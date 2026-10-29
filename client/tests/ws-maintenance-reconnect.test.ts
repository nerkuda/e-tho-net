/**
 * Переподключение при обслуживании сервера — close 1012 (задача 12fd5b0e,
 * требование 610169a5).
 *
 * Политика: шаг 1 с ±0,5 с, не более 12 попыток, затем понятное терминальное
 * состояние `offline` с подробностью `server-maintenance` (без бесконечного
 * цикла). Ручной повтор `forceReconnect` («Повторить»/system resume) выдаёт
 * новый бюджет. Обычный сетевой обрыв (1006) идёт прежней лестницей — её
 * покрывает `ws-client.test.ts`.
 *
 * Сокет настоящий (`ws` на эфемерном порту), таймеры — фейковые: тест
 * проверяет РАСЧЁТ задержки и исчерпание бюджета, не дожидаясь реального
 * времени.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { WebSocketServer, type WebSocket } from 'ws';

import { RealtimeClient } from '../src/main/net/ws-client.js';
import type { LocalDb } from '../src/main/db/local-db.js';

/** In-memory `LocalDb` stub: только `getMeta`/`setMeta` нужны WS-клиенту. */
function makeFakeDb(initial: Record<string, string> = {}): LocalDb {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getMeta: (key: string) => store.get(key) ?? null,
    setMeta: (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as LocalDb;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ждёт выполнения `cond()` (поллинг 10 мс) с дедлайном. */
async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`условие не выполнено за ${ms} мс`);
    }
    await wait(10);
  }
}

interface FakeTimer {
  id: number;
  fn: () => void;
  ms: number;
}

/**
 * Фейковые `setTimeout`/`clearTimeout` с адресуемыми таймерами.
 *
 * `clearTimeout` реально удаляет запись (в отличие от простого массива):
 * клиент гасит таймеры молчания/простоя при каждом закрытии, и без удаления
 * в списке оставались бы «призраки», неотличимые от таймера переподключения.
 */
function makeFakeTimers(): {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  reconnect: () => FakeTimer | undefined;
  all: () => FakeTimer[];
  run: (timer: FakeTimer) => void;
} {
  let nextId = 1;
  const timers = new Map<number, FakeTimer>();
  const setTimeoutStub = ((fn: () => void, ms: number): NodeJS.Timeout => {
    const timer: FakeTimer = { id: nextId++, fn, ms: Number(ms) };
    timers.set(timer.id, timer);
    return { unref: () => undefined, __timerId: timer.id } as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  const clearTimeoutStub = ((handle: unknown): void => {
    const id = (handle as { __timerId?: number } | null)?.__timerId;
    if (typeof id === 'number') timers.delete(id);
  }) as unknown as typeof clearTimeout;
  return {
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
    // Шаг обслуживания — 0…1500 мс; молчание/простой/стабильность в тестах
    // заданы большими значениями и в выборку не попадают.
    reconnect: () => [...timers.values()].find((timer) => timer.ms <= 5_000),
    all: () => [...timers.values()],
    run: (timer: FakeTimer) => {
      timers.delete(timer.id);
      timer.fn();
    },
  };
}

function startServer(): Promise<{
  server: WebSocketServer;
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 });
    server.on('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      // Идемпотентное закрытие: тест может закрыть сервер сам (имитация
      // недоступности), а после него тот же `close` вызывает afterEach.
      let closing: Promise<void> | null = null;
      resolve({
        server,
        url: `ws://127.0.0.1:${port}`,
        close: () => {
          if (closing !== null) return closing;
          for (const ws of server.clients) ws.terminate();
          closing = new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
          return closing;
        },
      });
    });
  });
}

function nextConnection(server: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve) => {
    server.once('connection', (ws) => resolve(ws));
  });
}

const teardowns: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardowns.length) {
    const fn = teardowns.pop()!;
    await fn();
  }
});

function makeClient(
  url: string,
  timers: ReturnType<typeof makeFakeTimers>,
  opts: {
    random?: () => number;
    maintenanceReconnectLimit?: number;
    maintenanceStableMs?: number;
  } = {},
): RealtimeClient {
  const client = new RealtimeClient({
    baseUrl: url,
    getApiKey: async () => 'etn_testkey',
    getClientId: () => 'cid-maintenance',
    getNetworkId: () => 'net1',
    localDb: makeFakeDb({}),
    random: opts.random ?? (() => 0.5),
    maintenanceReconnectLimit: opts.maintenanceReconnectLimit,
    // Всё, кроме переподключения, в тесте не должно «выстреливать».
    maintenanceStableMs: opts.maintenanceStableMs ?? 1_000_000,
    silenceThresholdMs: 1_000_000,
    idleTimeoutMs: 1_000_000,
    offlineAfterMs: 1_000_000,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  teardowns.push(async () => {
    try {
      client.disconnect();
    } catch {
      // best effort
    }
  });
  return client;
}

describe('RealtimeClient — обслуживание сервера (1012, 610169a5)', () => {
  it('шаг 1 с ±0,5 с: random 0.5 → 1000 мс, 0 → 500 мс, 1 → 1500 мс', async () => {
    for (const [random, expected] of [
      [0.5, 1_000],
      [0, 500],
      [1, 1_500],
    ] as const) {
      const { server, url, close } = await startServer();
      teardowns.push(close);
      const timers = makeFakeTimers();
      const conn = nextConnection(server);
      const client = makeClient(url, timers, { random: () => random });
      client.connect();
      const ws = await conn;
      await until(() => client.getStatus() === 'connected');

      ws.close(1012, 'maintenance');
      await until(() => timers.reconnect() !== undefined);
      const scheduled = timers.reconnect()!;
      assert.equal(scheduled.ms, expected, `random()=${random}`);
      assert.equal(client.getStatus(), 'reconnecting');
      assert.equal(client.getStatusDetail(), 'server-maintenance');
      client.disconnect();
      await close();
    }
  });

  it('исчерпав 12 попыток, останавливается в offline/server-maintenance без цикла', async () => {
    const { server, url, close } = await startServer();
    const timers = makeFakeTimers();
    const conn = nextConnection(server);
    const client = makeClient(url, timers);
    client.connect();
    const ws = await conn;
    await until(() => client.getStatus() === 'connected');

    ws.close(1012, 'maintenance');
    // Сервер уходит на обслуживание: дальнейшие попытки не находят его.
    await close();

    let scheduled = 0;
    for (let attempt = 1; attempt <= 12; attempt++) {
      await until(() => timers.reconnect() !== undefined);
      const timer = timers.reconnect()!;
      assert.equal(timer.ms, 1_000, `шаг попытки ${attempt}`);
      scheduled++;
      timers.run(timer);
      if (attempt < 12) {
        // Попытка провалилась (ECONNREFUSED → 1006) — бюджет обслуживания
        // продолжается, а не уходит в бесконечную лестницу.
        await until(() => timers.reconnect() !== undefined);
      }
    }

    await until(() => client.getStatus() === 'offline');
    assert.equal(scheduled, 12, 'ровно 12 попыток');
    assert.equal(client.getStatusDetail(), 'server-maintenance');
    await wait(100);
    assert.equal(timers.reconnect(), undefined, 'новых попыток не планируется');
    assert.equal(client.getStatus(), 'offline');
  });

  it('сервер принимает сокет и снова присылает 1012 — бюджет не обнуляется', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const timers = makeFakeTimers();
    const conn = nextConnection(server);
    const client = makeClient(url, timers);
    client.connect();
    let ws = await conn;
    await until(() => client.getStatus() === 'connected');

    ws.close(1012, 'maintenance');
    for (let attempt = 1; attempt <= 12; attempt++) {
      await until(() => timers.reconnect() !== undefined);
      const timer = timers.reconnect()!;
      assert.ok(
        timer.ms >= 500 && timer.ms <= 1_500,
        `шаг попытки ${attempt}: ${timer.ms}`,
      );
      // Следующий сокет ждём ДО выстрела таймера, иначе соединение успеет
      // открыться до подписки.
      const reconnected = nextConnection(server);
      timers.run(timer);
      ws = await reconnected;
      await until(() => client.getStatus() === 'connected');
      // Короткое соединение: таймер стабильности не успел обнулить эпизод.
      ws.close(1012, 'maintenance');
    }
    await until(() => client.getStatus() === 'offline');
    assert.equal(client.getStatusDetail(), 'server-maintenance');
    assert.equal(timers.reconnect(), undefined, 'бесконечного цикла нет');
  });

  it('10 с стабильного соединения обнуляют бюджет: следующий 1006 идёт обычной задержкой', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const timers = makeFakeTimers();
    const conn = nextConnection(server);
    // random 0.5: обычная fast-лестница = 750 мс, maintenance-шаг = 1000 мс —
    // исход различим по числам, а не только по detail.
    const client = makeClient(url, timers, { maintenanceStableMs: 10_000 });
    client.connect();
    let ws = await conn;
    await until(() => client.getStatus() === 'connected');

    // 1012 → режим обслуживания, попытка №1 через 1 с.
    ws.close(1012, 'maintenance');
    await until(() => timers.reconnect() !== undefined);
    const attempt = timers.reconnect()!;
    assert.equal(attempt.ms, 1_000);
    assert.equal(client.getStatusDetail(), 'server-maintenance');

    // Сервер вернулся: попытка открывает сокет, взводится таймер стабильности.
    const reconnected = nextConnection(server);
    timers.run(attempt);
    ws = await reconnected;
    await until(() => client.getStatus() === 'connected');
    const stable = timers.all().find((timer) => timer.ms === 10_000);
    assert.ok(stable !== undefined, 'в режиме обслуживания взведён таймер стабильности 10 с');

    // 10 с прожили — эпизод обслуживания закрыт.
    timers.run(stable);

    // Обычный сетевой обрыв (1006): прежняя fast-лестница 500–1000 мс (750 при
    // random 0.5), без detail обслуживания. Без сброса бюджета был бы шаг
    // обслуживания 1000 мс и detail `server-maintenance`.
    ws.terminate();
    await until(() => timers.reconnect() !== undefined);
    const ordinary = timers.reconnect()!;
    assert.equal(ordinary.ms, 750, 'после стабильности — обычная задержка');
    assert.equal(client.getStatusDetail(), null, 'режим обслуживания снят');
    assert.equal(client.getStatus(), 'reconnecting');
  });

  it('forceReconnect выдаёт новый бюджет и снимает режим обслуживания', async () => {
    const { server, url, close } = await startServer();
    const timers = makeFakeTimers();
    const conn = nextConnection(server);
    const client = makeClient(url, timers, { maintenanceReconnectLimit: 1 });
    client.connect();
    const ws = await conn;
    await until(() => client.getStatus() === 'connected');

    // Первый 1012 → одна попытка; сервер уже недоступен → предел.
    ws.close(1012, 'maintenance');
    await close();
    await until(() => timers.reconnect() !== undefined);
    timers.run(timers.reconnect()!);
    await until(() => client.getStatus() === 'offline');
    assert.equal(client.getStatusDetail(), 'server-maintenance');

    // Ручной повтор: немедленная попытка, состояние «Переподключение…».
    client.forceReconnect();
    await until(() => timers.reconnect() !== undefined);
    assert.equal(timers.reconnect()!.ms, 0, 'повтор немедленный');
    assert.equal(client.getStatus(), 'reconnecting');
    assert.equal(client.getStatusDetail(), null);
  });

  it('явный disconnect из режима обслуживания отменяет запланированную попытку', async () => {
    const { server, url, close } = await startServer();
    teardowns.push(close);
    const timers = makeFakeTimers();
    const conn = nextConnection(server);
    const client = makeClient(url, timers);
    client.connect();
    const ws = await conn;
    await until(() => client.getStatus() === 'connected');

    ws.close(1012, 'maintenance');
    await until(() => timers.reconnect() !== undefined);
    timers.run(timers.reconnect()!);
    client.disconnect();
    assert.equal(client.getStatus(), 'idle');
    assert.equal(timers.reconnect(), undefined, 'таймер погашен');
  });
});
