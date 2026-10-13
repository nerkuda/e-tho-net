/**
 * Тесты реестра профилей контекста точек применения (задача 7a798b17,
 * требования 0095daad/aed27eb8, ADR 0c02ab4f).
 *
 * Покрывают:
 *   * инварианты реестра: все шесть профилей описаны; `withTime` согласован с
 *     семейством токенов `time`; паритет `FILTER_AST_ENTITY_KINDS` с
 *     объединением `FilterAstEntity` (сторож против рассинхрона словаря);
 *   * валидацию видимости: операнд, невидимый в точке применения, отвергается
 *     `VALIDATION_ERROR` (AST-профили мыслей; семантические профили — no-op);
 *   * подключение к движку: `queryThoughts` с явным AST проверяет профиль,
 *     без профиля — проверки нет;
 *   * сохранение отбора типа: AST с невидимым операндом не сохраняется.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import {
  EtnError,
  FILTER_AST_ENTITY_KINDS,
  FILTER_AST_OPERATORS,
  FILTER_PROFILES,
  FILTER_PROFILE_IDS,
  filterProfileAstOperands,
  filterProfileHasTime,
  getFilterProfile,
  type FilterAst,
  type FilterAstEntity,
  type FilterAstNode,
} from '@etn/shared';

import type { NetworkDb } from '../src/db/network-db.js';
import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import { assertFilterAstInProfile } from '../src/domain/filter-profile-validation.js';
import { queryThoughts, type ThoughtQueryRequest } from '../src/domain/query-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { createThoughtTypeView } from '../src/domain/thought-type-views-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function astLeaf(entity: FilterAstEntity, operator: string, value?: unknown): FilterAst {
  const leaf: Record<string, unknown> = { entity, operator };
  if (value !== undefined) leaf['value'] = value;
  return { version: 1, filter: leaf as unknown as FilterAstNode };
}

describe('реестр профилей контекста (задача 7a798b17)', () => {
  it('описаны все шесть точек применения с непустыми операндами/операторами', () => {
    assert.deepEqual(
      [...FILTER_PROFILE_IDS].sort(),
      ['attachments', 'chronicle', 'events', 'map', 'publications', 'thoughts'],
    );
    for (const id of FILTER_PROFILE_IDS) {
      const profile = getFilterProfile(id);
      assert.equal(profile.id, id);
      assert.ok(profile.operands.length > 0, `${id}: операнды не пусты`);
      assert.ok(profile.operators.length > 0, `${id}: операторы не пусты`);
      assert.ok(profile.tokens.length > 0, `${id}: токены не пусты`);
      // Инвариант гранулярности времени: `withTime` ⟺ семейство токенов `time`.
      assert.equal(
        profile.withTime,
        profile.tokens.includes('time'),
        `${id}: withTime согласован с tokens`,
      );
    }
  });

  it('профили со временем — только хроника и события', () => {
    const withTime = FILTER_PROFILE_IDS.filter((id) => filterProfileHasTime(id));
    assert.deepEqual([...withTime].sort(), ['chronicle', 'events']);
  });

  it('сторож паритета: FILTER_AST_ENTITY_KINDS совпадает со словарём FilterAstEntity', () => {
    // Объект обязан перечислить КАЖДЫЙ вид операнда (иначе — ошибка компиляции):
    // добавление вида в объединение без строки здесь не соберётся.
    const allKinds: Record<FilterAstEntity['kind'], true> = {
      id: true,
      type: true,
      property: true,
      link_type: true,
      parents: true,
      children: true,
      attachments: true,
      chronology: true,
      comment: true,
      targets: true,
      active: true,
      trashed: true,
      keywords: true,
      author: true,
      editor: true,
      created_at: true,
      updated_at: true,
      properties: true,
      record_time: true,
      record_title: true,
      record_body: true,
      record_author: true,
      record_editor: true,
      occurred_at: true,
      action: true,
      entity_type: true,
      entity_id: true,
      user: true,
    };
    assert.deepEqual(
      [...FILTER_AST_ENTITY_KINDS].sort(),
      (Object.keys(allKinds) as string[]).sort(),
    );
  });

  it('операторы профилей мыслей совпадают с полным словарём AST', () => {
    for (const id of ['thoughts', 'map', 'publications'] as const) {
      assert.deepEqual(getFilterProfile(id).operators, FILTER_AST_OPERATORS);
    }
  });

  it('AST-операнды профиля: множества для мыслей, хроники и событий; null для иных сущностей', () => {
    for (const id of ['thoughts', 'map', 'publications', 'chronicle', 'events'] as const) {
      assert.ok(filterProfileAstOperands(id) !== null, `${id}: операнды — виды AST`);
    }
    for (const id of ['attachments'] as const) {
      assert.equal(filterProfileAstOperands(id), null, `${id}: семантические операнды`);
    }
    // Операнды AST-профилей ⊆ словаря видов AST.
    const kinds = new Set<string>(FILTER_AST_ENTITY_KINDS);
    for (const op of FILTER_PROFILES.thoughts.operands) assert.ok(kinds.has(op));
    for (const op of FILTER_PROFILES.chronicle.operands) assert.ok(kinds.has(op));
    for (const op of FILTER_PROFILES.events.operands) assert.ok(kinds.has(op));
    // «Тождественность» (id) — новый операнд профиля мыслей (задача 4752b065).
    assert.ok(FILTER_PROFILES.thoughts.operands.includes('id'));
    // «Сущность» событий несёт подвыборочные операторы (задача 2b230e8e, требование 1765e659).
    const entityIdOps = FILTER_PROFILES.events.operand_operators!['entity_id']!;
    for (const op of ['eq', 'ne', 'in', 'not_in', 'all_of'] as const) {
      assert.ok(entityIdOps.includes(op), `entity_id: ${op}`);
    }
  });

  it('профиль вложений: состав по требованию f67c85c1', () => {
    const p = getFilterProfile('attachments');
    // Операнды — видимые характеристики вложения: имя, вид (file/url), MIME,
    // владельцы, размер. Дат в карточке нет — created_at/updated_at не входят.
    assert.deepEqual([...p.operands].sort(), ['kind', 'mime_type', 'name', 'owner', 'size']);
    assert.ok(!p.operands.includes('created_at') && !p.operands.includes('updated_at'));
    const sets = p.operand_operators!;
    assert.deepEqual(Object.keys(sets).sort(), [...p.operands].sort(), 'наборы заданы на каждый операнд');
    // Имя: равно/содержит/в списке/Есть слова.
    for (const op of ['eq', 'contains', 'in', 'matches'] as const) {
      assert.ok(sets['name']!.includes(op), `name: ${op}`);
    }
    // Вид (file/url): равно/в списке.
    assert.ok(sets['kind']!.includes('eq') && sets['kind']!.includes('in'));
    // MIME: равно/содержит/в списке.
    for (const op of ['eq', 'contains', 'in'] as const) assert.ok(sets['mime_type']!.includes(op));
    // Владельцы: в списке/в иерархии/в выборке (all_of над под-выборкой)/количество.
    for (const op of ['in', 'in_hierarchy', 'all_of'] as const) assert.ok(sets['owner']!.includes(op));
    assert.ok(sets['owner']!.includes('gt') || sets['owner']!.includes('eq'), 'владельцы: количество');
    // Размер: сравнения/между/заполнено.
    for (const op of ['gt', 'between', 'is_empty'] as const) assert.ok(sets['size']!.includes(op));
  });

  it('семантические профили: operators — ровно объединение наборов по операндам', () => {
    for (const id of ['chronicle', 'events', 'attachments'] as const) {
      const p = getFilterProfile(id);
      const sets = p.operand_operators;
      assert.ok(sets !== undefined, `${id}: наборы по операндам заданы`);
      const union: string[] = [];
      for (const list of Object.values(sets!)) {
        for (const op of list) if (!union.includes(op)) union.push(op);
      }
      assert.deepEqual([...p.operators].sort(), [...union].sort(), `${id}: operators = union`);
    }
    // AST-профили несут словарь AST без наборов по операнду.
    for (const id of ['thoughts', 'map', 'publications'] as const) {
      assert.equal(getFilterProfile(id).operand_operators, undefined);
    }
  });

  it('валидация видимости: операнд вне профиля отвергается', () => {
    // «Цели» доступны только хронике — в отборе мыслей операнд невидим.
    const withTargets = astLeaf({ kind: 'targets' }, 'in', []);
    assert.throws(
      () => assertFilterAstInProfile(withTargets, 'thoughts'),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
    );
    // Тип связи виден на карте, но не в отборе мыслей.
    const withLinkType = astLeaf({ kind: 'link_type' }, 'in', [randomUUID()]);
    assert.doesNotThrow(() => assertFilterAstInProfile(withLinkType, 'map'));
    assert.throws(() => assertFilterAstInProfile(withLinkType, 'thoughts'));
    // Видимый операнд в своём профиле — без ошибки.
    assert.doesNotThrow(() => assertFilterAstInProfile(astLeaf({ kind: 'active' }, 'eq', true), 'thoughts'));
    // «Цели» видны в профиле хроники (задача 4752b065) — проверка проходит.
    assert.doesNotThrow(() => assertFilterAstInProfile(withTargets, 'chronicle'));
    // Операнд записи виден хронике, но не мыслям.
    assert.throws(
      () => assertFilterAstInProfile(astLeaf({ kind: 'record_body' }, 'matches', 'x'), 'thoughts'),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
    );
    // Оператор не из набора своего операнда хроники — тоже отказ.
    assert.throws(
      () => assertFilterAstInProfile(astLeaf({ kind: 'record_body' }, 'eq', 'x'), 'chronicle'),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
    );
    // Операнд события виден событиям, но не мыслям (задача 2b230e8e).
    assert.doesNotThrow(() => assertFilterAstInProfile(astLeaf({ kind: 'occurred_at' }, 'gte', 0), 'events'));
    assert.throws(
      () => assertFilterAstInProfile(astLeaf({ kind: 'occurred_at' }, 'gte', 0), 'thoughts'),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('под-выборка проверяется тем же профилем', () => {
    const nested: FilterAst = {
      version: 1,
      filter: {
        entity: { kind: 'property', property_id: 'p' },
        operator: 'in',
        value: { query: { entity: { kind: 'targets' }, operator: 'in', value: [] }, operator: 'in' },
      } as unknown as FilterAstNode,
    };
    assert.throws(
      () => assertFilterAstInProfile(nested, 'thoughts'),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
    );
  });

  describe('подключение к движку и сохранению', { skip: !nativeAvailable() }, () => {
    function run(ndb: NetworkDb, tree: FilterAst, profile?: 'thoughts'): void {
      const req: ThoughtQueryRequest = { sort: 'alpha', order: 'asc', limit: 10, offset: 0, count: true, ast: tree };
      queryThoughts(ndb, 'u', req, { emptyFilterMode: 'all', maxLimit: 100, ...(profile !== undefined ? { profile } : {}) });
    }

    it('queryThoughts проверяет профиль у явного AST; без профиля — не проверяет', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        // Живой тип связи: «Тип связи» исполним движком, но невидим в профиле
        // мыслей (виден на карте).
        const ltId = randomUUID();
        ndb
          .prepare(
            `INSERT INTO link_types (id, name_forward, name_forward_key, name_reverse, name_reverse_key,
                                     version, created_at, updated_at, created_by)
             VALUES (?, 'касается', lower('касается'), 'касается от', lower('касается от'), 1, '2024', '2024', 'u')`,
          )
          .run(ltId);
        const tree = astLeaf({ kind: 'link_type' }, 'in', [ltId]);
        assert.throws(
          () => run(ndb, tree, 'thoughts'),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
        // Без профиля движок профиль не применяет (обратная совместимость).
        assert.doesNotThrow(() => run(ndb, tree));
      } finally {
        ndb.close();
      }
    });

    it('сохранение отбора типа: AST с невидимым операндом не сохраняется', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const tt = createThoughtType(ndb, { name: 'task' }, 'u');
        assert.throws(
          () =>
            createThoughtTypeView(
              ndb,
              tt.id,
              { name: 'Битый', definition: JSON.stringify(astLeaf({ kind: 'targets' }, 'in', [])) },
              'u',
            ),
          (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        );
      } finally {
        ndb.close();
      }
    });
  });
});
