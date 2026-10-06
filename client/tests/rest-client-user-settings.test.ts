/**
 * Тест реального HTTP-пути L3s-настроек пользователя (0.12.1, задача
 * d534eb35): `RestClient.getMySettings`/`setMySetting` обязаны ходить на
 * `/users/me/settings` (+`/{key}`) — как сервер (`server/src/routes/me.ts`) и
 * спека (операция API `e7e07b24`, ADR `3a829d25`), а не на `/me/settings`.
 *
 * Проверяется на подменённом `fetch`: перехватываются метод и точный URL.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { RestClient } from '../src/main/net/rest-client.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Подменённый `fetch`, который записывает вызовы и отдаёт конверт успеха. */
function makeFetch(body: unknown): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchStub = mock.fn((url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    const text = JSON.stringify(body);
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(body),
    } as unknown as Response;
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { fetch: fetchStub, calls };
}

function makeClient(fetchImpl: typeof fetch): RestClient {
  return new RestClient({
    baseUrl: 'http://localhost:3000',
    getApiKey: async () => 'etn_testkey',
    getClientId: () => '11111111-1111-1111-1111-111111111111',
    fetchImpl,
    random: () => 0,
  });
}

describe('RestClient: путь L3s-настроек пользователя (/users/me/settings)', () => {
  it('getMySettings ходит на GET /api/v1/users/me/settings и возвращает карту', async () => {
    const { fetch, calls } = makeFetch({ data: { comment_hotkeys: { 'comment.bold': 'Ctrl+B' } } });
    const client = makeClient(fetch);

    const settings = await client.getMySettings();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://localhost:3000/api/v1/users/me/settings');
    assert.equal((calls[0]!.init.method ?? 'GET').toUpperCase(), 'GET');
    assert.deepEqual(settings, { comment_hotkeys: { 'comment.bold': 'Ctrl+B' } });
  });

  it('setMySetting ходит на PUT /api/v1/users/me/settings/{key} с телом { value }', async () => {
    const { fetch, calls } = makeFetch({ data: { key: 'comment_hotkeys', value: {} } });
    const client = makeClient(fetch);

    await client.setMySetting('comment_hotkeys', { 'comment.bold': 'Ctrl+Alt+B' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://localhost:3000/api/v1/users/me/settings/comment_hotkeys');
    assert.equal(calls[0]!.init.method, 'PUT');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      value: { 'comment.bold': 'Ctrl+Alt+B' },
    });
  });
});
