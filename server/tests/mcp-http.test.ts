/**
 * MCP StreamableHTTP endpoint tests (F1 DoD, F2 auth).
 *
 * Builds the real Fastify server with `ETN_MCP_ENABLED=1` semantics
 * (`config.mcp.enabled`), then drives the MCP handshake over `app.inject`:
 * initialize → session id → tools/list → callTool. Auth failures (missing,
 * invalid, read-only keys) and session protocol violations are checked.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

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
import { MCP_TOOL_NAMES } from '@etn/shared';

import { nativeAvailable } from './mcp-helpers.js';

/** JSON-RPC initialize request body (protocol version of the current SDK era). */
function initializeBody(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'etn-http-test', version: '0.0.1' },
    },
  };
}

/** A running app with MCP enabled and one admin key. */
async function buildHttpContext(): Promise<{
  app: FastifyInstance;
  sys: SystemDb;
  dataDir: string;
  adminKey: string;
  readOnlyKey: string;
  networkId: string;
  homeId: string;
}> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-mcp-http-'));
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
  const key = generateApiKey();
  sys.createApiKey({
    id: randomUUID(),
    userId: adminId,
    label: 'http',
    keyHash: hashApiKey(key.key),
    keyPrefix: key.keyPrefix,
  });
  const ro = generateApiKey();
  sys.createApiKey({
    id: randomUUID(),
    userId: adminId,
    label: 'http-ro',
    keyHash: hashApiKey(ro.key),
    keyPrefix: ro.keyPrefix,
    readOnly: true,
  });

  const config: ServerConfig = {
    dataDir,
    host: '127.0.0.1',
    port: 0,
    tls: null,
    logLevel: 'silent',
    mcp: { enabled: true, port: null },
  };
  const app = await createServer({ config, systemDb: sys, logger: createLogger('silent') });

  // Create a real network so tool calls have something to touch.
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/networks',
    headers: { authorization: `Bearer ${key.key}` },
    payload: { display_name: 'Net' },
  });
  assert.equal(created.statusCode, 201);
  const networkId = (created.json().data as { id: string }).id;
  const { openNetworkDb } = await import('../src/db/network-db.js');
  const ndb = openNetworkDb(dataDir, networkId);
  const home = ndb.prepare('SELECT id FROM thoughts WHERE is_root = 1 LIMIT 1').get() as {
    id: string;
  };

  return { app, sys, dataDir, adminKey: key.key, readOnlyKey: ro.key, networkId, homeId: home.id };
}

async function closeHttpContext(ctx: Awaited<ReturnType<typeof buildHttpContext>>): Promise<void> {
  await ctx.app.close();
  const { closeNetworkDb } = await import('../src/db/network-db.js');
  closeNetworkDb(ctx.networkId);
  ctx.sys.close();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
}

describe('MCP HTTP endpoint (F1/F2)', { skip: !nativeAvailable() }, () => {
  it('initialize creates a session; tools/list returns the catalogue', async () => {
    const ctx = await buildHttpContext();
    try {
      const init = await ctx.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${ctx.adminKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: initializeBody(),
      });
      assert.equal(init.statusCode, 200, init.body);
      const sessionId = init.headers['mcp-session-id'];
      assert.ok(typeof sessionId === 'string' && sessionId !== '', 'expected Mcp-Session-Id');

      const listed = await ctx.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${ctx.adminKey}`,
          'mcp-session-id': sessionId as string,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      });
      assert.equal(listed.statusCode, 200, listed.body);
      const names = (listed.json().result.tools as Array<{ name: string }>)
        .map((t) => t.name)
        .sort();
      assert.deepEqual(names, [...MCP_TOOL_NAMES].sort());

      // A tool call in the same session works.
      const called = await ctx.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${ctx.adminKey}`,
          'mcp-session-id': sessionId as string,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'etn.thoughts.get',
            arguments: { network_id: ctx.networkId, thought_id: ctx.homeId },
          },
        },
      });
      assert.equal(called.statusCode, 200, called.body);
      const content = called.json().result.content as Array<{ type: string; text: string }>;
      assert.ok(content.length > 0);
      const thought = JSON.parse(content[0]!.text) as { title: string };
      assert.equal(thought.title, 'HOME');
    } finally {
      await closeHttpContext(ctx);
    }
  });

  it('rejects missing or invalid keys with 401', async () => {
    const ctx = await buildHttpContext();
    try {
      const missing = await ctx.app.inject({
        method: 'POST',
        url: '/mcp',
        payload: initializeBody(),
      });
      assert.equal(missing.statusCode, 401);
      assert.equal(missing.json().error.code, 'UNAUTHORIZED');

      const bogus = await ctx.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: 'Bearer etn_deadbeef000000000000000000000000',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: initializeBody(),
      });
      assert.equal(bogus.statusCode, 401);
    } finally {
      await closeHttpContext(ctx);
    }
  });

  it('enforces session protocol: no session id, unknown session, GET without stream', async () => {
    const ctx = await buildHttpContext();
    try {
      const noSession = await ctx.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${ctx.adminKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      });
      assert.equal(noSession.statusCode, 400);

      const bogusSession = await ctx.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${ctx.adminKey}`,
          'mcp-session-id': '00000000-0000-0000-0000-000000000000',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      });
      assert.equal(bogusSession.statusCode, 404);
    } finally {
      await closeHttpContext(ctx);
    }
  });

  it('read-only key authenticates but mutating tools are rejected (F2)', async () => {
    const ctx = await buildHttpContext();
    try {
      const init = await ctx.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${ctx.readOnlyKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: initializeBody(),
      });
      assert.equal(init.statusCode, 200);
      const sessionId = init.headers['mcp-session-id'] as string;

      const called = await ctx.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${ctx.readOnlyKey}`,
          'mcp-session-id': sessionId,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'etn.thoughts.create',
            arguments: { network_id: ctx.networkId, title: 'Нет' },
          },
        },
      });
      assert.equal(called.statusCode, 200);
      const content = called.json().result.content as Array<{ type: string; text: string }>;
      assert.match(content[0]!.text, /read-only/);
    } finally {
      await closeHttpContext(ctx);
    }
  });

  it('MCP endpoint is absent when disabled (default config)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etn-mcp-off-'));
    const db: Database.Database = new DatabaseConstructor(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, systemMigrationsDir());
    const sys = new SystemDb(db);
    sys.createUser({
      id: randomUUID(),
      username: 'admin',
      displayName: null,
      isAdmin: true,
      isFirstUser: true,
    });
    try {
      const app = await createServer({
        config: {
          dataDir,
          host: '127.0.0.1',
          port: 0,
          tls: null,
          logLevel: 'silent',
          mcp: { enabled: false, port: null },
        },
        systemDb: sys,
        logger: createLogger('silent'),
      });
      const probe = await app.inject({ method: 'POST', url: '/mcp', payload: initializeBody() });
      assert.equal(probe.statusCode, 404);
      await app.close();
    } finally {
      sys.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
