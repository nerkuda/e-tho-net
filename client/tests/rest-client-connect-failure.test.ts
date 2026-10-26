/**
 * Структурная причина сетевого отказа в `RestClient` (ошибки 390e9746,
 * 69790006).
 *
 * Диалог подключения не должен угадывать причину по тексту исключения:
 * транспорт различает её сам и кладёт в `details` ошибки
 * (`{ kind: 'connect-failed', reason }`). Тест фиксирует распознавание
 * реальных форм отказа Node/undici (системный код в `cause` и живые пробы:
 * мёртвый порт, несуществующий хост, молчащий сервер, сброс сокета, обрыв
 * тела уже начатого ответа) и честный `other`, когда причина неразличима.
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

function makeClient(fetchImpl: typeof fetch, baseUrl = 'http://127.0.0.1:19777'): RestClient {
  return new RestClient({
    baseUrl,
    getApiKey: async () => 'etn_testkey',
    getClientId: () => '11111111-1111-1111-1111-111111111111',
    fetchImpl,
    random: () => 0,
  });
}

/**
 * Сервер, который отдаёт ЗАГОЛОВКИ и обрывает тело (69790006): объявлен
 * `Content-Length: 100`, фактически уходит 8 байт тела, затем сокет
 * разрушается. `fetch` в этом случае уже вернул `Response` — ошибка приходит
 * из чтения тела (`TypeError: terminated`), а не из установки соединения.
 */
async function startTruncatedBodyServer(status = '200 OK'): Promise<ProbeServer> {
  return startProbeServer((socket) => {
    socket.once('data', () => {
      socket.write(
        `HTTP/1.1 ${status}\r\n` +
          'Content-Type: application/json\r\n' +
          'Content-Length: 100\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          '{"data":',
        () => setTimeout(() => socket.destroy(), 40),
      );
    });
  });
}

/**
 * `fetch`, тело ответа которого рвётся при чтении — форма реального обрыва
 * undici (`TypeError: terminated`, cause `UND_ERR_SOCKET` «other side closed»).
 * Нужен для методов, читающих тело в обход JSON-конверта (байты/HTML).
 */
function brokenBodyFetch(cause?: Error): typeof fetch {
  const error =
    cause ??
    Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
  return (() =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(error);
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )) as typeof fetch;
}

/** Утверждения нормализованного обрыва тела: EtnError + причина + без огрызков. */
function assertBodyBreak(err: unknown): true {
  assert.ok(err instanceof EtnError, `ожидался EtnError, получено ${String(err)}`);
  assert.equal(err.code, 'INTERNAL');
  assert.deepEqual(err.details, { kind: 'connect-failed', reason: 'reset' });
  assert.match(err.message, /соединение сброшено сервером/);
  assert.doesNotMatch(err.message, /terminated|other side closed/i);
  return true;
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
    // Терминальный обрыв без причины (69790006): причина не выдумывается.
    assert.equal(classifyConnectFailure(new TypeError('terminated')), 'other');
  });

  it('вложенная цепочка cause: fetch failed → terminated → UND_ERR_SOCKET — reset', () => {
    // Обрыв тела (69790006) приходит именно так: внешняя ошибка чтения тела,
    // внутри — причина сокета. Классификатор обязан пройти всю цепочку.
    const socket = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const terminated = Object.assign(new TypeError('terminated'), { cause: socket });
    const failed = Object.assign(new TypeError('fetch failed'), { cause: terminated });
    assert.equal(classifyConnectFailure(failed), 'reset');
  });

  it('обрыв тела по объявленному Content-Length — reset', () => {
    // Живая форма 69790006 в undici: сервер объявил Content-Length, но закрыл
    // соединение раньше — `ResponseContentLengthMismatchError`
    // (`UND_ERR_RES_CONTENT_LENGTH_MISMATCH`). Это обрыв тела, не «other».
    const cause = Object.assign(
      new Error('Response body length does not match content-length header'),
      { code: 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH' },
    );
    const err = Object.assign(new TypeError('terminated'), { cause });
    assert.equal(classifyConnectFailure(err), 'reset');
  });

  it('оборванное chunked-тело (HPE_INVALID_EOF_STATE) — reset', () => {
    const cause = Object.assign(
      new Error('Response does not match the HTTP/1.1 protocol (Invalid EOF state)'),
      { code: 'HPE_INVALID_EOF_STATE' },
    );
    const err = Object.assign(new TypeError('terminated'), { cause });
    assert.equal(classifyConnectFailure(err), 'reset');
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

describe('RestClient: обрыв тела ответа после заголовков (69790006)', () => {
  it('живой сервер: 200 + Content-Length 100, 8 байт тела, сокет разрушен → reset', async () => {
    // Точное доказательство карточки: заголовки получены, тело оборвано.
    // До фикса здесь был сырой `TypeError: terminated` без details.
    const server = await startTruncatedBodyServer();
    try {
      const client = makeClient(fetch, `http://127.0.0.1:${server.port}`);
      await assert.rejects(client.getMe(), assertBodyBreak);
    } finally {
      await server.close();
    }
  });

  it('обрыв тела у ответа с ошибкой (404) нормализуется так же', async () => {
    // Тело читается ДО разбора статуса — обрыв не должен подменяться
    // «HTTP 404: <обрывок>» и не должен терять причину.
    const server = await startTruncatedBodyServer('404 Not Found');
    try {
      const client = makeClient(fetch, `http://127.0.0.1:${server.port}`);
      await assert.rejects(client.getMe(), assertBodyBreak);
    } finally {
      await server.close();
    }
  });

  it('requestRaw (GET /health) идёт через ту же нормализацию', async () => {
    const server = await startTruncatedBodyServer();
    try {
      const client = makeClient(fetch, `http://127.0.0.1:${server.port}`);
      await assert.rejects(client.getHealth(), assertBodyBreak);
    } finally {
      await server.close();
    }
  });

  it('обрыв тела без различимой причины — общий текст, без «terminated»', async () => {
    // Нераспознанная причина честно уходит в `other`; технический огрызок
    // чтения тела в сообщение не попадает.
    const client = makeClient(brokenBodyFetch(new TypeError('terminated')));
    await assert.rejects(client.getMe(), (err: unknown) => {
      assert.ok(err instanceof EtnError, `ожидался EtnError, получено ${String(err)}`);
      assert.deepEqual(err.details, { kind: 'connect-failed', reason: 'other' });
      assert.doesNotMatch(err.message, /terminated|other side closed/i);
      assert.match(err.message, /не удалось определить причину отказа/);
      return true;
    });
  });

  // Чтения тела в обход JSON-конверта (байты/HTML) — тот же класс обрыва.
  const rawReaders: Array<[string, (client: RestClient) => Promise<unknown>]> = [
    ['getAttachmentRaw', (client) => client.getAttachmentRaw('net1', 'C:\\data\\file.png')],
    ['downloadJob', (client) => client.downloadJob('job-1')],
    ['downloadServerLogFile', (client) => client.downloadServerLogFile('server.log')],
    ['getPublicationPrintHtml', (client) => client.getPublicationPrintHtml('net1', 'pub-1')],
  ];
  for (const [name, read] of rawReaders) {
    it(`${name}: обрыв тела → EtnError connect-failed/reset`, async () => {
      const client = makeClient(brokenBodyFetch());
      await assert.rejects(read(client), assertBodyBreak);
    });
  }
});
