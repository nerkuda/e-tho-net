/**
 * Comment domain service (task C7, docs/03-server-api.md §10,
 * docs/02-data-model.md §3.8).
 *
 * Comments are polymorphic: they attach to thoughts or links. A chronological
 * comment may be attached to **several** owners at once (L20): the m2m table
 * `comment_targets` holds the full set, while `comments.owner_type/owner_id`
 * keep the primary (first) attachment. Two kinds exist:
 *   * `permanent` — at most **one** per owner (enforced by the partial unique
 *     index `idx_comments_permanent_one`) and always exactly one target;
 *     `valid_from = created_at`, `valid_to = NULL`.
 *   * `chronological` — unrestricted count; carries `valid_from`/`valid_to`
 *     and 1..N targets. Detaching the last target re-attaches the comment to
 *     the network HOME thought.
 *
 * The server renders and caches `body_html` from `body_md` via the safe
 * {@link renderMarkdown} renderer. Mutating calls accept an optional
 * `expectedVersion` for the `If-Match` optimistic-concurrency contract.
 */

import { randomUUID } from 'node:crypto';

import {
  CHRONO_PREVIEW_MAX_ENTRIES,
  COMMENT_KINDS,
  COMMENT_OWNER_TYPES,
  COMMENT_PREVIEW_CHARS,
  COMMENT_TARGETS_MAX,
  EtnError,
  type Comment,
  type CommentInput,
  type CommentKind,
  type CommentOwnerType,
  type CommentTarget,
  type CommentUpdateInput,
  type CommentsPreview,
  type PermanentCommentPreview,
} from '@etn/shared';

import { renderMarkdown } from '@etn/markdown';

import type { NetworkDb } from '../db/network-db.js';
import {
  deleteRowLayered,
  isBaseContext,
  materializeShadow,
  materializeTombstone,
} from '../db/layer-write.js';

/** Raw `comments` row shape (dates as strings, no booleans). */
interface CommentRow {
  id: string;
  owner_type: string;
  owner_id: string;
  kind: string;
  title: string | null;
  body_md: string;
  body_html: string;
  valid_from: string;
  valid_to: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

/** Convert a raw row into a {@link Comment} (targets are attached separately). */
function rowToComment(row: CommentRow, targets: CommentTarget[] = []): Comment {
  return {
    id: row.id,
    owner_type: row.owner_type as CommentOwnerType,
    owner_id: row.owner_id,
    targets: orderTargets(row, targets),
    kind: row.kind as CommentKind,
    title: row.title,
    body_md: row.body_md,
    body_html: row.body_html,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

/** Stable targets order: the primary owner first, then the rest as stored. */
function orderTargets(row: { owner_type: string; owner_id: string }, targets: CommentTarget[]): CommentTarget[] {
  const primary = targets.filter((t) => t.owner_type === row.owner_type && t.owner_id === row.owner_id);
  const rest = targets.filter((t) => t.owner_type !== row.owner_type || t.owner_id !== row.owner_id);
  return [...primary, ...rest];
}

/**
 * Load the m2m targets of the given comments in one query, grouped by comment
 * id. Rows whose target set is somehow missing fall back to the primary owner
 * (keeps the «at least one target» invariant even on partially-lost data).
 */
function loadTargets(
  ndb: NetworkDb,
  rows: Array<{ id: string; owner_type: string; owner_id: string }>,
): Map<string, CommentTarget[]> {
  const map = new Map<string, CommentTarget[]>();
  if (rows.length === 0) return map;
  const placeholders = rows.map(() => '?').join(', ');
  const targetRows = ndb
    .prepare(
      `SELECT comment_id, owner_type, owner_id FROM comment_targets_v
       WHERE comment_id IN (${placeholders})`,
    )
    .all(...rows.map((r) => r.id)) as Array<{ comment_id: string; owner_type: string; owner_id: string }>;
  for (const tr of targetRows) {
    const list = map.get(tr.comment_id) ?? [];
    list.push({ owner_type: tr.owner_type as CommentOwnerType, owner_id: tr.owner_id });
    map.set(tr.comment_id, list);
  }
  for (const r of rows) {
    if (!map.has(r.id)) {
      map.set(r.id, [{ owner_type: r.owner_type as CommentOwnerType, owner_id: r.owner_id }]);
    }
  }
  return map;
}

/** Validate a comment kind against the enum tuple. */
function validateKind(kind: unknown): CommentKind {
  if (typeof kind !== 'string' || !(COMMENT_KINDS as readonly string[]).includes(kind)) {
    throw new EtnError('VALIDATION_ERROR', `invalid comment kind: ${String(kind)}`, {
      field: 'kind',
      allowed: COMMENT_KINDS,
    });
  }
  return kind as CommentKind;
}

/** Validate a polymorphic owner type against the enum tuple. */
function validateOwnerType(ownerType: unknown): CommentOwnerType {
  if (
    typeof ownerType !== 'string' ||
    !(COMMENT_OWNER_TYPES as readonly string[]).includes(ownerType)
  ) {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${String(ownerType)}`, {
      field: 'owner_type',
      allowed: COMMENT_OWNER_TYPES,
    });
  }
  return ownerType as CommentOwnerType;
}

/**
 * Ensure the polymorphic owner exists. Comments have no SQL FK, so this guard
 * prevents orphaned comments and gives the caller a precise 404. Reads through
 * the layer-resolving views (13-layers.md §4.2): an owner tombstoned in the
 * connection's layer is a valid 404 for a layer-scoped comment.
 */
function ensureOwnerExists(ndb: NetworkDb, ownerType: CommentOwnerType, ownerId: string): void {
  const table = ownerType === 'thought' ? 'thoughts_v' : 'links_v';
  const row = ndb.prepare(`SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`).get(ownerId);
  if (!row) {
    throw new EtnError('NOT_FOUND', `${ownerType} ${ownerId} not found`, {
      entity: ownerType,
      id: ownerId,
    });
  }
}

/** Return a comment by id, or `null` when absent. */
export function getComment(ndb: NetworkDb, id: string): Comment | null {
  const row = ndb.prepare('SELECT * FROM comments_v WHERE id = ? LIMIT 1').get(id) as
    CommentRow | undefined;
  if (row === undefined) return null;
  const targets = loadTargets(ndb, [row]).get(id) ?? [];
  return rowToComment(row, targets);
}

/** Return a comment or throw `NOT_FOUND` (404). */
function getCommentOrThrow(ndb: NetworkDb, id: string): Comment {
  const comment = getComment(ndb, id);
  if (!comment) {
    throw new EtnError('NOT_FOUND', `comment ${id} not found`, { entity: 'comment', id });
  }
  return comment;
}

/**
 * List comments attached to an owner (docs/03-server-api.md §10) — the primary
 * `owner_type/owner_id` pair plus every m2m attachment in `comment_targets`
 * (L20). The permanent comment (if any) sorts first, then chronological
 * comments ordered by `valid_from` ascending.
 */
export function listComments(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerId: string,
): Comment[] {
  validateOwnerType(ownerType);
  const rows = ndb
    .prepare(
      `SELECT * FROM comments_v c
       WHERE (c.owner_type = ? AND c.owner_id = ?)
          OR EXISTS (
            SELECT 1 FROM comment_targets_v ct
            WHERE ct.comment_id = c.id AND ct.owner_type = ? AND ct.owner_id = ?
          )
       ORDER BY (c.kind <> 'permanent'), c.valid_from ASC, c.created_at ASC`,
    )
    .all(ownerType, ownerId, ownerType, ownerId) as CommentRow[];
  const targets = loadTargets(ndb, rows);
  return rows.map((row) => rowToComment(row, targets.get(row.id) ?? []));
}

/**
 * Превью постоянного комментария (tasks N2/N5): `body_md` — первые
 * {@link COMMENT_PREVIEW_CHARS} символов с метаданными обрезки; `null`, когда
 * постоянного комментария нет. Один SELECT по частичному уникальному индексу
 * `idx_comments_permanent_one`.
 */
export function getPermanentPreview(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerId: string,
): PermanentCommentPreview | null {
  validateOwnerType(ownerType);
  const row = ndb
    .prepare(
      `SELECT id, body_md, valid_from, created_at, updated_at FROM comments_v
       WHERE owner_type = ? AND owner_id = ? AND kind = 'permanent'
       LIMIT 1`,
    )
    .get(ownerType, ownerId) as
    | {
        id: string;
        body_md: string;
        valid_from: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (row === undefined) {
    return null;
  }
  const chars_total = row.body_md.length;
  const chars_returned = Math.min(chars_total, COMMENT_PREVIEW_CHARS);
  return {
    id: row.id,
    body_md: row.body_md.slice(0, chars_returned),
    chars_returned,
    chars_total,
    truncated: chars_total > chars_returned,
    valid_from: row.valid_from,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Превью комментариев владельца (task N5, MCP `etn.thoughts.subgraph` с
 * `include_comments`): постоянный — через {@link getPermanentPreview};
 * хронология — последние {@link CHRONO_PREVIEW_MAX_ENTRIES} записей (по
 * `valid_from` DESC, затем `created_at` DESC), каждая с телом не длиннее
 * {@link COMMENT_PREVIEW_CHARS} и метаданными обрезки. Уровень списка несёт
 * `total`/`returned`/`truncated` — агент видит, что записей больше и полные
 * доступны отдельным запросом.
 */
export function getCommentsPreview(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerId: string,
): CommentsPreview {
  validateOwnerType(ownerType);
  const permanent = getPermanentPreview(ndb, ownerType, ownerId);
  const total = (
    ndb
      .prepare(
        `SELECT COUNT(*) AS c FROM comments_v c
         WHERE c.kind = 'chronological'
           AND ((c.owner_type = ? AND c.owner_id = ?)
                OR EXISTS (
                  SELECT 1 FROM comment_targets_v ct
                  WHERE ct.comment_id = c.id AND ct.owner_type = ? AND ct.owner_id = ?
                ))`,
      )
      .get(ownerType, ownerId, ownerType, ownerId) as { c: number }
  ).c;
  const rows = ndb
    .prepare(
      `SELECT c.id, c.title, c.body_md, c.valid_from, c.valid_to, c.created_by, c.created_at
       FROM comments_v c
       WHERE c.kind = 'chronological'
         AND ((c.owner_type = ? AND c.owner_id = ?)
              OR EXISTS (
                SELECT 1 FROM comment_targets_v ct
                WHERE ct.comment_id = c.id AND ct.owner_type = ? AND ct.owner_id = ?
              ))
       ORDER BY c.valid_from DESC, c.created_at DESC
       LIMIT ?`,
    )
    .all(ownerType, ownerId, ownerType, ownerId, CHRONO_PREVIEW_MAX_ENTRIES) as Array<{
    id: string;
    title: string | null;
    body_md: string;
    valid_from: string;
    valid_to: string | null;
    created_by: string;
    created_at: string;
  }>;
  const entries = rows.map((row) => {
    const chars_total = row.body_md.length;
    const chars_returned = Math.min(chars_total, COMMENT_PREVIEW_CHARS);
    return {
      id: row.id,
      title: row.title,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      created_by: row.created_by,
      created_at: row.created_at,
      body_md: row.body_md.slice(0, chars_returned),
      chars_returned,
      chars_total,
      truncated: chars_total > chars_returned,
    };
  });
  return {
    permanent,
    chronological: {
      entries,
      total,
      returned: entries.length,
      truncated: entries.length < total,
    },
  };
}

/**
 * Create a comment attached to a single owner (docs/03-server-api.md §10).
 * Backwards-compatible wrapper over {@link createCommentWithTargets} (L20).
 *
 * @param actorUserId - user creating the comment (recorded as created_by/updated_by).
 */
export function createComment(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerId: string,
  input: CommentInput,
  actorUserId: string,
): Comment {
  return createCommentWithTargets(ndb, [{ owner_type: ownerType, owner_id: ownerId }], input, actorUserId);
}

/**
 * Create a comment attached to one or more owners at once (L20,
 * docs/03-server-api.md §10). The first target becomes the primary
 * `owner_type/owner_id`; all targets (including the primary) are written to
 * `comment_targets`. Duplicate targets are collapsed. A `permanent` comment
 * must have exactly one target.
 *
 * Throws:
 *   * `VALIDATION_ERROR` (422) for an invalid kind/targets or empty body;
 *   * `NOT_FOUND` (404) if any target owner does not exist;
 *   * `DUPLICATE` (409) on a second `permanent` comment for the same owner.
 *
 * For `kind = 'permanent'` the `valid_from`/`valid_to` inputs are ignored
 * (`valid_from` becomes `created_at`, `valid_to` is `NULL`). For chronological
 * comments `valid_from` defaults to now and `valid_to` defaults to `null`
 * (open-ended); an explicit empty string is normalised to `null`.
 */
export function createCommentWithTargets(
  ndb: NetworkDb,
  rawTargets: CommentTarget[],
  input: CommentInput,
  actorUserId: string,
): Comment {
  const kind = validateKind(input.kind);
  if (typeof input.body_md !== 'string' || input.body_md === '') {
    throw new EtnError('VALIDATION_ERROR', 'body_md must be a non-empty string', {
      field: 'body_md',
    });
  }
  // Dedup targets preserving order; validate owner types and ids.
  const seen = new Set<string>();
  const targets: CommentTarget[] = [];
  for (const t of rawTargets) {
    const ot = validateOwnerType(t.owner_type);
    if (typeof t.owner_id !== 'string' || t.owner_id === '') {
      throw new EtnError('VALIDATION_ERROR', 'owner_id must be a non-empty string', {
        field: 'targets',
      });
    }
    const key = `${ot}|${t.owner_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ owner_type: ot, owner_id: t.owner_id });
  }
  if (targets.length === 0) {
    throw new EtnError('VALIDATION_ERROR', 'at least one target is required', {
      field: 'targets',
    });
  }
  if (targets.length > COMMENT_TARGETS_MAX) {
    throw new EtnError('VALIDATION_ERROR', `at most ${COMMENT_TARGETS_MAX} targets are allowed`, {
      field: 'targets',
      max: COMMENT_TARGETS_MAX,
    });
  }
  if (kind === 'permanent' && targets.length > 1) {
    throw new EtnError('VALIDATION_ERROR', 'a permanent comment has exactly one owner', {
      field: 'targets',
    });
  }
  const bodyHtml = renderMarkdown(input.body_md);

  return ndb.transaction(() => {
    for (const t of targets) {
      ensureOwnerExists(ndb, t.owner_type, t.owner_id);
    }

    const primary = targets[0];
    if (primary === undefined) {
      throw new EtnError('VALIDATION_ERROR', 'at least one target is required', {
        field: 'targets',
      });
    }
    if (kind === 'permanent') {
      // Enforce the "one permanent per owner" invariant ahead of the unique
      // index so we can raise the canonical DUPLICATE error explicitly.
      const existing = ndb
        .prepare(
          `SELECT 1 FROM comments_v
           WHERE owner_type = ? AND owner_id = ? AND kind = 'permanent' LIMIT 1`,
        )
        .get(primary.owner_type, primary.owner_id);
      if (existing) {
        throw new EtnError('DUPLICATE', 'a permanent comment already exists for this owner', {
          owner_type: primary.owner_type,
          owner_id: primary.owner_id,
        });
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const title = input.title === undefined ? null : input.title;
    // Permanent comments ignore the validity window (docs/02-data-model.md §3.8).
    const validFrom = kind === 'permanent' ? now : (normaliseDate(input.valid_from) ?? now);
    const validTo = kind === 'permanent' ? null : (normaliseDate(input.valid_to) ?? null);

    ndb
      .prepare(
        `INSERT INTO comments (id, layer_id, owner_type, owner_id, kind, title, body_md, body_html,
                               valid_from, valid_to, version,
                               created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ndb.layerId,
        primary.owner_type,
        primary.owner_id,
        kind,
        title,
        input.body_md,
        bodyHtml,
        validFrom,
        validTo,
        now,
        now,
        actorUserId,
        actorUserId,
      );
    const insertTarget = ndb.prepare(
      'INSERT INTO comment_targets (comment_id, owner_type, owner_id, layer_id) VALUES (?, ?, ?, ?)',
    );
    for (const t of targets) {
      insertTarget.run(id, t.owner_type, t.owner_id, ndb.layerId);
    }
    return getCommentOrThrow(ndb, id);
  });
}

/**
 * Patch a comment (docs/03-server-api.md §10). Last-write-wins per field;
 * `body_html` is re-rendered whenever `body_md` changes. `version` is bumped
 * on every successful update.
 *
 * Throws `NOT_FOUND` (404), `VERSION_CONFLICT` (409), or `VALIDATION_ERROR`
 * (422) when setting an empty `body_md`.
 */
export function updateComment(
  ndb: NetworkDb,
  id: string,
  changes: CommentUpdateInput,
  expectedVersion: number | undefined,
  actorUserId: string,
): Comment {
  return ndb.transaction(() => {
    const current = getCommentOrThrow(ndb, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'comment version mismatch', {
        entity: 'comment',
        id,
        expected: expectedVersion,
        current: current.version,
      });
    }

    const sets: string[] = [];
    const args: unknown[] = [];
    if (changes.title !== undefined) {
      sets.push('title = ?');
      args.push(changes.title);
    }
    if (changes.body_md !== undefined) {
      if (changes.body_md === '') {
        throw new EtnError('VALIDATION_ERROR', 'body_md must not be empty', {
          field: 'body_md',
        });
      }
      sets.push('body_md = ?', 'body_html = ?');
      args.push(changes.body_md, renderMarkdown(changes.body_md));
    }
    if (current.kind === 'chronological') {
      if (changes.valid_from !== undefined) {
        sets.push('valid_from = ?');
        args.push(normaliseDate(changes.valid_from) ?? new Date().toISOString());
      }
      if (changes.valid_to !== undefined) {
        sets.push('valid_to = ?');
        args.push(normaliseDate(changes.valid_to) ?? null);
      }
    }

    const now = new Date().toISOString();
    sets.push('version = ?', 'updated_at = ?', 'updated_by = ?');
    args.push(current.version + 1, now, actorUserId);
    // S4 (13-layers.md §5.1): first edit in a working layer materialises a
    // shadow copy; the UPDATE targets the connection's layer row only.
    materializeShadow(ndb, 'comments', id);
    args.push(id, ndb.layerId);
    ndb
      .prepare(`UPDATE comments SET ${sets.join(', ')} WHERE id = ? AND layer_id = ?`)
      .run(...args);
    return getCommentOrThrow(ndb, id);
  });
}

/**
 * Delete a comment (docs/03-server-api.md §10) together with its m2m targets.
 *
 * S4 (13-layers.md §5.2): in a working layer the deletion materialises
 * tombstones for the comment and its visible targets instead of deleting
 * physically; the base rows stay intact.
 *
 * Throws `NOT_FOUND` (404) or `VERSION_CONFLICT` (409).
 */
export function deleteComment(
  ndb: NetworkDb,
  id: string,
  expectedVersion: number | undefined,
): void {
  ndb.transaction(() => {
    const current = getCommentOrThrow(ndb, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'comment version mismatch', {
        entity: 'comment',
        id,
        expected: expectedVersion,
        current: current.version,
      });
    }
    if (!isBaseContext(ndb)) {
      const targetIds = (
        ndb.prepare('SELECT id FROM comment_targets_v WHERE comment_id = ?').all(id) as {
          id: string;
        }[]
      ).map((r) => r.id);
      for (const targetId of targetIds) materializeTombstone(ndb, 'comment_targets', targetId);
      materializeTombstone(ndb, 'comments', id);
      return;
    }
    ndb.prepare('DELETE FROM comment_targets WHERE comment_id = ?').run(id);
    ndb.prepare('DELETE FROM comments WHERE id = ?').run(id);
  });
}

/**
 * Attach an existing chronological comment to one more owner (L20,
 * docs/03-server-api.md §10). The primary owner does not change.
 *
 * Throws `NOT_FOUND` (404, comment or owner), `VERSION_CONFLICT` (409),
 * `VALIDATION_ERROR` (422, permanent comment or invalid owner type) or
 * `DUPLICATE` (409, already attached).
 */
export function addCommentTarget(
  ndb: NetworkDb,
  commentId: string,
  ownerType: CommentOwnerType,
  ownerId: string,
  expectedVersion: number | undefined,
  actorUserId: string,
): Comment {
  const ot = validateOwnerType(ownerType);
  return ndb.transaction(() => {
    const current = getCommentOrThrow(ndb, commentId);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'comment version mismatch', {
        entity: 'comment',
        id: commentId,
        expected: expectedVersion,
        current: current.version,
      });
    }
    if (current.kind !== 'chronological') {
      throw new EtnError('VALIDATION_ERROR', 'a permanent comment has exactly one owner', {
        field: 'targets',
      });
    }
    ensureOwnerExists(ndb, ot, ownerId);
    const duplicate = ndb
      .prepare(
        'SELECT 1 FROM comment_targets_v WHERE comment_id = ? AND owner_type = ? AND owner_id = ? LIMIT 1',
      )
      .get(commentId, ot, ownerId);
    if (duplicate) {
      throw new EtnError('DUPLICATE', 'the comment is already attached to this owner', {
        owner_type: ot,
        owner_id: ownerId,
      });
    }
    ndb
      .prepare(
        'INSERT INTO comment_targets (comment_id, owner_type, owner_id, layer_id) VALUES (?, ?, ?, ?)',
      )
      .run(commentId, ot, ownerId, ndb.layerId);
    bumpVersion(ndb, commentId, current.version, actorUserId);
    return getCommentOrThrow(ndb, commentId);
  });
}

/**
 * Detach a chronological comment from one owner (L20, docs/03-server-api.md
 * §10). When the primary owner is detached, the primary moves to another
 * remaining target (the FTS triggers rebuild the index row). Detaching the
 * **last** target re-attaches the comment to the network HOME thought, so a
 * chronological comment is never left ownerless.
 *
 * Throws `NOT_FOUND` (404, comment or target), `VERSION_CONFLICT` (409) or
 * `VALIDATION_ERROR` (422, permanent comment).
 */
export function removeCommentTarget(
  ndb: NetworkDb,
  commentId: string,
  ownerType: CommentOwnerType,
  ownerId: string,
  expectedVersion: number | undefined,
  actorUserId: string,
): Comment {
  const ot = validateOwnerType(ownerType);
  return ndb.transaction(() => {
    const current = getCommentOrThrow(ndb, commentId);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new EtnError('VERSION_CONFLICT', 'comment version mismatch', {
        entity: 'comment',
        id: commentId,
        expected: expectedVersion,
        current: current.version,
      });
    }
    if (current.kind !== 'chronological') {
      throw new EtnError('VALIDATION_ERROR', 'a permanent comment has exactly one owner', {
        field: 'targets',
      });
    }
    // S4: the target rows resolved in this layer's chain go first — physically
    // in the base, as tombstones in a working layer (13-layers.md §5.2).
    const targetRows = ndb
      .prepare(
        'SELECT id FROM comment_targets_v WHERE comment_id = ? AND owner_type = ? AND owner_id = ?',
      )
      .all(commentId, ot, ownerId) as { id: string }[];
    for (const row of targetRows) {
      deleteRowLayered(ndb, 'comment_targets', row.id);
    }
    if (targetRows.length === 0) {
      throw new EtnError('NOT_FOUND', 'the comment is not attached to this owner', {
        owner_type: ot,
        owner_id: ownerId,
      });
    }

    const restRows = ndb
      .prepare(
        `SELECT owner_type, owner_id FROM comment_targets_v WHERE comment_id = ?
         ORDER BY owner_type ASC, owner_id ASC`,
      )
      .all(commentId) as Array<{ owner_type: string; owner_id: string }>;
    let rest: CommentTarget[] = restRows.map((r) => ({
      owner_type: r.owner_type as CommentOwnerType,
      owner_id: r.owner_id,
    }));
    if (rest.length === 0) {
      // Last target detached — fall back to the protected HOME thought.
      const home = ndb.prepare('SELECT id FROM thoughts_v WHERE is_root = 1 LIMIT 1').get() as
        | { id: string }
        | undefined;
      if (home === undefined) {
        throw new EtnError('INTERNAL', 'network has no HOME thought', {});
      }
      ndb
        .prepare(
          'INSERT INTO comment_targets (comment_id, owner_type, owner_id, layer_id) VALUES (?, ?, ?, ?)',
        )
        .run(commentId, 'thought', home.id, ndb.layerId);
      rest = [{ owner_type: 'thought', owner_id: home.id }];
    }

    const wasPrimary = current.owner_type === ot && current.owner_id === ownerId;
    const nextPrimary = rest[0];
    if (nextPrimary === undefined) {
      throw new EtnError('INTERNAL', 'comment has no remaining targets', {});
    }
    const now = new Date().toISOString();
    if (wasPrimary) {
      // S4: the primary move is an edit of the comment row — materialise the
      // shadow copy first, then update the connection's layer row only.
      materializeShadow(ndb, 'comments', commentId);
      ndb
        .prepare(
          `UPDATE comments SET owner_type = ?, owner_id = ?, version = ?, updated_at = ?, updated_by = ?
           WHERE id = ? AND layer_id = ?`,
        )
        .run(
          nextPrimary.owner_type,
          nextPrimary.owner_id,
          current.version + 1,
          now,
          actorUserId,
          commentId,
          ndb.layerId,
        );
    } else {
      bumpVersion(ndb, commentId, current.version, actorUserId);
    }
    return getCommentOrThrow(ndb, commentId);
  });
}

/** Bump `version`/`updated_at`/`updated_by` of a comment (its layer row). */
function bumpVersion(ndb: NetworkDb, commentId: string, currentVersion: number, actorUserId: string): void {
  const now = new Date().toISOString();
  materializeShadow(ndb, 'comments', commentId);
  ndb
    .prepare(
      'UPDATE comments SET version = ?, updated_at = ?, updated_by = ? WHERE id = ? AND layer_id = ?',
    )
    .run(currentVersion + 1, now, actorUserId, commentId, ndb.layerId);
}

/**
 * Normalise a date input to an ISO-8601 string. Accepts `Date`, an ISO string,
 * or a `YYYY-MM-DD` calendar date (stored verbatim to preserve the calendar
 * semantics of chronological comments). Empty/whitespace strings and `null`
 * yield `null`.
 */
function normaliseDate(value: string | null | undefined | Date): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
  }
  return value.toISOString();
}
