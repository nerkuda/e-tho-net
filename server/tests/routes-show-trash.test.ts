/**
 * Route-level проверка настройки сети «Показывать содержимое корзины» —
 * задача 77923b49 (0.8.2), L3-preference `show_trash`.
 *
 * Домен отфильтрован по `opts.showTrash` (см. `show-trash-visibility.test.ts`);
 * здесь проверяется ПРОВОДКА, без которой настройка мертва:
 *
 *  - `PUT /networks/:id/preferences/show_trash` принимается и читается обратно
 *    (`GET /preferences`) — ключ объявлен в `SUPPORTED_PREFERENCE_KEYS`;
 *  - фокус/карта, иерархия «Структур» и сгруппированный список связей редактора
 *    резолвят флаг из preferences: дефолт — помеченные видны (поведение после
 *    355319d4 не меняется), выключенная настройка — скрыты;
 *  - явное переопределение в теле фокуса (`show_trash`) сильнее настройки —
 *    тот же путь, что у `show_inactive`.
 *
 * Требует нативного better-sqlite3; иначе скипается.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  apiCreateThought,
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Create a thought under `parentId` and return its id. */
async function childOf(ctx: RestTestContext, parentId: string, title: string): Promise<string> {
  const res = await apiCreateThought(ctx, {
    title,
    create_link: { direction: 'parent', target_thought_id: parentId },
  });
  assert.equal(res.statusCode, 201, `create ${title}: ${JSON.stringify(res.data)}`);
  return res.data['id'] as string;
}

/** Move a thought to the trash (S13). */
async function trashThought(ctx: RestTestContext, thoughtId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}`,
    headers: authHeaders(ctx),
    payload: { marked_for_deletion: true },
  });
  assert.equal(res.statusCode, 200, `trash ${thoughtId}: ${res.body}`);
}

/** PUT an L3 preference of the context's network. */
async function setPreference(
  ctx: RestTestContext,
  key: string,
  value: unknown,
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/networks/${ctx.networkId}/preferences/${key}`,
    headers: authHeaders(ctx),
    payload: { value },
  });
  assert.equal(res.statusCode, 200, `PUT ${key}: ${res.body}`);
}

/** POST the focus request and return the parsed `data`. */
async function focusOf(
  ctx: RestTestContext,
  thoughtId: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/focus`,
    headers: authHeaders(ctx),
    payload: body,
  });
  assert.equal(res.statusCode, 200, `focus: ${res.body}`);
  return res.json().data as Record<string, unknown>;
}

/** Child ids of the focus response. */
function childIds(focusData: Record<string, unknown>): string[] {
  const children = focusData['children'] as Array<{ id: string }>;
  return children.map((n) => n.id).sort();
}

/** Create a child of `parentId` and return `{ id, linkId }` (from the focus row). */
async function childWithLink(
  ctx: RestTestContext,
  parentId: string,
  title: string,
): Promise<{ id: string; linkId: string }> {
  const id = await childOf(ctx, parentId, title);
  const focus = await focusOf(ctx, parentId);
  const children = focus['children'] as Array<{ id: string; link_id: string }>;
  const row = children.find((c) => c.id === id);
  assert.ok(row !== undefined, `focus не отдал ребро к ${title}`);
  return { id, linkId: row.link_id };
}

/** Move a link to the trash (S13). */
async function trashLink(ctx: RestTestContext, linkId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/networks/${ctx.networkId}/links/${linkId}`,
    headers: authHeaders(ctx),
    payload: { marked_for_deletion: true },
  });
  assert.equal(res.statusCode, 200, `trash link ${linkId}: ${res.body}`);
}

/** Directions of the `POST /thoughts/query` page (`meta.directions`). */
async function queryDirections(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<Record<string, { has_incoming: boolean; has_outgoing: boolean }>> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/query`,
    headers: authHeaders(ctx),
    payload,
  });
  assert.equal(res.statusCode, 200, `query: ${res.body}`);
  const meta = res.json().meta as {
    directions: Record<string, { has_incoming: boolean; has_outgoing: boolean }>;
  };
  return meta.directions;
}

/** Parent (or child) ids of one hierarchy level. */
async function hierarchyIds(
  ctx: RestTestContext,
  thoughtId: string,
  dir: 'parents' | 'children',
): Promise<string[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/hierarchy?dir=${dir}`,
    headers: authHeaders(ctx),
  });
  assert.equal(res.statusCode, 200, `hierarchy: ${res.body}`);
  return (res.json().data as { neighbors: Array<{ id: string }> }).neighbors
    .map((n) => n.id)
    .sort();
}

describe(
  'show_trash на REST-роутах (77923b49)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('preference show_trash; фокус, иерархия и список связей прячут помеченных при выключенной настройке', async (t) => {
      const ctx = await buildRestContext();
      t.after(async () => closeRestContext(ctx));

      const focusThought = await apiCreateThought(ctx, { title: 'Фокус' });
      const focusId = focusThought.data['id'] as string;
      const liveChild = await childOf(ctx, focusId, 'Живой потомок');
      const trashedChild = await childOf(ctx, focusId, 'Потомок в корзине');
      await trashThought(ctx, trashedChild);

      // 1. Настройки нет — помеченный виден с признаком корзины (355319d4).
      assert.deepEqual(childIds(await focusOf(ctx, focusId)), [liveChild, trashedChild].sort());

      // 2. Явное переопределение в теле сильнее настройки (как show_inactive).
      assert.deepEqual(childIds(await focusOf(ctx, focusId, { show_trash: false })), [liveChild]);
      assert.deepEqual(
        childIds(await focusOf(ctx, focusId, { show_trash: true })),
        [liveChild, trashedChild].sort(),
      );

      // 3. Настройка сохраняется и читается обратно.
      await setPreference(ctx, 'show_trash', false);
      const prefs = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/preferences`,
        headers: authHeaders(ctx),
      });
      const stored = (prefs.json().data as Array<{ key: string; value: unknown }>).find(
        (p) => p.key === 'show_trash',
      );
      assert.equal(stored?.value, false);

      // 4. Выключенная настройка прячет помеченного в фокусе (карта/локальный граф).
      const focusHidden = await focusOf(ctx, focusId);
      assert.deepEqual(childIds(focusHidden), [liveChild]);
      const edges = focusHidden['edges'] as Array<{ target_id: string }>;
      assert.equal(
        edges.some((e) => e.target_id === trashedChild),
        false,
        'ребро к скрытому потомку не остаётся на карте',
      );

      // 5. Дерево «Структур» — тем же флагом из preferences.
      const hierarchy = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/thoughts/${focusId}/hierarchy?dir=children`,
        headers: authHeaders(ctx),
      });
      assert.equal(hierarchy.statusCode, 200, hierarchy.body);
      const neighbors = (hierarchy.json().data as { neighbors: Array<{ id: string }> }).neighbors;
      assert.deepEqual(neighbors.map((n) => n.id), [liveChild]);

      // 6. Сгруппированный список связей редактора.
      const links = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/thoughts/${focusId}/links?group=type`,
        headers: authHeaders(ctx),
      });
      assert.equal(links.statusCode, 200, links.body);
      const grouped = links.json().data as {
        untyped_children: Array<{ target_thought?: { id: string } }>;
        untyped_parents: Array<{ source_thought?: { id: string } }>;
        by_type: Array<{ items: Array<{ target_thought?: { id: string } }> }>;
      };
      const listedIds = [
        ...grouped.untyped_children.map((i) => i.target_thought?.id),
        ...grouped.untyped_parents.map((i) => i.source_thought?.id),
        ...grouped.by_type.flatMap((g) => g.items.map((i) => i.target_thought?.id)),
      ];
      assert.equal(
        listedIds.includes(trashedChild),
        false,
        `список связей прячет помеченного соседа: ${JSON.stringify(listedIds)}`,
      );
      assert.equal(
        listedIds.includes(liveChild),
        true,
        'живой сосед остался в списке связей',
      );

      // 7. Возврат настройки возвращает помеченного — переключение обратимо.
      await setPreference(ctx, 'show_trash', true);
      assert.deepEqual(childIds(await focusOf(ctx, focusId)), [liveChild, trashedChild].sort());
    });

    it('directions отбора согласованы с раскрытием при обеих положениях show_trash (331ffb94)', async (t) => {
      const ctx = await buildRestContext();
      t.after(async () => closeRestContext(ctx));

      // Корень A — помеченное РЕБРО к живому B; корень C — живое ребро к
      // помеченной МЫСЛИ D. Оба случая — грани одной настройки: сосед не
      // приходит в раскрытие, значит и эллипс не должен быть закрашен.
      const rootA = (await apiCreateThought(ctx, { title: 'Корень запроса A' })).data[
        'id'
      ] as string;
      const { id: b, linkId: abLink } = await childWithLink(ctx, rootA, 'Живой потомок B');
      await trashLink(ctx, abLink);

      const rootC = (await apiCreateThought(ctx, { title: 'Корень запроса C' })).data[
        'id'
      ] as string;
      const { id: d } = await childWithLink(ctx, rootC, 'Потомок D в корзине');
      await trashThought(ctx, d);

      const query = { keywords: 'Корень запроса' };

      // Настройка по умолчанию (включена): помеченное видно — эллипс заполнен
      // и раскрытие отдаёт соседа. Значит согласованность не сломана в другую
      // сторону (наивный «фикс» не должен гасить эллипс при видимой корзине).
      const open = await queryDirections(ctx, query);
      assert.deepEqual(open[rootA], { has_incoming: false, has_outgoing: true });
      assert.deepEqual(open[rootC], { has_incoming: false, has_outgoing: true });
      assert.deepEqual(await hierarchyIds(ctx, rootA, 'children'), [b].sort());
      assert.deepEqual(await hierarchyIds(ctx, rootC, 'children'), [d].sort());

      // Настройка выключена: и направление, и раскрытие пусты — эллипс не
      // обещает скрытого уровня (ошибка 331ffb94).
      await setPreference(ctx, 'show_trash', false);
      const hidden = await queryDirections(ctx, query);
      assert.deepEqual(
        hidden[rootA],
        { has_incoming: false, has_outgoing: false },
        'помеченное ребро не закрашивает эллипс при скрытой корзине',
      );
      assert.deepEqual(
        hidden[rootC],
        { has_incoming: false, has_outgoing: false },
        'ребро в помеченную мысль не закрашивает эллипс при скрытой корзине',
      );
      assert.deepEqual(await hierarchyIds(ctx, rootA, 'children'), []);
      assert.deepEqual(await hierarchyIds(ctx, rootC, 'children'), []);

      // Текущее переопределение в теле сильнее настройки (тот же путь, что у
      // фокуса/иерархии): при выключенной настройке true возвращает эллипс.
      assert.deepEqual((await queryDirections(ctx, { ...query, show_trash: true }))[rootA], {
        has_incoming: false,
        has_outgoing: true,
      });

      // Обратная обратимость настройки.
      await setPreference(ctx, 'show_trash', true);
      const again = await queryDirections(ctx, query);
      assert.deepEqual(again[rootA], { has_incoming: false, has_outgoing: true });
      assert.deepEqual(again[rootC], { has_incoming: false, has_outgoing: true });
    });
  },
);
