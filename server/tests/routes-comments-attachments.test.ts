/**
 * Integration tests for the /comments and /attachments routes (task D5, D8)
 * via app.inject: polymorphic owners (thought/link), the "one permanent
 * comment per owner" invariant (409), If-Match on comments, and
 * last-write-wins attachment updates.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { DEFAULT_MAX_LENGTH } from '@etn/markdown';

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

        // Comments on links work too (0.8.1: связь создаётся через свойство).
        const setLink = await ctx.app.inject({
          method: 'PUT',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/properties/${encodeURIComponent('Потомки')}`,
          headers: authHeaders(ctx),
          payload: { value: [thoughtId] },
        });
        assert.equal(setLink.statusCode, 200);
        const propsRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/properties`,
          headers: authHeaders(ctx),
        });
        const potomki = (propsRes.json().data as Array<{ property_name: string; values?: Array<{ link_id: string }> }>).find(
          (p) => p.property_name === 'Потомки',
        );
        const linkId = potomki!.values![0]!.link_id;
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

    it('attachments: url/file validation, list, patch metadata', async () => {
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

        // PATCH без If-Match (у вложений нет колонки версии) — правка метаданных.
        const patched = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/attachments/${urlAtt.id}`,
          headers: authHeaders(ctx),
          payload: { title: 'Обновлённая ссылка' },
        });
        assert.equal(patched.statusCode, 200);
        assert.equal((patched.json().data as { title: string }).title, 'Обновлённая ссылка');

        // Снятие владельца (owner-cleanup): последний живой владелец удаляет вложение.
        const del = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/attachments/${fileAtt.id}/owners`,
          headers: authHeaders(ctx),
          payload: { owner_type: 'thought', owner_id: thoughtId },
        });
        assert.equal(del.statusCode, 200, del.body);
        assert.deepEqual(del.json().data, { removed: true, attachment_deleted: true });

        const after = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments`,
          headers: authHeaders(ctx),
        });
        assert.equal((after.json().data as unknown[]).length, 1);

        // Публичного DELETE вложения БОЛЬШЕ НЕТ (0.12.1, задача 478f8c1f).
        const gone = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/attachments/${urlAtt.id}`,
          headers: authHeaders(ctx),
        });
        assert.equal(gone.statusCode, 404, gone.body);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('attachments: PUT /content over the render limit → 422, file and row unchanged (9f2e94b0)', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Хозяин редактора');
        const upload = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments/file`,
          headers: authHeaders(ctx),
          payload: {
            title: 'Заметка',
            mime_type: 'text/markdown',
            data_base64: Buffer.from('# старый').toString('base64'),
          },
        });
        assert.equal(upload.statusCode, 201);
        const att = upload.json().data as { id: string; file_path: string; file_size: number };
        const contentUrl = `/api/v1/networks/${ctx.networkId}/attachments/${att.id}/content`;

        // Over-limit markdown body → 422 VALIDATION_ERROR with the payload field.
        const over = 'a'.repeat(DEFAULT_MAX_LENGTH + 1);
        const rejected = await ctx.app.inject({
          method: 'PUT',
          url: contentUrl,
          headers: authHeaders(ctx),
          payload: { data_base64: Buffer.from(over).toString('base64') },
        });
        assert.equal(rejected.statusCode, 422);
        const error = rejected.json().error as { code: string; details?: { field?: string } };
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.equal(error.details?.field, 'data_base64');

        // Neither the file on disk nor the row changed.
        assert.equal(readFileSync(att.file_path, 'utf8'), '# старый');
        const meta = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments/${att.id}`,
          headers: authHeaders(ctx),
        });
        assert.equal((meta.json().data as { file_size: number }).file_size, att.file_size);

        // Boundary is inclusive: exactly the limit is accepted, and a normal
        // update still rewrites the file.
        const exact = 'a'.repeat(DEFAULT_MAX_LENGTH);
        const ok = await ctx.app.inject({
          method: 'PUT',
          url: contentUrl,
          headers: authHeaders(ctx),
          payload: { data_base64: Buffer.from(exact).toString('base64') },
        });
        assert.equal(ok.statusCode, 200);
        assert.equal(readFileSync(att.file_path, 'utf8'), exact);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('attachments: GET /attachments/raw serves stored file bytes by path', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Хозяин картинки');

        // Missing ?path → 422.
        const noPath = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments/raw`,
          headers: authHeaders(ctx),
        });
        assert.equal(noPath.statusCode, 422);

        // Upload a stored copy (this is what remote clients then download).
        const upload = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/attachments/file`,
          headers: authHeaders(ctx),
          payload: {
            title: 'Фото',
            mime_type: 'image/png',
            data_base64: Buffer.from('fakepng').toString('base64'),
          },
        });
        assert.equal(upload.statusCode, 201);
        const att = upload.json().data as { file_path: string };

        const raw = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments/raw?path=${encodeURIComponent(att.file_path)}`,
          headers: authHeaders(ctx),
        });
        assert.equal(raw.statusCode, 200);
        assert.match(String(raw.headers['content-type'] ?? ''), /image\/png/);
        assert.equal(raw.rawPayload.toString(), 'fakepng');

        // A client-local path (existing row or not) is never served.
        const local = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments/raw?path=${encodeURIComponent('C:\\docs\\note.txt')}`,
          headers: authHeaders(ctx),
        });
        assert.equal(local.statusCode, 404);
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
          added: Array<{ owner_type: string; owner_id: string; title: string | null }>;
          skipped: unknown[];
        };
        assert.equal(copyBody.added.length, 2);
        assert.deepEqual(copyBody.skipped, []);
        // Муль-владение: у того же вложения появились владельцы t1/t2.
        assert.deepEqual(
          copyBody.added.map((a) => a.owner_id).sort(),
          [t1, t2].sort(),
        );

        // Re-copy: those owners already exist — all skipped, nothing added.
        const reCopy = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/attachments/${sourceId}/copy`,
          headers: authHeaders(ctx),
          payload: { target_owner_type: 'thought', target_owner_ids: [t1, t2] },
        });
        assert.equal(reCopy.statusCode, 200);
        const reBody = reCopy.json().data as {
          added: unknown[];
          skipped: Array<{ owner_id: string }>;
        };
        assert.equal(reBody.added.length, 0);
        assert.deepEqual(reBody.skipped.map((s) => s.owner_id).sort(), [t1, t2].sort());

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

        // Пагинация: `limit`/`offset` приходят СТРОКАМИ и обязаны приниматься
        // (регресс: `parse: truncInt` ждал число и отдавал 422 на любой
        // limit/offset — исправлено `queryInt`, задача 0f6c3e39). `q=e` даёт
        // все три строки; страница по два вложения.
        const firstPage = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments?q=e&limit=2&offset=0`,
          headers: authHeaders(ctx),
        });
        assert.equal(firstPage.statusCode, 200);
        const firstBody = firstPage.json() as {
          data: unknown[];
          meta: { total: number; offset: number; limit: number };
        };
        assert.equal(firstBody.data.length, 2, 'первая страница — не больше limit');
        assert.equal(firstBody.meta.limit, 2);
        assert.equal(firstBody.meta.offset, 0);
        assert.equal(firstBody.meta.total, 3, 'total — всё множество, не страница');

        const secondPage = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments?q=e&limit=2&offset=2`,
          headers: authHeaders(ctx),
        });
        assert.equal(secondPage.statusCode, 200);
        const secondBody = secondPage.json() as {
          data: unknown[];
          meta: { total: number; offset: number; limit: number };
        };
        assert.equal(secondBody.data.length, 1, 'хвост второй страницы');
        assert.equal(secondBody.meta.offset, 2);

        // Некорректный limit — понятная ошибка 422 с именем параметра.
        const badLimit = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/attachments?q=e&limit=abc`,
          headers: authHeaders(ctx),
        });
        assert.equal(badLimit.statusCode, 422);
        assert.equal(badLimit.json().error.details.field, 'limit');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
