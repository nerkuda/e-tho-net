/**
 * Сторож содержания хроно-записей (0.10.1, ошибка 00115e7b; требование
 * 26f0aa52 «Ленивое создание записи»).
 *
 * Правило: хронологическая запись создаётся при хотя бы одном содержательном
 * элементе — непустом тексте, непустом заголовке ИЛИ привязке вне HOME
 * (владелец HOME — первичная привязка, не чипс). Пустой `body_md` допустим.
 * Постоянный комментарий по-прежнему требует непустой `body_md`, а правка не
 * может опустошить запись до состояния «нет ни текста, ни заголовка, ни
 * привязки».
 *
 * Проверяется на трёх слоях: домен, REST-маршрут (ослабленный контракт) и
 * MCP (`etn.thoughts.write` chronicle[] и `etn.comments.update`).
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

/** Seed an ordinary (non-HOME) thought so the polymorphic owner exists. */
function seedThought(ndb: NetworkDb, title = 'Seed'): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase());
  return id;
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
  'guard: содержание хроно-записи (0.10.1, ошибка 00115e7b)',
  nativeBindingAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('домен: запись создаётся по заголовку и по чипсу без текста; пустая при HOME — отказ', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const home = seedHome(ndb);
        const other = seedThought(ndb, 'Другая мысль');

        // Заголовок без текста (владелец HOME).
        const byTitle = createCommentWithTargets(
          ndb,
          [{ owner_type: 'thought', owner_id: home }],
          { kind: 'chronological', title: 'Только заголовок' },
          USER,
        );
        assert.equal(byTitle.body_md, '', 'пустой body_md сохранён как пустая строка');
        assert.equal(byTitle.title, 'Только заголовок');
        assert.equal(byTitle.kind, 'chronological');

        // Привязка вне HOME без текста и заголовка.
        const byChip = createCommentWithTargets(
          ndb,
          [
            { owner_type: 'thought', owner_id: home },
            { owner_type: 'thought', owner_id: other },
          ],
          { kind: 'chronological' },
          USER,
        );
        assert.equal(byChip.body_md, '');
        assert.equal(byChip.targets.length, 2);

        // Ни текста, ни заголовка, ни привязки вне HOME — отказ.
        assert.throws(
          () =>
            createCommentWithTargets(
              ndb,
              [{ owner_type: 'thought', owner_id: home }],
              { kind: 'chronological' },
              USER,
            ),
          validationError('content'),
          'пустая запись при владельце HOME обязана отвергаться',
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

    it('домен: правка не опустошает запись, привязка или текст спасают', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const home = seedHome(ndb);
        const other = seedThought(ndb, 'Привязка');

        const titleOnly = createCommentWithTargets(
          ndb,
          [{ owner_type: 'thought', owner_id: home }],
          { kind: 'chronological', title: 'Заголовок' },
          USER,
        );
        // Снятие заголовка при пустом теле и единственной цели HOME — отказ.
        assert.throws(
          () => updateComment(ndb, titleOnly.id, { title: null }, undefined, USER),
          validationError('content'),
        );
        // Правка только тела (заголовок остаётся) — допустима.
        const keptTitle = updateComment(ndb, titleOnly.id, { body_md: '' }, undefined, USER);
        assert.equal(keptTitle.title, 'Заголовок');

        // Запись держится на привязке вне HOME — опустошение допустимо.
        const chipOnly = createCommentWithTargets(
          ndb,
          [
            { owner_type: 'thought', owner_id: home },
            { owner_type: 'thought', owner_id: other },
          ],
          { kind: 'chronological' },
          USER,
        );
        const patched = updateComment(
          ndb,
          chipOnly.id,
          { valid_to: '2024-01-01' },
          undefined,
          USER,
        );
        assert.equal(patched.body_md, '');
        assert.equal(patched.valid_to, '2024-01-01T23:59:59.999Z');
      } finally {
        ndb.close();
      }
    });

    it('REST: заголовок/чипс без текста создаются, пустая и постоянная без текста — 422', async () => {
      const ctx = await buildRestContext();
      try {
        const created = await apiCreateThought(ctx, { title: `Чипс ${randomUUID()}` });
        const otherId = created.data.id as string;

        // Заголовок без текста на HOME.
        const byTitle = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'chronological', title: 'Только заголовок' },
        });
        assert.equal(byTitle.statusCode, 201);
        assert.equal((byTitle.json().data as { body_md: string }).body_md, '');

        // Чипс без текста и заголовка — через мультицелевой маршрут.
        const byChip = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/comments`,
          headers: authHeaders(ctx),
          payload: {
            kind: 'chronological',
            targets: [
              { owner_type: 'thought', owner_id: ctx.homeId },
              { owner_type: 'thought', owner_id: otherId },
            ],
          },
        });
        assert.equal(byChip.statusCode, 201);

        // Полностью пустая запись при HOME — 422.
        const empty = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'chronological' },
        });
        assert.equal(empty.statusCode, 422);
        assert.equal(empty.json().error.code, 'VALIDATION_ERROR');

        // Постоянный комментарий без текста — 422.
        const perm = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/comments`,
          headers: authHeaders(ctx),
          payload: { kind: 'permanent' },
        });
        assert.equal(perm.statusCode, 422);
        assert.equal(perm.json().error.code, 'VALIDATION_ERROR');

        // Опустошение заголовочной записи через PATCH — 422.
        const titleId = (byTitle.json().data as { id: string; version: number }).id;
        const emptied = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/comments/${titleId}`,
          headers: authHeaders(ctx),
          payload: { title: null, body_md: '' },
        });
        assert.equal(emptied.statusCode, 422);
        assert.equal(emptied.json().error.code, 'VALIDATION_ERROR');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('MCP: chronicle по заголовку и update пустого body_md при заголовке', async () => {
      const ctx = await buildMcpContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);
        try {
          const thought = await createThoughtViaWrite(handle.client, ctx.networkId, {
            title: `MCP-контент ${randomUUID()}`,
          });
          const write = await callWrite(handle.client, ctx.networkId, [
            {
              thought_id: thought.id,
              chronicle: [{ title: 'Только заголовок', valid_from: '2026-01-01' }],
            },
          ]);
          const commentId = write.items[0]!.chronicle![0]!.id;
          const got = await handle.client.callTool({
            name: 'etn.comments.get',
            arguments: { network_id: ctx.networkId, comment_id: commentId },
          });
          const mcp = toolJson<{ body_md: string; title: string | null }>(got);
          assert.equal(mcp.body_md, '', 'chronicle без body_md создаётся по заголовку');
          assert.equal(mcp.title, 'Только заголовок');

          // `etn.comments.update` с пустым body_md допустим, пока есть заголовок.
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
          const reread = toolJson<{ body_md: string; title: string | null }>(after);
          assert.equal(reread.body_md, '');
          assert.equal(reread.title, 'Только заголовок');
        } finally {
          await handle.close();
        }
      } finally {
        await closeMcpContext(ctx);
      }
    });
  },
);
