/**
 * Pagination / section selection of the structural layer diff (задача
 * ddb67ddc): keyset cursor, `sections` filter, per-page byte budget, and the
 * legacy full-report REST default.
 *
 * The scale test builds ~300 removed links synthetically (layer tombstones) —
 * the precedent layer 91ac2fa4 with ~1142 overridden rows is merged, so the
 * magnitude is reproduced on an isolated fixture. The full report for that
 * fixture exceeds the MCP page budget, while the default page stays within it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BASE_LAYER_ID,
  LAYER_DIFF_PAGE_BUDGET_BYTES,
  type Layer,
  type LayerDiffPage,
  type LayerDiffResult,
} from '@etn/shared';

import { openNetworkDb } from '../src/db/network-db.js';
import { createLink, deleteLink } from '../src/domain/link-service.js';
import { createThought } from '../src/domain/thought-service.js';
import {
  resolveDiffTarget,
  structuralLayerDiff,
  structuralLayerDiffPage,
} from '../src/domain/layer-diff-service.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

const SYSTEM = '00000000-0000-0000-0000-000000000000';

/** Create a layer through the REST API. */
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

/**
 * Build a layer whose diff against the base holds exactly `removals` removed
 * links: the base gets `removals` links hub→target, the layer tombstones them.
 */
async function buildSyntheticLayer(ctx: RestTestContext, removals: number): Promise<string> {
  const base = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, BASE_LAYER_ID);
  const hub = createThought(base, { title: 'Хаб' }, SYSTEM).id;
  const linkIds: string[] = [];
  for (let i = 0; i < removals; i += 1) {
    const target = createThought(base, { title: `Цель ${i}` }, SYSTEM).id;
    linkIds.push(createLink(base, { source_id: hub, target_id: target }, SYSTEM).id);
  }
  const layer = await createLayer(ctx, 'Синтетический слой');
  const layerNdb = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, layer.id);
  for (const id of linkIds) deleteLink(layerNdb, id, undefined);
  return layer.id;
}

interface PagedQuery {
  sections?: string[];
  limit?: number;
  cursor?: string;
}

/** GET the paged diff through REST (any pagination parameter → page). */
async function getPagedDiff(
  ctx: RestTestContext,
  layerId: string,
  query: PagedQuery = {},
): Promise<LayerDiffPage> {
  const params = new URLSearchParams();
  for (const section of query.sections ?? []) params.append('sections', section);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  const qs = params.toString();
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/diff${qs ? `?${qs}` : ''}`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
  return res.json().data as LayerDiffPage;
}

/** GET the legacy full report (no pagination parameters at all). */
async function getFullDiff(ctx: RestTestContext, layerId: string): Promise<LayerDiffResult> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/diff`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
  return res.json().data as LayerDiffResult;
}

describe(
  'layers.diff pagination + sections (ddb67ddc)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('section filter + keyset cursor walk every page; sums equal counts', async () => {
      const ctx = await buildRestContext();
      try {
        const layerId = await buildSyntheticLayer(ctx, 25);

        const first = await getPagedDiff(ctx, layerId, { sections: ['links.removed'], limit: 10 });
        assert.equal(first.counts['links.removed'], 25);
        assert.equal(first.counts['links.added'], 0);
        assert.deepEqual(first.sections, ['links.removed']);
        assert.equal(first.links.removed?.length, 10);
        // Unrequested sections are absent from the page.
        assert.equal(first.links.added, undefined);
        assert.equal(first.overridden.thought_ids, undefined);
        assert.equal(first.truncated, true);
        assert.equal(first.reason, 'has_more');
        assert.ok(first.next_cursor);

        const ids: string[] = [...(first.links.removed ?? [])].map((r) => r.id);
        let cursor: string | null = first.next_cursor;
        let pages = 1;
        while (cursor !== null) {
          const page: LayerDiffPage = await getPagedDiff(ctx, layerId, {
            sections: ['links.removed'],
            limit: 10,
            cursor,
          });
          pages += 1;
          ids.push(...(page.links.removed ?? []).map((r) => r.id));
          if (!page.truncated) {
            assert.equal(page.next_cursor, null);
            assert.equal(page.reason, null);
          }
          cursor = page.next_cursor;
        }
        assert.equal(pages, 3, '25 items at limit 10 need exactly 3 pages');
        assert.equal(ids.length, 25);
        assert.equal(new Set(ids).size, 25, 'no duplicates across pages');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('REST without parameters keeps the legacy full report (no counts)', async () => {
      const ctx = await buildRestContext();
      try {
        const layerId = await buildSyntheticLayer(ctx, 12);
        const full = await getFullDiff(ctx, layerId);
        assert.equal(full.links.removed.length, 12);
        assert.equal(
          Object.prototype.hasOwnProperty.call(full, 'counts'),
          false,
          'the full report must not carry the paged envelope',
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('REST with limit returns the paged envelope', async () => {
      const ctx = await buildRestContext();
      try {
        const layerId = await buildSyntheticLayer(ctx, 12);
        const page = await getPagedDiff(ctx, layerId, { limit: 5 });
        assert.deepEqual(page.sections, [
          'links.added',
          'links.removed',
          'links.type_changed',
          'links.reorder_collapsed',
          'links.reparented',
          'overridden.thought_ids',
          'overridden.link_ids',
        ]);
        assert.equal(page.counts['links.removed'], 12);
        assert.equal(page.limit, 5);
        assert.equal(page.truncated, true);
        assert.ok(page.next_cursor);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('unknown section, invalid cursor and past-the-end cursor are explicit', async () => {
      const ctx = await buildRestContext();
      try {
        const layerId = await buildSyntheticLayer(ctx, 3);

        const badSection = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/diff?sections=bogus`,
          headers: authHeaders(ctx),
        });
        assert.equal(badSection.statusCode, 422, badSection.body?.toString());

        const badCursor = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/diff?cursor=!!!not-base64`,
          headers: authHeaders(ctx),
        });
        assert.equal(badCursor.statusCode, 422, badCursor.body?.toString());

        // A cursor whose key sorts after every uuid: the page is empty and
        // complete (no spurious next_cursor).
        const pastEnd = Buffer.from(
          JSON.stringify({ v: 1, s: 'links.removed', k: 'zzzzzzzz' }),
          'utf8',
        ).toString('base64url');
        const page = await getPagedDiff(ctx, layerId, {
          sections: ['links.removed'],
          cursor: pastEnd,
        });
        assert.deepEqual(page.links.removed, []);
        assert.equal(page.truncated, false);
        assert.equal(page.next_cursor, null);
        assert.equal(page.counts['links.removed'], 3);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('empty diff yields an empty complete page with zero counts', async () => {
      const ctx = await buildRestContext();
      try {
        const layer = await createLayer(ctx, 'Пустой слой');
        // `limit` forces the page envelope; without any parameter REST returns
        // the legacy full report (covered by the test above).
        const page = await getPagedDiff(ctx, layer.id, { limit: 10 });
        assert.equal(page.truncated, false);
        assert.equal(page.next_cursor, null);
        assert.deepEqual(page.links.removed, []);
        for (const value of Object.values(page.counts)) assert.equal(value, 0);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('a report larger than the page budget is paginated, never silently cut', async () => {
      const ctx = await buildRestContext();
      try {
        const layerId = await buildSyntheticLayer(ctx, 300);
        const ndb = openNetworkDb(ctx.dataDir, ctx.networkId);
        const { layer, target } = resolveDiffTarget(ndb, layerId);
        const layerNdb = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, layer.id);
        const targetNdb = openNetworkDb(ctx.dataDir, ctx.networkId, undefined, target.id);

        const full = structuralLayerDiff(layerNdb, targetNdb, layer, target);
        const fullBytes = Buffer.byteLength(JSON.stringify(full, null, 2), 'utf8');
        assert.ok(
          fullBytes > LAYER_DIFF_PAGE_BUDGET_BYTES,
          `the full report (${fullBytes} Б) must exceed the page budget for this test to be meaningful`,
        );

        const page = structuralLayerDiffPage(layerNdb, targetNdb, layer, target);
        const pageBytes = Buffer.byteLength(JSON.stringify(page, null, 2), 'utf8');
        assert.ok(
          pageBytes <= LAYER_DIFF_PAGE_BUDGET_BYTES,
          `default page ${pageBytes} Б exceeds budget ${LAYER_DIFF_PAGE_BUDGET_BYTES}`,
        );
        assert.equal(page.counts['links.removed'], 300);
        assert.equal(page.truncated, true);
        assert.equal(page.reason, 'has_more');
        assert.ok(page.next_cursor);
        assert.ok(
          (page.links.removed?.length ?? 0) < 300,
          'the budget must trim the page below the item count',
        );
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
