/**
 * Property-value routes (task D4, 03-server-api.md §9).
 *
 *   GET    /networks/:networkId/thoughts/:id/properties            — list values
 *   PUT    /networks/:networkId/thoughts/:id/properties/:key       — upsert by key
 *   DELETE /networks/:networkId/thoughts/:id/properties/:key       — remove by key
 *   … and the same three under /networks/:networkId/links/:id/properties
 *
 * `PUT` is an upsert; the value is validated against the property definition
 * of the owner's type by the property service (unknown property → 404,
 * wrong-typed value → 422). The property key is addressed by path segment, so
 * an empty key cannot match the route; the service double-checks anyway.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError, type PropertyOwnerType, type PropertyValueValue } from '@etn/shared';

import { sendList, sendSuccess } from '../http/responses.js';
import { openRouteNetworkDb, requestBody, type RouteDeps } from './helpers.js';
import {
  deletePropertyValue,
  getPropertyValues,
  setPropertyValue,
} from '../domain/property-service.js';

/** Route params for a network + owner id. */
interface OwnerParams {
  networkId: string;
  id: string;
}

/** Route params for a network + owner id + property key. */
interface OwnerKeyParams {
  networkId: string;
  id: string;
  key: string;
}

/** `/api/v1/networks*` property-value routes plugin factory. */
export function createPropertiesRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    /** Register the three value endpoints for one owner kind. */
    const registerOwnerRoutes = (pathBase: string, ownerType: PropertyOwnerType) => {
      app.get(
        `${pathBase}/properties`,
        { preHandler: [app.authPreHandler, requireNetworkMember()] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id } = req.params as OwnerParams;
          const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
          const values = getPropertyValues(ndb, ownerType, id);
          sendList(reply, values, values.length, 0, values.length);
        },
      );

      app.put(
        `${pathBase}/properties/:key`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id, key } = req.params as OwnerKeyParams;
          if (key.trim() === '') {
            throw new EtnError(
              'VALIDATION_ERROR',
              'Ключ свойства не может быть пустым.',
              { field: 'key' },
              req.id,
            );
          }
          const body = requestBody(req);
          if (!('value' in body)) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'Поле value обязательно.',
              { field: 'value' },
              req.id,
            );
          }
          const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
          const value = setPropertyValue(ndb, ownerType, id, key, body.value as PropertyValueValue);
          sendSuccess(reply, value);
        },
      );

      app.delete(
        `${pathBase}/properties/:key`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id, key } = req.params as OwnerKeyParams;
          const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
          deletePropertyValue(ndb, ownerType, id, key);
          reply.code(204).send();
        },
      );
    };

    registerOwnerRoutes('/networks/:networkId/thoughts/:id', 'thought');
    registerOwnerRoutes('/networks/:networkId/links/:id', 'link');
  };
}
