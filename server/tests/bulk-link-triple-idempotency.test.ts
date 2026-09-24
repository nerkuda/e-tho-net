/**
 * Идемпотентность массовых операций со связями — по тройке живых рёбер
 * (задача 3f35d354, требование 4591f837, миграция 029).
 *
 * `POST /thoughts/batch` (§6.6) и MCP `etn.thoughts.bulk_update` — фасады над
 * доменной `applyBulkThoughtOp` (`thought-bulk-service.ts`). До правки
 * `link_parents`/`set_only_parents` считали пару уже связанной при ЛЮБОЙ
 * имеющейся связи (включая типизированную или помеченную на удаление) и
 * пропускали создание структурного ребра; из-за `affected: 1` без ошибок это
 * выглядело как успех (инцидент 73d8675c).
 *
 * Теперь пропуск возможен только при живом ребре той же тройки
 * `(source, target, args.link_type_id ?? null)`.
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
import type { NetworkDb } from '../src/db/network-db.js';

/** Insert a thought directly. */
function insertThought(ndb: NetworkDb, title: string, userId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, icon, icon_kind,
                             icon_attachment_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, updated_at,
                             created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, NULL, NULL, 'emoji', NULL, 1, 0, 0,
               0, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), now, now, userId, userId, nowMs, nowMs);
  return id;
}

/** Insert a link type directly. */
function insertLinkType(ndb: NetworkDb, nameForward: string, userId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO link_types (id, name_forward, name_reverse, description, color, style,
                               version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, NULL, NULL, 'solid', 1, ?, ?, ?)`,
    )
    .run(id, nameForward, `${nameForward}-обратно`, now, now, userId);
  return id;
}

/** Insert a directed link directly; `typeId: null` — структурная связь. */
function insertLink(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  typeId: string | null,
  userId: string,
  opts: { trashed?: boolean } = {},
): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion,
                          color, style, width, version, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, NULL, 1, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      sourceId,
      targetId,
      typeId,
      opts.trashed ? 1 : 0,
      now,
      now,
      userId,
      userId,
    );
}

/** Число ЖИВЫХ рёбер тройки (source, target, type); NULL-safe по типу. */
function liveTripleCount(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  typeId: string | null,
): number {
  const row = ndb
    .prepare(
      `SELECT COUNT(*) AS c FROM links_v
        WHERE source_id = ? AND target_id = ? AND ifnull(type_id, '') = ifnull(?, '')
          AND marked_for_deletion = 0`,
    )
    .get(sourceId, targetId, typeId) as { c: number };
  return row.c;
}

/** Прогнать групповую операцию через REST. */
async function runBatch(
  ctx: RestTestContext,
  op: string,
  ids: string[],
  args?: Record<string, unknown>,
): Promise<{ affected: number; failures: unknown[] }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
    headers: authHeaders(ctx),
    payload: args === undefined ? { ids, op } : { ids, op, args },
  });
  assert.equal(res.statusCode, 200, `REST ${op}: ${res.statusCode} ${res.body}`);
  return res.json().data as { affected: number; failures: unknown[] };
}

describe('bulk-связи: идемпотентность по тройке живых рёбер (3f35d354)', { skip: !nativeAvailable() }, () => {
  it('link_parents создаёт структурное ребро при типизированной связи пары и не дублирует при повторе', async () => {
    const ctx = await buildRestContext();
    try {
      const ndb = ctx.ndb;
      const linkTypeId = insertLinkType(ndb, 'типизированная', ctx.adminId);
      const a = insertThought(ndb, 'A', ctx.adminId);
      const p = insertThought(ndb, 'P', ctx.adminId);
      // У пары P → A уже есть ТИПИЗИРОВАННАЯ связь.
      insertLink(ndb, p, a, linkTypeId, ctx.adminId);

      // link_parents без link_type_id — структурная связь.
      const first = await runBatch(ctx, 'link_parents', [a], { parent_ids: [p] });
      assert.equal(first.affected, 1);
      assert.deepEqual(first.failures, []);
      assert.equal(
        liveTripleCount(ndb, p, a, null),
        1,
        'структурное ребро обязано появиться рядом с типизированным',
      );
      assert.equal(liveTripleCount(ndb, p, a, linkTypeId), 1, 'типизированное ребро не тронуто');

      // Повторный вызов не дублирует живое ребро той же тройки.
      const second = await runBatch(ctx, 'link_parents', [a], { parent_ids: [p] });
      assert.equal(second.affected, 1);
      assert.equal(liveTripleCount(ndb, p, a, null), 1, 'повтор не создаёт дубль тройки');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('link_parents создаёт структурное ребро, когда связь пары лежит в корзине', async () => {
    const ctx = await buildRestContext();
    try {
      const ndb = ctx.ndb;
      const linkTypeId = insertLinkType(ndb, 'корзинная', ctx.adminId);
      const a = insertThought(ndb, 'A', ctx.adminId);
      const p = insertThought(ndb, 'P', ctx.adminId);
      // Помеченная на удаление типизированная связь пары.
      insertLink(ndb, p, a, linkTypeId, ctx.adminId, { trashed: true });

      const result = await runBatch(ctx, 'link_parents', [a], { parent_ids: [p] });
      assert.equal(result.affected, 1);
      assert.deepEqual(result.failures, []);
      assert.equal(
        liveTripleCount(ndb, p, a, null),
        1,
        'корзинная связь пары не должна блокировать создание структурного ребра',
      );
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('link_parents восстанавливает корзинное ребро ТОЙ ЖЕ тройки, а не падает DUPLICATE', async () => {
    const ctx = await buildRestContext();
    try {
      const ndb = ctx.ndb;
      const linkTypeId = insertLinkType(ndb, 'корзинная-же-тройка', ctx.adminId);
      const a = insertThought(ndb, 'A', ctx.adminId);
      const p = insertThought(ndb, 'P', ctx.adminId);
      // Пара связана ровно той же тройкой, что просит операция, но ребро в корзине.
      insertLink(ndb, p, a, linkTypeId, ctx.adminId, { trashed: true });

      const result = await runBatch(ctx, 'link_parents', [a], {
        parent_ids: [p],
        link_type_id: linkTypeId,
      });
      assert.equal(result.affected, 1);
      assert.deepEqual(result.failures, []);
      assert.equal(
        liveTripleCount(ndb, p, a, linkTypeId),
        1,
        'корзинное ребро той же тройки обязано восстановиться',
      );
      const rows = ndb
        .prepare('SELECT COUNT(*) AS c FROM links_v WHERE source_id = ? AND target_id = ?')
        .get(p, a) as { c: number };
      assert.equal(rows.c, 1, 'вторая строка той же тройки не создаётся');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('set_only_parents досоздаёт структурное ребро при существующей типизированной связи якоря', async () => {
    const ctx = await buildRestContext();
    try {
      const ndb = ctx.ndb;
      const linkTypeId = insertLinkType(ndb, 'якорная', ctx.adminId);
      const c = insertThought(ndb, 'C', ctx.adminId);
      const p = insertThought(ndb, 'P', ctx.adminId);
      const stale = insertThought(ndb, 'Stale', ctx.adminId);
      // У C уже есть типизированная связь от якоря P и «мусорная» от Stale.
      insertLink(ndb, p, c, linkTypeId, ctx.adminId);
      insertLink(ndb, stale, c, null, ctx.adminId);

      const result = await runBatch(ctx, 'set_only_parents', [c], { parent_ids: [p] });
      assert.equal(result.affected, 1);
      assert.deepEqual(result.failures, []);
      assert.equal(
        liveTripleCount(ndb, p, c, null),
        1,
        'set_only_parents обязан досоздать структурное ребро якоря',
      );
      // Прочие входящие связи снесены (в основе — физически).
      assert.equal(liveTripleCount(ndb, stale, c, null), 0, 'постороннее ребро удалено');
    } finally {
      await closeRestContext(ctx);
    }
  });
});
