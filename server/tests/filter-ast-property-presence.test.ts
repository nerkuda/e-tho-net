/**
 * «Заполнено»/«не заполнено» для свойств видов `cross_network_ref`
 * («кросс-сетевая ссылка») и `publication` («публикация») — ошибка 0e976df4,
 * класс ошибки a6866689.
 *
 * Контракт (спека 489c394f): значение этих видов — необязательная ссылка,
 * поэтому у неё есть наличие:
 *   * `not_empty` («заполнено») — адрес/id задан;
 *   * `is_empty` («не заполнено») — значение не задано (нет строки значения
 *     либо колонка пуста).
 *
 * До исправления оба гейта — реестр профилей (`PROPERTY_OPERATOR_SETS`,
 * `shared/src/filter-profiles.ts`) и серверный гейт плоской формы
 * (`OPS_BY_VALUE_TYPE`, `server/src/domain/query-service.ts`) — не содержали
 * пары, хотя общий исполнитель `propertyClauses` её умеет. Тест закрывает обе
 * формы входа: AST-лист и плоское условие `properties[]` (они проходят разные
 * гейты), а также одиночное и множественное (`config.multiple`) значение.
 *
 * Мутационная проба (проверена при сдаче): снятие пары из
 * `OPS_BY_VALUE_TYPE` красит группу «плоская форма»; снятие из
 * `PROPERTY_OPERATOR_SETS` после пересборки `@etn/shared` красит AST-группу и
 * сторож `guard-guide-filter-operators`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { FILTER_AST_VERSION, type FilterAst, type FilterAstNode } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import {
  queryThoughts,
  type ThoughtQueryRequest as CanonicalQueryRequest,
} from '../src/domain/query-service.js';

const BASE_LAYER = '00000000-0000-4000-8000-0000000000ba5e';
const USER = 'u';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function seedThought(ndb: NetworkDb, title: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 0, 0, 1, '2024-01-01T00:00:00.000Z', 'u', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase());
  return id;
}

function seedProperty(
  ndb: NetworkDb,
  name: string,
  valueType: 'cross_network_ref' | 'publication',
  config: Record<string, unknown> | null = null,
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description,
                               created_at, updated_at)
       VALUES (?, ?, ?, lower(?), ?, ?, NULL, '2024', '2024')`,
    )
    .run(id, BASE_LAYER, name, name, valueType, config === null ? null : JSON.stringify(config));
  return id;
}

/** Значение вида `cross_network_ref`/`publication` лежит в `value_text`. */
function seedValue(ndb: NetworkDb, thoughtId: string, propertyId: string, raw: string): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_text, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, raw);
}

/** Корень AST из узла (версия подставляется автоматически). */
function ast(filter: FilterAstNode): FilterAst {
  return { version: FILTER_AST_VERSION, filter };
}

/** Лист-условие по свойству (без labels). */
function propertyLeaf(
  propertyId: string,
  operator: string,
  value?: unknown,
): FilterAstNode {
  const entity = { kind: 'property', property_id: propertyId };
  return (value === undefined ? { entity, operator } : { entity, operator, value }) as FilterAstNode;
}

/** Прогнать AST через единый исполнитель и вернуть отсортированные заголовки. */
function runAst(ndb: NetworkDb, tree: FilterAst): string[] {
  const req: CanonicalQueryRequest = { sort: 'alpha', order: 'asc', limit: 200, offset: 0, ast: tree };
  return queryThoughts(ndb, USER, req, { emptyFilterMode: 'all', maxLimit: 200 })
    .items.map((i) => i.title)
    .sort();
}

/** Плоская форма §6.10 (свой гейт `OPS_BY_VALUE_TYPE`). */
function runFlat(ndb: NetworkDb, propertyId: string, operator: 'is_empty' | 'not_empty'): string[] {
  const req: CanonicalQueryRequest = {
    sort: 'alpha',
    order: 'asc',
    limit: 200,
    offset: 0,
    properties: [{ property_id: propertyId, operator, value: '' }],
  };
  return queryThoughts(ndb, USER, req, { emptyFilterMode: 'all', maxLimit: 200 })
    .items.map((i) => i.title)
    .sort();
}

interface PresenceFixture {
  ndb: NetworkDb;
  propertyId: string;
  /** Мысли: с заполненным значением и без него. */
  filled: string;
  empty: string;
}

/** Одиночное (`config.multiple` не задан) свойство каждого вида. */
function buildSingleFixture(valueType: 'cross_network_ref' | 'publication'): PresenceFixture {
  const ndb = createInMemoryNetworkDb();
  const propertyId = seedProperty(ndb, `Ссылка ${valueType}`, valueType);
  const filled = seedThought(ndb, 'filled');
  const empty = seedThought(ndb, 'empty');
  seedValue(ndb, filled, propertyId, valueType === 'publication' ? 'pub-1' : 'n:net#thought');
  return { ndb, propertyId, filled, empty };
}

/** Множественное (`config.multiple: true`) свойство: значение — JSON-массив. */
function buildMultipleFixture(valueType: 'cross_network_ref' | 'publication'): PresenceFixture {
  const ndb = createInMemoryNetworkDb();
  const propertyId = seedProperty(ndb, `Ссылки ${valueType}`, valueType, { multiple: true });
  const filled = seedThought(ndb, 'filled');
  const empty = seedThought(ndb, 'empty');
  const raw =
    valueType === 'publication'
      ? JSON.stringify(['pub-1', 'pub-2'])
      : JSON.stringify(['n:net#one', 'n:net#two']);
  seedValue(ndb, filled, propertyId, raw);
  return { ndb, propertyId, filled, empty };
}

describe(
  '«Заполнено»/«не заполнено» по свойствам cross_network_ref/publication (0e976df4)',
  { skip: !nativeAvailable() },
  () => {
    for (const valueType of ['cross_network_ref', 'publication'] as const) {
      it(`${valueType} (single): AST — is_empty/not_empty по наличию значения`, () => {
        const f = buildSingleFixture(valueType);
        try {
          assert.deepEqual(
            runAst(f.ndb, ast(propertyLeaf(f.propertyId, 'not_empty'))),
            ['filled'],
            `${valueType}: «заполнено» — только мысль со значением`,
          );
          assert.deepEqual(
            runAst(f.ndb, ast(propertyLeaf(f.propertyId, 'is_empty'))),
            ['empty'],
            `${valueType}: «не заполнено» — только мысль без значения`,
          );
          // Значение для операторов наличия не читается (переданное игнорируется).
          assert.deepEqual(
            runAst(f.ndb, ast(propertyLeaf(f.propertyId, 'is_empty', 'ignored'))),
            ['empty'],
            `${valueType}: значение пары заполненности на клаузу не влияет`,
          );
          // Комбинация в группе: «И» — сужение, «НЕ» — инверсия набора.
          assert.deepEqual(
            runAst(
              f.ndb,
              ast({
                op: 'not',
                children: [propertyLeaf(f.propertyId, 'is_empty')],
              }),
            ),
            ['filled'],
            `${valueType}: НЕ «не заполнено» = «заполнено» на тех же данных`,
          );
        } finally {
          f.ndb.close();
        }
      });

      it(`${valueType} (single): плоская форма — гейт OPS_BY_VALUE_TYPE открыт`, () => {
        const f = buildSingleFixture(valueType);
        try {
          assert.deepEqual(runFlat(f.ndb, f.propertyId, 'not_empty'), ['filled']);
          assert.deepEqual(runFlat(f.ndb, f.propertyId, 'is_empty'), ['empty']);
        } finally {
          f.ndb.close();
        }
      });

      it(`${valueType} (multiple): AST — «количество = 0 / > 0»`, () => {
        const f = buildMultipleFixture(valueType);
        try {
          assert.deepEqual(
            runAst(f.ndb, ast(propertyLeaf(f.propertyId, 'not_empty'))),
            ['filled'],
            `${valueType} (multiple): «заполнено» — непустой набор`,
          );
          assert.deepEqual(
            runAst(f.ndb, ast(propertyLeaf(f.propertyId, 'is_empty'))),
            ['empty'],
            `${valueType} (multiple): «не заполнено» — значения нет`,
          );
        } finally {
          f.ndb.close();
        }
      });

      it(`${valueType} (multiple): плоская форма — наличие по строке значения`, () => {
        const f = buildMultipleFixture(valueType);
        try {
          assert.deepEqual(runFlat(f.ndb, f.propertyId, 'not_empty'), ['filled']);
          assert.deepEqual(runFlat(f.ndb, f.propertyId, 'is_empty'), ['empty']);
        } finally {
          f.ndb.close();
        }
      });
    }
  },
);
