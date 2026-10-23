/**
 * 0.14.1, задача e5ed05af «Перенос владельца отбора между мыслью и типом —
 * сервер» (операция 85414fbd, требование 6a7d2292, ADR 6021918b).
 *
 * Покрывает DoD задачи:
 *   * вне→тип: появление у всех мыслей типа; конфликт с собственным — 409;
 *     одноимённый унаследованный — законное перекрытие; имя за надгробием слоя
 *     — 409, не 500; безтиповая мысль — 422 THOUGHT_HAS_NO_TYPE; корзина — 404;
 *     чужой viewId — 404 с defined_on; дефолты (собственный/унаследованный);
 *     сохранение id/definition/description/дат создания, position — конец,
 *     version=1, updated_at обновлён; атомарность;
 *   * тип→вне: безтиповая цель работает; корзина цели — 404; чужой viewId и
 *     унаследованный источник (адрес — defined_on) — 404/успех; дубль у цели —
 *     409; дефолты; position — конец;
 *   * событовая пара в обе стороны (payload view_id/reason/moved_to, created —
 *     Effective, реальный thought_type_id) и слоевая видимость;
 *   * идемпотентность: replay 200 по тому же ключу, 404 новым;
 *   * круговой перенос в рабочем слое строки ИЗ ОСНОВЫ (обе стороны): оживление
 *     надгробия по id без UNIQUE-конфликтов + слияние после — без 422;
 *   * частичное слияние пары переноса в обе стороны (механизм V1);
 *   * ограничение `thought_type_views`: после move-to-thought в слое имя
 *     типового занято надгробием до слияния — CREATE даёт 409 с диагностикой.
 *
 * Skip на отсутствии нативной сборки `better-sqlite3` — как у остальных
 * серверных тестов.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, EtnError, type AnyRealtimeEvent } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import {
  createThoughtTypeView,
  getEffectiveViewsForThought,
  getThoughtTypeView,
  listThoughtTypeViewsByType,
} from '../src/domain/thought-type-views-service.js';
import {
  createThoughtCustomView,
  getThoughtCustomView,
  listThoughtCustomViews,
} from '../src/domain/thought-custom-views-service.js';
import {
  moveThoughtCustomViewToType,
  moveThoughtTypeViewToThought,
} from '../src/domain/thought-view-transfer.js';
import { collectThoughtLayerRows, mergeLayer } from '../src/domain/merge-service.js';
import { isEventVisibleInLayer } from '../src/realtime/layer-visibility.js';

import {
  authHeaders,
  buildRestContext,
  closeRestContext,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

const USER = 'user-1';
const DEFINITION = '{"keywords":"alpha","sort":"title","order":"asc"}';

// ---------------------------------------------------------------------------
// In-memory helpers
// ---------------------------------------------------------------------------

function seedThought(ndb: NetworkDb, title: string, typeId: string | null = null): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, layer_id, title, title_norm, type_id, active,
                             is_protected, is_root, version, created_at, created_by,
                             updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, 0, 0, 1, ?, 'u', ?, 'u')`,
    )
    .run(id, ndb.layerId, title, title.toLowerCase(), typeId, now, now);
  return id;
}

function seedLayer(ndb: NetworkDb, parentId: string = BASE_LAYER_ID, depth = 1): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, 'Слой переноса', 0, ?, 'u', ?, ?)`,
    )
    .run(id, parentId, depth, now, now);
  return id;
}

/** Состарить даты создания/обновления внетипового отбора — проверки переноса. */
function ageCustomView(ndb: NetworkDb, viewId: string): void {
  ndb
    .prepare(
      `UPDATE thought_custom_views
          SET created_at = '2020-01-01T00:00:00.000Z',
              updated_at = '2020-01-02T00:00:00.000Z'
        WHERE id = ? AND layer_id = ?`,
    )
    .run(viewId, ndb.layerId);
}

/** Состарить даты создания/обновления отбора типа — проверки переноса. */
function ageTypeView(ndb: NetworkDb, viewId: string): void {
  ndb
    .prepare(
      `UPDATE thought_type_views
          SET created_at = '2020-02-01T00:00:00.000Z',
              updated_at = '2020-02-02T00:00:00.000Z'
        WHERE id = ? AND layer_id = ?`,
    )
    .run(viewId, ndb.layerId);
}

/** Сырая физическая строка таблицы отбора (для проверок revive/base_version). */
function rawViewRow(
  ndb: NetworkDb,
  table: 'thought_custom_views' | 'thought_type_views',
  id: string,
): { deleted: number; base_version: number; version: number; name: string; position: number } | undefined {
  return ndb
    .prepare(
      `SELECT deleted, base_version, version, name, position
         FROM ${table} WHERE id = ? AND layer_id = ?`,
    )
    .get(id, ndb.layerId) as
    | { deleted: number; base_version: number; version: number; name: string; position: number }
    | undefined;
}

/** Mark a thought as trashed (raw, чтобы не зависеть от маршрута). */
function trashThought(ndb: NetworkDb, thoughtId: string): void {
  ndb
    .prepare('UPDATE thoughts SET marked_for_deletion = 1 WHERE id = ?')
    .run(thoughtId);
}

// ---------------------------------------------------------------------------
// Домен
// ---------------------------------------------------------------------------

describe(
  'перенос владельца отбора — домен (85414fbd)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    function setup(): {
      ndb: NetworkDb;
      typeId: string;
      thoughtId: string;
      siblingId: string;
    } {
      const ndb = createInMemoryNetworkDb();
      const type = createThoughtType(ndb, { name: 'task' }, USER);
      const thoughtId = seedThought(ndb, 'Каталог МЛИ', type.id);
      const siblingId = seedThought(ndb, 'Другой каталог', type.id);
      return { ndb, typeId: type.id, thoughtId, siblingId };
    }

    it('вне→тип: id/definition/description/даты сохранены, position в конец, version=1; отбор у всех мыслей типа', () => {
      const { ndb, typeId, thoughtId, siblingId } = setup();
      try {
        // У получателя уже есть отбор — переносимый должен встать в конец.
        createThoughtTypeView(ndb, typeId, { name: 'Первый', definition: DEFINITION }, USER);
        const source = createThoughtCustomView(
          ndb,
          thoughtId,
          {
            name: 'В гараже',
            description: 'что лежит в гараже',
            definition: DEFINITION,
            position: 7,
          },
          USER,
        );
        ageCustomView(ndb, source.id);

        const moved = moveThoughtCustomViewToType(ndb, thoughtId, source.id);

        assert.equal(moved.view.id, source.id, 'id сохраняется');
        assert.equal(moved.view.thought_type_id, typeId);
        assert.equal(moved.view.name, 'В гараже');
        assert.equal(moved.view.definition, DEFINITION, 'definition переносится дословно');
        assert.equal(moved.view.description, 'что лежит в гараже');
        assert.equal(moved.view.created_at, '2020-01-01T00:00:00.000Z');
        assert.equal(moved.view.created_by, source.created_by);
        assert.equal(moved.view.version, 1, 'version начинается заново');
        assert.ok(
          moved.view.updated_at > '2020-01-02T00:00:00.000Z',
          'updated_at — момент переноса',
        );
        assert.equal(moved.view.position, 1, 'position — в конец получателя');

        // Источник исчез из внетиповых отборов мысли.
        assert.equal(getThoughtCustomView(ndb, source.id), null);
        assert.deepEqual(
          listThoughtCustomViews(ndb, thoughtId).map((v) => v.name),
          [],
        );

        // Другая мысль того же типа видит отбор в эффективном наборе.
        const effective = getEffectiveViewsForThought(ndb, {
          id: siblingId,
          type_id: typeId,
        });
        const found = effective.find((v) => v.id === source.id);
        assert.ok(found, 'отбор появился у всех мыслей типа');
        assert.equal(found!.scope, 'type');
        assert.equal(found!.defined_on, typeId);
        assert.equal(found!.is_default, false);
      } finally {
        ndb.close();
      }
    });

    it('вне→тип: собственное имя занято — 409; унаследованное — законное перекрытие', () => {
      const { ndb, typeId, thoughtId } = setup();
      try {
        const own = createThoughtTypeView(
          ndb,
          typeId,
          { name: 'В гараже', definition: DEFINITION },
          USER,
        );
        const custom = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'в гараже', definition: DEFINITION },
          USER,
        );

        assert.throws(
          () => moveThoughtCustomViewToType(ndb, thoughtId, custom.id),
          (err: unknown) => {
            assert.ok(err instanceof EtnError);
            assert.equal(err.code, 'DUPLICATE');
            assert.equal((err.details as { existing_id?: string }).existing_id, own.id);
            return true;
          },
        );
        // Отказ атомарен: источник на месте, у типа по-прежнему один отбор.
        assert.ok(getThoughtCustomView(ndb, custom.id));
        assert.equal(getThoughtTypeView(ndb, custom.id), null);

        // Унаследованное имя предка — не конфликт: отбор типа у потомка
        // перекрывает отбор предка у всех мыслей потомка.
        const parent = createThoughtType(ndb, { name: 'parent-kind' }, USER);
        const child = createThoughtType(
          ndb,
          { name: 'child-kind', parent_id: parent.id },
          USER,
        );
        createThoughtTypeView(
          ndb,
          parent.id,
          { name: 'Кому одолжил', definition: DEFINITION },
          USER,
        );
        const childThought = seedThought(ndb, 'Каталог-потомок', child.id);
        const inherited = createThoughtCustomView(
          ndb,
          childThought,
          { name: 'Кому одолжил', definition: DEFINITION },
          USER,
        );
        const moved = moveThoughtCustomViewToType(ndb, childThought, inherited.id);
        assert.equal(moved.view.thought_type_id, child.id);
        const effective = getEffectiveViewsForThought(ndb, { type_id: child.id });
        const found = effective.find((v) => v.name_key === 'кому одолжил');
        assert.ok(found);
        assert.equal(found!.defined_on, child.id, 'перекрытие: winner — собственный отбор потомка');
        assert.equal(found!.inherited, false);
      } finally {
        ndb.close();
      }
    });

    it('вне→тип: имя за надгробием thought_type_views в слое — 409, не 500', () => {
      const { ndb, typeId, thoughtId } = setup();
      try {
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);

        const typeView = createThoughtTypeView(
          ndb,
          typeId,
          { name: 'Занято', definition: DEFINITION },
          USER,
        );
        // Удаляем в слое — надгробие занимает имя (UNIQUE 037 без предиката).
        ndb
          .prepare('UPDATE thought_type_views SET deleted = 1 WHERE id = ? AND layer_id = ?')
          .run(typeView.id, layerId);
        const custom = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'занято', definition: DEFINITION },
          USER,
        );

        assert.throws(
          () => moveThoughtCustomViewToType(ndb, thoughtId, custom.id),
          (err: unknown) => {
            assert.ok(err instanceof EtnError);
            assert.equal(err.code, 'DUPLICATE');
            assert.equal((err.details as { existing_id?: string }).existing_id, typeView.id);
            return true;
          },
        );
        // Источник и надгробие не тронуты.
        assert.ok(getThoughtCustomView(ndb, custom.id));
        assert.equal(rawViewRow(ndb, 'thought_type_views', typeView.id)!.deleted, 1);
      } finally {
        ndb.close();
      }
    });

    it('вне→тип: без типа — 422 THOUGHT_HAS_NO_TYPE; корзина/чужой viewId — 404', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const untyped = seedThought(ndb, 'Без типа');
        const custom = createThoughtCustomView(
          ndb,
          untyped,
          { name: 'Срез', definition: DEFINITION },
          USER,
        );
        assert.throws(
          () => moveThoughtCustomViewToType(ndb, untyped, custom.id),
          (err: unknown) => {
            assert.ok(err instanceof EtnError);
            assert.equal(err.code, 'VALIDATION_ERROR');
            assert.equal((err.details as { code?: string }).code, 'THOUGHT_HAS_NO_TYPE');
            return true;
          },
        );

        // Корзина мысли-владельца — 404.
        const type = createThoughtType(ndb, { name: 'task' }, USER);
        const trashed = seedThought(ndb, 'В корзине', type.id);
        const view = createThoughtCustomView(
          ndb,
          trashed,
          { name: 'Срез', definition: DEFINITION },
          USER,
        );
        trashThought(ndb, trashed);
        assert.throws(
          () => moveThoughtCustomViewToType(ndb, trashed, view.id),
          (err: unknown) => {
            assert.ok(err instanceof EtnError);
            assert.equal(err.code, 'NOT_FOUND');
            return true;
          },
        );

        // Чужой viewId — 404 с фактическим владельцем в details.defined_on.
        const owner = seedThought(ndb, 'Владелец', type.id);
        const foreign = createThoughtCustomView(
          ndb,
          owner,
          { name: 'Чужой', definition: DEFINITION },
          USER,
        );
        const another = seedThought(ndb, 'Другая', type.id);
        assert.throws(
          () => moveThoughtCustomViewToType(ndb, another, foreign.id),
          (err: unknown) => {
            assert.ok(err instanceof EtnError);
            assert.equal(err.code, 'NOT_FOUND');
            assert.equal((err.details as { defined_on?: string }).defined_on, owner);
            return true;
          },
        );
      } finally {
        ndb.close();
      }
    });

    it('дефолты: собственный дефолт получателя снимает пометку, унаследованный — нет', () => {
      const { ndb, typeId, thoughtId } = setup();
      try {
        // Собственный дефолт получателя.
        createThoughtTypeView(
          ndb,
          typeId,
          { name: 'Дефолт типа', definition: DEFINITION, is_default: true },
          USER,
        );
        const source = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'Мой дефолт', definition: DEFINITION, is_default: true },
          USER,
        );
        const moved = moveThoughtCustomViewToType(ndb, thoughtId, source.id);
        assert.equal(moved.view.is_default, false, 'собственный дефолт получателя сильнее');

        // Унаследованный дефолт предка помехой не является.
        const parent = createThoughtType(ndb, { name: 'parent-default' }, USER);
        createThoughtTypeView(
          ndb,
          parent.id,
          { name: 'Дефолт предка', definition: DEFINITION, is_default: true },
          USER,
        );
        const child = createThoughtType(
          ndb,
          { name: 'child-default', parent_id: parent.id },
          USER,
        );
        const childThought = seedThought(ndb, 'Потомок', child.id);
        const inheritedSource = createThoughtCustomView(
          ndb,
          childThought,
          { name: 'Свой дефолт', definition: DEFINITION, is_default: true },
          USER,
        );
        const inheritedMove = moveThoughtCustomViewToType(
          ndb,
          childThought,
          inheritedSource.id,
        );
        assert.equal(inheritedMove.view.is_default, true, 'унаследованный дефолт не мешает');
      } finally {
        ndb.close();
      }
    });

    it('тип→вне: безтиповая цель работает; поля/position/version сохранены', () => {
      const { ndb, typeId } = setup();
      try {
        const target = seedThought(ndb, 'Без типа — цель');
        // У цели уже есть внетиповой отбор → переносимый встаёт в конец.
        createThoughtCustomView(ndb, target, { name: 'Первый', definition: DEFINITION }, USER);
        const source = createThoughtTypeView(
          ndb,
          typeId,
          {
            name: 'Из типа',
            description: 'описание типа',
            definition: DEFINITION,
            position: 4,
          },
          USER,
        );
        ageTypeView(ndb, source.id);

        const moved = moveThoughtTypeViewToThought(ndb, typeId, source.id, target);
        assert.equal(moved.view.id, source.id);
        assert.equal(moved.view.thought_id, target);
        assert.equal(moved.view.definition, DEFINITION);
        assert.equal(moved.view.description, 'описание типа');
        assert.equal(moved.view.created_at, '2020-02-01T00:00:00.000Z');
        assert.equal(moved.view.version, 1);
        assert.ok(moved.view.updated_at > '2020-02-02T00:00:00.000Z');
        assert.equal(moved.view.position, 1, 'position — в конец получателя');
        assert.equal(getThoughtTypeView(ndb, source.id), null);
        assert.deepEqual(
          listThoughtCustomViews(ndb, target).map((v) => v.name),
          ['Первый', 'Из типа'],
        );
      } finally {
        ndb.close();
      }
    });

    it('тип→вне: корзина цели — 404; чужой :typeId — 404 с defined_on; дубль у цели — 409', () => {
      const { ndb, typeId, thoughtId } = setup();
      try {
        const source = createThoughtTypeView(
          ndb,
          typeId,
          { name: 'Переносимый', definition: DEFINITION },
          USER,
        );
        const trashed = seedThought(ndb, 'Корзина', typeId);
        trashThought(ndb, trashed);
        assert.throws(
          () => moveThoughtTypeViewToThought(ndb, typeId, source.id, trashed),
          (err: unknown) => {
            assert.ok(err instanceof EtnError);
            assert.equal(err.code, 'NOT_FOUND');
            return true;
          },
        );

        // Чужой тип в пути — 404 и фактический владелец (defined_on).
        const otherType = createThoughtType(ndb, { name: 'other' }, USER);
        assert.throws(
          () => moveThoughtTypeViewToThought(ndb, otherType.id, source.id, thoughtId),
          (err: unknown) => {
            assert.ok(err instanceof EtnError);
            assert.equal(err.code, 'NOT_FOUND');
            assert.equal((err.details as { defined_on?: string }).defined_on, typeId);
            return true;
          },
        );

        // У цели уже есть одноимённый внетиповой — 409.
        const clash = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'переносимый', definition: DEFINITION },
          USER,
        );
        assert.throws(
          () => moveThoughtTypeViewToThought(ndb, typeId, source.id, thoughtId),
          (err: unknown) => {
            assert.ok(err instanceof EtnError);
            assert.equal(err.code, 'DUPLICATE');
            assert.equal((err.details as { existing_id?: string }).existing_id, clash.id);
            return true;
          },
        );
        assert.ok(getThoughtTypeView(ndb, source.id), 'источник не тронут при отказе');
      } finally {
        ndb.close();
      }
    });

    it('тип→вне: унаследованный источник адресуется по defined_on (тип-владелец)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const parent = createThoughtType(ndb, { name: 'parent' }, USER);
        const child = createThoughtType(
          ndb,
          { name: 'child', parent_id: parent.id },
          USER,
        );
        const inherited = createThoughtTypeView(
          ndb,
          parent.id,
          { name: 'Кому одолжил', definition: DEFINITION },
          USER,
        );
        const target = seedThought(ndb, 'Получатель', child.id);

        // Тип фокуса (потомок) — не владелец: 404 с defined_on предка.
        assert.throws(
          () => moveThoughtTypeViewToThought(ndb, child.id, inherited.id, target),
          (err: unknown) => {
            assert.ok(err instanceof EtnError);
            assert.equal(err.code, 'NOT_FOUND');
            assert.equal((err.details as { defined_on?: string }).defined_on, parent.id);
            return true;
          },
        );
        // Адрес владельца — успех; у потомка отбор исчез из эффективного набора.
        const moved = moveThoughtTypeViewToThought(ndb, parent.id, inherited.id, target);
        assert.equal(moved.source.thought_type_id, parent.id);
        assert.equal(moved.thought_id, target);
        const childEffective = getEffectiveViewsForThought(ndb, { type_id: child.id });
        assert.equal(
          childEffective.some((v) => v.id === inherited.id),
          false,
          'отбор пропал у типа-потомка',
        );
      } finally {
        ndb.close();
      }
    });

    it('круговой перенос строк ИЗ ОСНОВЫ в слое: revival по id, слияние после — без 422', () => {
      const { ndb, typeId, thoughtId } = setup();
      try {
        // Основа: внетиповой X и типовой Y.
        const customX = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'В гараже', definition: DEFINITION },
          USER,
        );
        const typeY = createThoughtTypeView(
          ndb,
          typeId,
          { name: 'Кому одолжил', definition: DEFINITION },
          USER,
        );

        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);

        // Вне→тип→вне (X).
        moveThoughtCustomViewToType(ndb, thoughtId, customX.id);
        assert.equal(rawViewRow(ndb, 'thought_custom_views', customX.id)!.deleted, 1);
        moveThoughtTypeViewToThought(ndb, typeId, customX.id, thoughtId);
        assert.equal(getThoughtCustomView(ndb, customX.id)!.name, 'В гараже');
        assert.equal(rawViewRow(ndb, 'thought_type_views', customX.id)!.deleted, 1);

        // Тип→вне→тип (Y).
        moveThoughtTypeViewToThought(ndb, typeId, typeY.id, thoughtId);
        moveThoughtCustomViewToType(ndb, thoughtId, typeY.id);
        assert.equal(getThoughtTypeView(ndb, typeY.id)!.name, 'Кому одолжил');
        assert.equal(rawViewRow(ndb, 'thought_custom_views', typeY.id)!.deleted, 1);

        // Слияние слоя в основу — пары замыкаются, конфликтов/422 нет.
        const report = mergeLayer(ndb, layerId, undefined, USER);
        assert.ok((report.applied.thought_type_views ?? 0) >= 1);
        assert.ok((report.applied.thought_custom_views ?? 0) >= 1);
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(getThoughtCustomView(ndb, customX.id)!.name, 'В гараже');
        assert.equal(getThoughtTypeView(ndb, customX.id), null, 'типовой надгробие применён');
        assert.equal(getThoughtTypeView(ndb, typeY.id)!.name, 'Кому одолжил');
        assert.equal(getThoughtCustomView(ndb, typeY.id), null);
      } finally {
        ndb.close();
      }
    });

    it('тип→вне: собственный дефолт цели снимает пометку переносимого', () => {
      const { ndb, typeId } = setup();
      try {
        const target = seedThought(ndb, 'Цель с дефолтом');
        createThoughtCustomView(
          ndb,
          target,
          { name: 'Дефолт цели', definition: DEFINITION, is_default: true },
          USER,
        );
        const source = createThoughtTypeView(
          ndb,
          typeId,
          { name: 'Дефолт источника', definition: DEFINITION, is_default: true },
          USER,
        );
        const moved = moveThoughtTypeViewToThought(ndb, typeId, source.id, target);
        assert.equal(moved.view.is_default, false, 'собственный дефолт получателя сильнее');
      } finally {
        ndb.close();
      }
    });

    // --- Дельта раунда 2 (проверка 4e455999, репро S16/S17/S18) -----------
    // Переносы в рабочем слое обязаны видеть не только физические строки
    // слоя, но и видимые `*_v` (включая Основу): имена — как эталон
    // `assertNameAvailable`, дефолты — по видимым собственным строкам.

    it('S18: вне→тип в слое — имя занято видимым из Основы собственным отбором типа: 409, слияние без 422', () => {
      const { ndb, typeId, thoughtId } = setup();
      try {
        // Основа: собственный отбор типа «Живое имя».
        const baseView = createThoughtTypeView(
          ndb,
          typeId,
          { name: 'Живое имя', definition: DEFINITION },
          USER,
        );
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        const custom = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'живое имя', definition: DEFINITION },
          USER,
        );

        // Видимый из Основы собственный отбор типа — конфликт (409), как у
        // эталонной проверки имён CREATE, а не 200 с последующим UNIQUE.
        assert.throws(
          () => moveThoughtCustomViewToType(ndb, thoughtId, custom.id),
          (err: unknown) => {
            assert.ok(err instanceof EtnError);
            assert.equal(err.code, 'DUPLICATE');
            assert.equal(
              (err.details as { existing_id?: string }).existing_id,
              baseView.id,
              'диагностика указывает отбор типа из Основы',
            );
            return true;
          },
        );
        assert.equal(
          getThoughtCustomView(ndb, custom.id)!.name,
          'живое имя',
          'источник не тронут',
        );

        // Слияние после отказа — без 422: строки-получателя в слое не появилось.
        const report = mergeLayer(ndb, layerId, undefined, USER);
        assert.equal(report.applied.thought_type_views ?? 0, 0);
        ndb.useLayer(BASE_LAYER_ID);
        assert.deepEqual(
          listThoughtTypeViewsByType(ndb, typeId).map((v) => v.name),
          ['Живое имя'],
          'в основе по-прежнему один отбор типа',
        );
        assert.equal(
          getThoughtCustomView(ndb, custom.id)!.name,
          'живое имя',
          'внетиповой уехал в основу при merge',
        );
      } finally {
        ndb.close();
      }
    });

    it('S16: вне→тип в слое — видимый из Основы дефолт получателя снимает пометку; после merge один дефолт', () => {
      const { ndb, typeId, thoughtId } = setup();
      try {
        const baseDefault = createThoughtTypeView(
          ndb,
          typeId,
          { name: 'Базовый дефолт', definition: DEFINITION, is_default: true },
          USER,
        );
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        const custom = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'Переносимый дефолт', definition: DEFINITION, is_default: true },
          USER,
        );

        const moved = moveThoughtCustomViewToType(ndb, thoughtId, custom.id);
        assert.equal(
          moved.view.is_default,
          false,
          'видимый из Основы собственный дефолт получателя сильнее',
        );

        mergeLayer(ndb, layerId, undefined, USER);
        ndb.useLayer(BASE_LAYER_ID);
        const defaults = listThoughtTypeViewsByType(ndb, typeId).filter(
          (v) => v.is_default,
        );
        assert.deepEqual(
          defaults.map((v) => v.id),
          [baseDefault.id],
          'после слияния у типа ровно один дефолт — базовый',
        );
      } finally {
        ndb.close();
      }
    });

    it('S17: тип→вне в слое — видимый из Основы дефолт цели снимает пометку; после merge один дефолт', () => {
      const { ndb, typeId } = setup();
      try {
        const target = seedThought(ndb, 'Цель с базовым дефолтом');
        const baseDefault = createThoughtCustomView(
          ndb,
          target,
          { name: 'Дефолт цели', definition: DEFINITION, is_default: true },
          USER,
        );
        const source = createThoughtTypeView(
          ndb,
          typeId,
          { name: 'Переносимый дефолт', definition: DEFINITION, is_default: true },
          USER,
        );
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);

        const moved = moveThoughtTypeViewToThought(ndb, typeId, source.id, target);
        assert.equal(
          moved.view.is_default,
          false,
          'видимый из Основы собственный дефолт цели сильнее',
        );

        mergeLayer(ndb, layerId, undefined, USER);
        ndb.useLayer(BASE_LAYER_ID);
        const defaults = listThoughtCustomViews(ndb, target).filter(
          (v) => v.is_default,
        );
        assert.deepEqual(
          defaults.map((v) => v.id),
          [baseDefault.id],
          'после слияния у мысли ровно один дефолт — базовый',
        );
      } finally {
        ndb.close();
      }
    });

    it('тип→вне в слое: видимый из Основы одноимённый внетиповой цели — 409', () => {
      const { ndb, typeId } = setup();
      try {
        const target = seedThought(ndb, 'Цель с отбором');
        const baseCustom = createThoughtCustomView(
          ndb,
          target,
          { name: 'Кому одолжил', definition: DEFINITION },
          USER,
        );
        const source = createThoughtTypeView(
          ndb,
          typeId,
          { name: 'кому одолжил', definition: DEFINITION },
          USER,
        );
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);

        assert.throws(
          () => moveThoughtTypeViewToThought(ndb, typeId, source.id, target),
          (err: unknown) => {
            assert.ok(err instanceof EtnError);
            assert.equal(err.code, 'DUPLICATE');
            assert.equal(
              (err.details as { existing_id?: string }).existing_id,
              baseCustom.id,
              'диагностика указывает внетиповой отбор цели из Основы',
            );
            return true;
          },
        );
        assert.equal(getThoughtTypeView(ndb, source.id)!.name, 'кому одолжил');
      } finally {
        ndb.close();
      }
    });

    // Регресс механизма V1 (пара переноса замыкается мягко): обратное
    // направление — выбор внетиповой строки увозит типовую — покрыто
    // `thought-custom-views.test.ts` («частичное слияние внетипового тянет
    // пару переноса»); здесь — типовой выбор увозит внетиповую пару.
    it('частичное слияние пары переноса: типовой выбор увозит внетиповую пару (V1)', () => {
      const { ndb, typeId, thoughtId } = setup();
      try {
        // Пара в ОСНОВЕ: отбор типа, который слой перенёс в внетиповой.
        const pairId = randomUUID();
        const now = '2026-01-01T00:00:00.000Z';
        ndb
          .prepare(
            `INSERT INTO thought_type_views
               (id, layer_id, deleted, thought_type_id, name, name_key, definition,
                position, is_default, version, created_at, updated_at, created_by)
             VALUES (?, ?, 0, ?, 'Пара', 'пара', '{}', 0, 0, 1, ?, ?, 'u')`,
          )
          .run(pairId, BASE_LAYER_ID, typeId, now, now);
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        // Обе стороны пары физически в слое: живой внетиповой + надгробие типа.
        createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'Пара', definition: DEFINITION },
          USER,
        );
        ndb
          .prepare(
            `INSERT INTO thought_type_views
               (id, layer_id, deleted, base_version, thought_type_id, name, name_key, definition,
                position, is_default, version, created_at, updated_at, created_by)
             VALUES (?, ?, 1, 1, ?, 'Пара', 'пара', '{}', 0, 0, 2, ?, ?, 'u')`,
          )
          .run(pairId, layerId, typeId, now, now);
        // Приведём id внетиповой стороны к pairId (create дал случайный).
        const custom = listThoughtCustomViews(ndb, thoughtId).find((v) => v.name === 'Пара')!;
        ndb
          .prepare('UPDATE thought_custom_views SET id = ? WHERE id = ? AND layer_id = ?')
          .run(pairId, custom.id, layerId);
        // Две стороны пары должны иметь общий id; проверяем оба направления
        // частичного слияния через набор строк.
        const rows = collectThoughtLayerRows(ndb, layerId, thoughtId);
        assert.deepEqual(rows.thought_custom_views, [pairId]);
        assert.deepEqual(rows.thought_type_views, [pairId]);

        // Частичное слияние, тянущее ТИПОВУЮ строку, увозит пару.
        const report = mergeLayer(ndb, layerId, { thought_type_views: [pairId] }, USER);
        assert.equal(report.applied.thought_type_views, 1);
        assert.equal(report.applied.thought_custom_views, 1, 'пара уехала вместе');
      } finally {
        ndb.close();
      }
    });

    it('слоевая видимость: подписчик Основы не получает события переноса из слоя', () => {
      const { ndb, typeId, thoughtId } = setup();
      try {
        const custom = createThoughtCustomView(
          ndb,
          thoughtId,
          { name: 'X', definition: DEFINITION },
          USER,
        );
        const typeView = createThoughtTypeView(
          ndb,
          typeId,
          { name: 'Y', definition: DEFINITION },
          USER,
        );
        const layerId = seedLayer(ndb);
        ndb.useLayer(layerId);
        moveThoughtCustomViewToType(ndb, thoughtId, custom.id);

        // Событие «вне→тип»: подписчик Основы не видит ни одного из пары.
        // `isEventVisibleInLayer` читает цепочку слоёв СОЕДИНЕНИЯ — поэтому
        // перед проверкой переключаем контекст на слой подписчика.
        const event = (type: string, data: Record<string, unknown>): AnyRealtimeEvent =>
          ({ type, data, layer_id: layerId } as unknown as AnyRealtimeEvent);
        const deletedEvent = event('thought-custom-view.deleted', {
          thought_id: thoughtId,
          view_id: custom.id,
        });
        const createdEvent = event('thought-type-view.created', {
          thought_type_id: typeId,
          view: { id: custom.id },
        });

        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(
          isEventVisibleInLayer(ndb, deletedEvent, BASE_LAYER_ID),
          false,
          'подписчик Основы не получает deleted переноса из слоя',
        );
        assert.equal(
          isEventVisibleInLayer(ndb, createdEvent, BASE_LAYER_ID),
          false,
          'подписчик Основы не получает created переноса из слоя',
        );

        // Подписчик слоя — видит оба.
        ndb.useLayer(layerId);
        assert.equal(isEventVisibleInLayer(ndb, deletedEvent, layerId), true);
        assert.equal(isEventVisibleInLayer(ndb, createdEvent, layerId), true);

        // Обратное направление: тип Y (из основы) уезжает в внетиповой в слое.
        moveThoughtTypeViewToThought(ndb, typeId, typeView.id, thoughtId);
        const typeDeleted = event('thought-type-view.deleted', {
          thought_type_id: typeId,
          view_id: typeView.id,
        });
        const customCreated = event('thought-custom-view.created', {
          thought_id: thoughtId,
          view: { id: typeView.id },
        });
        ndb.useLayer(BASE_LAYER_ID);
        assert.equal(isEventVisibleInLayer(ndb, typeDeleted, BASE_LAYER_ID), false);
        assert.equal(isEventVisibleInLayer(ndb, customCreated, BASE_LAYER_ID), false);
      } finally {
        ndb.close();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

async function createType(ctx: RestTestContext, name: string, parentId?: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types`,
    headers: authHeaders(ctx),
    payload: { name, ...(parentId === undefined ? {} : { parent_id: parentId }) },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

async function createThought(
  ctx: RestTestContext,
  title: string,
  typeId?: string,
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts`,
    headers: authHeaders(ctx),
    payload: {
      title,
      ...(typeId === undefined ? {} : { type_id: typeId }),
      create_link: { direction: 'parent', target_thought_id: ctx.homeId },
    },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

async function createTypeView(
  ctx: RestTestContext,
  typeId: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = authHeaders(ctx),
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
    headers,
    payload: { definition: DEFINITION, ...payload },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

async function createCustomView(
  ctx: RestTestContext,
  thoughtId: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = authHeaders(ctx),
): Promise<{ id: string; statusCode: number; body: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/views`,
    headers,
    payload: { definition: DEFINITION, ...payload },
  });
  return {
    id: res.statusCode < 300 ? (res.json().data as { id: string }).id : '',
    statusCode: res.statusCode,
    body: res.body,
  };
}

function moveToTypeUrl(ctx: RestTestContext, thoughtId: string, viewId: string): string {
  return `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/views/${viewId}/move-to-type`;
}

function moveToThoughtUrl(ctx: RestTestContext, typeId: string, viewId: string): string {
  return `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views/${viewId}/move-to-thought`;
}

async function selectLayer(
  ctx: RestTestContext,
  layerId: string,
  clientId: string,
): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers/${layerId}/select`,
    headers: { ...authHeaders(ctx), 'client-id': clientId },
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body?.toString());
}

async function createLayer(ctx: RestTestContext, title: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/layers`,
    headers: authHeaders(ctx),
    payload: { title },
  });
  assert.equal(res.statusCode, 201, res.body?.toString());
  return (res.json().data as { id: string }).id;
}

describe(
  'перенос владельца отбора — REST (85414fbd)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('move-to-type: ответ 200 — карточка нового владельца + meta.layer; события пары', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const typeId = await createType(ctx, 'task');
        const thoughtId = await createThought(ctx, 'Каталог', typeId);
        const sibling = await createThought(ctx, 'Сосед', typeId);
        const firstView = await createTypeView(ctx, typeId, { name: 'Первый' });
        const custom = await createCustomView(ctx, thoughtId, {
          name: 'В гараже',
          description: 'описание',
        });
        assert.equal(custom.statusCode, 201, custom.body);

        const pubsub = ctx.app.pubsub;
        const received: AnyRealtimeEvent[] = [];
        const unsubscribe = pubsub.subscribe(ctx.networkId, (e: AnyRealtimeEvent) =>
          received.push(e),
        );
        let res: Awaited<ReturnType<typeof ctx.app.inject>>;
        try {
          res = await ctx.app.inject({
            method: 'POST',
            url: moveToTypeUrl(ctx, thoughtId, custom.id),
            headers: h,
          });
        } finally {
          unsubscribe();
        }
        assert.equal(res.statusCode, 200, res.body?.toString());
        const body = res.json() as {
          data: {
            id: string;
            thought_type_id: string;
            version: number;
            position: number;
            updated_at: string;
          };
          meta?: { layer?: { id: string } };
        };
        assert.equal(body.data.id, custom.id, 'id сохраняется');
        assert.equal(body.data.thought_type_id, typeId);
        assert.equal(body.data.version, 1);
        assert.equal(body.data.position, 1);
        assert.ok(body.data.updated_at);
        assert.ok(body.meta?.layer?.id, 'meta.layer — как у прочих write-ответов');

        // Источник исчез, у соседа отбор виден в эффективном наборе.
        const customList = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}/views`,
          headers: h,
        });
        assert.deepEqual(customList.json().data, []);
        const siblingViews = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${sibling}/views?include_effective=true`,
          headers: h,
        });
        const effective = (
          siblingViews.json().meta as { effective: Array<{ id: string; scope: string }> }
        ).effective;
        assert.deepEqual(
          effective.map((v) => [v.id, v.scope]),
          [
            [firstView, 'type'],
            [custom.id, 'type'],
          ],
        );

        await new Promise((r) => setImmediate(r));
        const deleted = received.find((e) => e.type === 'thought-custom-view.deleted');
        const created = received.find((e) => e.type === 'thought-type-view.created');
        assert.ok(deleted && created, 'пара событий');
        const deletedData = deleted!.data as unknown as {
          view_id: string;
          reason?: string;
          moved_to?: string;
          view: { id: string };
        };
        assert.equal(deletedData.view_id, custom.id);
        assert.equal(deletedData.reason, 'moved');
        assert.equal(deletedData.moved_to, typeId);
        assert.equal(deletedData.view.id, custom.id);
        const createdData = created!.data as {
          thought_type_id: string;
          view: { id: string; defined_on: string; inherited: boolean };
        };
        assert.equal(createdData.thought_type_id, typeId);
        assert.equal(createdData.view.id, custom.id);
        assert.equal(createdData.view.defined_on, typeId, 'created — EffectiveThoughtTypeView');
        assert.equal(createdData.view.inherited, false);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('move-to-thought: ответ 200 — внетиповая карточка scope/defined_on; события пары', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const typeId = await createType(ctx, 'task');
        // Безтиповая цель — работает (П2.5).
        const target = await createThought(ctx, 'Без типа');
        const typeView = await createTypeView(ctx, typeId, { name: 'Из типа' });

        const pubsub = ctx.app.pubsub;
        const received: AnyRealtimeEvent[] = [];
        const unsubscribe = pubsub.subscribe(ctx.networkId, (e: AnyRealtimeEvent) =>
          received.push(e),
        );
        let res: Awaited<ReturnType<typeof ctx.app.inject>>;
        try {
          res = await ctx.app.inject({
            method: 'POST',
            url: moveToThoughtUrl(ctx, typeId, typeView),
            headers: h,
            payload: { target_thought_id: target.slice(0, 8) },
          });
        } finally {
          unsubscribe();
        }
        assert.equal(res.statusCode, 200, res.body?.toString());
        const data = res.json().data as {
          id: string;
          scope: string;
          defined_on: string;
          version: number;
          position: number;
        };
        assert.equal(data.id, typeView);
        assert.equal(data.scope, 'thought');
        assert.equal(data.defined_on, target, 'короткий префикс цели резолвится');
        assert.equal(data.version, 1);
        assert.equal(data.position, 0);

        const typeList = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
          headers: h,
        });
        assert.deepEqual(typeList.json().data, []);

        await new Promise((r) => setImmediate(r));
        const deleted = received.find((e) => e.type === 'thought-type-view.deleted');
        const created = received.find((e) => e.type === 'thought-custom-view.created');
        assert.ok(deleted && created, 'пара событий');
        const deletedData = deleted!.data as unknown as {
          thought_type_id: string;
          view_id: string;
          reason?: string;
          moved_to?: string;
        };
        assert.equal(deletedData.thought_type_id, typeId, 'реальный владелец строки');
        assert.equal(deletedData.view_id, typeView);
        assert.equal(deletedData.reason, 'moved');
        assert.equal(deletedData.moved_to, target);
        const createdData = created!.data as {
          thought_id: string;
          view: { id: string; scope: string; defined_on: string };
        };
        assert.equal(createdData.thought_id, target);
        assert.equal(createdData.view.id, typeView);
        assert.equal(createdData.view.scope, 'thought');
        assert.equal(createdData.view.defined_on, target);
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('идемпотентность: replay 200 тем же ключом, 404 новым', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const typeId = await createType(ctx, 'task');
        const thoughtId = await createThought(ctx, 'Мысль', typeId);
        const custom = await createCustomView(ctx, thoughtId, { name: 'Идемпотентный' });
        assert.equal(custom.statusCode, 201);

        const headers = { ...h, 'client-request-id': `move-${randomUUID()}` };
        const first = await ctx.app.inject({
          method: 'POST',
          url: moveToTypeUrl(ctx, thoughtId, custom.id),
          headers,
        });
        assert.equal(first.statusCode, 200, first.body?.toString());
        const replay = await ctx.app.inject({
          method: 'POST',
          url: moveToTypeUrl(ctx, thoughtId, custom.id),
          headers,
        });
        assert.equal(replay.statusCode, 200, replay.body?.toString());
        assert.deepEqual(replay.json(), first.json(), 'replay отдаёт тот же ответ');

        // Новый ключ: источника уже нет — 404.
        const fresh = await ctx.app.inject({
          method: 'POST',
          url: moveToTypeUrl(ctx, thoughtId, custom.id),
          headers: { ...h, 'client-request-id': `move-${randomUUID()}` },
        });
        assert.equal(fresh.statusCode, 404, fresh.body?.toString());
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('404: корзина источника/цели, чужой viewId с defined_on; 422 без типа', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const typeId = await createType(ctx, 'task');
        const thoughtId = await createThought(ctx, 'Мысль', typeId);
        const another = await createThought(ctx, 'Другая', typeId);
        const custom = await createCustomView(ctx, thoughtId, { name: 'Свой' });
        assert.equal(custom.statusCode, 201);

        // Чужой viewId — 404, defined_on — фактический владелец.
        const foreign = await ctx.app.inject({
          method: 'POST',
          url: moveToTypeUrl(ctx, another, custom.id),
          headers: h,
        });
        assert.equal(foreign.statusCode, 404, foreign.body?.toString());
        assert.equal(
          (foreign.json().error.details as { defined_on?: string }).defined_on,
          thoughtId,
        );

        // Без типа — 422 THOUGHT_HAS_NO_TYPE.
        const untyped = await createThought(ctx, 'Без типа');
        const untypedView = await createCustomView(ctx, untyped, { name: 'Срез' });
        const noType = await ctx.app.inject({
          method: 'POST',
          url: moveToTypeUrl(ctx, untyped, untypedView.id),
          headers: h,
        });
        assert.equal(noType.statusCode, 422, noType.body?.toString());
        assert.equal(
          (noType.json().error.details as { code?: string }).code,
          'THOUGHT_HAS_NO_TYPE',
        );

        // Корзина источника — 404.
        const trashed = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${thoughtId}`,
          headers: h,
          payload: { marked_for_deletion: true },
        });
        assert.equal(trashed.statusCode, 200, trashed.body?.toString());
        const trashedMove = await ctx.app.inject({
          method: 'POST',
          url: moveToTypeUrl(ctx, thoughtId, custom.id),
          headers: h,
        });
        assert.equal(trashedMove.statusCode, 404, trashedMove.body?.toString());

        // Корзина цели move-to-thought — 404.
        const typeView = await createTypeView(ctx, typeId, { name: 'Типовой' });
        const trashTarget = await ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/thoughts/${another}`,
          headers: h,
          payload: { marked_for_deletion: true },
        });
        assert.equal(trashTarget.statusCode, 200);
        const targetTrashed = await ctx.app.inject({
          method: 'POST',
          url: moveToThoughtUrl(ctx, typeId, typeView),
          headers: h,
          payload: { target_thought_id: another },
        });
        assert.equal(targetTrashed.statusCode, 404, targetTrashed.body?.toString());
      } finally {
        await closeRestContext(ctx);
      }
    });

    it('move-to-type в слое: надгробие имени типового — 409, не 500; after move-to-thought имя занято до слияния', async () => {
      const ctx = await buildRestContext();
      try {
        const h = authHeaders(ctx);
        const typeId = await createType(ctx, 'task');
        const thoughtId = await createThought(ctx, 'Мысль', typeId);
        const layerId = await createLayer(ctx, 'Слой переносов');
        const layerHeaders = { ...h, 'client-id': 'transfer-layer' };
        await selectLayer(ctx, layerId, 'transfer-layer');

        // В слое: типовой отбор «Занято» → удаляем (надгробие занимает имя).
        const typeView = await createTypeView(ctx, typeId, { name: 'Занято' }, layerHeaders);
        const del = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views/${typeView}`,
          headers: { ...layerHeaders, 'if-match': '1' },
        });
        assert.equal(del.statusCode, 204, del.body?.toString());
        const custom = await createCustomView(ctx, thoughtId, { name: 'занято' }, layerHeaders);
        assert.equal(custom.statusCode, 201, custom.body);

        const collision = await ctx.app.inject({
          method: 'POST',
          url: moveToTypeUrl(ctx, thoughtId, custom.id),
          headers: layerHeaders,
        });
        assert.equal(collision.statusCode, 409, collision.body?.toString());
        assert.equal(collision.json().error.code, 'DUPLICATE');
        assert.equal(
          (collision.json().error.details as { existing_id?: string }).existing_id,
          typeView,
        );

        // Реальный move-to-thought в слое: имя типового занято надгробием
        // до слияния — CREATE того же имени даёт 409 с диагностикой.
        const movable = await createTypeView(ctx, typeId, { name: 'Уедет' }, layerHeaders);
        const move = await ctx.app.inject({
          method: 'POST',
          url: moveToThoughtUrl(ctx, typeId, movable),
          headers: layerHeaders,
          payload: { target_thought_id: thoughtId },
        });
        assert.equal(move.statusCode, 200, move.body?.toString());

        const recreate = await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/networks/${ctx.networkId}/thought-types/${typeId}/views`,
          headers: layerHeaders,
          payload: { name: 'Уедет', definition: DEFINITION },
        });
        assert.equal(recreate.statusCode, 409, recreate.body?.toString());
        assert.equal(recreate.json().error.code, 'DUPLICATE');
        assert.equal(
          (recreate.json().error.details as { existing_id?: string }).existing_id,
          movable,
          'надгробие перенесённого типового занимает имя',
        );
      } finally {
        await closeRestContext(ctx);
      }
    });
  },
);
