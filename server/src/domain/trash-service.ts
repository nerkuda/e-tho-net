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
    const check = checkThoughtDeletion(ndb, id);
    thoughts.push({ ...thought, blocked: check.blocked, blocking: check.blocking });
  }

  const links: TrashLinkEntry[] = [];
  for (const id of linkIds) {
    const link = getLink(ndb, id);
    if (link === null) continue; // deleted concurrently — defensive
    const check = checkLinkDeletion(ndb, id);
    links.push({ ...link, blocked: check.blocked, blocking: check.blocking });
  }

  return { thoughts, links };
}

/**
 * «Удалить всё, что возможно» (03-server-api.md §14b): physically delete every
 * marked thought/link that is not blocked; blocked ones are skipped silently
 * (an expected outcome, not a failure). Returns purged/skipped counts.
 *
 * Runs each deletion in its own transaction (a blocked row must not roll back
 * the ones that could be deleted); the caller may wrap the whole sweep in a
 * single outer transaction for auto-cleanup after layer operations.
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
    if (checkThoughtDeletion(ndb, id).blocked) {
      skipped += 1;
      continue;
    }
    deleteThought(ndb, id, undefined);
    deletedThoughtIds.push(id);
    purged += 1;
  }
  for (const id of linkIds) {
    if (checkLinkDeletion(ndb, id).blocked) {
      skipped += 1;
      continue;
    }
    deleteLink(ndb, id, undefined);
    deletedLinkIds.push(id);
    purged += 1;
  }

  return { purged, skipped, deleted_thought_ids: deletedThoughtIds, deleted_link_ids: deletedLinkIds };
}
