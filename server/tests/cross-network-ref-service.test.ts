/**
 * Unit-тесты сервиса кросс-сетевых ссылок (задача 7849008a, ADR ae8346d0).
 *
 * Покрывает:
 *   * парсер адреса n:<network>#<thought> — round-trip через форматтер;
 *   * snapshot helpers: read/upsert/delete в служебной таблице
 *     `property_value_cross_refs` (миграция 044);
 *   * `crossResolvePropertyValue` (REST cross-resolve, MCP
 *     `etn.properties.resolve`): обновление снапшота, пометка `unresolved`
 *     для недоступных/удалённых адресов.
 *
 * Сценарий «живой резолв через _system.db при записи» покрывается
 * интеграционными тестами на `etn.thoughts.write` — здесь проверяем
 * чистую логику с уже подготовленным контекстом.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  formatCrossNetworkAddress,
  isCrossNetworkAddress,
  parseCrossNetworkAddress,
} from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  deleteSnapshotPayload,
  readSnapshotPayload,
  upsertSnapshotPayload,
} from '../src/domain/cross-network-ref-service.js';
import { crossResolvePropertyValue } from '../src/domain/property-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const haveNative = nativeAvailable();

describe('parseCrossNetworkAddress', () => {
  it('round-trip: format → parse даёт исходные uuid', () => {
    const nid = randomUUID();
    const tid = randomUUID();
    const addr = formatCrossNetworkAddress(nid, tid);
    assert.equal(isCrossNetworkAddress(addr), true);
    const parsed = parseCrossNetworkAddress(addr);
    assert.deepEqual(parsed, { networkId: nid, thoughtId: tid });
  });

  it('голый uuid без префикса n: — не адрес', () => {
    assert.equal(isCrossNetworkAddress(randomUUID()), false);
    assert.equal(parseCrossNetworkAddress(randomUUID()), null);
  });

  it('невалидный формат — null', () => {
    assert.equal(parseCrossNetworkAddress('n:not-a-uuid#also-not'), null);
    assert.equal(parseCrossNetworkAddress(''), null);
    assert.equal(parseCrossNetworkAddress('garbage'), null);
  });
});

if (haveNative) {
  describe('snapshot payload helpers', () => {
    it('upsert + read возвращает записанное', () => {
      const ndb = createInMemoryNetworkDb();
      const propertyValueId = randomUUID();
      upsertSnapshotPayload(ndb, propertyValueId, [
        {
          network_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          thought_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          title: 'Title',
          resolved_at: '2026-09-22T00:00:00Z',
          unresolved: 0,
        },
      ]);
      const payload = readSnapshotPayload(ndb, propertyValueId);
      assert.ok(payload !== null);
      assert.equal(payload!.items.length, 1);
      assert.equal(payload!.items[0]!.title, 'Title');
    });

    it('delete убирает снапшот', () => {
      const ndb = createInMemoryNetworkDb();
      const propertyValueId = randomUUID();
      upsertSnapshotPayload(ndb, propertyValueId, [
        {
          network_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          thought_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          title: 't',
          resolved_at: 'now',
          unresolved: 0,
        },
      ]);
      deleteSnapshotPayload(ndb, propertyValueId);
      assert.equal(readSnapshotPayload(ndb, propertyValueId), null);
    });
  });

  describe('crossResolvePropertyValue', () => {
    it('адрес чужой сети с пустым контекстом (нет прав) → unresolved', () => {
      const { ndb, propertyKey } = setupCrossRefProperty();
      const nid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const tid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const addr = formatCrossNetworkAddress(nid, tid);
      const thoughtId = insertCrossRefValue(ndb, propertyKey, addr);
      const values = crossResolvePropertyValue(
        ndb,
        'thought',
        thoughtId,
        propertyKey,
        emptyCtx('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      );
      assert.equal(values.length, 1);
      assert.equal(values[0]!.unresolved, true);
      assert.ok(values[0]!.title_snapshot.length > 0);
    });

    it('адрес собственной сети → permission_denied (не резолвим свою)', () => {
      const { ndb, propertyKey } = setupCrossRefProperty();
      const ownNetId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const addr = formatCrossNetworkAddress(ownNetId, randomUUID());
      const thoughtId = insertCrossRefValue(ndb, propertyKey, addr);
      const values = crossResolvePropertyValue(
        ndb,
        'thought',
        thoughtId,
        propertyKey,
        emptyCtx(ownNetId),
      );
      assert.equal(values[0]!.unresolved, true);
    });

    it('невалидный адрес в value → помечается нерезолвленным', () => {
      const { ndb, propertyKey } = setupCrossRefProperty();
      const thoughtId = insertCrossRefValue(ndb, propertyKey, 'not-an-address');
      const values = crossResolvePropertyValue(
        ndb,
        'thought',
        thoughtId,
        propertyKey,
        emptyCtx(randomUUID()),
      );
      assert.equal(values.length, 1);
      assert.equal(values[0]!.unresolved, true);
      assert.equal(values[0]!.title_snapshot, 'not-an-address');
    });
  });
}

function setupCrossRefProperty(): { ndb: NetworkDb; propertyKey: string } {
  const ndb = createInMemoryNetworkDb();
  const propertyKey = 'кросс-ссылка';
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, deleted, base_version, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, ?, 0, 0, ?, ?, 'cross_network_ref', NULL, NULL, ?, ?)`,
    )
    .run(id, '00000000-0000-4000-8000-0000000000ba5e', propertyKey, propertyKey.toLowerCase(), now, now);
  return { ndb, propertyKey };
}

function insertCrossRefValue(ndb: NetworkDb, propertyKey: string, address: string): string {
  const propRow = ndb
    .prepare(`SELECT id FROM properties WHERE name_key = ?`)
    .get(propertyKey.toLowerCase()) as { id: string } | undefined;
  if (propRow === undefined) return '';
  const propertyId = propRow.id;
  const thoughtId = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, version, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, NULL, 1, 1, ?, ?, 't', 't')`,
    )
    .run(thoughtId, 'тест', 'тест', now, now);
  const valueId = randomUUID();
  ndb
    .prepare(
      `INSERT INTO property_values (id, layer_id, owner_type, owner_id, property_id, value_text, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'thought', ?, ?, ?, ?, 't', 't', 0, 0)`,
    )
    .run(valueId, '00000000-0000-4000-8000-0000000000ba5e', thoughtId, propertyId, address, now);
  return thoughtId;
}

function emptyCtx(currentNetworkId: string) {
  return {
    dataDir: '',
    userId: '',
    clientId: '',
    logger: undefined as never,
    accessibleNetworkIds: new Set<string>() as ReadonlySet<string>,
    currentNetworkId,
  };
}
