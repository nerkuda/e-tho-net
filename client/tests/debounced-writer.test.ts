/**
 * Отложенная запись, переживающая перемонтирование модуля
 * (ошибка 438092f6, замечание верификатора).
 *
 * Контракт:
 *  - ключ (сеть) и payload фиксируются в момент планирования;
 *  - перепланирование схлопывает только записи ОДНОГО ключа;
 *  - отложенная запись чужого ключа не отменяется новым планированием —
 *    настройка, изменённая перед уходом из сети, не теряется.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDebouncedWriter } from '../src/renderer/lib/debounced-writer.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface WriteCall {
  key: string;
  payload: string;
}

describe('отложенная запись переживает смену ключа/монтирования', () => {
  it('«изменил и сразу ушёл»: запись уходит в исходную сеть', async () => {
    const writes: WriteCall[] = [];
    const writer = createDebouncedWriter((key, payload) => writes.push({ key, payload }), 20);

    writer.schedule('A', 'payload-A');
    // Уход из сети/монтирования не отменяет запись: сразу планируется другая сеть.
    writer.schedule('B', 'payload-B');
    await sleep(60);

    assert.deepEqual(
      writes.map((w) => w.key),
      ['A', 'B'],
      'запись сети A не потеряна, сеть B не перезаписана чужой',
    );
    assert.equal(
      writes.find((w) => w.key === 'A')?.payload,
      'payload-A',
      'payload зафиксирован при планировании, а не прочитан позже',
    );
  });

  it('повторные изменения одной сети схлопываются в последнюю запись', async () => {
    const writes: WriteCall[] = [];
    const writer = createDebouncedWriter((key, payload) => writes.push({ key, payload }), 20);

    writer.schedule('A', 'v1');
    writer.schedule('A', 'v2');
    writer.schedule('A', 'v3');
    await sleep(60);

    assert.deepEqual(writes, [{ key: 'A', payload: 'v3' }], 'остаётся только последняя правка этой сети');
  });

  it('новое планирование не срывает уже идущую запись другой сети', async () => {
    const writes: WriteCall[] = [];
    const writer = createDebouncedWriter((key, payload) => writes.push({ key, payload }), 20);

    writer.schedule('A', 'a');
    await sleep(5); // A ещё в полёте
    writer.schedule('B', 'b');
    await sleep(60);

    assert.deepEqual(writes, [
      { key: 'A', payload: 'a' },
      { key: 'B', payload: 'b' },
    ]);
  });

  it('pending отражает наличие несработавшей записи', async () => {
    const writer = createDebouncedWriter(() => undefined, 20);
    assert.equal(writer.hasPending(), false, 'изначально пусто');
    writer.schedule('A', 'x');
    assert.equal(writer.hasPending(), true, 'после планирования — есть');
    await sleep(60);
    assert.equal(writer.hasPending(), false, 'после срабатывания — пусто');
  });
});
