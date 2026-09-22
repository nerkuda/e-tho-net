/**
 * Route-level regression for `POST /networks/:networkId/thoughts/edges`
 * (03-server-api.md §6.12).
 *
 * Ошибка релиза 0.8.2 (регрессия вехи 8, коммит 65563a9): контракт
 * `RestEdgesBody` не извлекал `network_id` из params, хендлер открывал БД
 * сети с `undefined` — каждый запрос endpoints падал 500 INTERNAL, и экран
 * «Структуры мыслей» оставался без линий между мыслями. Тест бьёт по роуту
 * целиком через inject, поэтому ловит и контрактную дыру, и саму выборку.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  apiCreateThought,
  authHeaders,
  buildRestContext,
  closeRestContext,
  type RestTestContext,
} from './rest-helpers.js';

describe('POST /networks/:networkId/thoughts/edges', () => {
  it('возвращает рёбра между видимыми мыслями (регрессия network_id из params)', async (t) => {
    const ctx: RestTestContext = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const a = await apiCreateThought(ctx, { title: 'A' });
    const b = await apiCreateThought(ctx, {
      title: 'B',
      create_link: { direction: 'parent', target_thought_id: a.data['id'] as string },
    });
    const idA = a.data['id'] as string;
    const idB = b.data['id'] as string;

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/networks/${ctx.networkId}/thoughts/edges`,
      headers: authHeaders(ctx),
      payload: { ids: [idA, idB], show_inactive: false },
    });
    assert.equal(res.statusCode, 200, `body: ${res.body}`);
    const data = res.json().data as { edges: Array<{ source_id: string; target_id: string }> };
    const pair = data.edges.find(
      (e) => (e.source_id === idA && e.target_id === idB) || (e.source_id === idB && e.target_id === idA),
    );
    assert.ok(pair !== undefined, `ребро A→B должно быть в ответе: ${JSON.stringify(data.edges)}`);
  });

  it('пустой ids — 422, а не 500', async (t) => {
    const ctx: RestTestContext = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/networks/${ctx.networkId}/thoughts/edges`,
      headers: authHeaders(ctx),
      payload: { ids: [], show_inactive: false },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });
});
