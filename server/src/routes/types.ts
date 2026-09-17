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
  LINK_PROPERTY_SIDES,
  type LinkPropertySide,
  type LinkTypeUpdateInput,
  type PropertyConfig,
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
import {
  recordLinkTypeActivity,
  recordThoughtTypeActivity,
  recordTypePropertyActivity,
} from '../domain/activity-service.js';
import { getLinkType } from '../domain/link-type-service.js';
import { getThoughtType } from '../domain/thought-type-service.js';

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

/** Display name of a thought- or link-type row (для activity-снимка). */
function typeName(type: { name?: string; name_forward?: string; id: string }): string {
  return type.name ?? type.name_forward ?? type.id;
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

/** Parse the body of `POST /link-types` (служебный, 0.8.1). */

/**
 * Parse the body of `PATCH /link-types/:id` (0.8.1, задача d7177d1d):
 * `/link-types` — служебный CRUD, пользовательские операции идут через
 * свойство-связь. PATCH принимает только оформление (`color`, `style`,
 * `width`) и иерархию (`parent_id`). Правка `name_forward`/`name_reverse`
 * через этот эндпоинт — `422`: имена живут вместе со свойством-связью
 * (`PATCH /networks/{nid}/properties/{id}`).
 */
function parseLinkTypeUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): LinkTypeUpdateInput {
  if (body.name_forward !== undefined || body.name_reverse !== undefined) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'PATCH /link-types/{id} не меняет имена — редактируйте свойство-связь (PATCH /networks/{nid}/properties/{id}).',
      {
        field: body.name_forward !== undefined ? 'name_forward' : 'name_reverse',
        hint: 'PATCH /networks/{nid}/properties/{id}',
      },
      requestId,
    );
  }
  const changes: LinkTypeUpdateInput = {};
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
 * Body of `PATCH …/types/{id}/properties/{propertyId}` (0.8.1, задача d7177d1d):
 * только роль привязки в типе. Помимо `required`/`position` принимает:
 *   * `side` — `source`/`target`, для привязок свойств-связей;
 *   * `allowed_target_type_ids` — список id типов, которые могут быть целью
 *     (для привязки со стороны источника; null/[] — снять ограничение);
 *   * `allowed_source_type_ids` — то же для привязки со стороны назначения
 *     (миграция 0.8.1 — зеркало, симметрично `allowed_target_type_ids`).
 *
 * Поля свойства (`name`/`value_type`/`config`/`description`) правятся в
 * справочнике; их передача сюда — `422`. Контракт действует только для
 * `owner_type="thought_type"`.
 */
function parseTypePropertyUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): {
  required: boolean;
  position: number | undefined;
  side?: LinkPropertySide | null;
  allowedTargetTypeIds?: string[] | null;
  allowedSourceTypeIds?: string[] | null;
} {
  const allowed = [
    'required',
    'position',
    'side',
    'allowed_target_type_ids',
    'allowed_source_type_ids',
  ];
  const rejected = Object.keys(body).filter((k) => !allowed.includes(k));
  if (rejected.length > 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `PATCH …/properties/{id} меняет только роль в типе (required, position, side, allowed_target_type_ids, allowed_source_type_ids); нельзя: ${rejected.join(', ')}.`,
      { field: rejected[0], allowed },
      requestId,
    );
  }
  const result: ReturnType<typeof parseTypePropertyUpdateBody> = {
    required: fieldBoolean(body, 'required', requestId) ?? false,
    position:
      typeof body.position === 'number' && Number.isFinite(body.position)
        ? Math.trunc(body.position)
        : undefined,
  };
  if (body.side !== undefined) {
    if (
      body.side !== null &&
      !(LINK_PROPERTY_SIDES as readonly string[]).includes(body.side as string)
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `side должен быть одним из: ${LINK_PROPERTY_SIDES.join(', ')} или null.`,
        { field: 'side', allowed: LINK_PROPERTY_SIDES },
        requestId,
      );
    }
    result.side = (body.side === null ? null : (body.side as LinkPropertySide));
  }
  if (body.allowed_target_type_ids !== undefined) {
    const ids = body.allowed_target_type_ids;
    if (ids !== null && !Array.isArray(ids)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'allowed_target_type_ids должен быть массивом id или null.',
        { field: 'allowed_target_type_ids' },
        requestId,
      );
    }
    if (Array.isArray(ids) && ids.some((id) => typeof id !== 'string' || id === '')) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'allowed_target_type_ids должен содержать только непустые строки.',
        { field: 'allowed_target_type_ids' },
        requestId,
      );
    }
    result.allowedTargetTypeIds = ids as string[] | null;
  }
  if (body.allowed_source_type_ids !== undefined) {
    const ids = body.allowed_source_type_ids;
    if (ids !== null && !Array.isArray(ids)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'allowed_source_type_ids должен быть массивом id или null.',
        { field: 'allowed_source_type_ids' },
        requestId,
      );
    }
    if (Array.isArray(ids) && ids.some((id) => typeof id !== 'string' || id === '')) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'allowed_source_type_ids должен содержать только непустые строки.',
        { field: 'allowed_source_type_ids' },
        requestId,
      );
    }
    result.allowedSourceTypeIds = ids as string[] | null;
  }
  return result;
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
        recordThoughtTypeActivity(ndb, {
          networkId,
          userId: req.auth!.user.id,
          action: 'created',
          type,
          layerId: req.layerEcho?.id ?? null,
        });
        sendCreated(reply, type, {
          version: type.version,
          updated_at: type.updated_at,
          request_id: req.id,
        });
      },
    );

    // `GET /thought-types/:id` — fetch one thought type (задача 59119797:
    // используется кликом по строке активности `entity_type='thought_type'`).
    app.get(
      '/networks/:networkId/thought-types/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as TypeIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const type = getThoughtType(ndb, id);
        if (type === null) {
          throw new EtnError('NOT_FOUND', `thought-type ${id} not found`, {
            entity: 'thought_type',
            id,
          }, req.id);
        }
        sendSuccess(reply, type, {
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
        const type = updateThoughtType(ndb, id, changes, expectedVersion, req.auth!.user.id);
        deps.emit(req, networkId, 'thought-type.updated', {
          id,
          changes,
          version: type.version,
        });
        recordThoughtTypeActivity(ndb, {
          networkId,
          userId: req.auth!.user.id,
          action: 'updated',
          type,
          layerId: req.layerEcho?.id ?? null,
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
        // Task ba024a45 / 0.7.2 (ADR 46d17a91): the type is used by THIS
        // network in any of its `type_roles` roles? Refuse even with `force` —
        // the network would lose the structural or instructions marker.
        // The owner must clear the role in `PATCH /networks/{id}` first.
        const networkRow = app.systemDb.getNetworkById(networkId);
        if (networkRow !== null) {
          const referencedRole = (Object.entries(networkRow.type_roles) as Array<
            [string, string | null]
          >).find(([, value]) => value === id)?.[0];
          if (referencedRole !== undefined) {
            throw new EtnError(
              'VALIDATION_ERROR',
              `Тип используется сетью в роли «${referencedRole}»; сначала снимите роль через PATCH /networks/{id}.`,
              {
                entity: 'thought_type',
                id,
                network_id: networkId,
                role: referencedRole,
              },
              req.id,
            );
          }
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const existing = getThoughtType(ndb, id);
        deleteThoughtType(ndb, id, expectedVersion, { force, actorUserId: req.auth!.user.id });
        deps.emit(req, networkId, 'thought-type.deleted', { id });
        if (existing) {
          recordThoughtTypeActivity(ndb, {
            networkId,
            userId: req.auth!.user.id,
            action: 'deleted',
            type: existing,
            layerId: req.layerEcho?.id ?? null,
          });
        }
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
      async (_req: FastifyRequest, reply) => {
        // 0.8.1, задача d7177d1d: /link-types — служебный CRUD. Создание
        // пользовательского типа связи идёт через POST свойства-связи:
        //   POST /networks/{nid}/properties  { value_type: 'link',
        //                                      name_forward, name_reverse, ... }
        // Здесь — 422 со ссылкой на правильный контракт.
        throw new EtnError(
          'VALIDATION_ERROR',
          'создание типа связи идёт через свойство-связь — POST /networks/{nid}/properties с value_type="link" и парой name_forward/name_reverse.',
          {
            field: 'endpoint',
            hint: 'POST /networks/{nid}/properties',
            required: ['name', 'value_type', 'name_forward', 'name_reverse'],
          },
          reply.request.id,
        );
      },
    );

    // `GET /link-types/:id` — fetch one link type (задача 59119797).
    app.get(
      '/networks/:networkId/link-types/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as TypeIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const type = getLinkType(ndb, id);
        if (type === null) {
          throw new EtnError('NOT_FOUND', `link-type ${id} not found`, {
            entity: 'link_type',
            id,
          }, req.id);
        }
        sendSuccess(reply, type, {
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
        const type = updateLinkType(ndb, id, changes, expectedVersion, req.auth!.user.id);
        deps.emit(req, networkId, 'link-type.updated', {
          id,
          changes,
          version: type.version,
        });
        recordLinkTypeActivity(ndb, {
          networkId,
          userId: req.auth!.user.id,
          action: 'updated',
          type,
          layerId: req.layerEcho?.id ?? null,
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
      async (_req: FastifyRequest, reply) => {
        // 0.8.1, задача d7177d1d: /link-types — служебный CRUD. Удаление
        // пользовательского типа связи идёт через DELETE свойства-связи:
        //   DELETE /networks/{nid}/properties/{id}
        // Ответ — 422 со ссылкой на правильный контракт. Рёбра при таком
        // удалении обнуляют `type_id` и становятся структурными
        // (требование 09f692ff).
        throw new EtnError(
          'VALIDATION_ERROR',
          'удаление типа связи идёт через свойство-связь — DELETE /networks/{nid}/properties/{id}.',
          {
            field: 'endpoint',
            hint: 'DELETE /networks/{nid}/properties/{id}',
            note: 'рёбра теряют type_id и становятся структурными',
          },
          reply.request.id,
        );
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
              }, req.auth!.user.id);
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
              }, req.auth!.user.id);
            }
            deps.emit(req, networkId, 'property-definition.created', { definition: prop });
            // Подключение свойства к типу — это операция правки типа
            // (требование b0c7a57c): фиксируем в журнале как обновление
            // владельца — самого типа.
            const ownerTypeRow =
              ownerType === 'thought_type'
                ? getThoughtType(ndb, id)
                : getLinkType(ndb, id);
            if (ownerTypeRow) {
              recordTypePropertyActivity(ndb, {
                networkId,
                userId: req.auth!.user.id,
                action: 'updated',
                typeId: ownerTypeRow.id,
                typeName: typeName(ownerTypeRow),
                layerId: req.layerEcho?.id ?? null,
              });
            }
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
          const { networkId, id, propertyId } = req.params as TypePropertyParams;
          const changes = parseTypePropertyUpdateBody(requestBody(req), req.id);
          // The binding id from the path is forwarded to the service, which
          // maps it back to the underlying registry property. PATCH changes
          // the BINDING only — `key`/`value_type`/`description` are rejected
          // up front by `parseTypePropertyUpdateBody`. `config` сюда передаём
          // собранным из `allowed_target_type_ids`/`allowed_source_type_ids` —
          // они редактируются по стороне привязки (0.8.1, задача d7177d1d).
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
          let configPatch: PropertyConfig | null | undefined = undefined;
          if (
            changes.allowedTargetTypeIds !== undefined ||
            changes.allowedSourceTypeIds !== undefined
          ) {
            const current = getTypeProperty(ndb, propertyId);
            if (current === null) {
              throw new EtnError('NOT_FOUND', `property ${propertyId} not found`, {
                entity: 'type_property',
                id: propertyId,
              }, req.id);
            }
            const baseConfig: PropertyConfig = { ...(current.config ?? {}) };
            if (changes.allowedTargetTypeIds !== undefined) {
              if (changes.allowedTargetTypeIds === null) {
                delete baseConfig.allowed_target_type_ids;
              } else {
                baseConfig.allowed_target_type_ids = changes.allowedTargetTypeIds;
              }
            }
            if (changes.allowedSourceTypeIds !== undefined) {
              if (changes.allowedSourceTypeIds === null) {
                delete baseConfig.allowed_source_type_ids;
              } else {
                baseConfig.allowed_source_type_ids = changes.allowedSourceTypeIds;
              }
            }
            configPatch = baseConfig;
          }
          const prop = updateTypeProperty(
            ndb,
            propertyId,
            {
              required: changes.required,
              position: changes.position,
              ...(changes.side !== undefined ? { side: changes.side } : {}),
              ...(configPatch !== undefined ? { config: configPatch } : {}),
            },
            req.auth!.user.id,
          );
          deps.emit(req, networkId, 'property-definition.updated', {
            id: propertyId,
            changes,
          });
          const ownerTypeRow =
            ownerType === 'thought_type'
              ? getThoughtType(ndb, id)
              : getLinkType(ndb, id);
          if (ownerTypeRow) {
            recordTypePropertyActivity(ndb, {
              networkId,
              userId: req.auth!.user.id,
              action: 'updated',
              typeId: ownerTypeRow.id,
              typeName: typeName(ownerTypeRow),
              layerId: req.layerEcho?.id ?? null,
            });
          }
          sendSuccess(reply, prop, { request_id: req.id });
        },
      );

      app.delete(
        `${pathBase}/:id/properties/:propertyId`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id, propertyId } = req.params as TypePropertyParams;
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
          const ownerTypeRow =
            ownerType === 'thought_type'
              ? getThoughtType(ndb, id)
              : getLinkType(ndb, id);
          deleteTypeProperty(ndb, propertyId, req.auth!.user.id);
          deps.emit(req, networkId, 'property-definition.deleted', { id: propertyId });
          if (ownerTypeRow) {
            recordTypePropertyActivity(ndb, {
              networkId,
              userId: req.auth!.user.id,
              action: 'updated',
              typeId: ownerTypeRow.id,
              typeName: typeName(ownerTypeRow),
              layerId: req.layerEcho?.id ?? null,
            });
          }
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
          const props = reorderTypeProperties(ndb, ownerType, id, orderedIds, req.auth!.user.id);
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
          const scalarOk =
            typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
          // Дефолт свойства-связи — набор целей (bb67e546): массив id мыслей
          // (пустой массив — сброс дефолта, как null у скаляров).
          const linkDefaultOk =
            Array.isArray(value) && value.every((id) => typeof id === 'string' && id !== '');
          if (value !== null && !scalarOk && !linkDefaultOk) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'value должен быть строкой, числом, булевым, массивом id мыслей (свойство-связь) или null.',
              { field: 'value' },
              req.id,
            );
          }
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
          setTypePropertyDefaultOverride(ndb, ownerType, id, propertyId, value, req.auth!.user.id);
          const def = getTypeProperty(ndb, propertyId);
          deps.emit(req, networkId, 'property-definition.updated', {
            id: propertyId,
            // The payload just signals that this definition's effective
            // default changed; consumers re-fetch the effective list.
            changes:
              value === null ? {} : { config: { ...def?.config, default_value: value } },
          });
          const ownerTypeRow =
            ownerType === 'thought_type'
              ? getThoughtType(ndb, id)
              : getLinkType(ndb, id);
          if (ownerTypeRow) {
            recordTypePropertyActivity(ndb, {
              networkId,
              userId: req.auth!.user.id,
              action: 'updated',
              typeId: ownerTypeRow.id,
              typeName: typeName(ownerTypeRow),
              layerId: req.layerEcho?.id ?? null,
            });
          }
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
          setTypePropertyDescriptionOverride(ndb, ownerType, id, propertyId, description, req.auth!.user.id);
          deps.emit(req, networkId, 'property-definition.updated', {
            id: propertyId,
            changes: { description },
          });
          const ownerTypeRow =
            ownerType === 'thought_type'
              ? getThoughtType(ndb, id)
              : getLinkType(ndb, id);
          if (ownerTypeRow) {
            recordTypePropertyActivity(ndb, {
              networkId,
              userId: req.auth!.user.id,
              action: 'updated',
              typeId: ownerTypeRow.id,
              typeName: typeName(ownerTypeRow),
              layerId: req.layerEcho?.id ?? null,
            });
          }
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
