/**
 * Comment domain service (task C7, docs/03-server-api.md §10,
 * docs/02-data-model.md §3.8).
 *
 * Comments are polymorphic: they attach to a thought or a link (`owner_type` +
 * `owner_id`, no SQL FK). Two kinds exist:
 *   * `permanent` — at most **one** per owner (enforced by the partial unique
 *     index `idx_comments_permanent_one`); `valid_from = created_at`,
 *     `valid_to = NULL`.
 *   * `chronological` — unrestricted count; carries `valid_from`/`valid_to`.
 *
 * The server renders and caches `body_html` from `body_md` via the safe
 * {@link renderMarkdown} renderer. Mutating calls accept an optional
 * `expectedVersion` for the `If-Match` optimistic-concurrency contract.
 */

import { randomUUID } from 'node:crypto';

import {
  COMMENT_KINDS,
  COMMENT_OWNER_TYPES,
  EtnError,
  type Comment,
  type CommentInput,
  type CommentKind,
  type CommentOwnerType,
  type CommentUpdateInput,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { renderMarkdown } from './markdown.js';

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

/** Convert a raw row into a {@link Comment}. */
function rowToComment(row: CommentRow): Comment {
  return {
    id: row.id,
    owner_type: row.owner_type as CommentOwnerType,
    owner_id: row.owner_id,
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
 * prevents orphaned comments and gives the caller a precise 404.
 */
function ensureOwnerExists(ndb: NetworkDb, ownerType: CommentOwnerType, ownerId: string): void {
  const table = ownerType === 'thought' ? 'thoughts' : 'links';
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
  const row = ndb.prepare('SELECT * FROM comments WHERE id = ? LIMIT 1').get(id) as
    CommentRow | undefined;
  return row ? rowToComment(row) : null;
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
 * List comments attached to an owner (docs/03-server-api.md §10). The permanent
 * comment (if any) sorts first, then chronological comments ordered by
 * `valid_from` ascending.
 */
export function listComments(
  ndb: NetworkDb,
  ownerType: CommentOwnerType,
  ownerId: string,
): Comment[] {
  validateOwnerType(ownerType);
  const rows = ndb
    .prepare(
      `SELECT * FROM comments
       WHERE owner_type = ? AND owner_id = ?
       ORDER BY (kind <> 'permanent'), valid_from ASC, created_at ASC`,
    )
    .all(ownerType, ownerId) as CommentRow[];
  return rows.map(rowToComment);
}

/**
 * Create a comment (docs/03-server-api.md §10).
 *
 * Throws:
 *   * `VALIDATION_ERROR` (422) for an invalid kind/owner or empty body;
 *   * `NOT_FOUND` (404) if the owner does not exist;
 *   * `DUPLICATE` (409) on a second `permanent` comment for the same owner.
 *
 * For `kind = 'permanent'` the `valid_from`/`valid_to` inputs are ignored
 * (`valid_from` becomes `created_at`, `valid_to` is `NULL`). For chronological
 * comments `valid_from` defaults to now and `valid_to` defaults to `null`
 * (open-ended); an explicit empty string is normalised to `null`.
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
  const ot = validateOwnerType(ownerType);
  const kind = validateKind(input.kind);
  if (typeof input.body_md !== 'string' || input.body_md === '') {
    throw new EtnError('VALIDATION_ERROR', 'body_md must be a non-empty string', {
      field: 'body_md',
    });
  }
  const bodyHtml = renderMarkdown(input.body_md);

  return ndb.transaction(() => {
    ensureOwnerExists(ndb, ot, ownerId);

    if (kind === 'permanent') {
      // Enforce the "one permanent per owner" invariant ahead of the unique
      // index so we can raise the canonical DUPLICATE error explicitly.
      const existing = ndb
        .prepare(
          `SELECT 1 FROM comments
           WHERE owner_type = ? AND owner_id = ? AND kind = 'permanent' LIMIT 1`,
        )
        .get(ot, ownerId);
      if (existing) {
        throw new EtnError('DUPLICATE', 'a permanent comment already exists for this owner', {
          owner_type: ot,
          owner_id: ownerId,
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
        `INSERT INTO comments (id, owner_type, owner_id, kind, title, body_md, body_html,
                               valid_from, valid_to, version,
                               created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ot,
        ownerId,
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
    args.push(id);
    ndb.prepare(`UPDATE comments SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return getCommentOrThrow(ndb, id);
  });
}

/**
 * Delete a comment (docs/03-server-api.md §10).
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
    ndb.prepare('DELETE FROM comments WHERE id = ?').run(id);
  });
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
