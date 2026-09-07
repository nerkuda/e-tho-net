/**
 * Repro/regression test for the reported bug (thought 49d1f5e8 in the ETN
 * knowledge base): "Внутренняя ошибка сервера при изменении значения
 * свойства".
 *
 * Scenario: a thought is created, a string property value is set for the
 * FIRST TIME in a child layer "A" (fresh row, id X — nothing exists anywhere
 * yet for this natural key), then set again from the base layer (base cannot
 * see A's row, so it independently mints a second row for the same natural
 * key, id Y), then set/deleted a THIRD time back in layer A. At that point
 * `property_values_v` — which dedups per surrogate `id`, not per natural key
 * `(owner_type, owner_id, property_id)` — reports BOTH X and Y as "visible"
 * winners in A's chain; the old code picked one arbitrarily via `LIMIT 1`
 * and could try to materialise a shadow copy of the wrong id into a layer
 * that already physically holds the other id for the same natural key,
 * violating `UNIQUE (owner_type, owner_id, property_id, layer_id)` — an
 * unhandled SQLite error surfacing as a 500, or (depending on which id the
 * arbitrary pick landed on) silently updating the wrong physical row.
 *
 * The fix (`resolveVisiblePropertyValueId` in property-service.ts) resolves
 * the natural key across the layer chain by depth (nearest layer wins) —
 * these tests assert the two guarantees that actually matter for the report:
 * no crash, and no cross-layer data corruption (each layer's own edit stays
 * its own). A pre-existing, separate limitation survives out of scope: once
 * two ids exist for the same natural key, `getPropertyValues` (and every
 * other reader of `property_values_v`, unrelated to the three patched
 * functions) can list both — logged as "грабли" in the knowledge base rather
 * than fixed here.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
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
): { value_text: string | null; deleted: number } | undefined {
  return ndb
    .prepare(
      `SELECT value_text, deleted FROM property_values
       WHERE owner_type = 'thought' AND owner_id = ? AND property_id = ? AND layer_id = ?`,
    )
    .get(ownerId, propertyId, layerId) as { value_text: string | null; deleted: number } | undefined;
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
  },
);
