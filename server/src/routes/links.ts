/**
 * Link routes (task D2, 03-server-api.md §7).
 *
 *   GET    /networks/:networkId/links/:id                  — fetch one
 *   PATCH  /networks/:networkId/links/:id                  — update endpoints/type/active (If-Match)
 *   GET    /networks/:networkId/thoughts/:id/links?group=type — grouped editor view
 *
 * 0.8.1 (требование 3ea5c6af): создание и удаление связей отдельными операциями
 * упразднено — `POST /links` и `DELETE /links/{id}` сняты, они ушли в операции
 * над свойствами-связями. От семейства остаётся восстановление из корзины через
 * `PATCH /links/{id}` (`marked_for_deletion: false`).
 *
 * All routes require network membership. Invariants (self-loops, duplicate
 * pairs, unknown endpoints/types) are enforced by the link domain service.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError, type LinkUpdateInput } from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import { openNetworkDb, openRouteNetworkDb, type RouteDeps } from './helpers.js';
import {
  parseRest,
  RestLinkDeletionCheck,
  RestLinkDeletionCheckBatch,
  RestLinkGet,
  RestLinkPatch,
  RestLinksByThought,
} from '../contracts.js';
import {
  checkLinkDeletion,
  getLink,
  listLinksByThought,
  updateLink,
} from '../domain/link-service.js';
import { recordLinkActivity } from '../domain/activity-service.js';

/** Route params for a network + link id. */
interface LinkIdParams {
  networkId: string;
  id: string;
}

/** Route params for a network + thought id (grouped listing). */
interface ThoughtIdParams {
  networkId: string;
  id: string;
}

/** `/api/v1/networks*` link routes plugin factory. */
export function createLinksRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.get(
      '/networks/:networkId/links/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestLinkGet, req);
        const networkId = input.network_id;
        // `at_layer_id` — открыть связь по id в конкретном слое, не
        // переключая сессию (лента событий, задача 59119797).
        const atLayerId = (input.at_layer_id as string | undefined) ?? null;
        const ndb =
          atLayerId !== null
            ? openNetworkDb(deps.dataDir, networkId, app.appLogger, atLayerId)
            : openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const link = getLink(ndb, input.link_id);
        if (link === null) {
          throw new EtnError('NOT_FOUND', 'Связь не найдена.', undefined, req.id);
        }
        sendSuccess(reply, link);
      },
    );

    app.patch(
      '/networks/:networkId/links/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestLinkPatch, req);
        const { network_id: networkId, link_id: id, expected_version: expectedVersion } = input;
        const changes: LinkUpdateInput = {};
        if (input.source_id !== undefined || input.target_id !== undefined) {
          changes.source_id = input.source_id as string;
          changes.target_id = input.target_id as string;
        }
        if (input.type_id !== undefined) changes.type_id = input.type_id as string | null;
        if (input.color !== undefined) changes.color = input.color as string | null;
        if (input.style !== undefined) changes.style = input.style as LinkUpdateInput['style'];
        if (input.width !== undefined) changes.width = input.width as number | null;
        if (input.active !== undefined) changes.active = input.active as boolean;
        if (input.marked_for_deletion !== undefined) changes.marked_for_deletion = input.marked_for_deletion as boolean;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const link = updateLink(ndb, id, changes, expectedVersion, req.auth!.user.id);
        if (link.id !== id) {
          // S14 (13-layers.md §6.1): an endpoint change in a working layer is
          // tombstone + insert — the link identity changes, so subscribers see
          // delete + create, not an update of a row they may no longer resolve.
          deps.emit(req, networkId, 'link.deleted', { id });
          deps.emit(req, networkId, 'link.created', { link });
          // В журнале фиксируем новое состояние как «обновление»: старая
          // запись уже помечена на удаление в текущем слое.
          recordLinkActivity(ndb, {
            networkId,
            userId: req.auth!.user.id,
            action: 'updated',
            link,
            layerId: req.layerEcho?.id ?? null,
          });
        } else {
          deps.emit(req, networkId, 'link.updated', {
            id,
            changes,
            version: link.version,
          });
          recordLinkActivity(ndb, {
            networkId,
            userId: req.auth!.user.id,
            action: changes.marked_for_deletion === true
              ? 'trashed'
              : changes.marked_for_deletion === false
                ? 'restored'
                : 'updated',
            link,
            layerId: req.layerEcho?.id ?? null,
          });
        }
        sendSuccess(reply, link, {
          version: link.version,
          updated_at: link.updated_at,
          request_id: req.id,
        });
      },
    );

    // --- Deletion check (03-server-api.md §6.5a, task S13) -------------------

    app.get(
      '/networks/:networkId/links/:id/deletion-check',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestLinkDeletionCheck, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        sendSuccess(reply, checkLinkDeletion(ndb, input.link_id));
      },
    );

    app.post(
      '/networks/:networkId/links/deletion-check-batch',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestLinkDeletionCheckBatch, req);
        const networkId = input.network_id;
        const ids = input.ids as string[];
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const result: Record<string, import('@etn/shared').LinkDeletionCheckResult> = {};
        for (const id of [...new Set(ids)]) {
          result[id] = checkLinkDeletion(ndb, id);
        }
        sendSuccess(reply, result);
      },
    );

    // Grouped listing for the editor (03-server-api.md §7.2). Only `group=type`
    // is defined; anything else is rejected rather than silently ignored.
    app.get(
      '/networks/:networkId/thoughts/:id/links',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestLinksByThought, req);
        const networkId = input.network_id;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const grouped = listLinksByThought(ndb, input.thought_id, {
          showInactive: input.show_inactive === true,
        });
        sendSuccess(reply, grouped);
      },
    );
  };
}
