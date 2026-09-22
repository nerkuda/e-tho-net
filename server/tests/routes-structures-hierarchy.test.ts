/**
 * Route-level regression for `GET /networks/:networkId/thoughts/:id/hierarchy`
 * (03-server-api.md §6.11) — ошибка db504c1a («Раскрытие ветви в „Структурах
 * мыслей“ игнорирует фильтр обхода по связям»).
 *
 * Домен `getHierarchy` умел `linkFilter` с 0.8.1, но до него фильтр не доходил:
 * маршрут не разбирал query-параметр, клиент его не передавал. Тест бьёт по
 * роуту целиком через inject, поэтому ловит и контрактную дыру, и саму выборку:
 *
 *   * с `link_filter` соседи, рёбра и `directions` ограничены выбранными типами;
 *   * без параметра — прежнее поведение (все рёбра);
 *   * форма значения валидируется как у поля `link_filter` тела
 *     `POST /thoughts/query` (битый JSON и пустой фильтр — 422).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { typeNameKey } from '@etn/shared';

import {
  apiCreateThought,
  authHeaders,
  buildRestContext,
  closeRestContext,
  type RestTestContext,
} from './rest-helpers.js';

/** Insert a link-type row directly and return its id (route tests seed the DB). */
function seedLinkType(ctx: RestTestContext, forward: string): string {
  const id = randomUUID();
  ctx.ndb
    .prepare(
      `INSERT INTO link_types (id, name_forward, name_forward_key, name_reverse, name_reverse_key,
                               version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, 1, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, forward, typeNameKey(forward), `${forward}-rev`, typeNameKey(`${forward}-rev`));
  return id;
}

interface HierarchyBody {
  neighbors: Array<{ id: string; title: string }>;
  edges: Array<{ source_id: string; target_id: string; type_id: string | null }>;
  directions: Record<string, { has_incoming: boolean; has_outgoing: boolean }>;
}

/** GET one hierarchy level through the route. */
async function getHierarchyRoute(
  ctx: RestTestContext,
  thoughtId: string,
  query: Record<string, string>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const qs = new URLSearchParams(query).toString();
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/hierarchy?${qs}`,
    headers: authHeaders(ctx),
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('GET /networks/:networkId/thoughts/:id/hierarchy', () => {
  it('link_filter ограничивает раскрытие выбранными типами связей (ошибка db504c1a)', async (t) => {
    const ctx: RestTestContext = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const lt = seedLinkType(ctx, 'Причина');
    const root = (await apiCreateThought(ctx, { title: 'Корень' })).data['id'] as string;
    const typed = (
      await apiCreateThought(ctx, {
        title: 'Типизированный потомок',
        create_link: { direction: 'parent', target_thought_id: root, type_id: lt },
      })
    ).data['id'] as string;
    await apiCreateThought(ctx, {
      title: 'Потомок без типа',
      create_link: { direction: 'parent', target_thought_id: root },
    });

    // Без параметра — прежнее поведение: оба потомка.
    const plain = await getHierarchyRoute(ctx, root, { dir: 'children' });
    assert.equal(plain.statusCode, 200, `body: ${JSON.stringify(plain.body)}`);
    const plainData = plain.body['data'] as HierarchyBody;
    assert.deepEqual(
      plainData.neighbors.map((n) => n.title).sort(),
      ['Потомок без типа', 'Типизированный потомок'],
    );

    // С фильтром по выбранному типу — только типизированный потомок и только
    // его ребро; directions считается по тем же рёбрам.
    const filtered = await getHierarchyRoute(ctx, root, {
      dir: 'children',
      link_filter: JSON.stringify({ type_ids: [lt] }),
    });
    assert.equal(filtered.statusCode, 200, `body: ${JSON.stringify(filtered.body)}`);
    const filteredData = filtered.body['data'] as HierarchyBody;
    assert.deepEqual(
      filteredData.neighbors.map((n) => n.title),
      ['Типизированный потомок'],
    );
    assert.deepEqual(
      filteredData.edges.map((e) => e.target_id),
      [typed],
    );
    assert.deepEqual(filteredData.directions[root], { has_incoming: false, has_outgoing: true });

    // «Только связи без типа» — пустой type_ids + include_structural.
    const structural = await getHierarchyRoute(ctx, root, {
      dir: 'children',
      link_filter: JSON.stringify({ include_structural: true }),
    });
    assert.equal(structural.statusCode, 200, `body: ${JSON.stringify(structural.body)}`);
    assert.deepEqual(
      (structural.body['data'] as HierarchyBody).neighbors.map((n) => n.title),
      ['Потомок без типа'],
    );
  });

  it('фильтр по типу, которого нет в сети, отдаёт пустое раскрытие', async (t) => {
    const ctx: RestTestContext = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const root = (await apiCreateThought(ctx, { title: 'Корень' })).data['id'] as string;
    await apiCreateThought(ctx, {
      title: 'Потомок без типа',
      create_link: { direction: 'parent', target_thought_id: root },
    });

    const res = await getHierarchyRoute(ctx, root, {
      dir: 'children',
      link_filter: JSON.stringify({ type_ids: [randomUUID()] }),
    });
    assert.equal(res.statusCode, 200, `body: ${JSON.stringify(res.body)}`);
    assert.deepEqual((res.body['data'] as HierarchyBody).neighbors, []);
  });

  it('битый link_filter — 422 VALIDATION_ERROR, а не молчаливый обход', async (t) => {
    const ctx: RestTestContext = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const root = (await apiCreateThought(ctx, { title: 'Корень' })).data['id'] as string;

    const broken = await getHierarchyRoute(ctx, root, { dir: 'children', link_filter: '{oops' });
    assert.equal(broken.statusCode, 422);
    const brokenError = broken.body['error'] as { code: string; details: { field: string } };
    assert.equal(brokenError.code, 'VALIDATION_ERROR');
    assert.equal(brokenError.details.field, 'link_filter');

    // Пустой фильтр (как у пустой группы панели) — тоже 422: «не фильтровать»
    // выражается отсутствием параметра, а не пустым объектом.
    const empty = await getHierarchyRoute(ctx, root, {
      dir: 'children',
      link_filter: JSON.stringify({ type_ids: [] }),
    });
    assert.equal(empty.statusCode, 422);
    assert.equal((empty.body['error'] as { code: string }).code, 'VALIDATION_ERROR');
  });
});
