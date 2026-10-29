/**
 * Заголовок `Client-Version` во всех запросах {@link RestClient} (задача
 * c3f33e6a, требование 339b507f).
 *
 * Сервер отклоняет изменяющие запросы desktop-клиента без версии или вне
 * `client_compatibility` кодом `426 CLIENT_VERSION_UNSUPPORTED`, поэтому
 * заголовок обязан уходить не только из общего движка запросов, но и из
 * raw-путей (вложения, скачивание джобы, файл журнала, печать публикации) и из
 * публичных `/health`/`/version`. Пропуск любого места здесь — 426 на
 * реальном сервере; статическая сторожевая проверка всех мест сборки заголовков
 * — `guard-rest-client-version-header.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';

import { RestClient } from '../src/main/net/rest-client.js';

const NET = '123e4567-e89b-12d3-a456-426614174000';
const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_VERSION = '0.15.1';

interface FetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Stub `fetch`: каждая запись — URL и init; ответ задаётся тестом как JSON,
 * текст или бинарь. Достаточно для путей, которые разбирают тело сами
 * (`getAttachmentRaw`, `downloadJob`, `downloadServerLogFile`, печать).
 */
function makeFetch(
  responses: Array<{
    status: number;
    body?: unknown;
    binary?: Uint8Array;
    headers?: Record<string, string>;
  }>,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let cursor = 0;
  const fetchStub = ((url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    const canned = responses[Math.min(cursor, responses.length - 1)];
    if (canned === undefined) throw new Error('makeFetch: responses must not be empty');
    cursor++;
    const textBody =
      canned.body === undefined
        ? ''
        : typeof canned.body === 'string'
          ? canned.body
          : JSON.stringify(canned.body);
    const bytes = canned.binary ?? new TextEncoder().encode(textBody);
    const response = {
      ok: canned.status >= 200 && canned.status < 300,
      status: canned.status,
      headers: new Headers(canned.headers ?? { 'content-type': 'application/json' }),
      text: () => Promise.resolve(textBody),
      json: () => Promise.resolve(canned.body === undefined ? undefined : JSON.parse(textBody)),
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    } as unknown as Response;
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { fetch: fetchStub, calls };
}

function makeClient(fetchImpl: typeof fetch): RestClient {
  return new RestClient({
    baseUrl: 'http://localhost:3000',
    getApiKey: async () => 'etn_testkey',
    getClientId: () => CLIENT_ID,
    clientVersion: CLIENT_VERSION,
    fetchImpl,
    random: () => 0,
  });
}

/** Проверяет пару заголовков версии клиента в последнем запросе. */
function assertClientHeaders(call: FetchCall | undefined): void {
  assert.ok(call !== undefined, 'ожидался хотя бы один запрос');
  const headers = new Headers(call.init.headers as HeadersInit);
  assert.equal(headers.get('Client-Id'), CLIENT_ID);
  assert.equal(headers.get('Client-Version'), CLIENT_VERSION);
}

describe('RestClient — Client-Version во всех путях запросов', () => {
  it('общий движок запросов (GET)', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { data: { id: 'u1', username: 'a', display_name: null, is_admin: false } } },
    ]);
    await makeClient(fetch).getMe();
    assertClientHeaders(calls[0]);
  });

  it('изменяющий запрос (POST)', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { data: { id: 't1' } } }]);
    await makeClient(fetch).createThought(NET, { title: 'T' });
    assertClientHeaders(calls[0]);
    assert.equal(new Headers(calls[0]!.init.headers as HeadersInit).get('Content-Type'), 'application/json');
  });

  it('raw-скачивание вложения', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: 'file bytes', headers: { 'content-type': 'text/plain' } },
    ]);
    const res = await makeClient(fetch).getAttachmentRaw(NET, 'notes/a.txt');
    assert.equal(res.contentType, 'text/plain');
    assertClientHeaders(calls[0]);
  });

  it('скачивание результата экспортной джобы', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, binary: Uint8Array.from([1, 2, 3]), headers: { 'content-type': 'application/zip' } },
    ]);
    const res = await makeClient(fetch).downloadJob('job-1');
    assert.equal(res.contentType, 'application/zip');
    assertClientHeaders(calls[0]);
  });

  it('скачивание файла серверного журнала', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: 'log line', headers: { 'content-type': 'text/plain; charset=utf-8' } },
    ]);
    const res = await makeClient(fetch).downloadServerLogFile('2026-10-29.log');
    assert.equal(res.body.toString('utf8'), 'log line');
    assertClientHeaders(calls[0]);
  });

  it('печатный HTML публикации', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: '<html></html>', headers: { 'content-type': 'text/html', 'x-publication-slug': 'doc' } },
    ]);
    const print = await makeClient(fetch).getPublicationPrintHtml(NET, 'pub-1');
    assert.equal(print.slug, 'doc');
    assertClientHeaders(calls[0]);
  });

  it('публичные /health и /version (без Authorization, но с версией)', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { status: 'ok', version: CLIENT_VERSION, uptime: 1 } },
      {
        status: 200,
        body: {
          version: CLIENT_VERSION,
          api: 'v1',
          min_client: '0.15.0',
          client_compatibility: '>=0.15.0 <0.16.0',
          recommended_client_version: CLIENT_VERSION,
          client_download_url: 'https://example.test/release',
          client_sha256: null,
        },
      },
    ]);
    const client = makeClient(fetch);
    await client.getHealth();
    await client.getVersion();
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assertClientHeaders(call);
      assert.equal(new Headers(call.init.headers as HeadersInit).get('Authorization'), null);
    }
  });

  it('426 без канонического конверта нормализуется в CLIENT_VERSION_UNSUPPORTED', async () => {
    const { fetch } = makeFetch([{ status: 426, body: 'upgrade required', headers: { 'content-type': 'text/plain' } }]);
    await assert.rejects(
      () => makeClient(fetch).getAttachmentRaw(NET, 'notes/a.txt'),
      (err: unknown) => {
        assert.ok(err instanceof EtnError);
        assert.equal(err.code, 'CLIENT_VERSION_UNSUPPORTED');
        return true;
      },
    );
  });
});
