/**
 * Unit tests for the staged binding-diff planner (client/src/renderer/lib/
 * type-property-draft.ts, task «Клиент: редактор типа подключает свойство из
 * справочника»): the Apply-time reconciliation of a type editor's local
 * own-bindings draft against what the server currently has. Pure logic —
 * no DOM (client tests run without jsdom, per the existing convention).
 *
 * Since 0.6.5 a type's own row is a binding to a network-wide property in
 * the registry; the diff planner emits the three op kinds that map straight
 * onto `POST /types/{id}/properties`, `DELETE …/properties/{pid}`, and
 * `PATCH …/properties/{pid} { required }`:
 *   * `unbind`   — DELETE
 *   * `attach`   — POST { mode: 'attach', property_id, side }
 *   * `set-role` — PATCH { required }
 * plus the trailing `needsReorder` flag when the order moved or new rows
 * landed in the middle. New rows ALWAYS attach an existing registry property
 * — brand-new properties are created through the shared property editor
 * first (0.6.5 приёмка), so there is no create-and-attach op any more.
 *
 * 0.8.1 (задача 935ec90e, требование 15b88319): двусторонняя вкладка
 * «Свойства» — каждая привязка несёт `side` (`source`/`target`/`null`).
 * `side` пробрасывается в `attach` op (создание) и в `opToAttachInput`
 * (тело POST), на стороне сервера записывается в `type_properties.side`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PropertyDefinition } from '@etn/shared';

import {
  cacheAttachedRegistryRow,
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

/** A staged attach row — references an existing registry property.
 *  `side` (0.8.1) — сторона привязки для свойств-связей; `null` для скаляров. */
function attach(
  draftId: string,
  propertyId: string,
  snapshot: { key: string; value_type?: 'text' | 'number' | 'date' | 'bool' | 'thought_ref' | 'url' | 'link'; description?: string | null },
  required = false,
  side: 'source' | 'target' | null = null,
): DraftProperty {
  return {
    id: draftId,
    isNew: true,
    property_id: propertyId,
    side,
    required,
    key: snapshot.key,
    value_type: snapshot.value_type ?? 'text',
    config: null,
    description: snapshot.description ?? null,
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
        side: null,
        required: false,
        key: 'A',
        value_type: 'text',
        config: null,
        description: null,
      },
      {
        id: 'p2',
        isNew: false,
        property_id: 'p2',
        side: null,
        required: false,
        key: 'B',
        value_type: 'number',
        config: { default_value: 3 },
        description: null,
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

  it('mirrors the stored `side` into the draft row (0.8.1, двусторонняя вкладка)', () => {
    const own = [
      def('p1', 'A', { side: 'source' }),
      def('p2', 'B', { side: 'target' }),
    ];
    const draft = draftPropertiesFrom(own);
    assert.equal(draft[0]!.side, 'source');
    assert.equal(draft[1]!.side, 'target');
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
      { kind: 'attach', draftId: 'draft:1', property_id: 'reg-2', required: false, side: null },
    ]);
    assert.equal(plan.needsReorder, true);
  });

  it('attaching a link property on the source side carries `side: "source"` through the planner', () => {
    const original: PropertyDefinition[] = [];
    const draft: DraftProperty[] = [
      attach('draft:1', 'reg-link', { key: 'parent-of', value_type: 'link' }, false, 'source'),
    ];
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, [
      { kind: 'attach', draftId: 'draft:1', property_id: 'reg-link', required: false, side: 'source' },
    ]);
  });

  it('attaching a link property on the target side carries `side: "target"` through the planner', () => {
    const original: PropertyDefinition[] = [];
    const draft: DraftProperty[] = [
      attach('draft:1', 'reg-link', { key: 'child-of', value_type: 'link' }, false, 'target'),
    ];
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, [
      { kind: 'attach', draftId: 'draft:1', property_id: 'reg-link', required: false, side: 'target' },
    ]);
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

  it('a full mixed batch: unbind + attach + set-role + reorder', () => {
    const original = [def('p1', 'A'), def('p2', 'B'), def('p3', 'C')];
    const draft: DraftProperty[] = [
      // p3 moved first; required unchanged → no op.
      { ...draftPropertiesFrom(original).find((d) => d.id === 'p3')! },
      // p1 moved second; required flips true → set-role.
      {
        ...draftPropertiesFrom(original).find((d) => d.id === 'p1')!,
        required: true,
      },
      // p2 dropped; an existing registry property attached third.
      attach('draft:9', 'reg-d', { key: 'D', value_type: 'bool' }),
    ];
    const plan = planPropertyDiff(original, draft, ['p2']);
    assert.deepEqual(plan.ops, [
      { kind: 'unbind', id: 'p2' },
      { kind: 'attach', draftId: 'draft:9', property_id: 'reg-d', required: false, side: null },
      { kind: 'set-role', id: 'p1', required: true },
    ]);
    assert.equal(plan.needsReorder, true);
  });

  it('a brand-new draft is all attaches — nothing is treated as a set-role', () => {
    const original: PropertyDefinition[] = [];
    const draft: DraftProperty[] = [
      attach('draft:1', 'reg-1', { key: 'X' }),
      attach('draft:2', 'reg-y', { key: 'Y', value_type: 'number' }),
    ];
    const plan = planPropertyDiff(original, draft, []);
    assert.deepEqual(plan.ops, [
      { kind: 'attach', draftId: 'draft:1', property_id: 'reg-1', required: false, side: null },
      { kind: 'attach', draftId: 'draft:2', property_id: 'reg-y', required: false, side: null },
    ]);
    assert.equal(plan.needsReorder, true);
  });
});

describe('opToAttachInput', () => {
  it('serialises an `attach` op to `{ mode: "attach", property_id, required, side }`', () => {
    const out = opToAttachInput({ kind: 'attach', draftId: 'd', property_id: 'reg-1', required: true, side: null });
    assert.deepEqual(out, { mode: 'attach', property_id: 'reg-1', required: true, side: null });
  });

  it('passes `side: "source"` through for a link property attached on the source side', () => {
    const out = opToAttachInput({ kind: 'attach', draftId: 'd', property_id: 'reg-link', required: false, side: 'source' });
    assert.deepEqual(out, { mode: 'attach', property_id: 'reg-link', required: false, side: 'source' });
  });

  it('passes `side: "target"` through for a link property attached on the target side', () => {
    const out = opToAttachInput({ kind: 'attach', draftId: 'd', property_id: 'reg-link', required: false, side: 'target' });
    assert.deepEqual(out, { mode: 'attach', property_id: 'reg-link', required: false, side: 'target' });
  });
});

/**
 * Regression tests for bug `da2d16c4-…` («В редакторе типа не работает
 * кнопка "Править природу свойства"»). `type-manager.ts`'s `editNature`
 * looks a draft row's registry nature up by `row.property_id` in a
 * `registryCache: Map<string, RegistryRow>` keyed by registry id — the SAME
 * id space `property_id` lives in ({@link attach}'s `propertyId` param
 * above mirrors `RegistryRow.id`). The cache used to be populated only once
 * by the section's `reload()`, so a property attached mid-session (picked
 * from the registry, or freshly created via the attach dialog's
 * «Добавить…») was invisible to it until the next full reload — the ✎
 * button's lookup missed and the click silently did nothing.
 * {@link cacheAttachedRegistryRow} is the fix: `openAttachPropertyDialog`
 * now calls it the instant a property is picked.
 */
describe('cacheAttachedRegistryRow (fix for da2d16c4-…)', () => {
  /** Minimal `RegistryRow` shape — only `id` matters to the cache/lookup. */
  interface MiniRegistryRow {
    id: string;
    name: string;
  }

  it('makes a freshly attached row resolvable by its property_id — the id-matching contract editNature relies on', () => {
    const cache = new Map<string, MiniRegistryRow>();
    const draft = attach('draft:1', 'reg-brand-new', { key: 'Новое свойство' });
    const registryRow: MiniRegistryRow = { id: 'reg-brand-new', name: 'Новое свойство' };

    cacheAttachedRegistryRow(cache, registryRow);

    assert.equal(cache.get(draft.property_id), registryRow);
  });

  it('does not disturb unrelated cached rows (plain Map.set, keyed by id)', () => {
    const existing: MiniRegistryRow = { id: 'reg-1', name: 'Существующее' };
    const cache = new Map<string, MiniRegistryRow>([[existing.id, existing]]);
    const added: MiniRegistryRow = { id: 'reg-2', name: 'Добавленное' };

    cacheAttachedRegistryRow(cache, added);

    assert.equal(cache.size, 2);
    assert.equal(cache.get('reg-1'), existing);
    assert.equal(cache.get('reg-2'), added);
  });

  it('re-attaching the same property_id refreshes the cached snapshot (last write wins)', () => {
    const stale: MiniRegistryRow = { id: 'reg-1', name: 'Старое имя' };
    const cache = new Map<string, MiniRegistryRow>([[stale.id, stale]]);
    const fresh: MiniRegistryRow = { id: 'reg-1', name: 'Новое имя' };

    cacheAttachedRegistryRow(cache, fresh);

    assert.equal(cache.get('reg-1'), fresh);
  });

  it('documents the regression shape: without caching on attach, the lookup misses (reg === undefined)', () => {
    // Mirrors the pre-fix `openAttachPropertyDialog`: the row is appended to
    // the draft table, but the registry snapshot cache is never told about
    // it — exactly the state that made `editNature`'s `registryCache.get(...)`
    // return `undefined` and the ✎ button do nothing.
    const cache = new Map<string, MiniRegistryRow>();
    const draft = attach('draft:1', 'reg-brand-new', { key: 'Новое свойство' });
    // Intentionally NOT calling cacheAttachedRegistryRow here.
    assert.equal(cache.get(draft.property_id), undefined, 'bug shape: cache misses the freshly attached property');
  });
});
