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
import { openRouteNetworkDb, requestBody, type RouteDeps } from './helpers.js';
import { importFromEtnx, previewFromEtnx } from '../domain/import-service.js';
import { getThoughtOrThrow } from '../domain/thought-service.js';

/** `/api/v1/networks*` import routes plugin factory. */
export function createImportRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // -- POST /networks/:networkId/import/preview --------------------------
    app.post(
      '/networks/:networkId/import/preview',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (request: FastifyRequest, reply) => {
        const networkId = (request.params as { networkId: string }).networkId;
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const body = requestBody(request);
        const archiveB64 = readArchiveB64(body, request.id);
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
        const networkId = (request.params as { networkId: string }).networkId;
        const ndb = openRouteNetworkDb(deps, networkId, app.appLogger);
        const body = requestBody(request);
        const archiveB64 = readArchiveB64(body, request.id);
        const parentThoughtId = readParentThoughtId(body, request.id);

        // Validate parent up-front so the import transaction does not have to
        // roll back half-way through. Errors here surface as 4xx instead of 5xx.
        getThoughtOrThrow(ndb, parentThoughtId);

        const buf = decodeArchive(archiveB64, request.id);
        const actorUserId = request.auth!.user.id;
        const slices = readImportSlices(body);
        const result = await importFromEtnx(
          ndb,
          buf,
          { actorUserId, parentThoughtId, slices },
          app.appLogger,
        );

        // Fire realtime events so other clients (and the importer's own
        // canvas/panels) refresh — the canvas, focus history, and selection
        // cache all listen to thought.created / link.created / comment.updated.
        for (const id of result.createdThoughtIds) {
          const thought = ndb
            .prepare(
              'SELECT id, title, title_norm, type_id, icon, icon_kind, active, is_protected, is_root, fg_color, bg_color, font_bold, font_italic, font_underline, font_strike, version, created_at, created_by, updated_at, updated_by FROM thoughts WHERE id = ?',
            )
            .get(id) as unknown as import('@etn/shared').Thought | undefined;
          if (thought === undefined) continue;
          deps.emit(request, networkId, 'thought.created', { thought });
        }
        for (const id of result.createdLinkIds) {
          const link = ndb
            .prepare(
              'SELECT id, source_id, target_id, type_id, color, style, width, active, version, created_at, updated_at, created_by, updated_by FROM links WHERE id = ?',
            )
            .get(id) as unknown as import('@etn/shared').Link | undefined;
          if (link === undefined) continue;
          deps.emit(request, networkId, 'link.created', { link });
        }
        for (const id of result.updatedCommentIds) {
          const comment = ndb
            .prepare(
              'SELECT id, owner_type, owner_id, kind, title, body_md, body_html, valid_from, valid_to, version, created_at, updated_at, created_by, updated_by FROM comments WHERE id = ?',
            )
            .get(id) as unknown as import('@etn/shared').Comment | undefined;
          if (comment === undefined) continue;
          deps.emit(request, networkId, 'comment.updated', {
            id: comment.id,
            changes: {
              body_md: comment.body_md,
              body_html: comment.body_html,
              title: comment.title,
            },
            version: comment.version,
          });
        }

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

/** Extract `archive_b64` (string) from a JSON body. */
function readArchiveB64(body: Record<string, unknown>, requestId: string): string {
  const value = body['archive_b64'];
  if (typeof value !== 'string' || value === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Поле archive_b64 обязательно и должно быть непустой строкой.',
      { field: 'archive_b64' },
      requestId,
    );
  }
  return value;
}

/** Extract `parent_thought_id` (UUID) from a JSON body. */
function readParentThoughtId(body: Record<string, unknown>, requestId: string): string {
  const value = body['parent_thought_id'];
  if (typeof value !== 'string' || value === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Поле parent_thought_id обязательно и должно быть UUID.',
      { field: 'parent_thought_id' },
      requestId,
    );
  }
  return value;
}

/** Type alias for the `slices` parameter of `importFromEtnx`. */
type ImportSlices = NonNullable<Parameters<typeof importFromEtnx>[2]['slices']>;

/**
 * Extract the optional `etnx` slice toggles from a JSON body. Returns
 * `undefined` when the field is absent — the import service then defaults
 * to importing every slice.
 */
function readImportSlices(body: Record<string, unknown>): ImportSlices | undefined {
  const raw = body['etnx'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EtnError('VALIDATION_ERROR', 'Поле etnx должно быть объектом.', {
      field: 'etnx',
    });
  }
  const obj = raw as Record<string, unknown>;
  const slices: ImportSlices = {};
  if (obj['include_types'] !== undefined) {
    if (typeof obj['include_types'] !== 'boolean') {
      throw new EtnError('VALIDATION_ERROR', 'etnx.include_types должен быть boolean.', {
        field: 'etnx.include_types',
      });
    }
    slices.include_types = obj['include_types'];
  }
  if (obj['include_attachments'] !== undefined) {
    if (typeof obj['include_attachments'] !== 'boolean') {
      throw new EtnError('VALIDATION_ERROR', 'etnx.include_attachments должен быть boolean.', {
        field: 'etnx.include_attachments',
      });
    }
    slices.include_attachments = obj['include_attachments'];
  }
  if (obj['include_chronology'] !== undefined) {
    if (typeof obj['include_chronology'] !== 'boolean') {
      throw new EtnError('VALIDATION_ERROR', 'etnx.include_chronology должен быть boolean.', {
        field: 'etnx.include_chronology',
      });
    }
    slices.include_chronology = obj['include_chronology'];
  }
  return slices;
}

/**
 * Decode a base64 archive string and check its size against the configured
 * maximum. The actual archive parsing (zip layout, manifest schema) happens
 * inside `import-service.ts` — this is just transport-level validation.
 */
function decodeArchive(archiveB64: string, requestId: string): Buffer {
  const buf = Buffer.from(archiveB64, 'base64');
  if (buf.length === 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Архив пустой или не base64.',
      undefined,
      requestId,
    );
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
