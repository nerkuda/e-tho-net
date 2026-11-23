/**
 * 0.16.2, ошибка 6fd7eb5f: слияние молча вставляет осиротевшую versioned-строку
 * (живая тень с `base_version > 0`, у которой в цепочке цели нет победителя) и
 * тем воскрешает удалённые данные.
 *
 * Как получается сирота (нога B карточки): реплей надгробия в основу физически
 * удаляет строку основы (24ca954b: «надгробие удаляет строку цели физически
 * только в P и не выметает тени соседних слоёв»). Живая тень соседнего слоя
 * после этого опирается на исчезнувшую строку. До фикса `detectVersionConflicts`
 * такие строки пропускал (`winner === undefined`), и реплей вставлял их в
 * основу как новые (`base_version = 0`) — удалённое ребро/мысль возвращались
 * молча.
 *
 * DoD:
 *   * слияние слоя с осиротевшей живой versioned-строкой — 422
 *     `VALIDATION_ERROR`, `details.conflicts` содержит
 *     `{ table, id, expected_base_version, current_version: null,
 *        reason: 'base_row_missing' }`, основа не меняется, тень слоя цела;
 *   * preview `listPendingMergeConflicts` показывает сироту заранее;
 *   * класс, а не случай: правило одинаково для любой versioned-таблицы
 *     (links, thoughts, comments, publications);
 *   * положительные контроли: строка, созданная в слое (`base_version = 0`),
 *     по-прежнему вставляется; явный `resetLayerOverride` на сироту —
 *     осознанная вставка (строка становится новой).
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, EtnError } from '@etn/shared';
import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createLink, deleteLink, getLink, updateLink } from '../src/domain/link-service.js';
import {
  listPendingMergeConflicts,
  mergeLayer,
  resetLayerOverride,
} from '../src/domain/merge-service.js';
import { createThought, deleteThought, updateThought } from '../src/domain/thought-service.js';

const USER = 'user-1';
/** Слой с живой тенью (правит то, что предок удалит). */
const LAYER_EDITED = '11111111-1111-4111-8111-111111111111';
/** Слой с надгробием (его слияние физически уносит строку основы). */
const LAYER_DELETED = '33333333-3333-4333-8333-333333333333';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Два слоя-ребёнка основы: правка и удаление независимы. */
function insertLayerChain(ndb: NetworkDb): void {
  const now = new Date().toISOString();
  const insert = ndb.prepare(
    `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
     VALUES (?, ?, ?, 0, 1, 'u', ?, ?)`,
  );
  insert.run(LAYER_EDITED, BASE_LAYER_ID, 'Слой правки', now, now);
  insert.run(LAYER_DELETED, BASE_LAYER_ID, 'Слой удаления', now, now);
}

interface LinkSeed {
  linkId: string;
  sourceId: string;
  targetId: string;
}

/** Ребро основы + живая тень правки в одном слое + надгробие в другом. */
function seedOrphanedLink(ndb: NetworkDb): LinkSeed {
  insertLayerChain(ndb);
  const t1 = createThought(ndb, { title: 'Источник' }, USER);
  const t2 = createThought(ndb, { title: 'Цель' }, USER);
  const link = createLink(ndb, { source_id: t1.id, target_id: t2.id, active: true }, USER);

  ndb.useLayer(LAYER_EDITED);
  updateLink(ndb, link.id, { active: true }, undefined, USER);
  const shadow = rawLink(ndb, link.id, LAYER_EDITED);
  assert.deepEqual(shadow, { deleted: 0, base_version: 1, version: 2 }, 'в правке — живая тень');

  ndb.useLayer(LAYER_DELETED);
  deleteLink(ndb, link.id, undefined);
  assert.equal(rawLink(ndb, link.id, LAYER_DELETED)?.deleted, 1, 'в удалении — надгробие');

  // Нога B: слияние надгробия в основу физически уносит строку основы.
  ndb.useLayer(BASE_LAYER_ID);
  const merged = mergeLayer(ndb, LAYER_DELETED, undefined, USER);
  assert.equal(merged.applied.links, 1, 'реплей надгробия применён');
  assert.equal(rawLink(ndb, link.id, BASE_LAYER_ID), undefined, 'строки основы больше нет');
  assert.equal(rawLink(ndb, link.id, LAYER_EDITED)?.base_version, 1, 'тень правки осиротела');
  return { linkId: link.id, sourceId: t1.id, targetId: t2.id };
}

interface RawRow {
  deleted: number;
  base_version: number;
  version: number;
}

/** Сырая строка в конкретном слое. */
function rawRow(ndb: NetworkDb, table: string, id: string, layerId: string): RawRow | undefined {
  return ndb
    .prepare(`SELECT deleted, base_version, version FROM ${table} WHERE id = ? AND layer_id = ?`)
    .get(id, layerId) as RawRow | undefined;
}

function rawLink(ndb: NetworkDb, id: string, layerId: string): RawRow | undefined {
  return rawRow(ndb, 'links', id, layerId);
}

/** Ожидаемая запись конфликта-сироты. */
function orphanConflict(
  table: string,
  id: string,
  expectedBaseVersion: number,
): {
  table: string;
  id: string;
  expected_base_version: number;
  current_version: null;
  reason: 'base_row_missing';
} {
  return {
    table,
    id,
    expected_base_version: expectedBaseVersion,
    current_version: null,
    reason: 'base_row_missing',
  };
}

/** 422 с ровно одной записью конфликта-сироты. */
function rejectsWithOrphan(expected: ReturnType<typeof orphanConflict>) {
  return (err: unknown): boolean => {
    if (!(err instanceof EtnError) || err.code !== 'VALIDATION_ERROR') return false;
    const details = err.details as {
      conflicts?: unknown;
      how_to?: unknown;
    };
    return (
      JSON.stringify(details.conflicts) === JSON.stringify([expected]) &&
      details.how_to === 'etn.how_to_merge_partial'
    );
  };
}

describe(
  '0.16.2 — осиротевшая versioned-строка при слиянии (6fd7eb5f)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding is unavailable' },
  () => {
    it('слияние слоя с живой тенью исчезнувшего ребра — 422, ребро не воскресает', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seedOrphanedLink(ndb);

        // Preview обязан предупредить заранее.
        const preview = listPendingMergeConflicts(ndb, LAYER_EDITED);
        assert.equal(preview.overridden, 1, 'в слое одна строка');
        assert.equal(preview.conflicts.length, 1, 'preview видит осиротевшую строку');
        const previewRow = preview.conflicts[0]!;
        assert.deepEqual(
          {
            table: previewRow.table,
            id: previewRow.id,
            previous_base_version: previewRow.previous_base_version,
            // Строки в предке нет: `current_version: 0` — существующая
            // семантика отчёта сброса перекрытия («нет строки»).
            current_version: previewRow.current_version,
            layer_version: previewRow.layer_version,
            version_raised_to: previewRow.version_raised_to,
            base_deleted: previewRow.base_deleted,
            layer_deleted: previewRow.layer_deleted,
          },
          {
            table: 'links',
            id: s.linkId,
            previous_base_version: 1,
            current_version: 0,
            layer_version: 2,
            version_raised_to: null,
            base_deleted: false,
            layer_deleted: false,
          },
        );
        assert.ok(previewRow.diff.length > 0, 'preview несёт построчное различие');

        assert.throws(
          () => mergeLayer(ndb, LAYER_EDITED, undefined, USER),
          rejectsWithOrphan(orphanConflict('links', s.linkId, 1)),
        );

        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getLink(ndb, s.linkId), null, 'ребро не воскресло в основе');
        assert.equal(rawLink(ndb, s.linkId, BASE_LAYER_ID), undefined, 'строки основы нет');
        assert.deepEqual(
          rawLink(ndb, s.linkId, LAYER_EDITED),
          { deleted: 0, base_version: 1, version: 2 },
          'тень слоя цела и не слита',
        );
      } finally {
        ndb.close();
      }
    });

    it('класс, а не случай: осиротевшая тень мысли ловится тем же правилом', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayerChain(ndb);
        const t = createThought(ndb, { title: 'Правленный в слое' }, USER);

        ndb.useLayer(LAYER_EDITED);
        updateThought(ndb, t.id, { title: 'Правка слоя' }, undefined, USER);
        assert.deepEqual(
          rawRow(ndb, 'thoughts', t.id, LAYER_EDITED),
          { deleted: 0, base_version: 1, version: 2 },
          'в правке — живая тень',
        );

        ndb.useLayer(LAYER_DELETED);
        deleteThought(ndb, t.id, undefined, USER);
        ndb.useLayer(BASE_LAYER_ID);
        mergeLayer(ndb, LAYER_DELETED, undefined, USER);
        assert.equal(rawRow(ndb, 'thoughts', t.id, BASE_LAYER_ID), undefined, 'мысли основы нет');

        assert.throws(
          () => mergeLayer(ndb, LAYER_EDITED, undefined, USER),
          rejectsWithOrphan(orphanConflict('thoughts', t.id, 1)),
        );
        assert.equal(
          rawRow(ndb, 'thoughts', t.id, BASE_LAYER_ID),
          undefined,
          'мысль не воскресла в основе',
        );
      } finally {
        ndb.close();
      }
    });

    it('положительный контроль: строка, созданная в слое (base_version 0), вставляется как прежде', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayerChain(ndb);
        const a = createThought(ndb, { title: 'Основа' }, USER);
        ndb.useLayer(LAYER_EDITED);
        const b = createThought(ndb, { title: 'Только в слое' }, USER);
        const link = createLink(ndb, { source_id: a.id, target_id: b.id, active: true }, USER);
        assert.equal(rawLink(ndb, link.id, LAYER_EDITED)?.base_version, 0, 'новая строка слоя');

        const merged = mergeLayer(ndb, LAYER_EDITED, undefined, USER);
        assert.equal(merged.applied.links, 1);
        assert.equal(merged.applied.thoughts, 1);
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getLink(ndb, link.id)?.id, link.id, 'новое ребро появилось в основе');
      } finally {
        ndb.close();
      }
    });

    it('явный reset_override на сироту — осознанная вставка (строка становится новой)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seedOrphanedLink(ndb);
        resetLayerOverride(ndb, LAYER_EDITED, { links: [s.linkId] });
        assert.equal(rawLink(ndb, s.linkId, LAYER_EDITED)?.base_version, 0, 'перекрытие сброшено');

        mergeLayer(ndb, LAYER_EDITED, undefined, USER);
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getLink(ndb, s.linkId)?.id, s.linkId, 'после явного сброса ребро вставлено');
        assert.deepEqual(
          rawLink(ndb, s.linkId, BASE_LAYER_ID),
          { deleted: 0, base_version: 0, version: 2 },
          'вставлено как новая строка, версия слоя сохранена',
        );
      } finally {
        ndb.close();
      }
    });
  },
);
