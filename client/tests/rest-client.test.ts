/**
 * Unit tests for {@link RestClient} (task G5).
 *
 * The client is exercised against a stubbed `fetch` implementation so the tests
 * cover header composition, query building, error normalisation, retry/backoff
 * and timeouts without any real network I/O.
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { EtnError } from '@etn/shared';

import { RestClient, type RequestOptions } from '../src/main/net/rest-client.js';

/** Minimal record of a single fetch invocation. */
interface FetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Builds a stub `fetch` that records every call and replies according to a queue of
 * canned responses. When the queue runs out the last response repeats.
 */
function makeFetch(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
  opts: { delayMs?: number } = {},
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let cursor = 0;
  const fetch = mock.fn((url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    const canned = responses[Math.min(cursor, responses.length - 1)];
    cursor++;
    const bodyStr =
      canned.body === undefined
        ? ''
        : typeof canned.body === 'string'
          ? canned.body
          : JSON.stringify(canned.body);
    const blob = new Blob([bodyStr]);
    const stream = blob.stream();
    const response: Response = {
      ok: canned.status >= 200 && canned.status < 300,
      status: canned.status,
      headers: new Headers(canned.headers ?? { 'content-type': 'application/json' }),
      text: () => Promise.resolve(bodyStr),
      json: () => Promise.resolve(canned.body === undefined ? undefined : JSON.parse(bodyStr)),
      body: stream,
    } as Response;
    if (opts.delayMs && opts.delayMs > 0) {
      return new Promise((resolve) => setTimeout(() => resolve(response), opts.delayMs));
    }
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { fetch, calls };
}

/** Builds a RestClient wired to the stubbed fetch. */
function makeClient(fetchImpl: typeof fetch, extra: { random?: () => number } = {}): RestClient {
  return new RestClient({
    baseUrl: 'http://localhost:3000',
    getApiKey: async () => 'etn_testkey',
    getClientId: () => '11111111-1111-1111-1111-111111111111',
    fetchImpl,
    random: extra.random ?? (() => 0),
  });
}

describe('RestClient — headers', () => {
  it('attaches Authorization Bearer, Client-Id and Accept on GET', async () => {
    const { fetch, calls } = makeFetch([
      {
        status: 200,
        body: { data: { id: 'u1', username: 'a', display_name: null, is_admin: false } },
      },
    ]);
    const client = makeClient(fetch);
    await client.getMe();

    assert.equal(calls.length, 1);
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    assert.equal(headers.get('Authorization'), 'Bearer etn_testkey');
    assert.equal(headers.get('Client-Id'), '11111111-1111-1111-1111-111111111111');
    assert.equal(headers.get('Accept'), 'application/json');
    assert.equal(headers.get('Content-Type'), null);
  });

  it('adds Content-Type, Client-Request-Id and If-Match on mutating requests', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { data: { id: 't1' }, meta: { version: 6 } } },
    ]);
    const client = makeClient(fetch);
    const ro: RequestOptions = { clientRequestId: 'req-123', expectedVersion: 5 };
    await client.updateThought('net1', 't1', { title: 'New' }, 5, ro);

    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(headers.get('Client-Request-Id'), 'req-123');
    assert.equal(headers.get('If-Match'), '5');
    assert.equal(calls[0]!.init.method, 'PATCH');
    assert.equal(calls[0]!.url, 'http://localhost:3000/api/v1/networks/net1/thoughts/t1');
  });

  it('resolves the API-key lazily on every call (rotation-safe)', async () => {
    let key = 'etn_v1';
    const { fetch, calls } = makeFetch([
      {
        status: 200,
        body: { data: { id: 'u1', username: 'a', display_name: null, is_admin: false } },
      },
      {
        status: 200,
        body: { data: { id: 'u1', username: 'a', display_name: null, is_admin: false } },
      },
    ]);
    const client = new RestClient({
      baseUrl: 'http://localhost:3000',
      getApiKey: async () => key,
      getClientId: () => 'c1',
      fetchImpl: fetch,
      random: () => 0,
    });
    await client.getMe();
    key = 'etn_v2';
    await client.getMe();

    const h1 = new Headers(calls[0]!.init.headers as HeadersInit);
    const h2 = new Headers(calls[1]!.init.headers as HeadersInit);
    assert.equal(h1.get('Authorization'), 'Bearer etn_v1');
    assert.equal(h2.get('Authorization'), 'Bearer etn_v2');
  });
});

describe('RestClient — URL & query', () => {
  it('encodes path segments and appends repeated array query params', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { data: [] } }]);
    const client = makeClient(fetch);
    await client.getNeighbors('net 1', 't/1', {
      dir: 'children',
      sort: 'alpha',
      type_id: ['a', 'b'],
    });

    const { url } = calls[0]!;
    assert.ok(
      url.startsWith('http://localhost:3000/api/v1/networks/net%201/thoughts/t%2F1/neighbors?'),
      url,
    );
    assert.ok(url.includes('dir=children'));
    assert.ok(url.includes('sort=alpha'));
    assert.ok(url.includes('type_id=a'));
    assert.ok(url.includes('type_id=b'));
  });

  it('omits undefined query values', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { data: [] } }]);
    const client = makeClient(fetch);
    await client.searchThoughts('net1', { q: 'hello', limit: undefined, scope: undefined });
    const { url } = calls[0]!;
    assert.equal(url.includes('limit'), false);
    assert.equal(url.includes('scope'), false);
    assert.ok(url.includes('q=hello'));
  });

  it('strips a trailing slash from baseUrl', async () => {
    const { fetch, calls } = makeFetch([
      {
        status: 200,
        body: { data: { id: 'u1', username: 'a', display_name: null, is_admin: false } },
      },
    ]);
    const client = new RestClient({
      baseUrl: 'http://localhost:3000///',
      getApiKey: async () => 'k',
      getClientId: () => 'c',
      fetchImpl: fetch,
      random: () => 0,
    });
    await client.getMe();
    assert.equal(calls[0]!.url, 'http://localhost:3000/api/v1/me');
  });
});

describe('RestClient — response parsing', () => {
  it('returns the data field of the success envelope and captures meta', async () => {
    const { fetch } = makeFetch([
      {
        status: 200,
        body: { data: { id: 't1', version: 3 }, meta: { version: 3, request_id: 'r1' } },
      },
    ]);
    const client = makeClient(fetch);
    const data = await client.getThought('net1', 't1');
    assert.deepEqual(data, { id: 't1', version: 3 });
    assert.equal(client.lastMeta?.version, 3);
    assert.equal(client.lastMeta?.request_id, 'r1');
  });

  it('treats 204 / empty body as undefined (DELETE)', async () => {
    const { fetch, calls } = makeFetch([{ status: 204, body: undefined }]);
    const client = makeClient(fetch);
    const result = await client.deleteThought('net1', 't1', 2);
    assert.equal(result, undefined);
    assert.equal(calls[0]!.init.method, 'DELETE');
  });
});

describe('RestClient — error handling', () => {
  it('throws EtnError with code/details/request_id for a canonical error body', async () => {
    const { fetch } = makeFetch([
      {
        status: 422,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'title must not be empty',
            details: [{ field: 'title', issue: 'required' }],
            request_id: 'req-9',
          },
        },
      },
    ]);
    const client = makeClient(fetch);
    await assert.rejects(
      () => client.createThought('net1', { title: '' }),
      (err: unknown) => {
        assert.ok(err instanceof EtnError, 'expected EtnError');
        const e = err as EtnError;
        assert.equal(e.code, 'VALIDATION_ERROR');
        assert.equal(e.message, 'title must not be empty');
        assert.equal(e.requestId, 'req-9');
        assert.deepEqual(e.details, [{ field: 'title', issue: 'required' }]);
        return true;
      },
    );
  });

  it('maps a non-canonical error to the closest EtnErrorCode', async () => {
    const { fetch } = makeFetch([{ status: 404, body: 'plain text not found' }]);
    const client = makeClient(fetch);
    await assert.rejects(
      () => client.getThought('net1', 'missing'),
      (err: unknown) => {
        assert.ok(err instanceof EtnError);
        assert.equal((err as EtnError).code, 'NOT_FOUND');
        return true;
      },
    );
  });

  it('does NOT retry on 4xx', async () => {
    const { fetch, calls } = makeFetch([
      { status: 409, body: { error: { code: 'DUPLICATE', message: 'dup' } } },
    ]);
    const client = makeClient(fetch);
    await assert.rejects(() => client.createThought('net1', { title: 'x' }));
    assert.equal(calls.length, 1, '4xx must not be retried');
  });
});

describe('RestClient — retry & timeout', () => {
  it('retries 5xx up to MAX_ATTEMPTS and returns once it succeeds', async () => {
    const { fetch, calls } = makeFetch([
      { status: 502, body: { error: { code: 'INTERNAL', message: 'bad gateway' } } },
      { status: 503, body: { error: { code: 'INTERNAL', message: 'unavailable' } } },
      {
        status: 200,
        body: { data: { id: 'u1', username: 'a', display_name: null, is_admin: false } },
      },
    ]);
    const client = makeClient(fetch, { random: () => 0 }); // jitter=0 → no real sleep
    const me = await client.getMe();
    assert.equal(me.id, 'u1');
    assert.equal(calls.length, 3);
  });

  it('throws INTERNAL after exhausting retries on 5xx', async () => {
    const { fetch, calls } = makeFetch([
      { status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } },
    ]);
    const client = makeClient(fetch, { random: () => 0 });
    await assert.rejects(
      () => client.getMe(),
      (err: unknown) => {
        assert.ok(err instanceof EtnError);
        assert.equal((err as EtnError).code, 'INTERNAL');
        return true;
      },
    );
    // 1 initial + 2 retries = 3 attempts total.
    assert.equal(calls.length, 3);
  });

  it('retries on network-level fetch rejection', async () => {
    let callsCount = 0;
    const fetchImpl = mock.fn((): Promise<Response> => {
      callsCount++;
      if (callsCount < 3) {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      const body = JSON.stringify({
        data: { id: 'u1', username: 'a', display_name: null, is_admin: false },
      });
      const response = {
        ok: true,
        status: 200,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(JSON.parse(body)),
      } as Response;
      return Promise.resolve(response);
    }) as unknown as typeof fetch;
    const client = new RestClient({
      baseUrl: 'http://localhost:3000',
      getApiKey: async () => 'k',
      getClientId: () => 'c',
      fetchImpl: fetchImpl,
      random: () => 0,
    });
    const me = await client.getMe();
    assert.equal(me.id, 'u1');
    assert.equal(callsCount, 3);
  });

  it('throws INTERNAL when every fetch attempt fails with a network error', async () => {
    const fetchImpl = mock.fn(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    ) as unknown as typeof fetch;
    const client = new RestClient({
      baseUrl: 'http://localhost:3000',
      getApiKey: async () => 'k',
      getClientId: () => 'c',
      fetchImpl: fetchImpl,
      random: () => 0,
    });
    await assert.rejects(
      () => client.getMe(),
      (err: unknown) => {
        assert.ok(err instanceof EtnError);
        assert.equal((err as EtnError).code, 'INTERNAL');
        assert.match((err as EtnError).message, /Сетевая ошибка/);
        return true;
      },
    );
  });
});
