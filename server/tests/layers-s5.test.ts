/**
 * Tests for types and type-property definitions in change layers (task S5,
 * docs/13-layers.md §13):
 *
 * DoD flow — «завести тип со свойствами в слое, пользоваться им, в основе до
 * сведения его не видно»:
 * - a thought type with a property created in a layer is visible in that layer
 *   and its descendants (through `listThoughtTypes` /
 *   `listEffectiveTypeProperties` — the same services `etn.types.list` calls),
 *   invisible in the base and in a sibling layer; a layer thought may use the
 *   layer type (values, required warnings), base/sibling writes referencing it
 *   are NOT_FOUND;
 * - the same for link types (a layer link uses the layer link type, base
 *   cannot).
 *
 * Special cases from the task text:
 * - L21 inheritance is computed over the RESOLVED type chain: a layer child
 *   type inherits a base parent's property; a layer-only type can never be the
 *   parent of a base type;
 * - a property definition deleted in a layer hides the base-stored values in
 *   that layer only; renaming the key in a layer keeps values attached (they
 *   reference property ids), the base keeps the old key;
 * - re-creating a key deleted earlier in the same layer wakes the tombstone —
 *   the returned definition is the live woken row (its original id), not a
 *   null for the fresh uuid;
 * - property definitions and default overrides cannot be attached to a type
 *   invisible in the connection's layer context (layer-only type from the
 *   base, type tombstoned in the layer itself);
 * - `existsInBaseLayer` — the reliable "type exists only in a layer" detector
 *   for the merge closure of S8 (13-layers.md §8.1, §6.7, §13): no REST
 *   surface, a building block.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, EtnError } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { existsInBaseLayer } from '../src/db/layer-write.js';
import {
  computeThoughtCardWarnings,
  createTypeProperty,
  deleteTypeProperty,
  getPropertyValues,
  getTypeProperty,
  getTypePropertyByKey,
  listEffectiveTypeProperties,
  setPropertyValue,
  setTypePropertyDefaultOverride,
  updateTypeProperty,
} from '../src/domain/property-service.js';
import {
  createThoughtType,
  deleteThoughtType,
  getThoughtType,
  listThoughtTypes,
  updateThoughtType,
} from '../src/domain/thought-type-service.js';
import { createLinkType, listLinkTypes } from '../src/domain/link-type-service.js';
import { getRootTypeId } from '../src/domain/type-hierarchy.js';
import { createLink, getLink } from '../src/domain/link-service.js';
import { createThought, getThought, updateThought } from '../src/domain/thought-service.js';

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** The layer ids: A (child of base), B (child of A), S (sibling of A). */
const LAYER_A = '11111111-1111-4111-8111-111111111111';
const LAYER_B = '22222222-2222-4222-8222-222222222222';
const LAYER_S = '33333333-3333-4333-8333-333333333333';

/** Seed `layers` with A (child of base), B (child of A) and S (child of base). */
function insertLayers(ndb: NetworkDb): void {
  const now = new Date().toISOString();
  const ins = ndb.prepare(
    `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
     VALUES (?, ?, ?, 0, ?, 'u', ?, ?)`,
  );
  ins.run(LAYER_A, BASE_LAYER_ID, 'Слой A', 1, now, now);
  ins.run(LAYER_B, LAYER_A, 'Слой B', 2, now, now);
  ins.run(LAYER_S, BASE_LAYER_ID, 'Слой-сосед', 1, now, now);
}

/** `assert.throws` predicate: an EtnError with the given code. */
const failsWith = (code: string) => (e: unknown): boolean =>
  e instanceof EtnError && e.code === code;

describe(
  'layers S5 — a type with properties lives inside its layer (DoD)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('thought type + property in a layer: visible there and in descendants, invisible in base and sibling', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayers(ndb);
        ndb.useLayer(LAYER_A);
        const type = createThoughtType(
          ndb,
          { name: 'Проект', description: 'тип только для слоя' },
          USER,
        );
        createTypeProperty(ndb, 'thought_type', type.id, {
          key: 'статус',
          value_type: 'text',
          required: true,
        });

        // Visible in A: `etn.types.list` reads through these very services.
        assert.ok(listThoughtTypes(ndb).some((t) => t.id === type.id));
        const eff = listEffectiveTypeProperties(ndb, 'thought_type', type.id);
        assert.equal(eff.length, 1);
        assert.deepEqual(
          {
            key: eff[0]!.key,
            inherited: eff[0]!.inherited,
            defined_on: eff[0]!.defined_on,
            required: eff[0]!.required,
          },
          { key: 'статус', inherited: false, defined_on: type.id, required: true },
        );

        // A descendant layer inherits the visibility through its chain.
        ndb.useLayer(LAYER_B);
        assert.notEqual(getThoughtType(ndb, type.id), null);

        // Base and the sibling layer do not see the type; referencing it from
        // there is NOT_FOUND (13-layers.md §13: a base row cannot point at a
        // layer-only type — the check is mandatory at merge time, and the
        // write path already refuses it).
        for (const layer of [BASE_LAYER_ID, LAYER_S]) {
          ndb.useLayer(layer);
          assert.equal(getThoughtType(ndb, type.id), null);
          assert.ok(!listThoughtTypes(ndb).some((t) => t.id === type.id));
          assert.throws(
            () => createThought(ndb, { title: 'Недопустимая', type_id: type.id }, USER),
            failsWith('NOT_FOUND'),
          );
          const host = createThought(ndb, { title: `Хозяин ${layer}` }, USER);
          assert.throws(
            () => updateThought(ndb, host.id, { type_id: type.id }, undefined, USER),
            failsWith('NOT_FOUND'),
          );
        }

        // A layer thought uses the type: value writes, reads, warnings.
        ndb.useLayer(LAYER_A);
        const withValue = createThought(ndb, { title: 'С проектом', type_id: type.id }, USER);
        assert.equal(getThought(ndb, withValue.id)?.type_id, type.id);
        setPropertyValue(ndb, 'thought', withValue.id, 'статус', 'в работе');
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', withValue.id).map((v) => v.value),
          ['в работе'],
        );
        assert.deepEqual(computeThoughtCardWarnings(ndb, withValue.id), []);
        const withoutValue = createThought(ndb, { title: 'Без статуса', type_id: type.id }, USER);
        assert.deepEqual(
          computeThoughtCardWarnings(ndb, withoutValue.id).map((w) => w.key),
          ['статус'],
        );

        // The layer thought is itself invisible in the base.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getThought(ndb, withValue.id), null);
      } finally {
        ndb.close();
      }
    });

    it('link type in a layer: a layer link uses it (with properties), base cannot', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayers(ndb);
        const a = createThought(ndb, { title: 'A' }, USER);
        const b = createThought(ndb, { title: 'B' }, USER);

        ndb.useLayer(LAYER_A);
        const lt = createLinkType(
          ndb,
          { name_forward: 'ведёт к', name_reverse: 'ведёт от' },
          USER,
        );
        // A property on the layer link type + a value on the layer link.
        createTypeProperty(ndb, 'link_type', lt.id, { key: 'вес', value_type: 'number' });
        const link = createLink(ndb, { source_id: a.id, target_id: b.id, type_id: lt.id }, USER);
        assert.equal(getLink(ndb, link.id)?.type_id, lt.id);
        setPropertyValue(ndb, 'link', link.id, 'вес', 3);
        assert.deepEqual(
          getPropertyValues(ndb, 'link', link.id).map((v) => v.value),
          [3],
        );
        assert.ok(listLinkTypes(ndb).some((t) => t.id === lt.id));

        // Base: the type and the link are invisible; assigning fails.
        ndb.useLayer(BASE_LAYER_ID);
        assert.ok(!listLinkTypes(ndb).some((t) => t.id === lt.id));
        assert.equal(getLink(ndb, link.id), null);
        assert.throws(
          () => createLink(ndb, { source_id: a.id, target_id: b.id, type_id: lt.id }, USER),
          failsWith('NOT_FOUND'),
        );
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'layers S5 — L21 inheritance over the resolved type chain',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('a layer child type inherits a base parent property; defaults override per layer', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayers(ndb);
        // Base: parent type with a property carrying its own default.
        const parent = createThoughtType(ndb, { name: 'Документ' }, USER);
        const def = createTypeProperty(ndb, 'thought_type', parent.id, {
          key: 'поле',
          value_type: 'text',
          config: { default_value: 'дефолт основы' },
        });

        // Layer A: child type under the base parent, own property, override.
        ndb.useLayer(LAYER_A);
        const child = createThoughtType(ndb, { name: 'Акт', parent_id: parent.id }, USER);
        createTypeProperty(ndb, 'thought_type', child.id, { key: 'номер', value_type: 'number' });
        const eff = listEffectiveTypeProperties(ndb, 'thought_type', child.id);
        assert.deepEqual(
          eff.map((d) => [d.key, d.inherited, d.defined_on]),
          [
            ['поле', true, parent.id],
            ['номер', false, child.id],
          ],
        );
        setTypePropertyDefaultOverride(ndb, 'thought_type', child.id, def.id, 'дефолт слоя');
        assert.equal(
          listEffectiveTypeProperties(ndb, 'thought_type', child.id).find((d) => d.key === 'поле')
            ?.default_value,
          'дефолт слоя',
        );

        // Value writes resolve the inherited definition across the layer
        // boundary (the chain is base parent → layer child).
        const th = createThought(ndb, { title: 'Акт №1', type_id: child.id }, USER);
        setPropertyValue(ndb, 'thought', th.id, 'поле', 'значение слоя');
        setPropertyValue(ndb, 'thought', th.id, 'номер', 7);
        assert.equal(getPropertyValues(ndb, 'thought', th.id).length, 2);

        // Base: the child does not exist; the parent's default is untouched.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getThoughtType(ndb, child.id), null);
        assert.equal(
          listEffectiveTypeProperties(ndb, 'thought_type', parent.id).find((d) => d.key === 'поле')
            ?.default_value,
          'дефолт основы',
        );
      } finally {
        ndb.close();
      }
    });

    it('an override set in the base is re-set in a layer as ONE visible row (no duplicate ids)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayers(ndb);
        const parent = createThoughtType(ndb, { name: 'Родитель' }, USER);
        const child = createThoughtType(ndb, { name: 'Ребёнок', parent_id: parent.id }, USER);
        const def = createTypeProperty(ndb, 'thought_type', parent.id, {
          key: 'вес',
          value_type: 'number',
        });
        // Base override for the child.
        setTypePropertyDefaultOverride(ndb, 'thought_type', child.id, def.id, 1);

        // The layer re-sets the override: the write must shadow the base row
        // (same logical id), not spawn a second row — the view resolves per
        // logical id, two ids would both be visible.
        ndb.useLayer(LAYER_A);
        setTypePropertyDefaultOverride(ndb, 'thought_type', child.id, def.id, 2);
        assert.equal(
          listEffectiveTypeProperties(ndb, 'thought_type', child.id).find((d) => d.key === 'вес')
            ?.default_value,
          2,
        );
        const layerRows = ndb
          .prepare(
            "SELECT COUNT(*) AS c FROM type_property_overrides_v WHERE owner_type = 'thought_type' AND type_id = ? AND property_id = ?",
          )
          .get(child.id, def.property_id) as { c: number };
        assert.equal(layerRows.c, 1);

        // The base keeps its own override value.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(
          listEffectiveTypeProperties(ndb, 'thought_type', child.id).find((d) => d.key === 'вес')
            ?.default_value,
          1,
        );
      } finally {
        ndb.close();
      }
    });

    it('a layer-only type can never become the parent of a base type', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayers(ndb);
        ndb.useLayer(LAYER_A);
        const layerOnly = createThoughtType(ndb, { name: 'Только слой' }, USER);
        ndb.useLayer(BASE_LAYER_ID);
        assert.throws(
          () => createThoughtType(ndb, { name: 'Ребёнок основы', parent_id: layerOnly.id }, USER),
          failsWith('NOT_FOUND'),
        );
        // The rejected type must not linger: the transaction rolled back.
        assert.ok(!listThoughtTypes(ndb).some((t) => t.name === 'Ребёнок основы'));
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'layers S5 — property deletion/renaming in a layer vs base-stored values',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('binding detached in a layer: value stays flagged outside_type there, alive in the base; rename keeps values attached', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayers(ndb);
        const type = createThoughtType(ndb, { name: 'Тип' }, USER);
        const goneDef = createTypeProperty(ndb, 'thought_type', type.id, {
          key: 'исчезает',
          value_type: 'text',
        });
        const renamedDef = createTypeProperty(ndb, 'thought_type', type.id, {
          key: 'имя',
          value_type: 'text',
        });
        const th = createThought(ndb, { title: 'Владелец', type_id: type.id }, USER);
        setPropertyValue(ndb, 'thought', th.id, 'исчезает', 'основа-значение');
        setPropertyValue(ndb, 'thought', th.id, 'имя', 'основа-имя');

        // Detach the property in layer A (0.6.5: a binding carries no values —
        // the stored value survives as a value outside type).
        ndb.useLayer(LAYER_A);
        deleteTypeProperty(ndb, goneDef.id);
        assert.equal(getTypeProperty(ndb, goneDef.id), null);
        assert.ok(
          !listEffectiveTypeProperties(ndb, 'thought_type', type.id).some(
            (d) => d.key === 'исчезает',
          ),
        );
        // The «исчезает» value is still readable in the layer — flagged
        // outside_type (02-data-model.md §3.5a), not hidden as in the
        // pre-0.6.5 cascade; «имя» is still attached and unflagged.
        const layerValues = getPropertyValues(ndb, 'thought', th.id);
        assert.deepEqual(
          layerValues.map((v) => [v.value, v.outside_type]).sort(),
          [
            ['основа-значение', true],
            ['основа-имя', false],
          ],
        );
        assert.ok(layerValues.every((v) => v.property_name.length > 0));
        // Writing it again is rejected with 422: the property exists in the
        // registry but the layer's chain does not attach it.
        assert.throws(
          () => setPropertyValue(ndb, 'thought', th.id, 'исчезает', 'слой'),
          failsWith('VALIDATION_ERROR'),
        );

        // Rename in the layer: values address the registry property id, so the
        // stored base value follows — new name in the layer.
        updateTypeProperty(ndb, renamedDef.id, { key: 'имя слоя' });
        assert.equal(getTypePropertyByKey(ndb, 'thought_type', type.id, 'имя слоя')?.id, renamedDef.id);
        assert.equal(getTypePropertyByKey(ndb, 'thought_type', type.id, 'имя'), null);
        setPropertyValue(ndb, 'thought', th.id, 'имя слоя', 'слоя-имя');
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th.id).map((v) => [v.property_id, v.value]),
          [
            [goneDef.property_id, 'основа-значение'],
            [renamedDef.property_id, 'слоя-имя'],
          ],
        );

        // Base: both bindings and both stored values are intact, old name.
        ndb.useLayer(BASE_LAYER_ID);
        assert.notEqual(getTypeProperty(ndb, goneDef.id), null);
        assert.equal(getTypePropertyByKey(ndb, 'thought_type', type.id, 'имя')?.id, renamedDef.id);
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th.id)
            .map((v) => [v.property_id, v.value])
            .sort(),
          [
            [goneDef.property_id, 'основа-значение'],
            [renamedDef.property_id, 'основа-имя'],
          ].sort(),
        );
      } finally {
        ndb.close();
      }
    });

    it('re-attaching a detached property in the layer wakes the tombstone and returns the live binding', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayers(ndb);
        const type = createThoughtType(ndb, { name: 'Тип' }, USER);
        const def = createTypeProperty(ndb, 'thought_type', type.id, {
          key: 'поле',
          value_type: 'number',
        });

        ndb.useLayer(LAYER_A);
        deleteTypeProperty(ndb, def.id);
        assert.equal(getTypeProperty(ndb, def.id), null);
        // Re-attach: the upsert wakes this layer's tombstone; the woken
        // binding keeps its ORIGINAL id, so the result must be re-read by
        // (owner, key) — a fresh uuid would not resolve (the S5 fix). The
        // nature fields of the request are ignored: the registry property
        // already exists (its value_type stays `number`).
        const woken = createTypeProperty(ndb, 'thought_type', type.id, {
          key: 'поле',
          value_type: 'text',
        });
        assert.notEqual(woken, null);
        assert.equal(woken.id, def.id);
        assert.equal(woken.property_id, def.property_id);
        assert.equal(woken.value_type, 'number', 'registry nature wins over the request');
        // One live layer row (the per-layer UNIQUE owner/property/layer), no
        // stale tombstone.
        const rows = ndb
          .prepare(
            'SELECT id, deleted FROM type_properties WHERE owner_type = ? AND owner_id = ? AND layer_id = ?',
          )
          .all('thought_type', type.id, LAYER_A) as Array<{ id: string; deleted: number }>;
        assert.deepEqual(rows, [{ id: def.id, deleted: 0 }]);
        // The woken binding is usable: values write and read through it.
        const th = createThought(ndb, { title: 'В', type_id: type.id }, USER);
        setPropertyValue(ndb, 'thought', th.id, 'поле', 5);
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th.id).map((v) => v.value),
          [5],
        );

        // The base binding and registry property were never touched by the
        // layer round-trip.
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getTypeProperty(ndb, def.id)?.value_type, 'number');
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'layers S5 — write guards and the layer-only detector for the S8 closure',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('definitions and overrides refuse owners invisible in the connection layer context', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayers(ndb);
        const rootTypeId = getRootTypeId(ndb, 'thought_types');
        assert.notEqual(rootTypeId, null);
        const rootProp = createTypeProperty(ndb, 'thought_type', rootTypeId!, {
          key: 'корень',
          value_type: 'number',
        });

        // A layer-only type is invisible from the base: neither a definition
        // nor an override may be attached to it there (13-layers.md §13).
        ndb.useLayer(LAYER_A);
        const layerType = createThoughtType(ndb, { name: 'Слой' }, USER);
        ndb.useLayer(BASE_LAYER_ID);
        assert.throws(
          () =>
            createTypeProperty(ndb, 'thought_type', layerType.id, {
              key: 'к',
              value_type: 'text',
            }),
          failsWith('NOT_FOUND'),
        );
        assert.throws(
          () => setTypePropertyDefaultOverride(ndb, 'thought_type', layerType.id, rootProp.id, 1),
          failsWith('NOT_FOUND'),
        );

        // A type tombstoned in the layer is invisible there for the same
        // writes (the owner check goes through the resolving view).
        const hidden = createThoughtType(ndb, { name: 'Скрытый в слое' }, USER);
        ndb.useLayer(LAYER_A);
        deleteThoughtType(ndb, hidden.id, undefined);
        assert.throws(
          () =>
            createTypeProperty(ndb, 'thought_type', hidden.id, { key: 'к', value_type: 'text' }),
          failsWith('NOT_FOUND'),
        );
        assert.throws(
          () => setTypePropertyDefaultOverride(ndb, 'thought_type', hidden.id, rootProp.id, 1),
          failsWith('NOT_FOUND'),
        );
        // Nothing leaked into the layer despite the throws (transactions).
        assert.equal(
          (
            ndb
              .prepare('SELECT COUNT(*) AS c FROM type_properties WHERE layer_id = ?')
              .get(LAYER_A) as { c: number }
          ).c,
          0,
        );
      } finally {
        ndb.close();
      }
    });

    it('existsInBaseLayer: «тип существует только в слое» is reliably detectable (S8 closure)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayers(ndb);
        const baseType = createThoughtType(ndb, { name: 'Тип основы' }, USER);
        const baseLinkType = createLinkType(
          ndb,
          { name_forward: 'основная', name_reverse: 'обратная' },
          USER,
        );

        ndb.useLayer(LAYER_A);
        const layerType = createThoughtType(ndb, { name: 'Тип слоя' }, USER);
        const layerProp = createTypeProperty(ndb, 'thought_type', layerType.id, {
          key: 'к',
          value_type: 'text',
        });
        const layerLinkType = createLinkType(
          ndb,
          { name_forward: 'слой-вперёд', name_reverse: 'слой-назад' },
          USER,
        );

        // Base-owned rows → true; layer-only rows → false.
        assert.equal(existsInBaseLayer(ndb, 'thought_types', baseType.id), true);
        assert.equal(existsInBaseLayer(ndb, 'link_types', baseLinkType.id), true);
        assert.equal(existsInBaseLayer(ndb, 'thought_types', layerType.id), false);
        assert.equal(existsInBaseLayer(ndb, 'type_properties', layerProp.id), false);
        assert.equal(existsInBaseLayer(ndb, 'link_types', layerLinkType.id), false);

        // A layer tombstone is the layer's private disagreement — the base row
        // still exists, so the closure sees the type in the base.
        deleteThoughtType(ndb, baseType.id, undefined);
        assert.equal(existsInBaseLayer(ndb, 'thought_types', baseType.id), true);

        // A layer shadow edit over a base row does not change ownership either.
        ndb.useLayer(BASE_LAYER_ID);
        const shadowed = createThoughtType(ndb, { name: 'Правится в слое' }, USER);
        ndb.useLayer(LAYER_A);
        updateThoughtType(ndb, shadowed.id, { description: 'правка слоя' }, undefined);
        assert.equal(existsInBaseLayer(ndb, 'thought_types', shadowed.id), true);
      } finally {
        ndb.close();
      }
    });
  },
);
