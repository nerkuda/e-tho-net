/**
 * Import routes (phase P, task P4; docs/02-data-model.md §9).
 *
 *   POST /networks/:networkId/import/preview — read-only manifest summary
 *   POST /networks/:networkId/import/commit  — apply a `.etnx` archive (base64)
 *
 * Both endpoints require network membership. The commit endpoint is
 * idempotent via the standard `Client-Request-Id` header (replays return the
 * cached response without re-applying the archive). After a successful commit
 * the route fires realtime events (`thought.created`, `link.created`,
 * `comment.updated`) for every newly created / overwritten entity so the
 * canvas, focus history and selection panels refresh without a manual reload.
 *
 * The archive body is sent as `archive_b64` (base64-encoded zip) inside the
 * JSON envelope; the route decodes it into a `Buffer` and hands it off to
 * `import-service.ts`. The maximum archive size is `ETNX_MAX_BYTES`.
 */

import { Buffer } from 'node:buffer';

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError, ETNX_MAX_BYTES, type ImportSummary } from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import {
  openRouteNetworkDb,
  restWriteFx,
  runWrite,
  type AnyWriteEvent,
  type RouteDeps,
  type WriteActivityEntry,
} from './helpers.js';
import { parseRest, RestImportCommit, RestImportPreview } from '../contracts.js';
import { importFromEtnx, previewFromEtnx } from '../domain/import-service.js';
import { getThought, getThoughtOrThrow } from '../domain/thought-service.js';
import { getLink } from '../domain/link-service.js';
import { getComment } from '../domain/comment-service.js';

/** `/api/v1/networks*` import routes plugin factory. */
export function createImportRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // -- POST /networks/:networkId/import/preview --------------------------
    app.post(
      '/networks/:networkId/import/preview',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (request: FastifyRequest, reply) => {
        const input = parseRest(RestImportPreview, request);
        const archiveB64 = input.archive_b64 as string;
        const buf = decodeArchive(archiveB64, request.id);
        const preview = await previewFromEtnx(buf, app.appLogger);
        return sendSuccess(reply, preview);
      },
    );

    // -- POST /networks/:networkId/import/commit ---------------------------
    app.post(
      '/networks/:networkId/import/commit',
      {
        preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler],
      },
      async (request: FastifyRequest, reply) => {
        const input = parseRest(RestImportCommit, request);
        const networkId = input.network_id;
        const ndb = openRouteNetworkDb(deps, request, networkId, app.appLogger);
        const archiveB64 = input.archive_b64 as string;
        const parentThoughtId = input.parent_thought_id as string;

        // Validate parent up-front so the import transaction does not have to
        // roll back half-way through. Errors here surface as 4xx instead of 5xx.
        getThoughtOrThrow(ndb, parentThoughtId);

        const buf = decodeArchive(archiveB64, request.id);
        const actorUserId = request.auth!.user.id;
        const slices = input.etnx as Parameters<typeof importFromEtnx>[2]['slices'] | undefined;
        // `importFromEtnx` сам держит весь импорт одной транзакцией; она же
        // асинхронна (разбор zip), поэтому обёртка здесь исполняет только
        // пост-коммитные эффекты: события и журнал — из результата импорта.
        const result = await importFromEtnx(
          ndb,
          buf,
          { actorUserId, parentThoughtId, slices },
          app.appLogger,
        );

        // Fire realtime events so other clients (and the importer's own
        // canvas/panels) refresh — the canvas, focus history, and selection
        // cache all listen to thought.created / link.created / comment.updated.
        runWrite(ndb, restWriteFx(deps, request, networkId), () => {
          const events: AnyWriteEvent[] = [];
          const activity: WriteActivityEntry[] = [];
          for (const id of result.createdThoughtIds) {
            const thought = getThought(ndb, id);
            if (thought === null) continue;
            events.push({ type: 'thought.created', data: { thought } });
            activity.push({ kind: 'thought', action: 'created', thought });
          }
          for (const id of result.createdLinkIds) {
            const link = getLink(ndb, id);
            if (link === null) continue;
            events.push({ type: 'link.created', data: { link } });
            activity.push({ kind: 'link', action: 'created', link });
          }
          for (const id of result.updatedCommentIds) {
            const comment = getComment(ndb, id);
            if (comment === null) continue;
            events.push({
              type: 'comment.updated',
              data: {
                id: comment.id,
                owner_id: comment.owner_id,
                kind: comment.kind,
                changes: {
                  body_md: comment.body_md,
                  body_html: comment.body_html,
                  title: comment.title,
                },
                version: comment.version,
              },
            });
            activity.push({ kind: 'comment', action: 'updated', comment });
          }
          return { result: undefined, events, activity };
        });

        const {
          thoughtIdRemap: _remap,
          createdThoughtIds: _t,
          createdLinkIds: _l,
          updatedCommentIds: _c,
          ...summary
        } = result;
        void _remap;
        void _t;
        void _l;
        void _c;
        const responseSummary: ImportSummary = summary;
        return sendSuccess(reply, responseSummary);
      },
    );
  };
}

/**
 * Decode a base64 archive string and check its size against the configured
 * maximum. The actual archive parsing (zip layout, manifest schema) happens
 * inside `import-service.ts` — this is just transport-level validation.
 */
function decodeArchive(archiveB64: string, requestId: string): Buffer {
  const buf = Buffer.from(archiveB64, 'base64');
  if (buf.length === 0) {
    throw new EtnError('VALIDATION_ERROR', 'Архив пустой или не base64.', undefined, requestId);
  }
  if (buf.length > ETNX_MAX_BYTES) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Размер архива ${buf.length} байт превысил лимит ${ETNX_MAX_BYTES}.`,
      { limit: ETNX_MAX_BYTES, actual: buf.length },
      requestId,
    );
  }
  return buf;
}
