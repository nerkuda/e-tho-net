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
import { recordLinkActivity, recordThoughtActivity } from '../domain/activity-service.js';
import { getLink } from '../domain/link-service.js';
import { getThought } from '../domain/thought-service.js';

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
        // Сохраняем снимки мыслей и связей, помеченных на удаление, ДО
        // физического удаления — после purgeTrash строк в `thoughts`/`links`
        // уже нет, и для activity_log нужен короткий снимок на момент
        // операции (требование b0c7a57c).
        const trash = listTrash(ndb);
        const thoughtSnapshots = new Map(trash.thoughts.map((t) => [t.id, t]));
        const linkSnapshots = new Map(trash.links.map((l) => [l.id, l]));
        const { purged, skipped, deleted_thought_ids, deleted_link_ids } = purgeTrash(ndb);
        const layerId = req.layerEcho?.id ?? null;
        const userId = req.auth!.user.id;
        // Fan out the standard deletion events so connected clients refresh.
        for (const id of deleted_thought_ids) {
          const snapshot = thoughtSnapshots.get(id);
          deps.emit(req, networkId, 'thought.deleted', { id });
          if (snapshot) {
            recordThoughtActivity(ndb, {
              networkId,
              userId,
              action: 'deleted',
              thought: snapshot,
              layerId,
            });
          }
        }
        for (const id of deleted_link_ids) {
          const snapshot = linkSnapshots.get(id);
          deps.emit(req, networkId, 'link.deleted', { id });
          if (snapshot) {
            recordLinkActivity(ndb, {
              networkId,
              userId,
              action: 'deleted',
              link: snapshot,
              layerId,
            });
          }
        }
        sendSuccess(reply, { purged, skipped });
      },
    );
  };
}
