/**
 * Trash routes (task S13, 03-server-api.md §14b).
 *
 *   GET  /networks/:networkId/trash        — marked-for-deletion thoughts/links
 *   POST /networks/:networkId/trash/purge  — delete every unblocked marked row
 *
 * The trash has no dedicated table: it is the set of rows with
 * `marked_for_deletion = 1` (02-data-model.md §3.1.2). Listing precomputes each
 * row's blocking check; purging physically deletes the unblocked ones and
 * silently skips the blocked ones.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { sendSuccess } from '../http/responses.js';
import { openRouteNetworkDb, type RouteDeps } from './helpers.js';
import { listTrash, purgeTrash } from '../domain/trash-service.js';

/** Route params for a network id. */
interface NetworkIdParams {
  networkId: string;
}

/** `/api/v1/networks*` trash routes plugin factory. */
export function createTrashRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.get(
      '/networks/:networkId/trash',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        sendSuccess(reply, listTrash(ndb));
      },
    );

    app.post(
      '/networks/:networkId/trash/purge',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const { purged, skipped, deleted_thought_ids, deleted_link_ids } = purgeTrash(ndb);
        // Fan out the standard deletion events so connected clients refresh.
        for (const id of deleted_thought_ids) {
          deps.emit(req, networkId, 'thought.deleted', { id });
        }
        for (const id of deleted_link_ids) {
          deps.emit(req, networkId, 'link.deleted', { id });
        }
        sendSuccess(reply, { purged, skipped });
      },
    );
  };
}
