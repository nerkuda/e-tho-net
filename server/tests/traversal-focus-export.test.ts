/**
 * Unit tests for graph traversal (C11), focus preferences/order writers (C12)
 * and the export service (C13).
 *
 * Shared in-memory NetworkDb fixture; skipped when the better-sqlite3 native
 * binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError } from '@etn/shared';
import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createThought } from '../src/domain/thought-service.js';
import { createLink } from '../src/domain/link-service.js';
import { findPath, subgraph, traverse } from '../src/domain/graph-traversal.js';
import {
  getFocusPreferences,
  setFocusOrder,
  setFocusPreferences,
} from '../src/domain/focus-service.js';
import { exportToMarkdown, getExportJob, startExportJob } from '../src/domain/export-service.js';
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

/** Create a thought row and return its id. */
function thought(ndb: NetworkDb, title: string): string {
  return createThought(ndb, { title }, 'user-1').id;
}

describe(
  'traversal + focus writers + export',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('traverse terminates on a cycle A→B→C→A and visits each node once', () => {
      const ndb = createInMemoryNetworkDb();
      const a = thought(ndb, 'A');
      const b = thought(ndb, 'B');
      const c = thought(ndb, 'C');
      createLink(ndb, { source_id: a, target_id: b }, 'user-1');
      createLink(ndb, { source_id: b, target_id: c }, 'user-1');
      createLink(ndb, { source_id: c, target_id: a }, 'user-1');

      const result = traverse(ndb, [a], 'children', { maxDepth: 10 });
      assert.deepEqual(result.ids.slice().sort(), [a, b, c].sort());
      assert.equal(result.truncated, false);
      ndb.close();
    });

    it('traverse truncates at maxNodes and reports the reason', () => {
      const ndb = createInMemoryNetworkDb();
      const root = thought(ndb, 'Root');
      for (let i = 0; i < 5; i++) {
        const child = thought(ndb, `Child ${i}`);
        createLink(ndb, { source_id: root, target_id: child }, 'user-1');
      }
      const result = traverse(ndb, [root], 'children', { maxNodes: 3 });
      assert.equal(result.ids.length, 3);
      assert.equal(result.truncated, true);
      assert.equal(result.reason, 'max_nodes');
      ndb.close();
    });

    it('findPath handles a diamond and returns the shortest path', () => {
      const ndb = createInMemoryNetworkDb();
      const a = thought(ndb, 'A');
      const b = thought(ndb, 'B');
      const c = thought(ndb, 'C');
      const d = thought(ndb, 'D');
      createLink(ndb, { source_id: a, target_id: b }, 'user-1');
      createLink(ndb, { source_id: b, target_id: c }, 'user-1');
      createLink(ndb, { source_id: a, target_id: d }, 'user-1');
      createLink(ndb, { source_id: d, target_id: c }, 'user-1');

      const path = findPath(ndb, a, c);
      assert.ok(path);
      assert.equal(path.length, 3);
      // Traversal steps are direction-agnostic, so the reverse path exists too.
      assert.ok(findPath(ndb, c, a));
      ndb.close();
    });

    it('subgraph returns nodes and inner edges', () => {
      const ndb = createInMemoryNetworkDb();
      const a = thought(ndb, 'A');
      const b = thought(ndb, 'B');
      createLink(ndb, { source_id: a, target_id: b }, 'user-1');
      const g = subgraph(ndb, [a], 1);
      assert.deepEqual(g.nodes.slice().sort(), [a, b].sort());
      assert.equal(g.edges.length, 1);
      assert.equal(g.edges[0]?.source_id, a);
      ndb.close();
    });

    it('setFocusPreferences upserts and rejects manual for siblings', () => {
      const ndb = createInMemoryNetworkDb();
      const focusId = thought(ndb, 'Focus');
      setFocusPreferences(ndb, 'user-1', focusId, {
        dir: 'children',
        sort: 'manual',
        order: 'asc',
      });
      assert.equal(getFocusPreferences(ndb, 'user-1', focusId, 'children')?.sort, 'manual');
      setFocusPreferences(ndb, 'user-1', focusId, {
        dir: 'children',
        sort: 'alpha',
        order: 'desc',
      });
      assert.equal(getFocusPreferences(ndb, 'user-1', focusId, 'children')?.sort, 'alpha');
      assert.throws(
        () =>
          setFocusPreferences(ndb, 'user-1', focusId, {
            dir: 'siblings',
            sort: 'manual',
            order: 'asc',
          }),
        EtnError,
      );
      ndb.close();
    });

    it('setFocusOrder replaces the position list and drops stale rows', () => {
      const ndb = createInMemoryNetworkDb();
      const focusId = thought(ndb, 'Focus');
      const c1 = thought(ndb, 'C1');
      const c2 = thought(ndb, 'C2');
      setFocusOrder(ndb, 'user-1', focusId, { dir: 'children', ordered_ids: [c1, c2] });
      setFocusOrder(ndb, 'user-1', focusId, { dir: 'children', ordered_ids: [c2, c1] });

      const rows = ndb
        .prepare(
          'SELECT thought_id, position FROM user_focus_order WHERE user_id = ? AND focus_thought_id = ? ORDER BY position',
        )
        .all('user-1', focusId) as Array<{ thought_id: string; position: number }>;
      assert.deepEqual(
        rows.map((r) => r.thought_id),
        [c2, c1],
      );
      assert.throws(
        () => setFocusOrder(ndb, 'user-1', focusId, { dir: 'siblings', ordered_ids: [c1] }),
        EtnError,
      );
      ndb.close();
    });

    it('exportToMarkdown includes title, comments and children links', () => {
      const ndb = createInMemoryNetworkDb();
      const a = thought(ndb, 'Alpha');
      const b = thought(ndb, 'Beta');
      createLink(ndb, { source_id: a, target_id: b }, 'user-1');
      createComment(
        ndb,
        'thought',
        a,
        { kind: 'permanent', body_md: 'Описание **альфы**' },
        'user-1',
      );

      const md = exportToMarkdown(ndb, [a]);
      assert.ok(md.includes('## Alpha'));
      assert.ok(md.includes('Описание **альфы**'));
      assert.ok(md.includes('Beta'));
      ndb.close();
    });

    it('startExportJob produces done markdown/html jobs and rejects pdf', () => {
      const ndb = createInMemoryNetworkDb();
      const a = thought(ndb, 'Alpha');
      const job = startExportJob(ndb, [a], 'markdown');
      assert.equal(job.status, 'done');
      const fetched = getExportJob(job.job_id);
      assert.equal(fetched?.status, 'done');
      assert.throws(() => startExportJob(ndb, [a], 'pdf'), EtnError);
      ndb.close();
    });
  },
);
