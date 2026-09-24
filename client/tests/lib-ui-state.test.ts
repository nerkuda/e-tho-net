/**
 * Селекторы поверх store — реактивная основа списков (задача 60fcc702,
 * требование 628d33ee, компонент ebe5e19f).
 *
 * Чистые юнит-тесты без DOM: модуль `lib/ui/state.ts` — функция над снимком
 * store, поэтому jsdom не нужен (тесты идут на голом Node + node:test).
 * Проверяется контракт подписки: немедленный вызов, структурное сравнение
 * среза (пересобранный равный срез не будит), вызов на изменении, отписка,
 * `immediate: false`, свой `equals`, `selectMany` и примитивы `deepEqual`.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { store } from '../src/renderer/state.js';
import {
  deepEqual,
  select,
  selectMany,
  type StateSelector,
} from '../src/renderer/lib/ui/state.js';

/** Сброс полей, которые трогают тесты (store — синглтон на весь процесс). */
beforeEach(() => {
  store.update({ pins: [], showInactive: false, showTrash: true, theme: 'light' });
});

describe('select — подписка на срез store (60fcc702)', () => {
  it('зовёт fn сразу с текущим срезом при подписке', () => {
    store.update({ pins: ['a', 'b'] });
    const seen: string[][] = [];
    const off = select(
      (s) => s.pins,
      (pins) => seen.push([...pins]),
    );
    try {
      assert.deepEqual(seen, [['a', 'b']], 'подписка обязана сразу отдать текущий срез');
    } finally {
      off();
    }
  });

  it('не зовёт fn на апдейте, не меняющем срез', () => {
    let calls = 0;
    const off = select(
      (s) => s.pins,
      () => {
        calls++;
      },
    );
    try {
      assert.equal(calls, 1, 'немедленный вызов');
      store.update({ theme: 'dark' });
      store.update({ selection: ['x'] });
      assert.equal(calls, 1, 'посторонние апдейты срез не меняют — fn не зовётся');
    } finally {
      off();
    }
  });

  it('структурное сравнение: пересобранный РАВНЫЙ срез не будит fn', () => {
    let calls = 0;
    const off = select(
      // Новый массив на каждом перевычислении — сравнение по ссылке здесь
      // ложно сработало бы.
      (s) => [s.showInactive, s.showTrash],
      () => {
        calls++;
      },
    );
    try {
      assert.equal(calls, 1);
      store.update({ theme: 'dark' });
      store.update({ selection: ['x'] });
      assert.equal(calls, 1, 'структурно равный срез не должен будить подписчика');
    } finally {
      off();
    }
  });

  it('зовёт fn, когда срез изменился', () => {
    const seen: boolean[][] = [];
    const off = select(
      (s) => [s.showInactive, s.showTrash],
      (value) => seen.push(value),
    );
    try {
      store.update({ showInactive: true });
      assert.equal(seen.length, 2, 'изменение среза — вызов');
      assert.deepEqual(seen[1], [true, true]);
      // Новый равный срез после изменения значения — молчание.
      store.update({ theme: 'dark' });
      assert.equal(seen.length, 2);
    } finally {
      off();
    }
  });

  it('отписка прекращает вызовы', () => {
    let calls = 0;
    const off = select(
      (s) => s.showInactive,
      () => {
        calls++;
      },
    );
    assert.equal(calls, 1);
    off();
    store.update({ showInactive: true });
    assert.equal(calls, 1, 'после отписки fn не зовётся');
  });

  it('immediate:false не зовёт fn при подписке, но зовёт на изменении', () => {
    let calls = 0;
    const off = select(
      (s) => s.showTrash,
      () => {
        calls++;
      },
      { immediate: false },
    );
    try {
      assert.equal(calls, 0, 'без immediate подписка молчит');
      store.update({ showTrash: false });
      assert.equal(calls, 1);
    } finally {
      off();
    }
  });

  it('options.equals заменяет сравнение среза', () => {
    let calls = 0;
    const off = select(
      (s) => ({ active: s.showInactive }),
      () => {
        calls++;
      },
      // Свой компаратор: считаем любые два объекта равными.
      { equals: () => true },
    );
    try {
      assert.equal(calls, 1);
      store.update({ showInactive: true });
      assert.equal(calls, 1, 'равенство задаёт потребитель, а не deepEqual');
    } finally {
      off();
    }
  });
});

describe('selectMany — подписка на несколько срезов (60fcc702)', () => {
  it('зовёт fn значениями кортежа и только на реальном изменении', () => {
    const seen: Array<[number, boolean]> = [];
    const off = selectMany(
      [(s) => s.pins.length, (s) => s.showTrash],
      (count, showTrash) => {
        seen.push([count, showTrash]);
      },
    );
    try {
      assert.deepEqual(seen, [[0, true]], 'немедленный вызов со всеми срезами');
      store.update({ theme: 'dark' });
      assert.equal(seen.length, 1, 'посторонний апдейт — молчание');
      store.update({ pins: ['a'] });
      assert.equal(seen.length, 2);
      assert.deepEqual(seen[1], [1, true], 'fn получает значения кортежа');
    } finally {
      off();
    }
  });

  it('отписка selectMany прекращает вызовы', () => {
    let calls = 0;
    const off = selectMany(
      [(s) => s.showInactive, (s) => s.showTrash],
      () => {
        calls++;
      },
    );
    assert.equal(calls, 1);
    off();
    store.update({ showInactive: true });
    assert.equal(calls, 1);
  });
});

describe('deepEqual — структурное равенство (60fcc702)', () => {
  it('примитивы, массивы и вложенные объекты', () => {
    assert.equal(deepEqual(1, 1), true);
    assert.equal(deepEqual(NaN, NaN), true);
    assert.equal(deepEqual('a', 'b'), false);
    assert.equal(deepEqual([1, [2, 3]], [1, [2, 3]]), true);
    assert.equal(deepEqual([1, 2], [2, 1]), false);
    assert.equal(deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }), true);
    assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(deepEqual({ a: 1 }, { b: 1 }), false);
  });

  it('Set, Map и Date', () => {
    assert.equal(deepEqual(new Set([1, 2]), new Set([2, 1])), true);
    assert.equal(deepEqual(new Set([1]), new Set([1, 2])), false);
    assert.equal(deepEqual(new Map([['a', 1]]), new Map([['a', 1]])), true);
    assert.equal(deepEqual(new Map([['a', 1]]), new Map([['a', 2]])), false);
    assert.equal(deepEqual(new Date(5), new Date(5)), true);
    assert.equal(deepEqual(new Date(5), new Date(6)), false);
  });

  it('разные типы не равны', () => {
    assert.equal(deepEqual([], {}), false);
    assert.equal(deepEqual(null, {}), false);
    assert.equal(deepEqual(1, '1'), false);
  });
});

describe('select — типизация селектора (60fcc702)', () => {
  it('селектор типизирован снимком AppState', () => {
    const selector: StateSelector<boolean> = (s) => s.showInactive;
    const values: boolean[] = [];
    const off = select(selector, (v) => values.push(v));
    try {
      assert.deepEqual(values, [false]);
    } finally {
      off();
    }
  });
});
