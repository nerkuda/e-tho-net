/**
 * Comment routes (task D5, 03-server-api.md §10).
 *
 *   GET/POST /networks/:networkId/thoughts/:id/comments  — list/create on a thought
 *   GET/POST /networks/:networkId/links/:id/comments     — list/create on a link
 *   PATCH    /networks/:networkId/comments/:id           — update (If-Match)
 *   DELETE   /networks/:networkId/comments/:id           — delete (If-Match)
 *
 * Comments are polymorphic (`owner_type` + `owner_id`). The service enforces
 * "one permanent comment per owner" (409 DUPLICATE), validates the owner's
 * existence (404) and renders `body_html` from `body_md`.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  type CommentInput,
  type CommentKind,
  type CommentOwnerType,
  type CommentUpdateInput,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  fieldNullableString,
  fieldString,
  openRouteNetworkDb,
  parseIfMatch,
  requestBody,
  type RouteDeps,
} from './helpers.js';
import {
  createComment,
  deleteComment,
  listComments,
  updateComment,
} from '../domain/comment-service.js';

/** Route params for a network + owner id. */
interface OwnerParams {
  networkId: string;
  id: string;
}

/** Route params for a network + comment id. */
interface CommentIdParams {
  networkId: string;
  id: string;
}

/** Parse and validate the body of `POST …/comments`. */
function parseCommentBody(body: Record<string, unknown>, requestId: string): CommentInput {
  const kind = fieldString(body, 'kind', requestId);
  if (kind === undefined) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'kind обязателен (permanent|chronological).',
      { field: 'kind' },
      requestId,
    );
  }
  const bodyMd = fieldString(body, 'body_md', requestId);
  if (bodyMd === undefined || bodyMd.trim() === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'body_md обязателен и не может быть пустым.',
      { field: 'body_md' },
      requestId,
    );
  }
  return {
    kind: kind as CommentKind,
    title: fieldNullableString(body, 'title', requestId),
    body_md: bodyMd,
    valid_from: fieldString(body, 'valid_from', requestId),
    valid_to: fieldNullableString(body, 'valid_to', requestId),
  };
}

/** Parse and validate the body of `PATCH /comments/:id`. */
function parseCommentUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): CommentUpdateInput {
  const changes: CommentUpdateInput = {};
  if (body.title !== undefined) {
    changes.title = fieldNullableString(body, 'title', requestId);
  }
  if (body.body_md !== undefined) {
    changes.body_md = fieldString(body, 'body_md', requestId);
  }
  if (body.valid_from !== undefined) {
    changes.valid_from = fieldString(body, 'valid_from', requestId);
  }
  if (body.valid_to !== undefined) {
    changes.valid_to = fieldNullableString(body, 'valid_to', requestId);
  }
  return changes;
}

/** `/api/v1/networks*` comment routes plugin factory. */
export function createCommentsRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    /** Register list/create for one owner kind. */
    const registerOwnerRoutes = (pathBase: string, ownerType: CommentOwnerType) => {
      app.get(
        `${pathBase}/comments`,
        { preHandler: [app.authPreHandler, requireNetworkMember()] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id } = req.params as OwnerParams;
          const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
          const comments = listComments(ndb, ownerType, id);
          sendList(reply, comments, comments.length, 0, comments.length);
        },
      );

      app.post(
        `${pathBase}/comments`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const { networkId, id } = req.params as OwnerParams;
          const input = parseCommentBody(requestBody(req), req.id);
          const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
          const comment = createComment(ndb, ownerType, id, input, req.auth!.user.id);
          sendCreated(reply, comment, {
            version: comment.version,
            updated_at: comment.updated_at,
            request_id: req.id,
          });
        },
      );
    };

    registerOwnerRoutes('/networks/:networkId/thoughts/:id', 'thought');
    registerOwnerRoutes('/networks/:networkId/links/:id', 'link');

    app.patch(
      '/networks/:networkId/comments/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as CommentIdParams;
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const changes = parseCommentUpdateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const comment = updateComment(ndb, id, changes, expectedVersion, req.auth!.user.id);
        sendSuccess(reply, comment, {
          version: comment.version,
          updated_at: comment.updated_at,
          request_id: req.id,
        });
      },
    );

    app.delete(
      '/networks/:networkId/comments/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as CommentIdParams;
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        deleteComment(ndb, id, expectedVersion);
        reply.code(204).send();
      },
    );
  };
}
