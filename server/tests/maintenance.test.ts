/**
 * Режим обслуживания сервера (задача 2f599b67, сущность aa55d459; требования
 * 20be64a8 «REST 503 SERVER_UPDATING», f84db18e «MCP SERVER_UPDATING»,
 * 9636b1cc «кадр maintenance и close 1012»).
 *
 * Три слоя проверки:
 *  - юнит: состояние сервиса (после старта `idle`, нормализация `retry_after`,
 *    кадр рассылается один раз) и гейт запроса (методы чтения и читающие
 *    `POST` из allowlist пропускаются, `/mcp` не перехватывается);
 *  - сквозная матрица на реальном Fastify-приложении: `/health`, `/version` и
 *    `/me` — 200, чтение — 200, все изменяющие методы — `503 SERVER_UPDATING` с
 *    `Retry-After`; гонка «запись в момент перехода»: запись до перехода
 *    проходит, сразу после вызова `beginUpdating` и после доставки кадра —
 *    нет; 503 приоритетнее 426;
 *  - WebSocket на живом порту: кадр `maintenance` приходит до close `1012`
 *    `server updating`, новый сокет в период обслуживания сразу получает 1012;
 *  - MCP (общий диспетчер stdio/HTTP): изменяющий инструмент отвечает
 *    `SERVER_UPDATING` с `retry_after`, читающий и read-only действие `etn.ops`
 *    проходят; HTTP-эндпоинт `/mcp` не перехватывается REST-503 (отдельный
 *    тест в `mcp-http.test.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WebSocket } from 'ws';

import type { HealthResponse } from '@etn/shared';

import {
  DEFAULT_MAINTENANCE_RETRY_AFTER_SECONDS,
  MIN_MAINTENANCE_RETRY_AFTER_SECONDS,
  SERVER_UPDATING_MESSAGE,
  createMaintenanceService,
  type MaintenanceState,
} from '../src/maintenance.js';
import { createMaintenanceGuard } from '../src/http/maintenance-guard.js';
import { READ_ONLY_POST_ROUTES } from '../src/auth/client-version-guard.js';
import {
  apiCreateThought,
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';
import {
  buildMcpContext,
  closeMcpContext,
  connectMcpClient,
  toolText,
} from './mcp-helpers.js';

/** Состояние обслуживания, которое отдают провайдеры в тестах MCP. */
const UPDATING_STATE: MaintenanceState = {
  state: 'updating',
  reason: 'server-updating',
  since: '2026-10-29T12:00:00.000Z',
  retry_after: 120,
  target_version: '0.99.0',
};

/** Запрос-двойник гейта: только метод и адрес (как у guard'а версии). */
function fakeReq(
  method: string,
  url: string,
  routeUrl?: string,
): Parameters<ReturnType<typeof createMaintenanceGuard>>[0] {
  return routeUrl === undefined
    ? { method, headers: {}, url }
    : { method, headers: {}, url, routeOptions: { url: routeUrl } };
}

/** Конкретный адрес из шаблона маршрута: `:param` → значение. */
function concretePath(route: string): string {
  return route
    .replace(/:networkId/g, 'net-1')
    .replace(/:thoughtId/g, 'thought-1')
    .replace(/:id/g, 'owner-1')
    .replace(/:key/g, 'author')
    .replace(/:view/g, 'my-view');
}

describe('состояние обслуживания — юнит', () => {
  it('после старта всегда idle с паузой по умолчанию', () => {
    const service = createMaintenanceService({ announce: async () => undefined });
    assert.deepEqual(service.getState(), {
      state: 'idle',
      reason: null,
      since: null,
      retry_after: DEFAULT_MAINTENANCE_RETRY_AFTER_SECONDS,
      target_version: null,
    });
  });

  it('beginUpdating переводит в updating и отдаёт кадр с полями состояния', async () => {
    const frames: unknown[] = [];
    const service = createMaintenanceService({
      announce: async (frame) => {
        frames.push(frame);
      },
      now: () => new Date('2026-10-29T12:34:56.789Z'),
    });

    const state = await service.beginUpdating({ target_version: '0.15.2', retry_after: 90 });

    assert.equal(state.state, 'updating');
    assert.equal(state.reason, 'server-updating');
    assert.equal(state.since, '2026-10-29T12:34:56.789Z');
    assert.equal(state.retry_after, 90);
    assert.equal(state.target_version, '0.15.2');
    assert.deepEqual(frames, [
      { type: 'maintenance', reason: 'server-updating', retry_after: 90, target_version: '0.15.2' },
    ]);
    // Состояние сервиса меняется до рассылки: изменяющие запросы уже
    // отклоняются, пока кадр летит (проверка ниже, в гонке).
    assert.deepEqual(service.getState(), state);
  });

  it('retry_after — целые секунды, не меньше 30; мусор заменяется дефолтом', async () => {
    const cases: Array<[number | undefined, number]> = [
      [undefined, DEFAULT_MAINTENANCE_RETRY_AFTER_SECONDS],
      [5, MIN_MAINTENANCE_RETRY_AFTER_SECONDS],
      [30.9, 30],
      [75.7, 75],
      [Number.NaN, DEFAULT_MAINTENANCE_RETRY_AFTER_SECONDS],
      [Number.POSITIVE_INFINITY, DEFAULT_MAINTENANCE_RETRY_AFTER_SECONDS],
    ];
    for (const [input, expected] of cases) {
      const service = createMaintenanceService({ announce: async () => undefined });
      const state = await service.beginUpdating(
        input === undefined ? {} : { retry_after: input },
      );
      assert.equal(state.retry_after, expected, String(input));
      assert.equal(state.target_version, null);
    }
  });

  it('повторный begin не рассылает кадр второй раз и ждёт ту же доставку', async () => {
    let announced = 0;
    let release: (() => void) | null = null;
    const service = createMaintenanceService({
      announce: () =>
        new Promise<void>((resolve) => {
          announced += 1;
          release = resolve;
        }),
    });

    const first = service.beginUpdating({ target_version: '0.15.2' });
    // Второй сигнал (например, повторный apply) не дублирует рассылку и не
    // возвращается раньше доставки первого кадра.
    let secondSettled = false;
    const second = service.beginUpdating().then((state) => {
      secondSettled = true;
      return state;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(announced, 1);
    assert.equal(secondSettled, false);

    (release as unknown as () => void)();
    const firstState = await first;
    assert.deepEqual(await second, firstState);
    assert.equal(firstState.target_version, '0.15.2');
    assert.equal(firstState.retry_after, DEFAULT_MAINTENANCE_RETRY_AFTER_SECONDS);
  });
});

describe('REST-гейт обслуживания — юнит', () => {
  const idle = createMaintenanceGuard({ getState: () => null });
  const updating = createMaintenanceGuard({ getState: () => UPDATING_STATE });

  it('в idle не блокирует ничего', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(idle(fakeReq(method, '/api/v1/networks/net-1/thoughts')), null, method);
    }
  });

  it('в updating методы чтения не блокируются', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(updating(fakeReq(method, '/api/v1/networks/net-1/thoughts')), null, method);
    }
  });

  it('читающие POST из allowlist пропускаются — весь список, с шаблоном и сырым адресом', () => {
    for (const route of READ_ONLY_POST_ROUTES) {
      const concrete = concretePath(route);
      assert.equal(updating(fakeReq('POST', concrete, route)), null, route);
      assert.equal(updating(fakeReq('POST', concrete)), null, `${route}: raw url`);
      assert.equal(updating(fakeReq('POST', `${concrete}/?x=1#frag`)), null, `${route}: normalized`);
    }
  });

  it('изменяющие методы и POST вне allowlist получают значения отказа', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const rejection = updating(fakeReq(method, '/api/v1/networks/net-1/thoughts'));
      assert.deepEqual(rejection, { retry_after: 120, target_version: '0.99.0' }, method);
    }
    for (const path of [
      '/api/v1/networks',
      '/api/v1/networks/net-1/thoughts',
      '/api/v1/networks/net-1/thoughts/batch',
      '/api/v1/networks/net-1/import/commit',
    ]) {
      assert.deepEqual(
        updating(fakeReq('POST', path)),
        { retry_after: 120, target_version: '0.99.0' },
        path,
      );
    }
    // DELETE по читающему пути остаётся изменяющим запросом.
    assert.deepEqual(
      updating(fakeReq('DELETE', concretePath('/api/v1/networks/:networkId/thoughts/query'))),
      { retry_after: 120, target_version: '0.99.0' },
    );
    // Похожий, но другой путь не совпадает с allowlist.
    assert.notEqual(
      updating(fakeReq('POST', '/api/v1/networks/net-1/thoughts/query/extra')),
      null,
    );
  });

  it('/mcp не перехватывается общим REST-гейтом', () => {
    assert.equal(updating(fakeReq('POST', '/mcp')), null);
    assert.equal(updating(fakeReq('GET', '/mcp')), null);
    assert.equal(updating(fakeReq('POST', '/mcp?x=1')), null);
    // Чужой путь с тем же префиксом — гейт работает.
    assert.notEqual(updating(fakeReq('POST', '/mcp/extra')), null);
  });
});

describe('обслуживание — сквозная матрица REST', { skip: !nativeAvailable() }, () => {
  it('после старта сервер в состоянии idle', async () => {
    const ctx = await buildRestContext();
    try {
      assert.deepEqual(ctx.app.maintenance.getState(), {
        state: 'idle',
        reason: null,
        since: null,
        retry_after: DEFAULT_MAINTENANCE_RETRY_AFTER_SECONDS,
        target_version: null,
      });
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('/health, /version, /me и чтение остаются доступны; изменяющие — 503 с Retry-After', async () => {
    const ctx = await buildRestContext();
    try {
      const created = await apiCreateThought(ctx, { title: 'До обслуживания' });
      assert.equal(created.statusCode, 201);

      await ctx.app.maintenance.beginUpdating({ target_version: '0.99.0', retry_after: 45 });

      // Сервер жив: health и version — 200 (по ним установщик проверяет
      // здоровье), /me — 200 (по успешному /me клиент видит конец обслуживания).
      for (const url of ['/api/v1/health', '/api/v1/version', '/api/v1/me']) {
        const res = await ctx.app.inject({ method: 'GET', url, headers: authHeaders(ctx) });
        assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
        if (url === '/api/v1/health') {
          // Health в обслуживании по-прежнему проверяет БД (задача 0178253c):
          // установщик ждёт db:"ok" именно в этот период.
          assert.equal((res.json() as HealthResponse).db, 'ok', 'db в обслуживании');
        }
      }

      // Чтение через POST-allowlist не блокируется.
      const query = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/thoughts/query`,
        headers: authHeaders(ctx),
        payload: { keywords: 'обслуживания', limit: 10 },
      });
      assert.equal(query.statusCode, 200, query.body);
      assert.equal((query.json().data as Array<{ title: string }>)[0]?.title, 'До обслуживания');

      // Изменяющие методы — 503 каноническим конвертом.
      const mutating: Array<{
        method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        url: string;
        payload?: Record<string, unknown>;
      }> = [
        { method: 'POST', url: '/api/v1/networks', payload: { display_name: 'Нет' } },
        { method: 'POST', url: `/api/v1/networks/${ctx.networkId}/thoughts`, payload: { title: 'Нет' } },
        { method: 'PATCH', url: '/api/v1/me', payload: { display_name: 'Нет' } },
        { method: 'PUT', url: '/api/v1/users/me/settings/comment_hotkeys', payload: { value: {} } },
        { method: 'DELETE', url: '/api/v1/me/keys/00000000-0000-4000-8000-000000000000' },
      ];
      for (const c of mutating) {
        const res = await ctx.app.inject({
          method: c.method,
          url: c.url,
          headers: { ...authHeaders(ctx), 'client-request-id': `maint-${c.method}` },
          ...(c.payload === undefined ? {} : { payload: c.payload }),
        });
        assert.equal(res.statusCode, 503, `${c.method} ${c.url}: ${res.body}`);
        assert.equal(res.headers['retry-after'], '45', `${c.method} ${c.url}: Retry-After`);
        const body = res.json() as {
          error: { code: string; message: string; details: unknown; request_id?: string };
        };
        assert.equal(body.error.code, 'SERVER_UPDATING', `${c.method} ${c.url}`);
        assert.equal(body.error.message, SERVER_UPDATING_MESSAGE);
        assert.deepEqual(body.error.details, { retry_after: 45, target_version: '0.99.0' });
        assert.equal(body.error.request_id, `maint-${c.method}`);
      }
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('503 обслуживания приоритетнее 426 проверки версии клиента', async () => {
    const ctx = await buildRestContext();
    try {
      await ctx.app.maintenance.beginUpdating({ retry_after: 60 });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/networks',
        headers: {
          ...authHeaders(ctx),
          'client-id': 'it-client-0000-0000-0000-000000000000',
          'client-version': '0.0.1',
        },
        payload: { display_name: 'Нет' },
      });
      assert.equal(res.statusCode, 503, res.body);
      assert.equal(res.json().error.code, 'SERVER_UPDATING');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('гонка перехода: запись до — проходит, в момент перехода и после кадра — 503', async () => {
    const ctx = await buildRestContext();
    try {
      const before = await apiCreateThought(ctx, { title: 'До перехода' });
      assert.equal(before.statusCode, 201);

      // Состояние меняется синхронно в первом же шаге beginUpdating, поэтому
      // запись, отправленная до доставки кадра, уже не проходит.
      const beginning = ctx.app.maintenance.beginUpdating({ retry_after: 30 });
      const duringTransition = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/thoughts`,
        headers: authHeaders(ctx),
        payload: { title: 'В момент перехода' },
      });
      assert.equal(duringTransition.statusCode, 503, duringTransition.body);
      assert.equal(duringTransition.json().error.code, 'SERVER_UPDATING');

      await beginning;
      const afterDelivery = await apiCreateThought(ctx, { title: 'После кадра' });
      assert.equal(afterDelivery.statusCode, 503);

      // Ни одна из отвергнутых записей не создалась.
      const titles = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/thoughts/query`,
        headers: authHeaders(ctx),
        payload: { limit: 100 },
      });
      assert.equal(titles.statusCode, 200);
      const found = (titles.json().data as Array<{ title: string }>).map((t) => t.title);
      assert.ok(found.includes('До перехода'), JSON.stringify(found));
      assert.ok(!found.includes('В момент перехода'), JSON.stringify(found));
      assert.ok(!found.includes('После кадра'), JSON.stringify(found));
    } finally {
      await closeRestContext(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// WebSocket: кадр `maintenance` до close `1012` (требование 9636b1cc)
// ---------------------------------------------------------------------------

/** Открыть WS-клиент на `/api/v1/realtime` тестового приложения. */
function connectRealtime(ctx: RestTestContext, port: number): WebSocket {
  const url = new URL(`ws://127.0.0.1:${port}/api/v1/realtime`);
  url.searchParams.set('network_id', ctx.networkId);
  return new WebSocket(url, { headers: authHeaders(ctx) });
}

/** Дождаться открытия сокета (гонка `open` уже случился — учитывается). */
function waitForOpen(ws: WebSocket, timeoutMs = 10_000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws: open timeout')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`ws: closed with ${code} before open`));
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Дождаться закрытия сокета и вернуть код с причиной. */
function waitForClose(ws: WebSocket, timeoutMs = 10_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      reject(new Error('ws: already closed'));
      return;
    }
    const timer = setTimeout(() => reject(new Error('ws: close timeout')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

describe('обслуживание — WebSocket', { skip: !nativeAvailable() }, () => {
  it('кадр maintenance доставляется до close 1012, новый сокет тоже получает 1012', async () => {
    const ctx = await buildRestContext();
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const address = ctx.app.server.address();
      assert.ok(address !== null && typeof address === 'object');
      const port = address.port;

      const ws = connectRealtime(ctx, port);
      const frames: unknown[] = [];
      ws.on('message', (data) => {
        frames.push(JSON.parse(data.toString()) as unknown);
      });
      await waitForOpen(ws);
      const closed = waitForClose(ws);

      await ctx.app.maintenance.beginUpdating({ target_version: '0.99.0', retry_after: 45 });
      const info = await closed;

      assert.equal(info.code, 1012, 'close 1012 service restart');
      assert.equal(info.reason, 'server updating');
      assert.deepEqual(frames, [
        // Кадр готовности (ADR daab6ac4, задача f99f0542) приходит сразу после
        // подключения — до кадра обслуживания.
        { type: 'ready', language: 'en', source: 'server' },
        {
          type: 'maintenance',
          reason: 'server-updating',
          retry_after: 45,
          target_version: '0.99.0',
        },
      ]);

      // Кадр доставлен до закрытия: к моменту close он уже в массиве.
      // Новый сокет в период обслуживания не принимается — сразу 1012, чтобы
      // клиент не принял скорую остановку службы за сетевую аварию.
      const late = connectRealtime(ctx, port);
      const lateClose = await waitForClose(late);
      assert.equal(lateClose.code, 1012);
      assert.equal(lateClose.reason, 'server updating');
      assert.equal(ctx.app.realtimeGateway.connectionCount(), 0);
    } finally {
      await closeRestContext(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// MCP: диспетчер отказывает изменяющим инструментам (требование f84db18e)
// ---------------------------------------------------------------------------

describe('обслуживание — MCP-диспетчер', { skip: !nativeAvailable() }, () => {
  it('изменяющий инструмент отвечает SERVER_UPDATING, читающий и read-only etn.ops — работают', async () => {
    const ctx = await buildMcpContext();
    const client = await connectMcpClient(ctx, ctx.adminKey, {
      maintenance: () => UPDATING_STATE,
    });
    try {
      const read = await client.client.callTool({
        name: 'etn.thoughts.search',
        arguments: { network_id: ctx.networkId, query: 'HOME' },
      });
      assert.equal(read.isError, undefined, toolText(read));

      const write = await client.client.callTool({
        name: 'etn.thoughts.write',
        arguments: {
          network_id: ctx.networkId,
          thoughts: [{ ref: 'x', thought: { title: 'Нет' } }],
        },
      });
      assert.equal(write.isError, true);
      const text = toolText(write);
      assert.match(text, /ETN error \[SERVER_UPDATING\]/);
      assert.match(text, /"retry_after":120/);
      assert.match(text, /"target_version":"0\.99\.0"/);

      // Read-only действие `etn.ops` не блокируется.
      const readOp = await client.client.callTool({
        name: 'etn.ops',
        arguments: { action: 'networks.list', params: {} },
      });
      assert.equal(readOp.isError, undefined, toolText(readOp));

      // Изменяющее действие — SERVER_UPDATING ещё до валидации params.
      const writeOp = await client.client.callTool({
        name: 'etn.ops',
        arguments: { action: 'locks.acquire', params: {} },
      });
      assert.equal(writeOp.isError, true);
      assert.match(toolText(writeOp), /ETN error \[SERVER_UPDATING\]/);

      // Ничего не записалось.
      const search = await client.client.callTool({
        name: 'etn.thoughts.search',
        arguments: { network_id: ctx.networkId, query: 'Нет' },
      });
      const found = JSON.parse(toolText(search)) as { by_names?: unknown[] };
      assert.equal((found.by_names ?? []).length, 0);
    } finally {
      await client.close();
      await closeMcpContext(ctx);
    }
  });
});
