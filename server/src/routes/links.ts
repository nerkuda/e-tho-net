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
import {
  fieldBoolean,
  fieldNullableInt,
  fieldNullableString,
  fieldString,
  fieldStringArray,
  openNetworkDb,
  openRouteNetworkDb,
  parseIfMatch,
  parseLinkStyle,
  queryBoolean,
  queryStrings,
  requestBody,
  type RouteDeps,
} from './helpers.js';
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

/** Parse and validate the body of `PATCH /links/:id`. */
function parseLinkUpdateBody(body: Record<string, unknown>, requestId: string): LinkUpdateInput {
  const changes: LinkUpdateInput = {};
  // Endpoints change together (swapping them inverts the link's direction).
  if (body.source_id !== undefined || body.target_id !== undefined) {
    const sourceId = fieldString(body, 'source_id', requestId);
    const targetId = fieldString(body, 'target_id', requestId);
    if (sourceId === undefined || targetId === undefined) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'source_id и target_id меняются вместе.',
        { field: 'source_id' },
        requestId,
      );
    }
    changes.source_id = sourceId;
    changes.target_id = targetId;
  }
  if (body.type_id !== undefined) {
    changes.type_id = fieldNullableString(body, 'type_id', requestId);
  }
  if (body.color !== undefined) {
    changes.color = fieldNullableString(body, 'color', requestId);
  }
  if (body.style !== undefined) {
    changes.style = parseLinkStyle(fieldNullableString(body, 'style', requestId), requestId);
  }
  if (body.width !== undefined) {
    changes.width = fieldNullableInt(body, 'width', requestId);
  }
  if (body.active !== undefined) {
    changes.active = fieldBoolean(body, 'active', requestId);
  }
  if (body.marked_for_deletion !== undefined) {
    changes.marked_for_deletion = fieldBoolean(body, 'marked_for_deletion', requestId);
  }
  return changes;
}

/** `/api/v1/networks*` link routes plugin factory. */
export function createLinksRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.get(
      '/networks/:networkId/links/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as LinkIdParams;
        // `at_layer_id` — открыть связь по id в конкретном слое, не
        // переключая сессию (лента событий, задача 59119797).
        const atLayerId = queryStrings((req.query as Record<string, unknown> | undefined)?.['at_layer_id'])[0] ?? null;
        const ndb =
          atLayerId !== null
            ? openNetworkDb(deps.dataDir, networkId, app.appLogger, atLayerId)
            : openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const link = getLink(ndb, id);
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
        const { networkId, id } = req.params as LinkIdParams;
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const changes = parseLinkUpdateBody(requestBody(req), req.id);
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
        const { networkId, id } = req.params as LinkIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        sendSuccess(reply, checkLinkDeletion(ndb, id));
      },
    );

    app.post(
      '/networks/:networkId/links/deletion-check-batch',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as LinkIdParams;
        const ids = fieldStringArray(requestBody(req), 'ids', req.id);
        if (ids === undefined || ids.length === 0) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'ids обязателен (непустой массив строк).',
            { field: 'ids' },
            req.id,
          );
        }
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
        const { networkId, id } = req.params as ThoughtIdParams;
        const query = req.query as Record<string, unknown>;
        const group = queryStrings(query.group)[0];
        if (group !== undefined && group !== 'type') {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Поддерживается только group=type.',
            { field: 'group' },
            req.id,
          );
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const grouped = listLinksByThought(ndb, id, {
          showInactive: queryBoolean(query.show_inactive, 'show_inactive', req.id) === true,
        });
        sendSuccess(reply, grouped);
      },
    );
  };
}
