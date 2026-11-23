/**
 * 0.16.2, ошибка 374c9776: удаление цели свойства-связи падало сырым
 * `UNIQUE constraint failed: links.source_id, links.target_id, links.type_id,
 * links.layer_id`, когда между парой source/target видно ДВА живых ребра одной
 * тройки в разных слоях (одно создано в основе, второе — в слое; возникает при
 * повторных правках основы после миграции слоя).
 *
 * Механика дефекта: `links_v` схлопывает строки по логическому `id`, а не по
 * тройке, поэтому в слое видны обе строки. Удаление цели брало строку основы и
 * материализовало её тень в текущем слое — а тройку в этом слое уже занимает
 * собственная живая строка слоя (частичный уникальный индекс 029).
 *
 * DoD (ADR a967d865, требование 4591f837):
 *   * живой дубль тройки снимается целиком: свежая строка слоя удаляется
 *     физически, строка основы/предка уходит в корзину слоя — значение
 *     свойства в слое после удаления пусто;
 *   * та же процедура у прямого вызова `removeLinkTargets` (ядро MCP
 *     `links.delete`), а не только у `properties.remove`;
 *   * неразрешимый случай (дубли в ДВУХ слоях выше текущего — две тени одной
 *     тройки в одну строку не помещаются) — внятная `VALIDATION_ERROR`, а не
 *     сырой сбой SQLite.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, EtnError } from '@etn/shared';
import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { removeLinkTargets } from '../src/domain/link-target-removal.js';
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

/** Живые рёбра свойства к цели в текущем контексте слоя. */
function linksTo(ndb: NetworkDb, s: Seed): string[] {
  return getLinkPropertyValues(ndb, 'thought', s.owner, s.linkTypeId, 'out')
    .filter((value) => value.target_id === s.t1)
    .map((value) => value.link_id);
}

/**
 * Ситуация дефекта: ребро сначала создано в слое A (своя строка A), затем
 * основа завела ребро той же тройки себе (правка основы после миграции слоя).
 * Возвращает id обеих строк: `layer` (A) и `base`.
 */
function seedTripleDuplicates(ndb: NetworkDb): Seed & { layerLinkId: string; baseLinkId: string } {
  const s = seed(ndb);
  insertLayerChain(ndb);
  ndb.useLayer(LAYER_A);
  setPropertyValue(ndb, 'thought', s.owner, s.key, [s.t1], USER);
  const [layerLinkId] = linksTo(ndb, s);
  assert.ok(layerLinkId !== undefined, 'в слое A появилось ребро');
  ndb.useLayer(BASE_LAYER_ID);
  setPropertyValue(ndb, 'thought', s.owner, s.key, [s.t1], USER);
  const [baseLinkId] = linksTo(ndb, s);
  assert.ok(baseLinkId !== undefined, 'в основе появилось ребро');
  ndb.useLayer(LAYER_A);
  assert.deepEqual(
    linksTo(ndb, s).sort(),
    [layerLinkId, baseLinkId].sort(),
    'в слое A видны оба живых ребра тройки',
  );
  return { ...s, layerLinkId, baseLinkId };
}

/** Сырая строка ребра в конкретном слое. */
function rawLinkRow(
  ndb: NetworkDb,
  linkId: string,
  layerId: string,
): { deleted: number; marked_for_deletion: number; base_version: number } | undefined {
  return ndb
    .prepare(
      'SELECT deleted, marked_for_deletion, base_version FROM links WHERE id = ? AND layer_id = ?',
    )
    .get(linkId, layerId) as
    { deleted: number; marked_for_deletion: number; base_version: number } | undefined;
}

/** Внятный отказ по неразрешимым дублям — VALIDATION_ERROR, не SQLite-сбой. */
function isDuplicateEdgesError(err: unknown): boolean {
  return (
    err instanceof EtnError && err.code === 'VALIDATION_ERROR' && /duplicate/i.test(err.message)
  );
}

describe(
  '0.16.2 — живой дубль тройки в разных слоях не ломает удаление ребра (374c9776)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('properties.remove из слоя снимает дубль целиком: строка слоя удалена, строка основы в корзине', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seedTripleDuplicates(ndb);

        const removed = removeLinkPropertyValue(ndb, 'thought', s.owner, s.key, s.t1, USER);

        assert.equal(removed.link_id !== null, true, 'удаление выполнено');
        assert.deepEqual(linksTo(ndb, s), [], 'значение свойства в слое пусто');

        assert.equal(
          rawLinkRow(ndb, s.layerLinkId, LAYER_A),
          undefined,
          'строка слоя удалена физически',
        );
        const baseShadow = rawLinkRow(ndb, s.baseLinkId, LAYER_A);
        assert.ok(baseShadow !== undefined, 'строка основы материализована тенью в слое');
        assert.equal(baseShadow.deleted, 0, 'тень живая (корзина, не удаление)');
        assert.equal(baseShadow.marked_for_deletion, 1, 'строка основы помечена в корзину слоя');
        const baseRow = rawLinkRow(ndb, s.baseLinkId, BASE_LAYER_ID);
        assert.equal(baseRow?.marked_for_deletion, 0, 'строка основы не тронута');
      } finally {
        ndb.close();
      }
    });

    it('прямой вызов removeLinkTargets (ядро MCP links.delete) снимает дубль так же', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seedTripleDuplicates(ndb);

        const removals = removeLinkTargets(ndb, s.baseLinkId, USER);

        assert.equal(removals.length, 2, 'сняты обе живые строки тройки');
        assert.deepEqual(linksTo(ndb, s), [], 'значение свойства в слое пусто');
        assert.equal(rawLinkRow(ndb, s.layerLinkId, LAYER_A), undefined, 'строка слоя удалена');
        assert.equal(
          rawLinkRow(ndb, s.baseLinkId, LAYER_A)?.marked_for_deletion,
          1,
          'строка основы в корзине слоя',
        );
      } finally {
        ndb.close();
      }
    });

    it('дубли в двух слоях выше текущего — VALIDATION_ERROR, а не сырой сбой SQLite', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seedTripleDuplicates(ndb);
        ndb.useLayer(LAYER_B);

        assert.throws(
          () => removeLinkPropertyValue(ndb, 'thought', s.owner, s.key, s.t1, USER),
          isDuplicateEdgesError,
        );

        assert.equal(rawLinkRow(ndb, s.layerLinkId, LAYER_A)?.deleted, 0, 'строка слоя A цела');
        assert.equal(
          rawLinkRow(ndb, s.baseLinkId, BASE_LAYER_ID)?.deleted,
          0,
          'строка основы цела',
        );
      } finally {
        ndb.close();
      }
    });
  },
);
