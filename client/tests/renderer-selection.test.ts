/**
 * Unit tests for selection-list deduplication (08-ui-spec.md §5.1): add paths
 * must never grow the list with an id it already contains — e.g. a shared
 * parent («Персоны») returned by the neighbours of every selected thought.
 * Plus the S13 pruning contract (§5a.2): the delete dialogs never clear the
 * whole list — physically deleted thoughts are removed one by one, the rest
 * (marked included) stay.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addToSelection, removeFromSelection, toggleSelection } from '../src/renderer/selection/selection.js';
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

describe('selection survives deletes (S13, §5a.2)', () => {
  it('removing purged ids keeps the rest of the list — the panel is not cleared', () => {
    // The purge path of the group-delete dialog prunes each deleted id via
    // onThoughtDeleted → this filter; marked thoughts are never removed here.
    store.update({ selection: ['a', 'b', 'c', 'd'] });
    removeFromSelection(['b', 'd']);
    assert.deepEqual(store.state.selection, ['a', 'c']);
  });

  it('removing an absent id is a no-op', () => {
    store.update({ selection: ['a'] });
    removeFromSelection(['zzz']);
    assert.deepEqual(store.state.selection, ['a']);
  });
});
