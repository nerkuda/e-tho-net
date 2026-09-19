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
 *
 * Веха 8 (задача c9d5f21e): вход — единые контракты из `contracts.ts`.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  type CommentInput,
  type CommentKind,
  type CommentOwnerType,
  type CommentTarget,
  type CommentUpdateInput,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import { openRouteNetworkDb, restWriteFx, runWrite, type RouteDeps } from './helpers.js';
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
import {
  parseRest,
  RestCommentAddTarget,
  RestCommentById,
  RestCommentCreateOwner,
  RestCommentCreateTargets,
  RestCommentDetachTarget,
  RestCommentListOwner,
  RestCommentUpdate,
} from '../contracts.js';

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
          const input = parseRest(RestCommentListOwner, req);
          const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
          const comments = listComments(ndb, ownerType, input.owner_id);
          sendList(reply, comments, comments.length, 0, comments.length);
        },
      );

      app.post(
        `${pathBase}/comments`,
        { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
        async (req: FastifyRequest, reply) => {
          const input = parseRest(RestCommentCreateOwner, req);
          const parsed: CommentInput = {
            kind: input.kind as CommentKind,
            title: input.title,
            body_md: input.body_md,
            valid_from: input.valid_from,
            valid_to: input.valid_to,
          };
          const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
          const comment = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
            const created = createComment(
              ndb,
              ownerType,
              input.owner_id,
              parsed,
              req.auth!.user.id,
            );
            return {
              result: created,
              events: [{ type: 'comment.created', data: { comment: created } }],
              activity: [{ kind: 'comment', action: 'created', comment: created }],
            };
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
        const input = parseRest(RestCommentCreateTargets, req);
        const parsed: CommentInput = {
          kind: input.kind as CommentKind,
          title: input.title,
          body_md: input.body_md,
          valid_from: input.valid_from,
          valid_to: input.valid_to,
        };
        const targets = input.targets as CommentTarget[];
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const comment = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const created = createCommentWithTargets(ndb, targets, parsed, req.auth!.user.id);
          return {
            result: created,
            events: [{ type: 'comment.created', data: { comment: created } }],
            activity: [{ kind: 'comment', action: 'created', comment: created }],
          };
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
        const input = parseRest(RestCommentById, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const comment = getComment(ndb, input.comment_id);
        if (comment === null) {
          throw new EtnError(
            'NOT_FOUND',
            `comment ${input.comment_id} not found`,
            { entity: 'comment', id: input.comment_id },
            req.id,
          );
        }
        sendSuccess(reply, comment);
      },
    );

    app.patch(
      '/networks/:networkId/comments/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestCommentUpdate, req);
        const changes: CommentUpdateInput = {};
        if (input.title !== undefined) changes.title = input.title;
        if (input.body_md !== undefined) changes.body_md = input.body_md;
        if (input.valid_from !== undefined) changes.valid_from = input.valid_from;
        if (input.valid_to !== undefined) changes.valid_to = input.valid_to;
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const comment = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const updated = updateComment(
            ndb,
            input.comment_id,
            changes,
            input.expected_version,
            req.auth!.user.id,
          );
          return {
            result: updated,
            events: [
              {
                type: 'comment.updated',
                data: { id: input.comment_id, changes, version: updated.version },
              },
            ],
            activity: [{ kind: 'comment', action: 'updated', comment: updated }],
          };
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
        const input = parseRest(RestCommentById, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const existing = getComment(ndb, input.comment_id);
          deleteComment(ndb, input.comment_id, input.expected_version);
          return {
            result: undefined,
            ...(existing === null
              ? {}
              : {
                  events: [
                    {
                      type: 'comment.deleted' as const,
                      data: {
                        owner_type: existing.owner_type,
                        owner_id: existing.owner_id,
                        id: input.comment_id,
                      },
                    },
                  ],
                  activity: [
                    { kind: 'comment' as const, action: 'deleted' as const, comment: existing },
                  ],
                }),
          };
        });
        reply.code(204).send();
      },
    );

    // Attach the comment to one more owner (L20).
    app.post(
      '/networks/:networkId/comments/:id/targets',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestCommentAddTarget, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const comment = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const updated = addCommentTarget(
            ndb,
            input.comment_id,
            input.owner_type as CommentOwnerType,
            input.owner_id,
            input.expected_version,
            req.auth!.user.id,
          );
          return {
            result: updated,
            events: [
              {
                type: 'comment.updated',
                data: {
                  id: input.comment_id,
                  changes: { targets: updated.targets },
                  version: updated.version,
                },
              },
            ],
          };
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
        const input = parseRest(RestCommentDetachTarget, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const comment = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const updated = removeCommentTarget(
            ndb,
            input.comment_id,
            input.owner_type as CommentOwnerType,
            input.owner_id,
            input.expected_version,
            req.auth!.user.id,
          );
          return {
            result: updated,
            events: [
              {
                type: 'comment.updated',
                data: {
                  id: input.comment_id,
                  changes: { targets: updated.targets },
                  version: updated.version,
                },
              },
            ],
          };
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
