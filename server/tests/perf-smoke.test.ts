/**
 * Performance smoke test (task I3, docs/workplan.md §11).
 *
 * Fills an in-memory network with 10k thoughts, then measures the hot paths:
 * bulk creation, focus (neighbours + sort), FTS search and a bounded subtree
 * traversal. Thresholds are deliberately generous (CI-safe smoke guards) —
 * they catch accidental quadratic behaviour, not micro-regressions.
 *
 * Skipped entirely when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createThought, focus } from '../src/domain/thought-service.js';
import { createLink } from '../src/domain/link-service.js';
import { search } from '../src/domain/search-service.js';
import { traverse } from '../src/domain/graph-traversal.js';
import { createComment } from '../src/domain/comment-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const THOUGHTS = 10_000;
/** Generous CI-safe ceilings (in ms) — real targets are far below. */
const CEIL = {
  bulkCreate: 30_000,
  focus: 2_000,
  search: 2_000,
  traverse: 1_000,
} as const;

describe(
  'Performance smoke (I3)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('10k-thought network: create, focus, search and traversal stay fast', () => {
      const ndb: NetworkDb = createInMemoryNetworkDb();

      // Build a shallow tree: HOME ← 10k children, one deep chain of 50.
      const homeId = createThought(ndb, { title: 'HOME' }, 'perf-user').id;
      let t0 = Date.now();
      const children: string[] = [];
      for (let i = 0; i < THOUGHTS; i++) {
        const child = createThought(ndb, { title: `Мысль ${i}` }, 'perf-user');
        createLink(ndb, { source_id: homeId, target_id: child.id }, 'perf-user');
        children.push(child.id);
      }
      const bulkCreateMs = Date.now() - t0;
      assert.ok(bulkCreateMs < CEIL.bulkCreate, `bulk create took ${bulkCreateMs}ms`);

      let chainParent = children[0] as string;
      for (let i = 0; i < 50; i++) {
        const next = createThought(ndb, { title: `Цепочка ${i}` }, 'perf-user');
        createLink(ndb, { source_id: chainParent, target_id: next.id }, 'perf-user');
        chainParent = next.id;
      }

      // Comment index for search.
      createComment(
        ndb,
        'thought',
        children[0] as string,
        { kind: 'permanent', body_md: 'уникальныймаркер для поиска' },
        'perf-user',
      );

      // Focus: children of HOME with default sort (bounded to the default limit).
      t0 = Date.now();
      const focusRes = focus(ndb, 'perf-user', homeId, { showInactive: true });
      const focusMs = Date.now() - t0;
      assert.ok(
        focusRes.children.length >= 1 && focusRes.children.length <= 50,
        'default focus limit applied',
      );
      assert.ok(focusMs < CEIL.focus, `focus took ${focusMs}ms`);

      // FTS search over 10k titles + comments.
      t0 = Date.now();
      const found = search(ndb, { q: 'уникальныймаркер' });
      const searchMs = Date.now() - t0;
      assert.ok(found.by_texts.length >= 1, 'comment body is found');
      assert.ok(searchMs < CEIL.search, `search took ${searchMs}ms`);

      // Cycle-safe traversal on the deep chain, bounded.
      t0 = Date.now();
      const walk = traverse(ndb, [homeId], 'children', { maxDepth: 100 });
      const traverseMs = Date.now() - t0;
      assert.ok(walk.ids.length > 100);
      assert.ok(traverseMs < CEIL.traverse, `traverse took ${traverseMs}ms`);

      ndb.close();
    });
  },
);
