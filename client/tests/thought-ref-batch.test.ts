/**
 * Батчер `thoughts.resolve` затронутых волной id (задача `96d7f05d`).
 *
 * Проверяет: один запрос на окно для всех потребителей, немедленный режим
 * действия пользователя, серверный лимит id на запрос и изоляцию сетей.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';

import type { ThoughtRef } from '@etn/shared';

import {
  __resetThoughtRefBatch,
  resolveThoughtRefs,
} from '../src/renderer/lib/thought-ref-batch.js';
import { REALTIME_REFETCH_MAX_WAIT_MS, REALTIME_REFETCH_WINDOW_MS } from '../src/renderer/lib/live/query-registry.js';

const NET = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000bb';

interface ResolveCall {
  networkId: string;
  ids: string[];
}

let calls: ResolveCall[] = [];

function stubResolve(): void {
  calls = [];
  (globalThis as any).etn = {
    thoughts: {
      resolve: async (networkId: string, ids: string[]): Promise<ThoughtRef[]> => {
        calls.push({ networkId, ids: [...ids] });
        return ids.map((id) => ({ id, title: `T:${id}` }) as ThoughtRef);
      },
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  stubResolve();
});

afterEach(() => {
  __resetThoughtRefBatch();
  delete (globalThis as any).etn;
});

describe('thought-ref-batch (96d7f05d)', () => {
  it('realtime-волна: id всех потребителей уходят одним resolve по окну', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const a = resolveThoughtRefs(NET, ['a', 'b'], { windowed: true });
    const b = resolveThoughtRefs(NET, ['b', 'c'], { windowed: true });

    await flushMicrotasks();
    assert.equal(calls.length, 0, 'до закрытия окна запроса нет');

    t.mock.timers.tick(REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();

    assert.equal(calls.length, 1, 'один запрос на всех потребителей');
    assert.deepEqual(calls[0]!.ids.sort(), ['a', 'b', 'c'], 'id дедуплицированы');
    assert.deepEqual(
      (await a).map((r) => r.id),
      ['a', 'b'],
      'каждый потребитель получает только свои id',
    );
    assert.deepEqual(
      (await b).map((r) => r.id),
      ['b', 'c'],
      'второй потребитель получает свои id',
    );
  });

  it('действие пользователя: запросы схлопываются в микротаске и уходят сразу', async () => {
    const a = resolveThoughtRefs(NET, ['a']);
    const b = resolveThoughtRefs(NET, ['b']);
    assert.equal(calls.length, 0, 'синхронные вызовы ещё не отправлены');

    await flushMicrotasks();
    assert.equal(calls.length, 1, 'оба вызова ушли одним запросом');
    assert.deepEqual(calls[0]!.ids.sort(), ['a', 'b']);
    assert.deepEqual((await a).map((r) => r.id), ['a']);
    assert.deepEqual((await b).map((r) => r.id), ['b']);
  });

  it('серверный лимит: большой набор режется на пакеты', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
    const promise = resolveThoughtRefs(NET, ids);
    await flushMicrotasks();
    assert.equal(calls.length, 2, '150 id → два запроса по лимиту');
    assert.deepEqual(
      calls.map((call) => call.ids.length),
      [100, 50],
      'пакеты не превышают серверный лимит 100',
    );
    assert.equal((await promise).length, 150);
  });

  it('сети не смешиваются в одном окне', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    void resolveThoughtRefs(NET, ['a'], { windowed: true });
    void resolveThoughtRefs(OTHER, ['b'], { windowed: true });
    t.mock.timers.tick(REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();

    assert.equal(calls.length, 2, 'по запросу на сеть');
    assert.deepEqual(
      calls.map((call) => call.networkId).sort(),
      [NET, OTHER].sort(),
    );
  });

  it('непрерывный поток: resolve хотя бы раз за 3 с, финальный проход без дублей', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gapMs = 100;
    const streamMs = 3000;
    // 31 вызов: t = 0, 100, …, 3000 — поток длится ровно 3 с.
    const events = streamMs / gapMs + 1;
    const pending: Promise<ThoughtRef[]>[] = [];
    let elapsed = 0;
    let firstCallAt: number | null = null;

    for (let i = 0; i < events; i += 1) {
      pending.push(resolveThoughtRefs(NET, [`id-${i}`], { windowed: true }));
      if (i < events - 1) {
        t.mock.timers.tick(gapMs);
        elapsed += gapMs;
      }
      await flushMicrotasks();
      if (calls.length > 0 && firstCallAt === null) firstCallAt = elapsed;
    }

    assert.notEqual(firstCallAt, null, 'за непрерывный поток был хотя бы один resolve');
    assert.ok(
      firstCallAt! <= REALTIME_REFETCH_MAX_WAIT_MS,
      `первый resolve не позже maxWait: ${firstCallAt} > ${REALTIME_REFETCH_MAX_WAIT_MS}`,
    );
    const atStop = calls.length;
    assert.ok(
      atStop >= Math.floor(streamMs / REALTIME_REFETCH_MAX_WAIT_MS),
      `поток дал ${atStop} resolve — меньше, чем окон maxWait за 3 с`,
    );

    // После остановки — ровно один финальный проход по накопленной волне.
    t.mock.timers.tick(REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    assert.equal(calls.length, atStop + 1, 'после остановки ровно один финальный resolve');

    // Больше тишины — больше запросов нет: дублей не осталось.
    t.mock.timers.tick(REALTIME_REFETCH_MAX_WAIT_MS + REALTIME_REFETCH_WINDOW_MS);
    await flushMicrotasks();
    assert.equal(calls.length, atStop + 1, 'после финального прохода повторов нет');

    await Promise.all(pending);
  });
});
