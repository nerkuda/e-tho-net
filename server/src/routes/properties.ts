/**
 * Property-value routes (task D4, 03-server-api.md §9).
 *
 *   GET    /networks/:networkId/thoughts/:id/properties                            — list values
 *   PUT    /networks/:networkId/thoughts/:id/properties/order                      — full order set
 *   PUT    /networks/:networkId/thoughts/:id/properties/:key                       — upsert by key
 *   DELETE /networks/:networkId/thoughts/:id/properties/:key                       — remove by key
 *   POST   /networks/:networkId/thoughts/:id/properties/:key/cross-resolve        — cross-network resolve
 *   … and the same four under /networks/:networkId/links/:id/properties
 *
 * `PUT` is an upsert; the value is validated against the property definition
 * from the network registry and may target ANY registry property of a thought
 * (0.14.1, ADR cb95fb4e: привязка к типу владельца не проверяется). An unknown
 * property for a thought is `422 VALIDATION_ERROR`. `side` (0.14.1, спека
 * 906a29c9) адресует сторону свойства-связи. The property key is addressed by
 * path segment, so an empty key cannot match the route; the service
 * double-checks anyway.
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
  linkRemovalsOf,
  setPropertyValue,
} from '../domain/property-service.js';
import { setThoughtPropertyOrder } from '../domain/property-order-service.js';
import type { AnyWriteEvent } from '../domain/write-wrapper.js';
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
  RestThoughtPropertiesOrder,
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
              input.side ?? null,
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
                // Свойство-связь: set-запись создаёт рёбра — подписчики должны
                // увидеть `link.created`, как при `etn.properties.add`
                // (ошибка 1b719d76).
                ...(set.link_ids ?? []).flatMap((linkId) => {
                  const link = getLink(ndb, linkId);
                  return link === null
                    ? []
                    : [{ type: 'link.created' as const, data: { link } }];
                }),
                // Умное удаление целей set-записью (0.14.1, ADR a967d865):
                // физическое удаление — `link.deleted`, корзина — `link.updated`.
                ...linkRemovalsOf(set).flatMap<AnyWriteEvent>((removal) => {
                  if (removal.action === 'deleted') {
                    return [{ type: 'link.deleted' as const, data: { id: removal.link_id } }];
                  }
                  const link = getLink(ndb, removal.link_id);
                  return link === null
                    ? []
                    : [
                        {
                          type: 'link.updated' as const,
                          data: {
                            id: link.id,
                            changes: { marked_for_deletion: true },
                            version: link.version,
                          },
                        },
                      ];
                }),
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
              input.side ?? null,
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
                // Свойство-связь: умное удаление (0.14.1, ADR a967d865) —
                // физическое удаление `link.deleted`, корзина `link.updated`.
                ...(removed.removals ?? []).flatMap<AnyWriteEvent>((removal) => {
                  if (removal.action === 'deleted') {
                    return [{ type: 'link.deleted' as const, data: { id: removal.link_id } }];
                  }
                  const link = getLink(ndb, removal.link_id);
                  return link === null
                    ? []
                    : [
                        {
                          type: 'link.updated' as const,
                          data: {
                            id: link.id,
                            changes: { marked_for_deletion: true },
                            version: link.version,
                          },
                        },
                      ];
                }),
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

    // PUT …/thoughts/:id/properties/order — полный набор пер-мысленного
    // порядка внетиповых свойств (0.14.1, задача 3948af62, контракт 27ed2b39).
    // Статический сегмент `order` приоритетнее `:key` в роутере Fastify; тем
    // не менее регистрируем явно ДО общего набора — адрес не должен зависеть
    // от порядка регистрации.
    app.put(
      '/networks/:networkId/thoughts/:id/properties/order',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestThoughtPropertiesOrder, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const ordered = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const items = setThoughtPropertyOrder(ndb, input.owner_id, input.items);
          return {
            result: items,
            // Полный набор — ОДНО событие с вычисленными сервером сторонами
            // (каталог d819137a, задача 3948af62).
            events: [
              {
                type: 'thought.properties.reordered' as const,
                data: { thought_id: input.owner_id, items },
              },
            ],
          };
        });
        sendSuccess(reply, { items: ordered });
      },
    );

    registerOwnerRoutes('/networks/:networkId/thoughts/:id', 'thought');
    registerOwnerRoutes('/networks/:networkId/links/:id', 'link');
  };
}
