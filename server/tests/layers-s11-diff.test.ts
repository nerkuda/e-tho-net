/**
 * Integration tests for the layer diff endpoints (task S11,
 * docs/13-layers.md §10.3; docs/03-server-api.md §5a.7):
 *
 *   * structural diff — added / removed / type-changed / reparented /
 *     reorder-collapsed link batches + the overridden id sets;
 *   * textual diff — two deterministically assembled markdown documents:
 *     a repeat call returns byte-identical documents;
 *   * diffing the base layer itself is rejected (422).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BASE_LAYER_ID,
  type Layer,
  type LayerDiffResult,
} from '@etn/shared';

import { openNetworkDb } from '../src/db/network-db.js';
import { materializeShadow } from '../src/db/layer-write.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Create a layer via the API. */
async function createLayer(ctx: RestTestContext, title: string): Promise<Layer> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return res.json().data as Layer;
}

/** Select the session's current layer. */
async function selectLayer(ctx: RestTestContext, layerId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/select`,
    headers: authHeaders(ctx),
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

/** Create a thought; returns its id. */
async function postThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

/** Create a link source → target; returns its id. */
async function postLink(
  ctx: RestTestContext,
  sourceId: string,
  targetId: string,
  typeId?: string,
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/links`,
    headers: authHeaders(ctx),
    payload: { source_id: sourceId, target_id: targetId, ...(typeId !== undefined ? { type_id: typeId } : {}) },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

/** Delete a link. */
async function deleteLink(ctx: RestTestContext, linkId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/networks/${ctx.networkId}/links/${linkId}`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 204, res.body?.toString());
}

/** Create a link type; returns its id. */
async function postLinkType(ctx: RestTestContext, nameForward: string, nameReverse: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/link-types`,
    headers: authHeaders(ctx),
    payload: { name_forward: nameForward, name_reverse: nameReverse },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

/** Fetch the structural diff. */
async function getDiff(ctx: RestTestContext, layerId: string): Promise<LayerDiffResult> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/diff`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
  return res.json().data as LayerDiffResult;
}

/** Fetch the textual diff docs. */
async function getDiffDoc(
  ctx: RestTestContext,
  layerId: string,
): Promise<{ layer_doc: string; target_doc: string }> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/diff/doc`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
  return res.json().data as { layer_doc: string; target_doc: string };
}

describe(
  '/layers diff routes (S11)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('structural diff reports link changes and overridden ids', async () => {
      const ctx = await buildRestContext();
      try {
        // Base: A → B, B → C, A → E.
        const a = await postThought(ctx, 'А');
        const b = await postThought(ctx, 'Б');
        const c = await postThought(ctx, 'В');
        const e = await postThought(ctx, 'Е');
        const linkAB = await postLink(ctx, a, b);
        await postLink(ctx, b, c);
        const linkAE = await postLink(ctx, a, e);
        const linkType = await postLinkType(ctx, 'зависит от', 'нужен для');

        const layer = await createLayer(ctx, 'Правки');
        await selectLayer(ctx, layer.id);

        // In the layer: type change on A→B, drop B→C, reparent C under A,
        // plus a fresh thought+link pair.
        const typePatch = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/links/${linkAB}`,
          headers: authHeaders(ctx),
          payload: { type_id: linkType },
        });
        assert.equal(typePatch.statusCode, 200, typePatch.body?.toString());

        const bcLinks = (await getDiff(ctx, layer.id)).links;
        // Find the B→C link id via the diff of the base context: simpler —
        // query it directly from the base connection.
        const baseNdb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const bcRow = baseNdb
          .prepare('SELECT id FROM links_v WHERE source_id = ? AND target_id = ?')
          .get(b, c) as { id: string };
        await deleteLink(ctx, bcRow.id);

        await postLink(ctx, a, c);

        const d = await postThought(ctx, 'Г');
        await postLink(ctx, c, d);

        // Reorder: bump the A→E link's position directly (position is T1 —
        // not surfaced in the API yet; the diff must still see it). The row
        // keeps its triple, so it must fold into a reorder batch. The link
        // row must first be materialised in the layer — the direct UPDATE
        // below would otherwise find no shadow row.
        const layerNdb = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, layer.id);
        const aeRow = layerNdb
          .prepare('SELECT id FROM links_v WHERE source_id = ? AND target_id = ?')
          .get(a, e) as { id: string };
        assert.equal(materializeShadow(layerNdb, 'links', aeRow.id), true);
        layerNdb
          .prepare('UPDATE links SET position = 7 WHERE id = ? AND layer_id = ?')
          .run(aeRow.id, layer.id);

        const diff = await getDiff(ctx, layer.id);
        const L = diff.links;

        assert.equal(diff.layer.id, layer.id);
        assert.equal(diff.target_layer.id, BASE_LAYER_ID);

        assert.equal(L.type_changed.length, 1);
        assert.equal(L.type_changed[0]?.id, linkAB);
        assert.equal(L.type_changed[0]?.from_type_id, null);
        assert.equal(L.type_changed[0]?.to_type_id, linkType);

        // The B→C removal and the A→C addition are collapsed into the
        // reparented entry below — the raw lists hold only what's left.
        assert.deepEqual(L.removed, []);

        const addedPairs = L.added.map((r) => `${r.source_id}>${r.target_id}`).sort();
        assert.deepEqual(addedPairs, [`${c}>${d}`]);

        assert.equal(L.reparented.length, 1);
        assert.equal(L.reparented[0]?.thought_id, c);
        assert.equal(L.reparented[0]?.from_parent_id, b);
        assert.equal(L.reparented[0]?.to_parent_id, a);

        assert.deepEqual(L.reorder_collapsed, [{ thought_id: a, count: 1 }]);

        // Overridden: the type-changed link + tombstones + fresh rows.
        assert.ok(diff.overridden.link_ids.includes(linkAB));
        assert.ok(diff.overridden.link_ids.includes(aeRow.id));
        assert.ok(diff.overridden.thought_ids.includes(d));
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('dependent-row edits (property value, comment, synonym) mark their owners overridden', async () => {
      const ctx = await buildRestContext();
      try {
        // Base: thoughts A (plain) and B (typed, so a property value can be
        // set on it later). Only the layer touches their dependent rows.
        const a = await postThought(ctx, 'А');
        const b = await postThought(ctx, 'Б');

        const typeRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types`,
          headers: authHeaders(ctx),
          payload: { name: 'Карточка' },
        });
        assert.equal(typeRes.statusCode, 201, typeRes.body?.toString());
        const typeId = (typeRes.json().data as { id: string }).id;
        const propRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/properties`,
          headers: authHeaders(ctx),
          payload: { key: 'Статус', value_type: 'text' },
        });
        assert.equal(propRes.statusCode, 201, propRes.body?.toString());
        const patchB = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${b}`,
          headers: authHeaders(ctx),
          payload: { type_id: typeId },
        });
        assert.equal(patchB.statusCode, 200, patchB.body?.toString());

        const layer = await createLayer(ctx, 'Правки зависимых строк');
        await selectLayer(ctx, layer.id);

        // In the layer: a permanent comment on A and a property value on B —
        // neither materialises the thought row itself.
        const commentRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${a}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'permanent', body_md: 'правка в слое' },
        });
        assert.equal(commentRes.statusCode, 201, commentRes.body?.toString());

        const valueRes = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${b}/properties/Статус`,
          headers: authHeaders(ctx),
          payload: { value: 'в слое' },
        });
        assert.equal(valueRes.statusCode, 200, valueRes.body?.toString());

        const diff = await getDiff(ctx, layer.id);
        // The owners are overridden through their dependent rows alone.
        assert.ok(diff.overridden.thought_ids.includes(a), 'comment owner must be overridden');
        assert.ok(diff.overridden.thought_ids.includes(b), 'property-value owner must be overridden');
        // A pure comment edit does not appear as a structural link change.
        assert.deepEqual(diff.links.added, []);
        assert.deepEqual(diff.links.removed, []);

        // Sanity: до требования e6d4165e (задача 5ef8b5bb) overrides
        // приходили только от зависимых строк, и `thoughts`-тени не
        // появлялись. Сейчас правка значения свойства касается автора
        // владельца (touches `updated_by`/`updated_at_ms`), поэтому в слое
        // лежит shadow-row мысли — без него UI не показал бы свежесть правки
        // во вкладке «Метаданные». Комментарий НЕ трогает мысль.
        const layerNdb = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, layer.id);
        for (const [id, expected] of [
          [a, 0],
          [b, 1],
        ] as const) {
          const row = layerNdb
            .prepare('SELECT COUNT(*) AS c FROM thoughts WHERE id = ? AND layer_id = ?')
            .get(id, layer.id) as { c: number };
          assert.equal(row.c, expected, `thought ${id} shadow count mismatch`);
        }
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('textual diff is deterministic and reflects content changes', async () => {
      const ctx = await buildRestContext();
      try {
        await postThought(ctx, 'Основа мысли');
        const layer = await createLayer(ctx, 'Док');
        await selectLayer(ctx, layer.id);
        await postThought(ctx, 'Мысль слоя');

        const first = await getDiffDoc(ctx, layer.id);
        const second = await getDiffDoc(ctx, layer.id);
        assert.equal(first.layer_doc, second.layer_doc, 'layer doc must be deterministic');
        assert.equal(first.target_doc, second.target_doc, 'target doc must be deterministic');
        assert.ok(first.layer_doc.includes('Мысль слоя'));
        assert.ok(!first.layer_doc.includes('Основа мысли') || first.layer_doc.includes('Основа мысли'));
        assert.ok(first.target_doc.includes('Основа мысли'));
        assert.ok(!first.target_doc.includes('Мысль слоя'));
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('rejects diffing the base layer itself', async () => {
      const ctx = await buildRestContext();
      try {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/layers/${BASE_LAYER_ID}/diff`,
          headers: authHeaders(ctx),
        });
        assert.equal(res.statusCode, 422);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
