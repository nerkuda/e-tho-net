/**
 * Unit tests for selection-list deduplication (08-ui-spec.md §5.1): add paths
 * must never grow the list with an id it already contains — e.g. a shared
 * parent («Персоны») returned by the neighbours of every selected thought.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addToSelection, toggleSelection } from '../src/renderer/selection/selection.js';
import { store } from '../src/renderer/state.js';

describe('selection deduplication', () => {
  it('addToSelection skips ids already present', () => {
    store.update({ selection: [] });
    addToSelection(['a', 'a', 'b']);
    assert.deepEqual(store.state.selection, ['a', 'b']);
    // A shared parent of several selected thoughts arrives once per thought.
    addToSelection(['b', 'c', 'c', 'b']);
    assert.deepEqual(store.state.selection, ['a', 'b', 'c']);
    // Nothing new → the list (and its order) is untouched.
    addToSelection(['a', 'b', 'c']);
    assert.deepEqual(store.state.selection, ['a', 'b', 'c']);
  });

  it('toggleSelection removes an existing id and re-adds it afterwards', () => {
    store.update({ selection: ['a', 'b'] });
    toggleSelection(['a']);
    assert.deepEqual(store.state.selection, ['b']);
    toggleSelection(['a']);
    assert.deepEqual(store.state.selection, ['b', 'a']);
  });

  it('store.resetNetwork clears the selection', () => {
    store.update({ selection: ['x', 'y'] });
    store.resetNetwork();
    assert.deepEqual(store.state.selection, []);
  });
});
