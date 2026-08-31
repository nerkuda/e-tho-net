/**
 * Trash (mark-for-deletion) domain service (task S13, docs/03-server-api.md
 * §14b; docs/02-data-model.md §3.1.2).
 *
 * There is no separate "trash" table: the trash is the set of thoughts and
 * links with `marked_for_deletion = 1`. Listing it just reads those rows and
 * precomputes each one's blocking check so the «Корзина» dialog does not fire
 * a per-row request; purging physically deletes every unblocked marked row.
 *
 * The actual delete runs through the same {@link deleteThought} /
 * {@link deleteLink} domain functions as a direct `DELETE`, so the blocking
 * check stays in exactly one place.
 */

import type {
  TrashLinkEntry,
  TrashListResult,
  TrashPurgeResult,
  TrashThoughtEntry,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getLink, checkLinkDeletion, deleteLink } from './link-service.js';
import { getThought, checkThoughtDeletion, deleteThought } from './thought-service.js';

/**
 * Full outcome of a purge: the public {@link TrashPurgeResult} plus the ids
 * that were actually deleted, so the route/MCP layer can fan out the standard
 * `thought.deleted` / `link.deleted` real-time events. Callers strip the id
 * lists from the wire response (03-server-api.md §14b exposes only the counts).
 */
export interface TrashPurgeOutcome extends TrashPurgeResult {
  deleted_thought_ids: string[];
  deleted_link_ids: string[];
}

/**
 * Blocking check of one trash entry — the same context-aware check as the
 * `deletion-check` endpoint (03-server-api.md §6.5a): in a working layer the
 * session's own shadow row never holds, but a live base row does (a «delete»
 * there would only be a tombstone, 13-layers.md §5.2), so the trash dialog
 * shows the same blocked/skip picture the single-delete dialog would.
 */
function trashCheckThought(ndb: NetworkDb, id: string) {
  return checkThoughtDeletion(ndb, id);
}

/** Link counterpart of {@link trashCheckThought}. */
function trashCheckLink(ndb: NetworkDb, id: string) {
  return checkLinkDeletion(ndb, id);
}

/**
 * Everything in the trash: every thought and link with
 * `marked_for_deletion = 1`, each with its precomputed blocking result
 * (03-server-api.md §14b). Not paginated — the trash is expected to stay small
 * because «Удалить всё, что возможно» regularly empties it.
 */
export function listTrash(ndb: NetworkDb): TrashListResult {
  const thoughtIds = (
    ndb.prepare('SELECT id FROM thoughts_v WHERE marked_for_deletion = 1').all() as { id: string }[]
  ).map((r) => r.id);
  const linkIds = (
    ndb.prepare('SELECT id FROM links_v WHERE marked_for_deletion = 1').all() as { id: string }[]
  ).map((r) => r.id);

  const thoughts: TrashThoughtEntry[] = [];
  for (const id of thoughtIds) {
    const thought = getThought(ndb, id);
    if (thought === null) continue; // deleted concurrently — defensive
    const check = trashCheckThought(ndb, id);
    thoughts.push({ ...thought, blocked: check.blocked, blocking: check.blocking });
  }

  const links: TrashLinkEntry[] = [];
  for (const id of linkIds) {
    const link = getLink(ndb, id);
    if (link === null) continue; // deleted concurrently — defensive
    const check = trashCheckLink(ndb, id);
    links.push({ ...link, blocked: check.blocked, blocking: check.blocking });
  }

  return { thoughts, links };
}

/**
 * «Удалить всё, что возможно» (03-server-api.md §14b): physically delete every
 * marked thought/link that is not blocked; blocked ones are skipped silently
 * (an expected outcome, not a failure). Returns purged/skipped counts.
 *
 * In a working layer blocked rows (base-held and other-layer shadows) are
 * skipped just like in the base: the «Удалить» in a layer means a tombstone
 * (13-layers.md §5.2), which the user has not consciously agreed to for rows
 * living elsewhere. Runs each deletion in its own transaction (a blocked row
 * must not roll back the ones that could be deleted); the caller may wrap the
 * whole sweep in a single outer transaction for auto-cleanup after layer
 * operations.
 */
export function purgeTrash(ndb: NetworkDb): TrashPurgeOutcome {
  let purged = 0;
  let skipped = 0;
  const deletedThoughtIds: string[] = [];
  const deletedLinkIds: string[] = [];

  const thoughtIds = (
    ndb.prepare('SELECT id FROM thoughts_v WHERE marked_for_deletion = 1').all() as { id: string }[]
  ).map((r) => r.id);
  const linkIds = (
    ndb.prepare('SELECT id FROM links_v WHERE marked_for_deletion = 1').all() as { id: string }[]
  ).map((r) => r.id);

  for (const id of thoughtIds) {
    if (trashCheckThought(ndb, id).blocked) {
      skipped += 1;
      continue;
    }
    deleteThought(ndb, id, undefined);
    deletedThoughtIds.push(id);
    purged += 1;
  }
  for (const id of linkIds) {
    if (trashCheckLink(ndb, id).blocked) {
      skipped += 1;
      continue;
    }
    deleteLink(ndb, id, undefined);
    deletedLinkIds.push(id);
    purged += 1;
  }

  return { purged, skipped, deleted_thought_ids: deletedThoughtIds, deleted_link_ids: deletedLinkIds };
}
