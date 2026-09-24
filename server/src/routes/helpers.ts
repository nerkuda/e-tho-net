/**
 * Транспортные хелперы REST-слоя (задача c9d5f21e, веха 8 версии 0.8.2).
 *
 * До вехи 8 здесь жили и полевые парсеры входа (`fieldString`, `queryInt`,
 * `parseIfMatch` и т.п.). Они удалены: валидация входа описывается едиными
 * контрактами в `server/src/contracts.ts` (одна схема на операцию для REST и
 * MCP) и исполняется `parseRest`/`parseBody`.
 *
 * Остались только транспортные заботы, которые повторяются в роутах:
 * открытие базы сети в контексте слоя сессии, резолв слоя, чтение тела
 * запроса как объекта и обёртки фильтра типов связей (shared-домен).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  BASE_LAYER_ID,
  EtnError,
  PREF_KEY,
  type LayerEcho,
  type LinkTypeFilterInput,
  type RealtimeAudience,
  type RealtimeEventMap,
  type RealtimeEventType,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { openNetworkDb } from '../db/network-db.js';
export { openNetworkDb };
import { SystemDb } from '../db/system-db.js';
import { resolveSessionLayer } from '../domain/layer-service.js';
import { parseLinkTypeFilterValue } from '@etn/shared';
import type { Logger } from '../logger.js';
import type { WriteFx } from '../domain/write-wrapper.js';
export { actionOfChanges, runWrite } from '../domain/write-wrapper.js';
export type {
  AnyWriteEvent,
  WriteActivityEntry,
  WriteAuditEntry,
  WriteFx,
  WriteOutcome,
} from '../domain/write-wrapper.js';

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
        ? resolveSessionLayer(
            openNetworkDb(dataDir, networkId, log, BASE_LAYER_ID),
            auth.user.id,
            auth.clientId,
          )
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
export function openRouteNetworkDbBase(
  deps: RouteDeps,
  networkId: string,
  log?: Logger,
): NetworkDb {
  return openNetworkDb(deps.dataDir, networkId, log, BASE_LAYER_ID);
}

/** Read a request body that may be absent (empty payload → `{}`). */
export function requestBody(req: FastifyRequest): Record<string, unknown> {
  if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
    // BAD_REQUEST поднимается в parseRest; здесь — только защита типа.
    return {};
  }
  return req.body as Record<string, unknown>;
}

/**
 * Resolve the `show_trash` visibility flag (задача 77923b49, 0.8.2): an
 * explicit request-level override wins, otherwise the user's network
 * preference `preferences.show_trash`. Default is `true` — помеченные на
 * удаление элементы видны с признаком корзины (поведение после 355319d4);
 * `false` прячет их на карте, локальном графе и в структурах.
 */
export function resolveShowTrash(
  app: FastifyInstance,
  userId: string,
  networkId: string,
  override?: boolean,
): boolean {
  if (override !== undefined) return override;
  const pref = app.systemDb.getNetworkPreference(userId, networkId, PREF_KEY.SHOW_TRASH);
  return pref?.value !== false;
}

/**
 * Контекст записи REST-фасада для обёртки домена ({@link runWrite},
 * ADR 162d8e7a): актор и слой сессии — из запроса (слой к этому моменту уже
 * резолвлен открытием `ndb`), транспорт событий — `deps.emit`. Аудита для
 * data-записей REST не ведёт (audit_log пишут только admin/me/networks-роуты,
 * работающие с `_system.db`, и MCP-инструменты — 05 §6.1).
 */
export function restWriteFx(deps: RouteDeps, req: FastifyRequest, networkId: string): WriteFx {
  return {
    networkId,
    userId: req.auth?.user.id ?? '',
    layerId: req.layerEcho?.id ?? null,
    emit: (type, data, options) => deps.emit(req, networkId, type, data, options),
  };
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

// ---------------------------------------------------------------------------
// Traversal link-type filter (задача c965ad03, 0.8.1, требование bed23c25)
// ---------------------------------------------------------------------------

/**
 * Parse the traversal link-type filter from a JSON body field `link_filter`
 * (shape validation in `parseLinkTypeFilterValue`). `undefined` when the
 * field is absent — the caller keeps the historical "walk every edge"
 * behaviour.
 */
export function parseLinkTypeFilter(
  obj: Record<string, unknown>,
  requestId?: string,
): LinkTypeFilterInput | undefined {
  return parseLinkTypeFilterValue(obj['link_filter'], requestId);
}

/**
 * Parse the same filter from repeatable query parameters — `link_type_id`
 * (repeatable id list) plus `include_structural=true/false`. `undefined`
 * when neither parameter is present; both present but yielding an empty
 * filter (no ids, no structural) → `VALIDATION_ERROR`.
 */
export function parseLinkTypeFilterQuery(
  query: Record<string, unknown>,
  requestId?: string,
): LinkTypeFilterInput | undefined {
  const typeIds = queryStrings(query['link_type_id']);
  const includeStructuralRaw = query['include_structural'];
  const includeStructural =
    typeof includeStructuralRaw === 'string' &&
    (includeStructuralRaw === 'true' || includeStructuralRaw === '1')
      ? true
      : typeof includeStructuralRaw === 'string' &&
          (includeStructuralRaw === 'false' || includeStructuralRaw === '0')
        ? false
        : undefined;
  if (typeIds.length === 0 && includeStructural === undefined) return undefined;
  if (typeIds.length === 0 && includeStructural !== true) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'фильтр типов связей пуст: укажите link_type_id и/или include_structural=true.',
      { field: 'link_type_id' },
      requestId,
    );
  }
  const out: LinkTypeFilterInput = {};
  if (typeIds.length > 0) out.type_ids = typeIds;
  if (includeStructural === true) out.include_structural = true;
  return out;
}

/**
 * Перечень сетей, к которым пользователь имеет доступ (member/admin).
 * Используется для cross-network ссылок (задача 7849008a): живой резолв
 * открывает только те сети, которые видны пользователю, иначе значение
 * молча помечается `unresolved` с причиной `permission_denied`
 * (требование 6d4ad9ac «Чтение кросс-сетевого значения не открывает
 * чужих баз»). Возвращаемый набор включает все сети пользователя —
 * в т.ч. текущую (для удобства вызывающего, проверка «своя сеть» идёт
 * отдельно в {@link resolveAndBuildSnapshotsForWrite}).
 *
 * Открывает системную БД на каждый вызов — это допустимо, потому что
 * `_system.db` — маленький WAL-файл, читается из кэша ОС, и вызов
 * идёт только на живой резолв/запись кросс-сетевого значения (не на
 * каждый запрос).
 */
export async function getAccessibleNetworkIdsForUser(
  dataDir: string,
  userId: string,
  log?: Logger,
): Promise<ReadonlySet<string>> {
  const sysDb = SystemDb.open(dataDir, log);
  try {
    const networks = sysDb.listNetworksForUser(userId);
    return new Set(networks.map((n) => n.id));
  } finally {
    sysDb.close();
  }
}
