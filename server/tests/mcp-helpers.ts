/**
 * Shared helpers for MCP phase-F tests.
 *
 * Builds an in-memory `_system.db` (with migrations, so the seeded L1 settings
 * exist), an admin user with a primary and a read-only API-key, a real network
 * on a temp data directory (created through the same NetworkService the REST
 * tests use, so `data.db` with the HOME thought exists on disk), and a PubSub
 * broker. {@link connectMcpClient} links an SDK `Client` to an MCP server built
 * through the production factory {@link createMcpServer} over the in-process
 * transport pair.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { SystemDb } from '../src/db/system-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { systemMigrationsDir } from '../src/paths.js';
import { closeNetworkDb, openNetworkDb } from '../src/db/network-db.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { NetworkServiceImpl } from '../src/domain/network-service.js';
import { createLogger } from '../src/logger.js';
import { createApiKeyAuthProvider } from '../src/mcp/auth.js';
import { createMcpServer } from '../src/mcp/index.js';
import { PubSub } from '../src/realtime/pubsub.js';

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

/** Fresh MCP test world: system DB, network, keys, broker. */
export interface McpTestContext {
  sys: SystemDb;
  /** Raw SQLite handle of `_system.db` (for direct settings manipulation). */
  rawDb: Database.Database;
  dataDir: string;
  pubsub: PubSub;
  adminId: string;
  adminKey: string;
  readOnlyKey: string;
  networkId: string;
  homeId: string;
}

/** Optional overrides for {@link buildMcpContext} — useful when pairing an
 * MCP server with a fixture built by the REST helpers (задача 6bcccd2b:
 * паритет `etn.activity.rollup` / `etn.activity.truncate` между REST и MCP).
 * All fields default to «свежий изолированный мир». */
export interface McpContextOverrides {
  /** Existing data directory (e.g. the temp dir of a REST context). */
  dataDir?: string;
  /** Existing network id — used together with `dataDir` to skip the fresh
   * network creation. Admin/API-key must already exist in the existing
   * `systemDb` (passed alongside). */
  networkId?: string;
  /** Existing system DB (must contain the admin user + a primary API-key). */
  systemDb?: SystemDb;
}

/** Build a fresh MCP test world, optionally reusing an existing data dir /
 * system DB / network from a parallel REST context. */
export async function buildMcpContext(overrides: McpContextOverrides = {}): Promise<McpTestContext> {
  const dataDir = overrides.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'etn-mcp-'));

  // Reuse the REST fixture's system DB when provided — both contexts already
  // agree on the admin/api-key rows and the network membership. We hold a
  // typed alias for the private `db` field without poking it directly from
  // the outside (callers go through the helper).
  let sys: SystemDb;
  let rawDb: Database.Database;
  let adminId: string;
  let adminKey: string;
  let readOnlyKey: string;

  if (overrides.systemDb !== undefined) {
    sys = overrides.systemDb;
    rawDb = (sys as unknown as { db: Database.Database }).db;
    // The REST fixture's admin is the only user; expose its primary key by
    // walking the API-key table.
    const adminRow = rawDb
      .prepare(`SELECT user_id FROM api_keys WHERE label = 'primary' LIMIT 1`)
      .get() as { user_id: string } | undefined;
    adminId = adminRow?.user_id ?? '';
    adminKey = '';
    readOnlyKey = '';
  } else {
    rawDb = new DatabaseConstructor(':memory:');
    rawDb.pragma('foreign_keys = ON');
    runMigrations(rawDb, systemMigrationsDir());
    sys = new SystemDb(rawDb);

    adminId = randomUUID();
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
      label: 'mcp-test',
      keyHash: hashApiKey(gen.key),
      keyPrefix: gen.keyPrefix,
    });
    const ro = generateApiKey();
    sys.createApiKey({
      id: randomUUID(),
      userId: adminId,
      label: 'mcp-test-ro',
      keyHash: hashApiKey(ro.key),
      keyPrefix: ro.keyPrefix,
      readOnly: true,
    });
    adminKey = gen.key;
    readOnlyKey = ro.key;
  }

  const pubsub = new PubSub();

  let networkId: string;
  let homeId: string;
  if (overrides.networkId !== undefined) {
    networkId = overrides.networkId;
    const ndb = openNetworkDb(dataDir, networkId);
    const home = ndb.prepare('SELECT id FROM thoughts WHERE is_root = 1 LIMIT 1').get() as
      | { id: string }
      | undefined;
    homeId = home?.id ?? '';
  } else {
    const network = await new NetworkServiceImpl(sys, dataDir, createLogger('silent')).createNetwork(
      adminId,
      'Test Net',
    );
    networkId = network.id;
    const ndb = openNetworkDb(dataDir, network.id);
    const home = ndb.prepare('SELECT id FROM thoughts WHERE is_root = 1 LIMIT 1').get() as {
      id: string;
    };
    homeId = home.id;
  }

  return {
    sys,
    rawDb,
    dataDir,
    pubsub,
    adminId,
    adminKey,
    readOnlyKey,
    networkId,
    homeId,
  };
}

/** Tear down: close the network DB first, then the system DB, then the dir.
 *  When the context was built with `systemDb` / `dataDir` overrides (REST
 *  fixture shared with the MCP layer), the system DB and data directory
 *  belong to the caller — skip closing them so a parallel `closeRestContext`
 *  can run cleanly. */
export async function closeMcpContext(
  ctx: McpTestContext,
  overrides: McpContextOverrides = {},
): Promise<void> {
  closeNetworkDb(ctx.networkId);
  if (overrides.systemDb === undefined) ctx.sys.close();
  if (overrides.dataDir === undefined) fs.rmSync(ctx.dataDir, { recursive: true, force: true });
}

/** An SDK client connected to a production-built MCP server for `key`. */
export interface McpClientHandle {
  client: Client;
  close(): Promise<void>;
}

/**
 * Build the MCP server through {@link createMcpServer} for the given key and
 * connect an SDK client over a linked in-memory transport pair.
 */
export async function connectMcpClient(ctx: McpTestContext, key: string): Promise<McpClientHandle> {
  const authProvider = createApiKeyAuthProvider(ctx.sys);
  const auth = authProvider(key);
  assert.notEqual(auth, null, 'test key must resolve');
  const mcp = createMcpServer({
    systemDb: ctx.sys,
    dataDir: ctx.dataDir,
    pubsub: ctx.pubsub,
    authProvider,
    auth: auth!,
    logger: createLogger('silent'),
    networkService: new NetworkServiceImpl(ctx.sys, ctx.dataDir, createLogger('silent')),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'etn-test-client', version: '0.0.1' });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await mcp.close();
    },
  };
}

/** The (non-task) tool-result shape returned by `Client.callTool`. */
export type ClientCallToolResult = Awaited<ReturnType<Client['callTool']>>;

/**
 * Вызвать редкую операцию через `etn.ops` (0.8.3, задача 86ef2ff4): `params` —
 * плоский объект, `confirm` — для деструктивных. Фикстуры тестов снятых
 * инструментов переведены на этот путь.
 */
export async function callOp(
  client: Client,
  action: string,
  params: Record<string, unknown> = {},
  confirm = false,
): Promise<ClientCallToolResult> {
  return client.callTool({
    name: 'etn.ops',
    arguments: { action, params, ...(confirm ? { confirm: true } : {}) },
  });
}

/** Extract the text of a tool result's first content block. */
export function toolText(result: ClientCallToolResult): string {
  if (!('content' in result)) {
    throw new Error('task-based tool result — not used in these tests');
  }
  const block = (result.content as Array<{ type?: string; text?: string }>)[0];
  assert.ok(block !== undefined && block.type === 'text', 'expected a text content block');
  assert.equal(typeof block.text, 'string');
  return block.text as string;
}

/** Parse a tool result's JSON payload. */
export function toolJson<T = unknown>(result: ClientCallToolResult): T {
  return JSON.parse(toolText(result)) as T;
}

// ---------------------------------------------------------------------------
// Миграция тестов с удалённых инструментов (веха 9, задача 937480ca)
// ---------------------------------------------------------------------------
// `etn.thoughts.create`/`update`/`set_active`/`upsert_bundle`,
// `etn.properties.set`, `etn.comments.upsert` удалены в 0.8.2 — их
// единственная замена `etn.thoughts.write`. Фикстуры тестов переведены на
// батч через эти обёртки; форма результатов совпадает со старыми
// инструментами там, где тесты на неё опирались.

/** Один элемент батча `etn.thoughts.write` (тестовое подмножество). */
export interface WriteThoughtFixture {
  ref?: string;
  thought_id?: string;
  /** Item-level правка существующей мысли (`thought_id`), взаимоисключима с `thought`. */
  title?: string;
  synonyms?: string[];
  type?: string;
  type_id?: string | null;
  active?: boolean;
  thought?: {
    title: string;
    synonyms?: string[];
    type_id?: string | null;
    type?: string;
    active?: boolean;
  };
  on_duplicate?: 'fail' | 'reuse' | 'update';
  comment?: { title?: string | null; body_md: string; valid_from?: string; valid_to?: string | null };
  chronicle?: Array<{
    title?: string | null;
    /** Необязателен (требование 26f0aa52): запись создаётся и по заголовку. */
    body_md?: string;
    valid_from?: string;
    valid_to?: string | null;
    /** Флаг «учитывать время» (0.10.1). */
    use_time?: boolean;
  }>;
  properties?: Record<string, unknown>;
  links?: Array<{
    direction: 'parent' | 'child';
    target_id?: string;
    target_ref?: string;
    type_id?: string | null;
    type?: string;
  }>;
  attachments?: Array<{
    kind: string;
    url?: string | null;
    file_path?: string | null;
    /** Данные файла (задача 75c75a2f): `mime_type` + `data_base64`. */
    mime_type?: string | null;
    data_base64?: string | null;
    title?: string | null;
    description?: string | null;
  }>;
}

/** Один элемент результата `etn.thoughts.write`. */
export interface WriteItemResult {
  id: string;
  version: number;
  thought_action: 'created' | 'updated' | 'reused';
  matched_on: string | null;
  warnings: unknown[];
  comment?: { id: string; version: number; action: 'created' | 'updated' };
  chronicle?: Array<{ id: string; version: number }>;
  properties?: Record<string, { id: string }>;
  links?: Array<{ id: string; version: number }>;
  attachments?: Array<{ id: string }>;
}

/** Результат `etn.thoughts.write`. */
export interface WriteToolResult {
  items: WriteItemResult[];
  warnings: unknown[];
  layer: { id: string; title: string };
  request_id?: string;
}

/** Вызвать `etn.thoughts.write` и распарсить результат. */
export async function callWrite(
  client: Client,
  networkId: string,
  thoughts: WriteThoughtFixture[],
): Promise<WriteToolResult> {
  const result = await client.callTool({
    name: 'etn.thoughts.write',
    arguments: { network_id: networkId, thoughts },
  });
  assert.equal(result.isError, undefined, toolText(result));
  return toolJson<WriteToolResult>(result);
}

/** Замена удалённого `etn.thoughts.create`: одна мысль через батч. */
export async function createThoughtViaWrite(
  client: Client,
  networkId: string,
  args: {
    title: string;
    synonyms?: string[];
    type_id?: string | null;
    type?: string;
    active?: boolean;
    link?: { direction: 'parent' | 'child'; target_thought_id: string; type_id?: string | null; type?: string };
    properties?: Record<string, unknown>;
    comment?: { body_md: string };
  },
): Promise<{ id: string; version: number }> {
  const result = await callWrite(client, networkId, [
    {
      ref: 'created',
      thought: {
        title: args.title,
        ...(args.synonyms === undefined ? {} : { synonyms: args.synonyms }),
        ...(args.type_id === undefined ? {} : { type_id: args.type_id }),
        ...(args.type === undefined ? {} : { type: args.type }),
        ...(args.active === undefined ? {} : { active: args.active }),
      },
      ...(args.comment === undefined ? {} : { comment: { body_md: args.comment.body_md } }),
      ...(args.properties === undefined ? {} : { properties: args.properties }),
      ...(args.link === undefined
        ? {}
        : {
            links: [
              {
                direction: args.link.direction,
                target_id: args.link.target_thought_id,
                ...(args.link.type_id === undefined ? {} : { type_id: args.link.type_id }),
                ...(args.link.type === undefined ? {} : { type: args.link.type }),
              },
            ],
          }),
    },
  ]);
  return { id: result.items[0]!.id, version: result.items[0]!.version };
}

/** Замена удалённого `etn.properties.set`: свойства через батч. */
export async function setPropertiesViaWrite(
  client: Client,
  networkId: string,
  ownerId: string,
  properties: Record<string, unknown>,
): Promise<{ id: string; version: number }> {
  const result = await callWrite(client, networkId, [
    { thought_id: ownerId, properties },
  ]);
  return { id: result.items[0]!.id, version: result.items[0]!.version };
}

/** Замена удалённого `etn.comments.upsert`: постоянный комментарий через батч. */
export async function upsertPermanentViaWrite(
  client: Client,
  networkId: string,
  ownerId: string,
  bodyMd: string,
): Promise<{ id: string; version: number; action: 'created' | 'updated' }> {
  const result = await callWrite(client, networkId, [
    { thought_id: ownerId, comment: { body_md: bodyMd } },
  ]);
  const comment = result.items[0]!.comment!;
  return { id: comment.id, version: comment.version, action: comment.action };
}

/** Замена удалённого `etn.comments.upsert` (kind=chronological): хроника через батч. */
export async function addChronicleViaWrite(
  client: Client,
  networkId: string,
  ownerId: string,
  bodyMd: string,
  validFrom?: string,
): Promise<{ id: string; version: number }> {
  const result = await callWrite(client, networkId, [
    {
      thought_id: ownerId,
      chronicle: [{ body_md: bodyMd, ...(validFrom === undefined ? {} : { valid_from: validFrom }) }],
    },
  ]);
  const entry = result.items[0]!.chronicle![0]!;
  return { id: entry.id, version: entry.version };
}
