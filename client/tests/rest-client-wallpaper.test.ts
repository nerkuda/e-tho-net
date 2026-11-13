/**
 * REST-методы фоновой картинки карты (0.16.1, задача 80324150; операция API
 * 31ef478a, серверный контракт задачи 8e007e63).
 *
 * Маршруты и формы тел — часть контракта, поэтому проверяются на уровне
 * `RestClient`, а не только сервиса: ошибка в пути или в поле тела проявилась бы
 * лишь на живом сервере.
 *
 *   GET    /api/v1/users/me/wallpaper?network_id=…
 *   GET    /api/v1/users/me/wallpaper/raw?network_id=…      (бинарный ответ + ETag)
 *   PUT    /api/v1/users/me/wallpaper?network_id=…          ({data_base64, mime_type, meta})
 *   DELETE /api/v1/users/me/wallpaper?network_id=…
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { RestClient } from '../src/main/net/rest-client.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Подменённый `fetch`, отдающий JSON-конверт успеха. */
function makeJsonFetch(body: unknown): { fetch: typeof fetch; calls: FetchCall[] } {
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

/** Подменённый `fetch`, отдающий бинарный ответ `/raw`. */
function makeRawFetch(
  bytes: Uint8Array,
  headers: Record<string, string>,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchStub = mock.fn((url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(headers),
      text: () => Promise.resolve(''),
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)),
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
    clientVersion: '0.16.1',
    fetchImpl,
    random: () => 0,
  });
}

/** Сеть сценария: сервер проверяет формат network_id (uuid). */
const NET = '11111111-1111-1111-1111-111111111111';

const INFO = {
  kind: 'map_wallpaper',
  network_id: NET,
  mime_type: 'image/jpeg',
  file_size: 4,
  meta: { width: 2, height: 2, avg_luminance: 0.5 },
  url: '/api/v1/users/me/wallpaper/raw',
};

describe('RestClient: фоновая картинка', () => {
  it('getWallpaper — GET /users/me/wallpaper', async () => {
    const { fetch, calls } = makeJsonFetch({ data: INFO });
    const client = makeClient(fetch);

    const result = await client.getWallpaper(NET);

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.url,
      `http://localhost:3000/api/v1/users/me/wallpaper?network_id=${NET}`,
    );
    assert.equal((calls[0]!.init.method ?? 'GET').toUpperCase(), 'GET');
    assert.deepEqual(result, INFO);
  });

  it('getWallpaperRaw — бинарные байты + ETag и Content-Type', async () => {
    const { fetch, calls } = makeRawFetch(new Uint8Array([1, 2, 3, 4]), {
      'content-type': 'image/jpeg',
      etag: '"abc"',
    });
    const client = makeClient(fetch);

    const raw = await client.getWallpaperRaw(NET);

    assert.equal(
      calls[0]!.url,
      `http://localhost:3000/api/v1/users/me/wallpaper/raw?network_id=${NET}`,
    );
    assert.equal(raw.contentType, 'image/jpeg');
    assert.equal(raw.etag, '"abc"');
    assert.deepEqual([...raw.body], [1, 2, 3, 4]);
  });

  it('getWallpaperRaw без ETag — etag null (хеш посчитает сервис)', async () => {
    const { fetch } = makeRawFetch(new Uint8Array([9]), { 'content-type': 'image/png' });
    const client = makeClient(fetch);

    const raw = await client.getWallpaperRaw(NET);

    assert.equal(raw.etag, null);
    assert.equal(raw.contentType, 'image/png');
  });

  it('uploadWallpaper — PUT с телом {data_base64, mime_type, meta}', async () => {
    const { fetch, calls } = makeJsonFetch({ data: INFO });
    const client = makeClient(fetch);

    const result = await client.uploadWallpaper(NET, {
      data_base64: 'AQIDBA==',
      mime_type: 'image/jpeg',
      meta: { width: 2, height: 2, avg_luminance: 0.5, dominant_hue: 200 },
    });

    assert.equal(
      calls[0]!.url,
      `http://localhost:3000/api/v1/users/me/wallpaper?network_id=${NET}`,
    );
    assert.equal(calls[0]!.init.method, 'PUT');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      data_base64: 'AQIDBA==',
      mime_type: 'image/jpeg',
      meta: { width: 2, height: 2, avg_luminance: 0.5, dominant_hue: 200 },
    });
    assert.deepEqual(result, INFO);
  });

  it('deleteWallpaper — DELETE /users/me/wallpaper', async () => {
    const { fetch, calls } = makeJsonFetch({ data: { status: 'ok' } });
    const client = makeClient(fetch);

    await client.deleteWallpaper(NET);

    assert.equal(
      calls[0]!.url,
      `http://localhost:3000/api/v1/users/me/wallpaper?network_id=${NET}`,
    );
    assert.equal(calls[0]!.init.method, 'DELETE');
  });
});
