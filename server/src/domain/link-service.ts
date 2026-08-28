/**
 * Link domain service (task C4, docs/03-server-api.md §7).
 *
 * Links are directed (`source_id` → `target_id`). Self-loops are rejected
 * (422 `VALIDATION_ERROR`) and duplicate typed pairs are rejected (409
 * `DUPLICATE`). Because SQLite treats `NULL` as distinct inside a UNIQUE index,
 * the duplicate guard for untyped (`type_id IS NULL`) links is enforced here in
 * addition to the schema constraint (docs/02-data-model.md §3.6, §7.1).
 *
 * Mutating calls accept an optional `expectedVersion` for the `If-Match`
 * optimistic-concurrency contract and reject mismatches with
 * `VERSION_CONFLICT`.
 */

import { randomUUID } from 'node:crypto';

import {
  EtnError,
  type IconKind,
  type Link,
  type LinkCreateInput,
  type LinkDeletionCheckResult,
  type LinkStyle,
  type LinkUpdateInput,
  type ThoughtLinkItem,
  type ThoughtLinksGrouped,
  type ThoughtRef,
  type UntypedLinkItem,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { listLinkHoldingLayers } from './holding-layers.js';
import { purgeOwnerDependants } from './owner-cleanup.js';
import { assertLinkTypeAssignable } from './link-type-service.js';

import {
  FONT_BOLD_BIT,
  FONT_ITALIC_BIT,
  FONT_STRIKE_BIT,
  FONT_UNDERLINE_BIT,
  readFont,
} from './font-style.js';

// ---------------------------------------------------------------------------
// Row shapes & conversion
// ---------------------------------------------------------------------------

/** Raw `links` row (INTEGER booleans). */
interface LinkRow {
  id: string;
  source_id: string;
  target_id: string;
  type_id: string | null;
  color: string | null;
  style: string | null;
  width: number | null;
  active: number;
  marked_for_deletion: number;
  marked_for_deletion_at: string | null;
  marked_for_deletion_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

/** Convert a raw row into a {@link Link}. */
function rowToLink(row: LinkRow): Link {
  return {
    id: row.id,
    source_id: row.source_id,
    target_id: row.target_id,
    type_id: row.type_id,
    color: row.color,
    style: row.style as LinkStyle | null,
    width: row.width,
    active: row.active === 1,
    marked_for_deletion: row.marked_for_deletion === 1,
    marked_for_deletion_at: row.marked_for_deletion_at,
    marked_for_deletion_by: row.marked_for_deletion_by,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

/** Raw incident-link row: a link joined with its type and the opponent thought. */
interface IncidentLinkRow {
  id: string;
  source_id: string;
  target_id: string;
  type_id: string | null;
  color: string | null;
  style: string | null;
  width: number | null;
  active: number;
  marked_for_deletion: number;
  marked_for_deletion_at: string | null;
  marked_for_deletion_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  name_forward: string | null;
  name_reverse: string | null;
  other_id: string;
  other_title: string;
  other_type_id: string | null;
  other_icon: string | null;
  other_icon_kind: string;
  other_icon_attachment_id: string | null;
  other_active: number;
  other_marked_for_deletion: number;
  other_fg_color: string | null;
  other_bg_color: string | null;
  other_font_bold: number;
  other_font_italic: number;
  other_font_underline: number;
  other_font_strike: number;
  other_font_manual: number;
  /** 'parent' — opponent is the link source; 'child' — opponent is the target. */
  side: 'parent' | 'child';
}

/** Build a {@link ThoughtRef} for the opponent thought of an incident link. */
function incidentRowToRef(row: IncidentLinkRow): ThoughtRef {
  const fm = row.other_font_manual;
  return {
    id: row.other_id,
    title: row.other_title,
    type_id: row.other_type_id,
    icon: row.other_icon,
    icon_kind: row.other_icon_kind as IconKind,
    icon_attachment_id: row.other_icon_attachment_id,
    active: row.other_active === 1,
    marked_for_deletion: row.other_marked_for_deletion === 1,
    fg_color: row.other_fg_color,
    bg_color: row.other_bg_color,
    font_bold: readFont(fm, FONT_BOLD_BIT, row.other_font_bold),
    font_italic: readFont(fm, FONT_ITALIC_BIT, row.other_font_italic),
    font_underline: readFont(fm, FONT_UNDERLINE_BIT, row.other_font_underline),
    font_strike: readFont(fm, FONT_STRIKE_BIT, row.other_font_strike),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sentinel substituting for a NULL `type_id` in duplicate-detection queries so
 * NULL-typed links compare equal among themselves. Any character that cannot
 * occur in a UUID works.
 */
const NULL_TYPE_SENTINEL = '\u0000';

/** Return `typeId` or the NULL sentinel (for `ifnull` comparisons). */
function typeIdOrSentinel(typeId: string | null | undefined): string {
  return typeId ?? NULL_TYPE_SENTINEL;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Return a link by id, or `null` when absent. */
export function getLink(ndb: NetworkDb, id: string): Link | null {
  const row = ndb.prepare('SELECT * FROM links WHERE id = ? LIMIT 1').get(id) as
    LinkRow | undefined;
  return row ? rowToLink(row) : null;
}

/** Return a link or throw `NOT_FOUND` (404). */
function getLinkOrThrow(ndb: NetworkDb, id: string): Link {
  const link = getLink(ndb, id);
  if (!link) {
    throw new EtnError('NOT_FOUND', `link ${id} not found`, { entity: 'link', id });
  }
  return link;
}

/**
 * List every link between two thoughts (either direction excluded — this is a
 * directed lookup from `sourceId` to `targetId`). Backs the
 * `unlink_from_focus` batch operation (03-server-api.md §6.6).
 *
 * @param typeId - when provided, only links of that type are returned;
 *   `null` matches untyped links only, `undefined` (default) matches any type.
 */
export function findLinksBetween(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  typeId?: string | null,
): Link[] {
  const rows =
    typeId === undefined
      ? (ndb
          .prepare('SELECT * FROM links WHERE source_id = ? AND target_id = ?')
          .all(sourceId, targetId) as LinkRow[])
      : (ndb
          .prepare(
            `SELECT * FROM links WHERE source_id = ? AND target_id = ? AND ifnull(type_id, ?) = ?`,
          )
          .all(sourceId, targetId, NULL_TYPE_SENTINEL, typeIdOrSentinel(typeId)) as LinkRow[]);
  return rows.map(rowToLink);
}

/**
 * Every incoming link of a thought (links where it is the target), any type,
 * active or not. Backs the `set_only_parents` batch operation
 * (03-server-api.md §6.6, L22).
 */
export function incomingLinksOf(ndb: NetworkDb, thoughtId: string): Link[] {
  const rows = ndb
    .prepare('SELECT * FROM links WHERE target_id = ?')
    .all(thoughtId) as LinkRow[];
  return rows.map(rowToLink);
}

/**
 * Returns every link whose both ends are in `ids` (the visible thoughts of a
 * focus response), optionally including inactive ones. Used to draw all links
 * among the visible clouds — not just those incident to the focus.
 */
export function getEdgesAmong(ndb: NetworkDb, ids: string[], showInactive: boolean): Link[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = ndb
    .prepare(
      `SELECT * FROM links
       WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})
         AND (active = 1 OR ?)`,
    )
    .all(...ids, ...ids, showInactive ? 1 : 0) as LinkRow[];
  return rows.map(rowToLink);
}

/**
 * For each id, whether it has any active incoming / outgoing link at all —
 * drives the top/bottom ellipse fill of a cloud so the user can see that a
 * thought continues the chain even when its other links are off-screen.
 */
export function getLinkDirections(
  ndb: NetworkDb,
  ids: string[],
): Map<string, { has_in: boolean; has_out: boolean }> {
  const result = new Map<string, { has_in: boolean; has_out: boolean }>();
  if (ids.length === 0) return result;
  for (const id of ids) result.set(id, { has_in: false, has_out: false });
  const placeholders = ids.map(() => '?').join(',');
  const rows = ndb
    .prepare(
      `SELECT source_id, target_id FROM links WHERE active = 1
         AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}))`,
    )
    .all(...ids, ...ids) as Array<{ source_id: string; target_id: string }>;
  for (const row of rows) {
    const src = result.get(row.source_id);
    if (src !== undefined) src.has_out = true;
    const tgt = result.get(row.target_id);
    if (tgt !== undefined) tgt.has_in = true;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a directed link (docs/03-server-api.md §7.1).
 *
 * Throws:
 *   * `VALIDATION_ERROR` (422) for a self-loop (`source_id = target_id`);
 *   * `NOT_FOUND` (404) if either endpoint or the referenced link type is unknown;
 *   * `DUPLICATE` (409) if an equivalent link already exists (typed or untyped).
 */
export function createLink(ndb: NetworkDb, input: LinkCreateInput, actorUserId: string): Link {
  if (input.source_id === input.target_id) {
    throw new EtnError('VALIDATION_ERROR', 'a link cannot connect a thought to itself', {
      source_id: input.source_id,
    });
  }
  const typeId = input.type_id ?? null;

  return ndb.transaction(() => {
    // Both endpoints must exist.
    const src = ndb.prepare('SELECT 1 FROM thoughts WHERE id = ?').get(input.source_id);
    if (!src) {
      throw new EtnError('NOT_FOUND', `source thought ${input.source_id} not found`, {
        entity: 'thought',
        id: input.source_id,
      });
    }
    const tgt = ndb.prepare('SELECT 1 FROM thoughts WHERE id = ?').get(input.target_id);
    if (!tgt) {
      throw new EtnError('NOT_FOUND', `target thought ${input.target_id} not found`, {
        entity: 'thought',
        id: input.target_id,
      });
    }
    if (typeId !== null) {
      // The root type is never assignable to links (L21, docs/08-ui-spec.md §8.1).
      assertLinkTypeAssignable(ndb, typeId);
    }
    // Duplicate guard, NULL-safe on both sides.
    const dup = ndb
      .prepare(
        'SELECT 1 FROM links WHERE source_id = ? AND target_id = ? AND ifnull(type_id, ?) = ? LIMIT 1',
      )
      .get(input.source_id, input.target_id, NULL_TYPE_SENTINEL, typeIdOrSentinel(typeId));
    if (dup) {
      throw new EtnError('DUPLICATE', 'an equivalent link already exists', {
        source_id: input.source_id,
        target_id: input.target_id,
        type_id: typeId,
      });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    ndb
      .prepare(
        `INSERT INTO links (id, source_id, target_id, type_id, color, style, width, active, version,
                            created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.source_id,
        input.target_id,
        typeId,
        input.color ?? null,
        input.style ?? null,
        input.width ?? null,
        input.active === false ? 0 : 1,
        now,
        now,
        actorUserId,
        actorUserId,
      );
    return getLinkOrThrow(ndb, id);
  });
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Patch a link (docs/03-server-api.md §7.1). Last-write-wins per field.
 * `source_id`/`target_id` must be provided together — swapping them inverts
 * the link's direction.
 *
 * Throws:
 *   * `NOT_FOUND` (404) if the link does not exist;
 *   * `VERSION_CONFLICT` (409) if `expectedVersion` is set and does not match;
 *   * `VALIDATION_ERROR` (422) for a one-sided endpoint change or a self-loop;
 *   * `DUPLICATE` (409) if changing the endpoints or `type_id` produces a pair
 *     that already exists.
 */
export function updateLink(
  ndb: NetworkDb,
  id: string,
  changes: LinkUpdateInput,
  expectedVersion: number | undefined,
  actorUserId: string,
): Link {
  return ndb.transaction(() => {
    const current = getLinkOrThrow(ndb, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'link version mismatch', {
        entity: 'link',
        id,
        expected: expectedVersion,
        current: current.version,
      });
    }

    // Endpoint change (inversion): both ids must arrive together and both
    // thoughts must exist; a self-loop is rejected exactly as on create.
    const endpointsChanging =
      changes.source_id !== undefined || changes.target_id !== undefined;
    if (endpointsChanging) {
      if (changes.source_id === undefined || changes.target_id === undefined) {
        throw new EtnError('VALIDATION_ERROR', 'source_id and target_id must change together', {
          link_id: id,
        });
      }
      if (changes.source_id === changes.target_id) {
        throw new EtnError('VALIDATION_ERROR', 'a link cannot connect a thought to itself', {
          source_id: changes.source_id,
        });
      }
      for (const [role, endpointId] of [
        ['source', changes.source_id],
        ['target', changes.target_id],
      ] as const) {
        const exists = ndb.prepare('SELECT 1 FROM thoughts WHERE id = ?').get(endpointId);
        if (!exists) {
          throw new EtnError('NOT_FOUND', `${role} thought ${endpointId} not found`, {
            entity: 'thought',
            id: endpointId,
          });
        }
      }
    }
    const newSourceId = changes.source_id ?? current.source_id;
    const newTargetId = changes.target_id ?? current.target_id;

    const sets: string[] = [];
    const args: unknown[] = [];
    if (changes.source_id !== undefined) {
      sets.push('source_id = ?');
      args.push(changes.source_id);
    }
    if (changes.target_id !== undefined) {
      sets.push('target_id = ?');
      args.push(changes.target_id);
    }
    let newTypeId = current.type_id;
    if (changes.type_id !== undefined) {
      newTypeId = changes.type_id;
      sets.push('type_id = ?');
      args.push(changes.type_id);
    }
    if (changes.color !== undefined) {
      sets.push('color = ?');
      args.push(changes.color);
    }
    if (changes.style !== undefined) {
      sets.push('style = ?');
      args.push(changes.style);
    }
    if (changes.width !== undefined) {
      sets.push('width = ?');
      args.push(changes.width);
    }
    if (changes.active !== undefined) {
      sets.push('active = ?');
      args.push(changes.active ? 1 : 0);
    }
    // Mark-for-deletion (S13, 02-data-model.md §3.1.2): reversible flag + audit.
    if (changes.marked_for_deletion !== undefined) {
      if (changes.marked_for_deletion) {
        sets.push('marked_for_deletion = ?', 'marked_for_deletion_at = ?', 'marked_for_deletion_by = ?');
        args.push(1, new Date().toISOString(), actorUserId);
      } else {
        sets.push('marked_for_deletion = ?', 'marked_for_deletion_at = ?', 'marked_for_deletion_by = ?');
        args.push(0, null, null);
      }
    }

    // If type_id is changing, verify the new type exists and is not the root
    // (the root is never assignable, L21).
    if (changes.type_id !== undefined && newTypeId !== null) {
      assertLinkTypeAssignable(ndb, newTypeId);
    }
    // Duplicate guard for the resulting pair: direction or type may have changed.
    if (changes.type_id !== undefined || endpointsChanging) {
      const dup = ndb
        .prepare(
          `SELECT 1 FROM links WHERE source_id = ? AND target_id = ? AND ifnull(type_id, ?) = ?
           AND id <> ? LIMIT 1`,
        )
        .get(newSourceId, newTargetId, NULL_TYPE_SENTINEL, typeIdOrSentinel(newTypeId), id);
      if (dup) {
        throw new EtnError('DUPLICATE', 'an equivalent link already exists', {
          source_id: newSourceId,
          target_id: newTargetId,
          type_id: newTypeId,
        });
      }
    }

    const now = new Date().toISOString();
    sets.push('version = ?', 'updated_at = ?', 'updated_by = ?');
    args.push(current.version + 1, now, actorUserId);
    args.push(id);
    ndb.prepare(`UPDATE links SET ${sets.join(', ')} WHERE id = ?`).run(...args);

    return getLinkOrThrow(ndb, id);
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Check whether a link can be physically deleted (docs/03-server-api.md §6.5a).
 * Links have no `thought_ref` usage and no children, so the only blocking arm
 * is a live (`deleted = 0`) shadow row of the link in a non-base layer
 * (02-data-model.md §3.1.2 п.3; until layers are created via S7 the list is
 * always empty).
 *
 * Throws `NOT_FOUND` (404) when the link does not exist.
 */
export function checkLinkDeletion(ndb: NetworkDb, id: string): LinkDeletionCheckResult {
  const row = ndb.prepare('SELECT 1 FROM links WHERE id = ?').get(id);
  if (!row) {
    throw new EtnError('NOT_FOUND', `link ${id} not found`, { entity: 'link', id });
  }
  const holdingLayers = listLinkHoldingLayers(ndb, id);
  return { blocked: holdingLayers.length > 0, blocking: { layers: holdingLayers } };
}

/**
 * Delete a link (docs/03-server-api.md §7.1). The link's polymorphic
 * dependants (comments, attachments incl. server-stored files, property
 * values — no SQL FK) are purged in the same transaction
 * (see {@link purgeOwnerDependants}).
 *
 * Throws `NOT_FOUND` (404) if the link does not exist and `VERSION_CONFLICT`
 * (409) if `expectedVersion` is set and does not match; `VALIDATION_ERROR`
 * (422) when deletion is blocked by a holding layer (S13/S2, §6.5a — the list
 * is empty until layers can be created, S7).
 */
export function deleteLink(ndb: NetworkDb, id: string, expectedVersion: number | undefined): void {
  ndb.transaction(() => {
    const current = getLinkOrThrow(ndb, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'link version mismatch', {
        entity: 'link',
        id,
        expected: expectedVersion,
        current: current.version,
      });
    }
    // S13: refuse physical deletion while blocked (§6.5a).
    const check = checkLinkDeletion(ndb, id);
    if (check.blocked) {
      throw new EtnError('VALIDATION_ERROR', 'link is held by a layer and cannot be deleted', {
        entity: 'link',
        id,
        blocking: check.blocking,
      });
    }
    // Polymorphic owners without SQL FK: clean up explicitly (mirrors
    // thought deletion). The link's comments (primary owner — deleted with
    // m2m targets; secondary targets — detached, L20 §10.1), attachments
    // (incl. server-stored files) and property values are purged in the same
    // transaction.
    purgeOwnerDependants(ndb, 'link', [id]);
    ndb.prepare('DELETE FROM links WHERE id = ?').run(id);
  });
}

// ---------------------------------------------------------------------------
// Grouped listing for the editor
// ---------------------------------------------------------------------------

/** Options for {@link listLinksByThought}. */
export interface ListLinksOptions {
  /** Include inactive links/thoughts when true (preferences.show_inactive). */
  showInactive?: boolean;
}

/**
 * Return all links incident to a thought, grouped for the editor
 * (docs/03-server-api.md §7.2): typed links by type (`by_type`, each item
 * carrying the opponent thought as `target_thought`), untyped links split into
 * `untyped_parents` (opponent is the source) and `untyped_children` (opponent
 * is the target). Inactive links and thoughts are filtered out unless
 * `opts.showInactive` is set.
 *
 * `type_name` is the link type's `name_forward` (source → target) label; the
 * editor can flip it for the reverse side if needed.
 */
export function listLinksByThought(
  ndb: NetworkDb,
  thoughtId: string,
  opts: ListLinksOptions = {},
): ThoughtLinksGrouped {
  const showInactive = opts.showInactive === true ? 1 : 0;
  const rows = ndb
    .prepare(
      `SELECT l.id, l.source_id, l.target_id, l.type_id, l.color, l.style, l.width,
              l.active, l.marked_for_deletion, l.marked_for_deletion_at, l.marked_for_deletion_by,
              l.version,
              l.created_at, l.updated_at, l.created_by, l.updated_by,
              lt.name_forward, lt.name_reverse,
              CASE WHEN l.target_id = ? THEN l.source_id ELSE l.target_id END AS other_id,
              t.title AS other_title, t.type_id AS other_type_id, t.icon AS other_icon,
              t.icon_kind AS other_icon_kind, t.icon_attachment_id AS other_icon_attachment_id,
              t.active AS other_active,
              t.marked_for_deletion AS other_marked_for_deletion,
              t.fg_color AS other_fg_color, t.bg_color AS other_bg_color,
              t.font_bold AS other_font_bold, t.font_italic AS other_font_italic,
              t.font_underline AS other_font_underline, t.font_strike AS other_font_strike,
              t.font_manual AS other_font_manual,
              CASE WHEN l.target_id = ? THEN 'parent' ELSE 'child' END AS side
       FROM links l
       LEFT JOIN link_types lt ON lt.id = l.type_id
       JOIN thoughts t ON t.id = (CASE WHEN l.target_id = ? THEN l.source_id ELSE l.target_id END)
       WHERE (l.source_id = ? OR l.target_id = ?)
         AND (l.active = 1 OR ?)
         AND (t.active = 1 OR ?)`,
    )
    .all(
      thoughtId,
      thoughtId,
      thoughtId,
      thoughtId,
      thoughtId,
      showInactive,
      showInactive,
    ) as IncidentLinkRow[];

  const byType = new Map<
    string,
    { type_id: string; type_name: string; items: ThoughtLinkItem[] }
  >();
  const untypedParents: UntypedLinkItem[] = [];
  const untypedChildren: UntypedLinkItem[] = [];

  for (const row of rows) {
    const link = rowToLink(row);
    const ref = incidentRowToRef(row);
    if (row.type_id) {
      let group = byType.get(row.type_id);
      if (!group) {
        group = {
          type_id: row.type_id,
          type_name: row.name_forward ?? '',
          items: [],
        };
        byType.set(row.type_id, group);
      }
      group.items.push({ link, target_thought: ref });
    } else if (row.side === 'parent') {
      untypedParents.push({ link, source_thought: ref });
    } else {
      untypedChildren.push({ link, target_thought: ref });
    }
  }

  return {
    by_type: [...byType.values()],
    untyped_parents: untypedParents,
    untyped_children: untypedChildren,
  };
}
