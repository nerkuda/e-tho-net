/**
 * Интеграционные тесты REST задач (0.16.1, задача 632eca85; операции
 * e6d65f51 GET /tasks и de4cee18 PATCH /tasks).
 *
 * Проверяются: выборка из материализованной проекции (scope, count, today),
 * keyset-курсор, правка toggle/move/cancel с expected_revision → 409,
 * массовые команды, постоянный комментарий, права участника сети и запрет
 * записи через GET.
 *
 * Требует нативного better-sqlite3; иначе пропускается.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TaskListPage, TaskPatchResult } from '@etn/shared';

import {
  apiCreateThought,
  authHeaders,
  buildRestContext,
  closeRestContext,
  createPlainUser,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Создать комментарий-источник задач и вернуть его id. */
async function createComment(
  ctx: RestTestContext,
  thoughtId: string,
  bodyMd: string,
  kind: 'chronological' | 'permanent' = 'chronological',
): Promise<{ id: string; version: number }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/comments`,
    headers: authHeaders(ctx),
    payload: {
      kind,
      body_md: bodyMd,
      ...(kind === 'chronological' ? { valid_from: '2026-11-01' } : {}),
    },
  });
  assert.equal(res.statusCode, 201);
  const data = res.json().data as { id: string; version: number };
  return { id: data.id, version: data.version };
}

/** GET /networks/:id/tasks с произвольными query-параметрами. */
async function getTasks(
  ctx: RestTestContext,
  query: Record<string, string> = {},
): Promise<{ statusCode: number; data: TaskListPage; code?: string }> {
  const search = new URLSearchParams(query).toString();
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/tasks${search === '' ? '' : `?${search}`}`,
    headers: authHeaders(ctx),
  });
  const json = res.json() as { data?: TaskListPage; error?: { code: string } };
  return {
    statusCode: res.statusCode,
    data: json.data as TaskListPage,
    ...(json.error === undefined ? {} : { code: json.error.code }),
  };
}

/** PATCH /networks/:id/tasks. */
async function patchTasks(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
  headers: Record<string, string> = authHeaders(ctx),
): Promise<{ statusCode: number; data: TaskPatchResult; code?: string }> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/networks/${ctx.networkId}/tasks`,
    headers,
    payload,
  });
  const json = res.json() as { data?: TaskPatchResult; error?: { code: string } };
  return {
    statusCode: res.statusCode,
    data: json.data as TaskPatchResult,
    ...(json.error === undefined ? {} : { code: json.error.code }),
  };
}

describe(
  'GET/PATCH /networks/:id/tasks',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('GET отдаёт строки проекции: scope, count только по флагу, keyset-страницы', async () => {
      const ctx = await buildRestContext();
      try {
        const thought = await apiCreateThought(ctx, { title: 'Задачи' });
        const thoughtId = thought.data['id'] as string;
        await createComment(
          ctx,
          thoughtId,
          '- [ ] A [[2026-11-20]]\n- [ ] B [[2026-11-21]]\n- [x] C [[2026-11-22]]',
        );

        const open = await getTasks(ctx, { scope: 'open' });
        assert.equal(open.statusCode, 200);
        assert.deepEqual(
          open.data.items.map((task) => task.text),
          ['A [[2026-11-20]]', 'B [[2026-11-21]]'],
        );
        assert.equal(open.data.total, undefined, 'COUNT без флага не отдаётся');
        assert.equal(open.data.max_revision, 1);

        const counted = await getTasks(ctx, { scope: 'open', count: 'true' });
        assert.equal(counted.data.total, 2);

        const done = await getTasks(ctx, { scope: 'done' });
        assert.deepEqual(
          done.data.items.map((task) => task.text),
          ['C [[2026-11-22]]'],
        );

        const first = await getTasks(ctx, { scope: 'open', limit: '1' });
        assert.equal(first.data.items.length, 1);
        assert.ok(first.data.cursor !== null);
        const second = await getTasks(ctx, {
          scope: 'open',
          limit: '1',
          cursor: first.data.cursor!,
        });
        assert.deepEqual(
          second.data.items.map((task) => task.text),
          ['B [[2026-11-21]]'],
          'keyset продолжает страницу без дублей',
        );
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('PATCH toggle/move/cancel: новая ревизия, 409 на устаревшей, undo данными прежней ревизии', async () => {
      const ctx = await buildRestContext();
      try {
        const thought = await apiCreateThought(ctx, { title: 'Правка' });
        const thoughtId = thought.data['id'] as string;
        const comment = await createComment(ctx, thoughtId, '- [ ] Задача [[2026-11-20]]');

        const toggled = await patchTasks(ctx, {
          ops: [
            {
              comment_id: comment.id,
              line_no: 0,
              action: 'toggle',
              expected_revision: comment.version,
            },
          ],
        });
        assert.equal(toggled.statusCode, 200);
        assert.deepEqual(toggled.data.results, [{ comment_id: comment.id, line_no: 0, ok: true }]);
        assert.equal(toggled.data.revisions[0]!.version, comment.version + 1);
        assert.equal(
          (await getTasks(ctx, { scope: 'done' })).data.items.length,
          1,
          'состояние читается из проекции',
        );

        const conflict = await patchTasks(ctx, {
          ops: [
            {
              comment_id: comment.id,
              line_no: 0,
              action: 'toggle',
              expected_revision: comment.version,
            },
          ],
        });
        assert.equal(conflict.statusCode, 409);
        assert.equal(conflict.code, 'VERSION_CONFLICT');

        // undo — данными прежней ревизии: клиент шлёт тело и ожидаемую версию.
        const undo = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/comments/${comment.id}`,
          headers: { ...authHeaders(ctx), 'if-match': String(comment.version + 1) },
          payload: { body_md: '- [ ] Задача [[2026-11-20]]' },
        });
        assert.equal(undo.statusCode, 200);
        assert.equal((undo.json().data as { version: number }).version, comment.version + 2);
        assert.equal((await getTasks(ctx, { scope: 'open' })).data.items.length, 1);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('массовые commands: move-all по фильтру и cancel-all с подзадачами', async () => {
      const ctx = await buildRestContext();
      try {
        const thought = await apiCreateThought(ctx, { title: 'Массовые' });
        const thoughtId = thought.data['id'] as string;
        const comment = await createComment(
          ctx,
          thoughtId,
          '- [ ] A [[2026-11-20]]\n  - [ ] подпункт\n    - [ ] B [[2026-11-21]]',
        );

        const moved = await patchTasks(ctx, {
          action: 'move-all',
          filter: { scope: 'open' },
          days: 1,
        });
        assert.equal(moved.statusCode, 200);
        const due = (await getTasks(ctx, { scope: 'open' })).data.items.map((task) => task.due);
        assert.deepEqual(due, ['2026-11-21', '2026-11-22'], 'все даты строк сдвинуты');

        const cancelled = await patchTasks(ctx, {
          action: 'cancel-all',
          filter: { comment_id: comment.id },
        });
        assert.equal(cancelled.statusCode, 200);
        assert.equal((await getTasks(ctx, { scope: 'open' })).data.items.length, 0);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('постоянный комментарий: задача видна и toggle работает по expected_revision', async () => {
      const ctx = await buildRestContext();
      try {
        const thought = await apiCreateThought(ctx, { title: 'Постоянный' });
        const thoughtId = thought.data['id'] as string;
        const comment = await createComment(
          ctx,
          thoughtId,
          '- [ ] Из постоянного [[2026-11-20]]',
          'permanent',
        );

        const listed = await getTasks(ctx, { comment_id: comment.id });
        assert.equal(listed.data.items.length, 1);
        assert.equal(listed.data.items[0]!.done, false);

        const toggled = await patchTasks(ctx, {
          ops: [{ comment_id: comment.id, line_no: 0, action: 'toggle', expected_revision: 1 }],
        });
        assert.equal(toggled.statusCode, 200);
        assert.equal((await getTasks(ctx, { scope: 'done' })).data.items.length, 1);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('права: без токена — 401, не участник сети — 403; GET не пишет', async () => {
      const ctx = await buildRestContext();
      try {
        const thought = await apiCreateThought(ctx, { title: 'Права' });
        await createComment(ctx, thought.data['id'] as string, '- [ ] Задача [[2026-11-20]]');

        const anonymous = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/tasks`,
        });
        assert.equal(anonymous.statusCode, 401);

        const stranger = createPlainUser(ctx);
        const forbidden = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/tasks`,
          headers: { authorization: `Bearer ${stranger.key}` },
        });
        assert.equal(forbidden.statusCode, 403);

        const patchForbidden = await patchTasks(
          ctx,
          {
            ops: [{ comment_id: 'whatever', line_no: 0, action: 'toggle', expected_revision: 1 }],
          },
          { authorization: `Bearer ${stranger.key}` },
        );
        assert.equal(patchForbidden.statusCode, 403);

        // GET обязан быть чистым чтением: маркер проекции не двигается.
        const before = (
          ctx.ndb.prepare('SELECT max_revision FROM task_projection_state WHERE id = 1').get() as {
            max_revision: number;
          }
        ).max_revision;
        await getTasks(ctx, { scope: 'open', count: 'true' });
        const after = (
          ctx.ndb.prepare('SELECT max_revision FROM task_projection_state WHERE id = 1').get() as {
            max_revision: number;
          }
        ).max_revision;
        assert.equal(after, before, 'GET /tasks не пишет в БД');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('невалидный scope и отсутствие ops/action — 422', async () => {
      const ctx = await buildRestContext();
      try {
        const badScope = await getTasks(ctx, { scope: 'later' });
        assert.equal(badScope.statusCode, 422);

        const empty = await patchTasks(ctx, {});
        assert.equal(empty.statusCode, 422, 'нужен ровно один из ops/action');
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
