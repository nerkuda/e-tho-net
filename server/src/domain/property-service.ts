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
  type EffectiveTypeProperty,
  type PropertyDefinition,
  type PropertyDefinitionInput,
  type PropertyDefinitionUpdateInput,
  type PropertyOwnerType,
  type PropertyValueType,
  type PropertyValue,
  type PropertyValueValue,
  type ResolvedPropertyValue,
  type ThoughtCardWarning,
  type ThoughtUsage,
  type ThoughtUsageGroup,
  type TypeOwnerType,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { rowToThoughtRef } from './thought-service.js';
import {
  expandTypeIdsToSubtree,
  getRootTypeId,
  subtreeIds,
  typeAncestors,
  type TypeTable,
} from './type-hierarchy.js';

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

// ===========================================================================
// Hierarchy (L21): chain-resolved definitions + default-value overrides
// ===========================================================================

/** The type table that stores owners of the given type_properties owner. */
function ownerTypeTable(ownerType: TypeOwnerType): TypeTable {
  return ownerType === 'thought_type' ? 'thought_types' : 'link_types';
}

/** Display name of a type from its owner table (link types: «fwd / rev»). */
function ownerTypeName(ndb: NetworkDb, ownerType: TypeOwnerType, ownerId: string): string {
  if (ownerType === 'thought_type') {
    const row = ndb.prepare('SELECT name FROM thought_types WHERE id = ?').get(ownerId) as
      | { name: string }
      | undefined;
    return row?.name ?? ownerId;
  }
  const row = ndb
    .prepare('SELECT name_forward, name_reverse FROM link_types WHERE id = ?')
    .get(ownerId) as { name_forward: string; name_reverse: string } | undefined;
  return row ? `${row.name_forward} / ${row.name_reverse}` : ownerId;
}

/**
 * The chain of type ids whose property definitions are visible to a thought/
 * link of type `typeId`: the type itself, its ancestors up to the root — and,
 * when `typeId` is `null` (an untyped owner), just the root type, whose
 * settings apply to every element without a type (docs/08-ui-spec.md §8.1).
 * Ordered from the type itself up to the root.
 */
function visibleTypeChain(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  typeId: string | null,
): string[] {
  const table = ownerTypeTable(ownerType);
  if (typeId === null) {
    const rootId = getRootTypeId(ndb, table);
    return rootId === null ? [] : [rootId];
  }
  return typeAncestors(ndb, table, typeId);
}

/** The default-value override a type holds for a property, or `null`. */function getOverride(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  typeId: string,
  propertyId: string,
): PropertyValueValue {
  const row = ndb
    .prepare(
      'SELECT default_value FROM type_property_overrides WHERE owner_type = ? AND type_id = ? AND property_id = ?',
    )
    .get(ownerType, typeId, propertyId) as { default_value: string } | undefined;
  return row ? (JSON.parse(row.default_value) as PropertyValueValue) : null;
}

/**
 * Effective property definitions of a type (L21, docs/02-data-model.md §3.4.1):
 * the type's own definitions plus everything inherited from its ancestors,
 * ordered from the root down to the type. `default_value` on each entry is the
 * effective default — the override stored on this type (inherited properties
 * only), else the definition's own `config.default_value`.
 */
export function listEffectiveTypeProperties(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
): EffectiveTypeProperty[] {
  const chainRootFirst = [...visibleTypeChain(ndb, ownerType, ownerId)].reverse();
  const out: EffectiveTypeProperty[] = [];
  for (const typeId of chainRootFirst) {
    for (const def of listTypeProperties(ndb, ownerType, typeId)) {
      const inherited = typeId !== ownerId;
      const override = inherited ? getOverride(ndb, ownerType, ownerId, def.id) : null;
      const ownDefault = def.config?.default_value ?? null;
      out.push({
        ...def,
        inherited,
        defined_on: typeId,
        defined_on_name: ownerTypeName(ndb, ownerType, typeId),
        default_value: inherited ? (override ?? ownDefault) : ownDefault,
        overridden_here: inherited && override !== null,
      });
    }
  }
  return out;
}

/**
 * Set or clear a type's default-value override of an inherited property
 * (docs/03-server-api.md §8). `value = null` deletes the override — the
 * effective default falls back to the definition's own default.
 *
 * Throws `NOT_FOUND` (404) when the property or the type does not exist, and
 * `VALIDATION_ERROR` (422) when the property is defined on the type itself
 * (own defaults are edited through the definition's `config`) or when the
 * value does not match the property's value type.
 */
export function setTypePropertyDefaultOverride(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  propertyId: string,
  value: PropertyValueValue,
): void {
  validateTypeOwnerType(ownerType);
  ndb.transaction(() => {
    const typeRow = ndb
      .prepare(`SELECT id FROM ${ownerTypeTable(ownerType)} WHERE id = ?`)
      .get(ownerId);
    if (!typeRow) {
      throw new EtnError('NOT_FOUND', `type ${ownerId} not found`, { entity: 'type', id: ownerId });
    }
    const def = getTypeProperty(ndb, propertyId);
    if (!def || def.owner_type !== ownerType) {
      throw new EtnError('NOT_FOUND', `property ${propertyId} not found`, {
        entity: 'type_property',
        id: propertyId,
      });
    }
    if (def.owner_id === ownerId) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'own defaults are edited on the property definition itself',
        { entity: 'type_property', id: propertyId, owner_id: ownerId },
      );
    }
    const chain = visibleTypeChain(ndb, ownerType, ownerId);
    if (!chain.includes(def.owner_id)) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'only properties inherited from ancestor types can be overridden',
        { entity: 'type_property', id: propertyId, owner_id: ownerId },
      );
    }
    if (value !== null) {
      validateAndCoerce(ndb, def, value);
    }
    const now = new Date().toISOString();
    if (value === null) {
      ndb
        .prepare(
          'DELETE FROM type_property_overrides WHERE owner_type = ? AND type_id = ? AND property_id = ?',
        )
        .run(ownerType, ownerId, propertyId);
      return;
    }
    ndb
      .prepare(
        `INSERT INTO type_property_overrides (id, owner_type, type_id, property_id, default_value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_type, type_id, property_id) DO UPDATE SET
           default_value = excluded.default_value,
           updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), ownerType, ownerId, propertyId, JSON.stringify(value), now, now);
  });
}

/**
 * A key is available for a definition on `ownerId` when no other definition
 * with the same key exists anywhere in the owner's ancestor chain or subtree —
 * a duplicate would make the effective property list of some type ambiguous.
 */
function assertKeyAvailableInTree(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  key: string,
  exceptPropertyId: string | null,
): void {
  const table = ownerTypeTable(ownerType);
  const scope = new Set<string>(typeAncestors(ndb, table, ownerId));
  for (const id of subtreeIds(ndb, table, ownerId)) scope.add(id);
  const stmt = ndb.prepare(
    'SELECT id FROM type_properties WHERE owner_type = ? AND owner_id = ? AND key = ?',
  );
  for (const typeId of scope) {
    const clash = stmt.get(ownerType, typeId, key) as { id: string } | undefined;
    if (clash && clash.id !== exceptPropertyId) {
      throw new EtnError(
        'DUPLICATE',
        `свойство «${key}» уже есть у этого типа или связанного с ним типа`,
        { owner_type: ownerType, owner_id: ownerId, key, clash_owner_id: typeId },
      );
    }
  }
}

/**
 * Create a property definition on a type (docs/03-server-api.md §8). `position`
 * defaults to one past the current maximum so new properties land last.
 *
 * Throws `DUPLICATE` (409) if a property with the same key already exists on
 * the owner or on any related type in its ancestor chain / subtree — the
 * effective property list must stay unambiguous (L21).
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
    assertKeyAvailableInTree(ndb, ownerType, ownerId, key, null);
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
 *
 * A multiple `thought_ref` value (`string[]`) degrades to its comma-joined
 * id list when converted to text — mirroring how multiple text values are
 * stored — and is cleared for every other target type.
 */
function convertStoredValue(
  value: string | number | boolean | string[],
  to: PropertyValueType,
): { column: string; raw: string | number | null } | null {
  if (Array.isArray(value)) {
    if (to === 'text' || to === 'url') return { column: 'value_text', raw: value.join(', ') };
    return null;
  }
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
    // No definition here (only the source value type) — the data-driven array
    // parse inside readValue covers stored multiple values without the flag.
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
      assertKeyAvailableInTree(ndb, current.owner_type, current.owner_id, nextKey, id);
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
 *
 * `thought_ref` (multiple form, 02-data-model.md §3.5): `value_thought_ref`
 * stores either a single raw id or a JSON array of ids. The stored shape wins
 * over the definition's `multiple` flag — an array is always parsed back into
 * `string[]` (never leaked as raw JSON text); with the flag on, a legacy
 * single id is wrapped into a one-element array. Turning `multiple` off never
 * reprocesses already stored values (same rule as `options`/`allowed_type_ids`).
 */
function readValue(
  row: PropertyValueRow,
  valueType: PropertyValueType,
  multiple = false,
): PropertyValueValue {
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
    case 'thought_ref': {
      const raw = row.value_thought_ref;
      if (raw === null) return null;
      if (raw.startsWith('[')) return parseRefIds(raw);
      return multiple ? [raw] : raw;
    }
  }
}

/** `true` when the definition allows several `thought_ref` values. */
function isMultipleRef(def: PropertyDefinition): boolean {
  return def.value_type === 'thought_ref' && def.config?.multiple === true;
}

/**
 * LIKE pattern matching an id inside a stored JSON array of ids
 * (`["a","b"]` → `%"a"%`). Quoting makes the match exact — `%"a"%` does not
 * hit `"ab"`. `%`/`_`/`\` are escaped; pair with `LIKE ? ESCAPE '\'`.
 */
function refLikePattern(id: string): string {
  return `%"${id.replace(/[\\%_]/g, (ch) => `\\${ch}`)}"%`;
}

/**
 * Parse a stored multiple `thought_ref` payload (`["id", …]` JSON) into ids.
 * Defensive against malformed/legacy content: anything that is not a JSON
 * array of strings yields an empty list.
 */
function parseRefIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v !== '');
  } catch {
    return [];
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
 * from the owner thought/link through its type's ancestor chain (L21): the
 * nearest definition with the key wins. An untyped owner sees the root type's
 * properties — the root's settings apply to every element without a type
 * (docs/08-ui-spec.md §8.1). Returns `null` when nothing matches.
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
  if (!row) {
    return null;
  }
  const defOwnerType: TypeOwnerType = ownerType === 'thought' ? 'thought_type' : 'link_type';
  for (const typeId of visibleTypeChain(ndb, defOwnerType, row.tid)) {
    const def = getTypePropertyByKey(ndb, defOwnerType, typeId, key);
    if (def) return def;
  }
  return null;
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
      value: readValue(row, def.value_type, isMultipleRef(def)),
      updated_at: row.updated_at,
    });
  }
  return out;
}

/**
 * MCP-чтение значений свойств (task N4, docs/05-mcp-server.md §4.1): то же,
 * что {@link getPropertyValues}, но `thought_ref`-значения резолвнуты в
 * `{id, title}` — агенту не нужны отдельные вызовы `etn.thoughts.get` на
 * каждую ссылку. Одиночные значения резолвятся LEFT JOIN'ом; множественные
 * (`config.multiple`, массив id) — одним пакетным запросом по всем id массивов.
 * REST-ответ не меняется. `title: null` означает висячую ссылку на удалённую
 * мысль (`value_thought_ref` без SQL FK).
 */
export function getPropertyValuesResolved(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
): ResolvedPropertyValue[] {
  const rows = ndb
    .prepare(
      `SELECT pv.*, t.title AS ref_title
       FROM property_values pv
       LEFT JOIN thoughts t ON t.id = pv.value_thought_ref
       WHERE pv.owner_type = ? AND pv.owner_id = ?`,
    )
    .all(ownerType, ownerId) as Array<PropertyValueRow & { ref_title: string | null }>;
  const prepared: Array<{
    row: PropertyValueRow & { ref_title: string | null };
    def: PropertyDefinition;
    value: PropertyValueValue;
  }> = [];
  for (const row of rows) {
    const def = getTypeProperty(ndb, row.property_id);
    // Skip orphaned values whose definition was deleted — should not happen
    // (the FK cascades), but stay defensive.
    if (!def) continue;
    prepared.push({ row, def, value: readValue(row, def.value_type, isMultipleRef(def)) });
  }
  // Titles of every id stored inside multiple-ref arrays (single refs come
  // from the LEFT JOIN above): one batched lookup.
  const arrayIds = new Set<string>();
  for (const { def, value } of prepared) {
    if (def.value_type === 'thought_ref' && Array.isArray(value)) {
      for (const id of value) arrayIds.add(id);
    }
  }
  const titlesById = new Map<string, string>();
  if (arrayIds.size > 0) {
    const ids = [...arrayIds];
    const titleRows = ndb
      .prepare(`SELECT id, title FROM thoughts WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: string; title: string }>;
    for (const t of titleRows) titlesById.set(t.id, t.title);
  }
  const out: ResolvedPropertyValue[] = [];
  for (const { row, def, value } of prepared) {
    let resolved: ResolvedPropertyValue['value'] = value;
    if (def.value_type === 'thought_ref') {
      if (Array.isArray(value)) {
        resolved = value.map((id) => ({ id, title: titlesById.get(id) ?? null }));
      } else if (typeof value === 'string') {
        resolved = { id: value, title: row.ref_title };
      }
    }
    out.push({
      id: row.id,
      owner_type: ownerType,
      owner_id: ownerId,
      property_id: row.property_id,
      value: resolved,
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
 *
 * Multiple `thought_ref` values are stored as a JSON array of ids
 * (02-data-model.md §3.5), so the match is `= ?` for single ids plus a LIKE
 * on the quoted `%"id"%` fragment for ids inside arrays.
 */
export function findThoughtUsage(ndb: NetworkDb, thoughtId: string): ThoughtUsage {
  const rows = ndb
    .prepare(
      `SELECT pv.property_id AS property_id, tp.key AS property_key,
              t.id, t.title, t.type_id, t.icon, t.icon_kind, t.icon_attachment_id,
              t.active,
              t.fg_color, t.bg_color, t.font_bold, t.font_italic,
              t.font_underline, t.font_strike, t.font_manual
       FROM property_values pv
       JOIN type_properties tp ON tp.id = pv.property_id
       JOIN thoughts t ON t.id = pv.owner_id
       WHERE pv.owner_type = 'thought'
         AND (pv.value_thought_ref = ? OR pv.value_thought_ref LIKE ? ESCAPE '\\')
       ORDER BY tp.key COLLATE NOCASE, t.title_norm COLLATE NOCASE`,
    )
    .all(thoughtId, refLikePattern(thoughtId)) as Array<{
    property_id: string;
    property_key: string;
    id: string;
    title: string;
    type_id: string | null;
    icon: string | null;
    icon_kind: string;
    icon_attachment_id: string | null;
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
  return { total: rows.length, groups, holding_layers: [] };
}

/**
 * Number of distinct thoughts referencing `thoughtId` through a `thought_ref`
 * property value (single or inside a multiple-ref JSON array). Backs the
 * "использование в свойствах" blocking arm of the S13 deletion check
 * (02-data-model.md §3.1.2, 03-server-api.md §6.5a).
 */
export function countThoughtRefUsages(ndb: NetworkDb, thoughtId: string): number {
  const row = ndb
    .prepare(
      `SELECT COUNT(DISTINCT pv.owner_id) AS c
       FROM property_values pv
       WHERE pv.owner_type = 'thought'
         AND (pv.value_thought_ref = ? OR pv.value_thought_ref LIKE ? ESCAPE '\\')`,
    )
    .get(thoughtId, refLikePattern(thoughtId)) as { c: number };
  return row.c;
}

/**
 * Null out every `thought_ref` value referencing `thoughtId` (single and
 * multiple form) in one sweep — «Очистить использование» (03-server-api.md
 * §9.2). Returns how many property-value rows were cleared.
 */
export function clearThoughtRefUsages(ndb: NetworkDb, thoughtId: string): number {
  const result = ndb
    .prepare(
      `UPDATE property_values SET value_thought_ref = NULL, updated_at = ?
       WHERE owner_type = 'thought'
         AND (value_thought_ref = ? OR value_thought_ref LIKE ? ESCAPE '\\')`,
    )
    .run(new Date().toISOString(), thoughtId, refLikePattern(thoughtId));
  return result.changes;
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
 * Multiple `thought_ref` (`config.multiple = true`, 02-data-model.md §3.4):
 * the value may be an array of thought ids — every id is validated exactly
 * like a single one, duplicates collapse, an empty array clears the value
 * (same as `null`). A single id is still accepted and stored as a one-element
 * array. Definitions without the flag reject arrays outright.
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
      // Multiple form first: an array of ids, each validated like a single one.
      if (Array.isArray(value)) {
        if (!isMultipleRef(def)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `property "${def.key}" does not allow multiple values`,
            { key: def.key, expected: 'thought_ref', multiple: false },
          );
        }
        const ids = [...new Set(value)];
        if (ids.length === 0) {
          // An empty selection clears the value (same as null).
          return { column, raw: null };
        }
        if (ids.some((id) => typeof id !== 'string')) {
          throw new EtnError('VALIDATION_ERROR', `property "${def.key}" expects thought ids`, {
            key: def.key,
            expected: 'thought_ref',
          });
        }
        for (const id of ids) {
          validateThoughtRefTarget(ndb, def, id);
        }
        return { column, raw: JSON.stringify(ids) };
      }
      if (typeof value !== 'string') {
        throw new EtnError('VALIDATION_ERROR', `property "${def.key}" expects a thought id`, {
          key: def.key,
          expected: 'thought_ref',
        });
      }
      validateThoughtRefTarget(ndb, def, value);
      // On a multiple definition a single id is normalized to a one-element
      // array, so the stored shape matches the definition.
      return { column, raw: isMultipleRef(def) ? JSON.stringify([value]) : value };
    }
  }
}

/**
 * Validate one `thought_ref` id against the definition: the thought must
 * exist, and when the config names allowed types the target's type must be
 * among them (subtree-expanded, L21).
 */
function validateThoughtRefTarget(
  ndb: NetworkDb,
  def: PropertyDefinition,
  id: string,
): void {
  const target = ndb.prepare('SELECT type_id FROM thoughts WHERE id = ?').get(id) as
    { type_id: string | null } | undefined;
  if (!target) {
    throw new EtnError('VALIDATION_ERROR', `referenced thought ${id} does not exist`, {
      key: def.key,
      ref: id,
    });
  }
  // Type filter: the list form supersedes the legacy single allowed_type_id.
  // Only writes are checked — already stored values are never reprocessed
  // when the filter changes (02-data-model.md §3.4). Since L21 the filter
  // matches whole subtrees: a referenced thought passes when its type is
  // a descendant of (or equal to) any allowed type (docs/08-ui-spec.md §8.1).
  const allowedIds = expandTypeIdsToSubtree(
    ndb,
    'thought_types',
    (
      def.config?.allowed_type_ids ??
      (def.config?.allowed_type_id !== undefined ? [def.config.allowed_type_id] : [])
    ).filter((id) => id !== ''),
  );
  if (allowedIds.length > 0 && (target.type_id === null || !allowedIds.includes(target.type_id))) {
    throw new EtnError('VALIDATION_ERROR', `thought ${id} is not of a required type`, {
      key: def.key,
      ref: id,
      allowed_type_ids: allowedIds,
      actual_type_id: target.type_id,
    });
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
      value: readValue(stored, def.value_type, isMultipleRef(def)),
      updated_at: stored.updated_at,
    };
  });
}

/**
 * Write a map of property values in one transaction (task O2,
 * docs/05-mcp-server.md §4.2). Each entry is validated and upserted exactly as
 * {@link setPropertyValue} does; the surrounding transaction makes the whole
 * set atomic — a failure on any key (undefined property, value-type mismatch)
 * rolls back every other value already written.
 *
 * Returns the stored values keyed by the property key.
 */
export function setPropertyValues(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  values: Record<string, PropertyValueValue>,
): Record<string, PropertyValue> {
  return ndb.transaction(() => {
    const stored: Record<string, PropertyValue> = {};
    for (const [key, value] of Object.entries(values)) {
      stored[key] = setPropertyValue(ndb, ownerType, ownerId, key, value);
    }
    return stored;
  });
}

/**
 * Compute "card completeness" warnings for a thought (task O6,
 * docs/05-mcp-server.md §4.2). Returns one entry per `required` property in
 * the thought's effective type chain (L21, own + inherited) for which there
 * is no stored value on this card.
 *
 * The check runs against the live `property_values` table — defaults set via
 * `type_property_overrides` / `config.default_value` are not stored rows and
 * therefore do NOT mask the warning (they apply to *future* values; the
 * existing card still lacks a stored one). Thoughts without a type never
 * report warnings — the root type intentionally carries no required
 * properties (its settings apply implicitly to untyped thoughts,
 * docs/08-ui-spec.md §8.1).
 */
export function computeThoughtCardWarnings(
  ndb: NetworkDb,
  thoughtId: string,
): ThoughtCardWarning[] {
  const row = ndb.prepare('SELECT type_id FROM thoughts WHERE id = ?').get(thoughtId) as
    | { type_id: string | null }
    | undefined;
  if (row === undefined || row.type_id === null) {
    return [];
  }
  const effective = listEffectiveTypeProperties(ndb, 'thought_type', row.type_id);
  if (effective.length === 0) {
    return [];
  }
  // Map (key → value) of everything currently stored on the thought.
  const stored = new Map<string, PropertyValueValue>();
  for (const v of getPropertyValues(ndb, 'thought', thoughtId)) {
    stored.set(keyOf(ndb, v.property_id), v.value);
  }
  const warnings: ThoughtCardWarning[] = [];
  for (const def of effective) {
    if (!def.required) continue;
    if (hasValue(stored.get(def.key))) continue;
    warnings.push({
      code: 'REQUIRED_PROPERTY_MISSING',
      key: def.key,
      property_id: def.id,
      defined_on: def.defined_on,
      value_type: def.value_type,
      inherited: def.inherited,
    });
  }
  return warnings;
}

/** Resolve a property definition's `key` from its id (small N, in-memory). */
function keyOf(ndb: NetworkDb, propertyId: string): string {
  const row = ndb.prepare('SELECT key FROM type_properties WHERE id = ?').get(propertyId) as
    | { key: string }
    | undefined;
  return row?.key ?? propertyId;
}

/**
 * A stored value counts as "filled" for the purpose of required-property
 * warnings when it is not the absence marker (`null`). Empty strings are
 * treated as filled for `text`/`url`/`date` — they are legitimate values
 * (e.g. an empty note is still a note), and conflating them with "unset"
 * would surprise callers who set `""` deliberately. An empty `thought_ref`
 * array, in contrast, is an empty selection (writes normalize it away, so
 * this only guards hand-crafted rows) and counts as unset.
 */
function hasValue(value: PropertyValueValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  return !(Array.isArray(value) && value.length === 0);
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
