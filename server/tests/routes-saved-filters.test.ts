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

import type { SavedFilter, SavedFilterDefinition } from '@etn/shared';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  type RestTestContext,
} from './rest-helpers.js';

/** Минимальное валидное определение отбора «Структур» (sort/order обязательны). */
const STRUCTURE_DEFINITION = { sort: 'alpha', order: 'asc' } satisfies SavedFilterDefinition;

/** Минимальное валидное определение отбора «Хроники» (order обязателен). */
const CHRONICLE_DEFINITION = { order: 'desc' };

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
});
