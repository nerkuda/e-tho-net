/**
 * Pinned-thoughts routes (L18, docs/03-server-api.md §19).
 *
 *   GET /networks/:networkId/pins — the user's pinned thoughts (position order)
 *   PUT /networks/:networkId/pins — replace the list (idempotent, ≤20)
 *
 * `GET` is read-only; `PUT` emits `pinned-thoughts.updated` with audience=user
 * so the user's other clients refresh their panels.
 *
 * Веха 8 (задача c9d5f21e): вход — единые контракты из `contracts.ts`.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { sendSuccess } from '../http/responses.js';
import { openRouteNetworkDb, restWriteFx, runWrite, type RouteDeps } from './helpers.js';
import { listPinnedThoughts, setPinnedThoughts } from '../domain/pin-service.js';
import { parseRest, RestPinsGet, RestPinsPut } from '../contracts.js';

/** `/api/v1/networks*` pinned-thoughts routes plugin factory. */
export function createPinsRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.get(
      '/networks/:networkId/pins',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPinsGet, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        sendSuccess(reply, listPinnedThoughts(ndb, req.auth!.user.id));
      },
    );

    app.put(
      '/networks/:networkId/pins',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestPinsPut, req);
        const orderedIds = input.ordered_ids as string[];
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const pins = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => ({
          result: setPinnedThoughts(ndb, req.auth!.user.id, orderedIds),
          events: [
            {
              type: 'pinned-thoughts.updated',
              data: { ordered_ids: orderedIds },
              options: { audience: 'user' },
            },
          ],
        }));
        sendSuccess(reply, pins, { request_id: req.id });
      },
    );
  };
}
