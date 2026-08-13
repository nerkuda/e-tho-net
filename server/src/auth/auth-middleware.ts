/**
 * Authentication preHandler for Fastify (task B8, docs/06-auth.md §3, §9).
 *
 * Extracts the `Bearer` API-key, resolves it via `SystemDb.findApiKeyByHash`,
 * populates `request.auth` with the user/key/client context, and updates
 * `last_used_at` asynchronously (so it never blocks the request). Failed
 * attempts feed the {@link AuthRateLimiter} and the `audit_log`
 * (`category=auth`); a banned bucket gets HTTP 429 without touching the store.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { SystemDb } from '../db/system-db.js';
import type { Logger } from '../logger.js';
import { sendEtnError } from '../http/errors.js';
import { type AuthContext, extractBearerToken, readClientId } from '../http/context.js';
import { deriveApiKeyPrefix, hashApiKey, isValidApiKeyFormat } from './api-key.js';
import { AuthRateLimiter, bucketKey, type RateLimitResult } from './rate-limiter.js';

/** Signature of a Fastify preHandler hook. */
export type AuthPreHandlerFn = (req: FastifyRequest, reply: FastifyReply) => Promise<void> | void;

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared auth preHandler built in {@link createAuthPreHandler}. */
    authPreHandler: AuthPreHandlerFn;
    /** Shared brute-force limiter (06-auth.md §9). */
    rateLimiter: AuthRateLimiter;
  }
}

/** Dependencies injected into {@link createAuthPreHandler}. */
export interface AuthMiddlewareDeps {
  systemDb: SystemDb;
  rateLimiter: AuthRateLimiter;
  logger: Logger;
}

/**
 * Idempotently register the `request.auth` decorator on the Fastify instance.
 * Safe to call from multiple route plugins — the second call is a no-op.
 */
export function ensureAuthDecorator(app: FastifyInstance): void {
  if (app.hasDecorator('auth')) {
    return;
  }
  // `decorateRequest` with a primitive default sets `auth = null` per request.
  app.decorateRequest('auth', null);
}

/**
 * Resolve the request IP, honouring the `trustProxy` setting by preferring the
 * first address of `x-forwarded-for`.
 */
function requestIp(req: FastifyRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const first = xff.split(',')[0];
    if (first !== undefined) {
      return first.trim();
    }
  }
  return req.ip;
}

/** Factory: build a Fastify preHandler that authenticates via API-key. */
export function createAuthPreHandler(
  deps: AuthMiddlewareDeps,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const { systemDb, rateLimiter, logger } = deps;

  return async function authPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const ip = requestIp(req);
    const requestId = req.id;

    // --- Parse the bearer token -------------------------------------------------
    const token = extractBearerToken(req.headers);
    // Derive a display prefix for the bucket key (null when malformed).
    const prefix = token !== null && isValidApiKeyFormat(token) ? deriveApiKeyPrefix(token) : null;
    const bucket = bucketKey(ip, prefix);

    // --- Ban check (06-auth.md §9) ---------------------------------------------
    if (rateLimiter.isBanned(bucket)) {
      const retryAfter = rateLimiter.retryAfterSeconds(bucket);
      systemDb.insertAuditLog({
        category: 'auth',
        action: 'rate_limited',
        details: { ip, key_prefix: prefix },
      });
      logger.warn(
        { ip, request_id: requestId, retry_after: retryAfter },
        'auth: rate-limited (banned)',
      );
      reply.header('retry-after', String(retryAfter));
      sendEtnError(
        reply,
        'RATE_LIMITED',
        'Слишком много неудачных попыток входа. Попробуйте позже.',
        { retry_after_seconds: retryAfter },
        requestId,
      );
      return;
    }

    if (token === null || !isValidApiKeyFormat(token)) {
      replyAuthFailure(
        reply,
        requestId,
        recordAuthFailure(
          systemDb,
          rateLimiter,
          logger,
          bucket,
          ip,
          prefix,
          'malformed_token',
          requestId,
        ),
      );
      return;
    }

    // --- Key lookup (06-auth.md §3) --------------------------------------------
    const keyHash = hashApiKey(token);
    const found = systemDb.findApiKeyByHash(keyHash);
    if (found === null) {
      replyAuthFailure(
        reply,
        requestId,
        recordAuthFailure(
          systemDb,
          rateLimiter,
          logger,
          bucket,
          ip,
          prefix,
          'unknown_key',
          requestId,
        ),
      );
      return;
    }

    // --- Success ---------------------------------------------------------------
    const { apiKey, user } = found;
    const ctx: AuthContext = {
      user,
      keyId: apiKey.id,
      keyReadOnly: apiKey.read_only,
      keyPrefix: apiKey.prefix,
      clientId: readClientId(req.headers),
    };
    req.auth = ctx;
    rateLimiter.clear(bucket);

    // Update last_used_at off the request path (06-auth.md §3.5). Errors here are
    // non-fatal — a transient write failure must not break an otherwise-valid
    // request.
    setImmediate(() => {
      try {
        systemDb.touchApiKeyUsed(apiKey.id);
      } catch (err) {
        logger.warn({ err, key_id: apiKey.id }, 'auth: failed to update last_used_at');
      }
    });
  };
}

/** Record an authentication failure into the rate limiter and audit log. */
function recordAuthFailure(
  systemDb: SystemDb,
  rateLimiter: AuthRateLimiter,
  logger: Logger,
  bucket: string,
  ip: string,
  prefix: string | null,
  reason: 'malformed_token' | 'unknown_key',
  requestId: string,
): RateLimitResult {
  const result = rateLimiter.recordFailure(bucket);
  systemDb.insertAuditLog({
    category: 'auth',
    action: 'login_failed',
    details: { ip, key_prefix: prefix, reason, banned: result.banned },
  });
  logger.info({ ip, reason, request_id: requestId, banned: result.banned }, 'auth: failed attempt');
  return result;
}

/**
 * Send the right failure response for an authentication attempt that just
 * crossed the rate-limit threshold: HTTP 429 once banned, 401 otherwise
 * (06-auth.md §9 — the request that exceeds the threshold is itself rejected
 * with 429).
 */
function replyAuthFailure(reply: FastifyReply, requestId: string, result: RateLimitResult): void {
  if (result.banned) {
    reply.header('retry-after', String(result.retryAfterSeconds));
    sendEtnError(
      reply,
      'RATE_LIMITED',
      'Слишком много неудачных попыток входа. Попробуйте позже.',
      { retry_after_seconds: result.retryAfterSeconds },
      requestId,
    );
    return;
  }
  sendEtnError(
    reply,
    'UNAUTHORIZED',
    'Недействительный или отсутствующий API-key.',
    undefined,
    requestId,
  );
}
