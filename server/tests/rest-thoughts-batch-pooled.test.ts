/**
 * REST-батчи мыслей в write-пуле (задача b9c70dd8, тех.проект 0df7ccd6,
 * ADR ca3a9218).
 *
 * До этой задачи write-пул был подключён к `etn.thoughts.write`,
 * `POST /thoughts` и (частично) MCP. Батчевые REST-пути
 * `POST /thoughts/batch` (массовые операции над существующими) и
 * `POST /thoughts/copy-batch` (пакетное создание с fileCopier и кросс-сетевым
 * источником) оставались синхронными в главном потоке: массовая операция из
 * клиента держала event loop и «морозила» сервер для всех сетей.
 *
 * Проверяется НАБЛЮДАЕМОЕ поведение:
 *
 *   * батч-операция через REST идёт через пул (счётчик пула растёт), но ответ,
 *     эффекты и журнал активности — те же, что на синхронном пути;
 *   * локальные операции батча (`delete`/`purge`) — тем же путём через пул;
 *   * `POST /thoughts/copy-batch` через пул переносит файлы вложений так же, как
 *     синхронный путь (файл физически появляется в сети-получателе);
 *   * `ETN_WRITE_POOL_SIZE=0` (пул не настроен) — синхронный путь как раньше;
 *   * нагрузочная проба: тяжёлая батч-операция через пул не блокирует главный
 *     поток (p99 лага пинга не выше относительного потолка от синхронного
 *     ориентира — см. `ping-lag.ts`).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import pino from 'pino';

import { BASE_LAYER_ID } from '@etn/shared';

import { runThoughtsBatch } from '../src/domain/heavy-write.js';
import type { Logger } from '../src/logger.js';
import { closeNetworkDb } from '../src/db/network-db.js';
import {
  closeWritePool,
  configureWritePool,
  getWritePool,
} from '../src/db/write-pool.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';
import { PING_P99_CEIL_MS, pingP99Ceiling, startPingLag } from './ping-lag.js';

/** Тяжёлый батч в нагрузочной пробе: 50 целей × 20 якорей = 1000 рёбер. */
const LOAD_TARGETS = 50;
const LOAD_ANCHORS = 20;
/** Форма большой сети (как в write-pool-load): мысли + wildcard-синонимы. */
const PROFILE_THOUGHTS = 600;
const PROFILE_WILDCARDS = 300;

/** Ответ REST: статус + `data`. */
interface RestResponse<T> {
  statusCode: number;
  body: string;
  data: T;
}

/** Выполнить запрос и вернуть статус + распарсенный `data`. */
async function injectData<T>(
  ctx: RestTestContext,
  method: 'POST' | 'GET',
  url: string,
  payload?: Record<string, unknown>,
): Promise<RestResponse<T>> {
  const res = await ctx.app.inject({ method, url, headers: authHeaders(ctx), payload });
  return {
    statusCode: res.statusCode,
    body: res.body,
    data: (res.json().data ?? null) as T,
  };
}

/** Создать мысль в указанной сети и вернуть её id. */
async function createThought(
  ctx: RestTestContext,
  title: string,
  networkId: string = ctx.networkId,
): Promise<string> {
  const res = await injectData<{ id: string }>(ctx, 'POST', `/api/v1/networks/${networkId}/thoughts`, {
    title,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.data.id;
}

/** Заполнить сеть «формой большой сети»: мысли + wildcard-синонимы. */
function seedProfile(ndb: RestTestContext['ndb'], thoughts: number, wildcards: number): string[] {
  const insThought = ndb.prepare(
    `INSERT INTO thoughts (id, layer_id, title, title_norm, active, is_protected, is_root,
                           version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u', 0, 0)`,
  );
  const insSynonym = ndb.prepare(
    'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)',
  );
  const ids: string[] = [];
  ndb.transaction(() => {
    for (let i = 0; i < thoughts; i += 1) {
      const id = randomUUID();
      insThought.run(id, BASE_LAYER_ID, `Мысль ${i}`, `мысль ${i}`);
      ids.push(id);
    }
    for (let i = 0; i < wildcards; i += 1) {
      const synonym = `терм${i}*`;
      insSynonym.run(ids[i % ids.length] as string, synonym, synonym.toLowerCase());
    }
  });
  return ids;
}

/** Вставить `count` простых мыслей напрямую и вернуть их id. */
function seedPlainThoughts(ndb: RestTestContext['ndb'], prefix: string, count: number): string[] {
  const ins = ndb.prepare(
    `INSERT INTO thoughts (id, layer_id, title, title_norm, active, is_protected, is_root,
                           version, created_at, created_by, updated_at, updated_by, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u', 0, 0)`,
  );
  const ids: string[] = [];
  ndb.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const id = randomUUID();
      const title = `${prefix}-${i}`;
      ins.run(id, BASE_LAYER_ID, title, title.toLowerCase());
      ids.push(id);
    }
  });
  return ids;
}

/** Логгер, складывающий JSON-строки в массив (для проверки лога воркера). */
function captureLogger(sink: string[]): Logger {
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      sink.push(String(chunk));
      cb();
    },
  });
  // Явные дженерики pino: двухаргументная перегрузка иначе выводит
  // CustomLevels=string и не совпадает с базовым `Logger` (= `Logger<never, boolean>`).
  return pino<never>({ level: 'debug' }, stream);
}

/** Строка журнала активности: актор, действие и тип сущности. */
interface ActivityRow {
  user_id: string;
  layer_id: string | null;
  action: string;
  entity_type: string;
}

describe(
  'REST-батчи мыслей в write-пуле (b9c70dd8)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    afterEach(async () => {
      await closeWritePool();
    });

    it('POST /thoughts/batch (групповая операция) через пул: результат, журнал и события сохранены', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await createThought(ctx, 'batch-a');
        const b = await createThought(ctx, 'batch-b');
        const c = await createThought(ctx, 'batch-c');

        configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
        const res = await injectData<{ affected: number; failures: unknown[] }>(
          ctx,
          'POST',
          `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          { ids: [a, b, c], op: 'trash' },
        );

        assert.equal(res.statusCode, 200, res.body);
        assert.equal(res.data.affected, 3, 'все три мысли обработаны');
        assert.deepEqual(res.data.failures, [], 'без ошибок по id');
        assert.ok(getWritePool()!.stats().completed >= 1, 'батч-задача исполнена пулом');
        assert.ok(getWritePool()!.stats().spawns >= 1, 'воркер сети поднят');

        // Побочный эффект и журнал — те же, что на синхронном пути.
        const trashed = ctx.ndb
          .prepare('SELECT COUNT(*) AS n FROM thoughts WHERE marked_for_deletion = 1')
          .get() as { n: number };
        assert.equal(trashed.n, 3, 'мысли помечены на удаление в БД');
        const activity = ctx.ndb
          .prepare(
            'SELECT user_id, layer_id, action, entity_type FROM activity_log ORDER BY occurred_at_ms, id',
          )
          .all() as ActivityRow[];
        const trashedRows = activity.filter((r) => r.action === 'trashed');
        assert.equal(trashedRows.length, 3, 'журнал записан воркером на каждую мысль');
        assert.ok(
          trashedRows.every((r) => r.user_id === ctx.adminId),
          'актор журнала — актор запроса',
        );
        assert.ok(
          trashedRows.every((r) => r.layer_id === ctx.ndb.layerId),
          'слой журнала — слой сессии',
        );
      } finally {
        await closeWritePool();
        await closeRestContext(ctx);
      }
    });

    it('POST /thoughts/batch (локальная операция delete) через пул удаляет мысли', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await createThought(ctx, 'del-a');
        const b = await createThought(ctx, 'del-b');
        configureWritePool({ size: 1, taskTimeoutMs: 60_000 });

        const res = await injectData<{ affected: number }>(
          ctx,
          'POST',
          `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          { ids: [a, b], op: 'delete' },
        );
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(res.data.affected, 2);
        const gone = ctx.ndb
          .prepare('SELECT COUNT(*) AS n FROM thoughts WHERE id IN (?, ?)')
          .get(a, b) as { n: number };
        assert.equal(gone.n, 0, 'мысли удалены физически');
        assert.ok(getWritePool()!.stats().completed >= 1, 'задача исполнена пулом');
      } finally {
        await closeWritePool();
        await closeRestContext(ctx);
      }
    });

    it('пул логирует исполнение батч-задачи (op виден в логе воркера)', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await createThought(ctx, 'log-a');
        const logs: string[] = [];
        configureWritePool({ size: 1, taskTimeoutMs: 60_000, logger: captureLogger(logs) });
        const result = await runThoughtsBatch(
          ctx.ndb,
          { networkId: ctx.networkId, userId: ctx.adminId, layerId: ctx.ndb.layerId, emit: () => {} },
          { ids: [a], op: 'set_active' },
        );
        assert.equal(result.affected, 1);
        assert.ok(
          logs.some((l) => l.includes('write.thought.batch')),
          `лог пула обязан нести op задачи; получено: ${logs.join('\n')}`,
        );
      } finally {
        await closeWritePool();
        await closeRestContext(ctx);
      }
    });

    it('паритет REST batch: пул выключен / включён — одинаковый результат', async () => {
      const sync = await buildRestContext();
      let syncResult: { affected: number; failures: unknown[] };
      try {
        assert.equal(getWritePool(), null, 'перед синхронным прогоном пула нет');
        const ids = await Promise.all(['p1', 'p2', 'p3'].map((t) => createThought(sync, t)));
        const res = await injectData<{ affected: number; failures: unknown[] }>(
          sync,
          'POST',
          `/api/v1/networks/${sync.networkId}/thoughts/batch`,
          { ids, op: 'set_active' },
        );
        assert.equal(res.statusCode, 200, res.body);
        syncResult = res.data;
      } finally {
        await closeRestContext(sync);
      }

      const pooled = await buildRestContext();
      try {
        configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
        const ids = await Promise.all(['q1', 'q2', 'q3'].map((t) => createThought(pooled, t)));
        const res = await injectData<typeof syncResult>(
          pooled,
          'POST',
          `/api/v1/networks/${pooled.networkId}/thoughts/batch`,
          { ids, op: 'set_active' },
        );
        assert.equal(res.statusCode, 200, res.body);
        assert.deepEqual(res.data, syncResult, 'ответ REST не изменился');
        assert.ok(getWritePool()!.stats().completed >= 1, 'второй батч — через пул');
      } finally {
        await closeWritePool();
        await closeRestContext(pooled);
      }
    });

    it('POST /thoughts/copy-batch через пул: ответ и физический перенос файла сохранены', async () => {
      const ctx = await buildRestContext();
      let netB: string | null = null;
      try {
        // Файл-источник в каталоге вложений сети A.
        const sourceDir = path.join(ctx.dataDir, 'networks', ctx.networkId, 'attachments');
        mkdirSync(sourceDir, { recursive: true });
        const sourcePath = path.join(sourceDir, 'plan.txt');
        writeFileSync(sourcePath, 'cross-network payload');

        const createdB = await injectData<{ id: string }>(ctx, 'POST', '/api/v1/networks', {
          display_name: 'Target Net',
        });
        assert.equal(createdB.statusCode, 201, createdB.body);
        netB = createdB.data.id;
        const pasteTarget = await createThought(ctx, 'paste-target', netB);

        configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
        const copy = await injectData<{
          created_attachments: Array<{ file_path: string; kind: string }>;
        }>(ctx, 'POST', `/api/v1/networks/${netB}/thoughts/copy-batch`, {
          source_network_id: ctx.networkId,
          parent_thought_id: pasteTarget,
          thoughts: [
            {
              source_id: randomUUID(),
              thought: {
                title: 'Копия A',
                synonyms: [],
                type: { id: null, name: null },
                icon: null,
                icon_kind: 'emoji',
                active: true,
                fg_color: null,
                bg_color: null,
                font_bold: null,
                font_italic: null,
                font_underline: null,
                font_strike: null,
              },
              attachments: [
                { kind: 'file', file_path: sourcePath, mime_type: 'text/plain', title: 'План' },
              ],
            },
          ],
          links: [],
        });

        assert.equal(copy.statusCode, 200, copy.body);
        assert.ok(getWritePool()!.stats().completed >= 1, 'задача copy-batch исполнена пулом');
        const copies = copy.data.created_attachments;
        assert.equal(copies.length, 1);
        const copiedPath = copies[0]!.file_path;
        assert.notEqual(copiedPath, sourcePath, 'копия не ссылается на файл сети A');
        assert.equal(
          path.dirname(copiedPath),
          path.join(ctx.dataDir, 'networks', netB, 'attachments'),
        );
        assert.ok(existsSync(copiedPath), 'файл копии создан после коммита');
        assert.equal(readFileSync(copiedPath).toString(), 'cross-network payload');
      } finally {
        await closeWritePool();
        if (netB !== null) closeNetworkDb(netB);
        await closeRestContext(ctx);
      }
    });

    it('нагрузка: тяжёлая батч-операция через пул не блокирует главный поток', async () => {
      const ctx = await buildRestContext();
      try {
        seedProfile(ctx.ndb, PROFILE_THOUGHTS, PROFILE_WILDCARDS);

        const batchUrl = `/api/v1/networks/${ctx.networkId}/thoughts/batch`;
        const measure = async (
          tag: string,
        ): Promise<{ ms: number; pings: number; p99: number; busy: number }> => {
          const stopPing = startPingLag(() => (getWritePool()?.stats().busyWorkers ?? 0) > 0);

          const targets = seedPlainThoughts(ctx.ndb, `${tag}-цель`, LOAD_TARGETS);
          const anchors = seedPlainThoughts(ctx.ndb, `${tag}-якорь`, LOAD_ANCHORS);
          const started = Date.now();
          const res = await injectData<{ affected: number; failures: unknown[] }>(ctx, 'POST', batchUrl, {
            ids: targets,
            op: 'link_parents',
            args: { parent_ids: anchors },
          });
          const ms = Date.now() - started;
          const lag = await stopPing();

          assert.equal(res.statusCode, 200, res.body);
          assert.equal(res.data.affected, LOAD_TARGETS, `батч ${tag} обработан целиком`);
          return { ms, ...lag };
        };

        // Синхронный ориентир: пула нет — батч идёт в главном потоке.
        assert.equal(getWritePool(), null, 'перед синхронным замером пула нет');
        const sync = await measure('синхронно');

        const pool = configureWritePool({ size: 2, taskTimeoutMs: 60_000 });
        assert.ok(pool !== null);
        // Разогрев привязки: подъём воркера — разовая плата, вне замера.
        await measure('разогрев');
        const pooled = await measure('через-пул');

        console.log(
          `[thoughts-batch-pool] ${LOAD_TARGETS}×${LOAD_ANCHORS} link_parents: ` +
            `синхронно=${sync.ms} мс (p99 пинга=${sync.p99.toFixed(1)} мс, пингов=${sync.pings}); ` +
            `через пул=${pooled.ms} мс (p99 пинга=${pooled.p99.toFixed(1)} мс, пингов=${pooled.pings}, ` +
            `при занятом воркере=${pooled.busy})`,
        );

        assert.ok(pooled.pings >= 5, `пинги успели накопиться (${pooled.pings})`);
        assert.ok(
          sync.p99 >= PING_P99_CEIL_MS,
          `синхронный путь обязан блокировать главный поток (p99 пинга ${sync.p99.toFixed(1)} мс)`,
        );
        assert.ok(pooled.busy > 0, 'пинги через пул приходятся на время занятого воркера');
        const ceiling = pingP99Ceiling(sync.p99);
        assert.ok(
          pooled.p99 <= ceiling,
          `p99 лага пинга через пул ${pooled.p99.toFixed(1)} мс > потолка ${ceiling.toFixed(1)} мс ` +
            `(синхронный ориентир ${sync.p99.toFixed(1)} мс) — главный поток блокируется`,
        );
        assert.ok(pool.stats().completed >= 2, 'батч-задачи исполнены пулом');
      } finally {
        await closeWritePool();
        await closeRestContext(ctx);
      }
    });
  },
);
