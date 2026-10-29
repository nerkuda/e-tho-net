/**
 * Guard версии desktop-клиента (задача c3f33e6a, требование 271e3327, ADR
 * 6ded6a87).
 *
 * Два слоя проверки:
 *  - юнит-матрица `createClientVersionGuard`: методы × наличие `Client-Id` ×
 *    три причины отказа (`version-missing`, `version-invalid`,
 *    `version-out-of-range`), включая пустой заголовок и массив значений;
 *  - сквозная матрица на реальном Fastify-приложении (`buildRestContext`,
 *    настоящий пайплайн и БД): чтение не блокируется, все четыре изменяющих
 *    метода получают 426, запрос без `Client-Id` (API-интеграция) проходит,
 *    диапазон совпадает с `GET /version`, ошибка идёт каноническим конвертом,
 *    а аутентификация выполняется раньше проверки версии.
 *
 * MCP-путь проверяется отдельно в `mcp-http.test.ts` (у `/mcp` собственный
 * транспорт, guard его не касается). Приоритет `503` обслуживания над `426`
 * появится вместе с компонентом maintenance (тех.проект 2d9f5cc7): его
 * `onRequest`-хук выполняется раньше этого preHandler по построению.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  CLIENT_VERSION_ERROR_REASON,
  parseSemver,
  type ClientVersionErrorDetails,
} from '@etn/shared';

import {
  createClientVersionGuard,
  describeClientVersionRejection,
} from '../src/auth/client-version-guard.js';
import { SERVER_VERSION, resolveClientChannel } from '../src/version.js';
import { authHeaders, buildRestContext, closeRestContext, nativeAvailable } from './rest-helpers.js';

/** Канал для юнит-матрицы: диапазон не зависит от версии репозитория. */
const UNIT_CHANNEL = {
  client_compatibility: '>=1.2.0 <1.3.0',
  client_download_url: 'https://example.test/releases/tag/v1.2.5',
};

/** Запрос-двойник guard'а: только метод и заголовки. */
function fakeReq(
  method: string,
  headers: Record<string, string | string[] | undefined> = {},
): Parameters<ReturnType<typeof createClientVersionGuard>>[0] {
  return { method, headers };
}

const unitGuard = createClientVersionGuard({
  clientChannel: UNIT_CHANNEL,
  serverVersion: '1.2.5',
});

describe('client-version-guard — юнит-матрица', () => {
  it('чтение (GET/HEAD/OPTIONS) не проверяется ни при какой версии', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(
        unitGuard(fakeReq(method, { 'client-id': 'c1', 'client-version': '0.0.1' })),
        null,
        method,
      );
      assert.equal(unitGuard(fakeReq(method, { 'client-id': 'c1' })), null, method);
    }
  });

  it('без Client-Id запрос считается API-интеграцией и пропускается', () => {
    assert.equal(unitGuard(fakeReq('POST', { 'client-version': '0.0.1' })), null);
    assert.equal(unitGuard(fakeReq('DELETE', {})), null);
  });

  it('Client-Id есть, Client-Version нет или пуст → version-missing', () => {
    for (const headers of [
      { 'client-id': 'c1' },
      { 'client-id': 'c1', 'client-version': '' },
      { 'client-id': 'c1', 'client-version': '   ' },
    ]) {
      const rejection = unitGuard(fakeReq('POST', headers));
      assert.deepEqual(rejection, {
        reason: CLIENT_VERSION_ERROR_REASON.missing,
        details: { reason: CLIENT_VERSION_ERROR_REASON.missing },
      });
    }
  });

  it('непарсящаяся версия → version-invalid с присланным значением', () => {
    for (const raw of ['garbage', 'v1.2.0', '1.2', '1.2.0.1']) {
      const rejection = unitGuard(fakeReq('PATCH', { 'client-id': 'c1', 'client-version': raw }));
      assert.deepEqual(rejection, {
        reason: CLIENT_VERSION_ERROR_REASON.invalid,
        details: { reason: CLIENT_VERSION_ERROR_REASON.invalid, client_version: raw },
      });
    }
  });

  it('версия вне диапазона → version-out-of-range с полным details', () => {
    for (const raw of ['1.1.9', '1.3.0', '1.2.0-rc.1', '2.0.0']) {
      const rejection = unitGuard(fakeReq('PUT', { 'client-id': 'c1', 'client-version': raw }));
      assert.deepEqual(rejection, {
        reason: CLIENT_VERSION_ERROR_REASON.outOfRange,
        details: {
          reason: CLIENT_VERSION_ERROR_REASON.outOfRange,
          server_version: '1.2.5',
          client_version: raw,
          compatibility: UNIT_CHANNEL.client_compatibility,
          download_url: UNIT_CHANNEL.client_download_url,
        },
      });
    }
  });

  it('все четыре изменяющих метода проходят проверку; версия в диапазоне допустима', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(
        unitGuard(fakeReq(method, { 'client-id': 'c1', 'client-version': '1.2.0' })),
        null,
        `${method}: нижняя граница`,
      );
      assert.equal(
        unitGuard(fakeReq(method, { 'client-id': 'c1', 'client-version': '1.2.99' })),
        null,
        `${method}: патч внутри minor`,
      );
      assert.equal(
        unitGuard(fakeReq(method, { 'client-id': 'c1', 'client-version': '1.3.0' }))?.reason,
        CLIENT_VERSION_ERROR_REASON.outOfRange,
        `${method}: следующий minor`,
      );
    }
  });

  it('повторённый заголовок берётся первым значением', () => {
    assert.equal(
      unitGuard(fakeReq('POST', { 'client-id': 'c1', 'client-version': ['1.2.1', '0.0.1'] })),
      null,
    );
    assert.equal(
      unitGuard(fakeReq('POST', { 'client-id': 'c1', 'client-version': ['garbage', '1.2.1'] }))?.reason,
      CLIENT_VERSION_ERROR_REASON.invalid,
    );
  });

  it('сообщение отказа адресовано API и называет причину без разбора клиентом', () => {
    const outOfRange = unitGuard(fakeReq('POST', { 'client-id': 'c1', 'client-version': '2.0.0' }));
    assert.ok(outOfRange !== null);
    const message = describeClientVersionRejection(outOfRange);
    assert.match(message, /2\.0\.0/);
    assert.match(message, />=1\.2\.0 <1\.3\.0/);
    assert.match(message, /Обновите клиент/);

    const missing = unitGuard(fakeReq('POST', { 'client-id': 'c1' }));
    assert.ok(missing !== null);
    assert.match(describeClientVersionRejection(missing), /Client-Version/);
  });
});

describe(
  'client-version-guard — сквозная матрица на реальном приложении',
  { skip: !nativeAvailable() },
  () => {
    /** Диапазон, который сервер сам отдаёт в `/version` (тот же источник). */
    const channel = resolveClientChannel({});
    const lower = parseSemver(channel.min_client);
    assert.ok(lower !== null, 'min_client обязан быть версией');
    const compatibleVersion = channel.min_client;
    const incompatibleVersion = `${lower.major}.${lower.minor + 1}.0`;

    const CLIENT_ID = 'it-client-0000-0000-0000-000000000000';

    /** Заголовки desktop-клиента с заданной версией. */
    function clientHeaders(version: string | null): Record<string, string> {
      const headers: Record<string, string> = { 'client-id': CLIENT_ID };
      if (version !== null) headers['client-version'] = version;
      return headers;
    }

    it('GET/HEAD не блокируются при несовместимой версии', async () => {
      const ctx = await buildRestContext();
      try {
        const headers = { ...authHeaders(ctx), ...clientHeaders(incompatibleVersion) };
        const get = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers });
        assert.equal(get.statusCode, 200, get.body);
        const head = await ctx.app.inject({ method: 'HEAD', url: '/api/v1/me', headers });
        assert.equal(head.statusCode, 200, head.body);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('аутентификация выполняется раньше проверки версии', async () => {
      const ctx = await buildRestContext();
      try {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: {
            authorization: 'Bearer etn_deadbeef000000000000000000000000',
            ...clientHeaders(incompatibleVersion),
          },
          payload: { display_name: 'Nope' },
        });
        assert.equal(res.statusCode, 401, res.body);
        assert.equal(res.json().error.code, 'UNAUTHORIZED');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('426: канонический конверт, полный details и эхо Client-Request-Id', async () => {
      const ctx = await buildRestContext();
      try {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: {
            ...authHeaders(ctx),
            ...clientHeaders(incompatibleVersion),
            'client-request-id': 'req-426-matrix',
          },
          payload: { display_name: 'Rejected' },
        });
        assert.equal(res.statusCode, 426, res.body);
        const body = res.json() as {
          error: {
            code: string;
            message: string;
            details: ClientVersionErrorDetails;
            request_id?: string;
          };
        };
        assert.equal(body.error.code, 'CLIENT_VERSION_UNSUPPORTED');
        assert.ok(body.error.message.length > 0);
        assert.equal(body.error.request_id, 'req-426-matrix');
        assert.deepEqual(body.error.details, {
          reason: CLIENT_VERSION_ERROR_REASON.outOfRange,
          server_version: SERVER_VERSION,
          client_version: incompatibleVersion,
          compatibility: channel.client_compatibility,
          download_url: channel.client_download_url,
        });
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('все четыре изменяющих метода отклоняются вне диапазона', async () => {
      const ctx = await buildRestContext();
      try {
        const headers = { ...authHeaders(ctx), ...clientHeaders(incompatibleVersion) };
        const cases: Array<{
          method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
          url: string;
          payload?: Record<string, unknown>;
        }> = [
          { method: 'POST', url: '/api/v1/networks', payload: { display_name: 'Rejected' } },
          { method: 'PATCH', url: '/api/v1/me', payload: { display_name: 'Rejected' } },
          { method: 'PUT', url: '/api/v1/users/me/settings/comment_hotkeys', payload: { value: {} } },
          { method: 'DELETE', url: `/api/v1/me/keys/${randomUUID()}` },
        ];
        for (const c of cases) {
          const res = await ctx.app.inject({
            method: c.method,
            url: c.url,
            headers,
            ...(c.payload === undefined ? {} : { payload: c.payload }),
          });
          assert.equal(res.statusCode, 426, `${c.method} ${c.url}: ${res.body}`);
          assert.equal(res.json().error.code, 'CLIENT_VERSION_UNSUPPORTED', `${c.method} ${c.url}`);
        }
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('version-missing и version-invalid дают 426 с соответствующей причиной', async () => {
      const ctx = await buildRestContext();
      try {
        const missing = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: { ...authHeaders(ctx), ...clientHeaders(null) },
          payload: { display_name: 'No version' },
        });
        assert.equal(missing.statusCode, 426, missing.body);
        assert.equal(missing.json().error.details.reason, CLIENT_VERSION_ERROR_REASON.missing);

        const invalid = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: { ...authHeaders(ctx), ...clientHeaders('not-a-version') },
          payload: { display_name: 'Bad version' },
        });
        assert.equal(invalid.statusCode, 426, invalid.body);
        assert.equal(invalid.json().error.details.reason, CLIENT_VERSION_ERROR_REASON.invalid);
        assert.equal(invalid.json().error.details.client_version, 'not-a-version');
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('совместимая версия пропускается, запрос без Client-Id — тоже (API-интеграция)', async () => {
      const ctx = await buildRestContext();
      try {
        const compatible = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: { ...authHeaders(ctx), ...clientHeaders(compatibleVersion) },
          payload: { display_name: 'Compatible client' },
        });
        assert.equal(compatible.statusCode, 201, compatible.body);

        // Без Client-Id версия не обязательна — скрипты и MCP-агенты не ломаем.
        const integration = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: { ...authHeaders(ctx), 'client-version': incompatibleVersion },
          payload: { display_name: 'API integration' },
        });
        assert.equal(integration.statusCode, 201, integration.body);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('диапазон guard’а — тот же, что отдаёт GET /version', async () => {
      const ctx = await buildRestContext();
      try {
        const versionRes = await ctx.app.inject({ method: 'GET', url: '/api/v1/version' });
        assert.equal(versionRes.statusCode, 200);
        const payload = versionRes.json() as {
          client_compatibility: string;
          min_client: string;
          client_download_url: string;
        };
        assert.equal(payload.client_compatibility, channel.client_compatibility);
        assert.equal(payload.min_client, channel.min_client);

        // Версия на границе диапазона из `/version` принимается…
        const accepted = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: { ...authHeaders(ctx), ...clientHeaders(payload.min_client) },
          payload: { display_name: 'Lower bound' },
        });
        assert.equal(accepted.statusCode, 201, accepted.body);

        // …а следующий minor — нет.
        const nextMinor = `${lower.major}.${lower.minor + 1}.0`;
        const rejected = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/networks',
          headers: { ...authHeaders(ctx), ...clientHeaders(nextMinor) },
          payload: { display_name: 'Next minor' },
        });
        assert.equal(rejected.statusCode, 426, rejected.body);
        assert.equal(rejected.json().error.details.compatibility, payload.client_compatibility);
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
