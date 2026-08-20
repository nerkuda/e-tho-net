/**
 * Cascade cleanup of polymorphic dependants when their owner disappears
 * (docs/03-server-api.md §6.5, §7.1, §10.1, §11; docs/02-data-model.md §3.5,
 * §3.8, §3.9).
 *
 * `comments`, `attachments` and `property_values` reference their owner as a
 * polymorphic `(owner_type, owner_id)` pair **without an SQL FK**, so neither
 * SQLite cascades nor a plain `DELETE` of the owner touches them. They must be
 * purged explicitly, in the same transaction, or they stay behind as orphans:
 *
 *   * `DELETE /links/{id}` used to leave the link's attachments and property
 *     values behind (comments were fixed in L20);
 *   * `DELETE /thoughts/{id}` cascades the incident `links` rows silently, so
 *     the comments/attachments/property values owned by those links need the
 *     same treatment as the thought's own ones.
 *
 * Server-stored attachment files (`networks/<nid>/attachments/`) are removed
 * from disk as well; client-local file paths are never touched.
 */

import { type AttachmentKind } from '@etn/shared';

import path from 'node:path';

import type { NetworkDb } from '../db/network-db.js';
import { removeStoredFile, storedFileInUse } from './attachment-service.js';

/** Polymorphic owner of comments/attachments/property values. */
type OwnerType = 'thought' | 'link';

/**
 * SQLite's bind-parameter cap is far above this; chunking keeps the `IN (…)`
 * lists bounded regardless of how many owners (e.g. incident links of a hub
 * thought) are passed in.
 */
const OWNER_CHUNK_SIZE = 500;

/**
 * Purge every polymorphic dependant of the given owners: comments primarily
 * owned by them (together with all their m2m targets), target rows pointing at
 * them (secondary attachments are detached, L20 §10.1), attachments (rows,
 * dangling `icon_attachment_id` references and server-stored files) and
 * property values. No-op for an empty list.
 */
export function purgeOwnerDependants(
  ndb: NetworkDb,
  ownerType: OwnerType,
  ownerIds: string[],
): void {
  for (let i = 0; i < ownerIds.length; i += OWNER_CHUNK_SIZE) {
    purgeChunk(ndb, ownerType, ownerIds.slice(i, i + OWNER_CHUNK_SIZE));
  }
}

/**
 * Purge the dependants removed together with a thought deletion: the thought's
 * own ones **and** those of its incident links — the latter are cascade-deleted
 * by the `links` FK, which never reaches the polymorphic tables.
 */
export function purgeThoughtDeletionDependants(ndb: NetworkDb, thoughtId: string): void {
  const linkIds = (
    ndb
      .prepare('SELECT id FROM links WHERE source_id = ? OR target_id = ?')
      .all(thoughtId, thoughtId) as { id: string }[]
  ).map((row) => row.id);
  purgeOwnerDependants(ndb, 'link', linkIds);
  purgeOwnerDependants(ndb, 'thought', [thoughtId]);
}

/** Single-chunk purge; `ownerIds` must be non-empty and ≤ OWNER_CHUNK_SIZE. */
function purgeChunk(ndb: NetworkDb, ownerType: OwnerType, ownerIds: string[]): void {
  if (ownerIds.length === 0) return;
  const owners = ownerIds.map(() => '?').join(', ');

  // Comments where an owner is the primary owner are deleted with all their
  // m2m targets; target rows pointing at the owner are detached (L20 §10.1).
  ndb
    .prepare(
      `DELETE FROM comment_targets WHERE comment_id IN
         (SELECT id FROM comments WHERE owner_type = ? AND owner_id IN (${owners}))`,
    )
    .run(ownerType, ...ownerIds);
  ndb
    .prepare(`DELETE FROM comments WHERE owner_type = ? AND owner_id IN (${owners})`)
    .run(ownerType, ...ownerIds);
  ndb
    .prepare(`DELETE FROM comment_targets WHERE owner_type = ? AND owner_id IN (${owners})`)
    .run(ownerType, ...ownerIds);

  const attachmentRows = ndb
    .prepare(
      `SELECT id, kind, file_path FROM attachments WHERE owner_type = ? AND owner_id IN (${owners})`,
    )
    .all(ownerType, ...ownerIds) as { id: string; kind: AttachmentKind; file_path: string | null }[];
  if (attachmentRows.length > 0) {
    ndb
      .prepare(`DELETE FROM attachments WHERE owner_type = ? AND owner_id IN (${owners})`)
      .run(ownerType, ...ownerIds);
    // A thought icon may reference its attachment (L16) — never leave a
    // dangling icon_attachment_id behind.
    const attachmentIds = attachmentRows.map((row) => row.id);
    ndb
      .prepare(
        `UPDATE thoughts SET icon_attachment_id = NULL WHERE icon_attachment_id IN (${attachmentIds.map(() => '?').join(', ')})`,
      )
      .run(...attachmentIds);
    for (const row of attachmentRows) {
      // A live attachment may still resolve to the same stored file (a second
      // reference is possible via `PATCH …/file_path`) — keep the file then.
      if (
        row.kind === 'file' &&
        row.file_path !== null &&
        storedFileInUse(ndb, path.resolve(row.file_path))
      ) {
        continue;
      }
      removeStoredFile(ndb, row.kind, row.file_path);
    }
  }

  ndb
    .prepare(`DELETE FROM property_values WHERE owner_type = ? AND owner_id IN (${owners})`)
    .run(ownerType, ...ownerIds);
}
