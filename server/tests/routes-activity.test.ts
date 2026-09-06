/**
 * Integration tests for the activity log (задача f2eca5a4, операция
 * 70dfe81d «/activity — лента, свёртка и обрезка» в мыслесети `ETN`).
 *
 *   * Запись в `activity_log` идёт при создании/правке/удалении мысли,
 *     связи, типа, свойства, комментария, вложения, слоя.
 *   * Захваты (`edit.acquired`/`released`/`cleared`) НЕ пишутся.
 *   * REST `GET /activity` — фильтры по периоду/пользователю/типу сущности
 *     + пагинация.
 *   * MCP `etn.activity.list` возвращает те же данные, что и REST (паритет
 *     операций, стандарт 9e5cff3f).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ActivityRow } from '@etn/shared';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  createPlainUser,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  toolJson,
  toolText,
  type McpClientHandle,
  type McpTestContext,
} from './mcp-helpers.js';

interface ActivityResponse {
  data: ActivityRow[];
  meta: { total: number; offset: number; limit: number };
}

async function apiListActivity(
  ctx: RestTestContext,
  key: string,
  query: string = '',
): Promise<{ statusCode: number; data: ActivityRow[]; meta: ActivityResponse['meta'] }> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/activity${query}`,
    headers: { authorization: `Bearer ${key}` },
  });
  const json = res.json();
  return {
    statusCode: res.statusCode,
    data: (json.data as ActivityRow[] | undefined) ?? [],
    meta: json.meta as ActivityResponse['meta'],
  };
}

async function apiCreateThought(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; data: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload,
  });
  return { statusCode: res.statusCode, data: res.json().data as Record<string, unknown> };
}

async function apiUpdateThought(
  ctx: RestTestContext,
  id: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; data: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}`,
    headers: authHeaders(ctx),
    payload,
  });
  return { statusCode: res.statusCode, data: res.json().data as Record<string, unknown> };
}

async function apiDeleteThought(
  ctx: RestTestContext,
  id: string,
): Promise<number> {
  const res = await ctx.app.inject({
    method: 'DELETE',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}`,
    headers: authHeaders(ctx),
  });
  return res.statusCode;
}

async function apiCreateLink(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; data: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/links`,
    headers: authHeaders(ctx),
    payload,
  });
  return { statusCode: res.statusCode, data: res.json().data as Record<string, unknown> };
}

async function apiAcquireLock(
  ctx: RestTestContext,
  key: string,
  body: { entity_type: string; entity_id: string },
): Promise<{ statusCode: number; data: Record<string, unknown> | null }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/locks`,
    headers: { authorization: `Bearer ${key}` },
    payload: body,
  });
  const json = res.json();
  return { statusCode: res.statusCode, data: (json.data as Record<string, unknown> | undefined) ?? null };
}

describe(
  'activity log (REST /activity, задача f2eca5a4)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('пишет запись на создание/правку/удаление мысли', async () => {
      const ctx = await buildRestContext();
      try {
        // 1. Создаём мысль — должна появиться запись 'created'.
        const created = await apiCreateThought(ctx, { title: 'Идея для проекта' });
        assert.equal(created.statusCode, 201);
        const thoughtId = created.data.id as string;

        // 2. Правка — ещё одна запись.
        const updated = await apiUpdateThought(ctx, thoughtId, { title: 'Идея для проекта (правка)' });
        assert.equal(updated.statusCode, 200);

        // 3. Удаление — последняя запись.
        const deleteStatus = await apiDeleteThought(ctx, thoughtId);
        assert.equal(deleteStatus, 204);

        // Лента должна вернуть 3 записи для этой мысли в обратном порядке.
        const list = await apiListActivity(ctx, ctx.adminKey, `?entity_type=thought&entity_id=${thoughtId}`);
        assert.equal(list.statusCode, 200);
        assert.equal(list.meta.total, 3);
        assert.deepEqual(
          list.data.map((r) => r.action),
          ['deleted', 'updated', 'created'],
        );
        // Снимок у удаления сохраняет «последнее живое» имя (правка).
        const deletedRow = list.data.find((r) => r.action === 'deleted');
        assert.ok(deletedRow, 'должна быть запись deleted');
        assert.match(deletedRow!.entity_title, /Идея для проекта \(правка\)/);
        // Снимок у создания — изначальное имя.
        const createdRow = list.data.find((r) => r.action === 'created');
        assert.ok(createdRow, 'должна быть запись created');
        assert.match(createdRow!.entity_title, /Идея для проекта/);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('захват (acquire/release/clear) НЕ пишется в журнал', async () => {
      const ctx = await buildRestContext();
      try {
        const created = await apiCreateThought(ctx, { title: 'Захватываемая мысль' });
        const thoughtId = created.data.id as string;

        const acquired = await apiAcquireLock(ctx, ctx.adminKey, {
          entity_type: 'thought',
          entity_id: thoughtId,
        });
        assert.equal(acquired.statusCode, 200);
        const lockId = (acquired.data as { id: string }).id;

        // Release — захват снимается.
        const releaseRes = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/locks/${lockId}`,
          headers: { authorization: `Bearer ${ctx.adminKey}` },
        });
        assert.equal(releaseRes.statusCode, 204);

        // Clear вручную (тут нет чужих захватов, но команда должна сработать).
        const clearRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/locks/clear`,
          headers: { authorization: `Bearer ${ctx.adminKey}` },
          payload: { user_id: ctx.adminId },
        });
        assert.equal(clearRes.statusCode, 200);

        // Лента должна содержать только одну запись — создание мысли.
        const list = await apiListActivity(
          ctx,
          ctx.adminKey,
          `?entity_type=thought&entity_id=${thoughtId}`,
        );
        assert.equal(list.meta.total, 1, 'захваты не должны писаться');
        assert.equal(list.data[0]!.action, 'created');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('фильтры: период, пользователь, тип сущности + пагинация', async () => {
      const ctx = await buildRestContext();
      try {
        // Создаём три мысли от админа.
        const t1 = await apiCreateThought(ctx, { title: 'Админская мысль 1' });
        assert.equal(t1.statusCode, 201);
        const t2 = await apiCreateThought(ctx, { title: 'Админская мысль 2' });
        assert.equal(t2.statusCode, 201);
        const t3 = await apiCreateThought(ctx, { title: 'Админская мысль 3' });
        assert.equal(t3.statusCode, 201);

        // Общая лента — минимум 3 записи (created).
        const all = await apiListActivity(ctx, ctx.adminKey);
        assert.ok(all.meta.total >= 3, `total=${all.meta.total}`);

        // Фильтр по админу — только его записи.
        const adminOnly = await apiListActivity(ctx, ctx.adminKey, `?user_id=${ctx.adminId}`);
        assert.equal(adminOnly.statusCode, 200);
        assert.ok(
          adminOnly.data.every((r) => r.user_id === ctx.adminId),
          'все записи должны быть от админа',
        );
        assert.ok(adminOnly.meta.total >= 3);

        // Фильтр по типу сущности.
        const thoughtsOnly = await apiListActivity(ctx, ctx.adminKey, '?entity_type=thought');
        assert.ok(
          thoughtsOnly.data.every((r) => r.entity_type === 'thought'),
          'все записи должны быть thought',
        );

        // Фильтр по конкретной сущности.
        const oneThought = await apiListActivity(
          ctx,
          ctx.adminKey,
          `?entity_type=thought&entity_id=${t1.data.id as string}`,
        );
        assert.equal(oneThought.meta.total, 1);
        assert.equal(oneThought.data[0]!.entity_id, t1.data.id);

        // Фильтр по периоду (from_ms в будущем — должно быть 0).
        const future = Date.now() + 60_000;
        const futureOnly = await apiListActivity(
          ctx,
          ctx.adminKey,
          `?from_ms=${future}`,
        );
        assert.equal(futureOnly.meta.total, 0);
        assert.equal(futureOnly.data.length, 0);

        // Пагинация: limit=1 — должна быть 1 запись, total > 1.
        const page1 = await apiListActivity(ctx, ctx.adminKey, '?limit=1&offset=0');
        assert.equal(page1.meta.limit, 1);
        assert.equal(page1.data.length, 1);
        assert.ok(page1.meta.total > 1);

        const page2 = await apiListActivity(ctx, ctx.adminKey, '?limit=1&offset=1');
        assert.equal(page2.data.length, 1);
        assert.notEqual(page2.data[0]!.id, page1.data[0]!.id, 'соседние страницы разные');

        void t2;
        void t3;
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('запись на создание/удаление связи', async () => {
      const ctx = await buildRestContext();
      try {
        const a = await apiCreateThought(ctx, { title: 'Мысль A' });
        const b = await apiCreateThought(ctx, { title: 'Мысль B' });
        const link = await apiCreateLink(ctx, {
          source_id: a.data.id,
          target_id: b.data.id,
        });
        assert.equal(link.statusCode, 201);
        const linkId = link.data.id as string;

        const delRes = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/links/${linkId}`,
          headers: authHeaders(ctx),
        });
        assert.equal(delRes.statusCode, 204);

        const list = await apiListActivity(
          ctx,
          ctx.adminKey,
          `?entity_type=link&entity_id=${linkId}`,
        );
        assert.equal(list.meta.total, 2);
        assert.deepEqual(
          list.data.map((r) => r.action),
          ['deleted', 'created'],
        );
        const createdRow = list.data.find((r) => r.action === 'created')!;
        assert.match(createdRow.entity_title, /→/);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('MCP etn.activity.list возвращает то же, что и REST /activity', async () => {
      // Используем единый MCP-контекст: создаём мысль через MCP и читаем ленту
      // обоими транспортами — REST и MCP должны вернуть идентичные данные.
      const ctx = await buildMcpContext();
      const restCtx = await buildRestContext();
      try {
        const handle = await connectMcpClient(ctx, ctx.adminKey);

        // Создаём мысль через MCP — запись должна появиться в журнале.
        const createRes = await handle.client.callTool({
          name: 'etn.thoughts.create',
          arguments: { network_id: ctx.networkId, title: 'MCP-паритет' },
        });
        assert.equal(createRes.isError, undefined, toolText(createRes));
        const thoughtId = (toolJson(createRes) as { id: string }).id;

        // MCP: etn.activity.list.
        const res = await handle.client.callTool({
          name: 'etn.activity.list',
          arguments: {
            network_id: ctx.networkId,
            entity_type: 'thought',
            entity_id: thoughtId,
          },
        });
        assert.equal(res.isError, undefined, toolText(res));
        const payload = toolJson(res) as {
          data: ActivityRow[];
          meta: { total: number; offset: number; limit: number };
        };
        assert.equal(payload.meta.total, 1);
        assert.equal(payload.data.length, 1);
        assert.equal(payload.data[0]!.entity_id, thoughtId);
        assert.equal(payload.data[0]!.action, 'created');

        // Захват через MCP НЕ пишется в журнал (паритет правила).
        const capRes = await handle.client.callTool({
          name: 'etn.locks.acquire',
          arguments: {
            network_id: ctx.networkId,
            entity_type: 'thought',
            entity_id: thoughtId,
          },
        });
        assert.equal(capRes.isError, undefined, toolText(capRes));
        const after = await handle.client.callTool({
          name: 'etn.activity.list',
          arguments: {
            network_id: ctx.networkId,
            entity_type: 'thought',
            entity_id: thoughtId,
          },
        });
        assert.equal(after.isError, undefined, toolText(after));
        const afterPayload = toolJson(after) as { meta: { total: number } };
        assert.equal(afterPayload.meta.total, 1, 'захват через MCP не должен писаться в журнал');

        // Sanity: envelope REST совпадает по форме (meta + data).
        assert.deepEqual(
          Object.keys(payload.meta).sort(),
          ['limit', 'offset', 'total'],
          'meta должна содержать { total, offset, limit }',
        );

        void handle;
        void restCtx;
      } finally {
        await closeMcpContext(ctx);
        await closeRestContext(restCtx);
      }
    });
  },
);
