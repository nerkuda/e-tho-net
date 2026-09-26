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
 *
 * Cross-network fan-out (задача eb1a3f43, требование c98d5d19): при наличии
 * `?network_ids=...` в строке запроса веером по сетям с последующим
 * слиянием результата (см. `cross-network-search-service`).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  PREF_KEY,
  type ExportEtnxOptions,
  type ExportFormat,
  type ExportJobStartResult,
  type MentionsScanMatch,
  type MentionsScanResponse,
  type SearchResponse,
  type SearchScope,
} from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import { openRouteNetworkDb, type RouteDeps } from './helpers.js';
import { parseRest, RestExport, RestJobById, RestMentionsScan, RestSearchQuery } from '../contracts.js';
import { getExportJob, getExportJobContent, startExportJob } from '../domain/export-service.js';
import { findMentionsInTexts } from '../domain/search-service.js';
import { searchAsync } from '../domain/heavy-read.js';
import {
  fanOutSearch,
  type CrossNetworkAccess,
} from '../domain/cross-network-search-service.js';

/** Map a stored export MIME type to the recommended download filename extension. */
function extensionFor(contentType: string): string {
  if (contentType.includes('html')) return 'html';
  if (contentType.includes('markdown')) return 'md';
  if (contentType.includes('zip')) return 'etnx';
  return 'bin';
}

/** Legacy `scope` values of 03-server-api.md §12 mapped to granular scopes. */
const LEGACY_SCOPE_MAP: Record<string, SearchScope[]> = {
  thoughts: ['names', 'texts'],
  links: ['links'],
  chronology: ['chronology'],
};

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
        const input = parseRest(RestSearchQuery, req);
        const networkId = input.network_id as string;
        const q = input.q as string;

        const scopeRaw = input.scope as string | undefined;
        // Legacy `thoughts` → two granular queries merged (names + texts).
        const granularScopes: SearchScope[] = LEGACY_SCOPE_MAP[scopeRaw ?? ''] ?? [
          (scopeRaw as SearchScope | undefined) ?? 'all',
        ];

        const inParam = input.in as 'subtree' | undefined;
        const fromThoughtId = input.from_thought_id as string | undefined;

        const pref = app.systemDb.getNetworkPreference(
          req.auth!.user.id,
          networkId,
          PREF_KEY.SHOW_INACTIVE,
        );
        const showInactiveDefault = pref?.value === true;
        const limit = input.limit ?? 50;
        const offset = input.offset ?? 0;

        // Задача eb1a3f43, требование c98d5d19: веерный режим.
        // Парсер repeatable кладёт `[]` при отсутствии параметра — поэтому
        // проверяем по длине, а не по наличию ключа.
        if ((input.network_ids as string[] | undefined)?.length ?? 0 > 0) {
          const requested = (input.network_ids as string[]).includes(networkId)
            ? (input.network_ids as string[])
            : [networkId, ...(input.network_ids as string[])];
          const unique = [...new Set(requested)];
          // Доступ: владелец ключа или admin — иначе сеть молча исключается.
          const accessibleIds: string[] = [];
          for (const id of unique) {
            if (app.systemDb.getMemberRole(req.auth!.user.id, id) !== null) accessibleIds.push(id);
          }
          const networks = accessibleIds.map((id) => ({
            id,
            display_name: app.systemDb.getNetworkById(id)?.display_name ?? id,
          }));
          if (networks.length === 0) {
            sendSuccess(reply, {
              by_names: [],
              by_texts: [],
              by_links: [],
              by_chrono: [],
              meta: { total_in_group: { names: 0, texts: 0, links: 0, chronology: 0 } },
              networks: [],
            } satisfies SearchResponse);
            return;
          }
          const access: CrossNetworkAccess = {
            networks,
            accessibleIds,
            dataDir: deps.dataDir,
            userId: req.auth!.user.id,
            clientId:
              req.auth?.clientId ??
              (req.headers['x-etn-client-id'] as string | undefined) ??
              `rest:${req.auth!.user.id}`,
            logger: app.appLogger,
          };
          // Legacy `thoughts` → names+texts. Для веерного режима мы мапим в
          // первый scope, чтобы per-сеть лимит не задваивался; merge ниже
          // приведёт к тем же группам, что и при двух scope-ах.
          const result = fanOutSearch(access, {
            networkIds: accessibleIds,
            q,
            scope: granularScopes[0],
            in: inParam,
            from_thought_id: fromThoughtId,
            type_id: (input.type_id ?? []) as string[],
            link_type_id: (input.link_type_id ?? []) as string[],
            show_inactive: input.show_inactive as boolean | undefined,
            trashed: input.trashed as boolean | undefined,
            author_id: input.author_id as string | undefined,
            editor_id: input.editor_id as string | undefined,
            limit,
            offset,
            showInactiveDefault,
          });
          sendSuccess(reply, { ...result.response, networks: result.networks } satisfies SearchResponse);
          return;
        }

        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const requestBase = {
          q,
          in: inParam as 'subtree' | undefined,
          from_thought_id: fromThoughtId,
          type_id: (input.type_id ?? []) as string[],
          link_type_id: (input.link_type_id ?? []) as string[],
          show_inactive: input.show_inactive as boolean | undefined,
          trashed: input.trashed as boolean | undefined,
          // Фильтры авторства (задача 59119797): query-параметры
          // `author_id`/`editor_id`, семантически эквивалентные MCP-тулу
          // `etn.thoughts.search`. Пустая строка и отсутствие — фильтр не
          // применяется (domain-слой сам приводит к `null`).
          author_id: input.author_id as string | undefined,
          editor_id: input.editor_id as string | undefined,
          limit,
          offset,
        };

        let response: SearchResponse = await searchAsync(
          ndb,
          { ...requestBase, scope: granularScopes[0] },
          showInactiveDefault,
        );
        for (let i = 1; i < granularScopes.length; i += 1) {
          response = mergeSearchResponses(
            response,
            await searchAsync(ndb, { ...requestBase, scope: granularScopes[i] }, showInactiveDefault),
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
        const input = parseRest(RestMentionsScan, req);
        const networkId = input.network_id;
        const texts = input.texts as string[];
        const showInactive = (input.show_inactive as boolean | undefined) ?? false;
        const excludeThoughtId = input.exclude_thought_id as string | undefined;

        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const results: MentionsScanMatch[][] = findMentionsInTexts(ndb, texts, {
          showInactive,
          excludeThoughtId,
        });
        sendSuccess(reply, { results } satisfies MentionsScanResponse);
      },
    );

    // --- Export (03-server-api.md §14) --------------------------------------

    app.post(
      '/networks/:networkId/export',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestExport, req);
        const networkId = input.network_id;
        const thoughtIds = input.thought_ids as string[];
        const format = input.format as ExportFormat;

        // .etnx-specific options (phase P, task P2). For other formats these
        // are ignored — passing `etnx: {...}` alongside `format: 'markdown'`
        // is allowed for forward compatibility.
        const etnxOpts = input.etnx as ExportEtnxOptions | undefined;

        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // Имя сети-источника для манифеста `.etnx` — display_name из реестра,
        // а не id (ошибка b52caa66); фолбэк на id, если записи нет.
        const networkName = app.systemDb.getNetworkById(networkId)?.display_name ?? networkId;
        // PDF is rejected by the service on MVP (VALIDATION_ERROR → 422).
        const job = await startExportJob(ndb, thoughtIds, format as ExportFormat, {
          etnx: etnxOpts,
          source: {
            network_id: networkId,
            network_name: networkName,
            user_id: req.auth!.user.id,
          },
        });
        sendSuccess(reply, { job_id: job.job_id } satisfies ExportJobStartResult, undefined, 202);
      },
    );

    // --- Job status / download (03-server-api.md §14) -----------------------

    app.get(
      '/jobs/:jobId',
      { preHandler: [app.authPreHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestJobById, req);
        const job = getExportJob(input.job_id);
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
        const input = parseRest(RestJobById, req);
        const content = getExportJobContent(input.job_id);
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
