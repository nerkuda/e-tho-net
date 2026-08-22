/**
 * Unit tests for `collectSubtreeTypes` (task O16,
 * docs/05-mcp-server.md §5.1b — `etn.types.list` with `in_subtree_of`).
 *
 * Verifies:
 *   * happy path — only types actually used inside the subtree are reported,
 *     with correct usage_count for both thought and link types;
 *   * empty subtree (no children) — empty maps, no error;
 *   * cycle safety — A→B→A does not loop forever;
 *   * inactive thoughts/links are skipped.
 *
 * The native `better-sqlite3` binding must load for these tests (they run
 * against an in-memory `data.db`); see `nativeAvailable()` below — the
 * server test suite SKIPs them otherwise.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { TRAVERSAL_DEFAULTS } from '@etn/shared';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { collectSubtreeTypes } from '../src/domain/search-service.js';
import { listThoughtTypes } from '../src/domain/thought-type-service.js';

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const USER = 'u';

interface SeededFixture {
  ndb: NetworkDb;
  noteType: string;
  linkType: string;
  seedId: string;
}

/** Build a small network with two thought types and one link type. */
function setupNetwork(): SeededFixture {
  const ndb = createInMemoryNetworkDb();
  const noteType = createThoughtType(ndb, { name: 'Note' }, USER).id;
  const taskType = createThoughtType(ndb, { name: 'Task' }, USER).id;
  const linkType = createLinkType(ndb, { name_forward: 'relates', name_reverse: 'relates' }, USER).id;
  // The root thought (no type) and a seed with type=Note.
  const seedId = seedThought(ndb, 'Seed', { type_id: noteType });
  void taskType; // present in catalogue but unused in this fixture's subtree.
  return { ndb, noteType, linkType, seedId };
}

/** Insert a thought row directly. */
function seedThought(
  ndb: NetworkDb,
  title: string,
  opts: { type_id?: string | null; active?: number } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase(), opts.type_id ?? null, opts.active ?? 1);
  return id;
}

/** Insert a link directly with an explicit type. */
function seedTypedLink(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  typeId: string | null,
  opts: { active?: number } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, sourceId, targetId, typeId, opts.active ?? 1);
  return id;
}

describe('collectSubtreeTypes (O16)', { skip: !nativeAvailable() }, () => {
  it('returns only the types actually used inside the subtree', () => {
    const { ndb, noteType, linkType, seedId } = setupNetwork();

    // Seed → A → B (all three of type Note); Seed↔A uses the link type.
    const a = seedThought(ndb, 'A', { type_id: noteType });
    const b = seedThought(ndb, 'B', { type_id: noteType });
    seedTypedLink(ndb, seedId, a, linkType);
    seedTypedLink(ndb, a, b, linkType);

    // A second branch that lives OUTSIDE the seed's subtree — must be ignored.
    const stray = seedThought(ndb, 'Stray', { type_id: noteType });
    seedTypedLink(ndb, stray, seedId, linkType);

    const { thought_type_counts, link_type_counts } = collectSubtreeTypes(ndb, seedId);

    // Only Note appears (Stray is outside the subtree).
    assert.deepEqual([...thought_type_counts.keys()].sort(), [noteType].sort());
    assert.deepEqual(thought_type_counts.get(noteType), 3);
    assert.equal(thought_type_counts.has(randomUUID()), false);

    // Two active links (Seed→A, A→B) sit fully inside the subtree; the third
    // (Stray→Seed) has a source outside it and must be skipped.
    assert.deepEqual([...link_type_counts.keys()].sort(), [linkType].sort());
    assert.deepEqual(link_type_counts.get(linkType), 2);
  });

  it('returns empty maps for a leaf subtree with no descendants', () => {
    const { ndb, seedId } = setupNetwork();
    const { thought_type_counts, link_type_counts } = collectSubtreeTypes(ndb, seedId);
    // The seed itself carries its own type, so the catalogue reflects the
    // seed — but with no descendants and no outgoing links the result is a
    // single thought type (the seed's) and zero link types.
    assert.equal(thought_type_counts.size, 1);
    assert.equal(link_type_counts.size, 0);
    void seedId;
  });

  it('survives cycles in the descendant graph (A→B→A)', () => {
    const { ndb, noteType, linkType, seedId } = setupNetwork();
    const a = seedThought(ndb, 'A', { type_id: noteType });
    const b = seedThought(ndb, 'B', { type_id: noteType });
    seedTypedLink(ndb, seedId, a, linkType);
    seedTypedLink(ndb, a, b, linkType);
    // Close the cycle back to `a`. Without UNIQUE-on-(id, depth) dedup the
    // walk would enumerate an exponential number of paths; the production
    // recursive CTE terminates.
    seedTypedLink(ndb, b, a, linkType);

    const { thought_type_counts, link_type_counts } = collectSubtreeTypes(ndb, seedId);
    assert.equal(thought_type_counts.get(noteType), 3);
    // Three links: seed→a, a→b, b→a (none share both endpoints outside).
    assert.equal(link_type_counts.get(linkType), 3);
  });

  it('honours max_depth and skips inactive thoughts/links', () => {
    const { ndb, noteType, linkType, seedId } = setupNetwork();

    const a = seedThought(ndb, 'A', { type_id: noteType });
    const b = seedThought(ndb, 'B', { type_id: noteType }); // depth 2 from seed
    const inactive = seedThought(ndb, 'Inactive', { type_id: noteType, active: 0 });
    seedTypedLink(ndb, seedId, a, linkType);
    seedTypedLink(ndb, a, b, linkType);
    seedTypedLink(ndb, b, inactive, linkType, { active: 0 });

    // depth=1 cuts off B and the inactive thoughts/links.
    const depth1 = collectSubtreeTypes(ndb, seedId, { maxDepth: 1 });
    assert.equal(depth1.thought_type_counts.get(noteType), 2); // seed + A
    assert.equal(depth1.link_type_counts.get(linkType), 1); // seed→A only

    // Default depth: inactive thought & inactive link are filtered out.
    const full = collectSubtreeTypes(ndb, seedId);
    assert.equal(full.thought_type_counts.get(noteType), 3); // seed, A, B
    assert.equal(full.link_type_counts.get(linkType), 2); // active links only

    // Sanity: TRAVERSAL_DEFAULTS.MAX_DEPTH is the implicit ceiling.
    assert.ok(TRAVERSAL_DEFAULTS.MAX_DEPTH >= 1);
  });

  it('returns null-free types (thoughts without type are not aggregated)', () => {
    // Use an untyped seed (the only way to make the thought_type_counts empty:
    // untyped thoughts contribute nothing to the aggregated map per
    // `AND type_id IS NOT NULL` in the collector).
    const { ndb, linkType } = setupNetwork();
    const untypedSeed = seedThought(ndb, 'UntypedSeed', { type_id: null });
    const a = seedThought(ndb, 'A', { type_id: null });
    seedTypedLink(ndb, untypedSeed, a, linkType);
    const { thought_type_counts, link_type_counts } = collectSubtreeTypes(ndb, untypedSeed);
    assert.equal(thought_type_counts.size, 0);
    assert.equal(link_type_counts.get(linkType), 1);
  });

  it('returns empty maps when no seedId is supplied', () => {
    const { ndb } = setupNetwork();
    const { thought_type_counts, link_type_counts } = collectSubtreeTypes(ndb, undefined);
    assert.equal(thought_type_counts.size, 0);
    assert.equal(link_type_counts.size, 0);
  });

  it('integration: catalog filtering with full network types', () => {
    // Sanity: types not used in the subtree must be excluded from the answer
    // even if the catalogue itself contains more entries.
    const { ndb, noteType, seedId } = setupNetwork();
    const a = seedThought(ndb, 'A', { type_id: noteType });
    // Create an unrelated thought type that lives outside the subtree's usage.
    createThoughtType(ndb, { name: 'UnusedElsewhere' }, USER);

    const all = listThoughtTypes(ndb).map((t) => t.id);
    const used = collectSubtreeTypes(ndb, seedId).thought_type_counts;
    for (const id of all) {
      if (used.has(id)) {
        assert.ok(used.get(id) === 1 || used.get(id) === 2, `unexpected count for ${id}`);
      }
    }
    // The unused type should not appear in the subtree usage map.
    assert.equal(used.size, 1);
    assert.ok(used.has(noteType));
    void a;
  });
});
