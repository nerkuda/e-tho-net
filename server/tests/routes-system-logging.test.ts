/**
 * Integration tests for the file-journal admin routes (task 1dd33e23 §4):
 * auth (401), rights (403 non-admin), status/toggle, download, deletion and
 * the path-traversal filename guard. Uses app.inject against a real temp
 * data dir (the journal lives in `<dataDir>/logs`).
 *
 * Requires the `better-sqlite3` native binding; skipped otherwise.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

import type { ServerConfig } from '../src/config.js';
import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir } from '../src/paths.js';
import { createServer } from '../src/http/server.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { createLogger } from '../src/logger.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** App + admin key + temp data dir; callers must `await ctx.app.close()` + cleanup. */
interface Ctx {
  app: FastifyInstance;
  sys: SystemDb;
  dataDir: string;
  adminKey: string;
  logsDir: string;
}

let ctx: Ctx | null = null;

async function buildApp(): Promise<Ctx> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-syslog-'));
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
  const config: ServerConfig = {
    dataDir,
    host: '127.0.0.1',
    port: 0,
    tls: null,
    logLevel: 'silent',
    mcp: { enabled: false, port: null },
  };
  const app = await createServer({ config, systemDb: sys, logger: createLogger('silent') });
  ctx = { app, sys, dataDir, adminKey: gen.key, logsDir: path.join(dataDir, 'logs') };
  return ctx;
}

/** Non-admin user with a key. */
function plainUserKey(c: Ctx): string {
  const userId = randomUUID();
  c.sys.createUser({ id: userId, username: `pleb-${userId.slice(0, 8)}`, displayName: null });
  const gen = generateApiKey();
  c.sys.createApiKey({
    id: randomUUID(),
    userId,
    label: 'p',
    keyHash: hashApiKey(gen.key),
    keyPrefix: gen.keyPrefix,
  });
  return gen.key;
}

function adminHeaders(c: Ctx): Record<string, string> {
  return { authorization: `Bearer ${c.adminKey}` };
}

function todayName(): string {
  return `server-${new Date().toISOString().slice(0, 10)}.log`;
}

afterEach(async () => {
  if (ctx !== null) {
    await ctx.app.close();
    ctx.sys.close();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
    ctx = null;
  }
});

describe(
  '/system/logging + /system/logs',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('GET /system/logging: 200 with disabled flag and empty file list', async () => {
      const c = await buildApp();
      const res = await c.app.inject({
        method: 'GET',
        url: '/api/v1/system/logging',
        headers: adminHeaders(c),
      });
      assert.equal(res.statusCode, 200);
      const data = res.json().data;
      assert.equal(data.enabled, false, 'flag starts off (in-memory only)');
      assert.equal(data.retentionDays, 30);
      assert.deepEqual(data.files, []);
      assert.equal(data.logDir, c.logsDir);
    });

    it('rejects anonymous (401) and non-admin (403) callers', async () => {
      const c = await buildApp();
      const anon = await c.app.inject({ method: 'GET', url: '/api/v1/system/logging' });
      assert.equal(anon.statusCode, 401);
      const pleb = plainUserKey(c);
      const forbidden = await c.app.inject({
        method: 'GET',
        url: '/api/v1/system/logging',
        headers: { authorization: `Bearer ${pleb}` },
      });
      assert.equal(forbidden.statusCode, 403);
      const forbiddenPut = await c.app.inject({
        method: 'PUT',
        url: '/api/v1/system/logging',
        headers: { authorization: `Bearer ${pleb}` },
        payload: { enabled: true },
      });
      assert.equal(forbiddenPut.statusCode, 403);
    });

    it('PUT toggles the flag and journals the toggle with the actor', async () => {
      const c = await buildApp();
      const res = await c.app.inject({
        method: 'PUT',
        url: '/api/v1/system/logging',
        headers: adminHeaders(c),
        payload: { enabled: true },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.enabled, true);
      const journal = fs.readFileSync(path.join(c.logsDir, todayName()), 'utf8');
      assert.match(journal, /WARN \[logging\] file logging enabled user=admin enabled=true/);
    });

    it('PUT validates the body (422 for a missing/non-boolean enabled)', async () => {
      const c = await buildApp();
      const noField = await c.app.inject({
        method: 'PUT',
        url: '/api/v1/system/logging',
        headers: adminHeaders(c),
        payload: {},
      });
      assert.equal(noField.statusCode, 422);
      assert.equal(noField.json().error.code, 'VALIDATION_ERROR');
      const notBool = await c.app.inject({
        method: 'PUT',
        url: '/api/v1/system/logging',
        headers: adminHeaders(c),
        payload: { enabled: 'yes' },
      });
      assert.equal(notBool.statusCode, 422);
    });

    it('GET /system/logs/:filename downloads the journal as text/plain attachment', async () => {
      const c = await buildApp();
      await c.app.inject({
        method: 'PUT',
        url: '/api/v1/system/logging',
        headers: adminHeaders(c),
        payload: { enabled: true },
      });
      const res = await c.app.inject({
        method: 'GET',
        url: `/api/v1/system/logs/${todayName()}`,
        headers: adminHeaders(c),
      });
      assert.equal(res.statusCode, 200);
      assert.ok(String(res.headers['content-type'] ?? '').includes('text/plain'));
      assert.ok(
        String(res.headers['content-disposition'] ?? '').includes(
          `attachment; filename="${todayName()}"`,
        ),
      );
      assert.match(res.body, /file logging enabled/);
    });

    it('GET /system/logs/:filename: 404 unknown, 422 malformed names', async () => {
      const c = await buildApp();
      const missing = await c.app.inject({
        method: 'GET',
        url: '/api/v1/system/logs/server-2020-01-01.log',
        headers: adminHeaders(c),
      });
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().error.code, 'NOT_FOUND');
      const bad = await c.app.inject({
        method: 'GET',
        url: '/api/v1/system/logs/..%2F..%2F_system.db',
        headers: adminHeaders(c),
      });
      assert.equal(bad.statusCode, 422, 'traversal attempt rejected by validation');
      assert.equal(bad.json().error.code, 'VALIDATION_ERROR');
      const bad2 = await c.app.inject({
        method: 'GET',
        url: '/api/v1/system/logs/server-2026-9-4.log',
        headers: adminHeaders(c),
      });
      assert.equal(bad2.statusCode, 422);
    });

    it('DELETE /system/logs/:filename removes a past file, 404 unknown, 422 malformed', async () => {
      const c = await buildApp();
      fs.mkdirSync(c.logsDir, { recursive: true });
      const past = path.join(c.logsDir, 'server-2020-01-01.log');
      fs.writeFileSync(past, 'old');
      const ok = await c.app.inject({
        method: 'DELETE',
        url: '/api/v1/system/logs/server-2020-01-01.log',
        headers: adminHeaders(c),
      });
      assert.equal(ok.statusCode, 204);
      assert.equal(fs.existsSync(past), false);
      const missing = await c.app.inject({
        method: 'DELETE',
        url: '/api/v1/system/logs/server-2020-01-02.log',
        headers: adminHeaders(c),
      });
      assert.equal(missing.statusCode, 404);
      const bad = await c.app.inject({
        method: 'DELETE',
        url: '/api/v1/system/logs/..%2Flogs2',
        headers: adminHeaders(c),
      });
      assert.equal(bad.statusCode, 422);
    });

    it('DELETE of the current daily file truncates it instead of unlinking', async () => {
      const c = await buildApp();
      await c.app.inject({
        method: 'PUT',
        url: '/api/v1/system/logging',
        headers: adminHeaders(c),
        payload: { enabled: true },
      });
      const name = todayName();
      const file = path.join(c.logsDir, name);
      assert.equal(fs.existsSync(file), true, 'journal exists after enabling');
      const res = await c.app.inject({
        method: 'DELETE',
        url: `/api/v1/system/logs/${name}`,
        headers: adminHeaders(c),
      });
      assert.equal(res.statusCode, 204);
      assert.equal(fs.existsSync(file), true, 'current file survives deletion');
      const after = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(after, /file logging enabled/, 'old contents truncated');
      assert.match(after, /log file removed/, 'deletion is journaled');
    });

    it('DELETE /system/logs wipes everything, truncating the current file', async () => {
      const c = await buildApp();
      fs.mkdirSync(c.logsDir, { recursive: true });
      fs.writeFileSync(path.join(c.logsDir, 'server-2020-01-01.log'), 'a');
      fs.writeFileSync(path.join(c.logsDir, 'server-2020-01-02.log'), 'b');
      const res = await c.app.inject({
        method: 'DELETE',
        url: '/api/v1/system/logs',
        headers: adminHeaders(c),
      });
      assert.equal(res.statusCode, 204);
      assert.equal(fs.existsSync(path.join(c.logsDir, 'server-2020-01-01.log')), false);
      assert.equal(fs.existsSync(path.join(c.logsDir, 'server-2020-01-02.log')), false);
      const status = await c.app.inject({
        method: 'GET',
        url: '/api/v1/system/logging',
        headers: adminHeaders(c),
      });
      const files = status.json().data.files as Array<{ name: string }>;
      assert.deepEqual(files.map((f) => f.name), [todayName()], 'only the truncated current file');
    });
  },
);
