/**
 * «Заполнено»/«не заполнено» для `bool`-свойства — задача 2dd47944
 * («Улучшения движка отборов»), класс ошибки a6866689/0e976df4.
 *
 * Контракт: `false` — это ЗНАЧЕНИЕ, а не «пусто». «Значения нет» выражается
 * отдельной парой `is_empty`/`not_empty` («не заполнено»/«заполнено»), потому
 * что `eq false` («равно нет») не отличает мысль с отметкой «нет» от мысли без
 * отметки вовсе — ровно на этом рассыпался отбор «Согласованные без отметки
 * предполёта» (карточка задачи).
 *
 * До исправления оба гейта — реестр профилей (`PROPERTY_OPERATOR_SETS`,
 * `shared/src/filter-profiles.ts`) и серверный гейт плоской формы
 * (`OPS_BY_VALUE_TYPE`, `server/src/domain/query-service.ts`) — запрещали пару
 * для `bool`, хотя общий исполнитель `propertyClauses` её умел: наличие
 * значения решает строка `property_values` (`value_bool` не NULL), и `false`
 * (0) проходит так же, как `true` (1).
 *
 * Тест закрывает обе формы входа — AST-лист и плоское условие `properties[]`:
 * они проходят разные гейты. Мутационные пробы (проверены при сдаче): снятие
 * пары из `OPS_BY_VALUE_TYPE` красит группы «плоская форма» и AST; снятие из
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

function seedProperty(ndb: NetworkDb, name: string, valueType: 'bool' | 'number'): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description,
                               created_at, updated_at)
       VALUES (?, ?, ?, lower(?), ?, NULL, NULL, '2024', '2024')`,
    )
    .run(id, BASE_LAYER, name, name, valueType);
  return id;
}

/** Значение `bool` — число 0/1 в `value_bool` (false — законное значение). */
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

function seedNumberValue(
  ndb: NetworkDb,
  thoughtId: string,
  propertyId: string,
  value: number,
): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_number, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

function ast(filter: FilterAstNode): FilterAst {
  return { version: FILTER_AST_VERSION, filter };
}

function propertyLeaf(propertyId: string, operator: string, value?: unknown): FilterAstNode {
  const entity = { kind: 'property', property_id: propertyId };
  return (
    value === undefined ? { entity, operator } : { entity, operator, value }
  ) as FilterAstNode;
}

function runAst(ndb: NetworkDb, tree: FilterAst): string[] {
  const req: CanonicalQueryRequest = {
    sort: 'alpha',
    order: 'asc',
    limit: 200,
    offset: 0,
    ast: tree,
  };
  return queryThoughts(ndb, USER, req, { emptyFilterMode: 'all', maxLimit: 200 })
    .items.map((i) => i.title)
    .sort();
}

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

interface BoolFixture {
  ndb: NetworkDb;
  propertyId: string;
}

/** Настоящий «нет», «да» и мысль без значения — три состояния bool-свойства. */
function buildBoolFixture(): BoolFixture {
  const ndb = createInMemoryNetworkDb();
  const propertyId = seedProperty(ndb, 'Предполёт выполнен', 'bool');
  seedBoolValue(ndb, seedThought(ndb, 'marked-yes'), propertyId, true);
  seedBoolValue(ndb, seedThought(ndb, 'marked-no'), propertyId, false);
  seedThought(ndb, 'not-marked');
  return { ndb, propertyId };
}

describe(
  '«Заполнено»/«не заполнено» по bool-свойству (2dd47944)',
  { skip: !nativeAvailable() },
  () => {
    it('AST: «заполнено» — false и true, «не заполнено» — только мысль без значения', () => {
      const f = buildBoolFixture();
      try {
        assert.deepEqual(
          runAst(f.ndb, ast(propertyLeaf(f.propertyId, 'not_empty'))),
          ['marked-no', 'marked-yes'],
          'false — значение: «заполнено» возвращает и «нет», и «да»',
        );
        assert.deepEqual(
          runAst(f.ndb, ast(propertyLeaf(f.propertyId, 'is_empty'))),
          ['not-marked'],
          '«не заполнено» — только мысль без строки значения',
        );
        // Значение пары наличия не читается (переданное игнорируется).
        assert.deepEqual(
          runAst(f.ndb, ast(propertyLeaf(f.propertyId, 'is_empty', 'ignored'))),
          ['not-marked'],
          'значение пары заполненности на клаузу не влияет',
        );
        // Комбинация в группе: «НЕ не заполнено» = «заполнено» на тех же данных.
        assert.deepEqual(
          runAst(f.ndb, ast({ op: 'not', children: [propertyLeaf(f.propertyId, 'is_empty')] })),
          ['marked-no', 'marked-yes'],
          'НЕ «не заполнено» — обе отметки, включая false',
        );
        // «Равно false» и «не заполнено» — РАЗНЫЕ наборы: false ≠ «пусто».
        assert.deepEqual(
          runAst(f.ndb, ast(propertyLeaf(f.propertyId, 'eq', false))),
          ['marked-no'],
          '«равно false» — только явная отметка «нет»',
        );
      } finally {
        f.ndb.close();
      }
    });

    it('плоская форма: гейт OPS_BY_VALUE_TYPE открыт для bool', () => {
      const f = buildBoolFixture();
      try {
        assert.deepEqual(runFlat(f.ndb, f.propertyId, 'not_empty'), ['marked-no', 'marked-yes']);
        assert.deepEqual(runFlat(f.ndb, f.propertyId, 'is_empty'), ['not-marked']);
      } finally {
        f.ndb.close();
      }
    });

    it('аналог класса: число 0 — значение, «не заполнено» — только отсутствие', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const propertyId = seedProperty(ndb, 'Количество', 'number');
        seedNumberValue(ndb, seedThought(ndb, 'zero'), propertyId, 0);
        seedThought(ndb, 'absent');
        assert.deepEqual(runAst(ndb, ast(propertyLeaf(propertyId, 'not_empty'))), ['zero']);
        assert.deepEqual(runAst(ndb, ast(propertyLeaf(propertyId, 'is_empty'))), ['absent']);
      } finally {
        ndb.close();
      }
    });
  },
);
