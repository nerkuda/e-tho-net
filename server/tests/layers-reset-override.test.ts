/**
 * Regression tests for the override reset (task 7cc34cf4, docs/13-layers.md
 * §8.5): re-pinning a shadow row's `base_version` to the current version of
 * the same logical row in the merge target.
 *
 * The suite reproduces the exact blocker that left a long-lived release layer
 * unmergeable: the base edits a row the layer already overrides, the merge is
 * rejected whole (§8.1) and there was no way to reconcile. It covers:
 *
 *   * the read-only preview (`listPendingMergeConflicts`) naming the row and
 *     showing «было в основе / стало в слое»;
 *   * the reset itself, after which the full merge goes through and the base
 *     ends up with the layer's consciously chosen content;
 *   * version continuity — a shadow whose `version` lags behind the target is
 *     raised, so the merge never walks the base's version backwards;
 *   * tombstones (a delete in the layer over a base edit) reset like live rows;
 *   * idempotency and the negatives: an id absent from the layer, the base
 *     layer, an empty selection, non-versioned tables.
 *
 * The operation is MCP-only (agent recovery path) — there is no REST route, so
 * the domain functions are exercised directly on the base connection, the same
 * way `layers-s8.test.ts` reaches into the domain for setup.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';

import { describe, it } from 'node:test';

import { BASE_LAYER_ID, EtnError, type Layer } from '@etn/shared';

import { listPendingMergeConflicts, resetLayerOverride } from '../src/domain/merge-service.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

type InjectMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A REST call helper bound to the context; `clientId` selects the session. */
async function call(
  ctx: RestTestContext,
  method: InjectMethod,
  url: string,
  payload?: Record<string, unknown>,
  opts: { clientId?: string } = {},
) {
  return ctx.app.inject({
    method,
    url: `/api/v1/networks/${ctx.networkId}${url}`,
    headers: {
      ...authHeaders(ctx),
      ...(opts.clientId !== undefined ? { 'client-id': opts.clientId } : {}),
    },
    ...(payload !== undefined ? { payload } : {}),
  });
}

/** Create a thought (base session) and return its id. */
async function thought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await call(ctx, 'POST', '/thoughts', { title });
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

/** Merge a layer (default session = base). */
async function merge(ctx: RestTestContext, layerId: string) {
  return call(ctx, 'POST', `/layers/${layerId}/merge`, {});
}

/** Assert a callback throws an `EtnError` with the given code. */
function throwsEtn(code: string, fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => err instanceof EtnError && err.code === code);
}

const WORKER = 'layer-worker';

describe(
  'override reset (7cc34cf4)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('preview names the divergence and reset unblocks the merge (the 0.9.1 blocker scenario)', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const layer = await createLayer(ctx, 'Релизный слой');
        await selectLayer(ctx, layer.id, WORKER);

        // The layer overrides A; the base then edits the same row (a hotfix):
        // the shadow's base_version stays 1 while the base moves to 2.
        assert.equal(
          (await call(ctx, 'PATCH', `/thoughts/${a}`, { icon: '🧪' }, { clientId: WORKER })).statusCode,
          200,
        );
        assert.equal((await call(ctx, 'PATCH', `/thoughts/${a}`, { icon: '🌐' })).statusCode, 200);

        const refused = await merge(ctx, layer.id);
        assert.equal(refused.statusCode, 422, refused.body?.toString());
        assert.deepEqual(refused.json().error.details.conflicts, [
          { table: 'thoughts', id: a, expected_base_version: 1, current_version: 2 },
        ]);

        // Read-only preview: the same row, with the side-by-side difference.
        const preview = listPendingMergeConflicts(ctx.ndb, layer.id);
        assert.equal(preview.overridden, 1);
        assert.equal(preview.conflicts.length, 1);
        const c = preview.conflicts[0]!;
        assert.equal(c.table, 'thoughts');
        assert.equal(c.id, a);
        assert.equal(c.previous_base_version, 1);
        assert.equal(c.current_version, 2);
        assert.equal(c.layer_version, 2);
        assert.equal(c.version_raised_to, null);
        const iconDiff = c.diff.find((d) => d.column === 'icon');
        assert.deepEqual(iconDiff, { column: 'icon', base: '🌐', layer: '🧪' });

        // Reset re-pins base_version to the current base version.
        const reset = resetLayerOverride(ctx.ndb, layer.id, { thoughts: [a] });
        assert.equal(reset.reset.length, 1);
        assert.deepEqual(reset.unchanged, []);
        assert.equal(reset.reset[0]!.previous_base_version, 1);
        assert.equal(reset.reset[0]!.current_version, 2);

        // Idempotency: a second reset finds nothing to re-pin.
        const again = resetLayerOverride(ctx.ndb, layer.id, { thoughts: [a] });
        assert.deepEqual(again.reset, []);
        assert.deepEqual(again.unchanged, [{ table: 'thoughts', id: a, reason: 'up_to_date' }]);

        // The preview is empty now, and the whole merge goes through.
        assert.equal(listPendingMergeConflicts(ctx.ndb, layer.id).conflicts.length, 0);
        const merged = await merge(ctx, layer.id);
        assert.equal(merged.statusCode, 200, merged.body?.toString());

        // The base carries the layer's consciously chosen content, not the
        // hotfix that happened to land first.
        const after = await call(ctx, 'GET', `/thoughts/${a}`);
        assert.equal(after.statusCode, 200);
        assert.equal(after.json().data.icon, '🧪');
        assert.equal(after.json().data.version, 2);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('raises a lagging shadow version so the merge cannot regress the base', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A'); // v1
        const layer = await createLayer(ctx, 'Отстающая тень');
        await selectLayer(ctx, layer.id, WORKER);
        assert.equal(
          (await call(ctx, 'PATCH', `/thoughts/${a}`, { icon: '🧪' }, { clientId: WORKER })).statusCode,
          200,
        );
        // Two independent base edits: the base is now at v3, the shadow at v2.
        assert.equal((await call(ctx, 'PATCH', `/thoughts/${a}`, { icon: '🌐' })).statusCode, 200);
        assert.equal((await call(ctx, 'PATCH', `/thoughts/${a}`, { icon: '🌠' })).statusCode, 200);
        assert.equal((await merge(ctx, layer.id)).statusCode, 422);

        const reset = resetLayerOverride(ctx.ndb, layer.id, { thoughts: [a] });
        assert.equal(reset.reset[0]!.current_version, 3);
        assert.equal(reset.reset[0]!.version_raised_to, 3);

        assert.equal((await merge(ctx, layer.id)).statusCode, 200);
        const after = await call(ctx, 'GET', `/thoughts/${a}`);
        assert.equal(after.json().data.icon, '🧪');
        assert.equal(after.json().data.version, 3); // never backwards
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('resets a tombstone over a base edit and then merges it as a deletion', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const layer = await createLayer(ctx, 'Удаление в слое');
        await selectLayer(ctx, layer.id, WORKER);
        assert.equal((await call(ctx, 'DELETE', `/thoughts/${a}`, undefined, { clientId: WORKER })).statusCode, 204);
        // The base edits the row the layer deleted.
        assert.equal((await call(ctx, 'PATCH', `/thoughts/${a}`, { icon: '🌐' })).statusCode, 200);
        assert.equal((await merge(ctx, layer.id)).statusCode, 422);

        const reset = resetLayerOverride(ctx.ndb, layer.id, { thoughts: [a] });
        assert.equal(reset.reset.length, 1);
        assert.equal(reset.reset[0]!.layer_deleted, true);
        assert.equal(reset.reset[0]!.base_deleted, false);

        assert.equal((await merge(ctx, layer.id)).statusCode, 200);
        const after = await call(ctx, 'GET', `/thoughts/${a}`);
        assert.equal(after.statusCode, 404);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('reports non-versioned rows as untouched and rejects a missing shadow row', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await thought(ctx, 'A');
        const layer = await createLayer(ctx, 'Проверки');
        await selectLayer(ctx, layer.id, WORKER);
        // Materialise the thought shadow and one synonym row (non-versioned).
        assert.equal(
          (
            await call(ctx, 'PATCH', `/thoughts/${a}`, { icon: '🧪', synonyms: ['син'] }, { clientId: WORKER })
          ).statusCode,
          200,
        );
        const synonym = ctx.ndb
          .prepare('SELECT id FROM thought_synonyms WHERE layer_id = ? LIMIT 1')
          .get(layer.id) as { id: string } | undefined;
        assert.ok(synonym !== undefined, 'синоним должен материализоваться в слое');

        const res = resetLayerOverride(
          ctx.ndb,
          layer.id,
          { thoughts: [a], thought_synonyms: [synonym.id] },
        );
        // The thought row is already in sync with the base; the synonym has no
        // version to compare at all.
        assert.equal(res.reset.length, 0);
        assert.deepEqual(
          res.unchanged.slice().sort((x, y) => x.table.localeCompare(y.table)),
          [
            { table: 'thought_synonyms', id: synonym.id, reason: 'not_versioned' },
            { table: 'thoughts', id: a, reason: 'up_to_date' },
          ],
        );

        // A row the layer does not hold is a 422, not a silent no-op.
        throwsEtn('VALIDATION_ERROR', () =>
          resetLayerOverride(ctx.ndb, layer.id, { thoughts: ['00000000-0000-4000-8000-0000000000ff'] }),
        );
        // The base itself and an empty selection are invalid too.
        throwsEtn('VALIDATION_ERROR', () => resetLayerOverride(ctx.ndb, BASE_LAYER_ID, { thoughts: [a] }));
        throwsEtn('VALIDATION_ERROR', () => resetLayerOverride(ctx.ndb, layer.id, {}));
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
