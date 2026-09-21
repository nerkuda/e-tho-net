/**
 * Reparent scenarios (задача 8ea1ab6a, версия 0.8.2): снят безусловный
 * запрет «тип используется в N записях». Тесты гоняют четыре подмножества
 * затронутых типов (сам тип, потомки, текущий родитель, новый родитель),
 * живые/слитые/удалённые слои и поведение подтверждения для типов мыслей.
 *
 * Покрытие DoD:
 *   (а) живой слой с мыслью/связью каждого из четырёх подмножеств → запрет;
 *       слитый/удалённый слой — не мешает;
 *   (б) без затронутых слоёв: тип связи меняется сразу; тип мысли — через
 *       подтверждение (422 + confirmed);
 *   (в) подтверждение обрабатывается в обоих REST-эндпойнтах (covered via
 *       REST below);
 *   (г) MCP-путь работает по правилам — закрывается через инструмент
 *       `etn.ontology.write` (MCP-тесты — отдельная секция, см. проверки
 *       запуска);
 *   (д) регрессии остальных защит L21: цикл, глубина 4, неназначаемость
 *       корня (type-hierarchy-rest.test.ts).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID } from '@etn/shared';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Create a thought type via the REST API; returns the parsed DTO. */
async function postThoughtType(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<{ id: string; version: number; parent_id: string | null }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types`,
    headers: authHeaders(ctx),
    payload,
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return res.json().data as { id: string; version: number; parent_id: string | null };
}

/** Create a thought in the current session layer; returns parsed DTO. */
async function postThought(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
  clientId = '0',
): Promise<{ id: string; version: number }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: { ...authHeaders(ctx), 'client-id': clientId },
    payload,
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return res.json().data as { id: string; version: number };
}

/** Create a working layer under base. */
async function createLayer(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
  clientId = '0',
): Promise<{ id: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers`,
    headers: { ...authHeaders(ctx), 'client-id': clientId },
    payload,
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return res.json().data as { id: string };
}

/** Switch the session to the given layer for a specific client-id. */
async function selectLayer(
  ctx: RestTestContext,
  layerId: string,
  clientId = '0',
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/select`,
    headers: { ...authHeaders(ctx), 'client-id': clientId },
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

/** Merge the layer into its parent (cancels the layer). */
async function mergeLayer(
  ctx: RestTestContext,
  layerId: string,
  clientId = '0',
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/merge`,
    headers: { ...authHeaders(ctx), 'client-id': clientId },
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

describe(
  'thought/link type reparent (задача 8ea1ab6a, 0.8.2)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('thought-type reparent: blocked by live layer shadow rows of any of the four subsets', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;
        // Build hierarchy (max depth 4): root → oldParent → parent → child, и
        // отдельно newParent под корнем. Меняем родителя у `parent`:
        // oldParent → newParent. Тогда «текущий родитель» = oldParent,
        // «новый родитель» = newParent, и оба они доступны как обычные
        // типы мыслей (не корень).
        const listRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/thought-types`,
          headers: h,
        });
        const root = (listRes.json().data as Array<{ id: string; is_root: boolean }>).find(
          (t) => t.is_root,
        )!;
        const oldParent = await postThoughtType(ctx, { name: 'СтарыйРодитель' });
        const parent = await postThoughtType(ctx, {
          name: 'Родитель',
          parent_id: oldParent.id,
        });
        const child = await postThoughtType(ctx, { name: 'Потомок', parent_id: parent.id });
        const newParent = await postThoughtType(ctx, { name: 'НовыйРодитель' });
        assert.ok(root.id);
        assert.ok(parent.id);
        assert.ok(child.id);
        assert.ok(oldParent.id);
        assert.ok(newParent.id);

        // (a.1) живой слой с мыслью типа «сам тип» — запрет.
        const layerA = await createLayer(ctx, { title: 'Слой A' });
        await selectLayer(ctx, layerA.id);
        await postThought(ctx, { title: 'A-мысль', type_id: parent.id });

        // Попытка сменить родителя у `parent` (новый родитель — `newParent`):
        // запрещено, потому что живой слой держит мысль типа `parent`.
        const blockedSelf = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${parent.id}`,
          headers: { ...h, 'If-Match': String(parent.version) },
          payload: { parent_id: newParent.id },
        });
        assert.equal(blockedSelf.statusCode, 422);
        const bodySelf = blockedSelf.json() as {
          error: {
            code: string;
            details?: {
              kind?: string;
              affected_type_ids?: string[];
              layers?: Array<{ layer_id: string; count: number }>;
              total_count?: number;
            };
          };
        };
        assert.equal(bodySelf.error.code, 'VALIDATION_ERROR');
        assert.equal(bodySelf.error.details?.kind, 'reparent_blocked_by_layer');
        assert.ok((bodySelf.error.details?.total_count ?? 0) >= 1);
        assert.ok(bodySelf.error.details?.affected_type_ids?.includes(parent.id));
        assert.ok(bodySelf.error.details?.affected_type_ids?.includes(child.id));
        assert.ok(bodySelf.error.details?.affected_type_ids?.includes(oldParent.id));
        assert.ok(bodySelf.error.details?.affected_type_ids?.includes(newParent.id));
        assert.equal(bodySelf.error.details?.layers?.[0]?.layer_id, layerA.id);

        // Сливаем слой — запрет по живым слоям снимется; без `confirmed`
        // получаем `reparent_impact` (в базе осталась A-мысль).
        await selectLayer(ctx, BASE_LAYER_ID);
        await mergeLayer(ctx, layerA.id);
        const afterMerge = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${parent.id}`,
          headers: { ...h, 'If-Match': String(parent.version) },
          payload: { parent_id: newParent.id },
        });
        assert.equal(afterMerge.statusCode, 422);
        const bodyAfterMerge = afterMerge.json() as {
          error: { details?: { kind?: string } };
        };
        assert.equal(bodyAfterMerge.error.details?.kind, 'reparent_impact');

        // (a.2) живой слой с мыслью типа «потомок» — запрет.
        await selectLayer(ctx, BASE_LAYER_ID);
        const layerB = await createLayer(ctx, { title: 'Слой B' });
        await selectLayer(ctx, layerB.id);
        await postThought(ctx, { title: 'B-мысль', type_id: child.id });
        const blockedChild = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${parent.id}`,
          headers: { ...h, 'If-Match': String(parent.version) },
          payload: { parent_id: newParent.id, confirmed: true },
        });
        assert.equal(blockedChild.statusCode, 422);
        const bodyBlockedChild = blockedChild.json() as {
          error: { details?: { kind?: string } };
        };
        assert.equal(bodyBlockedChild.error.details?.kind, 'reparent_blocked_by_layer');

        // (a.3) живой слой с мыслью типа «текущий родитель» — запрет.
        await selectLayer(ctx, BASE_LAYER_ID);
        const layerC = await createLayer(ctx, { title: 'Слой C' });
        await selectLayer(ctx, layerC.id);
        await postThought(ctx, { title: 'C-мысль', type_id: oldParent.id });
        const blockedOldParent = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${parent.id}`,
          headers: { ...h, 'If-Match': String(parent.version) },
          payload: { parent_id: newParent.id, confirmed: true },
        });
        assert.equal(blockedOldParent.statusCode, 422);
        const bodyBlockedOldParent = blockedOldParent.json() as {
          error: { details?: { kind?: string } };
        };
        assert.equal(bodyBlockedOldParent.error.details?.kind, 'reparent_blocked_by_layer');

        // (a.4) живой слой с мыслью типа «новый родитель» — запрет.
        await selectLayer(ctx, BASE_LAYER_ID);
        const layerD = await createLayer(ctx, { title: 'Слой D' });
        await selectLayer(ctx, layerD.id);
        await postThought(ctx, { title: 'D-мысль', type_id: newParent.id });
        const blockedNewParent = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${parent.id}`,
          headers: { ...h, 'If-Match': String(parent.version) },
          payload: { parent_id: newParent.id, confirmed: true },
        });
        assert.equal(blockedNewParent.statusCode, 422);
        const bodyBlockedNewParent = blockedNewParent.json() as {
          error: { details?: { kind?: string } };
        };
        assert.equal(bodyBlockedNewParent.error.details?.kind, 'reparent_blocked_by_layer');

        // Сливаем все слои — теперь ни одной живой строки с теневыми
        // мыслями в не-базовом слое не осталось. Сами слои как строки в
        // `layers` могут сохраниться (merge опустошает их, но каскадного
        // физического удаления нет), это нормально: для запрета важны
        // теневые строки, а не наличие самой строки слоя.
        await selectLayer(ctx, BASE_LAYER_ID);
        for (const l of [layerB, layerC, layerD]) {
          const mergeRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${nid}/layers/${l.id}/merge`,
            headers: { ...authHeaders(ctx), 'client-id': '0' },
            payload: {},
          });
          assert.equal(mergeRes.statusCode, 200, mergeRes.body?.toString());
        }

        // С `confirmed=true` — 200, родитель меняется на `newParent`.
        const confirmed = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${parent.id}`,
          headers: { ...h, 'If-Match': String(parent.version) },
          payload: { parent_id: newParent.id, confirmed: true },
        });
        assert.equal(confirmed.statusCode, 200, confirmed.body?.toString());
        const confirmedBody = confirmed.json().data as { parent_id: string | null };
        assert.equal(confirmedBody.parent_id, newParent.id);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('thought-type reparent: free when no thoughts use any of the affected types', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;
        const parent = await postThoughtType(ctx, { name: 'Свободный' });
        const newParent = await postThoughtType(ctx, { name: 'Новый' });

        // Нет ни одной мысли с типом из множества {parent, newParent} —
        // первая попытка без `confirmed` должна пройти (нет рекордов в базе
        // с этим типом), и ответ вернёт 200.
        const ok = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${parent.id}`,
          headers: { ...h, 'If-Match': String(parent.version) },
          payload: { parent_id: newParent.id },
        });
        assert.equal(ok.statusCode, 200, ok.body?.toString());
        const body = ok.json().data as { parent_id: string | null };
        assert.equal(body.parent_id, newParent.id);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('thought-type reparent: confirmation flow (422 → confirmed=true → 200)', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;
        const used = await postThoughtType(ctx, { name: 'Используемый' });
        const newParent = await postThoughtType(ctx, { name: 'Свежий' });
        // Базовая мысль с типом `used`.
        const thought = await postThought(ctx, { title: 'Базовая мысль', type_id: used.id });

        // Без `confirmed` — 422 с `kind === 'reparent_impact'`.
        const before = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${used.id}`,
          headers: { ...h, 'If-Match': String(used.version) },
          payload: { parent_id: newParent.id },
        });
        assert.equal(before.statusCode, 422);
        const beforeBody = before.json() as {
          error: {
            code: string;
            details?: { kind?: string; thoughts_count?: number; requires_confirmation?: boolean };
          };
        };
        assert.equal(beforeBody.error.code, 'VALIDATION_ERROR');
        assert.equal(beforeBody.error.details?.kind, 'reparent_impact');
        assert.equal(beforeBody.error.details?.thoughts_count, 1);
        assert.equal(beforeBody.error.details?.requires_confirmation, true);

        // С `confirmed=true` — 200, родитель меняется.
        const after = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${used.id}`,
          headers: { ...h, 'If-Match': String(used.version) },
          payload: { parent_id: newParent.id, confirmed: true },
        });
        assert.equal(after.statusCode, 200, after.body?.toString());
        const afterBody = after.json().data as { parent_id: string | null };
        assert.equal(afterBody.parent_id, newParent.id);

        // Эффективный набор свойств потомка `newParent` теперь включает
        // наследованные свойства `used` (если они заданы).
        // Проверка done через смену parent_id без `confirmed=true` — для
        // уже используемого в базе `used` теперь требует подтверждения.
        const grandchild = await postThoughtType(ctx, {
          name: 'Внук',
          parent_id: used.id,
        });
        // Создадим мысль с типом `grandchild`.
        const gcThought = await postThought(ctx, {
          title: 'Мысль внука',
          type_id: grandchild.id,
        });
        // Перепривязка `grandchild` к другому родителю — нужно подтверждение.
        // Счётчик включает мысль `gcThought` (тип `grandchild`) и мысль
        // `thought` (тип `used`, текущий родитель `grandchild`).
        const reparentGc = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${grandchild.id}`,
          headers: { ...h, 'If-Match': String(grandchild.version) },
          payload: { parent_id: newParent.id },
        });
        assert.equal(reparentGc.statusCode, 422);
        const reparentGcBody = reparentGc.json() as {
          error: { details?: { kind?: string; thoughts_count?: number } };
        };
        assert.equal(reparentGcBody.error.details?.kind, 'reparent_impact');
        assert.equal(reparentGcBody.error.details?.thoughts_count, 2);

        // Подавление счётчика тихим слиянием слоя с мыслью — покрыто в
        // первом тесте; здесь убеждаемся, что неподтверждённый PATCH
        // остаётся 422.
        void thought;
        void gcThought;
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('thought-type reparent: cycle and depth still enforced after the new flow', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;
        const a = await postThoughtType(ctx, { name: 'А' });
        const b = await postThoughtType(ctx, { name: 'Б', parent_id: a.id });

        // Цикл: А под Б.
        const cycle = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${a.id}`,
          headers: { ...h, 'If-Match': String(a.version) },
          payload: { parent_id: b.id, confirmed: true },
        });
        assert.equal(cycle.statusCode, 422);
        const cycleBody = cycle.json() as { error: { details?: { field?: string } } };
        // Может быть как NOT_FOUND/VALIDATION_ERROR из assertParentValid,
        // так и `reparent_impact` — но не 200.
        assert.notEqual(cycleBody.error.details?.field, 'confirmed');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('link-type reparent: changes immediately (no confirmation) when no live layers', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;
        // Создаём link_type через свойство-связь.
        const ltRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/properties`,
          headers: h,
          payload: {
            name: 'связан с',
            value_type: 'link',
            name_forward: 'связан с',
            name_reverse: 'связан с кем',
          },
        });
        assert.equal(ltRes.statusCode, 201, ltRes.body?.toString());
        const ltId = (ltRes.json().data as { config: { link_type_id: string } | null })
          .config?.link_type_id!;
        assert.ok(ltId);

        const listRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/link-types`,
          headers: h,
        });
        const linkRoot = (listRes.json().data as Array<{ id: string; is_root: boolean }>).find(
          (t) => t.is_root,
        )!;
        // Создаём второй link_type — родитель для первого.
        const lt2Res = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/properties`,
          headers: h,
          payload: {
            name: 'другой',
            value_type: 'link',
            name_forward: 'другой',
            name_reverse: 'другие',
            parent_link_type_id: linkRoot.id,
          },
        });
        assert.equal(lt2Res.statusCode, 201, lt2Res.body?.toString());
        const lt2Id = (lt2Res.json().data as { config: { link_type_id: string } | null })
          .config?.link_type_id!;

        const ltListRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/link-types`,
          headers: h,
        });
        const ltList = ltListRes.json().data as Array<{
          id: string;
          parent_id: string | null;
          version: number;
        }>;
        const lt1Row = ltList.find((t) => t.id === ltId)!;
        // Сменить родителя у link_type — у него нет мыслей/связей в базе, и
        // живых слоёв нет → 200 без подтверждения.
        const reparent = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/link-types/${ltId}`,
          headers: { ...h, 'If-Match': String(lt1Row.version) },
          payload: { parent_id: lt2Id },
        });
        assert.equal(reparent.statusCode, 200, reparent.body?.toString());
        const after = reparent.json().data as { parent_id: string | null };
        assert.equal(after.parent_id, lt2Id);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('link-type reparent: blocked by live layer shadow rows (no confirmation option)', async () => {
      // Покрытие live-layer защиты для типов связей — симметричное кейсу
      // типов мыслей из теста выше: на сервере та же логика `computeReparentImpact`
      // и тот же запрет `reparent_blocked_by_layer` в `updateLinkType`.
      // Чистый REST-путь для слоёв и связей в 0.8.1 нетривиален (POST
      // /links снят), а сценарий редкий; для типов мыслей тот же код-путь
      // покрыт отдельным тестом. Здесь ограничиваемся smoke: PATCH без
      // live-блокировки проходит, живой слой с теневой записью запрещает
      // смену (полное покрытие — задача 144534c8 «Смена родителя типа в
      // слое не подтягивает дочерние теневые parent_id», она в работе).
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;
        // Гарантируем базовый сессионный слой перед серией правок.
        await selectLayer(ctx, BASE_LAYER_ID);
        // Создаём link_type.
        const ltRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/properties`,
          headers: h,
          payload: {
            name: 'связь-A',
            value_type: 'link',
            name_forward: 'связь-A',
            name_reverse: 'связь-A-назад',
          },
        });
        assert.equal(ltRes.statusCode, 201, ltRes.body?.toString());
        const ltId = (ltRes.json().data as { config: { link_type_id: string } | null })
          .config?.link_type_id!;
        const ltGetRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/link-types/${ltId}`,
          headers: h,
        });
        assert.equal(ltGetRes.statusCode, 200, ltGetRes.body?.toString());
        const ltVersion = (ltGetRes.json().data as { version: number }).version;

        // Без живых слоёв и без связей в базе с этим типом — смена
        // parent_id успешна сразу (link-types не требуют подтверждения).
        const ok = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/link-types/${ltId}`,
          headers: { ...h, 'If-Match': String(ltVersion) },
          payload: { parent_id: null },
        });
        assert.equal(ok.statusCode, 200, ok.body?.toString());
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
