/**
 * Датовые границы AST-исполнителя отбора мыслей: «голая дата» = сутки UTC в
 * ВКЛЮЧИТЕЛЬНОЙ верхней границе (требования 25324388 «границы включительно,
 * „между x и x“ = равенство» и 469d8d69 «голая дата во входных параметрах
 * API = сутки UTC»; круг проверки 1 задачи 347b307e).
 *
 * Диагноз блокера: значения-даты мыслей (`created_at`/`updated_at`) хранятся с
 * временем, сравнение лексикографическое, поэтому верхняя граница-«голая дата»
 * (`$today`, `$weekEnd`) отсекала граничный день ЦЕЛИКОМ —
 * `created_at between [$today, $today]` давал 0 для мысли, созданной сегодня.
 * Фикс: включительная верхняя граница-«голая дата» разворачивается до конца
 * суток UTC. Нижние границы, строгий `lt`, полные инстансы (со временем) и
 * числа/строки не затронуты.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { FILTER_AST_VERSION, type FilterAst, type FilterAstNode } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { queryThoughts, type ThoughtQueryRequest } from '../src/domain/query-service.js';

const BASE_LAYER = '00000000-0000-4000-8000-0000000000ba5e';
const USER = 'u';
/** Четверг: неделя (пн..вс) — 2026-10-12 … 2026-10-18. */
const NOW_MS = Date.parse('2026-10-15T12:00:00.000Z');

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** Мысль с заданным `created_at` (значения-даты хранятся с временем). */
function seedThoughtAt(ndb: NetworkDb, title: string, createdAt: string, typeId: string | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 1, 0, 0, 1, ?, 'u', ?, 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase(), typeId, createdAt, createdAt);
  return id;
}

function seedThoughtType(ndb: NetworkDb, name: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, parent_id, name, name_key, version, created_at, updated_at, created_by)
       VALUES (?, NULL, ?, lower(?), 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, name, name);
  return id;
}

function seedProperty(ndb: NetworkDb, name: string, valueType: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, ?, ?, lower(?), ?, NULL, NULL, '2024', '2024')`,
    )
    .run(id, BASE_LAYER, name, name, valueType);
  return id;
}

function bindProperty(ndb: NetworkDb, typeId: string, propertyId: string): void {
  ndb
    .prepare(
      `INSERT INTO type_properties (id, owner_type, owner_id, property_id, required, position)
       VALUES (?, 'thought_type', ?, ?, 0, 0)`,
    )
    .run(randomUUID(), typeId, propertyId);
}

function seedDateValue(ndb: NetworkDb, thoughtId: string, propertyId: string, value: string): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_date, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

function ast(filter: FilterAstNode): FilterAst {
  return { version: FILTER_AST_VERSION, filter };
}

function leaf(entity: Record<string, unknown>, operator: string, value?: unknown): FilterAstNode {
  return (value === undefined ? { entity, operator } : { entity, operator, value }) as FilterAstNode;
}

/** Исполнить AST с контекстом токенов (`$today`/`$weekStart`…) и вернуть заголовки. */
function run(ndb: NetworkDb, tree: FilterAst, tokenContext = true): string[] {
  const req: ThoughtQueryRequest = {
    sort: 'alpha',
    order: 'asc',
    limit: 200,
    offset: 0,
    count: true,
    ast: tree,
  };
  const res = queryThoughts(ndb, USER, req, {
    emptyFilterMode: 'all',
    maxLimit: 200,
    ...(tokenContext
      ? { tokenContext: { nowMs: NOW_MS, userId: USER, firstDayOfWeek: 1, withTime: false } }
      : {}),
  });
  return res.items.map((i) => i.title).sort();
}

describe('датовые границы AST: «голая дата» = сутки UTC сверху (347b307e)', { skip: !nativeAvailable() }, () => {
  it('between [$today, $today] включает мысль, созданную сегодня в любое время', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      // Воспроизведение доказательства верификатора: 05:09:50Z сегодня.
      seedThoughtAt(ndb, 'Сегодня', '2026-10-15T05:09:50.000Z');
      seedThoughtAt(ndb, 'Сегодня поздно', '2026-10-15T23:59:59.998Z');
      seedThoughtAt(ndb, 'Вчера', '2026-10-14T23:59:59.999Z');
      seedThoughtAt(ndb, 'Завтра', '2026-10-16T00:00:00.000Z');

      assert.deepEqual(
        run(ndb, ast(leaf({ kind: 'created_at' }, 'between', [{ token: '$today' }, { token: '$today' }]))),
        ['Сегодня', 'Сегодня поздно'],
        '«между сегодня и сегодня» = весь день сегодня (границы включительны)',
      );
    } finally {
      ndb.close();
    }
  });

  it('между [$today-30d, $today] включает сегодня созданную (набор «Создано за 30 дней»)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      seedThoughtAt(ndb, 'Сегодня', '2026-10-15T05:09:50.000Z');
      seedThoughtAt(ndb, 'Ровно 30 дней', '2026-09-15T00:00:00.000Z');
      seedThoughtAt(ndb, '31 день', '2026-09-14T23:59:59.999Z');

      assert.deepEqual(
        run(ndb, ast(leaf({ kind: 'created_at' }, 'between', [{ token: '$today-30d' }, { token: '$today' }]))),
        ['Ровно 30 дней', 'Сегодня'],
        'верхняя граница $today покрывает весь сегодняшний день',
      );
    } finally {
      ndb.close();
    }
  });

  it('lte $weekEnd включает последний день недели, но не следующий', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      seedThoughtAt(ndb, 'Вс вечер', '2026-10-18T22:30:00.000Z');
      seedThoughtAt(ndb, 'Пн ночь', '2026-10-19T00:00:00.000Z');
      seedThoughtAt(ndb, 'Начало недели', '2026-10-12T00:00:00.000Z');

      assert.deepEqual(
        run(ndb, ast(leaf({ kind: 'created_at' }, 'lte', { token: '$weekEnd' }))),
        ['Вс вечер', 'Начало недели'],
        '$weekEnd = воскресенье покрывает весь день',
      );
    } finally {
      ndb.close();
    }
  });

  it('between [«голая дата», «голая дата»] покрывает граничный день целиком', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      seedThoughtAt(ndb, 'Первый день', '2026-10-01T00:00:00.000Z');
      seedThoughtAt(ndb, 'Последний день вечер', '2026-10-15T23:59:00.000Z');
      seedThoughtAt(ndb, 'После', '2026-10-16T00:00:00.000Z');

      assert.deepEqual(
        run(ndb, ast(leaf({ kind: 'created_at' }, 'between', ['2026-10-01', '2026-10-15']))),
        ['Первый день', 'Последний день вечер'],
      );
    } finally {
      ndb.close();
    }
  });

  it('регресс: полный ISO-инстанс (со временем) сверху работает как раньше', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      seedThoughtAt(ndb, 'До границы', '2026-10-15T05:00:00.000Z');
      seedThoughtAt(ndb, 'После границы', '2026-10-15T07:00:00.000Z');

      assert.deepEqual(
        run(ndb, ast(leaf({ kind: 'created_at' }, 'between', ['2026-10-01', '2026-10-15T06:00:00.000Z']))),
        ['До границы'],
        'инстанс с временем не разворачивается до конца суток',
      );
      assert.deepEqual(
        run(ndb, ast(leaf({ kind: 'created_at' }, 'lte', '2026-10-15T06:00:00.000Z'))),
        ['До границы'],
      );
    } finally {
      ndb.close();
    }
  });

  it('регресс: нижние границы и строгий lt не изменены', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      seedThoughtAt(ndb, 'Вчера', '2026-10-14T23:59:59.999Z');
      seedThoughtAt(ndb, 'Сегодня полночь', '2026-10-15T00:00:00.000Z');

      // Нижняя граница-«голая дата» = начало суток (как и было).
      assert.deepEqual(run(ndb, ast(leaf({ kind: 'created_at' }, 'gte', '2026-10-15'))), ['Сегодня полночь']);
      // Строгий lt не разворачивается: ровно полночь не проходит.
      assert.deepEqual(run(ndb, ast(leaf({ kind: 'created_at' }, 'lt', '2026-10-15'))), ['Вчера']);
    } finally {
      ndb.close();
    }
  });

  it('not_between — дополнение «между»: граничный день исключён целиком', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      seedThoughtAt(ndb, 'Внутри', '2026-10-10T12:00:00.000Z');
      seedThoughtAt(ndb, 'Граничный день', '2026-10-15T09:00:00.000Z');
      seedThoughtAt(ndb, 'После', '2026-10-16T00:00:00.000Z');

      // «Между» со «голой» верхней границей покрывает весь граничный день,
      // значит его дополнение его целиком исключает (границы «между»
      // включительны, требование 25324388).
      assert.deepEqual(
        run(ndb, ast(leaf({ kind: 'created_at' }, 'not_between', ['2026-10-01', '2026-10-15']))),
        ['После'],
      );
    } finally {
      ndb.close();
    }
  });

  it('eq/ne даты создания: равенство «голой даты» — сутки целиком (e219112e)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      seedThoughtAt(ndb, 'Сегодня раннее', '2026-10-15T05:09:50.000Z');
      seedThoughtAt(ndb, 'Сегодня позднее', '2026-10-15T23:59:59.998Z');
      seedThoughtAt(ndb, 'Вчера', '2026-10-14T23:59:59.999Z');

      // «равно 2026-10-15» = весь день 15-го (нижняя граница — само значение,
      // верхняя — конец суток), «не равно» — дополнение.
      assert.deepEqual(
        run(ndb, ast(leaf({ kind: 'created_at' }, 'eq', '2026-10-15'))),
        ['Сегодня позднее', 'Сегодня раннее'],
        '«равно голой дате» покрывает сутки целиком',
      );
      assert.deepEqual(
        run(ndb, ast(leaf({ kind: 'updated_at' }, 'ne', '2026-10-15'))),
        ['Вчера'],
        '«не равно голой дате» исключает сутки целиком',
      );
      // Полный инстанс — точное сравнение (границы совпадают).
      assert.deepEqual(
        run(ndb, ast(leaf({ kind: 'created_at' }, 'eq', '2026-10-15T05:09:50.000Z'))),
        ['Сегодня раннее'],
      );
    } finally {
      ndb.close();
    }
  });

  it('датовое свойство: включительная верхняя граница-«голая дата» покрывает день', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const typeId = seedThoughtType(ndb, 'Событие');
      const propId = seedProperty(ndb, 'Дата события', 'date');
      bindProperty(ndb, typeId, propId);
      const early = seedThoughtAt(ndb, 'Раннее', '2024-01-01T00:00:00.000Z', typeId);
      const late = seedThoughtAt(ndb, 'Позднее', '2024-01-01T00:00:00.000Z', typeId);
      const outside = seedThoughtAt(ndb, 'Вне', '2024-01-01T00:00:00.000Z', typeId);
      seedDateValue(ndb, early, propId, '2026-10-15T05:00:00.000Z');
      seedDateValue(ndb, late, propId, '2026-10-15T23:30:00.000Z');
      seedDateValue(ndb, outside, propId, '2026-10-16T00:00:00.000Z');

      const propLeaf = (operator: string, value: unknown): FilterAst =>
        ast(leaf({ kind: 'property', property_id: propId }, operator, value));

      assert.deepEqual(
        run(ndb, propLeaf('between', ['2026-10-15', '2026-10-15'])),
        ['Позднее', 'Раннее'],
        'верхняя граница-дата покрывает день целиком',
      );
      assert.deepEqual(run(ndb, propLeaf('lte', '2026-10-15')), ['Позднее', 'Раннее']);
      assert.deepEqual(run(ndb, propLeaf('lt', '2026-10-15')), [], 'строгий lt не разворачивается');
    } finally {
      ndb.close();
    }
  });
});
