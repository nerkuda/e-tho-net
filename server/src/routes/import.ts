/**
 * Import routes (phase P, task P4; docs/02-data-model.md §9).
 *
 *   POST /networks/:networkId/import/preview — read-only manifest summary
 *   POST /networks/:networkId/import/commit  — apply a `.etnx` archive (base64)
 *
 * Both endpoints require network membership. The commit endpoint is
 * idempotent via the standard `Client-Request-Id` header (replays return the
 * cached response without re-applying the archive).
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
        const result = await importFromEtnx(
          ndb,
          buf,
          { actorUserId, parentThoughtId },
          app.appLogger,
        );
        const { thoughtIdRemap: _remap, ...summary } = result;
        // thoughtIdRemap is informative; the REST contract returns just the summary.
        void _remap;
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
