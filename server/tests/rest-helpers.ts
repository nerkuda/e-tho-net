/**
 * Shared helpers for the phase-D REST integration tests (task D8).
 *
 * Builds a real Fastify app against a throwaway data directory with an admin
 * user + API-key, then creates a real network through `POST /networks` (so the
 * per-network `data.db` with the HOME thought exists on disk). Each test gets
 * a fresh context; {@link closeRestContext} closes the network DB first (the
 * SQLite file is open in the process registry, which would block `rmSync` on
 * Windows) and then removes the directory.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import {
  DEFAULT_MCP_SESSION_IDLE_TTL_MS,
  DEFAULT_UPDATE_CONFIG,
} from '../src/config.js';
import type { ServerConfig } from '../src/config.js';
import { resolveClientChannel } from '../src/version.js';
import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { closeNetworkDb, openNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { systemMigrationsDir } from '../src/paths.js';
import { createServer } from '../src/http/server.js';
import type { InstallerRunnerOptions } from '../src/update/installer-runner.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { createLogger } from '../src/logger.js';

/** True when the `better-sqlite3` native binding is available. */
export function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** A running app + freshly created network + its seeded HOME thought. */
export interface RestTestContext {
  app: FastifyInstance;
  sys: SystemDb;
  /** Temp data directory (removed by {@link closeRestContext}). */
  dataDir: string;
  /** Full API-key of the admin user. */
  adminKey: string;
  /** Id of the admin user. */
  adminId: string;
  /** Network created via `POST /networks`. */
  networkId: string;
  /** Id of the network's root HOME thought. */
  homeId: string;
  /** Open handle of the network's `data.db` (released by {@link closeRestContext}). */
  ndb: NetworkDb;
}

const TEST_CONFIG: ServerConfig = {
  dataDir: '/tmp/etn-rest-unused',
  host: '127.0.0.1',
  port: 0,
  tls: null,
  logLevel: 'silent',
  mcp: { enabled: false, port: null, sessionIdleTtlMs: DEFAULT_MCP_SESSION_IDLE_TTL_MS },
  readerPool: { size: 1, taskTimeoutMs: 30000 },
  // Фоновый чекпойнт WAL в тестах выключен: сеть чекпойнтит сам тест.
  walCheckpoint: { intervalMs: 0 },
  // Пул записи в тестах выключен: пути записи переводит отдельная задача (c8920d04).
  writePool: { size: 0, taskTimeoutMs: 120000, idleEvictionMs: 30000 },
  clientChannel: resolveClientChannel({}),
  update: DEFAULT_UPDATE_CONFIG,
  deployment: 'standalone',
};

/**
 * Тестовый конфиг сервера с подставленным каталогом данных и необязательными
 * переопределениями. Второй сервер на той же БД (тест перезапуска задания
 * обновления) собирается этим же конфигом.
 */
export function testServerConfig(
  dataDir: string,
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
  return { ...TEST_CONFIG, dataDir, ...overrides };
}

/**
 * Переопределения контекста для отдельных групп тестов. Обычные тесты
 * обходятся без них: конфиг — тестовый, путь — standalone.
 */
export interface RestContextOptions {
  /** Частичная замена тестового конфига (например, `deployment`). */
  config?: Partial<ServerConfig>;
  /**
   * Настройки задания обновления (задача 0a27a63b): подмена HTTP-клиента и
   * процесса установщика, чтобы тест не запускал настоящий exe.
   */
  updateApplyOptions?: {
    runnerOptions?: InstallerRunnerOptions;
    now?: () => Date;
  };
}

/**
 * Build a fresh app, an admin user with an API-key, and a real network with
 * its HOME thought. Callers must {@link closeRestContext} the result.
 */
export async function buildRestContext(
  options: RestContextOptions = {},
): Promise<RestTestContext> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-rest-'));

  const db: Database.Database = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, systemMigrationsDir());
  const sys = new SystemDb(db);

  const adminId = randomUUID();
  sys.createUser({
    id: adminId,
    username: 'admin',
    displayName: 'Admin',
    isAdmin: true,
    isFirstUser: true,
  });
  const gen = generateApiKey();
  sys.createApiKey({
    id: randomUUID(),
    userId: adminId,
    label: 'primary',
    keyHash: hashApiKey(gen.key),
    keyPrefix: gen.keyPrefix,
  });

  const app = await createServer({
    config: testServerConfig(dataDir, options.config),
    systemDb: sys,
    logger: createLogger('silent'),
    ...(options.updateApplyOptions === undefined
      ? {}
      : { updateApplyOptions: options.updateApplyOptions }),
  });

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/networks',
    headers: { authorization: `Bearer ${gen.key}` },
    payload: { display_name: 'Test Net' },
  });
  assert.equal(created.statusCode, 201);
  const networkId = (created.json().data as { id: string }).id;

  // The network data.db is open in the process registry; read the HOME id.
  const ndb = openNetworkDb(dataDir, networkId);
  const home = ndb.prepare('SELECT id FROM thoughts WHERE is_root = 1 LIMIT 1').get() as {
    id: string;
  };

  return { app, sys, dataDir, adminKey: gen.key, adminId, networkId, homeId: home.id, ndb };
}

/** Close the app, release the network DB handle and remove the temp directory. */
export async function closeRestContext(ctx: RestTestContext): Promise<void> {
  await ctx.app.close();
  closeNetworkDb(ctx.networkId);
  ctx.sys.close();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
}

/** Authorization headers for the context's admin user. */
export function authHeaders(ctx: RestTestContext): Record<string, string> {
  return { authorization: `Bearer ${ctx.adminKey}` };
}

/**
 * Версия тестового desktop-клиента — нижняя граница диапазона тестового
 * сервера (`resolveClientChannel({})`, тот же источник, что у `/version`).
 * Клиент обязан присылать её на изменяющих запросах (задача c3f33e6a): тесты,
 * которые адресуют сессию слоя через `Client-Id`, эмулируют desktop-клиент и
 * без версии получают `426 CLIENT_VERSION_UNSUPPORTED`.
 */
export const TEST_CLIENT_VERSION: string = resolveClientChannel({}).min_client;

/**
 * Заголовки desktop-клиента: `Client-Id` + совместимый `Client-Version`.
 * Без `clientId` — пустой набор (запрос считается API-интеграцией).
 */
export function clientHeaders(clientId: string | undefined): Record<string, string> {
  if (clientId === undefined) return {};
  return { 'client-id': clientId, 'client-version': TEST_CLIENT_VERSION };
}

/**
 * Create a plain, non-admin, non-member user with an API-key inside the
 * context's system DB (task 0.4.2 bug-fix tests: `buildRestContext`'s own
 * user is always a global admin, which now bypasses membership checks by
 * design — a genuine "foreign, no rights at all" caller must be a non-admin).
 */
export function createPlainUser(ctx: RestTestContext): { userId: string; key: string } {
  const userId = randomUUID();
  ctx.sys.createUser({ id: userId, username: `user-${userId.slice(0, 8)}`, displayName: null });
  const gen = generateApiKey();
  ctx.sys.createApiKey({
    id: randomUUID(),
    userId,
    label: 'plain',
    keyHash: hashApiKey(gen.key),
    keyPrefix: gen.keyPrefix,
  });
  return { userId, key: gen.key };
}

/**
 * Create a second global-admin user with an API-key inside the context's own
 * system DB/app (same process, same `dataDir`) — unlike a second
 * `buildRestContext()`, this shares the running server so it can exercise the
 * admin's cross-network access to `ctx.networkId` (task 0.4.2 bug-fix).
 */
export function createSecondAdminUser(ctx: RestTestContext): { userId: string; key: string } {
  const userId = randomUUID();
  ctx.sys.createUser({
    id: userId,
    username: `admin2-${userId.slice(0, 8)}`,
    displayName: null,
    isAdmin: true,
  });
  const gen = generateApiKey();
  ctx.sys.createApiKey({
    id: randomUUID(),
    userId,
    label: 'admin2',
    keyHash: hashApiKey(gen.key),
    keyPrefix: gen.keyPrefix,
  });
  return { userId, key: gen.key };
}

/** Create a thought via the REST API and return the parsed `data`. */
export async function apiCreateThought(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; data: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload,
  });
  return { statusCode: res.statusCode, data: res.json().data as Record<string, unknown> };
}

/**
 * Открыть `data.db` сети как `NetworkDb` для интеграционных тестов, которым
 * нужен прямой доступ к БД (например, чтобы прочитать HOME-мысль свежесозданной
 * сети). Соответствующий `closeNetworkDb` обязан вызвать владелец (см.
 * {@link closeRestContext}, который закроет только основную сеть; для второй
 * сети нужно звать `closeNetworkDb` явно).
 */
export function openNetworkDbSafe(dataDir: string, networkId: string): NetworkDb {
  return openNetworkDb(dataDir, networkId);
}
