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
  type PropertyDefinitionUpdateInput,
  type ThoughtTypeInput,
  type ThoughtTypeUpdateInput,
  type TypeOwnerType,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  fieldBoolean,
  fieldNullableString,
  fieldString,
  fieldStringArray,
  openRouteNetworkDb,
  parseIfMatch,
  queryBoolean,
  requestBody,
  type RouteDeps,
} from './helpers.js';
import {
  createLinkType,
  deleteLinkType,
  listLinkTypes,
  updateLinkType,
} from '../domain/link-type-service.js';
import {
  createThoughtType,
  deleteThoughtType,
  listThoughtTypes,
  updateThoughtType,
} from '../domain/thought-type-service.js';
import {
  createTypeProperty,
  deleteTypeProperty,
  listTypeProperties,
  reorderTypeProperties,
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
  return {
    name,
    icon: fieldNullableString(body, 'icon', requestId),
    fg_color: fieldNullableString(body, 'fg_color', requestId),
    bg_color: fieldNullableString(body, 'bg_color', requestId),
    font_bold: fieldBoolean(body, 'font_bold', requestId),
    font_italic: fieldBoolean(body, 'font_italic', requestId),
    font_underline: fieldBoolean(body, 'font_underline', requestId),
    font_strike: fieldBoolean(body, 'font_strike', requestId),
    description: fieldNullableString(body, 'description', requestId),
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
  if (body.icon !== undefined) {
    changes.icon = fieldNullableString(body, 'icon', requestId);
  }
  if (body.fg_color !== undefined) {
    changes.fg_color = fieldNullableString(body, 'fg_color', requestId);
  }
  if (body.bg_color !== undefined) {
    changes.bg_color = fieldNullableString(body, 'bg_color', requestId);
  }
  if (body.font_bold !== undefined) {
    changes.font_bold = fieldBoolean(body, 'font_bold', requestId);
  }
  if (body.font_italic !== undefined) {
    changes.font_italic = fieldBoolean(body, 'font_italic', requestId);
  }
  if (body.font_underline !== undefined) {
    changes.font_underline = fieldBoolean(body, 'font_underline', requestId);
  }
  if (body.font_strike !== undefined) {
    changes.font_strike = fieldBoolean(body, 'font_strike', requestId);
  }
  if (body.description !== undefined) {
    changes.description = fieldNullableString(body, 'description', requestId);
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
    color: fieldNullableString(body, 'color', requestId),
    style: fieldString(body, 'style', requestId) as LinkTypeInput['style'],
    width: typeof body.width === 'number' ? body.width : undefined,
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
  if (body.color !== undefined) {
    changes.color = fieldNullableString(body, 'color', requestId);
  }
  if (body.style !== undefined) {
    changes.style = fieldString(body, 'style', requestId) as LinkTypeUpdateInput['style'];
  }
  if (body.width !== undefined) {
    if (typeof body.width !== 'number' || !Number.isFinite(body.width)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'width должен быть числом.',
        { field: 'width' },
        requestId,
      );
    }
    changes.width = body.width;
  }
  if (body.description !== undefined) {
    changes.description = fieldNullableString(body, 'description', requestId);
  }
  return changes;
}

/** Parse the body of `POST …/types/:id/properties`. */
function parseTypePropertyBody(
  body: Record<string, unknown>,
  requestId: string,
): PropertyDefinitionInput {
  const key = fieldString(body, 'key', requestId);
  const valueType = fieldString(body, 'value_type', requestId);
  if (key === undefined || key.trim() === '' || valueType === undefined) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'key и value_type обязательны.',
      { field: 'key' },
      requestId,
    );
  }
  const config =
    typeof body.config === 'object' && body.config !== null
      ? (body.config as Record<string, unknown>)
      : body.config;
  return {
    key,
    value_type: valueType as PropertyDefinitionInput['value_type'],
    config: config as PropertyDefinitionInput['config'],
    required: fieldBoolean(body, 'required', requestId),
    position: typeof body.position === 'number' ? Math.trunc(body.position) : undefined,
  };
}

/** Parse the body of `PATCH …/types/:id/properties/:propertyId`. */
function parseTypePropertyUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): PropertyDefinitionUpdateInput {
  const changes: PropertyDefinitionUpdateInput = {};
  if (body.value_type !== undefined) {
    changes.value_type = fieldString(
      body,
      'value_type',
      requestId,
    ) as PropertyDefinitionUpdateInput['value_type'];
  }
  if (body.config !== undefined) {
    changes.config =
      typeof body.config === 'object' && body.config !== null
        ? (body.config as Record<string, unknown>)
        : null;
  }
  if (body.required !== undefined) {
    changes.required = fieldBoolean(body, 'required', requestId);
  }
  if (body.position !== undefined) {
    if (typeof body.position !== 'number' || !Number.isFinite(body.position)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'position должен быть числом.',
        { field: 'position' },
        requestId,
      );
    }
    changes.position = Math.trunc(body.position);
  }
  return changes;
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
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const types = listThoughtTypes(ndb);
        sendList(reply, types, types.length, 0, types.length);
      },
    );

    app.post(
      '/networks/:networkId/thought-types',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as TypeIdParams;
        const input = parseThoughtTypeBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const type = createThoughtType(ndb, input, req.auth!.user.id);
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
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const type = updateThoughtType(ndb, id, changes, expectedVersion);
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
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        deleteThoughtType(ndb, id, expectedVersion, { force, actorUserId: req.auth!.user.id });
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
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const types = listLinkTypes(ndb);
        sendList(reply, types, types.length, 0, types.length);
      },
    );

    app.post(
      '/networks/:networkId/link-types',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as TypeIdParams;
        const input = parseLinkTypeBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const type = createLinkType(ndb, input, req.auth!.user.id);
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
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const type = updateLinkType(ndb, id, changes, expectedVersion);
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
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        deleteLinkType(ndb, id, expectedVersion, { force, actorUserId: req.auth!.user.id });
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
          const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
          const props = listTypeProperties(ndb, ownerType, id);
          sendList(reply, props, props.length, 0, props.length);
        },
      );

      app.post(
        `${pathBase}/:id/properties`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id } = req.params as TypeIdParams;
          const input = parseTypePropertyBody(requestBody(req), req.id);
          const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
          const prop = createTypeProperty(ndb, ownerType, id, input);
          sendCreated(reply, prop, { request_id: req.id });
        },
      );

      app.patch(
        `${pathBase}/:id/properties/:propertyId`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, propertyId } = req.params as TypePropertyParams;
          const changes = parseTypePropertyUpdateBody(requestBody(req), req.id);
          const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
          const prop = updateTypeProperty(ndb, propertyId, changes);
          sendSuccess(reply, prop, { request_id: req.id });
        },
      );

      app.delete(
        `${pathBase}/:id/properties/:propertyId`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, propertyId } = req.params as TypePropertyParams;
          const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
          deleteTypeProperty(ndb, propertyId);
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
          const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
          const props = reorderTypeProperties(ndb, ownerType, id, orderedIds);
          sendList(reply, props, props.length, 0, props.length);
        },
      );
    };

    registerTypePropertyRoutes('/networks/:networkId/thought-types', 'thought_type');
    registerTypePropertyRoutes('/networks/:networkId/link-types', 'link_type');
  };
}
