/**
 * Unit tests for the staged binding-diff planner (client/src/renderer/lib/
 * type-property-draft.ts, task «Клиент: редактор типа подключает свойство из
 * справочника»): the Apply-time reconciliation of a type editor's local
 * own-bindings draft against what the server currently has. Pure logic —
 * no DOM (client tests run without jsdom, per the existing convention).
 *
 * Since 0.6.5 a type's own row is a binding to a network-wide property in
 * the registry; the diff planner emits the four op kinds that map straight
 * onto `POST /types/{id}/properties`, `DELETE …/properties/{pid}`, and
 * `PATCH …/properties/{pid} { required }`:
 *   * `unbind`              — DELETE
 *   * `attach`              — POST { mode: 'attach',   property_id }
 *   * `create-and-attach`   — POST { mode: 'create',   key, value_type, description }
 *   * `set-role`            — PATCH { required }
 * plus the trailing `needsReorder` flag when the order moved or new rows
 * landed in the middle.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PropertyDefinition } from '@etn/shared';

import {
  draftPropertiesFrom,
  nextDraftPropertyId,
  opToAttachInput,
  planPropertyDiff,
  type DraftProperty,
} from '../src/renderer/lib/type-property-draft.js';

/** Builds a minimal stored binding for the tests. `property_id` defaults to
 *  the same value as the binding id so most fixtures need not spell it out. */
function def(id: string, key: string, extra: Partial<PropertyDefinition> = {}): PropertyDefinition {
  return {
    id,
    property_id: id,
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

/** A staged attach row — references an existing registry property. */
function attach(
  draftId: string,
  propertyId: string,
  snapshot: { key: string; value_type?: 'text' | 'number' | 'date' | 'bool' | 'thought_ref' | 'url'; description?: string | null },
  required = false,
): DraftProperty {
  return {
    id: draftId,
    isNew: true,
    property_id: propertyId,
    required,
    key: snapshot.key,
    value_type: snapshot.value_type ?? 'text',
    config: null,
    description: snapshot.description ?? null,
    createInRegistry: false,
  };
}

/** A staged create-and-attach row — creates a new registry property first. */
function createAndAttach(
  draftId: string,
  name: string,
  valueType: 'text' | 'number' | 'date' | 'bool' | 'thought_ref' | 'url' = 'text',
  description: string | null = null,
  required = false,
): DraftProperty {
  return {
    id: draftId,
    isNew: true,
    property_id: '',
    required,
    key: name,
    value_type: valueType,
    config: null,
    description,
    createInRegistry: true,
  };
}

describe('draftPropertiesFrom', () => {
  it('mirrors stored bindings as non-new draft rows, in the given order', () => {
    const own = [
      def('p1', 'A'),
      def('p2', 'B', { value_type: 'number', config: { default_value: 3 } }),
    ];
    const draft = draftPropertiesFrom(own);
    assert.deepEqual(draft, [
      {
        id: 'p1',
        isNew: false,
        property_id: 'p1',
        required: false,
        key: 'A',
        value_type: 'text',
        config: null,
        description: null,
        createInRegistry: false,
      },
      {
        id: 'p2',
        isNew: false,
        property_id: 'p2',
        required: false,
        key: 'B',
        value_type: 'number',
        config: { default_value: 3 },
        description: null,
        createInRegistry: false,
      },
    ]);
  });

  it('mirrors the stored description into the draft row', () => {
    const own = [def('p1', 'A', { description: 'что значит это свойство' })];
    const draft = draftPropertiesFrom(own);
    assert.equal(draft[0]!.description, 'что значит это свойство');
  });

  it('preserves the `required` flag from the stored binding', () => {
    const own = [def('p1', 'A', { required: true })];
    const draft = draftPropertiesFrom(own);
    assert.equal(draft[0]!.required, true);
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

  it('attaching an existing registry property becomes an `attach` op and forces a reorder', () => {
    const original = [def('p1', 'A')];
    const draft = [...draftPropertiesFrom(original), attach('draft:1', 'reg-2', { key: 'B' })];
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, [
      { kind: 'attach', draftId: 'draft:1', property_id: 'reg-2', required: false },
    ]);
    assert.equal(plan.needsReorder, true);
  });

  it('creating a brand-new registry property and attaching it becomes a `create-and-attach` op', () => {
    const original = [def('p1', 'A')];
    const draft = [
      ...draftPropertiesFrom(original),
      createAndAttach('draft:2', 'N', 'date', 'дата поставки'),
    ];
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, [
      {
        kind: 'create-and-attach',
        draftId: 'draft:2',
        name: 'N',
        value_type: 'date',
        description: 'дата поставки',
        required: false,
      },
    ]);
    assert.equal(plan.needsReorder, true);
  });

  it('toggling `required` on an existing binding becomes a `set-role` op with only the changed field', () => {
    const original = [def('p1', 'A', { required: false })];
    const draft: DraftProperty[] = [
      { ...draftPropertiesFrom(original)[0]!, required: true },
    ];
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, [{ kind: 'set-role', id: 'p1', required: true }]);
    assert.equal(plan.needsReorder, false);
  });

  it('a `set-role` op is NOT emitted when `required` did not change', () => {
    const original = [def('p1', 'A', { required: true })];
    const draft = draftPropertiesFrom(original);
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, []);
  });

  it('unbinding an id becomes an `unbind` op, ordered BEFORE attaches/set-role ops', () => {
    const original = [def('p1', 'A'), def('p2', 'B')];
    const draft = draftPropertiesFrom(original.filter((d) => d.id !== 'p2'));
    const plan = planPropertyDiff(original, draft, ['p2']);
    assert.deepEqual(plan.ops, [{ kind: 'unbind', id: 'p2' }]);
    assert.equal(plan.needsReorder, false);
  });

  it('the planner never lets a `set-role` reference an id that is also being unbound', () => {
    // p1 is being unbound AND the client accidentally left it in the draft
    // (the type-editor never lets that happen, but a defensive test pinpoints
    // the contract: deleted ids drop out of the diff's set-role pass too).
    const original = [def('p1', 'A', { required: false }), def('p2', 'B', { required: false })];
    const draft = draftPropertiesFrom(original).map((d) =>
      d.id === 'p1' ? { ...d, required: true } : d,
    );
    const plan = planPropertyDiff(original, draft, ['p1']);
    assert.deepEqual(plan.ops, [
      { kind: 'unbind', id: 'p1' },
      // No `set-role` for p1: its row is gone, the diff skips it.
    ]);
  });

  it('reordering two unchanged rows needs a reorder but no create/update ops', () => {
    const original = [def('p1', 'A'), def('p2', 'B')];
    const draft = draftPropertiesFrom(original).reverse();
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, []);
    assert.equal(plan.needsReorder, true);
  });

  it('a full mixed batch: unbind + create-and-attach + set-role + reorder', () => {
    const original = [def('p1', 'A'), def('p2', 'B'), def('p3', 'C')];
    const draft: DraftProperty[] = [
      // p3 moved first; required unchanged → no op.
      { ...draftPropertiesFrom(original).find((d) => d.id === 'p3')! },
      // p1 moved second; required flips true → set-role.
      {
        ...draftPropertiesFrom(original).find((d) => d.id === 'p1')!,
        required: true,
      },
      // p2 dropped; new registry property created+attached third.
      createAndAttach('draft:9', 'D', 'bool'),
    ];
    const plan = planPropertyDiff(original, draft, ['p2']);
    assert.deepEqual(plan.ops, [
      { kind: 'unbind', id: 'p2' },
      { kind: 'create-and-attach', draftId: 'draft:9', name: 'D', value_type: 'bool', description: null, required: false },
      { kind: 'set-role', id: 'p1', required: true },
    ]);
    assert.equal(plan.needsReorder, true);
  });

  it('a brand-new draft is all attaches/creates — nothing is treated as a set-role', () => {
    const original: PropertyDefinition[] = [];
    const draft: DraftProperty[] = [
      attach('draft:1', 'reg-1', { key: 'X' }),
      createAndAttach('draft:2', 'Y', 'number'),
    ];
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, [
      { kind: 'attach', draftId: 'draft:1', property_id: 'reg-1', required: false },
      { kind: 'create-and-attach', draftId: 'draft:2', name: 'Y', value_type: 'number', description: null, required: false },
    ]);
    assert.equal(plan.needsReorder, true);
  });
});

describe('opToAttachInput', () => {
  it('serialises an `attach` op to `{ mode: "attach", property_id, required }`', () => {
    const out = opToAttachInput({ kind: 'attach', draftId: 'd', property_id: 'reg-1', required: true });
    assert.deepEqual(out, { mode: 'attach', property_id: 'reg-1', required: true });
  });

  it('serialises a `create-and-attach` op to `{ mode: "create", key, value_type, description, required }`', () => {
    const out = opToAttachInput({
      kind: 'create-and-attach',
      draftId: 'd',
      name: 'N',
      value_type: 'date',
      description: 'дата поставки',
      required: false,
    });
    assert.deepEqual(out, {
      mode: 'create',
      key: 'N',
      value_type: 'date',
      description: 'дата поставки',
      required: false,
    });
  });
});
