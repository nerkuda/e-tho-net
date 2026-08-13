/**
 * Attachment domain service (task C8, docs/03-server-api.md §11,
 * docs/02-data-model.md §3.9).
 *
 * Attachments are polymorphic (`owner_type` + `owner_id`, no SQL FK) and come in
 * two kinds:
 *   * `url` — stores a URL (`url` column populated);
 *   * `file` — stores a path in the user's OS (`file_path` populated); on MVP the
 *     binary is **not** uploaded to the server.
 *
 * `mime_type`/`file_size` are optional hints supplied by the client. The
 * `attachments` table has no `version` column, so updates are last-write-wins
 * without an `If-Match` guard (unlike thoughts/links/comments).
 */

import { randomUUID } from 'node:crypto';

import {
  ATTACHMENT_KINDS,
  ATTACHMENT_OWNER_TYPES,
  EtnError,
  type Attachment,
  type AttachmentInput,
  type AttachmentKind,
  type AttachmentOwnerType,
  type AttachmentUpdateInput,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/** Raw `attachments` row shape. */
interface AttachmentRow {
  id: string;
  owner_type: string;
  owner_id: string;
  kind: string;
  url: string | null;
  file_path: string | null;
  file_size: number | null;
  mime_type: string | null;
  title: string | null;
  description: string | null;
  position: number;
  created_at: string;
  created_by: string;
}

/** Convert a raw row into an {@link Attachment}. */
function rowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    owner_type: row.owner_type as AttachmentOwnerType,
    owner_id: row.owner_id,
    kind: row.kind as AttachmentKind,
    url: row.url,
    file_path: row.file_path,
    file_size: row.file_size,
    mime_type: row.mime_type,
    title: row.title,
    description: row.description,
    position: row.position,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

/** Validate an attachment kind against the enum tuple. */
function validateKind(kind: unknown): AttachmentKind {
  if (typeof kind !== 'string' || !(ATTACHMENT_KINDS as readonly string[]).includes(kind)) {
    throw new EtnError('VALIDATION_ERROR', `invalid attachment kind: ${String(kind)}`, {
      field: 'kind',
      allowed: ATTACHMENT_KINDS,
    });
  }
  return kind as AttachmentKind;
}

/** Validate a polymorphic owner type against the enum tuple. */
function validateOwnerType(ownerType: unknown): AttachmentOwnerType {
  if (
    typeof ownerType !== 'string' ||
    !(ATTACHMENT_OWNER_TYPES as readonly string[]).includes(ownerType)
  ) {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${String(ownerType)}`, {
      field: 'owner_type',
      allowed: ATTACHMENT_OWNER_TYPES,
    });
  }
  return ownerType as AttachmentOwnerType;
}

/**
 * Ensure the polymorphic owner exists. Attachments have no SQL FK, so this guard
 * prevents orphaned rows and gives the caller a precise 404.
 */
function ensureOwnerExists(ndb: NetworkDb, ownerType: AttachmentOwnerType, ownerId: string): void {
  const table = ownerType === 'thought' ? 'thoughts' : 'links';
  const row = ndb.prepare(`SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`).get(ownerId);
  if (!row) {
    throw new EtnError('NOT_FOUND', `${ownerType} ${ownerId} not found`, {
      entity: ownerType,
      id: ownerId,
    });
  }
}

/** Coerce a string-or-null field: empty string → null. */
function nullable(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : value;
}

/** Return an attachment by id, or `null` when absent. */
export function getAttachment(ndb: NetworkDb, id: string): Attachment | null {
  const row = ndb.prepare('SELECT * FROM attachments WHERE id = ? LIMIT 1').get(id) as
    AttachmentRow | undefined;
  return row ? rowToAttachment(row) : null;
}

/** Return an attachment or throw `NOT_FOUND` (404). */
function getAttachmentOrThrow(ndb: NetworkDb, id: string): Attachment {
  const a = getAttachment(ndb, id);
  if (!a) {
    throw new EtnError('NOT_FOUND', `attachment ${id} not found`, { entity: 'attachment', id });
  }
  return a;
}

/**
 * List attachments attached to an owner (docs/03-server-api.md §11), ordered by
 * display position then creation time.
 */
export function listAttachments(
  ndb: NetworkDb,
  ownerType: AttachmentOwnerType,
  ownerId: string,
): Attachment[] {
  validateOwnerType(ownerType);
  const rows = ndb
    .prepare(
      'SELECT * FROM attachments WHERE owner_type = ? AND owner_id = ? ORDER BY position ASC, created_at ASC',
    )
    .all(ownerType, ownerId) as AttachmentRow[];
  return rows.map(rowToAttachment);
}

/**
 * Create an attachment (docs/03-server-api.md §11).
 *
 * Throws:
 *   * `VALIDATION_ERROR` (422) for an invalid kind/owner or when the required
 *     location field (`url` for `kind='url'`, `file_path` for `kind='file'`) is
 *     missing;
 *   * `NOT_FOUND` (404) if the owner does not exist.
 *
 * @param actorUserId - user creating the attachment (recorded as created_by).
 */
export function createAttachment(
  ndb: NetworkDb,
  ownerType: AttachmentOwnerType,
  ownerId: string,
  input: AttachmentInput,
  actorUserId: string,
): Attachment {
  const ot = validateOwnerType(ownerType);
  const kind = validateKind(input.kind);
  const url = nullable(input.url ?? null);
  const filePath = nullable(input.file_path ?? null);
  if (kind === 'url') {
    if (url === null) {
      throw new EtnError('VALIDATION_ERROR', "kind='url' requires a non-empty url", {
        field: 'url',
      });
    }
  } else if (filePath === null) {
    throw new EtnError('VALIDATION_ERROR', "kind='file' requires a non-empty file_path", {
      field: 'file_path',
    });
  }

  return ndb.transaction(() => {
    ensureOwnerExists(ndb, ot, ownerId);
    const id = randomUUID();
    const now = new Date().toISOString();
    const position = typeof input.position === 'number' ? Math.trunc(input.position) : 0;
    ndb
      .prepare(
        `INSERT INTO attachments (id, owner_type, owner_id, kind, url, file_path,
                                  file_size, mime_type, title, description, position,
                                  created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ot,
        ownerId,
        kind,
        kind === 'url' ? url : null,
        kind === 'file' ? filePath : null,
        input.file_size ?? null,
        nullable(input.mime_type ?? null),
        nullable(input.title ?? null),
        nullable(input.description ?? null),
        position,
        now,
        actorUserId,
      );
    return getAttachmentOrThrow(ndb, id);
  });
}

/**
 * Patch an attachment (docs/03-server-api.md §11). Last-write-wins per field;
 * the row has no `version` column so there is no `If-Match` guard. The kind is
 * immutable after creation.
 *
 * Throws `NOT_FOUND` (404) or `VALIDATION_ERROR` (422) when clearing the
 * location field of the current kind.
 */
export function updateAttachment(
  ndb: NetworkDb,
  id: string,
  changes: AttachmentUpdateInput,
  actorUserId?: string,
): Attachment {
  return ndb.transaction(() => {
    const current = getAttachmentOrThrow(ndb, id);

    const sets: string[] = [];
    const args: unknown[] = [];
    if (changes.url !== undefined) {
      const url = nullable(changes.url);
      if (current.kind === 'url' && url === null) {
        throw new EtnError('VALIDATION_ERROR', "url cannot be empty for kind='url'", {
          field: 'url',
        });
      }
      sets.push('url = ?');
      args.push(url);
    }
    if (changes.file_path !== undefined) {
      const fp = nullable(changes.file_path);
      if (current.kind === 'file' && fp === null) {
        throw new EtnError('VALIDATION_ERROR', "file_path cannot be empty for kind='file'", {
          field: 'file_path',
        });
      }
      sets.push('file_path = ?');
      args.push(fp);
    }
    if (changes.file_size !== undefined) {
      sets.push('file_size = ?');
      args.push(changes.file_size);
    }
    if (changes.mime_type !== undefined) {
      sets.push('mime_type = ?');
      args.push(nullable(changes.mime_type));
    }
    if (changes.title !== undefined) {
      sets.push('title = ?');
      args.push(nullable(changes.title));
    }
    if (changes.description !== undefined) {
      sets.push('description = ?');
      args.push(nullable(changes.description));
    }
    if (changes.position !== undefined) {
      sets.push('position = ?');
      args.push(Math.trunc(changes.position));
    }
    // `created_by`/`updated_by` are not part of the schema (no updated_by column);
    // actorUserId is accepted for API symmetry but not persisted here.
    void actorUserId;

    if (sets.length === 0) {
      return current;
    }
    args.push(id);
    ndb.prepare(`UPDATE attachments SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return getAttachmentOrThrow(ndb, id);
  });
}

/**
 * Delete an attachment (docs/03-server-api.md §11). Throws `NOT_FOUND` (404).
 */
export function deleteAttachment(ndb: NetworkDb, id: string): void {
  ndb.transaction(() => {
    getAttachmentOrThrow(ndb, id);
    ndb.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  });
}
