/**
 * Коалессирующая очередь realtime-событий (задача afcfb144, уровень 3
 * тех.проекта `1d48df6d`): очередь окна дебаунса применяется ОДНИМ батчем,
 * fallback-событие отменяет батч и зовёт полный путь.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRealtimeBatch } from '../src/renderer/lib/realtime-batch.js';

function shimTimers(): void {
  const win = ((globalThis as any).window ?? ((globalThis as any).window = {})) as Record<
    string,
    unknown
  >;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('realtime-batch: одно применение на окно дебаунса (afcfb144)', () => {
  it('события окна применяются одним батчем, не по одному', async () => {
    shimTimers();
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
    await wait(30);

    assert.deepEqual(batches, [['a', 'b', 'c']], 'один вызов с тремя событиями');
    assert.equal(fulls, 0);
  });

  it('fallback-событие окна отменяет батч и зовёт полный путь', async () => {
    shimTimers();
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
    await wait(30);

    assert.deepEqual(batches, [], 'батч отброшен — перезапрос важнее экономии');
    assert.equal(fulls, 1);
  });

  it('новое событие отодвигает окно (trailing debounce)', async () => {
    shimTimers();
    const batches: string[][] = [];
    const batch = createRealtimeBatch<string>({
      windowMs: 20,
      applyBatch: (ops) => batches.push([...ops]),
      applyFull: () => undefined,
    });

    batch.push('a');
    await wait(10);
    batch.push('b');
    await wait(40);

    assert.deepEqual(batches, [['a', 'b']], 'пока поток не затих — применения нет');
  });

  it('следующее окно применяется отдельно', async () => {
    shimTimers();
    const batches: string[][] = [];
    const batch = createRealtimeBatch<string>({
      windowMs: 10,
      applyBatch: (ops) => batches.push([...ops]),
      applyFull: () => undefined,
    });

    batch.push('a');
    await wait(25);
    batch.push('b');
    await wait(25);

    assert.deepEqual(batches, [['a'], ['b']]);
  });
});
