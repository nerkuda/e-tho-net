/**
 * Unit tests for the structures tree layout (L15) and the shared keywords
 * mini-syntax parser. Pure Node, no DOM.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLikePattern, parseFilterKeywords } from '@etn/shared';

import {
  branchThoughtIds,
  childKey,
  flattenStructuresTree,
  parentKey,
  subtreeExpansionKeys,
  type ExpansionMap,
  type NeighbourLookup,
} from '../src/renderer/screens/structures/layout.js';

describe('parseFilterKeywords', () => {
  it('splits words, folds exclusions, drops empties and bare dashes', () => {
    assert.deepEqual(parseFilterKeywords('счет*  -вод*  '), {
      include: ['счет*'],
      exclude: ['вод*'],
    });
    assert.deepEqual(parseFilterKeywords('-'), { include: [], exclude: [] });
    assert.deepEqual(parseFilterKeywords(''), { include: [], exclude: [] });
    assert.deepEqual(parseFilterKeywords('a -b c -d'), {
      include: ['a', 'c'],
      exclude: ['b', 'd'],
    });
  });
});

describe('buildLikePattern', () => {
  it('maps * to % and escapes LIKE wildcards and the escape char', () => {
    // The trailing * is redundant inside the %…% wrap but harmless.
    assert.equal(buildLikePattern('счет*'), '%счет%%');
    assert.equal(buildLikePattern('100%'), '%100\\%%');
    assert.equal(buildLikePattern('a_b'), '%a\\_b%');
    assert.equal(buildLikePattern('back\\slash'), '%back\\\\slash%');
    assert.equal(buildLikePattern('сч*тчик'), '%сч%тчик%');
  });
});

describe('flattenStructuresTree', () => {
  /** Fixture: A → {Б, В}; Б → {В, Г} (В appears twice — dedup scenario). */
  const neighbors: Record<string, { parents: string[]; children: string[] }> = {
    a: { parents: [], children: ['b', 'v'] },
    b: { parents: ['a'], children: ['v', 'g'] },
    v: { parents: ['a', 'b'], children: [] },
    g: { parents: ['b'], children: [] },
  };
  const lookup: NeighbourLookup = (_key, thoughtId, dir) => neighbors[thoughtId]?.[dir] ?? [];

  it('lists roots without expansion', () => {
    const rows = flattenStructuresTree(['a', 'x'], new Map(), lookup);
    assert.deepEqual(
      rows.map((r) => [r.thoughtId, r.indent, r.via]),
      [
        ['a', 0, null],
        ['x', 0, null],
      ],
    );
    assert.deepEqual(
      rows.map((r) => r.root),
      [true, true],
    );
  });

  it('flags only the filter-result rows as roots', () => {
    const expansion: ExpansionMap = new Map([['a', { children: true }]]);
    const rows = flattenStructuresTree(['a'], expansion, lookup);
    assert.deepEqual(
      rows.map((r) => r.root),
      [true, false, false],
    );
  });

  it('emits children below the node with indent + 1 and a child via', () => {
    const expansion: ExpansionMap = new Map([['a', { children: true }]]);
    const rows = flattenStructuresTree(['a'], expansion, lookup);
    assert.deepEqual(
      rows.map((r) => [r.key, r.thoughtId, r.indent, r.via?.role ?? null]),
      [
        ['a', 'a', 0, null],
        [childKey('a', 'b'), 'b', 1, 'child'],
        [childKey('a', 'v'), 'v', 1, 'child'],
      ],
    );
  });

  it('emits parents above the node; the node and its subtree shift right', () => {
    // In real flow the server drops branch repeats via exclude_ids, so the
    // parents list of the nested b contains only fresh thoughts — modelled
    // here with an outside parent p.
    const lookupKeyed: NeighbourLookup = (key, thoughtId, dir) => {
      if (key === childKey('a', 'b') && dir === 'parents') return ['p'];
      return lookup(key, thoughtId, dir);
    };
    const expansion: ExpansionMap = new Map([
      ['a', { children: true }],
      [childKey('a', 'b'), { parents: true, children: true }],
    ]);
    const rows = flattenStructuresTree(['a'], expansion, lookupKeyed);
    assert.deepEqual(
      rows.map((r) => [r.key, r.indent, r.via?.role ?? null]),
      [
        ['a', 0, null],
        // The fresh parent p sits above b at b's original indent…
        [parentKey(childKey('a', 'b'), 'p'), 1, 'parent'],
        // …then b shifted to 2…
        [childKey('a', 'b'), 2, 'child'],
        // …and its children at 3.
        [childKey(childKey('a', 'b'), 'v'), 3, 'child'],
        [childKey(childKey('a', 'b'), 'g'), 3, 'child'],
        // v stays a direct child of a at 1.
        [childKey('a', 'v'), 1, 'child'],
      ],
    );
  });

  it('marks each row with its root branch (per-branch dedup scope)', () => {
    const expansion: ExpansionMap = new Map([['a', { children: true }]]);
    const rows = flattenStructuresTree(['a', 'b'], expansion, lookup);
    for (const row of rows) {
      if (row.thoughtId === 'b' && row.rootId === 'a') continue;
      if (row.thoughtId === 'b') assert.equal(row.rootId, 'b');
    }
    // The same thought b appears in both branches when both are roots.
    assert.equal(rows.filter((r) => r.thoughtId === 'b').length, 2);
  });
});

describe('branchThoughtIds / subtreeExpansionKeys', () => {
  it('collects the ids of one root branch only', () => {
    const rows = flattenStructuresTree(
      ['a', 'b'],
      new Map([
        ['a', { children: true }],
        ['b', { children: true }],
      ]),
      (_key, id, dir) => (dir === 'children' ? (id === 'a' ? ['v'] : ['g']) : []),
    );
    const aIds = branchThoughtIds(rows, 'a');
    assert.deepEqual(aIds.sort(), ['a', 'v']);
  });

  it('subtree keys include the node and everything nested under it', () => {
    const expansion: ExpansionMap = new Map([
      ['a', { children: true }],
      [childKey('a', 'b'), { children: true }],
      [childKey(childKey('a', 'b'), 'g'), { parents: true }],
      ['x', { children: true }],
    ]);
    const keys = subtreeExpansionKeys('a', expansion);
    assert.deepEqual(keys.sort(), ['a', 'a/b', 'a/b/g'].sort());
  });
});
