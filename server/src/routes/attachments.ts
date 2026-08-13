/**
 * Attachment routes (task D5, 03-server-api.md §11).
 *
 *   GET/POST /networks/:networkId/thoughts/:id/attachments — list/create on a thought
 *   GET/POST /networks/:networkId/links/:id/attachments    — list/create on a link
 *   PATCH    /networks/:networkId/attachments/:id          — update (last-write-wins)
 *   DELETE   /networks/:networkId/attachments/:id          — delete
 *
 * Attachments are polymorphic (`owner_type` + `owner_id`); on MVP `kind=file`
 * stores only a client-side path (no upload). The table has no `version`
 * column, so PATCH has no `If-Match` guard (documented in the service).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  type AttachmentInput,
  type AttachmentKind,
  type AttachmentOwnerType,
  type AttachmentUpdateInput,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  fieldNullableString,
  fieldString,
  openRouteNetworkDb,
  requestBody,
  type RouteDeps,
} from './helpers.js';
import {
  createAttachment,
  deleteAttachment,
  listAttachments,
  updateAttachment,
} from '../domain/attachment-service.js';

/** Route params for a network + owner id. */
interface OwnerParams {
  networkId: string;
  id: string;
}

/** Route params for a network + attachment id. */
interface AttachmentIdParams {
  networkId: string;
  id: string;
}

/** Optional numeric body field (finite number → truncated integer). */
function optionalIntField(
  body: Record<string, unknown>,
  key: string,
  requestId: string,
): number | undefined {
  const value = body[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EtnError('VALIDATION_ERROR', `${key} должен быть числом.`, { field: key }, requestId);
  }
  return Math.trunc(value);
}

/** Parse and validate the body of `POST …/attachments`. */
function parseAttachmentBody(body: Record<string, unknown>, requestId: string): AttachmentInput {
  const kind = fieldString(body, 'kind', requestId);
  if (kind === undefined) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'kind обязателен (url|file).',
      { field: 'kind' },
      requestId,
    );
  }
  return {
    kind: kind as AttachmentKind,
    url: fieldNullableString(body, 'url', requestId),
    file_path: fieldNullableString(body, 'file_path', requestId),
    file_size: optionalIntField(body, 'file_size', requestId),
    mime_type: fieldNullableString(body, 'mime_type', requestId),
    title: fieldNullableString(body, 'title', requestId),
    description: fieldNullableString(body, 'description', requestId),
    position: optionalIntField(body, 'position', requestId),
  };
}

/** Parse and validate the body of `PATCH /attachments/:id`. */
function parseAttachmentUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): AttachmentUpdateInput {
  const changes: AttachmentUpdateInput = {};
  if (body.url !== undefined) {
    changes.url = fieldNullableString(body, 'url', requestId);
  }
  if (body.file_path !== undefined) {
    changes.file_path = fieldNullableString(body, 'file_path', requestId);
  }
  if (body.file_size !== undefined) {
    changes.file_size = optionalIntField(body, 'file_size', requestId) ?? null;
  }
  if (body.mime_type !== undefined) {
    changes.mime_type = fieldNullableString(body, 'mime_type', requestId);
  }
  if (body.title !== undefined) {
    changes.title = fieldNullableString(body, 'title', requestId);
  }
  if (body.description !== undefined) {
    changes.description = fieldNullableString(body, 'description', requestId);
  }
  if (body.position !== undefined) {
    changes.position = optionalIntField(body, 'position', requestId);
  }
  return changes;
}

/** `/api/v1/networks*` attachment routes plugin factory. */
export function createAttachmentsRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    /** Register list/create for one owner kind. */
    const registerOwnerRoutes = (pathBase: string, ownerType: AttachmentOwnerType) => {
      app.get(
        `${pathBase}/attachments`,
        { preHandler: [app.authPreHandler, requireNetworkMember()] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id } = req.params as OwnerParams;
          const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
          const attachments = listAttachments(ndb, ownerType, id);
          sendList(reply, attachments, attachments.length, 0, attachments.length);
        },
      );

      app.post(
        `${pathBase}/attachments`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id } = req.params as OwnerParams;
          const input = parseAttachmentBody(requestBody(req), req.id);
          const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
          const attachment = createAttachment(ndb, ownerType, id, input, req.auth!.user.id);
          sendCreated(reply, attachment, { request_id: req.id });
        },
      );
    };

    registerOwnerRoutes('/networks/:networkId/thoughts/:id', 'thought');
    registerOwnerRoutes('/networks/:networkId/links/:id', 'link');

    app.patch(
      '/networks/:networkId/attachments/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as AttachmentIdParams;
        const changes = parseAttachmentUpdateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const attachment = updateAttachment(ndb, id, changes);
        sendSuccess(reply, attachment);
      },
    );

    app.delete(
      '/networks/:networkId/attachments/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as AttachmentIdParams;
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        deleteAttachment(ndb, id);
        reply.code(204).send();
      },
    );
  };
}
