/**
 * Структурная причина сетевого отказа в `RestClient` (ошибка 390e9746).
 *
 * Диалог подключения не должен угадывать причину по тексту исключения:
 * транспорт различает её сам и кладёт в `details` ошибки
 * (`{ kind: 'connect-failed', reason }`). Тест фиксирует распознавание
 * реальных форм отказа Node/undici (системный код в `cause`) и честный
 * `other`, когда причина неразличима.
 */

import assert from 'node:assert/strict';
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
    assert.equal(classifyConnectFailure(fetchFailedWithCode('ECONNRESET')), 'unreachable');
    assert.equal(classifyConnectFailure(fetchFailedWithCode('ETIMEDOUT')), 'timeout');
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
