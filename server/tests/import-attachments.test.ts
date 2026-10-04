/**
 * Импорт `.etnx` с вложениями (ошибка af6ebdea, версия 0.8.3).
 *
 * `insertAttachment` писал несуществующую колонку `attachments.updated_at` —
 * импорт любого архива с записью `attachments[]` падал `SqliteError`, который
 * агент видел как сырое «Unexpected error». Тест собирает .etnx-архив с
 * URL-вложением и прогоняет реальный `importFromEtnx`, проверяя, что запись
 * доехала до целевой сети, а сбой импорта оформлен ETN-ошибкой с кодом.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWriteStream, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { EtnError, ETNX_VERSION } from '@etn/shared';
import archiver from 'archiver';

import { logger } from '../src/logger.js';
import { importFromEtnx } from '../src/domain/import-service.js';
import { buildRestContext, closeRestContext, nativeAvailable } from './rest-helpers.js';

/** Минимальный манифест 1.1 с одной мыслью и одним URL-вложением к ней. */
function buildManifest(networkId: string): { manifest: unknown; thoughtId: string; attId: string } {
  const now = new Date().toISOString();
  const thoughtId = randomUUID();
  const attId = randomUUID();
  const manifest = {
    format: 'etnx',
    version: ETNX_VERSION,
    exported_at: now,
    source: { network_id: networkId, network_name: networkId, user_id: 'seed' },
    thought_types: [],
    link_types: [],
    properties: [],
    type_properties: [],
    thoughts: [
      {
        id: thoughtId,
        title: 'TEST 0.8.3 — вложение через импорт',
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
    attachments: [
      {
        id: attId,
        owner_type: 'thought',
        owner_id: thoughtId,
        kind: 'url',
        url: 'https://example.com/etn',
        file_path: null,
        file_size: null,
        mime_type: null,
        title: 'пример',
        description: null,
        icon: null,
        position: 0,
        created_at: now,
        created_by: 'seed',
      },
    ],
  };
  return { manifest, thoughtId, attId };
}

/** Записать .etnx-архив (manifest.json) во временный файл. */
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

/** Минимальный манифест 1.2 с одной мыслью и одним ФАЙЛОВЫМ вложением к ней. */
function buildFileManifest(networkId: string): { manifest: unknown; attId: string } {
  const now = new Date().toISOString();
  const thoughtId = randomUUID();
  const attId = randomUUID();
  const manifest = {
    format: 'etnx',
    version: ETNX_VERSION,
    exported_at: now,
    source: { network_id: networkId, network_name: networkId, user_id: 'seed' },
    thought_types: [],
    link_types: [],
    properties: [],
    type_properties: [],
    thoughts: [
      {
        id: thoughtId,
        title: 'TEST 626f4ff9 — файловое вложение через импорт',
        type_id: null,
        icon: null,
        icon_kind: 'emoji',
        active: true,
        marked_for_deletion: false,
        marked_for_deletion_at: null,
        marked_for_deletion_by: null,
        created_at: now,
        created_by: 'seed',
      },
    ],
    thought_synonyms: [],
    links: [],
    comments: [],
    comment_targets: [],
    property_values: [],
    attachments: [
      {
        id: attId,
        owner_type: 'thought',
        owner_id: thoughtId,
        kind: 'file',
        url: null,
        file_path: 'cover.txt',
        file_size: 5,
        mime_type: 'text/plain',
        title: 'файл',
        description: null,
        icon: null,
        position: 0,
        created_at: now,
        created_by: 'seed',
      },
    ],
  };
  return { manifest, attId };
}

/** Записать .etnx-архив с manifest.json и бинарём файлового вложения. */
async function writeArchiveWithBinary(
  manifest: unknown,
  relName: string,
  binary: Buffer,
  outPath: string,
): Promise<void> {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const out = createWriteStream(outPath);
  const done = new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve());
    out.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(out);
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  archive.append(binary, { name: `attachments/${relName}` });
  await archive.finalize();
  await done;
}

describe(
  'import .etnx with attachments (af6ebdea)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('imports an archive carrying a URL attachment without a schema error', async () => {
      const ctx = await buildRestContext();
      const outPath = path.join(tmpdir(), `etnx-att-${randomUUID()}.zip`);
      try {
        const { manifest, thoughtId, attId } = buildManifest(ctx.networkId);
        await writeArchive(manifest, outPath);

        const result = await importFromEtnx(
          ctx.ndb,
          readFileSync(outPath),
          { actorUserId: ctx.adminId, parentThoughtId: ctx.homeId },
          logger,
        );

        assert.equal(result.attachments_imported, 1, 'вложение должно импортироваться');
        const importedOwner = result.thoughtIdRemap.get(thoughtId);
        assert.ok(importedOwner !== undefined, 'мысль-владелец должна быть в remap');

        const row = ctx.ndb
          .prepare(
            'SELECT owner_id, kind, url, updated_by, created_at_ms FROM attachments WHERE id = ?',
          )
          .get(attId) as
          | {
              owner_id: string;
              kind: string;
              url: string;
              updated_by: string;
              created_at_ms: number;
            }
          | undefined;
        assert.ok(row !== undefined, 'импортированное вложение должно существовать');
        assert.equal(row.owner_id, importedOwner, 'вложение привязано к импортированной мысли');
        assert.equal(row.kind, 'url');
        assert.equal(row.url, 'https://example.com/etn');
        assert.equal(row.updated_by, ctx.adminId, 'updated_by пишется из actor');
        assert.ok(row.created_at_ms > 0, 'created_at_ms заполнен, а не остался дефолтным нулём');
      } finally {
        rmSync(outPath, { force: true });
        await closeRestContext(ctx);
      }
    });

    it('повторный импорт не плодит файлы-сироты и честно считает пропуски (626f4ff9)', async () => {
      const ctx = await buildRestContext();
      const outPath = path.join(tmpdir(), `etnx-att-file-${randomUUID()}.zip`);
      const attachDir = path.join(path.dirname(ctx.ndb.dbPath), 'attachments');
      try {
        const { manifest, attId } = buildFileManifest(ctx.networkId);
        await writeArchiveWithBinary(
          manifest,
          'cover.txt',
          Buffer.from('hello'),
          outPath,
        );

        const first = await importFromEtnx(
          ctx.ndb,
          readFileSync(outPath),
          { actorUserId: ctx.adminId, parentThoughtId: ctx.homeId },
          logger,
        );
        assert.equal(first.attachments_imported, 1, 'первый импорт пишет вложение');
        assert.equal(first.attachments_skipped, 0, 'первый импорт ничего не пропускает');
        assert.ok(
          ctx.ndb.prepare('SELECT 1 FROM attachments WHERE id = ?').get(attId) !== undefined,
          'строка вложения создана',
        );
        const filesAfterFirst = readdirSync(attachDir);
        assert.equal(filesAfterFirst.length, 1, 'первый импорт распаковал ровно один файл');

        // Повторный импорт того же архива: строка уже есть, файл не распаковывается.
        const second = await importFromEtnx(
          ctx.ndb,
          readFileSync(outPath),
          { actorUserId: ctx.adminId, parentThoughtId: ctx.homeId },
          logger,
        );
        assert.equal(second.attachments_imported, 0, 'повторно вложение не импортируется');
        assert.equal(second.attachments_skipped, 1, 'счётчик честно говорит «пропущено»');
        const filesAfterSecond = readdirSync(attachDir);
        assert.equal(
          filesAfterSecond.length,
          filesAfterFirst.length,
          'файлов-сирот не прибавилось',
        );
      } finally {
        rmSync(outPath, { force: true });
        await closeRestContext(ctx);
      }
    });

    it('wraps an import failure into an ETN error with a code', async () => {
      const ctx = await buildRestContext();
      try {
        await assert.rejects(
          () =>
            importFromEtnx(
              ctx.ndb,
              Buffer.from('not a zip archive'),
              { actorUserId: ctx.adminId, parentThoughtId: ctx.homeId },
              logger,
            ),
          (err: unknown) => {
            assert.ok(err instanceof EtnError, 'ожидается ETN-ошибка, не сырой SqliteError');
            assert.equal(err.code, 'INTERNAL');
            return true;
          },
        );
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
