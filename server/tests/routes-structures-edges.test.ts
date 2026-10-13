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
import { randomUUID } from 'node:crypto';
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

  // Ошибка a617b4c6: снимок рёбер для догрузки порций карты игнорировал
  // фильтр типов связей — контракт не принимал `link_filter`, маршрут звал
  // `getEdgesAmong(..., undefined, ...)`, и на холст возвращались рёбра
  // отфильтрованных типов. Родительская связь создаётся структурной
  // (`type_id = NULL`), поэтому фильтр без `include_structural` её отсекает.
  it('link_filter ограничивает снимок рёбер (a617b4c6)', async (t) => {
    const ctx: RestTestContext = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const a = await apiCreateThought(ctx, { title: 'A' });
    const b = await apiCreateThought(ctx, {
      title: 'B',
      create_link: { direction: 'parent', target_thought_id: a.data['id'] as string },
    });
    const idA = a.data['id'] as string;
    const idB = b.data['id'] as string;
    const edgesOf = (res: { json: () => unknown }): Array<{ id: string }> =>
      (res.json() as { data: { edges: Array<{ id: string }> } }).data.edges;

    const plain = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/networks/${ctx.networkId}/thoughts/edges`,
      headers: authHeaders(ctx),
      payload: { ids: [idA, idB], show_inactive: false },
    });
    assert.equal(plain.statusCode, 200, `body: ${plain.body}`);
    assert.ok(edgesOf(plain).length > 0, 'без фильтра ребро есть');

    // Фильтр по несуществующему типу связи (без `include_structural`) отсекает
    // структурное ребро — снимок обязан вернуть пусто.
    const filtered = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/networks/${ctx.networkId}/thoughts/edges`,
      headers: authHeaders(ctx),
      payload: {
        ids: [idA, idB],
        show_inactive: false,
        link_filter: { type_ids: ['11111111-1111-1111-1111-111111111111'] },
      },
    });
    assert.equal(filtered.statusCode, 200, `body: ${filtered.body}`);
    assert.deepEqual(edgesOf(filtered), [], 'фильтр типов отсекает рёбра (a617b4c6)');

    // `include_structural` возвращает структурное ребро обратно.
    const structural = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/networks/${ctx.networkId}/thoughts/edges`,
      headers: authHeaders(ctx),
      payload: {
        ids: [idA, idB],
        show_inactive: false,
        link_filter: { include_structural: true },
      },
    });
    assert.equal(structural.statusCode, 200, `body: ${structural.body}`);
    assert.ok(edgesOf(structural).length > 0, 'include_structural сохраняет структурное ребро');
  });

  // Задача f7da04d6 (требование 8c131cff, ADR 3fd7507f): `link_filter` переведён
  // на канонический AST-лист «Тип связи». Поведение обхода обязано совпасть с
  // прежним — в частности раскрытие типа вместе с потомками `link_types` (L21).
  it('link_filter раскрывает тип связи вместе с потомками (L21) — идентичность после перевода на AST', async (t) => {
    const ctx: RestTestContext = await buildRestContext();
    t.after(async () => closeRestContext(ctx));
    const ndb = ctx.ndb;

    const parentType = randomUUID();
    const childType = randomUUID();
    ndb
      .prepare(
        `INSERT INTO link_types (id, name_forward, name_forward_key, name_reverse, name_reverse_key,
                                 parent_id, version, created_at, updated_at, created_by)
         VALUES (?, 'родитель', lower('родитель'), 'родитель', lower('родитель'), NULL, 1, '2024', '2024', 'u')`,
      )
      .run(parentType);
    ndb
      .prepare(
        `INSERT INTO link_types (id, name_forward, name_forward_key, name_reverse, name_reverse_key,
                                 parent_id, version, created_at, updated_at, created_by)
         VALUES (?, 'дочерний', lower('дочерний'), 'дочерний', lower('дочерний'), ?, 1, '2024', '2024', 'u')`,
      )
      .run(childType, parentType);

    const a = await apiCreateThought(ctx, { title: 'Узел A' });
    const b = await apiCreateThought(ctx, { title: 'Узел B' });
    const idA = a.data['id'] as string;
    const idB = b.data['id'] as string;
    const linkId = randomUUID();
    ndb
      .prepare(
        `INSERT INTO links (id, source_id, target_id, type_id, active, version, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, 1, 1, '2024', '2024', 'u', 'u')`,
      )
      .run(linkId, idA, idB, childType);

    const edgesOf = (res: { json: () => unknown }): string[] =>
      (res.json() as { data: { edges: Array<{ id: string }> } }).data.edges.map((e) => e.id);

    // Фильтр по РОДИТЕЛЬСКОМУ типу обязан вернуть ребро дочернего типа.
    const byParent = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/networks/${ctx.networkId}/thoughts/edges`,
      headers: authHeaders(ctx),
      payload: { ids: [idA, idB], show_inactive: false, link_filter: { type_ids: [parentType] } },
    });
    assert.equal(byParent.statusCode, 200, `body: ${byParent.body}`);
    assert.ok(edgesOf(byParent).includes(linkId), 'тип раскрыт вместе с потомками (L21)');

    // Фильтр по чужому типу ребро отсекает.
    const byOther = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/networks/${ctx.networkId}/thoughts/edges`,
      headers: authHeaders(ctx),
      payload: {
        ids: [idA, idB],
        show_inactive: false,
        link_filter: { type_ids: [randomUUID()] },
      },
    });
    assert.equal(byOther.statusCode, 200);
    assert.ok(!edgesOf(byOther).includes(linkId), 'чужой тип отсекает ребро');
  });
});
