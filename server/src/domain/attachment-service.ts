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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  ATTACHMENT_KINDS,
  ATTACHMENT_OWNER_TYPES,
  buildLikePattern,
  EtnError,
  parseFilterKeywords,
  type Attachment,
  type AttachmentContent,
  type AttachmentContentUpdateInput,
  type AttachmentContentUpdateResult,
  type AttachmentCopyInput,
  type AttachmentCopyResult,
  type AttachmentFileInput,
  type AttachmentInput,
  type AttachmentKind,
  type AttachmentOwnerType,
  type AttachmentSearchQuery,
  type AttachmentUpdateInput,
} from '@etn/shared';

import { renderMarkdown } from '@etn/markdown';

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
  icon: string | null;
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
    icon: row.icon,
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
  // Reads go through the layer-resolving views (13-layers.md §4.2).
  const table = ownerType === 'thought' ? 'thoughts_v' : 'links_v';
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
  const row = ndb.prepare('SELECT * FROM attachments_v WHERE id = ? LIMIT 1').get(id) as
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
      'SELECT * FROM attachments_v WHERE owner_type = ? AND owner_id = ? ORDER BY position ASC, created_at ASC',
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

/** Maximum decoded size of an uploaded attachment file, 10 MiB. */
export const ATTACHMENT_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Extension by MIME type (for naming stored upload files). */
const UPLOAD_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/pdf': 'pdf',
};

/** Sanitizes a title into a safe file-name base (no path separators). */
function safeNameBase(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 60);
}

/**
 * Store an uploaded file and attach it (docs/03-server-api.md §11).
 *
 * The payload (base64) is decoded and written under the network's
 * `attachments/` directory — the same directory that hosts `data.db` — so the
 * stored copy lives and is backed up together with the database. The created
 * attachment is `kind='file'` with `file_path` pointing at the stored copy.
 *
 * Throws:
 *   * `VALIDATION_ERROR` (422) for a bad base64 payload, unknown/oversized
 *     content or a missing mime_type;
 *   * `NOT_FOUND` (404) if the owner does not exist.
 */
export function createAttachmentFile(
  ndb: NetworkDb,
  ownerType: AttachmentOwnerType,
  ownerId: string,
  input: AttachmentFileInput,
  actorUserId: string,
): Attachment {
  const ot = validateOwnerType(ownerType);
  const mime = input.mime_type.trim().toLowerCase();
  if (mime === '') {
    throw new EtnError('VALIDATION_ERROR', 'mime_type is required', { field: 'mime_type' });
  }
  const b64 = input.data_base64.replace(/^data:[^,]*,/, '').trim();
  if (b64 === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new EtnError('VALIDATION_ERROR', 'data_base64 must be base64 content', {
      field: 'data_base64',
    });
  }
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((b64.length * 3) / 4) - padding;
  if (bytes <= 0 || bytes > ATTACHMENT_FILE_MAX_BYTES) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `file exceeds the ${ATTACHMENT_FILE_MAX_BYTES} byte limit (${bytes})`,
      { field: 'data_base64', limit: ATTACHMENT_FILE_MAX_BYTES },
    );
  }
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length !== bytes) {
    throw new EtnError('VALIDATION_ERROR', 'data_base64 is not valid base64', {
      field: 'data_base64',
    });
  }

  // Ensure the owner exists before touching the filesystem.
  ensureOwnerExists(ndb, ot, ownerId);

  const dir = path.join(path.dirname(ndb.dbPath), 'attachments');
  mkdirSync(dir, { recursive: true });
  const ext = UPLOAD_MIME_EXT[mime] ?? (mime.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/g, '');
  const stamp = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const base = safeNameBase(nullable(input.title ?? null) ?? 'file');
  const name = `${base === '' ? 'file' : base}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}-${randomUUID().slice(0, 4)}.${ext}`;
  const filePath = path.join(dir, name);
  writeFileSync(filePath, buffer);

  return createAttachment(
    ndb,
    ot,
    ownerId,
    {
      kind: 'file',
      file_path: filePath,
      file_size: buffer.length,
      mime_type: mime,
      title: nullable(input.title ?? null),
    },
    actorUserId,
  );
}

/**
 * Copy an attachment to one or more target owners (03-server-api.md §11,
 * workplan L25). Each target gets a brand-new row carrying the same visible
 * fields as the source (`kind`/`url`/`file_path`/`mime_type`/`title`/
 * `description`/`icon`/`file_size`); the underlying file is **not** duplicated —
 * a `kind='file'` row simply references the same `file_path`, so the server's
 * existing rule "file is removed only when nobody uses it" (deleteAttachment,
 * L16 icon cleanup) applies without change.
 *
 * Targets that already own an attachment with the same `kind` and the same
 * `url`/`file_path` are skipped silently and reported via `skipped`.
 *
 * Throws:
 *   * `NOT_FOUND` (404) if the source attachment does not exist;
 *   * `VALIDATION_ERROR` (422) if any target owner id does not exist.
 *
 * The whole batch runs in a single transaction — either every new row is
 * inserted or none are.
 *
 * @param actorUserId - user creating the copies (recorded as `created_by`).
 */
export function copyAttachment(
  ndb: NetworkDb,
  sourceId: string,
  input: AttachmentCopyInput,
  actorUserId: string,
): AttachmentCopyResult {
  const targetOwnerType = validateOwnerType(input.target_owner_type);
  // Link owners are intentionally not supported yet: the workplan task scope is
  // "copy attachment to other thoughts". When support is added, the route
  // handler will switch to validateOwnerType unconditionally.
  if (targetOwnerType !== 'thought') {
    throw new EtnError('VALIDATION_ERROR', 'target_owner_type must be "thought"', {
      field: 'target_owner_type',
    });
  }
  const targetIds = Array.from(new Set(input.target_owner_ids));
  if (targetIds.length === 0) {
    return { created: [], skipped: [] };
  }
  return ndb.transaction(() => {
    const source = getAttachmentOrThrow(ndb, sourceId);
    // All targets must exist before any row is written — 422 names the first
    // missing id so the client can show a precise error.
    const placeholders = targetIds.map(() => '?').join(', ');
    const existingThoughtIds = new Set(
      (
        ndb
          .prepare(`SELECT id FROM thoughts_v WHERE id IN (${placeholders})`)
          .all(...targetIds) as { id: string }[]
      ).map((r) => r.id),
    );
    for (const id of targetIds) {
      if (!existingThoughtIds.has(id)) {
        throw new EtnError('VALIDATION_ERROR', `thought ${id} not found`, {
          field: 'target_owner_ids',
          missing: id,
        });
      }
    }
    // Detect duplicates in one pass: same owner + same kind + same url/file_path.
    // The url/file_path leg is split by kind to keep NULL-handling clean in SQL.
    const dupRows = ndb
      .prepare(
        `SELECT owner_id FROM attachments_v
         WHERE owner_type = ? AND kind = ? AND owner_id IN (${placeholders})
           AND ((? IS NOT NULL AND url = ?) OR (? IS NULL AND file_path = ?))`,
      )
      .all(
        targetOwnerType,
        source.kind,
        ...targetIds,
        source.url,
        source.url,
        source.file_path,
        source.file_path,
      ) as { owner_id: string }[];
    const duplicateIds = new Set(dupRows.map((r) => r.owner_id));

    const now = new Date().toISOString();
    const created: Attachment[] = [];
    const skipped: string[] = [];
    const insertStmt = ndb.prepare(
      `INSERT INTO attachments (id, owner_type, owner_id, kind, url, file_path,
                               file_size, mime_type, title, description, icon,
                               position, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectById = ndb.prepare('SELECT * FROM attachments_v WHERE id = ? LIMIT 1');
    for (const targetId of targetIds) {
      if (duplicateIds.has(targetId)) {
        skipped.push(targetId);
        continue;
      }
      const newId = randomUUID();
      insertStmt.run(
        newId,
        targetOwnerType,
        targetId,
        source.kind,
        source.kind === 'url' ? source.url : null,
        source.kind === 'file' ? source.file_path : null,
        source.file_size,
        source.mime_type,
        source.title,
        source.description,
        source.icon,
        0,
        now,
        actorUserId,
      );
      const row = selectById.get(newId) as AttachmentRow | undefined;
      if (row !== undefined) created.push(rowToAttachment(row));
    }
    return { created, skipped };
  });
}

/**
 * Search attachments across the whole network by keywords (03-server-api.md §11,
 * workplan L25). `q` is required and uses the same mini-syntax as the thought
 * search (§6.10): AND of include-words, `-word` exclusion, `*` infix wildcard;
 * every include word must match somewhere in the union of `title`,
 * `description`, `url`, `file_path` (case-insensitive LIKE).
 *
 * Used by the editor's «Найти существующее» dialog tab to suggest attachments
 * the user can reuse instead of uploading a fresh copy. The `exclude_owner_*`
 * pair hides rows that already belong to the active owner.
 *
 * No FTS index exists on `attachments`; the search runs as parameterised LIKE.
 * Result order is `created_at DESC` (most recent first).
 */
export function searchAttachments(
  ndb: NetworkDb,
  query: AttachmentSearchQuery,
): { items: Attachment[]; total: number } {
  const keywords = parseFilterKeywords(query.q ?? '');
  if (keywords.include.length === 0) {
    return { items: [], total: 0 };
  }
  const limit = typeof query.limit === 'number' ? Math.max(0, Math.min(200, Math.trunc(query.limit))) : 50;
  const offset = typeof query.offset === 'number' ? Math.max(0, Math.trunc(query.offset)) : 0;

  const where: string[] = [];
  const params: unknown[] = [];
  const fieldConcat =
    "LOWER(COALESCE(title, '') || '\n' || COALESCE(description, '') || '\n' || COALESCE(url, '') || '\n' || COALESCE(file_path, ''))";
  for (const word of keywords.include) {
    const pattern = buildLikePattern(word).toLowerCase();
    where.push(`${fieldConcat} LIKE ? ESCAPE '\\'`);
    params.push(pattern);
  }
  for (const word of keywords.exclude) {
    const pattern = buildLikePattern(word).toLowerCase();
    where.push(`${fieldConcat} NOT LIKE ? ESCAPE '\\'`);
    params.push(pattern);
  }
  if (query.kind !== undefined) {
    where.push('kind = ?');
    params.push(query.kind);
  }
  if (query.exclude_owner_type !== undefined && query.exclude_owner_id !== undefined) {
    where.push('NOT (owner_type = ? AND owner_id = ?)');
    params.push(query.exclude_owner_type, query.exclude_owner_id);
  }

  const whereSql = where.join(' AND ');
  const totalRow = ndb
    .prepare(`SELECT COUNT(*) AS n FROM attachments_v WHERE ${whereSql}`)
    .get(...params) as { n: number };
  const rows = ndb
    .prepare(
      `SELECT * FROM attachments_v WHERE ${whereSql}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as AttachmentRow[];
  return { items: rows.map(rowToAttachment), total: totalRow.n };
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
    if (changes.icon !== undefined) {
      const icon = nullable(changes.icon);
      if (icon !== null && !icon.startsWith('data:')) {
        throw new EtnError('VALIDATION_ERROR', 'icon must be a data: URL', {
          field: 'icon',
        });
      }
      sets.push('icon = ?');
      args.push(icon);
    }
    // Moving the attachment to another owner: both fields must describe the
    // target consistently; the new owner must exist (no SQL FK on the table).
    let moved = false;
    if (changes.owner_type !== undefined || changes.owner_id !== undefined) {
      const nextType =
        changes.owner_type !== undefined
          ? validateOwnerType(changes.owner_type)
          : current.owner_type;
      const nextId =
        changes.owner_id !== undefined ? nullable(changes.owner_id) : current.owner_id;
      if (nextId === null) {
        throw new EtnError('VALIDATION_ERROR', 'owner_id cannot be empty', {
          field: 'owner_id',
        });
      }
      if (nextType !== current.owner_type || nextId !== current.owner_id) {
        ensureOwnerExists(ndb, nextType, nextId);
        sets.push('owner_type = ?', 'owner_id = ?');
        args.push(nextType, nextId);
        moved = true;
      }
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
    // An owner move orphans any thought icon backed by this attachment (L16) —
    // drop the dangling reference; the icon preview itself stays.
    if (moved) {
      ndb
        .prepare('UPDATE thoughts SET icon_attachment_id = NULL WHERE icon_attachment_id = ?')
        .run(id);
    }
    return getAttachmentOrThrow(ndb, id);
  });
}

/**
 * Best-effort removal of a server-stored upload: only `kind='file'` rows whose
 * `file_path` points **inside the network's `attachments/` directory** are
 * deleted from disk. Client-local paths (drag-and-drop of OS files keeps them
 * on the user's machine) are never touched.
 */
export function removeStoredFile(
  ndb: NetworkDb,
  kind: AttachmentKind,
  filePath: string | null,
): void {
  if (kind !== 'file' || filePath === null) return;
  const storedDir = path.resolve(path.dirname(ndb.dbPath), 'attachments');
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(storedDir + path.sep) && existsSync(resolved)) {
    try {
      rmSync(resolved);
    } catch {
      // File cleanup is best-effort; callers delete the row regardless.
    }
  }
}

/**
 * True when a live attachment row still resolves to the same stored file.
 * Callers run this AFTER deleting the row(s) they are purging, so every row
 * left in the table is a real remaining user of the file.
 */
export function storedFileInUse(ndb: NetworkDb, resolvedPath: string): boolean {
  // layers:physical-read — файл один на все слои (13-layers.md §5.3): его судьбу
  // решают привязки ВСЕХ слоёв, а не только разрешённые в текущем контексте.
  const rows = ndb
    .prepare("SELECT file_path FROM attachments WHERE kind = 'file' AND file_path IS NOT NULL") // layers:physical-read
    .all() as { file_path: string }[];
  return rows.some((row) => path.resolve(row.file_path) === resolvedPath);
}

/**
 * Delete an attachment (docs/03-server-api.md §11). Throws `NOT_FOUND` (404).
 *
 * When the attachment is `kind='file'` and its `file_path` points **inside the
 * network's `attachments/` directory** (a server-stored upload), the stored
 * file is removed together with the row (see {@link removeStoredFile}) — but
 * only when nothing else uses it: another attachment resolving to the same
 * file keeps it (a second reference is possible via `PATCH …/file_path`), and
 * so does a thought icon backed by this attachment (`icon_attachment_id`,
 * Ctrl-hover reads the full picture from the file). Otherwise only the row is
 * deleted and the file stays.
 */
export function deleteAttachment(ndb: NetworkDb, id: string): void {
  ndb.transaction(() => {
    const current = getAttachmentOrThrow(ndb, id);
    // Check the icon reference BEFORE it is reset below — the file must
    // outlive the row for the icon's full picture (L16).
    // layers:physical-read — файл один на все слои (13-layers.md §5.3): иконка в любом слое удерживает его.
    const iconBacksFile =
      current.kind === 'file' &&
      ndb.prepare('SELECT 1 FROM thoughts WHERE icon_attachment_id = ? LIMIT 1').get(id) !== // layers:physical-read
      undefined;
    ndb.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    // Thoughts may reference this attachment as the backing picture of their
    // icon (L16) — drop the dangling reference; the icon preview itself stays.
    ndb
      .prepare('UPDATE thoughts SET icon_attachment_id = NULL WHERE icon_attachment_id = ?')
      .run(id);
    const keepFile =
      iconBacksFile ||
      (current.kind === 'file' &&
        current.file_path !== null &&
        storedFileInUse(ndb, path.resolve(current.file_path)));
    if (!keepFile) removeStoredFile(ndb, current.kind, current.file_path);
  });
}

// ---------------------------------------------------------------------------
// Text content of file attachments (built-in viewer/editor, L7,
// docs/03-server-api.md §11)
// ---------------------------------------------------------------------------

/** Hard cap on the text returned by `GET …/content` (matches the client). */
const CONTENT_TEXT_MAX_CHARS = 200_000;

/**
 * True when the attachment is a `kind='file'` whose content is text-like:
 * `text/*` mime or a `.txt`/`.md`/`.markdown` path. Mirrors the client-side
 * `isViewableText` check (attachments.ts).
 */
function isTextLikeFile(a: Attachment): boolean {
  if (a.kind !== 'file' || a.file_path === null) return false;
  if ((a.mime_type ?? '').startsWith('text/')) return true;
  return /\.(txt|md|markdown)$/i.test(a.file_path);
}

/** True for markdown files (server-rendered `html` in the content response). */
function isMarkdownFile(a: Attachment): boolean {
  const mime = (a.mime_type ?? '').toLowerCase();
  if (mime === 'text/markdown' || mime === 'text/md') return true;
  return /\.(md|markdown)$/i.test(a.file_path ?? '');
}

/**
 * Read the content of a text-like attachment (docs/03-server-api.md §11):
 * the text (truncated at {@link CONTENT_TEXT_MAX_CHARS}) and, for markdown
 * files, the server-rendered html. Non-text attachments return `text: null`.
 *
 * Throws `NOT_FOUND` (404) for a missing attachment and `VALIDATION_ERROR`
 * (422) when the backing file cannot be read.
 */
export function getAttachmentContent(ndb: NetworkDb, id: string): AttachmentContent {
  const a = getAttachmentOrThrow(ndb, id);
  if (!isTextLikeFile(a)) {
    return { mime_type: a.mime_type, text: null, html: null, truncated: false };
  }
  let raw: string;
  try {
    raw = readFileSync(a.file_path!, 'utf8');
  } catch {
    throw new EtnError('VALIDATION_ERROR', 'файл вложения недоступен для чтения', {
      field: 'file_path',
    });
  }
  const truncated = raw.length > CONTENT_TEXT_MAX_CHARS;
  const text = truncated ? raw.slice(0, CONTENT_TEXT_MAX_CHARS) : raw;
  const html = isMarkdownFile(a) ? renderMarkdown(text) : null;
  return { mime_type: a.mime_type, text, html, truncated };
}

/**
 * A server-stored attachment file served as raw bytes (remote clients).
 * `filename` is the base name of the stored copy; `mime_type` falls back to
 * `application/octet-stream` when the row carries no hint.
 */
export interface AttachmentRawFile {
  mime_type: string;
  filename: string;
  body: Buffer;
}

/**
 * Read the raw bytes of a server-stored attachment file by its absolute
 * `file_path` (the path the `etnimg:` scheme of a remote client resolves to).
 *
 * Only files stored **inside the network's `attachments/` directory** (uploads
 * of `POST …/attachments/file`, the same rule as {@link removeStoredFile}) are
 * served: a `file_path` pointing elsewhere belongs to some client's local disk
 * and must not be exposed through the API.
 *
 * Throws `NOT_FOUND` (404) when no `kind='file'` attachment resolves to the
 * path, the path is outside the stored-files directory or the backing file is
 * missing; `VALIDATION_ERROR` (422) when it cannot be read.
 */
export function getAttachmentRawByPath(ndb: NetworkDb, filePath: string): AttachmentRawFile {
  const resolved = path.resolve(filePath);
  const storedDir = path.resolve(path.dirname(ndb.dbPath), 'attachments');
  if (!resolved.startsWith(storedDir + path.sep)) {
    throw new EtnError('NOT_FOUND', 'файл вложения не найден', { field: 'path' });
  }
  const rows = ndb
    .prepare("SELECT mime_type, file_path FROM attachments_v WHERE kind = 'file' AND file_path IS NOT NULL")
    .all() as { mime_type: string | null; file_path: string }[];
  const row = rows.find((r) => path.resolve(r.file_path) === resolved);
  if (row === undefined) {
    throw new EtnError('NOT_FOUND', 'файл вложения не найден', { field: 'path' });
  }
  let body: Buffer;
  try {
    body = readFileSync(resolved);
  } catch {
    throw new EtnError('VALIDATION_ERROR', 'файл вложения недоступен для чтения', {
      field: 'path',
    });
  }
  return {
    mime_type: row.mime_type ?? 'application/octet-stream',
    filename: path.basename(resolved),
    body,
  };
}

/**
 * Overwrite the file of a text-like attachment (docs/03-server-api.md §11).
 * Decodes `data_base64` (≤10 MiB), writes it to `file_path` and refreshes
 * `file_size`/`mime_type` in the row. Last-write-wins (no version column).
 *
 * Throws `NOT_FOUND` (404), `VALIDATION_ERROR` (422) for a non-text
 * attachment, a bad payload or an unwritable file.
 */
export function updateAttachmentContent(
  ndb: NetworkDb,
  id: string,
  input: AttachmentContentUpdateInput,
): AttachmentContentUpdateResult {
  return ndb.transaction(() => {
    const current = getAttachmentOrThrow(ndb, id);
    if (!isTextLikeFile(current)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'контент доступен только для текстовых вложений',
        { field: 'id' },
      );
    }

    const b64 = input.data_base64.replace(/^data:[^,]*,/, '').trim();
    if (b64 === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      throw new EtnError('VALIDATION_ERROR', 'data_base64 must be base64 content', {
        field: 'data_base64',
      });
    }
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    const bytes = Math.floor((b64.length * 3) / 4) - padding;
    if (bytes < 0 || bytes > ATTACHMENT_FILE_MAX_BYTES) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `file exceeds the ${ATTACHMENT_FILE_MAX_BYTES} byte limit (${bytes})`,
        { field: 'data_base64', limit: ATTACHMENT_FILE_MAX_BYTES },
      );
    }
    const buffer = Buffer.from(b64, 'base64');
    if (buffer.length !== bytes) {
      throw new EtnError('VALIDATION_ERROR', 'data_base64 is not valid base64', {
        field: 'data_base64',
      });
    }

    try {
      writeFileSync(current.file_path!, buffer);
    } catch {
      throw new EtnError('VALIDATION_ERROR', 'не удалось записать файл вложения', {
        field: 'file_path',
      });
    }

    const nextMime =
      input.mime_type !== undefined && input.mime_type.trim() !== ''
        ? input.mime_type.trim().toLowerCase()
        : current.mime_type;
    ndb
      .prepare('UPDATE attachments SET file_size = ?, mime_type = ? WHERE id = ?')
      .run(buffer.length, nextMime, id);

    const text = buffer.toString('utf8');
    const html = isMarkdownFile({ ...current, mime_type: nextMime })
      ? renderMarkdown(text)
      : null;
    return { html };
  });
}

// ---------------------------------------------------------------------------
// URL enrichment (title + favicon), workplan L1
// ---------------------------------------------------------------------------

/** Fetch timeout for page/icon requests. */
const ENRICH_TIMEOUT_MS = 4000;
/** Max bytes of HTML read for title/favicon extraction. */
const ENRICH_HTML_MAX_BYTES = 512 * 1024;
/** Max favicon bytes stored as a `data:` URL. */
const FAVICON_MAX_BYTES = 64 * 1024;

/** Extract `<title>` text from an HTML document (null when absent/empty). */
export function extractHtmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null || match[1] === undefined) return null;
  const decoded = match[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return decoded === '' ? null : decoded.slice(0, 300);
}

/**
 * Resolve the favicon URL declared by `link rel=…icon…` elements, falling back
 * to `/favicon.ico` at the site root. Returns an absolute URL or null.
 */
export function extractFaviconUrl(html: string, baseUrl: string): string | null {
  const attr = (tag: string, name: string): string => {
    const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    return (m?.[2] ?? m?.[3] ?? m?.[4] ?? '').trim();
  };
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attr(tag, 'rel').toLowerCase();
    const relOk = rel
      .split(/\s+/)
      .some((r) => r === 'icon' || r === 'shortcut' || r === 'apple-touch-icon');
    if (!relOk) continue;
    const href = attr(tag, 'href');
    if (href === '') continue;
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      // malformed href — try the next link tag
    }
  }
  try {
    return new URL('/favicon.ico', baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Best-effort enrichment of a URL attachment (03-server-api.md §11): fetch the
 * page, fill the missing `title` from `<title>` and store the site favicon as
 * a `data:` URL in `icon`. Network failures are silently ignored — the
 * attachment stays as created.
 */
export async function enrichUrlAttachment(
  ndb: NetworkDb,
  attachment: Attachment,
  fetchImpl: typeof fetch = fetch,
): Promise<Attachment> {
  if (attachment.kind !== 'url' || attachment.url === null) return attachment;
  const changes: { title?: string; icon?: string | null } = {};
  try {
    const res = await fetchImpl(attachment.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
      headers: { 'user-agent': 'ETN-attachment-enricher' },
    });
    if (res.ok && (res.headers.get('content-type') ?? '').includes('text/html')) {
      const html = (await res.text()).slice(0, ENRICH_HTML_MAX_BYTES);
      if (attachment.title === null) {
        const title = extractHtmlTitle(html);
        if (title !== null) changes.title = title;
      }
      const iconUrl = extractFaviconUrl(html, attachment.url);
      if (iconUrl !== null) {
        const icon = await fetchFavicon(fetchImpl, iconUrl);
        if (icon !== null) changes.icon = icon;
      }
    }
  } catch {
    return attachment;
  }
  if (changes.title === undefined && changes.icon === undefined) return attachment;
  try {
    return updateAttachment(ndb, attachment.id, changes);
  } catch {
    return attachment;
  }
}

/** Fetch a favicon and encode it as a `data:` URL (null when unusable). */
async function fetchFavicon(fetchImpl: typeof fetch, url: string): Promise<string | null> {
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
      headers: { 'user-agent': 'ETN-attachment-enricher' },
    });
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!mime.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > FAVICON_MAX_BYTES) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}
