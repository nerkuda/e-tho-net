/**
 * Repro/regression tests for the reported bugs (ETN knowledge base):
 * 49d1f5e8 "Внутренняя ошибка сервера при изменении значения свойства" and
 * dc119240 "Чтение значений свойств может показать дубликат/устаревшее
 * значение на пересечении слоёв".
 *
 * Scenario: a thought is created, a string property value is set for the
 * FIRST TIME in a child layer "A" (fresh row, id X — nothing exists anywhere
 * yet for this natural key), then set again from the base layer (base cannot
 * see A's row, so it independently mints a second row for the same natural
 * key), then set/deleted a THIRD time back in layer A.
 *
 * The first fix (`resolveVisiblePropertyValueId`, commit c04e1d0) resolved
 * the natural key across the layer chain by depth (nearest layer wins) in
 * the write/delete paths — no crash, no cross-layer corruption.
 *
 * The complete fix (bug dc119240) makes the row id DETERMINISTIC from the
 * natural key (UUIDv5, db/property-value-id.ts + migration 036): independent
 * first-writes in disjoint layers converge on ONE id, so the per-id `*_v`
 * views report exactly one visible row per natural key — reads no longer
 * list a "ghost" value of the other origin, and deleting from the child
 * layer cannot leave a farther same-key row resurfacing afterwards.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { propertyValueId } from '../src/db/property-value-id.js';
import {
  createTypeProperty,
  deletePropertyValue,
  getPropertyValues,
  setPropertyValue,
} from '../src/domain/property-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createThought } from '../src/domain/thought-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const LAYER_A = '11111111-1111-4111-8111-111111111111';

function insertLayerA(ndb: NetworkDb): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, ?, 0, ?, 'u', ?, ?)`,
    )
    .run(LAYER_A, BASE_LAYER_ID, 'Слой А', 1, now, now);
}

/** Physical row of a property value scoped to one exact layer (raw read, bypassing `*_v`). */
function ownRow(
  ndb: NetworkDb,
  ownerId: string,
  propertyId: string,
  layerId: string,
): { id: string; value_text: string | null; deleted: number } | undefined {
  return ndb
    .prepare(
      `SELECT id, value_text, deleted FROM property_values
       WHERE owner_type = 'thought' AND owner_id = ? AND property_id = ? AND layer_id = ?`,
    )
    .get(ownerId, propertyId, layerId) as
    | { id: string; value_text: string | null; deleted: number }
    | undefined;
}

describe(
  'property values across layers — natural-key resolution (bug 49d1f5e8)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const USER = 'user-1';

    it('set in A, then base, then A again does not 500 and does not corrupt either layer', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayerA(ndb);
        const type = createThoughtType(ndb, { name: 'Задача' }, USER);
        const def = createTypeProperty(
          ndb,
          'thought_type',
          type.id,
          { key: 'статус', value_type: 'text' },
          USER,
        );
        const th = createThought(ndb, { title: 'Моя задача', type_id: type.id }, USER);

        // 1. Layer A: first write ever for this property — fresh row (id X).
        ndb.useLayer(LAYER_A);
        setPropertyValue(ndb, 'thought', th.id, 'статус', 'в работе (А)', USER);
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th.id).map((v) => v.value),
          ['в работе (А)'],
        );

        // 2. Base: independent write — base cannot see A's row, so it mints a
        // second, independent row for the same natural key (id Y).
        ndb.useLayer(BASE_LAYER_ID);
        setPropertyValue(ndb, 'thought', th.id, 'статус', 'открыто (основа)', USER);
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th.id).map((v) => v.value),
          ['открыто (основа)'],
        );

        // 3. Back to layer A: this used to throw (UNIQUE constraint violation
        // surfacing as an unhandled 500) — or, depending on which id the
        // arbitrary `LIMIT 1` landed on, silently overwrite base's row
        // instead of A's own. Neither must happen anymore.
        ndb.useLayer(LAYER_A);
        assert.doesNotThrow(() => {
          setPropertyValue(ndb, 'thought', th.id, 'статус', 'снова в работе (А)', USER);
        });

        // A's OWN physical row (and only it) carries the third edit.
        assert.equal(ownRow(ndb, th.id, def.property_id, LAYER_A)?.value_text, 'снова в работе (А)');
        assert.equal(
          getPropertyValues(ndb, 'thought', th.id).some((v) => v.value === 'снова в работе (А)'),
          true,
        );

        // Base's independent value survives untouched — the reported bug's
        // "silent corruption" variant would have overwritten it instead.
        assert.equal(ownRow(ndb, th.id, def.property_id, BASE_LAYER_ID)?.value_text, 'открыто (основа)');
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th.id).map((v) => v.value),
          ['открыто (основа)'],
        );
      } finally {
        ndb.close();
      }
    });

    it('same conflict pattern on delete does not 500 and does not touch base', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayerA(ndb);
        const type = createThoughtType(ndb, { name: 'Задача 2' }, USER);
        const def = createTypeProperty(
          ndb,
          'thought_type',
          type.id,
          { key: 'статус', value_type: 'text' },
          USER,
        );
        const th = createThought(ndb, { title: 'Другая задача', type_id: type.id }, USER);

        ndb.useLayer(LAYER_A);
        setPropertyValue(ndb, 'thought', th.id, 'статус', 'в работе (А)', USER);

        ndb.useLayer(BASE_LAYER_ID);
        setPropertyValue(ndb, 'thought', th.id, 'статус', 'открыто (основа)', USER);

        ndb.useLayer(LAYER_A);
        assert.doesNotThrow(() => {
          deletePropertyValue(ndb, 'thought', th.id, 'статус', USER);
        });
        // A's own row is tombstoned — the delete took effect in A, no 500.
        assert.equal(ownRow(ndb, th.id, def.property_id, LAYER_A)?.deleted, 1);

        // Base keeps its own value untouched — deleting from A must not
        // reach into base's independent row.
        assert.equal(ownRow(ndb, th.id, def.property_id, BASE_LAYER_ID)?.value_text, 'открыто (основа)');
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th.id).map((v) => v.value),
          ['открыто (основа)'],
        );
      } finally {
        ndb.close();
      }
    });

    // ------------------------------------------------------------------
    // dc119240: deterministic ids — reads must see exactly ONE value per
    // property, and a delete from the child layer must hide it for good
    // (no "resurfacing" base ghost with a different id).
    // ------------------------------------------------------------------

    it('independent first-writes converge on one id — reads see a single value, no ghost (dc119240)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayerA(ndb);
        const type = createThoughtType(ndb, { name: 'Задача 3' }, USER);
        const def = createTypeProperty(
          ndb,
          'thought_type',
          type.id,
          { key: 'статус', value_type: 'text' },
          USER,
        );
        const th = createThought(ndb, { title: 'Третья задача', type_id: type.id }, USER);
        const detId = propertyValueId('thought', th.id, def.property_id);

        // 1. First write ever, from layer A.
        ndb.useLayer(LAYER_A);
        setPropertyValue(ndb, 'thought', th.id, 'статус', 'в работе (А)', USER);
        assert.equal(ownRow(ndb, th.id, def.property_id, LAYER_A)?.id, detId);

        // 2. Independent first write from the base — the row it mints must
        // carry the SAME deterministic id (pre-fix this was a fresh random
        // uuid, and A's reads then listed BOTH values).
        ndb.useLayer(BASE_LAYER_ID);
        setPropertyValue(ndb, 'thought', th.id, 'статус', 'открыто (основа)', USER);
        assert.equal(ownRow(ndb, th.id, def.property_id, BASE_LAYER_ID)?.id, detId);

        // 3. Back in A: exactly ONE visible value — A's own. The per-id `*_v`
        // dedup now covers the natural key because both physical rows share
        // the id (nearest layer wins).
        ndb.useLayer(LAYER_A);
        const values = getPropertyValues(ndb, 'thought', th.id);
        assert.deepEqual(
          values.map((v) => ({ value: v.value, id: v.id })),
          [{ value: 'в работе (А)', id: detId }],
          'no duplicate/ghost entry for the same property',
        );

        // From the base the picture is symmetric: one value, its own.
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th.id).map((v) => v.value),
          ['открыто (основа)'],
        );
      } finally {
        ndb.close();
      }
    });

    it('delete from the child layer hides the value for good — no resurfacing ghost (dc119240)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayerA(ndb);
        const type = createThoughtType(ndb, { name: 'Задача 4' }, USER);
        const def = createTypeProperty(
          ndb,
          'thought_type',
          type.id,
          { key: 'статус', value_type: 'text' },
          USER,
        );
        const th = createThought(ndb, { title: 'Четвёртая задача', type_id: type.id }, USER);

        ndb.useLayer(LAYER_A);
        setPropertyValue(ndb, 'thought', th.id, 'статус', 'в работе (А)', USER);
        ndb.useLayer(BASE_LAYER_ID);
        setPropertyValue(ndb, 'thought', th.id, 'статус', 'открыто (основа)', USER);

        // Delete from A: the tombstone shares the deterministic id with the
        // base row, so the view's "nearest layer wins" hides the value in
        // A's whole chain — it cannot resurface via a second, different id.
        ndb.useLayer(LAYER_A);
        deletePropertyValue(ndb, 'thought', th.id, 'статус', USER);
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th.id).map((v) => v.value),
          [],
          'deleted in A means not visible from A — no base ghost resurfaces',
        );

        // ...while the base context still sees its own live row.
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          getPropertyValues(ndb, 'thought', th.id).map((v) => v.value),
          ['открыто (основа)'],
        );
      } finally {
        ndb.close();
      }
    });
  },
);
