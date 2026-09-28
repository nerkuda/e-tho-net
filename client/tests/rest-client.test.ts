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
  // Named `fetchStub` so the `typeof fetch` annotation below cannot resolve to
  // this very constant (TS7022: self-referencing initializer).
  const fetchStub = mock.fn((url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    const canned = responses[Math.min(cursor, responses.length - 1)];
    if (canned === undefined) throw new Error('makeFetch: responses must not be empty');
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
  return { fetch: fetchStub, calls };
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

/**
 * Yields to the macrotask queue so every pending microtask (lazy API-key
 * resolution, fetch dispatch) has run.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Fetch stub whose responses are released by the test, one body at a time —
 * needed to pin the microtask ORDER of two concurrent responses (the race the
 * regression tests below model). Each call gets a deferred body.
 */
function makeControlledFetch(): {
  fetch: typeof fetch;
  /** Releases the body of the n-th call (0-based) as a JSON success envelope. */
  resolveBody: (index: number, body: unknown) => void;
} {
  let next = 0;
  const releases = new Map<number, (payload: { body: string }) => void>();
  const fetchStub = ((_url: string, _init?: RequestInit): Promise<Response> => {
    const index = next++;
    const bodyPromise = new Promise<{ body: string }>((res) => {
      releases.set(index, res);
    });
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async (): Promise<string> => (await bodyPromise).body,
      json: async (): Promise<unknown> => JSON.parse((await bodyPromise).body),
    } as unknown as Response;
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return {
    fetch: fetchStub,
    resolveBody: (index: number, body: unknown): void => {
      const release = releases.get(index);
      if (release === undefined) throw new Error(`no pending request #${index}`);
      release({ body: JSON.stringify(body) });
    },
  };
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

  it('listLinksByThought sends show_inactive only when passed', async () => {
    const empty = { status: 200, body: { data: { by_type: [], untyped_parents: [], untyped_children: [] } } };
    const { fetch, calls } = makeFetch([empty, empty]);
    const client = makeClient(fetch);
    await client.listLinksByThought('net1', 't1');
    await client.listLinksByThought('net1', 't1', true);
    const [without, with_] = calls;
    assert.ok(without!.url.includes('group=type'));
    assert.equal(without!.url.includes('show_inactive'), false);
    assert.ok(with_!.url.includes('show_inactive=true'));
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

describe('RestClient — раскрытие дерева «Структур» (L15, ошибка db504c1a)', () => {
  /** Пустой ответ одного уровня иерархии — важен только собранный URL. */
  const EMPTY_HIERARCHY = {
    status: 200,
    body: {
      data: { neighbors: [], edges: [], truncated: false, has_more: false, directions: {} },
    },
  };

  it('getHierarchy кладёт фильтр обхода по связям в query-параметр link_filter', async () => {
    const { fetch, calls } = makeFetch([EMPTY_HIERARCHY]);
    const client = makeClient(fetch);
    await client.getHierarchy('net1', 't1', {
      dir: 'children',
      showInactive: false,
      excludeIds: ['a', 'b'],
      linkFilter: { type_ids: ['lt1'], include_structural: true },
    });
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get('dir'), 'children');
    assert.equal(url.searchParams.get('exclude_ids'), 'a,b');
    // Форма значения — та же, что у поля `link_filter` тела `POST /thoughts/query`.
    assert.deepEqual(JSON.parse(url.searchParams.get('link_filter') ?? 'null'), {
      type_ids: ['lt1'],
      include_structural: true,
    });
  });

  it('без фильтра обхода link_filter в запрос не попадает (прежнее поведение)', async () => {
    const { fetch, calls } = makeFetch([EMPTY_HIERARCHY]);
    const client = makeClient(fetch);
    await client.getHierarchy('net1', 't1', { dir: 'parents' });
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.has('link_filter'), false);
    assert.equal(url.searchParams.get('dir'), 'parents');
  });
});

describe('RestClient — снимок рёбер «Структур» (ошибка a617b4c6)', () => {
  /** Пустой снимок рёбер — важен только состав тела запроса. */
  const EMPTY_EDGES = { status: 200, body: { data: { edges: [] } } };

  it('postStructureEdges кладёт фильтр типов связей в тело link_filter', async () => {
    const { fetch, calls } = makeFetch([EMPTY_EDGES]);
    const client = makeClient(fetch);
    await client.postStructureEdges('net1', ['t1', 't2'], true, {
      type_ids: ['lt1'],
      include_structural: true,
    });
    assert.equal(calls[0]!.init.method, 'POST');
    const body = JSON.parse((calls[0]!.init.body ?? '{}') as string) as Record<string, unknown>;
    assert.deepEqual(body, {
      ids: ['t1', 't2'],
      show_inactive: true,
      link_filter: { type_ids: ['lt1'], include_structural: true },
    });
  });

  it('без фильтра тело запроса link_filter не содержит (прежнее поведение)', async () => {
    const { fetch, calls } = makeFetch([EMPTY_EDGES]);
    const client = makeClient(fetch);
    await client.postStructureEdges('net1', ['t1'], false);
    const body = JSON.parse((calls[0]!.init.body ?? '{}') as string) as Record<string, unknown>;
    assert.deepEqual(body, { ids: ['t1'], show_inactive: false });
  });
});

describe('RestClient — превью соседей на холсте (ошибка e5cee08e)', () => {
  /** Пустой список соседей — важен только собранный URL. */
  const EMPTY_NEIGHBORS = { status: 200, body: { data: [] } };

  it('getNeighbors кладёт фильтр типов связей в query-параметры link_type_id + include_structural', async () => {
    const { fetch, calls } = makeFetch([EMPTY_NEIGHBORS]);
    const client = makeClient(fetch);
    await client.getNeighbors('net1', 't1', {
      dir: 'children',
      limit: 200,
      linkFilter: { type_ids: ['lt1', 'lt2'], include_structural: true },
    });
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get('dir'), 'children');
    // Та же форма, что разбирает сервер (`parseLinkTypeFilterQuery`):
    // повторяемый link_type_id + include_structural.
    assert.deepEqual(url.searchParams.getAll('link_type_id'), ['lt1', 'lt2']);
    assert.equal(url.searchParams.get('include_structural'), 'true');
  });

  it('без фильтра query-параметров фильтра нет (прежнее поведение)', async () => {
    const { fetch, calls } = makeFetch([EMPTY_NEIGHBORS]);
    const client = makeClient(fetch);
    await client.getNeighbors('net1', 't1', { dir: 'parents' });
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.has('link_type_id'), false);
    assert.equal(url.searchParams.has('include_structural'), false);
    assert.equal(url.searchParams.get('dir'), 'parents');
  });
});

describe('RestClient — response parsing', () => {
  it('returns the data field of the success envelope', async () => {
    const { fetch } = makeFetch([
      {
        status: 200,
        body: { data: { id: 't1', version: 3 }, meta: { version: 3, request_id: 'r1' } },
      },
    ]);
    const client = makeClient(fetch);
    const data = await client.getThought('net1', 't1');
    assert.deepEqual(data, { id: 't1', version: 3 });
  });

  it('treats 204 / empty body as undefined (DELETE)', async () => {
    const { fetch, calls } = makeFetch([{ status: 204, body: undefined }]);
    const client = makeClient(fetch);
    const result = await client.deleteThought('net1', 't1', 2);
    assert.equal(result, undefined);
    assert.equal(calls[0]!.init.method, 'DELETE');
  });
});

describe('RestClient — метаданные ответа привязаны к своему ответу (ошибка 90811979)', () => {  /**
   * Свойство полосы отборов (полоса фокуса) собирается из `data` И `meta`
   * ОДНОГО ответа `GET …/thought-types/{id}/views`: `data` — собственные
   * отборы типа, `meta.effective` — унаследованная цепочка. Пока обе части
   * брались из общего поля клиента, ответ соседнего запроса, разобравшийся
   * позже (но до продолжения читателя), подменял `meta.effective` пустым
   * значением — полоса теряла отборы, режим откатывался на «Потомки», и нижняя
   * зона оставалась пустой до ручного переключения режима.
   */
  it('читает meta.effective из своего ответа, а не из чужого (гонка разбора)', async () => {
    const ctl = makeControlledFetch();
    const client = makeClient(ctl.fetch);
    const viewsPromise = client.listThoughtTypeViews('net1', 'type1', { includeEffective: true });
    const otherPromise = client.getThought('net1', 't1');
    await tick();
    // Порядок разбора: сначала ответ полосы (со своим `effective`), затем
    // ответ постороннего запроса с ДРУГОЙ meta. Продолжение читателя полосы
    // выполняется уже после второго разбора.
    ctl.resolveBody(0, {
      data: [{ id: 'v1' }],
      meta: { effective: [{ id: 'v1', name: 'отбор' }] },
    });
    ctl.resolveBody(1, { data: { id: 't1', version: 7 }, meta: { version: 7 } });
    const [views, other] = await Promise.all([viewsPromise, otherPromise]);
    assert.equal(other.id, 't1');
    assert.deepEqual(
      views.meta.effective.map((v) => v.id),
      ['v1'],
    );
  });

  it('не портит meta соседей: каждый читатель получает meta своего ответа', async () => {
    const ctl = makeControlledFetch();
    const client = makeClient(ctl.fetch);
    const pagePromise = client.getNeighborsPage('net1', 't1', { dir: 'children' });
    const activityPromise = client.listActivity('net1');
    await tick();
    ctl.resolveBody(0, { data: [{ id: 'n1' }], meta: { total: 5, limit: 1, offset: 0 } });
    ctl.resolveBody(1, { data: [], meta: { total: 42 } });
    const [page, activity] = await Promise.all([pagePromise, activityPromise]);
    assert.deepEqual(
      { items: page.items.map((n) => n.id), total: page.total, limit: page.limit },
      { items: ['n1'], total: 5, limit: 1 },
    );
    assert.equal(activity.total, 42);
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

describe('RestClient — сохранённые отборы «Структур» (ошибка 0a8b9da3)', () => {
  it('lists/creates/updates/deletes structure saved filters with view=structures', async () => {
    const filter = {
      id: 'f1',
      view: 'structures',
      name: 'Все персоны',
      definition: { sort: 'alpha', order: 'asc' },
      created_at: '2024',
      updated_at: '2024',
    };
    const { fetch, calls } = makeFetch([
      { status: 200, body: { data: [filter] } },
      { status: 201, body: { data: filter } },
      { status: 200, body: { data: { ...filter, name: 'Все женщины' } } },
      { status: 204, body: undefined },
    ]);
    const client = makeClient(fetch);

    const list = await client.listSavedFilters('net1');
    assert.equal(list.length, 1);
    assert.ok(calls[0]!.url.includes('/saved-filters?'), 'чтение идёт по тому же адресу');
    assert.ok(calls[0]!.url.includes('view=structures'), 'вид «Структур» задан явно');

    await client.createSavedFilter('net1', {
      name: 'Все женщины',
      definition: { sort: 'alpha', order: 'asc' },
    });
    const createdBody = JSON.parse((calls[1]!.init.body ?? '{}') as string) as Record<string, unknown>;
    assert.equal(
      createdBody['view'],
      'structures',
      'POST обязан нести view — иначе сервер отвечает VALIDATION_ERROR «Недопустимый view»',
    );
    assert.equal(createdBody['name'], 'Все женщины');

    await client.updateSavedFilter('net1', 'f1', { name: 'Все женщины' });
    const updatedBody = JSON.parse((calls[2]!.init.body ?? '{}') as string) as Record<string, unknown>;
    assert.equal(updatedBody['view'], 'structures');
    assert.equal(updatedBody['name'], 'Все женщины');

    await client.deleteSavedFilter('net1', 'f1');
    assert.equal(calls[3]!.url, 'http://localhost:3000/api/v1/networks/net1/saved-filters/f1');
  });
});

describe('RestClient — chronicle (L20)', () => {
  it('POSTs the chronicle query and reads total from the list meta', async () => {
    const { fetch, calls } = makeFetch([
      {
        status: 200,
        body: {
          data: [{ id: 'c1', title: 'Запись', valid_from: '2024-01-01', valid_to: null, version: 1, created_at: '2024', updated_at: '2024', created_by: 'u', updated_by: 'u', snippet: 'x', targets: [] }],
          meta: { total: 7, offset: 0, limit: 50 },
        },
      },
    ]);
    const client = makeClient(fetch);
    const result = await client.queryChronicle('net1', {
      keywords: 'счет*',
      link_scope: 'both',
      order: 'desc',
      limit: 50,
      offset: 0,
    });
    assert.equal(result.total, 7);
    assert.equal(result.rows.length, 1);
    assert.equal(calls[0]!.url, 'http://localhost:3000/api/v1/networks/net1/chronicle/query');
    const sent = JSON.parse((calls[0]!.init.body ?? '{}') as string) as Record<string, unknown>;
    assert.equal(sent['keywords'], 'счет*');
    assert.equal(sent['order'], 'desc');
  });

  it('lists/create/updates/deletes chronicle saved filters with view=chronicle', async () => {
    const filter = { id: 'f1', view: 'chronicle', name: 'Отбор', definition: { order: 'asc' }, created_at: '2024', updated_at: '2024' };
    const { fetch, calls } = makeFetch([
      { status: 200, body: { data: [filter] } },
      { status: 201, body: { data: filter } },
      { status: 200, body: { data: { ...filter, name: 'Отбор 2' } } },
      { status: 204, body: undefined },
    ]);
    const client = makeClient(fetch);

    const list = await client.listChronicleFilters('net1');
    assert.equal(list.length, 1);
    assert.ok(calls[0]!.url.includes('/saved-filters?'));
    assert.ok(calls[0]!.url.includes('view=chronicle'));

    await client.createChronicleFilter('net1', { name: 'Отбор', definition: { order: 'asc' } });
    const createdBody = JSON.parse((calls[1]!.init.body ?? '{}') as string) as Record<string, unknown>;
    assert.equal(createdBody['view'], 'chronicle');

    await client.updateChronicleFilter('net1', 'f1', { name: 'Отбор 2' });
    const updatedBody = JSON.parse((calls[2]!.init.body ?? '{}') as string) as Record<string, unknown>;
    assert.equal(updatedBody['view'], 'chronicle');
    assert.equal(updatedBody['name'], 'Отбор 2');

    await client.deleteChronicleFilter('net1', 'f1');
    assert.equal(calls[3]!.url, 'http://localhost:3000/api/v1/networks/net1/saved-filters/f1');
  });

  it('creates a multi-target comment and manages targets (L20)', async () => {
    const comment = { id: 'c1', owner_type: 'thought', owner_id: 't1', targets: [{ owner_type: 'thought', owner_id: 't1' }], kind: 'chronological', title: null, body_md: 'x', body_html: '<p>x</p>', valid_from: '2024-01-01', valid_to: null, version: 1, created_at: '2024', updated_at: '2024', created_by: 'u', updated_by: 'u' };
    const { fetch, calls } = makeFetch([
      { status: 201, body: { data: comment } },
      { status: 200, body: { data: comment } },
      { status: 200, body: { data: comment } },
      { status: 200, body: { data: comment } },
    ]);
    const client = makeClient(fetch);

    await client.createCommentWithTargets('net1', {
      kind: 'chronological',
      body_md: 'x',
      targets: [{ owner_type: 'thought', owner_id: 't1' }, { owner_type: 'thought', owner_id: 't2' }],
    });
    assert.equal(calls[0]!.url, 'http://localhost:3000/api/v1/networks/net1/comments');

    await client.getComment('net1', 'c1');
    assert.equal(calls[1]!.url, 'http://localhost:3000/api/v1/networks/net1/comments/c1');

    await client.addCommentTarget('net1', 'c1', 'thought', 't2', 1);
    assert.equal(calls[2]!.url, 'http://localhost:3000/api/v1/networks/net1/comments/c1/targets');

    await client.removeCommentTarget('net1', 'c1', 'thought', 't2', 2);
    assert.equal(calls[3]!.url, 'http://localhost:3000/api/v1/networks/net1/comments/c1/targets/thought/t2');
  });
});

describe('RestClient — attachment raw download', () => {
  /** fetch stub that replies with binary bytes (makeFetch is text-only). */
  function binaryFetch(status: number, bytes: Uint8Array, contentType: string): {
    fetch: typeof fetch;
    calls: FetchCall[];
  } {
    const calls: FetchCall[] = [];
    // `Uint8Array.from` re-creates the view over a plain ArrayBuffer, which
    // satisfies BodyInit under TS 5.9 (Uint8Array<ArrayBufferLike> would not).
    const fetchStub = mock.fn((url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(
        new Response(Uint8Array.from(bytes), { status, headers: { 'content-type': contentType } }),
      );
    }) as unknown as typeof fetch;
    return { fetch: fetchStub, calls };
  }

  it('getAttachmentRaw GETs the encoded path and returns the raw bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { fetch, calls } = binaryFetch(200, bytes, 'image/png');
    const client = makeClient(fetch);
    const filePath = 'C:\\data\\фото 1.png';

    const file = await client.getAttachmentRaw('net1', filePath);
    assert.equal(
      calls[0]!.url,
      'http://localhost:3000/api/v1/networks/net1/attachments/raw' +
        '?path=' + encodeURIComponent(filePath),
    );
    assert.equal((calls[0]!.init.headers as Record<string, string>)['Authorization'], 'Bearer etn_testkey');
    assert.equal(file.contentType, 'image/png');
    assert.deepEqual(new Uint8Array(file.body), bytes);
  });

  it('getAttachmentRaw maps a non-2xx reply to an EtnError without retries', async () => {
    const { fetch, calls } = binaryFetch(404, new TextEncoder().encode('nope'), 'text/plain');
    const client = makeClient(fetch);

    await assert.rejects(
      client.getAttachmentRaw('net1', 'C:\\missing.png'),
      (e: unknown) => e instanceof EtnError && e.code === 'NOT_FOUND',
    );
    assert.equal(calls.length, 1);
  });
});

describe('RestClient — in-flight дедуп одинаковых GET', () => {
  it('два одинаковых параллельных GET делят один fetch и один ответ', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { data: [{ id: 't1' }] } }], {
      delayMs: 10,
    });
    const client = makeClient(fetch);
    const [a, b] = await Promise.all([
      client.listThoughtTypes('net1'),
      client.listThoughtTypes('net1'),
    ]);
    assert.equal(calls.length, 1);
    assert.deepEqual(a, b);
  });

  it('после завершения GET слот освобождается — последовательные GET летят отдельно', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { data: [] } },
      { status: 200, body: { data: [] } },
    ]);
    const client = makeClient(fetch);
    await client.listThoughtTypes('net1');
    await client.listThoughtTypes('net1');
    assert.equal(calls.length, 2);
  });

  it('разные GET (другой путь/запрос) не дедупятся', async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { data: [] } }], { delayMs: 10 });
    const client = makeClient(fetch);
    await Promise.all([
      client.listThoughtTypes('net1'),
      client.listLinkTypes('net1'),
      client.listThoughtTypes('net2'),
    ]);
    assert.equal(calls.length, 3);
  });

  it('отклонённый GET освобождает слот: повторный одинаковый GET летит заново', async () => {
    const { fetch, calls } = makeFetch([
      { status: 404, body: { error: { code: 'NOT_FOUND', message: 'нет' } } },
      { status: 200, body: { data: [] } },
    ]);
    const client = makeClient(fetch);
    await assert.rejects(() => client.listThoughtTypes('net1'));
    await client.listThoughtTypes('net1');
    assert.equal(calls.length, 2);
  });
});

describe('RestClient — §16 system endpoints', () => {
  it('getHealth targets /api/v1/health without an Authorization header', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { status: 'ok', version: '0.5.5', uptime: 12.5 } },
    ]);
    const client = makeClient(fetch);
    const health = await client.getHealth();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://localhost:3000/api/v1/health');
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    assert.equal(headers.get('Authorization'), null);
    assert.equal(health.status, 'ok');
    assert.equal(health.version, '0.5.5');
  });

  it('getVersion targets /api/v1/version and returns the server version', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { version: '0.5.5', client_compatibility: '>=0.5.0 <1.0.0' } },
    ]);
    const client = makeClient(fetch);
    const version = await client.getVersion();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://localhost:3000/api/v1/version');
    assert.equal(version.version, '0.5.5');
  });
});

// ---------------------------------------------------------------------------
// Регрессия бага 3 (5467fb19): `{ data, meta }` envelope auto-unwraps to
// `data` inside `request()`/`parseResponse()` — `listThoughtTypeViews` and
// `runThoughtTypeView` used to return `this.request(...)` directly typed as
// `{ data, meta }`, so callers (`views-tab.ts`'s `ownViewsOf(resp.data, …)`,
// `focus-filter-strip.ts`'s `resp.meta.*`) read `undefined` at runtime and
// crashed with «Cannot read properties of undefined (reading 'filter')».
// ---------------------------------------------------------------------------
describe('RestClient — thought-type views (0.7.3, баг 5467fb19)', () => {
  it('listThoughtTypeViews resolves both `data` (own views) and `meta.effective` on the same object', async () => {
    const ownView = { id: 'v1', thought_type_id: 'ty1', name: 'Own' };
    const effectiveView = { id: 'v0', thought_type_id: 'root', name: 'Inherited' };
    const { fetch, calls } = makeFetch([
      {
        status: 200,
        body: { data: [ownView], meta: { effective: [effectiveView] } },
      },
    ]);
    const client = makeClient(fetch);
    const resp = await client.listThoughtTypeViews('net1', 'ty1', { includeEffective: true });

    assert.equal(calls[0]!.url, 'http://localhost:3000/api/v1/networks/net1/thought-types/ty1/views?include_effective=true');
    // `resp.data` must be the own-views array, not `undefined` — the exact
    // shape `views-tab.ts`'s `ownViewsOf(resp.data, typeId)` relies on.
    assert.deepEqual(resp.data, [ownView]);
    assert.deepEqual(resp.meta.effective, [effectiveView]);
  });

  it('listThoughtTypeViews defaults `meta.effective` to [] when the server omits it', async () => {
    const { fetch } = makeFetch([{ status: 200, body: { data: [] } }]);
    const client = makeClient(fetch);
    const resp = await client.listThoughtTypeViews('net1', 'ty1', { includeEffective: false });

    assert.deepEqual(resp.data, []);
    assert.deepEqual(resp.meta.effective, []);
  });

  it('runThoughtTypeView resolves both `data` (page items) and `meta` (view/unresolved/directions)', async () => {
    const item = { id: 't1', title: 'Задача 0.7.3' };
    const { fetch } = makeFetch([
      {
        status: 200,
        body: {
          data: [item],
          meta: {
            total: 1,
            limit: 100,
            offset: 0,
            directions: { t1: { has_incoming: false, has_outgoing: true } },
            view: { id: 'v1', name: 'Работы версии', type_id: 'ty1' },
            sort: 'alpha',
            order: 'asc',
          },
        },
      },
    ]);
    const client = makeClient(fetch);
    const resp = await client.runThoughtTypeView('net1', 'th1', 'Работы версии');

    assert.deepEqual(resp.data, [item]);
    assert.equal(resp.meta.total, 1);
    assert.equal(resp.meta.view.name, 'Работы версии');
    assert.deepEqual(resp.meta.directions, { t1: { has_incoming: false, has_outgoing: true } });
    assert.equal(resp.meta.unresolved, undefined);
  });

  it('runThoughtTypeView carries `meta.unresolved` through when a token could not be resolved', async () => {
    const { fetch } = makeFetch([
      {
        status: 200,
        body: {
          data: [],
          meta: {
            total: 0,
            limit: 0,
            offset: 0,
            directions: {},
            view: { id: 'v1', name: 'Работы версии', type_id: 'ty1' },
            unresolved: [{ token: '$thought.[версия]', reason: 'unknown_property', message: 'нет свойства' }],
          },
        },
      },
    ]);
    const client = makeClient(fetch);
    const resp = await client.runThoughtTypeView('net1', 'th1', 'Работы версии');

    assert.deepEqual(resp.data, []);
    assert.equal(resp.meta.unresolved?.length, 1);
    assert.equal(resp.meta.unresolved?.[0]?.reason, 'unknown_property');
  });
});

/**
 * Этап 4 тех.проекта e29c0f00: COUNT запрашивается явно (требование 5adebf61),
 * курсор следующей страницы читается из `meta.next_cursor` (3f2fdc41), а
 * `signal` отменяет устаревший запрос (ebed4980).
 */
describe('RestClient — structures query: COUNT, курсор и отмена', () => {
  /** Список-конверт с заданными `meta`. */
  function listMeta(meta: Record<string, unknown>): { status: number; body: unknown } {
    return {
      status: 200,
      body: { data: [], meta: { offset: 0, limit: 100, directions: {}, ...meta } },
    };
  }

  it('queryStructureThoughts запрашивает COUNT явно и прокидывает signal', async () => {
    const { fetch, calls } = makeFetch([listMeta({ total: 3, has_more: true, next_cursor: 'cur-1' })]);
    const client = makeClient(fetch);
    const request = { sort: 'alpha', order: 'asc', limit: 100, offset: 0 } as Parameters<
      RestClient['queryStructureThoughts']
    >[1];
    const controller = new AbortController();

    const res = await client.queryStructureThoughts('net1', request, { signal: controller.signal });

    assert.equal(res.total, 3);
    assert.equal(res.next_cursor, 'cur-1');
    const body = JSON.parse(String(calls[0]!.init.body)) as { count?: boolean };
    assert.equal(body.count, true, 'транспорт просит COUNT явно — экрану нужен счётчик');
    assert.ok(calls[0]!.init.signal instanceof AbortSignal, 'signal обязан дойти до fetch');
    assert.equal(calls[0]!.init.signal?.aborted, false);
  });

  it('явный count: false не перетирается транспортом', async () => {
    const { fetch, calls } = makeFetch([listMeta({ total: null, has_more: false, next_cursor: null })]);
    const client = makeClient(fetch);
    const request = {
      sort: 'alpha',
      order: 'asc',
      limit: 100,
      offset: 0,
      count: false,
    } as Parameters<RestClient['queryStructureThoughts']>[1];

    const res = await client.queryStructureThoughts('net1', request);

    const body = JSON.parse(String(calls[0]!.init.body)) as { count?: boolean };
    assert.equal(body.count, false);
    // Сервер COUNT не считал — транспорт подставляет длину страницы.
    assert.equal(res.total, 0);
  });
});

/**
 * Ошибка da2c68a7: клиент 0.9.1 всегда шлёт `count` (и `cursor` на продолжении),
 * а сервер старше этапа 4 тех.проекта e29c0f00 держит строгий REST-контракт
 * запроса — лишнее поле роняет весь отбор `VALIDATION_ERROR`, и экран
 * «Структуры» остаётся пустым при любом фильтре. Транспорт обязан деградировать
 * на старый сервер: повторить запрос без новых полей и листать по `offset`.
 */
describe('RestClient — деградация выборки на сервер без count/cursor (da2c68a7)', () => {
  /** Ответ старого сервера на неизвестное поле строгого контракта. */
  function unknownField(field: string): { status: number; body: unknown } {
    return {
      status: 422,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: `Неизвестные поля: ${field}.`,
          details: { fields: [field] },
        },
      },
    };
  }

  /** Список-конверт старого сервера: `total` без `next_cursor`. */
  function oldList(items: unknown[], total: number): { status: number; body: unknown } {
    return {
      status: 200,
      body: { data: items, meta: { total, offset: 0, limit: items.length, directions: {} } },
    };
  }

  /** Минимальная мысль-ссылка для страницы. */
  function ref(id: string): { id: string; title: string; type_id: null; active: boolean } {
    return { id, title: id, type_id: null, active: true };
  }

  it('повторяет запрос без count и листает offset-курсором', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ref(`t${i}`));
    const { fetch, calls } = makeFetch([
      unknownField('count'),
      oldList(page1, 250),
      oldList([ref('t100')], 250),
    ]);
    const client = makeClient(fetch);
    const request = {
      sort: 'created',
      order: 'asc',
      limit: 100,
      offset: 0,
    } as Parameters<RestClient['queryStructureThoughts']>[1];

    const res = await client.queryStructureThoughts('net1', request);

    assert.equal(res.items.length, 100, 'отбор снова возвращает результат');
    assert.equal(res.total, 250, 'счётчик берётся из meta.total старого сервера');
    assert.equal(res.next_cursor, 'offset:100', 'продолжение задаётся offset-курсором');
    // Первый запрос нёс count (и был отвергнут), повтор — уже нет.
    assert.equal((JSON.parse(String(calls[0]!.init.body)) as { count?: boolean }).count, true);
    const retry = JSON.parse(String(calls[1]!.init.body)) as { count?: boolean; offset?: number };
    assert.equal(retry.count, undefined, 'повтор уходит без неизвестного поля count');
    assert.equal(retry.offset, 0);

    // Следующая страница: транспорт разворачивает offset-курсор обратно в offset.
    const res2 = await client.queryStructureThoughts('net1', {
      ...request,
      cursor: res.next_cursor ?? undefined,
    });
    const page2 = JSON.parse(String(calls[2]!.init.body)) as {
      count?: boolean;
      offset?: number;
      cursor?: string;
    };
    assert.equal(page2.count, undefined);
    assert.equal(page2.offset, 100);
    assert.equal(page2.cursor, undefined, 'курсор-заглушка не уходит на старый сервер');
    assert.equal(res2.items.length, 1);
    assert.equal(res2.next_cursor, null, 'последняя страница закрывает листание');
  });

  it('на новом сервере count запрашивается, а реальный курсор не теряется', async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { data: [], meta: { total: 0, directions: {}, next_cursor: null } } },
    ]);
    const client = makeClient(fetch);
    await client.queryStructureThoughts('net1', {
      sort: 'created',
      order: 'asc',
      limit: 100,
      offset: 0,
      cursor: 'real-keyset-cursor',
    } as Parameters<RestClient['queryStructureThoughts']>[1]);

    const body = JSON.parse(String(calls[0]!.init.body)) as { count?: boolean; cursor?: string };
    assert.equal(body.count, true);
    assert.equal(body.cursor, 'real-keyset-cursor', 'keyset-курсор нового сервера обязан уходить в тело');
  });

  it('ids_only на старом сервере тоже листается offset-курсором', async () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `i${i}`);
    const { fetch, calls } = makeFetch([
      unknownField('count'),
      { status: 200, body: { data: { ids, total: 5000 } } },
    ]);
    const client = makeClient(fetch);

    const res = await client.queryStructureThoughtIds('net1', {
      sort: 'created',
      order: 'asc',
      limit: 2000,
      offset: 0,
    } as Parameters<RestClient['queryStructureThoughtIds']>[1]);

    assert.equal(res.ids.length, 2000);
    assert.equal(res.total, 5000);
    assert.equal(res.next_cursor, 'offset:2000');
    const retry = JSON.parse(String(calls[1]!.init.body)) as { count?: boolean; cursor?: string };
    assert.equal(retry.count, undefined);
    assert.equal(retry.cursor, undefined);
  });
});
