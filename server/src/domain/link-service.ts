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
  type LinkUpdateInput,
  type ThoughtLinkItem,
  type ThoughtLinksGrouped,
  type ThoughtRef,
  type UntypedLinkItem,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

// ---------------------------------------------------------------------------
// Row shapes & conversion
// ---------------------------------------------------------------------------

/** Raw `links` row (INTEGER booleans). */
interface LinkRow {
  id: string;
  source_id: string;
  target_id: string;
  type_id: string | null;
  active: number;
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
    active: row.active === 1,
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
  active: number;
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
  other_active: number;
  other_fg_color: string | null;
  other_bg_color: string | null;
  other_font_bold: number;
  other_font_italic: number;
  other_font_underline: number;
  other_font_strike: number;
  /** 'parent' — opponent is the link source; 'child' — opponent is the target. */
  side: 'parent' | 'child';
}

/** Build a {@link ThoughtRef} for the opponent thought of an incident link. */
function incidentRowToRef(row: IncidentLinkRow): ThoughtRef {
  return {
    id: row.other_id,
    title: row.other_title,
    type_id: row.other_type_id,
    icon: row.other_icon,
    icon_kind: row.other_icon_kind as IconKind,
    active: row.other_active === 1,
    fg_color: row.other_fg_color,
    bg_color: row.other_bg_color,
    font_bold: row.other_font_bold === 1,
    font_italic: row.other_font_italic === 1,
    font_underline: row.other_font_underline === 1,
    font_strike: row.other_font_strike === 1,
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
      const lt = ndb.prepare('SELECT 1 FROM link_types WHERE id = ?').get(typeId);
      if (!lt) {
        throw new EtnError('NOT_FOUND', `link type ${typeId} not found`, {
          entity: 'link_type',
          id: typeId,
        });
      }
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
        `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                            created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.source_id,
        input.target_id,
        typeId,
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
 *
 * Throws:
 *   * `NOT_FOUND` (404) if the link does not exist;
 *   * `VERSION_CONFLICT` (409) if `expectedVersion` is set and does not match;
 *   * `DUPLICATE` (409) if changing `type_id` produces a pair that already exists.
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

    const sets: string[] = [];
    const args: unknown[] = [];
    let newTypeId = current.type_id;
    if (changes.type_id !== undefined) {
      newTypeId = changes.type_id;
      sets.push('type_id = ?');
      args.push(changes.type_id);
    }
    if (changes.active !== undefined) {
      sets.push('active = ?');
      args.push(changes.active ? 1 : 0);
    }

    // If type_id is changing, verify the new type exists and no duplicate results.
    if (changes.type_id !== undefined && newTypeId !== null) {
      const lt = ndb.prepare('SELECT 1 FROM link_types WHERE id = ?').get(newTypeId);
      if (!lt) {
        throw new EtnError('NOT_FOUND', `link type ${newTypeId} not found`, {
          entity: 'link_type',
          id: newTypeId,
        });
      }
    }
    if (changes.type_id !== undefined) {
      const dup = ndb
        .prepare(
          `SELECT 1 FROM links WHERE source_id = ? AND target_id = ? AND ifnull(type_id, ?) = ?
           AND id <> ? LIMIT 1`,
        )
        .get(
          current.source_id,
          current.target_id,
          NULL_TYPE_SENTINEL,
          typeIdOrSentinel(newTypeId),
          id,
        );
      if (dup) {
        throw new EtnError('DUPLICATE', 'an equivalent link already exists', {
          source_id: current.source_id,
          target_id: current.target_id,
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
 * Delete a link (docs/03-server-api.md §7.1).
 *
 * Throws `NOT_FOUND` (404) if the link does not exist and `VERSION_CONFLICT`
 * (409) if `expectedVersion` is set and does not match.
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
      `SELECT l.id, l.source_id, l.target_id, l.type_id, l.active, l.version,
              l.created_at, l.updated_at, l.created_by, l.updated_by,
              lt.name_forward, lt.name_reverse,
              CASE WHEN l.target_id = ? THEN l.source_id ELSE l.target_id END AS other_id,
              t.title AS other_title, t.type_id AS other_type_id, t.icon AS other_icon,
              t.icon_kind AS other_icon_kind, t.active AS other_active,
              t.fg_color AS other_fg_color, t.bg_color AS other_bg_color,
              t.font_bold AS other_font_bold, t.font_italic AS other_font_italic,
              t.font_underline AS other_font_underline, t.font_strike AS other_font_strike,
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
