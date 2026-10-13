/**
 * Unit tests for the screen-aware thought copy source (bug 00275531):
 * Ctrl+C/V must copy the thought SELECTED ON THE CURRENT SCREEN, not the one
 * focused on the map. The pure resolver decides the priority per view; the
 * per-screen provider registry lets each thought screen report its selection.
 *
 * Contract (08-ui-spec.md, error 00275531):
 *  - view `structures` → the thought selected on that screen (map ignored);
 *  - view `map`        → the canvas cursor, else the canvas focus;
 *  - views without thoughts (chronicle / activity / publications) → `null`
 *    (native copy runs, no thought is copied).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  resolveThoughtCopyTarget,
  screenThoughtSource,
  setScreenThoughtSource,
} from '../src/renderer/lib/screen-thought-source.js';

describe('resolveThoughtCopyTarget — bug 00275531', () => {
  it('structures: the screen selection wins over the map cursor/focus', () => {
    assert.equal(
      resolveThoughtCopyTarget({ view: 'structures', screenId: 'sel', cursorId: 'cur', focusId: 'foc' }),
      'sel',
    );
    // No selection on the screen → nothing to copy even if the map has focus.
    assert.equal(
      resolveThoughtCopyTarget({ view: 'structures', screenId: null, cursorId: 'cur', focusId: 'foc' }),
      null,
    );
  });

  it('map: cursor wins over focus, both ignored when absent', () => {
    assert.equal(
      resolveThoughtCopyTarget({ view: 'map', screenId: 'sel', cursorId: 'cur', focusId: 'foc' }),
      'cur',
    );
    assert.equal(
      resolveThoughtCopyTarget({ view: 'map', screenId: null, cursorId: null, focusId: 'foc' }),
      'foc',
    );
    assert.equal(
      resolveThoughtCopyTarget({ view: 'map', screenId: 'sel', cursorId: null, focusId: null }),
      null,
    );
  });

  it('screens without thoughts never return a thought', () => {
    for (const view of ['chronicle', 'activity', 'publications'] as const) {
      assert.equal(
        resolveThoughtCopyTarget({ view, screenId: 'sel', cursorId: 'cur', focusId: 'foc' }),
        null,
        `${view} must not copy a thought`,
      );
    }
  });
});

describe('screenThoughtSource registry', () => {
  afterEach(() => setScreenThoughtSource('structures', null));

  it('returns the registered provider and forgets it on unregister', () => {
    assert.equal(screenThoughtSource('structures'), undefined);
    const provider = (): string | null => 'x1';
    setScreenThoughtSource('structures', provider);
    assert.equal(screenThoughtSource('structures')?.(), 'x1');
    setScreenThoughtSource('structures', null);
    assert.equal(screenThoughtSource('structures'), undefined);
  });
});
