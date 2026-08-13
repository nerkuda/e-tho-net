/**
 * MCP stdio transport — local agent entry point (task F1,
 * docs/05-mcp-server.md §2).
 *
 * Runs the MCP server over stdin/stdout for agents launched on the server
 * host (`etn mcp` CLI command). The API key comes from `ETN_API_KEY` or the
 * `--api-key` argument (F2); it is resolved exactly once at startup, and a
 * missing/unknown/disabled key aborts with a clear error.
 *
 * The process stays alive as long as stdin is open (the transport keeps the
 * event loop busy); it is closed when the client disconnects or the process
 * receives SIGINT/SIGTERM.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pino from 'pino';

import { SystemDb } from '../db/system-db.js';
import type { Logger } from '../logger.js';
import { PubSub } from '../realtime/pubsub.js';
import { createApiKeyAuthProvider } from './auth.js';
import { createMcpServer } from './index.js';
import type { McpDeps } from './types.js';

/** Options accepted by {@link runStdioMcp}. */
export interface StdioMcpOptions {
  /** Absolute ETN data directory (`ETN_DATA_DIR`). */
  dataDir: string;
  /** Full API key (`ETN_API_KEY` or `--api-key`); `null` aborts. */
  apiKey: string | null;
  /** Optional logger (defaults to a pino instance writing to **stderr**). */
  logger?: Logger;
}

/**
 * Open `_system.db`, authenticate the key, and serve MCP over stdio.
 *
 * The default logger writes to **stderr** on purpose: stdout carries the MCP
 * protocol frames and must stay clean (pino's own default is stdout).
 *
 * @throws when the key is missing/invalid — the CLI surfaces it and exits 1.
 */
export async function runStdioMcp(opts: StdioMcpOptions): Promise<void> {
  const log =
    opts.logger ??
    pino(
      { level: process.env.ETN_LOG_LEVEL?.trim() || 'info' },
      pino.destination(2), // fd 2 = stderr
    );
  if (opts.apiKey === null || opts.apiKey === '') {
    throw new Error(
      'Для stdio-режима MCP нужен API-key: задайте ETN_API_KEY или передайте --api-key.',
    );
  }

  const systemDb = SystemDb.open(opts.dataDir, log);
  try {
    const authProvider = createApiKeyAuthProvider(systemDb);
    const auth = authProvider(opts.apiKey);
    if (auth === null) {
      throw new Error('Невалидный или отключённый API-key (проверьте ETN_API_KEY / --api-key).');
    }

    const deps: McpDeps = {
      systemDb,
      dataDir: opts.dataDir,
      pubsub: new PubSub(),
      authProvider,
      auth,
      logger: log,
    };
    const mcp = createMcpServer(deps);
    const transport = new StdioServerTransport();
    transport.onerror = (err: Error) => {
      log.error({ err }, 'mcp stdio: transport error');
    };
    // Resolves when the transport closes (client disconnect / stream error) —
    // keeps the CLI process alive for the whole MCP session.
    const finished = new Promise<void>((resolve) => {
      transport.onclose = () => resolve();
    });
    await mcp.connect(transport);
    log.info({ user: auth.username, keyPrefix: auth.keyPrefix }, 'mcp stdio: server ready');
    await finished;
    await mcp.close().catch(() => undefined);
    systemDb.close();
    log.info('mcp stdio: session closed');
  } catch (err) {
    systemDb.close();
    throw err;
  }
}
