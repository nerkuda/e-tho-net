/**
 * REST-путь языковых настроек (ADR daab6ac4 §3, задачи f99f0542/faba9ff4):
 * клиент обязан ходить на серверные маршруты языка, а не собирать цепочку
 * наследования сам.
 *
 *   GET /api/v1/users/me/language-settings
 *   GET /api/v1/admin/settings/language
 *   PUT /api/v1/admin/settings/language
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { RestClient } from '../src/main/net/rest-client.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Подменённый `fetch`, записывающий вызовы и отдающий конверт успеха. */
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
    clientVersion: '0.15.2',
    fetchImpl,
    random: () => 0,
  });
}

describe('RestClient: языковые настройки', () => {
  it('getMyLanguageSettings — GET /users/me/language-settings', async () => {
    const settings = {
      language: null,
      networks: [
        {
          network_id: 'n1',
          language: 'en',
          source: 'server',
          stored_language: null,
          can_edit: false,
        },
      ],
    };
    const { fetch, calls } = makeFetch({ data: settings });
    const client = makeClient(fetch);

    const result = await client.getMyLanguageSettings();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://localhost:3000/api/v1/users/me/language-settings');
    assert.equal((calls[0]!.init.method ?? 'GET').toUpperCase(), 'GET');
    assert.deepEqual(result, settings);
  });

  it('getServerLanguage — GET /admin/settings/language', async () => {
    const { fetch, calls } = makeFetch({ data: { language: 'en' } });
    const client = makeClient(fetch);

    const result = await client.getServerLanguage();

    assert.equal(calls[0]!.url, 'http://localhost:3000/api/v1/admin/settings/language');
    assert.deepEqual(result, { language: 'en' });
  });

  it('setServerLanguage — PUT /admin/settings/language с телом { language }', async () => {
    const { fetch, calls } = makeFetch({ data: { language: 'zh' } });
    const client = makeClient(fetch);

    await client.setServerLanguage('zh');

    assert.equal(calls[0]!.url, 'http://localhost:3000/api/v1/admin/settings/language');
    assert.equal(calls[0]!.init.method, 'PUT');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { language: 'zh' });
  });
});
