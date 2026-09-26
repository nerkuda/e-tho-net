/**
 * Сторожа панели выделенных (ошибка 3a64e680).
 *
 * Симптом: при пролистывании длинного списка потомков на карте панель
 * выделенных мигала, а имена выделенных мыслей на несколько секунд подменялись
 * их id. Причина — панель подписывалась на весь store и на каждое событие
 * (в т.ч. посторонние для выделения апдейты фокуса/секторов) полностью
 * пересобирала список, а на время асинхронного resolve подставляла id.
 *
 * Здесь проверяются два инварианта фикса:
 *  1. узкая подписка панели (срез `selection`) не срабатывает на посторонние
 *     обновления магазина (счётчик рендеров);
 *  2. неразрешённое имя строки НИКОГДА не рисуется как id.
 *
 * Чистая логика разницы/подписей живёт в `lib/pure.ts` и импортируется сюда же.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { store } from '../src/renderer/state.js';
import { planSelectionRows, selectionRowTitles } from '../src/renderer/lib/pure.js';
import { subscribeSelectionChanges } from '../src/renderer/selection/selection.js';

beforeEach(() => {
  store.update({ selection: [] });
});

describe('planSelectionRows — разница состава выделения (3a64e680)', () => {
  it('убирает пропавшие id и отдаёт новый порядок', () => {
    const plan = planSelectionRows(['a', 'b', 'c'], ['c', 'a', 'd']);
    assert.deepEqual(plan.removed, ['b']);
    assert.deepEqual(plan.order, ['c', 'a', 'd']);
  });

  it('пустое прежнее выделение — ничего не убирает', () => {
    const plan = planSelectionRows([], ['x', 'y']);
    assert.deepEqual(plan.removed, []);
    assert.deepEqual(plan.order, ['x', 'y']);
  });

  it('одинаковый состав — пустая разница', () => {
    const plan = planSelectionRows(['a', 'b'], ['b', 'a']);
    assert.deepEqual(plan.removed, []);
    assert.deepEqual(plan.order, ['b', 'a']);
  });
});

describe('selectionRowTitles — имя строки никогда не id (3a64e680)', () => {
  it('разрешённая мысль — её имя', () => {
    const titles = selectionRowTitles(
      ['a'],
      new Map([['a', { title: 'Персоны' }]]),
      new Map(),
    );
    assert.equal(titles.get('a'), 'Персоны');
  });

  it('неразрешённое имя без прежней подписи — пустая строка, а не id', () => {
    const titles = selectionRowTitles(['11111111-2222-3333-4444-555555555555'], new Map(), new Map());
    assert.equal(titles.get('11111111-2222-3333-4444-555555555555'), '');
  });

  it('неразрешённое имя сохраняет прежнюю подпись', () => {
    const titles = selectionRowTitles(['b'], new Map(), new Map([['b', 'Роли']]));
    assert.equal(titles.get('b'), 'Роли');
  });
});

describe('подписка панели выделенных (3a64e680)', () => {
  it('событие пагинации не вызывает перерисовку панели выделенных', () => {
    store.update({ selection: ['a', 'b'] });
    let renders = 0;
    // Панель подписывается на срез `selection` ровно так — тем же API.
    const off = subscribeSelectionChanges(() => {
      renders++;
    });
    try {
      assert.equal(renders, 1, 'немедленный рендер при подписке');
      // Догрузка длинных списков и прочие посторонние обновления магазина:
      // ответы фокуса, порядок зон, статус реального времени, масштаб.
      store.update({ focus: null });
      store.update({ zoneOrder: { parents: [], children: [] } });
      store.update({ canvasZoom: 1.05 });
      store.update({ lastEvent: 'изменена мысль' });
      store.update({ showInactive: true });
      assert.equal(renders, 1, 'посторонние апдейты панель не перерисовывают');
    } finally {
      off();
    }
  });

  it('изменение состава выделения перерисовывает панель ровно раз', () => {
    let renders = 0;
    const off = subscribeSelectionChanges(() => {
      renders++;
    });
    try {
      assert.equal(renders, 1);
      store.update({ selection: ['a', 'b', 'c'] });
      assert.equal(renders, 2);
      // Пересобранный РАВНЫЙ список — не повод рисовать (структурное сравнение).
      store.update({ selection: ['a', 'b', 'c'] });
      assert.equal(renders, 2);
    } finally {
      off();
    }
  });
});
