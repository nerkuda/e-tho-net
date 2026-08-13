/**
 * Shared transport-boundary helpers for the phase-D REST routes (tasks D1–D6).
 *
 * The domain services validate the business rules; these helpers cover the
 * concerns that repeat across the route plugins: opening the per-network
 * database, reading the JSON body as an object, parsing the `If-Match` header
 * and coercing individual body/query fields with canonical `VALIDATION_ERROR`
 * responses (docs/03-server-api.md §2.1). Validation messages follow the
 * Russian-wire style of the existing route layer.
 */

import type { FastifyRequest } from 'fastify';

import {
  EtnError,
  type RealtimeAudience,
  type RealtimeEventMap,
  type RealtimeEventType,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { openNetworkDb } from '../db/network-db.js';
import type { Logger } from '../logger.js';

/**
 * Emitter signature used by phase-D routes: derive the actor from the request
 * (auth context + `Client-Id`) and emit the catalogue-typed event after a
 * successful mutation (docs/04-realtime.md §4–5, task E3).
 */
export type RouteEmit = <E extends RealtimeEventType>(
  req: FastifyRequest,
  networkId: string,
  type: E,
  data: RealtimeEventMap[E],
  options?: { audience?: RealtimeAudience },
) => void;

/** Dependencies injected into the phase-D route plugin factories. */
export interface RouteDeps {
  /** Absolute ETN data directory (used to open `networks/<id>/data.db`). */
  dataDir: string;
  /** Emit a realtime event for the acting request (task E3 wiring). */
  emit: RouteEmit;
}

/** Open (or reuse) the network database for a route request. */
export function openRouteNetworkDb(deps: RouteDeps, networkId: string, log?: Logger): NetworkDb {
  return openNetworkDb(deps.dataDir, networkId, log);
}

/** Assert that the parsed JSON body is an object and return it typed. */
export function bodyObject(body: unknown, requestId?: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new EtnError(
      'BAD_REQUEST',
      'Тело запроса должно быть JSON-объектом.',
      undefined,
      requestId,
    );
  }
  return body as Record<string, unknown>;
}

/**
 * Parse an `If-Match` header into the expected entity version. Absent header
 * yields `undefined` (no optimistic check); a non-integer value is rejected
 * with `VALIDATION_ERROR`.
 */
export function parseIfMatch(header: string | undefined, requestId?: string): number | undefined {
  if (header === undefined) {
    return undefined;
  }
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Заголовок If-Match должен содержать целую версию.',
      { field: 'If-Match' },
      requestId,
    );
  }
  return Number.parseInt(trimmed, 10);
}

/** Read an optional string field; anything present but not a string → 422. */
export function fieldString(
  obj: Record<string, unknown>,
  key: string,
  requestId?: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new EtnError(
      'VALIDATION_ERROR',
      `${key} должен быть строкой.`,
      { field: key },
      requestId,
    );
  }
  return value;
}

/** Read an optional string-or-null field; wrong type → 422. */
export function fieldNullableString(
  obj: Record<string, unknown>,
  key: string,
  requestId?: string,
): string | null | undefined {
  const value = obj[key];
  if (value === undefined || value === null) {
    return value as undefined | null;
  }
  if (typeof value !== 'string') {
    throw new EtnError(
      'VALIDATION_ERROR',
      `${key} должен быть строкой или null.`,
      { field: key },
      requestId,
    );
  }
  return value;
}

/** Read an optional boolean field; wrong type → 422. */
export function fieldBoolean(
  obj: Record<string, unknown>,
  key: string,
  requestId?: string,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new EtnError(
      'VALIDATION_ERROR',
      `${key} должен быть логическим значением.`,
      { field: key },
      requestId,
    );
  }
  return value;
}

/** Read an optional array of strings; wrong shape → 422. */
export function fieldStringArray(
  obj: Record<string, unknown>,
  key: string,
  requestId?: string,
): string[] | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `${key} должен быть массивом строк.`,
      { field: key },
      requestId,
    );
  }
  return value as string[];
}

/**
 * Read a synonyms field in either accepted shape (03-server-api.md §6.3):
 * an array of strings or a single comma-separated string.
 */
export function fieldStringOrArray(
  obj: Record<string, unknown>,
  key: string,
  requestId?: string,
): string[] | string | undefined {
  const value = obj[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  throw new EtnError(
    'VALIDATION_ERROR',
    `${key} должен быть строкой или массивом строк.`,
    { field: key },
    requestId,
  );
}

/**
 * Read a repeatable query parameter: a single string, an array of strings, or
 * nothing. Non-string entries are dropped (Fastify guarantees string|string[]).
 */
export function queryStrings(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  return [];
}

/**
 * Parse a positive-integer query parameter. Returns the `fallback` when the
 * parameter is absent; rejects non-integer values with `VALIDATION_ERROR`.
 */
export function queryInt(
  value: unknown,
  fallback: number,
  opts: { field: string; min: number; requestId?: string },
): number {
  if (value === undefined) {
    return fallback;
  }
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === 'string' && raw !== '' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < opts.min) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `${opts.field} должен быть целым числом не меньше ${opts.min}.`,
      { field: opts.field },
      opts.requestId,
    );
  }
  return parsed;
}

/** Parse an optional boolean query parameter (`true`/`false`/`1`/`0`). */
export function queryBoolean(
  value: unknown,
  field: string,
  requestId?: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === '0') {
    return false;
  }
  throw new EtnError(
    'VALIDATION_ERROR',
    `Параметр ${field} должен быть логическим значением (true/false).`,
    { field },
    requestId,
  );
}

/** Read a request body that may be absent (empty payload → `{}`). */
export function requestBody(req: FastifyRequest): Record<string, unknown> {
  return bodyObject(req.body ?? {}, req.id);
}
