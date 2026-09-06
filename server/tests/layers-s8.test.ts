/**
 * Integration tests for the layer merge (task S8, docs/13-layers.md §8;
 * docs/03-server-api.md §5a.6) via app.inject:
 *
 *   * clean merge — the layer's final state lands in the parent, the layer
 *     empties, exactly one `layer.merged` event is emitted (04-realtime.md
 *     §11.4), and the reserve layer keeps the pre-merge state (§8.2);
 *   * a parent edit made after the layer's birth rejects the whole merge
 *     with the divergence list (§8.1);
 *   * a non-closed partial merge is rejected with `missing_closure` and
 *     passes once the selection is completed (§8.1);
 *   * the reserve layer is a holding layer by design: it keeps the trash
 *     auto-purge (§8.4) from purging the rows it backs up until the reserve
 *     itself is deleted (13-layers.md §8.2);
 *   * the S14 DoD scenario: re-typed links, re-pointed links (tombstone +
 *     new id), deleted links and a reordered children batch merge without
 *     losses and without dangling edges, the reorder collapsing into one
 *     `reorder_collapsed` entry (§6.5);
 *   * the §6.2 logical duplicate collapses onto the parent's link;
 *   * the §6.4 residual case: a link to an endpoint physically purged via
 *     another layer's merge is skipped with a report entry, the merge
 *     continues and the link stays in its layer.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';

import { describe, it } from 'node:test';

import { BASE_LAYER_ID, type Layer, type LayerMergeReport } from '@etn/shared';

import { openNetworkDb } from '../src/db/network-db.js';
import { materializeShadow } from '../src/db/layer-write.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Methods used by this suite; `inject`'s `method` (light-my-request) rejects
 * fastify's wider `HTTPMethods` union (no `trace`), so keep a local one. */
type InjectMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A REST call helper bound to the context; `clientId` selects the session. */
async function call(
  ctx: RestTestContext,
  method: InjectMethod,
  url: string,
  payload?: Record<string, unknown>,
  opts: { clientId?: string; ifMatch?: number } = {},
) {
  return ctx.app.inject({
    method,
    url: `/api/v1/networks/${ctx.networkId}${url}`,
    headers: {
      ...authHeaders(ctx),
      ...(opts.clientId !== undefined ? { 'client-id': opts.clientId } : {}),
      ...(opts.ifMatch !== undefined ? { 'if-match': String(opts.ifMatch) } : {}),
    },
    ...(payload !== undefined ? { payload } : {}),
  });
}

/** Create a thought (default session — the base) and return its id. */
async function thought(ctx: RestTestContext, title: string, clientId?: string): Promise<string> {
  const res = await call(ctx, 'POST', '/thoughts', { title }, { clientId });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

/** Create a link and return its id. */
async function link(
  ctx: RestTestContext,
  sourceId: string,
  targetId: string,
  typeId?: string,
  clientId?: string,
): Promise<string> {
  const res = await call(
    ctx,
    'POST',
    '/links',
    { source_id: sourceId, target_id: targetId, ...(typeId !== undefined ? { type_id: typeId } : {}) },
    { clientId },
  );
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

/** Create a layer (base-layer session) and return the DTO. */
async function createLayer(ctx: RestTestContext, title: string): Promise<Layer> {
  const res = await call(ctx, 'POST', '/layers', { title });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return res.json().data as Layer;
}

/** Switch a session (by client id) onto a layer. */
async function selectLayer(ctx: RestTestContext, layerId: string, clientId: string): Promise<void> {
  const res = await call(ctx, 'POST', `/layers/${layerId}/select`, {}, { clientId });
  assert.equal(res.statusCode, 200);
}

/** Merge a layer (default session). */
async function merge(ctx: RestTestContext, layerId: string, tables?: Record<string, string[]>) {
  return call(ctx, 'POST', `/layers/${layerId}/merge`, tables !== undefined ? { tables } : {});
}

/** Physical row counts of a logical id across all **working** layers —
 * reserve (service) copies are the rollback point and do not count. */
function rowCount(ctx: RestTestContext, table: string, id: string): number {
  return (
    ctx.ndb
      .prepare(
        `SELECT COUNT(*) AS c FROM ${table} t
         WHERE t.id = ? AND EXISTS (SELECT 1 FROM layers l WHERE l.id = t.layer_id AND l.is_service = 0)`,
      )
      .get(id) as { c: number }
  ).c;
}

/** Physical rows of one layer (test introspection). */
function layerRows(ctx: RestTestContext, table: string, layerId: string): number {
  return (
    ctx.ndb.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE layer_id = ?`).get(layerId) as {
      c: number;
    }
  ).c;
}

const WORKER = 'layer-worker';

describe(
  'POST /layers/:id/merge (S8)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('clean merge: final state lands in the base, layer empties, one layer.merged event', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const b = await thought(ctx, 'B');
        const layer = await createLayer(ctx, 'Чистое слияние');
        await selectLayer(ctx, layer.id, WORKER);

        // Layer edits: an update of A, a new thought C, a new link A→B and
        // a thought D created and deleted inside the layer.
        const patchA = await call(ctx, 'PATCH', `/thoughts/${a}`, { title: 'A (слой)' }, { clientId: WORKER });
        assert.equal(patchA.statusCode, 200);
        const c = await thought(ctx, 'C', WORKER);
        const ab = await link(ctx, a, b, undefined, WORKER);
        const d = await thought(ctx, 'D', WORKER);
        const delD = await call(ctx, 'DELETE', `/thoughts/${d}`, undefined, { clientId: WORKER });
        assert.equal(delD.statusCode, 204);

        const seqBefore = ctx.app.systemDb.getMaxEventSeq(ctx.networkId) ?? 0;
        const res = await merge(ctx, layer.id);
        assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
        const report = res.json().data as LayerMergeReport;
        assert.equal(report.applied.thoughts, 3); // A update + C insert + D tombstone
        assert.equal(report.applied.links, 1);
        assert.deepEqual(report.skipped, []);
        assert.deepEqual(report.reorder_collapsed, []);
        assert.equal(report.purged, 0);
        assert.ok(report.reserve_layer_id);

        // Base sees the layer's final state (default session = base).
        const aAfter = await call(ctx, 'GET', `/thoughts/${a}`);
        assert.equal(aAfter.statusCode, 200);
        assert.equal(aAfter.json().data.title, 'A (слой)');
        assert.equal(aAfter.json().data.version, 2); // version continuity (§8.1)
        const cAfter = await call(ctx, 'GET', `/thoughts/${c}`);
        assert.equal(cAfter.statusCode, 200);
        const dAfter = await call(ctx, 'GET', `/thoughts/${d}`);
        assert.equal(dAfter.statusCode, 404); // never existed in the base
        const abAfter = await call(ctx, 'GET', `/links/${ab}`);
        assert.equal(abAfter.statusCode, 200);

        // If-Match continuity: the version seen in the layer keeps working
        // in the base after the merge.
        const rePatch = await call(ctx, 'PATCH', `/thoughts/${a}`, { title: 'A (основа)' }, { ifMatch: 2 });
        assert.equal(rePatch.statusCode, 200);

        // The layer is emptied relative to its parent (§8.4).
        assert.equal(layerRows(ctx, 'thoughts', layer.id), 0);
        assert.equal(layerRows(ctx, 'links', layer.id), 0);
        // …but survives as an entity.
        const layers = (await call(ctx, 'GET', '/layers')).json().data as Layer[];
        assert.ok(layers.some((l) => l.id === layer.id));

        // The reserve layer: service, hidden by default, carrying the
        // pre-merge state of the overwritten rows (A; C, D and the link were
        // pure inserts/no-op drops with nothing to back up).
        const visible = (await call(ctx, 'GET', '/layers')).json().data as Layer[];
        assert.ok(visible.every((l) => l.id !== report.reserve_layer_id));
        const withService = (await call(ctx, 'GET', '/layers?include_service=true')).json().data as Layer[];
        const reserve = withService.find((l) => l.id === report.reserve_layer_id) as Layer;
        assert.equal(reserve.is_service, true);
        assert.equal(reserve.parent_id, BASE_LAYER_ID);
        const reserveNdb = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, reserve.id);
        const oldA = reserveNdb.prepare('SELECT title FROM thoughts_v WHERE id = ?').get(a) as {
          title: string;
        };
        assert.equal(oldA.title, 'A'); // pre-merge state
        // D never existed in the base (created and deleted inside the
        // layer): its tombstone had no winner, so the reserve has nothing
        // of it — nothing in the base was overwritten on its account.

        // Exactly one layer.merged event, attributed to the merge target.
        const events = ctx.app.systemDb.readEventsAfter(ctx.networkId, seqBefore, 20);
        const mergedEvents = events.filter((e) => e.type === 'layer.merged');
        assert.equal(mergedEvents.length, 1);
        assert.equal(mergedEvents[0]?.layer_id, BASE_LAYER_ID);
        assert.equal((mergedEvents[0]?.data as { target_layer: { id: string } }).target_layer.id, BASE_LAYER_ID);
        assert.equal((mergedEvents[0]?.data as { applied: Record<string, number> }).applied.thoughts, 3);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('a parent edit after the layer was born rejects the merge with the divergence list', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const layer = await createLayer(ctx, 'Конфликт');
        await selectLayer(ctx, layer.id, WORKER);
        const patch = await call(ctx, 'PATCH', `/thoughts/${a}`, { icon: '🧪' }, { clientId: WORKER });
        assert.equal(patch.statusCode, 200);

        // The base edits the same row after the layer materialised its
        // shadow: the merge must refuse, naming the row.
        const basePatch = await call(ctx, 'PATCH', `/thoughts/${a}`, { icon: '🌐' });
        assert.equal(basePatch.statusCode, 200);

        const res = await merge(ctx, layer.id);
        assert.equal(res.statusCode, 422);
        assert.equal(res.json().error.code, 'VALIDATION_ERROR');
        const conflicts = res.json().error.details.conflicts as Array<{
          table: string;
          id: string;
          expected_base_version: number;
          current_version: number;
        }>;
        assert.deepEqual(conflicts, [
          { table: 'thoughts', id: a, expected_base_version: 1, current_version: 2 },
        ]);

        // Nothing was applied: no reserve layer, the shadow stays in place.
        const withService = (await call(ctx, 'GET', '/layers?include_service=true')).json().data as Layer[];
        assert.ok(withService.every((l) => l.is_service === false));
        assert.equal(layerRows(ctx, 'thoughts', layer.id), 1);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('partial merge: a broken selection is rejected with missing_closure, a closed one passes', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const layer = await createLayer(ctx, 'Частичное');
        await selectLayer(ctx, layer.id, WORKER);
        const x = await thought(ctx, 'X (слой)', WORKER);
        const ab = await link(ctx, a, x, undefined, WORKER);

        // Selecting the link alone leaves X outside both the merge and the
        // parent — the set is not closed (§8.1).
        const broken = await merge(ctx, layer.id, { links: [ab] });
        assert.equal(broken.statusCode, 422);
        const missing = broken.json().error.details.missing_closure as Array<{
          table: string;
          id: string;
          referenced_by: { table: string; id: string };
        }>;
        assert.deepEqual(missing, [
          { table: 'thoughts', id: x, referenced_by: { table: 'links', id: ab } },
        ]);

        // Completing the selection merges cleanly; the untouched remainder
        // of the layer (nothing here) stays.
        const ok = await merge(ctx, layer.id, { links: [ab], thoughts: [x] });
        assert.equal(ok.statusCode, 200, JSON.stringify(ok.json()));
        const report = ok.json().data as LayerMergeReport;
        assert.equal(report.applied.thoughts, 1);
        assert.equal(report.applied.links, 1);
        const xAfter = await call(ctx, 'GET', `/thoughts/${x}`);
        assert.equal(xAfter.statusCode, 200);
        const abAfter = await call(ctx, 'GET', `/links/${ab}`);
        assert.equal(abAfter.statusCode, 200);
        assert.equal(layerRows(ctx, 'thoughts', layer.id), 0);
        assert.equal(layerRows(ctx, 'links', layer.id), 0);

        // Unknown ids are a 422, not a silent skip.
        const unknown = await merge(ctx, layer.id, { thoughts: ['00000000-0000-4000-8000-0000000000ff'] });
        assert.equal(unknown.statusCode, 422);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('full merge passes when a layer-edited value holds a MULTIPLE thought_ref array (0.6.5 fix)', async () => {
      const ctx = await buildRestContext();
      try {
        // A multiple thought_ref property, attached to a type the owner wears;
        // both reference targets live in the BASE only (they were never
        // touched by the layer) — exactly the production shape that used to
        // fail closure: value_thought_ref holds a JSON array, and the whole
        // JSON text was passed as one "thought id".
        const prop = await call(ctx, 'POST', '/properties', {
          name: 'связанные задачи',
          value_type: 'thought_ref',
          config: { multiple: true },
        });
        assert.equal(prop.statusCode, 201, prop.body?.toString());
        const propertyId = (prop.json().data as { id: string }).id;

        const type = await call(ctx, 'POST', '/thought-types', { name: 'Носитель свойств' });
        assert.equal(type.statusCode, 201, type.body?.toString());
        const typeId = (type.json().data as { id: string }).id;

        const attach = await call(ctx, 'POST', `/thought-types/${typeId}/properties`, {
          mode: 'attach',
          property_id: propertyId,
        });
        assert.equal(attach.statusCode, 201, attach.body?.toString());

        const t1 = await thought(ctx, 'Цель 1');
        const t2 = await thought(ctx, 'Цель 2');
        const owner = await call(ctx, 'POST', '/thoughts', {
          title: 'Владелец значения',
          type_id: typeId,
        });
        assert.equal(owner.statusCode, 201, owner.body?.toString());
        const ownerId = (owner.json().data as { id: string }).id;

        const layer = await createLayer(ctx, 'Множественная ссылка');
        await selectLayer(ctx, layer.id, WORKER);

        // Set the multiple value FROM the layer: the shadow row lands in the
        // layer carrying value_thought_ref = '["t1","t2"]'.
        const set = await call(
          ctx,
          'PUT',
          `/thoughts/${ownerId}/properties/связанные задачи`,
          { value: [t1, t2] },
          { clientId: WORKER },
        );
        assert.equal(set.statusCode, 200, set.body?.toString());

        // Full merge: must close (the array expands into live target refs)
        // and replay the value into the base.
        const res = await merge(ctx, layer.id);
        assert.equal(res.statusCode, 200, res.body?.toString());
        const report = res.json().data as LayerMergeReport;
        assert.equal(report.applied.property_values, 1);

        const values = await call(ctx, 'GET', `/thoughts/${ownerId}/properties`);
        assert.equal(values.statusCode, 200);
        const list = values.json().data as Array<{ value: unknown }>;
        const stored = list.find((v) => Array.isArray(v.value))?.value;
        assert.deepEqual(stored, [t1, t2]);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('the reserve layer holds trash rows until it is deleted (documented §8.2 decision)', async () => {
      const ctx = await buildRestContext();
      try {
        const m = await thought(ctx, 'M');
        const layer = await createLayer(ctx, 'Корзина');
        await selectLayer(ctx, layer.id, WORKER);
        // Mark the thought from inside the layer: the shadow carries the mark.
        const mark = await call(ctx, 'PATCH', `/thoughts/${m}`, { marked_for_deletion: true }, { clientId: WORKER });
        assert.equal(mark.statusCode, 200);

        const res = await merge(ctx, layer.id);
        assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
        const report = res.json().data as LayerMergeReport;
        // The mark landed in the base; the reserve backs the pre-merge live
        // row, so the auto-purge (§8.4) cannot purge it yet.
        assert.equal(report.purged, 0);
        const mAfter = await call(ctx, 'GET', `/thoughts/${m}`);
        assert.equal(mAfter.statusCode, 200);
        assert.equal(mAfter.json().data.marked_for_deletion, true);

        const trash = (await call(ctx, 'GET', '/trash')).json().data as {
          thoughts: Array<{ id: string; blocked: boolean; blocking: { layers: Array<{ id: string }> } }>;
        };
        const entry = trash.thoughts.find((t) => t.id === m);
        assert.ok(entry !== undefined);
        assert.equal(entry.blocked, true);
        assert.deepEqual(entry.blocking.layers.map((l) => l.id), [report.reserve_layer_id]);

        // Deleting the reserve releases the hold — and the layer-deletion
        // auto-purge (§2.4) removes M in the same transaction.
        const delReserve = await call(ctx, 'DELETE', `/layers/${report.reserve_layer_id}`);
        assert.equal(delReserve.statusCode, 200, delReserve.body?.toString());
        assert.equal((delReserve.json().data as { purged: number }).purged, 1);
        assert.equal(rowCount(ctx, 'thoughts', m), 0);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('S14 scenario: retype, repoint, delete, reorder merge without losses; reorder collapses to one entry', async () => {
      const ctx = await buildRestContext();
      try {
        // Base: parent P1 with children C1..C3 and D1..D3, plus P2; a link
        // type for the re-typing.
        const p1 = await thought(ctx, 'P1');
        const p2 = await thought(ctx, 'P2');
        const children: Record<string, string> = {};
        for (const name of ['C1', 'C2', 'C3', 'D1', 'D2', 'D3']) {
          children[name] = await thought(ctx, name);
        }
        const type = await call(ctx, 'POST', '/link-types', { name_forward: 'смотрит на', name_reverse: 'показан в' });
        assert.equal(type.statusCode, 201, JSON.stringify(type.json()));
        const typeId = type.json().data.id as string;

        const linkC1 = await link(ctx, p1, children.C1!);
        const linkC2 = await link(ctx, p1, children.C2!);
        const linkC3 = await link(ctx, p1, children.C3!);
        const linkD = [await link(ctx, p1, children.D1!), await link(ctx, p1, children.D2!), await link(ctx, p1, children.D3!)];

        const layer = await createLayer(ctx, 'Правки связей');
        await selectLayer(ctx, layer.id, WORKER);

        // (a) retype a link — an UPDATE of the same identity (§6.1);
        const retype = await call(ctx, 'PATCH', `/links/${linkC1}`, { type_id: typeId }, { clientId: WORKER });
        assert.equal(retype.statusCode, 200, JSON.stringify(retype.json()));
        assert.equal(retype.json().data.id, linkC1);

        // (b) repoint a link — tombstone + new id (§6.1);
        const repoint = await call(
          ctx,
          'PATCH',
          `/links/${linkC2}`,
          { source_id: p2, target_id: children.C2! },
          { clientId: WORKER },
        );
        assert.equal(repoint.statusCode, 200, JSON.stringify(repoint.json()));
        const repointedId = repoint.json().data.id as string;
        assert.notEqual(repointedId, linkC2);

        // (c) delete a link — a tombstone;
        const del = await call(ctx, 'DELETE', `/links/${linkC3}`, undefined, { clientId: WORKER });
        assert.equal(del.statusCode, 204);

        // (d) reorder the D-children — position-only writes on three rows.
        const layerNdb = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, layer.id);
        const positions = [3, 1, 2];
        for (let i = 0; i < linkD.length; i += 1) {
          materializeShadow(layerNdb, 'links', linkD[i]!);
          layerNdb
            .prepare('UPDATE links SET position = ?, version = version + 1 WHERE id = ? AND layer_id = ?')
            .run(positions[i], linkD[i]!, layer.id);
        }

        const res = await merge(ctx, layer.id);
        assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
        const report = res.json().data as LayerMergeReport;
        // linkC1 update + linkC2 tombstone + repointed insert + linkC3
        // tombstone + 3 D-updates.
        assert.equal(report.applied.links, 7);
        // One collapsed entry per reordered parent — not N positions (§6.5).
        assert.deepEqual(report.reorder_collapsed, [{ thought_id: p1, count: 3 }]);
        assert.deepEqual(report.skipped, []);

        // The base state matches the layer's final state.
        const c1 = ctx.ndb
          .prepare('SELECT type_id FROM links WHERE id = ? AND layer_id = ?')
          .get(linkC1, BASE_LAYER_ID) as { type_id: string };
        assert.equal(c1.type_id, typeId);
        assert.equal(rowCount(ctx, 'links', linkC2), 0); // old identity gone physically
        const repointed = ctx.ndb
          .prepare('SELECT source_id, target_id FROM links WHERE id = ? AND layer_id = ?')
          .get(repointedId, BASE_LAYER_ID) as { source_id: string; target_id: string };
        assert.equal(repointed.source_id, p2);
        assert.equal(repointed.target_id, children.C2!);
        assert.equal(rowCount(ctx, 'links', linkC3), 0);
        for (let i = 0; i < linkD.length; i += 1) {
          const row = ctx.ndb
            .prepare('SELECT position FROM links WHERE id = ? AND layer_id = ?')
            .get(linkD[i]!, BASE_LAYER_ID) as { position: number };
          assert.equal(row.position, positions[i]);
        }

        // No dangling edges anywhere: every base link resolves to live
        // thoughts through the visibility views (§5.2 filter).
        const dangling = ctx.ndb
          .prepare(
            `SELECT COUNT(*) AS c FROM links l WHERE l.layer_id = ?
             AND NOT EXISTS (SELECT 1 FROM thoughts_v t WHERE t.id = l.source_id)
             AND NOT EXISTS (SELECT 1 FROM thoughts_v t WHERE t.id = l.target_id)`,
          )
          .get(BASE_LAYER_ID) as { c: number };
        assert.equal(dangling.c, 0);
        assert.equal(layerRows(ctx, 'links', layer.id), 0);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('§6.2: a duplicate triple collapses onto the parent link instead of inserting', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const b = await thought(ctx, 'B');
        const type = await call(ctx, 'POST', '/link-types', { name_forward: 'связан с', name_reverse: 'связан с' });
        const typeId = type.json().data.id as string;

        const layer = await createLayer(ctx, 'Дубль');
        await selectLayer(ctx, layer.id, WORKER);
        // The layer creates A→B of type T first…
        const layerLinkId = await link(ctx, a, b, typeId, WORKER);
        const layerNdb = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, layer.id);
        layerNdb
          .prepare('UPDATE links SET position = ? WHERE id = ? AND layer_id = ?')
          .run(7, layerLinkId, layer.id);

        // …then the base independently creates the same triple under a
        // different id (invisible to the layer at its creation time).
        const baseLinkId = await link(ctx, a, b, typeId);

        const res = await merge(ctx, layer.id);
        assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
        const report = res.json().data as LayerMergeReport;
        assert.equal(report.applied.links, 1); // counted as merged, but collapsed

        // Exactly one live A→B typed link in the base — the parent's row with
        // the layer's non-triple fields applied (§6.2).
        const rows = ctx.ndb
          .prepare(
            `SELECT id, position, version FROM links
             WHERE layer_id = ? AND source_id = ? AND target_id = ? AND type_id = ?`,
          )
          .all(BASE_LAYER_ID, a, b, typeId) as Array<{ id: string; position: number; version: number }>;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.id, baseLinkId);
        assert.equal(rows[0]?.position, 7); // layer's order applied
        assert.equal(rows[0]?.version, 2); // ordinary edit bump
        assert.equal(rowCount(ctx, 'links', layerLinkId), 0);
        assert.equal(layerRows(ctx, 'links', layer.id), 0);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('§6.4: a link to an endpoint purged via another merge is skipped with a report entry', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const b = await thought(ctx, 'B');

        // L1 creates a link onto B; a sibling layer L2 deletes B.
        const l1 = await createLayer(ctx, 'Связь');
        await selectLayer(ctx, l1.id, 'worker-1');
        const ab = await link(ctx, a, b, undefined, 'worker-1');

        const l2 = await createLayer(ctx, 'Удаление B');
        await selectLayer(ctx, l2.id, 'worker-2');
        const delB = await call(ctx, 'DELETE', `/thoughts/${b}`, undefined, { clientId: 'worker-2' });
        assert.equal(delB.statusCode, 204);

        // Merging L2 removes B's base row — the replay touches only the
        // target's rows, so L1's link shadow survives (13-layers.md §8.1).
        const res2 = await merge(ctx, l2.id);
        assert.equal(res2.statusCode, 200, JSON.stringify(res2.json()));
        const bGone = await call(ctx, 'GET', `/thoughts/${b}`);
        assert.equal(bGone.statusCode, 404);

        // Merging L1 now hits the residual case: the link's target is
        // physically gone everywhere — the link is skipped, the merge
        // succeeds, and the link row stays in the layer.
        const res1 = await merge(ctx, l1.id);
        assert.equal(res1.statusCode, 200, JSON.stringify(res1.json()));
        const report = res1.json().data as LayerMergeReport;
        assert.deepEqual(report.skipped, [
          { table: 'links', id: ab, reason: 'endpoint_missing', missing: 'target' },
        ]);
        assert.deepEqual(report.applied, {});
        assert.equal(report.reserve_layer_id, null); // nothing was overwritten
        assert.equal(rowCount(ctx, 'links', ab), 1); // still in the layer
        assert.equal(layerRows(ctx, 'links', l1.id), 1);
        const abInBase = await call(ctx, 'GET', `/links/${ab}`);
        assert.equal(abInBase.statusCode, 404); // not created in the base
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('merging into a non-base parent materialises shadows and tombstones in it, base untouched', async () => {
      const ctx = await buildRestContext();
      try {
        // chain: base ← L1 ← L2. L2 edits base rows; the merge target is L1.
        const a = await thought(ctx, 'A');
        const b = await thought(ctx, 'B');
        const l1 = await createLayer(ctx, 'L1');
        await selectLayer(ctx, l1.id, 'worker-1');
        const l2res = await call(ctx, 'POST', '/layers', { title: 'L2', parent_id: l1.id });
        assert.equal(l2res.statusCode, 201);
        const l2 = l2res.json().data as Layer;
        await selectLayer(ctx, l2.id, 'worker-2');

        const patchA = await call(ctx, 'PATCH', `/thoughts/${a}`, { title: 'A (L2)' }, { clientId: 'worker-2' });
        assert.equal(patchA.statusCode, 200);
        const delB = await call(ctx, 'DELETE', `/thoughts/${b}`, undefined, { clientId: 'worker-2' });
        assert.equal(delB.statusCode, 204);

        const res = await merge(ctx, l2.id);
        assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
        const report = res.json().data as LayerMergeReport;
        assert.equal(report.applied.thoughts, 2);
        // The winners lived in the base (above L1), but the reserve still
        // backs them up — it must show the pre-merge state visible from L1
        // (13-layers.md §8.2), so it is created as a service child of L1.
        assert.ok(report.reserve_layer_id);
        const reserveRows = ctx.ndb
          .prepare('SELECT COUNT(*) AS c FROM thoughts WHERE layer_id = ?')
          .get(report.reserve_layer_id) as { c: number };
        assert.equal(reserveRows.c, 2);

        // L1 sees the merged state: A's shadow (version continuity, base
        // version pinned to the base row it was replayed against) and B's
        // tombstone.
        const aShadow = ctx.ndb
          .prepare('SELECT title, version, base_version, deleted FROM thoughts WHERE id = ? AND layer_id = ?')
          .get(a, l1.id) as { title: string; version: number; base_version: number; deleted: number };
        assert.equal(aShadow.title, 'A (L2)');
        assert.equal(aShadow.version, 2);
        assert.equal(aShadow.base_version, 1);
        const bTomb = ctx.ndb
          .prepare('SELECT deleted, base_version FROM thoughts WHERE id = ? AND layer_id = ?')
          .get(b, l1.id) as { deleted: number; base_version: number };
        assert.equal(bTomb.deleted, 1);
        assert.equal(bTomb.base_version, 1);
        const seenInL1 = await call(ctx, 'GET', `/thoughts/${a}`, undefined, { clientId: 'worker-1' });
        assert.equal(seenInL1.json().data.title, 'A (L2)');
        const bInL1 = await call(ctx, 'GET', `/thoughts/${b}`, undefined, { clientId: 'worker-1' });
        assert.equal(bInL1.statusCode, 404);

        // The base underneath is untouched; L2 is emptied.
        const aInBase = await call(ctx, 'GET', `/thoughts/${a}`);
        assert.equal(aInBase.json().data.title, 'A');
        const bInBase = await call(ctx, 'GET', `/thoughts/${b}`);
        assert.equal(bInBase.statusCode, 200);
        assert.equal(layerRows(ctx, 'thoughts', l2.id), 0);

        // The single layer.merged event names L1 (the target), not the base.
        const events = ctx.app.systemDb.readEventsAfter(ctx.networkId, 0, 100);
        const merged = events.filter((e) => e.type === 'layer.merged');
        assert.equal(merged.length, 1);
        assert.equal(merged[0]?.layer_id, l1.id);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
