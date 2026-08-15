/**
 * Property service (tasks C5 + C6).
 *
 * Two concerns live here, both keyed by `owner_type`:
 *   * **Type-property definitions** (`type_properties`, C5) — which properties a
 *     thought type or link type exposes. Shared by {@link
 *     './thought-type-service.js'} and {@link './link-type-service.js'}.
 *   * **Property values** (`property_values`, C6) — the actual values stored on
 *     individual thoughts/links. See {@link setPropertyValue} and friends below.
 *
 * The two are deliberately in one module: `property_values.property_id`
 * references `type_properties.id`, and validating a value requires reading its
 * definition, so the definitions are the natural entry point for the value API.
 */

import { randomUUID } from 'node:crypto';

import {
  EtnError,
  PROPERTY_VALUE_TYPES,
  TYPE_OWNER_TYPES,
  type PropertyDefinition,
  type PropertyDefinitionInput,
  type PropertyDefinitionUpdateInput,
  type PropertyOwnerType,
  type PropertyValueType,
  type PropertyValue,
  type PropertyValueValue,
  type ThoughtUsage,
  type ThoughtUsageGroup,
  type TypeOwnerType,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { rowToThoughtRef } from './thought-service.js';

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

/** A plain ISO date (YYYY-MM-DD, optionally with a time tail). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}($|T)/;

/**
 * Try to convert a stored value to a new value type (L6). Returns the column +
 * raw SQL value to rewrite, or `null` when the value cannot be represented —
 * the caller then clears it. Deliberately conservative: dates never become
 * numbers, thought refs never convert into anything but text.
 */
function convertStoredValue(
  value: string | number | boolean,
  to: PropertyValueType,
): { column: string; raw: string | number | null } | null {
  switch (to) {
    case 'text':
    case 'url': {
      if (typeof value === 'string') return { column: 'value_text', raw: value };
      if (typeof value === 'number') return { column: 'value_text', raw: String(value) };
      return { column: 'value_text', raw: value ? 'true' : 'false' };
    }
    case 'number': {
      if (typeof value === 'number') return { column: 'value_number', raw: value };
      if (typeof value === 'boolean') return { column: 'value_number', raw: value ? 1 : 0 };
      const trimmed = value.trim();
      if (trimmed !== '') {
        const n = Number(trimmed);
        if (Number.isFinite(n)) return { column: 'value_number', raw: n };
      }
      return null;
    }
    case 'date': {
      if (typeof value === 'string' && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value))) {
        return { column: 'value_date', raw: value.slice(0, 10) };
      }
      return null;
    }
    case 'bool': {
      if (typeof value === 'boolean') return { column: 'value_bool', raw: value ? 1 : 0 };
      if (typeof value === 'number' && (value === 0 || value === 1)) {
        return { column: 'value_bool', raw: value };
      }
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (s === 'true' || s === 'да' || s === '1') return { column: 'value_bool', raw: 1 };
        if (s === 'false' || s === 'нет' || s === '0') return { column: 'value_bool', raw: 0 };
      }
      return null;
    }
    case 'thought_ref':
      return null;
  }
}

/**
 * Rewrite every stored value of a property whose `value_type` changed (L6):
 * convertible values move to the new column, the rest are deleted. Runs in the
 * caller's transaction so a failed migration rolls the type change back.
 */
function migratePropertyValues(
  ndb: NetworkDb,
  propertyId: string,
  from: PropertyValueType,
  to: PropertyValueType,
): void {
  const rows = ndb
    .prepare('SELECT * FROM property_values WHERE property_id = ?')
    .all(propertyId) as PropertyValueRow[];
  const now = new Date().toISOString();
  for (const row of rows) {
    const value = readValue(row, from);
    const converted = value === null ? null : convertStoredValue(value, to);
    if (converted === null) {
      ndb.prepare('DELETE FROM property_values WHERE id = ?').run(row.id);
      continue;
    }
    ndb
      .prepare(
        `UPDATE property_values SET
           value_text = NULL, value_date = NULL, value_number = NULL,
           value_bool = NULL, value_thought_ref = NULL,
           ${converted.column} = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(converted.raw, now, row.id);
  }
}

/**
 * Patch a property definition (docs/03-server-api.md §8). Last-write-wins per
 * field. `type_properties` has no `version` column, so there is no If-Match
 * guard here.
 *
 * Changing `value_type` rewrites every stored value of the property in the same
 * transaction: values that fit the new type are converted, the rest are
 * cleared. Changing `key` keeps stored values attached (they reference the
 * property id, not the key).
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
  const nextKey = changes.key !== undefined ? validateKey(changes.key) : undefined;
  const nextType = changes.value_type !== undefined ? validateValueType(changes.value_type) : undefined;

  return ndb.transaction(() => {
    if (nextKey !== undefined && nextKey !== current.key) {
      const dupe = ndb
        .prepare(
          'SELECT 1 FROM type_properties WHERE owner_type = ? AND owner_id = ? AND key = ? AND id <> ?',
        )
        .get(current.owner_type, current.owner_id, nextKey, id);
      if (dupe) {
        throw new EtnError('DUPLICATE', `property "${nextKey}" already exists on this type`, {
          owner_type: current.owner_type,
          owner_id: current.owner_id,
          key: nextKey,
        });
      }
    }
    if (nextType !== undefined && nextType !== current.value_type) {
      migratePropertyValues(ndb, id, current.value_type, nextType);
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    if (nextKey !== undefined) {
      sets.push('key = ?');
      args.push(nextKey);
    }
    if (nextType !== undefined) {
      sets.push('value_type = ?');
      args.push(nextType);
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
  });
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

// ===========================================================================
// Property values (C6)
// ===========================================================================
//
// Stored in `property_values` as polymorphic EAV (owner_type = 'thought' |
// 'link'). Exactly one value_* column is populated per row, chosen by the
// definition's value_type; the rest stay NULL (docs/02-data-model.md §3.5).

/** Raw `property_values` row. */
interface PropertyValueRow {
  id: string;
  owner_type: string;
  owner_id: string;
  property_id: string;
  value_text: string | null;
  value_date: string | null;
  value_number: number | null;
  value_bool: number | null;
  value_thought_ref: string | null;
  updated_at: string;
}

/**
 * Map a stored row back into the typed {@link PropertyValue.value} according to
 * the definition's `value_type`, reading only the matching column.
 */
function readValue(row: PropertyValueRow, valueType: PropertyValueType): PropertyValueValue {
  switch (valueType) {
    case 'text':
    case 'url':
      return row.value_text;
    case 'date':
      return row.value_date;
    case 'number':
      return row.value_number;
    case 'bool':
      return row.value_bool === null ? null : row.value_bool === 1;
    case 'thought_ref':
      return row.value_thought_ref;
  }
}

/**
 * The `value_*` column a value type is stored in. `url` shares `value_text`
 * with `text` (02-data-model.md §3.4). The literal is derived from the
 * validated enum, never from user input.
 */
function storageColumn(valueType: PropertyValueType): string {
  return valueType === 'url' ? 'value_text' : `value_${valueType}`;
}

/** The table that holds the owner row for a given value owner_type. */
function ownerTable(ownerType: PropertyOwnerType): 'thoughts' | 'links' {
  return ownerType === 'thought' ? 'thoughts' : 'links';
}

/**
 * Find the property definition governing `(ownerType, ownerId, key)` by walking
 * from the owner thought/link to its type and that type's properties. Returns
 * `null` when the owner has no type or the type defines no such property.
 */
function resolveDefinition(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  key: string,
): PropertyDefinition | null {
  const row = ndb
    .prepare(`SELECT type_id AS tid FROM ${ownerTable(ownerType)} WHERE id = ?`)
    .get(ownerId) as { tid: string | null } | undefined;
  if (!row || !row.tid) {
    return null;
  }
  const defOwnerType: TypeOwnerType = ownerType === 'thought' ? 'thought_type' : 'link_type';
  return getTypePropertyByKey(ndb, defOwnerType, row.tid, key);
}

/**
 * List all stored property values of an owner (docs/03-server-api.md §9). Each
 * value is returned with the runtime type matching its definition's value_type.
 */
export function getPropertyValues(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
): PropertyValue[] {
  const rows = ndb
    .prepare('SELECT * FROM property_values WHERE owner_type = ? AND owner_id = ?')
    .all(ownerType, ownerId) as PropertyValueRow[];
  const out: PropertyValue[] = [];
  for (const row of rows) {
    const def = getTypeProperty(ndb, row.property_id);
    // Skip orphaned values whose definition was deleted — should not happen
    // (the FK cascades), but stay defensive.
    if (!def) continue;
    out.push({
      id: row.id,
      owner_type: ownerType,
      owner_id: ownerId,
      property_id: row.property_id,
      value: readValue(row, def.value_type),
      updated_at: row.updated_at,
    });
  }
  return out;
}

/**
 * Reverse `thought_ref` lookup (docs/03-server-api.md §9.1): every thought
 * whose property values reference `thoughtId`, grouped by property. Only
 * values on thoughts are searched (`owner_type = 'thought'`). Groups are
 * ordered by property name, items by the owner's normalized title.
 */
export function findThoughtUsage(ndb: NetworkDb, thoughtId: string): ThoughtUsage {
  const rows = ndb
    .prepare(
      `SELECT pv.property_id AS property_id, tp.key AS property_key,
              t.id, t.title, t.type_id, t.icon, t.icon_kind, t.active,
              t.fg_color, t.bg_color, t.font_bold, t.font_italic,
              t.font_underline, t.font_strike, t.font_manual
       FROM property_values pv
       JOIN type_properties tp ON tp.id = pv.property_id
       JOIN thoughts t ON t.id = pv.owner_id
       WHERE pv.owner_type = 'thought' AND pv.value_thought_ref = ?
       ORDER BY tp.key COLLATE NOCASE, t.title_norm COLLATE NOCASE`,
    )
    .all(thoughtId) as Array<{
    property_id: string;
    property_key: string;
    id: string;
    title: string;
    type_id: string | null;
    icon: string | null;
    icon_kind: string;
    active: number;
    fg_color: string | null;
    bg_color: string | null;
    font_bold: number;
    font_italic: number;
    font_underline: number;
    font_strike: number;
    font_manual: number;
  }>;

  const groups: ThoughtUsageGroup[] = [];
  const byProperty = new Map<string, ThoughtUsageGroup>();
  for (const row of rows) {
    let group = byProperty.get(row.property_id);
    if (group === undefined) {
      group = { property_id: row.property_id, key: row.property_key, thoughts: [] };
      byProperty.set(row.property_id, group);
      groups.push(group);
    }
    group.thoughts.push(rowToThoughtRef(row));
  }
  return { total: rows.length, groups };
}

/**
 * Validate `value` against the definition's `value_type` and return the column
 * name + raw SQL value to write.
 *
 * The returned `column` is always one of the fixed `value_*` literals derived
 * from `value_type` (never user input), which is what makes it safe to splice
 * into the upsert statement. For `thought_ref`, when the definition's config
 * names an `allowed_type_id`, the referenced thought must be of that type.
 *
 * @returns the column name and the raw SQL value (or `null` to clear).
 */
function validateAndCoerce(
  ndb: NetworkDb,
  def: PropertyDefinition,
  value: PropertyValueValue,
): { column: string; raw: string | number | null } {
  // `value_type` is an enum member (validated on definition write), so the
  // interpolated column is one of the fixed `value_*` literals.
  const column = storageColumn(def.value_type);
  if (value === null) {
    return { column, raw: null };
  }
  switch (def.value_type) {
    case 'text':
    case 'url':
      if (typeof value !== 'string') {
        throw new EtnError('VALIDATION_ERROR', `property "${def.key}" expects text`, {
          key: def.key,
          expected: def.value_type,
        });
      }
      return { column, raw: value };
    case 'date':
      if (typeof value !== 'string') {
        throw new EtnError(
          'VALIDATION_ERROR',
          `property "${def.key}" expects an ISO-8601 date string`,
          {
            key: def.key,
            expected: 'date',
          },
        );
      }
      return { column, raw: value };
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new EtnError('VALIDATION_ERROR', `property "${def.key}" expects a number`, {
          key: def.key,
          expected: 'number',
        });
      }
      return { column, raw: value };
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new EtnError('VALIDATION_ERROR', `property "${def.key}" expects a boolean`, {
          key: def.key,
          expected: 'bool',
        });
      }
      return { column, raw: value ? 1 : 0 };
    case 'thought_ref': {
      if (typeof value !== 'string') {
        throw new EtnError('VALIDATION_ERROR', `property "${def.key}" expects a thought id`, {
          key: def.key,
          expected: 'thought_ref',
        });
      }
      const target = ndb.prepare('SELECT type_id FROM thoughts WHERE id = ?').get(value) as
        { type_id: string | null } | undefined;
      if (!target) {
        throw new EtnError('VALIDATION_ERROR', `referenced thought ${value} does not exist`, {
          key: def.key,
          ref: value,
        });
      }
      // Type filter: the list form supersedes the legacy single allowed_type_id.
      // Only writes are checked — already stored values are never reprocessed
      // when the filter changes (02-data-model.md §3.4).
      const allowedIds = (
        def.config?.allowed_type_ids ??
        (def.config?.allowed_type_id !== undefined ? [def.config.allowed_type_id] : [])
      ).filter((id) => id !== '');
      if (
        allowedIds.length > 0 &&
        (target.type_id === null || !allowedIds.includes(target.type_id))
      ) {
        throw new EtnError(
          'VALIDATION_ERROR',
          `thought ${value} is not of a required type`,
          { key: def.key, ref: value, allowed_type_ids: allowedIds, actual_type_id: target.type_id },
        );
      }
      return { column, raw: value };
    }
  }
}

/**
 * Upsert a property value addressed by key (docs/03-server-api.md §9).
 *
 * The value is validated against the property definition found on the owner's
 * type and written **only** to the matching `value_*` column; the other value
 * columns are set to NULL. Passing `null` clears the value.
 *
 * Throws:
 *   * `NOT_FOUND` (404) if the owner or its type has no such property;
 *   * `VALIDATION_ERROR` (422) if the value does not match `value_type` (or, for
 *     `thought_ref`, references a missing/wrong-typed thought).
 */
export function setPropertyValue(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  key: string,
  value: PropertyValueValue,
): PropertyValue {
  if (ownerType !== 'thought' && ownerType !== 'link') {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${ownerType}`, {
      field: 'owner_type',
    });
  }
  return ndb.transaction(() => {
    // Ensure the owner exists.
    const owner = ndb.prepare(`SELECT 1 FROM ${ownerTable(ownerType)} WHERE id = ?`).get(ownerId);
    if (!owner) {
      throw new EtnError('NOT_FOUND', `${ownerType} ${ownerId} not found`, {
        entity: ownerType,
        id: ownerId,
      });
    }
    const def = resolveDefinition(ndb, ownerType, ownerId, key);
    if (!def) {
      throw new EtnError('NOT_FOUND', `property "${key}" is not defined on this owner's type`, {
        owner_type: ownerType,
        owner_id: ownerId,
        key,
      });
    }

    const { column, raw } = validateAndCoerce(ndb, def, value);
    const now = new Date().toISOString();
    const id = randomUUID();
    // Upsert: write the raw value into the matching column on INSERT, and on
    // conflict reset every value_* column before copying the matching one back,
    // so the single-column rule holds even if value_type changed since the last
    // write. `column` is a fixed `value_*` literal derived from value_type.
    ndb
      .prepare(
        `INSERT INTO property_values (id, owner_type, owner_id, property_id, ${column}, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_type, owner_id, property_id) DO UPDATE SET
           value_text = NULL,
           value_date = NULL,
           value_number = NULL,
           value_bool = NULL,
           value_thought_ref = NULL,
           ${column} = excluded.${column},
           updated_at = excluded.updated_at`,
      )
      .run(id, ownerType, ownerId, def.id, raw, now);

    const stored = ndb
      .prepare(
        'SELECT * FROM property_values WHERE owner_type = ? AND owner_id = ? AND property_id = ?',
      )
      .get(ownerType, ownerId, def.id) as PropertyValueRow;
    return {
      id: stored.id,
      owner_type: ownerType,
      owner_id: ownerId,
      property_id: def.id,
      value: readValue(stored, def.value_type),
      updated_at: stored.updated_at,
    };
  });
}

/**
 * Delete a stored property value addressed by key. Throws `NOT_FOUND` (404) if
 * the property is undefined or no value is stored for that key.
 */
export function deletePropertyValue(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  key: string,
): { property_id: string } {
  if (ownerType !== 'thought' && ownerType !== 'link') {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${ownerType}`, {
      field: 'owner_type',
    });
  }
  return ndb.transaction(() => {
    const def = resolveDefinition(ndb, ownerType, ownerId, key);
    if (!def) {
      throw new EtnError('NOT_FOUND', `property "${key}" is not defined on this owner's type`, {
        owner_type: ownerType,
        owner_id: ownerId,
        key,
      });
    }
    const result = ndb
      .prepare(
        'DELETE FROM property_values WHERE owner_type = ? AND owner_id = ? AND property_id = ?',
      )
      .run(ownerType, ownerId, def.id);
    if (result.changes === 0) {
      throw new EtnError('NOT_FOUND', `no value stored for property "${key}"`, {
        owner_type: ownerType,
        owner_id: ownerId,
        key,
      });
    }
    // Return the property_id so routes can emit `property-value.deleted`
    // (task E3 wiring) without a second lookup.
    return { property_id: def.id };
  });
}
