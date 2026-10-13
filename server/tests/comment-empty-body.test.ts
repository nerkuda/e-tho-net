/**
 * Пустое тело комментария — не ошибка (ошибка 00f1d0e6, ожидание заказчика
 * 2026-10-13: «пустой комментарий допускается везде»; требование 26f0aa52 —
 * согласованность create/update, модель немедленного создания).
 *
 * Проверяется сквозь ОБА фасада и оба вида комментариев:
 *   * REST `PATCH /comments/{id}` и MCP `etn.comments.update` опустошают
 *     постоянный комментарий и хроно-запись — без `VALIDATION_ERROR`;
 *   * повторное заполнение после очистки работает (version растёт);
 *   * создание с пустым телом не отвергается (в т.ч. `comment` мысли).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NetworkDb } from '../src/db/network-db.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';
import { buildMcpContext, closeMcpContext, connectMcpClient, toolJson } from './mcp-helpers.js';

/** Thought via the API, id out. */
async function createThought(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.json()));
  return (res.json().data as { id: string }).id;
}

/** Comment via the API (permanent or chronological), `{ id, version }` out. */
async function createComment(
  ctx: RestTestContext,
  thoughtId: string,
  payload: Record<string, unknown>,
): Promise<{ id: string; version: number }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/comments`,
    headers: authHeaders(ctx),
    payload,
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.json()));
  return res.json().data as { id: string; version: number };
}

/** REST PATCH of the body; the whole envelope back. */
async function patchBody(
  ctx: RestTestContext,
  commentId: string,
  bodyMd: string,
  version: number,
): Promise<{ status: number; data: { body_md: string; body_html: string; version: number } }> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/networks/${ctx.networkId}/comments/${commentId}`,
    headers: { ...authHeaders(ctx), 'if-match': String(version) },
    payload: { body_md: bodyMd },
  });
  return { status: res.statusCode, data: res.json().data as never };
}

describe(
  'комментарий: пустое тело — не ошибка (00f1d0e6)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('REST: очистка постоянного комментария и хроно-записи сохраняется, повторное заполнение работает', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Хозяин пустого комментария');

        for (const kind of ['permanent', 'chronological'] as const) {
          const comment = await createComment(ctx, thoughtId, {
            kind,
            body_md: 'Исходный **текст**',
          });

          // Пустое тело — обычное сохранение: 200, тело и рендер пусты.
          const cleared = await patchBody(ctx, comment.id, '', comment.version);
          assert.equal(cleared.status, 200, `очистка ${kind} — 200`);
          assert.equal(cleared.data.body_md, '');
          assert.equal(cleared.data.body_html, '');
          assert.equal(cleared.data.version, comment.version + 1);

          // Повторное заполнение после очистки.
          const refilled = await patchBody(ctx, comment.id, 'Снова **текст**', cleared.data.version);
          assert.equal(refilled.status, 200, `заполнение ${kind} после очистки — 200`);
          assert.equal(refilled.data.body_md, 'Снова **текст**');
          assert.ok(refilled.data.body_html.includes('<strong>текст</strong>'));

          // Текст действительно в базе, а не только в ответе.
          const stored = ctx.ndb
            .prepare('SELECT body_md FROM comments_v WHERE id = ?')
            .get(comment.id) as { body_md: string };
          assert.equal(stored.body_md, 'Снова **текст**');
        }
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('REST: создание с пустым телом не отвергается (permanent, chronological, comment мысли)', async () => {
      const ctx = await buildRestContext();
      try {
        const thoughtId = await createThought(ctx, 'Творение пустых комментариев');

        const permanent = await createComment(ctx, thoughtId, { kind: 'permanent', body_md: '' });
        const chronological = await createComment(ctx, thoughtId, {
          kind: 'chronological',
          body_md: '',
        });
        const emptyRows = ctx.ndb
          .prepare('SELECT kind, body_md, body_html FROM comments_v WHERE id IN (?, ?)')
          .all(permanent.id, chronological.id) as Array<{
          kind: string;
          body_md: string;
          body_html: string;
        }>;
        assert.equal(emptyRows.length, 2, 'обе пустые записи созданы');
        assert.deepEqual(
          emptyRows.map((r) => [r.kind, r.body_md, r.body_html]).sort(),
          [
            ['chronological', '', ''],
            ['permanent', '', ''],
          ],
        );

        // Мысль с пустым постоянным комментарием — тоже не ошибка.
        const withEmptyComment = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts`,
          headers: authHeaders(ctx),
          payload: { title: 'Мысль с пустым комментарием', comment: { body_md: '' } },
        });
        assert.equal(withEmptyComment.statusCode, 201, JSON.stringify(withEmptyComment.json()));
        const emptyThoughtId = (withEmptyComment.json().data as { id: string }).id;
        const stored = ctx.ndb
          .prepare(
            "SELECT body_md FROM comments_v WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'permanent'",
          )
          .get(emptyThoughtId) as { body_md: string } | undefined;
        assert.equal(stored?.body_md, '', 'пустой постоянный комментарий мысли сохранён');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('MCP: etn.comments.update опустошает постоянный комментарий и хроно-запись, заполнение возвращается', async () => {
      const rest = await buildRestContext();
      const mcp = await buildMcpContext({
        dataDir: rest.dataDir,
        networkId: rest.networkId,
        systemDb: rest.sys,
      });
      const handle = await connectMcpClient(mcp, rest.adminKey);
      try {
        const ndb = rest.ndb as NetworkDb;
        const thoughtId = await createThought(rest, 'Хозяин для MCP');

        /** Правка тела через MCP; возвращает новую версию. */
        const mcpPatch = async (
          commentId: string,
          bodyMd: string,
          version: number,
        ): Promise<number> => {
          const res = await handle.client.callTool({
            name: 'etn.comments.update',
            arguments: {
              network_id: rest.networkId,
              comment_id: commentId,
              changes: { body_md: bodyMd },
              expected_version: version,
            },
          });
          const payload = toolJson<{ id: string; version: number }>(res);
          assert.equal(payload.id, commentId);
          return payload.version;
        };

        for (const kind of ['permanent', 'chronological'] as const) {
          const comment = await createComment(rest, thoughtId, { kind, body_md: 'До очистки' });
          const clearedVersion = await mcpPatch(comment.id, '', comment.version);
          const cleared = ndb
            .prepare('SELECT body_md, body_html FROM comments_v WHERE id = ?')
            .get(comment.id) as { body_md: string; body_html: string };
          assert.deepEqual(cleared, { body_md: '', body_html: '' }, `${kind}: пустое тело сохранено`);

          await mcpPatch(comment.id, 'После очистки', clearedVersion);
          const refilled = ndb
            .prepare('SELECT body_md FROM comments_v WHERE id = ?')
            .get(comment.id) as { body_md: string };
          assert.equal(refilled.body_md, 'После очистки', `${kind}: заполнение вернулось`);
        }

        // Тот же путь для батча MCP: пустой `comment` мысли не отвергается.
        const before = (
          ndb
            .prepare("SELECT COUNT(*) AS n FROM comments_v WHERE body_md = '' AND kind = 'permanent'")
            .get() as { n: number }
        ).n;
        const batch = await handle.client.callTool({
          name: 'etn.thoughts.write',
          arguments: {
            network_id: rest.networkId,
            thoughts: [
              { ref: 'empty', thought: { title: 'MCP: мысль с пустым комментарием' }, comment: { body_md: '' } },
            ],
          },
        });
        assert.ok(!('isError' in batch) || batch.isError !== true, JSON.stringify(batch));
        const after = (
          ndb
            .prepare("SELECT COUNT(*) AS n FROM comments_v WHERE body_md = '' AND kind = 'permanent'")
            .get() as { n: number }
        ).n;
        assert.equal(after, before + 1, 'батч создал пустой постоянный комментарий');
      } finally {
        await handle.close();
        await closeMcpContext(mcp, {
          dataDir: rest.dataDir,
          networkId: rest.networkId,
          systemDb: rest.sys,
        });
        await closeRestContext(rest);
      }
    });
  },
);
