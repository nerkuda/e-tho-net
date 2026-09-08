/**
 * Unit tests for the `thought_type_views` repository
 * (server/src/domain/thought-type-views-repo.ts, задача 5361aa33
 * «Хранение отборов типов», миграция 037).
 *
 * Сценарии:
 *   * CRUD: insert / get / list-by-type / update / delete;
 *   * уникальность имени отбора в пределах одного типа (требование 141c2576);
 *   * ветвимость слоёв: правка отбора в слое НЕ затрагивает базу; надгробие
 *     в слое скрывает базовую строку;
 *   * репозиторий НЕ обеспечивает инвариант «один is_default на тип»
 *     (требование 7263e565) — это задача доменного слоя (17eb741e), здесь
 *     только проверяем, что хранилище позволяет сохранить такой кейс без
 *     ошибки, чтобы домен мог снять старую пометку и поставить новую
 *     одной транзакцией;
 *   * пустой definition отвергается на уровне БД NOT NULL.
 *
 * Skip на отсутствии нативной сборки `better-sqlite3` — как и остальные
 * unit-тесты серверного домена.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import type { NetworkDb } from '../src/db/network-db.js';
import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import {
  deleteThoughtTypeView,
  getThoughtTypeView,
  insertThoughtTypeView,
  listThoughtTypeViewsByType,
  THOUGHT_TYPE_VIEW_NAME_MAX,
  updateThoughtTypeView,
} from '../src/domain/thought-type-views-repo.js';

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const USER = 'user-1';
const DEFINITION = '{"keywords":"alpha","sort":"title","order":"asc"}';

describe(
  'thought_type_views repository (задача 5361aa33)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    /** Готовая БД + один тип «task» с известным id. */
    function setup(): { ndb: NetworkDb; typeId: string } {
      const ndb = createInMemoryNetworkDb();
      const tt = createThoughtType(ndb, { name: 'task' }, USER);
      return { ndb, typeId: tt.id };
    }

    it('insert / get / list roundtrip сохраняет все поля', () => {
      const { ndb, typeId } = setup();
      try {
        const created = insertThoughtTypeView(
          ndb,
          {
            thought_type_id: typeId,
            name: 'Активные',
            description: 'мысли со статусом активна',
            definition: DEFINITION,
            position: 2,
            is_default: true,
          },
          USER,
        );

        assert.equal(created.thought_type_id, typeId);
        assert.equal(created.name, 'Активные');
        assert.equal(created.name_key, 'активные');
        assert.equal(created.description, 'мысли со статусом активна');
        assert.equal(created.definition, DEFINITION);
        assert.equal(created.position, 2);
        assert.equal(created.is_default, 1);
        assert.equal(created.version, 1);
        assert.equal(created.created_by, USER);

        // Чтение по id
        const fetched = getThoughtTypeView(ndb, created.id);
        assert.deepEqual(fetched, created);

        // Список по типу содержит ровно одну запись
        const list = listThoughtTypeViewsByType(ndb, typeId);
        assert.equal(list.length, 1);
        assert.equal(list[0]!.id, created.id);
      } finally {
        ndb.close();
      }
    });

    it('list сортирует по position, затем по имени', () => {
      const { ndb, typeId } = setup();
      try {
        insertThoughtTypeView(
          ndb,
          { thought_type_id: typeId, name: 'Гамма', definition: DEFINITION, position: 1 },
          USER,
        );
        insertThoughtTypeView(
          ndb,
          { thought_type_id: typeId, name: 'Альфа', definition: DEFINITION, position: 0 },
          USER,
        );
        insertThoughtTypeView(
          ndb,
          { thought_type_id: typeId, name: 'Бета', definition: DEFINITION, position: 0 },
          USER,
        );
        const list = listThoughtTypeViewsByType(ndb, typeId);
        assert.deepEqual(
          list.map((v) => v.name),
          ['Альфа', 'Бета', 'Гамма'],
        );
      } finally {
        ndb.close();
      }
    });

    it('уникальность имени отбора в пределах своего типа (требование 141c2576)', () => {
      const { ndb, typeId } = setup();
      try {
        insertThoughtTypeView(
          ndb,
          { thought_type_id: typeId, name: 'Активные', definition: DEFINITION },
          USER,
        );
        // Тот же тип, то же имя в той же форме — UNIQUE-конфликт.
        assert.throws(
          () =>
            insertThoughtTypeView(
              ndb,
              { thought_type_id: typeId, name: 'Активные', definition: DEFINITION },
              USER,
            ),
          /UNIQUE/,
        );
        // Регистр игнорируется: «активные» и «АКТИВНЫЕ» — одно и то же имя.
        assert.throws(
          () =>
            insertThoughtTypeView(
              ndb,
              { thought_type_id: typeId, name: 'АКТИВНЫЕ', definition: DEFINITION },
              USER,
            ),
          /UNIQUE/,
        );
      } finally {
        ndb.close();
      }
    });

    it('то же имя в ДРУГОМ типе не конфликтует (имя уникально в пределах своего типа)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const a = createThoughtType(ndb, { name: 'task' }, USER);
        const b = createThoughtType(ndb, { name: 'person' }, USER);
        insertThoughtTypeView(
          ndb,
          { thought_type_id: a.id, name: 'Все', definition: DEFINITION },
          USER,
        );
        // Другой тип — другое пространство имён.
        insertThoughtTypeView(
          ndb,
          { thought_type_id: b.id, name: 'Все', definition: DEFINITION },
          USER,
        );
        assert.equal(listThoughtTypeViewsByType(ndb, a.id).length, 1);
        assert.equal(listThoughtTypeViewsByType(ndb, b.id).length, 1);
      } finally {
        ndb.close();
      }
    });

    it('update инкрементирует version и применяет изменения через слой', () => {
      const { ndb, typeId } = setup();
      try {
        const created = insertThoughtTypeView(
          ndb,
          { thought_type_id: typeId, name: 'Активные', definition: DEFINITION, position: 0 },
          USER,
        );
        const updated = updateThoughtTypeView(
          ndb,
          created.id,
          { name: 'Горячие', description: 'новое описание', position: 5, is_default: true },
          USER,
        );
        assert.equal(updated.name, 'Горячие');
        assert.equal(updated.name_key, 'горячие');
        assert.equal(updated.description, 'новое описание');
        assert.equal(updated.position, 5);
        assert.equal(updated.is_default, 1);
        assert.equal(updated.version, 2, 'version + 1 на каждой успешной правке');
      } finally {
        ndb.close();
      }
    });

    it('update несуществующего id бросает ошибку', () => {
      const { ndb } = setup();
      try {
        assert.throws(
          () =>
            updateThoughtTypeView(
              ndb,
              '00000000-0000-4000-8000-000000000000',
              { name: 'x' },
              USER,
            ),
          /not found/,
        );
      } finally {
        ndb.close();
      }
    });

    it('delete в основе удаляет физически (последующий get возвращает null)', () => {
      const { ndb, typeId } = setup();
      try {
        const v = insertThoughtTypeView(
          ndb,
          { thought_type_id: typeId, name: 'Активные', definition: DEFINITION },
          USER,
        );
        assert.equal(deleteThoughtTypeView(ndb, v.id), true);
        assert.equal(getThoughtTypeView(ndb, v.id), null);
        assert.equal(deleteThoughtTypeView(ndb, v.id), false, 'повторный delete — false');
      } finally {
        ndb.close();
      }
    });

    it('delete в слое оставляет базовую строку (надгробие слоя скрывает её)', () => {
      const { ndb, typeId } = setup();
      try {
        const v = insertThoughtTypeView(
          ndb,
          { thought_type_id: typeId, name: 'Активные', definition: DEFINITION },
          USER,
        );
        // Дочерний слой
        ndb.exec(
          `INSERT INTO layers (id, parent_id, title, depth, created_by, created_at, last_activity_at)
             VALUES ('11111111-1111-4111-8111-111111111111',
                     '${BASE_LAYER_ID}', 'L1', 1, '${USER}', '2024-01-01', '2024-01-01')`,
        );
        ndb.useLayer('11111111-1111-4111-8111-111111111111');

        assert.equal(deleteThoughtTypeView(ndb, v.id), true);
        // В слое строка скрыта
        assert.equal(getThoughtTypeView(ndb, v.id), null);
        // В базе она ещё есть
        const stillThere = ndb
          .prepare('SELECT id FROM thought_type_views WHERE id = ? AND deleted = 0')
          .get(v.id) as { id: string } | undefined;
        assert.ok(stillThere, 'базовая строка не удалена');
        // Возврат в базу — снова видна
        ndb.useLayer(BASE_LAYER_ID);
        const back = getThoughtTypeView(ndb, v.id);
        assert.ok(back);
        assert.equal(back!.id, v.id);
      } finally {
        ndb.close();
      }
    });

    it('update в слое НЕ затрагивает базовую строку (материализация тени)', () => {
      const { ndb, typeId } = setup();
      try {
        const v = insertThoughtTypeView(
          ndb,
          { thought_type_id: typeId, name: 'Активные', definition: DEFINITION, position: 0 },
          USER,
        );

        ndb.exec(
          `INSERT INTO layers (id, parent_id, title, depth, created_by, created_at, last_activity_at)
             VALUES ('22222222-2222-4222-8222-222222222222',
                     '${BASE_LAYER_ID}', 'L2', 1, '${USER}', '2024-01-01', '2024-01-01')`,
        );
        ndb.useLayer('22222222-2222-4222-8222-222222222222');

        const updated = updateThoughtTypeView(
          ndb,
          v.id,
          { name: 'Горячие', position: 9 },
          USER,
        );
        assert.equal(updated.name, 'Горячие');
        assert.equal(updated.version, 2);

        // Базовая строка осталась прежней
        const base = ndb
          .prepare('SELECT name, position, version FROM thought_type_views WHERE id = ? AND layer_id = ?')
          .get(v.id, BASE_LAYER_ID) as { name: string; position: number; version: number };
        assert.equal(base.name, 'Активные');
        assert.equal(base.position, 0);
        assert.equal(base.version, 1);

        // В слое — перекрытая строка
        const inLayer = ndb
          .prepare('SELECT name, position, version, layer_id, base_version FROM thought_type_views WHERE id = ? AND layer_id = ?')
          .get(v.id, '22222222-2222-4222-8222-222222222222') as {
          name: string;
          position: number;
          version: number;
          layer_id: string;
          base_version: number;
        };
        assert.equal(inLayer.name, 'Горячие');
        assert.equal(inLayer.position, 9);
        assert.equal(inLayer.version, 2);
        assert.equal(inLayer.base_version, 1, 'base_version фиксируется на момент материализации');
      } finally {
        ndb.close();
      }
    });

    it('позволяет иметь несколько is_default=1 (инвариант — задача домена 17eb741e)', () => {
      const { ndb, typeId } = setup();
      try {
        // Репозиторий не закрывает инвариант «один is_default на тип» —
        // он обеспечивается доменным слоем, который в одной транзакции
        // снимает старую пометку и ставит новую. Здесь только подтверждаем,
        // что хранилище такую запись принимает.
        insertThoughtTypeView(
          ndb,
          { thought_type_id: typeId, name: 'Первый', definition: DEFINITION, is_default: true },
          USER,
        );
        insertThoughtTypeView(
          ndb,
          { thought_type_id: typeId, name: 'Второй', definition: DEFINITION, is_default: true },
          USER,
        );
        const list = listThoughtTypeViewsByType(ndb, typeId);
        assert.equal(list.length, 2);
        assert.ok(list.every((v) => v.is_default === 1));
      } finally {
        ndb.close();
      }
    });

    it('пустое/превышающее лимит имя отвергается на входе', () => {
      const { ndb, typeId } = setup();
      try {
        assert.throws(
          () =>
            insertThoughtTypeView(
              ndb,
              { thought_type_id: typeId, name: '   ', definition: DEFINITION },
              USER,
            ),
          /non-empty/,
        );
        const long = 'x'.repeat(THOUGHT_TYPE_VIEW_NAME_MAX + 1);
        assert.throws(
          () =>
            insertThoughtTypeView(
              ndb,
              { thought_type_id: typeId, name: long, definition: DEFINITION },
              USER,
            ),
          new RegExp(String(THOUGHT_TYPE_VIEW_NAME_MAX)),
        );
      } finally {
        ndb.close();
      }
    });
  },
);
