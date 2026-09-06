/**
 * Comment routes (task D5, L20; 03-server-api.md §10).
 *
 *   GET/POST /networks/:networkId/thoughts/:id/comments  — list/create on a thought
 *   GET/POST /networks/:networkId/links/:id/comments     — list/create on a link
 *   POST     /networks/:networkId/comments                — create with 1..N targets (L20)
 *   GET      /networks/:networkId/comments/:id            — fetch one with all targets (L20)
 *   PATCH    /networks/:networkId/comments/:id            — update (If-Match)
 *   DELETE   /networks/:networkId/comments/:id            — delete (If-Match)
 *   POST     /networks/:networkId/comments/:id/targets                 — attach one more owner (L20)
 *   DELETE   /networks/:networkId/comments/:id/targets/:ownerType/:ownerId — detach (L20)
 *
 * Comments are polymorphic (`owner_type` + `owner_id`); a chronological
 * comment may be attached to several owners via `comment_targets` (L20). The
 * service enforces "one permanent comment per owner" (409 DUPLICATE),
 * validates the owner's existence (404) and renders `body_html` from
 * `body_md`.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  COMMENT_OWNER_TYPES,
  EtnError,
  type CommentInput,
  type CommentKind,
  type CommentOwnerType,
  type CommentTarget,
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
  addCommentTarget,
  createComment,
  createCommentWithTargets,
  deleteComment,
  getComment,
  listComments,
  removeCommentTarget,
  updateComment,
} from '../domain/comment-service.js';
import { recordCommentActivity } from '../domain/activity-service.js';

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

/** Route params for a network + comment id + one target. */
interface TargetParams {
  networkId: string;
  id: string;
  ownerType: string;
  ownerId: string;
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

/** Parse the `targets` array of `POST /networks/:nid/comments` (L20). */
function parseTargets(body: Record<string, unknown>, requestId: string): CommentTarget[] {
  const raw = body['targets'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'targets обязателен: массив { owner_type, owner_id } (1 и более).',
      { field: 'targets' },
      requestId,
    );
  }
  const targets: CommentTarget[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'каждый элемент targets — объект { owner_type, owner_id }.',
        { field: 'targets' },
        requestId,
      );
    }
    const rec = item as Record<string, unknown>;
    const ownerType = rec['owner_type'];
    const ownerId = rec['owner_id'];
    if (
      typeof ownerType !== 'string' ||
      !(COMMENT_OWNER_TYPES as readonly string[]).includes(ownerType) ||
      typeof ownerId !== 'string' ||
      ownerId === ''
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'каждый элемент targets — { owner_type: thought|link, owner_id: непустая строка }.',
        { field: 'targets' },
        requestId,
      );
    }
    targets.push({ owner_type: ownerType as CommentOwnerType, owner_id: ownerId });
  }
  return targets;
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
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
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
          const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
          const comment = createComment(ndb, ownerType, id, input, req.auth!.user.id);
          deps.emit(req, networkId, 'comment.created', { comment });
          recordCommentActivity(ndb, {
            networkId,
            userId: req.auth!.user.id,
            action: 'created',
            comment,
            layerId: req.layerEcho?.id ?? null,
          });
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

    // Create a comment attached to several owners at once (L20).
    app.post(
      '/networks/:networkId/comments',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as { networkId: string };
        const body = requestBody(req);
        const input = parseCommentBody(body, req.id);
        const targets = parseTargets(body, req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const comment = createCommentWithTargets(ndb, targets, input, req.auth!.user.id);
        deps.emit(req, networkId, 'comment.created', { comment });
        recordCommentActivity(ndb, {
          networkId,
          userId: req.auth!.user.id,
          action: 'created',
          comment,
          layerId: req.layerEcho?.id ?? null,
        });
        sendCreated(reply, comment, {
          version: comment.version,
          updated_at: comment.updated_at,
          request_id: req.id,
        });
      },
    );

    // Fetch one comment with all its targets (L20).
    app.get(
      '/networks/:networkId/comments/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as CommentIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const comment = getComment(ndb, id);
        if (comment === null) {
          throw new EtnError('NOT_FOUND', `comment ${id} not found`, { entity: 'comment', id }, req.id);
        }
        sendSuccess(reply, comment);
      },
    );

    app.patch(
      '/networks/:networkId/comments/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as CommentIdParams;
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const changes = parseCommentUpdateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const comment = updateComment(ndb, id, changes, expectedVersion, req.auth!.user.id);
        deps.emit(req, networkId, 'comment.updated', {
          id,
          changes,
          version: comment.version,
        });
        recordCommentActivity(ndb, {
          networkId,
          userId: req.auth!.user.id,
          action: 'updated',
          comment,
          layerId: req.layerEcho?.id ?? null,
        });
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
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const existing = getComment(ndb, id);
        deleteComment(ndb, id, expectedVersion);
        if (existing) {
          deps.emit(req, networkId, 'comment.deleted', {
            owner_type: existing.owner_type,
            owner_id: existing.owner_id,
            id,
          });
          recordCommentActivity(ndb, {
            networkId,
            userId: req.auth!.user.id,
            action: 'deleted',
            comment: existing,
            layerId: req.layerEcho?.id ?? null,
          });
        }
        reply.code(204).send();
      },
    );

    // Attach the comment to one more owner (L20).
    app.post(
      '/networks/:networkId/comments/:id/targets',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as CommentIdParams;
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const body = requestBody(req);
        const ownerType = fieldString(body, 'owner_type', req.id);
        const ownerId = fieldString(body, 'owner_id', req.id);
        if (ownerType === undefined || ownerId === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'owner_type (thought|link) и owner_id обязательны.',
            { field: 'owner_type/owner_id' },
            req.id,
          );
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const comment = addCommentTarget(
          ndb,
          id,
          ownerType as CommentOwnerType,
          ownerId,
          expectedVersion,
          req.auth!.user.id,
        );
        deps.emit(req, networkId, 'comment.updated', {
          id,
          changes: { targets: comment.targets },
          version: comment.version,
        });
        sendSuccess(reply, comment, {
          version: comment.version,
          updated_at: comment.updated_at,
          request_id: req.id,
        });
      },
    );

    // Detach the comment from one owner (L20).
    app.delete(
      '/networks/:networkId/comments/:id/targets/:ownerType/:ownerId',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id, ownerType, ownerId } = req.params as TargetParams;
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const comment = removeCommentTarget(
          ndb,
          id,
          ownerType as CommentOwnerType,
          ownerId,
          expectedVersion,
          req.auth!.user.id,
        );
        deps.emit(req, networkId, 'comment.updated', {
          id,
          changes: { targets: comment.targets },
          version: comment.version,
        });
        sendSuccess(reply, comment, {
          version: comment.version,
          updated_at: comment.updated_at,
          request_id: req.id,
        });
      },
    );
  };
}
