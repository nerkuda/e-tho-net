/**
 * Pinned-thoughts routes (L18, docs/03-server-api.md §19).
 *
 *   GET /networks/:networkId/pins — the user's pinned thoughts (position order)
 *   PUT /networks/:networkId/pins — replace the list (idempotent, ≤20)
 *
 * `GET` is read-only; `PUT` emits `pinned-thoughts.updated` with audience=user
 * so the user's other clients refresh their panels.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError } from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import { fieldStringArray, openRouteNetworkDb, requestBody, type RouteDeps } from './helpers.js';
import { listPinnedThoughts, setPinnedThoughts } from '../domain/pin-service.js';

/** Route params for `:networkId`. */
interface NetworkIdParams {
  networkId: string;
}

/** `/api/v1/networks*` pinned-thoughts routes plugin factory. */
export function createPinsRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.get(
      '/networks/:networkId/pins',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        sendSuccess(reply, listPinnedThoughts(ndb, req.auth!.user.id));
      },
    );

    app.put(
      '/networks/:networkId/pins',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const body = requestBody(req);
        const orderedIds = fieldStringArray(body, 'ordered_ids', req.id);
        if (orderedIds === undefined) {
          throw new EtnError('VALIDATION_ERROR', 'ordered_ids обязателен.', {
            field: 'ordered_ids',
          }, req.id);
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const pins = setPinnedThoughts(ndb, req.auth!.user.id, orderedIds);
        deps.emit(req, networkId, 'pinned-thoughts.updated', { ordered_ids: orderedIds }, {
          audience: 'user',
        });
        sendSuccess(reply, pins, { request_id: req.id });
      },
    );
  };
}
