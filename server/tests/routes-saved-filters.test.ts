/**
 * Route-level regression for named saved filters
 * (`GET/POST/PATCH/DELETE /networks/:networkId/saved-filters`, операция API
 * `/saved-filters — именованные отборы «Структур» и «Хроники»`).
 *
 * Ошибка 0a8b9da3 (релиз 0.8.2): контракт `RestSavedFilterCreateBody` требовал
 * `view` в теле POST, тогда как спецификация объявляет его необязательным
 * (`{ view?, name, definition }`, по умолчанию `structures`), а чтение (GET) и
 * правка (PATCH) принимают `view?`. Клиент «Структур» слал `{ name, definition }`
 * без вида, и запись отбивалась `VALIDATION_ERROR «Недопустимый view»` — при том,
 * что чтение списка с тем же адресом работало. Тест бьёт по роуту целиком:
 * POST без `view` обязан создавать отбор вида `structures`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FilterAst, SavedFilter, SavedFilterDefinition } from '@etn/shared';
import { FILTER_AST_VERSION } from '@etn/shared';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  createPlainUser,
  type RestTestContext,
} from './rest-helpers.js';

/** Минимальное валидное определение отбора «Структур» (sort/order обязательны). */
const STRUCTURE_DEFINITION = { sort: 'alpha', order: 'asc' } satisfies SavedFilterDefinition;

/** Минимальное валидное определение отбора «Хроники» (order обязателен). */
const CHRONICLE_DEFINITION = { order: 'desc' };

/** Минимальное валидное определение «Событий»: AST профиля `events` (0.13.3). */
const EVENTS_DEFINITION: FilterAst = {
  version: FILTER_AST_VERSION,
  filter: {
    op: 'and',
    children: [
      { entity: { kind: 'action' }, operator: 'in', value: ['created', 'updated'] },
      { entity: { kind: 'user' }, operator: 'eq', value: 'u-1' },
    ],
  },
};

/** Определение «Структур» в форме AST (её пишет единый редактор, задача 46eba874). */
const AST_DEFINITION: FilterAst = {
  version: FILTER_AST_VERSION,
  filter: {
    op: 'and',
    children: [{ entity: { kind: 'type' }, operator: 'in', value: ['t-1'] }],
  },
  sort: [{ key: 'created_at', order: 'desc' }],
};

/** POST /saved-filters с произвольным телом. */
async function postFilter(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; data?: SavedFilter; error?: { code: string; details?: unknown } }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/saved-filters`,
    headers: authHeaders(ctx),
    payload,
  });
  const json = res.json() as {
    data?: SavedFilter;
    error?: { code: string; details?: unknown };
  };
  return { statusCode: res.statusCode, data: json.data, error: json.error };
}

describe('POST /networks/:networkId/saved-filters', () => {
  it('без view создаёт отбор «Структур» (регрессия обязательного view)', async (t) => {
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const created = await postFilter(ctx, {
      name: 'Все женщины',
      definition: STRUCTURE_DEFINITION,
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.error));
    assert.equal(created.data?.view, 'structures', 'вид по умолчанию — structures');
    assert.equal(created.data?.name, 'Все женщины');
  });

  it('с view=chronicle создаёт отбор «Хроники», с view=structures — «Структур»', async (t) => {
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const chronicle = await postFilter(ctx, {
      view: 'chronicle',
      name: 'Хроника за неделю',
      definition: CHRONICLE_DEFINITION,
    });
    assert.equal(chronicle.statusCode, 201, JSON.stringify(chronicle.error));
    assert.equal(chronicle.data?.view, 'chronicle');

    const structures = await postFilter(ctx, {
      view: 'structures',
      name: 'Все персоны',
      definition: STRUCTURE_DEFINITION,
    });
    assert.equal(structures.statusCode, 201, JSON.stringify(structures.error));
    assert.equal(structures.data?.view, 'structures');
  });

  it('структурный отбор в форме AST принимается и возвращается как есть (задача 46eba874)', async (t) => {
    // Панель «Структур» пишет определение в форме AST (единый редактор дерева,
    // `buildFilterAst`); прежде форма принимала только плоское `definition v1` и
    // отвергала AST (`VALIDATION_ERROR «Недопустимый sort»`) — «Сохранить» в
    // панели не срабатывало. Теперь обе формы допустимы.
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const created = await postFilter(ctx, { name: 'AST-отбор', definition: AST_DEFINITION });
    assert.equal(created.statusCode, 201, JSON.stringify(created.error));
    assert.deepEqual(
      created.data?.definition,
      AST_DEFINITION,
      'AST сохранён без потерь (version/filter/sort)',
    );

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters?view=structures`,
      headers: authHeaders(ctx),
    });
    assert.equal(list.statusCode, 200);
    const rows = list.json().data as Array<{ name: string; definition: unknown }>;
    assert.deepEqual(rows.find((r) => r.name === 'AST-отбор')?.definition, AST_DEFINITION);
  });

  it('недопустимый view — 422 VALIDATION_ERROR, без записи', async (t) => {
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const bad = await postFilter(ctx, {
      view: 'timeline',
      name: 'Кривой вид',
      definition: STRUCTURE_DEFINITION,
    });
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.error?.code, 'VALIDATION_ERROR');

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters`,
      headers: authHeaders(ctx),
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().data, [], 'отбор с кривым видом не сохранён');
  });

  it('повтор имени в пределах вида — 409 DUPLICATE', async (t) => {
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    await postFilter(ctx, { name: 'Все персоны', definition: STRUCTURE_DEFINITION });
    const dup = await postFilter(ctx, { name: 'все ПЕРСОНЫ', definition: STRUCTURE_DEFINITION });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.error?.code, 'DUPLICATE');
  });
});

describe('GET/PATCH /networks/:networkId/saved-filters', () => {
  it('список по умолчанию — «Структуры»; перезапись по имени без view сохраняет вид', async (t) => {
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const created = await postFilter(ctx, {
      name: 'Все персоны',
      definition: STRUCTURE_DEFINITION,
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.error));
    const id = created.data!.id;

    // GET без view = structures (обратная совместимость).
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters`,
      headers: authHeaders(ctx),
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      (list.json().data as SavedFilter[]).map((f) => f.id),
      [id],
      'отбор «Структур» виден в списке без view',
    );

    // PATCH без view — «сохранить под именем» из строки отбора: имя и определение.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters/${id}`,
      headers: authHeaders(ctx),
      payload: { name: 'Все женщины', definition: { sort: 'alpha', order: 'desc' } },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    const patchedData = patched.json().data as SavedFilter;
    assert.equal(patchedData.name, 'Все женщины');
    assert.equal(patchedData.view, 'structures', 'вид при правке не меняется');
    assert.equal((patchedData.definition as { order?: string }).order, 'desc');
  });

  it('view разделяет списки: хронику не видно в «Структурах» и наоборот', async (t) => {
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    await postFilter(ctx, { name: 'Все персоны', definition: STRUCTURE_DEFINITION });
    await postFilter(ctx, {
      view: 'chronicle',
      name: 'Хроника за неделю',
      definition: CHRONICLE_DEFINITION,
    });

    const structures = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters?view=structures`,
      headers: authHeaders(ctx),
    });
    const chronicle = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters?view=chronicle`,
      headers: authHeaders(ctx),
    });
    assert.deepEqual(
      (structures.json().data as SavedFilter[]).map((f) => f.name),
      ['Все персоны'],
    );
    assert.deepEqual(
      (chronicle.json().data as SavedFilter[]).map((f) => f.name),
      ['Хроника за неделю'],
    );
  });

  // Стандарт «запись каждого view одного REST-контракта покрыта тестом»
  // (задача c85e53ec): `RestSavedFilterPatchBody.view` — тоже вид с двумя
  // значениями; PATCH обязан принимать и structures, и chronicle, разбирая
  // definition парсером выбранного вида.
  it('PATCH с явным view сохраняет отбор своего вида', async (t) => {
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const structures = await postFilter(ctx, {
      view: 'structures',
      name: 'Все персоны',
      definition: STRUCTURE_DEFINITION,
    });
    const chronicle = await postFilter(ctx, {
      view: 'chronicle',
      name: 'Хроника за неделю',
      definition: CHRONICLE_DEFINITION,
    });
    assert.equal(structures.statusCode, 201, JSON.stringify(structures.error));
    assert.equal(chronicle.statusCode, 201, JSON.stringify(chronicle.error));

    const patchStructures = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters/${structures.data!.id}`,
      headers: authHeaders(ctx),
      payload: { view: 'structures', definition: { sort: 'alpha', order: 'asc' } },
    });
    assert.equal(patchStructures.statusCode, 200, patchStructures.body);
    const patchedStructures = patchStructures.json().data as SavedFilter;
    assert.equal(patchedStructures.view, 'structures');
    assert.equal((patchedStructures.definition as { sort?: string }).sort, 'alpha');

    const patchChronicle = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters/${chronicle.data!.id}`,
      headers: authHeaders(ctx),
      payload: { view: 'chronicle', definition: { order: 'asc' } },
    });
    assert.equal(patchChronicle.statusCode, 200, patchChronicle.body);
    const patchedChronicle = patchChronicle.json().data as SavedFilter;
    assert.equal(patchedChronicle.view, 'chronicle');
    assert.equal((patchedChronicle.definition as { order?: string }).order, 'asc');
  });
});

describe('saved-filters view=events («События», 0.13.3, задача c0c7b834)', () => {
  it('с view=events создаёт отбор «Событий» и снимает сортировку', async (t) => {
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const withSort: FilterAst = {
      ...EVENTS_DEFINITION,
      sort: [{ key: 'created_at', order: 'desc' }],
    };
    const created = await postFilter(ctx, {
      view: 'events',
      name: 'Мои действия',
      definition: withSort,
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.error));
    assert.equal(created.data?.view, 'events');
    const definition = created.data?.definition as FilterAst;
    assert.equal(definition.version, FILTER_AST_VERSION);
    assert.deepEqual(definition.filter, EVENTS_DEFINITION.filter);
    assert.equal(definition.sort, undefined, 'сортировка профилю ленты не принадлежит и не сохраняется');

    // Список вида содержит отбор; имя уникально в пределах вида.
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters?view=events`,
      headers: authHeaders(ctx),
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      (list.json().data as Array<{ name: string }>).map((f) => f.name),
      ['Мои действия'],
    );
  });

  it('GET view=events разделяет списки: отборы «Событий» не видны в других местах', async (t) => {
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    await postFilter(ctx, { view: 'events', name: 'Действия', definition: EVENTS_DEFINITION });
    await postFilter(ctx, { name: 'Мысли', definition: STRUCTURE_DEFINITION });
    await postFilter(ctx, {
      view: 'chronicle',
      name: 'Записи',
      definition: CHRONICLE_DEFINITION,
    });

    const read = async (view?: string): Promise<string[]> => {
      const url =
        view === undefined
          ? `/api/v1/networks/${ctx.networkId}/saved-filters`
          : `/api/v1/networks/${ctx.networkId}/saved-filters?view=${view}`;
      const res = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(ctx) });
      assert.equal(res.statusCode, 200, res.body);
      return (res.json().data as Array<{ name: string }>).map((f) => f.name);
    };

    assert.deepEqual(await read('events'), ['Действия']);
    assert.deepEqual(await read('structures'), ['Мысли']);
    assert.deepEqual(await read('chronicle'), ['Записи']);
    assert.deepEqual(await read(), ['Мысли'], 'GET без view — по-прежнему structures');
  });

  it('PATCH определяет вид по сохранённой строке (view=events)', async (t) => {
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const events = await postFilter(ctx, {
      view: 'events',
      name: 'Действия',
      definition: EVENTS_DEFINITION,
    });
    assert.equal(events.statusCode, 201, JSON.stringify(events.error));

    // Тело говорит `structures` и несёт плоскую структуру — если бы вид брался
    // из тела, определение разобрал бы парсер «Структур». Сохранённая строка —
    // events, поэтому определение разбирается профилем `events`, и `view`
    // остаётся events.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters/${events.data!.id}`,
      headers: authHeaders(ctx),
      payload: { view: 'structures', definition: EVENTS_DEFINITION },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    const data = patched.json().data as { view: string; definition: FilterAst };
    assert.equal(data.view, 'events', 'вид не меняется и берётся из сохранённой строки');
    assert.deepEqual(data.definition.filter, EVENTS_DEFINITION.filter);

    // Тело говорит `chronicle` — если бы вид брался из тела, парсер «Хроники»
    // потребовал бы `order` и запись отбилась бы 422.
    const again = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters/${events.data!.id}`,
      headers: authHeaders(ctx),
      payload: { view: 'chronicle', definition: EVENTS_DEFINITION },
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal((again.json().data as { view: string }).view, 'events');
  });

  it('events отвергает чужую форму определения и операнд вне профиля', async (t) => {
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    // Форма «Структур» (`sort`/`order`) и форма «Хроники» (`order`) — не AST.
    for (const definition of [STRUCTURE_DEFINITION, CHRONICLE_DEFINITION]) {
      const bad = await postFilter(ctx, {
        view: 'events',
        name: 'Кривая форма',
        definition,
      });
      assert.equal(bad.statusCode, 422, JSON.stringify(bad.error));
      assert.equal(bad.error?.code, 'VALIDATION_ERROR');
    }

    // Операнд мыслей (`type`) в ленте не виден — профиль `events` отвергает.
    const foreign: FilterAst = {
      version: FILTER_AST_VERSION,
      filter: { op: 'and', children: [{ entity: { kind: 'type' }, operator: 'in', value: ['t-1'] }] },
    };
    const rejected = await postFilter(ctx, {
      view: 'events',
      name: 'Чужой операнд',
      definition: foreign,
    });
    assert.equal(rejected.statusCode, 422, JSON.stringify(rejected.error));
    assert.equal(rejected.error?.code, 'VALIDATION_ERROR');

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters?view=events`,
      headers: authHeaders(ctx),
    });
    assert.deepEqual(list.json().data, [], 'ни одна кривая запись не сохранена');
  });

  it('events: повтор имени внутри вида — 409, одинаковые имена в разных местах разрешены', async (t) => {
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const first = await postFilter(ctx, {
      view: 'events',
      name: 'Действия',
      definition: EVENTS_DEFINITION,
    });
    assert.equal(first.statusCode, 201, JSON.stringify(first.error));
    const dup = await postFilter(ctx, {
      view: 'events',
      name: 'действия',
      definition: EVENTS_DEFINITION,
    });
    assert.equal(dup.statusCode, 409, JSON.stringify(dup.error));
    assert.equal(dup.error?.code, 'DUPLICATE');

    const otherView = await postFilter(ctx, { name: 'Действия', definition: STRUCTURE_DEFINITION });
    assert.equal(otherView.statusCode, 201, JSON.stringify(otherView.error));
    assert.equal(otherView.data?.view, 'structures');
  });

  it('личная изоляция: чужие отборы «Событий» не видны и не правятся', async (t) => {
    const ctx = await buildRestContext();
    t.after(async () => closeRestContext(ctx));

    const mine = await postFilter(ctx, {
      view: 'events',
      name: 'Мои действия',
      definition: EVENTS_DEFINITION,
    });
    assert.equal(mine.statusCode, 201, JSON.stringify(mine.error));

    const other = createPlainUser(ctx);
    ctx.sys.addNetworkMember(ctx.networkId, other.userId, 'member', ctx.adminId);
    const otherHeaders = { authorization: `Bearer ${other.key}` };

    const list = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters?view=events`,
      headers: otherHeaders,
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.deepEqual(list.json().data, [], 'чужие отборы не видны');

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters/${mine.data!.id}`,
      headers: otherHeaders,
      payload: { name: 'Захват' },
    });
    assert.equal(patch.statusCode, 404, patch.body);
    const remove = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters/${mine.data!.id}`,
      headers: otherHeaders,
    });
    assert.equal(remove.statusCode, 404, remove.body);

    // Своё имя в том же виде другой пользователь может занять — уникальность
    // в пределах пары (пользователь, вид).
    const own = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/networks/${ctx.networkId}/saved-filters`,
      headers: otherHeaders,
      payload: { view: 'events', name: 'Мои действия', definition: EVENTS_DEFINITION },
    });
    assert.equal(own.statusCode, 201, own.body);
  });
});
