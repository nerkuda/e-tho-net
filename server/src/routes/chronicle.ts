/**
 * Chronicle-view routes (L20, 03-server-api.md §20).
 *
 *   POST /networks/:networkId/chronicle/query — two-phase chronological-comment
 *     query (thoughts → their chronological comments + link comments).
 *
 * The query handler is read-only (no idempotency pre-handler); saved filters
 * of the chronicle view reuse the shared `/saved-filters` endpoints with
 * `view = 'chronicle'` (03-server-api.md §18).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { sendList } from '../http/responses.js';
import { openRouteNetworkDb, requestBody, type RouteDeps } from './helpers.js';
import { parseChronicleQueryBody, queryChronicle } from '../domain/chronicle-service.js';

/** Route params for `:networkId`. */
interface NetworkIdParams {
  networkId: string;
}

/** `/api/v1/networks*` chronicle routes plugin factory. */
export function createChronicleRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.post(
      '/networks/:networkId/chronicle/query',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const query = parseChronicleQueryBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const result = queryChronicle(ndb, query);
        sendList(reply, result.rows, result.total, query.offset, query.limit);
      },
    );
  };
}
