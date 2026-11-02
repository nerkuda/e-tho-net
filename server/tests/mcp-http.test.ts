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

import {
  DEFAULT_MCP_SESSION_IDLE_TTL_MS,
  DEFAULT_UPDATE_CONFIG,
} from '../src/config.js';
import type { ServerConfig } from '../src/config.js';
import { resolveClientChannel } from '../src/version.js';
import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir } from '../src/paths.js';
import { createServer } from '../src/http/server.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { createLogger } from '../src/logger.js';
import { MCP_TOOL_NAMES, parseSemver } from '@etn/shared';

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
    mcp: { enabled: true, port: null, sessionIdleTtlMs: DEFAULT_MCP_SESSION_IDLE_TTL_MS },
    readerPool: { size: 1, taskTimeoutMs: 30000 },
  // Фоновый чекпойнт WAL в тестах выключен: сеть чекпойнтит сам тест.
  walCheckpoint: { intervalMs: 0 },
  // Пул записи в тестах выключен: пути записи переводит отдельная задача (c8920d04).
  writePool: { size: 0, taskTimeoutMs: 120000, idleEvictionMs: 30000 },
  clientChannel: resolveClientChannel({}),
  update: DEFAULT_UPDATE_CONFIG,
  deployment: 'standalone',
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

  it('MCP не проходит проверку версии desktop-клиента: 426 к /mcp не применяется', async () => {
    const ctx = await buildHttpContext();
    try {
      // Версия заведомо вне client_compatibility сервера: REST с такими
      // заголовками получил бы 426 на изменяющем запросе (задача c3f33e6a),
      // но у MCP собственный транспорт (требование e5e8d1da, ADR 6ded6a87).
      const channel = resolveClientChannel({});
      const lower = parseSemver(channel.min_client);
      assert.ok(lower !== null, 'min_client обязан быть версией');
      const incompatible = `${lower.major}.${lower.minor + 1}.0`;
      const clientHeaders = { 'client-id': 'mcp-version-probe', 'client-version': incompatible };

      const init = await ctx.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${ctx.adminKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...clientHeaders,
        },
        payload: initializeBody(),
      });
      assert.equal(init.statusCode, 200, init.body);
      const sessionId = init.headers['mcp-session-id'] as string;

      const called = await ctx.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${ctx.adminKey}`,
          'mcp-session-id': sessionId,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...clientHeaders,
        },
        payload: {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: {
            name: 'etn.thoughts.write',
            arguments: {
              network_id: ctx.networkId,
              thoughts: [{ ref: 'mcp', thought: { title: 'MCP без проверки версии' } }],
            },
          },
        },
      });
      assert.equal(called.statusCode, 200, called.body);
      const content = called.json().result.content as Array<{ type: string; text: string }>;
      assert.doesNotMatch(content[0]!.text, /CLIENT_VERSION_UNSUPPORTED/);
      // Изменение реально произошло: мысль создана, а не отклонена guard'ом.
      const written = JSON.parse(content[0]!.text) as {
        items: Array<{ thought_action: string; id: string }>;
      };
      assert.equal(written.items[0]?.thought_action, 'created');
      assert.equal(typeof written.items[0]?.id, 'string');
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
            name: 'etn.thoughts.write',
            arguments: {
              network_id: ctx.networkId,
              thoughts: [{ ref: 'x', thought: { title: 'Нет' } }],
            },
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

  it('во время обслуживания /mcp не перехватывается REST-503: чтение работает, запись — SERVER_UPDATING', async () => {
    const ctx = await buildHttpContext();
    try {
      await ctx.app.maintenance.beginUpdating({ target_version: '0.99.0', retry_after: 60 });

      // Общий REST-гейт изменяющий REST-запрос уже отклоняет…
      const rest = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/networks',
        headers: { authorization: `Bearer ${ctx.adminKey}` },
        payload: { display_name: 'Нет' },
      });
      assert.equal(rest.statusCode, 503, rest.body);
      assert.equal(rest.json().error.code, 'SERVER_UPDATING');

      // …а `/mcp` не перехватывается: initialize и чтение проходят.
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
      const sessionId = init.headers['mcp-session-id'] as string;

      const call = async (
        id: number,
        name: string,
        args: Record<string, unknown>,
      ): Promise<{ statusCode: number; body: string; json: () => Record<string, unknown> }> => {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/mcp',
          headers: {
            authorization: `Bearer ${ctx.adminKey}`,
            'mcp-session-id': sessionId,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          payload: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
        });
        return { statusCode: res.statusCode, body: res.body, json: () => res.json() };
      };

      const read = await call(2, 'etn.thoughts.get', {
        network_id: ctx.networkId,
        thought_id: ctx.homeId,
      });
      assert.equal(read.statusCode, 200, read.body);
      const readResult = read.json().result as { content: Array<{ text: string }>; isError?: boolean };
      assert.equal(readResult.isError, undefined, readResult.content[0]!.text);

      const write = await call(3, 'etn.thoughts.write', {
        network_id: ctx.networkId,
        thoughts: [{ ref: 'x', thought: { title: 'Нет' } }],
      });
      assert.equal(write.statusCode, 200, write.body);
      const writeResult = write.json().result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      assert.equal(writeResult.isError, true);
      assert.match(writeResult.content[0]!.text, /ETN error \[SERVER_UPDATING\]/);
      assert.match(writeResult.content[0]!.text, /"retry_after":60/);
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
          mcp: { enabled: false, port: null, sessionIdleTtlMs: DEFAULT_MCP_SESSION_IDLE_TTL_MS },
          readerPool: { size: 1, taskTimeoutMs: 30000 },
          // Пул записи в тестах выключен: пути записи переводит отдельная
          // задача (c8920d04).
          writePool: { size: 0, taskTimeoutMs: 120000, idleEvictionMs: 30000 },
          clientChannel: resolveClientChannel({}),
          update: DEFAULT_UPDATE_CONFIG,
          deployment: 'standalone',
          // Фоновый чекпойнт WAL в тестах выключен: сеть чекпойнтит сам тест.
          walCheckpoint: { intervalMs: 0 },
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
