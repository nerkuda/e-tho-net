/**
 * Коалессирующая очередь realtime-событий (задача afcfb144, уровень 3
 * тех.проекта `1d48df6d`): очередь окна дебаунса применяется ОДНИМ батчем,
 * fallback-событие отменяет батч и зовёт полный путь.
 *
 * Таймеры окна виртуальные (мок `node:test`): порядок «внутри окна / на
 * границе окна» задаётся точными тиками, а не задержками реального
 * event loop. Иначе под нагрузкой тест был нестабилен (ошибка 3d9164c3):
 * `await wait(10)` мог не уложиться в окно 20 мс.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import { createRealtimeBatch } from '../src/renderer/lib/realtime-batch.js';

/**
 * Подменить таймеры `window` глобальными — модуль зовёт `window.setTimeout`,
 * а мок `node:test` патчит только `globalThis`. Проброс динамический, поэтому
 * замоканный `setTimeout` подхватывается в момент вызова, а после теста
 * восстанавливается сам.
 */
function shimTimers(): void {
  const g = globalThis as any;
  const win = (g.window ?? (g.window = {})) as Record<string, unknown>;
  win.setTimeout = (...args: unknown[]) => g.setTimeout(...args);
  win.clearTimeout = (...args: unknown[]) => g.clearTimeout(...args);
}

/** Виртуальные таймеры окна: тест не зависит от загрузки машины. */
function useFakeTimers(t: TestContext): void {
  shimTimers();
  t.mock.timers.enable({ apis: ['setTimeout'] });
}

describe('realtime-batch: одно применение на окно дебаунса (afcfb144)', () => {
  it('события окна применяются одним батчем, не по одному', (t) => {
    useFakeTimers(t);
    const batches: string[][] = [];
    let fulls = 0;
    const batch = createRealtimeBatch<string>({
      windowMs: 10,
      applyBatch: (ops) => batches.push([...ops]),
      applyFull: () => {
        fulls += 1;
      },
    });

    batch.push('a');
    batch.push('b');
    batch.push('c');
    assert.equal(batch.pending, 3, 'события накоплены в окне');

    t.mock.timers.tick(9);
    assert.deepEqual(batches, [], 'окно 10 мс ещё не истекло');
    t.mock.timers.tick(1);

    assert.deepEqual(batches, [['a', 'b', 'c']], 'один вызов с тремя событиями');
    assert.equal(fulls, 0);
  });

  it('fallback-событие окна отменяет батч и зовёт полный путь', (t) => {
    useFakeTimers(t);
    const batches: string[][] = [];
    let fulls = 0;
    const batch = createRealtimeBatch<string>({
      windowMs: 10,
      applyBatch: (ops) => batches.push([...ops]),
      applyFull: () => {
        fulls += 1;
      },
    });

    batch.push('a');
    batch.markFull();
    t.mock.timers.tick(9);
    assert.deepEqual(batches, [], 'окно ещё не истекло');
    t.mock.timers.tick(1);

    assert.deepEqual(batches, [], 'батч отброшен — перезапрос важнее экономии');
    assert.equal(fulls, 1);
  });

  it('новое событие отодвигает окно (trailing debounce)', (t) => {
    useFakeTimers(t);
    const batches: string[][] = [];
    const batch = createRealtimeBatch<string>({
      windowMs: 20,
      applyBatch: (ops) => batches.push([...ops]),
      applyFull: () => undefined,
    });

    batch.push('a'); // дедлайн окна 20
    t.mock.timers.tick(10); // 10 — окно ещё живо
    batch.push('b'); // дедлайн продлён до 30
    t.mock.timers.tick(19); // 29 — старый дедлайн 20 обязан молчать
    assert.deepEqual(batches, [], 'окно продлено: применения пока нет');
    t.mock.timers.tick(1); // 30 — поток затих на 20 мс

    assert.deepEqual(batches, [['a', 'b']], 'пока поток не затих — применения нет');
  });

  it('следующее окно применяется отдельно', (t) => {
    useFakeTimers(t);
    const batches: string[][] = [];
    const batch = createRealtimeBatch<string>({
      windowMs: 10,
      applyBatch: (ops) => batches.push([...ops]),
      applyFull: () => undefined,
    });

    batch.push('a');
    t.mock.timers.tick(10);
    assert.deepEqual(batches, [['a']], 'первое окно применилось');
    batch.push('b');
    t.mock.timers.tick(10);

    assert.deepEqual(batches, [['a'], ['b']]);
  });
});
