/**
 * Change-layer domain service (task S7, docs/13-layers.md §2, §7, §10.1;
 * docs/03-server-api.md §5a).
 *
 * Layers are copy-on-write branches of the network; this service owns the
 * non-branchable `layers` metadata table (§2.2) and the server-side session
 * default (`session_layers`, §7.1). It runs on any connection context — the
 * metadata and the session table are layer-independent — but routes use the
 * base-layer connection for these operations.
 *
 * Rights (§7.2): every network member has the same layer rights — create,
 * select, merge (S8, not here) and delete any layer. No per-role checks.
 */

import { randomUUID } from 'node:crypto';

import { BASE_LAYER_ID, EtnError, type Layer, type LayerDeleteResult } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { purgeTrash } from './trash-service.js';

/** Maximum depth of ordinary layers above the base (§2.1: base→L1→…→L4). */
export const MAX_LAYER_DEPTH = 4;

/** Title/comment/git-branch length limit, mirrors `display_name` of networks. */
const TITLE_LIMIT = 200;

/** Row shape of the physical `layers` table. */
interface LayerRow {
  id: string;
  parent_id: string | null;
  title: string;
  comment: string | null;
  git_branch: string | null;
  is_service: number;
  is_base: number;
  depth: number;
  created_by: string;
  created_at: string;
  last_activity_at: string;
  version: number;
}

/** ISO-8601 timestamp with second precision (§2.2: «точность до секунды»). */
function nowSeconds(): string {
  return new Date().toISOString().slice(0, 19) + 'Z';
}

/** Fetch one `layers` row or `undefined`. */
function layerRow(ndb: NetworkDb, id: string): LayerRow | undefined {
  return ndb
    .prepare(
      `SELECT id, parent_id, title, comment, git_branch, is_service, is_base,
              depth, created_by, created_at, last_activity_at, version
       FROM layers WHERE id = ? LIMIT 1`,
    )
    .get(id) as LayerRow | undefined;
}

/** Whole-descendant-subtree size per layer (excluding the layer itself). */
function childrenCounts(ndb: NetworkDb): Map<string, number> {
  const rows = ndb
    .prepare(
      `WITH RECURSIVE tree(root, node) AS (
         SELECT id, id FROM layers
         UNION ALL
         SELECT t.root, l.id FROM layers l JOIN tree t ON l.parent_id = t.node
       )
       SELECT root, COUNT(*) - 1 AS children_count FROM tree GROUP BY root`,
    )
    .all() as { root: string; children_count: number }[];
  return new Map(rows.map((r) => [r.root, r.children_count]));
}

/** Map a physical row + counters to the wire {@link Layer} DTO. */
function toLayer(row: LayerRow, childrenCount: number, currentLayerId: string): Layer {
  return {
    id: row.id,
    parent_id: row.parent_id,
    title: row.title,
    comment: row.comment,
    git_branch: row.git_branch,
    is_service: row.is_service === 1,
    is_base: row.is_base === 1,
    depth: row.depth,
    created_by: row.created_by,
    created_at: row.created_at,
    last_activity_at: row.last_activity_at,
    version: row.version,
    children_count: childrenCount,
    current: row.id === currentLayerId,
  };
}

/** Assert that `id` addresses an existing layer, return its row. */
function requireLayer(ndb: NetworkDb, id: string): LayerRow {
  const row = layerRow(ndb, id);
  if (row === undefined) {
    throw new EtnError('NOT_FOUND', `layer ${id} not found`, { entity: 'layer', id });
  }
  return row;
}

/**
 * All layers of the network with hierarchy metadata (§2.2), newest last.
 * Service layers (`is_service = 1`) are hidden unless `includeService` —
 * otherwise the selection list drowns in auto-created reserve layers (§10.1).
 * Each element carries `children_count` (the DELETE cascade confirmation,
 * §2.4) and `current` for the session's selected layer.
 */
export function listLayers(
  ndb: NetworkDb,
  opts: { includeService?: boolean; currentLayerId?: string } = {},
): Layer[] {
  const currentLayerId = opts.currentLayerId ?? BASE_LAYER_ID;
  const counts = childrenCounts(ndb);
  const rows = (
    ndb
      .prepare(
        `SELECT id, parent_id, title, comment, git_branch, is_service, is_base,
                depth, created_by, created_at, last_activity_at, version
         FROM layers ${opts.includeService === true ? '' : 'WHERE is_service = 0'}
         ORDER BY depth, created_at, id`,
      )
      .all() as LayerRow[]
  ).map((row) => toLayer(row, counts.get(row.id) ?? 0, currentLayerId));
  return rows;
}

/** Input of {@link createLayer}. */
export interface CreateLayerInput {
  /** Parent layer id; the route defaults it to the session's current layer (§2.3). */
  parentId: string;
  title: string;
  comment?: string | null;
  gitBranch?: string | null;
  /** Creator user id (§2.2 `created_by`); required. */
  createdBy: string;
}

/** Validate an optional nullable string field with a length limit. */
function fieldText(value: string | null | undefined, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim();
  if (trimmed.length > TITLE_LIMIT) {
    throw new EtnError('VALIDATION_ERROR', `${field} длиннее ${TITLE_LIMIT} символов.`, {
      field,
      limit: TITLE_LIMIT,
    });
  }
  return trimmed;
}

/**
 * Create a layer under the given parent (§2.3). The depth limit is enforced
 * here: a parent at depth 4 cannot get children — 422 `VALIDATION_ERROR`
 * (§2.1). Service layers (created by the merge machinery, S8) bypass the
 * depth limit — they are not meant for work.
 */
export function createLayer(ndb: NetworkDb, input: CreateLayerInput): Layer {
  const title = input.title.trim();
  if (title.length === 0 || title.length > TITLE_LIMIT) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `title должен быть непустой строкой не длиннее ${TITLE_LIMIT} символов.`,
      { field: 'title', limit: TITLE_LIMIT },
    );
  }
  const comment = fieldText(input.comment ?? null, 'comment');
  const gitBranch = fieldText(input.gitBranch ?? null, 'git_branch');

  return ndb.transaction(() => {
    const parent = requireLayer(ndb, input.parentId);
    if (parent.depth >= MAX_LAYER_DEPTH) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `превышен лимит глубины слоёв (${MAX_LAYER_DEPTH}); родитель «${parent.title}» уже на максимальном уровне`,
        { field: 'parent_id', parent_depth: parent.depth, limit: MAX_LAYER_DEPTH },
      );
    }
    const id = randomUUID();
    const now = nowSeconds();
    ndb.prepare(
      `INSERT INTO layers (id, parent_id, title, comment, git_branch, is_service, is_base,
                           depth, created_by, created_at, last_activity_at, version)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 1)`,
    ).run(id, parent.id, title, comment, gitBranch, parent.depth + 1, input.createdBy, now, now);
    return toLayer(layerRow(ndb, id) as LayerRow, 0, id);
  });
}

/**
 * Rename a layer / edit its comment (§2.2, §10.1). The base layer's title is
 * fixed («Основа») — a rename attempt is 422 regardless of rights (§2.1);
 * editing the base's `comment` is allowed. `expectedVersion` is the usual
 * `If-Match` optimistic lock (409 `VERSION_CONFLICT` on mismatch).
 */
export function updateLayer(
  ndb: NetworkDb,
  id: string,
  changes: { title?: string; comment?: string | null },
  expectedVersion?: number,
): Layer {
  const title = changes.title === undefined ? undefined : changes.title.trim();
  if (title !== undefined && (title.length === 0 || title.length > TITLE_LIMIT)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `title должен быть непустой строкой не длиннее ${TITLE_LIMIT} символов.`,
      { field: 'title', limit: TITLE_LIMIT },
    );
  }
  const comment = fieldText(changes.comment, 'comment');

  return ndb.transaction(() => {
    const row = requireLayer(ndb, id);
    if (row.is_base === 1 && title !== undefined) {
      throw new EtnError('VALIDATION_ERROR', 'название основы фиксировано и не редактируется.', {
        field: 'title',
        layer_id: id,
      });
    }
    if (expectedVersion !== undefined && expectedVersion !== row.version) {
      throw new EtnError('VERSION_CONFLICT', 'layer version mismatch', {
        entity: 'layer',
        id,
        expected_version: expectedVersion,
        current_version: row.version,
      });
    }
    if (title !== undefined || comment !== undefined) {
      ndb.prepare(
        `UPDATE layers SET
           title = COALESCE(?, title),
           comment = CASE WHEN ? THEN ? ELSE comment END,
           version = version + 1
         WHERE id = ?`,
      ).run(title ?? null, comment !== undefined ? 1 : 0, comment ?? null, id);
    }
    const counts = childrenCounts(ndb);
    return toLayer(requireLayer(ndb, id), counts.get(id) ?? 0, id);
  });
}

/** Ids of the layer and its whole descendant subtree (§2.4: deletion is a
 * subtree-wide operation), in stable parent-before-child order. */
export function layerSubtreeIds(ndb: NetworkDb, id: string): string[] {
  return (
    ndb
      .prepare(
        `WITH RECURSIVE subtree(id, ord) AS (
           SELECT id, 0 FROM layers WHERE id = ?
           UNION ALL
           SELECT l.id, s.ord + 1 FROM layers l JOIN subtree s ON l.parent_id = s.id
         )
         SELECT su.id FROM subtree su JOIN layers l ON l.id = su.id
         ORDER BY su.ord, l.created_at, l.id`,
      )
      .all(id) as { id: string }[]
  ).map((r) => r.id);
}

/**
 * Delete a layer together with its whole descendant subtree (§2.4).
 *
 *   * the base layer is undeletable — 422 (§2.1/§2.4);
 *   * `cascade` must echo the layer's `children_count` from the list response:
 *     a mismatched number is 409 (the client's picture is stale), a missing
 *     number with living descendants is 422 carrying the actual
 *     `children_count`; a childless layer deletes without the parameter;
 *   * every session sitting on the deleted subtree (the layer or any
 *     descendant) is switched to the deleted layer's parent (§2.4);
 *   * the physical DELETE cascades through `layers.parent_id` (the subtree)
 *     and `layer_id → layers.id` (all shadow rows and tombstones of the
 *     branchable tables — §2.4 «физически удаляет все его теневые строки»);
 *   * right after the deletion the trash is auto-purged (§2.4, S13): the
 *     dropped shadow rows may have been the last thing holding marked rows
 *     back from physical deletion.
 *
 * Must run on the base-layer connection (the auto-purge physically deletes).
 */
export function deleteLayer(ndb: NetworkDb, id: string, cascade?: number): LayerDeleteResult {
  return ndb.transaction(() => {
    const row = requireLayer(ndb, id);
    if (row.is_base === 1) {
      throw new EtnError('VALIDATION_ERROR', 'основу удалить нельзя.', {
        field: 'layer_id',
        layer_id: id,
      });
    }
    const subtree = layerSubtreeIds(ndb, id);
    const childrenCount = subtree.length - 1;
    if (cascade === undefined) {
      if (childrenCount > 0) {
        throw new EtnError(
          'VALIDATION_ERROR',
          'у слоя есть потомки: передайте cascade=<children_count> для подтверждения.',
          { field: 'cascade', children_count: childrenCount },
        );
      }
    } else if (cascade !== childrenCount) {
      throw new EtnError(
        'VERSION_CONFLICT',
        'число потомков слоя изменилось: обновите список слоёв и повторите.',
        { field: 'cascade', children_count: childrenCount, cascade },
      );
    }

    // Sessions on the deleted subtree move to the deleted layer's parent
    // (§2.4) — never to a dangling layer id. The parent always exists: the
    // base is not deletable, so a non-base layer always has one.
    const placeholders = subtree.map(() => '?').join(', ');
    ndb.prepare(
      `UPDATE session_layers SET layer_id = ?, updated_at = ?
       WHERE layer_id IN (${placeholders})`,
    ).run(row.parent_id, nowSeconds(), ...subtree);

    // Physical delete: FK cascades remove the subtree (parent_id) and every
    // shadow row / tombstone of the branchable tables (layer_id).
    ndb.prepare('DELETE FROM layers WHERE id = ?').run(id);

    // Auto-purge (§2.4, S13): removed shadow rows may unblock marked thoughts.
    const { purged, skipped } = purgeTrash(ndb);
    return { deleted: subtree.length, purged, skipped };
  });
}

/** Ids of rows physically deleted by {@link deleteLayer}'s auto-purge — the
 * route fans out the standard `thought.deleted`/`link.deleted` events for
 * them. Returned by {@link deleteLayerWithEvents}. */
export interface LayerDeleteOutcome extends LayerDeleteResult {
  deleted_thought_ids: string[];
  deleted_link_ids: string[];
}

/**
 * {@link deleteLayer} + the id lists the route needs to fan out trash-purge
 * deletion events (same fan-out as `POST /trash/purge`). Marked rows are read
 * before the transaction and diffed against the survivors after it: a marked
 * row disappears either through the purge (unblocked by the dropped shadow
 * rows) or through the layer cascade itself (its only physical row lived in
 * the deleted subtree) — both warrant a `*.deleted` event.
 */
export function deleteLayerWithEvents(ndb: NetworkDb, id: string, cascade?: number): LayerDeleteOutcome {
  const markedBefore = {
    // layers:physical-read — дифф помеченных строк всех слоёв для событий автоочистки.
    thoughts: (
      ndb.prepare('SELECT id FROM thoughts WHERE marked_for_deletion = 1 -- layers:physical-read').all() as { id: string }[]
    ).map((r) => r.id),
    links: (
      ndb.prepare('SELECT id FROM links WHERE marked_for_deletion = 1 -- layers:physical-read').all() as { id: string }[]
    ).map((r) => r.id),
  };
  const result = deleteLayer(ndb, id, cascade);
  const survivedThoughts = new Set(
    (
      ndb.prepare('SELECT id FROM thoughts WHERE marked_for_deletion = 1 -- layers:physical-read').all() as { id: string }[]
    ).map((r) => r.id),
  );
  const survivedLinks = new Set(
    (
      ndb.prepare('SELECT id FROM links WHERE marked_for_deletion = 1 -- layers:physical-read').all() as { id: string }[]
    ).map((r) => r.id),
  );
  return {
    ...result,
    deleted_thought_ids: markedBefore.thoughts.filter((tid) => !survivedThoughts.has(tid)),
    deleted_link_ids: markedBefore.links.filter((lid) => !survivedLinks.has(lid)),
  };
}

/**
 * The session's current layer (§7.1): `(user_id, client_id)` default from
 * `session_layers`, falling back to the base when nothing is recorded or the
 * recorded layer no longer exists (a stale row cannot survive the API — the
 * delete route re-points sessions — but degrade defensively instead of
 * failing every request).
 */
export function resolveSessionLayer(
  ndb: NetworkDb,
  userId: string,
  clientId: string | null,
): { id: string; title: string } {
  const recorded = ndb
    .prepare('SELECT layer_id FROM session_layers WHERE user_id = ? AND client_id = ? LIMIT 1')
    .get(userId, clientId ?? '') as { layer_id: string } | undefined;
  if (recorded !== undefined) {
    const row = layerRow(ndb, recorded.layer_id);
    if (row !== undefined) {
      return { id: row.id, title: row.title };
    }
  }
  const base = layerRow(ndb, BASE_LAYER_ID);
  return { id: BASE_LAYER_ID, title: base?.title ?? 'Основа' };
}

/**
 * Switch the session's current layer (§7.1): every later request of this
 * `(user_id, client_id)` — reads and writes — runs in the new layer's context.
 * Service layers cannot be selected (§2.1/§8.2: hidden from selection).
 */
export function setSessionLayer(
  ndb: NetworkDb,
  userId: string,
  clientId: string | null,
  layerId: string,
): { id: string; title: string } {
  const row = requireLayer(ndb, layerId);
  if (row.is_service === 1) {
    throw new EtnError('VALIDATION_ERROR', 'служебный слой нельзя выбрать для работы.', {
      field: 'layer_id',
      layer_id: layerId,
    });
  }
  ndb.prepare(
    `INSERT INTO session_layers (user_id, client_id, layer_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, client_id) DO UPDATE SET layer_id = excluded.layer_id,
                                                   updated_at = excluded.updated_at`,
  ).run(userId, clientId ?? '', layerId, nowSeconds());
  return { id: row.id, title: row.title };
}
