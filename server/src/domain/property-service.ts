/**
 * Property service (0.6.5 — «Унификация работы со свойствами»; задачи C5+C6,
 * затем разделение на справочник и привязки).
 *
 * Three concerns live here, all keyed by `owner_type`:
 *   * **Property registry** (`properties`) — the network-wide nature of a
 *     property (name, value type, config, description). A property exists once
 *     and is attached to any number of thought/link types. Name is unique per
 *     network (case-insensitive, `name_key`), checked against the layer view
 *     `properties_v` (02-data-model.md §3.4a).
 *   * **Type bindings** (`type_properties`) — the property's role in one type:
 *     `required`, `position`. Inheritance goes along the type chain (L21); a
 *     binding on an ancestor makes the property visible to every descendant,
 *     and attaching it to an ancestor drops the descendants' redundant
 *     bindings in the same transaction (значения при этом не меняются — они
 *     адресуются свойством, а не привязкой).
 *   * **Property values** (`property_values`) — the actual values stored on
 *     individual thoughts/links. `property_id` references the registry, so a
 *     value survives type changes and detaches: a value whose property is not
 *     attached to the owner's type chain is read back flagged `outside_type`
 *     and can only be deleted, never written (02-data-model.md §3.5a).
 *
 * Reads go through the `*_v` layer views only (lint layers-s3); writes go
 * through `materializeShadow`/`deleteRowLayered` like every other branchable
 * table (13-layers.md §5).
 */

import { randomUUID } from 'node:crypto';

import {
  EtnError,
  PROPERTY_VALUE_TYPES,
  TYPE_OWNER_TYPES,
  type EffectiveTypeProperty,
  type NetworkProperty,
  type NetworkPropertyInput,
  type NetworkPropertyUpdateInput,
  type PropertyConfig,
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
import { deleteRowLayered, isBaseContext, materializeShadow } from '../db/layer-write.js';
import { rowToThoughtRef } from './thought-service.js';
import {
  expandTypeIdsToSubtree,
  getRootTypeId,
  subtreeIds,
  typeAncestors,
  type TypeTable,
} from './type-hierarchy.js';

// ===========================================================================
// Shared helpers
// ===========================================================================

/** The minimal nature of a property needed to validate/write a value. */
export interface PropertyLike {
  id: string;
  name: string;
  value_type: PropertyValueType;
  config: PropertyConfig | null;
}

/**
 * Normalize an incoming property description: `null`/blank → `null` (no
 * description), otherwise the trimmed string.
 */
function normalizeDescription(description: unknown): string | null {
  if (description === undefined || description === null) return null;
  if (typeof description !== 'string') {
    throw new EtnError('VALIDATION_ERROR', 'description must be a string or null', {
      field: 'description',
    });
  }
  const trimmed = description.trim();
  return trimmed === '' ? null : trimmed;
}

/** Validate a property name: non-empty string. */
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

/** The type table that stores owners of the given binding owner type. */
function ownerTypeTable(ownerType: TypeOwnerType): TypeTable {
  return ownerType === 'thought_type' ? 'thought_types' : 'link_types';
}

/**
 * Обновить `updated_at`/`updated_by`/`updated_at_ms` типа (требование e6d4165e,
 * приравнивание «правка настроек типа → правка самого типа»). Все настройки —
 * подключение свойств, дефолты, описание, реордеринг — касаются типа как
 * сущности и должны быть видны в его DTO.
 *
 * Вызывается внутри уже открытой транзакции (все остальные правки
 * type_properties / type_property_overrides) и сам открывает теневую копию
 * по правилам S4 (13-layers.md §5.1).
 */
function touchType(ndb: NetworkDb, ownerType: TypeOwnerType, ownerId: string, actorUserId: string): void {
  const table = ownerTypeTable(ownerType);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  materializeShadow(ndb, table, ownerId);
  ndb
    .prepare(
      `UPDATE ${table} SET updated_at = ?, updated_by = ?, updated_at_ms = ?, version = version + 1
       WHERE id = ? AND layer_id = ?`,
    )
    .run(now, actorUserId, nowMs, ownerId, ndb.layerId);
}

/**
 * Обновить `updated_at`/`updated_by`/`updated_at_ms` владельца значения
 * свойства (мысли или связи) — требование e6d4165e, приравнивание
 * «правка значения свойства → правка владельца». Без этого `updated_by`
 * карточки мысли застывал бы на времени создания, и вкладка «Метаданные»
 * врала бы.
 *
 * Открывает теневую копию владельца в текущем слое; записи `value_*` и
 * `property_values.updated_at` остаются независимыми (миллисекундные даты
 * значения и владельца могут различаться на пару мс).
 */
function touchOwner(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  actorUserId: string,
): void {
  const table = ownerType === 'thought' ? 'thoughts' : 'links';
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  materializeShadow(ndb, table, ownerId);
  ndb
    .prepare(
      `UPDATE ${table} SET updated_at = ?, updated_by = ?, updated_at_ms = ?, version = version + 1
       WHERE id = ? AND layer_id = ?`,
    )
    .run(now, actorUserId, nowMs, ownerId, ndb.layerId);
}

/** Display name of a type from its owner table (link types: «fwd / rev»). */
function ownerTypeName(ndb: NetworkDb, ownerType: TypeOwnerType, ownerId: string): string {
  if (ownerType === 'thought_type') {
    const row = ndb.prepare('SELECT name FROM thought_types_v WHERE id = ?').get(ownerId) as
      | { name: string }
      | undefined;
    return row?.name ?? ownerId;
  }
  const row = ndb
    .prepare('SELECT name_forward, name_reverse FROM link_types_v WHERE id = ?')
    .get(ownerId) as { name_forward: string; name_reverse: string } | undefined;
  return row ? `${row.name_forward} / ${row.name_reverse}` : ownerId;
}

// ===========================================================================
// Property registry (`properties`) — 0.6.5
// ===========================================================================

/** Raw `properties` row. */
interface PropertyRow {
  id: string;
  name: string;
  name_key: string;
  value_type: string;
  config: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  created_at_ms: number;
  updated_at_ms: number;
}

/** Convert a raw registry row into a {@link NetworkProperty}. */
function rowToNetworkProperty(row: PropertyRow): NetworkProperty {
  return {
    id: row.id,
    name: row.name,
    value_type: row.value_type as PropertyValueType,
    config: row.config ? (JSON.parse(row.config) as PropertyConfig) : null,
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at_ms: row.created_at_ms,
    updated_at_ms: row.updated_at_ms,
  };
}

/** Every property of the registry visible in the connection's layer context. */
export function listNetworkProperties(ndb: NetworkDb): NetworkProperty[] {
  const rows = ndb
    .prepare('SELECT * FROM properties_v ORDER BY name COLLATE NOCASE')
    .all() as PropertyRow[];
  return rows.map(rowToNetworkProperty);
}

/** A registry property by id, or `null` when absent. */
export function getNetworkProperty(ndb: NetworkDb, id: string): NetworkProperty | null {
  const row = ndb.prepare('SELECT * FROM properties_v WHERE id = ?').get(id) as
    | PropertyRow
    | undefined;
  return row ? rowToNetworkProperty(row) : null;
}

/** A registry property by name (case-insensitive), or `null` when absent. */
export function getNetworkPropertyByName(ndb: NetworkDb, name: string): NetworkProperty | null {
  const row = ndb
    .prepare('SELECT * FROM properties_v WHERE name_key = type_name_key(?)')
    .get(name) as PropertyRow | undefined;
  return row ? rowToNetworkProperty(row) : null;
}

/**
 * Throw `DUPLICATE` (409) when another visible property already holds the
 * name. Uniqueness is checked against `properties_v` — the layer's view, not
 * the physical table: the same name may coexist in different layers and only
 * clash at merge time (02-data-model.md §3.4a, «Слои»).
 */
function assertNameAvailable(ndb: NetworkDb, name: string, exceptId: string | null): void {
  const row = ndb
    .prepare('SELECT id FROM properties_v WHERE name_key = type_name_key(?)')
    .get(name) as { id: string } | undefined;
  if (row && row.id !== exceptId) {
    throw new EtnError('DUPLICATE', `свойство «${name}» уже есть в этой мыслесети`, {
      name,
      conflict_property_id: row.id,
    });
  }
}

/**
 * Create a registry property (name must be free, case-insensitively). The row
 * lands in the connection's layer; a same-`name_key` tombstone of this layer
 * is woken by the upsert below.
 */
export function createNetworkProperty(
  ndb: NetworkDb,
  input: NetworkPropertyInput,
  actorUserId: string,
): NetworkProperty {
  const name = validateKey(input.name);
  const valueType = validateValueType(input.value_type);
  const configJson =
    input.config === undefined || input.config === null ? null : JSON.stringify(input.config);
  const description = normalizeDescription(input.description);
  const id = randomUUID();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  assertNameAvailable(ndb, name, null);
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description,
                               created_at, updated_at, created_by, updated_by,
                               created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, type_name_key(?), ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name_key, layer_id) DO UPDATE SET
         deleted = 0,
         name = excluded.name,
         value_type = excluded.value_type,
         config = excluded.config,
         description = excluded.description,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by,
         updated_at_ms = excluded.updated_at_ms`,
    )
    .run(
      id,
      ndb.layerId,
      name,
      name,
      valueType,
      configJson,
      description,
      now,
      now,
      actorUserId,
      actorUserId,
      nowMs,
      nowMs,
    );
  // The conflict arm wakes a same-name tombstone of this layer keeping its
  // ORIGINAL id — re-read by name, never by the fresh uuid.
  return getNetworkPropertyByName(ndb, name)!;
}

/**
 * Patch a registry property (last-write-wins per field). Changing `value_type`
 * rewrites every stored value of the property in the same transaction:
 * convertible values move to the new column, the rest are cleared (L6, and
 * 02-data-model.md §3.4a). Renaming is safe — values address the property by
 * id, not by name.
 */
export function updateNetworkProperty(
  ndb: NetworkDb,
  id: string,
  changes: NetworkPropertyUpdateInput,
  actorUserId: string,
): NetworkProperty {
  const current = getNetworkProperty(ndb, id);
  if (!current) {
    throw new EtnError('NOT_FOUND', `property ${id} not found`, { entity: 'property', id });
  }
  const nextName = changes.name !== undefined ? validateKey(changes.name) : undefined;
  const nextType =
    changes.value_type !== undefined ? validateValueType(changes.value_type) : undefined;

  return ndb.transaction(() => {
    if (nextName !== undefined && nextName !== current.name) {
      assertNameAvailable(ndb, nextName, id);
    }
    if (nextType !== undefined && nextType !== current.value_type) {
      migratePropertyValues(ndb, id, current.value_type, nextType);
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    if (nextName !== undefined) {
      sets.push('name = ?', 'name_key = type_name_key(?)');
      args.push(nextName, nextName);
    }
    if (nextType !== undefined) {
      sets.push('value_type = ?');
      args.push(nextType);
    }
    if (changes.config !== undefined) {
      sets.push('config = ?');
      args.push(changes.config === null ? null : JSON.stringify(changes.config));
    }
    if (changes.description !== undefined) {
      sets.push('description = ?');
      args.push(normalizeDescription(changes.description));
    }
    if (sets.length === 0) {
      return current;
    }
    const nowMs = Date.now();
    sets.push('updated_at = ?', 'updated_by = ?', 'updated_at_ms = ?');
    args.push(new Date(nowMs).toISOString(), actorUserId, nowMs);
    materializeShadow(ndb, 'properties', id);
    args.push(id, ndb.layerId);
    ndb.prepare(`UPDATE properties SET ${sets.join(', ')} WHERE id = ? AND layer_id = ?`).run(
      ...args,
    );
    return getNetworkProperty(ndb, id)!;
  });
}

/**
 * Delete a registry property. Allowed only when the property is attached to
 * nothing and filled nowhere (even a value outside type blocks): the refusal
 * returns two counters — how many types attach it and how many values are
 * stored — so the client can explain what is holding it
 * (02-data-model.md §3.4a «Удаление свойства блокируется»).
 */
export function deleteNetworkProperty(ndb: NetworkDb, id: string): void {
  const current = getNetworkProperty(ndb, id);
  if (!current) {
    throw new EtnError('NOT_FOUND', `property ${id} not found`, { entity: 'property', id });
  }
  const typesCount = (
    ndb
      .prepare('SELECT COUNT(*) AS c FROM type_properties_v WHERE property_id = ?')
      .get(id) as { c: number }
  ).c;
  const valuesCount = (
    ndb
      .prepare('SELECT COUNT(*) AS c FROM property_values_v WHERE property_id = ?')
      .get(id) as { c: number }
  ).c;
  if (typesCount > 0 || valuesCount > 0) {
    throw new EtnError(
      'DUPLICATE',
      'свойство подключено к типам или заполнено — сначала отключите его от всех типов и разберите значения',
      { property_id: id, types_count: typesCount, values_count: valuesCount },
    );
  }
  deleteRowLayered(ndb, 'properties', id);
}

// ===========================================================================
// Type bindings (`type_properties`) — what a type exposes
// ===========================================================================

/** Raw binding row joined with its registry property. */
interface BindingRow {
  id: string;
  owner_type: string;
  owner_id: string;
  property_id: string;
  required: number;
  position: number;
  name: string;
  value_type: string;
  config: string | null;
  description: string | null;
}

/** Convert a joined binding row into a {@link PropertyDefinition}. */
function rowToPropertyDefinition(row: BindingRow): PropertyDefinition {
  return {
    id: row.id,
    property_id: row.property_id,
    owner_type: row.owner_type as TypeOwnerType,
    owner_id: row.owner_id,
    key: row.name,
    value_type: row.value_type as PropertyValueType,
    config: row.config ? (JSON.parse(row.config) as PropertyConfig) : null,
    required: row.required === 1,
    position: row.position,
    description: row.description,
  };
}

const BINDING_SELECT = `SELECT tp.id AS id, tp.owner_type AS owner_type, tp.owner_id AS owner_id,
       tp.property_id AS property_id, tp.required AS required, tp.position AS position,
       p.name AS name, p.value_type AS value_type, p.config AS config, p.description AS description
  FROM type_properties_v tp
  JOIN properties_v p ON p.id = tp.property_id`;

/**
 * List the own bindings of a type, ordered by `position` then name
 * (docs/03-server-api.md §8). The registry nature is merged into each entry.
 */
export function listTypeProperties(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
): PropertyDefinition[] {
  const rows = ndb
    .prepare(`${BINDING_SELECT} WHERE tp.owner_type = ? AND tp.owner_id = ? ORDER BY tp.position, p.name`)
    .all(ownerType, ownerId) as BindingRow[];
  return rows.map(rowToPropertyDefinition);
}

/** Return a binding (with its merged property nature) by binding id, or `null`. */
export function getTypeProperty(ndb: NetworkDb, id: string): PropertyDefinition | null {
  const row = ndb.prepare(`${BINDING_SELECT} WHERE tp.id = ?`).get(id) as
    | BindingRow
    | undefined;
  return row ? rowToPropertyDefinition(row) : null;
}

/**
 * Look up the binding of a property by (owner_type, owner_id, key) — the key
 * resolves against the registry (names are unique per network). Returns `null`
 * when the type does not attach a property with this name.
 */
export function getTypePropertyByKey(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  key: string,
): PropertyDefinition | null {
  const row = ndb
    .prepare(`${BINDING_SELECT} WHERE tp.owner_type = ? AND tp.owner_id = ? AND p.name_key = type_name_key(?)`)
    .get(ownerType, ownerId, key) as BindingRow | undefined;
  return row ? rowToPropertyDefinition(row) : null;
}

// ---------------------------------------------------------------------------
// Hierarchy (L21): chain-resolved bindings + default-value/description overrides
// ---------------------------------------------------------------------------

/**
 * The chain of type ids whose bindings are visible to a thought/link of type
 * `typeId`: the type itself, its ancestors up to the root — and, when `typeId`
 * is `null` (an untyped owner), just the root type, whose settings apply to
 * every element without a type (docs/08-ui-spec.md §8.1). Ordered from the
 * type itself up to the root.
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

/** The override rows a type holds for a property: both payloads at once. */
function getOverrideRow(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  typeId: string,
  propertyId: string,
): { default_value: PropertyValueValue; description: string | null } | null {
  const row = ndb
    .prepare(
      'SELECT default_value, description FROM type_property_overrides_v WHERE owner_type = ? AND type_id = ? AND property_id = ?',
    )
    .get(ownerType, typeId, propertyId) as
    | { default_value: string; description: string | null }
    | undefined;
  return row
    ? { default_value: JSON.parse(row.default_value) as PropertyValueValue, description: row.description }
    : null;
}

/**
 * Effective properties of a type (L21 + 0.6.5, docs/02-data-model.md §3.4.1):
 * the type's own bindings plus everything inherited from its ancestors,
 * ordered from the root down to the type. One property appears once in the
 * chain — ancestors win by position, and the «attach to ancestor drops
 * descendants' bindings» rule keeps the invariant on write.
 *
 * `default_value` and `description` are override-aware and transitive: the
 * deepest type between the defining type and this one that stored an override
 * wins, until a deeper type overrides it again.
 */
export function listEffectiveTypeProperties(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
): EffectiveTypeProperty[] {
  const chainSelfFirst = visibleTypeChain(ndb, ownerType, ownerId);
  const chainRootFirst = [...chainSelfFirst].reverse();
  const out: EffectiveTypeProperty[] = [];
  for (const typeId of chainRootFirst) {
    for (const def of listTypeProperties(ndb, ownerType, typeId)) {
      const inherited = typeId !== ownerId;
      // Transitive overrides: walk from the type itself up to (excluding) the
      // defining type; the first override row found wins (02-data-model.md
      // §3.4.1 «Транзитивность»).
      let override: PropertyValueValue = null;
      let descOverride: string | null = null;
      let overriddenHere = false;
      let descriptionOverridden = false;
      if (inherited) {
        for (const t of chainSelfFirst) {
          if (t === typeId) break;
          const row = getOverrideRow(ndb, ownerType, t, def.property_id);
          if (row === null) continue;
          if (override === null && row.default_value !== null) {
            override = row.default_value;
            overriddenHere = t === ownerId;
          }
          if (descOverride === null && row.description !== null) {
            descOverride = row.description;
            descriptionOverridden = t === ownerId;
          }
          if (override !== null && descOverride !== null) break;
        }
      }
      const ownDefault = def.config?.default_value ?? null;
      out.push({
        ...def,
        inherited,
        defined_on: typeId,
        defined_on_name: ownerTypeName(ndb, ownerType, typeId),
        default_value: inherited ? (override ?? ownDefault) : ownDefault,
        overridden_here: overriddenHere,
        description: inherited ? (descOverride ?? def.description) : def.description,
        description_overridden: descriptionOverridden,
      });
    }
  }
  return out;
}

/**
 * Shared guard of both override setters (default value, description): the type
 * must resolve in the connection's layer context, and the addressed property
 * (by binding id OR registry property id — legacy REST clients address the
 * ancestor's binding, new ones the registry property) must be **inherited from
 * an ancestor** — a property attached by the type itself is edited in the
 * registry (its default and description apply to everyone).
 *
 * Throws `NOT_FOUND` (404) for a missing type/property and `VALIDATION_ERROR`
 * (422) for an own or out-of-chain property.
 */
function assertOverridableInheritedProperty(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  propertyId: string,
): PropertyLike {
  validateTypeOwnerType(ownerType);
  // S5 (13-layers.md §13): the owner must resolve in the connection's layer
  // context — the `_v` view hides types tombstoned in this chain and keeps
  // layer-only types invisible to the base.
  const typeRow = ndb
    .prepare(`SELECT id FROM ${ownerTypeTable(ownerType)}_v WHERE id = ?`)
    .get(ownerId);
  if (!typeRow) {
    throw new EtnError('NOT_FOUND', `type ${ownerId} not found`, { entity: 'type', id: ownerId });
  }
  // Accept a binding id (legacy form: the ancestor's definition id) or a
  // registry property id.
  const binding = ndb
    .prepare('SELECT property_id FROM type_properties_v WHERE id = ?')
    .get(propertyId) as { property_id: string } | undefined;
  const registryId = binding ? binding.property_id : propertyId;
  const prop = getNetworkProperty(ndb, registryId);
  if (!prop) {
    throw new EtnError('NOT_FOUND', `property ${propertyId} not found`, {
      entity: 'type_property',
      id: propertyId,
    });
  }
  const chain = visibleTypeChain(ndb, ownerType, ownerId);
  for (const typeId of chain) {
    const own = ndb
      .prepare(
        'SELECT id FROM type_properties_v WHERE owner_type = ? AND owner_id = ? AND property_id = ?',
      )
      .get(ownerType, typeId, registryId) as { id: string } | undefined;
    if (!own) continue;
    if (typeId === ownerId) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'собственные свойства правятся в справочнике — дефолт и описание сразу для всех типов',
        { entity: 'type_property', id: registryId, owner_id: ownerId },
      );
    }
    break; // found on the nearest chain member — inheritance confirmed
  }
  // Not attached anywhere in the chain at all → cannot be overridden here.
  const attached = ndb
    .prepare(
      `SELECT 1 FROM type_properties_v
       WHERE owner_type = ? AND property_id = ? AND owner_id IN (${chain.map(() => '?').join(', ')})
       LIMIT 1`,
    )
    .get(ownerType, registryId, ...chain);
  if (!attached) {
    throw new EtnError(
      'VALIDATION_ERROR',
      'переопределять можно только свойства, подключённые предками этого типа',
      { entity: 'type_property', id: registryId, owner_id: ownerId },
    );
  }
  return { id: prop.id, name: prop.name, value_type: prop.value_type, config: prop.config };
}

/** The visible override rows of (type, property) — ids plus both payloads. */
function listOverrideRows(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  propertyId: string,
): Array<{ id: string; default_value: string; description: string | null }> {
  return ndb
    .prepare(
      'SELECT id, default_value, description FROM type_property_overrides_v WHERE owner_type = ? AND type_id = ? AND property_id = ?',
    )
    .all(ownerType, ownerId, propertyId) as Array<{
    id: string;
    default_value: string;
    description: string | null;
  }>;
}

/**
 * Set or clear a type's default-value override of an inherited property
 * (docs/03-server-api.md §8). `value = null` resets the default back to the
 * registry's own — an override row that also carries a description override
 * survives with `default_value = 'null'` (JSON null: "no default override").
 *
 * Throws `NOT_FOUND` (404) when the property or the type does not exist, and
 * `VALIDATION_ERROR` (422) when the property is attached by the type itself
 * or does not come from an ancestor.
 */
export function setTypePropertyDefaultOverride(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  propertyId: string,
  value: PropertyValueValue,
  actorUserId: string,
): void {
  ndb.transaction(() => {
    const prop = assertOverridableInheritedProperty(ndb, ownerType, ownerId, propertyId);
    if (value !== null) {
      validateAndCoerce(ndb, prop, value);
    }
    const now = new Date().toISOString();
    if (value === null) {
      // Reset the default only: a row that still carries a description
      // override survives with default_value = 'null' (JSON null reads back
      // as "no override"); a row overriding nothing is removed.
      for (const row of listOverrideRows(ndb, ownerType, ownerId, prop.id)) {
        if (row.description === null) {
          // S4: физически в основе, надгробием в слое (13-layers.md §5.2).
          deleteRowLayered(ndb, 'type_property_overrides', row.id);
          continue;
        }
        materializeShadow(ndb, 'type_property_overrides', row.id);
        ndb
          .prepare(
            'UPDATE type_property_overrides SET default_value = ?, updated_at = ? WHERE id = ? AND layer_id = ?',
          )
          .run('null', now, row.id, ndb.layerId);
      }
    } else {
      // S5 (13-layers.md §5.1): a visible ancestor row for this natural key is
      // shadowed FIRST — a fresh logical id would leave both rows live in this
      // layer's view. The conflict arm updates ONLY default_value, so a
      // description override held by the same row survives.
      const existingOverride = listOverrideRows(ndb, ownerType, ownerId, prop.id)[0];
      if (existingOverride) {
        materializeShadow(ndb, 'type_property_overrides', existingOverride.id);
      }
      ndb
        .prepare(
          `INSERT INTO type_property_overrides (id, layer_id, owner_type, type_id, property_id, default_value, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_type, type_id, property_id, layer_id) DO UPDATE SET
             default_value = excluded.default_value,
             updated_at = excluded.updated_at,
             deleted = 0`,
        )
        .run(randomUUID(), ndb.layerId, ownerType, ownerId, prop.id, JSON.stringify(value), now, now);
    }
    // Любая правка дефолта (включая сброс) — это правка настроек типа:
    // обновим авторство самого типа (требование e6d4165e, приравнивание).
    touchType(ndb, ownerType, ownerId, actorUserId);
  });
}

/**
 * Set or clear a type's description override of an inherited property
 * (docs/03-server-api.md §8.2). `description = null` (or a blank string)
 * resets the effective description back to the registry's own.
 *
 * Semantics mirror {@link setTypePropertyDefaultOverride}; both overrides are
 * transitive down the type subtree until a deeper type overrides them.
 */
export function setTypePropertyDescriptionOverride(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  propertyId: string,
  description: string | null,
  actorUserId: string,
): void {
  const normalized = normalizeDescription(description);
  ndb.transaction(() => {
    const prop = assertOverridableInheritedProperty(ndb, ownerType, ownerId, propertyId);
    const now = new Date().toISOString();
    if (normalized === null) {
      // Reset the description only: a row that still carries a default-value
      // override survives with description = NULL; a row overriding nothing
      // is removed.
      for (const row of listOverrideRows(ndb, ownerType, ownerId, prop.id)) {
        if (JSON.parse(row.default_value) === null) {
          deleteRowLayered(ndb, 'type_property_overrides', row.id);
          continue;
        }
        materializeShadow(ndb, 'type_property_overrides', row.id);
        ndb
          .prepare(
            'UPDATE type_property_overrides SET description = NULL, updated_at = ? WHERE id = ? AND layer_id = ?',
          )
          .run(now, row.id, ndb.layerId);
      }
    } else {
      const existingOverride = listOverrideRows(ndb, ownerType, ownerId, prop.id)[0];
      if (existingOverride) {
        materializeShadow(ndb, 'type_property_overrides', existingOverride.id);
      }
      ndb
        .prepare(
          `INSERT INTO type_property_overrides (id, layer_id, owner_type, type_id, property_id, default_value, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'null', ?, ?, ?)
           ON CONFLICT (owner_type, type_id, property_id, layer_id) DO UPDATE SET
             description = excluded.description,
             updated_at = excluded.updated_at,
             deleted = 0`,
        )
        .run(randomUUID(), ndb.layerId, ownerType, ownerId, prop.id, normalized, now, now);
    }
    // Любая правка описания (включая сброс) — это правка настроек типа:
    // обновим авторство самого типа (требование e6d4165e, приравнивание).
    touchType(ndb, ownerType, ownerId, actorUserId);
  });
}

/**
 * Create-or-attach: the legacy `POST …/types/{id}/properties` entry point.
 *
 * New model (0.6.5): the property lives in the registry.
 *   * a registry property with this name (case-insensitive) already exists →
 *     it is attached to the type as-is; the request's nature fields
 *     (`value_type`/`config`/`description`) are ignored — the registry is the
 *     single source of the property's nature;
 *   * otherwise a registry property is created with the given nature first.
 *
 * Then the binding is created with the given `required`/`position`. Attaching
 * to a type whose ANCESTOR already binds the property is rejected with
 * `DUPLICATE` — the property is already inherited. Attaching to a type drops
 * the same property's redundant bindings across the type's whole SUBTREE in
 * the same transaction (02-data-model.md §3.4.1); values are never touched —
 * they address the property, not the binding.
 *
 * `position` defaults to one past the current maximum so new properties land
 * last. The binding row lands in the connection's layer; a binding tombstone
 * of this layer is woken by the upsert.
 */
export function createTypeProperty(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  input: PropertyDefinitionInput,
  actorUserId: string,
): PropertyDefinition {
  validateTypeOwnerType(ownerType);
  const key = validateKey(input.key);
  return ndb.transaction(() => {
    // S5 (13-layers.md §13): the owner must resolve in the connection's layer
    // context — a base write cannot attach a binding to a layer-only type,
    // and a layer write cannot attach one to a type tombstoned in its chain.
    const owner = ndb
      .prepare(`SELECT id FROM ${ownerTypeTable(ownerType)}_v WHERE id = ?`)
      .get(ownerId);
    if (!owner) {
      throw new EtnError('NOT_FOUND', `type ${ownerId} not found`, { entity: 'type', id: ownerId });
    }

    // Registry first: reuse by name, else create.
    let prop = getNetworkPropertyByName(ndb, key);
    if (!prop) {
      prop = createNetworkProperty(ndb, {
        name: key,
        value_type: validateValueType(input.value_type),
        config: input.config ?? null,
        description: input.description ?? null,
      }, actorUserId);
    }

    // A binding on an ancestor means the property is already inherited — the
    // effective list must keep exactly one entry per property per chain. A
    // visible binding on the type itself is a duplicate attach.
    const chain = visibleTypeChain(ndb, ownerType, ownerId);
    for (const typeId of chain) {
      const clash = ndb
        .prepare(
          'SELECT id FROM type_properties_v WHERE owner_type = ? AND owner_id = ? AND property_id = ?',
        )
        .get(ownerType, typeId, prop.id) as { id: string } | undefined;
      if (!clash) continue;
      if (typeId === ownerId) {
        throw new EtnError('DUPLICATE', `свойство «${key}» уже подключено к этому типу`, {
          owner_type: ownerType,
          owner_id: ownerId,
          key,
          clash_owner_id: typeId,
        });
      }
      throw new EtnError(
        'DUPLICATE',
        `свойство «${key}» уже подключено родительским типом — оно и так наследуется`,
        { owner_type: ownerType, owner_id: ownerId, key, clash_owner_id: typeId },
      );
    }

    // Attaching here makes the same property's bindings across the subtree
    // redundant (02-data-model.md §3.4.1): drop them in this transaction.
    // Values survive — they reference the property, not the binding.
    const table = ownerTypeTable(ownerType);
    for (const typeId of subtreeIds(ndb, table, ownerId)) {
      if (typeId === ownerId) continue;
      const redundant = ndb
        .prepare(
          'SELECT id FROM type_properties_v WHERE owner_type = ? AND owner_id = ? AND property_id = ?',
        )
        .get(ownerType, typeId, prop.id) as { id: string } | undefined;
      if (redundant) {
        deleteRowLayered(ndb, 'type_properties', redundant.id);
      }
    }

    const position =
      input.position ??
      (
        ndb
          .prepare(
            'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM type_properties_v WHERE owner_type = ? AND owner_id = ?',
          )
          .get(ownerType, ownerId) as { p: number }
      ).p;
    const bindingId = randomUUID();
    ndb
      .prepare(
        `INSERT INTO type_properties (id, layer_id, owner_type, owner_id, property_id, required, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_type, owner_id, property_id, layer_id) DO UPDATE SET
           deleted = 0,
           required = excluded.required,
           position = excluded.position`,
      )
      .run(bindingId, ndb.layerId, ownerType, ownerId, prop.id, input.required ? 1 : 0, position);
    // The conflict arm wakes a same-(owner, property) tombstone of this layer
    // keeping its ORIGINAL id — re-read by (owner, key), never by the fresh uuid.
    // Подключение свойства — это правка настроек типа: обновим авторство
    // самого типа (требование e6d4165e, приравнивание).
    touchType(ndb, ownerType, ownerId, actorUserId);
    return getTypePropertyByKey(ndb, ownerType, ownerId, key)!;
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
 * Scope: the values visible in the connection's layer context (matches the
 * write path — a layer edits its own view of the row set).
 */
function migratePropertyValues(
  ndb: NetworkDb,
  propertyId: string,
  from: PropertyValueType,
  to: PropertyValueType,
): void {
  const rows = ndb
    .prepare('SELECT * FROM property_values_v WHERE property_id = ?')
    .all(propertyId) as PropertyValueRow[];
  const now = new Date().toISOString();
  for (const row of rows) {
    // No definition here (only the source value type) — the data-driven array
    // parse inside readValue covers stored multiple values without the flag.
    const value = readValue(row, from);
    const converted = value === null ? null : convertStoredValue(value, to);
    if (converted === null) {
      // S4: физически в основе, надгробием в слое (13-layers.md §5.2).
      deleteRowLayered(ndb, 'property_values', row.id);
      continue;
    }
    materializeShadow(ndb, 'property_values', row.id);
    ndb
      .prepare(
        `UPDATE property_values SET
           value_text = NULL, value_date = NULL, value_number = NULL,
           value_bool = NULL, value_thought_ref = NULL,
           ${converted.column} = ?, updated_at = ?
         WHERE id = ? AND layer_id = ?`,
      )
      .run(converted.raw, now, row.id, ndb.layerId);
  }
}

/**
 * Patch a type property (docs/03-server-api.md §8, legacy surface). The id
 * addresses the BINDING; `required`/`position` edit the binding itself, while
 * `key`/`value_type`/`config`/`description` edit the registry property — and
 * so apply immediately to every type attaching it (0.6.5 semantics).
 *
 * Changing `value_type` rewrites every stored value of the property in the
 * same transaction (see {@link migratePropertyValues}); renaming keeps stored
 * values attached (they reference the property id, not the name).
 */
export function updateTypeProperty(
  ndb: NetworkDb,
  id: string,
  changes: PropertyDefinitionUpdateInput,
  actorUserId: string,
): PropertyDefinition {
  const current = getTypeProperty(ndb, id);
  if (!current) {
    throw new EtnError('NOT_FOUND', `property ${id} not found`, { entity: 'type_property', id });
  }
  const nextKey = changes.key !== undefined ? validateKey(changes.key) : undefined;
  const nextType = changes.value_type !== undefined ? validateValueType(changes.value_type) : undefined;

  return ndb.transaction(() => {
    // Registry-level edits (nature): one property, every attaching type.
    const registryChanges: NetworkPropertyUpdateInput = {};
    if (nextKey !== undefined && nextKey !== current.key) registryChanges.name = nextKey;
    if (nextType !== undefined && nextType !== current.value_type) {
      registryChanges.value_type = nextType;
    }
    if (changes.config !== undefined) registryChanges.config = changes.config;
    if (changes.description !== undefined) registryChanges.description = changes.description;
    if (Object.keys(registryChanges).length > 0) {
      updateNetworkProperty(ndb, current.property_id, registryChanges, actorUserId);
    }
    // Binding-level edits (role in this type).
    const sets: string[] = [];
    const args: unknown[] = [];
    if (changes.required !== undefined) {
      sets.push('required = ?');
      args.push(changes.required ? 1 : 0);
    }
    if (changes.position !== undefined) {
      sets.push('position = ?');
      args.push(changes.position);
    }
    let typeTouched = Object.keys(registryChanges).length > 0;
    if (sets.length > 0) {
      // S4 (13-layers.md §5.1): shadow copy on first edit in a working layer;
      // the UPDATE targets the connection's layer row only.
      materializeShadow(ndb, 'type_properties', id);
      args.push(id, ndb.layerId);
      ndb.prepare(`UPDATE type_properties SET ${sets.join(', ')} WHERE id = ? AND layer_id = ?`).run(
        ...args,
      );
      // Правка роли свойства в типе (required/position) тоже меняет настройки
      // типа: обновим авторство типа (требование e6d4165e).
      typeTouched = true;
    }
    if (typeTouched) {
      touchType(ndb, current.owner_type, current.owner_id, actorUserId);
    }
    return getTypeProperty(ndb, id)!;
  });
}

/**
 * Detach a property from a type (legacy `DELETE …/types/{id}/properties/{id}`
 * surface). Since 0.6.5 the binding carries no values: detaching leaves every
 * stored value in place — it becomes a value outside type, readable with
 * `outside_type: true` and deletable manually (02-data-model.md §3.5a). The
 * pre-0.6.5 cascade (values + overrides deleted with the definition) is gone.
 */
export function deleteTypeProperty(ndb: NetworkDb, id: string, actorUserId: string): void {
  const current = getTypeProperty(ndb, id);
  if (!current) {
    throw new EtnError('NOT_FOUND', `property ${id} not found`, { entity: 'type_property', id });
  }
  // S4 (13-layers.md §5.2): in a working layer the detach materialises a
  // tombstone over the binding; the base rows stay intact.
  deleteRowLayered(ndb, 'type_properties', id);
  // Отключение свойства — это правка настроек типа: обновим авторство
  // самого типа (требование e6d4165e, приравнивание).
  ndb.transaction(() => {
    touchType(ndb, current.owner_type, current.owner_id, actorUserId);
  });
}

/**
 * Reorder the property bindings of a type by assigning `position = index` to
 * each id in `orderedPropertyIds` (docs/03-server-api.md §8). Ids not listed
 * keep their position. All listed ids must belong to the given owner.
 */
export function reorderTypeProperties(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  orderedPropertyIds: string[],
  actorUserId: string,
): PropertyDefinition[] {
  return ndb.transaction(() => {
    // S4: в слое порядок — правка теневых копий привязок (13-layers.md §5.1).
    const stmt = ndb.prepare(
      'UPDATE type_properties SET position = ? WHERE id = ? AND owner_type = ? AND owner_id = ? AND layer_id = ?',
    );
    orderedPropertyIds.forEach((propId, index) => {
      materializeShadow(ndb, 'type_properties', propId);
      stmt.run(index, propId, ownerType, ownerId, ndb.layerId);
    });
    // Реордеринг — правка настроек типа: обновим авторство самого типа
    // (требование e6d4165e, приравнивание).
    touchType(ndb, ownerType, ownerId, actorUserId);
    return listTypeProperties(ndb, ownerType, ownerId);
  });
}

// ===========================================================================
// Property values (C6) — polymorphic EAV on thoughts/links
// ===========================================================================

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
  created_by: string;
  updated_by: string;
  created_at_ms: number;
  updated_at_ms: number;
}

/**
 * Map a stored row back into the typed {@link PropertyValue.value} according to
 * the property's `value_type`, reading only the matching column.
 *
 * `thought_ref` (multiple form): `value_thought_ref` stores either a single raw
 * id or a JSON array of ids; the stored shape wins over the `multiple` flag.
 * `url` behaves the same (JSON array in `value_text`, task 0.6.2).
 */
function readValue(
  row: PropertyValueRow,
  valueType: PropertyValueType,
  multiple = false,
): PropertyValueValue {
  switch (valueType) {
    case 'text':
      return row.value_text;
    case 'url': {
      const raw = row.value_text;
      if (raw === null) return null;
      if (raw.startsWith('[')) return parseRefIds(raw);
      return multiple ? [raw] : raw;
    }
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

/**
 * `true` when the property allows several values of its `value_type`
 * (`thought_ref` and `url` only; `text` keeps its comma-join form).
 */
function isMultipleProperty(prop: PropertyLike): boolean {
  if (prop.config?.multiple !== true) return false;
  return prop.value_type === 'thought_ref' || prop.value_type === 'url';
}

/**
 * LIKE pattern matching an id inside a stored JSON array of ids
 * (`["a","b"]` → `%"a"%`). Quoting makes the match exact.
 */
function refLikePattern(id: string): string {
  return `%"${id.replace(/[\\%_]/g, (ch) => `\\${ch}`)}"%`;
}

/**
 * Parse a stored multiple `thought_ref`/`url` payload (`["id", …]` JSON) into
 * strings. Defensive against malformed/legacy content.
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
 * with `text`. The literal is derived from the validated enum, never from user
 * input.
 */
function storageColumn(valueType: PropertyValueType): string {
  return valueType === 'url' ? 'value_text' : `value_${valueType}`;
}

/**
 * The layer-resolving view of an owner's table (13-layers.md §4.2): owner
 * validation must respect the connection's layer context — a tombstoned owner
 * is a 404 in that layer.
 */
function ownerTable(ownerType: PropertyOwnerType): 'thoughts_v' | 'links_v' {
  return ownerType === 'thought' ? 'thoughts_v' : 'links_v';
}

/**
 * Property ids attached to the owner's type chain (own binding or any
 * ancestor's, L21): the set of properties a value write may target. An
 * untyped owner sees the root type's bindings (docs/08-ui-spec.md §8.1).
 */
function attachedPropertyIds(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
): Set<string> {
  const row = ndb
    .prepare(`SELECT type_id AS tid FROM ${ownerTable(ownerType)} WHERE id = ?`)
    .get(ownerId) as { tid: string | null } | undefined;
  if (!row) {
    throw new EtnError('NOT_FOUND', `${ownerType} ${ownerId} not found`, {
      entity: ownerType,
      id: ownerId,
    });
  }
  const defOwnerType: TypeOwnerType = ownerType === 'thought' ? 'thought_type' : 'link_type';
  const chain = visibleTypeChain(ndb, defOwnerType, row.tid);
  const ids = new Set<string>();
  if (chain.length === 0) return ids;
  const stmt = ndb.prepare(
    `SELECT property_id FROM type_properties_v WHERE owner_type = ? AND owner_id IN (${chain
      .map(() => '?')
      .join(', ')})`,
  );
  for (const r of stmt.all(defOwnerType, ...chain) as Array<{ property_id: string }>) {
    ids.add(r.property_id);
  }
  return ids;
}

/**
 * Resolve a property by NAME against the registry (names are unique per
 * network since 0.6.5, so the name alone addresses the property).
 * Connectivity to the owner's type is NOT checked here — callers decide
 * (writes reject unattached properties with 422, deletes of outside-type
 * values must succeed). Exported for the MCP facade (`etn.properties.set`),
 * which needs the resolved `value_type` to coerce stringified scalars at the
 * transport boundary (docs/05-mcp-server.md §5.2).
 */
export function resolveDefinition(
  ndb: NetworkDb,
  _ownerType: PropertyOwnerType,
  _ownerId: string,
  key: string,
): PropertyLike | null {
  const prop = getNetworkPropertyByName(ndb, key);
  return prop
    ? { id: prop.id, name: prop.name, value_type: prop.value_type, config: prop.config }
    : null;
}

/**
 * List all stored property values of an owner (docs/03-server-api.md §9),
 * including **values outside type** — values whose property is not attached to
 * the owner's type chain (a leftover from a type change or a detached
 * property). Such values carry `outside_type: true` plus the property's name
 * and value type, without which the client could not render them
 * (02-data-model.md §3.5a).
 */
export function getPropertyValues(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
): PropertyValue[] {
  const rows = ndb
    .prepare(
      `SELECT pv.*, p.name AS property_name, p.value_type AS property_value_type, p.config AS property_config
       FROM property_values_v pv
       JOIN properties_v p ON p.id = pv.property_id
       WHERE pv.owner_type = ? AND pv.owner_id = ?`,
    )
    .all(ownerType, ownerId) as Array<PropertyValueRow & {
    property_name: string;
    property_value_type: string;
    property_config: string | null;
  }>;
  const attached = attachedPropertyIds(ndb, ownerType, ownerId);
  const out: PropertyValue[] = [];
  for (const row of rows) {
    const prop: PropertyLike = {
      id: row.property_id,
      name: row.property_name,
      value_type: row.property_value_type as PropertyValueType,
      config: row.property_config ? (JSON.parse(row.property_config) as PropertyConfig) : null,
    };
    out.push({
      id: row.id,
      owner_type: ownerType,
      owner_id: ownerId,
      property_id: row.property_id,
      outside_type: !attached.has(row.property_id),
      property_name: row.property_name,
      value_type: prop.value_type,
      value: readValue(row, prop.value_type, isMultipleProperty(prop)),
      updated_at: row.updated_at,
      created_by: row.created_by,
      updated_by: row.updated_by,
      created_at_ms: row.created_at_ms,
      updated_at_ms: row.updated_at_ms,
    });
  }
  return out;
}

/**
 * MCP-чтение значений свойств (task N4, docs/05-mcp-server.md §4.1): то же,
 * что {@link getPropertyValues}, но `thought_ref`-значения резолвнуты в
 * `{id, title}` — агенту не нужны отдельные вызовы `etn.thoughts.get` на
 * каждую ссылку. Одиночные значения резолвятся LEFT JOIN'ом; множественные —
 * одним пакетным запросом по всем id массивов. REST-ответ не меняется.
 * `title: null` означает висячую ссылку на удалённую мысль.
 */
export function getPropertyValuesResolved(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
): ResolvedPropertyValue[] {
  const rows = ndb
    .prepare(
      `SELECT pv.*, p.name AS property_name, p.value_type AS property_value_type, p.config AS property_config,
              t.title AS ref_title
       FROM property_values_v pv
       JOIN properties_v p ON p.id = pv.property_id
       LEFT JOIN thoughts_v t ON t.id = pv.value_thought_ref
       WHERE pv.owner_type = ? AND pv.owner_id = ?`,
    )
    .all(ownerType, ownerId) as Array<
    PropertyValueRow & {
      property_name: string;
      property_value_type: string;
      property_config: string | null;
      ref_title: string | null;
    }
  >;
  const attached = attachedPropertyIds(ndb, ownerType, ownerId);
  const prepared: Array<{
    row: (typeof rows)[number];
    prop: PropertyLike;
    value: PropertyValueValue;
  }> = [];
  for (const row of rows) {
    const prop: PropertyLike = {
      id: row.property_id,
      name: row.property_name,
      value_type: row.property_value_type as PropertyValueType,
      config: row.property_config ? (JSON.parse(row.property_config) as PropertyConfig) : null,
    };
    prepared.push({ row, prop, value: readValue(row, prop.value_type, isMultipleProperty(prop)) });
  }
  // Titles of every id stored inside multiple-ref arrays: one batched lookup.
  const arrayIds = new Set<string>();
  for (const { prop, value } of prepared) {
    if (prop.value_type === 'thought_ref' && Array.isArray(value)) {
      for (const id of value) arrayIds.add(id);
    }
  }
  const titlesById = new Map<string, string>();
  if (arrayIds.size > 0) {
    const ids = [...arrayIds];
    const titleRows = ndb
      .prepare(`SELECT id, title FROM thoughts_v WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: string; title: string }>;
    for (const t of titleRows) titlesById.set(t.id, t.title);
  }
  const out: ResolvedPropertyValue[] = [];
  for (const { row, prop, value } of prepared) {
    let resolved: ResolvedPropertyValue['value'] = value;
    if (prop.value_type === 'thought_ref') {
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
      outside_type: !attached.has(row.property_id),
      property_name: row.property_name,
      value_type: prop.value_type,
      value: resolved,
      updated_at: row.updated_at,
      created_by: row.created_by,
      updated_by: row.updated_by,
      created_at_ms: row.created_at_ms,
      updated_at_ms: row.updated_at_ms,
    });
  }
  return out;
}

/**
 * Reverse `thought_ref` lookup (docs/03-server-api.md §9.1): every thought
 * whose property values reference `thoughtId`, grouped by property. Since
 * 0.6.5 the grouping is by the registry property — the same field gives one
 * group regardless of the referencing owners' types. Groups are ordered by
 * property name, items by the owner's normalized title.
 *
 * Multiple `thought_ref` values are stored as a JSON array of ids, so the
 * match is `= ?` for single ids plus a LIKE on the quoted `%"id"%` fragment
 * for ids inside arrays.
 */
export function findThoughtUsage(ndb: NetworkDb, thoughtId: string): ThoughtUsage {
  const rows = ndb
    .prepare(
      `SELECT pv.property_id AS property_id, p.name AS property_key,
              t.id, t.title, t.type_id, t.icon, t.icon_kind, t.icon_attachment_id,
              t.active,
              t.fg_color, t.bg_color, t.font_bold, t.font_italic,
              t.font_underline, t.font_strike, t.font_manual
       FROM property_values_v pv
       JOIN properties_v p ON p.id = pv.property_id
       JOIN thoughts_v t ON t.id = pv.owner_id
       WHERE pv.owner_type = 'thought'
         AND (pv.value_thought_ref = ? OR pv.value_thought_ref LIKE ? ESCAPE '\\')
       ORDER BY p.name COLLATE NOCASE, t.title_norm COLLATE NOCASE`,
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
 * "использование в свойствах" blocking arm of the S13 deletion check.
 * The check must see live values of every layer; tombstones do not block.
 */
export function countThoughtRefUsages(ndb: NetworkDb, thoughtId: string): number {
  // layers:physical-read — блокирующее плечо удаления: аудит живых значений ВСЕХ слоёв.
  const row = ndb
    .prepare(
      `SELECT COUNT(DISTINCT pv.owner_id) AS c
       FROM property_values pv -- layers:physical-read
       WHERE pv.owner_type = 'thought' AND pv.deleted = 0
         AND (pv.value_thought_ref = ? OR pv.value_thought_ref LIKE ? ESCAPE '\\')`,
    )
    .get(thoughtId, refLikePattern(thoughtId)) as { c: number };
  return row.c;
}

/**
 * Null out every `thought_ref` value referencing `thoughtId` (single and
 * multiple form) in one sweep — «Очистить использование» (03-server-api.md
 * §9.2). Returns how many property-value rows were cleared.
 *
 * S4: the base-layer sweep clears live rows of every layer; a working layer
 * clears its visible values as shadow edits only.
 */
export function clearThoughtRefUsages(ndb: NetworkDb, thoughtId: string): number {
  const now = new Date().toISOString();
  if (isBaseContext(ndb)) {
    // layers:physical-read — зеркально плечу блокировки: живые значения всех слоёв.
    const result = ndb
      .prepare(
        `UPDATE property_values SET value_thought_ref = NULL, updated_at = ?
         WHERE owner_type = 'thought' AND deleted = 0
           AND (value_thought_ref = ? OR value_thought_ref LIKE ? ESCAPE '\\')`, // layers:physical-read
      )
      .run(now, thoughtId, refLikePattern(thoughtId));
    return result.changes;
  }
  const rows = ndb
    .prepare(
      `SELECT id FROM property_values_v
       WHERE owner_type = 'thought'
         AND (value_thought_ref = ? OR value_thought_ref LIKE ? ESCAPE '\\')`,
    )
    .all(thoughtId, refLikePattern(thoughtId)) as { id: string }[];
  for (const row of rows) {
    materializeShadow(ndb, 'property_values', row.id);
    ndb
      .prepare(
        'UPDATE property_values SET value_thought_ref = NULL, updated_at = ? WHERE id = ? AND layer_id = ?',
      )
      .run(now, row.id, ndb.layerId);
  }
  return rows.length;
}

/**
 * Validate `value` against the property's `value_type` and return the column
 * name + raw SQL value to write.
 *
 * The returned `column` is always one of the fixed `value_*` literals derived
 * from `value_type` (never user input). For `thought_ref`, when the config
 * names allowed types, the referenced thought must be of one of them
 * (subtree-expanded, L21).
 */
function validateAndCoerce(
  ndb: NetworkDb,
  prop: PropertyLike,
  value: PropertyValueValue,
): { column: string; raw: string | number | null } {
  const column = storageColumn(prop.value_type);
  if (value === null) {
    return { column, raw: null };
  }
  switch (prop.value_type) {
    case 'text':
      if (typeof value !== 'string') {
        throw new EtnError('VALIDATION_ERROR', `property "${prop.name}" expects text`, {
          key: prop.name,
          expected: 'text',
        });
      }
      return { column, raw: value };
    case 'url': {
      if (Array.isArray(value)) {
        if (!isMultipleProperty(prop)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `property "${prop.name}" does not allow multiple values`,
            { key: prop.name, expected: 'url', multiple: false },
          );
        }
        const urls = [...new Set(value)];
        if (urls.length === 0) return { column, raw: null };
        if (urls.some((url) => typeof url !== 'string')) {
          throw new EtnError('VALIDATION_ERROR', `property "${prop.name}" expects URL strings`, {
            key: prop.name,
            expected: 'url',
          });
        }
        return { column, raw: JSON.stringify(urls) };
      }
      if (typeof value !== 'string') {
        throw new EtnError('VALIDATION_ERROR', `property "${prop.name}" expects a URL string`, {
          key: prop.name,
          expected: 'url',
        });
      }
      return { column, raw: isMultipleProperty(prop) ? JSON.stringify([value]) : value };
    }
    case 'date':
      if (typeof value !== 'string') {
        throw new EtnError(
          'VALIDATION_ERROR',
          `property "${prop.name}" expects an ISO-8601 date string`,
          { key: prop.name, expected: 'date' },
        );
      }
      return { column, raw: value };
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new EtnError('VALIDATION_ERROR', `property "${prop.name}" expects a number`, {
          key: prop.name,
          expected: 'number',
        });
      }
      return { column, raw: value };
    case 'bool':
      if (typeof value !== 'boolean') {
        throw new EtnError('VALIDATION_ERROR', `property "${prop.name}" expects a boolean`, {
          key: prop.name,
          expected: 'bool',
        });
      }
      return { column, raw: value ? 1 : 0 };
    case 'thought_ref': {
      if (Array.isArray(value)) {
        if (!isMultipleProperty(prop)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `property "${prop.name}" does not allow multiple values`,
            { key: prop.name, expected: 'thought_ref', multiple: false },
          );
        }
        const ids = [...new Set(value)];
        if (ids.length === 0) {
          // An empty selection clears the value (same as null).
          return { column, raw: null };
        }
        if (ids.some((id) => typeof id !== 'string')) {
          throw new EtnError('VALIDATION_ERROR', `property "${prop.name}" expects thought ids`, {
            key: prop.name,
            expected: 'thought_ref',
          });
        }
        for (const id of ids) {
          validateThoughtRefTarget(ndb, prop, id);
        }
        return { column, raw: JSON.stringify(ids) };
      }
      if (typeof value !== 'string') {
        throw new EtnError('VALIDATION_ERROR', `property "${prop.name}" expects a thought id`, {
          key: prop.name,
          expected: 'thought_ref',
        });
      }
      validateThoughtRefTarget(ndb, prop, value);
      return { column, raw: isMultipleProperty(prop) ? JSON.stringify([value]) : value };
    }
  }
}

/**
 * Validate one `thought_ref` id against the property: the thought must exist,
 * and when the config names allowed types the target's type must be among
 * them (subtree-expanded, L21). Only writes are checked — stored values are
 * never reprocessed when the filter changes.
 */
function validateThoughtRefTarget(ndb: NetworkDb, prop: PropertyLike, id: string): void {
  const target = ndb.prepare('SELECT type_id FROM thoughts_v WHERE id = ?').get(id) as
    { type_id: string | null } | undefined;
  if (!target) {
    throw new EtnError('VALIDATION_ERROR', `referenced thought ${id} does not exist`, {
      key: prop.name,
      ref: id,
    });
  }
  const allowedIds = expandTypeIdsToSubtree(
    ndb,
    'thought_types',
    (
      prop.config?.allowed_type_ids ??
      (prop.config?.allowed_type_id !== undefined ? [prop.config.allowed_type_id] : [])
    ).filter((id) => id !== ''),
  );
  if (allowedIds.length > 0 && (target.type_id === null || !allowedIds.includes(target.type_id))) {
    throw new EtnError('VALIDATION_ERROR', `thought ${id} is not of a required type`, {
      key: prop.name,
      ref: id,
      allowed_type_ids: allowedIds,
      actual_type_id: target.type_id,
    });
  }
}

/**
 * Upsert a property value addressed by property name (docs/03-server-api.md §9).
 *
 * The name resolves against the registry; the value is validated against the
 * property's nature and written only to the matching `value_*` column; the
 * other value columns are set to NULL. Passing `null` clears the value.
 *
 * A value may only be written for a property **attached to the owner's type
 * chain** (own binding or an ancestor's) — a registry property the type does
 * not attach is rejected with `VALIDATION_ERROR` (422), which also covers
 * re-writing an existing outside-type value: attach the property first
 * (02-data-model.md §3.5a).
 *
 * Throws:
 *   * `NOT_FOUND` (404) if the owner or the property (by name) is missing;
 *   * `VALIDATION_ERROR` (422) if the property is not attached to the owner's
 *     type, or the value does not match `value_type`.
 */
export function setPropertyValue(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  key: string,
  value: PropertyValueValue,
  actorUserId: string,
): PropertyValue {
  if (ownerType !== 'thought' && ownerType !== 'link') {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${ownerType}`, {
      field: 'owner_type',
    });
  }
  return ndb.transaction(() => {
    // Ensure the owner exists (attachedPropertyIds re-reads it too, but the
    // 404 there must not precede property resolution errors in tests).
    const owner = ndb.prepare(`SELECT 1 FROM ${ownerTable(ownerType)} WHERE id = ?`).get(ownerId);
    if (!owner) {
      throw new EtnError('NOT_FOUND', `${ownerType} ${ownerId} not found`, {
        entity: ownerType,
        id: ownerId,
      });
    }
    const prop = resolveDefinition(ndb, ownerType, ownerId, key);
    if (!prop) {
      throw new EtnError('NOT_FOUND', `property "${key}" does not exist in this network`, {
        owner_type: ownerType,
        owner_id: ownerId,
        key,
      });
    }
    return setPropertyValueForProperty(ndb, ownerType, ownerId, prop, value, { key }, actorUserId);
  });
}

/**
 * The shared write path of {@link setPropertyValue} and
 * {@link setPropertyValueById}: connectivity check (422 when the owner's type
 * chain does not attach the property), validation, layered upsert.
 */
function setPropertyValueForProperty(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  prop: PropertyLike,
  value: PropertyValueValue,
  errKey: { key: string },
  actorUserId: string,
): PropertyValue {
  const attached = attachedPropertyIds(ndb, ownerType, ownerId);
  if (!attached.has(prop.id)) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `property "${errKey.key}" is not attached to this owner's type — attach it first`,
      { owner_type: ownerType, owner_id: ownerId, key: errKey.key, property_id: prop.id },
    );
  }

  const { column, raw } = validateAndCoerce(ndb, prop, value);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const id = randomUUID();
  // S5 (13-layers.md §5.1): a visible ancestor row for this natural key is
  // shadowed FIRST — writing with a fresh logical id would leave both rows
  // live in this layer's view and break the «one value per (owner, property)»
  // invariant of §3.5.
  const existing = ndb
    .prepare(
      'SELECT id FROM property_values_v WHERE owner_type = ? AND owner_id = ? AND property_id = ? LIMIT 1',
    )
    .get(ownerType, ownerId, prop.id) as { id: string } | undefined;
  if (existing) {
    materializeShadow(ndb, 'property_values', existing.id);
  }
  // Upsert: write the raw value into the matching column on INSERT, and on
  // conflict reset every value_* column before copying the matching one back.
  // S4: the row lands in the connection's layer; `deleted = 0` wakes a
  // same-key tombstone of this layer instead of dropping the write silently.
  ndb
    .prepare(
      `INSERT INTO property_values (id, layer_id, owner_type, owner_id, property_id, ${column}, updated_at,
                                   created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_type, owner_id, property_id, layer_id) DO UPDATE SET
         deleted = 0,
         value_text = NULL,
         value_date = NULL,
         value_number = NULL,
         value_bool = NULL,
         value_thought_ref = NULL,
         ${column} = excluded.${column},
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by,
         updated_at_ms = excluded.updated_at_ms`,
    )
    .run(id, ndb.layerId, ownerType, ownerId, prop.id, raw, now, actorUserId, actorUserId, nowMs, nowMs);

  // Правка значения — это правка владельца (требование e6d4165e).
  // Без этого `updated_by` карточки мысли/связи застывал бы на создании,
  // и вкладка «Метаданные» показывала бы чужое имя.
  touchOwner(ndb, ownerType, ownerId, actorUserId);

  const stored = ndb
    .prepare(
      'SELECT * FROM property_values_v WHERE owner_type = ? AND owner_id = ? AND property_id = ?',
    )
    .get(ownerType, ownerId, prop.id) as PropertyValueRow;
  return {
    id: stored.id,
    owner_type: ownerType,
    owner_id: ownerId,
    property_id: prop.id,
    outside_type: false,
    property_name: prop.name,
    value_type: prop.value_type,
    value: readValue(stored, prop.value_type, isMultipleProperty(prop)),
    updated_at: stored.updated_at,
    created_by: stored.created_by,
    updated_by: stored.updated_by,
    created_at_ms: stored.created_at_ms,
    updated_at_ms: stored.updated_at_ms,
  };
}

/**
 * Same as {@link setPropertyValue} but addresses the property by registry id —
 * used by thought creation defaults, where the effective list entry is already
 * resolved (no second name lookup, no ambiguity).
 */
export function setPropertyValueById(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  propertyId: string,
  value: PropertyValueValue,
  actorUserId: string,
): PropertyValue {
  if (ownerType !== 'thought' && ownerType !== 'link') {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${ownerType}`, {
      field: 'owner_type',
    });
  }
  return ndb.transaction(() => {
    const owner = ndb.prepare(`SELECT 1 FROM ${ownerTable(ownerType)} WHERE id = ?`).get(ownerId);
    if (!owner) {
      throw new EtnError('NOT_FOUND', `${ownerType} ${ownerId} not found`, {
        entity: ownerType,
        id: ownerId,
      });
    }
    const registryProp = getNetworkProperty(ndb, propertyId);
    if (!registryProp) {
      throw new EtnError('NOT_FOUND', `property ${propertyId} not found`, {
        entity: 'property',
        id: propertyId,
      });
    }
    const prop: PropertyLike = {
      id: registryProp.id,
      name: registryProp.name,
      value_type: registryProp.value_type,
      config: registryProp.config,
    };
    return setPropertyValueForProperty(
      ndb,
      ownerType,
      ownerId,
      prop,
      value,
      { key: registryProp.name },
      actorUserId,
    );
  });
}

/**
 * Write a map of property values in one transaction (task O2,
 * docs/05-mcp-server.md §4.2). Each entry is validated and upserted exactly as
 * {@link setPropertyValue} does; a failure on any key rolls back the whole set.
 */
export function setPropertyValues(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  values: Record<string, PropertyValueValue>,
  actorUserId: string,
): Record<string, PropertyValue> {
  return ndb.transaction(() => {
    const stored: Record<string, PropertyValue> = {};
    for (const [key, value] of Object.entries(values)) {
      stored[key] = setPropertyValue(ndb, ownerType, ownerId, key, value, actorUserId);
    }
    return stored;
  });
}

/**
 * Compute "card completeness" warnings for a thought (task O6,
 * docs/05-mcp-server.md §4.2). Returns one entry per `required` property in
 * the thought's effective type chain (L21) for which there is no stored value
 * on this card. Matching is by property id — a stored value outside the type
 * still counts as filled (it is the same property).
 *
 * Defaults are not stored rows and therefore do not mask the warning; thoughts
 * without a type never report warnings.
 */
export function computeThoughtCardWarnings(
  ndb: NetworkDb,
  thoughtId: string,
): ThoughtCardWarning[] {
  const row = ndb.prepare('SELECT type_id FROM thoughts_v WHERE id = ?').get(thoughtId) as
    | { type_id: string | null }
    | undefined;
  if (row === undefined || row.type_id === null) {
    return [];
  }
  const effective = listEffectiveTypeProperties(ndb, 'thought_type', row.type_id);
  if (effective.length === 0) {
    return [];
  }
  // Map (property_id → value) of everything currently stored on the thought.
  const stored = new Map<string, PropertyValueValue>();
  for (const v of getPropertyValues(ndb, 'thought', thoughtId)) {
    stored.set(v.property_id, v.value);
  }
  const warnings: ThoughtCardWarning[] = [];
  for (const def of effective) {
    if (!def.required) continue;
    if (hasValue(stored.get(def.property_id))) continue;
    warnings.push({
      code: 'REQUIRED_PROPERTY_MISSING',
      key: def.key,
      property_id: def.property_id,
      defined_on: def.defined_on,
      value_type: def.value_type,
      inherited: def.inherited,
    });
  }
  return warnings;
}

/**
 * A stored value counts as "filled" when it is not the absence marker
 * (`null`). Empty strings are legitimate values; an empty `thought_ref` array
 * is an empty selection and counts as unset.
 */
function hasValue(value: PropertyValueValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  return !(Array.isArray(value) && value.length === 0);
}

/**
 * Delete a stored property value addressed by property name. Outside-type
 * values are deletable — manual removal is the only action available for them
 * (02-data-model.md §3.5a) — so the property only has to exist in the
 * registry, not to be attached to the owner's type. Throws `NOT_FOUND` (404)
 * if the property is unknown or no value is stored for it.
 */
export function deletePropertyValue(
  ndb: NetworkDb,
  ownerType: PropertyOwnerType,
  ownerId: string,
  key: string,
  actorUserId: string,
): { property_id: string } {
  if (ownerType !== 'thought' && ownerType !== 'link') {
    throw new EtnError('VALIDATION_ERROR', `invalid owner_type: ${ownerType}`, {
      field: 'owner_type',
    });
  }
  return ndb.transaction(() => {
    const prop = resolveDefinition(ndb, ownerType, ownerId, key);
    if (!prop) {
      throw new EtnError('NOT_FOUND', `property "${key}" does not exist in this network`, {
        owner_type: ownerType,
        owner_id: ownerId,
        key,
      });
    }
    // S4: в слое значение скрывается надгробием (13-layers.md §5.2), в основе —
    // прежний физический DELETE.
    if (!isBaseContext(ndb)) {
      const rows = ndb
        .prepare(
          'SELECT id FROM property_values_v WHERE owner_type = ? AND owner_id = ? AND property_id = ?',
        )
        .all(ownerType, ownerId, prop.id) as { id: string }[];
      if (rows.length === 0) {
        throw new EtnError('NOT_FOUND', `no value stored for property "${key}"`, {
          owner_type: ownerType,
          owner_id: ownerId,
          key,
        });
      }
      for (const row of rows) deleteRowLayered(ndb, 'property_values', row.id);
      // Удаление значения — правка владельца: обновим авторство
      // (требование e6d4165e, приравнивание).
      touchOwner(ndb, ownerType, ownerId, actorUserId);
      return { property_id: prop.id };
    }
    const result = ndb
      .prepare(
        'DELETE FROM property_values WHERE owner_type = ? AND owner_id = ? AND property_id = ?',
      )
      .run(ownerType, ownerId, prop.id);
    if (result.changes === 0) {
      throw new EtnError('NOT_FOUND', `no value stored for property "${key}"`, {
        owner_type: ownerType,
        owner_id: ownerId,
        key,
      });
    }
    // Удаление значения — правка владельца: обновим авторство
    // (требование e6d4165e, приравнивание).
    touchOwner(ndb, ownerType, ownerId, actorUserId);
    // Return the property_id so routes can emit `property-value.deleted`
    // without a second lookup.
    return { property_id: prop.id };
  });
}
