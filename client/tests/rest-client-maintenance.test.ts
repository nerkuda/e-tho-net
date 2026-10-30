/**
 * RestClient при обслуживании сервера (задача 479e37ed, требование 9636b1cc).
 *
 * - `503 SERVER_UPDATING` с `Retry-After` разбирается штатно и НЕ повторяется
 *   внутри вызова: срок повтора у него собственный — серверный `Retry-After`;
 * - отказ переводит клиент в состояние обслуживания (конверт `details`:
 *   `retry_after`, `target_version`), и до восстановления изменяющие запросы
 *   не уходят вовсе — пользователь получает канонический `SERVER_UPDATING`, а
 *   не «сервер недоступен»;
 * - чтения во время обслуживания проходят, а успешный `GET /me` подтверждает
 *   конец обслуживания и снимает блокировку записи (сценарий 610169a5).
 *
 * Сеть не используется: `fetch` подменён очередью канонических ответов.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError, type ServerUpdatingErrorDetails } from '@etn/shared';

import { RestClient } from '../src/main/net/rest-client.js';
import { ServerMaintenanceState } from '../src/main/server-maintenance.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Stub `fetch` with a queue of canned responses (last one repeats). */
function makeFetch(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let cursor = 0;
  const fetchStub = ((url: string, init?: RequestInit): Promise<Response> => {
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
    const response = {
      ok: canned.status >= 200 && canned.status < 300,
      status: canned.status,
      headers: new Headers(canned.headers ?? { 'content-type': 'application/json' }),
      text: () => Promise.resolve(bodyStr),
      json: () => Promise.resolve(canned.body === undefined ? undefined : JSON.parse(bodyStr)),
    } as unknown as Response;
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { fetch: fetchStub, calls };
}

/** RestClient + shared maintenance state wired the way `ipc/register.ts` does. */
function makeClient(
  fetchImpl: typeof fetch,
  maintenance: ServerMaintenanceState,
  extra: { onServerMaintenanceEnded?: () => void } = {},
): RestClient {
  return new RestClient({
    baseUrl: 'http://localhost:3000',
    getApiKey: async () => 'etn_testkey',
    getClientId: () => '11111111-1111-1111-1111-111111111111',
    clientVersion: '0.15.1',
    fetchImpl,
    random: () => 0,
    serverMaintenance: maintenance,
    ...extra,
  });
}

interface RouteCall {
  method: string;
  path: string;
}

type RouteResponse = { status: number; body?: unknown; headers?: Record<string, string> };

/**
 * Stub `fetch` by route `METHOD /path` (последний ответ маршрута повторяется,
 * `setRoute` меняет его на ходу). Нужен тестам правила выхода: `/version`
 * обязан вернуть ДРУГУЮ версию, чтобы `/me` считался доказательством.
 */
function makeRoutedFetch(routes: Record<string, RouteResponse>): {
  fetch: typeof fetch;
  calls: RouteCall[];
  setRoute: (route: string, response: RouteResponse) => void;
} {
  const store = { ...routes };
  const calls: RouteCall[] = [];
  const fetchStub = ((input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, '');
    calls.push({ method, path });
    const canned = store[`${method} ${path}`];
    if (canned === undefined) {
      throw new Error(`makeRoutedFetch: нет маршрута ${method} ${path}`);
    }
    const bodyStr =
      canned.body === undefined
        ? ''
        : typeof canned.body === 'string'
          ? canned.body
          : JSON.stringify(canned.body);
    const response = {
      ok: canned.status >= 200 && canned.status < 300,
      status: canned.status,
      headers: new Headers(canned.headers ?? { 'content-type': 'application/json' }),
      text: () => Promise.resolve(bodyStr),
      json: () => Promise.resolve(canned.body === undefined ? undefined : JSON.parse(bodyStr)),
    } as unknown as Response;
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return {
    fetch: fetchStub,
    calls,
    setRoute: (route, response) => {
      store[route] = response;
    },
  };
}

/** Успешный публичный `GET /version` с заданной версией процесса. */
function versionResponse(version: string): RouteResponse {
  return {
    status: 200,
    body: {
      data: {
        version,
        api: 'v1',
        min_client: '0.15.0',
        client_compatibility: '>=0.15.0 <0.16.0',
      },
    },
  };
}

/** Канонический конверт `503 SERVER_UPDATING` с заголовком `Retry-After`. */
function updatingResponse(details: ServerUpdatingErrorDetails): {
  status: number;
  body: unknown;
  headers: Record<string, string>;
} {
  return {
    status: 503,
    headers: {
      'content-type': 'application/json',
      'retry-after': String(details.retry_after),
    },
    body: {
      error: {
        code: 'SERVER_UPDATING',
        message: 'Сервер обновляется, повторите позже.',
        details,
      },
    },
  };
}

const ME = { id: 'u1', username: 'a', display_name: null, is_admin: false };

describe('RestClient — обслуживание сервера (479e37ed)', () => {
  it('503 SERVER_UPDATING не повторяется: одна попытка, конверт разобран, состояние включено', async () => {
    const details: ServerUpdatingErrorDetails = { retry_after: 120, target_version: '0.15.2' };
    const { fetch, calls } = makeFetch([updatingResponse(details)]);
    const maintenance = new ServerMaintenanceState();
    const client = makeClient(fetch, maintenance);

    await assert.rejects(
      () => client.createThought('net1', { title: 'новая мысль' }),
      (err: unknown) => {
        assert.ok(err instanceof EtnError);
        assert.equal(err.code, 'SERVER_UPDATING');
        assert.deepEqual(err.details, details);
        return true;
      },
    );
    // Ни одной повторной попытки: срок повтора — `Retry-After`, а не backoff.
    assert.equal(calls.length, 1);
    const info = maintenance.get();
    assert.notEqual(info, null);
    assert.equal(info?.retry_after, 120);
    assert.equal(info?.target_version, '0.15.2');
    assert.equal(info?.source, 'rest');
  });

  it('пока обслуживание активно, изменяющий запрос не уходит и отдаёт SERVER_UPDATING', async () => {
    const maintenance = new ServerMaintenanceState();
    maintenance.enter({ retry_after: 60, target_version: null }, 'realtime');
    const { fetch, calls } = makeFetch([{ status: 200, body: { data: ME } }]);
    const client = makeClient(fetch, maintenance);

    await assert.rejects(
      () => client.updateMe('Имя'),
      (err: unknown) => {
        assert.ok(err instanceof EtnError);
        assert.equal(err.code, 'SERVER_UPDATING');
        assert.deepEqual(err.details, { retry_after: 60, target_version: null });
        return true;
      },
    );
    assert.equal(calls.length, 0, 'запрос не отправлен вовсе');
  });

  it('чтения во время обслуживания проходят; /me 200 без смены версии режим НЕ снимает', async () => {
    // Вердикт повторной приёмки 479e37ed: сервер в обслуживании отвечает на
    // `/me` 200 (чтения не блокируются), поэтому успех `/me` сам по себе не
    // отличает старый процесс от нового. Доказательство — смена версии,
    // которую показывает публичный `GET /version`.
    const maintenance = new ServerMaintenanceState();
    maintenance.enter({ retry_after: 60, target_version: null }, 'realtime', '0.15.1');
    const { fetch, calls, setRoute } = makeRoutedFetch({
      'GET /networks': { status: 200, body: { data: [] } },
      'GET /me': { status: 200, body: { data: ME } },
      'GET /version': versionResponse('0.15.1'),
    });
    const client = makeClient(fetch, maintenance);

    // Произвольное чтение режим не снимает.
    await client.listNetworks();
    assert.notEqual(maintenance.get(), null, 'чтение не подтверждает конец обслуживания');

    // `/me` 200, но версия процесса прежняя — это тот же старый процесс.
    const me = await client.getMe();
    assert.equal(me.id, 'u1');
    assert.notEqual(maintenance.get(), null, '/me без смены версии НЕ выход');
    assert.equal(calls.filter((c) => c.path === '/version').length, 1, 'ровно один GET /version на проверку');

    // Обновлённый процесс поднялся — та же проверка теперь даёт выход.
    setRoute('GET /version', versionResponse('0.15.2'));
    await client.getMe();
    assert.equal(maintenance.get(), null, '/me + другая версия процесса — выход');
    assert.equal(calls.filter((c) => c.path === '/version').length, 2);

    // Блокировка записи снята: следующая мутация уходит в сеть.
    const next = makeFetch([{ status: 200, body: { data: ME } }]);
    const client2 = makeClient(next.fetch, maintenance);
    await client2.updateMe('Имя');
    assert.equal(next.calls.length, 1);
  });

  it('target_version известна: выход по версии не меньше целевой, без ожидания смены базы', async () => {
    const maintenance = new ServerMaintenanceState();
    maintenance.enter({ retry_after: 60, target_version: '0.15.2' }, 'realtime', '0.15.1');
    const { fetch } = makeRoutedFetch({
      'GET /me': { status: 200, body: { data: ME } },
      'GET /version': versionResponse('0.15.2'),
    });
    let ended = 0;
    const client = makeClient(fetch, maintenance, { onServerMaintenanceEnded: () => (ended += 1) });

    await client.getMe();
    assert.equal(maintenance.get(), null, 'версия процесса достигла target_version');
    assert.equal(ended, 1);
  });

  it('неудачная проверка /version оставляет обслуживание активным', async () => {
    const maintenance = new ServerMaintenanceState();
    maintenance.enter({ retry_after: 60, target_version: null }, 'realtime', '0.15.1');
    const { fetch, calls } = makeRoutedFetch({
      'GET /me': { status: 200, body: { data: ME } },
      'GET /version': { status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } },
    });
    let ended = 0;
    const client = makeClient(fetch, maintenance, { onServerMaintenanceEnded: () => (ended += 1) });

    const me = await client.getMe();
    assert.equal(me.id, 'u1', 'ответ /me не ломается неудачей проверки версии');
    assert.notEqual(maintenance.get(), null, 'без доказательства состояние остаётся');
    assert.equal(ended, 0, 'колбэк выхода не вызывается');
    // `/version` идёт напрямую (requestRaw): одна попытка, без повторов.
    assert.equal(calls.filter((c) => c.path === '/version').length, 1);
  });

  it('вне обслуживания /me не запрашивает /version (лишнего запроса нет)', async () => {
    const maintenance = new ServerMaintenanceState();
    const { fetch, calls } = makeRoutedFetch({
      'GET /me': { status: 200, body: { data: ME } },
    });
    const client = makeClient(fetch, maintenance);

    await client.getMe();
    assert.deepEqual(
      calls.map((c) => c.path),
      ['/me'],
      'проверка версии выполняется только при активном обслуживании',
    );
  });

  it('вход по 503 запоминает версию процесса на входе: её смена и есть выход', async () => {
    const maintenance = new ServerMaintenanceState();
    const { fetch, calls, setRoute } = makeRoutedFetch({
      'GET /version': versionResponse('0.15.1'),
      'POST /networks/net1/thoughts': updatingResponse({ retry_after: 60, target_version: null }),
      'GET /me': { status: 200, body: { data: ME } },
    });
    const client = makeClient(fetch, maintenance);

    // Клиент уже знает версию процесса (проверка совместимости при подключении).
    await client.getVersion();
    await assert.rejects(
      () => client.createThought('net1', { title: 'новая мысль' }),
      (err: unknown) => err instanceof EtnError && err.code === 'SERVER_UPDATING',
    );
    assert.equal(maintenance.get()?.entry_version, '0.15.1', 'база эпизода — наблюдённая версия');

    // Прежняя версия — не выход.
    await client.getMe();
    assert.notEqual(maintenance.get(), null);
    // Новая версия того же публичного `/version` — выход.
    setRoute('GET /version', versionResponse('0.15.2'));
    await client.getMe();
    assert.equal(maintenance.get(), null, 'смена версии процесса завершает обслуживание');
    assert.equal(calls.filter((c) => c.path === '/version').length, 3, 'два наблюдения + проверка в /me');
  });

  it('голый 503 без Retry-After остаётся транзиентной ошибкой и повторяется', async () => {
    const { fetch, calls } = makeFetch([
      { status: 503, body: { error: { code: 'INTERNAL', message: 'unavailable' } } },
      { status: 200, body: { data: ME } },
    ]);
    const maintenance = new ServerMaintenanceState();
    const client = makeClient(fetch, maintenance);

    const me = await client.getMe();
    assert.equal(me.id, 'u1');
    assert.equal(calls.length, 2, '1 попытка + 1 повтор');
    assert.equal(maintenance.get(), null);
  });

  it('503 прокси с Retry-After, но без конверта SERVER_UPDATING, — транзиентный: 3 попытки', async () => {
    // Замечание приёмки 479e37ed: признак обслуживания — КОД в конверте, а не
    // заголовок. Прокси/балансировщик ставит `Retry-After` по своим правилам;
    // раньше такой ответ не повторялся и показывался как «сервер недоступен».
    const { fetch, calls } = makeFetch([
      {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '300' },
        body: { error: { code: 'INTERNAL', message: 'service unavailable' } },
      },
    ]);
    const maintenance = new ServerMaintenanceState();
    const client = makeClient(fetch, maintenance);

    await assert.rejects(
      () => client.createThought('net1', { title: 'новая мысль' }),
      (err: unknown) => {
        assert.ok(err instanceof EtnError);
        assert.equal(err.code, 'INTERNAL');
        assert.notEqual(err.code, 'SERVER_UPDATING');
        return true;
      },
    );
    assert.equal(calls.length, 3, 'все три попытки, как у любой транзиентной 5xx');
    assert.equal(maintenance.get(), null, 'обслуживание не включено');
  });

  it('503 SERVER_UPDATING без заголовка Retry-After распознаётся по конверту: одна попытка', async () => {
    const details: ServerUpdatingErrorDetails = { retry_after: 300, target_version: '0.15.2' };
    const { fetch, calls } = makeFetch([
      {
        status: 503,
        headers: { 'content-type': 'application/json' },
        body: {
          error: { code: 'SERVER_UPDATING', message: 'Сервер обновляется.', details },
        },
      },
    ]);
    const maintenance = new ServerMaintenanceState();
    const client = makeClient(fetch, maintenance);

    await assert.rejects(
      () => client.createThought('net1', { title: 'новая мысль' }),
      (err: unknown) => err instanceof EtnError && err.code === 'SERVER_UPDATING',
    );
    assert.equal(calls.length, 1, 'конверт обслуживания не повторяется (срок — свой)');
    assert.equal(maintenance.get()?.retry_after, 300);
  });

  it('голый 503 с пустым телом — отказ после 3 попыток, а не «успех» с undefined', async () => {
    // Пустое тело 5xx — отказ, а не данные: иначе вызывающий получил бы
    // `undefined` как успешный результат (тот же класс, что голый 503).
    const { fetch, calls } = makeFetch([
      { status: 503, headers: { 'content-type': 'text/plain' } },
    ]);
    const maintenance = new ServerMaintenanceState();
    const client = makeClient(fetch, maintenance);

    await assert.rejects(
      () => client.getMe(),
      (err: unknown) => {
        assert.ok(err instanceof EtnError);
        assert.equal(err.code, 'INTERNAL');
        return true;
      },
    );
    assert.equal(calls.length, 3, '3 попытки транзиентной ошибки');
  });

  it('действующий выход по /me сообщает владельцу (forceReconnect + checkCompatibility)', async () => {
    const maintenance = new ServerMaintenanceState();
    maintenance.enter({ retry_after: 60, target_version: '0.15.2' }, 'realtime', '0.15.1');
    const { fetch } = makeRoutedFetch({
      'GET /me': { status: 200, body: { data: ME } },
      'GET /version': versionResponse('0.15.2'),
    });
    let ended = 0;
    const client = makeClient(fetch, maintenance, {
      onServerMaintenanceEnded: () => {
        ended += 1;
      },
    });

    await client.getMe();
    assert.equal(maintenance.get(), null, 'GET /me + смена версии сняли обслуживание');
    assert.equal(ended, 1, 'владелец получил сигнал выхода (реконнект + checkCompatibility)');

    // Состояние уже неактивно — повторный /me колбэк НЕ дёргает.
    await client.getMe();
    assert.equal(ended, 1, 'сигнал выхода — только при действующем выходе');
  });
});
