/**
 * Unit tests for the `thought_type_views` domain service
 * (server/src/domain/thought-type-views-service.ts, задача 17eb741e
 * «Домен отборов типа»).
 *
 * Покрытие по требованиям:
 *   * 141c2576 — уникальность имени в пределах типа (create + переименование,
 *     регистронезависимо);
 *   * 7263e565 — единственный `is_default` на тип (create с is_default +
 *     update с is_default + создание второго без снятия первого);
 *   * eaca1253 — эффективный набор: пустой набор, свои отборы, наследование
 *     от предков, перекрытие одноимённых, порядок от корня к типу мысли,
 *     наследование `is_default`;
 *   * 23e0f78e — мысль без типа видит отборы корневого типа; добавлять
 *     отборы корневому типу через `create` запрещено.
 *
 * Skip на отсутствии нативной сборки `better-sqlite3` — как и остальные
 * unit-тесты серверного домена.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { EtnError, THOUGHT_TYPE_VIEW_NAME_MAX } from '@etn/shared';

import type { NetworkDb } from '../src/db/network-db.js';
import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import {
  createThoughtType,
  getRootThoughtType,
} from '../src/domain/thought-type-service.js';
import {
  createThoughtTypeView,
  deleteThoughtTypeView,
  getEffectiveViewsForThought,
  getThoughtTypeView,
  listThoughtTypeViewsByType,
  updateThoughtTypeView,
} from '../src/domain/thought-type-views-service.js';

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

/** Insert a thought row directly — обходит thought-service для краткости тестов. */
function seedThought(
  ndb: NetworkDb,
  overrides: Partial<{ id: string; title: string; type_id: string | null }> = {},
): string {
  const id = overrides.id ?? randomUUID();
  const title = overrides.title ?? 'Seed';
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 0, 1,
               '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase(), overrides.type_id ?? null);
  return id;
}

describe(
  'thought_type_views service (задача 17eb741e)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    /** Сеть + один обычный тип «task» с известным id. */
    function setup(): { ndb: NetworkDb; typeId: string; rootId: string } {
      const ndb = createInMemoryNetworkDb();
      const tt = createThoughtType(ndb, { name: 'task' }, USER);
      const root = getRootThoughtType(ndb);
      assert.ok(root, 'корневой тип должен существовать после миграций');
      return { ndb, typeId: tt.id, rootId: root!.id };
    }

    describe('CRUD', () => {
      it('create / get / list сохраняет поля и нормализует name_key', () => {
        const { ndb, typeId } = setup();
        try {
          const created = createThoughtTypeView(
            ndb,
            typeId,
            {
              name: '  Активные  ',
              description: 'мысли со статусом активна',
              definition: DEFINITION,
              position: 3,
              is_default: true,
            },
            USER,
          );
          assert.equal(created.name, 'Активные', 'trim в начале и конце');
          assert.equal(created.name_key, 'активные', 'lowercase для name_key');
          assert.equal(created.description, 'мысли со статусом активна');
          assert.equal(created.definition, DEFINITION);
          assert.equal(created.position, 3);
          assert.equal(created.is_default, true);

          // Чтение по id
          const fetched = getThoughtTypeView(ndb, created.id);
          assert.deepEqual(fetched, created);

          // Список по типу
          const list = listThoughtTypeViewsByType(ndb, typeId);
          assert.equal(list.length, 1);
          assert.equal(list[0]!.id, created.id);
        } finally {
          ndb.close();
        }
      });

      it('update с частичной правкой применяет только переданные поля', () => {
        const { ndb, typeId } = setup();
        try {
          const created = createThoughtTypeView(
            ndb,
            typeId,
            { name: 'Активные', definition: DEFINITION, position: 1 },
            USER,
          );
          const updated = updateThoughtTypeView(
            ndb,
            created.id,
            { description: 'новое описание', position: 5 },
            undefined,
            USER,
          );
          assert.equal(updated.name, 'Активные', 'имя не менялось');
          assert.equal(updated.description, 'новое описание');
          assert.equal(updated.position, 5);
          assert.equal(updated.is_default, false);
          assert.equal(updated.version, 2);
        } finally {
          ndb.close();
        }
      });

      it('update с expectedVersion: VERSION_CONFLICT при несовпадении', () => {
        const { ndb, typeId } = setup();
        try {
          const created = createThoughtTypeView(
            ndb,
            typeId,
            { name: 'Активные', definition: DEFINITION },
            USER,
          );
          // Делаем ещё одну правку — version уходит вперёд
          updateThoughtTypeView(
            ndb,
            created.id,
            { description: 'x' },
            undefined,
            USER,
          );
          assert.throws(
            () =>
              updateThoughtTypeView(
                ndb,
                created.id,
                { description: 'y' },
                1, // старая версия
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'VERSION_CONFLICT');
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });

      it('delete возвращает NOT_FOUND для несуществующего id', () => {
        const { ndb } = setup();
        try {
          assert.throws(
            () => deleteThoughtTypeView(ndb, randomUUID()),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'NOT_FOUND');
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });

      it('delete успешно удаляет существующий отбор', () => {
        const { ndb, typeId } = setup();
        try {
          const created = createThoughtTypeView(
            ndb,
            typeId,
            { name: 'Активные', definition: DEFINITION },
            USER,
          );
          deleteThoughtTypeView(ndb, created.id);
          assert.equal(getThoughtTypeView(ndb, created.id), null);
          assert.equal(listThoughtTypeViewsByType(ndb, typeId).length, 0);
        } finally {
          ndb.close();
        }
      });
    });

    describe('уникальность имени (требование 141c2576)', () => {
      it('create дубля в пределах того же типа → DUPLICATE с existing_id', () => {
        const { ndb, typeId } = setup();
        try {
          const first = createThoughtTypeView(
            ndb,
            typeId,
            { name: 'Активные', definition: DEFINITION },
            USER,
          );
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                typeId,
                { name: 'Активные', definition: DEFINITION },
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'DUPLICATE');
              const details = (err as EtnError).details as {
                existing_id: string;
                existing_name: string;
                field: string;
              };
              assert.equal(details.existing_id, first.id);
              assert.equal(details.existing_name, 'Активные');
              assert.equal(details.field, 'name');
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });

      it('регистр игнорируется: «Foo» и «foo» — дубль', () => {
        const { ndb, typeId } = setup();
        try {
          createThoughtTypeView(
            ndb,
            typeId,
            { name: 'Foo', definition: DEFINITION },
            USER,
          );
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                typeId,
                { name: 'foo', definition: DEFINITION },
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'DUPLICATE');
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });

      it('то же имя в ДРУГОМ типе — не дубль (уникальность в пределах своего типа)', () => {
        const { ndb } = setup();
        try {
          const a = createThoughtType(ndb, { name: 'task2' }, USER);
          const b = createThoughtType(ndb, { name: 'person' }, USER);
          createThoughtTypeView(ndb, a.id, { name: 'Все', definition: DEFINITION }, USER);
          // Тот же тип — дубль
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                a.id,
                { name: 'ВСЕ', definition: DEFINITION },
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'DUPLICATE');
              return true;
            },
          );
          // Другой тип — не дубль
          const ok = createThoughtTypeView(
            ndb,
            b.id,
            { name: 'Все', definition: DEFINITION },
            USER,
          );
          assert.ok(ok);
        } finally {
          ndb.close();
        }
      });

      it('переименование: name_key пересчитывается, старый name_key свободен', () => {
        const { ndb, typeId } = setup();
        try {
          const first = createThoughtTypeView(
            ndb,
            typeId,
            { name: 'Активные', definition: DEFINITION },
            USER,
          );
          // Переименовываем
          updateThoughtTypeView(
            ndb,
            first.id,
            { name: 'Горячие' },
            undefined,
            USER,
          );
          const renamed = getThoughtTypeView(ndb, first.id)!;
          assert.equal(renamed.name, 'Горячие');
          assert.equal(renamed.name_key, 'горячие');

          // Старый name_key теперь свободен: можно создать «Активные» заново
          const second = createThoughtTypeView(
            ndb,
            typeId,
            { name: 'Активные', definition: DEFINITION },
            USER,
          );
          assert.notEqual(second.id, first.id);

          // Переименование в то же имя (без изменения) — не ошибка
          updateThoughtTypeView(
            ndb,
            first.id,
            { name: 'Горячие' },
            undefined,
            USER,
          );

          // Переименование в уже занятое имя — DUPLICATE
          assert.throws(
            () =>
              updateThoughtTypeView(
                ndb,
                first.id,
                { name: 'Активные' }, // занято «second»
                undefined,
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'DUPLICATE');
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });
    });

    describe('валидация payload (422)', () => {
      it('имя: пустое после trim → VALIDATION_ERROR', () => {
        const { ndb, typeId } = setup();
        try {
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                typeId,
                { name: '   ', definition: DEFINITION },
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'VALIDATION_ERROR');
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });

      it(`имя: длиннее ${THOUGHT_TYPE_VIEW_NAME_MAX} символов → VALIDATION_ERROR`, () => {
        const { ndb, typeId } = setup();
        try {
          const long = 'x'.repeat(THOUGHT_TYPE_VIEW_NAME_MAX + 1);
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                typeId,
                { name: long, definition: DEFINITION },
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'VALIDATION_ERROR');
              const details = (err as EtnError).details as { field: string; limit: number };
              assert.equal(details.field, 'name');
              assert.equal(details.limit, THOUGHT_TYPE_VIEW_NAME_MAX);
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });

      it('definition: пустая строка → VALIDATION_ERROR', () => {
        const { ndb, typeId } = setup();
        try {
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                typeId,
                { name: 'X', definition: '' },
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'VALIDATION_ERROR');
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });

      it('definition: невалидный JSON → VALIDATION_ERROR', () => {
        const { ndb, typeId } = setup();
        try {
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                typeId,
                { name: 'X', definition: '{ not a json' },
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'VALIDATION_ERROR');
              const details = (err as EtnError).details as { field: string };
              assert.equal(details.field, 'definition');
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });

      it('definition: массив или null вместо объекта → VALIDATION_ERROR', () => {
        const { ndb, typeId } = setup();
        try {
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                typeId,
                { name: 'X', definition: '[1,2,3]' },
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'VALIDATION_ERROR');
              return true;
            },
          );
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                typeId,
                { name: 'Y', definition: 'null' },
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'VALIDATION_ERROR');
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });

      it('position: отрицательное или не-целое → VALIDATION_ERROR', () => {
        const { ndb, typeId } = setup();
        try {
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                typeId,
                { name: 'X', definition: DEFINITION, position: -1 },
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'VALIDATION_ERROR');
              return true;
            },
          );
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                typeId,
                { name: 'Y', definition: DEFINITION, position: 1.5 },
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'VALIDATION_ERROR');
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });

      it('create: неизвестный thoughtTypeId → NOT_FOUND', () => {
        const { ndb } = setup();
        try {
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                randomUUID(),
                { name: 'X', definition: DEFINITION },
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'NOT_FOUND');
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });
    });

    describe('is_default (требование 7263e565)', () => {
      it('create второго is_default=true снимает пометку с первого', () => {
        const { ndb, typeId } = setup();
        try {
          const first = createThoughtTypeView(
            ndb,
            typeId,
            { name: 'Активные', definition: DEFINITION, is_default: true },
            USER,
          );
          const second = createThoughtTypeView(
            ndb,
            typeId,
            { name: 'Все', definition: DEFINITION, is_default: true },
            USER,
          );
          assert.equal(getThoughtTypeView(ndb, first.id)!.is_default, false);
          assert.equal(getThoughtTypeView(ndb, second.id)!.is_default, true);

          // В списке по типу — не более одного is_default=true
          const list = listThoughtTypeViewsByType(ndb, typeId);
          assert.equal(list.filter((v) => v.is_default).length, 1);
        } finally {
          ndb.close();
        }
      });

      it('update с is_default=true снимает пометку с прежнего', () => {
        const { ndb, typeId } = setup();
        try {
          const first = createThoughtTypeView(
            ndb,
            typeId,
            { name: 'Активные', definition: DEFINITION, is_default: true },
            USER,
          );
          const second = createThoughtTypeView(
            ndb,
            typeId,
            { name: 'Все', definition: DEFINITION },
            USER,
          );
          updateThoughtTypeView(
            ndb,
            second.id,
            { is_default: true },
            undefined,
            USER,
          );
          assert.equal(getThoughtTypeView(ndb, first.id)!.is_default, false);
          assert.equal(getThoughtTypeView(ndb, second.id)!.is_default, true);

          const list = listThoughtTypeViewsByType(ndb, typeId);
          assert.equal(list.filter((v) => v.is_default).length, 1);
        } finally {
          ndb.close();
        }
      });

      it('update с is_default=true для того же отбора — без эффекта на других', () => {
        const { ndb, typeId } = setup();
        try {
          const first = createThoughtTypeView(
            ndb,
            typeId,
            { name: 'Активные', definition: DEFINITION, is_default: true },
            USER,
          );
          const second = createThoughtTypeView(
            ndb,
            typeId,
            { name: 'Все', definition: DEFINITION },
            USER,
          );
          updateThoughtTypeView(
            ndb,
            first.id,
            { is_default: true },
            undefined,
            USER,
          );
          assert.equal(getThoughtTypeView(ndb, first.id)!.is_default, true);
          assert.equal(getThoughtTypeView(ndb, second.id)!.is_default, false);
        } finally {
          ndb.close();
        }
      });
    });

    describe('запрет создания на корневом типе (требование 23e0f78e)', () => {
      it('create с thoughtTypeId === root.id → VALIDATION_ERROR', () => {
        const { ndb, rootId } = setup();
        try {
          assert.throws(
            () =>
              createThoughtTypeView(
                ndb,
                rootId,
                { name: 'Что-то', definition: DEFINITION },
                USER,
              ),
            (err: unknown) => {
              assert.ok(err instanceof EtnError);
              assert.equal((err as EtnError).code, 'VALIDATION_ERROR');
              return true;
            },
          );
        } finally {
          ndb.close();
        }
      });
    });

    describe('эффективный набор (требование eaca1253)', () => {
      /** Цепочка: корень → task → project. Возвращает id типа task и project. */
      function setupChain(): {
        ndb: NetworkDb;
        rootId: string;
        taskId: string;
        projectId: string;
      } {
        const ndb = createInMemoryNetworkDb();
        const root = getRootThoughtType(ndb)!;
        const task = createThoughtType(ndb, { name: 'task' }, USER);
        const project = createThoughtType(ndb, { name: 'project', parent_id: task.id }, USER);
        return { ndb, rootId: root.id, taskId: task.id, projectId: project.id };
      }

      it('мысль своего типа без отборов — пустой эффективный набор', () => {
        const { ndb, taskId } = setupChain();
        try {
          const thoughtId = seedThought(ndb, { title: 'A', type_id: taskId });
          const eff = getEffectiveViewsForThought(ndb, { type_id: taskId });
          assert.equal(eff.length, 0);

          // sanity: тот же код с мыслью без типа даёт тот же результат, если
          // у корневого типа тоже нет отборов
          const thought2 = seedThought(ndb, { title: 'B', type_id: null });
          assert.equal(getEffectiveViewsForThought(ndb, { type_id: null }).length, 0);
          assert.ok(thoughtId);
          assert.ok(thought2);
        } finally {
          ndb.close();
        }
      });

      it('мысль своего типа с одним отбором — только он, defined_on = свой тип', () => {
        const { ndb, taskId } = setupChain();
        try {
          seedThought(ndb, { title: 'A', type_id: taskId });
          createThoughtTypeView(
            ndb,
            taskId,
            { name: 'Активные', definition: DEFINITION, position: 0 },
            USER,
          );
          const eff = getEffectiveViewsForThought(ndb, { type_id: taskId });
          assert.equal(eff.length, 1);
          assert.equal(eff[0]!.name, 'Активные');
          assert.equal(eff[0]!.defined_on, taskId);
          assert.equal(eff[0]!.inherited, false);
        } finally {
          ndb.close();
        }
      });

      it('мысль типа-потомка: свои + унаследованные от предков', () => {
        const { ndb, taskId, projectId } = setupChain();
        try {
          seedThought(ndb, { title: 'P', type_id: projectId });
          createThoughtTypeView(
            ndb,
            taskId,
            { name: 'Активные', definition: DEFINITION, position: 0 },
            USER,
          );
          createThoughtTypeView(
            ndb,
            projectId,
            { name: 'Срочные', definition: DEFINITION, position: 0 },
            USER,
          );
          const eff = getEffectiveViewsForThought(ndb, { type_id: projectId });
          // От корня к типу мысли: Активные (предок) → Срочные (свой).
          assert.deepEqual(
            eff.map((v) => v.name),
            ['Активные', 'Срочные'],
          );
          assert.equal(eff[0]!.inherited, true);
          assert.equal(eff[0]!.defined_on, taskId);
          assert.equal(eff[1]!.inherited, false);
          assert.equal(eff[1]!.defined_on, projectId);
        } finally {
          ndb.close();
        }
      });

      it('перекрытие: потомок с тем же name_key перекрывает предка целиком', () => {
        const { ndb, taskId, projectId } = setupChain();
        try {
          seedThought(ndb, { title: 'P', type_id: projectId });
          createThoughtTypeView(
            ndb,
            taskId,
            {
              name: 'Активные',
              description: 'предок',
              definition: DEFINITION,
              position: 0,
            },
            USER,
          );
          createThoughtTypeView(
            ndb,
            projectId,
            {
              name: 'АКТИВНЫЕ', // тот же name_key после lower
              description: 'потомок',
              definition: DEFINITION,
              position: 5,
            },
            USER,
          );
          const eff = getEffectiveViewsForThought(ndb, { type_id: projectId });
          assert.equal(eff.length, 1, 'одноимённый предка перекрыт');
          assert.equal(eff[0]!.name, 'АКТИВНЫЕ', 'виден потомок (а не предок)');
          assert.equal(eff[0]!.description, 'потомок', 'определение перекрыто целиком');
          assert.equal(eff[0]!.defined_on, projectId);
          assert.equal(eff[0]!.inherited, false);
          assert.equal(eff[0]!.position, 5);
        } finally {
          ndb.close();
        }
      });

      it('порядок: от корня к типу мысли, внутри уровня по position', () => {
        const { ndb, taskId, projectId } = setupChain();
        try {
          seedThought(ndb, { title: 'P', type_id: projectId });
          // Предок: 2 отбора, position 5 и 0
          createThoughtTypeView(
            ndb,
            taskId,
            { name: 'T2', definition: DEFINITION, position: 5 },
            USER,
          );
          createThoughtTypeView(
            ndb,
            taskId,
            { name: 'T1', definition: DEFINITION, position: 0 },
            USER,
          );
          // Свой: 2 отбора, position 1 и 0
          createThoughtTypeView(
            ndb,
            projectId,
            { name: 'P2', definition: DEFINITION, position: 1 },
            USER,
          );
          createThoughtTypeView(
            ndb,
            projectId,
            { name: 'P1', definition: DEFINITION, position: 0 },
            USER,
          );
          const eff = getEffectiveViewsForThought(ndb, { type_id: projectId });
          assert.deepEqual(
            eff.map((v) => v.name),
            ['T1', 'T2', 'P1', 'P2'],
          );
        } finally {
          ndb.close();
        }
      });

      it('наследование is_default: своего нет — берётся ближайший у предка', () => {
        const { ndb, taskId, projectId } = setupChain();
        try {
          seedThought(ndb, { title: 'P', type_id: projectId });
          // Предок помечен по умолчанию
          createThoughtTypeView(
            ndb,
            taskId,
            { name: 'ИзПредка', definition: DEFINITION, is_default: true },
            USER,
          );
          // Свой — без пометки
          createThoughtTypeView(
            ndb,
            projectId,
            { name: 'ИзПотомка', definition: DEFINITION },
            USER,
          );
          const eff = getEffectiveViewsForThought(ndb, { type_id: projectId });
          const def = eff.find((v) => v.is_default);
          assert.ok(def, 'is_default пришёл из предка');
          assert.equal(def!.name, 'ИзПредка');
          assert.equal(def!.defined_on, taskId);
        } finally {
          ndb.close();
        }
      });

      it('свой is_default отменяет унаследованный', () => {
        const { ndb, taskId, projectId } = setupChain();
        try {
          seedThought(ndb, { title: 'P', type_id: projectId });
          createThoughtTypeView(
            ndb,
            taskId,
            { name: 'ИзПредка', definition: DEFINITION, is_default: true },
            USER,
          );
          createThoughtTypeView(
            ndb,
            projectId,
            { name: 'ИзПотомка', definition: DEFINITION, is_default: true },
            USER,
          );
          const eff = getEffectiveViewsForThought(ndb, { type_id: projectId });
          const def = eff.find((v) => v.is_default);
          assert.ok(def);
          assert.equal(def!.name, 'ИзПотомка', 'свой is_default побеждает');
        } finally {
          ndb.close();
        }
      });

      it('мысль без типа: набор корневого типа (требование 23e0f78e)', () => {
        const { ndb, rootId } = setupChain();
        try {
          seedThought(ndb, { title: 'Untyped', type_id: null });
          // Отбор на корневом типе
          ndb
            .prepare(
              `INSERT INTO thought_type_views (id, layer_id, thought_type_id, name, name_key,
                                                definition, position, is_default,
                                                version, created_at, updated_at, created_by)
               VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', ?, 'ОтКорня',
                       'откорня', ?, 0, 1, 1,
                       '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', ?)`,
            )
            .run(randomUUID(), rootId, DEFINITION, USER);
          const eff = getEffectiveViewsForThought(ndb, { type_id: null });
          assert.equal(eff.length, 1);
          assert.equal(eff[0]!.name, 'ОтКорня');
          assert.equal(eff[0]!.defined_on, rootId);
          assert.equal(eff[0]!.is_default, true);
        } finally {
          ndb.close();
        }
      });
    });
  },
);
