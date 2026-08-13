/**
 * Property service — type-property definitions (task C5).
 *
 * Defines which properties a thought type or link type exposes (`type_properties`,
 * docs/02-data-model.md §3.4). Shared by {@link './thought-type-service.js'} and
 * {@link './link-type-service.js'} through the `owner_type` parameter.
 *
 * The companion value API (`property_values`) is added in task C6 — definitions
 * are the natural entry point there, since validating a value requires reading
 * its definition.
 */

import { randomUUID } from 'node:crypto';

import {
  EtnError,
  PROPERTY_VALUE_TYPES,
  TYPE_OWNER_TYPES,
  type PropertyDefinition,
  type PropertyDefinitionInput,
  type PropertyDefinitionUpdateInput,
  type PropertyValueType,
  type TypeOwnerType,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

// ===========================================================================
// Type-property definitions (C5)
// ===========================================================================

/** Raw `type_properties` row (INTEGER boolean). */
interface TypePropertyRow {
  id: string;
  owner_type: string;
  owner_id: string;
  key: string;
  value_type: string;
  config: string | null;
  required: number;
  position: number;
}

/** Convert a raw row into a {@link PropertyDefinition}. */
function rowToPropertyDefinition(row: TypePropertyRow): PropertyDefinition {
  return {
    id: row.id,
    owner_type: row.owner_type as TypeOwnerType,
    owner_id: row.owner_id,
    key: row.key,
    value_type: row.value_type as PropertyValueType,
    config: row.config ? (JSON.parse(row.config) as PropertyDefinition['config']) : null,
    required: row.required === 1,
    position: row.position,
  };
}

/** Validate a property key: non-empty string. */
function validateKey(key: unknown): string {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new EtnError('VALIDATION_ERROR', 'property key must be a non-empty string', {
      field: 'key',
    });
  }
  return key.trim();
}

/** Validate a value type against the accepted enum. */
function validateValueType(valueType: unknown): PropertyValueType {
  if (
    typeof valueType !== 'string' ||
    !(PROPERTY_VALUE_TYPES as readonly string[]).includes(valueType)
  ) {
    throw new EtnError('VALIDATION_ERROR', `invalid value_type: ${String(valueType)}`, {
      field: 'value_type',
      allowed: PROPERTY_VALUE_TYPES,
    });
  }
  return valueType as PropertyValueType;
}

/** Validate an owner type for type_properties ('thought_type' | 'link_type'). */
function validateTypeOwnerType(ownerType: unknown): TypeOwnerType {
  if (
    typeof ownerType !== 'string' ||
    !(TYPE_OWNER_TYPES as readonly string[]).includes(ownerType)
  ) {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${String(ownerType)}`, {
      field: 'owner_type',
    });
  }
  return ownerType as TypeOwnerType;
}

/**
 * List the property definitions of a type, ordered by `position` then `key`
 * (docs/03-server-api.md §8).
 */
export function listTypeProperties(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
): PropertyDefinition[] {
  const rows = ndb
    .prepare(
      'SELECT * FROM type_properties WHERE owner_type = ? AND owner_id = ? ORDER BY position, key',
    )
    .all(ownerType, ownerId) as TypePropertyRow[];
  return rows.map(rowToPropertyDefinition);
}

/** Return a property definition by id, or `null` when absent. */
export function getTypeProperty(ndb: NetworkDb, id: string): PropertyDefinition | null {
  const row = ndb.prepare('SELECT * FROM type_properties WHERE id = ?').get(id) as
    TypePropertyRow | undefined;
  return row ? rowToPropertyDefinition(row) : null;
}

/**
 * Look up a property definition by (owner_type, owner_id, key). Used by the
 * value API to resolve the column to write to.
 */
export function getTypePropertyByKey(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  key: string,
): PropertyDefinition | null {
  const row = ndb
    .prepare('SELECT * FROM type_properties WHERE owner_type = ? AND owner_id = ? AND key = ?')
    .get(ownerType, ownerId, key) as TypePropertyRow | undefined;
  return row ? rowToPropertyDefinition(row) : null;
}

/**
 * Create a property definition on a type (docs/03-server-api.md §8). `position`
 * defaults to one past the current maximum so new properties land last.
 *
 * Throws `DUPLICATE` (409) if a property with the same key already exists on the
 * owner.
 */
export function createTypeProperty(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  input: PropertyDefinitionInput,
): PropertyDefinition {
  validateTypeOwnerType(ownerType);
  const key = validateKey(input.key);
  const valueType = validateValueType(input.value_type);
  const id = randomUUID();

  return ndb.transaction(() => {
    const existing = ndb
      .prepare('SELECT 1 FROM type_properties WHERE owner_type = ? AND owner_id = ? AND key = ?')
      .get(ownerType, ownerId, key);
    if (existing) {
      throw new EtnError('DUPLICATE', `property "${key}" already exists on this type`, {
        owner_type: ownerType,
        owner_id: ownerId,
        key,
      });
    }
    const position =
      input.position ??
      (
        ndb
          .prepare(
            'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM type_properties WHERE owner_type = ? AND owner_id = ?',
          )
          .get(ownerType, ownerId) as { p: number }
      ).p;
    const configJson =
      input.config === undefined || input.config === null ? null : JSON.stringify(input.config);
    ndb
      .prepare(
        `INSERT INTO type_properties (id, owner_type, owner_id, key, value_type, config, required, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ownerType, ownerId, key, valueType, configJson, input.required ? 1 : 0, position);
    return getTypeProperty(ndb, id)!;
  });
}

/**
 * Patch a property definition (docs/03-server-api.md §8). Last-write-wins per
 * field. `type_properties` has no `version` column, so there is no If-Match
 * guard here.
 */
export function updateTypeProperty(
  ndb: NetworkDb,
  id: string,
  changes: PropertyDefinitionUpdateInput,
): PropertyDefinition {
  const current = getTypeProperty(ndb, id);
  if (!current) {
    throw new EtnError('NOT_FOUND', `property ${id} not found`, { entity: 'type_property', id });
  }
  const sets: string[] = [];
  const args: unknown[] = [];
  if (changes.value_type !== undefined) {
    sets.push('value_type = ?');
    args.push(validateValueType(changes.value_type));
  }
  if (changes.config !== undefined) {
    sets.push('config = ?');
    args.push(changes.config === null ? null : JSON.stringify(changes.config));
  }
  if (changes.required !== undefined) {
    sets.push('required = ?');
    args.push(changes.required ? 1 : 0);
  }
  if (changes.position !== undefined) {
    sets.push('position = ?');
    args.push(changes.position);
  }
  if (sets.length === 0) {
    return current;
  }
  args.push(id);
  ndb.prepare(`UPDATE type_properties SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return getTypeProperty(ndb, id)!;
}

/** Delete a property definition. Cascades to stored values via SQL FK. */
export function deleteTypeProperty(ndb: NetworkDb, id: string): void {
  const current = getTypeProperty(ndb, id);
  if (!current) {
    throw new EtnError('NOT_FOUND', `property ${id} not found`, { entity: 'type_property', id });
  }
  ndb.prepare('DELETE FROM type_properties WHERE id = ?').run(id);
}

/**
 * Reorder the property definitions of a type by assigning `position = index` to
 * each id in `orderedPropertyIds` (docs/03-server-api.md §8). Ids not listed
 * keep their position. All listed ids must belong to the given owner.
 */
export function reorderTypeProperties(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  orderedPropertyIds: string[],
): PropertyDefinition[] {
  return ndb.transaction(() => {
    const stmt = ndb.prepare(
      'UPDATE type_properties SET position = ? WHERE id = ? AND owner_type = ? AND owner_id = ?',
    );
    orderedPropertyIds.forEach((propId, index) => stmt.run(index, propId, ownerType, ownerId));
    return listTypeProperties(ndb, ownerType, ownerId);
  });
}
