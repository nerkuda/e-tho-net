/**
 * Thought/link type routes (task D3, 03-server-api.md §8).
 *
 *   GET/POST/PATCH/DELETE /networks/:networkId/thought-types (…/:id)
 *   GET/POST/PATCH/DELETE /networks/:networkId/link-types    (…/:id)
 *
 * Plus type-property (`type_properties`) sub-resources on both type kinds:
 *
 *   GET    …/types/:id/properties                    — list definitions
 *   POST   …/types/:id/properties                    — create a definition
 *   PATCH  …/types/:id/properties/:propertyId        — update a definition
 *   DELETE …/types/:id/properties/:propertyId        — delete a definition
 *   PUT    …/types/:id/properties/reorder            — assign positions
 *   PUT    …/types/:id/properties/:propertyId/default      — override the default
 *   PUT    …/types/:id/properties/:propertyId/description  — override the description
 *
 * DELETE of a type still in use requires `?force=1` (nulls `type_id` on the
 * referencing thoughts/links). All routes require network membership.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  type LinkTypeInput,
  type LinkTypeUpdateInput,
  type PropertyDefinitionInput,
  type ThoughtTypeInput,
  type ThoughtTypeUpdateInput,
  type TypeOwnerType,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  assertImageIcon,
  fieldBoolean,
  fieldNullableBoolean,
  fieldNullableString,
  fieldString,
  fieldStringArray,
  openRouteNetworkDb,
  parseIconKind,
  parseIfMatch,
  queryBoolean,
  requestBody,
  type RouteDeps,
} from './helpers.js';
import {
  createLinkType,
  deleteLinkType,
  listLinkTypeCounts,
  listLinkTypes,
  updateLinkType,
} from '../domain/link-type-service.js';
import {
  createThoughtType,
  deleteThoughtType,
  listThoughtTypeCounts,
  listThoughtTypes,
  updateThoughtType,
} from '../domain/thought-type-service.js';
import {
  createTypeProperty,
  deleteTypeProperty,
  getNetworkProperty,
  getNetworkPropertyByName,
  getTypeProperty,
  listEffectiveTypeProperties,
  reorderTypeProperties,
  setTypePropertyDefaultOverride,
  setTypePropertyDescriptionOverride,
  updateTypeProperty,
} from '../domain/property-service.js';

/** Route params for a network + type id. */
interface TypeIdParams {
  networkId: string;
  id: string;
}

/** Route params for a network + type id + property id. */
interface TypePropertyParams {
  networkId: string;
  id: string;
  propertyId: string;
}

/**
 * Parse a `parent_id` body field: a string id, `null`/'' — «under the root».
 * Returns `undefined` when the field is absent (no change).
 */
function fieldParentId(
  body: Record<string, unknown>,
  requestId: string,
): string | null | undefined {
  if (body.parent_id === undefined) return undefined;
  const value = fieldNullableString(body, 'parent_id', requestId);
  return value === undefined || value === '' ? null : value;
}

/** Parse the body of `POST /thought-types`. */
function parseThoughtTypeBody(body: Record<string, unknown>, requestId: string): ThoughtTypeInput {
  const name = fieldString(body, 'name', requestId);
  if (name === undefined || name.trim() === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'name обязателен и не может быть пустым.',
      { field: 'name' },
      requestId,
    );
  }
  const icon = fieldNullableString(body, 'icon', requestId);
  const iconKind = parseIconKind(fieldNullableString(body, 'icon_kind', requestId), requestId);
  if (iconKind === 'image') {
    assertImageIcon(icon, requestId);
  }
  return {
    name,
    parent_id: fieldParentId(body, requestId) ?? null,
    icon,
    icon_kind: iconKind,
    fg_color: fieldNullableString(body, 'fg_color', requestId),
    bg_color: fieldNullableString(body, 'bg_color', requestId),
    font_bold: fieldNullableBoolean(body, 'font_bold', requestId),
    font_italic: fieldNullableBoolean(body, 'font_italic', requestId),
    font_underline: fieldNullableBoolean(body, 'font_underline', requestId),
    font_strike: fieldNullableBoolean(body, 'font_strike', requestId),
    description: fieldNullableString(body, 'description', requestId),
    comment_template_md: fieldNullableString(body, 'comment_template_md', requestId),
  };
}

/** Parse the body of `PATCH /thought-types/:id`. */
function parseThoughtTypeUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): ThoughtTypeUpdateInput {
  const changes: ThoughtTypeUpdateInput = {};
  if (body.name !== undefined) {
    changes.name = fieldString(body, 'name', requestId);
  }
  const parentId = fieldParentId(body, requestId);
  if (parentId !== undefined) {
    changes.parent_id = parentId;
  }
  if (body.icon !== undefined) {
    changes.icon = fieldNullableString(body, 'icon', requestId);
  }
  if (body.icon_kind !== undefined) {
    changes.icon_kind = parseIconKind(fieldNullableString(body, 'icon_kind', requestId), requestId);
  }
  if (changes.icon_kind === 'image') {
    assertImageIcon(changes.icon, requestId);
  }
  if (body.fg_color !== undefined) {
    changes.fg_color = fieldNullableString(body, 'fg_color', requestId);
  }
  if (body.bg_color !== undefined) {
    changes.bg_color = fieldNullableString(body, 'bg_color', requestId);
  }
  if (body.font_bold !== undefined) {
    changes.font_bold = fieldNullableBoolean(body, 'font_bold', requestId);
  }
  if (body.font_italic !== undefined) {
    changes.font_italic = fieldNullableBoolean(body, 'font_italic', requestId);
  }
  if (body.font_underline !== undefined) {
    changes.font_underline = fieldNullableBoolean(body, 'font_underline', requestId);
  }
  if (body.font_strike !== undefined) {
    changes.font_strike = fieldNullableBoolean(body, 'font_strike', requestId);
  }
  if (body.description !== undefined) {
    changes.description = fieldNullableString(body, 'description', requestId);
  }
  if (body.comment_template_md !== undefined) {
    changes.comment_template_md = fieldNullableString(body, 'comment_template_md', requestId);
  }
  return changes;
}

/** Parse the body of `POST /link-types`. */
function parseLinkTypeBody(body: Record<string, unknown>, requestId: string): LinkTypeInput {
  const nameForward = fieldString(body, 'name_forward', requestId);
  const nameReverse = fieldString(body, 'name_reverse', requestId);
  if (
    nameForward === undefined ||
    nameForward.trim() === '' ||
    nameReverse === undefined ||
    nameReverse.trim() === ''
  ) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'name_forward и name_reverse обязательны.',
      { field: 'name_forward' },
      requestId,
    );
  }
  return {
    name_forward: nameForward,
    name_reverse: nameReverse,
    parent_id: fieldParentId(body, requestId) ?? null,
    color: fieldNullableString(body, 'color', requestId),
    style:
      body.style === null
        ? null
        : (fieldString(body, 'style', requestId) as LinkTypeInput['style']),
    width: body.width === null ? null : typeof body.width === 'number' ? body.width : undefined,
    description: fieldNullableString(body, 'description', requestId),
  };
}

/** Parse the body of `PATCH /link-types/:id`. */
function parseLinkTypeUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): LinkTypeUpdateInput {
  const changes: LinkTypeUpdateInput = {};
  if (body.name_forward !== undefined) {
    changes.name_forward = fieldString(body, 'name_forward', requestId);
  }
  if (body.name_reverse !== undefined) {
    changes.name_reverse = fieldString(body, 'name_reverse', requestId);
  }
  const parentId = fieldParentId(body, requestId);
  if (parentId !== undefined) {
    changes.parent_id = parentId;
  }
  if (body.color !== undefined) {
    changes.color = fieldNullableString(body, 'color', requestId);
  }
  if (body.style !== undefined) {
    changes.style =
      body.style === null
        ? null
        : (fieldString(body, 'style', requestId) as LinkTypeUpdateInput['style']);
  }
  if (body.width !== undefined) {
    if (body.width !== null && (typeof body.width !== 'number' || !Number.isFinite(body.width))) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'width должен быть числом или null.',
        { field: 'width' },
        requestId,
      );
    }
    changes.width = body.width as number | null;
  }
  if (body.description !== undefined) {
    changes.description = fieldNullableString(body, 'description', requestId);
  }
  return changes;
}

/**
 * Two-form input for `POST …/types/:id/properties` (task 75404197):
 *
 *   * `{ property_id }` — attach an existing registry property;
 *   * `{ key, value_type, config?, description? }` — create the registry
 *     property in this layer and attach it (raises `409 DUPLICATE` with
 *     `details.property_id` when the name is already taken).
 *
 * `required`/`position` belong to the binding, so they are accepted in both
 * shapes. Returned as a discriminated input that the route consumes directly.
 */
type AttachPropertyInput =
  | {
      mode: 'attach';
      property_id: string;
      required: boolean;
      position: number | undefined;
    }
  | {
      mode: 'create';
      key: string;
      value_type: PropertyDefinitionInput['value_type'];
      config: PropertyDefinitionInput['config'];
      description: PropertyDefinitionInput['description'];
      required: boolean;
      position: number | undefined;
    };

function parseAttachBody(
  body: Record<string, unknown>,
  requestId: string,
): AttachPropertyInput {
  const required = fieldBoolean(body, 'required', requestId) ?? false;
  const position =
    typeof body.position === 'number' && Number.isFinite(body.position)
      ? Math.trunc(body.position)
      : undefined;

  if (body.property_id !== undefined) {
    if (typeof body.property_id !== 'string' || body.property_id.trim() === '') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'property_id должен быть непустой строкой.',
        { field: 'property_id' },
        requestId,
      );
    }
    // Nature fields must NOT be passed alongside `property_id`: the registry
    // is the single source of truth.
    if (
      body.key !== undefined ||
      body.value_type !== undefined ||
      body.config !== undefined ||
      body.description !== undefined
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'при property_id поля key/value_type/config/description не допускаются — это поля свойства в справочнике.',
        { field: 'property_id' },
        requestId,
      );
    }
    return { mode: 'attach', property_id: body.property_id, required, position };
  }

  const key = fieldString(body, 'key', requestId);
  const valueType = fieldString(body, 'value_type', requestId);
  if (key === undefined || key.trim() === '' || valueType === undefined) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'нужны либо property_id, либо key и value_type.',
      { field: 'key' },
      requestId,
    );
  }
  const config =
    body.config === undefined
      ? null
      : typeof body.config === 'object' && body.config !== null
        ? (body.config as Record<string, unknown>)
        : body.config;
  const description = fieldNullableString(body, 'description', requestId) ?? null;
  return {
    mode: 'create',
    key: key.trim(),
    value_type: valueType as PropertyDefinitionInput['value_type'],
    config: config as PropertyDefinitionInput['config'],
    description,
    required,
    position,
  };
}

/**
 * Read a string id out of an `EtnError.details` blob (typed `unknown`).
 * Centralised so the routes can fish out `property_id` without per-call casts.
 */
function readStringDetail(details: unknown, key: string): string | null {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Body of `PATCH …/types/:id/properties/{propertyId}` (task 75404197): only
 * the **binding's** role (`required`, `position`). Anything else (name, value
 * type, config, description) is a property-level field and must be edited in
 * the registry; passing it here is a 422.
 */
function parseTypePropertyUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): { required: boolean; position: number | undefined } {
  const allowed = ['required', 'position'];
  const rejected = Object.keys(body).filter((k) => !allowed.includes(k));
  if (rejected.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `PATCH …/properties/{id} меняет только роль в типе (required, position); нельзя: ${rejected.join(', ')}.`,
      { field: rejected[0], allowed },
      requestId,
    );
  }
  return {
    required: fieldBoolean(body, 'required', requestId) ?? false,
    position:
      typeof body.position === 'number' && Number.isFinite(body.position)
        ? Math.trunc(body.position)
        : undefined,
  };
}

/** `/api/v1/networks*` type routes plugin factory. */
export function createTypesRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // ---------------------------------------------------------------------
    // thought-types
    // ---------------------------------------------------------------------

    app.get(
      '/networks/:networkId/thought-types',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as TypeIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const types = listThoughtTypes(ndb);
        sendList(reply, types, types.length, 0, types.length);
      },
    );

    // Own record count per thought type id (task «Улучшить диалог редактирования
    // типов мыслей и связей»): the type-manager list's «Количество» column;
    // the client sums a group type's total over its subtree itself.
    app.get(
      '/networks/:networkId/thought-types/counts',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as TypeIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        sendSuccess(reply, listThoughtTypeCounts(ndb));
      },
    );

    app.post(
      '/networks/:networkId/thought-types',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as TypeIdParams;
        const input = parseThoughtTypeBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const type = createThoughtType(ndb, input, req.auth!.user.id);
        deps.emit(req, networkId, 'thought-type.created', { type });
        sendCreated(reply, type, {
          version: type.version,
          updated_at: type.updated_at,
          request_id: req.id,
        });
      },
    );

    app.patch(
      '/networks/:networkId/thought-types/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as TypeIdParams;
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const changes = parseThoughtTypeUpdateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const type = updateThoughtType(ndb, id, changes, expectedVersion);
        deps.emit(req, networkId, 'thought-type.updated', {
          id,
          changes,
          version: type.version,
        });
        sendSuccess(reply, type, {
          version: type.version,
          updated_at: type.updated_at,
          request_id: req.id,
        });
      },
    );

    app.delete(
      '/networks/:networkId/thought-types/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as TypeIdParams;
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const query = req.query as Record<string, unknown>;
        const force = queryBoolean(query.force, 'force', req.id) === true;
        // Task O5: the type is the network's `node_section_type_id`?
        // Refuse even with `force` — the network would lose its machine-readable
        // structure marker. The owner must clear the setting first.
        const referencing = app.systemDb.listNetworksReferencingNodeSectionType(id);
        const selfRef = referencing.find((n) => n.id === networkId);
        if (selfRef !== undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Тип используется как узловой раздел сети; сначала очистите настройку сети.',
            { entity: 'thought_type', id, network_id: networkId },
            req.id,
          );
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        deleteThoughtType(ndb, id, expectedVersion, { force, actorUserId: req.auth!.user.id });
        deps.emit(req, networkId, 'thought-type.deleted', { id });
        reply.code(204).send();
      },
    );

    // ---------------------------------------------------------------------
    // link-types
    // ---------------------------------------------------------------------

    app.get(
      '/networks/:networkId/link-types',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as TypeIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const types = listLinkTypes(ndb);
        sendList(reply, types, types.length, 0, types.length);
      },
    );

    // Own record count per link type id — the link-type analogue of the
    // `/thought-types/counts` route above.
    app.get(
      '/networks/:networkId/link-types/counts',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as TypeIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        sendSuccess(reply, listLinkTypeCounts(ndb));
      },
    );

    app.post(
      '/networks/:networkId/link-types',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as TypeIdParams;
        const input = parseLinkTypeBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const type = createLinkType(ndb, input, req.auth!.user.id);
        deps.emit(req, networkId, 'link-type.created', { type });
        sendCreated(reply, type, {
          version: type.version,
          updated_at: type.updated_at,
          request_id: req.id,
        });
      },
    );

    app.patch(
      '/networks/:networkId/link-types/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as TypeIdParams;
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const changes = parseLinkTypeUpdateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const type = updateLinkType(ndb, id, changes, expectedVersion);
        deps.emit(req, networkId, 'link-type.updated', {
          id,
          changes,
          version: type.version,
        });
        sendSuccess(reply, type, {
          version: type.version,
          updated_at: type.updated_at,
          request_id: req.id,
        });
      },
    );

    app.delete(
      '/networks/:networkId/link-types/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as TypeIdParams;
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const query = req.query as Record<string, unknown>;
        const force = queryBoolean(query.force, 'force', req.id) === true;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        deleteLinkType(ndb, id, expectedVersion, { force, actorUserId: req.auth!.user.id });
        deps.emit(req, networkId, 'link-type.deleted', { id });
        reply.code(204).send();
      },
    );

    // ---------------------------------------------------------------------
    // type_properties (shared between both type kinds)
    // ---------------------------------------------------------------------

    /** Register the property sub-routes for one type kind. */
    const registerTypePropertyRoutes = (pathBase: string, ownerType: TypeOwnerType) => {
      app.get(
        `${pathBase}/:id/properties`,
        { preHandler: [app.authPreHandler, requireNetworkMember()] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id } = req.params as TypeIdParams;
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
          // L21: the list is the effective (inheritance-aware) one — the
          // type's own definitions plus everything inherited from ancestors.
          const props = listEffectiveTypeProperties(ndb, ownerType, id);
          sendList(reply, props, props.length, 0, props.length);
        },
      );

      app.post(
        `${pathBase}/:id/properties`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id } = req.params as TypeIdParams;
          const input = parseAttachBody(requestBody(req), req.id);
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
          try {
            // Resolve `property_id` to a registry property and re-use its
            // `createTypeProperty` form: the service looks up by name and
            // skips the registry create when a property of this name already
            // exists in the layer view.
            let prop;
            if (input.mode === 'attach') {
              const registry = getNetworkProperty(ndb, input.property_id);
              if (registry === null) {
                throw new EtnError(
                  'NOT_FOUND',
                  `property ${input.property_id} not found`,
                  { entity: 'property', id: input.property_id },
                  req.id,
                );
              }
              prop = createTypeProperty(ndb, ownerType, id, {
                key: registry.name,
                value_type: registry.value_type,
                config: registry.config,
                description: registry.description,
                required: input.required,
                position: input.position,
              });
            } else {
              // The `{ key, value_type }` form promises to CREATE a registry
              // property (task 75404197). Reject the request up front when
              // the name is already taken so the client gets a precise
              // `details.property_id` to offer «connect the existing one».
              const existing = getNetworkPropertyByName(ndb, input.key);
              if (existing !== null) {
                throw new EtnError(
                  'DUPLICATE',
                  `свойство «${input.key}» уже есть в этой мыслесети`,
                  { name: input.key, property_id: existing.id },
                  req.id,
                );
              }
              prop = createTypeProperty(ndb, ownerType, id, {
                key: input.key,
                value_type: input.value_type,
                config: input.config,
                description: input.description,
                required: input.required,
                position: input.position,
              });
            }
            deps.emit(req, networkId, 'property-definition.created', { definition: prop });
            sendCreated(reply, prop, { request_id: req.id });
          } catch (err) {
            if (err instanceof EtnError && err.code === 'DUPLICATE') {
              // `createTypeProperty` uses the name as the natural key, so a
              // name clash raises DUPLICATE with no id in details — look the
              // owner up by name in the registry and attach its id so the
              // client can offer «connect the existing one».
              if (readStringDetail(err.details, 'property_id') === null) {
                const name =
                  input.mode === 'attach'
                    ? getNetworkProperty(ndb, input.property_id)?.name
                    : input.key;
                if (typeof name === 'string') {
                  const registry = (() => {
                    try {
                      // Round-trip via the service's own name resolver to
                      // stay consistent with `name_key` collation.
                      return ndb
                        .prepare('SELECT id FROM properties_v WHERE name_key = type_name_key(?)')
                        .get(name) as { id: string } | undefined;
                    } catch {
                      return undefined;
                    }
                  })();
                  if (registry !== undefined) {
                    throw new EtnError(
                      'DUPLICATE',
                      err.message,
                      { ...(err.details as Record<string, unknown> | null ?? {}), property_id: registry.id },
                      req.id,
                    );
                  }
                }
              }
            }
            throw err;
          }
        },
      );

      app.patch(
        `${pathBase}/:id/properties/:propertyId`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, propertyId } = req.params as TypePropertyParams;
          const changes = parseTypePropertyUpdateBody(requestBody(req), req.id);
          // The binding id from the path is forwarded to the service, which
          // maps it back to the underlying registry property. PATCH changes
          // the BINDING only — `key`/`value_type`/`config`/`description` are
          // rejected up front by `parseTypePropertyUpdateBody`.
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
          const prop = updateTypeProperty(ndb, propertyId, {
            required: changes.required,
            position: changes.position,
          });
          deps.emit(req, networkId, 'property-definition.updated', {
            id: propertyId,
            changes,
          });
          sendSuccess(reply, prop, { request_id: req.id });
        },
      );

      app.delete(
        `${pathBase}/:id/properties/:propertyId`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, propertyId } = req.params as TypePropertyParams;
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
          deleteTypeProperty(ndb, propertyId);
          deps.emit(req, networkId, 'property-definition.deleted', { id: propertyId });
          reply.code(204).send();
        },
      );

      app.put(
        `${pathBase}/:id/properties/reorder`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id } = req.params as TypeIdParams;
          const body = requestBody(req);
          const orderedIds = fieldStringArray(body, 'ordered_ids', req.id);
          if (orderedIds === undefined) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'ordered_ids обязателен (массив строк).',
              { field: 'ordered_ids' },
              req.id,
            );
          }
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
          const props = reorderTypeProperties(ndb, ownerType, id, orderedIds);
          sendList(reply, props, props.length, 0, props.length);
        },
      );

      // L21: set/clear a type's default-value override of an inherited
      // property definition (`value: null` clears the override).
      app.put(
        `${pathBase}/:id/properties/:propertyId/default`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id, propertyId } = req.params as TypePropertyParams;
          const body = requestBody(req);
          if (!('value' in body)) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'value обязателен (значение или null).',
              { field: 'value' },
              req.id,
            );
          }
          const value = body.value;
          if (
            value !== null &&
            typeof value !== 'string' &&
            typeof value !== 'number' &&
            typeof value !== 'boolean'
          ) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'value должен быть строкой, числом, булевым или null.',
              { field: 'value' },
              req.id,
            );
          }
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
          setTypePropertyDefaultOverride(ndb, ownerType, id, propertyId, value);
          const def = getTypeProperty(ndb, propertyId);
          deps.emit(req, networkId, 'property-definition.updated', {
            id: propertyId,
            // The payload just signals that this definition's effective
            // default changed; consumers re-fetch the effective list.
            changes:
              value === null ? {} : { config: { ...def?.config, default_value: value } },
          });
          sendSuccess(reply, { property_id: propertyId, default_value: value }, {
            request_id: req.id,
          });
        },
      );

      // Set/clear a type's DESCRIPTION override of an inherited property
      // (`description: null` resets to the definition's own description).
      app.put(
        `${pathBase}/:id/properties/:propertyId/description`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id, propertyId } = req.params as TypePropertyParams;
          const body = requestBody(req);
          if (!('description' in body)) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'description обязателен (текст или null).',
              { field: 'description' },
              req.id,
            );
          }
          const description = body.description;
          if (description !== null && typeof description !== 'string') {
            throw new EtnError(
              'VALIDATION_ERROR',
              'description должен быть строкой или null.',
              { field: 'description' },
              req.id,
            );
          }
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
          setTypePropertyDescriptionOverride(ndb, ownerType, id, propertyId, description);
          deps.emit(req, networkId, 'property-definition.updated', {
            id: propertyId,
            changes: { description },
          });
          sendSuccess(reply, { property_id: propertyId, description }, {
            request_id: req.id,
          });
        },
      );
    };

    registerTypePropertyRoutes('/networks/:networkId/thought-types', 'thought_type');
    registerTypePropertyRoutes('/networks/:networkId/link-types', 'link_type');
  };
}
