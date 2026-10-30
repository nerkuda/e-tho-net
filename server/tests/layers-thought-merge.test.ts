/**
 * Tests for resolving ONE thought's layer changes (задача f5c363a3, «Слияние
 * отдельных мыслей в основу из GUI с разрешением конфликтов»):
 *
 *   POST /networks/:networkId/layers/:layerId/merge  { thought_id, mode }
 *     — режимы `overwrite` («полностью переписать») и `combine` («объединить
 *       изменения»: постоянный комментарий объединяется с основой);
 *   POST /networks/:networkId/layers/:layerId/discard { thought_id }
 *     — «Отказаться от изменений»: строки мысли удаляются из слоя.
 *
 * Covered: overwrite on a real conflict (побеждает версия слоя);
 * combine переносит хроно-записи и объединяет разошедшийся комментарий с
 * маркерами; discard возвращает мысль к основе и убирает созданную в слое;
 * сервер НЕ расширяет набор (незамкнутый набор → 422 missing_closure);
 * контракт REST (mode без thought_id, thought_id вместе с tables).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Layer, LayerMergeReport } from '@etn/shared';

import { mergeCommentText } from '../src/domain/merge-service.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
  clientHeaders,
} from './rest-helpers.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** REST call bound to the context; `clientId` selects the session (layer). */
async function call(
  ctx: RestTestContext,
  method: Method,
  url: string,
  payload?: Record<string, unknown>,
  clientId?: string,
) {
  return ctx.app.inject({
    method,
    url: `/api/v1/networks/${ctx.networkId}${url}`,
    headers: {
      ...authHeaders(ctx),
      ...clientHeaders(clientId),
    },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function thought(ctx: RestTestContext, title: string, clientId?: string): Promise<string> {
  const res = await call(ctx, 'POST', '/thoughts', { title }, clientId);
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

async function createLayer(ctx: RestTestContext, title: string): Promise<Layer> {
  const res = await call(ctx, 'POST', '/layers', { title });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return res.json().data as Layer;
}

async function selectLayer(ctx: RestTestContext, layerId: string, clientId: string): Promise<void> {
  const res = await call(ctx, 'POST', `/layers/${layerId}/select`, {}, clientId);
  assert.equal(res.statusCode, 200, res.body?.toString());
}

async function permanent(
  ctx: RestTestContext,
  thoughtId: string,
  body: string,
  clientId?: string,
): Promise<string> {
  const res = await call(
    ctx,
    'POST',
    `/thoughts/${thoughtId}/comments`,
    { kind: 'permanent', body_md: body },
    clientId,
  );
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

async function chronological(
  ctx: RestTestContext,
  thoughtId: string,
  body: string,
  clientId?: string,
): Promise<string> {
  const res = await call(
    ctx,
    'POST',
    `/thoughts/${thoughtId}/comments`,
    { kind: 'chronological', body_md: body, title: 'запись' },
    clientId,
  );
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

async function patchComment(
  ctx: RestTestContext,
  commentId: string,
  body: string,
  clientId?: string,
): Promise<void> {
  const res = await call(ctx, 'PATCH', `/comments/${commentId}`, { body_md: body }, clientId);
  assert.equal(res.statusCode, 200, res.body?.toString());
}

async function commentBody(ctx: RestTestContext, commentId: string): Promise<string> {
  const res = await call(ctx, 'GET', `/comments/${commentId}`);
  assert.equal(res.statusCode, 200, res.body?.toString());
  return (res.json().data as { body_md: string }).body_md;
}

async function listComments(
  ctx: RestTestContext,
  thoughtId: string,
): Promise<Array<{ kind: string; body_md: string }>> {
  const res = await call(ctx, 'GET', `/thoughts/${thoughtId}/comments`);
  assert.equal(res.statusCode, 200, res.body?.toString());
  return res.json().data as Array<{ kind: string; body_md: string }>;
}

async function overridden(ctx: RestTestContext, layerId: string) {
  const res = await call(ctx, 'GET', `/layers/${layerId}/diff`);
  assert.equal(res.statusCode, 200, res.body?.toString());
  return res.json().data.overridden as { thought_ids: string[]; link_ids: string[] };
}

async function mergeThought(
  ctx: RestTestContext,
  layerId: string,
  thoughtId: string,
  mode: 'overwrite' | 'combine',
) {
  return call(ctx, 'POST', `/layers/${layerId}/merge`, { thought_id: thoughtId, mode });
}

const WORKER = 'thought-merge-worker';

describe(
  'merge/discard one thought (f5c363a3)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('mergeCommentText: equal, one-sided and conflicting texts', () => {
      assert.deepEqual(mergeCommentText('A\nB', 'A\nB'), { body: 'A\nB', conflicts: 0 });
      assert.deepEqual(mergeCommentText('A\nB', 'A'), { body: 'A\nB', conflicts: 0 });
      assert.deepEqual(mergeCommentText('', 'A'), { body: 'A', conflicts: 0 });
      const conflict = mergeCommentText('l1\nL2', 'B1\nl2');
      assert.equal(conflict.conflicts, 1);
      assert.ok(conflict.body.includes('<<<<<<< слой'));
      assert.ok(conflict.body.includes('>>>>>>> основа'));
      assert.ok(conflict.body.includes('L2') && conflict.body.includes('B1'));
    });

    it('overwrite: layer version wins over a conflicting base edit, override disappears', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const commentId = await permanent(ctx, a, 'base');
        const layer = await createLayer(ctx, 'Слой');
        await selectLayer(ctx, layer.id, WORKER);
        await patchComment(ctx, commentId, 'layer', WORKER);
        // Base edits the same comment → base_version conflict (1 vs 2).
        await patchComment(ctx, commentId, 'base-2');

        const res = await mergeThought(ctx, layer.id, a, 'overwrite');
        assert.equal(res.statusCode, 200, res.body?.toString());
        const report = res.json().data as LayerMergeReport;
        assert.equal(report.thought_merge?.comment_merged, false);
        assert.equal(await commentBody(ctx, commentId), 'layer');
        assert.ok(!(await overridden(ctx, layer.id)).thought_ids.includes(a));
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('combine: conflicting comment gets git-style markers while base is preserved', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const commentId = await permanent(ctx, a, 'l1\nl2');
        const layer = await createLayer(ctx, 'Слой');
        await selectLayer(ctx, layer.id, WORKER);
        await patchComment(ctx, commentId, 'l1\nL2', WORKER);
        await patchComment(ctx, commentId, 'B1\nl2');

        const res = await mergeThought(ctx, layer.id, a, 'combine');
        assert.equal(res.statusCode, 200, res.body?.toString());
        const report = res.json().data as LayerMergeReport;
        assert.equal(report.thought_merge?.comment_merged, true);
        assert.equal(report.thought_merge?.comment_conflicts, 1);
        const body = await commentBody(ctx, commentId);
        assert.ok(body.includes('<<<<<<< слой'));
        assert.ok(body.includes('L2') && body.includes('B1'));
        assert.ok(!(await overridden(ctx, layer.id)).thought_ids.includes(a));
      } finally {
        await closeRestContext(ctx);
      }
    });

    /**
     * Регресс ошибки b1c5e128: `combineThoughtComment` выбирал строку слоя
     * корректно (`WHERE layer_id = ?`), но объединённое тело писал
     * `UPDATE comments … WHERE id = ?` — логический `id` общий у строк одного
     * комментария во всех слоях, поэтому объединённый текст (с маркерами
     * конфликта) попадал ещё и в основу, и в строки соседних/дочерних слоёв.
     * Ожидание: меняется только строка сливаемого слоя (далее её переносит
     * обычный реплей); соседний слой сохраняет собственную редакцию.
     */
    it('combine: объединение комментария не задевает строку соседнего слоя (b1c5e128)', async () => {
      const ctx = await buildRestContext();
      const WORKER_A = 'merge-combine-a';
      const WORKER_B = 'merge-combine-b';
      try {
        const a = await thought(ctx, 'A');
        const commentId = await permanent(ctx, a, 'l1\nl2');
        const layerA = await createLayer(ctx, 'Слой A');
        const layerB = await createLayer(ctx, 'Слой B');

        // Тень A — конфликтующая правка, тень B — своя независимая редакция.
        await selectLayer(ctx, layerA.id, WORKER_A);
        await patchComment(ctx, commentId, 'l1\nL2', WORKER_A);
        await selectLayer(ctx, layerB.id, WORKER_B);
        await patchComment(ctx, commentId, 'слой-B', WORKER_B);
        // Основа правит комментарий → `base_version` расходится у обеих теней.
        await patchComment(ctx, commentId, 'B1\nl2');

        const res = await mergeThought(ctx, layerA.id, a, 'combine');
        assert.equal(res.statusCode, 200, res.body?.toString());
        const report = res.json().data as LayerMergeReport;
        assert.equal(report.thought_merge?.comment_merged, true);
        assert.equal(report.thought_merge?.comment_conflicts, 1);

        // Физическая строка слоя B не изменилась: тела основы/слоя A
        // (с маркерами конфликта) до неё не дошли.
        const layerBRow = ctx.ndb
          .prepare('SELECT body_md FROM comments WHERE id = ? AND layer_id = ?')
          .get(commentId, layerB.id) as { body_md: string } | undefined;
        assert.ok(layerBRow !== undefined, 'у слоя B должна остаться своя строка');
        assert.equal(layerBRow.body_md, 'слой-B', 'строка соседнего слоя не должна получить объединённый текст');
        assert.ok(!layerBRow.body_md.includes('<<<<<<< слой'));

        // И в контексте B читается именно её редакция.
        const read = await call(ctx, 'GET', `/comments/${commentId}`, undefined, WORKER_B);
        assert.equal(read.statusCode, 200, read.body?.toString());
        assert.equal((read.json().data as { body_md: string }).body_md, 'слой-B');

        // Сливаемый слой A перенесён в основу — объединение в ней видно.
        const baseBody = await commentBody(ctx, commentId);
        assert.ok(baseBody.includes('<<<<<<< слой'));
        assert.ok(baseBody.includes('L2') && baseBody.includes('B1'));
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('combine: chronological comments of the layer are carried into the base', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const commentId = await permanent(ctx, a, 'head');
        const layer = await createLayer(ctx, 'Слой');
        await selectLayer(ctx, layer.id, WORKER);
        await patchComment(ctx, commentId, 'head (слой)', WORKER);
        await chronological(ctx, a, 'хроно из слоя', WORKER);

        const res = await mergeThought(ctx, layer.id, a, 'overwrite');
        assert.equal(res.statusCode, 200, res.body?.toString());
        const comments = await listComments(ctx, a);
        assert.ok(comments.some((c) => c.kind === 'chronological' && c.body_md === 'хроно из слоя'));
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('discard: layer edits are dropped, the base is untouched', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const commentId = await permanent(ctx, a, 'base');
        const layer = await createLayer(ctx, 'Слой');
        await selectLayer(ctx, layer.id, WORKER);
        await patchComment(ctx, commentId, 'layer', WORKER);

        const res = await call(ctx, 'POST', `/layers/${layer.id}/discard`, { thought_id: a });
        assert.equal(res.statusCode, 200, res.body?.toString());
        assert.equal((res.json().data as { total: number }).total > 0, true);
        assert.equal(await commentBody(ctx, commentId), 'base');
        assert.ok(!(await overridden(ctx, layer.id)).thought_ids.includes(a));
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('discard: a thought created only in the layer disappears from the base', async () => {
      const ctx = await buildRestContext();
      try {
        const layer = await createLayer(ctx, 'Слой');
        await selectLayer(ctx, layer.id, WORKER);
        const c = await thought(ctx, 'Только в слое', WORKER);

        const res = await call(ctx, 'POST', `/layers/${layer.id}/discard`, { thought_id: c });
        assert.equal(res.statusCode, 200, res.body?.toString());
        const read = await call(ctx, 'GET', `/thoughts/${c}`);
        assert.equal(read.statusCode, 404, read.body?.toString());
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('refuses a non-closed set: the server does not expand it (406f432e)', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const layer = await createLayer(ctx, 'Слой');
        await selectLayer(ctx, layer.id, WORKER);
        // A layer-only type used by A — outside the thought's row set.
        const typeRes = await call(ctx, 'POST', '/thought-types', { name: 'Слойный тип' }, WORKER);
        assert.equal(typeRes.statusCode, 201, typeRes.body?.toString());
        const typeId = (typeRes.json().data as { id: string }).id;
        const patch = await call(ctx, 'PATCH', `/thoughts/${a}`, { type_id: typeId }, WORKER);
        assert.equal(patch.statusCode, 200, patch.body?.toString());

        const res = await mergeThought(ctx, layer.id, a, 'overwrite');
        assert.equal(res.statusCode, 422, res.body?.toString());
        const missing = res.json().error.details.missing_closure as Array<{ table: string }>;
        assert.ok(missing.some((m) => m.table === 'thought_types'));
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('REST contract: mode requires thought_id, tables conflict with it', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const layer = await createLayer(ctx, 'Слой');
        const noThought = await call(ctx, 'POST', `/layers/${layer.id}/merge`, {
          mode: 'combine',
        });
        assert.equal(noThought.statusCode, 422, noThought.body?.toString());
        const both = await call(ctx, 'POST', `/layers/${layer.id}/merge`, {
          thought_id: a,
          tables: { thoughts: [a] },
        });
        assert.equal(both.statusCode, 422, both.body?.toString());
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
