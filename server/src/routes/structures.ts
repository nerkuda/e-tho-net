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
import { openRouteNetworkDb, requestBody, type RouteDeps } from './helpers.js';
import {
  csvToList,
  parseBody,
  parseRest,
  RestEdgesBody,
  RestHierarchyQuery,
  RestSavedFilterCreateBody,
  RestSavedFilterPatchBody,
  RestSavedFilterViewQuery,
  RestStructureQueryBody,
} from '../contracts.js';
import {
  createSavedFilter,
  deleteSavedFilter,
  getHierarchy,
  listSavedFilters,
  parseSavedFilterDefinition,
  parseStructureFilter,
  updateSavedFilter,
} from '../domain/structure-service.js';
import {
  queryThoughtIds,
  queryThoughts,
  structureRequestToQuery,
} from '../domain/query-service.js';
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

/** Разобрать тело POST /thoughts/query: обёртку валидирует контракт,
 *  фильтр — shared-парсер parseStructureFilter (домен); лимиты — как раньше. */
function parseQueryBody(body: Record<string, unknown>, requestId: string): StructureQueryRequest {
  const out = parseBody(RestStructureQueryBody, body, requestId);
  const filter = parseStructureFilter(body, requestId);
  const sort = (out.sort ?? 'created') as StructureSort;
  const order = (out.order ?? 'asc') as SortOrder;
  const idsOnly = out.ids_only === true;
  const limit = (out.limit as number | undefined) ?? STRUCTURES_PAGE_SIZE;
  const offset = (out.offset as number | undefined) ?? 0;
  const maxLimit = idsOnly ? STRUCTURES_QUERY_IDS_MAX_LIMIT : STRUCTURES_QUERY_MAX_LIMIT;
  if (limit < 1 || limit > maxLimit) {
    throw new EtnError('VALIDATION_ERROR', `limit должен быть целым числом 1..${maxLimit}.`, { field: 'limit' }, requestId);
  }
  if (offset < 0) {
    throw new EtnError('VALIDATION_ERROR', 'offset должен быть целым числом ≥ 0.', { field: 'offset' }, requestId);
  }
  return { ...filter, sort, order, limit, offset, ...(idsOnly ? { ids_only: true } : {}) };
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
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // Единый движок выборки (задача c5265deb): REST-фильтр переводится в
        // канонический запрос и исполняется общей доменной функцией.
        // ids_only (L22): bare ids for the bulk filter commands — the same
        // candidate set and ordering, a higher limit ceiling, no meta flags.
        if (query.ids_only === true) {
          const result = queryThoughtIds(
            ndb,
            req.auth!.user.id,
            structureRequestToQuery(query),
            { maxLimit: STRUCTURES_QUERY_IDS_MAX_LIMIT, emptyFilterMode: 'home_orphans' },
          );
          sendSuccess(reply, { ids: result.ids, total: result.total });
          return;
        }
        const result = queryThoughts(
          ndb,
          req.auth!.user.id,
          structureRequestToQuery(query),
          { maxLimit: STRUCTURES_QUERY_MAX_LIMIT, emptyFilterMode: 'home_orphans', includeDirections: true },
        );
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
        const input = parseRest(RestHierarchyQuery, req);
        const networkId = input.network_id as string;
        const dir = input.dir as 'parents' | 'children';
        const showInactive = (input.show_inactive as boolean | undefined) ?? false;
        const offset = input.offset ?? 0;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const data = getHierarchy(ndb, input.thought_id, dir, {
          showInactive,
          excludeIds: csvToList((req.query as Record<string, unknown>)['exclude_ids']),
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
        const input = parseRest(RestEdgesBody, req);
        const networkId = input.network_id as string;
        const ids = (input.ids as string[]).slice(0, STRUCTURES_EDGES_MAX_IDS);
        const showInactive = input.show_inactive === true;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
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
        const view = (parseRest(RestSavedFilterViewQuery, req).view ?? 'structures') as SavedFilterView;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        sendSuccess(reply, listSavedFilters(ndb, req.auth!.user.id, view));
      },
    );

    app.post(
      '/networks/:networkId/saved-filters',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const input = parseRest(RestSavedFilterCreateBody, req);
        const view = (input.view ?? 'structures') as SavedFilterView;
        const name = input.name as string;
        const definitionRaw = input.definition;
        const definition =
          view === 'chronicle'
            ? parseChronicleFilterDefinition(definitionRaw as Record<string, unknown>, req.id)
            : parseSavedFilterDefinition(definitionRaw as Record<string, unknown>, req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
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
        const input = parseRest(RestSavedFilterPatchBody, req);
        const view = (input.view ?? 'structures') as SavedFilterView;
        const name = input.name as string | undefined;
        let definition;
        const definitionRaw = input.definition;
        if (definitionRaw !== undefined) {
          definition =
            view === 'chronicle'
              ? parseChronicleFilterDefinition(definitionRaw as Record<string, unknown>, req.id)
              : parseSavedFilterDefinition(definitionRaw as Record<string, unknown>, req.id);
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
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
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        deleteSavedFilter(ndb, req.auth!.user.id, fid);
        deps.emit(req, networkId, 'saved-filter.deleted', { id: fid }, { audience: 'user' });
        sendSuccess(reply, { id: fid });
      },
    );
  };
}
