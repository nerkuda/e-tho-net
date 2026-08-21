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
  },
);
