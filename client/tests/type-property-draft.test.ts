/**
 * Unit tests for the staged property-diff planner (client/src/renderer/lib/
 * type-property-draft.ts, task «Улучшить диалог редактирования типов мыслей
 * и связей»): the Apply-time reconciliation of a type editor's local
 * own-properties draft against what the server currently has. Pure logic —
 * no DOM (client tests run without jsdom, per the existing convention).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PropertyDefinition } from '@etn/shared';

import {
  draftPropertiesFrom,
  nextDraftPropertyId,
  planPropertyDiff,
  type DraftProperty,
} from '../src/renderer/lib/type-property-draft.js';

/** Builds a minimal stored property definition for the tests. */
function def(id: string, key: string, extra: Partial<PropertyDefinition> = {}): PropertyDefinition {
  return {
    id,
    owner_type: 'thought_type',
    owner_id: 'type-1',
    key,
    value_type: 'text',
    config: null,
    required: false,
    position: 0,
    description: null,
    ...extra,
  };
}

describe('draftPropertiesFrom', () => {
  it('mirrors stored definitions as non-new draft rows, in the given order', () => {
    const own = [def('p1', 'A'), def('p2', 'B', { value_type: 'number', config: { default_value: 3 } })];
    const draft = draftPropertiesFrom(own);
    assert.deepEqual(draft, [
      { id: 'p1', isNew: false, key: 'A', value_type: 'text', config: null, description: null },
      { id: 'p2', isNew: false, key: 'B', value_type: 'number', config: { default_value: 3 }, description: null },
    ]);
  });

  it('mirrors the stored description into the draft row', () => {
    const own = [def('p1', 'A', { description: 'что значит это свойство' })];
    const draft = draftPropertiesFrom(own);
    assert.equal(draft[0]!.description, 'что значит это свойство');
  });
});

describe('nextDraftPropertyId', () => {
  it('returns distinct placeholder ids that never collide with real UUIDs', () => {
    const a = nextDraftPropertyId();
    const b = nextDraftPropertyId();
    assert.notEqual(a, b);
    assert.ok(a.startsWith('draft:'));
    assert.ok(b.startsWith('draft:'));
  });
});

describe('planPropertyDiff', () => {
  it('empty draft from empty original: no ops, no reorder', () => {
    const plan = planPropertyDiff([], [], []);
    assert.deepEqual(plan.ops, []);
    assert.equal(plan.needsReorder, false);
  });

  it('unchanged draft (matches original exactly): no ops', () => {
    const original = [def('p1', 'A'), def('p2', 'B')];
    const draft = draftPropertiesFrom(original);
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, []);
    assert.equal(plan.needsReorder, false);
  });

  it('a new (staged) property becomes a create op and forces a reorder', () => {
    const original = [def('p1', 'A')];
    const draft: DraftProperty[] = [
      ...draftPropertiesFrom(original),
      { id: 'draft:1', isNew: true, key: 'B', value_type: 'number', config: null, description: null },
    ];
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, [
      { kind: 'create', draftId: 'draft:1', input: { key: 'B', value_type: 'number', config: null, description: null } },
    ]);
    assert.equal(plan.needsReorder, true);
  });

  it('a staged description change becomes an update op with only description', () => {
    const original = [def('p1', 'A', { description: 'старое описание' })];
    const draft: DraftProperty[] = [
      { id: 'p1', isNew: false, key: 'A', value_type: 'text', config: null, description: 'новое описание' },
    ];
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, [{ kind: 'update', id: 'p1', changes: { description: 'новое описание' } }]);
  });

  it('clearing the description is detected (null vs undefined matters not)', () => {
    const original = [def('p1', 'A', { description: 'было' })];
    const draft: DraftProperty[] = [
      { id: 'p1', isNew: false, key: 'A', value_type: 'text', config: null, description: null },
    ];
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, [{ kind: 'update', id: 'p1', changes: { description: null } }]);
  });

  it('a new property staged WITH a description sends it in the create input', () => {
    const draft: DraftProperty[] = [
      { id: 'draft:2', isNew: true, key: 'N', value_type: 'date', config: null, description: 'дата поставки' },
    ];
    const plan = planPropertyDiff([], draft, []);
    assert.deepEqual(plan.ops, [
      { kind: 'create', draftId: 'draft:2', input: { key: 'N', value_type: 'date', config: null, description: 'дата поставки' } },
    ]);
  });

  it('a renamed/retyped existing property becomes an update op with only the changed fields', () => {
    const original = [def('p1', 'A', { value_type: 'text', config: { default_value: 'x' } })];
    const draft: DraftProperty[] = [{ id: 'p1', isNew: false, key: 'A2', value_type: 'text', config: { default_value: 'x' }, description: null }];
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, [{ kind: 'update', id: 'p1', changes: { key: 'A2' } }]);
    assert.equal(plan.needsReorder, false);
  });

  it('a config-only change (e.g. options list) is still detected', () => {
    const original = [def('p1', 'A', { config: { options: ['a', 'b'] } })];
    const draft: DraftProperty[] = [{ id: 'p1', isNew: false, key: 'A', value_type: 'text', config: { options: ['a', 'b', 'c'] }, description: null }];
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, [{ kind: 'update', id: 'p1', changes: { config: { options: ['a', 'b', 'c'] } } }]);
  });

  it('a removed id becomes a delete op, ordered before creates/updates', () => {
    const original = [def('p1', 'A'), def('p2', 'B')];
    const draft: DraftProperty[] = draftPropertiesFrom(original.filter((d) => d.id !== 'p2'));
    const plan = planPropertyDiff(original, draft, ['p2']);
    assert.deepEqual(plan.ops, [{ kind: 'delete', id: 'p2' }]);
    assert.equal(plan.needsReorder, false);
  });

  it('reordering two unchanged rows needs a reorder but no create/update ops', () => {
    const original = [def('p1', 'A'), def('p2', 'B')];
    const draft: DraftProperty[] = draftPropertiesFrom(original).reverse();
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, []);
    assert.equal(plan.needsReorder, true);
  });

  it('a full mixed batch: delete + create + update + reorder', () => {
    const original = [def('p1', 'A'), def('p2', 'B'), def('p3', 'C')];
    const draft: DraftProperty[] = [
      { id: 'p3', isNew: false, key: 'C', value_type: 'text', config: null, description: null }, // moved first
      { id: 'p1', isNew: false, key: 'A renamed', value_type: 'text', config: null, description: null }, // renamed
      { id: 'draft:9', isNew: true, key: 'D', value_type: 'bool', config: null, description: null }, // new
      // p2 dropped
    ];
    const plan = planPropertyDiff(original, draft, ['p2']);
    assert.deepEqual(plan.ops, [
      { kind: 'delete', id: 'p2' },
      { kind: 'update', id: 'p1', changes: { key: 'A renamed' } },
      { kind: 'create', draftId: 'draft:9', input: { key: 'D', value_type: 'bool', config: null, description: null } },
    ]);
    assert.equal(plan.needsReorder, true);
  });
});
