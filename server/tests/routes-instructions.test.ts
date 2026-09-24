/**
 * REST-аналог витрины инструкций — `GET /networks/:id/instructions`
 * (ADR 8c93f03a, веха 7 версии 0.8.2): паритет с `etn.instructions` через
 * общий доменный `getNetworkInstructions`.
 *
 * Бутстрап — `rest-helpers.ts` (реальный Fastify-сервер + реальная сеть);
 * роль `instructions` выставляется через `PATCH /networks/:id` — заодно
 * покрывается доменный `updateNetwork` на type_roles. Мысли и типы
 * вставляются напрямую в `data.db` (как в `mcp-instructions.test.ts`),
 * постоянные комментарии — доменной `createCommentWithTargets`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { INSTRUCTIONS_PREVIEW_CHARS } from '@etn/shared';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';
import { createCommentWithTargets } from '../src/domain/comment-service.js';

/** Insert a thought-type directly. */
function makeThoughtType(ctx: RestTestContext, name: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ctx.ndb
    .prepare(
      `INSERT INTO thought_types (id, name, name_key, is_root, version,
                                  created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?)`,
    )
    .run(id, name, name.toLowerCase(), now, now, ctx.adminId, ctx.adminId);
  return id;
}

/** Insert a thought directly. */
function makeThought(
  ctx: RestTestContext,
  title: string,
  typeId: string | null,
  opts: { active?: number; trashed?: number } = {},
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ctx.ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, icon, icon_kind,
                             icon_attachment_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, updated_at,
                             created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, NULL, 'emoji', NULL, ?, 0, 0,
               ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.ndb.layerId,
      title,
      title.toLowerCase(),
      typeId,
      opts.active ?? 1,
      opts.trashed ?? 0,
      now,
      now,
      ctx.adminId,
      ctx.adminId,
      Date.now(),
      Date.now(),
    );
  return id;
}

/** Постоянный комментарий мысли через домен. */
function setPermanent(ctx: RestTestContext, thoughtId: string, body: string): void {
  createCommentWithTargets(
    ctx.ndb,
    [{ owner_type: 'thought', owner_id: thoughtId }],
    { kind: 'permanent', body_md: body },
    ctx.adminId,
  );
}

/** Нетипизированная структурная связь «родитель → потомок» (как в guard-MCP). */
function linkParent(ctx: RestTestContext, parentId: string, childId: string): void {
  const now = new Date().toISOString();
  ctx.ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion,
                          color, style, width, version, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, NULL, 1, 0, NULL, NULL, NULL, 1, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), parentId, childId, now, now, ctx.adminId, ctx.adminId);
}

describe('GET /networks/:id/instructions (REST-аналог etn.instructions)', { skip: !nativeAvailable() }, () => {
  it('has_instructions=false без роли instructions', async () => {
    const ctx = await buildRestContext();
    try {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/instructions`,
        headers: authHeaders(ctx),
      });
      assert.equal(res.statusCode, 200);
      const body = res.json().data;
      assert.equal(body.network_id, ctx.networkId);
      assert.equal(body.has_instructions, false);
      assert.deepEqual(body.instructions, []);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('список, полный текст по instruction_id и фильтр keywords — как MCP', async () => {
    const ctx = await buildRestContext();
    try {
      const instructionsTypeId = makeThoughtType(ctx, 'Инструкция');
      const otherTypeId = makeThoughtType(ctx, 'Заметка');

      // Роль выставляем через PATCH /networks/:id — доменный updateNetwork.
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/networks/${ctx.networkId}`,
        headers: authHeaders(ctx),
        payload: { type_roles: { instructions: instructionsTypeId } },
      });
      assert.equal(patch.statusCode, 200);
      assert.equal(patch.json().data.type_roles.instructions, instructionsTypeId);

      const setup = makeThought(ctx, 'Setup', instructionsTypeId);
      setPermanent(ctx, setup, 'Первая инструкция.');
      const cleanup = makeThought(ctx, 'Cleanup', instructionsTypeId);
      setPermanent(ctx, cleanup, 'Вторая инструкция.');
      makeThought(ctx, 'Noise', otherTypeId);

      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/instructions`,
        headers: authHeaders(ctx),
      });
      assert.equal(list.statusCode, 200);
      const listBody = list.json().data;
      assert.equal(listBody.has_instructions, true);
      assert.deepEqual(
        listBody.instructions.map((i: { title: string }) => i.title).sort(),
        ['Cleanup', 'Setup'],
      );
      assert.equal(listBody.meta.total, 2);

      const byId = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/instructions?instruction_id=${setup}`,
        headers: authHeaders(ctx),
      });
      assert.equal(byId.statusCode, 200);
      assert.equal(byId.json().data.instruction_id, setup);
      assert.equal(byId.json().data.body_md, 'Первая инструкция.');

      const byKeywords = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/instructions?keywords=up`,
        headers: authHeaders(ctx),
      });
      assert.equal(byKeywords.statusCode, 200);
      const kwBody = byKeywords.json().data;
      assert.deepEqual(
        kwBody.instructions.map((i: { title: string }) => i.title).sort(),
        ['Cleanup', 'Setup'],
      );
      assert.equal(kwBody.meta.total, 2);
      assert.equal(kwBody.meta.matched, 2);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('валидация: XOR режимов, лимиты при instruction_id, потолок limit', async () => {
    const ctx = await buildRestContext();
    try {
      const base = `/api/v1/networks/${ctx.networkId}/instructions`;
      const xor = await ctx.app.inject({
        method: 'GET',
        url: `${base}?instruction_id=${randomUUID()}&keywords=up`,
        headers: authHeaders(ctx),
      });
      assert.equal(xor.statusCode, 422);

      const limitWithId = await ctx.app.inject({
        method: 'GET',
        url: `${base}?instruction_id=${randomUUID()}&limit=10`,
        headers: authHeaders(ctx),
      });
      assert.equal(limitWithId.statusCode, 422);

      const tooBig = await ctx.app.inject({
        method: 'GET',
        url: `${base}?limit=201`,
        headers: authHeaders(ctx),
      });
      assert.equal(tooBig.statusCode, 422);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('NOT_FOUND по неизвестному instruction_id', async () => {
    const ctx = await buildRestContext();
    try {
      const instructionsTypeId = makeThoughtType(ctx, 'Инструкция');
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/networks/${ctx.networkId}`,
        headers: authHeaders(ctx),
        payload: { type_roles: { instructions: instructionsTypeId } },
      });
      assert.equal(patch.statusCode, 200);

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/instructions?instruction_id=${randomUUID()}`,
        headers: authHeaders(ctx),
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await closeRestContext(ctx);
    }
  });

  // Норма 825800fc для REST (задача 65cf6074): перечень без keywords — только
  // корневые инструкции (модель скиллов), превью постоянного комментария ≤ 300;
  // под-инструкция достижима поиском по keywords.
  it('перечень — только корневые, превью ≤ 300; под-инструкция — через keywords', async () => {
    const ctx = await buildRestContext();
    try {
      const instructionsTypeId = makeThoughtType(ctx, 'Инструкция');
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/networks/${ctx.networkId}`,
        headers: authHeaders(ctx),
        payload: { type_roles: { instructions: instructionsTypeId } },
      });
      assert.equal(patch.statusCode, 200);

      const root = makeThought(ctx, 'Корневая инструкция', instructionsTypeId);
      setPermanent(ctx, root, 'К'.repeat(INSTRUCTIONS_PREVIEW_CHARS + 200));
      const flatRoot = makeThought(ctx, 'Плоская инструкция', instructionsTypeId);
      setPermanent(ctx, flatRoot, 'Коротко.');
      const nested = makeThought(ctx, 'Под-инструкция', instructionsTypeId);
      setPermanent(ctx, nested, 'Вложенная.');
      linkParent(ctx, root, nested);

      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/instructions`,
        headers: authHeaders(ctx),
      });
      assert.equal(list.statusCode, 200);
      const listBody = list.json().data;
      const titles = listBody.instructions.map((i: { title: string }) => i.title).sort();
      assert.deepEqual(titles, ['Корневая инструкция', 'Плоская инструкция']);
      assert.equal(listBody.meta.total, 2);
      const rootRow = listBody.instructions.find(
        (i: { title: string }) => i.title === 'Корневая инструкция',
      );
      assert.equal(rootRow.preview.chars_returned, INSTRUCTIONS_PREVIEW_CHARS);
      assert.equal(rootRow.preview.truncated, true);
      assert.equal(rootRow.preview.body_md.length, INSTRUCTIONS_PREVIEW_CHARS);

      const byKeywords = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/instructions?keywords=инструкц`,
        headers: authHeaders(ctx),
      });
      assert.equal(byKeywords.statusCode, 200);
      // keywords ищет по всем, включая подчинённые (модель скиллов).
      assert.ok(
        byKeywords
          .json()
          .data.instructions.some((i: { id: string }) => i.id === nested),
        'под-инструкция обязана находиться поиском по keywords',
      );
    } finally {
      await closeRestContext(ctx);
    }
  });

  // Задача 649c55e2: режимы перечня scope (roots|all) и instruction_ids.
  it('scope=all, instruction_ids (порядок + missing) и взаимоисключения режимов', async () => {
    const ctx = await buildRestContext();
    try {
      const instructionsTypeId = makeThoughtType(ctx, 'Инструкция');
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/networks/${ctx.networkId}`,
        headers: authHeaders(ctx),
        payload: { type_roles: { instructions: instructionsTypeId } },
      });
      assert.equal(patch.statusCode, 200);

      const root = makeThought(ctx, 'Root', instructionsTypeId);
      setPermanent(ctx, root, 'Корневая.');
      const nested = makeThought(ctx, 'Nested', instructionsTypeId);
      setPermanent(ctx, nested, 'Подчинённая.');
      linkParent(ctx, root, nested);

      const base = `/api/v1/networks/${ctx.networkId}/instructions`;

      // По умолчанию — только корневые.
      const roots = await ctx.app.inject({ method: 'GET', url: base, headers: authHeaders(ctx) });
      assert.equal(roots.statusCode, 200);
      assert.deepEqual(
        roots.json().data.instructions.map((i: { title: string }) => i.title),
        ['Root'],
      );

      // scope=all — включая подчинённые.
      const all = await ctx.app.inject({
        method: 'GET',
        url: `${base}?scope=all`,
        headers: authHeaders(ctx),
      });
      assert.equal(all.statusCode, 200);
      assert.deepEqual(
        all.json().data.instructions.map((i: { title: string }) => i.title).sort(),
        ['Nested', 'Root'],
      );
      assert.equal(all.json().data.meta.total, 2);

      // instruction_ids — карточки в порядке запроса, ненайденные в missing.
      const ghost = randomUUID();
      const ids = await ctx.app.inject({
        method: 'GET',
        url: `${base}?instruction_ids=${nested}&instruction_ids=${root}&instruction_ids=${ghost}`,
        headers: authHeaders(ctx),
      });
      assert.equal(ids.statusCode, 200);
      const idsBody = ids.json().data;
      assert.deepEqual(
        idsBody.instructions.map((i: { id: string }) => i.id),
        [nested, root],
      );
      assert.deepEqual(idsBody.missing, [ghost]);
      assert.equal(idsBody.meta.total, 2);

      // Взаимоисключения режимов — 422.
      for (const suffix of [
        `?scope=all&keywords=up`,
        `?scope=all&instruction_id=${root}`,
        `?instruction_ids=${nested}&keywords=up`,
        `?instruction_ids=${nested}&instruction_id=${root}`,
        `?instruction_ids=${nested}&scope=all`,
        `?instruction_ids=${nested}&limit=10`,
      ]) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `${base}${suffix}`,
          headers: authHeaders(ctx),
        });
        assert.equal(res.statusCode, 422, `ожидался 422 для ${suffix}`);
      }
    } finally {
      await closeRestContext(ctx);
    }
  });
});
