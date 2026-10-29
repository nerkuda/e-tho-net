/**
 * Клиентская проверка совместимости версий (задача 12fd5b0e, требование
 * 4d3be6ca, сущность 89aad200, сценарии 90f10d92 / 08da2626 / d2c80aa4).
 *
 * Покрыто:
 *  - пять статусов результата и их проекция на баннер
 *    (`hidden`/`recommended-update`/`unknown`);
 *  - двойная проверка: встроенный диапазон клиента + диапазон сервера, включая
 *    устаревший однобокий `>=0.1.0` (сервер 0.14.1) с откатом к `min_client`;
 *  - битый/недоступный `/version` — `check-failed`, а не «совместимо»;
 *  - `connectAndActivate`: порядок «проверка → GET /me» и отсутствие `getMe`
 *    при отказе (ни один авторизованный запрос не уходит);
 *  - `CompatibilityGate`: публикация вердикта, повторная проверка на
 *    переподключении, teardown по блокировке, `426` в середине сессии,
 *    `roleConfirmed` (K3), сброс;
 *  - проводка в `register.ts`/`handlers.ts`/`preload` (статический сторож).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';

import { EtnError, type VersionResponse } from '@etn/shared';

import {
  checkCompatibility,
  CompatibilityGate,
  compatibilityRefusal,
  isReconnectTransition,
  parseVersionResponse,
  verifyCompatibilityOnConnect,
  type CompatibilityResult,
} from '../src/main/compatibility.js';
import {
  addProfileAndConnect,
  connectAndActivate,
  connectProfileWithCompatibility,
} from '../src/main/ipc/connect-active-profile.js';
import { createHandlers, type HandlerDeps } from '../src/main/ipc/handlers.js';
import { RestClient } from '../src/main/net/rest-client.js';
import type { NewServerProfile } from '../src/main/db/local-db.js';

const CLIENT = '0.15.1';
const RELEASE_PAGE = 'https://github.com/nerkuda/e-tho-net/releases/tag/v0.15.2';

/** Тело `/version` с реалистичными значениями minor-окна (1f593647). */
function versionBody(overrides: Partial<VersionResponse> = {}): VersionResponse {
  return {
    version: '0.15.1',
    api: 'v1',
    min_client: '0.15.0',
    client_compatibility: '>=0.15.0 <0.16.0',
    recommended_client_version: '0.15.1',
    client_download_url: RELEASE_PAGE,
    ...overrides,
  };
}

function check(
  response: unknown,
  clientVersion = CLIENT,
  roleConfirmed?: boolean,
): CompatibilityResult {
  return checkCompatibility({
    clientVersion,
    response,
    ...(roleConfirmed === undefined ? {} : { roleConfirmed }),
  });
}

/** Управляемое обещание — чтобы проверить гонку: проверка в полёте против 426. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** In-memory замена профильной части `LocalDb` (better-sqlite3 в тестах не грузим). */
interface ProfileStore {
  activeId: string | null;
  inserted: NewServerProfile[];
  setActiveProfile(id: string | null): void;
  insertProfile(profile: NewServerProfile): void;
}

function makeProfileStore(): ProfileStore {
  return {
    activeId: null,
    inserted: [],
    setActiveProfile(id: string | null) {
      this.activeId = id;
    },
    insertProfile(profile: NewServerProfile) {
      this.inserted.push(profile);
    },
  };
}

describe('checkCompatibility — пять статусов (89aad200)', () => {
  it('compatible: обе версии в minor-окне, рекомендации нет', () => {
    const result = check(versionBody());
    assert.equal(result.status, 'compatible');
    assert.equal(result.banner, 'hidden');
    assert.equal(result.blocking, false);
    assert.equal(result.reason, null);
    assert.equal(result.clientVersion, CLIENT);
    assert.equal(result.serverVersion, '0.15.1');
    assert.equal(result.serverCompatibility, '>=0.15.0 <0.16.0');
    assert.equal(result.clientCompatibility, '>=0.15.0 <0.16.0');
    assert.equal(result.downloadUrl, RELEASE_PAGE);
  });

  it('recommended-update: сервер рекомендует более новую версию', () => {
    const result = check(versionBody({ recommended_client_version: '0.15.2' }));
    assert.equal(result.status, 'recommended-update');
    assert.equal(result.banner, 'recommended-update');
    assert.equal(result.blocking, false);
    assert.equal(result.recommendedClientVersion, '0.15.2');
  });

  it('client-outdated: клиент старше сервера и вне его диапазона', () => {
    // Сценарий 90f10d92: клиент 0.14.1, сервер 0.15.0.
    const result = check(
      versionBody({ version: '0.15.0', min_client: '0.15.0' }),
      '0.14.1',
    );
    assert.equal(result.status, 'client-outdated');
    assert.equal(result.banner, 'hidden');
    assert.equal(result.blocking, true);
    assert.equal(result.reason, 'client-outdated');
  });

  it('client-outdated: сервер не принимает клиента по своему диапазону', () => {
    // Оба в окне клиента, но сервер уже не пускает 0.15.1.
    const result = check(versionBody({ client_compatibility: '>=0.15.2 <0.16.0' }));
    assert.equal(result.status, 'client-outdated');
    assert.equal(result.reason, 'client-outdated');
    assert.equal(result.serverCompatibility, '>=0.15.2 <0.16.0');
  });

  it('server-outdated: уже выпущенный сервер 0.14.1 отдаёт однобокое >=0.1.0', () => {
    // Сценарий 08da2626: встроенный диапазон клиента — предохранитель.
    const old = {
      version: '0.14.1',
      api: 'v1',
      min_client: '0.1.0',
      client_compatibility: '>=0.1.0',
    };
    const result = check(old);
    assert.equal(result.status, 'server-outdated');
    assert.equal(result.banner, 'hidden');
    assert.equal(result.blocking, true);
    assert.equal(result.reason, 'server-outdated');
    assert.equal(result.clientCompatibility, '>=0.15.0 <0.16.0');
  });

  it('check-failed: недоступный или битый /version — НЕ «совместимо»', () => {
    for (const broken of [
      null,
      undefined,
      'garbage',
      {},
      { version: '0.15.1' }, // нет ни client_compatibility, ни min_client
      { version: 'not-a-version', api: 'v1', min_client: '0.1.0', client_compatibility: '>=0.1.0' },
      { version: '0.15.1', api: 'v1', min_client: 'не-версия', client_compatibility: '>=0.1.0' },
    ]) {
      const result = check(broken);
      assert.equal(result.status, 'check-failed', JSON.stringify(broken));
      assert.equal(result.banner, 'unknown', JSON.stringify(broken));
      assert.equal(result.blocking, false, 'check-failed не блокирует');
      assert.equal(result.reason, 'check-failed');
    }
  });

  it('legacy-диапазон с валидным min_client не считается битым', () => {
    const result = check(
      versionBody({ version: '0.15.0', client_compatibility: '>=0.1.0', min_client: '0.1.0' }),
    );
    assert.equal(result.status, 'compatible');
    assert.equal(result.serverCompatibility, '>=0.1.0');
  });

  it('рекомендация вне диапазона сервера не показывается', () => {
    const result = check(versionBody({ recommended_client_version: '0.16.0' }));
    assert.equal(result.status, 'compatible');
    assert.equal(result.banner, 'hidden');
  });

  it('prerelease следующего minor вне окна, prerelease той же ветки — внутри', () => {
    assert.equal(check(versionBody({ version: '0.16.0-rc.1' })).status, 'client-outdated');
    assert.equal(check(versionBody({ version: '0.15.1-rc.1' })).status, 'compatible');
  });

  it('roleConfirmed попадает в результат (K3)', () => {
    assert.equal(check(versionBody()).roleConfirmed, false);
    assert.equal(check(versionBody(), CLIENT, true).roleConfirmed, true);
  });

  it('parseVersionResponse: пустые/нестроковые необязательные поля — null', () => {
    const parsed = parseVersionResponse({
      version: '0.15.1',
      api: 'v1',
      min_client: '0.15.0',
      client_compatibility: '>=0.15.0 <0.16.0',
      recommended_client_version: '',
      client_download_url: 42,
    });
    assert.ok(parsed);
    assert.equal(parsed.recommended_client_version, null);
    assert.equal(parsed.client_download_url, null);
  });
});

describe('connectAndActivate — проверка до первой авторизованной операции', () => {
  it('порядок вызовов: сначала проверка, затем GET /me', async () => {
    const db = makeProfileStore();
    const order: string[] = [];
    const me = await connectAndActivate(
      db,
      'p1',
      async () => {
        order.push('me');
        return { id: 'user-1' };
      },
      async () => {
        order.push('check');
      },
    );
    assert.deepEqual(order, ['check', 'me']);
    assert.deepEqual(me, { id: 'user-1' });
    assert.equal(db.activeId, 'p1');
  });

  it('отказ проверки: getMe не вызывается, профиль не активируется', async () => {
    const db = makeProfileStore();
    db.setActiveProfile('old');
    let meCalls = 0;
    await assert.rejects(
      connectAndActivate(
        db,
        'new',
        async () => {
          meCalls += 1;
          return { id: 'user' };
        },
        async () => {
          throw compatibilityRefusal(check(versionBody({ client_compatibility: '>=0.16.0 <0.17.0' })));
        },
      ),
      (err: unknown) => err instanceof EtnError && err.code === 'CLIENT_VERSION_UNSUPPORTED',
    );
    assert.equal(meCalls, 0, 'ни один авторизованный запрос не ушёл');
    assert.equal(db.activeId, 'old', 'активный профиль не переключён');
  });

  it('отказ подключения несёт машиночитаемый результат (details.kind)', async () => {
    const result = check(versionBody({ version: '0.14.1', client_compatibility: '>=0.1.0' }));
    const err = compatibilityRefusal(result);
    assert.equal(err.code, 'CLIENT_VERSION_UNSUPPORTED');
    const details = err.details as { kind: string; result: CompatibilityResult };
    assert.equal(details.kind, 'client-compatibility');
    assert.equal(details.result.status, 'server-outdated');
  });
});

describe('verifyCompatibilityOnConnect — блокировка и роль (8623b9ff)', () => {
  /**
   * Фейковый сервер: журнал фактических запросов.
   * `GET /version` — публичная проверка, `GET /me` — единственный допустимый
   * авторизованный запрос (диагностический, только для роли).
   */
  function makeProbe(
    serverLog: string[],
    version: () => Promise<VersionResponse>,
    me: () => Promise<unknown>,
  ): { getVersion: () => Promise<VersionResponse>; getMe: () => Promise<unknown> } {
    return {
      getVersion: async () => {
        serverLog.push('GET /version');
        return version();
      },
      getMe: async () => {
        serverLog.push('GET /me');
        return me();
      },
    };
  }

  function makeGate(): {
    gate: CompatibilityGate;
    published: Array<CompatibilityResult | null>;
  } {
    const published: Array<CompatibilityResult | null> = [];
    return {
      gate: new CompatibilityGate({
        clientVersion: CLIENT,
        publish: (result) => published.push(result),
        teardown: () => undefined,
      }),
      published,
    };
  }

  it('несовместимый сервер 0.16.0 + администратор: /version, диагностический /me, роль подтверждена, профиль не активирован', async () => {
    const serverLog: string[] = [];
    const { gate, published } = makeGate();
    const probe = makeProbe(
      serverLog,
      async () => versionBody({ version: '0.16.0', recommended_client_version: '0.16.0' }),
      async () => ({ id: 'admin-1', is_admin: true }),
    );
    const db = makeProfileStore();
    db.setActiveProfile('old');

    await assert.rejects(
      connectProfileWithCompatibility(db, 'new', probe, gate),
      (err: unknown) => {
        assert.ok(err instanceof EtnError, `ожидался EtnError, получено ${String(err)}`);
        assert.equal(err.code, 'CLIENT_VERSION_UNSUPPORTED');
        const details = err.details as { kind: string; result: CompatibilityResult };
        assert.equal(details.kind, 'client-compatibility');
        assert.equal(details.result.status, 'client-outdated');
        assert.equal(details.result.roleConfirmed, true);
        return true;
      },
    );

    // «Журнал сервера»: ровно version + диагностический me, ни одного запроса данных.
    assert.deepEqual(serverLog, ['GET /version', 'GET /me']);
    assert.equal(db.activeId, 'old', 'профиль не активирован');
    const verdict = gate.getResult();
    assert.equal(verdict?.status, 'client-outdated');
    assert.equal(verdict?.roleConfirmed, true);
    assert.deepEqual(published.at(-1), verdict, 'подтверждение роли опубликовано рендереру');
  });

  it('диагностический /me упал: роль не подтверждена, отказ остаётся блокирующим', async () => {
    const serverLog: string[] = [];
    const { gate } = makeGate();
    const probe = makeProbe(
      serverLog,
      async () => versionBody({ version: '0.16.0' }),
      async () => {
        throw new EtnError('UNAUTHORIZED', 'Ключ отозван');
      },
    );

    await assert.rejects(
      verifyCompatibilityOnConnect(gate, probe),
      (err: unknown) => err instanceof EtnError && err.code === 'CLIENT_VERSION_UNSUPPORTED',
    );
    assert.deepEqual(serverLog, ['GET /version', 'GET /me']);
    assert.equal(gate.getResult()?.status, 'client-outdated');
    assert.equal(gate.getResult()?.roleConfirmed, false, 'ошибка /me роль не подтверждает');
  });

  it('check-failed: диагностического /me нет, пробрасывается исходная ошибка /version', async () => {
    const serverLog: string[] = [];
    const { gate } = makeGate();
    const failure = new EtnError(
      'INTERNAL',
      'Сетевая ошибка: сервер не ответил за отведённое время',
      { kind: 'connect-failed', reason: 'timeout' },
    );
    const probe = makeProbe(
      serverLog,
      async () => {
        throw failure;
      },
      async () => ({ id: 'user-1' }),
    );

    await assert.rejects(
      verifyCompatibilityOnConnect(gate, probe),
      (err: unknown) => err === failure,
      'check-failed отказывает с честной причиной недоступного /version',
    );
    assert.deepEqual(serverLog, ['GET /version'], 'авторизованных запросов нет');
    assert.equal(gate.getResult()?.status, 'check-failed');
    assert.equal(gate.getResult()?.roleConfirmed, false);
  });

  it('совместимый сервер: verify не трогает /me, профиль активируется после обычного GET /me', async () => {
    const serverLog: string[] = [];
    const { gate } = makeGate();
    const probe = makeProbe(
      serverLog,
      async () => versionBody(),
      async () => ({ id: 'user-1' }),
    );
    await verifyCompatibilityOnConnect(gate, probe);
    assert.deepEqual(serverLog, ['GET /version'], 'диагностический /me не нужен');

    const db = makeProfileStore();
    const me = await connectProfileWithCompatibility(db, 'new', probe, gate);
    assert.deepEqual(me, { id: 'user-1' });
    assert.deepEqual(serverLog, ['GET /version', 'GET /version', 'GET /me']);
    assert.equal(db.activeId, 'new');
    assert.equal(gate.getResult()?.roleConfirmed, true, 'успешный /me подтвердил роль');
  });

  it('server-outdated (старый сервер 0.14.1): диагностический /me тоже подтверждает роль', async () => {
    const serverLog: string[] = [];
    const { gate } = makeGate();
    const probe = makeProbe(
      serverLog,
      async () =>
        versionBody({ version: '0.14.1', client_compatibility: '>=0.1.0', min_client: '0.1.0' }),
      async () => ({ id: 'admin-1', is_admin: true }),
    );

    await assert.rejects(verifyCompatibilityOnConnect(gate, probe));
    assert.deepEqual(serverLog, ['GET /version', 'GET /me']);
    assert.equal(gate.getResult()?.status, 'server-outdated');
    assert.equal(gate.getResult()?.roleConfirmed, true);
  });
});

describe('addProfileAndConnect — сохранение без активации (12fd5b0e)', () => {
  const profile: NewServerProfile = {
    id: 'new-profile',
    label: 'Новый сервер',
    base_url: 'http://localhost:3000',
  };

  it('профиль вставляется неактивным; активация — только после успешного connect', async () => {
    const db = makeProfileStore();
    db.setActiveProfile('old');
    const order: string[] = [];

    // Реальный `connectProfile` активирует профиль внутри
    // `connectAndActivate` — здесь это моделируется явно.
    const me = await addProfileAndConnect(db, profile, async (id) => {
      order.push(`connect:${id}`);
      db.setActiveProfile(id);
      return { id: 'user-1' };
    });

    assert.deepEqual(order, ['connect:new-profile'], 'connect вызван после вставки');
    assert.equal(db.inserted.length, 1);
    assert.equal(db.inserted[0]?.is_active, false, 'вставка неактивной');
    assert.equal(db.activeId, 'new-profile');
    assert.deepEqual(me, { id: 'user-1' });
  });

  it('блокирующий отказ через добавление профиля: профиль сохранён, но активным остаётся прежний', async () => {
    const db = makeProfileStore();
    db.setActiveProfile('old');

    await assert.rejects(
      addProfileAndConnect(db, profile, async () => {
        throw compatibilityRefusal(check(versionBody({ version: '0.16.0' })));
      }),
      (err: unknown) => err instanceof EtnError && err.code === 'CLIENT_VERSION_UNSUPPORTED',
    );

    assert.equal(db.inserted.length, 1, 'профиль сохранён');
    assert.equal(db.inserted[0]?.is_active, false, 'сохранён неактивным');
    assert.equal(db.activeId, 'old', 'активный профиль не переключён на неподключённый');
  });
});

/** TCP-сервер, принимающий соединение и не отвечающий ни байтом. */
async function startSilentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // Намеренно молчим: именно этот случай держал экран подключения ~5 мин.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'адрес локального сервера');
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('молчащий сервер: проверка версии ограничена таймаутом (12fd5b0e)', () => {
  it('getVersion через gate: check-failed за отведённое время, не дольше таймаута', async () => {
    const server = await startSilentServer();
    try {
      const rest = new RestClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        getApiKey: async () => 'etn_testkey',
        getClientId: () => '11111111-1111-1111-1111-111111111111',
        clientVersion: CLIENT,
        responseTimeoutMs: 150,
      });
      const published: Array<CompatibilityResult | null> = [];
      const gate = new CompatibilityGate({
        clientVersion: CLIENT,
        publish: (result) => published.push(result),
        teardown: () => undefined,
      });

      const started = Date.now();
      const outcome = await gate.check(() => rest.getVersion());
      const elapsed = Date.now() - started;

      assert.equal(outcome.ok, false);
      assert.equal(outcome.result.status, 'check-failed', 'молчание — не «совместимо»');
      assert.equal(outcome.result.banner, 'unknown');
      assert.equal(outcome.result.blocking, false);
      assert.equal(gate.isBlocking(), false);
      assert.deepEqual(published.at(-1), outcome.result);

      const error = outcome.ok === false ? outcome.error : undefined;
      assert.ok(error instanceof EtnError, `ожидался EtnError, получено ${String(error)}`);
      assert.deepEqual(error.details, { kind: 'connect-failed', reason: 'timeout' });
      assert.ok(
        elapsed < 5_000,
        `отказ за ${elapsed} мс — не дольше прикладного таймаута (150 мс), а не таймаута undici`,
      );
    } finally {
      await server.close();
    }
  });
});

describe('CompatibilityGate — вердикт, переподключение и 426', () => {
  interface Harness {
    gate: CompatibilityGate;
    published: Array<CompatibilityResult | null>;
    teardownCalls: number;
  }

  function makeGate(): Harness {
    const published: Array<CompatibilityResult | null> = [];
    const state = { teardownCalls: 0 };
    const gate = new CompatibilityGate({
      clientVersion: CLIENT,
      publish: (result) => published.push(result),
      teardown: () => {
        state.teardownCalls += 1;
      },
    });
    return {
      gate,
      published,
      get teardownCalls() {
        return state.teardownCalls;
      },
    };
  }

  it('check публикует вердикт и возвращает ok для совместимого сервера', async () => {
    const h = makeGate();
    const outcome = await h.gate.check(async () => versionBody());
    assert.equal(outcome.ok, true);
    assert.deepEqual(h.published, [outcome.result]);
    assert.equal(h.gate.getResult()?.status, 'compatible');
    assert.equal(h.gate.isBlocking(), false);
  });

  it('check-failed на подключении: публикует unknown и отдаёт исходную ошибку', async () => {
    const h = makeGate();
    const failure = new EtnError('INTERNAL', 'Нет соединения с сервером');
    const outcome = await h.gate.check(async () => {
      throw failure;
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false ? outcome.error : null, failure);
    assert.equal(h.published.at(-1)?.status, 'check-failed');
    assert.equal(h.published.at(-1)?.banner, 'unknown');
    assert.equal(h.teardownCalls, 0, 'check-failed не рвёт соединение');
  });

  it('блокировка на подключении: публикует, но соединение не рвёт (его ещё нет)', async () => {
    const h = makeGate();
    const outcome = await h.gate.check(async () => versionBody({ version: '0.14.1' }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.result.status, 'server-outdated');
    assert.equal(h.published.at(-1)?.blocking, true);
    assert.equal(h.teardownCalls, 0);
  });

  it('переподключение: проверка повторяется, блокировка рвёт соединение', async () => {
    const h = makeGate();
    await h.gate.check(async () => versionBody());
    let fetches = 0;
    const outcome = await h.gate.recheck(async () => {
      fetches += 1;
      return versionBody({ client_compatibility: '>=0.16.0 <0.17.0' });
    });
    assert.equal(fetches, 1, 'на reconnect /version запрошен снова');
    assert.equal(outcome?.ok, false);
    assert.equal(outcome?.result.status, 'client-outdated');
    assert.equal(h.teardownCalls, 1, 'блокирующий вердикт рвёт соединение');
  });

  it('переподключение с недоступным /version: unknown, соединение живо', async () => {
    const h = makeGate();
    await h.gate.check(async () => versionBody());
    const outcome = await h.gate.recheck(async () => {
      throw new Error('ECONNREFUSED');
    });
    assert.equal(outcome?.ok, false);
    assert.equal(h.gate.getResult()?.status, 'check-failed');
    assert.equal(h.teardownCalls, 0);
  });

  it('recheck не плодит параллельные запросы (single-flight)', async () => {
    const h = makeGate();
    const reply = deferred<VersionResponse>();
    const gateCall = h.gate.recheck(() => reply.promise);
    const second = await h.gate.recheck(async () => versionBody());
    assert.equal(second, null, 'второй вызов пропущен');
    reply.resolve(versionBody());
    assert.equal((await gateCall)?.ok, true);
  });

  it('426 в середине сессии: client-outdated из details, teardown и публикация', async () => {
    const h = makeGate();
    await h.gate.check(async () => versionBody());
    h.gate.markRoleConfirmed();
    h.gate.onVersionRejected({
      reason: 'version-out-of-range',
      server_version: '0.15.2',
      client_version: CLIENT,
      compatibility: '>=0.15.2 <0.16.0',
      download_url: RELEASE_PAGE,
    });
    const result = h.gate.getResult();
    assert.equal(result?.status, 'client-outdated');
    assert.equal(result?.blocking, true);
    assert.equal(result?.roleConfirmed, true, 'роль подтверждена до отказа (K3)');
    assert.equal(result?.serverVersion, '0.15.2');
    assert.equal(result?.serverCompatibility, '>=0.15.2 <0.16.0');
    assert.equal(result?.downloadUrl, RELEASE_PAGE);
    assert.equal(h.teardownCalls, 1, 'соединение разорвано без ожидания перезапуска');
    assert.deepEqual(h.published.at(-1), result);
  });

  it('426 обгоняет проверку в полёте: устаревший ответ не перезаписывает вердикт', async () => {
    const h = makeGate();
    const reply = deferred<VersionResponse>();
    const pending = h.gate.check(() => reply.promise);
    h.gate.onVersionRejected({
      reason: 'version-out-of-range',
      server_version: '0.16.0',
      compatibility: '>=0.16.0 <0.17.0',
    });
    reply.resolve(versionBody());
    await pending;
    assert.equal(h.gate.getResult()?.status, 'client-outdated');
    assert.ok(
      h.published.every((entry) => entry === null || entry.status !== 'compatible'),
      'устаревший compatible не опубликован',
    );
  });

  it('новое подключение сбрасывает подтверждение роли до GET /me', async () => {
    const h = makeGate();
    await h.gate.check(async () => versionBody());
    h.gate.markRoleConfirmed();
    const outcome = await h.gate.check(async () => versionBody({ version: '0.14.1' }));
    assert.equal(outcome.result.roleConfirmed, false);
  });

  it('reset публикует null и очищает вердикт', async () => {
    const h = makeGate();
    await h.gate.check(async () => versionBody());
    h.gate.markRoleConfirmed();
    h.gate.reset();
    assert.equal(h.gate.getResult(), null);
    assert.equal(h.gate.isBlocking(), false);
    assert.equal(h.published.at(-1), null);
  });
});

describe('isReconnectTransition', () => {
  it('переподключение — только возврат в connected после обрыва', () => {
    assert.equal(isReconnectTransition('reconnecting', 'connected'), true);
    assert.equal(isReconnectTransition('offline', 'connected'), true);
    assert.equal(isReconnectTransition('suspect', 'connected'), true);
    // Первый коннект проверен ДО /me, повторять его не нужно.
    assert.equal(isReconnectTransition('connecting', 'connected'), false);
    assert.equal(isReconnectTransition(null, 'connected'), false);
    assert.equal(isReconnectTransition('connected', 'connected'), false);
    assert.equal(isReconnectTransition('connected', 'reconnecting'), false);
  });
});

describe('IPC и проводка (сторож задачи 12fd5b0e)', () => {
  it('server.getCompatibility отдаёт текущий вердикт', async () => {
    const verdict = check(versionBody());
    const handlers = createHandlers({
      getCompatibility: () => verdict,
    } as unknown as HandlerDeps);
    const handler = handlers.get('server.getCompatibility');
    assert.ok(handler !== undefined);
    assert.deepEqual(await handler!([], { signal: new AbortController().signal }), verdict);
  });

  const CLIENT_ROOT = path.resolve(import.meta.dirname, '..', 'src');
  const registerSrc = readFileSync(path.join(CLIENT_ROOT, 'main', 'ipc', 'register.ts'), 'utf8');
  const handlersSrc = readFileSync(path.join(CLIENT_ROOT, 'main', 'ipc', 'handlers.ts'), 'utf8');
  const preloadSrc = readFileSync(path.join(CLIENT_ROOT, 'preload', 'index.ts'), 'utf8');

  it('проверка версии подключена к connectProfile', () => {
    // Наличие проводки (исчезновение вызова — регресс). ПОРЯДОК «версия → /me»
    // проверяется фактической последовательностью вызовов в
    // `connectProfileWithCompatibility`/`verifyCompatibilityOnConnect` (describe
    // выше), а не подстрокой: перестановка вызовов с сохранением текста такой
    // сторож не ловит (замечание верификатора 6).
    assert.match(registerSrc, /connectProfileWithCompatibility\(\s*opts\.localDb/);
  });

  it('426 в середине сессии доходит до gate из RestClient', () => {
    assert.match(registerSrc, /onClientVersionUnsupported: \(details\) => compatibility\.onVersionRejected\(details\)/);
  });

  it('переподключение повторяет проверку', () => {
    assert.match(registerSrc, /isReconnectTransition\(previous, status\)/);
    assert.match(registerSrc, /compatibility\.recheck\(fetchVersion\)/);
  });

  it('IPC: handler и подписка preload на канал вердикта', () => {
    assert.match(handlersSrc, /'server\.getCompatibility'/);
    assert.match(preloadSrc, /'compatibility:status'/);
    assert.match(preloadSrc, /getCompatibility: \(\) => invoke\('server\.getCompatibility'\)/);
  });
});
