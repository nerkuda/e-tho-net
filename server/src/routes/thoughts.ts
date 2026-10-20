/**
 * Thought routes (task D1, 03-server-api.md §6).
 *
 *   GET    /networks/:networkId/thoughts/:id                  — fetch one
 *   POST   /networks/:networkId/thoughts/:id/focus            — focus + neighbours
 *   POST   /networks/:networkId/thoughts                      — create (with create_link)
 *   PATCH  /networks/:networkId/thoughts/:id                  — update (If-Match)
 *   DELETE /networks/:networkId/thoughts/:id                  — delete (If-Match)
 *   GET    /networks/:networkId/thoughts/:id/neighbors        — neighbours (no focus switch)
 *   POST   /networks/:networkId/thoughts/batch                — bulk operations
 *   POST   /networks/:networkId/thoughts/resolve              — bulk light metadata
 *   GET    /networks/:networkId/thoughts/:id/mentions         — mentions of a thought
 *   GET    /networks/:networkId/thoughts/duplicates           — duplicate candidates
 *   PUT    /networks/:networkId/thoughts/:fid/focus-preferences — per-zone sort choice
 *   POST   /networks/:networkId/thoughts/:fid/focus-order     — manual zone order
 *
 * All routes require network membership. Business rules (version conflicts,
 * protected HOME, dedup) live in the domain services; this layer only parses
 * the wire format and maps to them.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import path from 'node:path';

import {
  EtnError,
  PREF_KEY,
  computeDefaultCanvasLinkFilter,
  parseStoredCanvasLinkFilter,
  type CrossNetworkDuplicateResponse,
  type FocusDir,
  type FocusOrderInput,
  type FocusOrderResult,
  type FocusPreferencesInput,
  type LinkTypeFilterInput,
  type SortKind,
  type SortOrder,
  type ThoughtBatchOp,
  type ThoughtBatchResult,
  type ThoughtCopyInput,
  type ThoughtCreateInput,
  type ThoughtUpdateInput,
  type UsageClearResult,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  openRouteNetworkDb,
  parseLinkTypeFilter,
  parseLinkTypeFilterQuery,
  queryStrings,
  requestBody,
  resolveShowTrash,
  restWriteFx,
  runWrite,
  type RouteDeps,
} from './helpers.js';
import {
  parseRest,
  RestFocusBody,
  RestFocusOrderBody,
  RestFocusPrefsBody,
  RestIdsBody,
  RestIfMatch,
  RestNeighborsQuery,
  RestResolveIdsBody,
  RestThoughtDuplicates,
} from '../contracts.js';
import {
  AnchorIdsSchema,
  assertImageIcon,
  parseBody,
  RestThoughtCopyBody,
  RestThoughtCreateBody,
  RestThoughtUpdateBody,
} from '../contracts.js';
import { openNetworkDb, type NetworkDb } from '../db/network-db.js';
import { networkDir } from '../paths.js';
import { setFocusOrder, setFocusPreferences } from '../domain/focus-service.js';
import { runThoughtCreate, runThoughtsBatch, runThoughtsCopy } from '../domain/heavy-write.js';
import { assertLibraryIcon } from '../domain/icon-view.js';
import {
  clearThoughtRefUsages,
  findThoughtUsage,
  listNetworkProperties,
} from '../domain/property-service.js';
import { findBacklinks } from '../domain/backlinks-service.js';
import { findMentions } from '../domain/search-service.js';
import {
  fanOutFindDuplicates,
  type CrossNetworkAccess,
} from '../domain/cross-network-search-service.js';
import { findDuplicatesAsync, neighborsWithTotalAsync, resolveThoughtRefsAsync } from '../domain/heavy-read.js';
import {
  checkThoughtDeletion,
  deleteThought,
  focus,
  getThought,
  updateThought,
} from '../domain/thought-service.js';
import { BULK_THOUGHT_OPS } from '../domain/thought-bulk-service.js';

/** Route params for `:networkId`. */
interface NetworkIdParams {
  networkId: string;
}

/** Route params for a network + thought id. */
interface ThoughtIdParams {
  networkId: string;
  id: string;
}

/** Route params for a network + focus-thought id (focus preferences/order). */
interface FocusIdParams {
  networkId: string;
  fid: string;
}

/** Operators accepted by `POST /thoughts/batch` (03-server-api.md §6.6). */
const BATCH_OPS: readonly ThoughtBatchOp[] = [
  'set_type',
  'clear_type',
  'set_active',
  'set_inactive',
  'delete',
  'trash',
  'purge',
  'link_to_focus',
  'unlink_from_focus',
  'link_parents',
  'link_children',
  'set_only_parents',
  'unlink_parents',
  'unlink_children',
];

function isBatchOp(value: unknown): value is ThoughtBatchOp {
  return typeof value === 'string' && (BATCH_OPS as readonly string[]).includes(value);
}

/**
 * Anchor id list of the bulk link operations (`parent_ids`/`child_ids`,
 * 03-server-api.md §6.6): a non-empty array of non-empty strings, deduped.
 */
function parseAnchorIds(
  raw: unknown,
  field: 'parent_ids' | 'child_ids',
  requestId: string,
): string[] {
  const res = AnchorIdsSchema.safeParse(raw);
  if (!res.success) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `${field} должен быть непустым массивом непустых строк.`,
      { field: `args.${field}` },
      requestId,
    );
  }
  return [...new Set(res.data)];
}

/** Convert a comma-separated synonym string into an array (service dedupes). */
function toSynonymArray(value: string[] | string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : value.split(',');
}

/**
 * Parse and validate the body of `POST /thoughts/copy-batch`. The shape is
 * wide (a list of thought snapshots + a list of inter-thought links) but
 * the per-item validation is light — the service is the source of truth on
 * what can actually be materialised. Here we just make sure the wrapper
 * fields are well-formed and the arrays are non-empty.
 */
function parseThoughtCopyBody(body: Record<string, unknown>, requestId: string): ThoughtCopyInput {
  return parseBody(RestThoughtCopyBody, body, requestId) as unknown as ThoughtCopyInput;
}

/** Parse and validate the body of `POST /thoughts`. */
function parseThoughtCreateBody(
  body: Record<string, unknown>,
  requestId: string,
): ThoughtCreateInput {
  const out = parseBody(RestThoughtCreateBody, body, requestId);
  const iconKind = out.icon_kind as ThoughtCreateInput['icon_kind'];
  if (iconKind === 'image') {
    assertImageIcon(out.icon as string | null | undefined, requestId);
  }
  return {
    title: out.title as string,
    synonyms: toSynonymArray(out.synonyms as string[] | string | undefined),
    type_id: (out.type_id ?? null) as string | null,
    icon: (out.icon ?? null) as string | null,
    icon_kind: iconKind,
    icon_color: (out.icon_color ?? null) as string | null,
    active: out.active as boolean | undefined,
    fg_color: (out.fg_color ?? null) as string | null,
    bg_color: (out.bg_color ?? null) as string | null,
    font_bold: out.font_bold as boolean | undefined,
    font_italic: out.font_italic as boolean | undefined,
    font_underline: out.font_underline as boolean | undefined,
    font_strike: out.font_strike as boolean | undefined,
    create_link: out.create_link as ThoughtCreateInput['create_link'],
    comment: out.comment as ThoughtCreateInput['comment'],
  };
}

/** Parse and validate the body of `PATCH /thoughts/:id`. */
function parseThoughtUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): ThoughtUpdateInput {
  const out = parseBody(RestThoughtUpdateBody, body, requestId);
  const changes: ThoughtUpdateInput = {};
  if (out.title !== undefined) changes.title = out.title as string;
  if (out.synonyms !== undefined)
    changes.synonyms = toSynonymArray(out.synonyms as string[] | string | undefined);
  if (out.type_id !== undefined) changes.type_id = out.type_id as string | null;
  if (out.icon !== undefined) changes.icon = out.icon as string | null;
  if (out.icon_kind !== undefined)
    changes.icon_kind = out.icon_kind as ThoughtUpdateInput['icon_kind'];
  if (out.icon_attachment_id !== undefined)
    changes.icon_attachment_id = out.icon_attachment_id as string | null;
  if (changes.icon_kind === 'image') {
    assertImageIcon(changes.icon, requestId);
  }
  if (out.icon_color !== undefined) changes.icon_color = out.icon_color as string | null;
  if (out.active !== undefined) changes.active = out.active as boolean;
  if (out.marked_for_deletion !== undefined)
    changes.marked_for_deletion = out.marked_for_deletion as boolean;
  if (out.fg_color !== undefined) changes.fg_color = out.fg_color as string | null;
  if (out.bg_color !== undefined) changes.bg_color = out.bg_color as string | null;
  if (out.font_bold !== undefined) changes.font_bold = out.font_bold as boolean | null;
  if (out.font_italic !== undefined) changes.font_italic = out.font_italic as boolean | null;
  if (out.font_underline !== undefined)
    changes.font_underline = out.font_underline as boolean | null;
  if (out.font_strike !== undefined) changes.font_strike = out.font_strike as boolean | null;
  return changes;
}

/**
 * Resolve the `show_inactive` visibility flag: an explicit request-level
 * override wins, otherwise the user's network preference (default `false`).
 */
function resolveShowInactive(
  app: FastifyInstance,
  req: FastifyRequest,
  networkId: string,
  override?: boolean,
): boolean {
  if (override !== undefined) {
    return override;
  }
  const pref = app.systemDb.getNetworkPreference(
    req.auth!.user.id,
    networkId,
    PREF_KEY.SHOW_INACTIVE,
  );
  return pref?.value === true;
}

/**
 * Resolve the effective canvas link-type filter (requirement «Дефолт и
 * хранение фильтра типов связей на карте», 0.8.1): an explicit request-level
 * `link_filter` wins; otherwise the user's stored `PREF_KEY.CANVAS_LINK_FILTER`
 * preference; otherwise the live default computed from `show_on_map` in the
 * property registry (structural links «Родители»/«Потомки» always included).
 */
function resolveCanvasLinkFilter(
  app: FastifyInstance,
  req: FastifyRequest,
  ndb: NetworkDb,
  networkId: string,
  override?: LinkTypeFilterInput,
): LinkTypeFilterInput {
  if (override !== undefined) return override;
  const pref = app.systemDb.getNetworkPreference(
    req.auth!.user.id,
    networkId,
    PREF_KEY.CANVAS_LINK_FILTER,
  );
  const stored = parseStoredCanvasLinkFilter(pref?.value);
  if (stored !== null) return stored;
  return computeDefaultCanvasLinkFilter(listNetworkProperties(ndb));
}

/** `/api/v1/networks*` thought routes plugin factory. */
export function createThoughtsRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // --- Read ---------------------------------------------------------------

    app.get(
      '/networks/:networkId/thoughts/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as ThoughtIdParams;
        // `at_layer_id` — для ленты событий: открыть мысль по id в
        // конкретном слое, не переключая сессию (задача 59119797: фон
        // таблицы событий слетает после клика).
        const atLayerId =
          queryStrings((req.query as Record<string, unknown> | undefined)?.['at_layer_id'])[0] ??
          null;
        const ndb =
          atLayerId !== null
            ? openNetworkDb(deps.dataDir, networkId, app.appLogger, atLayerId)
            : openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const thought = getThought(ndb, id);
        if (thought === null) {
          throw new EtnError('NOT_FOUND', 'Мысль не найдена.', undefined, req.id);
        }
        sendSuccess(reply, thought);
      },
    );

    // --- Focus (03-server-api.md §6.2) --------------------------------------

    app.post(
      '/networks/:networkId/thoughts/:id/focus',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as ThoughtIdParams;
        const focusBody = parseRest(RestFocusBody, req);
        const override = focusBody.show_inactive as boolean | undefined;
        const showInactive = resolveShowInactive(app, req, networkId, override);
        // Показывать содержимое корзины (задача 77923b49): фокус/карта и
        // локальный граф редактора — тот же путь, что show_inactive.
        const showTrash = resolveShowTrash(
          app,
          req.auth!.user.id,
          networkId,
          focusBody.show_trash as boolean | undefined,
        );
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // Задача c965ad03: фильтр обхода по типам связей — зоны, рёбра и
        // индикаторы направлений ограничиваются выбранными типами. Задача
        // «Фильтр типов связей на карте мыслей» (0.8.1): без явного
        // request-level override резолвится из сохранённого предпочтения
        // пользователя, а без него — из `show_on_map` реестра свойств.
        const linkFilter = resolveCanvasLinkFilter(
          app,
          req,
          ndb,
          networkId,
          parseLinkTypeFilter(requestBody(req), req.id),
        );
        const response = runWrite(ndb, restWriteFx(deps, req, networkId), () => ({
          result: focus(ndb, req.auth!.user.id, id, { showInactive, showTrash, linkFilter }),
          events: [
            {
              type: 'thought-view.updated',
              data: {
                thought_id: id,
                last_viewed_at: new Date().toISOString(),
              },
            },
          ],
        }));
        sendSuccess(reply, response);
      },
    );

    // --- Create (03-server-api.md §6.3) -------------------------------------

    app.post(
      '/networks/:networkId/thoughts',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const input = parseThoughtCreateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // Создание мысли GUI-клиента исполняется в write-пуле (задача c744e05c,
        // ADR ca3a9218): фасад `runThoughtCreate` несёт ту же композицию, что
        // раньше жила здесь (мысль + постоянный комментарий + рёбра link-дефолтов
        // и `create_link`), но транзакцию открывает воркер — массовая запись из
        // клиента (вставка текста, серии созданий) больше не держит event loop.
        const thought = await runThoughtCreate(ndb, restWriteFx(deps, req, networkId), input);
        sendCreated(reply, thought, {
          version: thought.version,
          updated_at: thought.updated_at,
          request_id: req.id,
        });
      },
    );

    // --- Update (03-server-api.md §6.4) -------------------------------------

    app.patch(
      '/networks/:networkId/thoughts/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as ThoughtIdParams;
        const expectedVersion = parseRest(RestIfMatch, req).expected_version;
        const changes = parseThoughtUpdateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // Частичная правка может нести только `icon` или только `icon_kind` —
        // правило вида `icon` (задача 610a440e) проверяет ИТОГОВУЮ пару,
        // слитую с сохранённой мыслью. Мысль не найдена — решение за
        // `updateThought` (NOT_FOUND), здесь ничего не проверяем.
        const before = getThought(ndb, id);
        if (before !== null) {
          assertLibraryIcon(
            changes.icon_kind ?? before.icon_kind,
            changes.icon !== undefined ? changes.icon : before.icon,
            req.id,
          );
        }
        const thought = runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          const updated = updateThought(ndb, id, changes, expectedVersion, req.auth!.user.id);
          return {
            result: updated,
            events: [{ type: 'thought.updated', data: { id, changes, version: updated.version } }],
            activity: [{ kind: 'thought', action: 'updated', thought: updated }],
          };
        });
        sendSuccess(reply, thought, {
          version: thought.version,
          updated_at: thought.updated_at,
          request_id: req.id,
        });
      },
    );

    // --- Delete (03-server-api.md §6.5) -------------------------------------

    app.delete(
      '/networks/:networkId/thoughts/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as ThoughtIdParams;
        const expectedVersion = parseRest(RestIfMatch, req).expected_version;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        runWrite(ndb, restWriteFx(deps, req, networkId), () => {
          // Получаем снимок мысли до удаления — он уйдёт в activity_log.
          const existing = getThought(ndb, id);
          // actorUserId нужен для object-lock enforcement (задача 2031df5e).
          deleteThought(ndb, id, expectedVersion, req.auth!.user.id);
          return {
            result: undefined,
            events: [{ type: 'thought.deleted', data: { id } }],
            ...(existing === null
              ? {}
              : {
                  activity: [
                    { kind: 'thought' as const, action: 'deleted' as const, thought: existing },
                  ],
                }),
          };
        });
        reply.code(204).send();
      },
    );

    // --- Deletion check (03-server-api.md §6.5a, task S13) -------------------

    app.get(
      '/networks/:networkId/thoughts/:id/deletion-check',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as ThoughtIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        sendSuccess(reply, checkThoughtDeletion(ndb, id));
      },
    );

    app.post(
      '/networks/:networkId/thoughts/deletion-check-batch',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const ids = [...new Set(parseRest(RestIdsBody, req).ids as unknown as string[])];
        if (ids === undefined || ids.length === 0) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'ids обязателен (непустой массив строк).',
            { field: 'ids' },
            req.id,
          );
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const result: Record<string, import('@etn/shared').ThoughtDeletionCheckResult> = {};
        for (const id of [...new Set(ids)]) {
          result[id] = checkThoughtDeletion(ndb, id);
        }
        sendSuccess(reply, result);
      },
    );

    // --- Neighbours without focus switch (03-server-api.md §6.7) ------------

    app.get(
      '/networks/:networkId/thoughts/:id/neighbors',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { id } = req.params as ThoughtIdParams;
        const input = parseRest(RestNeighborsQuery, req);
        const networkId = input.network_id as string;
        const dirRaw = input.dir as string;
        const sortRaw = input.sort as string | undefined;
        const orderRaw = input.order as string | undefined;
        const typeId = input.type_id as string | undefined;
        // Задача c965ad03: фильтр обхода по типам связей (repeatable
        // `link_type_id` + `include_structural`).
        const linkFilter = parseLinkTypeFilterQuery(req.query as Record<string, unknown>, req.id);
        const limit = input.limit ?? 50;
        const offset = input.offset ?? 0;

        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const neighborOpts = {
          userId: req.auth!.user.id,
          showInactive: resolveShowInactive(
            app,
            req,
            networkId,
            input.show_inactive as boolean | undefined,
          ),
          showTrash: resolveShowTrash(
            app,
            req.auth!.user.id,
            networkId,
            input.show_trash as boolean | undefined,
          ),
          sort: sortRaw as SortKind | undefined,
          order: orderRaw as SortOrder | undefined,
          typeId,
          linkFilter,
        };
        const page = await neighborsWithTotalAsync(
          ndb,
          id,
          dirRaw as FocusDir,
          neighborOpts,
          { limit, offset },
        );
        // Bug fix (0.6.3, thought f2c7c7d3): `total` used to echo the
        // returned page's length, so a neighbour list longer than `limit`
        // looked complete — no signal ever told the caller more rows exist.
        // `total` считается тем же WHERE без LIMIT/OFFSET в reader-воркере
        // (одна задача пула, ошибка 49e05ea0).
        sendList(reply, page.neighbors, page.total, offset, limit);
      },
    );

    // --- Batch (03-server-api.md §6.6) --------------------------------------

    app.post(
      '/networks/:networkId/thoughts/batch',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const body = requestBody(req);

        const idsRaw = body.ids;
        if (
          !Array.isArray(idsRaw) ||
          idsRaw.length === 0 ||
          idsRaw.some((item) => typeof item !== 'string' || item === '')
        ) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'ids должен быть непустым массивом непустых строк.',
            { field: 'ids' },
            req.id,
          );
        }
        const ids = [...new Set(idsRaw as string[])];
        const op = body.op;
        if (!isBatchOp(op)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Недопустимая операция.',
            { field: 'op', allowed: BATCH_OPS },
            req.id,
          );
        }
        const args =
          typeof body.args === 'object' && body.args !== null && !Array.isArray(body.args)
            ? (body.args as Record<string, unknown>)
            : {};

        // Pre-validate op-specific args once (per-id failures stay per-id).
        let setTypeId: string | null | undefined;
        let focusThoughtId: string | undefined;
        let linkTypeForCreate: string | null | undefined;
        let linkTypeForFind: string | null | undefined;
        let direction: 'parent' | 'child' = 'child';
        let anchorParentIds: string[] | undefined;
        let anchorChildIds: string[] | undefined;
        // Type of the links the bulk link ops create (absent/null = untyped);
        // links that already exist keep their type untouched.
        let bulkLinkType: string | null = null;
        if (op === 'set_type') {
          const raw = args.type_id;
          if (raw === undefined) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'Для set_type нужен args.type_id.',
              { field: 'args.type_id' },
              req.id,
            );
          }
          if (raw !== null && typeof raw !== 'string') {
            throw new EtnError(
              'VALIDATION_ERROR',
              'args.type_id должен быть строкой или null.',
              { field: 'args.type_id' },
              req.id,
            );
          }
          setTypeId = raw;
        }
        if (op === 'link_to_focus' || op === 'unlink_from_focus') {
          const rawFocus = args.focus_thought_id;
          if (typeof rawFocus !== 'string' || rawFocus === '') {
            throw new EtnError(
              'VALIDATION_ERROR',
              'Для связи с фокусом нужен args.focus_thought_id.',
              { field: 'args.focus_thought_id' },
              req.id,
            );
          }
          focusThoughtId = rawFocus;
          const rawDirection = args.direction;
          if (rawDirection !== undefined && rawDirection !== 'parent' && rawDirection !== 'child') {
            throw new EtnError(
              'VALIDATION_ERROR',
              'args.direction должен быть "parent" или "child".',
              { field: 'args.direction' },
              req.id,
            );
          }
          direction = rawDirection === 'parent' ? 'parent' : 'child';
          const rawType = args.link_type_id;
          if (rawType !== undefined && rawType !== null && typeof rawType !== 'string') {
            throw new EtnError(
              'VALIDATION_ERROR',
              'args.link_type_id должен быть строкой или null.',
              { field: 'args.link_type_id' },
              req.id,
            );
          }
          linkTypeForCreate = rawType ?? null;
          linkTypeForFind = rawType; // undefined = any type when unlinking
        }
        if (op === 'link_parents' || op === 'set_only_parents' || op === 'unlink_parents') {
          anchorParentIds = parseAnchorIds(args.parent_ids, 'parent_ids', req.id);
        }
        if (op === 'link_children' || op === 'unlink_children') {
          anchorChildIds = parseAnchorIds(args.child_ids, 'child_ids', req.id);
        }
        if (op === 'link_parents' || op === 'link_children' || op === 'set_only_parents') {
          const rawLinkType = args.link_type_id;
          if (
            rawLinkType !== undefined &&
            rawLinkType !== null &&
            typeof rawLinkType !== 'string'
          ) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'args.link_type_id должен быть строкой или null.',
              { field: 'args.link_type_id' },
              req.id,
            );
          }
          bulkLinkType = rawLinkType ?? null;
        }

        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const fx = restWriteFx(deps, req, networkId);

        // Групповые операции, общие с `etn.thoughts.bulk_update` (задача
        // fffe76f2, ADR 162d8e7a), и локальные операции батча
        // (`delete`/`purge`/связь с фокусом) переведены на write-пул (задача
        // b9c70dd8): изменение, журнал активности и real-time-эффекты
        // формируются в домене (`composeThoughtBatch`), а исполняет фасад
        // `runThoughtsBatch` — пул, либо тот же код синхронно (деградация).
        const isBulk = (BULK_THOUGHT_OPS as readonly string[]).includes(op);
        const isFocusOp = op === 'link_to_focus' || op === 'unlink_from_focus';
        const result = await runThoughtsBatch(ndb, fx, {
          ids,
          op,
          ...(isBulk
            ? {
                bulk: {
                  type_id: setTypeId,
                  parent_ids: anchorParentIds,
                  child_ids: anchorChildIds,
                  link_type_id: bulkLinkType,
                },
              }
            : {}),
          ...(isFocusOp
            ? {
                focus: {
                  direction,
                  focus_thought_id: focusThoughtId!,
                  link_type_id: linkTypeForCreate ?? null,
                  find_link_type_id: linkTypeForFind,
                },
              }
            : {}),
        });
        sendSuccess(reply, result satisfies ThoughtBatchResult);
      },
    );

    // --- Copy-batch (workplan L26, task bb8277f6) ----------------------------
    // Paste a clipboard snapshot under `parent_thought_id` in this network.
    // Type and link-type resolution falls back to "drop the type" per spec
    // when nothing fits; scalar property values pass through verbatim.
    // The whole batch is one transaction — partial failure rolls back.

    app.post(
      '/networks/:networkId/thoughts/copy-batch',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const input = parseThoughtCopyBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // Межсетевое копирование: файлы вложений физически переносятся в
        // сеть-получатель (ошибка b83a7d89). `path.basename` отсекает
        // traversal в `source_network_id` — у реального id (UUID) это no-op.
        // Перевод на write-пул (задача b9c70dd8): фасад исполняет запись в пуле
        // (имена копий планирует исполнитель), а файлы пишет САМ фасад после
        // коммита — при откате транзакции осиротевших файлов не остаётся.
        const sourceAttachmentsDir = path.join(
          networkDir(deps.dataDir, path.basename(input.source_network_id)),
          'attachments',
        );
        const result = await runThoughtsCopy(ndb, restWriteFx(deps, req, networkId), input, {
          sourceAttachmentsDir,
          warn: (message, details) => app.appLogger.warn({ ...details }, message),
        });
        sendSuccess(reply, result);
      },
    );

    // --- Resolve (03-server-api.md §6.9) ------------------------------------

    app.post(
      '/networks/:networkId/thoughts/resolve',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestResolveIdsBody, req);
        const networkId = (req.params as NetworkIdParams).networkId;
        const ids = input.ids as unknown as string[];
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const refs = await resolveThoughtRefsAsync(ndb, ids);
        sendList(reply, refs, refs.length, 0, refs.length);
      },
    );

    // --- Mentions (03-server-api.md §13) ------------------------------------

    app.get(
      '/networks/:networkId/thoughts/:id/mentions',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as ThoughtIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const mentions = findMentions(ndb, id);
        sendList(reply, mentions, mentions.length, 0, mentions.length);
      },
    );

    // --- Backlinks (03-server-api.md §13a, task R3) -------------------------

    app.get(
      '/networks/:networkId/thoughts/:id/backlinks',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as ThoughtIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const backlinks = findBacklinks(ndb, id);
        sendList(reply, backlinks, backlinks.length, 0, backlinks.length);
      },
    );

    // --- Usage: reverse link-property lookup (03-server-api.md §9.1, L7) ----

    app.get(
      '/networks/:networkId/thoughts/:id/usage',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as ThoughtIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        sendSuccess(reply, findThoughtUsage(ndb, id));
      },
    );

    // --- Clear usage (03-server-api.md §9.2, task S13) -----------------------

    app.post(
      '/networks/:networkId/thoughts/:id/usage/clear',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, id } = req.params as ThoughtIdParams;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // Умное удаление цели (0.14.1, ADR a967d865) может отказать 422 на
        // ребре, удерживаемом живой тенью слоя (S13). Очистка обязана быть
        // атомарной: без транзакции ранее удалённые рёбра остались бы
        // удалёнными при отказе на одном из следующих. События/журнал — по
        // прежнему не эмитятся (решение оркестратора для usage_clear).
        const cleared = runWrite(ndb, restWriteFx(deps, req, networkId), () => ({
          result: clearThoughtRefUsages(ndb, id),
        }));
        sendSuccess(reply, { cleared } satisfies UsageClearResult);
      },
    );

    // --- Duplicate candidates (add-thought dialog, 03-server-api.md §6.3,
    //     08-ui-spec.md §4.4; MCP find_duplicates) ---------------------------

    app.get(
      '/networks/:networkId/thoughts/duplicates',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestThoughtDuplicates, req);
        const networkId = input.network_id as string;
        const title = input.title as string;
        // Synonyms: repeatable ?synonyms=a&synonyms=b or a comma-separated value.
        const synonyms = ((input.synonyms as string[] | undefined) ?? []).flatMap((value) =>
          value.split(','),
        );
        // Optional thought-type filter (link-property pickers): repeatable
        // ?type_ids=… or a comma-separated value.
        const typeIds = ((input.type_ids as string[] | undefined) ?? []).flatMap((value) =>
          value.split(','),
        );
        // Задача eb1a3f43, требование c98d5d19: веерный режим.
        // Парсер repeatable кладёт `[]` при отсутствии параметра — поэтому
        // проверяем по длине, а не по наличию ключа.
        if ((input.network_ids as string[] | undefined)?.length ?? 0 > 0) {
          const ids = (input.network_ids as string[]).includes(networkId)
            ? (input.network_ids as string[])
            : [networkId, ...(input.network_ids as string[])];
          const requested = [...new Set(ids)];
          // Доступ: владелец ключа или admin — иначе сеть молча исключается.
          const accessibleIds: string[] = [];
          for (const id of requested) {
            if (app.systemDb.getMemberRole(req.auth!.user.id, id) !== null) accessibleIds.push(id);
          }
          const networks = accessibleIds.map((id) => ({
            id,
            display_name: app.systemDb.getNetworkById(id)?.display_name ?? id,
          }));
          if (networks.length === 0) {
            sendSuccess(reply, { hits: [], networks } satisfies CrossNetworkDuplicateResponse);
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
          const result = await fanOutFindDuplicates(access, {
            networkIds: accessibleIds,
            title,
            synonyms,
            typeIds,
          });
          sendSuccess(
            reply,
            {
              hits: result.hits,
              networks: result.networks,
              truncated: result.truncated,
              reason: result.reason,
            } satisfies CrossNetworkDuplicateResponse,
          );
          return;
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const hits = await findDuplicatesAsync(ndb, title, synonyms, typeIds);
        sendList(reply, hits, hits.length, 0, hits.length);
      },
    );

    // --- Focus-zone sort choice (03-server-api.md §6.8) ----------------------

    app.put(
      '/networks/:networkId/thoughts/:fid/focus-preferences',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestFocusPrefsBody, req);
        const { networkId, fid } = req.params as FocusIdParams & NetworkIdParams;
        const dir = input.dir as string;
        const sort = input.sort as string;
        const order = input.order as string;
        // The focus service validates the enum values itself.
        const parsed: FocusPreferencesInput = {
          dir: dir as FocusDir,
          sort: sort as SortKind,
          order: order as SortOrder,
        };
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const result = runWrite(ndb, restWriteFx(deps, req, networkId), () => ({
          result: setFocusPreferences(ndb, req.auth!.user.id, fid, parsed),
          events: [
            {
              type: 'user-focus-preferences.updated',
              data: {
                focus_thought_id: fid,
                dir: parsed.dir,
                sort: parsed.sort,
                sort_order: parsed.order,
              },
            },
          ],
        }));
        sendSuccess(reply, result);
      },
    );

    // --- Manual focus-zone order (03-server-api.md §6.8) ---------------------

    app.post(
      '/networks/:networkId/thoughts/:fid/focus-order',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestFocusOrderBody, req);
        const { networkId, fid } = req.params as FocusIdParams & NetworkIdParams;
        const dir = input.dir as string;
        const orderedIds = input.ordered_ids as unknown as string[];
        const parsed: FocusOrderInput = {
          dir: dir as FocusOrderInput['dir'],
          ordered_ids: orderedIds,
        };
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        runWrite(ndb, restWriteFx(deps, req, networkId), () => ({
          result: setFocusOrder(ndb, req.auth!.user.id, fid, parsed),
          events: [
            {
              type: 'user-focus-order.updated',
              data: {
                focus_thought_id: fid,
                dir: parsed.dir,
                ordered_ids: orderedIds,
              },
            },
          ],
        }));
        sendSuccess(
          reply,
          { focus_thought_id: fid, dir: parsed.dir, ordered_ids: orderedIds } satisfies FocusOrderResult,
        );
      },
    );
  };
}
