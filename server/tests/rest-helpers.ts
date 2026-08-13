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

import type { ServerConfig } from '../src/config.js';
import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { closeNetworkDb, openNetworkDb } from '../src/db/network-db.js';
import { systemMigrationsDir } from '../src/paths.js';
import { createServer } from '../src/http/server.js';
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
}

const TEST_CONFIG: ServerConfig = {
  dataDir: '/tmp/etn-rest-unused',
  host: '127.0.0.1',
  port: 0,
  tls: null,
  logLevel: 'silent',
  mcp: { enabled: false, port: null },
};

/**
 * Build a fresh app, an admin user with an API-key, and a real network with
 * its HOME thought. Callers must {@link closeRestContext} the result.
 */
export async function buildRestContext(): Promise<RestTestContext> {
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
    config: { ...TEST_CONFIG, dataDir },
    systemDb: sys,
    logger: createLogger('silent'),
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

  return { app, sys, dataDir, adminKey: gen.key, adminId, networkId, homeId: home.id };
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
