/**
 * Unit tests for the operator list of the structures filter panel.
 *
 * Pure structural check on the exported `OPS_BY_TYPE` map (bug fix 0.6.3):
 * every value type EXCEPT `bool` must offer `not_empty` («заполнено») and
 * `is_empty` («не заполнено») for the presence test of a property. The
 * `bool` type is intentionally excluded — `eq true` / `eq false` already
 * cover the same intent, and a redundant toggle would clutter the small
 * list. The label strings are pinned in Russian: they are part of the
 * user-facing contract of the panel.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OPS_BY_TYPE } from '../src/renderer/screens/structures/filter-panel.js';

describe('OPS_BY_TYPE (structures filter panel)', () => {
  /** Every value type except `bool` must carry the presence-test ops. */
  const presentTypes = ['text', 'url', 'date', 'number', 'thought_ref'] as const;

  for (const valueType of presentTypes) {
    it(`offers «заполнено»/«не заполнено» for ${valueType}`, () => {
      const ops = OPS_BY_TYPE[valueType];
      const notEmpty = ops.find((o) => o.op === 'not_empty');
      const isEmpty = ops.find((o) => o.op === 'is_empty');
      assert.ok(notEmpty, `${valueType} must have a not_empty entry`);
      assert.ok(isEmpty, `${valueType} must have an is_empty entry`);
      assert.equal(notEmpty!.label, 'заполнено');
      assert.equal(isEmpty!.label, 'не заполнено');
    });
  }

  it('bool has no presence-test ops (eq true / eq false already cover it)', () => {
    const ops = OPS_BY_TYPE.bool;
    assert.equal(ops.length, 1, 'bool must keep its single eq entry');
    assert.equal(ops[0]!.op, 'eq');
    assert.equal(ops[0]!.label, 'равно');
    assert.ok(!ops.some((o) => o.op === 'is_empty' || o.op === 'not_empty'));
  });

  it('all entries use a recognised StructurePropertyOp value', () => {
    const seenOps = new Set<string>();
    for (const valueType of Object.keys(OPS_BY_TYPE) as Array<keyof typeof OPS_BY_TYPE>) {
      for (const entry of OPS_BY_TYPE[valueType]) {
        assert.ok(
          ['eq', 'contains', 'gt', 'lt', 'in', 'not_in', 'is_empty', 'not_empty'].includes(
            entry.op,
          ),
          `unknown op ${entry.op} for ${valueType}`,
        );
        assert.ok(entry.label.length > 0, `${valueType}.${entry.op} must have a label`);
        seenOps.add(entry.op);
      }
    }
    // Sanity: every wire operator must actually appear in at least one type —
    // guards against an enum tweak that silently drops a usable operator.
    for (const op of ['eq', 'contains', 'gt', 'lt', 'in', 'not_in', 'is_empty', 'not_empty']) {
      assert.ok(seenOps.has(op), `op ${op} is declared but unused by any value type`);
    }
  });
});
