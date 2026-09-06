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

import {
  EtnError,
  FOCUS_DIRS,
  PREF_KEY,
  SORT_KINDS,
  SORT_ORDERS,
  type FocusDir,
  type FocusOrderInput,
  type FocusPreferencesInput,
  type SortKind,
  type SortOrder,
  type ThoughtBatchFailure,
  type ThoughtBatchOp,
  type ThoughtCopyInput,
  type ThoughtCreateInput,
  type ThoughtUpdateInput,
} from '@etn/shared';

import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import {
  assertImageIcon,
  fieldBoolean,
  fieldNullableBoolean,
  fieldNullableString,
  fieldString,
  fieldStringArray,
  fieldStringOrArray,
  openRouteNetworkDb,
  parseIconKind,
  parseIfMatch,
  queryBoolean,
  queryInt,
  queryStrings,
  requestBody,
  type RouteDeps,
} from './helpers.js';
import { setFocusOrder, setFocusPreferences } from '../domain/focus-service.js';
import { createLink, deleteLink, findLinksBetween, incomingLinksOf } from '../domain/link-service.js';
import { clearThoughtRefUsages, findThoughtUsage } from '../domain/property-service.js';
import { findBacklinks } from '../domain/backlinks-service.js';
import { findDuplicates, findMentions } from '../domain/search-service.js';
import {
  checkThoughtDeletion,
  countNeighbors,
  createThought,
  deleteThought,
  focus,
  getNeighbors,
  getThought,
  resolveThoughts,
  updateThought,
} from '../domain/thought-service.js';
import { copyThoughtsBatch } from '../domain/thought-copy-service.js';

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
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((v) => typeof v !== 'string' || v === '')) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `${field} должен быть непустым массивом непустых строк.`,
      { field: `args.${field}` },
      requestId,
    );
  }
  return [...new Set(raw as string[])];
}

/** Convert a comma-separated synonym string into an array (service dedupes). */
function toSynonymArray(value: string[] | string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : value.split(',');
}

/** UUID shape used to validate the `source_id` extension on each snapshot. */
const UUID_RE_FOR_SOURCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse and validate the body of `POST /thoughts/copy-batch`. The shape is
 * wide (a list of thought snapshots + a list of inter-thought links) but
 * the per-item validation is light — the service is the source of truth on
 * what can actually be materialised. Here we just make sure the wrapper
 * fields are well-formed and the arrays are non-empty.
 */
function parseThoughtCopyBody(
  body: Record<string, unknown>,
  requestId: string,
): ThoughtCopyInput {
  const sourceNetworkId = fieldString(body, 'source_network_id', requestId);
  if (sourceNetworkId === undefined || sourceNetworkId === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'source_network_id обязателен и не может быть пустым.',
      { field: 'source_network_id' },
      requestId,
    );
  }
  const parentThoughtId = fieldString(body, 'parent_thought_id', requestId);
  if (parentThoughtId === undefined || parentThoughtId === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'parent_thought_id обязателен и не может быть пустым.',
      { field: 'parent_thought_id' },
      requestId,
    );
  }
  const thoughtsRaw = body.thoughts;
  const linksRaw = body.links;
  if (!Array.isArray(thoughtsRaw) || thoughtsRaw.length === 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'thoughts должен быть непустым массивом снимков мыслей.',
      { field: 'thoughts' },
      requestId,
    );
  }
  const thoughts: import('@etn/shared').ThoughtCopyItem[] = [];
  for (const [idx, raw] of thoughtsRaw.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `thoughts[${idx}] должен быть объектом.`,
        { field: `thoughts[${idx}]` },
        requestId,
      );
    }
    const item = raw as Record<string, unknown>;
    // The snapshot is a copy-paste extension: it carries the original
    // thought id under `source_id` so the result map can hand it back.
    // We do not enforce that it parses as a UUID here — the server is
    // permissive (a missing source_id yields `thought_id_map[''] = …`),
    // but when present we make sure it has the canonical shape.
    if (
      item['source_id'] !== undefined &&
      item['source_id'] !== null &&
      item['source_id'] !== '' &&
      (typeof item['source_id'] !== 'string' ||
        !UUID_RE_FOR_SOURCE.test(item['source_id'] as string))
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `thoughts[${idx}].source_id должен быть UUID-строкой.`,
        { field: `thoughts[${idx}].source_id` },
        requestId,
      );
    }
    thoughts.push(item as unknown as import('@etn/shared').ThoughtCopyItem);
  }

  const links: import('@etn/shared').ThoughtCopyLink[] = [];
  if (linksRaw !== undefined) {
    if (!Array.isArray(linksRaw)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'links должен быть массивом.',
        { field: 'links' },
        requestId,
      );
    }
    for (const [idx, raw] of linksRaw.entries()) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new EtnError(
          'VALIDATION_ERROR',
          `links[${idx}] должен быть объектом.`,
          { field: `links[${idx}]` },
          requestId,
        );
      }
      links.push(raw as unknown as import('@etn/shared').ThoughtCopyLink);
    }
  }

  return {
    source_network_id: sourceNetworkId,
    parent_thought_id: parentThoughtId,
    thoughts,
    links,
  };
}

/** Parse and validate the body of `POST /thoughts`. */
function parseThoughtCreateBody(
  body: Record<string, unknown>,
  requestId: string,
): ThoughtCreateInput {
  const title = fieldString(body, 'title', requestId);
  if (title === undefined || title.trim() === '') {
    throw new EtnError(
      'VALIDATION_ERROR',
      'title обязателен и не может быть пустым.',
      { field: 'title' },
      requestId,
    );
  }

  let createLink: ThoughtCreateInput['create_link'];
  const createLinkRaw = body.create_link;
  if (createLinkRaw !== undefined) {
    if (
      typeof createLinkRaw !== 'object' ||
      createLinkRaw === null ||
      Array.isArray(createLinkRaw)
    ) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'create_link должен быть объектом.',
        { field: 'create_link' },
        requestId,
      );
    }
    const cl = createLinkRaw as Record<string, unknown>;
    const direction = fieldString(cl, 'direction', requestId);
    if (direction !== 'parent' && direction !== 'child') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'create_link.direction должен быть "parent" или "child".',
        { field: 'create_link.direction' },
        requestId,
      );
    }
    const targetThoughtId = fieldString(cl, 'target_thought_id', requestId);
    if (targetThoughtId === undefined || targetThoughtId === '') {
      throw new EtnError(
        'VALIDATION_ERROR',
        'create_link.target_thought_id обязателен.',
        { field: 'create_link.target_thought_id' },
        requestId,
      );
    }
    createLink = {
      direction,
      target_thought_id: targetThoughtId,
      type_id: fieldNullableString(cl, 'type_id', requestId) ?? null,
    };
  }

  const icon = fieldNullableString(body, 'icon', requestId);
  const iconKind = parseIconKind(fieldNullableString(body, 'icon_kind', requestId), requestId);
  if (iconKind === 'image') {
    assertImageIcon(icon, requestId);
  }

  return {
    title,
    synonyms: toSynonymArray(fieldStringOrArray(body, 'synonyms', requestId)),
    type_id: fieldNullableString(body, 'type_id', requestId),
    icon,
    icon_kind: iconKind,
    active: fieldBoolean(body, 'active', requestId),
    fg_color: fieldNullableString(body, 'fg_color', requestId),
    bg_color: fieldNullableString(body, 'bg_color', requestId),
    font_bold: fieldBoolean(body, 'font_bold', requestId),
    font_italic: fieldBoolean(body, 'font_italic', requestId),
    font_underline: fieldBoolean(body, 'font_underline', requestId),
    font_strike: fieldBoolean(body, 'font_strike', requestId),
    create_link: createLink,
  };
}

/** Parse and validate the body of `PATCH /thoughts/:id`. */
function parseThoughtUpdateBody(
  body: Record<string, unknown>,
  requestId: string,
): ThoughtUpdateInput {
  const changes: ThoughtUpdateInput = {};
  if (body.title !== undefined) {
    changes.title = fieldString(body, 'title', requestId);
  }
  if (body.synonyms !== undefined) {
    changes.synonyms = toSynonymArray(fieldStringOrArray(body, 'synonyms', requestId));
  }
  if (body.type_id !== undefined) {
    changes.type_id = fieldNullableString(body, 'type_id', requestId);
  }
  if (body.icon !== undefined) {
    changes.icon = fieldNullableString(body, 'icon', requestId);
  }
  if (body.icon_kind !== undefined) {
    changes.icon_kind = parseIconKind(fieldNullableString(body, 'icon_kind', requestId), requestId);
  }
  if (body.icon_attachment_id !== undefined) {
    changes.icon_attachment_id = fieldNullableString(body, 'icon_attachment_id', requestId);
  }
  // An image icon must be a valid data/http(s) URL within the size limit.
  if (changes.icon_kind === 'image') {
    assertImageIcon(changes.icon, requestId);
  }
  if (body.active !== undefined) {
    changes.active = fieldBoolean(body, 'active', requestId);
  }
  if (body.marked_for_deletion !== undefined) {
    changes.marked_for_deletion = fieldBoolean(body, 'marked_for_deletion', requestId);
  }
  if (body.fg_color !== undefined) {
    changes.fg_color = fieldNullableString(body, 'fg_color', requestId);
  }
  if (body.bg_color !== undefined) {
    changes.bg_color = fieldNullableString(body, 'bg_color', requestId);
  }
  // font_* accept null ("inherit from type"); the service flips the manual bit.
  if (body.font_bold !== undefined) {
    changes.font_bold = fieldNullableBoolean(body, 'font_bold', requestId);
  }
  if (body.font_italic !== undefined) {
    changes.font_italic = fieldNullableBoolean(body, 'font_italic', requestId);
  }
  if (body.font_underline !== undefined) {
    changes.font_underline = fieldNullableBoolean(body, 'font_underline', requestId);
  }
  if (body.font_strike !== undefined) {
    changes.font_strike = fieldNullableBoolean(body, 'font_strike', requestId);
  }
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
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
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
        const body = requestBody(req);
        const override = fieldBoolean(body, 'show_inactive', req.id);
        const showInactive = resolveShowInactive(app, req, networkId, override);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const response = focus(ndb, req.auth!.user.id, id, { showInactive });
        deps.emit(req, networkId, 'thought-view.updated', {
          thought_id: id,
          last_viewed_at: new Date().toISOString(),
        });
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
        const thought = createThought(ndb, input, req.auth!.user.id);
        deps.emit(req, networkId, 'thought.created', { thought });
        if (input.create_link) {
          // Mirrors createLinkForNewThought's source/target calc (thought-service.ts):
          // parent: target sources a link to the new thought; child: the new
          // thought sources a link to target.
          const link = findLinksBetween(
            ndb,
            input.create_link.direction === 'parent'
              ? input.create_link.target_thought_id
              : thought.id,
            input.create_link.direction === 'parent'
              ? thought.id
              : input.create_link.target_thought_id,
            input.create_link.type_id,
          )[0];
          if (link) {
            deps.emit(req, networkId, 'link.created', { link });
          }
        }
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
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const changes = parseThoughtUpdateBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const thought = updateThought(ndb, id, changes, expectedVersion, req.auth!.user.id);
        deps.emit(req, networkId, 'thought.updated', {
          id,
          changes,
          version: thought.version,
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
        const expectedVersion = parseIfMatch(req.headers['if-match'], req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        // actorUserId нужен для object-lock enforcement (задача 2031df5e).
        deleteThought(ndb, id, expectedVersion, req.auth!.user.id);
        deps.emit(req, networkId, 'thought.deleted', { id });
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
        const ids = fieldStringArray(requestBody(req), 'ids', req.id);
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
        const { networkId, id } = req.params as ThoughtIdParams;
        const query = req.query as Record<string, unknown>;

        const dirRaw = queryStrings(query.dir)[0];
        if (dirRaw === undefined || !(FOCUS_DIRS as readonly string[]).includes(dirRaw)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Параметр dir обязателен: parents|children|siblings.',
            { field: 'dir', allowed: FOCUS_DIRS },
            req.id,
          );
        }
        const sortRaw = queryStrings(query.sort)[0];
        if (sortRaw !== undefined && !(SORT_KINDS as readonly string[]).includes(sortRaw)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Недопустимый sort.',
            { field: 'sort', allowed: SORT_KINDS },
            req.id,
          );
        }
        const orderRaw = queryStrings(query.order)[0];
        if (orderRaw !== undefined && !(SORT_ORDERS as readonly string[]).includes(orderRaw)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Недопустимый order.',
            { field: 'order', allowed: SORT_ORDERS },
            req.id,
          );
        }
        const typeId = queryStrings(query.type_id)[0];
        const limit = queryInt(query.limit, 50, { field: 'limit', min: 1, requestId: req.id });
        const offset = queryInt(query.offset, 0, { field: 'offset', min: 0, requestId: req.id });

        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const neighborOpts = {
          userId: req.auth!.user.id,
          showInactive: resolveShowInactive(
            app,
            req,
            networkId,
            queryBoolean(query.show_inactive, 'show_inactive', req.id),
          ),
          sort: sortRaw as SortKind | undefined,
          order: orderRaw as SortOrder | undefined,
          typeId,
        };
        const neighbors = getNeighbors(ndb, id, dirRaw as FocusDir, { ...neighborOpts, limit, offset });
        // Bug fix (0.6.3, thought f2c7c7d3): `total` used to echo the
        // returned page's length, so a neighbour list longer than `limit`
        // looked complete — no signal ever told the caller more rows exist.
        // `countNeighbors` runs the identical WHERE without LIMIT/OFFSET.
        const total = countNeighbors(ndb, id, dirRaw as FocusDir, neighborOpts);
        sendList(reply, neighbors, total, offset, limit);
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
          if (rawLinkType !== undefined && rawLinkType !== null && typeof rawLinkType !== 'string') {
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
        const userId = req.auth!.user.id;
        const failures: ThoughtBatchFailure[] = [];
        let affected = 0;
        for (const id of ids) {
          try {
            switch (op) {
              case 'set_type': {
                const updated = updateThought(ndb, id, { type_id: setTypeId }, undefined, userId);
                deps.emit(req, networkId, 'thought.updated', {
                  id,
                  changes: { type_id: setTypeId },
                  version: updated.version,
                });
                break;
              }
              case 'clear_type': {
                const updated = updateThought(ndb, id, { type_id: null }, undefined, userId);
                deps.emit(req, networkId, 'thought.updated', {
                  id,
                  changes: { type_id: null },
                  version: updated.version,
                });
                break;
              }
              case 'set_active': {
                const updated = updateThought(ndb, id, { active: true }, undefined, userId);
                deps.emit(req, networkId, 'thought.updated', {
                  id,
                  changes: { active: true },
                  version: updated.version,
                });
                break;
              }
              case 'set_inactive': {
                const updated = updateThought(ndb, id, { active: false }, undefined, userId);
                deps.emit(req, networkId, 'thought.updated', {
                  id,
                  changes: { active: false },
                  version: updated.version,
                });
                break;
              }
              case 'delete':
              case 'purge':
                // S13: `delete` is an alias of `purge` — both physically delete
                // with the same blocking check (deleteThought refuses when the
                // thought is referenced by a property). actorUserId — для
                // object-lock enforcement (задача 2031df5e).
                deleteThought(ndb, id, undefined, userId);
                deps.emit(req, networkId, 'thought.deleted', { id });
                break;
              case 'trash': {
                const updated = updateThought(
                  ndb,
                  id,
                  { marked_for_deletion: true },
                  undefined,
                  userId,
                );
                deps.emit(req, networkId, 'thought.updated', {
                  id,
                  changes: { marked_for_deletion: true },
                  version: updated.version,
                });
                break;
              }
              case 'link_to_focus': {
                const [sourceId, targetId] =
                  direction === 'parent' ? [id, focusThoughtId!] : [focusThoughtId!, id];
                const link = createLink(
                  ndb,
                  { source_id: sourceId, target_id: targetId, type_id: linkTypeForCreate },
                  userId,
                );
                deps.emit(req, networkId, 'link.created', { link });
                break;
              }
              case 'unlink_from_focus': {
                const [sourceId, targetId] =
                  direction === 'parent' ? [id, focusThoughtId!] : [focusThoughtId!, id];
                const found = findLinksBetween(ndb, sourceId, targetId, linkTypeForFind);
                if (found.length === 0) {
                  throw new EtnError('NOT_FOUND', `Нет связи между ${sourceId} и ${targetId}.`);
                }
                for (const link of found) {
                  deleteLink(ndb, link.id, undefined);
                  deps.emit(req, networkId, 'link.deleted', { id: link.id });
                }
                break;
              }
              // Bulk link operations of the structures filter commands
              // (03-server-api.md §6.6, L22): anchors come from the picker,
              // newly created links get `args.link_type_id` (untyped when
              // absent) and pairs already linked in any type are left
              // untouched — the op is idempotent per pair.
              case 'link_parents': {
                for (const parentId of anchorParentIds!) {
                  if (parentId === id) continue; // self-loop is skipped silently
                  if (findLinksBetween(ndb, parentId, id).length > 0) continue;
                  const link = createLink(
                    ndb,
                    { source_id: parentId, target_id: id, type_id: bulkLinkType },
                    userId,
                  );
                  deps.emit(req, networkId, 'link.created', { link });
                }
                break;
              }
              case 'link_children': {
                for (const childId of anchorChildIds!) {
                  if (childId === id) continue;
                  if (findLinksBetween(ndb, id, childId).length > 0) continue;
                  const link = createLink(
                    ndb,
                    { source_id: id, target_id: childId, type_id: bulkLinkType },
                    userId,
                  );
                  deps.emit(req, networkId, 'link.created', { link });
                }
                break;
              }
              case 'set_only_parents': {
                const keepers = new Set(anchorParentIds!);
                for (const link of incomingLinksOf(ndb, id)) {
                  if (keepers.has(link.source_id)) continue;
                  deleteLink(ndb, link.id, undefined);
                  deps.emit(req, networkId, 'link.deleted', { id: link.id });
                }
                for (const parentId of anchorParentIds!) {
                  if (parentId === id) continue;
                  if (findLinksBetween(ndb, parentId, id).length > 0) continue;
                  const link = createLink(
                    ndb,
                    { source_id: parentId, target_id: id, type_id: bulkLinkType },
                    userId,
                  );
                  deps.emit(req, networkId, 'link.created', { link });
                }
                break;
              }
              case 'unlink_parents': {
                for (const parentId of anchorParentIds!) {
                  for (const link of findLinksBetween(ndb, parentId, id)) {
                    deleteLink(ndb, link.id, undefined);
                    deps.emit(req, networkId, 'link.deleted', { id: link.id });
                  }
                }
                break;
              }
              case 'unlink_children': {
                for (const childId of anchorChildIds!) {
                  for (const link of findLinksBetween(ndb, id, childId)) {
                    deleteLink(ndb, link.id, undefined);
                    deps.emit(req, networkId, 'link.deleted', { id: link.id });
                  }
                }
                break;
              }
            }
            affected += 1;
          } catch (err) {
            if (err instanceof EtnError) {
              failures.push({ id, code: err.code, message: err.message });
            } else {
              failures.push({ id, code: 'INTERNAL', message: 'internal error' });
            }
          }
        }
        sendSuccess(reply, { affected, failures });
      },
    );

    // --- Copy-batch (workplan L26, task bb8277f6) ----------------------------
    // Paste a clipboard snapshot under `parent_thought_id` in this network.
    // Type and link-type resolution falls back to "drop the type" per spec
    // when nothing fits; thought_ref values are re-resolved by id → title.
    // The whole batch is one transaction — partial failure rolls back.

    app.post(
      '/networks/:networkId/thoughts/copy-batch',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const input = parseThoughtCopyBody(requestBody(req), req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const result = copyThoughtsBatch(ndb, input, req.auth!.user.id);
        // Real-time: emit a `thought.created` for every new thought and a
        // `link.created` for every new link so other connected clients
        // refresh without polling. The actor has no echo (04-realtime.md §5);
        // the local refresh below reconciles the canvas / structures view.
        for (const thought of result.created_thoughts) {
          deps.emit(req, networkId, 'thought.created', { thought });
        }
        for (const link of result.created_links) {
          deps.emit(req, networkId, 'link.created', { link });
        }
        sendSuccess(reply, result);
      },
    );

    // --- Resolve (03-server-api.md §6.9) ------------------------------------

    app.post(
      '/networks/:networkId/thoughts/resolve',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const body = requestBody(req);
        const ids = fieldStringArray(body, 'ids', req.id);
        if (ids === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'ids обязателен (массив строк).',
            { field: 'ids' },
            req.id,
          );
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const refs = resolveThoughts(ndb, ids);
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

    // --- Usage: reverse thought_ref lookup (03-server-api.md §9.1, L7) ------

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
        const cleared = clearThoughtRefUsages(ndb, id);
        sendSuccess(reply, { cleared });
      },
    );

    // --- Duplicate candidates (add-thought dialog, 03-server-api.md §6.3,
    //     08-ui-spec.md §4.4; MCP find_duplicates) ---------------------------

    app.get(
      '/networks/:networkId/thoughts/duplicates',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const query = req.query as Record<string, unknown>;
        const title = queryStrings(query.title)[0];
        if (title === undefined || title.trim() === '') {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Параметр title обязателен и не может быть пустым.',
            { field: 'title' },
            req.id,
          );
        }
        // Synonyms: repeatable ?synonyms=a&synonyms=b or a comma-separated value.
        const synonyms = queryStrings(query.synonyms).flatMap((value) => value.split(','));
        // Optional thought-type filter (thought_ref property pickers): repeatable
        // ?type_ids=… or a comma-separated value.
        const typeIds = queryStrings(query.type_ids).flatMap((value) => value.split(','));
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const hits = findDuplicates(ndb, title, synonyms, typeIds);
        sendList(reply, hits, hits.length, 0, hits.length);
      },
    );

    // --- Focus-zone sort choice (03-server-api.md §6.8) ----------------------

    app.put(
      '/networks/:networkId/thoughts/:fid/focus-preferences',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, fid } = req.params as FocusIdParams;
        const body = requestBody(req);
        const dir = fieldString(body, 'dir', req.id);
        const sort = fieldString(body, 'sort', req.id);
        const order = fieldString(body, 'order', req.id);
        if (dir === undefined || sort === undefined || order === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'dir, sort и order обязательны.',
            { field: 'dir' },
            req.id,
          );
        }
        // The focus service validates the enum values itself.
        const input: FocusPreferencesInput = {
          dir: dir as FocusDir,
          sort: sort as SortKind,
          order: order as SortOrder,
        };
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const result = setFocusPreferences(ndb, req.auth!.user.id, fid, input);
        deps.emit(req, networkId, 'user-focus-preferences.updated', {
          focus_thought_id: fid,
          dir: input.dir,
          sort: input.sort,
          sort_order: input.order,
        });
        sendSuccess(reply, result);
      },
    );

    // --- Manual focus-zone order (03-server-api.md §6.8) ---------------------

    app.post(
      '/networks/:networkId/thoughts/:fid/focus-order',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, fid } = req.params as FocusIdParams;
        const body = requestBody(req);
        const dir = fieldString(body, 'dir', req.id);
        const orderedIds = fieldStringArray(body, 'ordered_ids', req.id);
        if (dir === undefined || orderedIds === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'dir и ordered_ids обязательны.',
            { field: 'dir' },
            req.id,
          );
        }
        const input: FocusOrderInput = {
          dir: dir as FocusOrderInput['dir'],
          ordered_ids: orderedIds,
        };
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        setFocusOrder(ndb, req.auth!.user.id, fid, input);
        deps.emit(req, networkId, 'user-focus-order.updated', {
          focus_thought_id: fid,
          dir: input.dir,
          ordered_ids: orderedIds,
        });
        sendSuccess(reply, { focus_thought_id: fid, dir: input.dir, ordered_ids: orderedIds });
      },
    );
  };
}
