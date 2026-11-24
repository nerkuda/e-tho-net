/**
 * 0.16.2, ошибка a9615f9b: живой дубль тройки ребра ломал не только удаление
 * (374c9776), но и ЛЮБУЮ запись, материализующую живую тень строки основы в
 * слой: правку ребра основы из слоя (`updateLink`), восстановление из корзины
 * (`links.restore` = `updateLink`), смену типа ребра, каскад удаления типа
 * связи. Вставка тени упиралась в сырой `UNIQUE constraint failed:
 * links.source_id, links.target_id, links.type_id, links.layer_id`: слот тройки
 * в текущем слое уже держит своя живая строка (уникальный индекс 029).
 *
 * Политика (уточнение 0.16.2 к требованию ebb070c2): такая запись отвергается
 * внятной 422 `VALIDATION_ERROR` «duplicate edges» с перечнем строк в
 * `details.links`; дубль сначала снимается целиком (`links.delete`) либо слой
 * сливается/отбрасывается. Сырой сбой SQLite недопустим.
 *
 * Сопутствующие пункты верификации 374c9776 (круг 2):
 *   * держателем слота может быть ЖИВАЯ строка слоя, а не только корзинная —
 *     текст 422 обязан это различать;
 *   * блокирующие счётчики (`countThoughtRefUsages`, `deletion_blocks`) считают
 *     ЛОГИЧЕСКИЕ ссылки, как `clearThoughtRefUsages`: дубль — одна ссылка.
 *
 * Skipped when the `better-sqlite3` native binding is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, EtnError } from '@etn/shared';
import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createLink, updateLink } from '../src/domain/link-service.js';
import { createLinkType, deleteLinkType } from '../src/domain/link-type-service.js';
import { removeLinkTargets } from '../src/domain/link-target-removal.js';
import {
  clearThoughtRefUsages,
  countThoughtRefUsages,
  createNetworkProperty,
  getLinkPropertyValues,
  setPropertyValue,
} from '../src/domain/property-service.js';
import { checkThoughtDeletion, createThought } from '../src/domain/thought-service.js';

const USER = 'user-1';
const LAYER_A = '11111111-1111-4111-8111-111111111111';
const LAYER_L = '33333333-3333-4333-8333-333333333333';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Вставить рабочий слой в цепочку (parentId — родитель, depth — глубина). */
function addLayer(ndb: NetworkDb, id: string, parentId: string, depth: number): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, ?, 0, ?, 'u', ?, ?)`,
    )
    .run(id, parentId, id.slice(0, 6), depth, now, now);
}

/** Сырая строка ребра в конкретном слое. */
function rawLinkRow(
  ndb: NetworkDb,
  linkId: string,
  layerId: string,
):
  | {
      deleted: number;
      marked_for_deletion: number;
      base_version: number;
      version: number;
      type_id: string | null;
      active: number;
    }
  | undefined {
  return ndb
    .prepare(
      `SELECT deleted, marked_for_deletion, base_version, version, type_id, active
         FROM links WHERE id = ? AND layer_id = ?`,
    )
    .get(linkId, layerId) as
    | {
        deleted: number;
        marked_for_deletion: number;
        base_version: number;
        version: number;
        type_id: string | null;
        active: number;
      }
    | undefined;
}

/** Внятный отказ по дублю тройки — VALIDATION_ERROR, не SQLite-сбой. */
function isDuplicateEdgesError(err: unknown): boolean {
  return (
    err instanceof EtnError &&
    err.code === 'VALIDATION_ERROR' &&
    /duplicate edges/.test(err.message)
  );
}

/** Слой, в котором живёт дубль тройки: своя живая строка слоя + строка основы. */
interface DuplicateSeed {
  owner: string;
  target: string;
  typeId: string;
  layerLinkId: string;
  baseLinkId: string;
}

/**
 * Ситуация дефекта: ребро создано в слое A, затем основа завела ребро той же
 * тройки себе (правка основы после миграции слоя) — в A видны обе живые строки.
 */
function seedDuplicate(ndb: NetworkDb): DuplicateSeed {
  addLayer(ndb, LAYER_A, BASE_LAYER_ID, 1);
  const type = createLinkType(
    ndb,
    { name_forward: 'rel', name_reverse: 'rel-обратно' },
    USER,
  );
  const owner = createThought(ndb, { title: 'Владелец' }, USER);
  const target = createThought(ndb, { title: 'Цель' }, USER);
  ndb.useLayer(LAYER_A);
  const layerLink = createLink(
    ndb,
    { source_id: owner.id, target_id: target.id, type_id: type.id },
    USER,
  );
  ndb.useLayer(BASE_LAYER_ID);
  const baseLink = createLink(
    ndb,
    { source_id: owner.id, target_id: target.id, type_id: type.id },
    USER,
  );
  ndb.useLayer(LAYER_A);
  return {
    owner: owner.id,
    target: target.id,
    typeId: type.id,
    layerLinkId: layerLink.id,
    baseLinkId: baseLink.id,
  };
}

describe(
  '0.16.2 — живой дубль тройки не ломает записи, материализующие тень ребра (a9615f9b)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('правка ребра основы из слоя с дублем — 422 с перечнем строк, тень не создана', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seedDuplicate(ndb);

        assert.throws(
          () => updateLink(ndb, s.baseLinkId, { active: false }, undefined, USER),
          (err: unknown) => {
            assert.ok(isDuplicateEdgesError(err), 'внятная 422 duplicate edges');
            const details = (err as EtnError).details as {
              links?: Array<{ id: string; layer_id: string }>;
            };
            assert.deepEqual(
              (details.links ?? []).map((l) => l.id).sort(),
              [s.baseLinkId, s.layerLinkId].sort(),
              'в details.links обе строки тройки',
            );
            return true;
          },
        );

        assert.equal(
          rawLinkRow(ndb, s.baseLinkId, LAYER_A),
          undefined,
          'тень строки основы в слой не материализована',
        );
        assert.equal(rawLinkRow(ndb, s.baseLinkId, BASE_LAYER_ID)?.active, 1, 'основа не тронута');
        assert.equal(rawLinkRow(ndb, s.layerLinkId, LAYER_A)?.deleted, 0, 'строка слоя цела');
      } finally {
        ndb.close();
      }
    });

    it('восстановление из корзины поверх живой строки слоя — 422, корзинная строка цела', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        addLayer(ndb, LAYER_A, BASE_LAYER_ID, 1);
        addLayer(ndb, LAYER_L, LAYER_A, 2);
        const type = createLinkType(
          ndb,
          { name_forward: 'rel', name_reverse: 'rel-обратно' },
          USER,
        );
        const owner = createThought(ndb, { title: 'Владелец' }, USER);
        const target = createThought(ndb, { title: 'Цель' }, USER);
        // Своя строка слоя L появляется, пока основа пуста.
        ndb.useLayer(LAYER_L);
        createLink(ndb, { source_id: owner.id, target_id: target.id, type_id: type.id }, USER);
        ndb.useLayer(BASE_LAYER_ID);
        const base = createLink(
          ndb,
          { source_id: owner.id, target_id: target.id, type_id: type.id },
          USER,
        );
        // В A строка основы уходит в корзину: в L видна корзинная строка A.
        ndb.useLayer(LAYER_A);
        const removed = removeLinkTargets(ndb, base.id, USER);
        assert.equal(removed[0]?.action, 'trashed', 'корзинная строка A создана');
        const trashedVersion = rawLinkRow(ndb, base.id, LAYER_A)?.version;

        ndb.useLayer(LAYER_L);
        assert.throws(
          () => updateLink(ndb, base.id, { marked_for_deletion: false }, undefined, USER),
          isDuplicateEdgesError,
        );
        const stillTrashed = rawLinkRow(ndb, base.id, LAYER_A);
        assert.equal(stillTrashed?.marked_for_deletion, 1, 'корзинная строка A не восстановлена');
        assert.equal(stillTrashed?.version, trashedVersion, 'корзинная строка A не тронута');
        assert.equal(
          rawLinkRow(ndb, base.id, LAYER_L),
          undefined,
          'тень корзинной строки в L не создана',
        );
      } finally {
        ndb.close();
      }
    });

    it('смена типа ребра основы из слоя с дублем — 422, тип в основе не изменён', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const s = seedDuplicate(ndb);
        const other = createLinkType(
          ndb,
          { name_forward: 'other', name_reverse: 'other-обратно' },
          USER,
        );

        assert.throws(
          () => updateLink(ndb, s.baseLinkId, { type_id: other.id }, undefined, USER),
          isDuplicateEdgesError,
        );
        assert.equal(
          rawLinkRow(ndb, s.baseLinkId, BASE_LAYER_ID)?.type_id,
          s.typeId,
          'тип ребра основы не изменён',
        );
        assert.equal(
          rawLinkRow(ndb, s.baseLinkId, LAYER_A),
          undefined,
          'тень строки основы в слой не материализована',
        );
      } finally {
        ndb.close();
      }
    });

    it('каскад удаления типа связи в слое разбирает дубль по строкам слоя, а не падает', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        addLayer(ndb, LAYER_A, BASE_LAYER_ID, 1);
        const type = createLinkType(
          ndb,
          { name_forward: 'rel', name_reverse: 'rel-обратно' },
          USER,
        );
        const owner = createThought(ndb, { title: 'Владелец' }, USER);
        const target = createThought(ndb, { title: 'Цель' }, USER);
        // Строки вставлены напрямую, чтобы порядок строк в связке был
        // предсказуем: сначала строка основы, затем строка слоя. До фикса каскад
        // материализовал тень строки основы поверх живой строки слоя и падал
        // сырым UNIQUE.
        const now = new Date().toISOString();
        const insertRow = ndb.prepare(
          `INSERT INTO links (id, layer_id, source_id, target_id, type_id, active,
                              version, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
        );
        const baseLinkId = 'aaaaaaaa-0000-4000-8000-000000000001';
        const layerLinkId = 'bbbbbbbb-0000-4000-8000-000000000002';
        insertRow.run(
          baseLinkId,
          BASE_LAYER_ID,
          owner.id,
          target.id,
          type.id,
          now,
          now,
          USER,
          USER,
        );
        insertRow.run(layerLinkId, LAYER_A, owner.id, target.id, type.id, now, now, USER, USER);

        ndb.useLayer(LAYER_A);
        deleteLinkType(ndb, type.id, undefined, { force: true });

        assert.equal(
          ndb.prepare('SELECT 1 FROM link_types_v WHERE id = ?').get(type.id),
          undefined,
          'тип связи скрыт в слое',
        );
        assert.equal(rawLinkRow(ndb, layerLinkId, LAYER_A)?.type_id, null, 'строка слоя отвязана');
        const baseShadow = rawLinkRow(ndb, baseLinkId, LAYER_A);
        assert.equal(baseShadow?.type_id, null, 'тень строки основы отвязана');
        assert.equal(rawLinkRow(ndb, baseLinkId, BASE_LAYER_ID)?.type_id, type.id, 'основа цела');
      } finally {
        ndb.close();
      }
    });

    it('положительный контроль: без дубля правка ребра основы из слоя создаёт тень', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        addLayer(ndb, LAYER_A, BASE_LAYER_ID, 1);
        const type = createLinkType(
          ndb,
          { name_forward: 'rel', name_reverse: 'rel-обратно' },
          USER,
        );
        const owner = createThought(ndb, { title: 'Владелец' }, USER);
        const target = createThought(ndb, { title: 'Цель' }, USER);
        ndb.useLayer(BASE_LAYER_ID);
        const base = createLink(
          ndb,
          { source_id: owner.id, target_id: target.id, type_id: type.id },
          USER,
        );
        const baseVersion = rawLinkRow(ndb, base.id, BASE_LAYER_ID)?.version ?? 0;

        ndb.useLayer(LAYER_A);
        updateLink(ndb, base.id, { color: '#abc' }, undefined, USER);

        const shadow = rawLinkRow(ndb, base.id, LAYER_A);
        assert.ok(shadow !== undefined, 'тень создана в слое');
        assert.equal(shadow.base_version, baseVersion, 'тень опирается на версию основы');
        assert.equal(
          rawLinkRow(ndb, base.id, BASE_LAYER_ID)?.version,
          baseVersion,
          'основа не тронута',
        );
      } finally {
        ndb.close();
      }
    });

    it('слот держит живая тень своего слоя — 422 советует снять дубль, а не чистить корзину', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        addLayer(ndb, LAYER_A, BASE_LAYER_ID, 1);
        addLayer(ndb, LAYER_L, LAYER_A, 2);
        const type = createLinkType(
          ndb,
          { name_forward: 'rel', name_reverse: 'rel-обратно' },
          USER,
        );
        const owner = createThought(ndb, { title: 'Владелец' }, USER);
        const target = createThought(ndb, { title: 'Цель' }, USER);
        // Слой A создаёт своё ребро, основа — своё той же тройки.
        ndb.useLayer(LAYER_A);
        const layerLink = createLink(
          ndb,
          { source_id: owner.id, target_id: target.id, type_id: type.id },
          USER,
        );
        ndb.useLayer(BASE_LAYER_ID);
        const baseLink = createLink(
          ndb,
          { source_id: owner.id, target_id: target.id, type_id: type.id },
          USER,
        );
        // В L материализуется ЖИВАЯ тень строки A: слот тройки в L держит она.
        ndb.useLayer(LAYER_L);
        updateLink(ndb, layerLink.id, { color: '#123' }, undefined, USER);

        assert.throws(
          () => removeLinkTargets(ndb, baseLink.id, USER),
          (err: unknown) => {
            assert.ok(err instanceof EtnError && err.code === 'VALIDATION_ERROR');
            assert.match(err.message, /duplicate edges/);
            assert.match(err.message, /live row of this layer/, 'держатель назван верно');
            assert.doesNotMatch(err.message, /basket/, 'совет про корзину неприменим');
            return true;
          },
        );
        assert.equal(
          rawLinkRow(ndb, baseLink.id, BASE_LAYER_ID)?.marked_for_deletion,
          0,
          'строка основы не помечена',
        );
      } finally {
        ndb.close();
      }
    });

    it('блокирующие счётчики на дубле считают логические ссылки, как «Очистить использование»', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        addLayer(ndb, LAYER_A, BASE_LAYER_ID, 1);
        const prop = createNetworkProperty(
          ndb,
          {
            name: 'rel',
            value_type: 'link',
            name_forward: 'rel',
            name_reverse: 'rel-обратно',
            config: { blocks_target_deletion: true },
          },
          USER,
        );
        const owner = createThought(ndb, { title: 'Владелец' }, USER);
        const target = createThought(ndb, { title: 'Цель' }, USER);
        ndb.useLayer(LAYER_A);
        setPropertyValue(ndb, 'thought', owner.id, 'rel', [target.id], USER);
        ndb.useLayer(BASE_LAYER_ID);
        setPropertyValue(ndb, 'thought', owner.id, 'rel', [target.id], USER);
        ndb.useLayer(LAYER_A);
        const linkTypeId = (prop.config?.link_type_id ?? '') as string;
        assert.equal(
          getLinkPropertyValues(ndb, 'thought', owner.id, linkTypeId, 'out').length,
          2,
          'в слое видны оба ребра тройки',
        );

        assert.equal(countThoughtRefUsages(ndb, target.id), 1, 'ссылка логическая — одна');
        assert.equal(
          checkThoughtDeletion(ndb, target.id).blocking.properties,
          1,
          'контракт blocking.properties считает ссылки, а не строки',
        );
        assert.equal(clearThoughtRefUsages(ndb, target.id), 1, 'снята одна ссылка');
        assert.equal(countThoughtRefUsages(ndb, target.id), 0, 'после снятия ссылок нет');
      } finally {
        ndb.close();
      }
    });
  },
);
