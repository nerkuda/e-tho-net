/**
 * Регрессия d4802371 «Ошибка удаления группы типов» (версия 0.16.1).
 *
 * До фикса `deleteThoughtType` жёстко отвергал тип с дочерними типами даже при
 * `force=1`, поэтому клиент получал 422 и общее «проверьте введённые данные».
 * Теперь:
 *   * без `force` тип с детьми отвергается (`details.children`), ничего не
 *     меняется;
 *   * с `force` удаляется ВСЁ поддерево, дети раньше родителя, и для каждого
 *     типа работает прежняя семантика: мысли теряют `type_id`, привязки и
 *     overrides типа удаляются, собственные отборы каскадятся;
 *   * роль сети на ЛЮБОМ типе поддерева отвергает каскад (MCP-путь —
 *     `deleteOntologyEntity` с `networkRoles`);
 *   * в рабочем слое появляются надгробия на все типы поддерева, основа цела.
 *
 * Skip при отсутствии нативной сборки `better-sqlite3` — как у соседних
 * unit-тестов серверного домена.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID, EtnError } from '@etn/shared';

import type { NetworkDb } from '../src/db/network-db.js';
import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import { deleteOntologyEntity } from '../src/domain/ontology-delete-service.js';
import {
  createTypeProperty,
  setTypePropertyDefaultOverride,
} from '../src/domain/property-service.js';
import { getThought } from '../src/domain/thought-service.js';
import { deleteThoughtTypeWithViews } from '../src/domain/thought-type-delete-service.js';
import {
  createThoughtType,
  deleteThoughtType,
  getRootThoughtType,
  getThoughtType,
  listThoughtTypes,
} from '../src/domain/thought-type-service.js';
import { createThoughtTypeView } from '../src/domain/thought-type-views-service.js';

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
const NETWORK = 'net-1';
/** Слой A — дочерний к основе (для проверки надгробий). */
const LAYER_A = '11111111-1111-4111-8111-111111111111';
const VIEW_DEFINITION = '{"keywords":"alpha","sort":"title","order":"asc"}';

/** Insert a thought row directly — обходит thought-service для краткости тестов. */
function seedThought(ndb: NetworkDb, typeId: string | null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 0, 1,
               '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, 'Seed', 'seed', typeId);
  return id;
}

/** Положить в БД слой A (дочерний к основе). */
function insertLayer(ndb: NetworkDb): void {
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO layers (id, parent_id, title, is_base, depth, created_by, created_at, last_activity_at)
       VALUES (?, ?, 'Слой A', 0, 1, 'u', ?, ?)`,
    )
    .run(LAYER_A, BASE_LAYER_ID, now, now);
}

/** Тип A → ребёнок B → внук C; корень сети — отдельно. */
function seedChain(ndb: NetworkDb): {
  rootId: string;
  a: ReturnType<typeof createThoughtType>;
  b: ReturnType<typeof createThoughtType>;
  c: ReturnType<typeof createThoughtType>;
} {
  const root = getRootThoughtType(ndb);
  assert.ok(root, 'корневой тип должен существовать после миграций');
  const a = createThoughtType(ndb, { name: 'A' }, USER);
  const b = createThoughtType(ndb, { name: 'B', parent_id: a.id }, USER);
  const c = createThoughtType(ndb, { name: 'C', parent_id: b.id }, USER);
  return { rootId: root.id, a, b, c };
}

/** Число физических строк по id (без слоевых представлений). */
function physicalCount(ndb: NetworkDb, table: string, where: string, ...args: unknown[]): number {
  return (
    ndb.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...args) as { c: number }
  ).c;
}

describe(
  'deleteThoughtType: каскад поддерева (задача d4802371)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('force=1 удаляет всё поддерево: мысли без типа, привязки/overrides/отборы удалены, корень цел', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { rootId, a, b, c } = seedChain(ndb);
        const thoughtA = seedThought(ndb, a.id);
        const thoughtB = seedThought(ndb, b.id);
        const thoughtC = seedThought(ndb, c.id);
        // Привязка свойства у ребёнка и override внука (наследуемое свойство
        // объявлено на корне), собственный отбор внука.
        const rootProp = createTypeProperty(
          ndb,
          'thought_type',
          rootId,
          { key: 'заметка', value_type: 'text' },
          USER,
        );
        createTypeProperty(ndb, 'thought_type', b.id, { key: 'уровень', value_type: 'text' }, USER);
        setTypePropertyDefaultOverride(ndb, 'thought_type', c.id, rootProp.id, 'своё', USER);
        const view = createThoughtTypeView(
          ndb,
          c.id,
          { name: 'Отбор внука', definition: VIEW_DEFINITION },
          USER,
        );

        const result = deleteThoughtTypeWithViews(ndb, a.id, undefined, { force: true });

        // Снапшоты — на каждый тип поддерева, запрошенный первым (preorder).
        assert.deepEqual(
          result.types.map((t) => t.id),
          [a.id, b.id, c.id],
        );
        assert.deepEqual(
          result.views.map((v) => v.id),
          [view.id],
        );

        for (const id of [a.id, b.id, c.id]) {
          assert.equal(getThoughtType(ndb, id), null, `тип ${id} удалён`);
        }
        assert.deepEqual(
          listThoughtTypes(ndb).map((t) => t.id),
          [rootId],
          'в каталоге остался только корень',
        );
        assert.notEqual(getThoughtType(ndb, rootId), null, 'корень не тронут');

        // Мысли не удалены — они стали без типа (для всех трёх типов).
        for (const thoughtId of [thoughtA, thoughtB, thoughtC]) {
          assert.equal(
            (
              ndb.prepare('SELECT type_id FROM thoughts WHERE id = ?').get(thoughtId) as {
                type_id: string | null;
              }
            ).type_id,
            null,
            'мысль потеряла type_id',
          );
        }

        // Привязки каждого типа поддерева и собственный override внука ушли.
        for (const id of [a.id, b.id, c.id]) {
          assert.equal(
            physicalCount(
              ndb,
              'type_properties',
              "owner_type = 'thought_type' AND owner_id = ?",
              id,
            ),
            0,
            `привязки типа ${id} удалены`,
          );
        }
        assert.equal(
          physicalCount(ndb, 'type_property_overrides', 'type_id = ?', c.id),
          0,
          'override внука удалён',
        );
        assert.equal(
          physicalCount(ndb, 'thought_type_views', 'thought_type_id = ?', c.id),
          0,
          'отбор внука удалён каскадом',
        );
      } finally {
        ndb.close();
      }
    });

    it('без force тип с детьми отвергается с details.children и ничего не меняется', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { rootId, a, b, c } = seedChain(ndb);
        const thought = seedThought(ndb, c.id);
        const before = listThoughtTypes(ndb)
          .map((t) => t.id)
          .sort();

        assert.throws(
          () => deleteThoughtType(ndb, a.id, undefined),
          (e: unknown) =>
            e instanceof EtnError &&
            e.code === 'VALIDATION_ERROR' &&
            (e.details as { children?: number }).children === 2,
          'без force поддерево не удаляется',
        );

        assert.deepEqual(
          listThoughtTypes(ndb)
            .map((t) => t.id)
            .sort(),
          before,
          'каталог не изменился',
        );
        assert.notEqual(getThoughtType(ndb, b.id), null);
        assert.notEqual(getThoughtType(ndb, c.id), null);
        assert.notEqual(getThoughtType(ndb, rootId), null);
        assert.equal(
          (
            ndb.prepare('SELECT type_id FROM thoughts WHERE id = ?').get(thought) as {
              type_id: string | null;
            }
          ).type_id,
          c.id,
          'мысль сохранила тип',
        );
      } finally {
        ndb.close();
      }
    });

    it('роль сети на дочернем типе отвергает каскад (MCP-путь), затем force удаляет и считает поддерево', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const { a, b, c } = seedChain(ndb);
        seedThought(ndb, a.id);
        seedThought(ndb, c.id);
        const before = listThoughtTypes(ndb)
          .map((t) => t.id)
          .sort();

        // Роль `structural` занята ВНУКОМ, а удаляется корень поддерева.
        assert.throws(
          () =>
            deleteOntologyEntity(
              ndb,
              { network_id: NETWORK, kind: 'thought_type', id: a.id, force: true },
              USER,
              { structural: c.id },
            ),
          (e: unknown) =>
            e instanceof EtnError &&
            e.code === 'VALIDATION_ERROR' &&
            (e.details as { role?: string }).role === 'structural' &&
            (e.details as { id?: string }).id === c.id,
          'роль дочернего типа проверяется',
        );
        assert.deepEqual(
          listThoughtTypes(ndb)
            .map((t) => t.id)
            .sort(),
          before,
          'транзакция откатилась: ничего не удалено',
        );

        // Роль свободна — каскад проходит, счётчики описывают поддерево.
        const result = deleteOntologyEntity(
          ndb,
          { network_id: NETWORK, kind: 'thought_type', id: a.id, force: true },
          USER,
          {},
        );
        assert.equal(result.deleted, true);
        assert.equal(result.affected_counts.children_count, 2);
        assert.equal(result.affected_counts.cascade_types_count, 3);
        assert.equal(result.affected_counts.thoughts_count, 2, 'мысли всех типов поддерева');
        for (const id of [a.id, b.id, c.id]) {
          assert.equal(getThoughtType(ndb, id), null, `тип ${id} удалён каскадом`);
        }
      } finally {
        ndb.close();
      }
    });

    it('в рабочем слое force ставит надгробия на все типы поддерева, основа цела', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        insertLayer(ndb);
        const { a, b, c } = seedChain(ndb);
        const thought = seedThought(ndb, c.id);

        ndb.useLayer(LAYER_A);
        deleteThoughtType(ndb, a.id, undefined, { force: true });

        // В слое типов и их мыслей уже нет; мысль видна без типа.
        for (const id of [a.id, b.id, c.id]) {
          assert.equal(getThoughtType(ndb, id), null, `тип ${id} скрыт в слое`);
        }
        assert.equal(getThought(ndb, thought)?.type_id, null, 'в слое мысль без типа');

        // Физически: основа не тронута, в слое — надгробия на каждый тип.
        for (const id of [a.id, b.id, c.id]) {
          assert.equal(
            (
              ndb
                .prepare('SELECT deleted FROM thought_types WHERE id = ? AND layer_id = ?')
                .get(id, BASE_LAYER_ID) as { deleted: number } | undefined
            )?.deleted,
            0,
            `строка основы типа ${id} цела`,
          );
          assert.equal(
            (
              ndb
                .prepare('SELECT deleted FROM thought_types WHERE id = ? AND layer_id = ?')
                .get(id, LAYER_A) as { deleted: number } | undefined
            )?.deleted,
            1,
            `надгробие типа ${id} в слое`,
          );
        }
        assert.equal(
          (
            ndb
              .prepare('SELECT type_id FROM thoughts WHERE id = ? AND layer_id = ?')
              .get(thought, BASE_LAYER_ID) as { type_id: string | null }
          ).type_id,
          c.id,
          'строка мысли в основе не изменилась',
        );

        ndb.useLayer(BASE_LAYER_ID);
        for (const id of [a.id, b.id, c.id]) {
          assert.notEqual(getThoughtType(ndb, id), null, `в основе тип ${id} на месте`);
        }
      } finally {
        ndb.close();
      }
    });
  },
);
