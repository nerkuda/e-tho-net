/**
 * Паритет групповых операций REST ↔ MCP (задача fffe76f2, веха 7 версии 0.8.2).
 *
 * `POST /thoughts/batch` (03-server-api.md §6.6) и `etn.thoughts.bulk_update`
 * — фасады над одной доменной функцией `applyBulkThoughtOp`
 * (`thought-bulk-service.ts`, ADR 162d8e7a). Тест прогоняет каждую из десяти
 * общих операций через обе точки входа на одинаково устроенных «близнецах» в
 * одной сети и сверяет:
 *
 *   * результат — `affected` и `failures`;
 *   * журнал — добавленные операцией строки `activity_log`
 *     (`action`, `entity_type`, `entity_title` с нормализованными id);
 *   * починку ошибки e8959ae7 — в журнале удаления связи `type_id` реальный
 *     (из снимка связи, а не `null`), независимо от точки входа.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  toolJson,
  toolText,
  type McpClientHandle,
  type McpTestContext,
} from './mcp-helpers.js';
import { openNetworkDb } from '../src/db/network-db.js';

/** Insert a thought directly via SQL — тестам нужны быстрые «близнецы». */
function insertThought(
  ndb: ReturnType<typeof openNetworkDb>,
  title: string,
  typeId: string | null,
  userId: string,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, icon, icon_kind,
                             icon_attachment_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, updated_at,
                             created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, NULL, 'emoji', NULL, 1, 0, 0,
               0, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ndb.layerId,
      title,
      title.toLowerCase(),
      typeId,
      now,
      now,
      userId,
      userId,
      nowMs,
      nowMs,
    );
  return id;
}

/** Результат групповой операции точки входа. */
interface BulkResult {
  affected: number;
  failures: Array<{ id: string; code: string; message: string }>;
}

/** Одна строка журнала, сравнимая между точками входа. */
interface JournalRow {
  action: string;
  entity_type: string;
  entity_title: string;
}

/** Прочитать строки `activity_log`, добавленные после снимка `before`. */
function journalSince(
  ndb: ReturnType<typeof openNetworkDb>,
  before: ReadonlySet<string>,
  idTokens: ReadonlyMap<string, string>,
): JournalRow[] {
  const rows = ndb
    .prepare(
      `SELECT id, action, entity_type, entity_title
         FROM activity_log
        ORDER BY occurred_at_ms ASC, id ASC`,
    )
    .all() as Array<{ id: string; action: string; entity_type: string; entity_title: string }>;
  const fresh = rows.filter((r) => !before.has(r.id));
  return fresh.map((r) => {
    let title = r.entity_title;
    for (const [id, token] of idTokens) {
      title = title.split(id).join(token);
    }
    return { action: r.action, entity_type: r.entity_type, entity_title: title };
  });
}

/** Снимок всех id строк журнала на текущий момент. */
function journalIds(ndb: ReturnType<typeof openNetworkDb>): Set<string> {
  const rows = ndb.prepare('SELECT id FROM activity_log').all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** Прогнать групповую операцию через REST и вернуть результат. */
async function restBulk(
  ctx: RestTestContext,
  op: string,
  ids: string[],
  args: Record<string, unknown> | undefined,
): Promise<BulkResult> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
    headers: authHeaders(ctx),
    payload: args === undefined ? { ids, op } : { ids, op, args },
  });
  assert.equal(res.statusCode, 200, `REST ${op}: ${res.statusCode}`);
  return res.json().data as BulkResult;
}

/** Прогнать групповую операцию через MCP и вернуть результат. */
async function mcpBulk(
  handle: McpClientHandle,
  networkId: string,
  op: string,
  ids: string[],
  args: Record<string, unknown> | undefined,
): Promise<BulkResult> {
  const result = await handle.client.callTool({
    name: 'etn.thoughts.bulk_update',
    arguments: args === undefined ? { network_id: networkId, ids, op } : { network_id: networkId, ids, op, args },
  });
  assert.equal(result.isError, undefined, `MCP ${op}: ${toolText(result)}`);
  return toolJson<BulkResult>(result);
}

describe(
  'групповые операции: паритет REST /thoughts/batch и MCP etn.thoughts.bulk_update',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('все десять общих операций дают одинаковый результат и журнал; удаления несут реальный type_id (e8959ae7)', async () => {
      const restCtx = await buildRestContext();
      const overrides = {
        dataDir: restCtx.dataDir,
        systemDb: restCtx.sys,
        networkId: restCtx.networkId,
      };
      let mcpCtx: McpTestContext | undefined;
      let handle: McpClientHandle | undefined;
      try {
        // Мысле-тип и тип связи — общие для обеих сторон.
        const typeRes = await restCtx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${restCtx.networkId}/thought-types`,
          headers: authHeaders(restCtx),
          payload: { name: 'ПараТип' },
        });
        assert.equal(typeRes.statusCode, 201);
        const thoughtTypeId = (typeRes.json().data as { id: string }).id;

        const ltRes = await restCtx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${restCtx.networkId}/properties`,
          headers: authHeaders(restCtx),
          payload: { name: 'ПараСвязь', value_type: 'link', name_forward: 'ПараСвязь', name_reverse: 'ОбратноПараСвязь' },
        });
        assert.equal(ltRes.statusCode, 201);
        const linkTypeId = (
          ltRes.json().data as { config: { link_type_id: string } | null }
        ).config!.link_type_id;

        const ndb = openNetworkDb(restCtx.dataDir, restCtx.networkId);
        // Близнецы: REST-набор (r*) и MCP-набор (m*), одинаково устроенные.
        const rA = insertThought(ndb, 'par-rest-A', null, restCtx.adminId);
        const rB = insertThought(ndb, 'par-rest-B', null, restCtx.adminId);
        const rC = insertThought(ndb, 'par-rest-C', null, restCtx.adminId);
        const rP1 = insertThought(ndb, 'par-rest-P1', null, restCtx.adminId);
        const rP2 = insertThought(ndb, 'par-rest-P2', null, restCtx.adminId);
        const rC2 = insertThought(ndb, 'par-rest-C2', null, restCtx.adminId);
        const mA = insertThought(ndb, 'par-mcp-A', null, restCtx.adminId);
        const mB = insertThought(ndb, 'par-mcp-B', null, restCtx.adminId);
        const mC = insertThought(ndb, 'par-mcp-C', null, restCtx.adminId);
        const mP1 = insertThought(ndb, 'par-mcp-P1', null, restCtx.adminId);
        const mP2 = insertThought(ndb, 'par-mcp-P2', null, restCtx.adminId);
        const mC2 = insertThought(ndb, 'par-mcp-C2', null, restCtx.adminId);

        const idTokens = new Map<string, string>([
          [rA, 'A'], [rB, 'B'], [rC, 'C'], [rP1, 'P1'], [rP2, 'P2'], [rC2, 'C2'],
          [mA, 'A'], [mB, 'B'], [mC, 'C'], [mP1, 'P1'], [mP2, 'P2'], [mC2, 'C2'],
          [thoughtTypeId, 'T'], [linkTypeId, 'LT'],
          // Заголовки «близнецов» тоже отличаются — заменяем и их.
          ['par-rest-A', 'A'], ['par-rest-B', 'B'], ['par-rest-C', 'C'],
          ['par-rest-P1', 'P1'], ['par-rest-P2', 'P2'], ['par-rest-C2', 'C2'],
          ['par-mcp-A', 'A'], ['par-mcp-B', 'B'], ['par-mcp-C', 'C'],
          ['par-mcp-P1', 'P1'], ['par-mcp-P2', 'P2'], ['par-mcp-C2', 'C2'],
        ]);

        mcpCtx = await buildMcpContext(overrides);
        handle = await connectMcpClient(mcpCtx, restCtx.adminKey);

        const ghost = '00000000-0000-4000-8000-0000000000ff';
        const steps: Array<{
          op: string;
          restIds: string[];
          mcpIds: string[];
          restArgs?: Record<string, unknown>;
          mcpArgs?: Record<string, unknown>;
        }> = [
          { op: 'set_type', restIds: [rA], mcpIds: [mA], restArgs: { type_id: thoughtTypeId }, mcpArgs: { type_id: thoughtTypeId } },
          { op: 'clear_type', restIds: [rA], mcpIds: [mA] },
          { op: 'set_active', restIds: [rB], mcpIds: [mB] },
          { op: 'set_inactive', restIds: [rB], mcpIds: [mB] },
          { op: 'trash', restIds: [rC], mcpIds: [mC] },
          // Типизированная связь — для проверки type_id в журнале удаления.
          { op: 'link_parents', restIds: [rA], mcpIds: [mA], restArgs: { parent_ids: [rP1], link_type_id: linkTypeId }, mcpArgs: { parent_ids: [mP1], link_type_id: linkTypeId } },
          { op: 'link_children', restIds: [rP1], mcpIds: [mP1], restArgs: { child_ids: [rC2] }, mcpArgs: { child_ids: [mC2] } },
          { op: 'set_only_parents', restIds: [rA], mcpIds: [mA], restArgs: { parent_ids: [rP2] }, mcpArgs: { parent_ids: [mP2] } },
          { op: 'unlink_parents', restIds: [rA], mcpIds: [mA], restArgs: { parent_ids: [rP2] }, mcpArgs: { parent_ids: [mP2] } },
          { op: 'unlink_children', restIds: [rP1], mcpIds: [mP1], restArgs: { child_ids: [rC2] }, mcpArgs: { child_ids: [mC2] } },
          // Паритет failures: один несуществующий id в батче.
          { op: 'set_inactive', restIds: [rB, ghost], mcpIds: [mB, ghost] },
        ];

        for (const step of steps) {
          const before = journalIds(ndb);

          const restResult = await restBulk(restCtx, step.op, step.restIds, step.restArgs);
          const restJournal = journalSince(ndb, before, idTokens);

          const beforeMcp = journalIds(ndb);
          const mcpResult = await mcpBulk(handle!, restCtx.networkId, step.op, step.mcpIds, step.mcpArgs);
          const mcpJournal = journalSince(ndb, beforeMcp, idTokens);

          assert.deepEqual(
            { affected: mcpResult.affected, failures: mcpResult.failures },
            { affected: restResult.affected, failures: restResult.failures },
            `результат ${step.op}: REST и MCP должны совпадать`,
          );
          assert.deepEqual(
            mcpJournal,
            restJournal,
            `журнал ${step.op}: REST и MCP должны писать одинаковые строки`,
          );
        }

        // Точечная проверка e8959ae7: удаление ТИПИЗИРОВАННОЙ связи пишет в
        // журнал реальный type_id (REST-журнал выше уже содержит «связь P1 → A
        // типа LT», но продублируем явной проверкой, чтобы тест читался сам).
        // Создаём ещё одну типизированную связь и удаляем её через MCP.
        const beforeTypeCheck = journalIds(ndb);
        await mcpBulk(handle!, restCtx.networkId, 'link_parents', [mA], {
          parent_ids: [mP1],
          link_type_id: linkTypeId,
        });
        await mcpBulk(handle!, restCtx.networkId, 'unlink_parents', [mA], {
          parent_ids: [mP1],
        });
        const rows = journalSince(ndb, beforeTypeCheck, idTokens);
        const deletedRows = rows.filter((r) => r.action === 'deleted');
        assert.equal(deletedRows.length, 1);
        assert.equal(
          deletedRows[0]!.entity_title,
          'связь P1 → A типа LT',
          'журнал удаления через MCP должен нести реальный type_id (e8959ae7)',
        );
      } finally {
        if (handle !== undefined) await handle.close();
        if (mcpCtx !== undefined) await closeMcpContext(mcpCtx, overrides);
        await closeRestContext(restCtx);
      }
    });
  },
);
