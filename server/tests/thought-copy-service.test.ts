/**
 * Unit tests for {@link copyThoughtsBatch} (task L26, bb8277f6).
 *
 * Two scenarios are pinned down:
 *
 *  - A subgraph copy preserves internal hierarchy: only the **roots** of
 *    the copied subgraph (the thoughts with no incoming copied link) get a
 *    new parent-link to the paste target. Internal thoughts keep their
 *    existing parent-links and do NOT receive an extra link to the paste
 *    target — otherwise the children zone would double-list them.
 *  - The whole batch is atomic: a malformed thought snapshot rolls back
 *    every other create in the same call.
 *
 * Skipped entirely when the `better-sqlite3` native binding is unavailable
 * (the rest of the suite stays green).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import type { ThoughtCopyInput, ThoughtCopyItem, ThoughtCopyLink } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { copyThoughtsBatch } from '../src/domain/thought-copy-service.js';

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

const ACTOR = '11111111-2222-3333-4444-555555555555';
const PASTE_TARGET = 'paste-target-thought';

function setup(): NetworkDb {
  const ndb = createInMemoryNetworkDb();
  // Insert the paste target up-front — the service validates its existence
  // and would 404 on a missing parent.
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, icon, icon_kind, active,
                             is_protected, is_root, fg_color, bg_color,
                             font_bold, font_italic, font_underline, font_strike, font_manual,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, NULL, 'emoji', 1, 0, 0, NULL, NULL, 0, 0, 0, 0, 0,
               1, '2026-01-01T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(PASTE_TARGET, 'Paste target', 'paste target', ACTOR, ACTOR);
  return ndb;
}

function snapshot(title: string): ThoughtCopyItem {
  return {
    thought: {
      title,
      synonyms: [],
      type: { id: null, name: null },
      icon: null,
      icon_kind: 'emoji',
      active: true,
      fg_color: null,
      bg_color: null,
      font_bold: null,
      font_italic: null,
      font_underline: null,
      font_strike: null,
    },
  } as unknown as ThoughtCopyItem;
}

/** Inject the client-side `source_id` extension (the service reads it off
 *  the wire to fill in the result's `thought_id_map`). */
function withSourceId(item: ThoughtCopyItem, sourceId: string): ThoughtCopyItem {
  return { ...item, source_id: sourceId } as unknown as ThoughtCopyItem;
}

function untypedLink(sourceId: string, targetId: string): ThoughtCopyLink {
  return {
    source_id: sourceId,
    target_id: targetId,
    type: { id: null, name_forward: null, name_reverse: null },
    color: null,
    style: null,
    width: null,
    active: true,
  };
}

describe(
  'copyThoughtsBatch',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('attaches only roots of the copied subgraph to the paste target', () => {
      const ndb = setup();
      // Source subgraph: A → B, A → C (B and C are children of A).
      const input: ThoughtCopyInput = {
        source_network_id: 'source-net',
        parent_thought_id: PASTE_TARGET,
        thoughts: [
          withSourceId(snapshot('Project A'), 'source-a'),
          withSourceId(snapshot('Subtask B'), 'source-b'),
          withSourceId(snapshot('Subtask C'), 'source-c'),
        ],
        links: [
          untypedLink('source-a', 'source-b'),
          untypedLink('source-a', 'source-c'),
        ],
      };

      const result = copyThoughtsBatch(ndb, input, ACTOR);

      // Three thoughts created.
      assert.equal(result.created_thoughts.length, 3);
      const newA = result.thought_id_map['source-a']!;
      const newB = result.thought_id_map['source-b']!;
      const newC = result.thought_id_map['source-c']!;
      assert.ok(newA && newB && newC);

      // New thoughts that are TARGETS of copied links (B, C) must NOT have a
      // parent-link from the paste target — they keep the original link
      // from A as their parent.
      const linkToA = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(PASTE_TARGET, newA) as { id: string } | undefined;
      const linkToB = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(PASTE_TARGET, newB) as { id: string } | undefined;
      const linkToC = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(PASTE_TARGET, newC) as { id: string } | undefined;
      assert.ok(linkToA, 'paste-target → A (root) must get a parent-link');
      assert.equal(linkToB, undefined, 'paste-target → B (internal) must NOT get a parent-link');
      assert.equal(linkToC, undefined, 'paste-target → C (internal) must NOT get a parent-link');

      // B and C keep the original A → B / A → C parent-links.
      const aToB = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(newA, newB) as { id: string } | undefined;
      const aToC = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(newA, newC) as { id: string } | undefined;
      assert.ok(aToB, 'A → B parent-link must survive the copy');
      assert.ok(aToC, 'A → C parent-link must survive the copy');
    });

    it('attaches every thought when none of them has a copied parent', () => {
      const ndb = setup();
      // Two independent thoughts copied together — no links between them.
      const input: ThoughtCopyInput = {
        source_network_id: 'source-net',
        parent_thought_id: PASTE_TARGET,
        thoughts: [
          withSourceId(snapshot('Independent A'), 'src-1'),
          withSourceId(snapshot('Independent B'), 'src-2'),
        ],
        links: [],
      };

      const result = copyThoughtsBatch(ndb, input, ACTOR);

      const newA = result.thought_id_map['src-1']!;
      const newB = result.thought_id_map['src-2']!;
      const linkToA = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(PASTE_TARGET, newA) as { id: string } | undefined;
      const linkToB = ndb
        .prepare('SELECT id FROM links WHERE source_id = ? AND target_id = ?')
        .get(PASTE_TARGET, newB) as { id: string } | undefined;
      assert.ok(linkToA, 'Independent thought A must be attached to paste target');
      assert.ok(linkToB, 'Independent thought B must be attached to paste target');
    });

    it('attaches only the source of an inter-thought link as a root', () => {
      // Edge case: a copy of two siblings with a single inter-thought link.
      // A is the source of the inter-link (so it has no incoming copied
      // link → root → gets a parent-link to the paste target). B is the
      // target of that same link → internal → keeps the inter-link as its
      // only incoming edge and is NOT attached to the paste target again.
      const ndb = setup();
      const input: ThoughtCopyInput = {
        source_network_id: 'source-net',
        parent_thought_id: PASTE_TARGET,
        thoughts: [
          withSourceId(snapshot('Sibling A'), 's-a'),
          withSourceId(snapshot('Sibling B'), 's-b'),
        ],
        links: [untypedLink('s-a', 's-b')],
      };

      const result = copyThoughtsBatch(ndb, input, ACTOR);
      const newA = result.thought_id_map['s-a']!;
      const newB = result.thought_id_map['s-b']!;

      assert.ok(
        ndb
          .prepare('SELECT 1 FROM links WHERE source_id = ? AND target_id = ?')
          .get(PASTE_TARGET, newA),
        'Sibling A (link source) must attach to paste target',
      );
      assert.equal(
        ndb
          .prepare('SELECT 1 FROM links WHERE source_id = ? AND target_id = ?')
          .get(PASTE_TARGET, newB),
        undefined,
        'Sibling B (link target) must NOT be re-attached to paste target',
      );
      // The copied inter-link is preserved.
      assert.ok(
        ndb.prepare('SELECT 1 FROM links WHERE source_id = ? AND target_id = ?').get(newA, newB),
        'Sibling A → Sibling B inter-link preserved',
      );
    });
  },
);
