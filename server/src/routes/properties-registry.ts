/**
 * Property-registry routes (task 75404197, 03-server-api.md §8a).
 *
 *   GET    /api/v1/networks/{nid}/properties              # registry list
 *   POST   /api/v1/networks/{nid}/properties              # create
 *   GET    /api/v1/networks/{nid}/properties/{id}         # one
 *   PATCH  /api/v1/networks/{nid}/properties/{id}         # rename / retype / ...
 *   DELETE /api/v1/networks/{nid}/properties/{id}         # refuse when in use
 *   GET    /api/v1/networks/{nid}/properties/{id}/usage   # bindings + values
 *
 * The registry is the single source of truth for a property's *nature* (name,
 * value_type, config, description). Type bindings (`type_properties`) and
 * stored values (`property_values`) reference it by id; both sub-routes live
 * elsewhere (`routes/types.ts`, `routes/properties.ts`).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  LINK_STYLES,
  PROPERTY_VALUE_TYPES,
  type LinkStyle,
  type NetworkProperty,
  type NetworkPropertyInput,
  type NetworkPropertyUpdateInput,
  type PropertyConfig,
  type PropertyValueType,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import { openRouteNetworkDb, type RouteDeps } from './helpers.js';
import { parseBody, RestPropertyCreateBody, RestPropertyUpdateBody } from '../contracts.js';
import {
  classifyStoredValues,
  createNetworkProperty,
  deleteNetworkProperty,
  getNetworkProperty,
  getPropertyCounterMaps,
  getPropertyRegistryCounters,
  getPropertyUsage,
  listNetworkProperties,
  updateNetworkProperty,
  type RegistryPropertyCounters,
} from '../domain/property-service.js';
import { recordPropertyActivity } from '../domain/activity-service.js';

// ===========================================================================
// Body parsers
// ===========================================================================

/**
 * Read the `conflict_property_id` string out of an `EtnError.details` blob.
 * `details` is typed `unknown`, so this is the type-safe way to dig a string
 * out of it without sprinkling `as any` casts through the route handlers.
 */
function readConflictPropertyId(details: unknown): string | null {
  if (typeof details !== 'object' || details === null) return null;
  const value = (details as Record<string, unknown>).conflict_property_id;
  return typeof value === 'string' ? value : null;
}

/** Re-cast an `unknown` details blob into a plain record (best-effort). */
function readDetailsObject(details: unknown): Record<string, unknown> | null {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return null;
  return details as Record<string, unknown>;
}

/**
 * Parse the body of `POST /networks/{nid}/properties`. The route is `POST`
 * (creation), so every recognised field is required: `name`, `value_type`. The
 * optional `config`/`description` follow the shared shape; an absent `config`
 * defaults to `null`, an absent `description` defaults to `null` too.
 *
 * For `value_type: "link"` the route also accepts the link-type side of the
 * unified property lifecycle (0.8.1, требование 09f692ff): a single POST
 * creates both the property and its link type. `name_forward`/`name_reverse`
 * are required in that case (unless an existing `config.link_type_id` is
 * supplied); `parent_link_type_id`/`link_color`/`link_style`/`link_width` are
 * optional decoration of the new type. For non-link properties those fields
 * are rejected up front so the call does not silently set decoration on a
 * scalar property.
 */
function parseCreateBody(
  body: Record<string, unknown>,
  requestId: string,
): NetworkPropertyInput {
  const out = parseBody(RestPropertyCreateBody, body, requestId);
  return {
    name: (out.name as string).trim(),
    value_type: out.value_type as PropertyValueType,
    config:
      out.config === undefined
        ? undefined
        : out.config === null
          ? null
          : (out.config as PropertyConfig),
    description: (out.description ?? null) as string | null,
    name_forward: out.name_forward === undefined ? undefined : (out.name_forward as string).trim(),
    name_reverse: out.name_reverse === undefined ? undefined : (out.name_reverse as string).trim(),
    parent_link_type_id: (out.parent_link_type_id ?? null) as string | null,
    link_color: (out.link_color ?? null) as string | null,
    link_style: (out.link_style ?? null) as LinkStyle | null,
    link_width: (out.link_width ?? null) as number | null,
  };
}

/**
 * Parse the body of `PATCH /networks/{nid}/properties/{id}`. Every field is
 * optional; an absent `config` keeps the current value (use `null` to clear).
 *
 * Для свойства-связи (0.8.1, единый жизненный цикл [[#09f692ff-8338-4948-a4a2-0f356485ad09]])
 * PATCH принимает и поля типа связи — `name_forward`/`name_reverse` и
 * оформление (`link_color`/`link_style`/`link_width`): они пробрасываются в
 * доменный `updateNetworkProperty`, который правит связанный `link_type` в
 * той же транзакции. Применимость к `value_type="link"` проверяет маршрут по
 * текущему свойству (сам `value_type` в теле PATCH необязателен).
 */
function parseUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): NetworkPropertyUpdateInput {
  const out = parseBody(RestPropertyUpdateBody, body, requestId);
  const changes: NetworkPropertyUpdateInput = {};
  if (out.name !== undefined) changes.name = (out.name as string).trim();
  if (out.value_type !== undefined) changes.value_type = out.value_type as PropertyValueType;
  if (out.config !== undefined) changes.config = out.config === null ? null : (out.config as PropertyConfig);
  if (out.description !== undefined) changes.description = (out.description ?? null) as string | null;
  if (out.name_forward !== undefined) changes.name_forward = (out.name_forward as string).trim();
  if (out.name_reverse !== undefined) changes.name_reverse = (out.name_reverse as string).trim();
  if (out.link_color !== undefined) changes.link_color = out.link_color as string | null;
  if (out.link_style !== undefined) changes.link_style = out.link_style as LinkStyle | null;
  if (out.link_width !== undefined) changes.link_width = out.link_width as number | null;
  return changes;
}

/** True when the PATCH body carries link-type fields (имена сторон/оформление). */
function hasLinkTypeFields(changes: NetworkPropertyUpdateInput): boolean {
  return (
    changes.name_forward !== undefined ||
    changes.name_reverse !== undefined ||
    changes.link_color !== undefined ||
    changes.link_style !== undefined ||
    changes.link_width !== undefined
  );
}

// ===========================================================================
// Routes
// ===========================================================================

interface PropertyIdParams {
  networkId: string;
  id: string;
}

/** `/api/v1/networks*` property-registry routes plugin factory. */
export function createPropertiesRegistryRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.get(
      '/networks/:networkId/properties',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as PropertyIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const properties = listNetworkProperties(ndb);
        // Счётчики считает домен (ADR 8c93f03a): четыре агрегата — за четыре
        // запроса, затем O(1)-склейка по каждому свойству.
        const { typesByProp, valuesByProp, linkSourceByProp, linkTargetByProp } =
          getPropertyCounterMaps(ndb);
        type Entry = NetworkProperty & RegistryPropertyCounters;
        const data: Entry[] = properties.map((p) => {
          const entry: Entry = {
            ...p,
            types_count: typesByProp.get(p.id) ?? 0,
            values_count: valuesByProp.get(p.id) ?? 0,
          };
          if (p.value_type === 'link') {
            entry.types_source_count = linkSourceByProp.get(p.id) ?? 0;
            entry.types_target_count = linkTargetByProp.get(p.id) ?? 0;
          }
          return entry;
        });
        sendList(reply, data, data.length, 0, data.length);
      },
    );

    app.post(
      '/networks/:networkId/properties',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as PropertyIdParams;
        const input = parseCreateBody((req.body ?? {}) as Record<string, unknown>, req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        try {
          const property = createNetworkProperty(ndb, input, req.auth!.user.id);
          deps.emit(req, networkId, 'property-registry.created', { property });
          recordPropertyActivity(ndb, {
            networkId,
            userId: req.auth!.user.id,
            action: 'created',
            property,
            layerId: req.layerEcho?.id ?? null,
          });
          sendCreated(reply, property, { request_id: req.id });
        } catch (err) {
          if (err instanceof EtnError && err.code === 'DUPLICATE') {
            // Surface the id of the property that holds the name — the client
            // uses it to offer «connect the existing one» (02-data-model.md
            // §3.4a, «Подключение»).
            const conflictId = readConflictPropertyId(err.details);
            if (conflictId !== null) {
              throw new EtnError(
                err.code,
                err.message,
                { ...(readDetailsObject(err.details) ?? {}), property_id: conflictId },
                req.id,
              );
            }
          }
          throw err;
        }
      },
    );

    app.get(
      '/networks/:networkId/properties/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as PropertyIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const property = getNetworkProperty(ndb, id);
        if (property === null) {
          throw new EtnError('NOT_FOUND', `property ${id} not found`, {
            entity: 'property',
            id,
          }, req.id);
        }
        const counters = getPropertyRegistryCounters(ndb, id, property.value_type);
        sendSuccess(reply, { ...property, ...counters });
      },
    );

    app.patch(
      '/networks/:networkId/properties/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as PropertyIdParams;
        const changes = parseUpdateBody((req.body ?? {}) as Record<string, unknown>, req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const current = getNetworkProperty(ndb, id);
        if (current === null) {
          throw new EtnError('NOT_FOUND', `property ${id} not found`, {
            entity: 'property',
            id,
          }, req.id);
        }
        // Поля типа связи (имена сторон/оформление) — только для свойств-связей
        // (0.8.1, единый жизненный цикл): у скалярного свойства связанного
        // link_type нет, молча игнорировать поля нельзя.
        if (hasLinkTypeFields(changes) && current.value_type !== 'link') {
          throw new EtnError(
            'VALIDATION_ERROR',
            'name_forward/name_reverse/link_color/link_style/link_width применимы только к value_type="link".',
            { field: 'value_type', actual: current.value_type },
            req.id,
          );
        }
        // Predict the migration footprint before delegating to the service:
        // `updateNetworkProperty` rewrites the values in a single transaction,
        // so the classification is exact as long as no concurrent writer
        // sneaks in (the per-request layer view serialises reads).
        let converted = 0;
        let dropped = 0;
        const typeChanged =
          changes.value_type !== undefined && changes.value_type !== current.value_type;
        if (typeChanged) {
          const counts = classifyStoredValues(ndb, id, current.value_type, changes.value_type!);
          converted = counts.converted;
          dropped = counts.dropped;
        }
        try {
          const property = updateNetworkProperty(ndb, id, changes, req.auth!.user.id);
          deps.emit(req, networkId, 'property-registry.updated', {
            id,
            changes,
            converted,
            dropped,
          });
          recordPropertyActivity(ndb, {
            networkId,
            userId: req.auth!.user.id,
            action: 'updated',
            property,
            layerId: req.layerEcho?.id ?? null,
          });
          sendSuccess(reply, { ...property, converted, dropped }, { request_id: req.id });
        } catch (err) {
          if (err instanceof EtnError && err.code === 'DUPLICATE') {
            const conflictId = readConflictPropertyId(err.details);
            if (conflictId !== null) {
              throw new EtnError(
                err.code,
                err.message,
                { ...(readDetailsObject(err.details) ?? {}), property_id: conflictId },
                req.id,
              );
            }
          }
          throw err;
        }
      },
    );

    app.delete(
      '/networks/:networkId/properties/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as PropertyIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const existing = getNetworkProperty(ndb, id);
        let result;
        try {
          // deleteNetworkProperty удаляет и свойство, и связанный link_type
          // (0.8.1, требование 09f692ff); `links_becoming_structural` —
          // число рёбер, ставших структурными.
          result = deleteNetworkProperty(ndb, id);
        } catch (err) {
          // Re-throw with the canonical `details.property_id` (the domain
          // already adds `types_count` and `values_count` to `details`).
          if (err instanceof EtnError && err.code === 'DUPLICATE') {
            throw err;
          }
          throw err;
        }
        deps.emit(req, networkId, 'property-registry.deleted', { id });
        if (existing) {
          recordPropertyActivity(ndb, {
            networkId,
            userId: req.auth!.user.id,
            action: 'deleted',
            property: existing,
            layerId: req.layerEcho?.id ?? null,
          });
        }
        // 200 OK с телом — спека (требование 09f692ff): для свойств-связей
        // клиенту нужно знать, сколько рёбер потеряло `type_id`. Для скаляров
        // поле `null` — обратная совместимость с будущими правками.
        sendSuccess(
          reply,
          { id, links_becoming_structural: result.links_becoming_structural },
          { request_id: req.id },
        );
      },
    );

    app.get(
      '/networks/:networkId/properties/:id/usage',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as PropertyIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const property = getNetworkProperty(ndb, id);
        if (property === null) {
          throw new EtnError('NOT_FOUND', `property ${id} not found`, {
            entity: 'property',
            id,
          }, req.id);
        }

        // Весь usage-отчёт считает домен (ADR 8c93f03a): привязки с именами
        // и счётчики «in-type»/«out-of-type».
        const usage = getPropertyUsage(ndb, id);
        sendSuccess(reply, {
          property_id: id,
          name: property.name,
          value_type: property.value_type,
          bindings: usage.bindings,
          values_in_type_count: usage.values_in_type_count,
          values_outside_type_count: usage.values_outside_type_count,
          thought_types: usage.thought_types,
          link_types: usage.link_types,
        });
      },
    );
  };
}
