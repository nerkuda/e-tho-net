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
  PROPERTY_VALUE_TYPES,
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
  return {
    name: name.trim(),
    value_type: valueType as PropertyValueType,
    ...(configValue !== undefined ? { config: configValue } : {}),
    ...(description !== undefined ? { description } : {}),
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

/** Counts of attached types and stored values of a registry property. */
interface RegistryPropertyCounters {
  /** Number of `type_properties` rows pointing at this property (across both type kinds). */
  types_count: number;
  /** Number of `property_values` rows pointing at this property. */
  values_count: number;
}

function readCounters(ndb: NetworkDb, propertyId: string): RegistryPropertyCounters {
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
  return { types_count: typesCount, values_count: valuesCount };
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
      `SELECT value_text, value_date, value_number, value_bool, value_thought_ref
       FROM property_values_v WHERE property_id = ?`,
    )
    .all(propertyId) as Array<{
    value_text: string | null;
    value_date: string | null;
    value_number: number | null;
    value_bool: number | null;
    value_thought_ref: string | null;
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
      case 'thought_ref': {
        const raw = row.value_thought_ref;
        if (raw === null) value = null;
        else if (raw.startsWith('[')) {
          try {
            const parsed: unknown = JSON.parse(raw);
            value = Array.isArray(parsed)
              ? (parsed.filter((v): v is string => typeof v === 'string') as string[])
              : [];
          } catch {
            value = [];
          }
        } else value = raw;
        break;
      }
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
    case 'thought_ref':
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
        type Entry = NetworkProperty & RegistryPropertyCounters;
        const data: Entry[] = properties.map((p) => ({
          ...p,
          types_count: typesByProp.get(p.id) ?? 0,
          values_count: valuesByProp.get(p.id) ?? 0,
        }));
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
          const property = createNetworkProperty(ndb, input);
          deps.emit(req, networkId, 'property-registry.created', { property });
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
        const counters = readCounters(ndb, id);
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
          const property = updateNetworkProperty(ndb, id, changes);
          deps.emit(req, networkId, 'property-registry.updated', {
            id,
            changes,
            converted,
            dropped,
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
        try {
          deleteNetworkProperty(ndb, id);
        } catch (err) {
          // Re-throw with the canonical `details.property_id` (the domain
          // already adds `types_count` and `values_count` to `details`).
          if (err instanceof EtnError && err.code === 'DUPLICATE') {
            throw err;
          }
          throw err;
        }
        deps.emit(req, networkId, 'property-registry.deleted', { id });
        reply.code(204).send();
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
