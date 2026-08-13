/**
 * Request idempotency via `Client-Request-Id` (task B11, 01-architecture.md §6,
 * 02-data-model.md §2.7).
 *
 * Mutating requests may carry `Client-Request-Id: <UUID>`; the first successful
 * (2xx) response is cached in `client_request_cache` for `IDEMPOTENCY_TTL_MINUTES`
 * (10). A retried request with the same id (and same user) replays the cached
 * status+body **without re-executing the handler**, protecting against duplicate
 * side effects when clients retry.
 *
 * The `preHandler` checks the cache (after auth, so `user_id` is known) and
 * short-circuits on a hit; the global `onSend` hook persists successful first
 * responses. GET requests are ignored — idempotency applies only to mutations.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { IDEMPOTENCY_TTL_MINUTES } from '@etn/shared';

import type { SystemDb } from '../db/system-db.js';
import type { Logger } from '../logger.js';

/** Per-request idempotency state attached by the preHandler. */
export interface IdempotencyState {
  /** `Client-Request-Id` value driving this request. */
  requestId: string;
  /** Owning user — cache entries are user-scoped. */
  userId: string;
  /** True when the response is being served from the cache (not re-saved). */
  replay: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Idempotency state, or `null` when the request opts out / is a GET. */
    idempotency: IdempotencyState | null;
  }
  interface FastifyInstance {
    /** Shared idempotency preHandler (task B11). */
    idempotency: IdempotencyMiddleware;
  }
}

/** HTTP methods that may carry idempotency semantics. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Interval between cache sweeps, in milliseconds. */
const PURGE_INTERVAL_MS = 5 * 60_000;

/** Read the `Client-Request-Id` header, or `null` when absent/blank. */
export function readClientRequestId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers['client-request-id'];
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Idempotency bundle bound to a single {@link SystemDb}. */
export interface IdempotencyMiddleware {
  /** preHandler: replay cached response on hit, otherwise record state for onSend. */
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Build the idempotency preHandler. Wire it on mutating routes after the auth
 * preHandler (it reads `request.auth.user.id`). The companion `onSend` hook and
 * TTL sweep are registered globally via {@link registerIdempotencyHooks}.
 */
export function createIdempotencyMiddleware(
  systemDb: SystemDb,
  logger: Logger,
): IdempotencyMiddleware {
  const preHandler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    req.idempotency = null;
    if (!MUTATING_METHODS.has(req.method.toUpperCase())) {
      return;
    }
    const requestId = readClientRequestId(req.headers);
    if (requestId === null) {
      return;
    }
    if (req.auth === null) {
      // Idempotency requires a known user; if auth failed the auth preHandler
      // already replied. Leave state null and bail.
      return;
    }
    const userId = req.auth.user.id;
    const cached = systemDb.findCachedResponse(requestId, userId);
    if (cached !== null) {
      req.idempotency = { requestId, userId, replay: true };
      const body = cached.body === null ? null : safeParse(cached.body);
      logger.info(
        { request_id: requestId, user_id: userId, status: cached.status },
        'idempotency: cache hit, replaying',
      );
      reply.code(cached.status).send(body);
      return;
    }
    req.idempotency = { requestId, userId, replay: false };
  };
  return { preHandler };
}

/**
 * Register the `onSend` hook (persist 2xx first responses) and the periodic TTL
 * sweep on the Fastify instance. Call once during server bootstrap.
 */
export function registerIdempotencyHooks(
  app: FastifyInstance,
  systemDb: SystemDb,
  logger: Logger,
): void {
  app.addHook(
    'onSend',
    async (req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
      const state = req.idempotency;
      if (state === null || state.replay) {
        return payload;
      }
      const status = reply.statusCode;
      if (status < 200 || status >= 300) {
        return payload; // cache successes only
      }
      const bodyStr = typeof payload === 'string' ? payload : null;
      try {
        systemDb.saveCachedResponse(state.requestId, state.userId, status, bodyStr);
      } catch (err) {
        logger.warn({ err, request_id: state.requestId }, 'idempotency: failed to cache response');
      }
      return payload;
    },
  );

  const timer = setInterval(() => {
    const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL_MINUTES * 60_000).toISOString();
    try {
      const removed = systemDb.purgeExpiredCache(cutoff);
      if (removed > 0) {
        logger.debug({ removed }, 'idempotency: purged expired cache rows');
      }
    } catch (err) {
      logger.warn({ err }, 'idempotency: purge sweep failed');
    }
  }, PURGE_INTERVAL_MS);
  timer.unref?.();
  app.addHook('onClose', () => clearInterval(timer));
}

/** Parse JSON without throwing; returns the raw string on failure. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
