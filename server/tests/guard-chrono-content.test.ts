/**
 * Сторож содержания хроно-записей (0.12.1, требование 26f0aa52, модель
 * немедленного создания 2026-10-09).
 *
 * Правило: хронологическая запись валидна уже при наличии хотя бы одной
 * привязки — пустые `title` и `body_md` допустимы. Кнопка «Добавить» создаёт
 * такую запись сразу, наполнение — позже. Согласованность create/update:
 * существующую запись разрешено опустошить до того же состояния. Постоянный
 * комментарий по-прежнему требует непустой `body_md`, а хроно-запись без
 * целей — отказ.
 *
 * Проверяется на трёх слоях: домен, REST-маршрут и MCP (`etn.thoughts.write`
 * chronicle[] и `etn.comments.update`).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createComment, createCommentWithTargets, updateComment } from '../src/domain/comment-service.js';
import { apiCreateThought, authHeaders, buildRestContext, closeRestContext } from './rest-helpers.js';
import {
  buildMcpContext,
  callWrite,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  toolJson,
} from './mcp-helpers.js';

const USER = 'guard-chrono-content-user';

/** True when the `better-sqlite3` native binding loads. */
function nativeBindingAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Seed the protected HOME thought (`is_root = 1`) of an in-memory network. */
function seedHome(ndb: NetworkDb): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, 'HOME', 'home', 1, 1, 1, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id);
  return id;
}

/** `VALIDATION_ERROR` с ожидаемым `details.field`. */
function validationError(field: string): (err: unknown) => boolean {
  return (err: unknown) =>
    err instanceof EtnError &&
    err.code === 'VALIDATION_ERROR' &&
    (err.details as { field?: string }).field === field;
}

describe(
  'guard: содержание хроно-записи (0.12.1, требование 26f0aa52)',
  nativeBindingAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('домен: пустая запись при единственной привязке HOME создаётся; без целей — отказ', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const home = seedHome(ndb);

        // Пустая запись с единственной привязкой HOME (модель немедленного
        // создания): title=null, body_md='' — валидна.
        const empty = createCommentWithTargets(
          ndb,
          [{ owner_type: 'thought', owner_id: home }],
          { kind: 'chronological' },
          USER,
        );
        assert.equal(empty.body_md, '', 'пустой body_md сохранён как пустая строка');
        assert.equal(empty.title, null);
        assert.equal(empty.kind, 'chronological');
        assert.equal(empty.targets.length, 1);

        // Запись с текстом без заголовка по-прежнему валидна.
        const withBody = createComment(
          ndb,
          'thought',
          home,
          { kind: 'chronological', body_md: 'текст' },
          USER,
        );
        assert.equal(withBody.title, null);
        assert.equal(withBody.body_md, 'текст');

        // Ни одной цели — отказ (только цели делают запись не бесхозной).
        assert.throws(
          () => createCommentWithTargets(ndb, [], { kind: 'chronological' }, USER),
          validationError('targets'),
          'хроно-запись без целей обязана отвергаться',
        );
      } finally {
        ndb.close();
      }
    });

    it('домен: постоянный комментарий без текста отвергается', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const home = seedHome(ndb);
        assert.throws(
          () => createComment(ndb, 'thought', home, { kind: 'permanent' }, USER),
          validationError('body_md'),
        );
        assert.throws(
          () => createComment(ndb, 'thought', home, { kind: 'permanent', body_md: '   ' }, USER),
          validationError('body_md'),
          'пробельный текст не считается содержанием',
        );
      } finally {
        ndb.close();
      }
    });

    it('домен: опустошение существующей хроно-записи разрешено', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const home = seedHome(ndb);

        const record = createComment(
          ndb,
          'thought',
          home,
          { kind: 'chronological', title: 'Заголовок', body_md: 'Текст' },
          USER,
        );
        // Снятие и заголовка, и тела при единственной цели HOME — теперь ОК.
        const emptied = updateComment(
          ndb,
          record.id,
          { title: null, body_md: '' },
          undefined,
          USER,
        );
        assert.equal(emptied.title, null);
        assert.equal(emptied.body_md, '');
        assert.equal(emptied.version, record.version + 1);
      } finally {
        ndb.close();
      }
    });

    it('REST: пустая хроно-запись с HOME — 201; опустошение PATCH — 200; постоянная без тела и хроно без целей — 422', async () => {
      const ctx = await buildRestContext();
      try {
        // Пустая хроно-запись при единственной привязке HOME — 201.
        const empty = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'chronological' },
        });
        assert.equal(empty.statusCode, 201);
        const emptyData = empty.json().data as { id: string; title: null; body_md: string };
        assert.equal(emptyData.body_md, '');
        assert.equal(emptyData.title, null);

        // Опустошение существующей записи через PATCH — 200.
        const created = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'chronological', title: 'Заголовок', body_md: 'Текст' },
        });
        assert.equal(created.statusCode, 201);
        const recordId = (created.json().data as { id: string }).id;
        const emptied = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/comments/${recordId}`,
          headers: authHeaders(ctx),
          payload: { title: null, body_md: '' },
        });
        assert.equal(emptied.statusCode, 200);
        const emptiedData = emptied.json().data as { title: null; body_md: string };
        assert.equal(emptiedData.title, null);
        assert.equal(emptiedData.body_md, '');

        // Постоянный комментарий без текста — 422.
        const perm = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'permanent' },
        });
        assert.equal(perm.statusCode, 422);
        assert.equal(perm.json().error.code, 'VALIDATION_ERROR');

        // Хроно-запись без целей (пустой targets) — 422.
        const noTargets = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'chronological', targets: [] },
        });
        assert.equal(noTargets.statusCode, 422);
        assert.equal(noTargets.json().error.code, 'VALIDATION_ERROR');

        // Хроно-запись БЕЗ ключа targets (не пустой массив, а отсутствие) —
        // тот же 422 с `details.field=targets`, а не 500 INTERNAL от итерации
        // undefined в домене (ошибка 13a2706f). `targets` объявлен только в
        // REST-карте, поэтому без явного `req` поле молча пропускалось.
        const absentTargets = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'chronological' },
        });
        assert.equal(absentTargets.statusCode, 422, absentTargets.body);
        const absentError = absentTargets.json().error as {
          code: string;
          details?: { field?: string };
        };
        assert.equal(absentError.code, 'VALIDATION_ERROR');
        assert.equal(absentError.details?.field, 'targets');

        // Привязка вне HOME также валидна без содержания.
        const other = await apiCreateThought(ctx, { title: `Чипс ${randomUUID()}` });
        const byChip = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/comments`,
          headers: authHeaders(ctx),
          payload: {
            kind: 'chronological',
            targets: [
              { owner_type: 'thought', owner_id: ctx.homeId },
              { owner_type: 'thought', owner_id: other.data.id },
            ],
          },
        });
        assert.equal(byChip.statusCode, 201);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('MCP: chronicle с пустыми title/body создаётся; update опустошает запись', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const thought = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: `MCP-контент ${randomUUID()}`,
          });
          // chronicle без title/body — валидна (владелец-мысль = привязка).
          const write = await callWrite(handle.client, ctx.networkId, [
            {
              thought_id: thought.id,
              chronicle: [{ valid_from: '2026-01-01' }],
            },
          ]);
          const commentId = write.items[0]!.chronicle![0]!.id;

          // Текст без заголовка сохраняется.
          await handle.client.callTool({
            name: 'etn.comments.update',
            arguments: {
              network_id: ctx.networkId,
              comment_id: commentId,
              changes: { body_md: 'текст' },
            },
          });
          const afterText = await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, comment_id: commentId },
          });
          const withText = toolJson<{ body_md: string; title: string | null }>(afterText);
          assert.equal(withText.body_md, 'текст');
          assert.equal(withText.title, null);

          // Опустошение записи допустимо.
          await handle.client.callTool({
            name: 'etn.comments.update',
            arguments: {
              network_id: ctx.networkId,
              comment_id: commentId,
              changes: { body_md: '' },
            },
          });
          const after = await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, comment_id: commentId },
          });
          const reread = toolJson<{ body_md: string }>(after);
          assert.equal(reread.body_md, '');
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);
