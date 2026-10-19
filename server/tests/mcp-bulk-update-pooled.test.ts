/**
 * MCP `etn.thoughts.bulk_update` в write-пуле (задача dba7fabc, тех.проект
 * 0df7ccd6, ADR ca3a9218).
 *
 * REST-батчи переведены на пул задачей b9c70dd8, но MCP-путь того же класса
 * остался синхронным: массовая операция держала event loop главного потока.
 * Тест проверяет НАБЛЮДАЕМОЕ поведение:
 *
 *   * вызов идёт через пул (счётчик и лог воркера), но ответ, эффекты, журнал
 *     активности и аудит — те же, что на синхронном пути;
 *   * строка аудита — ровно одна на вызов и появляется после коммита;
 *   * события публикуются после коммита (в момент события БД уже изменена);
 *   * пул выключен (`size: 0`) — синхронный путь как раньше;
 *   * паритет ответа `{ affected, failures[] }`: тот же состав и порядок.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';

import pino from 'pino';

import type { AnyRealtimeEvent } from '@etn/shared';

import type { Logger } from '../src/logger.js';
import { openNetworkDb } from '../src/db/network-db.js';
import {
  closeWritePool,
  configureWritePool,
  getWritePool,
} from '../src/db/write-pool.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  nativeAvailable,
  toolJson,
  type McpClientHandle,
  type McpTestContext,
} from './mcp-helpers.js';

/** Результат MCP-вызова `bulk_update` (после эха слоя). */
interface BulkResult {
  affected: number;
  failures: Array<{ id: string; code: string; message: string }>;
  layer: { id: string; title: string };
}

/** Логгер, складывающий JSON-строки в массив (для проверки лога воркера). */
function captureLogger(sink: string[]): Logger {
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      sink.push(String(chunk));
      cb();
    },
  });
  return pino<never>({ level: 'debug' }, stream);
}

/** Вставить мысль напрямую и вернуть её id (быстрая фикстура). */
function insertThought(
  ndb: ReturnType<typeof openNetworkDb>,
  title: string,
  userId: string,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, updated_at,
                             created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 1, 0, 0, 0, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), now, now, userId, userId, nowMs, nowMs);
  return id;
}

/** Вызвать `etn.thoughts.bulk_update` и вернуть распарсенный результат. */
async function callBulkUpdate(
  handle: McpClientHandle,
  ctx: McpTestContext,
  ids: string[],
  op: string,
): Promise<BulkResult> {
  const result = await handle.client.callTool({
    name: 'etn.thoughts.bulk_update',
    arguments: { network_id: ctx.networkId, ids, op },
  });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return toolJson<BulkResult>(result);
}

/** Строка журнала активности: актор, слой и действие. */
interface ActivityRow {
  user_id: string;
  layer_id: string | null;
  action: string;
  entity_type: string;
}

describe(
  'MCP bulk_update в write-пуле (dba7fabc)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    afterEach(async () => {
      await closeWritePool();
    });

    it('bulk_update через пул: результат, журнал, аудит и события после коммита', async () => {
      const ctx = await buildMcpContext();
      let handle: McpClientHandle | null = null;
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const ids = [
          insertThought(ndb, 'pooled-active-1', ctx.adminId),
          insertThought(ndb, 'pooled-active-2', ctx.adminId),
          insertThought(ndb, 'pooled-active-3', ctx.adminId),
        ];
        // Заранее деактивируем одну — операция обязана её включить.
        ndb.prepare('UPDATE thoughts SET active = 0 WHERE id = ?').run(ids[1]);

        // Наблюдение за событиями: в момент `thought.updated` данные уже
        // закоммичены воркером (иначе главное соединение их не увидит).
        const events: AnyRealtimeEvent[] = [];
        const activeAtEvent: Array<number> = [];
        const activityAtEvent: Array<number> = [];
        const unsubscribe = ctx.pubsub.subscribe(ctx.networkId, (event) => {
          const ev = event as unknown as AnyRealtimeEvent;
          events.push(ev);
          if (ev.type !== 'thought.updated') return;
          const id = (ev.data as { id: string }).id;
          const row = ndb.prepare('SELECT active FROM thoughts_v WHERE id = ?').get(id) as
            | { active: number }
            | undefined;
          activeAtEvent.push(row?.active ?? -1);
          const journal = ndb
            .prepare(
              `SELECT COUNT(*) AS n FROM activity_log
                WHERE entity_id = ? AND action = 'updated'`,
            )
            .get(id) as { n: number };
          activityAtEvent.push(journal.n);
        });

        const logs: string[] = [];
        configureWritePool({ size: 1, taskTimeoutMs: 60_000, logger: captureLogger(logs) });
        handle = await connectMcpClient(ctx, ctx.adminKey);

        const result = await callBulkUpdate(handle, ctx, ids, 'set_active');
        unsubscribe();

        assert.equal(result.affected, 3);
        assert.deepEqual(result.failures, []);
        assert.ok(getWritePool()!.stats().completed >= 1, 'задача исполнена пулом');
        assert.ok(getWritePool()!.stats().spawns >= 1, 'воркер сети поднят');
        assert.ok(
          logs.some((l) => l.includes('write.thought.batch')),
          `лог пула обязан нести op задачи; получено: ${logs.join('\n')}`,
        );

        // Побочный эффект и журнал — те же, что на синхронном пути.
        for (const id of ids) {
          const row = ndb.prepare('SELECT active FROM thoughts_v WHERE id = ?').get(id) as
            | { active: number }
            | undefined;
          assert.equal(row?.active, 1, 'мысль активна в БД');
        }
        const activity = ndb
          .prepare(
            `SELECT user_id, layer_id, action, entity_type FROM activity_log
              WHERE action = 'updated' ORDER BY occurred_at_ms, id`,
          )
          .all() as ActivityRow[];
        assert.equal(activity.length, 3, 'журнал записан воркером на каждую мысль');
        assert.ok(
          activity.every((r) => r.user_id === ctx.adminId),
          'актор журнала — актор вызова',
        );
        assert.ok(
          activity.every((r) => r.layer_id === ndb.layerId),
          'слой журнала — слой сессии',
        );

        // События: три `thought.updated`, и в их момент запись уже в БД.
        const updated = events.filter((e) => e.type === 'thought.updated');
        assert.equal(updated.length, 3, 'событие на каждую затронутую мысль');
        assert.deepEqual(activeAtEvent, [1, 1, 1], 'на момент события мысль уже активна');
        assert.ok(
          activityAtEvent.every((n) => n >= 1),
          'на момент события строка журнала уже записана',
        );

        // Аудит: ровно одна строка на вызов, после коммита.
        const audit = ctx.sys.queryAudit({ category: 'data' });
        assert.equal(audit.length, 1, 'одна строка audit_log на весь вызов');
        assert.equal(audit[0]!.action, 'etn.thoughts.bulk_update');
        assert.equal(audit[0]!.actor_user_id, ctx.adminId);
        assert.equal(audit[0]!.network_id, ctx.networkId);
        assert.equal(audit[0]!.target_type, 'thought');
        assert.equal(audit[0]!.target_id, ids[0]);
        assert.deepEqual(audit[0]!.details, {
          op: 'set_active',
          ids: 3,
          affected: 3,
          failures: 0,
        });
      } finally {
        await closeWritePool();
        if (handle !== null) await handle.close();
        await closeMcpContext(ctx);
      }
    });

    it('пул выключен (SIZE=0) — синхронный путь как раньше', async () => {
      const ctx = await buildMcpContext();
      let handle: McpClientHandle | null = null;
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const ids = [
          insertThought(ndb, 'sync-inactive-1', ctx.adminId),
          insertThought(ndb, 'sync-inactive-2', ctx.adminId),
        ];
        assert.equal(configureWritePool({ size: 0 }), null);
        assert.equal(getWritePool(), null, 'пул выключен');
        handle = await connectMcpClient(ctx, ctx.adminKey);

        const result = await callBulkUpdate(handle, ctx, ids, 'set_inactive');
        assert.equal(result.affected, 2);
        assert.deepEqual(result.failures, []);
        for (const id of ids) {
          const row = ndb.prepare('SELECT active FROM thoughts_v WHERE id = ?').get(id) as
            | { active: number }
            | undefined;
          assert.equal(row?.active, 0, 'мысль деактивирована синхронным путём');
        }
        assert.equal(getWritePool(), null, 'синхронный путь не поднимает пул');
        const audit = ctx.sys.queryAudit({ category: 'data' });
        assert.equal(audit.length, 1, 'одна строка audit_log на вызов');
        assert.equal(audit[0]!.action, 'etn.thoughts.bulk_update');
      } finally {
        await closeWritePool();
        if (handle !== null) await handle.close();
        await closeMcpContext(ctx);
      }
    });

    it('паритет ответа sync/pool: состав и порядок failures сохранены', async () => {
      const ctx = await buildMcpContext();
      let handle: McpClientHandle | null = null;
      try {
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const ghostA = '00000000-0000-4000-8000-0000000000ff';
        const ghostB = '00000000-0000-4000-8000-0000000000fe';
        const syncIds = [
          insertThought(ndb, 'parity-sync-a', ctx.adminId),
          ghostA,
          insertThought(ndb, 'parity-sync-b', ctx.adminId),
          ghostB,
        ];
        const poolIds = [
          insertThought(ndb, 'parity-pool-a', ctx.adminId),
          ghostA,
          insertThought(ndb, 'parity-pool-b', ctx.adminId),
          ghostB,
        ];

        // Синхронный прогон: пула нет.
        assert.equal(getWritePool(), null);
        handle = await connectMcpClient(ctx, ctx.adminKey);
        const syncResult = await callBulkUpdate(handle, ctx, syncIds, 'set_inactive');

        // Пул-прогон на эквивалентном наборе.
        configureWritePool({ size: 1, taskTimeoutMs: 60_000 });
        const completedBefore = getWritePool()!.stats().completed;
        const poolResult = await callBulkUpdate(handle, ctx, poolIds, 'set_inactive');

        assert.equal(
          getWritePool()!.stats().completed,
          completedBefore + 1,
          'батч-задача исполнена пулом (счётчик вырос ровно на одну задачу)',
        );

        /** Нормализовать id набора в позиционные токены (ghost — общий). */
        const normalize = (r: BulkResult, ids: string[]): BulkResult => ({
          affected: r.affected,
          failures: r.failures.map((f) => ({
            id: ids.indexOf(f.id) >= 0 ? `#${ids.indexOf(f.id)}` : f.id,
            code: f.code,
            message: f.message,
          })),
          layer: r.layer,
        });
        assert.deepEqual(
          normalize(poolResult, poolIds),
          normalize(syncResult, syncIds),
          'ответ MCP не изменился: affected, состав и порядок failures',
        );
        assert.deepEqual(
          poolResult.failures.map((f) => f.id),
          [ghostA, ghostB],
          'порядок failures — порядок ids',
        );
      } finally {
        await closeWritePool();
        if (handle !== null) await handle.close();
        await closeMcpContext(ctx);
      }
    });
  },
);
