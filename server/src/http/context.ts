/**
 * Request-scoped authentication context and Fastify type augmentation (task B8).
 *
 * The {@link AuthContext} is populated by the auth preHandler on every
 * authenticated request and read by route handlers via `request.auth`. It is
 * `null` before authentication completes (or for routes that opt out of auth).
 */

import type { ApiKey, User } from '@etn/shared';

/**
 * Identity and key material attached to an authenticated request.
 * Mirrors the `request.user = { user, key_id, client_id }` contract from task
 * B8 / docs/06-auth.md §3, extended with the key's `read_only` flag (needed by
 * mutating endpoints and MCP).
 */
export interface AuthContext {
  /** Authenticated user (non-disabled owner of the key). */
  user: User;
  /** id of the API-key used for this request. */
  keyId: string;
  /** Whether the key is read-only (mutating endpoints must be blocked). */
  keyReadOnly: boolean;
  /** Display prefix of the key (for audit logging), e.g. `a1b2c3d4`. */
  keyPrefix: string;
  /** `Client-Id` header value, or `null` when omitted (used for echo suppression). */
  clientId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Auth context — populated by the auth preHandler. `null` on routes that
     * do not require authentication (e.g. `/health`, `/version`) or before the
     * preHandler has run.
     */
    auth: AuthContext | null;
  }
}

/** Name of the header carrying the client installation id (04-realtime.md §2). */
export const CLIENT_ID_HEADER = 'client-id';

/** Name of the header carrying the bearer API-key (06-auth.md §1). */
export const AUTHORIZATION_HEADER = 'authorization';

/** Prefix expected on the bearer token (06-auth.md §1). */
export const BEARER_PREFIX = 'bearer';

/** Read the `Client-Id` header, normalised or `null`. */
export function readClientId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers[CLIENT_ID_HEADER];
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extract the bearer token from the `Authorization` header.
 *
 * @returns the raw token string, or `null` when the header is missing or not a
 *   well-formed `Bearer <token>` value.
 */
export function extractBearerToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers[AUTHORIZATION_HEADER];
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  const space = trimmed.indexOf(' ');
  if (space <= 0) {
    return null;
  }
  const scheme = trimmed.slice(0, space).toLowerCase();
  if (scheme !== BEARER_PREFIX) {
    return null;
  }
  const token = trimmed.slice(space + 1).trim();
  return token.length > 0 ? token : null;
}

/** Type re-export so callers avoid importing the whole @etn/shared surface. */
export type { ApiKey, User };
