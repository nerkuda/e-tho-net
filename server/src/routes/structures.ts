/**
 * Structures-view routes (L15, 03-server-api.md §6.10, §6.11, §18).
 *
 *   POST   /networks/:networkId/thoughts/query        — filter thoughts (paged)
 *   GET    /networks/:networkId/thoughts/:id/hierarchy — one-level parents/children
 *   GET    /networks/:networkId/saved-filters          — list own saved filters
 *   POST   /networks/:networkId/saved-filters          — create (idempotent)
 *   PATCH  /networks/:networkId/saved-filters/:fid     — rename / redefine (idempotent)
 *   DELETE /networks/:networkId/saved-filters/:fid     — delete
 *
 * The query/hierarchy handlers are read-only (no idempotency pre-handler);
 * saved-filter mutations emit `saved-filter.*` events with audience=user so
 * the user's other clients refresh their lists.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  SAVED_FILTER_VIEWS,
  STRUCTURES_EDGES_MAX_IDS,
  STRUCTURES_PAGE_SIZE,
  STRUCTURES_QUERY_IDS_MAX_LIMIT,
  STRUCTURES_QUERY_MAX_LIMIT,
  STRUCTURE_SORTS,
  SORT_ORDERS,
  type SavedFilterView,
  type StructureQueryRequest,
  type StructureSort,
  type SortOrder,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  fieldString,
  openRouteNetworkDb,
  queryBoolean,
  requestBody,
  type RouteDeps,
} from './helpers.js';
import {
  createSavedFilter,
  deleteSavedFilter,
  getHierarchy,
  listSavedFilters,
  parseSavedFilterDefinition,
  parseStructureFilter,
  queryThoughtIds,
  queryThoughts,
  updateSavedFilter,
} from '../domain/structure-service.js';
import { parseChronicleFilterDefinition } from '../domain/chronicle-service.js';
import { getEdgesAmong } from '../domain/link-service.js';

/** Route params for `:networkId`. */
interface NetworkIdParams {
  networkId: string;
}

/** Route params for a network + thought id. */
interface ThoughtIdParams {
  networkId: string;
  id: string;
}

/** Route params for a network + saved-filter id. */
interface SavedFilterIdParams {
  networkId: string;
  fid: string;
}

/** Validate `view` against the shared enum tuple (default 'structures'). */
function parseView(value: unknown, requestId?: string): SavedFilterView {
  if (value === undefined || value === null || value === '') return 'structures';
  if (typeof value !== 'string' || !(SAVED_FILTER_VIEWS as readonly string[]).includes(value)) {
    throw new EtnError('VALIDATION_ERROR', 'Недопустимый view.', {
      field: 'view',
      allowed: SAVED_FILTER_VIEWS,
    }, requestId);
  }
  return value as SavedFilterView;
}

/** Validate `sort` against the shared enum tuple. */
function parseSort(value: unknown, requestId?: string): StructureSort {
  if (typeof value !== 'string' || !(STRUCTURE_SORTS as readonly string[]).includes(value)) {
    throw new EtnError('VALIDATION_ERROR', 'Недопустимый sort.', {
      field: 'sort',
      allowed: STRUCTURE_SORTS,
    }, requestId);
  }
  return value as StructureSort;
}

/** Validate `order` against the shared enum tuple. */
function parseOrder(value: unknown, requestId?: string): SortOrder {
  if (typeof value !== 'string' || !(SORT_ORDERS as readonly string[]).includes(value)) {
    throw new EtnError('VALIDATION_ERROR', 'Недопустимый order.', {
      field: 'order',
      allowed: SORT_ORDERS,
    }, requestId);
  }
  return value as SortOrder;
}

/** Parse the body of `POST /thoughts/query` into a typed request. */
function parseQueryBody(body: Record<string, unknown>, requestId: string): StructureQueryRequest {
  const filter = parseStructureFilter(body, requestId);
  const sort = parseSort(body['sort'] ?? 'created', requestId);
  const order = parseOrder(body['order'] ?? 'asc', requestId);
  const idsOnly = body['ids_only'] === true;
  const limitRaw = body['limit'];
  const limit =
    typeof limitRaw === 'number' && Number.isInteger(limitRaw)
      ? limitRaw
      : STRUCTURES_PAGE_SIZE;
  const offsetRaw = body['offset'];
  const offset =
    typeof offsetRaw === 'number' && Number.isInteger(offsetRaw) ? offsetRaw : 0;
  const maxLimit = idsOnly ? STRUCTURES_QUERY_IDS_MAX_LIMIT : STRUCTURES_QUERY_MAX_LIMIT;
  if (limit < 1 || limit > maxLimit) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `limit должен быть целым числом 1..${maxLimit}.`,
      { field: 'limit' },
      requestId,
    );
  }
  if (offset < 0) {
    throw new EtnError('VALIDATION_ERROR', 'offset должен быть целым числом ≥ 0.', {
      field: 'offset',
    }, requestId);
  }
  return { ...filter, sort, order, limit, offset, ...(idsOnly ? { ids_only: true } : {}) };
}

/** Parse the `exclude_ids` query parameter: a comma-separated id list. */
function parseExcludeIds(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** `/api/v1/networks*` structures routes plugin factory. */
export function createStructuresRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // --- Filter query (03-server-api.md §6.10) -------------------------------

    app.post(
      '/networks/:networkId/thoughts/query',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const query = parseQueryBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        // ids_only (L22): bare ids for the bulk filter commands — the same
        // candidate set and ordering, a higher limit ceiling, no meta flags.
        if (query.ids_only === true) {
          const result = queryThoughtIds(ndb, req.auth!.user.id, query, req.id);
          sendSuccess(reply, { ids: result.ids, total: result.total });
          return;
        }
        const result = queryThoughts(ndb, req.auth!.user.id, query, req.id);
        sendList(reply, result.items, result.total, query.offset, query.limit, {
          directions: result.directions,
        });
      },
    );

    // --- One-level hierarchy expansion (03-server-api.md §6.11) --------------

    app.get(
      '/networks/:networkId/thoughts/:id/hierarchy',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as ThoughtIdParams;
        const query = req.query as Record<string, unknown>;
        const dir = query['dir'];
        if (dir !== 'parents' && dir !== 'children') {
          throw new EtnError('VALIDATION_ERROR', 'dir должен быть parents или children.', {
            field: 'dir',
          }, req.id);
        }
        const showInactive =
          queryBoolean(query['show_inactive'], 'show_inactive', req.id) ?? false;
        const offsetRaw = query['offset'];
        const offset =
          typeof offsetRaw === 'string' && offsetRaw !== '' && Number.isInteger(Number(offsetRaw))
            ? Math.max(0, Number(offsetRaw))
            : 0;
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const data = getHierarchy(ndb, id, dir, {
          showInactive,
          excludeIds: parseExcludeIds(query['exclude_ids']),
          offset,
        });
        sendSuccess(reply, data);
      },
    );

    // --- Links among visible thoughts (03-server-api.md §6.12) ---------------

    app.post(
      '/networks/:networkId/thoughts/edges',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const body = requestBody(req);
        const idsRaw = body['ids'];
        if (!Array.isArray(idsRaw) || idsRaw.some((v) => typeof v !== 'string')) {
          throw new EtnError('VALIDATION_ERROR', 'ids должен быть массивом строк.', {
            field: 'ids',
          }, req.id);
        }
        const showInactive = body['show_inactive'] === true;
        const ids = (idsRaw as string[]).slice(0, STRUCTURES_EDGES_MAX_IDS);
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const edges = getEdgesAmong(ndb, ids, showInactive).map((l) => ({
          id: l.id,
          source_id: l.source_id,
          target_id: l.target_id,
          type_id: l.type_id,
          // Per-link line-style override (null = inherit from the type), §6.12.
          color: l.color,
          style: l.style,
          width: l.width,
        }));
        sendSuccess(reply, { edges });
      },
    );

    // --- Saved filters (03-server-api.md §18) --------------------------------

    app.get(
      '/networks/:networkId/saved-filters',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const view = parseView((req.query as Record<string, unknown>)['view'], req.id);
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        sendSuccess(reply, listSavedFilters(ndb, req.auth!.user.id, view));
      },
    );

    app.post(
      '/networks/:networkId/saved-filters',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const body = requestBody(req);
        const view = parseView(body['view'], req.id);
        const name = fieldString(body, 'name', req.id);
        if (name === undefined) {
          throw new EtnError('VALIDATION_ERROR', 'name обязателен.', { field: 'name' }, req.id);
        }
        const definitionRaw = body['definition'];
        if (typeof definitionRaw !== 'object' || definitionRaw === null) {
          throw new EtnError('VALIDATION_ERROR', 'definition обязателен.', {
            field: 'definition',
          }, req.id);
        }
        const definition =
          view === 'chronicle'
            ? parseChronicleFilterDefinition(definitionRaw as Record<string, unknown>, req.id)
            : parseSavedFilterDefinition(definitionRaw as Record<string, unknown>, req.id);
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const filter = createSavedFilter(ndb, req.auth!.user.id, view, name, definition);
        deps.emit(req, networkId, 'saved-filter.created', { filter }, { audience: 'user' });
        sendCreated(reply, filter, { request_id: req.id });
      },
    );

    app.patch(
      '/networks/:networkId/saved-filters/:fid',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, fid } = req.params as SavedFilterIdParams;
        const body = requestBody(req);
        const view = parseView(body['view'], req.id);
        const name = fieldString(body, 'name', req.id);
        let definition;
        const definitionRaw = body['definition'];
        if (definitionRaw !== undefined) {
          if (typeof definitionRaw !== 'object' || definitionRaw === null) {
            throw new EtnError('VALIDATION_ERROR', 'definition должен быть объектом.', {
              field: 'definition',
            }, req.id);
          }
          definition =
            view === 'chronicle'
              ? parseChronicleFilterDefinition(definitionRaw as Record<string, unknown>, req.id)
              : parseSavedFilterDefinition(definitionRaw as Record<string, unknown>, req.id);
        }
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const filter = updateSavedFilter(ndb, req.auth!.user.id, fid, {
          ...(name !== undefined ? { name } : {}),
          ...(definition !== undefined ? { definition } : {}),
        });
        deps.emit(req, networkId, 'saved-filter.updated', { filter }, { audience: 'user' });
        sendSuccess(reply, filter, { request_id: req.id });
      },
    );

    app.delete(
      '/networks/:networkId/saved-filters/:fid',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, fid } = req.params as SavedFilterIdParams;
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        deleteSavedFilter(ndb, req.auth!.user.id, fid);
        deps.emit(req, networkId, 'saved-filter.deleted', { id: fid }, { audience: 'user' });
        sendSuccess(reply, { id: fid });
      },
    );
  };
}
