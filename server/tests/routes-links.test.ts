/**
 * Integration tests for the /links routes (task D2, D8) via app.inject:
 * CRUD with If-Match, duplicate/self-loop invariants and the grouped editor
 * listing (`GET /thoughts/:id/links?group=type`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Create a thought via the API and return its id. */
async function createThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201);
  return (res.json().data as { id: string }).id;
}

describe(
  '/links routes',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('CRUD a link with If-Match; duplicate and self-loop rejected', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await createThought(ctx, 'Исток');
        const b = await createThought(ctx, 'Цель');

        const created = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links`,
          headers: authHeaders(ctx),
          payload: { source_id: a, target_id: b },
        });
        assert.equal(created.statusCode, 201);
        const link = created.json().data as { id: string; version: number; active: boolean };
        assert.equal(link.version, 1);

        // Duplicate untyped pair → 409.
        const dup = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links`,
          headers: authHeaders(ctx),
          payload: { source_id: a, target_id: b },
        });
        assert.equal(dup.statusCode, 409);
        assert.equal(dup.json().error.code, 'DUPLICATE');

        // Self-loop → 422.
        const loop = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links`,
          headers: authHeaders(ctx),
          payload: { source_id: a, target_id: a },
        });
        assert.equal(loop.statusCode, 422);

        // Unknown endpoint → 404.
        const unknown = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links`,
          headers: authHeaders(ctx),
          payload: { source_id: a, target_id: '00000000-0000-0000-0000-000000000000' },
        });
        assert.equal(unknown.statusCode, 404);

        // PATCH active=false with correct If-Match.
        const patched = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/links/${link.id}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { active: false },
        });
        assert.equal(patched.statusCode, 200);
        assert.equal((patched.json().data as { version: number }).version, 2);

        // Stale If-Match → 409.
        const conflict = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/links/${link.id}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { active: true },
        });
        assert.equal(conflict.statusCode, 409);

        // Delete → 204, then 404 on GET.
        const del = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/links/${link.id}`,
          headers: { ...authHeaders(ctx), 'if-match': '2' },
        });
        assert.equal(del.statusCode, 204);

        const gone = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/links/${link.id}`,
          headers: authHeaders(ctx),
        });
        assert.equal(gone.statusCode, 404);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('grouped listing: typed groups and untyped parents/children', async () => {
      const ctx = await buildRestContext();
      try {
        const child = await createThought(ctx, 'Ребёнок для группировки');
        const lt = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/link-types`,
          headers: authHeaders(ctx),
          payload: { name_forward: 'содержит', name_reverse: 'входит в' },
        });
        const linkTypeId = (lt.json().data as { id: string }).id;

        // Typed link HOME → child.
        const typed = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links`,
          headers: authHeaders(ctx),
          payload: { source_id: ctx.homeId, target_id: child, type_id: linkTypeId },
        });
        assert.equal(typed.statusCode, 201);
        assert.equal(
          (typed.json().data as { type_id: string | null }).type_id,
          linkTypeId,
          'POST /links must apply type_id from the body',
        );

        // Untyped link child → HOME (child acts as a parent of HOME).
        const untyped = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links`,
          headers: authHeaders(ctx),
          payload: { source_id: child, target_id: ctx.homeId },
        });
        assert.equal(untyped.statusCode, 201);

        const grouped = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/links?group=type`,
          headers: authHeaders(ctx),
        });
        assert.equal(grouped.statusCode, 200);
        const data = grouped.json().data as {
          by_type: Array<{ type_id: string; items: unknown[] }>;
          untyped_parents: unknown[];
          untyped_children: unknown[];
        };
        assert.equal(data.by_type.length, 1);
        assert.equal(data.by_type[0]!.type_id, linkTypeId);
        assert.equal(data.by_type[0]!.items.length, 1);
        assert.equal(data.untyped_parents.length, 1);
        assert.equal(data.untyped_children.length, 0);

        const badGroup = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/links?group=flat`,
          headers: authHeaders(ctx),
        });
        assert.equal(badGroup.statusCode, 422);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('POST /links applies type_id from the body (regression: bug b1f560f3)', async () => {
      // Regression guard for error b1f560f3: prior to the fix the REST handler
      // silently dropped `type_id` from the request body, so callers following
      // the spec got untyped links without any diagnostic. With the fix in
      // place the type must reach the domain layer: a valid type persists on
      // the new link, an unknown type fails fast with 404 (NOT_FOUND, the
      // project convention for a missing referenced entity), and a duplicate
      // typed pair hits the UNIQUE `(source_id, target_id, type_id)` arm with
      // 409 (so the same triple cannot be inserted twice).
      const ctx = await buildRestContext();
      try {
        const a = await createThought(ctx, 'A');
        const b = await createThought(ctx, 'B');

        const lt = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/link-types`,
          headers: authHeaders(ctx),
          payload: { name_forward: 'содержит', name_reverse: 'входит в' },
        });
        assert.equal(lt.statusCode, 201);
        const linkTypeId = (lt.json().data as { id: string }).id;

        // 1) Valid type_id must be applied to the new link.
        const created = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links`,
          headers: authHeaders(ctx),
          payload: { source_id: a, target_id: b, type_id: linkTypeId },
        });
        assert.equal(created.statusCode, 201);
        assert.equal(
          (created.json().data as { type_id: string | null }).type_id,
          linkTypeId,
          'POST /links must persist type_id from the body (bug b1f560f3)',
        );

        // 2) Unknown type_id must surface as an error, not a silent untyped
        // insert. The project convention for "referenced entity missing" is
        // 404 (NOT_FOUND), used for unknown thoughts / link types / thought
        // types alike — `assertLinkTypeAssignable` throws `NOT_FOUND` for an
        // unknown id, mirroring `assertThoughtTypeAssignable`.
        const unknown = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links`,
          headers: authHeaders(ctx),
          payload: {
            source_id: b,
            target_id: a,
            type_id: '00000000-0000-0000-0000-000000000000',
          },
        });
        assert.equal(unknown.statusCode, 404);
        assert.equal(unknown.json().error.code, 'NOT_FOUND');

        // 3) UNIQUE invariant: the same typed pair cannot be inserted twice.
        // Without the fix this slipped through, producing silent duplicate
        // links; with the fix the duplicate guard fires on the typed triple.
        const dup = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links`,
          headers: authHeaders(ctx),
          payload: { source_id: a, target_id: b, type_id: linkTypeId },
        });
        assert.equal(dup.statusCode, 409);
        assert.equal(dup.json().error.code, 'DUPLICATE');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
