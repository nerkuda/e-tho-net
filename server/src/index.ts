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
import { closeReaderPool, configureReaderPool } from './db/reader-pool.js';
import {
  checkpointAndCloseAllNetworkDbs,
  startWalCheckpointScheduler,
  type WalCheckpointScheduler,
} from './db/wal-checkpoint.js';
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

  // Пул reader-воркеров тяжёлых чтений (ADR bec191e6): процессный ресурс,
  // настраивается на старте. Тяжёлые выборки уходят в воркеры, чтобы
  // синхронный better-sqlite3 не блокировал цикл событий; писатель остаётся
  // единственным — в главном потоке. Воркеры поднимаются лениво.
  configureReaderPool({
    size: config.readerPool.size,
    taskTimeoutMs: config.readerPool.taskTimeoutMs,
    logger,
  });

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

  // Фоновый чекпойнт WAL сетей (ошибка dac92886): авто-чекпойнт SQLite —
  // PASSIVE и не продвигается, пока читатель держит снапшот, а `-wal` не
  // усекается вовсе. Таймер `unref()`-нут и работает между запросами
  // (better-sqlite3 синхронный), интервал — `ETN_WAL_CHECKPOINT_INTERVAL_MS`.
  const walCheckpoint: WalCheckpointScheduler | null =
    config.walCheckpoint.intervalMs > 0
      ? startWalCheckpointScheduler({ intervalMs: config.walCheckpoint.intervalMs, logger })
      : null;
  if (walCheckpoint === null) {
    logger.info('WAL background checkpoint disabled (ETN_WAL_CHECKPOINT_INTERVAL_MS=0)');
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down ETN server');
    fileLog.info('server', 'ETN server shutting down', { signal });
    walCheckpoint?.stop();
    if (mcpListener !== null) {
      await new Promise<void>((resolve) => mcpListener.close(() => resolve()));
    }
    await app.close();
    // Читатели закрываются ДО чекпойнта: их снапшоты мешали бы усечь журнал.
    await closeReaderPool();
    // Чекпойнт всех БД и закрытие соединений сетей (ошибка dac92886): иначе
    // `-wal` остаётся «высокой водой», а `process.exit` не даёт SQLite
    // выполнить собственный чекпойнт при закрытии последнего соединения.
    checkpointAndCloseAllNetworkDbs({ logger });
    systemDb.checkpointWal();
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
