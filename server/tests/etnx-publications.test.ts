/**
 * `.etnx` переносит публикации и полки (0.11.1, задача 950e0a59; требование
 * de697045; формат .etnx 1.2).
 *
 * Покрытие DoD:
 *   * раунд-трип: экспорт → импорт в чистую сеть → повторный экспорт — секции
 *     publications / publication_order / publication_exclusions / shelves /
 *     shelf_items идентичны;
 *   * старый архив формата 1.1 без секций публикаций читается (секции пусты);
 *   * публикация с обложкой-файлом переносится вместе с файлом: строка-вложение
 *     `owner_type='publication'` и её бинарь доезжают до целевой сети.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { type EtnxManifest } from '@etn/shared';
import archiver from 'archiver';
import yauzl from 'yauzl';
import type { Options as YauzlOptions, ZipFile } from 'yauzl';

import { logger } from '../src/logger.js';
import { exportToEtnx } from '../src/domain/export-service.js';
import { importFromEtnx, readManifestFromBuffer } from '../src/domain/import-service.js';
import { createAttachmentFile } from '../src/domain/attachment-service.js';
import {
  addPublicationExclusion,
  addShelfItem,
  createPublication,
  createShelf,
  setPublicationOrder,
  trashShelf,
  updatePublication,
} from '../src/domain/publication-service.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

const yauzlFromBuffer = promisify(yauzl.fromBuffer) as (
  buffer: Buffer,
  options: YauzlOptions,
) => Promise<ZipFile>;

/** Создать мысль через REST и вернуть её id. */
async function createThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json().data as { id: string }).id;
}

/** Экспортировать `.etnx` во временный файл и вернуть путь. */
async function exportArchive(ctx: RestTestContext, rootIds: string[]): Promise<string> {
  const outPath = path.join(tmpdir(), `etnx-pub-${randomUUID()}.zip`);
  await exportToEtnx(
    ctx.ndb,
    rootIds,
    { include_attachments: true, include_chronology: true, include_types: true },
    { network_id: ctx.networkId, network_name: ctx.networkId, user_id: ctx.adminId },
    outPath,
  );
  return outPath;
}

/** Записать минимальный zip с заданным manifest.json. */
async function writeArchive(manifest: unknown, outPath: string): Promise<void> {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const out = createWriteStream(outPath);
  const done = new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve());
    out.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(out);
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  await archive.finalize();
  await done;
}

/** Имена записей архива. */
async function zipEntries(zipPath: string): Promise<string[]> {
  const zip = await yauzlFromBuffer(readFileSync(zipPath), { lazyEntries: true });
  const entries: string[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry) => {
      entries.push(entry.fileName);
      zip.readEntry();
    });
    zip.on('end', resolve);
    zip.on('error', reject);
    zip.readEntry();
  });
  zip.close();
  return entries;
}

describe(
  '.etnx публикации и полки (950e0a59)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('round-trip: секции публикаций/полок идентичны после экспорт→импорт→экспорт', async () => {
      const src = await buildRestContext();
      const dst = await buildRestContext();
      let outA = '';
      let outB = '';
      try {
        const thoughtId = await createThought(src, 'Раздел публикации RT');

        const publication = createPublication(
          src.ndb,
          {
            title: 'Публикация RT',
            subtitle: 'Подзаголовок',
            summary_md: 'Резюме без заголовков',
            authorship: 'Автор',
            cover_url: 'https://example.com/cover.png',
            text_sources: [],
            extra_properties: [],
            numbering_from: 1,
            numbering_to: 3,
          },
          src.adminId,
        );
        setPublicationOrder(
          src.ndb,
          publication.id,
          [{ node_key: thoughtId, position: 5 }],
          src.adminId,
        );
        addPublicationExclusion(src.ndb, publication.id, thoughtId, src.adminId);
        const shelf = createShelf(src.ndb, { title: 'Полка RT' }, src.adminId);
        addShelfItem(src.ndb, shelf.id, publication.id, 7, src.adminId);
        // Пометка корзины полки обязана пережить раунд-трип (0.11.1, c59ce742).
        trashShelf(src.ndb, shelf.id, src.adminId);

        outA = await exportArchive(src, [thoughtId]);
        const manifestA = await readManifestFromBuffer(readFileSync(outA), logger);
        assert.equal(manifestA.version, '1.2', 'версия формата — 1.2');
        assert.equal(manifestA.publications.length, 1);
        assert.equal(manifestA.publication_order.length, 1);
        assert.equal(manifestA.publication_exclusions.length, 1);
        assert.equal(manifestA.shelves.length, 1);
        assert.equal(manifestA.shelf_items.length, 1);
        assert.equal(
          manifestA.shelves[0]?.marked_for_deletion,
          true,
          'пометка корзины полки уехала в манифест',
        );

        // Импорт в чистую сеть.
        const result = await importFromEtnx(
          dst.ndb,
          readFileSync(outA),
          { actorUserId: dst.adminId, parentThoughtId: dst.homeId },
          logger,
        );
        assert.equal(result.publications_created, 1, 'публикация создана');
        assert.equal(result.shelves_created, 1, 'полка создана');
        const remappedThoughtId = result.thoughtIdRemap.get(thoughtId);
        assert.ok(remappedThoughtId !== undefined, 'мысль импортирована (remap есть)');

        // Повторный экспорт из целевой сети — публикации экспортируются
        // независимо от содержимого подграфа, поэтому корни не важны.
        outB = await exportArchive(dst, []);
        const manifestB = await readManifestFromBuffer(readFileSync(outB), logger);

        assert.deepEqual(manifestB.publications, manifestA.publications, 'публикации идентичны');
        assert.deepEqual(manifestB.shelves, manifestA.shelves, 'полки идентичны');
        assert.deepEqual(manifestB.shelf_items, manifestA.shelf_items, 'состав полок идентичен');
        // Ссылки на мысль следуют за remap импорта (мысли получают новый id),
        // остальные поля строк идентичны.
        assert.deepEqual(
          manifestB.publication_order,
          manifestA.publication_order.map((r) => ({ ...r, node_key: remappedThoughtId })),
          'порядок идентичен с учётом remap мысли',
        );
        assert.deepEqual(
          manifestB.publication_exclusions,
          manifestA.publication_exclusions.map((r) => ({ ...r, thought_id: remappedThoughtId })),
          'исключения идентичны с учётом remap мысли',
        );
      } finally {
        if (outA !== '') rmSync(outA, { force: true });
        if (outB !== '') rmSync(outB, { force: true });
        await closeRestContext(src);
        await closeRestContext(dst);
      }
    });

    it('старый архив 1.1 без секций публикаций читается как пустой набор', async () => {
      const ctx = await buildRestContext();
      const outPath = path.join(tmpdir(), `etnx-pub-old-${randomUUID()}.zip`);
      try {
        const now = new Date().toISOString();
        const thoughtId = randomUUID();
        // Манифест 1.1: секций publications/… нет вообще (как писал старый сервер).
        const manifest: Record<string, unknown> = {
          format: 'etnx',
          version: '1.1',
          exported_at: now,
          source: { network_id: ctx.networkId, network_name: ctx.networkId, user_id: 'seed' },
          thought_types: [],
          link_types: [],
          properties: [],
          type_properties: [],
          thoughts: [
            {
              id: thoughtId,
              title: 'Старый архив 1.1',
              type_id: null,
              icon: null,
              icon_kind: 'emoji',
              active: true,
              created_at: now,
              created_by: 'seed',
            },
          ],
          thought_synonyms: [],
          links: [],
          comments: [],
          comment_targets: [],
          property_values: [],
          attachments: [],
        };
        await writeArchive(manifest, outPath);

        const parsed: EtnxManifest = await readManifestFromBuffer(readFileSync(outPath), logger);
        assert.equal(parsed.version, '1.1');
        assert.deepEqual(parsed.publications, [], 'нет публикаций');
        assert.deepEqual(parsed.shelves, [], 'нет полок');

        const result = await importFromEtnx(
          ctx.ndb,
          readFileSync(outPath),
          { actorUserId: ctx.adminId, parentThoughtId: ctx.homeId },
          logger,
        );
        assert.equal(result.thoughts_created, 1, 'старый архив всё ещё импортируется');
        assert.equal(result.publications_created, 0);
        assert.equal(result.shelves_created, 0);
      } finally {
        rmSync(outPath, { force: true });
        await closeRestContext(ctx);
      }
    });

    it('публикация с обложкой-файлом переносится вместе с файлом', async () => {
      const src = await buildRestContext();
      const dst = await buildRestContext();
      let outPath = '';
      try {
        const publication = createPublication(src.ndb, { title: 'Публикация с обложкой' }, src.adminId);
        const bytes = Buffer.from('etnx-cover-binary-content', 'utf8');
        const cover = createAttachmentFile(
          src.ndb,
          'publication',
          publication.id,
          {
            title: 'cover',
            mime_type: 'image/png',
            data_base64: bytes.toString('base64'),
          },
          src.adminId,
        );
        updatePublication(
          src.ndb,
          publication.id,
          { cover_attachment_id: cover.id },
          src.adminId,
        );

        outPath = await exportArchive(src, []);
        const manifest = await readManifestFromBuffer(readFileSync(outPath), logger);
        const coverRow = manifest.attachments.find((a) => a.owner_type === 'publication');
        assert.ok(coverRow !== undefined, 'строка-вложение обложки в манифесте');
        assert.equal(coverRow.kind, 'file');
        assert.equal(coverRow.owner_id, publication.id);
        assert.ok(cover.file_path !== null, 'исходный файл обложки сохранён');
        assert.equal(coverRow.file_path, path.basename(cover.file_path), 'file_path относителен архива');
        const entries = await zipEntries(outPath);
        assert.ok(
          entries.includes(`attachments/${coverRow.file_path}`),
          `архив содержит бинарь обложки, записи: ${entries.join(', ')}`,
        );

        const result = await importFromEtnx(
          dst.ndb,
          readFileSync(outPath),
          { actorUserId: dst.adminId, parentThoughtId: dst.homeId },
          logger,
        );
        assert.equal(result.publications_created, 1);
        assert.ok(result.attachments_imported >= 1, 'обложка импортирована');

        const imported = dst.ndb
          .prepare(
            "SELECT id, owner_type, owner_id, kind, file_path FROM attachments WHERE id = ?",
          )
          .get(cover.id) as
          | { id: string; owner_type: string; owner_id: string; kind: string; file_path: string | null }
          | undefined;
        assert.ok(imported !== undefined, 'строка-вложение обложки импортирована');
        assert.equal(imported.owner_type, 'publication');
        assert.equal(imported.owner_id, publication.id);
        assert.equal(imported.kind, 'file');
        assert.ok(imported.file_path !== null && existsSync(imported.file_path), 'файл записан на диск');
        assert.deepEqual(readFileSync(imported.file_path!), bytes, 'содержимое файла совпадает');

        const pub = dst.ndb
          .prepare('SELECT cover_attachment_id FROM publications WHERE id = ?')
          .get(publication.id) as { cover_attachment_id: string | null } | undefined;
        assert.equal(pub?.cover_attachment_id, cover.id, 'обложка публикации связана со строкой-вложением');
      } finally {
        if (outPath !== '') rmSync(outPath, { force: true });
        await closeRestContext(src);
        await closeRestContext(dst);
      }
    });
  },
);
