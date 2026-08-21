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
  type AttachmentFileInput,
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
  createAttachmentFile,
  deleteAttachment,
  enrichUrlAttachment,
  getAttachment,
  getAttachmentContent,
  listAttachments,
  updateAttachment,
  updateAttachmentContent,
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

/** Parse and validate the body of `POST …/attachments/file`. */
function parseAttachmentFileBody(
  body: Record<string, unknown>,
  requestId: string,
): AttachmentFileInput {
  const mimeType = fieldString(body, 'mime_type', requestId);
  if (mimeType === undefined || mimeType === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'mime_type обязателен.',
      { field: 'mime_type' },
      requestId,
    );
  }
  const data = fieldString(body, 'data_base64', requestId);
  if (data === undefined || data === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'data_base64 обязателен.',
      { field: 'data_base64' },
      requestId,
    );
  }
  return {
    title: fieldNullableString(body, 'title', requestId),
    mime_type: mimeType,
    data_base64: data,
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
  if (body.icon !== undefined) {
    changes.icon = fieldNullableString(body, 'icon', requestId);
  }
  if (body.position !== undefined) {
    changes.position = optionalIntField(body, 'position', requestId);
  }
  if (body.owner_type !== undefined || body.owner_id !== undefined) {
    if (body.owner_type !== undefined) {
      const t = fieldString(body, 'owner_type', requestId);
      if (t !== 'thought' && t !== 'link') {
        throw new EtnError(
          'VALIDATION_ERROR',
          'owner_type должен быть thought|link.',
          { field: 'owner_type' },
          requestId,
        );
      }
      changes.owner_type = t;
    }
    if (body.owner_id !== undefined) {
      changes.owner_id = fieldString(body, 'owner_id', requestId) ?? '';
    }
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
          let attachment = createAttachment(ndb, ownerType, id, input, req.auth!.user.id);
          // URL attachments are enriched (page title + favicon) before the
          // response/event so clients render a filled row at once (L1).
          if (attachment.kind === 'url') {
            attachment = await enrichUrlAttachment(ndb, attachment);
          }
          deps.emit(req, networkId, 'attachment.created', { attachment });
          sendCreated(reply, attachment, { request_id: req.id });
        },
      );

      // File upload: the payload is stored under the network's attachments/
      // directory (next to data.db); the response carries the stored path.
      app.post(
        `${pathBase}/attachments/file`,
        {
          preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler],
          // 10 MiB decoded ≈ 13.4 MiB base64 — allow headroom over the default 1 MiB.
          bodyLimit: 16 * 1024 * 1024,
        },
        async (req: FastifyRequest, reply) => {
          const { networkId, id } = req.params as OwnerParams;
          const input = parseAttachmentFileBody(requestBody(req), req.id);
          const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
          const attachment = createAttachmentFile(ndb, ownerType, id, input, req.auth!.user.id);
          deps.emit(req, networkId, 'attachment.created', { attachment });
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
        deps.emit(req, networkId, 'attachment.updated', { id, changes });
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
        deps.emit(req, networkId, 'attachment.deleted', { id });
        reply.code(204).send();
      },
    );

    // Text content of a file attachment for the built-in viewer/editor (L7,
    // 03-server-api.md §11). GET returns text (+ rendered html for markdown);
    // PUT overwrites the file.
    app.get(
      '/networks/:networkId/attachments/:id/content',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as AttachmentIdParams;
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        sendSuccess(reply, getAttachmentContent(ndb, id));
      },
    );

    app.put(
      '/networks/:networkId/attachments/:id/content',
      {
        preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler],
        bodyLimit: 16 * 1024 * 1024,
      },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as AttachmentIdParams;
        const body = requestBody(req);
        const data = fieldString(body, 'data_base64', req.id);
        if (data === undefined || data === '') {
          throw new EtnError('VALIDATION_ERROR', 'data_base64 обязателен.', {
            field: 'data_base64',
          }, req.id);
        }
        const mime = fieldString(body, 'mime_type', req.id);
        const input = { data_base64: data, mime_type: mime };
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const result = updateAttachmentContent(ndb, id, input);
        const updated = getAttachment(ndb, id);
        deps.emit(req, networkId, 'attachment.updated', {
          id,
          changes: {
            file_size: updated?.file_size ?? null,
            mime_type: updated?.mime_type ?? null,
          },
        });
        sendSuccess(reply, result, { request_id: req.id });
      },
    );
  };
}
