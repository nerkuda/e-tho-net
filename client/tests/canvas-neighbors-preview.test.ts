/**
 * Unit tests for the pure helpers behind the canvas ellipse Ctrl-hover
 * neighbours preview (task «Распространить предпросмотр с зажатым Ctrl на
 * эллипсы облачков мыслей», client/src/renderer/lib/pure.ts +
 * client/src/renderer/canvas/canvas.ts's `resolveNeighborsPreview`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  neighborsDirForEllipse,
  neighborsPreviewBounds,
  neighborsPreviewHeading,
  sortRefsByTitle,
} from '../src/renderer/lib/pure.js';

describe('neighborsDirForEllipse (task «Распространить предпросмотр…»)', () => {
  it('top ellipse → parents (incoming links)', () => {
    assert.equal(neighborsDirForEllipse('top'), 'parents');
  });
  it('bottom ellipse → children (outgoing links)', () => {
    assert.equal(neighborsDirForEllipse('bottom'), 'children');
  });
});

describe('neighborsPreviewHeading', () => {
  it('prefixes «Входящие связи» for parents', () => {
    assert.equal(neighborsPreviewHeading('parents', 'Моя мысль'), 'Входящие связи: Моя мысль');
  });
  it('prefixes «Исходящие связи» for children', () => {
    assert.equal(neighborsPreviewHeading('children', 'Моя мысль'), 'Исходящие связи: Моя мысль');
  });
});

describe('neighborsPreviewBounds (70% height / 25% width of the canvas viewport)', () => {
  it('computes 70% height and 25% width, rounded', () => {
    assert.deepEqual(neighborsPreviewBounds({ width: 1200, height: 800 }), {
      maxWidthPx: 300,
      maxHeightPx: 560,
    });
  });
  it('rounds fractional pixels', () => {
    assert.deepEqual(neighborsPreviewBounds({ width: 1001, height: 777 }), {
      maxWidthPx: 250, // 1001*0.25=250.25 -> 250
      maxHeightPx: 544, // 777*0.7=543.9 -> 544
    });
  });
  it('handles a zero-size viewport', () => {
    assert.deepEqual(neighborsPreviewBounds({ width: 0, height: 0 }), {
      maxWidthPx: 0,
      maxHeightPx: 0,
    });
  });
});

describe('sortRefsByTitle (alphabetical ascending, locale-aware)', () => {
  // Cross-script (Cyrillic vs Latin) collation order is environment-dependent
  // (ICU root order), so the assertions stay within one script at a time —
  // what matters here is that `sortRefsByTitle` delegates to `localeCompare`
  // ascending, not a specific cross-script tie-break.
  it('sorts a mixed-case Latin list ascending', () => {
    const refs = [{ title: 'banana' }, { title: 'Arbuz' }, { title: 'apple' }];
    assert.deepEqual(
      sortRefsByTitle(refs).map((r) => r.title),
      ['apple', 'Arbuz', 'banana'],
    );
  });
  it('sorts a Cyrillic list ascending', () => {
    const refs = [{ title: 'Яблоко' }, { title: 'Банан' }, { title: 'Апельсин' }];
    assert.deepEqual(
      sortRefsByTitle(refs).map((r) => r.title),
      ['Апельсин', 'Банан', 'Яблоко'],
    );
  });
  it('does not mutate the input array', () => {
    const refs = [{ title: 'B' }, { title: 'A' }];
    const sorted = sortRefsByTitle(refs);
    assert.notEqual(sorted, refs);
    assert.deepEqual(refs.map((r) => r.title), ['B', 'A']);
  });
  it('returns an empty array unchanged', () => {
    assert.deepEqual(sortRefsByTitle([]), []);
  });
});
