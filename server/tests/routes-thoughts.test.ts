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
  createPlainUser,
  createSecondAdminUser,
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
        // Create a child of HOME with an inline link (direction=parent: HOME
        // becomes the new thought's parent).
        const childId = await createThought(ctx, {
          title: 'Ребёнок',
          create_link: { direction: 'parent', target_thought_id: ctx.homeId },
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
          create_link: { direction: 'parent', target_thought_id: ctx.homeId },
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
          create_link: { direction: 'parent', target_thought_id: ctx.homeId },
        });
        await createThought(ctx, {
          title: 'Обычный',
          create_link: { direction: 'parent', target_thought_id: ctx.homeId },
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

    // Bug fix 0.6.3 (thought f2c7c7d3-f19d-4c98-a80e-db373848da94): `meta.total`
    // used to echo the returned page's length, so a section with more
    // children than the default page size (50) looked complete even though
    // most were silently cut off — the caller had no signal to page further.
    it('neighbors: meta.total reflects the real count, not the truncated page (bug f2c7c7d3)', async () => {
      const ctx = await buildRestContext();
      try {
        for (let i = 0; i < 55; i += 1) {
          await createThought(ctx, {
            title: `Person ${i}`,
            create_link: { direction: 'parent', target_thought_id: ctx.homeId },
          });
        }

        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/neighbors?dir=children`,
          headers: authHeaders(ctx),
        });
        assert.equal(res.statusCode, 200);
        const body = res.json() as { data: unknown[]; meta: { total: number; limit: number } };
        assert.equal(body.data.length, 50, 'page must still be capped at the default limit');
        assert.equal(body.meta.total, 55, 'total must count every match, not just the returned page');
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

    it('batch: bulk link ops (L22) — untyped new links, idempotent, only-parents', async () => {
      const ctx = await buildRestContext();
      try {
        const parent1 = await createThought(ctx, { title: 'Родитель один' });
        const parent2 = await createThought(ctx, { title: 'Родитель два' });
        const x = await createThought(ctx, { title: 'Отобранная X' });
        const y = await createThought(ctx, { title: 'Отобранная Y' });

        // A foreign incoming link parent2 → x (typed with no type).
        const seed = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links`,
          headers: authHeaders(ctx),
          payload: { source_id: parent2, target_id: x },
        });
        assert.equal(seed.statusCode, 201);

        const parentsOf = async (id: string): Promise<string[]> => {
          const res = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}/hierarchy?dir=parents`,
            headers: authHeaders(ctx),
          });
          assert.equal(res.statusCode, 200);
          return (res.json().data as { neighbors: Array<{ id: string }> }).neighbors.map(
            (n) => n.id,
          );
        };

        // link_parents: untyped parent1 → x/y; the existing parent2 → x stays.
        const link = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: { ids: [x, y], op: 'link_parents', args: { parent_ids: [parent1] } },
        });
        assert.equal(link.statusCode, 200);
        const ld = link.json().data as { affected: number; failures: unknown[] };
        assert.equal(ld.affected, 2);
        assert.equal(ld.failures.length, 0);
        assert.deepEqual((await parentsOf(x)).sort(), [parent1, parent2].sort());
        assert.deepEqual(await parentsOf(y), [parent1]);

        // Re-running the same op is idempotent — already linked pairs are kept.
        const linkAgain = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: { ids: [x, y], op: 'link_parents', args: { parent_ids: [parent1] } },
        });
        assert.equal(linkAgain.statusCode, 200);
        const lad = linkAgain.json().data as { affected: number; failures: unknown[] };
        assert.equal(lad.affected, 2);
        assert.equal(lad.failures.length, 0);

        // A self-loop anchor (the thought is in its own parents) is skipped
        // silently — not a per-id failure.
        const selfLoop = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: { ids: [x], op: 'link_parents', args: { parent_ids: [x, parent1] } },
        });
        assert.equal(selfLoop.statusCode, 200);
        assert.equal((selfLoop.json().data as { affected: number }).affected, 1);

        // set_only_parents: parent2 → x is dropped, parent1 → x survives.
        const only = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: { ids: [x], op: 'set_only_parents', args: { parent_ids: [parent1] } },
        });
        assert.equal(only.statusCode, 200);
        assert.equal((only.json().data as { affected: number }).affected, 1);
        assert.deepEqual(await parentsOf(x), [parent1]);

        // unlink_parents: drop the links with the picked parents only.
        const unlink = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: { ids: [x], op: 'unlink_parents', args: { parent_ids: [parent1, parent2] } },
        });
        assert.equal(unlink.statusCode, 200);
        assert.equal((unlink.json().data as { affected: number }).affected, 1);
        assert.deepEqual(await parentsOf(x), []);

        // link_children creates x → y; unlink_children drops it back. (The
        // parent1 → y link from the link_parents step above stays — unlink is
        // scoped to the picked anchors.)
        const linkChild = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: { ids: [x], op: 'link_children', args: { child_ids: [y] } },
        });
        assert.equal(linkChild.statusCode, 200);
        assert.deepEqual((await parentsOf(y)).sort(), [parent1, x].sort());
        const unlinkChild = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: { ids: [x], op: 'unlink_children', args: { child_ids: [y] } },
        });
        assert.equal(unlinkChild.statusCode, 200);
        assert.deepEqual(await parentsOf(y), [parent1]);

        // args validation: missing anchor list → 422 for the whole request.
        const badArgs = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: { ids: [x], op: 'link_parents', args: {} },
        });
        assert.equal(badArgs.statusCode, 422);

        // args.link_type_id sets the type of the links the op CREATES; the
        // pairs linked above (untyped) are untouched, the new one is typed.
        const lt = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/link-types`,
          headers: authHeaders(ctx),
          payload: { name_forward: 'Содержит', name_reverse: 'Входит в' },
        });
        assert.equal(lt.statusCode, 201);
        const linkTypeId = (lt.json().data as { id: string }).id;
        const typed = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/batch`,
          headers: authHeaders(ctx),
          payload: {
            ids: [y],
            op: 'link_parents',
            args: { parent_ids: [x, parent2], link_type_id: linkTypeId },
          },
        });
        assert.equal(typed.statusCode, 200);
        assert.equal((typed.json().data as { affected: number }).affected, 1);
        // y keeps the untyped parent1 link and gains typed x/parent2 links.
        const yLinks = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${y}/links?group=type`,
          headers: authHeaders(ctx),
        });
        assert.equal(yLinks.statusCode, 200);
        const grouped = yLinks.json().data as {
          by_type: Array<{ type_id: string | null; items: Array<{ link: { source_id: string } }> }>;
          untyped_parents: Array<{ link: { source_id: string } }>;
        };
        const typedGroup = grouped.by_type.find((g) => g.type_id === linkTypeId);
        assert.ok(typedGroup !== undefined);
        assert.deepEqual(
          typedGroup.items.map((i) => i.link.source_id).sort(),
          [x, parent2].sort(),
        );
        // The pre-existing untyped parent1 → y link is untouched.
        assert.ok(grouped.untyped_parents.some((u) => u.link.source_id === parent1));
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

        // 0.4.5: partial matches a whole word of the title…
        const partial = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/duplicates?title=${encodeURIComponent('механика')}`,
          headers: authHeaders(ctx),
        });
        assert.equal(partial.statusCode, 200);
        assert.equal(
          (partial.json().data as Array<{ matched_on: string }>)[0]!.matched_on,
          'partial',
        );

        // 0.4.5: partial matches infix fragments of a word — «механи» finds
        // «Квантовая механика» as a weak partial candidate (never as a duplicate).
        const infix = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/duplicates?title=${encodeURIComponent('механи')}`,
          headers: authHeaders(ctx),
        });
        assert.equal(infix.statusCode, 200);
        const infixHits = infix.json().data as Array<{ matched_on: string }>;
        assert.equal(infixHits.length, 1);
        assert.equal(infixHits[0]!.matched_on, 'partial');

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

        // A plain (non-admin, non-member) user is forbidden — `buildRestContext`'s
        // own user is always a global admin, which now bypasses membership by
        // design (task 0.4.2 bug-fix), so a genuine "no rights at all" caller
        // must be a non-admin (see the dedicated admin-bypass test below).
        const foreign = createPlainUser(ctx);
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}`,
          headers: { authorization: `Bearer ${foreign.key}` },
        });
        assert.equal(res.statusCode, 403);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('a plain member (added, not owner, not admin) has full write rights on the graph (task 0.4.2)', async () => {
      const ctx = await buildRestContext();
      try {
        const member = createPlainUser(ctx);
        const add = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/members`,
          headers: authHeaders(ctx),
          payload: { user_id: member.userId },
        });
        assert.equal(add.statusCode, 201);
        const memberHeaders = { authorization: `Bearer ${member.key}` };

        const created = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: memberHeaders,
          payload: { title: 'Создано участником' },
        });
        assert.equal(created.statusCode, 201);
        const thoughtId = (created.json().data as { id: string }).id;

        const patched = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}`,
          headers: { ...memberHeaders, 'if-match': '1' },
          payload: { title: 'Переименовано участником' },
        });
        assert.equal(patched.statusCode, 200);

        const deleted = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}`,
          headers: { ...memberHeaders, 'if-match': '2' },
        });
        assert.equal(deleted.statusCode, 204);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('a global admin without explicit membership can read and write a foreign network (task 0.4.2)', async () => {
      const ctx = await buildRestContext();
      try {
        // Second admin, on the same server, never added to ctx.networkId's
        // network_members row.
        const secondAdmin = createSecondAdminUser(ctx);
        const headers = { authorization: `Bearer ${secondAdmin.key}` };

        const get = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}`,
          headers,
        });
        assert.equal(get.statusCode, 200);

        const created = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers,
          payload: { title: 'Создано чужим админом' },
        });
        assert.equal(created.statusCode, 201);
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

    it('a body that is not valid UTF-8 JSON is rejected with 400 BAD_REQUEST, not 500', async () => {
      const ctx = await buildRestContext();
      try {
        // Raw bytes that are not a valid UTF-8 sequence: simulates a client
        // sending its console's native (non-UTF-8) encoding for a body with
        // non-ASCII text — e.g. `curl -d '{"title":"<кириллица>"}'` from Git
        // Bash on Windows, where the argument is encoded via the active code
        // page (cp866/cp1251) rather than UTF-8. `0xcf 0xf0 0xe8 0xe2 0xe5
        // 0xf2` below is "Привет" as cp1251 bytes, which decode to invalid
        // UTF-8 (each byte replaced by U+FFFD, changing the byte length and
        // tripping Fastify's Content-Length check) instead of throwing a
        // recognisable "bad JSON" error — this used to fall through the
        // global error handler as a generic 500 INTERNAL.
        const invalidUtf8Body = Buffer.from([
          0x7b,
          0x22,
          0x74,
          0x69,
          0x74,
          0x6c,
          0x65,
          0x22,
          0x3a,
          0x22, // {"title":"
          0xcf,
          0xf0,
          0xe8,
          0xe2,
          0xe5,
          0xf2, // cp1251 "Привет" — invalid as UTF-8
          0x22,
          0x7d, // "}
        ]);

        const res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
          payload: invalidUtf8Body,
        });
        assert.equal(res.statusCode, 400);
        assert.equal(res.json().error.code, 'BAD_REQUEST');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
