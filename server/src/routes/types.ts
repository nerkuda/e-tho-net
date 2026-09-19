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
  type LinkPropertySide,
  type LinkTypeUpdateInput,
  type PropertyConfig,
  type PropertyDefinitionInput,
  type IconKind,
  type ThoughtTypeInput,
  type ThoughtTypeUpdateInput,
  type TypeOwnerType,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  openRouteNetworkDb,
  requestBody,
  restWriteFx,
  runWrite,
  type RouteDeps,
} from './helpers.js';
import {
  assertImageIcon,
  parseBody,
  parseRest,
  RestDescriptionOverrideBody,
  RestForceQuery,
  RestIfMatch,
  RestLinkTypeUpdateBody,
  RestOrderedIdsBody,
  RestThoughtTypeCreateBody,
  RestThoughtTypeUpdateBody,
  RestAttachBody,
  RestTypePropertyUpdateBody,
} from '../contracts.js';
import { listLinkTypeCounts, listLinkTypes, updateLinkType } from '../domain/link-type-service.js';
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
/** Display name of a thought- or link-type row (для activity-снимка). */
function typeName(type: { name?: string; name_forward?: string; id: string }): string {
  return type.name ?? type.name_forward ?? type.id;
}

function parseThoughtTypeBody(body: Record<string, unknown>, requestId: string): ThoughtTypeInput {
  const out = parseBody(RestThoughtTypeCreateBody, body, requestId);
  const iconKind = out.icon_kind as IconKind | undefined;
  if (iconKind === 'image') {
    assertImageIcon(out.icon as string | null | undefined, requestId);
  }
  return {
    name: out.name as string,
    parent_id: (out.parent_id ?? null) as string | null,
    icon: (out.icon ?? null) as string | null,
    icon_kind: iconKind,
    fg_color: (out.fg_color ?? null) as string | null,
    bg_color: (out.bg_color ?? null) as string | null,
    font_bold: out.font_bold as boolean | null | undefined,
    font_italic: out.font_italic as boolean | null | undefined,
    font_underline: out.font_underline as boolean | null | undefined,
    font_strike: out.font_strike as boolean | null | undefined,
    description: (out.description ?? null) as string | null,
    comment_template_md: (out.comment_template_md ?? null) as string | null,
  } as unknown as ThoughtTypeInput;
}

function parseThoughtTypeUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): ThoughtTypeUpdateInput {
  const out = parseBody(RestThoughtTypeUpdateBody, body, requestId);
  const changes: Record<string, unknown> = {};
  if (out.name !== undefined) changes.name = out.name;
  if (out.parent_id !== undefined) changes.parent_id = out.parent_id;
  if (out.icon !== undefined) changes.icon = out.icon;
  if (out.icon_kind !== undefined) changes.icon_kind = out.icon_kind;
  if (out.fg_color !== undefined) changes.fg_color = out.fg_color;
  if (out.bg_color !== undefined) changes.bg_color = out.bg_color;
  if (out.font_bold !== undefined) changes.font_bold = out.font_bold;
  if (out.font_italic !== undefined) changes.font_italic = out.font_italic;
  if (out.font_underline !== undefined) changes.font_underline = out.font_underline;
  if (out.font_strike !== undefined) changes.font_strike = out.font_strike;
  if (out.description !== undefined) changes.description = out.description;
  if (out.comment_template_md !== undefined) changes.comment_template_md = out.comment_template_md;
  if (changes.icon_kind === 'image') {
    assertImageIcon(changes.icon as string | null | undefined, requestId);
  }
  return changes as unknown as ThoughtTypeUpdateInput;
}

/** Parse the body of `POST /link-types` (служебный, 0.8.1). */

function parseLinkTypeUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): LinkTypeUpdateInput {
  const out = parseBody(RestLinkTypeUpdateBody, body, requestId);
  const changes: LinkTypeUpdateInput = {};
  if (out.parent_id !== undefined) changes.parent_id = out.parent_id as string | null;
  if (out.color !== undefined) changes.color = out.color as string | null;
  if (out.style !== undefined) changes.style = out.style as LinkTypeUpdateInput['style'];
  if (out.width !== undefined) changes.width = out.width as number | null;
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
 * `required`/`position`/`side` belong to the binding and are accepted in both
 * shapes. `side` (0.8.1, задача d7177d1d) — сторона привязки свойства-связи
 * (`source`/`target`); для скаляров — `null`.
 */
type AttachPropertyInput =
  | {
      mode: 'attach';
      property_id: string;
      required: boolean;
      position: number | undefined;
      side?: LinkPropertySide | null;
    }
  | {
      mode: 'create';
      key: string;
      value_type: PropertyDefinitionInput['value_type'];
      config: PropertyDefinitionInput['config'];
      description: PropertyDefinitionInput['description'];
      required: boolean;
      position: number | undefined;
      side?: LinkPropertySide | null;
    };

function parseAttachBody(body: Record<string, unknown>, requestId: string): AttachPropertyInput {
  const out = parseBody(RestAttachBody, body, requestId);
  const required = (out.required as boolean | undefined) ?? false;
  const position = out.position as number | undefined;
  const side =
    out.side === undefined ? undefined : (out.side as unknown as LinkPropertySide | null);
  if (out.property_id !== undefined) {
    // Природа свойства живёт в справочнике — nature-поля не допускаются.
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
    return {
      mode: 'attach',
      property_id: (out.property_id as string).trim(),
      required,
      position,
      ...(side !== undefined ? { side } : {}),
    };
  }
  const key = out.key as unknown as string | undefined;
  if (key === undefined || key.trim() === '' || out.value_type === undefined) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'нужны либо property_id, либо key и value_type.',
      { field: 'key' },
      requestId,
    );
  }
  return {
    mode: 'create',
    key: key.trim(),
    value_type: out.value_type as unknown as PropertyDefinitionInput['value_type'],
    config:
      out.config === undefined
        ? undefined
        : out.config === null
          ? null
          : (out.config as PropertyDefinitionInput['config']),
    description: (out.description ?? null) as PropertyDefinitionInput['description'],
    required,
    position,
    ...(side !== undefined ? { side } : {}),
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
  const out = parseBody(RestTypePropertyUpdateBody, body, requestId);
  return {
    required: (out.required as boolean | undefined) ?? false,
    position: out.position as number | undefined,
    ...(out.side !== undefined ? { side: out.side as LinkPropertySide | null } : {}),
    ...(out.allowed_target_type_ids !== undefined
      ? { allowedTargetTypeIds: out.allowed_target_type_ids as string[] | null }
      : {}),
    ...(out.allowed_source_type_ids !== undefined
      ? { allowedSourceTypeIds: out.allowed_source_type_ids as string[] | null }
      : {}),
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
        const type = runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          const created = createThoughtType(ndb, input, req.auth!.user.id);
          return {
            result: created,
            events: [{ type: 'thought-type.created', data: { type: created } }],
            activity: [{ kind: 'thought-type', action: 'created', type: created }],
          };
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
          throw new EtnError(
            'NOT_FOUND',
            `thought-type ${id} not found`,
            {
              entity: 'thought_type',
              id,
            },
            req.id,
          );
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
        const expectedVersion = parseRest(RestIfMatch, req).expected_version;
        const changes = parseThoughtTypeUpdateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const type = runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          const updated = updateThoughtType(ndb, id, changes, expectedVersion, req.auth!.user.id);
          return {
            result: updated,
            events: [
              { type: 'thought-type.updated', data: { id, changes, version: updated.version } },
            ],
            activity: [{ kind: 'thought-type', action: 'updated', type: updated }],
          };
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
        const expectedVersion = parseRest(RestIfMatch, req).expected_version;
        const force = parseRest(RestForceQuery, req).force === true;
        // Task ba024a45 / 0.7.2 (ADR 46d17a91): the type is used by THIS
        // network in any of its `type_roles` roles? Refuse even with `force` —
        // the network would lose the structural or instructions marker.
        // The owner must clear the role in `PATCH /networks/{id}` first.
        const networkRow = app.systemDb.getNetworkById(networkId);
        if (networkRow !== null) {
          const referencedRole = (
            Object.entries(networkRow.type_roles) as Array<[string, string | null]>
          ).find(([, value]) => value === id)?.[0];
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
        runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          const existing = getThoughtType(ndb, id);
          deleteThoughtType(ndb, id, expectedVersion, { force, actorUserId: req.auth!.user.id });
          return {
            result: undefined,
            events: [{ type: 'thought-type.deleted', data: { id } }],
            ...(existing === null
              ? {}
              : {
                  activity: [
                    { kind: 'thought-type' as const, action: 'deleted' as const, type: existing },
                  ],
                }),
          };
        });
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
          throw new EtnError(
            'NOT_FOUND',
            `link-type ${id} not found`,
            {
              entity: 'link_type',
              id,
            },
            req.id,
          );
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
        const expectedVersion = parseRest(RestIfMatch, req).expected_version;
        const changes = parseLinkTypeUpdateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const type = runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          const updated = updateLinkType(ndb, id, changes, expectedVersion, req.auth!.user.id);
          return {
            result: updated,
            events: [
              { type: 'link-type.updated', data: { id, changes, version: updated.version } },
            ],
            activity: [{ kind: 'link-type', action: 'updated', type: updated }],
          };
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
              prop = createTypeProperty(
                ndb,
                ownerType,
                id,
                {
                  key: registry.name,
                  value_type: registry.value_type,
                  config: registry.config,
                  description: registry.description,
                  required: input.required,
                  position: input.position,
                  ...(input.side !== undefined ? { side: input.side } : {}),
                },
                req.auth!.user.id,
              );
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
              prop = createTypeProperty(
                ndb,
                ownerType,
                id,
                {
                  key: input.key,
                  value_type: input.value_type,
                  config: input.config,
                  description: input.description,
                  required: input.required,
                  position: input.position,
                  ...(input.side !== undefined ? { side: input.side } : {}),
                },
                req.auth!.user.id,
              );
            }
            runWrite(ndb, restWriteFx(deps, req, networkId), () => {
              // Подключение свойства к типу — это операция правки типа
              // (требование b0c7a57c): фиксируем в журнале как обновление
              // владельца — самого типа.
              const ownerTypeRow =
                ownerType === 'thought_type' ? getThoughtType(ndb, id) : getLinkType(ndb, id);
              return {
                result: undefined,
                events: [{ type: 'property-definition.created', data: { definition: prop } }],
                ...(ownerTypeRow === null
                  ? {}
                  : {
                      activity: [
                        {
                          kind: 'type-property' as const,
                          action: 'updated' as const,
                          typeId: ownerTypeRow.id,
                          typeName: typeName(ownerTypeRow),
                        },
                      ],
                    }),
              };
            });
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
                  const registry = getNetworkPropertyByName(ndb, name);
                  if (registry !== null) {
                    throw new EtnError(
                      'DUPLICATE',
                      err.message,
                      {
                        ...((err.details as Record<string, unknown> | null) ?? {}),
                        property_id: registry.id,
                      },
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
              throw new EtnError(
                'NOT_FOUND',
                `property ${propertyId} not found`,
                {
                  entity: 'type_property',
                  id: propertyId,
                },
                req.id,
              );
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
          const prop = runWrite(ndb, restWriteFx(deps, req, networkId), () => {
            const updated = updateTypeProperty(
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
            const ownerTypeRow =
              ownerType === 'thought_type' ? getThoughtType(ndb, id) : getLinkType(ndb, id);
            return {
              result: updated,
              events: [{ type: 'property-definition.updated', data: { id: propertyId, changes } }],
              ...(ownerTypeRow === null
                ? {}
                : {
                    activity: [
                      {
                        kind: 'type-property' as const,
                        action: 'updated' as const,
                        typeId: ownerTypeRow.id,
                        typeName: typeName(ownerTypeRow),
                      },
                    ],
                  }),
            };
          });
          sendSuccess(reply, prop, { request_id: req.id });
        },
      );

      app.delete(
        `${pathBase}/:id/properties/:propertyId`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id, propertyId } = req.params as TypePropertyParams;
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
          runWrite(ndb, restWriteFx(deps, req, networkId), () => {
            const ownerTypeRow =
              ownerType === 'thought_type' ? getThoughtType(ndb, id) : getLinkType(ndb, id);
            deleteTypeProperty(ndb, propertyId, req.auth!.user.id);
            return {
              result: undefined,
              events: [{ type: 'property-definition.deleted', data: { id: propertyId } }],
              ...(ownerTypeRow === null
                ? {}
                : {
                    activity: [
                      {
                        kind: 'type-property' as const,
                        action: 'updated' as const,
                        typeId: ownerTypeRow.id,
                        typeName: typeName(ownerTypeRow),
                      },
                    ],
                  }),
            };
          });
          reply.code(204).send();
        },
      );

      app.put(
        `${pathBase}/:id/properties/reorder`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id } = req.params as TypeIdParams;
          const orderedIds = parseRest(RestOrderedIdsBody, req).ordered_ids as unknown as string[];
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
          runWrite(ndb, restWriteFx(deps, req, networkId), () => {
            setTypePropertyDefaultOverride(
              ndb,
              ownerType,
              id,
              propertyId,
              value,
              req.auth!.user.id,
            );
            const def = getTypeProperty(ndb, propertyId);
            const ownerTypeRow =
              ownerType === 'thought_type' ? getThoughtType(ndb, id) : getLinkType(ndb, id);
            return {
              result: undefined,
              events: [
                {
                  type: 'property-definition.updated',
                  data: {
                    id: propertyId,
                    // The payload just signals that this definition's effective
                    // default changed; consumers re-fetch the effective list.
                    changes:
                      value === null ? {} : { config: { ...def?.config, default_value: value } },
                  },
                },
              ],
              ...(ownerTypeRow === null
                ? {}
                : {
                    activity: [
                      {
                        kind: 'type-property' as const,
                        action: 'updated' as const,
                        typeId: ownerTypeRow.id,
                        typeName: typeName(ownerTypeRow),
                      },
                    ],
                  }),
            };
          });
          sendSuccess(
            reply,
            { property_id: propertyId, default_value: value },
            {
              request_id: req.id,
            },
          );
        },
      );

      // Set/clear a type's DESCRIPTION override of an inherited property
      // (`description: null` resets to the definition's own description).
      app.put(
        `${pathBase}/:id/properties/:propertyId/description`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id, propertyId } = req.params as TypePropertyParams;
          const description = parseRest(RestDescriptionOverrideBody, req).description as
            string | null;
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
          runWrite(ndb, restWriteFx(deps, req, networkId), () => {
            setTypePropertyDescriptionOverride(
              ndb,
              ownerType,
              id,
              propertyId,
              description,
              req.auth!.user.id,
            );
            const ownerTypeRow =
              ownerType === 'thought_type' ? getThoughtType(ndb, id) : getLinkType(ndb, id);
            return {
              result: undefined,
              events: [
                {
                  type: 'property-definition.updated',
                  data: { id: propertyId, changes: { description } },
                },
              ],
              ...(ownerTypeRow === null
                ? {}
                : {
                    activity: [
                      {
                        kind: 'type-property' as const,
                        action: 'updated' as const,
                        typeId: ownerTypeRow.id,
                        typeName: typeName(ownerTypeRow),
                      },
                    ],
                  }),
            };
          });
          sendSuccess(
            reply,
            { property_id: propertyId, description },
            {
              request_id: req.id,
            },
          );
        },
      );
    };

    registerTypePropertyRoutes('/networks/:networkId/thought-types', 'thought_type');
    registerTypePropertyRoutes('/networks/:networkId/link-types', 'link_type');
  };
}
