/**
 * Unit tests for the read-metrics domain service (workplan task O10,
 * docs/05-mcp-server.md §5.1, docs/02-data-model.md §3.13).
 *
 * Server-side DB tests are skipped under `node --test` when the native
 * `better-sqlite3` binding is unavailable (AGENTS.md §10) — the assertions
 * below run under the real DB in production and CI.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  READ_METRICS_DEFAULT_LIMIT,
  clampReadMetricsParams,
  getColdReads,
  getTopReads,
  recordReads,
} from '../src/domain/read-metrics-service.js';

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

/** Seed a thought with a controlled updated_at so the cold ordering is stable. */
function seedThought(
  ndb: NetworkDb,
  title: string,
  opts: { active?: boolean; updatedAt?: string } = {},
): string {
  const id = randomUUID();
  const ts = opts.updatedAt ?? '2026-08-22T00:00:00.000Z';
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             type_id, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 0, 0, NULL, 1, ?, 'u', ?, 'u')`,
    )
    .run(id, title, title.toLowerCase(), opts.active === false ? 0 : 1, ts, ts);
  return id;
}

describe(
  'read-metrics-service',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    describe('recordReads', () => {
      it('inserts a fresh row with count=1 and stamps both timestamps', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const id = seedThought(ndb, 'alpha');
          const now = '2026-08-22T10:00:00.000Z';
          recordReads(ndb, [id], { now });

          const row = ndb
            .prepare(
              'SELECT reads_count, first_read_at, last_read_at FROM thought_read_metrics WHERE thought_id = ?',
            )
            .get(id) as { reads_count: number; first_read_at: string; last_read_at: string };
          assert.equal(row.reads_count, 1);
          assert.equal(row.first_read_at, now);
          assert.equal(row.last_read_at, now);
        } finally {
          ndb.close();
        }
      });

      it('bumps count and refreshes last_read_at but never rewrites first_read_at', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const id = seedThought(ndb, 'alpha');
          const first = '2026-08-22T10:00:00.000Z';
          const second = '2026-08-22T11:00:00.000Z';
          recordReads(ndb, [id], { now: first });
          recordReads(ndb, [id], { now: second });

          const row = ndb
            .prepare(
              'SELECT reads_count, first_read_at, last_read_at FROM thought_read_metrics WHERE thought_id = ?',
            )
            .get(id) as { reads_count: number; first_read_at: string; last_read_at: string };
          assert.equal(row.reads_count, 2);
          assert.equal(row.first_read_at, first);
          assert.equal(row.last_read_at, second);
        } finally {
          ndb.close();
        }
      });

      it('de-duplicates ids before the batched UPSERT so the count moves once', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const id = seedThought(ndb, 'alpha');
          const now = '2026-08-22T10:00:00.000Z';
          recordReads(ndb, [id, id, id], { now });

          const row = ndb
            .prepare('SELECT reads_count FROM thought_read_metrics WHERE thought_id = ?')
            .get(id) as { reads_count: number };
          assert.equal(row.reads_count, 1);
        } finally {
          ndb.close();
        }
      });

      it('silently skips unknown ids (no row, no error)', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const id = seedThought(ndb, 'alpha');
          const now = '2026-08-22T10:00:00.000Z';
          recordReads(ndb, [id, randomUUID(), randomUUID()], { now });

          const row = ndb
            .prepare('SELECT reads_count FROM thought_read_metrics WHERE thought_id = ?')
            .get(id) as { reads_count: number };
          assert.equal(row.reads_count, 1);
          const total = (ndb.prepare('SELECT COUNT(*) AS c FROM thought_read_metrics').get() as {
            c: number;
          }).c;
          assert.equal(total, 1);
        } finally {
          ndb.close();
        }
      });

      it('is a no-op for an empty id list', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const now = '2026-08-22T10:00:00.000Z';
          recordReads(ndb, [], { now });
          const total = (ndb.prepare('SELECT COUNT(*) AS c FROM thought_read_metrics').get() as {
            c: number;
          }).c;
          assert.equal(total, 0);
        } finally {
          ndb.close();
        }
      });
    });

    describe('getTopReads', () => {
      it('returns the highest-count thoughts, ties broken by last_read_at desc', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const a = seedThought(ndb, 'A', { updatedAt: '2026-08-20T00:00:00.000Z' });
          const b = seedThought(ndb, 'B', { updatedAt: '2026-08-21T00:00:00.000Z' });
          const c = seedThought(ndb, 'C', { updatedAt: '2026-08-22T00:00:00.000Z' });

          // a: 3 reads, last at t1; b: 3 reads, last at t2 (t2 > t1); c: 1 read.
          recordReads(ndb, [a, b], { now: '2026-08-22T08:00:00.000Z' });
          recordReads(ndb, [a, b], { now: '2026-08-22T09:00:00.000Z' });
          recordReads(ndb, [a, b], { now: '2026-08-22T10:00:00.000Z' });
          recordReads(ndb, [a], { now: '2026-08-22T11:00:00.000Z' }); // a wins tie
          recordReads(ndb, [c], { now: '2026-08-22T07:00:00.000Z' });

          const top = getTopReads(ndb, { limit: 5 });
          assert.deepEqual(
            top.map((row) => row.thought_id),
            [a, b, c],
          );
          assert.equal(top[0]?.reads_count, 4);
          assert.equal(top[1]?.reads_count, 3);
          assert.equal(top[2]?.reads_count, 1);
        } finally {
          ndb.close();
        }
      });

      it('respects the limit and the include_inactive toggle', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const active = seedThought(ndb, 'active', { active: true });
          const inactive = seedThought(ndb, 'inactive', { active: false });
          recordReads(ndb, [active, inactive], { now: '2026-08-22T10:00:00.000Z' });

          const onlyActive = getTopReads(ndb, { limit: 10 });
          assert.deepEqual(
            onlyActive.map((row) => row.thought_id),
            [active],
          );

          const all = getTopReads(ndb, { limit: 10, includeInactive: true });
          assert.equal(all.length, 2);
        } finally {
          ndb.close();
        }
      });
    });

    describe('getColdReads', () => {
      it('returns never-read thoughts ordered by updated_at desc', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const stale = seedThought(ndb, 'stale', { updatedAt: '2026-08-01T00:00:00.000Z' });
          const fresh = seedThought(ndb, 'fresh', { updatedAt: '2026-08-22T00:00:00.000Z' });
          const hot = seedThought(ndb, 'hot', { updatedAt: '2026-08-15T00:00:00.000Z' });
          recordReads(ndb, [hot], { now: '2026-08-22T10:00:00.000Z' });

          const cold = getColdReads(ndb, { limit: 10 });
          assert.deepEqual(
            cold.map((row) => row.thought_id),
            [fresh, stale],
          );
          assert.equal(cold[0]?.reads_count, 0);
          assert.equal(cold[0]?.first_read_at, null);
          assert.equal(cold[0]?.last_read_at, null);
        } finally {
          ndb.close();
        }
      });

      it('honours `since` by surfacing thoughts not read since the cutoff', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const old = seedThought(ndb, 'old', { updatedAt: '2026-08-15T00:00:00.000Z' });
          const recent = seedThought(ndb, 'recent', { updatedAt: '2026-08-20T00:00:00.000Z' });
          const never = seedThought(ndb, 'never', { updatedAt: '2026-08-22T00:00:00.000Z' });

          recordReads(ndb, [old], { now: '2026-08-10T00:00:00.000Z' });
          recordReads(ndb, [recent], { now: '2026-08-21T00:00:00.000Z' });

          // Cutoff is 2026-08-15: `old` was last touched before it; `recent` was
          // touched after; `never` has no row at all.
          const cold = getColdReads(ndb, { limit: 10, since: '2026-08-15T00:00:00.000Z' });
          assert.deepEqual(
            cold.map((row) => row.thought_id),
            [never, old],
          );
        } finally {
          ndb.close();
        }
      });

      it('returns the empty list when every thought has been read recently', () => {
        const ndb = createInMemoryNetworkDb();
        try {
          const a = seedThought(ndb, 'A');
          recordReads(ndb, [a], { now: '2026-08-22T10:00:00.000Z' });
          const cold = getColdReads(ndb, { limit: 10, since: '2026-08-01T00:00:00.000Z' });
          assert.deepEqual(cold, []);
        } finally {
          ndb.close();
        }
      });
    });

    describe('clampReadMetricsParams', () => {
      it('defaults kind to "top" and limit to the canonical default', () => {
        const out = clampReadMetricsParams({});
        assert.equal(out.kind, 'top');
        assert.equal(out.limit, READ_METRICS_DEFAULT_LIMIT);
      });

      it('clamps the requested limit into [1, 200]', () => {
        assert.equal(clampReadMetricsParams({ limit: 0 }).limit, 1);
        assert.equal(clampReadMetricsParams({ limit: 999 }).limit, 200);
        assert.equal(clampReadMetricsParams({ limit: 7 }).limit, 7);
      });
    });
  },
);
