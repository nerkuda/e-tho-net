/**
 * Backlinks service (task R3, docs/03-server-api.md §13a,
 * docs/12-wiki-id-refs.md §6.1): find comments whose `body_md` carries an
 * explicit ID-based wiki-link to a given thought (`[[#<id>]]` or
 * `[[n:<net>#<id>]]`) or publication (`[[#pub:<id>]]`, 0.11.1, задача f37b468d,
 * требование 7f583ef9). Runtime regex over `body_md` (no separate index — task
 * R3 decision). One hit per `(owner_type, owner_id)`; a thought target's own
 * comments are excluded (anti-self). Publications have no comments of their own,
 * so no exclusion is needed there.
 */

import { EtnError, type MentionHit } from '@etn/shared';
import type { NetworkDb } from '../db/network-db.js';
import { makeSnippet } from './search-service.js';

/** Matches `[[#<uuid>]]` or `[[#<uuid>|<alias>]]`. */
const RE_ID = /\[\[#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\|[^\]\n]*)?\]\]/gi;

/** Matches `[[#pub:<uuid>]]` or `[[#pub:<uuid>|<alias>]]` (задача f37b468d). */
const RE_PUB =
  /\[\[#pub:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\|[^\]\n]*)?\]\]/gi;

/**
 * Matches `[[n:<uuid>#<uuid>]]` or `[[n:<uuid>#<uuid>|<alias>]]`. The first
 * capture group is the **target thought id** (after `#`); the second is the
 * optional alias; the network id (before `#`) is captured but not used here —
 * we match by the target id only.
 */
const RE_CROSS =
  /\[\[n:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\|[^\]\n]*)?\]\]/gi;

/** Which kinds of wiki-link a scan matches (and which it ignores). */
interface BacklinkMatchers {
  /** Match bare thought-id links `[[#<uuid>]]`. */
  id: boolean;
  /** Match cross-network thought links `[[n:<net>#<uuid>]]`. */
  cross: boolean;
  /** Match publication links `[[#pub:<uuid>]]`. */
  pub: boolean;
}

interface BacklinkRow {
  comment_id: string;
  owner_id: string;
  title: string;
  active: number;
  body: string;
}

/**
 * Scan a single comment body for any matching wiki-link whose target id equals
 * `targetIdLowercased`. Returns the first matching id as the snippet highlight
 * term (so the snippet is centered on it), or null if no match.
 */
function findMatchingId(body: string, targetIdLowercased: string, m: BacklinkMatchers): string | null {
  const patterns: Array<{ re: RegExp; group: number }> = [];
  if (m.id) patterns.push({ re: RE_ID, group: 1 });
  if (m.cross) patterns.push({ re: RE_CROSS, group: 2 });
  if (m.pub) patterns.push({ re: RE_PUB, group: 1 });
  for (const { re, group } of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
      const captured = match[group];
      if (captured !== undefined && captured.toLowerCase() === targetIdLowercased) {
        return captured;
      }
      if (match[0].length === 0) re.lastIndex += 1; // guard against empty matches
    }
  }
  return null;
}

/**
 * Scan thought- and link-owned comments for a matching wiki-link to `targetId`
 * and return one {@link MentionHit} per `(owner_type, owner_id)`.
 *
 * @param excludeThoughtId — when set, that thought's own comments are skipped
 *   (anti-self for a thought target).
 */
function scanBacklinkOwners(
  ndb: NetworkDb,
  targetId: string,
  matchers: BacklinkMatchers,
  excludeThoughtId: string | null,
): MentionHit[] {
  const targetIdLower = targetId.toLowerCase();
  const out: MentionHit[] = [];
  const seen = new Set<string>();

  // 2) Pull thought-owned comments (excluding the target thought itself).
  //    Same `JOIN thoughts_v` pattern as `findMentions` — keeps `title` and
  //    `active` aligned with the owner's actual row.
  const thoughtRows = ndb
    .prepare(
      `SELECT c.id AS comment_id, c.owner_id AS owner_id,
              t.title AS title, t.active AS active, c.body_md AS body
       FROM comments_v c
       JOIN thoughts_v t ON t.id = c.owner_id
       WHERE c.owner_type = 'thought'${excludeThoughtId === null ? '' : ' AND c.owner_id <> ?'}`,
    )
    .all(...(excludeThoughtId === null ? [] : [excludeThoughtId])) as BacklinkRow[];

  // 3) Pull link-owned comments — `title` is the link type's forward name.
  const linkRows = ndb
    .prepare(
      `SELECT c.id AS comment_id, c.owner_id AS owner_id,
              COALESCE(lt.name_forward, '') AS title,
              COALESCE(l.active, 1) AS active,
              c.body_md AS body
       FROM comments_v c
       LEFT JOIN links_v l ON l.id = c.owner_id
       LEFT JOIN link_types_v lt ON lt.id = l.type_id
       WHERE c.owner_type = 'link'`,
    )
    .all() as BacklinkRow[];

  for (const rows of [thoughtRows, linkRows]) {
    for (const r of rows) {
      const matchedId = findMatchingId(r.body, targetIdLower, matchers);
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

/**
 * Find backlinks (explicit ID-based wiki references) to the given thought.
 *
 * @param ndb Network-scoped DB handle.
 * @param thoughtId Target thought id (UUID).
 * @returns One `MentionHit` per `(owner_type, owner_id)` owner whose comments
 *   carry a `[[#<id>]]` or `[[n:<net>#<id>]]` reference to this thought.
 *   The target thought's own comments are excluded. Publication links
 *   (`[[#pub:…]]`) are NOT thought references and are ignored.
 * @throws `EtnError('NOT_FOUND')` if the target thought does not exist.
 */
export function findBacklinks(ndb: NetworkDb, thoughtId: string): MentionHit[] {
  // 1) Verify the target thought exists; mirror `findMentions` semantics.
  const exists = ndb.prepare('SELECT 1 FROM thoughts_v WHERE id = ?').get(thoughtId);
  if (!exists) {
    throw new EtnError('NOT_FOUND', `thought ${thoughtId} not found`, {
      entity: 'thought',
      id: thoughtId,
    });
  }
  return scanBacklinkOwners(ndb, thoughtId, { id: true, cross: true, pub: false }, thoughtId);
}

/**
 * Find backlinks to the given publication (0.11.1, задача f37b468d,
 * требование 7f583ef9): owners whose comments carry a `[[#pub:<id>]]`
 * reference. Only publication refs are matched — a bare `[[#<id>]]` is a
 * thought link, and a publication id is never a thought.
 *
 * @throws `EtnError('NOT_FOUND')` if the target publication does not exist in
 *   the connection's layer context.
 */
export function findPublicationBacklinks(ndb: NetworkDb, publicationId: string): MentionHit[] {
  const exists = ndb.prepare('SELECT 1 FROM publications_v WHERE id = ?').get(publicationId);
  if (!exists) {
    throw new EtnError('NOT_FOUND', `publication ${publicationId} not found`, {
      entity: 'publication',
      id: publicationId,
    });
  }
  return scanBacklinkOwners(ndb, publicationId, { id: false, cross: false, pub: true }, null);
}
