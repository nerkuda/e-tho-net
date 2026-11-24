/**
 * 0.16.2, ошибка 97b64a69: удаление ребра в слое при живой тени дочернего слоя
 * воскрешает ребро.
 *
 * Сценарий: слой A (ребёнок основы) создаёт ребро; слой B (ребёнок A) меняет
 * это ребро — появляется живая тень `base_version: 1`; удаление ребра из A
 * физически сносит строку A, тень B остаётся и при слиянии B→A возвращает
 * ребро в A. Правило ADR a967d865 (требование ebb070c2): физическое удаление
 * строки слоя допустимо, только когда ребра не держит ни один слой, — та же
 * проверка `listLinkHoldingLayers`, что у основы.
 *
 * DoD:
 *   * 422 `VALIDATION_ERROR` с `details.blocking.layers = [{ id: B }]`,
 *     строки ребра целы в обоих слоях;
 *   * положительный контроль: после слияния B→A (тень снята) удаление
 *     проходит физически;
 *   * процедура единая — блокирует и прямой вызов `removeLinkTargets`
 *     (ядро MCP `links.delete`), и `properties.remove`.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, EtnError } from '@etn/shared';
import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { getLink, updateLink } from '../src/domain/link-service.js';
import { removeLinkTargets } from '../src/domain/link-target-removal.js';
import { mergeLayer } from '../src/domain/merge-service.js';
import {
  createNetworkProperty,
  getLinkPropertyValues,
  removeLinkPropertyValue,
  setPropertyValue,
} from '../src/domain/property-service.js';
import { createThought } from '../src/domain/thought-service.js';

const USER = 'user-1';
const LAYER_A = '11111111-1111-4111-8111-111111111111';
const LAYER_B = '22222222-2222-4222-8222-222222222222';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Цепочка слоёв: A — ребёнок основы, B — ребёнок A. */
function insertLayerChain(ndb: NetworkDb): void {
  const now = new Date().toISOString();
  const insert = ndb.prepare(
    `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
     VALUES (?, ?, ?, 0, ?, 'u', ?, ?)`,
  );
  insert.run(LAYER_A, BASE_LAYER_ID, 'Слой A', 1, now, now);
  insert.run(LAYER_B, LAYER_A, 'Слой B', 2, now, now);
}

interface Seed {
  owner: string;
  t1: string;
  key: string;
  linkTypeId: string;
}

/** Свойство-связь в справочнике + владелец и цель. */
function seed(ndb: NetworkDb): Seed {
  const prop = createNetworkProperty(
    ndb,
    { name: 'rel', value_type: 'link', name_forward: 'rel', name_reverse: 'rel-обратно' },
    USER,
  );
  const owner = createThought(ndb, { title: 'Владелец rel' }, USER);
  const t1 = createThought(ndb, { title: 'Цель rel' }, USER);
  return {
    owner: owner.id,
    t1: t1.id,
    key: 'rel',
    linkTypeId: (prop.config?.link_type_id ?? '') as string,
  };
}

/** Живое ребро свойства к конкретной цели (или `undefined`). */
function linkTo(ndb: NetworkDb, s: Seed): string | undefined {
  return getLinkPropertyValues(ndb, 'thought', s.owner, s.linkTypeId, 'out').find(
    (value) => value.target_id === s.t1,
  )?.link_id;
}

/** Сырая строка ребра в конкретном слое. */
function rawLinkRow(
  ndb: NetworkDb,
  linkId: string,
  layerId: string,
):
  | { deleted: number; marked_for_deletion: number; base_version: number; version: number }
  | undefined {
  return ndb
    .prepare(
      'SELECT deleted, marked_for_deletion, base_version, version FROM links WHERE id = ? AND layer_id = ?',
    )
    .get(linkId, layerId) as
    | { deleted: number; marked_for_deletion: number; base_version: number; version: number }
    | undefined;
}

/** Ситуация дефекта: ребро создано в A, тень-правка в B; возвращает id ребра. */
function seedHeldLink(ndb: NetworkDb): Seed & { linkId: string } {
  const s = seed(ndb);
  insertLayerChain(ndb);
  ndb.useLayer(LAYER_A);
  setPropertyValue(ndb, 'thought', s.owner, s.key, [s.t1], USER);
  const linkId = linkTo(ndb, s);
  assert.ok(linkId !== undefined);
  ndb.useLayer(LAYER_B);
  updateLink(ndb, linkId, { active: true }, undefined, USER);
  const shadow = rawLinkRow(ndb, linkId, LAYER_B);
  assert.ok(shadow !== undefined, 'в B появилась тень');
  assert.equal(shadow.deleted, 0, 'тень живая');
  assert.equal(shadow.base_version, 1, 'тень перекрывает строку A (version 1)');
  ndb.useLayer(LAYER_A);
  return { ...s, linkId };
}

/** Проверка 422 с удержанием именно слоя B. */
function isHeldByB(err: unknown): boolean {
  return (
    err instanceof EtnError &&
    err.code === 'VALIDATION_ERROR' &&
    JSON.stringify((err.details as { blocking?: { layers?: unknown } }).blocking?.layers) ===
      JSON.stringify([{ id: LAYER_B, title: 'Слой B' }])
  );
}

describe(
  '0.16.2 — ребро слоя под живой тенью дочернего слоя (97b64a69)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('properties.remove из A: 422 с blocking.layers=[B], строки ребра целы в обоих слоях', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seedHeldLink(ndb);

        assert.throws(
          () => removeLinkPropertyValue(ndb, 'thought', s.owner, s.key, s.t1, USER),
          isHeldByB,
        );

        assert.equal(rawLinkRow(ndb, s.linkId, LAYER_A)?.deleted, 0, 'строка A цела');
        assert.equal(rawLinkRow(ndb, s.linkId, LAYER_A)?.marked_for_deletion, 0, 'строка A живая');
        assert.equal(rawLinkRow(ndb, s.linkId, LAYER_B)?.deleted, 0, 'тень B цела');
        assert.equal(rawLinkRow(ndb, s.linkId, LAYER_B)?.base_version, 1, 'тень B не переписана');
        assert.equal(getLink(ndb, s.linkId)?.id, s.linkId, 'ребро по-прежнему видно в A');
        assert.equal(
          getLinkPropertyValues(ndb, 'thought', s.owner, s.linkTypeId, 'out').length,
          1,
          'значение свойства не пропало',
        );
      } finally {
        ndb.close();
      }
    });

    it('прямой вызов removeLinkTargets (ядро MCP links.delete) из A тоже даёт 422', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seedHeldLink(ndb);
        assert.throws(() => removeLinkTargets(ndb, s.linkId, USER), isHeldByB);
        assert.equal(rawLinkRow(ndb, s.linkId, LAYER_A)?.deleted, 0);
        assert.equal(rawLinkRow(ndb, s.linkId, LAYER_B)?.deleted, 0);
      } finally {
        ndb.close();
      }
    });

    it('после слияния B→A (тень снята) удаление из A проходит физически', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seedHeldLink(ndb);

        const merged = mergeLayer(ndb, LAYER_B, undefined, USER);
        assert.equal(merged.applied.links, 1, 'правка B перенесена в A');
        assert.equal(rawLinkRow(ndb, s.linkId, LAYER_B), undefined, 'строка B слита');

        ndb.useLayer(LAYER_A);
        const removed = removeLinkPropertyValue(ndb, 'thought', s.owner, s.key, s.t1, USER);
        assert.equal(removed?.action, 'deleted', 'без теней — физическое удаление');
        assert.equal(rawLinkRow(ndb, s.linkId, LAYER_A), undefined, 'строки A нет');
        assert.equal(rawLinkRow(ndb, s.linkId, LAYER_B), undefined, 'строки B нет');
        assert.equal(getLink(ndb, s.linkId), null);
      } finally {
        ndb.close();
      }
    });
  },
);
