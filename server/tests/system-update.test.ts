/**
 * Admin-эндпоинты и задание обновления сервера (задача 0a27a63b; тех.проект
 * 2d9f5cc7; операции 841a2515, 5b9b064c, 8a2972c2, 3bc8a9c3; сущность
 * «Задание обновления сервера» 1f39811c).
 *
 * Два слоя:
 *  - сквозные REST-тесты на реальном Fastify-приложении: права администратора,
 *    статус кеша (+ HTTPS-предупреждение), `429` идущей проверки, гонка двух
 *    администраторов (`201` + `409` с текущим заданием), Docker/downgrade `409`,
 *    «сервер не службой» — `failed` без остановки, `502` при хеше без остановки
 *    службы, maintenance включён до запуска установщика, CORS на `503`,
 *    восстановление незавершённого задания после перезапуска;
 *  - юнит-тесты сервиса задания: коды установщика 0/10/20, тайм-аут (задание
 *    `failed` с путём журнала, второй apply — `409 installer-alive`), виды
 *    `502`, конфликты версий, восстановление.
 *
 * Фикстуры — внешний контракт (фид, байты установщика, код возврата процесса),
 * а не данные мыслесети: сервер и поставка обмениваются байтами и кодами, как
 * в `installer-runner.test.ts` и `update-checker.test.ts`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';

import { createServer } from '../src/http/server.js';
import { DEFAULT_UPDATE_CONFIG } from '../src/config.js';
import { runMigrations } from '../src/db/migrator.js';
import { SystemDb } from '../src/db/system-db.js';
import { systemMigrationsDir } from '../src/paths.js';
import { createLogger } from '../src/logger.js';
import { SERVER_VERSION } from '../src/version.js';
import type { UpdateCache } from '../src/update/checker.js';
import {
  NOT_A_SERVICE_MESSAGE,
  UpdateApplyConflictError,
  UpdateApplyNoUpdateError,
  UpdateInstallerFailureError,
  createUpdateApplyService,
  recoverInterruptedUpdateJobs,
  type UpdateApplyService,
  type UpdateJob,
} from '../src/update/apply.js';
import {
  type InstallerFetch,
  type InstallerFetchResponse,
  type InstallerProcessHandle,
  type InstallerRunnerOptions,
  type SpawnInstaller,
} from '../src/update/installer-runner.js';
import { INSTALLER_HTTPS_WARNING } from '../src/routes/system-update.js';
import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  createPlainUser,
  createSecondAdminUser,
  nativeAvailable,
  testServerConfig,
  type RestTestContext,
} from './rest-helpers.js';

/** Версия обновления в тестах — строго новее текущей версии сервера. */
const TARGET_VERSION = '0.16.0';

/** Ссылка на ассет в тестовом фиде. */
const DOWNLOAD_URL = `https://feed.test/download/v${TARGET_VERSION}/ETN-Setup-${TARGET_VERSION}.exe`;

/** Байты установщика: содержимое произвольно, важен SHA-256. */
const INSTALLER_BYTES = Buffer.from('MZ etn update job test payload', 'utf8');

/** SHA-256 установщика. */
const INSTALLER_SHA = createHash('sha256').update(INSTALLER_BYTES).digest('hex');

/** URL фида в тестовом конфиге. */
const FEED_URL = 'https://feed.test/releases';

/** Временные каталоги теста — удаляются после прогона. */
const tempRoots: string[] = [];

/** Уникальный временный каталог. */
function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** Тело загрузки ассета кусками (проверяет потоковую запись runner'а). */
function bodyChunks(data: Buffer, chunkSize = 5): AsyncIterable<Uint8Array> {
  return (async function* chunks(): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      yield data.subarray(offset, offset + chunkSize);
    }
  })();
}

/** Успешный ответ загрузки ассета. */
function okResponse(data: Buffer = INSTALLER_BYTES): InstallerFetchResponse {
  return { ok: true, status: 200, body: bodyChunks(data) };
}

/** Обработчики подставного процесса установщика. */
type CloseHandler = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorHandler = (error: Error) => void;

/** Подставной процесс установщика с управляемым завершением. */
class FakeProcess implements InstallerProcessHandle {
  #closeHandlers: CloseHandler[] = [];
  #errorHandlers: ErrorHandler[] = [];
  closed = false;

  on(event: 'close', handler: CloseHandler): void;
  on(event: 'error', handler: ErrorHandler): void;
  on(event: 'close' | 'error', handler: CloseHandler | ErrorHandler): void {
    if (event === 'close') {
      this.#closeHandlers.push(handler as CloseHandler);
    } else {
      this.#errorHandlers.push(handler as ErrorHandler);
    }
  }

  finish(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.#closeHandlers) handler(code, null);
  }

  fail(error: Error): void {
    for (const handler of this.#errorHandlers) handler(error);
  }
}

/** Дождаться условия с ограничением времени (ожидания фоновых шагов). */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('ожидание условия не завершилось за отведённое время');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Создать журнал установщика по контракту a1211915
 * (`install-YYYYMMDD-HHmmss.log`) со свежим mtime — runner находит журнал по
 * времени изменения, поэтому файл пишется в момент запуска процесса.
 */
function touchInstallerLog(dir: string): string {
  const logPath = path.join(dir, 'install-20261030-120000.log');
  writeFileSync(logPath, 'installer journal\n', 'utf8');
  const now = new Date();
  utimesSync(logPath, now, now);
  return logPath;
}

/** Ответ фида в формате GitHub Releases (один релиз с ассетом и хешами). */
function feedPayload(downloadUrl: string): unknown[] {
  return [
    {
      tag_name: `v${TARGET_VERSION}`,
      prerelease: false,
      draft: false,
      assets: [
        { name: `ETN-Setup-${TARGET_VERSION}.exe`, browser_download_url: downloadUrl },
        { name: 'SHA256SUMS', browser_download_url: 'https://feed.test/SHA256SUMS' },
      ],
    },
  ];
}

/** Подменить глобальный fetch на фид и выполнить `fn` (только проверка). */
async function withFeed<T>(downloadUrl: string, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url === 'https://feed.test/SHA256SUMS') {
      return {
        ok: true,
        status: 200,
        text: async () => `${INSTALLER_SHA}  ETN-Setup-${TARGET_VERSION}.exe\n`,
      };
    }
    if (url === FEED_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify(feedPayload(downloadUrl)) };
    }
    throw new Error(`неожиданный адрес запроса проверки: ${url}`);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Наполнить кеш проверки через `POST /system/update/check` (реальный checker с
 * подменённым fetch).
 */
async function primeCache(
  ctx: RestTestContext,
  downloadUrl: string = DOWNLOAD_URL,
): Promise<void> {
  await withFeed(downloadUrl, async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/system/update/check',
      headers: authHeaders(ctx),
    });
    assert.equal(res.statusCode, 200, res.body);
    const data = res.json().data as { available_version: string | null };
    assert.equal(data.available_version, TARGET_VERSION);
  });
}

/** Harness runner'а: фид установщика, подставной процесс и счётчики вызовов. */
interface RunnerHarness {
  runnerOptions: InstallerRunnerOptions;
  /** Сколько раз сервис пытался запустить установщик. */
  spawns(): number;
  /** Последний созданный процесс (управление завершением). */
  lastProcess(): FakeProcess | null;
  /** Сколько раз запрашивался ассет. */
  downloads(): number;
  logDir: string;
}

/** Настройки harness'а. */
interface RunnerHarnessOptions {
  /** Ответ загрузки ассета; по умолчанию — корректные байты. */
  fetchImpl?: InstallerFetch;
  /** Запуск процесса; по умолчанию — сразу закрывается кодом 0. */
  spawnImpl?: SpawnInstaller;
  runTimeoutMs?: number;
  /** Блокировать скачивание до `release()`. */
  blocked?: boolean;
}

/** Собрать harness runner'а. */
function makeRunnerHarness(
  overrides: RunnerHarnessOptions = {},
): RunnerHarness & { release(): void } {
  const logDir = makeTempRoot('etn-update-log-');
  const downloadRoot = makeTempRoot('etn-update-dl-');
  let spawnCount = 0;
  let downloadCount = 0;
  let last: FakeProcess | null = null;
  let release: (() => void) | null = null;
  const gate =
    overrides.blocked === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : null;

  const assetFetch: InstallerFetch = async () => {
    downloadCount += 1;
    if (gate !== null) await gate;
    return okResponse();
  };
  const processSpawn: SpawnInstaller =
    overrides.spawnImpl ??
    (() => {
      const process = new FakeProcess();
      queueMicrotask(() => process.finish(0));
      return process;
    });

  const runnerOptions: InstallerRunnerOptions = {
    fetchImpl: overrides.fetchImpl ?? assetFetch,
    // Попытки считаются в обёртке: она стоит между сервисом и подставным
    // процессом, поэтому учитывает и бросок spawnImpl (ошибка запуска).
    spawnImpl: (installerPath, args) => {
      spawnCount += 1;
      const child = processSpawn(installerPath, args);
      if (child instanceof FakeProcess) {
        last = child;
      }
      return child;
    },
    downloadRoot,
    logDirs: [logDir],
    downloadTimeoutMs: 5_000,
    runTimeoutMs: overrides.runTimeoutMs ?? 5_000,
  };

  return {
    runnerOptions,
    logDir,
    spawns: () => spawnCount,
    lastProcess: () => last,
    downloads: () => downloadCount,
    release: () => release?.(),
  };
}

/** Контекст с режимом службы Windows и фидом обновлений в конфиге. */
async function buildUpdateContext(
  harness: RunnerHarness,
  deployment: 'windows-service' | 'standalone' | 'docker' = 'windows-service',
): Promise<RestTestContext> {
  return buildRestContext({
    config: {
      deployment,
      update: { ...DEFAULT_UPDATE_CONFIG, feedUrl: FEED_URL },
    },
    updateApplyOptions: { runnerOptions: harness.runnerOptions },
  });
}

/** `POST /system/update/apply` с указанной версией и заголовками. */
async function apiApply(
  ctx: RestTestContext,
  targetVersion: string,
  headers: Record<string, string> = authHeaders(ctx),
): Promise<{ statusCode: number; body: string; data: UpdateJob | null; details: unknown }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/system/update/apply',
    headers: { ...headers, 'client-request-id': `apply-${targetVersion}-${Math.random()}` },
    payload: { target_version: targetVersion },
  });
  const json = res.json() as { data?: UpdateJob; error?: { details?: unknown } };
  return {
    statusCode: res.statusCode,
    body: res.body,
    data: json.data ?? null,
    details: json.error?.details ?? null,
  };
}

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// REST: права, статус, проверка
// ---------------------------------------------------------------------------

describe('system/update — администратор и статус', { skip: !nativeAvailable() }, () => {
  it('все четыре эндпоинта требуют администратора (401 без ключа, 403 не админу)', async () => {
    const harness = makeRunnerHarness();
    const ctx = await buildUpdateContext(harness);
    try {
      const plain = createPlainUser(ctx);
      const routes: Array<{
        method: 'GET' | 'POST';
        url: string;
        payload?: Record<string, unknown>;
      }> = [
        { method: 'GET', url: '/api/v1/system/update' },
        { method: 'POST', url: '/api/v1/system/update/check' },
        {
          method: 'POST',
          url: '/api/v1/system/update/apply',
          payload: { target_version: TARGET_VERSION },
        },
        { method: 'GET', url: '/api/v1/system/update/progress' },
      ];
      for (const route of routes) {
        const anon = await ctx.app.inject(
          route.payload === undefined
            ? { method: route.method, url: route.url }
            : { method: route.method, url: route.url, payload: route.payload },
        );
        assert.equal(anon.statusCode, 401, `${route.method} ${route.url}: anon`);
        const forbidden = await ctx.app.inject(
          route.payload === undefined
            ? { method: route.method, url: route.url, headers: { authorization: `Bearer ${plain.key}` } }
            : {
                method: route.method,
                url: route.url,
                headers: { authorization: `Bearer ${plain.key}` },
                payload: route.payload,
              },
        );
        assert.equal(forbidden.statusCode, 403, `${route.method} ${route.url}: plain user`);
        assert.equal((forbidden.json() as { error: { code: string } }).error.code, 'FORBIDDEN');
      }
      // Ни одно задание не создано.
      assert.equal(ctx.sys.getLatestUpdateJob(), null);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('GET отдаёт кеш, deployment и instruction; прогресс пуст до первого задания', async () => {
    const harness = makeRunnerHarness();
    const ctx = await buildUpdateContext(harness);
    try {
      const initial = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/system/update',
        headers: authHeaders(ctx),
      });
      assert.equal(initial.statusCode, 200, initial.body);
      const initialData = initial.json().data as Record<string, unknown>;
      assert.equal(initialData.current_version, SERVER_VERSION);
      assert.equal(initialData.available_version, null);
      assert.equal(initialData.deployment, 'windows-service');
      assert.equal(initialData.instruction, null);
      assert.equal(initialData.check_error, null);

      await primeCache(ctx);
      const afterCheck = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/system/update',
        headers: authHeaders(ctx),
      });
      const data = afterCheck.json().data as Record<string, unknown>;
      assert.equal(data.available_version, TARGET_VERSION);
      assert.equal(data.download_url, DOWNLOAD_URL);
      assert.equal(data.sha256, INSTALLER_SHA);
      assert.equal(data.channel, 'stable');
      assert.equal(data.check_error, null);

      const progress = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/system/update/progress',
        headers: authHeaders(ctx),
      });
      assert.equal(progress.statusCode, 200);
      assert.deepEqual(progress.json().data, { job: null });
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('http-ссылка на ассет отражается предупреждением в check_error, кеш не меняется', async () => {
    const harness = makeRunnerHarness();
    const ctx = await buildUpdateContext(harness);
    try {
      await primeCache(ctx, 'http://feed.test/ETN-Setup.exe');
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/system/update',
        headers: authHeaders(ctx),
      });
      const data = res.json().data as { check_error: string | null; download_url: string | null };
      assert.equal(data.download_url, 'http://feed.test/ETN-Setup.exe');
      assert.equal(data.check_error, INSTALLER_HTTPS_WARNING);
      // Кеш checker'а не изменился: это предупреждение ответа, а не проверки.
      assert.equal(ctx.app.updateChecker.getCache().check_error, null);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('POST /check во время идущей проверки — 429', async () => {
    const harness = makeRunnerHarness();
    const ctx = await buildUpdateContext(harness);
    try {
      const original = globalThis.fetch;
      let releaseFetch: (() => void) | null = null;
      // Висит только запрос фида; SHA256SUMS отдаётся сразу, иначе проверка
      // уйдёт во второй висящий запрос, который никто не отпустит.
      globalThis.fetch = ((input: unknown) => {
        const url = typeof input === 'string' ? input : String(input);
        if (url === 'https://feed.test/SHA256SUMS') {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: async () => `${INSTALLER_SHA}  ETN-Setup-${TARGET_VERSION}.exe\n`,
          });
        }
        return new Promise<unknown>((resolve) => {
          releaseFetch = () =>
            resolve({
              ok: true,
              status: 200,
              text: async () => JSON.stringify(feedPayload(DOWNLOAD_URL)),
            });
        });
      }) as unknown as typeof fetch;
      try {
        const pending = ctx.app.updateChecker.checkNow();
        await waitFor(() => ctx.app.updateChecker.isCheckInProgress());
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/system/update/check',
          headers: authHeaders(ctx),
        });
        assert.equal(res.statusCode, 429, res.body);
        assert.equal((res.json() as { error: { code: string } }).error.code, 'RATE_LIMITED');
        (releaseFetch as unknown as () => void)();
        await pending;
      } finally {
        globalThis.fetch = original;
      }
    } finally {
      await closeRestContext(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// REST: apply — конфликты и отказы без остановки службы
// ---------------------------------------------------------------------------

describe('system/update/apply — конфликты', { skip: !nativeAvailable() }, () => {
  it('без доступной версии — 422; без target_version — 422', async () => {
    const harness = makeRunnerHarness();
    const ctx = await buildUpdateContext(harness);
    try {
      const noUpdate = await apiApply(ctx, TARGET_VERSION);
      assert.equal(noUpdate.statusCode, 422, noUpdate.body);
      assert.equal((noUpdate.details as { reason: string }).reason, 'no-update');

      await primeCache(ctx);
      const missing = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/system/update/apply',
        headers: authHeaders(ctx),
        payload: {},
      });
      assert.equal(missing.statusCode, 422, missing.body);
      const body = missing.json() as {
        error: { code: string; details: { field: string } };
      };
      assert.equal(body.error.code, 'VALIDATION_ERROR');
      assert.equal(body.error.details.field, 'target_version');
      assert.equal(ctx.sys.getLatestUpdateJob(), null);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('downgrade — 409, задание не создаётся', async () => {
    const harness = makeRunnerHarness();
    const ctx = await buildUpdateContext(harness);
    try {
      await primeCache(ctx);
      const res = await apiApply(ctx, '0.15.0');
      assert.equal(res.statusCode, 409, res.body);
      assert.equal((res.details as { reason: string }).reason, 'downgrade');
      assert.equal(ctx.sys.getLatestUpdateJob(), null);
      assert.equal(harness.spawns(), 0);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('Docker — 409, прогресс всегда null', async () => {
    const harness = makeRunnerHarness();
    const ctx = await buildUpdateContext(harness, 'docker');
    try {
      await primeCache(ctx);
      const res = await apiApply(ctx, TARGET_VERSION);
      assert.equal(res.statusCode, 409, res.body);
      assert.equal((res.details as { reason: string }).reason, 'docker');
      assert.equal(ctx.sys.getLatestUpdateJob(), null);
      const progress = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/system/update/progress',
        headers: authHeaders(ctx),
      });
      assert.deepEqual(progress.json().data, { job: null });
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('гонка двух администраторов: ровно одно задание, второй получает 409 с текущим', async () => {
    const harness = makeRunnerHarness({ blocked: true });
    const ctx = await buildUpdateContext(harness);
    try {
      await primeCache(ctx);
      const second = createSecondAdminUser(ctx);

      const first = apiApply(ctx, TARGET_VERSION, authHeaders(ctx));
      // Задание вставляется синхронно до первого await скачивания.
      await waitFor(() => ctx.sys.getActiveUpdateJob() !== null);
      const secondResponse = await apiApply(ctx, TARGET_VERSION, {
        authorization: `Bearer ${second.key}`,
      });

      assert.equal(secondResponse.statusCode, 409, secondResponse.body);
      const details = secondResponse.details as { reason: string; job: UpdateJob };
      assert.equal(details.reason, 'job-active');
      assert.equal(details.job.stage, 'preparing');
      assert.equal(details.job.target_version, TARGET_VERSION);

      harness.release();
      const firstResponse = await first;
      assert.equal(firstResponse.statusCode, 201, firstResponse.body);
      assert.ok(firstResponse.data !== null);
      assert.equal(firstResponse.data!.target_version, TARGET_VERSION);

      // Ровно одно задание: последнее в журнале — то же, что вернул первый apply.
      const latest = ctx.sys.getLatestUpdateJob();
      assert.ok(latest !== null);
      assert.equal(latest!.id, firstResponse.data!.id);
      await waitFor(() => ctx.app.updateApply.getProgress()?.stage === 'done');
      assert.equal(ctx.sys.getActiveUpdateJob(), null);
      const progress = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/system/update/progress',
        headers: authHeaders(ctx),
      });
      const job = (progress.json().data as { job: UpdateJob }).job;
      assert.equal(job.id, latest!.id);
      assert.equal(job.stage, 'done');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('сервер не службой — задание failed без остановки, запись продолжает работать', async () => {
    const harness = makeRunnerHarness();
    const ctx = await buildUpdateContext(harness, 'standalone');
    try {
      await primeCache(ctx);
      const res = await apiApply(ctx, TARGET_VERSION);
      assert.equal(res.statusCode, 201, res.body);
      assert.ok(res.data !== null);
      assert.equal(res.data!.stage, 'failed');
      assert.equal(res.data!.error, NOT_A_SERVICE_MESSAGE);
      assert.equal(harness.spawns(), 0);
      assert.equal(harness.downloads(), 0);
      // Обслуживание не включалось: changed-запрос проходит.
      assert.equal(ctx.app.maintenance.getState().state, 'idle');
      const created = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/thoughts`,
        headers: authHeaders(ctx),
        payload: { title: 'После отказа не службой' },
      });
      assert.equal(created.statusCode, 201, created.body);
      // Итог виден в прогрессе.
      const progress = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/system/update/progress',
        headers: authHeaders(ctx),
      });
      assert.equal((progress.json().data as { job: UpdateJob }).job.stage, 'failed');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('несовпавший хеш — 502, задание failed на preparing, служба работает', async () => {
    const harness = makeRunnerHarness({
      // Байты не совпадут с хешем из SHA256SUMS.
      fetchImpl: async () => okResponse(Buffer.from('подменённый установщик', 'utf8')),
    });
    const ctx = await buildUpdateContext(harness);
    try {
      await primeCache(ctx);
      const res = await apiApply(ctx, TARGET_VERSION);
      assert.equal(res.statusCode, 502, res.body);
      const details = res.details as { reason: string; job: UpdateJob };
      assert.equal(details.reason, 'installer-hash');
      assert.equal(details.job.stage, 'failed');
      assert.equal(details.job.target_version, TARGET_VERSION);
      assert.equal(harness.spawns(), 0);
      // Обслуживание не включалось — сервер продолжает принимать записи.
      assert.equal(ctx.app.maintenance.getState().state, 'idle');
      const created = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/thoughts`,
        headers: authHeaders(ctx),
        payload: { title: 'После несовпавшего хеша' },
      });
      assert.equal(created.statusCode, 201, created.body);
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('http-ссылка на ассет — 502, установщик не скачивается и не запускается', async () => {
    const harness = makeRunnerHarness();
    const ctx = await buildUpdateContext(harness);
    try {
      await primeCache(ctx, 'http://feed.test/ETN-Setup.exe');
      const res = await apiApply(ctx, TARGET_VERSION);
      assert.equal(res.statusCode, 502, res.body);
      const details = res.details as { reason: string; job: UpdateJob };
      assert.equal(details.reason, 'installer-target');
      assert.match(details.job.error ?? '', /HTTPS/i);
      assert.equal(harness.downloads(), 0);
      assert.equal(harness.spawns(), 0);
      assert.equal(ctx.app.maintenance.getState().state, 'idle');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('обслуживание включено до запуска установщика, этап задания — backing-up', async () => {
    let stateAtSpawn: string | null = null;
    let stageAtSpawn: string | null = null;
    let ctxRef: RestTestContext | null = null;
    let logDir = '';
    const harness = makeRunnerHarness({
      spawnImpl: () => {
        stateAtSpawn = ctxRef?.app.maintenance.getState().state ?? null;
        stageAtSpawn = ctxRef?.sys.getActiveUpdateJob()?.stage ?? null;
        touchInstallerLog(logDir);
        const process = new FakeProcess();
        queueMicrotask(() => process.finish(0));
        return process;
      },
    });
    logDir = harness.logDir;
    const ctx = await buildUpdateContext(harness);
    ctxRef = ctx;
    try {
      await primeCache(ctx);
      const res = await apiApply(ctx, TARGET_VERSION);
      assert.equal(res.statusCode, 201, res.body);
      // К моменту spawn состояние — updating (кадр разослан) и этап backing-up.
      assert.equal(stateAtSpawn, 'updating');
      assert.equal(stageAtSpawn, 'backing-up');
    } finally {
      await closeRestContext(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// REST: CORS на 503 обслуживания и восстановление после перезапуска
// ---------------------------------------------------------------------------

describe('обслуживание — CORS на 503', { skip: !nativeAvailable() }, () => {
  it('503 от гейта несёт access-control-allow-origin запроса', async () => {
    const ctx = await buildRestContext();
    try {
      await ctx.app.maintenance.beginUpdating({ retry_after: 30, target_version: '0.99.0' });
      const origin = 'https://client.example';
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/networks',
        headers: { ...authHeaders(ctx), origin },
        payload: { display_name: 'Нет' },
      });
      assert.equal(res.statusCode, 503, res.body);
      assert.equal((res.json() as { error: { code: string } }).error.code, 'SERVER_UPDATING');
      assert.equal(
        res.headers['access-control-allow-origin'],
        origin,
        '503 обязан нести CORS-заголовок (замечание приёмки 2f599b67)',
      );
    } finally {
      await closeRestContext(ctx);
    }
  });
});

describe('задание обновления — перезапуск сервера', { skip: !nativeAvailable() }, () => {
  it('незавершённое задание после перезапуска читается как failed', async () => {
    const harness = makeRunnerHarness();
    const ctx = await buildUpdateContext(harness);
    try {
      await primeCache(ctx);
      ctx.sys.createUpdateJob({
        id: 'running-job-after-restart',
        targetVersion: TARGET_VERSION,
        stage: 'backing-up',
        startedAt: '2026-10-30T10:00:00.000Z',
      });
      // Живое задание до «перезапуска» — активное.
      assert.equal(ctx.app.updateApply.getProgress()?.stage, 'backing-up');

      // Новый процесс сервера на той же БД: восстановление при создании сервиса.
      const second = await createServer({
        config: testServerConfig(ctx.dataDir, {
          deployment: 'windows-service',
          update: { ...DEFAULT_UPDATE_CONFIG, feedUrl: FEED_URL },
        }),
        systemDb: ctx.sys,
        logger: createLogger('silent'),
      });
      try {
        const job = second.updateApply.getProgress();
        assert.ok(job !== null);
        assert.equal(job!.stage, 'failed');
        assert.match(job!.error ?? '', /backing-up/);
        assert.match(job!.error ?? '', /перезапущен/);
        assert.equal(second.updateApply.isJobRunning(), false);
        assert.equal(ctx.sys.getActiveUpdateJob(), null);
      } finally {
        await second.close();
      }
    } finally {
      await closeRestContext(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Юнит: сервис задания (коды установщика, тайм-аут, виды 502)
// ---------------------------------------------------------------------------

/** Системная БД в памяти с применёнными миграциями. */
function makeSystemDb(): SystemDb {
  const db: Database.Database = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, systemMigrationsDir());
  return new SystemDb(db);
}

/** Кеш проверки, предлагающий TARGET_VERSION. */
function makeCache(overrides: Partial<UpdateCache> = {}): UpdateCache {
  return {
    current_version: SERVER_VERSION,
    available_version: TARGET_VERSION,
    channel: 'stable',
    checked_at: '2026-10-30T10:00:00.000Z',
    check_error: null,
    download_url: DOWNLOAD_URL,
    sha256: INSTALLER_SHA,
    deployment: 'windows-service',
    ...overrides,
  };
}

/** Собрать сервис задания с подменённым runner'ом и обслуживанием. */
function makeService(
  harness: RunnerHarness,
  options: {
    deployment?: 'windows-service' | 'standalone' | 'docker';
    cache?: UpdateCache;
    sys?: SystemDb;
  } = {},
): { service: UpdateApplyService; sys: SystemDb; maintenanceCalls: () => number } {
  const sys = options.sys ?? makeSystemDb();
  let calls = 0;
  const service = createUpdateApplyService({
    systemDb: sys,
    deployment: options.deployment ?? 'windows-service',
    maintenance: {
      beginUpdating: async () => {
        calls += 1;
        return {
          state: 'updating',
          reason: 'server-updating',
          since: '2026-10-30T10:00:00.000Z',
          retry_after: 300,
          target_version: TARGET_VERSION,
        };
      },
    },
    getCache: () => options.cache ?? makeCache(),
    runnerOptions: harness.runnerOptions,
    now: () => new Date('2026-10-30T10:00:00.000Z'),
  });
  return { service, sys, maintenanceCalls: () => calls };
}

describe('задание обновления — коды установщика', { skip: !nativeAvailable() }, () => {
  it('код 0 — done, обслуживание включено, задание терминальное', async () => {
    const harness = makeRunnerHarness();
    const { service, sys, maintenanceCalls } = makeService(harness);
    try {
      const job = await service.apply({ targetVersion: TARGET_VERSION });
      assert.equal(job.target_version, TARGET_VERSION);
      assert.equal(maintenanceCalls(), 1);
      await waitFor(() => service.getProgress()?.stage === 'done');
      const done = service.getProgress();
      assert.ok(done !== null);
      assert.equal(done!.stage, 'done');
      assert.equal(done!.error, null);
      assert.equal(sys.getActiveUpdateJob(), null);
    } finally {
      sys.close();
    }
  });

  it('код 10 — failed с кодом и путём журнала', async () => {
    const harness = makeRunnerHarness({
      spawnImpl: () => {
        touchInstallerLog(harness.logDir);
        const process = new FakeProcess();
        queueMicrotask(() => process.finish(10));
        return process;
      },
    });
    const { service, sys } = makeService(harness);
    try {
      await service.apply({ targetVersion: TARGET_VERSION });
      await waitFor(() => service.getProgress()?.stage === 'failed');
      const job = service.getProgress();
      assert.ok(job !== null);
      assert.match(job!.error ?? '', /кодом 10/);
      assert.match(job!.error ?? '', /install-\d{8}-\d{6}\.log/);
    } finally {
      sys.close();
    }
  });

  it('код 20 — failed «нужен ручной режим» с путём журнала', async () => {
    const harness = makeRunnerHarness({
      spawnImpl: () => {
        touchInstallerLog(harness.logDir);
        const process = new FakeProcess();
        queueMicrotask(() => process.finish(20));
        return process;
      },
    });
    const { service, sys } = makeService(harness);
    try {
      await service.apply({ targetVersion: TARGET_VERSION });
      await waitFor(() => service.getProgress()?.stage === 'failed');
      const job = service.getProgress();
      assert.ok(job !== null);
      assert.match(job!.error ?? '', /ручной режим/);
      assert.match(job!.error ?? '', /install-\d{8}-\d{6}\.log/);
    } finally {
      sys.close();
    }
  });
});

describe('задание обновления — тайм-аут и installer alive', { skip: !nativeAvailable() }, () => {
  it('тайм-аут: failed с путём журнала, новый apply — 409, пока процесс жив', async () => {
    const harness = makeRunnerHarness({
      runTimeoutMs: 25,
      spawnImpl: () => {
        touchInstallerLog(harness.logDir);
        // Процесс намеренно не закрывается: установщик оставлен работать.
        return new FakeProcess();
      },
    });
    const { service, sys } = makeService(harness);
    try {
      const launched = await service.apply({ targetVersion: TARGET_VERSION });
      assert.equal(launched.stage, 'backing-up');
      assert.equal(service.isInstallerAlive(), true);

      await waitFor(() => service.getProgress()?.stage === 'failed', 5_000);
      const failed = service.getProgress();
      assert.ok(failed !== null);
      assert.match(failed!.error ?? '', /не завершился/);
      assert.match(failed!.error ?? '', /install-\d{8}-\d{6}\.log/);
      assert.equal(sys.getActiveUpdateJob(), null, 'задание уже терминальное');

      // single-flight runner'а снят тайм-аутом, но флаг «installer alive» — нет.
      await assert.rejects(
        service.apply({ targetVersion: TARGET_VERSION }),
        (err: unknown) =>
          err instanceof UpdateApplyConflictError && err.reason === 'installer-alive',
      );

      // Процесс завершился — новая попытка разрешена и отрабатывает.
      harness.lastProcess()?.finish(0);
      await waitFor(() => !service.isInstallerAlive());
      const retried = await service.apply({ targetVersion: TARGET_VERSION });
      assert.equal(retried.target_version, TARGET_VERSION);
      // Завершаем уже процесс повторной попытки — первый так и остался жив.
      harness.lastProcess()?.finish(0);
      await waitFor(() => service.getProgress()?.stage === 'done');
    } finally {
      sys.close();
    }
  });
});

describe('задание обновления — виды 502', { skip: !nativeAvailable() }, () => {
  const cases: Array<{
    name: string;
    harness: () => RunnerHarness;
    cache: () => UpdateCache;
    expected: UpdateInstallerFailureError['reason'];
    /** Сколько раз сервис пытался запустить установщик. */
    spawns: number;
    /** Включалось ли обслуживание до отказа. */
    maintenanceCalls: number;
  }> = [
    {
      name: 'цель без ссылки',
      harness: () => makeRunnerHarness(),
      cache: () => makeCache({ download_url: null, sha256: null }),
      expected: 'installer-target',
      spawns: 0,
      maintenanceCalls: 0,
    },
    {
      name: 'скачивание',
      harness: () =>
        makeRunnerHarness({
          fetchImpl: async () => ({ ok: false, status: 500, body: null }),
        }),
      cache: () => makeCache(),
      expected: 'installer-download',
      spawns: 0,
      maintenanceCalls: 0,
    },
    {
      name: 'хеш',
      harness: () => makeRunnerHarness({ fetchImpl: async () => okResponse(Buffer.from('другое')) }),
      cache: () => makeCache(),
      expected: 'installer-hash',
      spawns: 0,
      maintenanceCalls: 0,
    },
    {
      name: 'запуск',
      harness: () =>
        makeRunnerHarness({
          spawnImpl: () => {
            throw new Error('нет прав на запуск');
          },
        }),
      cache: () => makeCache(),
      expected: 'installer-launch',
      spawns: 1,
      // Хук обслуживания стоит до spawn: он уже отработал, но установщик не
      // запущен и служба не остановлена.
      maintenanceCalls: 1,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} — 502 (UpdateInstallerFailureError), задание failed`, async () => {
      const harness = testCase.harness();
      const { service, sys, maintenanceCalls } = makeService(harness, {
        cache: testCase.cache(),
      });
      try {
        await assert.rejects(
          service.apply({ targetVersion: TARGET_VERSION }),
          (err: unknown) =>
            err instanceof UpdateInstallerFailureError && err.reason === testCase.expected,
        );
        const job = service.getProgress();
        assert.ok(job !== null);
        assert.equal(job!.stage, 'failed');
        assert.equal(service.isInstallerAlive(), false);
        assert.equal(sys.getActiveUpdateJob(), null);
        assert.equal(harness.spawns(), testCase.spawns);
        assert.equal(maintenanceCalls(), testCase.maintenanceCalls);
      } finally {
        sys.close();
      }
    });
  }
});

describe('задание обновления — конфликты версий', { skip: !nativeAvailable() }, () => {
  it('нет доступной версии — 422 no-update', async () => {
    const harness = makeRunnerHarness();
    const { service, sys } = makeService(harness, {
      cache: makeCache({ available_version: null, download_url: null, sha256: null }),
    });
    try {
      await assert.rejects(
        service.apply({ targetVersion: TARGET_VERSION }),
        (err: unknown) => err instanceof UpdateApplyNoUpdateError && err.reason === 'no-update',
      );
      assert.equal(sys.getLatestUpdateJob(), null);
    } finally {
      sys.close();
    }
  });

  it('версия не semver — 422 invalid-target', async () => {
    const harness = makeRunnerHarness();
    const { service, sys } = makeService(harness);
    try {
      await assert.rejects(
        service.apply({ targetVersion: 'не-версия' }),
        (err: unknown) =>
          err instanceof UpdateApplyNoUpdateError && err.reason === 'invalid-target',
      );
      assert.equal(sys.getLatestUpdateJob(), null);
    } finally {
      sys.close();
    }
  });

  it('downgrade и сменившийся кеш — 409', async () => {
    const harness = makeRunnerHarness();
    const { service, sys } = makeService(harness);
    try {
      await assert.rejects(
        service.apply({ targetVersion: '0.15.0' }),
        (err: unknown) =>
          err instanceof UpdateApplyConflictError && err.reason === 'downgrade',
      );
      await assert.rejects(
        service.apply({ targetVersion: '0.16.1' }),
        (err: unknown) =>
          err instanceof UpdateApplyConflictError && err.reason === 'version-mismatch',
      );
      assert.equal(sys.getLatestUpdateJob(), null);
    } finally {
      sys.close();
    }
  });

  it('Docker — 409, задание не создаётся', async () => {
    const harness = makeRunnerHarness();
    const { service, sys } = makeService(harness, { deployment: 'docker' });
    try {
      await assert.rejects(
        service.apply({ targetVersion: TARGET_VERSION }),
        (err: unknown) => err instanceof UpdateApplyConflictError && err.reason === 'docker',
      );
      assert.equal(sys.getLatestUpdateJob(), null);
      assert.equal(service.getProgress(), null);
    } finally {
      sys.close();
    }
  });
});

describe('задание обновления — восстановление', { skip: !nativeAvailable() }, () => {
  it('recoverInterruptedUpdateJobs переводит активные задания в failed и сохраняет этап в причине', () => {
    const sys = makeSystemDb();
    try {
      sys.createUpdateJob({
        id: 'interrupted',
        targetVersion: TARGET_VERSION,
        stage: 'backing-up',
        startedAt: '2026-10-30T10:00:00.000Z',
      });
      assert.equal(recoverInterruptedUpdateJobs(sys), 1);
      const row = sys.getUpdateJob('interrupted');
      assert.ok(row !== null);
      assert.equal(row!.stage, 'failed');
      assert.match(row!.error ?? '', /backing-up/);
      assert.notEqual(row!.finished_at, null);
      // Повторный вызов ничего не меняет: терминальные не трогаются.
      assert.equal(recoverInterruptedUpdateJobs(sys), 0);
    } finally {
      sys.close();
    }
  });
});
