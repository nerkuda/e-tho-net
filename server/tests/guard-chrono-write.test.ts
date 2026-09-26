/**
 * Сторож валидации ЗАПИСИ хроно-записей (0.10.1, задача T2 fca5b507;
 * ADR времени 994d076a, требования «Формат дат хроно-записи» d58aa1a4,
 * «Флаг "учитывать время"» 91ba5b3f, «Голая дата во входных параметрах
 * API = сутки UTC» 469d8d69).
 *
 * Сторож `guard-comments-time.test.ts` проверяет схему и приведение данных
 * (миграция 046). Здесь — правило НА УРОВНЕ ЗАПИСИ: домен обязан не пускать
 * в хранилище date-only и пустой `valid_to` у хронологической, независимо от
 * того, пришла запись через REST, MCP или прямой вызов домена.
 *
 * Проверяется:
 *   * домен: «голая дата» нормализуется в полный UTC-инстанс (начало суток для
 *     `valid_from`, конец для явного `valid_to`), пустое окончание = началу,
 *     флаг `use_time` пишется, невозможная дата/инстанс без пояса отвергаются
 *     `VALIDATION_ERROR`;
 *   * хранилище: после записей нет date-only и нет пустого `valid_to` у
 *     хронологических, у постоянного `valid_to` остаётся NULL;
 *   * паритет REST ↔ MCP: одинаковый вход даёт одинаковый результат.
 *
 * Почему это домен, а не CHECK на таблице. SQLite не умеет `ALTER TABLE ADD
 * CHECK` — ограничение добавляется только пересборкой таблицы, а `comments`
 * лежит в ветвимой модели с представлениями `comments_v`, FTS-триггерами и
 * частичным уникальным индексом, плюс десятки тестов-фикстур пишут строки
 * напрямую. Пересборка и триггер-запрет ломали бы эти пути. Единственный
 * продуктовый писатель — `comment-service` (маршруты, MCP и батч идут через
 * него), поэтому жёсткая валидация стоит там и проверяется этим сторожем.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWriteStream, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ETNX_VERSION, EtnError } from '@etn/shared';
import archiver from 'archiver';

import DatabaseConstructor from 'better-sqlite3';

import { logger } from '../src/logger.js';
import { importFromEtnx } from '../src/domain/import-service.js';
import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createComment, updateComment } from '../src/domain/comment-service.js';
import { authHeaders, buildRestContext, closeRestContext } from './rest-helpers.js';
import {
  buildMcpContext,
  callWrite,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  toolJson,
} from './mcp-helpers.js';

const USER = 'guard-chrono-user';

/** GLOB-шаблон «голой даты» `YYYY-MM-DD`. */
const DATE_ONLY_GLOB = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';

/** True when the `better-sqlite3` native binding loads. */
function nativeBindingAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Seed a thought directly so the polymorphic owner exists. */
function seedThought(ndb: NetworkDb, title = 'Seed'): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase());
  return id;
}

/** Сколько строк хранят date-only в `valid_from`/`valid_to`. */
function dateOnlyRows(ndb: NetworkDb): number {
  return (
    ndb
      .prepare(
        `SELECT COUNT(*) AS c FROM comments
          WHERE valid_from GLOB '${DATE_ONLY_GLOB}' OR valid_to GLOB '${DATE_ONLY_GLOB}'`,
      )
      .get() as { c: number }
  ).c;
}

/** Сколько хронологических строк осталось без окончания. */
function openChronoRows(ndb: NetworkDb): number {
  return (
    ndb
      .prepare("SELECT COUNT(*) AS c FROM comments WHERE kind = 'chronological' AND valid_to IS NULL")
      .get() as { c: number }
  ).c;
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

/** Прочитать даты и флаг записи напрямую из таблицы. */
function rawDates(
  ndb: NetworkDb,
  id: string,
): { valid_from: string; valid_to: string | null; use_time: number } {
  return ndb
    .prepare('SELECT valid_from, valid_to, use_time FROM comments WHERE id = ?')
    .get(id) as { valid_from: string; valid_to: string | null; use_time: number };
}

describe(
  'guard: валидация записи хроно-записей (0.10.1, T2)',
  nativeBindingAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('домен: date-only → полный UTC-инстанс, пустой valid_to = valid_from', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const c = createComment(
          ndb,
          'thought',
          t,
          { kind: 'chronological', body_md: 'date-only', valid_from: '2024-01-01' },
          USER,
        );
        assert.equal(c.valid_from, '2024-01-01T00:00:00.000Z');
        assert.equal(c.valid_to, '2024-01-01T00:00:00.000Z');
        assert.equal(c.use_time, false, 'по умолчанию флаг выключен');

        // Явный date-only valid_to = конец суток UTC (граница включительная).
        const ranged = createComment(
          ndb,
          'thought',
          t,
          {
            kind: 'chronological',
            body_md: 'range',
            valid_from: '2024-02-10',
            valid_to: '2024-02-20',
            use_time: true,
          },
          USER,
        );
        assert.equal(ranged.valid_from, '2024-02-10T00:00:00.000Z');
        assert.equal(ranged.valid_to, '2024-02-20T23:59:59.999Z');
        assert.equal(ranged.use_time, true);

        // Полный инстанс с офсентом приводится к UTC; постоянный — NULL valid_to.
        const offset = createComment(
          ndb,
          'thought',
          t,
          { kind: 'chronological', body_md: 'offset', valid_from: '2024-03-01T03:00:00+03:00' },
          USER,
        );
        assert.equal(offset.valid_from, '2024-03-01T00:00:00.000Z');
        const permanent = createComment(
          ndb,
          'thought',
          t,
          { kind: 'permanent', body_md: 'perm' },
          USER,
        );
        assert.equal(permanent.valid_to, null, 'постоянный сохраняет valid_to = NULL');

        // Хранилище: ни date-only, ни открытых хроно-записей.
        assert.equal(dateOnlyRows(ndb), 0, 'date-only в хранилище запрещён');
        assert.equal(openChronoRows(ndb), 0, 'пустой valid_to хронологической запрещён');
      } finally {
        ndb.close();
      }
    });

    it('домен: невозможная дата и инстанс без пояса → VALIDATION_ERROR', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const cases: Array<[string, string]> = [
          ['2024-02-30', 'невозможный день'],
          ['2024-13-01', 'невозможный месяц'],
          ['не дата', 'мусор'],
          ['2024-01-01T10:00:00', 'инстанс без пояса'],
          ['2024-01-01T25:00:00Z', 'невозможный час'],
        ];
        for (const [value, label] of cases) {
          assert.throws(
            () =>
              createComment(
                ndb,
                'thought',
                t,
                { kind: 'chronological', body_md: label, valid_from: value },
                USER,
              ),
            (err: unknown) =>
              err instanceof EtnError &&
              err.code === 'VALIDATION_ERROR' &&
              (err.details as { field?: string }).field === 'valid_from',
            `«${value}» (${label}) обязан отвергаться VALIDATION_ERROR`,
          );
        }
        assert.equal(dateOnlyRows(ndb), 0);
      } finally {
        ndb.close();
      }
    });

    it('домен: правка — пустое valid_to = началу, use_time пишется', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const t = seedThought(ndb);
        const c = createComment(
          ndb,
          'thought',
          t,
          { kind: 'chronological', body_md: 'edit', valid_from: '2024-04-01', valid_to: '2024-04-10' },
          USER,
        );
        const updated = updateComment(
          ndb,
          c.id,
          { valid_from: '2024-05-01', valid_to: '', use_time: true },
          undefined,
          USER,
        );
        assert.equal(updated.valid_from, '2024-05-01T00:00:00.000Z');
        assert.equal(updated.valid_to, updated.valid_from, 'пустое окончание = началу');
        assert.equal(updated.use_time, true);
        assert.deepEqual(rawDates(ndb, c.id), {
          valid_from: '2024-05-01T00:00:00.000Z',
          valid_to: '2024-05-01T00:00:00.000Z',
          use_time: 1,
        });
        assert.equal(dateOnlyRows(ndb), 0);
        assert.equal(openChronoRows(ndb), 0);
      } finally {
        ndb.close();
      }
    });

    it('REST: создание хроно-записи нормализует даты и флаг; мусор → 422', async () => {
      const ctx = await buildRestContext();
      try {
        const created = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/comments`,
          headers: authHeaders(ctx),
          payload: {
            kind: 'chronological',
            body_md: 'REST-запись',
            valid_from: '2026-01-01',
            use_time: true,
          },
        });
        assert.equal(created.statusCode, 201);
        const data = created.json().data as {
          id: string;
          valid_from: string;
          valid_to: string | null;
          use_time: boolean;
        };
        assert.equal(data.valid_from, '2026-01-01T00:00:00.000Z');
        assert.equal(data.valid_to, '2026-01-01T00:00:00.000Z');
        assert.equal(data.use_time, true);
        assert.deepEqual(rawDates(ctx.ndb, data.id), {
          valid_from: '2026-01-01T00:00:00.000Z',
          valid_to: '2026-01-01T00:00:00.000Z',
          use_time: 1,
        });
        assert.equal(dateOnlyRows(ctx.ndb), 0);
        assert.equal(openChronoRows(ctx.ndb), 0);

        const bad = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'chronological', body_md: 'сломанная', valid_from: '2026-02-30' },
        });
        assert.equal(bad.statusCode, 422);
        assert.equal(bad.json().error.code, 'VALIDATION_ERROR');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('паритет REST ↔ MCP: одинаковый вход даёт одинаковый результат', async () => {
      // REST-сторона — прямой вызов домена (та же валидация, что у маршрута).
      const ndb = createInMemoryNetworkDb();
      let domainDates: { valid_from: string; valid_to: string | null; use_time: boolean };
      try {
        const t = seedThought(ndb);
        const c = createComment(
          ndb,
          'thought',
          t,
          { kind: 'chronological', body_md: 'parity', valid_from: '2026-03-04', use_time: true },
          USER,
        );
        domainDates = { valid_from: c.valid_from, valid_to: c.valid_to, use_time: c.use_time ?? false };
      } finally {
        ndb.close();
      }

      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const thought = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: `Паритет ${randomUUID()}`,
          });
          const write = await callWrite(handle.client, ctx.networkId, [
            {
              thought_id: thought.id,
              chronicle: [
                { body_md: 'parity', valid_from: '2026-03-04', use_time: true },
              ],
            },
          ]);
          const commentId = write.items[0]!.chronicle![0]!.id;
          const got = await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, comment_id: commentId },
          });
          const mcp = toolJson<{ valid_from: string; valid_to: string | null; use_time: boolean }>(got);
          assert.deepEqual(
            { valid_from: mcp.valid_from, valid_to: mcp.valid_to, use_time: mcp.use_time },
            domainDates,
            'результат MCP обязан совпасть с результатом домена (REST)',
          );
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });

    it('импорт .etnx: даты приводятся к конвенции, use_time не теряется', async () => {
      const ctx = await buildRestContext();
      const outPath = path.join(tmpdir(), `etnx-chrono-${randomUUID()}.zip`);
      try {
        const now = new Date().toISOString();
        const thoughtId = randomUUID();
        const commentId = randomUUID();
        const manifest = {
          format: 'etnx',
          version: ETNX_VERSION,
          exported_at: now,
          source: { network_id: ctx.networkId, network_name: ctx.networkId, user_id: 'seed' },
          thought_types: [],
          link_types: [],
          properties: [],
          type_properties: [],
          thoughts: [
            {
              id: thoughtId,
              title: 'Архив с хроно-записью',
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
          comments: [
            {
              id: commentId,
              owner_type: 'thought',
              owner_id: thoughtId,
              kind: 'chronological',
              title: 'Старая запись',
              body_md: 'из архива',
              body_html: '<p>из архива</p>',
              // Старый формат архива: date-only + открытое окончание.
              valid_from: '2025-01-02',
              valid_to: null,
              use_time: true,
              version: 1,
              created_at: now,
              updated_at: now,
              created_by: 'seed',
              updated_by: 'seed',
            },
          ],
          comment_targets: [],
          property_values: [],
          attachments: [],
        };
        await writeArchive(manifest, outPath);

        await importFromEtnx(
          ctx.ndb,
          readFileSync(outPath),
          { actorUserId: ctx.adminId, parentThoughtId: ctx.homeId },
          logger,
        );

        const row = rawDates(ctx.ndb, commentId);
        assert.equal(row.valid_from, '2025-01-02T00:00:00.000Z', 'date-only нормализован');
        assert.equal(row.valid_to, row.valid_from, 'пустое окончание = началу');
        assert.equal(row.use_time, 1, 'флаг use_time сохранён');
        assert.equal(dateOnlyRows(ctx.ndb), 0);
        assert.equal(openChronoRows(ctx.ndb), 0);
      } finally {
        rmSync(outPath, { force: true });
        await closeRestContext(ctx);
      }
    });
  },
);
