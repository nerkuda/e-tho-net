/**
 * Integration tests for the per-thought textual diff endpoint (задача
 * 52c776f1, docs/13-layers.md §10.3; docs/03-server-api.md §5a.7):
 *
 *   `GET /networks/:networkId/layers/:layerId/diff/thought/:thoughtId`
 *
 * The endpoint is the server half of the separate text-diff dialog: it reads
 * ONE thought in both contexts (the diffed layer and its merge target) and
 * returns display-ready `{ target, layer, changed }` field pairs. Covered:
 * changed / added / removed / unchanged permanent comment, a thought added and
 * a thought deleted in the layer, the REST contract (field order, `kind`) and
 * the error cases (unknown thought → 404; diffing the base itself → 422).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  BASE_LAYER_ID,
  LAYER_THOUGHT_DIFF_FIELD_KEYS,
  type Layer,
  type LayerThoughtDiff,
} from '@etn/shared';

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

/** Create a permanent comment on a thought; returns its id. */
async function postPermanentComment(
  ctx: RestTestContext,
  thoughtId: string,
  body: string,
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/comments`,
    headers: authHeaders(ctx),
    payload: { kind: 'permanent', body_md: body },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

/** Patch a comment body (in the session's current layer). */
async function patchComment(ctx: RestTestContext, commentId: string, body: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/networks/${ctx.networkId}/comments/${commentId}`,
    headers: authHeaders(ctx),
    payload: { body_md: body },
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

/** Delete a comment (in the session's current layer). */
async function deleteComment(ctx: RestTestContext, commentId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/networks/${ctx.networkId}/comments/${commentId}`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 204, res.body?.toString());
}

/** Delete a thought (tombstone in the session's current layer). */
async function deleteThought(ctx: RestTestContext, thoughtId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 204, res.body?.toString());
}

/** Fetch the per-thought diff. */
async function getThoughtDiff(
  ctx: RestTestContext,
  layerId: string,
  thoughtId: string,
): Promise<LayerThoughtDiff> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/diff/thought/${thoughtId}`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
  return res.json().data as LayerThoughtDiff;
}

/** Find one field of the diff by key. */
function field(diff: LayerThoughtDiff, key: string) {
  const found = diff.fields.find((f) => f.key === key);
  assert.ok(found, `field ${key} missing`);
  return found;
}

describe(
  '/layers diff/thought route (52c776f1)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('changed / new / removed / unchanged permanent comment', async () => {
      const ctx = await buildRestContext();
      try {
        // Base thoughts, each with its own permanent comment scenario.
        const changed = await postThought(ctx, 'Изменённый');
        const changedComment = await postPermanentComment(ctx, changed, 'старый текст');

        const fresh = await postThought(ctx, 'Новая правка');

        const removed = await postThought(ctx, 'Удалённая правка');
        const removedComment = await postPermanentComment(ctx, removed, 'будет удалён');

        const stable = await postThought(ctx, 'Без правок');
        await postPermanentComment(ctx, stable, 'стабильный текст');

        const layer = await createLayer(ctx, 'Правки комментариев');
        await selectLayer(ctx, layer.id);

        await patchComment(ctx, changedComment, 'новый текст');
        await postPermanentComment(ctx, fresh, 'появился в слое');
        await deleteComment(ctx, removedComment);

        // 1. Изменённый комментарий.
        const d1 = await getThoughtDiff(ctx, layer.id, changed);
        assert.equal(d1.kind, 'changed');
        assert.deepEqual(field(d1, 'comment'), {
          key: 'comment',
          target: 'старый текст',
          layer: 'новый текст',
          changed: true,
        });
        assert.equal(field(d1, 'title').changed, false);
        assert.equal(d1.layer.id, layer.id);
        assert.equal(d1.target_layer.id, BASE_LAYER_ID);

        // 2. Комментарий появился в слое (в основе его не было).
        const d2 = await getThoughtDiff(ctx, layer.id, fresh);
        assert.equal(d2.kind, 'changed');
        assert.deepEqual(field(d2, 'comment'), {
          key: 'comment',
          target: '',
          layer: 'появился в слое',
          changed: true,
        });

        // 3. Комментарий удалён в слое.
        const d3 = await getThoughtDiff(ctx, layer.id, removed);
        assert.deepEqual(field(d3, 'comment'), {
          key: 'comment',
          target: 'будет удалён',
          layer: '',
          changed: true,
        });

        // 4. Комментарий не тронут.
        const d4 = await getThoughtDiff(ctx, layer.id, stable);
        assert.equal(d4.kind, 'unchanged');
        assert.equal(
          d4.fields.every((f) => f.changed === false),
          true,
          'unchanged thought must have no changed fields',
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('a thought added in the layer is `added`, a thought deleted in the layer is `removed`', async () => {
      const ctx = await buildRestContext();
      try {
        const doomed = await postThought(ctx, 'Будет удалена');
        const layer = await createLayer(ctx, 'Правки состава');
        await selectLayer(ctx, layer.id);

        const born = await postThought(ctx, 'Родилась в слое');
        await deleteThought(ctx, doomed);

        const added = await getThoughtDiff(ctx, layer.id, born);
        assert.equal(added.kind, 'added');
        assert.equal(added.title, 'Родилась в слое');
        assert.deepEqual(field(added, 'title'), {
          key: 'title',
          target: '',
          layer: 'Родилась в слое',
          changed: true,
        });

        const removed = await getThoughtDiff(ctx, layer.id, doomed);
        assert.equal(removed.kind, 'removed');
        assert.equal(removed.title, 'Будет удалена');
        assert.equal(field(removed, 'title').target, 'Будет удалена');
        assert.equal(field(removed, 'title').layer, '');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('REST contract: five ordered fields, kind and echoes', async () => {
      const ctx = await buildRestContext();
      try {
        const thought = await postThought(ctx, 'Контракт');
        const layer = await createLayer(ctx, 'Контракт-слой');
        await selectLayer(ctx, layer.id);

        const diff = await getThoughtDiff(ctx, layer.id, thought);
        assert.deepEqual(
          diff.fields.map((f) => f.key),
          [...LAYER_THOUGHT_DIFF_FIELD_KEYS],
          'field order must follow LAYER_THOUGHT_DIFF_FIELD_KEYS',
        );
        assert.equal(diff.thought_id, thought);
        assert.equal(diff.layer.title, 'Контракт-слой');
        assert.equal(diff.target_layer.title, 'Основа');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('rejects an unknown thought (404) and the base layer (422)', async () => {
      const ctx = await buildRestContext();
      try {
        const layer = await createLayer(ctx, 'Ошибки');
        const unknown = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/layers/${layer.id}/diff/thought/${randomUUID()}`,
          headers: authHeaders(ctx),
        });
        assert.equal(unknown.statusCode, 404, unknown.body?.toString());

        const base = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/layers/${BASE_LAYER_ID}/diff/thought/${randomUUID()}`,
          headers: authHeaders(ctx),
        });
        assert.equal(base.statusCode, 422, base.body?.toString());
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
