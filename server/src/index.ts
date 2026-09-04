/**
 * ETN server entry point (task B7).
 *
 * Reads configuration from the environment, opens `_system.db`, refuses to
 * start when the server has not been initialised (no first admin exists — see
 * docs/06-auth.md §8), builds the Fastify instance and binds it to
 * `ETN_HOST:ETN_PORT`. Handles graceful shutdown on SIGINT/SIGTERM.
 */

import { fileURLToPath } from 'node:url';
import http from 'node:http';

import { ConfigError, loadConfig } from './config.js';
import { SystemDb } from './db/system-db.js';
import { sweepCommentHtml } from './domain/markdown-sweep.js';
import { createServer } from './http/server.js';
import { logger } from './logger.js';
import { handleMcpNodeRequest } from './mcp/http.js';
import { SERVER_VERSION } from './version.js';

/** Run the server against `env`/`argv`. Exported for tests. */
export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    const msg = err instanceof ConfigError ? err.message : (err as Error).message;
    logger.fatal({ err }, `Configuration error: ${msg}`);
    throw err;
  }

  logger.info(
    { dataDir: config.dataDir, host: config.host, port: config.port, tls: config.tls !== null },
    'Starting ETN server',
  );

  const systemDb = SystemDb.open(config.dataDir, logger);

  if (!systemDb.hasFirstUser()) {
    systemDb.close();
    const msg =
      'Server is not initialised: no first administrator exists. ' +
      'Run `etn init --username <login> [--display-name "<name>"]` first (docs/06-auth.md §8).';
    logger.fatal(msg);
    throw new Error(msg);
  }

  // Re-render the cached comment HTML once when the rendering pipeline version
  // changed (task M1, @etn/markdown).
  sweepCommentHtml(config.dataDir, systemDb, logger);

  const app = await createServer({ config, systemDb, logger });
  const fileLog = app.fileLog;

  await app.listen({ host: config.host, port: config.port });
  logger.info(
    `ETN server listening on ${config.tls !== null ? 'https' : 'http'}://${config.host}:${config.port}`,
  );
  // File journal: startup entry (INFO — only lands while logging is enabled,
  // task 1dd33e23 §3). Config fields are secret-free by design (TLS paths,
  // not contents; no keys are ever logged).
  fileLog.info('server', 'ETN server started', {
    version: SERVER_VERSION,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    host: config.host,
    port: config.port,
    tls: config.tls !== null,
    mcp_enabled: config.mcp.enabled,
    log_level: config.logLevel,
    data_dir: config.dataDir,
  });

  // Dedicated MCP listener (05-mcp-server.md §2): when ETN_MCP_ENABLED=1 and
  // ETN_MCP_PORT is set, /mcp is additionally served on its own port so agent
  // traffic stays isolated from the REST API.
  const mcpListener: http.Server | null =
    config.mcp.enabled && config.mcp.port !== null
      ? http.createServer((req, res) => {
          void handleMcpNodeRequest(app.mcpHttp, req, res).catch((err: unknown) => {
            logger.error({ err }, 'mcp: dedicated listener failed');
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json' });
            }
            res.end(
              JSON.stringify({ error: { code: 'INTERNAL', message: 'MCP endpoint failure' } }),
            );
          });
        })
      : null;
  if (mcpListener !== null) {
    mcpListener.listen(config.mcp.port as number, config.host, () => {
      logger.info(`ETN MCP endpoint listening on http://${config.host}:${config.mcp.port}/mcp`);
    });
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down ETN server');
    fileLog.info('server', 'ETN server shutting down', { signal });
    if (mcpListener !== null) {
      await new Promise<void>((resolve) => mcpListener.close(() => resolve()));
    }
    await app.close();
    systemDb.close();
    logger.info('ETN server stopped');
    fileLog.info('server', 'ETN server stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Run when invoked directly as the process entry point.
const invokedScript = process.argv[1];
const thisFile = fileURLToPath(import.meta.url);
if (invokedScript === thisFile) {
  startServer().catch((err) => {
    logger.fatal({ err }, err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
