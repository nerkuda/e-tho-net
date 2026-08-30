/**
 * Layer integrity invariant (task S12, docs/13-layers.md §12 DoD; the
 * «тест-инвариант целостности, который можно гонять по боевой базе»).
 *
 * After the SQLite foreign keys were dropped for the branchable tables
 * (13-layers.md §3 — rows address each other across layers), referential
 * integrity became an application concern. This module is the single check
 * that can run over ANY network database — a test fixture or a live copy —
 * and report every dangling live reference:
 *
 *   * a live `links` row whose source or target thought does not exist as a
 *     live row in ANY layer;
 *   * a live `comments` / `comment_targets` / `attachments` /
 *     `property_values` row whose owner does not exist as a live row in ANY
 *     layer.
 *
 * «Live» means `deleted = 0` on the row itself. The OWNER may live in a
 * different layer than the referencing row — layers share logical ids
 * (§4.1), so the check is against the union of all layers' live rows.
 * Tombstones (deleted = 1) are not checked: a tombstone may legitimately
 * outlive its target (it is the deletion itself).
 *
 * All reads are physical on purpose — the check must see what the views
 * deliberately hide. The `layers:physical-read` markers keep the S3 lint
 * rule honest (every direct branchable-table read is discoverable).
 */

import type { NetworkDb } from '../db/network-db.js';

/** One dangling reference found by {@link checkLayerIntegrity}. */
export interface LayerIntegrityViolation {
  table: string;
  /** The referencing row's id. */
  id: string;
  /** What the row references: `source`/`target` (links) or `owner`. */
  ref: string;
  /** The missing entity's type + id. */
  missing: { table: string; id: string };
}

/** Ids of live thoughts across ALL layers (physical read). */
function liveThoughtIds(ndb: NetworkDb): Set<string> {
  const rows = ndb
    .prepare('SELECT id FROM thoughts WHERE deleted = 0 -- layers:physical-read')
    .all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** Ids of live links across ALL layers (physical read). */
function liveLinkIds(ndb: NetworkDb): Set<string> {
  const rows = ndb
    .prepare('SELECT id FROM links WHERE deleted = 0 -- layers:physical-read')
    .all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * Every dangling live reference in the network — empty array means the
 * invariant holds. Runs in a single read pass over the branchable tables;
 * sized for tests and for an occasional sweep of a live base (thousands of
 * rows are fine, this is not a per-request tool).
 */
export function checkLayerIntegrity(ndb: NetworkDb): LayerIntegrityViolation[] {
  const violations: LayerIntegrityViolation[] = [];
  const thoughts = liveThoughtIds(ndb);
  const links = liveLinkIds(ndb);

  // links: both endpoints must be live somewhere.
  for (const row of ndb
    .prepare(
      'SELECT id, source_id, target_id FROM links WHERE deleted = 0 -- layers:physical-read',
    )
    .all() as { id: string; source_id: string; target_id: string }[]) {
    if (!thoughts.has(row.source_id)) {
      violations.push({
        table: 'links',
        id: row.id,
        ref: 'source',
        missing: { table: 'thoughts', id: row.source_id },
      });
    }
    if (!thoughts.has(row.target_id)) {
      violations.push({
        table: 'links',
        id: row.id,
        ref: 'target',
        missing: { table: 'thoughts', id: row.target_id },
      });
    }
  }

  // comments: the owner (thought or link) must be live somewhere.
  for (const row of ndb
    .prepare(
      'SELECT id, owner_type, owner_id FROM comments WHERE deleted = 0 -- layers:physical-read',
    )
    .all() as { id: string; owner_type: 'thought' | 'link'; owner_id: string }[]) {
    const alive = row.owner_type === 'thought' ? thoughts.has(row.owner_id) : links.has(row.owner_id);
    if (!alive) {
      violations.push({
        table: 'comments',
        id: row.id,
        ref: 'owner',
        missing: { table: row.owner_type === 'thought' ? 'thoughts' : 'links', id: row.owner_id },
      });
    }
  }

  // comment_targets: the target owner must be live somewhere.
  for (const row of ndb
    .prepare(
      'SELECT id, owner_type, owner_id FROM comment_targets WHERE deleted = 0 -- layers:physical-read',
    )
    .all() as { id: string; owner_type: 'thought' | 'link'; owner_id: string }[]) {
    const alive = row.owner_type === 'thought' ? thoughts.has(row.owner_id) : links.has(row.owner_id);
    if (!alive) {
      violations.push({
        table: 'comment_targets',
        id: row.id,
        ref: 'owner',
        missing: { table: row.owner_type === 'thought' ? 'thoughts' : 'links', id: row.owner_id },
      });
    }
  }

  // attachments: the owner must be live somewhere.
  for (const row of ndb
    .prepare(
      'SELECT id, owner_type, owner_id FROM attachments WHERE deleted = 0 -- layers:physical-read',
    )
    .all() as { id: string; owner_type: 'thought' | 'link'; owner_id: string }[]) {
    const alive = row.owner_type === 'thought' ? thoughts.has(row.owner_id) : links.has(row.owner_id);
    if (!alive) {
      violations.push({
        table: 'attachments',
        id: row.id,
        ref: 'owner',
        missing: { table: row.owner_type === 'thought' ? 'thoughts' : 'links', id: row.owner_id },
      });
    }
  }

  // property_values: the owner must be live somewhere.
  for (const row of ndb
    .prepare(
      'SELECT id, owner_type, owner_id FROM property_values WHERE deleted = 0 -- layers:physical-read',
    )
    .all() as { id: string; owner_type: 'thought' | 'link'; owner_id: string }[]) {
    const alive = row.owner_type === 'thought' ? thoughts.has(row.owner_id) : links.has(row.owner_id);
    if (!alive) {
      violations.push({
        table: 'property_values',
        id: row.id,
        ref: 'owner',
        missing: { table: row.owner_type === 'thought' ? 'thoughts' : 'links', id: row.owner_id },
      });
    }
  }

  return violations;
}
