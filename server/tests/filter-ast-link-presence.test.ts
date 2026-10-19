/**
 * Тесты операндов «Есть входящие связи»/«Есть исходящие связи» (задача
 * 60db9614, требования сущности 489c394f).
 *
 * Покрывают:
 *   * оба направления: входящие — рёбра, где мысль `target`; исходящие — где
 *     `source`;
 *   * структурные рёбра (`type_id IS NULL`) наравне с типизированными —
 *     «не важно какого типа»;
 *   * фильтр состояний РЕБРА (`active`/`inactive`/`trashed`/`not_trashed`):
 *     две независимые пары по И, пустая пара не ограничивает, все значения =
 *     все состояния, пустой/отсутствующий `states` = все состояния;
 *   * флаги относятся только к ребру: живое ребро к мысли в корзине или к
 *     неактуальной мысли всё равно считается;
 *   * валидацию: `value` у операнда, неизвестное состояние, недопустимый
 *     оператор, операнд вне профиля (хроника/события/вложения) — `VALIDATION_ERROR`;
 *   * доступность в профилях `thoughts`/`map`/`publications`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { EtnError, FILTER_AST_VERSION, type FilterAst, type FilterAstNode } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { parseFilterAst } from '../src/domain/filter-ast.js';
import { assertFilterAstInProfile } from '../src/domain/filter-profile-validation.js';
import { queryThoughts, type ThoughtQueryRequest } from '../src/domain/query-service.js';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

const USER = 'u';

function seedThought(
  ndb: NetworkDb,
  title: string,
  opts: { active?: number; marked?: number } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, marked_for_deletion, is_protected,
                             is_root, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 0, 0, 1, '2024-01-01T00:00:00.000Z', 'u',
               '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(
      id,
      title,
      title.normalize('NFC').trim().toLowerCase(),
      opts.active ?? 1,
      opts.marked ?? 0,
    );
  return id;
}

function seedLinkType(ndb: NetworkDb): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO link_types (id, name_forward, name_forward_key, name_reverse,
                               name_reverse_key, version, created_at, updated_at, created_by)
       VALUES (?, 'Тип', 'тип', 'Обратно', 'обратно', 1, '2024', '2024', 'u')`,
    )
    .run(id);
  return id;
}

function seedLink(
  ndb: NetworkDb,
  sourceId: string,
  targetId: string,
  opts: { typeId?: string | null; active?: number; marked?: number } = {},
): void {
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, marked_for_deletion,
                          version, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(
      randomUUID(),
      sourceId,
      targetId,
      opts.typeId ?? null,
      opts.active ?? 1,
      opts.marked ?? 0,
    );
}

function ast(filter: FilterAstNode): FilterAst {
  return { version: FILTER_AST_VERSION, filter };
}

function runAst(ndb: NetworkDb, tree: FilterAst): string[] {
  const req: ThoughtQueryRequest = {
    sort: 'alpha',
    order: 'asc',
    limit: 200,
    offset: 0,
    count: true,
    ast: tree,
  };
  const res = queryThoughts(ndb, USER, req, { emptyFilterMode: 'all', maxLimit: 200 });
  return res.items.map((item) => item.title).sort();
}

function leaf(
  kind: 'incoming_links' | 'outgoing_links',
  operator: 'is_empty' | 'not_empty',
  states?: readonly string[],
): FilterAstNode {
  const entity = states === undefined ? { kind } : { kind, states };
  return { entity, operator } as unknown as FilterAstNode;
}

describe('AST: наличие входящих и исходящих связей (60db9614)', { skip: !nativeAvailable() }, () => {
  /**
   * Стенд состояний:
   *   L  — только живое входящее;
   *   I  — только неактуальное входящее;
   *   T  — только входящее в корзине;
   *   IT — неактуальное входящее в корзине;
   *   S  — только СТРУКТУРНОЕ исходящее;
   *   TN — живое входящее от мысли в корзине;
   *   IN — живое входящее от неактуальной мысли;
   *   N  — без единого ребра.
   */
  function fixture(): {
    ndb: NetworkDb;
    L: string;
    I: string;
    T: string;
    IT: string;
    S: string;
    TN: string;
    IN: string;
    N: string;
  } {
    const ndb = createInMemoryNetworkDb();
    const typeId = seedLinkType(ndb);
    const L = seedThought(ndb, 'Живое входящее');
    const I = seedThought(ndb, 'Неактуальное входящее');
    const T = seedThought(ndb, 'Входящее в корзине');
    const IT = seedThought(ndb, 'Неактуальное в корзине');
    const S = seedThought(ndb, 'Структурное исходящее');
    const TN = seedThought(ndb, 'Сосед в корзине');
    const IN = seedThought(ndb, 'Неактуальный сосед');
    const N = seedThought(ndb, 'Без связей');

    seedLink(ndb, seedThought(ndb, 'Источник L'), L, { typeId, active: 1, marked: 0 });
    seedLink(ndb, seedThought(ndb, 'Источник I'), I, { typeId, active: 0, marked: 0 });
    seedLink(ndb, seedThought(ndb, 'Источник T'), T, { typeId, active: 1, marked: 1 });
    seedLink(ndb, seedThought(ndb, 'Источник IT'), IT, { typeId, active: 0, marked: 1 });
    seedLink(ndb, S, seedThought(ndb, 'Структурный потомок'), { typeId: null });
    // Ребро живое; состояние СОСЕДА другое — на условие влиять не должно.
    seedLink(
      ndb,
      seedThought(ndb, 'Сосед в корзине', { marked: 1 }),
      TN,
      { typeId, active: 1, marked: 0 },
    );
    seedLink(
      ndb,
      seedThought(ndb, 'Неактуальный сосед', { active: 0 }),
      IN,
      { typeId, active: 1, marked: 0 },
    );
    return { ndb, L, I, T, IT, S, TN, IN, N };
  }

  it('направления: входящие — target, исходящие — source; структурные рёбра учитываются', () => {
    const f = fixture();
    assert.deepEqual(
      runAst(f.ndb, ast(leaf('incoming_links', 'not_empty'))),
      ['Входящее в корзине', 'Живое входящее', 'Неактуальное в корзине', 'Неактуальное входящее', 'Неактуальный сосед', 'Сосед в корзине', 'Структурный потомок'],
    );
    // У S только структурное исходящее ребро — оно обязано считаться; у
    // источников входящих рёбер тоже есть исходящие.
    assert.deepEqual(runAst(f.ndb, ast(leaf('outgoing_links', 'not_empty'))), [
      'Источник I',
      'Источник IT',
      'Источник L',
      'Источник T',
      'Неактуальный сосед',
      'Сосед в корзине',
      'Структурное исходящее',
    ]);
    assert.deepEqual(runAst(f.ndb, ast(leaf('incoming_links', 'is_empty'))), [
      'Без связей',
      'Источник I',
      'Источник IT',
      'Источник L',
      'Источник T',
      'Неактуальный сосед',
      'Сосед в корзине',
      'Структурное исходящее',
    ]);
    assert.deepEqual(runAst(f.ndb, ast(leaf('outgoing_links', 'is_empty'))), [
      'Без связей',
      'Входящее в корзине',
      'Живое входящее',
      'Неактуальное в корзине',
      'Неактуальное входящее',
      'Неактуальный сосед',
      'Сосед в корзине',
      'Структурный потомок',
    ]);
  });

  it('состояния ребра: каждая пара по И; не выбранное состояние исключает ребро', () => {
    const f = fixture();
    const names = (states: readonly string[]): string[] =>
      runAst(f.ndb, ast(leaf('incoming_links', 'not_empty', states)));

    assert.deepEqual(names(['active']), ['Входящее в корзине', 'Живое входящее', 'Неактуальный сосед', 'Сосед в корзине', 'Структурный потомок']);
    assert.deepEqual(names(['inactive']), ['Неактуальное в корзине', 'Неактуальное входящее']);
    assert.deepEqual(names(['trashed']), ['Входящее в корзине', 'Неактуальное в корзине']);
    assert.deepEqual(names(['not_trashed']), ['Живое входящее', 'Неактуальное входящее', 'Неактуальный сосед', 'Сосед в корзине', 'Структурный потомок']);
    assert.deepEqual(names(['active', 'not_trashed']), ['Живое входящее', 'Неактуальный сосед', 'Сосед в корзине', 'Структурный потомок']);
    assert.deepEqual(names(['inactive', 'trashed']), ['Неактуальное в корзине']);
    // Оба значения пары — пара не ограничивает.
    assert.deepEqual(names(['active', 'inactive']), names([]));
    assert.deepEqual(names(['trashed', 'not_trashed']), names([]));
    // Пустая пара (выбран только член второй) не ограничивает первую.
    assert.deepEqual(names(['trashed']), ['Входящее в корзине', 'Неактуальное в корзине']);
    // Все четыре (и пустой/отсутствующий набор) = все состояния.
    assert.deepEqual(names(['active', 'inactive', 'trashed', 'not_trashed']), names([]));
  });

  it('флаги относятся только к ребру: живое ребро к мысли в корзине/неактуальной считается', () => {
    const f = fixture();
    assert.deepEqual(
      runAst(f.ndb, ast(leaf('incoming_links', 'not_empty', ['active', 'not_trashed']))),
      ['Живое входящее', 'Неактуальный сосед', 'Сосед в корзине', 'Структурный потомок'],
    );
    // И наоборот: ребро в корзине не становится «живым» из-за живого соседа.
    assert.deepEqual(
      runAst(f.ndb, ast(leaf('incoming_links', 'not_empty', ['trashed']))),
      ['Входящее в корзине', 'Неактуальное в корзине'],
    );
  });

  it('валидация: value, неизвестное состояние, оператор и чужой профиль — VALIDATION_ERROR', () => {
    const f = fixture();
    const parseError = (filter: unknown): EtnError => {
      try {
        parseFilterAst({ version: FILTER_AST_VERSION, filter });
      } catch (error) {
        assert.ok(error instanceof EtnError, `ожидался EtnError, получено ${String(error)}`);
        return error;
      }
      assert.fail('ожидалась VALIDATION_ERROR');
    };

    const withValue = parseError({
      entity: { kind: 'incoming_links' },
      operator: 'not_empty',
      value: 'x',
    });
    assert.equal(withValue.code, 'VALIDATION_ERROR');
    assert.equal((withValue.details as Record<string, unknown>)['field'], 'filter.value');

    const badState = parseError({
      entity: { kind: 'outgoing_links', states: ['active', 'unknown'] },
      operator: 'not_empty',
    });
    assert.equal(badState.code, 'VALIDATION_ERROR');
    assert.equal((badState.details as Record<string, unknown>)['field'], 'filter.entity.states');

    const parsed = parseFilterAst(ast(leaf('incoming_links', 'not_empty')));
    for (const profile of ['thoughts', 'map', 'publications'] as const) {
      assert.doesNotThrow(() => assertFilterAstInProfile(parsed, profile), profile);
    }
    for (const profile of ['chronicle', 'events', 'attachments'] as const) {
      assert.throws(
        () => assertFilterAstInProfile(parsed, profile),
        (error: unknown) =>
          error instanceof EtnError &&
          error.code === 'VALIDATION_ERROR' &&
          (error.details as Record<string, unknown>)['field'] === 'filter.entity',
        `${profile}: операнд обязан быть невидим`,
      );
    }

    // Оператор вне набора: гейт профиля отвергает `eq` (а не молча игнорирует).
    assert.throws(
      () =>
        assertFilterAstInProfile(
          {
            version: FILTER_AST_VERSION,
            filter: { entity: { kind: 'incoming_links' }, operator: 'eq', value: true } as FilterAstNode,
          },
          'thoughts',
        ),
      (error: unknown) =>
        error instanceof EtnError &&
        error.code === 'VALIDATION_ERROR' &&
        (error.details as Record<string, unknown>)['field'] === 'filter.operator',
    );
    // Пустой массив `states` нормализуется в отсутствие поля — обе формы «все».
    const empty = parseFilterAst(ast(leaf('incoming_links', 'not_empty', [])));
    assert.ok('entity' in empty.filter);
    assert.deepEqual(empty.filter.entity, { kind: 'incoming_links' });
    assert.deepEqual(runAst(f.ndb, empty), runAst(f.ndb, ast(leaf('incoming_links', 'not_empty'))));
  });
});
