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
  BASE_LAYER_ID,
  EtnError,
  ICON_KINDS,
  LINK_STYLES,
  type IconKind,
  type LayerEcho,
  type LinkStyle,
  type RealtimeAudience,
  type RealtimeEventMap,
  type RealtimeEventType,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { openNetworkDb } from '../db/network-db.js';
export { openNetworkDb };
import { resolveSessionLayer } from '../domain/layer-service.js';
import type { Logger } from '../logger.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Session layer of this request (task S7, 13-layers.md §7.1), resolved
     * lazily from `session_layers` by the first call of
     * {@link openRouteNetworkDb} (or the onSend echo hook) and memoised for
     * the request lifetime. `undefined` until resolved.
     */
    layerEcho: LayerEcho | undefined;
  }
}

/**
 * Emitter signature used by phase-D routes: derive the actor from the request
 * (auth context + `Client-Id`) and emit the catalogue-typed event after a
 * successful mutation (docs/04-realtime.md §4–5, task E3).
 *
 * `options.layerId` overrides the event's layer attribution (task S8): the
 * merge route attributes its single `layer.merged` event to the merge target,
 * not to the acting session's current layer.
 */
export type RouteEmit = <E extends RealtimeEventType>(
  req: FastifyRequest,
  networkId: string,
  type: E,
  data: RealtimeEventMap[E],
  options?: { audience?: RealtimeAudience; layerId?: string },
) => void;

/** Dependencies injected into the phase-D route plugin factories. */
export interface RouteDeps {
  /** Absolute ETN data directory (used to open `networks/<id>/data.db`). */
  dataDir: string;
  /** Emit a realtime event for the acting request (task E3 wiring). */
  emit: RouteEmit;
}

/**
 * Resolve (and memoise on the request) the session's current layer for
 * `networkId` (task S7, 13-layers.md §7.1): the `(user_id, client_id)` default
 * from `session_layers`, base layer when nothing is recorded. The lookup runs
 * on the network's base-layer connection — `session_layers` is not branchable,
 * and the base context is always valid.
 */
export function resolveRequestLayer(
  dataDir: string,
  req: FastifyRequest,
  networkId: string,
  log?: Logger,
): LayerEcho {
  if (req.layerEcho === undefined) {
    const auth = req.auth;
    req.layerEcho =
      auth !== null
        ? resolveSessionLayer(openNetworkDb(dataDir, networkId, log, BASE_LAYER_ID), auth.user.id, auth.clientId)
        : { id: BASE_LAYER_ID, title: 'Основа' };
  }
  return req.layerEcho;
}

/**
 * Open (or reuse) the network database for a route request **in the context of
 * the session's current layer** (task S7, 13-layers.md §7): reads through the
 * `*_v` views and layered writes of everything this session does resolve along
 * that layer's ancestor chain. The resolved layer is memoised on the request
 * for the `meta.layer` echo of the onSend hook.
 */
export function openRouteNetworkDb(
  deps: RouteDeps,
  req: FastifyRequest,
  networkId: string,
  log?: Logger,
): NetworkDb {
  const layer = resolveRequestLayer(deps.dataDir, req, networkId, log);
  return openNetworkDb(deps.dataDir, networkId, log, layer.id);
}

/**
 * Open (or reuse) the network database **in the base-layer context** — for
 * route families that operate on layer-independent data (the `layers`
 * metadata itself, `session_layers`) or must act physically regardless of the
 * session's selection (the layer-delete cascade + trash auto-purge). The
 * session's layer default is resolved separately via
 * {@link resolveRequestLayer}.
 */
export function openRouteNetworkDbBase(deps: RouteDeps, networkId: string, log?: Logger): NetworkDb {
  return openNetworkDb(deps.dataDir, networkId, log, BASE_LAYER_ID);
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

/**
 * Read an optional boolean-or-null field; wrong type → 422. Like
 * {@link fieldBoolean} but also accepts `null` (used for "inherit from type"
 * style fields, 02-data-model.md §3.1.1).
 */
export function fieldNullableBoolean(
  obj: Record<string, unknown>,
  key: string,
  requestId?: string,
): boolean | null | undefined {
  const value = obj[key];
  if (value === undefined || value === null) {
    return value as boolean | null | undefined;
  }
  if (typeof value !== 'boolean') {
    throw new EtnError(
      'VALIDATION_ERROR',
      `${key} должен быть логическим значением или null.`,
      { field: key },
      requestId,
    );
  }
  return value;
}

/** Validate the optional `icon_kind` field against the shared enum. */
export function parseIconKind(
  value: string | null | undefined,
  requestId?: string,
): IconKind | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!(ICON_KINDS as readonly string[]).includes(value)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Недопустимый icon_kind.',
      { field: 'icon_kind', allowed: ICON_KINDS },
      requestId,
    );
  }
  return value as IconKind;
}

/** Maximum inline image-icon size (decoded), 256 KiB (08-ui-spec.md §6.8). */
export const ICON_MAX_BYTES = 256 * 1024;

/** Validate the optional link line `style` against the shared enum. */
export function parseLinkStyle(
  value: string | null | undefined,
  requestId?: string,
): LinkStyle | null | undefined {
  if (value === undefined || value === null) {
    return value as LinkStyle | null | undefined;
  }
  if (!(LINK_STYLES as readonly string[]).includes(value)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Недопустимый style связи.',
      { field: 'style', allowed: LINK_STYLES },
      requestId,
    );
  }
  return value as LinkStyle;
}

/** Read an optional integer-or-null field; wrong type → 422. */
export function fieldNullableInt(
  obj: Record<string, unknown>,
  key: string,
  requestId?: string,
): number | null | undefined {
  const value = obj[key];
  if (value === undefined || value === null) {
    return value as number | null | undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `${key} должен быть целым числом или null.`,
      { field: key },
      requestId,
    );
  }
  return value;
}

/**
 * Validate an `image`-kind icon value: an `http(s)://` URL or a `data:image/…`
 * URL within {@link ICON_MAX_BYTES}. Only meaningful when `icon_kind = 'image'`.
 */
export function assertImageIcon(icon: string | null | undefined, requestId?: string): void {
  if (icon === undefined || icon === null || icon === '') return;
  if (/^https?:\/\//i.test(icon)) return;
  const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/i.exec(icon);
  if (match === null) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'icon должен быть data:image URL или http(s) URL.',
      { field: 'icon' },
      requestId,
    );
  }
  const b64 = match[1] ?? '';
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((b64.length * 3) / 4) - padding;
  if (bytes > ICON_MAX_BYTES) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Файл иконки слишком большой (${bytes} байт; лимит ${ICON_MAX_BYTES}).`,
      { field: 'icon', limit: ICON_MAX_BYTES },
      requestId,
    );
  }
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
 * The `undefined` overload lets optional parameters (e.g. the layer-delete
 * `cascade` confirmation) stay absent.
 */
export function queryInt(
  value: unknown,
  fallback: number,
  opts: { field: string; min: number; requestId?: string },
): number;
export function queryInt(
  value: unknown,
  fallback: undefined,
  opts: { field: string; min: number; requestId?: string },
): number | undefined;
export function queryInt(
  value: unknown,
  fallback: number | undefined,
  opts: { field: string; min: number; requestId?: string },
): number | undefined {
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
