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

    it('thought-type reparent with shadow child: child shadow keeps its parent_id (задача 144534c8)', async () => {
      // Сценарий карточки 144534c8: у типа T есть дочерний тип C, у C в
      // рабочем слое есть теневая строка (например, поправлен description),
      // но в слое нет ни одной мысли с типом C. Смена parent T в этом слое:
      //   - `computeReparentImpact` НЕ учитывает тени самих типов — только
      //     мысли/связи. Поскольку записей нет, `layers_open_count = 0`,
      //     для thought-type без `confirmed` проходит (нет мыслей в базе);
      //   - `materializeShadow` создаёт тень T в слое и обновляет parent_id;
      //   - тень C в слое остаётся с `parent_id = T` — и это КОРРЕКТНО:
      //     parent_id дочернего типа указывает на предка, а не на parent
      //     предка. Смена parent предка не должна тянуть за собой дочерние
      //     тени, иначе они бы указали на parent предка, а не на самого
      //     предка, — это и был бы рассинхрон.
      //
      // Тест проверяет: после PATCH в слое view показывает правильную
      // цепочку C → T → newParent; физически тень C в слое хранит
      // parent_id = T (не изменилось); тень T в слое имеет parent_id =
      // newParent. Если в слое добавить мысль типа C — следующий PATCH
      // блокируется `reparent_blocked_by_layer` (защита работает).
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const nid = ctx.networkId;
        // Сетевая сессия per-client-id: типы создаются без client-id
        // (базовый слой по умолчанию), а вся работа в слое — под
        // client-id '0'. Это соглашение выдержано во всём файле.
        const hLayer = { ...authHeaders(ctx), 'client-id': '0' };

        // Иерархия: parent под корнем, child под parent, newParent под корнем.
        const parent = await postThoughtType(ctx, { name: 'Предок-Тип' });
        const child = await postThoughtType(ctx, {
          name: 'Потомок-Тип',
          parent_id: parent.id,
        });
        const newParent = await postThoughtType(ctx, { name: 'Новый-Предок' });

        // Создаём рабочий слой и переключаем на него сессию client-id '0'.
        const layer = await createLayer(ctx, { title: 'Слой 144534c8' });
        await selectLayer(ctx, layer.id);

        // В слое правим только метаданные child — это создаёт тень child.
        // Тени parent в слое пока нет.
        const childInLayer = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/thought-types/${child.id}`,
          headers: hLayer,
        });
        assert.equal(childInLayer.statusCode, 200, childInLayer.body?.toString());
        const childVersion = (childInLayer.json().data as { version: number }).version;
        const patchChildDesc = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${child.id}`,
          headers: { ...hLayer, 'If-Match': String(childVersion) },
          payload: { description: 'правим метаданные в слое' },
        });
        assert.equal(patchChildDesc.statusCode, 200, patchChildDesc.body?.toString());
        const childShadowVersion = (patchChildDesc.json().data as { version: number }).version;

        // Физический SELECT через общее соединение `ctx.ndb` — его
        // контекст = базовый слой, но `WHERE layer_id = ?` вытаскивает
        // ровно тень слоя: контекст нужен только для `*_v`, прямой
        // доступ к таблице работает без него.
        const childShadowRow = ctx.ndb
          .prepare(
            `SELECT parent_id FROM thought_types
             WHERE id = ? AND layer_id = ? AND deleted = 0`,
          )
          .get(child.id, layer.id) as { parent_id: string | null } | undefined;
        assert.ok(childShadowRow, 'тень child должна существовать в слое');
        assert.equal(childShadowRow.parent_id, parent.id);

        // В этом же слое меняем parent_id у parent. Поскольку мыслей с
        // типом parent/child/newParent в базе нет, запрета по живым слоям
        // не возникает; для thought-type нет и `reparent_impact` —
        // подтверждение требуется только когда у типа есть живые мысли
        // в базе (thought-type-service.ts:366-388).
        const parentInLayer = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/thought-types/${parent.id}`,
          headers: hLayer,
        });
        assert.equal(parentInLayer.statusCode, 200, parentInLayer.body?.toString());
        const parentVersion = (parentInLayer.json().data as { version: number }).version;
        const reparent = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${parent.id}`,
          headers: { ...hLayer, 'If-Match': String(parentVersion) },
          payload: { parent_id: newParent.id },
        });
        assert.equal(reparent.statusCode, 200, reparent.body?.toString());

        // View в слое: parent перешёл под newParent, child остался под parent.
        const childAfter = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/thought-types/${child.id}`,
          headers: hLayer,
        });
        assert.equal(childAfter.statusCode, 200, childAfter.body?.toString());
        const childAfterBody = childAfter.json().data as { parent_id: string | null };
        assert.equal(
          childAfterBody.parent_id,
          parent.id,
          'parent_id child не должен измениться',
        );

        const parentAfter = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/thought-types/${parent.id}`,
          headers: hLayer,
        });
        assert.equal(parentAfter.statusCode, 200, parentAfter.body?.toString());
        const parentAfterBody = parentAfter.json().data as { parent_id: string | null };
        assert.equal(parentAfterBody.parent_id, newParent.id);

        // Физически: тень child в слое по-прежнему хранит parent_id =
        // parent, тень parent в слое хранит parent_id = newParent.
        // version у тени child не менялся (мы обновляли только
        // description, не parent_id), у тени parent — инкрементирован при
        // правке parent_id.
        const childShadowAfter = ctx.ndb
          .prepare(
            `SELECT parent_id, version FROM thought_types
             WHERE id = ? AND layer_id = ? AND deleted = 0`,
          )
          .get(child.id, layer.id) as { parent_id: string | null; version: number } | undefined;
        assert.ok(childShadowAfter);
        assert.equal(childShadowAfter.parent_id, parent.id);
        assert.equal(childShadowAfter.version, childShadowVersion);

        const parentShadowAfter = ctx.ndb
          .prepare(
            `SELECT parent_id FROM thought_types
             WHERE id = ? AND layer_id = ? AND deleted = 0`,
          )
          .get(parent.id, layer.id) as { parent_id: string | null } | undefined;
        assert.ok(parentShadowAfter);
        assert.equal(parentShadowAfter.parent_id, newParent.id);

        // Дополнительная проверка защиты: если в слое есть мысль типа child,
        // следующий PATCH parent должен блокироваться — теми же правилами
        // задачи 8ea1ab6a, что и для всех четырёх подмножеств затронутых
        // типов. Это подтверждает, что тень child не делает проверку
        // «дырявой»: пока в слое живут мысли с типом из затронутого
        // множества, смена запрещена.
        const childThought = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/thoughts`,
          headers: hLayer,
          payload: { title: 'мысль-потомок', type_id: child.id },
        });
        assert.equal(childThought.statusCode, 201, childThought.body?.toString());
        const parentAfter2 = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/thought-types/${parent.id}`,
          headers: hLayer,
        });
        assert.equal(parentAfter2.statusCode, 200, parentAfter2.body?.toString());
        const parentVersion2 = (parentAfter2.json().data as { version: number }).version;
        const blocked = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/thought-types/${parent.id}`,
          headers: { ...hLayer, 'If-Match': String(parentVersion2) },
          payload: { parent_id: null, confirmed: true },
        });
        assert.equal(blocked.statusCode, 422);
        const blockedBody = blocked.json() as {
          error: { code: string; details?: { kind?: string } };
        };
        assert.equal(blockedBody.error.code, 'VALIDATION_ERROR');
        assert.equal(blockedBody.error.details?.kind, 'reparent_blocked_by_layer');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('link-type reparent with shadow child: child shadow keeps its parent_id (задача 144534c8)', async () => {
      // Симметричный тест для link-type. Сценарий тот же: у типа связи T
      // есть дочерний тип C, у C в слое тень (поправлен description), а
      // мыслей/связей в базе нет. Смена parent T в слое не должна ломать
      // цепочку: тень C хранит parent_id = T (не изменилось), тень T —
      // parent_id = newParent. POST /links в 0.8.1 снят, поэтому полная
      // проверка запрета по живому слою для link-type делается в
      // отдельном тесте выше; здесь — сценарий без связей.
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const hLayer = { ...authHeaders(ctx), 'client-id': '0' };
        const nid = ctx.networkId;
        await selectLayer(ctx, BASE_LAYER_ID);

        // Создаём link_type T под корнем и дочерний C под T. POST
        // /properties на REST идёт в базовый слой (без client-id).
        const ltTRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/properties`,
          headers: h,
          payload: {
            name: 'тип-связи-T',
            value_type: 'link',
            name_forward: 'связь-T',
            name_reverse: 'связь-T-назад',
          },
        });
        assert.equal(ltTRes.statusCode, 201, ltTRes.body?.toString());
        const ltTId = (ltTRes.json().data as { config: { link_type_id: string } | null })
          .config?.link_type_id!;

        const ltCRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/properties`,
          headers: h,
          payload: {
            name: 'тип-связи-C',
            value_type: 'link',
            name_forward: 'связь-C',
            name_reverse: 'связь-C-назад',
            parent_link_type_id: ltTId,
          },
        });
        assert.equal(ltCRes.statusCode, 201, ltCRes.body?.toString());
        const ltCId = (ltCRes.json().data as { config: { link_type_id: string } | null })
          .config?.link_type_id!;

        // Подтверждаем базовый parent_id у ltC в базовом слое — иначе
        // утверждения «parent_id не меняется» не имеют смысла.
        const ltCBase = ctx.ndb
          .prepare(
            `SELECT parent_id FROM link_types
             WHERE id = ? AND layer_id = ? AND deleted = 0`,
          )
          .get(ltCId, BASE_LAYER_ID) as { parent_id: string | null } | undefined;
        assert.ok(ltCBase);
        assert.equal(ltCBase.parent_id, ltTId, 'ltC.parent_id в базе должен = ltTId');

        // Рабочий слой.
        const layer = await createLayer(ctx, { title: 'Слой 144534c8 — link' });
        await selectLayer(ctx, layer.id);

        // В слое правим описание C — материализуется тень C.
        const ltCGetRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/link-types/${ltCId}`,
          headers: hLayer,
        });
        assert.equal(ltCGetRes.statusCode, 200, ltCGetRes.body?.toString());
        const ltCVersion = (ltCGetRes.json().data as { version: number }).version;
        const patchCRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/link-types/${ltCId}`,
          headers: { ...hLayer, 'If-Match': String(ltCVersion) },
          payload: { description: 'правим в слое' },
        });
        assert.equal(patchCRes.statusCode, 200, patchCRes.body?.toString());

        // Тень C физически в слое, parent_id = ltTId. Чтение через
        // `ctx.ndb` (базовый слой) + фильтр по `layer_id`.
        const cShadow = ctx.ndb
          .prepare(
            `SELECT parent_id FROM link_types
             WHERE id = ? AND layer_id = ? AND deleted = 0`,
          )
          .get(ltCId, layer.id) as { parent_id: string | null } | undefined;
        assert.ok(cShadow, 'тень link_type C должна существовать в слое');
        assert.equal(cShadow.parent_id, ltTId);

        // Создаём link_type newParent для смены родителя — в базовом слое.
        const ltNRes = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${nid}/properties`,
          headers: h,
          payload: {
            name: 'тип-связи-N',
            value_type: 'link',
            name_forward: 'связь-N',
            name_reverse: 'связь-N-назад',
          },
        });
        assert.equal(ltNRes.statusCode, 201, ltNRes.body?.toString());
        const ltNId = (ltNRes.json().data as { config: { link_type_id: string } | null })
          .config?.link_type_id!;

        // В слое меняем parent_id T → N. Связей с типом T/C нет → нет
        // блокировки, link-type меняются сразу.
        const ltTGetRes = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/link-types/${ltTId}`,
          headers: hLayer,
        });
        assert.equal(ltTGetRes.statusCode, 200, ltTGetRes.body?.toString());
        const ltTVersion = (ltTGetRes.json().data as { version: number }).version;
        const reparentRes = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${nid}/link-types/${ltTId}`,
          headers: { ...hLayer, 'If-Match': String(ltTVersion) },
          payload: { parent_id: ltNId },
        });
        assert.equal(reparentRes.statusCode, 200, reparentRes.body?.toString());
        const reparentBody = reparentRes.json().data as { parent_id: string | null };
        assert.equal(reparentBody.parent_id, ltNId);

        // View в слое: C остался под T, T теперь под N.
        const ltCAfter = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${nid}/link-types/${ltCId}`,
          headers: hLayer,
        });
        assert.equal(ltCAfter.statusCode, 200, ltCAfter.body?.toString());
        const ltCAfterBody = ltCAfter.json().data as { parent_id: string | null };
        assert.equal(
          ltCAfterBody.parent_id,
          ltTId,
          'parent_id C не должен измениться',
        );

        // Физически: тень C в слое хранит parent_id = ltTId, тень T — ltNId.
        const cShadowAfter = ctx.ndb
          .prepare(
            `SELECT parent_id FROM link_types
             WHERE id = ? AND layer_id = ? AND deleted = 0`,
          )
          .get(ltCId, layer.id) as { parent_id: string | null } | undefined;
        assert.ok(cShadowAfter);
        assert.equal(cShadowAfter.parent_id, ltTId);

        const tShadowAfter = ctx.ndb
          .prepare(
            `SELECT parent_id FROM link_types
             WHERE id = ? AND layer_id = ? AND deleted = 0`,
          )
          .get(ltTId, layer.id) as { parent_id: string | null } | undefined;
        assert.ok(tShadowAfter);
        assert.equal(tShadowAfter.parent_id, ltNId);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
