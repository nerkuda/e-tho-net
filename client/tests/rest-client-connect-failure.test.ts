/**
 * Структурная причина сетевого отказа в `RestClient` (ошибка 390e9746).
 *
 * Диалог подключения не должен угадывать причину по тексту исключения:
 * транспорт различает её сам и кладёт в `details` ошибки
 * (`{ kind: 'connect-failed', reason }`). Тест фиксирует распознавание
 * реальных форм отказа Node/undici (системный код в `cause` и живые пробы:
 * мёртвый порт, несуществующий хост, молчащий сервер, сброс сокета) и честный
 * `other`, когда причина неразличима.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import { RestClient, classifyConnectFailure } from '../src/main/net/rest-client.js';

/** fetch, который всегда падает заданной ошибкой. */
function failingFetch(err: unknown): typeof fetch {
  return (() => Promise.reject(err)) as typeof fetch;
}

/** Ошибка undici: `TypeError: fetch failed` с системным кодом в `cause`. */
function fetchFailedWithCode(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:19777`), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

/** Локальный сервер на свободном порту: порт и гарантированная остановка. */
interface ProbeServer {
  port: number;
  close: () => Promise<void>;
}

/** Поднимает TCP-сервер на свободном порту; `onSocket` задаёт поведение. */
async function startProbeServer(onSocket: (socket: net.Socket) => void): Promise<ProbeServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    onSocket(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'адрес локального сервера');
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Ошибка отказа `fetch`; успешный ответ — провал теста (ожидался отказ). */
async function fetchFailure(url: string, init?: RequestInit): Promise<unknown> {
  try {
    await fetch(url, init);
  } catch (err) {
    return err;
  }
  assert.fail(`ожидался отказ подключения: ${url}`);
}

function makeClient(fetchImpl: typeof fetch): RestClient {
  return new RestClient({
    baseUrl: 'http://127.0.0.1:19777',
    getApiKey: async () => 'etn_testkey',
    getClientId: () => '11111111-1111-1111-1111-111111111111',
    fetchImpl,
    random: () => 0,
  });
}

describe('classifyConnectFailure: различимые причины (390e9746)', () => {
  it('системный код распознаётся в цепочке cause', () => {
    assert.equal(classifyConnectFailure(fetchFailedWithCode('ECONNREFUSED')), 'refused');
    assert.equal(classifyConnectFailure(fetchFailedWithCode('ENOTFOUND')), 'dns');
    assert.equal(classifyConnectFailure(fetchFailedWithCode('EAI_AGAIN')), 'dns');
    assert.equal(classifyConnectFailure(fetchFailedWithCode('ENETUNREACH')), 'unreachable');
    assert.equal(classifyConnectFailure(fetchFailedWithCode('EHOSTUNREACH')), 'unreachable');
    assert.equal(classifyConnectFailure(fetchFailedWithCode('ECONNRESET')), 'reset');
    assert.equal(classifyConnectFailure(fetchFailedWithCode('ETIMEDOUT')), 'timeout');
  });

  it('сброс соединения undici (UND_ERR_SOCKET «other side closed») — reset', () => {
    // Реальная форма отказа: fetch падает `TypeError: fetch failed`, причина —
    // undici SocketError с кодом UND_ERR_SOCKET (ошибки 2edf8494, 390e9746).
    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    assert.equal(classifyConnectFailure(err), 'reset');
  });

  it('прочие сокетные сбои UND_ERR_SOCKET — честный other, а не выдуманный сброс', () => {
    const cause = Object.assign(new Error('socket write failed'), { code: 'UND_ERR_SOCKET' });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    assert.equal(classifyConnectFailure(err), 'other');
  });

  it('унаследованные ключи карты причин не становятся причиной', () => {
    // `code` приходит из чужих ошибок: `toString`/`__proto__` не должны
    // подставлять функцию/объект вместо причины (класс ошибки 2edf8494).
    assert.equal(classifyConnectFailure(fetchFailedWithCode('toString')), 'other');
    assert.equal(classifyConnectFailure(fetchFailedWithCode('__proto__')), 'other');
    assert.equal(classifyConnectFailure(fetchFailedWithCode('hasOwnProperty')), 'other');
  });

  it('собственный таймаут (причина отмены без кода) — timeout', () => {
    assert.equal(classifyConnectFailure(new Error('ETN response timeout')), 'timeout');
  });

  it('неразличимый сбой — честный other, без выдуманной причины', () => {
    assert.equal(classifyConnectFailure(new Error('boom')), 'other');
    assert.equal(classifyConnectFailure(undefined), 'other');
    assert.equal(classifyConnectFailure({ code: 42 }), 'other');
  });
});

describe('classifyConnectFailure: реальные формы отказа undici (390e9746)', () => {
  it('мёртвый порт (сервер закрыт) → refused', async () => {
    const server = await startProbeServer(() => {});
    const { port } = server;
    await server.close();
    const err = await fetchFailure(`http://127.0.0.1:${port}/api/v1/health`);
    assert.equal(classifyConnectFailure(err), 'refused');
  });

  it('несуществующий хост → dns', async () => {
    const err = await fetchFailure('http://etn-390e9746-no-such-host.invalid:19777/api/v1/health', {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(classifyConnectFailure(err), 'dns');
  });

  it('сервер принимает соединение и молчит → timeout', async () => {
    const server = await startProbeServer(() => {});
    try {
      const err = await fetchFailure(`http://127.0.0.1:${server.port}/api/v1/health`, {
        signal: AbortSignal.timeout(250),
      });
      assert.equal(classifyConnectFailure(err), 'timeout');
    } finally {
      await server.close();
    }
  });

  it('сервер разрушает сокет после запроса → reset', async () => {
    // Решение заказчика: сброс установленного соединения — самостоятельная
    // причина, а не общая «other». undici отдаёт `fetch failed` с причиной
    // SocketError `other side closed` (UND_ERR_SOCKET).
    const server = await startProbeServer((socket) => {
      socket.once('data', () => socket.destroy());
    });
    try {
      const err = await fetchFailure(`http://127.0.0.1:${server.port}/api/v1/health`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(classifyConnectFailure(err), 'reset');
    } finally {
      await server.close();
    }
  });
});

describe('RestClient: причина отказа едет в details (390e9746)', () => {
  it('ECONNREFUSED после повторов → INTERNAL + connect-failed/refused', async () => {
    const client = makeClient(failingFetch(fetchFailedWithCode('ECONNREFUSED')));
    await assert.rejects(client.getMe(), (err: unknown) => {
      assert.ok(err instanceof EtnError, `ожидался EtnError, получено ${String(err)}`);
      assert.equal(err.code, 'INTERNAL');
      assert.deepEqual(err.details, { kind: 'connect-failed', reason: 'refused' });
      return true;
    });
  });

  it('таймаут → connect-failed/timeout', async () => {
    const client = makeClient(failingFetch(new Error('ETN response timeout')));
    await assert.rejects(client.getMe(), (err: unknown) => {
      assert.ok(err instanceof EtnError);
      assert.deepEqual(err.details, { kind: 'connect-failed', reason: 'timeout' });
      return true;
    });
  });
});
