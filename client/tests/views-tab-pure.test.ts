/**
 * Tests for the «Отборы» tab pure helpers (задача b8301c16, требование
 * 344b8798, 0.7.3).
 *
 * The helpers live in `views-tab-pure.ts` because the DOM-bound
 * `views-tab.ts` pulls in IPC, the realtime bridge and the dialog
 * module — too heavy for the unit test runner. The pure module only
 * needs the shape of `ThoughtTypeView` from `@etn/shared`, so the
 * assertions here exercise the contract the DOM layer relies on.
 *
 * Covered behaviours:
 *   - `sortViewsByPosition` is stable and orders by `position` ascending,
 *     with id as a deterministic tiebreaker;
 *   - `planReorder` re-numbers the list to `0..n-1` in the post-move order
 *     and returns patches for every row whose `position` changes (for a
 *     canonical `0..n-1` list that is just the swapped pair);
 *   - `planReorder` returns `null` for out-of-range and no-op moves;
 *   - `planSetDefault` / `planClearDefault` short-circuit when the target
 *     already (or does not yet) carry the mark;
 *   - `ownViewsOf` keeps only entries whose `thought_type_id` matches.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ThoughtTypeView } from '@etn/shared';

import {
  applyViewUpdates,
  ownViewsOf,
  planClearDefault,
  planReorder,
  planSetDefault,
  sortViewsByPosition,
} from '../src/renderer/screens/thought-type/views-tab-pure.js';

const TYPE_A = '00000000-0000-4000-8000-aaaaaaaaaaaa';
const TYPE_B = '00000000-0000-4000-8000-bbbbbbbbbbbb';

function view(
  id: string,
  position: number,
  thought_type_id = TYPE_A,
  is_default = false,
): ThoughtTypeView {
  return {
    id,
    thought_type_id,
    name: `view-${id}`,
    name_key: `view-${id}`,
    description: null,
    definition: '{"sort":"created","order":"asc"}',
    position,
    is_default,
    version: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: '00000000-0000-4000-8000-000000000001',
  };
}

describe('thought-type editor — views-tab pure helpers (задача b8301c16)', () => {
  describe('sortViewsByPosition', () => {
    it('orders by `position` ascending', () => {
      const sorted = sortViewsByPosition([
        view('c', 30),
        view('a', 10),
        view('b', 20),
      ]);
      assert.deepEqual(
        sorted.map((v) => v.id),
        ['a', 'b', 'c'],
      );
    });

    it('uses id as a deterministic tiebreaker', () => {
      // Same `position` should sort by id ascending — keeps the order
      // stable between reloads when the server returns rows in a
      // different physical order.
      const sorted = sortViewsByPosition([
        view('b', 10),
        view('a', 10),
        view('c', 10),
      ]);
      assert.deepEqual(
        sorted.map((v) => v.id),
        ['a', 'b', 'c'],
      );
    });

    it('does not mutate the input array', () => {
      const input = [view('c', 30), view('a', 10)];
      const snapshot = [...input];
      sortViewsByPosition(input);
      assert.deepEqual(input, snapshot);
    });

    it('handles an empty list', () => {
      assert.deepEqual(sortViewsByPosition([]), []);
    });
  });

  describe('planReorder', () => {
    const list = [view('a', 10), view('b', 20), view('c', 30)];

    it('re-numbers the whole list after moving a row up by one', () => {
      // c(30) → позиция b: порядок [a, c, b] получает позиции 0,1,2 —
      // меняются все строки, потому что старые позиции не были 0..n-1.
      const plan = planReorder(list, 2, 1);
      assert.deepEqual(plan, [
        { id: 'a', position: 0 },
        { id: 'c', position: 1 },
        { id: 'b', position: 2 },
      ]);
    });

    it('for a canonical 0..n-1 list only the swapped pair changes', () => {
      const canonical = [view('a', 0), view('b', 1), view('c', 2)];
      const plan = planReorder(canonical, 0, 1);
      assert.deepEqual(plan, [
        { id: 'b', position: 0 },
        { id: 'a', position: 1 },
      ]);
    });

    it('breaks duplicated positions (legacy position=0 state) instead of a no-op swap', () => {
      // Все отборы создавались без position и лежат с position=0: простой
      // обмен 0↔0 порядок не менял (ошибка a62190d1). Перенумерация
      // фиксирует видимый порядок списка.
      const duplicated = [view('a', 0), view('b', 0), view('c', 0)];
      const plan = planReorder(duplicated, 1, 2);
      assert.deepEqual(plan, [
        { id: 'c', position: 1 },
        { id: 'b', position: 2 },
      ]);
      // applyViewUpdates по плану даёт новый видимый порядок [a, c, b].
      const next = sortViewsByPosition(applyViewUpdates(duplicated, plan!));
      assert.deepEqual(
        next.map((v) => v.id),
        ['a', 'c', 'b'],
      );
    });

    it('returns null when fromIndex === toIndex (no-op)', () => {
      assert.equal(planReorder(list, 1, 1), null);
    });

    it('returns null when fromIndex is out of range', () => {
      assert.equal(planReorder(list, -1, 0), null);
      assert.equal(planReorder(list, 3, 0), null);
    });

    it('returns null when toIndex is out of range', () => {
      assert.equal(planReorder(list, 0, -1), null);
      assert.equal(planReorder(list, 0, 3), null);
    });

    it('keeps a single-row list intact (no patches)', () => {
      assert.equal(planReorder([view('a', 0)], 0, 0), null);
    });
  });

  describe('planSetDefault / planClearDefault', () => {
    it('plans set-default for a view that does not yet carry the mark', () => {
      const list = [view('a', 10, TYPE_A, false), view('b', 20, TYPE_A, false)];
      assert.deepEqual(planSetDefault(list, 'b'), { id: 'b', is_default: true });
    });

    it('short-circuits when the target is already the default', () => {
      const list = [view('a', 10, TYPE_A, true)];
      assert.equal(planSetDefault(list, 'a'), null);
    });

    it('plans clear-default for a view that carries the mark', () => {
      const list = [view('a', 10, TYPE_A, true)];
      assert.deepEqual(planClearDefault(list, 'a'), { id: 'a', is_default: false });
    });

    it('short-circuits when the target is not the default', () => {
      const list = [view('a', 10, TYPE_A, false)];
      assert.equal(planClearDefault(list, 'a'), null);
    });

    it('returns null for an unknown id', () => {
      assert.equal(planSetDefault([view('a', 10, TYPE_A, false)], 'missing'), null);
      assert.equal(planClearDefault([view('a', 10, TYPE_A, true)], 'missing'), null);
    });
  });

  describe('ownViewsOf', () => {
    it('keeps only entries whose thought_type_id matches', () => {
      const mixed = [
        view('a1', 0, TYPE_A, false),
        view('a2', 1, TYPE_A, false),
        view('b1', 0, TYPE_B, false),
      ];
      const own = ownViewsOf(mixed, TYPE_A);
      assert.equal(own.length, 2);
      assert.deepEqual(
        own.map((v) => v.id),
        ['a1', 'a2'],
      );
    });

    it('returns an empty array when nothing matches', () => {
      const mixed = [view('b1', 0, TYPE_B, false)];
      assert.deepEqual(ownViewsOf(mixed, TYPE_A), []);
    });
  });

  describe('applyViewUpdates', () => {
    it('replaces matching views with the server response rows', () => {
      const list = [view('a', 10), view('b', 20), view('c', 30)];
      const updates = [
        { ...view('a', 11), version: 2 },
        { ...view('b', 19), version: 2 },
      ];
      const next = applyViewUpdates(list, updates);
      const a = next.find((v) => v.id === 'a')!;
      const b = next.find((v) => v.id === 'b')!;
      const c = next.find((v) => v.id === 'c')!;
      assert.equal(a.version, 2);
      assert.equal(a.position, 11);
      assert.equal(b.version, 2);
      assert.equal(b.position, 19);
      // Untouched row keeps its original position and version.
      assert.equal(c.position, 30);
      assert.equal(c.version, 1);
    });

    it('does not mutate the input list', () => {
      const list = [view('a', 10)];
      const updates = [{ ...view('a', 11), version: 2 }];
      const snapshot = JSON.stringify(list);
      applyViewUpdates(list, updates);
      assert.equal(JSON.stringify(list), snapshot);
    });

    it('returns a shallow copy when no updates are given', () => {
      const list = [view('a', 10)];
      const next = applyViewUpdates(list, []);
      assert.notEqual(next, list);
      assert.deepEqual(next, list);
    });

    it('keeps views whose id has no matching update untouched', () => {
      const list = [view('a', 10), view('b', 20)];
      const updates = [{ ...view('a', 99), version: 5 }];
      const next = applyViewUpdates(list, updates);
      const b = next.find((v) => v.id === 'b')!;
      assert.equal(b.version, 1);
      assert.equal(b.position, 20);
    });
  });
});
