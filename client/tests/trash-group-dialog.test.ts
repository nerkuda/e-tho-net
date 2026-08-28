/**
 * Unit tests for the group-delete dialog model (S13, 08-ui-spec.md §5a.2):
 * the per-row choice defaults, the two mass toggles of the «Переключить:»
 * toolbar and the trash/purge split «Применить» feeds into the batch calls.
 * Pure logic — no DOM required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { trashInternals } from '../src/renderer/trash.js';

const { defaultChoice, applyMassToggle, splitChoice } = trashInternals;

const CHECKS = {
  a: { blocked: false },
  b: { blocked: true }, // used in a thought_ref property — purge impossible
  c: { blocked: false },
};

describe('group-delete dialog model (§5a.2)', () => {
  it('defaults every row to «В корзину» (the safe default)', () => {
    const choice = defaultChoice(['a', 'b', 'c']);
    assert.deepEqual(
      [...choice.entries()].map(([id, purge]) => `${id}:${purge}`),
      ['a:false', 'b:false', 'c:false'],
    );
  });

  it('«все в корзину» resets every row to «В корзину» — blocked included', () => {
    const choice = defaultChoice(['a', 'b', 'c']);
    choice.set('a', true); // user picked «Удалить» for a first
    applyMassToggle(choice, ['a', 'b', 'c'], CHECKS, 'all-trash');
    assert.deepEqual([...choice.values()], [false, false, false]);
  });

  it('«удалять возможное» sets «Удалить» only where blocked=false', () => {
    const choice = defaultChoice(['a', 'b', 'c']);
    applyMassToggle(choice, ['a', 'b', 'c'], CHECKS, 'delete-possible');
    // a and c are deletable; b stays on «В корзину» (blocked).
    assert.equal(choice.get('a'), true);
    assert.equal(choice.get('b'), false, 'a blocked row must stay on «В корзину»');
    assert.equal(choice.get('c'), true);
  });

  it('splitChoice feeds «Применить»: purge rows vs trash rows, order kept', () => {
    const choice = defaultChoice(['a', 'b', 'c']);
    applyMassToggle(choice, ['a', 'b', 'c'], CHECKS, 'delete-possible');
    const { trashIds, purgeIds } = splitChoice(['a', 'b', 'c'], choice);
    assert.deepEqual(trashIds, ['b'], 'only the blocked row goes to op:trash');
    assert.deepEqual(purgeIds, ['a', 'c'], 'unblocked rows go to op:purge');
  });

  it('a missing deletion-check entry reads as unblocked', () => {
    const choice = defaultChoice(['x']);
    applyMassToggle(choice, ['x'], {}, 'delete-possible');
    assert.equal(choice.get('x'), true);
  });
});
