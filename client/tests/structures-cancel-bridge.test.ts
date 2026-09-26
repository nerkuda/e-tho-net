/**
 * Сквозная проверка механики отмены выборок через contextBridge
 * (требование ebed4980, ошибка b7cbd0e0).
 *
 * Корень дефекта: `AbortSignal` — host-объект, он НЕ переживает
 * `contextBridge`-сериализацию аргументов и приезжает в preload пустым
 * объектом `{}`; прежний `invokeCancellable` вешал `signal.addEventListener`
 * на этот огрызок и падал `TypeError` на КАЖДОМ запросе с сигналом.
 * Поэтому слушатель `abort` обязан жить в renderer-контексте, где сигнал
 * настоящий, а через мост уходит только примитив `requestId` (плюс
 * fire-and-forget `cancelRequest(requestId)`).
 *
 * Тест намеренно НЕ мокает renderer-фасад напрямую, а поднимает фальшивый
 * мост: каждый аргумент функции, «выставленной» в renderer, проходит
 * структурно-клон-подобную потерю (`bridgeClone`) — так же, как настоящий
 * `contextBridge.exposeInMainWorld`. Фасад при этом берётся настоящий,
 * из `renderer/lib/etn.ts`.
 *
 * Красный до фикса (b7cbd0e0): фасад отдавал `{ signal }` прямо в мост,
 * третий аргумент приезжал объектом, а не строкой `requestId`, и
 * `cancelRequest` не вызывался вовсе.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { etn } from '../src/renderer/lib/etn.js';

/** Минимальный запрос выборки: содержимое фильтра для механики отмены неважно. */
const REQ = { sort: 'alpha', order: 'asc', limit: 10, offset: 0 } as any;

interface BridgeCall {
  networkId: unknown;
  request: unknown;
  requestId: unknown;
}

interface FakeBridge {
  calls: BridgeCall[];
  cancels: string[];
  /** Разрешить текущий приостановленный запрос заданным ответом. */
  resolve(value: unknown): void;
}

/**
 * Модель `contextBridge`-сериализации одного значения: host-объекты вроде
 * `AbortSignal` клонируются в пустой plain-объект (наблюдаемое поведение
 * Electron), массивы/объекты обходятся рекурсивно, примитивы — как есть.
 */
function bridgeClone(value: unknown): unknown {
  if (value instanceof AbortSignal) return {};
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(bridgeClone);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = bridgeClone(v);
  return out;
}

/** Обернуть функцию так, будто её вызвали через мост (аргументы клонируются). */
function acrossBridge<T extends (...args: any[]) => any>(fn: T): T {
  return ((...args: any[]) => fn(...args.map(bridgeClone))) as T;
}

/**
 * Поднять фальшивый мост: `window.etn` получает уже сериализованные функции
 * с примитивным `requestId` вместо сигнала. Возвращает регистратор вызовов.
 */
function installFakeBridge(): FakeBridge {
  const calls: BridgeCall[] = [];
  const cancels: string[] = [];
  let settle: ((value: unknown) => void) | null = null;

  const rawQuery = (networkId: unknown, request: unknown, requestId?: unknown): Promise<unknown> => {
    calls.push({ networkId, request, requestId });
    return new Promise((resolve) => {
      settle = resolve;
    });
  };
  const rawCancel = (requestId: string): void => {
    cancels.push(requestId);
  };

  const bridged = {
    structures: {
      query: acrossBridge(rawQuery),
      queryIds: acrossBridge(rawQuery),
      hierarchy: acrossBridge(async () => ({ parents: [], children: [] })),
      edges: acrossBridge(async () => []),
    },
    cancelRequest: acrossBridge(rawCancel),
  };

  (globalThis as any).window = { etn: bridged };
  return {
    calls,
    cancels,
    resolve: (value: unknown) => settle?.(value),
  };
}

describe('Отмена выборок через contextBridge (ошибка b7cbd0e0)', () => {
  it('AbortSignal теряет методы на мосту — приезжает пустым объектом (корень дефекта)', () => {
    const controller = new AbortController();
    const received = acrossBridge((x: unknown) => x)(controller.signal) as Record<string, unknown>;
    assert.deepEqual(received, {}, 'signal через мост приходит пустым объектом');
    assert.equal(received.addEventListener, undefined, 'метода addEventListener на огрызке нет');
  });

  it('фасад не отправляет signal через мост: третьим аргументом идёт строковый requestId', async () => {
    const bridge = installFakeBridge();
    const controller = new AbortController();

    const promise = etn.structures.query('net-1', REQ, { signal: controller.signal });

    assert.equal(bridge.calls.length, 1, 'вызов дошёл до моста ровно один раз');
    const requestId = bridge.calls[0]!.requestId;
    assert.equal(typeof requestId, 'string', 'через мост уходит примитив requestId, а не сигнал');
    assert.ok((requestId as string).length > 0, 'requestId не пустой');
    assert.equal(bridge.cancels.length, 0, 'без abort отмена не шлётся');

    // Abort в renderer-контексте → fire-and-forget отмена по requestId.
    controller.abort();
    assert.deepEqual(bridge.cancels, [requestId], 'abort превращается в cancelRequest(requestId)');

    bridge.resolve({ items: [], total: 0, directions: {}, next_cursor: null });
    await promise;
  });

  it('заранее отменённый сигнал не уходит в мост и отклоняется AbortError', async () => {
    const bridge = installFakeBridge();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => etn.structures.query('net-1', REQ, { signal: controller.signal }),
      (err: any) => err?.name === 'AbortError',
    );
    assert.equal(bridge.calls.length, 0, 'отменённый до старта запрос в мост не идёт');
  });

  it('после завершения запроса сигнал отписан: abort не шлёт повторную отмену', async () => {
    const bridge = installFakeBridge();
    const controller = new AbortController();

    const promise = etn.structures.query('net-1', REQ, { signal: controller.signal });
    bridge.resolve({ items: [], total: 0, directions: {}, next_cursor: null });
    await promise;

    controller.abort();
    assert.equal(bridge.cancels.length, 0, 'слушатель abort снят после завершения вызова');
  });

  it('вызов без signal остаётся обычным: requestId не передаётся', async () => {
    const bridge = installFakeBridge();
    const promise = etn.structures.query('net-1', REQ);
    assert.equal(bridge.calls.length, 1);
    assert.equal(bridge.calls[0]!.requestId, undefined, 'без signal отменяемость не включается');
    bridge.resolve({ items: [], total: 0, directions: {}, next_cursor: null });
    await promise;
  });

  it('queryIds идёт тем же путём: requestId строкой и отмена по abort', async () => {
    const bridge = installFakeBridge();
    const controller = new AbortController();

    const promise = etn.structures.queryIds('net-1', REQ, { signal: controller.signal });
    const requestId = bridge.calls[0]!.requestId;
    assert.equal(typeof requestId, 'string');

    controller.abort();
    assert.deepEqual(bridge.cancels, [requestId]);

    bridge.resolve({ ids: [], total: 0, next_cursor: null });
    await promise;
  });
});
