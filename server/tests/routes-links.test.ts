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
  },
);
