/**
 * Thought domain service (task C3, docs/03-server-api.md §6).
 *
 * All functions operate against an open {@link NetworkDb} for a single network
 * and run their writes inside a transaction. Concurrency control is optimistic:
 * mutating calls accept an optional `expectedVersion` and reject with
 * {@link EtnError} `VERSION_CONFLICT` (409) when it does not match the row's
 * current `version` (the `If-Match` contract of docs/03-server-api.md §1).
 *
 * Booleans map to INTEGER 0/1 at the SQLite boundary; the public surface always
 * returns real booleans via {@link rowToThought}.
 *
 * Deduplication is deliberately **not** performed here — it is a UI concern
 * (docs/03-server-api.md §6.3). This service persists exactly what the caller
 * hands it.
 */

import { randomUUID } from 'node:crypto';

import {
  EtnError,
  FOCUS_DIRS,
  SORT_KINDS,
  SORT_ORDERS,
  THOUGHT_RESOLVE_MAX_IDS,
  THOUGHT_TITLE_MAX,
  type FocusDir,
  type FocusNeighbor,
  type FocusResponse,
  type IconKind,
  type SortKind,
  type SortOrder,
  type Thought,
  type ThoughtCardWarning,
  type ThoughtCreateInput,
  type ThoughtDeletionCheckResult,
  type ThoughtRef,
  type ThoughtUpdateInput,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { createComment } from './comment-service.js';
import { listThoughtHoldingLayers } from './holding-layers.js';
import { purgeThoughtDeletionDependants } from './owner-cleanup.js';
import { computeThoughtCardWarnings, countThoughtRefUsages } from './property-service.js';
import { assertThoughtTypeAssignable, getThoughtType } from './thought-type-service.js';

import { getAttachment } from './attachment-service.js';
import { getEdgesAmong, getLinkDirections } from './link-service.js';
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

/** Raw `thoughts` row (INTEGER booleans, string dates). */
interface ThoughtRow {
  id: string;
  title: string;
  title_norm: string;
  type_id: string | null;
  icon: string | null;
  icon_kind: string;
  icon_attachment_id: string | null;
  active: number;
  is_protected: number;
  is_root: number;
  marked_for_deletion: number;
  marked_for_deletion_at: string | null;
  marked_for_deletion_by: string | null;
  fg_color: string | null;
  bg_color: string | null;
  font_bold: number;
  font_italic: number;
  font_underline: number;
  font_strike: number;
  /** Bitmap of manual font_* fields (02-data-model.md §3.1.1). */
  font_manual: number;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** A `thoughts` row joined with a link for neighbour listings. */
interface NeighborRow {
  id: string;
  title: string;
  type_id: string | null;
  icon: string | null;
  active: number;
  link_id: string;
  link_type_id: string | null;
  link_active: number;
  /**
   * Populated only when the query opted into the manual-position join
   * (`useManualJoin`, see `buildNeighborsQuery`). `number` for an entry
   * found in `user_focus_order`, otherwise `null`.
   */
  manual_position?: number | null;
}

/** Convert a raw row + synonyms into a {@link Thought}. */
function rowToThought(row: ThoughtRow, synonyms: string[]): Thought {
  const fm = row.font_manual;
  return {
    id: row.id,
    title: row.title,
    type_id: row.type_id,
    icon: row.icon,
    icon_kind: row.icon_kind as IconKind,
    icon_attachment_id: row.icon_attachment_id,
    active: row.active === 1,
    is_protected: row.is_protected === 1,
    is_root: row.is_root === 1,
    marked_for_deletion: row.marked_for_deletion === 1,
    marked_for_deletion_at: row.marked_for_deletion_at,
    marked_for_deletion_by: row.marked_for_deletion_by,
    fg_color: row.fg_color,
    bg_color: row.bg_color,
    font_bold: readFont(fm, FONT_BOLD_BIT, row.font_bold),
    font_italic: readFont(fm, FONT_ITALIC_BIT, row.font_italic),
    font_underline: readFont(fm, FONT_UNDERLINE_BIT, row.font_underline),
    font_strike: readFont(fm, FONT_STRIKE_BIT, row.font_strike),
    synonyms,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

/**
 * Convert a raw row into a lightweight {@link ThoughtRef}. The row must carry
 * the display columns shared by every `SELECT` that builds refs; reused by
 * other domain modules (e.g. the property usage lookup).
 */
export function rowToThoughtRef(row: {
  id: string;
  title: string;
  type_id: string | null;
  icon: string | null;
  icon_kind: string;
  /** Optional — SELECTs that do not carry the column yield `null`. */
  icon_attachment_id?: string | null;
  active: number;
  /** Optional — SELECTs that do not carry the column yield `false` (S13). */
  marked_for_deletion?: number;
  fg_color: string | null;
  bg_color: string | null;
  font_bold: number;
  font_italic: number;
  font_underline: number;
  font_strike: number;
  font_manual: number;
}): ThoughtRef {
  const fm = row.font_manual;
  return {
    id: row.id,
    title: row.title,
    type_id: row.type_id,
    icon: row.icon,
    icon_kind: row.icon_kind as IconKind,
    icon_attachment_id: row.icon_attachment_id ?? null,
    active: row.active === 1,
    marked_for_deletion: row.marked_for_deletion === 1,
    fg_color: row.fg_color,
    bg_color: row.bg_color,
    font_bold: readFont(fm, FONT_BOLD_BIT, row.font_bold),
    font_italic: readFont(fm, FONT_ITALIC_BIT, row.font_italic),
    font_underline: readFont(fm, FONT_UNDERLINE_BIT, row.font_underline),
    font_strike: readFont(fm, FONT_STRIKE_BIT, row.font_strike),
  };
}

/** Convert a raw neighbour row into a {@link FocusNeighbor}. */
function rowToNeighbor(row: NeighborRow): FocusNeighbor {
  return {
    id: row.id,
    title: row.title,
    type_id: row.type_id,
    icon: row.icon,
    active: row.active === 1,
    link_id: row.link_id,
    link_type_id: row.link_type_id,
    link_active: row.link_active === 1,
    // Placeholder; `focus()` overwrites these from `getLinkDirections`.
    has_incoming: false,
    has_outgoing: false,
    // Only set when the query joined `user_focus_order`; otherwise undefined
    // and surfaced as `null` (no position known, indicator hidden).
    manual_position: row.manual_position ?? null,
  };
}

// ---------------------------------------------------------------------------
// Validation & normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a title or synonym for search and dedup comparison:
 * NFC normalisation, trim, lowercase (docs/02-data-model.md §3.1).
 */
export function normalizeTitle(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
}

/**
 * Validate and clean a thought title. Rejects empty/over-long titles with
 * `VALIDATION_ERROR` (docs/02-data-model.md §3.1, §8 open question: the length
 * cap is enforced by the application, not by a CHECK constraint).
 */
function validateTitle(title: unknown): string {
  if (typeof title !== 'string') {
    throw new EtnError('VALIDATION_ERROR', 'title must be a non-empty string');
  }
  const trimmed = title.trim();
  if (trimmed === '') {
    throw new EtnError('VALIDATION_ERROR', 'title must not be empty');
  }
  // Count code points (not UTF-16 units) so emoji/CJK are measured correctly.
  if ([...trimmed].length > THOUGHT_TITLE_MAX) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `title must be at most ${THOUGHT_TITLE_MAX} characters`,
      { field: 'title', limit: THOUGHT_TITLE_MAX },
    );
  }
  return trimmed;
}

/** Accepted synonym input shape: an array of strings or a single comma-separated string. */
export type SynonymInput = string[] | string | undefined;

/**
 * Parse synonym input into a clean array of display forms.
 *
 * Accepts either an array (`["a", "b"]`) or a comma-separated string
 * (`"a, b ,c"`). Entries are trimmed and empties/duplicates (by normalised
 * form) removed, so the result is a stable list of unique synonyms.
 */
export function parseSynonyms(input: SynonymInput): string[] {
  const raw: string[] = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed === '') continue;
    const norm = normalizeTitle(trimmed);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(trimmed);
  }
  return out;
}

/**
 * Replace a thought's synonyms atomically. Caller is responsible for the
 * surrounding transaction (so a title+synonym update commits together).
 */
function setSynonyms(ndb: NetworkDb, thoughtId: string, synonyms: string[]): void {
  ndb.prepare('DELETE FROM thought_synonyms WHERE thought_id = ?').run(thoughtId);
  if (synonyms.length === 0) return;
  const stmt = ndb.prepare(
    'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)',
  );
  for (const synonym of synonyms) {
    stmt.run(thoughtId, synonym, normalizeTitle(synonym));
  }
}

/** Read the ordered display forms of a thought's synonyms. */
function readSynonyms(ndb: NetworkDb, thoughtId: string): string[] {
  const rows = ndb
    .prepare('SELECT synonym FROM thought_synonyms_v WHERE thought_id = ? ORDER BY synonym')
    .all(thoughtId) as { synonym: string }[];
  return rows.map((r) => r.synonym);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Return a thought with its synonyms, or `null` when not found.
 */
export function getThought(ndb: NetworkDb, id: string): Thought | null {
  const row = ndb.prepare('SELECT * FROM thoughts_v WHERE id = ? LIMIT 1').get(id) as
    ThoughtRow | undefined;
  if (!row) {
    return null;
  }
  return rowToThought(row, readSynonyms(ndb, id));
}

/**
 * Return a thought or throw `NOT_FOUND` (404). Convenience wrapper for handlers
 * that need the entity to exist.
 */
export function getThoughtOrThrow(ndb: NetworkDb, id: string): Thought {
  const thought = getThought(ndb, id);
  if (!thought) {
    throw new EtnError('NOT_FOUND', `thought ${id} not found`, { entity: 'thought', id });
  }
  return thought;
}

/**
 * Resolve up to {@link THOUGHT_RESOLVE_MAX_IDS} thought ids into lightweight
 * {@link ThoughtRef} metadata (docs/03-server-api.md §6.9). Unknown ids are
 * silently dropped. Used by the client for focus history and mentions where the
 * full entity is unnecessary.
 */
export function resolveThoughts(ndb: NetworkDb, ids: string[]): ThoughtRef[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  // Cap to THOUGHT_RESOLVE_MAX_IDS per the API contract.
  const capped = unique.slice(0, THOUGHT_RESOLVE_MAX_IDS);
  const placeholders = capped.map(() => '?').join(',');
  const rows = ndb
    .prepare(
      `SELECT id, title, type_id, icon, icon_kind, icon_attachment_id, active,
              marked_for_deletion,
              fg_color, bg_color,
              font_bold, font_italic, font_underline, font_strike, font_manual
       FROM thoughts_v WHERE id IN (${placeholders})`,
    )
    .all(...capped) as Array<{
    id: string;
    title: string;
    type_id: string | null;
    icon: string | null;
    icon_kind: string;
    icon_attachment_id: string | null;
    active: number;
    marked_for_deletion: number;
    fg_color: string | null;
    bg_color: string | null;
    font_bold: number;
    font_italic: number;
    font_underline: number;
    font_strike: number;
    font_manual: number;
  }>;
  return rows.map(rowToThoughtRef);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Inline link creation used by {@link createThought} to attach a parent or
 * child link in the same transaction as the new thought. The standalone link
 * CRUD lives in `link-service.ts` (task C4); this helper keeps the create flow
 * atomic without introducing a cross-module dependency in the commit order.
 *
 * Throws `NOT_FOUND` if the target thought is unknown and `DUPLICATE` if an
 * equivalent link already exists.
 */
function createLinkForNewThought(
  ndb: NetworkDb,
  newThoughtId: string,
  createLink: NonNullable<ThoughtCreateInput['create_link']>,
  actorUserId: string,
  now: string,
): void {
  const targetId = createLink.target_thought_id;
  // The new thought has a fresh UUID, so it can never equal an existing target;
  // guard anyway in case of a future caller passing a pre-existing id.
  if (targetId === newThoughtId) {
    throw new EtnError('VALIDATION_ERROR', 'a thought cannot link to itself');
  }
  const exists = ndb.prepare('SELECT 1 FROM thoughts_v WHERE id = ?').get(targetId);
  if (!exists) {
    throw new EtnError('NOT_FOUND', `target thought ${targetId} not found`, {
      entity: 'thought',
      id: targetId,
    });
  }
  // parent: new thought sources a link to target. child: target sources to new.
  const [sourceId, linkTargetId] =
    createLink.direction === 'parent' ? [newThoughtId, targetId] : [targetId, newThoughtId];
  const typeId = createLink.type_id ?? null;
  // Duplicate guard, NULL-safe on both sides (UNIQUE treats NULL as distinct).
  const dup = ndb
    .prepare(
      'SELECT 1 FROM links_v WHERE source_id = ? AND target_id = ? AND ifnull(type_id, ?) = ? LIMIT 1',
    )
    .get(sourceId, linkTargetId, '\u0000', typeId ?? '\u0000');
  if (dup) {
    throw new EtnError('DUPLICATE', 'an equivalent link already exists', {
      source_id: sourceId,
      target_id: linkTargetId,
      type_id: typeId,
    });
  }
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                        created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), sourceId, linkTargetId, typeId, now, now, actorUserId, actorUserId);
}

/**
 * Create a thought (docs/03-server-api.md §6.3). Generates the id and
 * `title_norm`, sets `version = 1`, persists synonyms, and optionally creates a
 * parent/child link atomically. Returns the freshly-created {@link Thought}.
 *
 * @param ndb - open network database.
 * @param input - creation payload (title required, rest optional).
 * @param actorUserId - user performing the creation (stored as created_by/updated_by).
 */
export function createThought(
  ndb: NetworkDb,
  input: ThoughtCreateInput,
  actorUserId: string,
): Thought {
  const title = validateTitle(input.title);
  const id = randomUUID();
  const now = new Date().toISOString();
  const synonyms = parseSynonyms(input.synonyms);
  const iconKind: IconKind = input.icon_kind ?? 'emoji';

  return ndb.transaction(() => {
    // The root type is never assignable — its settings apply to untyped
    // thoughts implicitly (L21, docs/08-ui-spec.md §8.1).
    if (input.type_id !== undefined && input.type_id !== null) {
      assertThoughtTypeAssignable(ndb, input.type_id);
    }
    // Bitmap of manually-provided font_* fields (those absent stay inherited).
    const fontManual =
      (input.font_bold !== undefined ? FONT_BOLD_BIT : 0) |
      (input.font_italic !== undefined ? FONT_ITALIC_BIT : 0) |
      (input.font_underline !== undefined ? FONT_UNDERLINE_BIT : 0) |
      (input.font_strike !== undefined ? FONT_STRIKE_BIT : 0);
    ndb
      .prepare(
        `INSERT INTO thoughts (id, title, title_norm, type_id, icon, icon_kind, active,
                             is_protected, is_root, fg_color, bg_color,
                             font_bold, font_italic, font_underline, font_strike, font_manual,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        title,
        normalizeTitle(title),
        input.type_id ?? null,
        input.icon ?? null,
        iconKind,
        input.active === false ? 0 : 1,
        input.fg_color ?? null,
        input.bg_color ?? null,
        input.font_bold ? 1 : 0,
        input.font_italic ? 1 : 0,
        input.font_underline ? 1 : 0,
        input.font_strike ? 1 : 0,
        fontManual,
        now,
        actorUserId,
        now,
        actorUserId,
      );
    setSynonyms(ndb, id, synonyms);
    if (input.create_link) {
      createLinkForNewThought(ndb, id, input.create_link, actorUserId, now);
    }
    // Server-side comment template application (0.4.3): a thought created with
    // a type that carries a non-empty `comment_template_md` gets its permanent
    // comment seeded with the template text, so agent-created cards (MCP/REST,
    // which cannot pass a comment body on create) match the UI behaviour.
    // `upsert_bundle` with an explicit comment overwrites this later in the
    // same transaction.
    if (input.type_id !== undefined && input.type_id !== null) {
      const template = getThoughtType(ndb, input.type_id)?.comment_template_md;
      if (template !== null && template !== undefined && template.trim() !== '') {
        createComment(
          ndb,
          'thought',
          id,
          { kind: 'permanent', title: null, body_md: template },
          actorUserId,
        );
      }
    }
    // Re-read to pick up default columns and synonyms verbatim.
    return getThoughtOrThrow(ndb, id);
  });
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Patch a thought (docs/03-server-api.md §6.4). Last-write-wins per field: only
 * keys present in `changes` are written. `version` is bumped on every
 * successful update.
 *
 * Throws:
 *   * `NOT_FOUND` (404) if the thought does not exist;
 *   * `VERSION_CONFLICT` (409) if `expectedVersion` is set and does not match;
 *   * `PROTECTED_ENTITY` (422) if `is_root` and the caller tries to deactivate.
 */
export function updateThought(
  ndb: NetworkDb,
  id: string,
  changes: ThoughtUpdateInput,
  expectedVersion: number | undefined,
  actorUserId: string,
): Thought {
  return ndb.transaction(() => {
    const current = getThoughtOrThrow(ndb, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'thought version mismatch', {
        entity: 'thought',
        id,
        expected: expectedVersion,
        current: current.version,
      });
    }
    // Protect the HOME thought from being deactivated.
    if (current.is_root && changes.active === false) {
      throw new EtnError('PROTECTED_ENTITY', 'the root thought cannot be deactivated', {
        entity: 'thought',
        id,
      });
    }

    const sets: string[] = [];
    const args: unknown[] = [];
    if (changes.title !== undefined) {
      const title = validateTitle(changes.title);
      sets.push('title = ?', 'title_norm = ?');
      args.push(title, normalizeTitle(title));
    }
    if (changes.type_id !== undefined) {
      // The root type is never assignable — its settings apply to untyped
      // thoughts implicitly (L21, docs/08-ui-spec.md §8.1).
      if (changes.type_id !== null) {
        assertThoughtTypeAssignable(ndb, changes.type_id);
      }
      sets.push('type_id = ?');
      args.push(changes.type_id);
    }
    if (changes.icon !== undefined) {
      sets.push('icon = ?');
      args.push(changes.icon);
    }
    if (changes.icon_kind !== undefined) {
      sets.push('icon_kind = ?');
      args.push(changes.icon_kind);
    }
    // Icon ← attachment link (L16). A non-null value must reference an image
    // file attachment owned by THIS thought; replacing the icon with an
    // emoji/URL/cleared icon without an explicit link drops the old reference.
    const clearsAttachment =
      changes.icon_kind === 'emoji' ||
      changes.icon === null ||
      (changes.icon !== undefined &&
        changes.icon !== null &&
        changes.icon_attachment_id === undefined);
    if (changes.icon_attachment_id !== undefined) {
      const attachmentId = changes.icon_attachment_id;
      if (attachmentId !== null) {
        const attachment = getAttachment(ndb, attachmentId);
        if (
          attachment === null ||
          attachment.kind !== 'file' ||
          !(attachment.mime_type ?? '').startsWith('image/') ||
          attachment.owner_type !== 'thought' ||
          attachment.owner_id !== id
        ) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'icon_attachment_id должен указывать на картинку-вложение этой мысли.',
            { field: 'icon_attachment_id', attachment_id: attachmentId },
          );
        }
      }
      sets.push('icon_attachment_id = ?');
      args.push(attachmentId);
    } else if (clearsAttachment) {
      sets.push('icon_attachment_id = ?');
      args.push(null);
    }
    if (changes.active !== undefined) {
      sets.push('active = ?');
      args.push(changes.active ? 1 : 0);
    }
    // Mark-for-deletion (S13, 02-data-model.md §3.1.2): `true` sets the flag and
    // records when/by whom; `false` clears the flag and its audit columns. No
    // blocking check here — marking is always allowed and reversible.
    if (changes.marked_for_deletion !== undefined) {
      if (changes.marked_for_deletion) {
        sets.push('marked_for_deletion = ?', 'marked_for_deletion_at = ?', 'marked_for_deletion_by = ?');
        args.push(1, new Date().toISOString(), actorUserId);
      } else {
        sets.push('marked_for_deletion = ?', 'marked_for_deletion_at = ?', 'marked_for_deletion_by = ?');
        args.push(0, null, null);
      }
    }
    if (changes.fg_color !== undefined) {
      sets.push('fg_color = ?');
      args.push(changes.fg_color);
    }
    if (changes.bg_color !== undefined) {
      sets.push('bg_color = ?');
      args.push(changes.bg_color);
    }
    // Font-style changes use the manual bitmap: null clears the bit (inherit
    // from type), true/false sets the bit and the stored value (02-data-model.md
    // §3.1.1). Reconstruct the current bitmap from the DTO (font_* !== null ⇒
    // the bit was on), then apply each incoming change.
    let fontManual =
      (current.font_bold !== null ? FONT_BOLD_BIT : 0) |
      (current.font_italic !== null ? FONT_ITALIC_BIT : 0) |
      (current.font_underline !== null ? FONT_UNDERLINE_BIT : 0) |
      (current.font_strike !== null ? FONT_STRIKE_BIT : 0);
    let anyFont = false;
    const applyFont = (bit: number, change: boolean | null | undefined, col: string): void => {
      if (change === undefined) return;
      anyFont = true;
      if (change === null) {
        // Clear the bit; leave the stored value untouched (ignored while off).
        fontManual &= ~bit;
        return;
      }
      fontManual |= bit;
      sets.push(`${col} = ?`);
      args.push(change ? 1 : 0);
    };
    applyFont(FONT_BOLD_BIT, changes.font_bold, 'font_bold');
    applyFont(FONT_ITALIC_BIT, changes.font_italic, 'font_italic');
    applyFont(FONT_UNDERLINE_BIT, changes.font_underline, 'font_underline');
    applyFont(FONT_STRIKE_BIT, changes.font_strike, 'font_strike');
    if (anyFont) {
      sets.push('font_manual = ?');
      args.push(fontManual);
    }

    const now = new Date().toISOString();
    sets.push('version = ?', 'updated_at = ?', 'updated_by = ?');
    args.push(current.version + 1, now, actorUserId);

    args.push(id);
    ndb.prepare(`UPDATE thoughts SET ${sets.join(', ')} WHERE id = ?`).run(...args);

    if (changes.synonyms !== undefined) {
      setSynonyms(ndb, id, parseSynonyms(changes.synonyms));
    }
    return getThoughtOrThrow(ndb, id);
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Number of children that would be left with no parent after deleting
 * `thoughtId`: the distinct targets of the thought's active outgoing links
 * that have no other active incoming link. The cascade removes link rows, not
 * child thoughts, so this is the "будущие сироты" warning of §6.5/§6.5a.
 */
function countOrphanedChildren(ndb: NetworkDb, thoughtId: string): number {
  const row = ndb
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT l.target_id
         FROM links_v l
         WHERE l.source_id = ? AND l.active = 1
           AND l.target_id <> ?
           AND NOT EXISTS (
             SELECT 1 FROM links_v l2
             WHERE l2.target_id = l.target_id
               AND l2.active = 1
               AND l2.source_id <> ?
           )
         GROUP BY l.target_id
       )`,
    )
    .get(thoughtId, thoughtId, thoughtId) as { c: number };
  return row.c;
}

/**
 * Check whether a thought can be physically deleted (docs/03-server-api.md
 * §6.5a). Blocking arms: "использование в свойствах" (`thought_ref` from other
 * thoughts) and — since the layers schema landed in S2 — live (`deleted = 0`)
 * shadow rows of the thought itself or of links where it is an endpoint in any
 * non-base layer (docs/02-data-model.md §3.1.2 п.2–3). Also reports how many
 * children would become orphans.
 *
 * Throws `NOT_FOUND` (404) when the thought does not exist.
 */
export function checkThoughtDeletion(ndb: NetworkDb, id: string): ThoughtDeletionCheckResult {
  const row = ndb.prepare('SELECT 1 FROM thoughts_v WHERE id = ?').get(id);
  if (!row) {
    throw new EtnError('NOT_FOUND', `thought ${id} not found`, { entity: 'thought', id });
  }
  const properties = countThoughtRefUsages(ndb, id);
  const holdingLayers = listThoughtHoldingLayers(ndb, id);
  return {
    blocked: properties > 0 || holdingLayers.length > 0,
    blocking: { properties, layers: holdingLayers },
    orphaned_children: countOrphanedChildren(ndb, id),
  };
}

/**
 * Delete a thought (docs/03-server-api.md §6.5). Since S2 there are no SQL FKs
 * from other entity tables to `thoughts` (the logical id is no longer unique),
 * so the whole cascade — incident links (with their polymorphic dependants),
 * synonyms, comments, attachments, property values and the per-user state
 * (views, focus, pins, read metrics) — runs explicitly in the same transaction
 * (see {@link purgeThoughtDeletionDependants}).
 *
 * Throws:
 *   * `NOT_FOUND` (404) if the thought does not exist;
 *   * `VERSION_CONFLICT` (409) if `expectedVersion` is set and does not match;
 *   * `PROTECTED_ENTITY` (422) for `is_protected` thoughts (HOME);
 *   * `VALIDATION_ERROR` (422, `details.blocking`) when deletion is blocked by
 *     referencing properties or by a holding layer (S13/S2, §6.5a).
 */
export function deleteThought(
  ndb: NetworkDb,
  id: string,
  expectedVersion: number | undefined,
): void {
  ndb.transaction(() => {
    const current = getThoughtOrThrow(ndb, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'thought version mismatch', {
        entity: 'thought',
        id,
        expected: expectedVersion,
        current: current.version,
      });
    }
    if (current.is_protected) {
      throw new EtnError('PROTECTED_ENTITY', 'protected thoughts cannot be deleted', {
        entity: 'thought',
        id,
      });
    }
    // S13: refuse physical deletion while other thoughts reference this one
    // through a thought_ref property, or while a non-base layer holds a live
    // shadow row of it / of a link where it is an endpoint
    // (02-data-model.md §3.1.2).
    const check = checkThoughtDeletion(ndb, id);
    if (check.blocked) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'thought is used in properties or held by a layer and cannot be deleted',
        {
          entity: 'thought',
          id,
          blocking: check.blocking,
        },
      );
    }
    // Everything that used to ride on SQL FKs (links, synonyms, per-user
    // state) or has none (comments, attachments, property values) is cleaned
    // up explicitly, in this transaction — see purgeThoughtDeletionDependants.
    purgeThoughtDeletionDependants(ndb, id);
    ndb.prepare('DELETE FROM thoughts WHERE id = ?').run(id);
  });
}

// ---------------------------------------------------------------------------
// Synonym helpers (direct API for callers that manage synonyms outside update)
// ---------------------------------------------------------------------------

/** Append synonyms to a thought, ignoring duplicates by normalised form. */
export function addSynonyms(ndb: NetworkDb, thoughtId: string, input: SynonymInput): string[] {
  return ndb.transaction(() => {
    getThoughtOrThrow(ndb, thoughtId);
    const additions = parseSynonyms(input);
    const stmt = ndb.prepare(
      'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)',
    );
    for (const synonym of additions) {
      stmt.run(thoughtId, synonym, normalizeTitle(synonym));
    }
    return readSynonyms(ndb, thoughtId);
  });
}

/** Remove a single synonym (matched case-insensitively by normalised form). */
export function removeSynonym(ndb: NetworkDb, thoughtId: string, synonym: string): string[] {
  return ndb.transaction(() => {
    getThoughtOrThrow(ndb, thoughtId);
    ndb
      .prepare('DELETE FROM thought_synonyms WHERE thought_id = ? AND synonym_norm = ?')
      .run(thoughtId, normalizeTitle(synonym));
    return readSynonyms(ndb, thoughtId);
  });
}

/** Replace the full synonym set of a thought. */
export function replaceSynonyms(ndb: NetworkDb, thoughtId: string, input: SynonymInput): string[] {
  return ndb.transaction(() => {
    getThoughtOrThrow(ndb, thoughtId);
    setSynonyms(ndb, thoughtId, parseSynonyms(input));
    return readSynonyms(ndb, thoughtId);
  });
}

// ---------------------------------------------------------------------------
// Focus & neighbours
// ---------------------------------------------------------------------------

/** Options controlling neighbour visibility and ordering. */
export interface NeighborOptions {
  /** Acting user — needed for `viewed`/`manual` sort and focus preferences. */
  userId?: string;
  /** Include inactive thoughts/links when true (preferences.show_inactive). */
  showInactive?: boolean;
  /** Sort strategy (docs/11-settings-and-state.md §3.2). */
  sort?: SortKind;
  /** Sort direction. */
  order?: SortOrder;
  /** Max number of neighbours to return. */
  limit?: number;
  /** Number of neighbours to skip. */
  offset?: number;
  /** Restrict neighbours to thoughts of this type (03-server-api.md §6.7). */
  typeId?: string;
}

/** Read a user's sort preference for a (focus, dir) zone, or null if unset. */
function readFocusPref(
  ndb: NetworkDb,
  userId: string,
  focusThoughtId: string,
  dir: FocusDir,
): { sort: SortKind; order: SortOrder } | null {
  const row = ndb
    .prepare(
      'SELECT sort, sort_order FROM user_focus_preferences WHERE user_id = ? AND focus_thought_id = ? AND dir = ?',
    )
    .get(userId, focusThoughtId, dir) as { sort: string; sort_order: string } | undefined;
  if (!row) return null;
  return { sort: row.sort as SortKind, order: row.sort_order as SortOrder };
}

/** Guard that a value is one of the accepted sort strategies. */
function isValidSort(v: unknown): v is SortKind {
  return typeof v === 'string' && (SORT_KINDS as readonly string[]).includes(v);
}

/** Guard that a value is one of the accepted sort orders. */
function isValidOrder(v: unknown): v is SortOrder {
  return typeof v === 'string' && (SORT_ORDERS as readonly string[]).includes(v);
}

/**
 * Resolve a sort/order pair for `getNeighbors`. Explicit caller values win;
 * otherwise default to `created`/`asc` (docs/11-settings-and-state.md §3.2).
 *
 * Values are validated against the enum tuples so that untrusted HTTP input
 * can never reach {@link orderByClause} as raw text.
 *
 * Stored focus preferences are applied by {@link focus} (which knows the focus
 * id); `getNeighbors` does not consult them.
 */
function resolveSortOrder(opts: NeighborOptions): { sort: SortKind; order: SortOrder } {
  const sort: SortKind = isValidSort(opts.sort) ? opts.sort : 'created';
  const order: SortOrder = isValidOrder(opts.order) ? opts.order : 'asc';
  return { sort, order };
}

/**
 * Build the `ORDER BY` clause for a neighbour listing. `sort` and `order` are
 * enum members (validated by the caller), never free user text, so embedding
 * them here is safe.
 *
 * Manual order keeps un-positioned thoughts last (NULLS LAST) and falls back to
 * alphabetical for siblings, which never store a manual position
 * (docs/02-data-model.md §3.10.4).
 */
function orderByClause(sort: SortKind, order: SortOrder, dir: FocusDir): string {
  const dirKeyword = order === 'desc' ? 'DESC' : 'ASC';
  const nulls = order === 'desc' ? 'DESC' : 'ASC';
  switch (sort) {
    case 'alpha':
      return `ORDER BY t.title COLLATE NOCASE ${dirKeyword}`;
    case 'created':
      return `ORDER BY t.created_at ${dirKeyword}`;
    case 'viewed':
      // Never-viewed thoughts sort last regardless of direction.
      return `ORDER BY (tv.last_viewed_at IS NULL) ${nulls}, tv.last_viewed_at ${dirKeyword}`;
    case 'manual':
      if (dir === 'siblings') {
        return `ORDER BY t.title COLLATE NOCASE ${dirKeyword}`;
      }
      return `ORDER BY (ufo.position IS NULL) ${nulls}, ufo.position ${dirKeyword}, t.title COLLATE NOCASE ASC`;
  }
}

/**
 * Build the fully-parameterised neighbours query for one direction.
 *
 * The `dir`/`sort`/`order` values are enum members validated upstream and only
 * select between fixed SQL fragments — they are never interpolated as raw
 * identifiers. All dynamic values (user id, focus id, showInactive flag, limits)
 * bind via `?` placeholders returned alongside the SQL.
 */
function buildNeighborsQuery(
  dir: FocusDir,
  sort: SortKind,
  order: SortOrder,
  opts: NeighborOptions,
  focusThoughtId: string,
): { sql: string; params: unknown[] } {
  const showInactive = opts.showInactive === true ? 1 : 0;
  const userId = opts.userId;
  const useViewedJoin = sort === 'viewed' && !!userId;
  const useManualJoin = sort === 'manual' && dir !== 'siblings' && !!userId;

  const select =
    'SELECT t.id, t.title, t.type_id, t.icon, t.active, t.created_at' +
    (useViewedJoin ? ', tv.last_viewed_at' : '') +
    // Alias is required: rowToNeighbor reads `manual_position` by name.
    (useManualJoin ? ', ufo.position AS manual_position' : '') +
    (dir === 'siblings'
      ? ', MIN(l.id) AS link_id, MIN(l.type_id) AS link_type_id, MIN(l.active) AS link_active'
      : ', l.id AS link_id, l.type_id AS link_type_id, l.active AS link_active');

  const joins: string[] = [];
  const params: unknown[] = [];

  if (dir === 'parents') {
    joins.push('JOIN thoughts_v t ON t.id = l.source_id');
  } else if (dir === 'children') {
    joins.push('JOIN thoughts_v t ON t.id = l.target_id');
  } else {
    // siblings: pick the focus's parents, then their other children.
    joins.push('JOIN links_v lp ON lp.source_id = l.source_id');
    joins.push('JOIN thoughts_v t ON t.id = l.target_id');
  }
  if (useViewedJoin) {
    joins.push('LEFT JOIN thought_views tv ON tv.user_id = ? AND tv.thought_id = t.id');
    params.push(userId);
  }
  if (useManualJoin) {
    joins.push(
      'LEFT JOIN user_focus_order ufo ON ufo.user_id = ? AND ufo.focus_thought_id = ? AND ufo.dir = ? AND ufo.thought_id = t.id',
    );
    params.push(userId, focusThoughtId, dir);
  }

  const where: string[] = [];
  if (dir === 'parents') {
    where.push('l.target_id = ?');
    params.push(focusThoughtId);
  } else if (dir === 'children') {
    where.push('l.source_id = ?');
    params.push(focusThoughtId);
  } else {
    where.push('lp.target_id = ?', 'l.target_id <> ?');
    params.push(focusThoughtId, focusThoughtId);
  }
  // Active filter on the link(s) and the neighbour thought, gated by showInactive.
  if (dir === 'siblings') {
    where.push('(lp.active = 1 OR ?)', '(l.active = 1 OR ?)', '(t.active = 1 OR ?)');
    params.push(showInactive, showInactive, showInactive);
  } else {
    where.push('(l.active = 1 OR ?)', '(t.active = 1 OR ?)');
    params.push(showInactive, showInactive);
  }
  // Optional thought-type filter (03-server-api.md §6.7). Pushed after the
  // clauses above so the bind order stays aligned with `where`.
  if (opts.typeId !== undefined) {
    where.push('t.type_id = ?');
    params.push(opts.typeId);
  }

  const sqlParts = [select, 'FROM links_v l', ...joins.map((j) => j.trimStart())];
  sqlParts.push('WHERE ' + where.join(' AND '));
  if (dir === 'siblings') {
    sqlParts.push('GROUP BY t.id');
  }
  sqlParts.push(orderByClause(sort, order, dir));
  return { sql: sqlParts.join('\n'), params };
}

/**
 * List a thought's parents, children, or siblings (docs/03-server-api.md §6.7).
 *
 * Parents are sources of links targeting the thought; children are targets of
 * links originating at it; siblings are thoughts sharing at least one parent
 * (excluding the thought itself). Inactive thoughts and links are filtered out
 * unless `opts.showInactive` is set.
 */
export function getNeighbors(
  ndb: NetworkDb,
  thoughtId: string,
  dir: FocusDir,
  opts: NeighborOptions = {},
): FocusNeighbor[] {
  if (!FOCUS_DIRS.includes(dir)) {
    throw new EtnError('VALIDATION_ERROR', `invalid dir: ${String(dir)}`, { field: 'dir' });
  }
  const { sort, order } = resolveSortOrder(opts);
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const { sql, params } = buildNeighborsQuery(dir, sort, order, opts, thoughtId);
  const rows = ndb
    .prepare(`${sql} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as NeighborRow[];
  return rows.map(rowToNeighbor);
}

/** Options for {@link focus}. */
export interface FocusOptions {
  /** Include inactive thoughts/links when true (preferences.show_inactive). */
  showInactive?: boolean;
}

/**
 * Focus a thought (docs/03-server-api.md §6.2). Records the user's view
 * (`thought_views.last_viewed_at`) and returns the focused thought plus its
 * parents, children and siblings, ordered by the user's stored focus-zone
 * preference for each direction (default `created`/`asc`).
 *
 * The current focus id is **not** persisted server-side — it is a client L4
 * state (docs/11-settings-and-state.md §2). Only the view mark is.
 *
 * Throws `NOT_FOUND` (404) if the thought does not exist.
 */
export function focus(
  ndb: NetworkDb,
  userId: string,
  thoughtId: string,
  opts: FocusOptions = {},
): FocusResponse {
  const focused = getThoughtOrThrow(ndb, thoughtId);
  const showInactive = opts.showInactive === true;
  const now = new Date().toISOString();

  // Record the view mark (upsert). audience=user event emitted by the realtime layer.
  ndb.transaction(() => {
    ndb
      .prepare(
        `INSERT INTO thought_views (user_id, thought_id, last_viewed_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id, thought_id) DO UPDATE SET last_viewed_at = excluded.last_viewed_at`,
      )
      .run(userId, thoughtId, now);
  });

  const dirs: FocusDir[] = ['parents', 'children', 'siblings'];
  const grouped: Record<FocusDir, FocusNeighbor[]> = {
    parents: [],
    children: [],
    siblings: [],
  };
  // Read the stored sort preferences per zone; siblings is not manually
  // orderable but does store a sort/order selection (03-server-api.md §6.8).
  const parentPref = readFocusPref(ndb, userId, thoughtId, 'parents');
  const childPref = readFocusPref(ndb, userId, thoughtId, 'children');
  const siblingPref = readFocusPref(ndb, userId, thoughtId, 'siblings');
  const prefs: Record<FocusDir, { sort: SortKind; order: SortOrder } | null> = {
    parents: parentPref,
    children: childPref,
    siblings: siblingPref,
  };
  for (const dir of dirs) {
    grouped[dir] = getNeighbors(ndb, thoughtId, dir, {
      userId,
      showInactive,
      sort: prefs[dir]?.sort,
      order: prefs[dir]?.order,
    });
  }
  // Zone exclusivity (08-ui-spec.md §2.1): a thought may appear in at most one
  // zone. Priority: focus (never a neighbour) > parents > children > siblings —
  // e.g. a thought that is both a child of the focus and of a focus's parent is
  // listed in «Низ» only. Also collapses duplicate rows from parallel links of
  // different types. Edges still cover all visible thoughts, so links to a
  // thought's other roles keep drawing.
  const taken = new Set<string>([thoughtId]);
  for (const dir of dirs) {
    grouped[dir] = grouped[dir].filter((n) => {
      if (taken.has(n.id)) return false;
      taken.add(n.id);
      return true;
    });
  }
  // Every active link among the visible thoughts (focus + parents + children +
  // siblings) — for the canvas to draw links between any two visible clouds,
  // not only those incident to the focus.
  const visibleIds = [
    thoughtId,
    ...grouped.parents.map((n) => n.id),
    ...grouped.children.map((n) => n.id),
    ...grouped.siblings.map((n) => n.id),
  ];
  const edges = getEdgesAmong(ndb, visibleIds, showInactive).map((l) => ({
    id: l.id,
    source_id: l.source_id,
    target_id: l.target_id,
    type_id: l.type_id,
    // Per-link line-style override (null = inherit from the type); 08-ui-spec.md §6.9.
    color: l.color,
    style: l.style,
    width: l.width,
  }));
  // Whether each visible thought has any incoming/outgoing link at all —
  // drives the top/bottom ellipse fill so chains are visible off-screen.
  const directions = getLinkDirections(ndb, visibleIds);
  const annotate = (n: FocusNeighbor): FocusNeighbor => {
    const d = directions.get(n.id) ?? { has_in: false, has_out: false };
    return { ...n, has_incoming: d.has_in, has_outgoing: d.has_out };
  };
  return {
    focused,
    parents: grouped.parents.map(annotate),
    children: grouped.children.map(annotate),
    siblings: grouped.siblings.map(annotate),
    edges,
    sorts: {
      parents: { sort: parentPref?.sort ?? 'created', order: parentPref?.order ?? 'asc' },
      children: { sort: childPref?.sort ?? 'created', order: childPref?.order ?? 'asc' },
      siblings: { sort: siblingPref?.sort ?? 'created', order: siblingPref?.order ?? 'asc' },
    },
  };
}

// ---------------------------------------------------------------------------
// "Card completeness" warnings (task O6, docs/05-mcp-server.md §4.2)
// ---------------------------------------------------------------------------

/**
 * Result of a mutation that may surface {@link ThoughtCardWarning}s about the
 * resulting card. REST endpoints ignore `warnings`; the MCP layer surfaces
 * them to the agent so it can follow up with `etn.properties.set` /
 * `etn.thoughts.upsert_bundle`.
 */
export interface ThoughtMutationWithWarnings {
  thought: Thought;
  warnings: ThoughtCardWarning[];
}

/**
 * Thin wrapper over {@link createThought} that returns the resulting thought
 * together with the list of "missing required property" warnings (task O6).
 * The warnings are computed against the freshly-written row in the same
 * transaction — empty when the type has no `required` properties or when all
 * of them are filled.
 */
export function createThoughtWithWarnings(
  ndb: NetworkDb,
  input: ThoughtCreateInput,
  actorUserId: string,
): ThoughtMutationWithWarnings {
  const thought = createThought(ndb, input, actorUserId);
  const warnings = computeThoughtCardWarnings(ndb, thought.id);
  return { thought, warnings };
}

/**
 * Thin wrapper over {@link updateThought}. Warnings are recomputed **only**
 * when the change set may have shifted the required-property surface — i.e.
 * `type_id` is present in `changes` (a type assignment is the only mutation
 * that can introduce a new obligation; renaming, restyling and toggling
 * `active` leave the property contract alone, so we skip the lookup).
 */
export function updateThoughtWithWarnings(
  ndb: NetworkDb,
  id: string,
  changes: ThoughtUpdateInput,
  expectedVersion: number | undefined,
  actorUserId: string,
): ThoughtMutationWithWarnings {
  const thought = updateThought(ndb, id, changes, expectedVersion, actorUserId);
  const warnings =
    changes.type_id === undefined ? [] : computeThoughtCardWarnings(ndb, thought.id);
  return { thought, warnings };
}
