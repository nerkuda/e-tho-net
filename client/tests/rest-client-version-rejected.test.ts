/**
 * `426 CLIENT_VERSION_UNSUPPORTED` в середине сессии (задача 12fd5b0e,
 * требование 4d3be6ca): сервер отклонил изменяющий запрос desktop-клиента вне
 * своего диапазона. RestClient обязан сообщить main-процессу о отказе —
 * канонический код конверта или HTTP 426 в неканоническом ответе, — причём
 * без повторов: второй попытки быть не должно.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError, type ClientVersionErrorDetails } from '@etn/shared';

import { RestClient } from '../src/main/net/rest-client.js';

const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_VERSION = '0.15.1';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(responses: Array<{ status: number; body?: unknown }>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let cursor = 0;
  const fetchStub = ((url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    const canned = responses[Math.min(cursor, responses.length - 1)]!;
    cursor++;
    const textBody =
      canned.body === undefined
        ? ''
        : typeof canned.body === 'string'
          ? canned.body
          : JSON.stringify(canned.body);
    const response = {
      ok: canned.status >= 200 && canned.status < 300,
      status: canned.status,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve(textBody),
      json: () => Promise.resolve(canned.body === undefined ? undefined : JSON.parse(textBody)),
    } as unknown as Response;
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { fetch: fetchStub, calls };
}

interface Harness {
  client: RestClient;
  calls: FetchCall[];
  rejections: Array<ClientVersionErrorDetails | null>;
}

function makeClient(responses: Array<{ status: number; body?: unknown }>): Harness {
  const { fetch, calls } = makeFetch(responses);
  const rejections: Array<ClientVersionErrorDetails | null> = [];
  const client = new RestClient({
    baseUrl: 'http://localhost:3000',
    getApiKey: async () => 'etn_testkey',
    getClientId: () => CLIENT_ID,
    clientVersion: CLIENT_VERSION,
    fetchImpl: fetch,
    random: () => 0,
    onClientVersionUnsupported: (details) => rejections.push(details),
  });
  return { client, calls, rejections };
}

const DETAILS: ClientVersionErrorDetails = {
  reason: 'version-out-of-range',
  server_version: '0.15.2',
  client_version: CLIENT_VERSION,
  compatibility: '>=0.15.2 <0.16.0',
  download_url: 'https://github.com/nerkuda/e-tho-net/releases/tag/v0.15.2',
};

describe('RestClient — 426 CLIENT_VERSION_UNSUPPORTED (12fd5b0e)', () => {
  it('канонический конверт: сообщает details и не повторяет запрос', async () => {
    const h = makeClient([
      {
        status: 426,
        body: {
          error: {
            code: 'CLIENT_VERSION_UNSUPPORTED',
            message: 'Клиент несовместим с сервером',
            details: DETAILS,
            request_id: 'req-1',
          },
        },
      },
    ]);

    await assert.rejects(
      h.client.getMe(),
      (err: unknown) =>
        err instanceof EtnError &&
        err.code === 'CLIENT_VERSION_UNSUPPORTED' &&
        err.message === 'Клиент несовместим с сервером',
    );
    assert.deepEqual(h.rejections, [DETAILS]);
    assert.equal(h.calls.length, 1, 'повторной попытки нет');
  });

  it('неканонический 426: сообщает null, отказ всё равно распознан', async () => {
    const h = makeClient([{ status: 426, body: 'Upgrade Required' }]);

    await assert.rejects(
      h.client.getMe(),
      (err: unknown) => err instanceof EtnError && err.code === 'CLIENT_VERSION_UNSUPPORTED',
    );
    assert.deepEqual(h.rejections, [null]);
    assert.equal(h.calls.length, 1);
  });

  it('details без reason считаются неканоническими (null)', async () => {
    const h = makeClient([
      {
        status: 426,
        body: {
          error: {
            code: 'CLIENT_VERSION_UNSUPPORTED',
            message: 'nope',
            details: { server_version: '0.15.2' },
          },
        },
      },
    ]);
    await assert.rejects(h.client.getMe());
    assert.deepEqual(h.rejections, [null]);
  });

  it('другие ошибки и успешные ответы хук не дёргают', async () => {
    const h = makeClient([
      {
        status: 409,
        body: { error: { code: 'VERSION_CONFLICT', message: 'Конфликт версий' } },
      },
      { status: 200, body: { data: { id: 'user-1' } } },
    ]);
    await assert.rejects(h.client.getMe());
    assert.deepEqual(h.rejections, []);
    await h.client.getMe();
    assert.deepEqual(h.rejections, []);
  });
});
