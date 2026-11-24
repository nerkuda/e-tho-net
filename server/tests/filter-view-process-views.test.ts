/**
 * Отборы поддержки процесса на движке AST — задача 2dd47944 («Улучшения
 * движка отборов»), DoD: «Ждут верификатора» и «Ждут заказчика» объединяются в
 * ОДИН отбор на все виды работ, «Согласованные без предполёта» и «Сценарии без
 * покрытия задачами» создаются и работают.
 *
 * Три конструкции задачи проверяются СКВОЗЬ отбор типа мысли (создание через
 * `createThoughtTypeView` + исполнение через `runViewForThought`) — это и есть
 * путь боевых отборов, а не только внутренний движок:
 *   1. **OR по свойствам** — `or`-группа по статусам разных видов работ: один
 *      отбор типа-родителя наследуется видами и находит работы каждого вида
 *      (раньше нужен был отдельный отбор на вид);
 *   2. **Негативный link-фильтр** — лист `link_type` с `not_in`: «у мысли НЕТ
 *      связи указанного типа» («сценарии без покрытия задачами»);
 *   3. **`is_empty`/`not_empty` для bool** — «отметки нет» отличается от
 *      отметки «нет» (`eq false`); см. `filter-ast-bool-presence.test.ts`.
 *
 * Сторож `guard-guide-filter-operators` держит паритет этих наборов с
 * `etn.guide { topic: "thoughts.query" }` и реестром профилей.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { FILTER_AST_VERSION, type FilterAst, type FilterAstNode } from '@etn/shared';

import type { NetworkDb } from '../src/db/network-db.js';
import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import { createLinkType } from '../src/domain/link-type-service.js';
import { createTypeProperty } from '../src/domain/property-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import {
  createThoughtTypeView,
  getEffectiveViewsForThought,
  runViewForThought,
} from '../src/domain/thought-type-views-service.js';

const USER = 'user-1';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function seedThought(ndb: NetworkDb, title: string, typeId: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase(), typeId);
  return id;
}

function seedTextValue(ndb: NetworkDb, thoughtId: string, propertyId: string, value: string): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_text, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

function seedBoolValue(
  ndb: NetworkDb,
  thoughtId: string,
  propertyId: string,
  value: boolean,
): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_bool, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value ? 1 : 0);
}

function seedLink(ndb: NetworkDb, sourceId: string, targetId: string, linkTypeId: string): void {
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(randomUUID(), sourceId, targetId, linkTypeId);
}

function leaf(entity: Record<string, unknown>, operator: string, value?: unknown): FilterAstNode {
  return (
    value === undefined ? { entity, operator } : { entity, operator, value }
  ) as FilterAstNode;
}

function ast(filter: FilterAstNode): FilterAst {
  return { version: FILTER_AST_VERSION, filter };
}

/** Исполнить отбор и вернуть отсортированные заголовки (сортировка — в JS). */
async function runView(
  ndb: NetworkDb,
  view: Parameters<typeof runViewForThought>[1],
  anchorId: string,
): Promise<string[]> {
  const result = await runViewForThought(ndb, view, anchorId, USER);
  return result.items.map((i) => i.title).sort();
}

describe(
  'отборы процесса на AST: OR по свойствам, негативная связь, bool (2dd47944)',
  { skip: !nativeAvailable() },
  () => {
    it('один отбор на все виды работ: OR по статусам видов наследуется подтипами', async () => {
      const ndb = createInMemoryNetworkDb();
      try {
        // Виды работ — подтипы «работы»: один отбор на родителе видят все виды.
        const work = createThoughtType(ndb, { name: 'работа' }, USER);
        const taskKind = createThoughtType(
          ndb,
          { name: 'задача разработки', parent_id: work.id },
          USER,
        );
        const errorKind = createThoughtType(ndb, { name: 'ошибка', parent_id: work.id }, USER);
        const statusTask = createTypeProperty(
          ndb,
          'thought_type',
          taskKind.id,
          { key: 'Статус задачи разработки', value_type: 'text' },
          USER,
        );
        const statusError = createTypeProperty(
          ndb,
          'thought_type',
          errorKind.id,
          { key: 'Статус ошибки', value_type: 'text' },
          USER,
        );

        const taskVerifying = seedThought(ndb, 'Задача на верификации', taskKind.id);
        seedTextValue(ndb, taskVerifying, statusTask.property_id, 'тестируется');
        const errorVerifying = seedThought(ndb, 'Ошибка на верификации', errorKind.id);
        seedTextValue(ndb, errorVerifying, statusError.property_id, 'тестируется');
        const taskSigned = seedThought(ndb, 'Задача согласована', taskKind.id);
        seedTextValue(ndb, taskSigned, statusTask.property_id, 'согласована');
        const errorFixed = seedThought(ndb, 'Ошибка исправлена', errorKind.id);
        seedTextValue(ndb, errorFixed, statusError.property_id, 'исправлена');

        const view = createThoughtTypeView(
          ndb,
          work.id,
          {
            name: 'Ждут верификатора',
            definition: JSON.stringify(
              ast({
                op: 'and',
                children: [
                  leaf({ kind: 'type' }, 'in_hierarchy', [work.id]),
                  {
                    op: 'or',
                    children: [
                      leaf(
                        { kind: 'property', property_id: statusTask.property_id },
                        'eq',
                        'тестируется',
                      ),
                      leaf(
                        { kind: 'property', property_id: statusError.property_id },
                        'eq',
                        'тестируется',
                      ),
                    ],
                  },
                ],
              }),
            ),
          },
          USER,
        );

        assert.deepEqual(
          await runView(ndb, view, taskSigned),
          ['Задача на верификации', 'Ошибка на верификации'],
          'OR по статусам двух видов работ в ОДНОМ отборе',
        );

        // Отбор родительского типа входит в эффективный набор подтипа (наследован).
        const effective = getEffectiveViewsForThought(ndb, { type_id: errorKind.id });
        const inherited = effective.find((v) => v.name === 'Ждут верификатора');
        assert.ok(inherited !== undefined, 'отбор «работа» виден виду-подтипу');
        assert.equal(inherited.defined_on, work.id);
        assert.equal(inherited.inherited, true);
      } finally {
        ndb.close();
      }
    });

    it('«Сценарии без покрытия задачами»: link_type not_in — у мысли НЕТ связи типа', async () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const scenarioKind = createThoughtType(ndb, { name: 'сценарий' }, USER);
        const taskKind = createThoughtType(ndb, { name: 'задача разработки' }, USER);
        const coverage = createLinkType(
          ndb,
          { name_forward: 'проверяет сценарии', name_reverse: 'проверяется задачами' },
          USER,
        );

        const covered = seedThought(ndb, 'Покрытый сценарий', scenarioKind.id);
        // Непокрытый сценарий нужен только как ожидаемая выдача отбора.
        seedThought(ndb, 'Непокрытый сценарий', scenarioKind.id);
        const task = seedThought(ndb, 'Задача, покрывающая сценарий', taskKind.id);
        seedLink(ndb, task, covered, coverage.id);

        const view = createThoughtTypeView(
          ndb,
          scenarioKind.id,
          {
            name: 'Сценарии без покрытия',
            definition: JSON.stringify(
              ast({
                op: 'and',
                children: [
                  leaf({ kind: 'type' }, 'in_hierarchy', [scenarioKind.id]),
                  leaf({ kind: 'link_type' }, 'not_in', [coverage.id]),
                ],
              }),
            ),
          },
          USER,
        );

        assert.deepEqual(
          await runView(ndb, view, covered),
          ['Непокрытый сценарий'],
          'отбор возвращает только сценарии без связи «проверяет сценарии»',
        );
      } finally {
        ndb.close();
      }
    });

    it('«Согласованные без отметки предполёта»: is_empty по bool — «нет отметки» ≠ «отметка нет»', async () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const taskKind = createThoughtType(ndb, { name: 'задача разработки' }, USER);
        const status = createTypeProperty(
          ndb,
          'thought_type',
          taskKind.id,
          { key: 'Статус задачи разработки', value_type: 'text' },
          USER,
        );
        const preflight = createTypeProperty(
          ndb,
          'thought_type',
          taskKind.id,
          { key: 'Предполёт выполнен', value_type: 'bool' },
          USER,
        );

        const withoutMarker = seedThought(ndb, 'Согласована без отметки', taskKind.id);
        seedTextValue(ndb, withoutMarker, status.property_id, 'согласована');
        const markedYes = seedThought(ndb, 'Согласована, предполёт был', taskKind.id);
        seedTextValue(ndb, markedYes, status.property_id, 'согласована');
        seedBoolValue(ndb, markedYes, preflight.property_id, true);
        // Отметка «нет» (false) — это ЗНАЧЕНИЕ: отбор «без отметки» её не берёт.
        const markedNo = seedThought(ndb, 'Согласована, предполёт отмечен «нет»', taskKind.id);
        seedTextValue(ndb, markedNo, status.property_id, 'согласована');
        seedBoolValue(ndb, markedNo, preflight.property_id, false);

        const view = createThoughtTypeView(
          ndb,
          taskKind.id,
          {
            name: 'Согласованные без предполёта',
            definition: JSON.stringify(
              ast({
                op: 'and',
                children: [
                  leaf({ kind: 'type' }, 'in_hierarchy', [taskKind.id]),
                  leaf({ kind: 'property', property_id: status.property_id }, 'eq', 'согласована'),
                  leaf({ kind: 'property', property_id: preflight.property_id }, 'is_empty'),
                ],
              }),
            ),
          },
          USER,
        );

        assert.deepEqual(
          await runView(ndb, view, markedYes),
          ['Согласована без отметки'],
          'bool «не заполнено» — только мысль без строки значения (false исключён)',
        );
      } finally {
        ndb.close();
      }
    });
  },
);
