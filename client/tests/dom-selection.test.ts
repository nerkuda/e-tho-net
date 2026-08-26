/**
 * Unit tests for the text-selection predicate (client/src/renderer/lib/dom.ts).
 *
 * Regression guard for b6690109: Ctrl+C over a text selected inside the
 * comment view mode (non-editable content) must run the native copy, not the
 * global thought-copy handler in app.ts. The handler skips interception
 * exactly when `hasTextSelection` returns true, so the predicate must accept
 * only real, visible, non-empty selections — phantom ranges inside hidden
 * DOM (e.g. the CM6 subtree after a field returns to view mode) must be
 * rejected, otherwise copying thoughts would silently stop working.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasTextSelection, type TextSelectionLike } from '../src/renderer/lib/dom.js';

/** Builds a selection-like stub: `rects` = client rectangles of range 0. */
function sel(
  text: string,
  opts: { collapsed?: boolean; rects?: number; rangeCount?: number } = {},
): TextSelectionLike {
  const rectCount = opts.rects ?? 1;
  return {
    rangeCount: opts.rangeCount ?? 1,
    isCollapsed: opts.collapsed ?? false,
    toString: () => text,
    getRangeAt: () => ({ getClientRects: () => new Array(rectCount) }),
  };
}

describe('hasTextSelection', () => {
  it('accepts a non-empty visible text selection', () => {
    assert.equal(hasTextSelection(sel('выделенный текст')), true);
  });

  it('rejects null and an empty selection (rangeCount 0)', () => {
    assert.equal(hasTextSelection(null), false);
    assert.equal(hasTextSelection(sel('', { rangeCount: 0 })), false);
  });

  it('rejects a collapsed selection (caret, nothing dragged)', () => {
    assert.equal(hasTextSelection(sel('слово', { collapsed: true })), false);
  });

  it('rejects whitespace-only selections (toString has no copyable text)', () => {
    assert.equal(hasTextSelection(sel('   \n\t ')), false);
  });

  it('rejects phantom selections without client rects (hidden DOM, b6690109)', () => {
    // A range can survive in a display:none subtree (the hidden CM6 editor
    // after a markdown field returns to view mode): it has text but no
    // rendered boxes — the thought copy must still run.
    assert.equal(hasTextSelection(sel('скрытый текст', { rects: 0 })), false);
  });
});
