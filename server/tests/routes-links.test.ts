/**
 * Integration tests for the /links routes (task D2, D8) via app.inject.
 *
 * 0.8.1 (требование 3ea5c6af): создание и удаление связей отдельными операциями
 * упразднено — `POST /links` и `DELETE /links/{id}` сняты, они ушли в операции
 * над свойствами-связями. Здесь тестируем оставшийся контур: создание связи
 * через свойство (`PUT /thoughts/:id/properties/:key`), чтение `GET /links/:id`,
 * `PATCH /links/:id` (active + If-Match) и группированный список редактора.
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

/** Set a link property value on a thought (creates/removes edges). */
async function setProperty(
  ctx: RestTestContext,
  thoughtId: string,
  key: string,
  value: unknown,
): Promise<number> {
  const res = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/properties/${encodeURIComponent(key)}`,
    headers: authHeaders(ctx),
    payload: { value },
  });
  return res.statusCode;
}

describe(
  '/links routes',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('создание связи через свойство, чтение и PATCH (If-Match)', async () => {
      const ctx = await buildRestContext();
      try {
        const child = await createThought(ctx, 'Цель');
        // Структурная связь HOME → child через «Потомки».
        assert.equal(await setProperty(ctx, ctx.homeId, 'Потомки', [child]), 200);

        // Группированный список: ребёнок — в untyped_children.
        const grouped = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/links?group=type`,
          headers: authHeaders(ctx),
        });
        assert.equal(grouped.statusCode, 200);
        const data = grouped.json().data as {
          by_type: Array<{ items: unknown[] }>;
          untyped_parents: unknown[];
          untyped_children: Array<{ link: { id: string } }>;
        };
        assert.equal(data.untyped_children.length, 1);
        const linkId = data.untyped_children[0]!.link.id;

        // Чтение отдельной связи.
        const got = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/links/${linkId}`,
          headers: authHeaders(ctx),
        });
        assert.equal(got.statusCode, 200);

        // PATCH active=false с корректным If-Match.
        const patched = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/links/${linkId}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { active: false },
        });
        assert.equal(patched.statusCode, 200);
        assert.equal((patched.json().data as { version: number }).version, 2);

        // Устаревший If-Match → 409.
        const conflict = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/links/${linkId}`,
          headers: { ...authHeaders(ctx), 'if-match': '1' },
          payload: { active: true },
        });
        assert.equal(conflict.statusCode, 409);

        // POST /links снят → 404.
        const post = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/links`,
          headers: authHeaders(ctx),
          payload: { source_id: ctx.homeId, target_id: child },
        });
        assert.equal(post.statusCode, 404);

        // DELETE /links/{id} снят → 404.
        const del = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/links/${linkId}`,
          headers: authHeaders(ctx),
        });
        assert.equal(del.statusCode, 404);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('удаление из набора помечает ребро в корзину (значение не читается)', async () => {
      const ctx = await buildRestContext();
      try {
        const child = await createThought(ctx, 'Ребёнок для удаления');
        assert.equal(await setProperty(ctx, ctx.homeId, 'Потомки', [child]), 200);

        // Очистить набор — ребро в корзину.
        assert.equal(await setProperty(ctx, ctx.homeId, 'Потомки', []), 200);

        // В значениях свойства «Потомки» помеченного ребра нет.
        const props = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctx.homeId}/properties`,
          headers: authHeaders(ctx),
        });
        assert.equal(props.statusCode, 200);
        const values = props.json().data as Array<{ property_name: string; values?: unknown[] }>;
        const potomki = values.find((v) => v.property_name === 'Потомки');
        assert.ok(potomki !== undefined);
        assert.deepEqual(potomki.values, []);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
