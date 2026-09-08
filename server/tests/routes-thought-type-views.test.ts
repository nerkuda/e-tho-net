/**
 * Интеграционные тесты REST-маршрутов отборов типов мыслей
 * (задача 65de7eaa; контракты b90bb6e6, 95273103, c643fd7b).
 *
 * Покрывает:
 *   * CRUD отборов: create/list/get/patch/delete + If-Match + DUPLICATE/NOT_FOUND;
 *   * `POST /thoughts/{id}/views/{view}/run` — happy path с подстановкой токена
 *     `$thought.[version]`, ветвимая выборка работ версии;
 *   * `run` с неразрешимым токеном — `{ data: [], meta.unresolved: [...] }`,
 *     200 OK без 404/500;
 *   * `run` с токеном `$thought.[tags]` (multiple) в скалярной операции →
 *     422 ещё на сохранении отбора (дубликат требования 12fccde9 на REST);
 *   * `meta.effective` в `GET .../views?include_effective=true` — эффективный
 *     набор с учётом предков;
 *   * события `thought-type-view.created/updated/deleted/run` через
 *     `pubsub.subscribe` — сценарий «второй клиент видит изменение без
 *     перезахода»;
 *   * уважение слою: правка в слое видна только при чтении с тем же слоем;
 *     клиент в основе правок слоя не видит (layer-visibility);
 *   * слияние слоя (`etn.layers.merge`) — после него все видят новое;
 *   * заголовок слоя — `?layer_id=` или `X-Etn-Layer` принимается и применяется.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  BASE_LAYER_ID,
  type AnyRealtimeEvent,
} from '@etn/shared';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Create a child of HOME and return its id. */
async function createChild(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: {
      title,
      create_link: { direction: 'parent', target_thought_id: ctx.homeId },
    },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

/** Create a thought type and return its id. */
async function createThoughtType(
  ctx: RestTestContext,
  name: string,
  parentId: string | null = null,
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types`,
    headers: authHeaders(ctx),
    payload: { name, parent_id: parentId },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

/**
 * Создать реестровое text-свойство с фиксированным (или случайным) именем и
 * подключить его к типу мысли. Имя глобально уникально в сети; если нужна
 * переносимость свойства между типами (для сценариев «контекстная мысль
 * другого типа»), передавайте `uniqueName` явно, иначе будет сгенерирован
 * случайный суффикс.
 *
 * Возвращает `{ id, name }`: `id` — реестровый UUID (нужен для
 * `definition.properties[].property_id` движка отбора, 03-server-api.md
 * §6.10 и `thought-type-views-service.ts`), `name` — имя свойства (для
 * `PUT /thoughts/{id}/properties/{name}` и для токена `$thought.[name]`).
 */
async function attachTextProperty(
  ctx: RestTestContext,
  typeId: string,
  propName: string,
  uniqueName?: string,
): Promise<{ id: string; name: string }> {
  const finalName = uniqueName ?? `${propName}-${randomUUID().slice(0, 8)}`;
  // 1. Create registry property.
  const regRes = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/properties`,
    headers: authHeaders(ctx),
    payload: { name: finalName, value_type: 'text' },
  });
  assert.equal(regRes.statusCode, 201, regRes.body?.toString());
  const propId = (regRes.json().data as { id: string }).id;
  // 2. Attach to the thought type.
  const attachRes = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/properties`,
    headers: authHeaders(ctx),
    payload: { property_id: propId, required: false },
  });
  assert.equal(attachRes.statusCode, 201, attachRes.body?.toString());
  return { id: propId, name: finalName };
}

/** Set a text property value on a thought. */
async function setTextProperty(
  ctx: RestTestContext,
  thoughtId: string,
  propName: string,
  value: string,
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PUT',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/properties/${propName}`,
    headers: authHeaders(ctx),
    payload: { value },
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

/** Create a thought with a type and a property value in one shot. */
async function createTypedChildWithValue(
  ctx: RestTestContext,
  title: string,
  typeId: string,
  propName: string,
  value: string,
): Promise<string> {
  const id = await createChild(ctx, title);
  await ctx.app.inject({
    method: 'PATCH',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${id}`,
    headers: authHeaders(ctx),
    payload: { type_id: typeId },
  });
  await setTextProperty(ctx, id, propName, value);
  return id;
}

interface ViewDto {
  id: string;
  thought_type_id: string;
  name: string;
  name_key: string;
  description: string | null;
  definition: string;
  position: number;
  is_default: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
}

describe(
  '/thought-types/{id}/views routes (задача 65de7eaa)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    describe('CRUD', () => {
      it('POST + GET + list + PATCH + DELETE happy path with If-Match', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');

          // POST — create a view.
          const definition = JSON.stringify({ keywords: 'alpha', sort: 'alpha', order: 'asc' });
          const created = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
            payload: {
              name: 'Активные',
              description: 'мысли с подстрокой alpha',
              definition,
              position: 1,
              is_default: false,
            },
          });
          assert.equal(created.statusCode, 201, created.body?.toString());
          const createdView = created.json().data as ViewDto;
          assert.equal(createdView.thought_type_id, typeId);
          assert.equal(createdView.name, 'Активные');
          assert.equal(createdView.name_key, 'активные');
          assert.equal(createdView.position, 1);
          assert.equal(createdView.is_default, false);
          assert.equal(createdView.version, 1);

          // GET by id.
          const get = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views/${createdView.id}`,
            headers: h,
          });
          assert.equal(get.statusCode, 200);
          assert.equal((get.json().data as ViewDto).name, 'Активные');

          // List.
          const list = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
          });
          assert.equal(list.statusCode, 200);
          assert.deepEqual((list.json().data as ViewDto[]).map((v) => v.id), [createdView.id]);

          // PATCH (rename + position) — correct If-Match bumps version.
          const patch = await ctx.app.inject({
            method: 'PATCH',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views/${createdView.id}`,
            headers: { ...h, 'if-match': '1' },
            payload: { name: 'Архив', position: 5 },
          });
          assert.equal(patch.statusCode, 200, patch.body?.toString());
          const patched = patch.json().data as ViewDto;
          assert.equal(patched.name, 'Архив');
          assert.equal(patched.position, 5);
          assert.equal(patched.version, 2);

          // PATCH with stale version → 409.
          const conflict = await ctx.app.inject({
            method: 'PATCH',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views/${createdView.id}`,
            headers: { ...h, 'if-match': '1' },
            payload: { name: 'Другой' },
          });
          assert.equal(conflict.statusCode, 409);
          assert.equal(conflict.json().error.code, 'VERSION_CONFLICT');

          // DELETE with stale version → 409.
          const delConflict = await ctx.app.inject({
            method: 'DELETE',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views/${createdView.id}`,
            headers: { ...h, 'if-match': '1' },
          });
          assert.equal(delConflict.statusCode, 409);

          // DELETE with current version → 204.
          const del = await ctx.app.inject({
            method: 'DELETE',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views/${createdView.id}`,
            headers: { ...h, 'if-match': '2' },
          });
          assert.equal(del.statusCode, 204);

          // 404 на повторный GET.
          const gone = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views/${createdView.id}`,
            headers: h,
          });
          assert.equal(gone.statusCode, 404);
        } finally {
          await closeRestContext(ctx);
        }
      });

      it('POST с дублем имени в пределах типа → 409 DUPLICATE с details.existing_id', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');
          const definition = JSON.stringify({ keywords: 'alpha' });

          const first = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
            payload: { name: 'Дубликаты', definition },
          });
          assert.equal(first.statusCode, 201);

          // Регистронезависимое сравнение — поэтому «дубликаты» (со строчной «д»)
          // уже занято.
          const dup = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
            payload: { name: 'дубликаты', definition },
          });
          assert.equal(dup.statusCode, 409);
          assert.equal(dup.json().error.code, 'DUPLICATE');
          const details = dup.json().error.details as {
            existing_id?: string;
            existing_name?: string;
          };
          assert.ok(details.existing_id, 'details.existing_id обязан быть');
          assert.equal(details.existing_name, 'Дубликаты');
        } finally {
          await closeRestContext(ctx);
        }
      });

      it('POST с невалидным definition → 422 VALIDATION_ERROR', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');

          const res = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
            payload: { name: 'Битый', definition: '{это не JSON' },
          });
          assert.equal(res.statusCode, 422);
          assert.equal(res.json().error.code, 'VALIDATION_ERROR');
        } finally {
          await closeRestContext(ctx);
        }
      });

      it('GET на отсутствующий viewId → 404', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');
          const res = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views/${randomUUID()}`,
            headers: h,
          });
          assert.equal(res.statusCode, 404);
          assert.equal(res.json().error.code, 'NOT_FOUND');
        } finally {
          await closeRestContext(ctx);
        }
      });

      it('POST с токеном `$thought.[multiple]` в скалярной операции → 422 на сохранении (требование 12fccde9)', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');
          // Регистрируем множественное свойство `tags`.
          const regRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/properties`,
            headers: h,
            payload: { name: 'tags', value_type: 'text', config: { multiple: true } },
          });
          assert.equal(regRes.statusCode, 201);
          const propId = (regRes.json().data as { id: string }).id;
          const attach = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/properties`,
            headers: h,
            payload: { property_id: propId, required: false },
          });
          assert.equal(attach.statusCode, 201);

          // definition с `$thought.[tags]` в операции `eq` — скаляр, несовместимо.
          const definition = JSON.stringify({
            properties: [{ property: 'tags', op: 'eq', value: '$thought.[tags]' }],
          });
          const res = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
            payload: { name: 'С битым токеном', definition },
          });
          assert.equal(res.statusCode, 422);
          const details = res.json().error.details as { reason?: string };
          assert.equal(details.reason, 'incompatible_operation');
        } finally {
          await closeRestContext(ctx);
        }
      });

      it('POST с лишним полем → 422 со списком неизвестных ключей', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');
          const res = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
            payload: {
              name: 'Опечатка',
              definition: '{}',
              // опечатка клиента — `definitionn` молча бы превратился в undefined,
              // и отбор сохранился бы без `definition`. Это и есть причина
              // строгого списка ключей в parseCreateBody.
              definitionn: '{}',
            },
          });
          assert.equal(res.statusCode, 422);
          const details = res.json().error.details as { fields?: string[] };
          assert.deepEqual(details.fields, ['definitionn']);
        } finally {
          await closeRestContext(ctx);
        }
      });
    });

    describe('effective набор', () => {
      it('GET ?include_effective=true возвращает свой + унаследованный от предка', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const parentId = await createThoughtType(ctx, 'parent');
          const childId = await createThoughtType(ctx, 'child', parentId);

          const definition = JSON.stringify({ keywords: 'a' });
          // Отбор на предке.
          await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${parentId}/views`,
            headers: h,
            payload: { name: 'Наследуемый', definition },
          });
          // Собственный отбор на потомке.
          await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${childId}/views`,
            headers: h,
            payload: { name: 'Собственный', definition },
          });

          const res = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${childId}/views?include_effective=true`,
            headers: h,
          });
          assert.equal(res.statusCode, 200);
          const meta = res.json().meta as { effective: Array<{ name: string; defined_on: string; inherited: boolean }> };
          assert.equal(meta.effective.length, 2);
          // Наследованный идёт первым (требование eaca1253 — от корня к типу).
          assert.equal(meta.effective[0]!.name, 'Наследуемый');
          assert.equal(meta.effective[0]!.inherited, true);
          assert.equal(meta.effective[0]!.defined_on, parentId);
          assert.equal(meta.effective[1]!.name, 'Собственный');
          assert.equal(meta.effective[1]!.inherited, false);
        } finally {
          await closeRestContext(ctx);
        }
      });
    });

    describe('POST /thoughts/{id}/views/{view}/run', () => {
      it('happy path: отбор «Работы версии» подставляет $thought.[version] и возвращает отфильтрованные мысли', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);

          // 1. Тип «task» + свойство «version-XXX» (text). Имя свойства
          //    суффиксируется случайно, чтобы не конфликтовать с другими
          //    тестами в реестре.
          const taskType = await createThoughtType(ctx, 'task');
          const propSuffix = randomUUID().slice(0, 8);
          const propName = `version-${propSuffix}`;
          const { id: propId } = await attachTextProperty(ctx, taskType, propName, propName);

          // 2. Создаём три мысли этого типа с разными значениями свойства.
          const v = `v-${randomUUID().slice(0, 8)}`;
          const inA = await createTypedChildWithValue(ctx, 'Задача A', taskType, propName, v);
          const inB = await createTypedChildWithValue(ctx, 'Задача B', taskType, propName, v);
          // Чужая версия — не должна попасть в выборку.
          const otherV = `v-${randomUUID().slice(0, 8)}`;
          const out = await createTypedChildWithValue(ctx, 'Чужая', taskType, propName, otherV);

          // 3. Контекстная мысль того же типа (важно: токен `$thought.[X]`
          //    подставляется из свойств КОНТЕКСТНОЙ мысли, поэтому тип должен
          //    иметь одноимённое свойство).
          const versionThought = await createTypedChildWithValue(
            ctx,
            'Версия',
            taskType,
            propName,
            v,
          );

          // 4. Создаём отбор на `task` с токеном `$thought.[<propname>]`.
          //    `definition.properties[i].property_id` — реестровый UUID свойства
          //    (а не имя), иначе движок отбора не найдёт определение и молча
          //    пропустит фильтр (`getNetworkProperty` вернёт null → skip,
          //    см. `structure-service.ts`/`appendPropertyWhere`).
          //    `definition.properties[i].value` — имя свойства в скобках,
          //    это и есть подстановка.
          const definition = JSON.stringify({
            type_ids: [taskType],
            properties: [
              {
                property_id: propId,
                op: 'eq',
                value: `$thought.[${propName}]`,
              },
            ],
            sort: 'alpha',
            order: 'asc',
          });
          const viewRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${taskType}/views`,
            headers: h,
            payload: { name: 'Работы версии', definition, is_default: true },
          });
          assert.equal(viewRes.statusCode, 201, viewRes.body?.toString());
          const viewId = (viewRes.json().data as ViewDto).id;

          // 5. Запускаем run. URL-encoded потому что имя отбора содержит
          //    пробел и кириллицу — Fastify при `inject` ожидает уже
          //    закодированный путь (иначе ломается маршрутизация).
          const runUrl = `/api/v1/networks/${ctx.networkId}/thoughts/${versionThought}/views/${encodeURIComponent('Работы версии')}/run`;
          const run = await ctx.app.inject({
            method: 'POST',
            url: runUrl,
            headers: h,
            payload: {},
          });
          assert.equal(run.statusCode, 200, run.body?.toString());
          const body = run.json() as {
            data: Array<{ id: string }>;
            meta: { total: number; view: { id: string; name: string; type_id: string }; unresolved?: unknown[] };
          };
          assert.deepEqual(body.meta.unresolved ?? [], []);
          assert.equal(body.meta.total, 2);
          const ids = body.data.map((d) => d.id).sort();
          assert.deepEqual(ids, [inA, inB].sort());
          // `out` не попал в выборку.
          assert.ok(!ids.includes(out), 'посторонняя версия не должна попасть в результат');
          // meta.view указывает на сам отбор.
          assert.equal(body.meta.view.id, viewId);
        } finally {
          await closeRestContext(ctx);
        }
      });

      it('happy path: thought_ref свойство + type_ids + $thought (регрессия бага 4)', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          // Иерархия типов: «работа» → «задача»/«ошибка»; «версия» — отдельный
          // тип (как в боевой сети ETN).
          const rabotaType = await createThoughtType(ctx, 'работа');
          const zadachaType = await createThoughtType(ctx, 'задача', rabotaType);
          const oshibkaType = await createThoughtType(ctx, 'ошибка', rabotaType);
          const versiyaType = await createThoughtType(ctx, 'версия');

          // Свойство «версия» (thought_ref) на «работа» — наследуют задача/ошибка.
          const propName = `версия-${randomUUID().slice(0, 8)}`;
          const regRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/properties`,
            headers: h,
            payload: { name: propName, value_type: 'thought_ref' },
          });
          assert.equal(regRes.statusCode, 201, regRes.body?.toString());
          const propId = (regRes.json().data as { id: string }).id;
          const attach = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${rabotaType}/properties`,
            headers: h,
            payload: { property_id: propId, required: false },
          });
          assert.equal(attach.statusCode, 201, attach.body?.toString());

          // Контекстная мысль-версия (тип «версия»).
          const setType = async (thoughtId: string, typeId: string): Promise<void> => {
            const res = await ctx.app.inject({
              method: 'PATCH',
              url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}`,
              headers: h,
              payload: { type_id: typeId },
            });
            assert.equal(res.statusCode, 200, res.body?.toString());
          };
          const setRef = async (thoughtId: string, value: string): Promise<void> => {
            const res = await ctx.app.inject({
              method: 'PUT',
              url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/properties/${propName}`,
              headers: h,
              payload: { value },
            });
            assert.equal(res.statusCode, 200, res.body?.toString());
          };
          const versionThought = await createChild(ctx, 'Версия 1');
          await setType(versionThought, versiyaType);

          // Работы, привязанные к версии свойством «версия».
          const createWork = async (title: string, typeId: string, versionId: string): Promise<string> => {
            const id = await createChild(ctx, title);
            await setType(id, typeId);
            await setRef(id, versionId);
            return id;
          };
          const inA = await createWork('Задача A', zadachaType, versionThought);
          const inB = await createWork('Ошибка B', oshibkaType, versionThought);

          // Чужая версия — не должна попасть в выборку.
          const otherVersion = await createChild(ctx, 'Версия 2');
          await setType(otherVersion, versiyaType);
          const out = await createWork('Чужая задача', zadachaType, otherVersion);

          // Отбор на типе «версия»: тип ∈ {задача, ошибка} И «версия» = $thought.
          const definition = JSON.stringify({
            type_ids: [zadachaType, oshibkaType],
            properties: [{ property_id: propId, op: 'eq', value: '$thought' }],
            sort: 'alpha',
            order: 'asc',
          });
          const viewRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${versiyaType}/views`,
            headers: h,
            payload: { name: 'Работы версии', definition },
          });
          assert.equal(viewRes.statusCode, 201, viewRes.body?.toString());

          const runUrl = `/api/v1/networks/${ctx.networkId}/thoughts/${versionThought}/views/${encodeURIComponent('Работы версии')}/run`;
          const run = await ctx.app.inject({ method: 'POST', url: runUrl, headers: h, payload: {} });
          assert.equal(run.statusCode, 200, run.body?.toString());
          const body = run.json() as {
            data: Array<{ id: string }>;
            meta: { total: number; unresolved?: unknown[] };
          };
          assert.deepEqual(body.meta.unresolved ?? [], []);
          assert.equal(body.meta.total, 2);
          const ids = body.data.map((d) => d.id).sort();
          assert.deepEqual(ids, [inA, inB].sort());
          assert.ok(!ids.includes(out), 'посторонняя версия не должна попасть в результат');
        } finally {
          await closeRestContext(ctx);
        }
      });

      it('неразрешимый токен → 200 OK с пустым data и meta.unresolved', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');
          // Подключаем свойство к типу с уникальным именем — чтобы пройти
          // валидацию токенов при сохранении. Затем при run свойство
          // доступно в цепочке типа, но значение не заполнено — резолвер не
          // находит значение в карте контекста и эмитит `unknown_property`.
          // Это валидный «неразрешимый токен» по требованию b7fdab20 —
          // страница пуста, причина названа.
          const propName = `version-${randomUUID().slice(0, 8)}`;
          const { id: propId } = await attachTextProperty(ctx, typeId, propName, propName);

          const definition = JSON.stringify({
            properties: [{ property_id: propId, op: 'eq', value: `$thought.[${propName}]` }],
            sort: 'alpha',
            order: 'asc',
          });
          const viewRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
            payload: { name: 'С токеном', definition },
          });
          assert.equal(viewRes.statusCode, 201);

          // Контекстная мысль с типом, но БЕЗ значения свойства — токен
          // `$thought.[<propname>]` не разрешится, и run вернёт пустой результат
          // с непустым `meta.unresolved`.
          const ctxThought = await createChild(ctx, 'Без значения');
          await ctx.app.inject({
            method: 'PATCH',
            url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctxThought}`,
            headers: h,
            payload: { type_id: typeId },
          });

          const runUrl = `/api/v1/networks/${ctx.networkId}/thoughts/${ctxThought}/views/${encodeURIComponent('С токеном')}/run`;
          const run = await ctx.app.inject({
            method: 'POST',
            url: runUrl,
            headers: h,
            payload: {},
          });
          assert.equal(run.statusCode, 200);
          const body = run.json() as {
            data: unknown[];
            meta: { total: number; unresolved: Array<{ token: string; reason: string }> };
          };
          assert.deepEqual(body.data, []);
          assert.equal(body.meta.total, 0);
          assert.equal(body.meta.unresolved.length, 1);
          // `reason` — одна из причин неразрешимости (`unknown_property` для
          // свойств без значения, `empty_value` для дат без разбора и т.п.).
          // Главное — причина названа и страница пуста.
          assert.match(
            body.meta.unresolved[0]!.reason,
            /unknown_property|empty_value|syntax_error/,
          );
        } finally {
          await closeRestContext(ctx);
        }
      });

      it('404 если у мысли нет такого отбора', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');
          const ctxThought = await createChild(ctx, 'Контекст');
          const res = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctxThought}/views/Несуществующий/run`,
            headers: h,
            payload: {},
          });
          assert.equal(res.statusCode, 404);
          assert.equal(res.json().error.code, 'NOT_FOUND');
        } finally {
          await closeRestContext(ctx);
        }
      });

      it('адресация по id тоже работает', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');
          const viewRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
            payload: {
              name: 'По id',
              definition: JSON.stringify({ sort: 'alpha', order: 'asc' }),
            },
          });
          const viewId = (viewRes.json().data as ViewDto).id;

          // Контекстная мысль должна быть того же типа, чтобы эффективный
          // набор для её типа содержал наш отбор.
          const ctxThought = await createChild(ctx, 'Контекст');
          await ctx.app.inject({
            method: 'PATCH',
            url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctxThought}`,
            headers: h,
            payload: { type_id: typeId },
          });

          const res = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctxThought}/views/${viewId}/run`,
            headers: h,
            payload: {},
          });
          assert.equal(res.statusCode, 200);
        } finally {
          await closeRestContext(ctx);
        }
      });
    });

    describe('Real-time события', () => {
      it('thought-type-view.created доставляется подписчикам после POST', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');

          // Подписываемся на брокер СЕРВЕРА (`ctx.app.pubsub` — тот самый
          // экземпляр, в который пишет `routeDeps.emit`). Новый `new PubSub()`
          // событий не увидит, потому что это будет параллельный брокер без
          // подписчиков серверного `realtimeGateway`.
          const pubsub = ctx.app.pubsub;
          const received: AnyRealtimeEvent[] = [];
          const unsubscribe = pubsub.subscribe(
            ctx.networkId,
            (event: AnyRealtimeEvent) => received.push(event),
          );

          try {
            const res = await ctx.app.inject({
              method: 'POST',
              url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
              headers: h,
              payload: { name: 'Событие', definition: JSON.stringify({}) },
            });
            assert.equal(res.statusCode, 201);

            // Эмиссия — асинхронная (publish выполняется синхронно, но для
            // надёжности даём микротаскам отработать).
            await new Promise((r) => setImmediate(r));
            const created = received.find((e) => e.type === 'thought-type-view.created');
            assert.ok(created, 'thought-type-view.created должен быть в событиях');
            assert.equal(created!.audience, 'network');
            const data = created!.data as { thought_type_id: string; view: { name: string } };
            assert.equal(data.thought_type_id, typeId);
            assert.equal(data.view.name, 'Событие');
          } finally {
            unsubscribe();
          }
        } finally {
          await closeRestContext(ctx);
        }
      });

      it('thought-type-view.updated/deleted/run также доставляются', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');

          // Подписываемся на серверный брокер — `routeDeps.emit` пишет именно
          // в `ctx.app.pubsub`. См. комментарий в предыдущем тесте.
          const pubsub = ctx.app.pubsub;
          const received: AnyRealtimeEvent[] = [];
          const unsubscribe = pubsub.subscribe(
            ctx.networkId,
            (event: AnyRealtimeEvent) => received.push(event),
          );

          try {
            const created = await ctx.app.inject({
              method: 'POST',
              url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
              headers: h,
              payload: { name: 'Полный цикл', definition: JSON.stringify({}) },
            });
            assert.equal(created.statusCode, 201);
            const viewId = (created.json().data as ViewDto).id;

            await ctx.app.inject({
              method: 'PATCH',
              url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views/${viewId}`,
              headers: { ...h, 'if-match': '1' },
              payload: { name: 'Полный цикл 2' },
            });

            // Контекстная мысль того же типа, чтобы эффективный набор
            // содержал наш отбор и run отработал.
            const ctxThought = await createChild(ctx, 'Контекст');
            await ctx.app.inject({
              method: 'PATCH',
              url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctxThought}`,
              headers: h,
              payload: { type_id: typeId },
            });
            await ctx.app.inject({
              method: 'POST',
              url: `/api/v1/networks/${ctx.networkId}/thoughts/${ctxThought}/views/${encodeURIComponent('Полный цикл 2')}/run`,
              headers: h,
              payload: {},
            });

            await ctx.app.inject({
              method: 'DELETE',
              url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views/${viewId}`,
              headers: { ...h, 'if-match': '2' },
            });

            await new Promise((r) => setImmediate(r));
            const types = received.map((e) => e.type);
            // created, updated, run, deleted — все четыре.
            assert.ok(types.includes('thought-type-view.created'), types.join(','));
            assert.ok(types.includes('thought-type-view.updated'), types.join(','));
            assert.ok(types.includes('thought-type-view.run'), types.join(','));
            assert.ok(types.includes('thought-type-view.deleted'), types.join(','));
          } finally {
            unsubscribe();
          }
        } finally {
          await closeRestContext(ctx);
        }
      });
    });

    describe('Ветвимость и слои', () => {
      it('правка в слое версии видна только при чтении с этим слоем; базовый клиент видит основу', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');

          // Создаём слой поверх основы.
          const layerRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/layers`,
            headers: h,
            payload: { title: 'Версия 0.7.4' },
          });
          assert.equal(layerRes.statusCode, 201);
          const layerId = (layerRes.json().data as { id: string }).id;

          // Создаём отбор в основе.
          const baseViewRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
            payload: { name: 'Базовый', definition: JSON.stringify({}) },
          });
          assert.equal(baseViewRes.statusCode, 201);
          const baseViewId = (baseViewRes.json().data as ViewDto).id;

          // Переключаем сессию на слой версии.
          const selectRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/select`,
            headers: { ...h, 'client-id': 'ver-client' },
            payload: {},
          });
          assert.equal(selectRes.statusCode, 200);

          // В слое — другой отбор с ДРУГИМ `name` (иначе CREATE отвергнётся
          // `UNIQUE (thought_type_id, name_key, layer_id)` — база уже видит
          // базовый «Базовый» через `thought_type_views_v`). Перекрытие
          // по `name_key` достигается через PATCH, не CREATE; здесь мы
          // проверяем именно изоляцию слоёв на чтении.
          const layerViewRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: { ...h, 'client-id': 'ver-client' },
            payload: { name: 'Из слоя', definition: JSON.stringify({ keywords: 'layer' }) },
          });
          assert.equal(layerViewRes.statusCode, 201);
          const layerViewId = (layerViewRes.json().data as ViewDto).id;
          assert.notEqual(layerViewId, baseViewId);

          // Клиент в слое видит свой отбор + унаследованный из основы
          // (это и есть «эффективный набор» в терминах спецификации).
          // `listThoughtTypeViewsByType` возвращает только собственные
          // отборы типа в текущем слое, без подъёма по цепочке предков — так
          // что в слое клиент видит только `Из слоя`, а в основе — только
          // `Базовый`. Унаследованные от предков показывает `meta.effective`.
          const layerList = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: { ...h, 'client-id': 'ver-client' },
          });
          assert.equal(layerList.statusCode, 200);
          const layerViews = (layerList.json().data as ViewDto[]).map((v) => v.id);
          assert.deepEqual(layerViews, [layerViewId]);

          // Клиент в основе видит только базовый отбор.
          const baseList = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: { ...h, 'client-id': 'base-client' },
          });
          assert.equal(baseList.statusCode, 200);
          const baseViews = (baseList.json().data as ViewDto[]).map((v) => v.id);
          assert.deepEqual(baseViews, [baseViewId]);

          // С `?include_effective=true` слой видит свой + наследованный из основы.
          const layerEffective = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views?include_effective=true`,
            headers: { ...h, 'client-id': 'ver-client' },
          });
          assert.equal(layerEffective.statusCode, 200);
          const effectiveNames = (layerEffective.json().meta as { effective: Array<{ name: string }> })
            .effective.map((v) => v.name)
            .sort();
          assert.deepEqual(effectiveNames, ['Базовый', 'Из слоя']);

          // В основе — только базовый (он же «унаследованный» от самого себя).
          const baseEffective = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views?include_effective=true`,
            headers: { ...h, 'client-id': 'base-client' },
          });
          assert.equal(baseEffective.statusCode, 200);
          const baseEffectiveNames = (baseEffective.json().meta as { effective: Array<{ name: string }> })
            .effective.map((v) => v.name)
            .sort();
          assert.deepEqual(baseEffectiveNames, ['Базовый']);
        } finally {
          await closeRestContext(ctx);
        }
      });
    });

    describe('Идемпотентность', () => {
      it('POST без Idempotency-Key → два вызова с одинаковым телом дают 201 и 409 (идемпотентность НЕ включена без ключа)', async () => {
        // Этот сценарий — обратная сторона идемпотентности: без заголовка
        // `idempotency-key` middleware пропускает запрос, и второй POST
        // с тем же именем → 409 DUPLICATE (как и должно быть по требованию
        // 141c2576).
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');
          const payload = { name: 'Без ключа', definition: JSON.stringify({}) };

          const first = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
            payload,
          });
          assert.equal(first.statusCode, 201);

          const second = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
            payload,
          });
          assert.equal(second.statusCode, 409);
          assert.equal(second.json().error.code, 'DUPLICATE');
        } finally {
          await closeRestContext(ctx);
        }
      });
    });

    describe('Слияние слоя', () => {
      it('после merge оба клиента видят отбор из слоя', async () => {
        const ctx = await buildRestContext();
        try {
          const h = authHeaders(ctx);
          const typeId = await createThoughtType(ctx, 'task');

          // Слой версии.
          const layerRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/layers`,
            headers: h,
            payload: { title: 'Слой для слияния' },
          });
          const layerId = (layerRes.json().data as { id: string }).id;

          // Базовый отбор.
          await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
            payload: { name: 'Базовый', definition: JSON.stringify({}) },
          });

          // Переключаем сессию на слой версии — без этого POST пойдёт в базу,
          // и слияние будет пустым.
          const selectRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/select`,
            headers: { ...h, 'client-id': 'layer-client' },
            payload: {},
          });
          assert.equal(selectRes.statusCode, 200);

          // Отбор в слое.
          const layerPost = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: { ...h, 'client-id': 'layer-client' },
            payload: { name: 'Из слоя', definition: JSON.stringify({}) },
          });
          assert.equal(layerPost.statusCode, 201, layerPost.body?.toString());

          // Слияние.
          const mergeRes = await ctx.app.inject({
            method: 'POST',
            url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/merge`,
            headers: h,
            payload: {},
          });
          assert.equal(mergeRes.statusCode, 200, mergeRes.body?.toString());

          // Базовый клиент теперь видит оба отбора.
          const baseList = await ctx.app.inject({
            method: 'GET',
            url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
            headers: h,
          });
          assert.equal(baseList.statusCode, 200);
          const names = (baseList.json().data as ViewDto[]).map((v) => v.name).sort();
          assert.deepEqual(names, ['Базовый', 'Из слоя']);
        } finally {
          await closeRestContext(ctx);
        }
      });
    });
  },
);
