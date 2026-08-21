/**
 * Integration tests for the /comments and /attachments routes (task D5, D8)
 * via app.inject: polymorphic owners (thought/link), the "one permanent
 * comment per owner" invariant (409), If-Match on comments, and
 * last-write-wins attachment updates.
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
  '/comments and /attachments routes',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('comments: permanent + chronological CRUD, second permanent → 409', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Хозяин комментариев');

        const permanent = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'permanent', body_md: '**Постоянный** текст' },
        });
        assert.equal(permanent.statusCode, 201);
        const perm = permanent.json().data as { id: string; version: number; body_html: string };
        assert.ok(perm.body_html.includes('<strong>Постоянный</strong>'));

        // Second permanent on the same owner → 409 DUPLICATE.
        const secondPermanent = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'permanent', body_md: 'Второй постоянный' },
        });
        assert.equal(secondPermanent.statusCode, 409);
        assert.equal(secondPermanent.json().error.code, 'DUPLICATE');

        const chrono = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/comments`,
          headers: authHeaders(ctx),
          payload: {
            kind: 'chronological',
            title: 'Событие',
            body_md: 'Хронология',
            valid_from: '2026-01-01',
          },
        });
        assert.equal(chrono.statusCode, 201);

        const list = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/comments`,
          headers: authHeaders(ctx),
        });
        assert.equal(list.statusCode, 200);
        assert.equal((list.json().data as unknown[]).length, 2);

        // PATCH with correct If-Match bumps the version.
        const patched = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/comments/${perm.id}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { body_md: 'Обновлённый **текст**' },
        });
        assert.equal(patched.statusCode, 200);
        assert.equal((patched.json().data as { version: number }).version, 2);

        const conflict = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/comments/${perm.id}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { body_md: 'Устаревший' },
        });
        assert.equal(conflict.statusCode, 409);

        const del = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/comments/${perm.id}`,
          headers: { ...authHeaders(ctx), 'if-match': '2' },
        });
        assert.equal(del.statusCode, 204);

        // Comments on links work too.
        const linkRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links`,
          headers: authHeaders(ctx),
          payload: { source_id: ctx.homeId, target_id: thoughtId },
        });
        const linkId = (linkRes.json().data as { id: string }).id;
        const linkComment = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links/${linkId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'chronological', body_md: 'Комментарий связи' },
        });
        assert.equal(linkComment.statusCode, 201);

        // Unknown owner → 404.
        const missingOwner = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/00000000-0000-0000-0000-000000000000/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'permanent', body_md: 'x' },
        });
        assert.equal(missingOwner.statusCode, 404);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('attachments: url/file validation, list, patch (no If-Match), delete', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Хозяин вложений');

        // url without a url → 422.
        const badUrl = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments`,
          headers: authHeaders(ctx),
          payload: { kind: 'url', title: 'Ссылка' },
        });
        assert.equal(badUrl.statusCode, 422);

        const url = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments`,
          headers: authHeaders(ctx),
          payload: { kind: 'url', url: 'https://example.com/', title: 'Ссылка' },
        });
        assert.equal(url.statusCode, 201);
        const urlAtt = url.json().data as { id: string };

        // file without file_path → 422; with → 201.
        const badFile = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments`,
          headers: authHeaders(ctx),
          payload: { kind: 'file', mime_type: 'text/plain' },
        });
        assert.equal(badFile.statusCode, 422);

        const file = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments`,
          headers: authHeaders(ctx),
          payload: { kind: 'file', file_path: 'C:\\docs\\note.txt', mime_type: 'text/plain' },
        });
        assert.equal(file.statusCode, 201);
        const fileAtt = file.json().data as { id: string };

        const list = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments`,
          headers: authHeaders(ctx),
        });
        assert.equal(list.statusCode, 200);
        assert.equal((list.json().data as unknown[]).length, 2);

        // PATCH without If-Match (attachments have no version column).
        const patched = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/attachments/${urlAtt.id}`,
          headers: authHeaders(ctx),
          payload: { title: 'Обновлённая ссылка' },
        });
        assert.equal(patched.statusCode, 200);
        assert.equal((patched.json().data as { title: string }).title, 'Обновлённая ссылка');

        const del = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/attachments/${fileAtt.id}`,
          headers: authHeaders(ctx),
        });
        assert.equal(del.statusCode, 204);

        const after = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments`,
          headers: authHeaders(ctx),
        });
        assert.equal((after.json().data as unknown[]).length, 1);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('attachments: POST /attachments/:id/copy — multi-target, skip duplicates, 404/422', async () => {
      const ctx = await buildRestContext();
      try {
        const source = await createThought(ctx, 'Источник');
        const t1 = await createThought(ctx, 'Получатель 1');
        const t2 = await createThought(ctx, 'Получатель 2');

        // Create source attachment.
        const sourceAtt = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${source}/attachments`,
          headers: authHeaders(ctx),
          payload: {
            kind: 'url',
            url: 'https://example.com/page',
            title: 'Page',
            description: 'desc',
            mime_type: 'text/html',
          },
        });
        assert.equal(sourceAtt.statusCode, 201);
        const sourceId = (sourceAtt.json().data as { id: string }).id;

        // Copy to two targets — both new.
        const copyRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/attachments/${sourceId}/copy`,
          headers: authHeaders(ctx),
          payload: { target_owner_type: 'thought', target_owner_ids: [t1, t2] },
        });
        assert.equal(copyRes.statusCode, 200);
        const copyBody = copyRes.json().data as {
          created: Array<{ id: string; owner_id: string; title: string }>;
          skipped: string[];
        };
        assert.equal(copyBody.created.length, 2);
        assert.deepEqual(copyBody.skipped, []);
        const newIds = new Set(copyBody.created.map((c) => c.id));
        assert.equal(newIds.size, 2);
        for (const c of copyBody.created) {
          assert.equal(c.title, 'Page');
          assert.ok([t1, t2].includes(c.owner_id));
        }

        // Re-copy: same source, target t1 already has the same kind+url — skipped.
        const reCopy = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/attachments/${sourceId}/copy`,
          headers: authHeaders(ctx),
          payload: { target_owner_type: 'thought', target_owner_ids: [t1, t2] },
        });
        assert.equal(reCopy.statusCode, 200);
        const reBody = reCopy.json().data as {
          created: unknown[];
          skipped: string[];
        };
        assert.equal(reBody.created.length, 0);
        assert.deepEqual(reBody.skipped.sort(), [t1, t2].sort());

        // Each target now has exactly one copy in its list.
        for (const tid of [t1, t2]) {
          const list = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thoughts/${tid}/attachments`,
            headers: authHeaders(ctx),
          });
          assert.equal((list.json().data as unknown[]).length, 1);
        }

        // Unknown source → 404.
        const missing = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/attachments/00000000-0000-0000-0000-000000000000/copy`,
          headers: authHeaders(ctx),
          payload: { target_owner_type: 'thought', target_owner_ids: [t1] },
        });
        assert.equal(missing.statusCode, 404);

        // Unknown target → 422.
        const badTarget = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/attachments/${sourceId}/copy`,
          headers: authHeaders(ctx),
          payload: {
            target_owner_type: 'thought',
            target_owner_ids: ['00000000-0000-0000-0000-000000000000'],
          },
        });
        assert.equal(badTarget.statusCode, 422);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('attachments: GET /attachments — network-wide search with q/kind/exclude_owner', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await createThought(ctx, 'Владелец A');
        const b = await createThought(ctx, 'Владелец B');
        // Three attachments across two owners.
        for (const [owner, payload] of [
          [a, { kind: 'url', url: 'https://e.com/roadmap', title: 'Roadmap Q4' }],
          [a, { kind: 'url', url: 'https://e.com/budget', title: 'Budget 2025' }],
          [b, { kind: 'file', file_path: 'C:\\notes.txt', title: 'Notes' }],
        ] as const) {
          const res = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thoughts/${owner}/attachments`,
            headers: authHeaders(ctx),
            payload,
          });
          assert.equal(res.statusCode, 201);
        }

        // Search by title keyword.
        const byTitle = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments?q=roadmap`,
          headers: authHeaders(ctx),
        });
        assert.equal(byTitle.statusCode, 200);
        assert.equal((byTitle.json().data as unknown[]).length, 1);

        // Empty q → empty result (no unscoped listing).
        const empty = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments`,
          headers: authHeaders(ctx),
        });
        assert.equal(empty.statusCode, 200);
        assert.equal((empty.json().data as unknown[]).length, 0);

        // Exclude owner — keyword "notes" hits only B's row (A has no match).
        const excludeA = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments?q=notes&exclude_owner_type=thought&exclude_owner_id=${a}`,
          headers: authHeaders(ctx),
        });
        assert.equal(excludeA.statusCode, 200);
        const items = excludeA.json().data as Array<{ owner_id: string }>;
        assert.equal(items.length, 1);
        assert.equal(items[0]!.owner_id, b);

        // Without `exclude_owner` the same `q` would also match nothing for A
        // (A has no "notes" row), so flip the keyword to a common one and
        // check that exclude_owner actually filters out A's matches.
        const withoutExclude = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments?q=e`,
          headers: authHeaders(ctx),
        });
        const withExclude = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments?q=e&exclude_owner_type=thought&exclude_owner_id=${a}`,
          headers: authHeaders(ctx),
        });
        assert.equal(withoutExclude.statusCode, 200);
        assert.equal(withExclude.statusCode, 200);
        const allRows = withoutExclude.json().data as Array<{ owner_id: string }>;
        const filteredRows = withExclude.json().data as Array<{ owner_id: string }>;
        // `e` is a one-letter substring of "Roadmap", "Budget" and "notes" —
        // every attachment matches. Excluding owner `a` leaves only B's row.
        assert.equal(allRows.length, 3);
        assert.equal(filteredRows.length, 1);
        assert.equal(filteredRows[0]!.owner_id, b);

        // Filter by kind — only the url row remains.
        const onlyUrl = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments?q=roadmap&kind=url`,
          headers: authHeaders(ctx),
        });
        assert.equal((onlyUrl.json().data as unknown[]).length, 1);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
