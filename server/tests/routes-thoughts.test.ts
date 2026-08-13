/**
 * Integration tests for the /thoughts routes (task D1, D8) via app.inject:
 * CRUD with If-Match conflicts, protected HOME, focus, neighbours, batch,
 * resolve, mentions and the add-dialog duplicates endpoint.
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

/** Create a thought and assert 201; returns its id. */
async function createThought(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload,
  });
  assert.equal(res.statusCode, 201);
  const data = res.json().data as { id: string; version: number };
  assert.equal(data.version, 1);
  return data.id;
}

describe(
  '/thoughts routes',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('CRUD: create with link, read, patch with If-Match, delete', async () => {
      const ctx = await buildRestContext();
      try {
        // Create a child of HOME with an inline link (direction=child).
        const childId = await createThought(ctx, {
          title: 'Ребёнок',
          create_link: { direction: 'child', target_thought_id: ctx.homeId },
        });

        const get = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${childId}`,
          headers: authHeaders(ctx),
        });
        assert.equal(get.statusCode, 200);
        assert.equal((get.json().data as { title: string }).title, 'Ребёнок');

        // Correct If-Match: version bumps to 2.
        const patch = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${childId}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { title: 'Ребёнок v2', synonyms: ['чадо', 'отпрыск'] },
        });
        assert.equal(patch.statusCode, 200);
        const patched = patch.json().data as { version: number; synonyms: string[] };
        assert.equal(patched.version, 2);
        assert.deepEqual(patched.synonyms, ['отпрыск', 'чадо']);

        // Stale If-Match → 409 VERSION_CONFLICT.
        const conflict = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${childId}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { title: 'Устаревшее' },
        });
        assert.equal(conflict.statusCode, 409);
        assert.equal(conflict.json().error.code, 'VERSION_CONFLICT');

        // Delete with stale version → 409; with current version → 204.
        const delConflict = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${childId}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
        });
        assert.equal(delConflict.statusCode, 409);

        const del = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${childId}`,
          headers: { ...authHeaders(ctx), 'if-match': '2' },
        });
        assert.equal(del.statusCode, 204);

        const gone = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${childId}`,
          headers: authHeaders(ctx),
        });
        assert.equal(gone.statusCode, 404);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('protected HOME cannot be deleted (422) or deactivated (422)', async () => {
      const ctx = await buildRestContext();
      try {
        const del = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
        });
        assert.equal(del.statusCode, 422);
        assert.equal(del.json().error.code, 'PROTECTED_ENTITY');

        const deactivate = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { active: false },
        });
        assert.equal(deactivate.statusCode, 422);
        assert.equal(deactivate.json().error.code, 'PROTECTED_ENTITY');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('focus returns focused thought + children; focus prefs and order persist', async () => {
      const ctx = await buildRestContext();
      try {
        const childId = await createThought(ctx, {
          title: 'Фокус-ребёнок',
          create_link: { direction: 'child', target_thought_id: ctx.homeId },
        });

        const focusRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/focus`,
          headers: authHeaders(ctx),
          payload: {},
        });
        assert.equal(focusRes.statusCode, 200);
        const body = focusRes.json().data as {
          focused: { id: string };
          children: Array<{ id: string }>;
          parents: unknown[];
          siblings: unknown[];
        };
        assert.equal(body.focused.id, ctx.homeId);
        assert.ok(body.children.some((c) => c.id === childId));

        // Focus-zone sort choice.
        const prefs = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/focus-preferences`,
          headers: authHeaders(ctx),
          payload: { dir: 'children', sort: 'alpha', order: 'desc' },
        });
        assert.equal(prefs.statusCode, 200);
        assert.equal((prefs.json().data as { sort: string }).sort, 'alpha');

        // Manual order for the children zone.
        const order = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/focus-order`,
          headers: authHeaders(ctx),
          payload: { dir: 'children', ordered_ids: [childId] },
        });
        assert.equal(order.statusCode, 200);
        assert.deepEqual((order.json().data as { ordered_ids: string[] }).ordered_ids, [childId]);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('neighbors: dir/sort/type_id filtering', async () => {
      const ctx = await buildRestContext();
      try {
        const type = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types`,
          headers: authHeaders(ctx),
          payload: { name: 'Люди' },
        });
        const typeId = (type.json().data as { id: string }).id;

        const typedId = await createThought(ctx, {
          title: 'Типизированный',
          type_id: typeId,
          create_link: { direction: 'child', target_thought_id: ctx.homeId },
        });
        await createThought(ctx, {
          title: 'Обычный',
          create_link: { direction: 'child', target_thought_id: ctx.homeId },
        });

        const all = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/neighbors?dir=children&sort=alpha&order=asc`,
          headers: authHeaders(ctx),
        });
        assert.equal(all.statusCode, 200);
        assert.equal((all.json().data as unknown[]).length, 2);

        const filtered = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/neighbors?dir=children&type_id=${typeId}`,
          headers: authHeaders(ctx),
        });
        assert.equal(filtered.statusCode, 200);
        const hits = filtered.json().data as Array<{ id: string }>;
        assert.equal(hits.length, 1);
        assert.equal(hits[0]!.id, typedId);

        const badDir = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/neighbors`,
          headers: authHeaders(ctx),
        });
        assert.equal(badDir.statusCode, 422);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('batch: set_active/inactive, protected HOME failure, link/unlink to focus', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await createThought(ctx, { title: 'Batch A' });
        const b = await createThought(ctx, { title: 'Batch B' });

        const deactivate = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: { ids: [a, b], op: 'set_inactive' },
        });
        assert.equal(deactivate.statusCode, 200);
        assert.equal((deactivate.json().data as { affected: number }).affected, 2);

        // HOME is protected: per-id failure, not a request failure.
        const protectedBatch = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: { ids: [ctx.homeId], op: 'set_inactive' },
        });
        assert.equal(protectedBatch.statusCode, 200);
        const pb = protectedBatch.json().data as {
          affected: number;
          failures: Array<{ id: string; code: string }>;
        };
        assert.equal(pb.affected, 0);
        assert.equal(pb.failures[0]!.code, 'PROTECTED_ENTITY');

        // link_to_focus (direction=child: focus → thought).
        const linkBatch = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: {
            ids: [a, b],
            op: 'link_to_focus',
            args: { focus_thought_id: ctx.homeId, direction: 'child' },
          },
        });
        assert.equal(linkBatch.statusCode, 200);
        assert.equal((linkBatch.json().data as { affected: number }).affected, 2);

        // Linking again → per-id DUPLICATE failures.
        const dupBatch = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: {
            ids: [a],
            op: 'link_to_focus',
            args: { focus_thought_id: ctx.homeId, direction: 'child' },
          },
        });
        assert.equal(dupBatch.statusCode, 200);
        const db = dupBatch.json().data as { affected: number; failures: Array<{ code: string }> };
        assert.equal(db.affected, 0);
        assert.equal(db.failures[0]!.code, 'DUPLICATE');

        // unlink_from_focus removes the links.
        const unlinkBatch = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: {
            ids: [a, b],
            op: 'unlink_from_focus',
            args: { focus_thought_id: ctx.homeId, direction: 'child' },
          },
        });
        assert.equal(unlinkBatch.statusCode, 200);
        assert.equal((unlinkBatch.json().data as { affected: number }).affected, 2);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('resolve returns light metadata and drops unknown ids', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await createThought(ctx, { title: 'Resolve A' });
        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/resolve`,
          headers: authHeaders(ctx),
          payload: { ids: [a, '00000000-0000-0000-0000-000000000000'] },
        });
        assert.equal(res.statusCode, 200);
        const data = res.json().data as Array<{ id: string; title: string }>;
        assert.equal(data.length, 1);
        assert.equal(data[0]!.title, 'Resolve A');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('mentions: a comment on another thought mentioning the title is found', async () => {
      const ctx = await buildRestContext();
      try {
        const target = await createThought(ctx, { title: 'Таргет' });
        const other = await createThought(ctx, { title: 'Другая' });

        const comment = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${other}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'permanent', body_md: 'Ссылаюсь на Таргет.' },
        });
        assert.equal(comment.statusCode, 201);

        const mentions = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${target}/mentions`,
          headers: authHeaders(ctx),
        });
        assert.equal(mentions.statusCode, 200);
        const hits = mentions.json().data as Array<{ owner_id: string }>;
        assert.ok(hits.some((h) => h.owner_id === other));
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('duplicates endpoint (add-thought dialog): exact, synonym and partial', async () => {
      const ctx = await buildRestContext();
      try {
        await createThought(ctx, { title: 'Квантовая механика', synonyms: ['кванты'] });

        const exact = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/duplicates?title=${encodeURIComponent('квантовая механика')}`,
          headers: authHeaders(ctx),
        });
        assert.equal(exact.statusCode, 200);
        const exactHits = exact.json().data as Array<{ matched_on: string }>;
        assert.equal(exactHits[0]!.matched_on, 'title');

        const bySynonym = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/duplicates?title=${encodeURIComponent('кванты')}`,
          headers: authHeaders(ctx),
        });
        assert.equal(bySynonym.statusCode, 200);
        assert.equal(
          (bySynonym.json().data as Array<{ matched_on: string }>)[0]!.matched_on,
          'synonym',
        );

        const partial = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/duplicates?title=${encodeURIComponent('механи')}`,
          headers: authHeaders(ctx),
        });
        assert.equal(partial.statusCode, 200);
        assert.equal(
          (partial.json().data as Array<{ matched_on: string }>)[0]!.matched_on,
          'partial',
        );

        const missingTitle = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/duplicates`,
          headers: authHeaders(ctx),
        });
        assert.equal(missingTitle.statusCode, 422);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('a non-member is rejected (403) and no key is rejected (401)', async () => {
      const ctx = await buildRestContext();
      try {
        const noKey = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}`,
        });
        assert.equal(noKey.statusCode, 401);

        const second = await buildRestContext();
        try {
          const foreign = await second.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}`,
            headers: authHeaders(second),
          });
          assert.equal(foreign.statusCode, 403);
        } finally {
          await closeRestContext(second);
        }
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('invalid body is rejected with VALIDATION_ERROR', async () => {
      const ctx = await buildRestContext();
      try {
        const noTitle = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { synonyms: ['x'] },
        });
        assert.equal(noTitle.statusCode, 422);
        assert.equal(noTitle.json().error.code, 'VALIDATION_ERROR');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
