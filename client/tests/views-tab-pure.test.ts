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
 *   - `planReorder` returns a pair of (moved, neighbour) patches whose
 *     `position` values swap the rows;
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

    it('moves a row up by one (fromIndex < toIndex)', () => {
      const plan = planReorder(list, 2, 1);
      assert.deepEqual(plan, {
        movedId: 'c',
        neighbourId: 'b',
        movedPosition: 20,
        neighbourPosition: 30,
      });
    });

    it('moves a row down by one (fromIndex > toIndex)', () => {
      const plan = planReorder(list, 0, 1);
      assert.deepEqual(plan, {
        movedId: 'a',
        neighbourId: 'b',
        movedPosition: 20,
        neighbourPosition: 10,
      });
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

    it('preserves the visual swap: moved takes neighbour.position, neighbour takes moved.position', () => {
      const plan = planReorder(list, 0, 2);
      assert.equal(plan!.movedId, 'a');
      assert.equal(plan!.neighbourId, 'c');
      assert.equal(plan!.movedPosition, 30);
      assert.equal(plan!.neighbourPosition, 10);
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
});
