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
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createThought, focus } from '../src/domain/thought-service.js';
import { createLink } from '../src/domain/link-service.js';
import { findBlockingDuplicate, findDuplicates, search } from '../src/domain/search-service.js';
import { traverse } from '../src/domain/graph-traversal.js';
import { createComment } from '../src/domain/comment-service.js';
import { writeThoughts } from '../src/domain/thought-write-service.js';

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
  // Duplicate-gate smoke (ошибки 646347ab / 9f4c0793 / 5e35eb7b): the old
  // behaviour measured ~1.4 s per findDuplicates and ~36 s per 12-item batch on
  // this wildcard profile; the ceilings catch its return, not micro-regressions.
  //
  // One call is not enough to judge the gate (ошибка 7ca41e5b): the FIRST call
  // pays a one-time warm-up of the per-pattern wildcard matchers (the first
  // execution of thousands of distinct RegExp sources), later calls run warm.
  // Two ceilings make the smoke load-tolerant without losing sensitivity.
  //
  // Cold call (process just paid that warm-up). Measured 2026-11-11 on this
  // profile (8000 thoughts + 4000 `*`-synonyms): ~790 ms idle, 1887/2114/2170 ms
  // in full parallel server runs (two suites at once — where the old 1500 ms
  // ceiling flaked). 4 s ≈ 1.8x the worst observation and still catches a
  // blow-up of the one-time cost.
  findDuplicatesCold: 4_000,
  // Steady state — the real per-request cost of the gate, which is what a
  // regression of the guarded class (~1.4 s PER CALL) would inflate. Measured
  // 2026-11-11 as the median of 5 calls: ~23 ms idle, 95–193 ms under two
  // parallel full runs (single spikes up to 645 ms). 500 ms keeps >2.5x margin
  // under that load and stays 2.8x below the old per-call behaviour.
  findDuplicatesSteady: 500,
  blockingGate: 200,
  writeBatch: 10_000,
} as const;

/** Median of the samples — the load-tolerant aggregate of a repeated measure. */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2)
    : (sorted[middle] as number);
}

/** Wildcard-heavy profile of the duplicate-gate smoke (large-network shape). */
const DUP_THOUGHTS = 8_000;
const DUP_WILDCARDS = 4_000;

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

    it('wildcard-heavy network: duplicate gate and write batch stay cheap', () => {
      const ndb: NetworkDb = createInMemoryNetworkDb();
      const insThought = ndb.prepare(
        `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                               version, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
      );
      const insSynonym = ndb.prepare(
        'INSERT OR IGNORE INTO thought_synonyms (thought_id, synonym, synonym_norm) VALUES (?, ?, ?)',
      );
      ndb.transaction(() => {
        const ids: string[] = [];
        for (let i = 0; i < DUP_THOUGHTS; i++) {
          const id = randomUUID();
          const title = `Мысль номер ${i}`;
          insThought.run(id, title, title.toLowerCase());
          ids.push(id);
        }
        for (let i = 0; i < DUP_WILDCARDS; i++) {
          const synonym = `терм${i}*`;
          insSynonym.run(ids[i % ids.length] as string, synonym, synonym.toLowerCase());
        }
      });

      // The full heavy duplicate scan (used once per new batch item for
      // `duplicate_candidates`): the correlated-EXISTS partial scan and the
      // per-pattern regex compilation must not come back. The first call also
      // pays the one-time matcher warm-up (a cost of its own class), so the cold
      // call and the steady state are judged separately (ошибка 7ca41e5b): a
      // single fixed number either flaked under parallel load or went slack. A
      // per-call regression inflates the STEADY median — the cold ceiling cannot
      // hide it.
      let t0 = Date.now();
      findDuplicates(ndb, 'какой-то заголовок');
      const dupColdMs = Date.now() - t0;
      assert.ok(
        dupColdMs < CEIL.findDuplicatesCold,
        `first findDuplicates (cold: one-time matcher warm-up) took ${dupColdMs}ms`,
      );

      const dupSamples: number[] = [];
      for (let i = 0; i < 5; i++) {
        t0 = Date.now();
        findDuplicates(ndb, 'какой-то заголовок');
        dupSamples.push(Date.now() - t0);
      }
      const dupMs = median(dupSamples);
      assert.ok(
        dupMs < CEIL.findDuplicatesSteady,
        `findDuplicates took ${dupMs}ms (median of 5: ${dupSamples.join('/')})`,
      );

      // The blocking gate is two indexed point lookups, independent of the
      // wildcard volume.
      t0 = Date.now();
      assert.equal(findBlockingDuplicate(ndb, 'несуществующее название', null), undefined);
      const gateMs = Date.now() - t0;
      assert.ok(gateMs < CEIL.blockingGate, `blocking gate took ${gateMs}ms`);

      // A 12-item `etn.thoughts.write` batch: one heavy scan per item and a
      // cheap gate, no second heavy scan.
      const input = {
        thoughts: Array.from({ length: 12 }, (_, k) => ({
          ref: `r${k}`,
          thought: { title: `Батчевая мысль ${k}` },
        })),
      } as unknown as Parameters<typeof writeThoughts>[1];
      t0 = Date.now();
      const batch = writeThoughts(ndb, input, 'perf-user');
      const batchMs = Date.now() - t0;
      assert.equal(batch.items.length, 12);
      assert.ok(batchMs < CEIL.writeBatch, `12-item write batch took ${batchMs}ms`);

      ndb.close();
    });
  },
);
