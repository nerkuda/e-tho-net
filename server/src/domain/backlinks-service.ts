/**
 * Backlinks service (task R3, docs/03-server-api.md §13a,
 * docs/12-wiki-id-refs.md §6.1): find comments whose `body_md` carries an
 * explicit ID-based wiki-link `[[#<id>]]` or `[[n:<net>#<id>]]` to a given
 * thought. Runtime regex over `body_md` (no separate index — task R3
 * decision). One hit per `(owner_type, owner_id)`; the target thought's own
 * comments are excluded (anti-self).
 */

import { EtnError, type MentionHit } from '@etn/shared';
import type { NetworkDb } from '../db/network-db.js';
import { makeSnippet } from './search-service.js';

/** Matches `[[#<uuid>]]` or `[[#<uuid>|<alias>]]`. */
const RE_ID = /\[\[#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\|[^\]\n]*)?\]\]/gi;

/**
 * Matches `[[n:<uuid>#<uuid>]]` or `[[n:<uuid>#<uuid>|<alias>]]`. The first
 * capture group is the **target thought id** (after `#`); the second is the
 * optional alias; the network id (before `#`) is captured but not used here —
 * we match by the target id only.
 */
const RE_CROSS =
  /\[\[n:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\|[^\]\n]*)?\]\]/gi;

interface BacklinkRow {
  comment_id: string;
  owner_id: string;
  title: string;
  active: number;
  body: string;
}

/**
 * Scan a single comment body for any ID-based wiki-link whose target id
 * matches `targetIdLowercased`. Returns the first matching id-pattern as the
 * snippet highlight term (so the snippet is centered on it), or null if no
 * match.
 */
function findMatchingId(body: string, targetIdLowercased: string): string | null {
  RE_ID.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_ID.exec(body)) !== null) {
    const captured = m[1];
    if (captured !== undefined && captured.toLowerCase() === targetIdLowercased) {
      return captured;
    }
    if (m[0].length === 0) RE_ID.lastIndex += 1; // guard against empty matches
  }
  RE_CROSS.lastIndex = 0;
  while ((m = RE_CROSS.exec(body)) !== null) {
    const captured = m[2];
    if (captured !== undefined && captured.toLowerCase() === targetIdLowercased) {
      return captured;
    }
    if (m[0].length === 0) RE_CROSS.lastIndex += 1;
  }
  return null;
}

/**
 * Find backlinks (explicit ID-based wiki references) to the given thought.
 *
 * @param ndb Network-scoped DB handle.
 * @param thoughtId Target thought id (UUID).
 * @returns One `MentionHit` per `(owner_type, owner_id)` owner whose comments
 *   carry a `[[#<id>]]` or `[[n:<net>#<id>]]` reference to this thought.
 *   The target thought's own comments are excluded.
 * @throws `EtnError('NOT_FOUND')` if the target thought does not exist.
 */
export function findBacklinks(ndb: NetworkDb, thoughtId: string): MentionHit[] {
  // 1) Verify the target thought exists; mirror `findMentions` semantics.
  const exists = ndb.prepare('SELECT 1 FROM thoughts WHERE id = ?').get(thoughtId);
  if (!exists) {
    throw new EtnError('NOT_FOUND', `thought ${thoughtId} not found`, {
      entity: 'thought',
      id: thoughtId,
    });
  }

  const targetIdLower = thoughtId.toLowerCase();
  const out: MentionHit[] = [];
  const seen = new Set<string>();

  // 2) Pull thought-owned comments (excluding the target thought itself).
  //    Same `JOIN thoughts` pattern as `findMentions` — keeps `title` and
  //    `active` aligned with the owner's actual row.
  const thoughtRows = ndb
    .prepare(
      `SELECT c.id AS comment_id, c.owner_id AS owner_id,
              t.title AS title, t.active AS active, c.body_md AS body
       FROM comments c
       JOIN thoughts t ON t.id = c.owner_id
       WHERE c.owner_type = 'thought' AND c.owner_id <> ?`,
    )
    .all(thoughtId) as BacklinkRow[];

  // 3) Pull link-owned comments — `title` is the link type's forward name.
  const linkRows = ndb
    .prepare(
      `SELECT c.id AS comment_id, c.owner_id AS owner_id,
              COALESCE(lt.name_forward, '') AS title,
              COALESCE(l.active, 1) AS active,
              c.body_md AS body
       FROM comments c
       LEFT JOIN links l ON l.id = c.owner_id
       LEFT JOIN link_types lt ON lt.id = l.type_id
       WHERE c.owner_type = 'link'`,
    )
    .all() as BacklinkRow[];

  for (const rows of [thoughtRows, linkRows]) {
    for (const r of rows) {
      const matchedId = findMatchingId(r.body, targetIdLower);
      if (matchedId === null) continue;

      // Collapse per (owner_type, owner_id): the first matching comment
      // wins. `owner_type` is implicit from the row group above.
      const ownerType: 'thought' | 'link' = rows === thoughtRows ? 'thought' : 'link';
      const key = `${ownerType}:${r.owner_id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        owner_type: ownerType,
        owner_id: r.owner_id,
        title: r.title,
        comment_id: r.comment_id,
        snippet: makeSnippet(r.body, [matchedId]),
        active: r.active === 1,
      });
    }
  }

  return out;
}
