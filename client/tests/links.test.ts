/**
 * Unit tests for the link-overlay grouping helper
 * (client/src/renderer/canvas/links.ts). The DOM/SVG rendering is covered by
 * manual/E2E checks; this pins down the directed-pair bundling that drives the
 * line-per-pair rendering.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FocusEdge } from '@etn/shared';

import { linksInternals } from '../src/renderer/canvas/links.js';

const { groupBundles } = linksInternals;

function edge(id: string, sourceId: string, targetId: string, typeId: string | null = null): FocusEdge {
  return { id, source_id: sourceId, target_id: targetId, type_id: typeId };
}

describe('groupBundles (link overlay)', () => {
  it('groups edges of the same directed pair into one bundle', () => {
    const bundles = groupBundles([
      edge('l1', 'A', 'B', 't1'),
      edge('l2', 'A', 'B', 't2'),
    ]);
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0]?.key, 'A>B');
    assert.equal(bundles[0]?.sourceId, 'A');
    assert.equal(bundles[0]?.targetId, 'B');
    assert.equal(bundles[0]?.edges.length, 2);
  });

  it('keeps opposite directions as separate bundles', () => {
    const bundles = groupBundles([edge('l1', 'A', 'B'), edge('l2', 'B', 'A')]);
    assert.equal(bundles.length, 2);
    assert.deepEqual(
      bundles.map((b) => b.key).sort(),
      ['A>B', 'B>A'],
    );
  });

  it('one bundle per distinct pair across many edges', () => {
    const bundles = groupBundles([
      edge('l1', 'A', 'B'),
      edge('l2', 'A', 'C'),
      edge('l3', 'A', 'B'),
      edge('l4', 'B', 'A'),
      edge('l5', 'A', 'B'),
    ]);
    // A>B (3), A>C (1), B>A (1)
    const byKey = new Map(bundles.map((b) => [b.key, b.edges.length]));
    assert.equal(byKey.get('A>B'), 3);
    assert.equal(byKey.get('A>C'), 1);
    assert.equal(byKey.get('B>A'), 1);
  });

  it('returns an empty list for no edges', () => {
    assert.deepEqual(groupBundles([]), []);
  });
});
