/**
 * Link routes (task D2, 03-server-api.md §7).
 *
 *   POST   /networks/:networkId/links                      — create a directed link
 *   GET    /networks/:networkId/links/:id                  — fetch one
 *   PATCH  /networks/:networkId/links/:id                  — update type/active (If-Match)
 *   DELETE /networks/:networkId/links/:id                  — delete (If-Match)
 *   GET    /networks/:networkId/thoughts/:id/links?group=type — grouped editor view
 *
 * All routes require network membership. Invariants (self-loops, duplicate
 * pairs, unknown endpoints/types) are enforced by the link domain service.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError, type LinkCreateInput, type LinkUpdateInput } from '@etn/shared';

import { sendCreated, sendSuccess } from '../http/responses.js';
import {
  fieldBoolean,
  fieldNullableString,
  fieldString,
  openRouteNetworkDb,
  parseIfMatch,
  queryBoolean,
  queryStrings,
  requestBody,
  type RouteDeps,
} from './helpers.js';
import {
  createLink,
  deleteLink,
  getLink,
  listLinksByThought,
  updateLink,
} from '../domain/link-service.js';

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

/** Parse and validate the body of `POST /links`. */
function parseLinkCreateBody(body: Record<string, unknown>, requestId: string): LinkCreateInput {
  const sourceId = fieldString(body, 'source_id', requestId);
  const targetId = fieldString(body, 'target_id', requestId);
  if (sourceId === undefined || sourceId === '' || targetId === undefined || targetId === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'source_id и target_id обязательны.',
      { field: 'source_id' },
      requestId,
    );
  }
  return {
    source_id: sourceId,
    target_id: targetId,
    type_id: fieldNullableString(body, 'type_id', requestId),
    active: fieldBoolean(body, 'active', requestId),
  };
}

/** Parse and validate the body of `PATCH /links/:id`. */
function parseLinkUpdateBody(body: Record<string, unknown>, requestId: string): LinkUpdateInput {
  const changes: LinkUpdateInput = {};
  if (body.type_id !== undefined) {
    changes.type_id = fieldNullableString(body, 'type_id', requestId);
  }
  if (body.active !== undefined) {
    changes.active = fieldBoolean(body, 'active', requestId);
  }
  return changes;
}

/** `/api/v1/networks*` link routes plugin factory. */
export function createLinksRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.post(
      '/networks/:networkId/links',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as LinkIdParams;
        const input = parseLinkCreateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const link = createLink(ndb, input, req.auth!.user.id);
        sendCreated(reply, link, {
          version: link.version,
          updated_at: link.updated_at,
          request_id: req.id,
        });
      },
    );

    app.get(
      '/networks/:networkId/links/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as LinkIdParams;
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
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
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const link = updateLink(ndb, id, changes, expectedVersion, req.auth!.user.id);
        sendSuccess(reply, link, {
          version: link.version,
          updated_at: link.updated_at,
          request_id: req.id,
        });
      },
    );

    app.delete(
      '/networks/:networkId/links/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as LinkIdParams;
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        deleteLink(ndb, id, expectedVersion);
        reply.code(204).send();
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
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const grouped = listLinksByThought(ndb, id, {
          showInactive: queryBoolean(query.show_inactive, 'show_inactive', req.id) === true,
        });
        sendSuccess(reply, grouped);
      },
    );
  };
}
