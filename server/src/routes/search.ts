/**
 * Search, export and job routes (task D6, 03-server-api.md §12, §14, §21).
 *
 *   GET  /networks/:networkId/search            — full-text search (§12)
 *   POST /networks/:networkId/mentions/scan     — thought mentions in text (§21, L24)
 *   POST /networks/:networkId/export            — start an export job (202 + job_id)
 *   GET  /jobs/:jobId                           — job status
 *   GET  /jobs/:jobId/download                  — finished job content (binary stream)
 *
 * Search accepts the legacy `scope=thoughts|links|chronology|all` values of
 * §12 in addition to the granular `names|texts` scopes of the shared contract;
 * `thoughts` is mapped to `names,texts` (two queries merged, see C9 note).
 * Search/export require network membership; the job endpoints require any
 * valid API-key (job ids are UUIDs, treated as capability URLs on MVP).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  ETNX_SUBTREE_DEPTH_MAX,
  EXPORT_FORMATS,
  PREF_KEY,
  type ExportEtnxOptions,
  type ExportFormat,
  type MentionsScanMatch,
  type SearchResponse,
  type SearchScope,
} from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import {
  fieldBoolean,
  fieldString,
  fieldStringArray,
  openRouteNetworkDb,
  queryBoolean,
  queryInt,
  queryStrings,
  requestBody,
  type RouteDeps,
} from './helpers.js';
import { getExportJob, getExportJobContent, startExportJob } from '../domain/export-service.js';
import { findMentionsInTexts, search } from '../domain/search-service.js';

/** `POST /mentions/scan` payload limits (03-server-api.md §21). */
const MENTIONS_SCAN_MAX_TEXTS = 50;
const MENTIONS_SCAN_MAX_TOTAL_CHARS = 20_000;

/** Map a stored export MIME type to the recommended download filename extension. */
function extensionFor(contentType: string): string {
  if (contentType.includes('html')) return 'html';
  if (contentType.includes('markdown')) return 'md';
  if (contentType.includes('zip')) return 'etnx';
  return 'bin';
}

/** Parse the optional `etnx` block of an export request (phase P, P2). */
function parseEtnxOptions(
  body: Record<string, unknown>,
  requestId: string,
): ExportEtnxOptions | undefined {
  const raw = body['etnx'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'Поле etnx должно быть объектом.',
      { field: 'etnx' },
      requestId,
    );
  }
  const obj = raw as Record<string, unknown>;
  const opts: ExportEtnxOptions = {};
  if (obj['include_types'] !== undefined) {
    if (typeof obj['include_types'] !== 'boolean') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'etnx.include_types должен быть boolean.',
        { field: 'etnx.include_types' },
        requestId,
      );
    }
    opts.include_types = obj['include_types'];
  }
  if (obj['include_attachments'] !== undefined) {
    if (typeof obj['include_attachments'] !== 'boolean') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'etnx.include_attachments должен быть boolean.',
        { field: 'etnx.include_attachments' },
        requestId,
      );
    }
    opts.include_attachments = obj['include_attachments'];
  }
  if (obj['include_chronology'] !== undefined) {
    if (typeof obj['include_chronology'] !== 'boolean') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'etnx.include_chronology должен быть boolean.',
        { field: 'etnx.include_chronology' },
        requestId,
      );
    }
    opts.include_chronology = obj['include_chronology'];
  }
  if (obj['include_subtree'] !== undefined) {
    if (typeof obj['include_subtree'] !== 'boolean') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'etnx.include_subtree должен быть boolean.',
        { field: 'etnx.include_subtree' },
        requestId,
      );
    }
    opts.include_subtree = obj['include_subtree'];
  }
  if (obj['subtree_depth'] !== undefined) {
    if (typeof obj['subtree_depth'] !== 'number' || !Number.isInteger(obj['subtree_depth'])) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'etnx.subtree_depth должен быть целым числом.',
        { field: 'etnx.subtree_depth' },
        requestId,
      );
    }
    const depth = obj['subtree_depth'] as number;
    if (depth < 1 || depth > ETNX_SUBTREE_DEPTH_MAX) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `etnx.subtree_depth должен быть в диапазоне 1..${ETNX_SUBTREE_DEPTH_MAX}.`,
        { field: 'etnx.subtree_depth', min: 1, max: ETNX_SUBTREE_DEPTH_MAX },
        requestId,
      );
    }
    opts.subtree_depth = depth;
  }
  return opts;
}

/** Route params for a network id. */
interface NetworkIdParams {
  networkId: string;
}

/** Route params for a job id. */
interface JobIdParams {
  jobId: string;
}

/** Legacy `scope` values of 03-server-api.md §12 mapped to granular scopes. */
const LEGACY_SCOPE_MAP: Record<string, SearchScope[]> = {
  thoughts: ['names', 'texts'],
  links: ['links'],
  chronology: ['chronology'],
};

/** Every accepted `scope` value (granular shared values + legacy ones). */
const ACCEPTED_SCOPES = new Set<string>([
  'names',
  'texts',
  'links',
  'chronology',
  'all',
  'thoughts',
]);

/** Merge two search responses (used for the legacy `thoughts` scope). */
function mergeSearchResponses(a: SearchResponse, b: SearchResponse): SearchResponse {
  return {
    by_names: [...a.by_names, ...b.by_names],
    by_texts: [...a.by_texts, ...b.by_texts],
    by_links: [...a.by_links, ...b.by_links],
    by_chrono: [...a.by_chrono, ...b.by_chrono],
    meta: {
      total_in_group: {
        names: a.meta.total_in_group.names + b.meta.total_in_group.names,
        texts: a.meta.total_in_group.texts + b.meta.total_in_group.texts,
        links: a.meta.total_in_group.links + b.meta.total_in_group.links,
        chronology: a.meta.total_in_group.chronology + b.meta.total_in_group.chronology,
      },
    },
  };
}

/** `/api/v1/*` search/export/job routes plugin factory. */
export function createSearchRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // --- Search (03-server-api.md §12) --------------------------------------

    app.get(
      '/networks/:networkId/search',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const query = req.query as Record<string, unknown>;

        const q = queryStrings(query.q)[0];
        if (q === undefined || q.trim() === '') {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Параметр q обязателен и не может быть пустым.',
            { field: 'q' },
            req.id,
          );
        }

        const scopeRaw = queryStrings(query.scope)[0];
        if (scopeRaw !== undefined && !ACCEPTED_SCOPES.has(scopeRaw)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Недопустимый scope.',
            { field: 'scope', allowed: [...ACCEPTED_SCOPES] },
            req.id,
          );
        }
        // Legacy `thoughts` → two granular queries merged (names + texts).
        const granularScopes: SearchScope[] = LEGACY_SCOPE_MAP[scopeRaw ?? ''] ?? [
          (scopeRaw as SearchScope | undefined) ?? 'all',
        ];

        const inParam = queryStrings(query.in)[0];
        if (inParam !== undefined && inParam !== 'subtree') {
          throw new EtnError(
            'VALIDATION_ERROR',
            'in должен быть равен "subtree".',
            { field: 'in' },
            req.id,
          );
        }
        const fromThoughtId = queryStrings(query.from_thought_id)[0];
        if (inParam === 'subtree' && fromThoughtId === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'При in=subtree нужен from_thought_id.',
            { field: 'from_thought_id' },
            req.id,
          );
        }

        const pref = app.systemDb.getNetworkPreference(
          req.auth!.user.id,
          networkId,
          PREF_KEY.SHOW_INACTIVE,
        );
        const showInactiveDefault = pref?.value === true;
        const limit = queryInt(query.limit, 50, { field: 'limit', min: 1, requestId: req.id });
        const offset = queryInt(query.offset, 0, { field: 'offset', min: 0, requestId: req.id });

        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const requestBase = {
          q,
          in: inParam as 'subtree' | undefined,
          from_thought_id: fromThoughtId,
          type_id: queryStrings(query.type_id),
          link_type_id: queryStrings(query.link_type_id),
          show_inactive: queryBoolean(query.show_inactive, 'show_inactive', req.id),
          trashed: queryBoolean(query.trashed, 'trashed', req.id),
          limit,
          offset,
        };

        let response: SearchResponse = search(
          ndb,
          { ...requestBase, scope: granularScopes[0] },
          showInactiveDefault,
        );
        for (let i = 1; i < granularScopes.length; i += 1) {
          response = mergeSearchResponses(
            response,
            search(ndb, { ...requestBase, scope: granularScopes[i] }, showInactiveDefault),
          );
        }
        sendSuccess(reply, response);
      },
    );

    // --- Mentions scan (03-server-api.md §21, L24) --------------------------

    app.post(
      '/networks/:networkId/mentions/scan',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const body = requestBody(req);

        const texts = fieldStringArray(body, 'texts', req.id);
        if (texts === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'texts обязателен (массив строк).',
            { field: 'texts' },
            req.id,
          );
        }
        if (texts.length > MENTIONS_SCAN_MAX_TEXTS) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `texts не может содержать больше ${MENTIONS_SCAN_MAX_TEXTS} элементов.`,
            { field: 'texts', max: MENTIONS_SCAN_MAX_TEXTS },
            req.id,
          );
        }
        const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
        if (totalChars > MENTIONS_SCAN_MAX_TOTAL_CHARS) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `Суммарная длина texts не может превышать ${MENTIONS_SCAN_MAX_TOTAL_CHARS} символов.`,
            { field: 'texts', max_total_chars: MENTIONS_SCAN_MAX_TOTAL_CHARS },
            req.id,
          );
        }

        const showInactive = fieldBoolean(body, 'show_inactive', req.id) ?? false;
        const excludeThoughtId = fieldString(body, 'exclude_thought_id', req.id);

        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const results: MentionsScanMatch[][] = findMentionsInTexts(ndb, texts, {
          showInactive,
          excludeThoughtId,
        });
        sendSuccess(reply, { results });
      },
    );

    // --- Export (03-server-api.md §14) --------------------------------------

    app.post(
      '/networks/:networkId/export',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const body = requestBody(req);

        const thoughtIds = fieldStringArray(body, 'thought_ids', req.id);
        if (
          thoughtIds === undefined ||
          thoughtIds.length === 0 ||
          thoughtIds.some((id) => id === '')
        ) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'thought_ids обязателен (непустой массив строк).',
            { field: 'thought_ids' },
            req.id,
          );
        }
        const format = fieldString(body, 'format', req.id);
        if (format === undefined || !(EXPORT_FORMATS as readonly string[]).includes(format)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Недопустимый format.',
            { field: 'format', allowed: EXPORT_FORMATS },
            req.id,
          );
        }

        // .etnx-specific options (phase P, task P2). For other formats these
        // are ignored — passing `etnx: {...}` alongside `format: 'markdown'`
        // is allowed for forward compatibility.
        const etnxOpts = parseEtnxOptions(body, req.id);

        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // PDF is rejected by the service on MVP (VALIDATION_ERROR → 422).
        const job = await startExportJob(ndb, thoughtIds, format as ExportFormat, {
          etnx: etnxOpts,
          source: {
            network_id: networkId,
            network_name: networkId,
            user_id: req.auth!.user.id,
          },
        });
        sendSuccess(reply, { job_id: job.job_id }, undefined, 202);
      },
    );

    // --- Job status / download (03-server-api.md §14) -----------------------

    app.get(
      '/jobs/:jobId',
      { preHandler: [app.authPreHandler] },
      async (req: FastifyRequest, reply) => {
        const { jobId } = req.params as JobIdParams;
        const job = getExportJob(jobId);
        if (job === null) {
          throw new EtnError('NOT_FOUND', 'Задача экспорта не найдена.', undefined, req.id);
        }
        sendSuccess(reply, job);
      },
    );

    app.get(
      '/jobs/:jobId/download',
      { preHandler: [app.authPreHandler] },
      async (req: FastifyRequest, reply) => {
        const { jobId } = req.params as JobIdParams;
        const content = getExportJobContent(jobId);
        if (content === null) {
          throw new EtnError(
            'NOT_FOUND',
            'Результат задачи экспорта недоступен.',
            undefined,
            req.id,
          );
        }
        const extension = extensionFor(content.contentType);
        reply
          .header('content-type', content.contentType)
          .header('content-disposition', `attachment; filename="etn-export.${extension}"`)
          .send(content.body);
      },
    );
  };
}
