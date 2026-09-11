/**
 * Test fixture helper: seed a `thought_ref` registry property + type binding
 * directly (raw SQL), bypassing the registry's value-type guard.
 *
 * Since 0.8.1 the registry no longer accepts `thought_ref` for NEW properties
 * (ADR «вид значения thought_ref упраздняется»), but the VALUE handling of
 * existing `thought_ref` properties keeps working until the migration task.
 * Unit tests that exercise that value handling seed the property here instead
 * of through `createTypeProperty`/`createNetworkProperty`, which now reject the
 * type.
 */

import { randomUUID } from 'node:crypto';

import type { PropertyConfig, PropertyDefinition, TypeOwnerType } from '@etn/shared';

import type { NetworkDb } from '../src/db/network-db.js';

/** Seed a `thought_ref` property bound to a type and return its binding DTO. */
export function seedThoughtRefProperty(
  ndb: NetworkDb,
  ownerType: TypeOwnerType,
  ownerId: string,
  key: string,
  config: PropertyConfig = {},
  userId = 'test-user',
  options: { required?: boolean; position?: number } = {},
): PropertyDefinition {
  const propertyId = randomUUID();
  const bindingId = randomUUID();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const configJson = JSON.stringify(config);
  const required = options.required === true;
  const position = options.position ?? 0;
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description,
                               created_at, updated_at, created_by, updated_by,
                               created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, type_name_key(?), 'thought_ref', ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      propertyId,
      ndb.layerId,
      key,
      key,
      configJson,
      now,
      now,
      userId,
      userId,
      nowMs,
      nowMs,
    );
  ndb
    .prepare(
      `INSERT INTO type_properties (id, layer_id, owner_type, owner_id, property_id, required, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(bindingId, ndb.layerId, ownerType, ownerId, propertyId, required ? 1 : 0, position);
  return {
    id: bindingId,
    property_id: propertyId,
    owner_type: ownerType,
    owner_id: ownerId,
    key,
    value_type: 'thought_ref',
    config,
    required,
    position,
    description: null,
  };
}
