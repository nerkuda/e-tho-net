/**
 * Fastify server factory, plugins and system routes (task B7,
 * 03-server-api.md §1, §2, §16).
 *
 * {@link createServer} wires the shared dependencies (`systemDb`, `logger`,
 * `config`) onto a fresh Fastify instance, registers CORS and the WebSocket
 * plugin (routes added later in phase E), installs a single error handler that
 * emits the canonical `{ error: { code, message, details?, request_id? } }`
 * body, and exposes `/health` and `/version`. The instance is returned without
 * being started so callers (and tests) can register additional routes first.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import corsPlugin from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';

import type { ServerConfig } from '../config.js';
import type { SystemDb } from '../db/system-db.js';
import type { Logger } from '../logger.js';
import { createAuthPreHandler, ensureAuthDecorator } from '../auth/auth-middleware.js';
import { AuthRateLimiter } from '../auth/rate-limiter.js';
import { createAccessControl } from '../auth/access-control.js';
import { NetworkMembersService } from '../domain/network-members-service.js';
import { PubSub } from '../realtime/pubsub.js';
import { createIdempotencyMiddleware, registerIdempotencyHooks } from './idempotency.js';
import { normaliseError } from './errors.js';
import { meRoutes } from '../routes/me.js';
import { usersRoutes } from '../routes/users.js';
import { createNetworksRoutes } from '../routes/networks.js';
import { auditRoutes } from '../routes/audit.js';
import { NetworkServiceImpl } from '../domain/network-service.js';
import { HEALTH_STARTED_AT, HEALTH_RESPONSE, VERSION_PAYLOAD } from '../version.js';

/** Interval between rate-limiter cleanup sweeps (06-auth.md §9), in milliseconds. */
const RATE_LIMITER_CLEANUP_MS = 60_000;

/** Dependencies injected into {@link createServer}. */
export interface ServerDeps {
  /** Validated server configuration (env-driven). */
  config: ServerConfig;
  /** Open `_system.db` accessor. */
  systemDb: SystemDb;
  /** Application logger (pino). */
  logger: Logger;
}

/** Name of the reply header carrying the correlation id for every request. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Resolve the request id for correlation/logging. Prefers the client-supplied
 * `Client-Request-Id` (which also drives idempotency, task B11); falls back to
 * a freshly generated UUID so every request has a stable handle.
 */
export function resolveRequestId(req: FastifyRequest): string {
  const headerValue = req.headers['client-request-id'];
  if (typeof headerValue === 'string' && headerValue.length > 0) {
    return headerValue;
  }
  return randomUUID();
}

/**
 * Build a Fastify instance with plugins, error handler and system routes.
 *
 * TLS is enabled when `config.tls` is set (both `ETN_TLS_CERT`/`ETN_TLS_KEY`
 * resolved by `config.ts`); the certificate files are read here, not in
 * `config.ts`, so configuration validation stays free of filesystem side
 * effects.
 *
 * @returns an un-started Fastify instance; call `.listen()` (or pass to the
 *   entry point) to bind.
 */
export async function createServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, systemDb, logger } = deps;

  const httpsOptions =
    config.tls !== null
      ? {
          https: {
            cert: readFileSync(config.tls.cert),
            key: readFileSync(config.tls.key),
          },
        }
      : {};

  const app = Fastify({
    logger: false, // we use the injected pino logger explicitly
    trustProxy: true,
    ...httpsOptions,
  });

  // --- Error handler (03-server-api.md §2) ---------------------------------
  // Registered before any plugin/route so encapsulated child contexts inherit
  // the canonical { error: { code, message, details?, request_id? } } shape.
  app.setErrorHandler((err, req, reply) => {
    const { statusCode, body, internalMessage } = normaliseError(err, req.id);
    if (statusCode >= 500) {
      logger.error({ err, request_id: req.id }, internalMessage);
    } else {
      logger.warn({ request_id: req.id, statusCode }, internalMessage);
    }
    reply.code(statusCode).send(body);
  });

  // Correlation id on every request: surface it back via X-Request-Id so
  // clients/logs can tie a response to its origin.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const requestId = resolveRequestId(req);
    req.id = requestId;
    reply.header(REQUEST_ID_HEADER, requestId);
  });

  // Structured access log. `req.id` is the correlation id assigned above.
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    logger.info(
      {
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        request_id: req.id,
      },
      'request completed',
    );
  });

  // --- Plugins -------------------------------------------------------------
  await app.register(corsPlugin, {
    origin: true, // reflect request origin; credentials not used (bearer keys)
  });
  // WebSocket plugin: registered now so phase E can attach routes; no routes yet.
  await app.register(websocketPlugin);

  // --- Auth infrastructure (task B8) ---------------------------------------
  ensureAuthDecorator(app);
  const rateLimiter = new AuthRateLimiter();
  app.decorate('rateLimiter', rateLimiter);
  app.decorate('authPreHandler', createAuthPreHandler({ systemDb, rateLimiter, logger }));
  // Periodic eviction of expired failure/ban entries.
  const cleanupTimer = setInterval(() => rateLimiter.cleanup(), RATE_LIMITER_CLEANUP_MS);
  cleanupTimer.unref?.();
  app.addHook('onClose', () => clearInterval(cleanupTimer));

  // --- Access control (task B9) --------------------------------------------
  const members = new NetworkMembersService(systemDb);
  app.decorate('members', members);
  app.decorate('accessControl', createAccessControl(members));

  // --- Real-time pub/sub (task B10) ----------------------------------------
  const pubsub = new PubSub();
  app.decorate('pubsub', pubsub);

  // --- Idempotency (task B11) ----------------------------------------------
  app.decorateRequest('idempotency', null);
  app.decorate('idempotency', createIdempotencyMiddleware(systemDb, logger));
  registerIdempotencyHooks(app, systemDb, logger);

  // --- Shared dependencies for routes (tasks B12+) -------------------------
  app.decorate('systemDb', systemDb);
  app.decorate('appLogger', logger);

  // --- Route plugins (tasks B12+) ------------------------------------------
  await app.register(meRoutes, { prefix: '/api/v1' });
  await app.register(usersRoutes, { prefix: '/api/v1' });
  // NetworkService: directory + data.db + HOME seeding (task C10).
  await app.register(
    createNetworksRoutes(new NetworkServiceImpl(systemDb, config.dataDir, logger)),
    { prefix: '/api/v1' },
  );
  await app.register(auditRoutes, { prefix: '/api/v1' });

  // --- System routes (03-server-api.md §16) --------------------------------
  app.get('/api/v1/health', async () => {
    return { ...HEALTH_RESPONSE, uptime: Math.round(process.uptime() * 1000) / 1000 };
  });

  app.get('/api/v1/version', async () => VERSION_PAYLOAD);

  return app;
}

/** Process start timestamp, frozen at module load for `uptime` reporting. */
export { HEALTH_STARTED_AT };

/** Health response skeleton (uptime filled in per-request). */
export { HEALTH_RESPONSE };
