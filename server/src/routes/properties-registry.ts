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
import {
  bodyObject,
  fieldNullableString,
  openRouteNetworkDb,
  requestBody,
  type RouteDeps,
} from './helpers.js';
import {
  createNetworkProperty,
  deleteNetworkProperty,
  getNetworkProperty,
  listNetworkProperties,
  updateNetworkProperty,
} from '../domain/property-service.js';
import type { NetworkDb } from '../db/network-db.js';
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
  const name = body.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'name обязателен и не может быть пустым.',
      { field: 'name' },
      requestId,
    );
  }
  const valueType = body.value_type;
  if (
    typeof valueType !== 'string' ||
    !(PROPERTY_VALUE_TYPES as readonly string[]).includes(valueType)
  ) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'value_type обязателен и должен быть одним из поддерживаемых.',
      { field: 'value_type', allowed: PROPERTY_VALUE_TYPES },
      requestId,
    );
  }
  const config = body.config;
  const configValue: PropertyConfig | null | undefined =
    config === undefined
      ? undefined
      : config === null
        ? null
        : (config as PropertyConfig);
  const description = fieldNullableString(body, 'description', requestId);

  // Поля оформления создаваемого типа связи (0.8.1) — только для свойств-связей.
  const linkFieldsPresent =
    body.name_forward !== undefined ||
    body.name_reverse !== undefined ||
    body.parent_link_type_id !== undefined ||
    body.link_color !== undefined ||
    body.link_style !== undefined ||
    body.link_width !== undefined;
  if (linkFieldsPresent && valueType !== 'link') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'name_forward/name_reverse/parent_link_type_id/link_color/link_style/link_width применимы только к value_type="link".',
      { field: 'value_type', actual: valueType },
      requestId,
    );
  }

  let nameForward: string | undefined;
  let nameReverse: string | undefined;
  let parentLinkTypeId: string | null | undefined;
  let linkColor: string | null | undefined;
  let linkStyle: LinkStyle | null | undefined;
  let linkWidth: number | null | undefined;

  if (body.name_forward !== undefined) {
    if (typeof body.name_forward !== 'string' || body.name_forward.trim() === '') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'name_forward должен быть непустой строкой.',
        { field: 'name_forward' },
        requestId,
      );
    }
    nameForward = body.name_forward.trim();
  }
  if (body.name_reverse !== undefined) {
    if (typeof body.name_reverse !== 'string' || body.name_reverse.trim() === '') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'name_reverse должен быть непустой строкой.',
        { field: 'name_reverse' },
        requestId,
      );
    }
    nameReverse = body.name_reverse.trim();
  }
  if (body.parent_link_type_id !== undefined) {
    if (body.parent_link_type_id !== null && typeof body.parent_link_type_id !== 'string') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'parent_link_type_id должен быть строкой или null.',
        { field: 'parent_link_type_id' },
        requestId,
      );
    }
    parentLinkTypeId = body.parent_link_type_id as string | null;
  }
  if (body.link_color !== undefined) {
    if (body.link_color !== null && typeof body.link_color !== 'string') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'link_color должен быть строкой или null.',
        { field: 'link_color' },
        requestId,
      );
    }
    linkColor = body.link_color as string | null;
  }
  if (body.link_style !== undefined) {
    if (
      body.link_style !== null &&
      !(LINK_STYLES as readonly string[]).includes(body.link_style as string)
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `link_style должен быть одним из: ${LINK_STYLES.join(', ')}.`,
        { field: 'link_style', allowed: LINK_STYLES },
        requestId,
      );
    }
    linkStyle = body.link_style as LinkStyle | null;
  }
  if (body.link_width !== undefined) {
    if (
      body.link_width !== null &&
      (typeof body.link_width !== 'number' || !Number.isFinite(body.link_width as number))
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'link_width должен быть числом или null.',
        { field: 'link_width' },
        requestId,
      );
    }
    linkWidth = body.link_width as number | null;
  }

  return {
    name: name.trim(),
    value_type: valueType as PropertyValueType,
    ...(configValue !== undefined ? { config: configValue } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(nameForward !== undefined ? { name_forward: nameForward } : {}),
    ...(nameReverse !== undefined ? { name_reverse: nameReverse } : {}),
    ...(parentLinkTypeId !== undefined ? { parent_link_type_id: parentLinkTypeId } : {}),
    ...(linkColor !== undefined ? { link_color: linkColor } : {}),
    ...(linkStyle !== undefined ? { link_style: linkStyle } : {}),
    ...(linkWidth !== undefined ? { link_width: linkWidth } : {}),
  };
}

/**
 * Parse the body of `PATCH /networks/{nid}/properties/{id}`. Every field is
 * optional; an absent `config` keeps the current value (use `null` to clear).
 */
function parseUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): NetworkPropertyUpdateInput {
  const changes: NetworkPropertyUpdateInput = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'name должен быть непустой строкой.',
        { field: 'name' },
        requestId,
      );
    }
    changes.name = body.name.trim();
  }
  if (body.value_type !== undefined) {
    if (
      typeof body.value_type !== 'string' ||
      !(PROPERTY_VALUE_TYPES as readonly string[]).includes(body.value_type)
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'value_type должен быть одним из поддерживаемых.',
        { field: 'value_type', allowed: PROPERTY_VALUE_TYPES },
        requestId,
      );
    }
    changes.value_type = body.value_type as PropertyValueType;
  }
  if (body.config !== undefined) {
    changes.config = body.config === null ? null : (body.config as PropertyConfig);
  }
  if (body.description !== undefined) {
    changes.description = fieldNullableString(body, 'description', requestId) ?? null;
  }
  return changes;
}

// ===========================================================================
// Counters / usage
// ===========================================================================

/**
 * Counts of attached types and stored values of a registry property. For
 * link-properties the `types_count` is split into two side counters
 * (0.8.1, требование d7177d1d): a link-property is attached by both sides of
 * a typed edge, and the UI uses the per-side count to render the property
 * manager. For non-link properties both side counts are `undefined`.
 */
interface RegistryPropertyCounters {
  /** Number of `type_properties` rows pointing at this property (across both type kinds). */
  types_count: number;
  /** Number of `property_values` rows pointing at this property. */
  values_count: number;
  /** For link-properties only — number of types attached on the source side. */
  types_source_count?: number;
  /** For link-properties only — number of types attached on the target side. */
  types_target_count?: number;
}

function readCounters(
  ndb: NetworkDb,
  propertyId: string,
  valueType?: PropertyValueType,
): RegistryPropertyCounters {
  const typesCount = (
    ndb
      .prepare('SELECT COUNT(*) AS c FROM type_properties_v WHERE property_id = ?')
      .get(propertyId) as { c: number }
  ).c;
  const valuesCount = (
    ndb
      .prepare('SELECT COUNT(*) AS c FROM property_values_v WHERE property_id = ?')
      .get(propertyId) as { c: number }
  ).c;
  const result: RegistryPropertyCounters = {
    types_count: typesCount,
    values_count: valuesCount,
  };
  if (valueType === 'link') {
    // Split by side. `side IS NULL` rows are legacy bindings (миграция 041) —
    // they keep counting in the total but not in either side.
    const sourceCount = (
      ndb
        .prepare(
          `SELECT COUNT(*) AS c FROM type_properties_v WHERE property_id = ? AND side = 'source'`,
        )
        .get(propertyId) as { c: number }
    ).c;
    const targetCount = (
      ndb
        .prepare(
          `SELECT COUNT(*) AS c FROM type_properties_v WHERE property_id = ? AND side = 'target'`,
        )
        .get(propertyId) as { c: number }
    ).c;
    result.types_source_count = sourceCount;
    result.types_target_count = targetCount;
  }
  return result;
}

/**
 * Replicate {@link convertStoredValue} from the property service without
 * touching the domain module: walk every stored value of the property and
 * classify it as convertible or droppable for the requested `value_type`.
 * Used to surface `converted`/`dropped` counters from the PATCH endpoint
 * without changing the service's signature.
 */
function classifyStoredValues(
  ndb: NetworkDb,
  propertyId: string,
  from: PropertyValueType,
  to: PropertyValueType,
): { converted: number; dropped: number } {
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}($|T)/;
  const rows = ndb
    .prepare(
      `SELECT value_text, value_date, value_number, value_bool
       FROM property_values_v WHERE property_id = ?`,
    )
    .all(propertyId) as Array<{
    value_text: string | null;
    value_date: string | null;
    value_number: number | null;
    value_bool: number | null;
  }>;

  let converted = 0;
  let dropped = 0;
  for (const row of rows) {
    // Read the stored value as its declared type, then try to convert.
    let value: string | number | boolean | string[] | null = null;
    switch (from) {
      case 'text':
      case 'url':
        value = row.value_text;
        break;
      case 'date':
        value = row.value_date;
        break;
      case 'number':
        value = row.value_number;
        break;
      case 'bool':
        value = row.value_bool === null ? null : row.value_bool === 1;
        break;
      case 'link':
        value = null;
        break;
    }
    // Same conversion rules as the domain service.
    if (canConvert(value, to, ISO_DATE_RE)) converted += 1;
    else dropped += 1;
  }
  return { converted, dropped };
}

function canConvert(
  value: string | number | boolean | string[] | null,
  to: PropertyValueType,
  ISO_DATE_RE: RegExp,
): boolean {
  if (value === null) return true; // NULL always stays NULL
  if (Array.isArray(value)) {
    return to === 'text' || to === 'url';
  }
  switch (to) {
    case 'text':
    case 'url':
      return true;
    case 'number': {
      if (typeof value === 'number') return true;
      if (typeof value === 'boolean') return true;
      const trimmed = value.trim();
      if (trimmed === '') return false;
      const n = Number(trimmed);
      return Number.isFinite(n);
    }
    case 'date':
      return typeof value === 'string' && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
    case 'bool':
      if (typeof value === 'boolean') return true;
      if (typeof value === 'number' && (value === 0 || value === 1)) return true;
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        return s === 'true' || s === 'да' || s === '1' || s === 'false' || s === 'нет' || s === '0';
      }
      return false;
    case 'link':
      return false;
    case 'thought_ref':
      // Legacy (миграция 040): таких свойств в живой БД не остаётся.
      return false;
  }
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
        // Counter lookup is O(1) per property; one query for types and one for
        // values is enough — the route runs inside a single transaction.
        const typeRows = ndb
          .prepare(
            'SELECT property_id, COUNT(*) AS c FROM type_properties_v GROUP BY property_id',
          )
          .all() as Array<{ property_id: string; c: number }>;
        const valueRows = ndb
          .prepare(
            'SELECT property_id, COUNT(*) AS c FROM property_values_v GROUP BY property_id',
          )
          .all() as Array<{ property_id: string; c: number }>;
        const typesByProp = new Map(typeRows.map((r) => [r.property_id, r.c]));
        const valuesByProp = new Map(valueRows.map((r) => [r.property_id, r.c]));
        // Per-side counters for link properties (0.8.1, задача d7177d1d).
        const linkSourceRows = ndb
          .prepare(
            `SELECT property_id, COUNT(*) AS c FROM type_properties_v
               WHERE side = 'source' GROUP BY property_id`,
          )
          .all() as Array<{ property_id: string; c: number }>;
        const linkTargetRows = ndb
          .prepare(
            `SELECT property_id, COUNT(*) AS c FROM type_properties_v
               WHERE side = 'target' GROUP BY property_id`,
          )
          .all() as Array<{ property_id: string; c: number }>;
        const linkSourceByProp = new Map(linkSourceRows.map((r) => [r.property_id, r.c]));
        const linkTargetByProp = new Map(linkTargetRows.map((r) => [r.property_id, r.c]));
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
        const input = parseCreateBody(bodyObject(req.body ?? {}, req.id), req.id);
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
        const counters = readCounters(ndb, id, property.value_type);
        sendSuccess(reply, { ...property, ...counters });
      },
    );

    app.patch(
      '/networks/:networkId/properties/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as PropertyIdParams;
        const changes = parseUpdateBody(bodyObject(req.body ?? {}, req.id), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const current = getNetworkProperty(ndb, id);
        if (current === null) {
          throw new EtnError('NOT_FOUND', `property ${id} not found`, {
            entity: 'property',
            id,
          }, req.id);
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

        // Bindings: every type (thought or link) that attaches the property.
        const bindingRows = ndb
          .prepare(
            `SELECT tp.owner_type AS owner_type, tp.owner_id AS owner_id,
                    tp.required AS required
             FROM type_properties_v tp
             WHERE tp.property_id = ?
             ORDER BY tp.owner_type, tp.owner_id`,
          )
          .all(id) as Array<{
          owner_type: 'thought_type' | 'link_type';
          owner_id: string;
          required: number;
        }>;

        const thoughtTypeIds = bindingRows
          .filter((b) => b.owner_type === 'thought_type')
          .map((b) => b.owner_id);
        const linkTypeIds = bindingRows
          .filter((b) => b.owner_type === 'link_type')
          .map((b) => b.owner_id);

        const thoughtNameById = new Map<string, string>();
        if (thoughtTypeIds.length > 0) {
          const rows = ndb
            .prepare(
              `SELECT id, name FROM thought_types_v WHERE id IN (${thoughtTypeIds.map(() => '?').join(', ')})`,
            )
            .all(...thoughtTypeIds) as Array<{ id: string; name: string }>;
          for (const r of rows) thoughtNameById.set(r.id, r.name);
        }
        const linkNameById = new Map<string, string>();
        if (linkTypeIds.length > 0) {
          const rows = ndb
            .prepare(
              `SELECT id, name_forward, name_reverse FROM link_types_v WHERE id IN (${linkTypeIds.map(() => '?').join(', ')})`,
            )
            .all(...linkTypeIds) as Array<{
            id: string;
            name_forward: string;
            name_reverse: string;
          }>;
          for (const r of rows) linkNameById.set(r.id, `${r.name_forward} / ${r.name_reverse}`);
        }

        // For each binding, count stored values on owners whose type id matches
        // this binding exactly. The "in-type" notion is by the binding row's
        // owner type (a thought_type binding covers thoughts whose type_id
        // equals it).
        type UsageBinding = {
          owner_type: 'thought_type' | 'link_type';
          owner_id: string;
          owner_name: string;
          required: boolean;
          values_in_type_count: number;
        };
        const bindings: UsageBinding[] = [];
        for (const b of bindingRows) {
          const ownerTable = b.owner_type === 'thought_type' ? 'thoughts_v' : 'links_v';
          const name =
            b.owner_type === 'thought_type'
              ? (thoughtNameById.get(b.owner_id) ?? b.owner_id)
              : (linkNameById.get(b.owner_id) ?? b.owner_id);
          const count = (
            ndb
              .prepare(
                `SELECT COUNT(*) AS c
                 FROM property_values_v pv
                 JOIN ${ownerTable} o ON o.id = pv.owner_id
                 WHERE pv.property_id = ? AND pv.owner_type = ? AND o.type_id = ?`,
              )
              .get(
                id,
                b.owner_type === 'thought_type' ? 'thought' : 'link',
                b.owner_id,
              ) as { c: number }
          ).c;
          bindings.push({
            owner_type: b.owner_type,
            owner_id: b.owner_id,
            owner_name: name,
            required: b.required === 1,
            values_in_type_count: count,
          });
        }

        // «Out-of-type»: stored values whose owner's type is not in the
        // attached set. Walk thought/link owners separately: a thought_type
        // binding covers thoughts, never links, so a thought's outside-type
        // status is computed against the thought_type bindings only.
        const thoughtTypeIdSet = new Set(thoughtTypeIds);
        const linkTypeIdSet = new Set(linkTypeIds);

        const thoughtOutsideCount = (
          ndb
            .prepare(
              `SELECT COUNT(*) AS c
               FROM property_values_v pv
               LEFT JOIN thoughts_v t ON t.id = pv.owner_id
               WHERE pv.property_id = ? AND pv.owner_type = 'thought'
                 AND (t.type_id IS NULL OR t.type_id NOT IN (${thoughtTypeIds.length > 0 ? thoughtTypeIds.map(() => '?').join(', ') : 'NULL'}))`,
            )
            .get(id, ...(thoughtTypeIds.length > 0 ? thoughtTypeIds : [])) as { c: number }
        ).c;

        const linkOutsideCount = (
          ndb
            .prepare(
              `SELECT COUNT(*) AS c
               FROM property_values_v pv
               LEFT JOIN links_v l ON l.id = pv.owner_id
               WHERE pv.property_id = ? AND pv.owner_type = 'link'
                 AND (l.type_id IS NULL OR l.type_id NOT IN (${linkTypeIds.length > 0 ? linkTypeIds.map(() => '?').join(', ') : 'NULL'}))`,
            )
            .get(id, ...(linkTypeIds.length > 0 ? linkTypeIds : [])) as { c: number }
        ).c;

        const valuesInTypeCount = bindings.reduce((acc, b) => acc + b.values_in_type_count, 0);
        const valuesOutsideTypeCount = thoughtOutsideCount + linkOutsideCount;

        sendSuccess(reply, {
          property_id: id,
          name: property.name,
          value_type: property.value_type,
          bindings,
          values_in_type_count: valuesInTypeCount,
          values_outside_type_count: valuesOutsideTypeCount,
          // Silence unused locals — the sets document the dichotomy above.
          thought_types: Array.from(thoughtTypeIdSet),
          link_types: Array.from(linkTypeIdSet),
        });
      },
    );
  };
}
