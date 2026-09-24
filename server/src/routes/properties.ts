/**
 * Property-value routes (task D4, 03-server-api.md §9).
 *
 *   GET    /networks/:networkId/thoughts/:id/properties                            — list values
 *   PUT    /networks/:networkId/thoughts/:id/properties/:key                       — upsert by key
 *   DELETE /networks/:networkId/thoughts/:id/properties/:key                       — remove by key
 *   POST   /networks/:networkId/thoughts/:id/properties/:key/cross-resolve        — cross-network resolve
 *   … and the same four under /networks/:networkId/links/:id/properties
 *
 * `PUT` is an upsert; the value is validated against the property definition
 * of the owner's type by the property service (unknown property → 404,
 * wrong-typed value → 422). The property key is addressed by path segment, so
 * an empty key cannot match the route; the service double-checks anyway.
 *
 * `cross-resolve` (задача 7849008a, спека 737ed900) — служебная операция
 * явного резолва значений `cross_network_ref`: открывает целевые сети и
 * обновляет снапшоты имён. Служебная запись без write-бюджета и
 * audit-записи (требование c104a0fc).
 *
 * Веха 8 (задача c9d5f21e): вход — единые контракты из `contracts.ts`.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  type PropertyCrossResolveResult,
  type PropertyOwnerType,
  type PropertyValueValue,
} from '@etn/shared';

import { sendList, sendSuccess } from '../http/responses.js';
import { openRouteNetworkDb, restWriteFx, runWrite, type RouteDeps } from './helpers.js';
import {
  crossResolvePropertyValue,
  deletePropertyValue,
  getPropertyValuesWithLinks,
  setPropertyValue,
} from '../domain/property-service.js';
import type { CrossNetworkAccessContext } from '../domain/cross-network-ref-service.js';
import { getAccessibleNetworkIdsForUser } from './helpers.js';
import { getThought } from '../domain/thought-service.js';
import { getLink } from '../domain/link-service.js';
import {
  parseRest,
  RestPropertyCrossResolve,
  RestPropertyDelete,
  RestPropertyList,
  RestPropertyPut,
} from '../contracts.js';

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
          const input = parseRest(RestPropertyList, req);
          const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
          // Задача 7849008a, требование 6d4ad9ac: фильтр прав для
          // `cross_network_ref` — список сетей пользователя запрашивается из
          // системной БД; нет прав на сеть → значение молча отфильтровывается.
          const accessibleIds = await getAccessibleNetworkIdsForUser(
            deps.dataDir,
            req.auth!.user.id,
            app.appLogger,
          );
          const values = getPropertyValuesWithLinks(ndb, ownerType, input.owner_id, accessibleIds);
          sendList(reply, values, values.length, 0, values.length);
        },
      );

      app.put(
        `${pathBase}/properties/:key`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const input = parseRest(RestPropertyPut, req);
          const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
          // Контекст для кросс-сетевой записи (задача 7849008a): нужен только
          // если значение окажется `cross_network_ref`. Резолвим заранее —
          // для других value_type это лишний вызов systemDb, но он дёшев
          // (WAL-кэш).
          const accessibleIds = await getAccessibleNetworkIdsForUser(
            deps.dataDir,
            req.auth!.user.id,
            app.appLogger,
          );
          const crossCtx: CrossNetworkAccessContext = {
            dataDir: deps.dataDir,
            userId: req.auth!.user.id,
            clientId: req.auth!.clientId ?? '',
            logger: app.appLogger,
            accessibleNetworkIds: accessibleIds,
            currentNetworkId: input.network_id,
          };
          const value = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
            const set = setPropertyValue(
              ndb,
              ownerType,
              input.owner_id,
              input.key,
              input.value as PropertyValueValue,
              req.auth!.user.id,
              crossCtx,
            );
            // В журнал пишем обновление самой сущности-владельца (требование
            // b0c7a57c): смена значения свойства — это её операция.
            const ownerEntity =
              ownerType === 'thought'
                ? getThought(ndb, input.owner_id)
                : getLink(ndb, input.owner_id);
            return {
              result: set,
              events: [
                {
                  type: 'property-value.set',
                  data: {
                    owner_type: ownerType,
                    owner_id: input.owner_id,
                    property_id: set.property_id,
                    value: set.value,
                  },
                },
              ],
              ...(ownerEntity === null
                ? {}
                : {
                    activity: [
                      { kind: 'owner' as const, entityType: ownerType, entity: ownerEntity },
                    ],
                  }),
            };
          });
          sendSuccess(reply, value);
        },
      );

      app.delete(
        `${pathBase}/properties/:key`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const input = parseRest(RestPropertyDelete, req);
          const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
          runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
            const removed = deletePropertyValue(
              ndb,
              ownerType,
              input.owner_id,
              input.key,
              req.auth!.user.id,
            );
            // Idempotent DELETE (error cefb4db0): nothing stored → no event or
            // owner-activity record — the call had no effect.
            if (!removed.deleted) {
              return { result: undefined };
            }
            const ownerEntity =
              ownerType === 'thought'
                ? getThought(ndb, input.owner_id)
                : getLink(ndb, input.owner_id);
            return {
              result: undefined,
              events: [
                {
                  type: 'property-value.deleted',
                  data: {
                    owner_type: ownerType,
                    owner_id: input.owner_id,
                    property_id: removed.property_id,
                  },
                },
              ],
              ...(ownerEntity === null
                ? {}
                : {
                    activity: [
                      { kind: 'owner' as const, entityType: ownerType, entity: ownerEntity },
                    ],
                  }),
            };
          });
          reply.code(204).send();
        },
      );

      // POST …/properties/:key/cross-resolve — явный резолв кросс-сетевых
      // значений (задача 7849008a, спека 737ed900). Служебная операция:
      // без write-бюджета и audit-записи как содержательной правки
      // (требование c104a0fc).
      app.post(
        `${pathBase}/properties/:key/cross-resolve`,
        { preHandler: [app.authPreHandler, requireNetworkMember()] },
        async (req: FastifyRequest, reply) => {
          const input = parseRest(RestPropertyCrossResolve, req);
          const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
          const accessibleIds = await getAccessibleNetworkIdsForUser(
            deps.dataDir,
            req.auth!.user.id,
            app.appLogger,
          );
          const ctx: CrossNetworkAccessContext = {
            dataDir: deps.dataDir,
            userId: req.auth!.user.id,
            clientId: req.auth!.clientId ?? '',
            logger: app.appLogger,
            accessibleNetworkIds: accessibleIds,
            currentNetworkId: input.network_id,
          };
          const values = crossResolvePropertyValue(
            ndb,
            ownerType,
            input.owner_id,
            input.key,
            ctx,
          );
          // Типизация ответа через общий DTO `@etn/shared` — сторож
          // `client/tests/guard-rest-response-contracts.test.ts` паритет.
          const payload: PropertyCrossResolveResult = { values };
          sendSuccess(reply, payload);
        },
      );
    };

    registerOwnerRoutes('/networks/:networkId/thoughts/:id', 'thought');
    registerOwnerRoutes('/networks/:networkId/links/:id', 'link');
  };
}
