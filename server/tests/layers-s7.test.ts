/**
 * Integration tests for the change-layer REST surface (task S7,
 * docs/13-layers.md §2, §7, §10.1; docs/03-server-api.md §5a) via app.inject:
 *
 *   * layer list with hierarchy metadata, `current` marking and service-layer
 *     hiding;
 *   * the server-side session default (`session_layers`): selecting a layer
 *     routes every later read/write of that (user, client) into the layer —
 *     a layer write is invisible from the base and the base stays transparent
 *     to the layer (§4.1);
 *   * the `meta.layer` echo on every mutating response and the `X-Etn-Layer`
 *     headers on bodiless 204 replies (§7.1);
 *   * depth limit (§2.1), base-layer protection, subtree cascade delete with
 *     the `cascade` confirmation, session re-pointing and the trash
 *     auto-purge right after the deletion (§2.4).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { describe, it } from 'node:test';

import { BASE_LAYER_ID, type Layer } from '@etn/shared';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Create a layer via the API and return the parsed DTO. */
async function createLayer(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<Layer> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers`,
    headers: authHeaders(ctx),
    payload,
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return res.json().data as Layer;
}

/** Select the session's current layer for an optional `client-id` header. */
async function selectLayer(
  ctx: RestTestContext,
  layerId: string,
  clientId?: string,
): Promise<number> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/select`,
    headers: { ...authHeaders(ctx), ...(clientId !== undefined ? { 'client-id': clientId } : {}) },
    payload: {},
  });
  return res.statusCode;
}

/** List layers (optionally including service ones) for a client id. */
async function listLayers(
  ctx: RestTestContext,
  opts: { includeService?: boolean; clientId?: string } = {},
): Promise<Layer[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/layers${opts.includeService ? '?include_service=true' : ''}`,
    headers: { ...authHeaders(ctx), ...(opts.clientId !== undefined ? { 'client-id': opts.clientId } : {}) },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data as Layer[];
}

/** Create a thought via the API; returns the full injected response. */
async function postThought(ctx: RestTestContext, title: string, clientId?: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: { ...authHeaders(ctx), ...(clientId !== undefined ? { 'client-id': clientId } : {}) },
    payload: { title },
  });
}

describe(
  '/layers routes (S7)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('list starts with the base layer marked current; creation defaults to the session layer', async () => {
      const ctx = await buildRestContext();
      try {
        const initial = await listLayers(ctx);
        assert.equal(initial.length, 1);
        const [base] = initial;
        assert.equal(base?.is_base, true);
        assert.equal(base?.current, true);
        assert.equal(base?.id, BASE_LAYER_ID);
        assert.equal(base?.parent_id, null);
        assert.equal(base?.children_count, 0);

        const created = await createLayer(ctx, { title: 'Правки августа', comment: 'слой для задачи' });
        assert.equal(created.is_base, false);
        assert.equal(created.parent_id, BASE_LAYER_ID); // session default = base
        assert.equal(created.depth, 1);
        assert.equal(created.comment, 'слой для задачи');
        assert.equal(created.created_by, ctx.adminId);
        assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(created.created_at));

        const after = await listLayers(ctx);
        assert.equal(after.length, 2);
        assert.equal(after[1]?.children_count, 0);
        assert.equal(after[0]?.current, true); // still the base
        assert.equal(after[1]?.current, false);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('session layer isolates writes; base stays transparent to the layer (§4.1)', async () => {
      const ctx = await buildRestContext();
      try {
        const layer = await createLayer(ctx, { title: 'Песочница' });
        assert.equal(await selectLayer(ctx, layer.id), 200);

        // Write inside the layer; the echo names the session layer.
        const inLayer = await postThought(ctx, 'Мысль слоя');
        assert.equal(inLayer.statusCode, 201);
        const layeredId = (inLayer.json().data as { id: string }).id;
        assert.deepEqual(inLayer.json().meta.layer, { id: layer.id, title: 'Песочница' });

        // Visible from the layer…
        const seenInLayer = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${layeredId}`,
          headers: authHeaders(ctx),
        });
        assert.equal(seenInLayer.statusCode, 200);

        // …invisible from the base after switching back.
        assert.equal(await selectLayer(ctx, BASE_LAYER_ID), 200);
        const seenInBase = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${layeredId}`,
          headers: authHeaders(ctx),
        });
        assert.equal(seenInBase.statusCode, 404);

        // Transparency (§4.1): a base write is visible from the layer.
        const baseThought = await postThought(ctx, 'Мысль основы');
        assert.equal(baseThought.statusCode, 201);
        const baseId = (baseThought.json().data as { id: string }).id;
        assert.equal(await selectLayer(ctx, layer.id), 200);
        const seenThrough = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${baseId}`,
          headers: authHeaders(ctx),
        });
        assert.equal(seenThrough.statusCode, 200);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('sessions are per client-id: one installation switching does not move another', async () => {
      const ctx = await buildRestContext();
      try {
        const layer = await createLayer(ctx, { title: 'Слой А' });
        assert.equal(await selectLayer(ctx, layer.id, 'client-alpha'), 200);

        const alpha = await listLayers(ctx, { clientId: 'client-alpha' });
        const beta = await listLayers(ctx, { clientId: 'client-beta' });
        assert.equal(alpha.find((l) => l.id === layer.id)?.current, true);
        assert.equal(beta.find((l) => l.id === layer.id)?.current, false);
        assert.equal(beta.find((l) => l.id === BASE_LAYER_ID)?.current, true);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('every mutating response echoes the session layer; reads do not', async () => {
      const ctx = await buildRestContext();
      try {
        // POST /layers echoes the session default (the base) — creation is
        // not a switch.
        const createdRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/layers`,
          headers: authHeaders(ctx),
          payload: { title: 'Эхо' },
        });
        assert.equal(createdRes.statusCode, 201);
        assert.deepEqual(createdRes.json().meta.layer, { id: BASE_LAYER_ID, title: 'Основа' });
        const layer = createdRes.json().data as Layer;

        // select — the echo becomes the newly selected layer.
        const selectRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/layers/${layer.id}/select`,
          headers: authHeaders(ctx),
          payload: {},
        });
        assert.equal(selectRes.statusCode, 200);
        assert.deepEqual(selectRes.json().meta.layer, { id: layer.id, title: 'Эхо' });

        // POST /thoughts — echo in meta.layer.
        const thoughtRes = await postThought(ctx, 'Для эха');
        assert.equal(thoughtRes.statusCode, 201);
        assert.deepEqual(thoughtRes.json().meta.layer, { id: layer.id, title: 'Эхо' });
        const thoughtId = (thoughtRes.json().data as { id: string; version: number }).id;

        // PATCH /thoughts — echo as well.
        const patchRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { title: 'Для эха 2' },
        });
        assert.equal(patchRes.statusCode, 200);
        assert.deepEqual(patchRes.json().meta.layer, { id: layer.id, title: 'Эхо' });

        // GET — no echo by design (§7.1).
        const getRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}`,
          headers: authHeaders(ctx),
        });
        assert.equal(getRes.statusCode, 200);
        assert.equal(getRes.json().meta?.layer, undefined);

        // DELETE — bodiless 204: the echo rides the X-Etn-Layer headers.
        const delRes = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}`,
          headers: { ...authHeaders(ctx), 'if-match': '2' },
        });
        assert.equal(delRes.statusCode, 204);
        assert.equal(delRes.headers['x-etn-layer'], layer.id);
        assert.equal(decodeURIComponent(String(delRes.headers['x-etn-layer-title'])), 'Эхо');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('service layers are hidden from the list and cannot be selected', async () => {
      const ctx = await buildRestContext();
      try {
        const now = new Date().toISOString();
        const serviceId = randomUUID();
        ctx.ndb
          .prepare(
            `INSERT INTO layers (id, parent_id, title, comment, git_branch, is_service, is_base,
                                  depth, created_by, created_at, last_activity_at, version)
             VALUES (?, ?, 'резерв: слияние', NULL, NULL, 1, 0, 1, 'system', ?, ?, 1)`,
          )
          .run(serviceId, BASE_LAYER_ID, now, now);

        const visible = await listLayers(ctx);
        assert.equal(visible.some((l) => l.id === serviceId), false);

        const withService = await listLayers(ctx, { includeService: true });
        assert.equal(withService.some((l) => l.id === serviceId), true);
        assert.equal(withService.find((l) => l.id === serviceId)?.is_service, true);

        const select = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/layers/${serviceId}/select`,
          headers: authHeaders(ctx),
          payload: {},
        });
        assert.equal(select.statusCode, 422);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('depth limit: five levels are impossible (422 on the fifth)', async () => {
      const ctx = await buildRestContext();
      try {
        let parent: string = BASE_LAYER_ID;
        for (let depth = 1; depth <= 4; depth += 1) {
          const created = await createLayer(ctx, { parent_id: parent, title: `L${depth}` });
          assert.equal(created.depth, depth);
          parent = created.id;
        }
        const fifth = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/layers`,
          headers: authHeaders(ctx),
          payload: { parent_id: parent, title: 'L5' },
        });
        assert.equal(fifth.statusCode, 422);
        assert.equal(fifth.json().error.code, 'VALIDATION_ERROR');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('rename/comment: If-Match conflict, fixed base title, editable base comment', async () => {
      const ctx = await buildRestContext();
      try {
        const layer = await createLayer(ctx, { title: 'Было' });
        const renamed = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/layers/${layer.id}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { title: 'Стало', comment: 'обновлено' },
        });
        assert.equal(renamed.statusCode, 200);
        assert.equal((renamed.json().data as Layer).title, 'Стало');
        assert.equal((renamed.json().data as Layer).version, 2);

        const stale = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/layers/${layer.id}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { title: 'Конфликт' },
        });
        assert.equal(stale.statusCode, 409);

        const baseRename = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/layers/${BASE_LAYER_ID}`,
          headers: authHeaders(ctx),
          payload: { title: 'Нельзя' },
        });
        assert.equal(baseRename.statusCode, 422);

        const baseComment = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/layers/${BASE_LAYER_ID}`,
          headers: authHeaders(ctx),
          payload: { comment: 'комментарий основы разрешён' },
        });
        assert.equal(baseComment.statusCode, 200);
        assert.equal((baseComment.json().data as Layer).comment, 'комментарий основы разрешён');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('delete: base forbidden; cascade confirmation; sessions re-pointed; trash auto-purged', async () => {
      const ctx = await buildRestContext();
      try {
        // Base is undeletable (§2.4).
        const delBase = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/layers/${BASE_LAYER_ID}`,
          headers: authHeaders(ctx),
        });
        assert.equal(delBase.statusCode, 422);

        // A marked base thought held by a live layer shadow: after the layer
        // is gone, the trash auto-purge must physically remove it (§2.4).
        const marked = await postThought(ctx, 'Помеченная в основе');
        assert.equal(marked.statusCode, 201);
        const markedId = (marked.json().data as { id: string }).id;
        const mark = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${markedId}`,
          headers: authHeaders(ctx),
          payload: { marked_for_deletion: true },
        });
        assert.equal(mark.statusCode, 200);

        const parent = await createLayer(ctx, { title: 'Родитель' });
        assert.equal(await selectLayer(ctx, parent.id), 200);
        // A layer-only thought + its shadow of the marked thought live here.
        const layerThought = await postThought(ctx, 'Мысль слоя');
        assert.equal(layerThought.statusCode, 201);
        const layerThoughtId = (layerThought.json().data as { id: string }).id;
        // Touch the marked thought from the layer: live shadow = holding layer.
        const touch = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${markedId}`,
          headers: authHeaders(ctx),
          payload: { icon: '🧪' },
        });
        assert.equal(touch.statusCode, 200);

        const child = await createLayer(ctx, { title: 'Потомок', parent_id: parent.id });
        // Another session sits on the doomed child.
        assert.equal(await selectLayer(ctx, child.id, 'client-doomed'), 200);

        // Missing cascade → 422 carrying children_count.
        const noCascade = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/layers/${parent.id}`,
          headers: authHeaders(ctx),
        });
        assert.equal(noCascade.statusCode, 422);
        assert.equal(noCascade.json().error.details.children_count, 1);

        // Wrong cascade → 409.
        const wrongCascade = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/layers/${parent.id}?cascade=5`,
          headers: authHeaders(ctx),
        });
        assert.equal(wrongCascade.statusCode, 409);

        // Correct cascade → the whole subtree goes away.
        const ok = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/layers/${parent.id}?cascade=1`,
          headers: authHeaders(ctx),
        });
        assert.equal(ok.statusCode, 200);
        const body = ok.json().data as { deleted: number; purged: number; skipped: number };
        assert.equal(body.deleted, 2); // parent + child
        assert.equal(body.purged, 1); // the marked thought, unblocked by the cascade
        assert.equal(body.skipped, 0);
        // Echo of the delete response itself: the author's session sat on the
        // deleted layer and was re-pointed to the deleted layer's parent (base).
        assert.deepEqual(ok.json().meta.layer, { id: BASE_LAYER_ID, title: 'Основа' });

        // Layers gone; shadow rows physically removed.
        const remaining = await listLayers(ctx);
        assert.equal(remaining.some((l) => l.id === parent.id || l.id === child.id), false);
        const shadows = ctx.ndb
          .prepare('SELECT COUNT(*) AS c FROM thoughts WHERE layer_id IN (?, ?)')
          .get(parent.id, child.id) as { c: number };
        assert.equal(shadows.c, 0);
        const layerThoughtGone = ctx.ndb
          .prepare('SELECT COUNT(*) AS c FROM thoughts WHERE id = ?')
          .get(layerThoughtId) as { c: number };
        assert.equal(layerThoughtGone.c, 0);
        const markedGone = ctx.ndb
          .prepare('SELECT COUNT(*) AS c FROM thoughts WHERE id = ?')
          .get(markedId) as { c: number };
        assert.equal(markedGone.c, 0);

        // The session that sat on the child was switched to the deleted
        // layer's parent — the base (§2.4).
        const doomed = await listLayers(ctx, { clientId: 'client-doomed' });
        assert.equal(doomed.find((l) => l.id === BASE_LAYER_ID)?.current, true);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('a childless layer deletes without the cascade parameter', async () => {
      const ctx = await buildRestContext();
      try {
        const layer = await createLayer(ctx, { title: 'Без потомков' });
        const del = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/layers/${layer.id}`,
          headers: authHeaders(ctx),
        });
        assert.equal(del.statusCode, 200);
        assert.equal((del.json().data as { deleted: number }).deleted, 1);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
