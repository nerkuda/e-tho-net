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

import { BASE_LAYER_ID } from '@etn/shared';

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
import { startEventLogCleanup } from '../realtime/event-log-cleanup.js';
import { EventLogRelay } from '../realtime/event-log-relay.js';
import { RealtimeGateway, type RealtimeGatewayOptions } from '../realtime/gateway.js';
import { createIdempotencyMiddleware, registerIdempotencyHooks } from './idempotency.js';
import { normaliseError } from './errors.js';
import { meRoutes } from '../routes/me.js';
import { createImportRoutes } from '../routes/import.js';
import { usersRoutes } from '../routes/users.js';
import { createNetworksRoutes } from '../routes/networks.js';
import { auditRoutes } from '../routes/audit.js';
import { createThoughtsRoutes } from '../routes/thoughts.js';
import { createLinksRoutes } from '../routes/links.js';
import { createStructuresRoutes } from '../routes/structures.js';
import { createChronicleRoutes } from '../routes/chronicle.js';
import { createPinsRoutes } from '../routes/pins.js';
import { createTypesRoutes } from '../routes/types.js';
import { createPropertiesRoutes } from '../routes/properties.js';
import { createCommentsRoutes } from '../routes/comments.js';
import { createAttachmentsRoutes } from '../routes/attachments.js';
import { createSearchRoutes } from '../routes/search.js';
import { createTrashRoutes } from '../routes/trash.js';
import { createLayersRoutes } from '../routes/layers.js';
import { createAdminNetworksRoutes } from '../routes/admin-networks.js';
import { systemLoggingRoutes } from '../routes/system-logging.js';
import { FileLog, type FileLogLevel } from '../log/file-log.js';
import { startEventLoopMonitor } from '../log/event-loop-monitor.js';
import { resolveRequestLayer, type RouteDeps } from '../routes/helpers.js';
import { emitDomainEvent } from '../realtime/emit.js';
import { NetworkServiceImpl } from '../domain/network-service.js';
import { createApiKeyAuthProvider } from '../mcp/auth.js';
import { createMcpHttpEndpoint } from '../mcp/http.js';
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
  /** Optional WebSocket gateway tuning (mainly for tests). */
  realtimeOptions?: Partial<RealtimeGatewayOptions>;
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

  // --- File journal (task 1dd33e23, spec: подсистема «Логирование») --------
  // Plain-text daily journal under <dataDir>/logs/: ERROR entries are always
  // written, other levels only while the in-memory flag is on (off at every
  // start). Deliberately separate from the stdout pino logger.
  const fileLog = new FileLog(config.dataDir);

  const app = Fastify({
    logger: false, // we use the injected pino logger explicitly
    trustProxy: true,
    ...httpsOptions,
  });

  app.decorate('fileLog', fileLog);
  // better-sqlite3 is synchronous — a blocked loop is the prime suspect for
  // the intermittent client freezes; sample it and WARN past 100 ms.
  const stopLagMonitor = startEventLoopMonitor(fileLog);
  app.addHook('onClose', () => stopLagMonitor());

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
  // clients/logs can tie a response to its origin. The same hook stamps the
  // file-journal start time used by the onResponse access entry below.
  app.decorateRequest('fileLogStart', 0);
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    req.fileLogStart = performance.now();
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
    logRequestToJournal(fileLog, req, reply);
  });

  // --- Layer echo (task S7, 13-layers.md §7.1) ------------------------------
  // Every successful mutating REST response of a network carries the session's
  // current layer: `meta.layer: { id, title }` in JSON bodies, and the
  // `X-Etn-Layer`/`X-Etn-Layer-Title` headers on bodiless 204 replies. The
  // hidden per-session default is dangerous exactly because a restarted
  // client could write into the wrong layer — the echo makes it discoverable
  // immediately. Registered before any route so it applies to all of them.
  registerLayerEchoHook(app, config.dataDir);

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

  // --- Real-time WebSocket gateway + event-log retention (tasks E1–E6) ------
  const gateway = new RealtimeGateway({
    systemDb,
    pubsub,
    dataDir: config.dataDir,
    logger,
    options: deps.realtimeOptions,
    fileLog,
  });
  gateway.register(app);
  // Task S9 (13-layers.md §12): routes/layers.ts pushes forced-resync control
  // frames after a session's layer changes server-side.
  app.decorate('realtimeGateway', gateway);
  const stopEventLogCleanup = startEventLogCleanup(systemDb, logger);
  app.addHook('onClose', () => stopEventLogCleanup());

  // --- Event-log relay (04-realtime.md §5) ----------------------------------
  // The broker is in-memory, so events written by a foreign process (the stdio
  // MCP CLI) never reach the gateway on their own. The relay polls the log and
  // broadcasts them, bounded by pollIntervalMs; own writes are tracked via the
  // broker subscription and never re-broadcast.
  const eventLogRelay = new EventLogRelay({ systemDb, pubsub, logger });
  eventLogRelay.start();
  app.addHook('onClose', () => eventLogRelay.stop());

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
  // Admin network routes (task D7, 03-server-api.md §4.2).
  await app.register(
    createAdminNetworksRoutes(new NetworkServiceImpl(systemDb, config.dataDir, logger)),
    { prefix: '/api/v1' },
  );

  // Real-time event emission for phase-D routes (task E3): derive the actor
  // from the request auth context and publish catalogue-typed events.
  const routeDeps: RouteDeps = {
    dataDir: config.dataDir,
    emit: (req, networkId, type, data, options) => {
      const auth = req.auth;
      emitDomainEvent(
        { systemDb, pubsub },
        networkId,
        type,
        data,
        { user_id: auth?.user.id ?? '', client_id: auth?.clientId ?? null },
        {
          ...(options?.audience !== undefined ? { audience: options.audience } : {}),
          meta: { request_id: req.id },
          // Task S9, 13-layers.md §12: tag the event with the write's layer so
          // the gateway/changes.list can compute per-subscriber visibility.
          // `req.layerEcho` is already memoised by the route's
          // `openRouteNetworkDb` call before it emits. Task S8: the merge
          // route attributes its `layer.merged` event to the merge target
          // explicitly — the acting session may sit anywhere.
          layerId: options?.layerId ?? req.layerEcho?.id ?? BASE_LAYER_ID,
        },
      );
    },
  };

  // Thought routes (task D1): CRUD, focus, neighbours, batch, resolve,
  // mentions, focus preferences/order (03-server-api.md §6).
  await app.register(createThoughtsRoutes(routeDeps), { prefix: '/api/v1' });

  // Link routes (task D2): CRUD + grouped editor listing (03-server-api.md §7).
  await app.register(createLinksRoutes(routeDeps), { prefix: '/api/v1' });

  // Structures-view routes (L15): filter query, hierarchy expansion and saved
  // filters (03-server-api.md §6.10, §6.11, §18).
  await app.register(createStructuresRoutes(routeDeps), { prefix: '/api/v1' });

  // Chronicle-view routes (L20): two-phase chronological-comment query
  // (03-server-api.md §20).
  await app.register(createChronicleRoutes(routeDeps), { prefix: '/api/v1' });

  // Pinned-thoughts routes (L18): per-user ordered list (03-server-api.md §19).
  await app.register(createPinsRoutes(routeDeps), { prefix: '/api/v1' });

  // Type routes (task D3): thought/link types + type_properties (03-server-api.md §8).
  await app.register(createTypesRoutes(routeDeps), { prefix: '/api/v1' });

  // Property-value routes (task D4): per-thought/per-link values by key (03-server-api.md §9).
  await app.register(createPropertiesRoutes(routeDeps), { prefix: '/api/v1' });

  // Comment and attachment routes (task D5, 03-server-api.md §10–11).
  await app.register(createCommentsRoutes(routeDeps), { prefix: '/api/v1' });
  await app.register(createAttachmentsRoutes(routeDeps), { prefix: '/api/v1' });

  // Search, export and job routes (task D6, 03-server-api.md §12, §14).
  await app.register(createSearchRoutes(routeDeps), { prefix: '/api/v1' });

  // Trash routes (task S13, 03-server-api.md §14b).
  await app.register(createTrashRoutes(routeDeps), { prefix: '/api/v1' });

  // Change-layer routes (task S7, 03-server-api.md §5a): list/create/rename/
  // delete layers and switch the session's current layer.
  await app.register(createLayersRoutes(routeDeps), { prefix: '/api/v1' });

  // Import routes (phase P, P4): preview + commit a `.etnx` archive.
  await app.register(createImportRoutes(routeDeps), { prefix: '/api/v1' });

  // --- System routes (03-server-api.md §16) --------------------------------
  app.get('/api/v1/health', async () => {
    return { ...HEALTH_RESPONSE, uptime: Math.round(process.uptime() * 1000) / 1000 };
  });

  app.get('/api/v1/version', async () => VERSION_PAYLOAD);

  // File-journal management (task 1dd33e23 §4): admin-only status/toggle and
  // per-file download/delete endpoints.
  await app.register(systemLoggingRoutes, { prefix: '/api/v1' });

  // --- MCP StreamableHTTP endpoint (phase F, 05-mcp-server.md §2) -----------
  // Mounted when ETN_MCP_ENABLED=1; agents authenticate with the same
  // API-keys as REST (Bearer). With ETN_MCP_PORT set, the entry point
  // additionally serves the endpoint on a dedicated listener (see index.ts).
  if (config.mcp.enabled) {
    const mcpHttp = createMcpHttpEndpoint({
      systemDb,
      dataDir: config.dataDir,
      pubsub,
      authProvider: createApiKeyAuthProvider(systemDb),
      logger,
      fileLog,
    });
    await mcpHttp.register(app);
    app.decorate('mcpHttp', mcpHttp);
    app.addHook('onClose', () => mcpHttp.close());
    logger.info('MCP endpoint enabled: /mcp (StreamableHTTP)');
  }

  return app;
}

/** Process start timestamp, frozen at module load for `uptime` reporting. */
export { HEALTH_STARTED_AT };

/** Health response skeleton (uptime filled in per-request). */
export { HEALTH_RESPONSE };

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * `performance.now()` stamped by the onRequest hook — the basis of the
     * file-journal request duration (task 1dd33e23 §3). `0` until stamped.
     */
    fileLogStart: number;
  }
}

/** REST request duration past which the journal entry becomes a slow WARN. */
const SLOW_REQUEST_MS = 1_000;

/**
 * One file-journal entry per completed request (task 1dd33e23 §3):
 * method, path, status, duration, request_id, client_id. Levels — 5xx ERROR
 * (always, even with the flag off), slow (>1 s) WARN, 4xx WARN, else INFO;
 * non-ERROR levels only land while logging is enabled (`FileLog.log` filters).
 */
function logRequestToJournal(
  fileLog: FileLog,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  const status = reply.statusCode;
  const startedAt = req.fileLogStart > 0 ? req.fileLogStart : performance.now();
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  const slow = durationMs >= SLOW_REQUEST_MS;
  const level: FileLogLevel = status >= 500 ? 'ERROR' : slow || status >= 400 ? 'WARN' : 'INFO';
  fileLog.log(
    level,
    'http',
    slow ? 'slow request completed' : 'request completed',
    {
      method: req.method,
      path: (req.url ?? '').split('?')[0] ?? '',
      status,
      duration_ms: durationMs,
      request_id: req.id,
      client_id: req.auth?.clientId ?? null,
      ...(slow ? { slow: true } : {}),
    },
  );
}

/** Response header carrying the echoed layer id (13-layers.md §7.1, task S7). */
export const LAYER_ECHO_HEADER = 'x-etn-layer';

/** Response header carrying the echoed layer title (pairs with the id one). */
export const LAYER_ECHO_TITLE_HEADER = 'x-etn-layer-title';

/** Mutating HTTP methods whose network responses echo the session layer. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Matches `/api/v1/networks/<uuid>` and captures the network id. */
const NETWORK_URL_RE = /^\/api\/v1\/networks\/([^/?#]+)/;

/** The base-layer echo used when no session default can be resolved. */
const BASE_ECHO = { id: BASE_LAYER_ID, title: 'Основа' } as const;

/**
 * onSend hook implementing the layer echo (13-layers.md §7.1, task S7): every
 * successful mutating response under `/api/v1/networks…` carries the
 * session's current layer — `meta.layer: { id, title }` merged into JSON
 * bodies, and the {@link LAYER_ECHO_HEADER}/{@link LAYER_ECHO_TITLE_HEADER}
 * headers on bodiless 204 replies (a 204 has no meta to extend; the headers
 * are the additive way to keep the DELETE contract unchanged). Responses to
 * reads carry no echo by design (§7.1) — the read is already implicitly bound
 * to the session layer.
 */
/**
 * onSend hook implementing the layer echo (13-layers.md §7.1, task S7): every
 * successful mutating response under `/api/v1/networks…` carries the
 * session's current layer — `meta.layer: { id, title }` merged into JSON
 * bodies, and the {@link LAYER_ECHO_HEADER}/{@link LAYER_ECHO_TITLE_HEADER}
 * headers on bodiless 204 replies (a 204 has no meta to extend; the headers
 * are the additive way to keep the DELETE contract unchanged). Responses to
 * reads carry no echo by design (§7.1) — the read is already implicitly bound
 * to the session layer.
 *
 * Deliberately a **synchronous done-style** hook: an extra async onSend hook
 * adds a microtask hop to the send chain and changes the outcome of Fastify's
 * `wrapThenable` race (an async handler that already called `reply.send` and
 * resolves before the headers are flushed triggers a duplicate
 * `reply.send(undefined)`, ERR_HTTP_HEADERS_SENT). The session-layer lookup is
 * synchronous anyway (better-sqlite3), so no await is needed.
 */
function registerLayerEchoHook(app: FastifyInstance, dataDir: string): void {
  app.addHook(
    'onSend',
    (req: FastifyRequest, reply: FastifyReply, payload: unknown, done: (err?: Error | null, res?: unknown) => void) => {
      if (!MUTATING_METHODS.has(req.method)) {
        done();
        return;
      }
      const status = reply.statusCode;
      if (status < 200 || status >= 300) {
        done();
        return;
      }
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (!path.startsWith('/api/v1/networks')) {
        done();
        return;
      }

      const match = NETWORK_URL_RE.exec(path);
      let layer = req.layerEcho ?? BASE_ECHO;
      if (match !== null && req.layerEcho === undefined && req.auth !== null) {
        // The handler never opened the network db (e.g. member/preference
        // routes): resolve the session default now — access was already
        // checked by the route, the status is a success. Any failure degrades
        // to the base echo instead of failing an otherwise-successful response.
        try {
          layer = resolveRequestLayer(dataDir, req, match[1] as string);
        } catch {
          layer = BASE_ECHO;
        }
      }

      // JSON bodies get meta.layer; everything else (204 empty, buffers,
      // streams, non-JSON strings) gets the header pair. Header values must be
      // ASCII, so the title is percent-encoded there (decodeURIComponent on
      // the client).
      if (typeof payload === 'string' && payload.startsWith('{')) {
        const contentType = reply.getHeader('content-type');
        if (typeof contentType === 'string' && contentType.includes('application/json')) {
          try {
            const body = JSON.parse(payload) as { meta?: Record<string, unknown> } | null;
            if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
              body.meta = { ...(body.meta ?? {}), layer };
              done(null, JSON.stringify(body));
              return;
            }
          } catch {
            // malformed body string — fall through to the header fallback
          }
        }
      }
      reply.header(LAYER_ECHO_HEADER, layer.id);
      reply.header(LAYER_ECHO_TITLE_HEADER, encodeURIComponent(layer.title));
      done();
    },
  );
}
