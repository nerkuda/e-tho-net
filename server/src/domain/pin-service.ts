/**
 * Pinned-thoughts domain service (L18, docs/02-data-model.md §3.10.6,
 * docs/03-server-api.md §19).
 *
 * The user's ordered «закреплённые мысли» list — level-L3 user state
 * (docs/11-settings-and-state.md §2): stored per (user × network) and synced
 * across the user's clients via the `pinned-thoughts.updated` event with
 * audience = "user".
 *
 * The write side uses replace semantics (like `setFocusOrder`): the caller
 * supplies the full intended order, the server rewrites the table in one
 * transaction and assigns `position` = array index. Duplicates are rejected,
 * the list length is capped at {@link PINNED_THOUGHTS_LIMIT} and every id must
 * resolve to an existing thought (otherwise `NOT_FOUND`).
 */

import { EtnError, PINNED_THOUGHTS_LIMIT, type PinnedThoughtEntry } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getThoughtOrThrow } from './thought-service.js';

/** Raw `user_pinned_thoughts` row. */
interface PinnedRow {
  thought_id: string;
  position: number;
}

/** List the user's pinned thoughts in position order (03-server-api.md §19). */
export function listPinnedThoughts(ndb: NetworkDb, userId: string): PinnedThoughtEntry[] {
  const rows = ndb
    .prepare(
      'SELECT thought_id, position FROM user_pinned_thoughts' +
        ' WHERE user_id = ? ORDER BY position ASC',
    )
    .all(userId) as PinnedRow[];
  return rows.map((row) => ({ thought_id: row.thought_id, position: row.position }));
}

/**
 * Replace the user's pinned list with the given order (03-server-api.md §19).
 *
 * Throws:
 *   * `VALIDATION_ERROR` when the list exceeds {@link PINNED_THOUGHTS_LIMIT}
 *     or contains duplicate ids;
 *   * `NOT_FOUND` when any id does not reference an existing thought.
 */
export function setPinnedThoughts(
  ndb: NetworkDb,
  userId: string,
  orderedIds: string[],
): PinnedThoughtEntry[] {
  if (orderedIds.length > PINNED_THOUGHTS_LIMIT) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `Закрепить можно не более ${PINNED_THOUGHTS_LIMIT} мыслей — сначала открепите лишние.`,
      { field: 'ordered_ids', limit: PINNED_THOUGHTS_LIMIT },
    );
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new EtnError('VALIDATION_ERROR', 'Дубли закреплённых мыслей не допускаются.', {
      field: 'ordered_ids',
    });
  }
  for (const id of orderedIds) {
    getThoughtOrThrow(ndb, id);
  }

  const now = new Date().toISOString();
  ndb.transaction(() => {
    ndb.prepare('DELETE FROM user_pinned_thoughts WHERE user_id = ?').run(userId);
    const insert = ndb.prepare(
      'INSERT INTO user_pinned_thoughts (user_id, thought_id, position, pinned_at)' +
        ' VALUES (?, ?, ?, ?)',
    );
    orderedIds.forEach((thoughtId, position) => {
      insert.run(userId, thoughtId, position, now);
    });
  });
  return orderedIds.map((thought_id, position) => ({ thought_id, position }));
}
