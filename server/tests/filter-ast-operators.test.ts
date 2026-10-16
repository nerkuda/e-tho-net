/**
 * Тесты словаря операторов AST-исполнителя (задача aee021c8, этап 2 поверх T1
 * 9c156b8c; тех.проект «Ядро AST и операторы»).
 *
 * Покрывают семантику операторов по типу левого операнда (требования-операторы
 * 1e19504b/7f0e3f8c/f14e48ab/25324388/bd0348b3/0882f8d5):
 *   * сравнения и «между» по числу/дате/строке (лексикографически);
 *   * «количество» по коллекциям (родители/потомки/вложения/дневник),
 *     свойствам-связям (обе стороны) и множественным свойствам, включая
 *     «количество = 0» (пограничный сценарий c76f688b);
 *   * «имеет свойство»/«не имеет» для мысли (эффективные + индивидуальные) и
 *     для операнда «Тип» (эффективные свойства типа с наследованием);
 *   * «Найти слова»: области чекбоксами; ни одной (в т.ч. отсутствие `scope`) —
 *     условие отключено;
 *   * честный `unsupported` для чужих задач (под-выборки; «в иерархии» для
 *     операндов вне объёма задачи e62aa4db).
 *     Токены AST раскрываются резолвером с 0.13.1 (задача 0f1b9892) — их
 *     покрытие в `filter-ast-tokens.test.ts`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  queryThoughts,
  type ThoughtQueryRequest as CanonicalQueryRequest,
} from '../src/domain/query-service.js';
import { EtnError, FILTER_AST_VERSION, type FilterAst, type FilterAstNode } from '@etn/shared';

const BASE_LAYER = '00000000-0000-4000-8000-0000000000ba5e';

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function seedThought(
  ndb: NetworkDb,
  title: string,
  opts: { type_id?: string; active?: number } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 0, 0, 1, '2024-01-01T00:00:00.000Z', 'u', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, title, title.normalize('NFC').trim().toLowerCase(), opts.type_id ?? null, opts.active ?? 1);
  return id;
}

function seedThoughtType(ndb: NetworkDb, name: string, parentId: string | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thought_types (id, parent_id, name, name_key, version, created_at, updated_at, created_by)
       VALUES (?, ?, ?, lower(?), 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, parentId, name, name);
  return id;
}

function seedLinkType(ndb: NetworkDb, nameForward: string, nameReverse: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO link_types (id, name_forward, name_forward_key, name_reverse, name_reverse_key,
                               version, created_at, updated_at, created_by)
       VALUES (?, ?, lower(?), ?, lower(?), 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, nameForward, nameForward, nameReverse, nameReverse);
  return id;
}

function seedLink(ndb: NetworkDb, sourceId: string, targetId: string, typeId: string | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, sourceId, targetId, typeId);
  return id;
}

function seedProperty(
  ndb: NetworkDb,
  name: string,
  valueType: string,
  config: Record<string, unknown> | null = null,
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, ?, ?, lower(?), ?, ?, NULL, '2024', '2024')`,
    )
    .run(id, BASE_LAYER, name, name, valueType, config === null ? null : JSON.stringify(config));
  return id;
}

/** Привязка реестрового свойства к типу мысли (для эффективного набора). */
function bindProperty(ndb: NetworkDb, typeId: string, propertyId: string): void {
  ndb
    .prepare(
      `INSERT INTO type_properties (id, owner_type, owner_id, property_id, required, position)
       VALUES (?, 'thought_type', ?, ?, 0, 0)`,
    )
    .run(randomUUID(), typeId, propertyId);
}

/** Значение свойства в колонку по его виду (одна колонка на вид). */
function seedValue(
  ndb: NetworkDb,
  thoughtId: string,
  propertyId: string,
  valueType: string,
  value: string | number,
): void {
  const column =
    valueType === 'number' ? 'value_number' : valueType === 'date' ? 'value_date' : 'value_text';
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, ${column}, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

function seedAttachment(ndb: NetworkDb, thoughtId: string): void {
  ndb
    .prepare(
      `INSERT INTO attachments (id, owner_type, owner_id, kind, url, created_at, created_by)
       VALUES (?, 'thought', ?, 'url', 'https://example.test/a', '2024', 'u')`,
    )
    .run(randomUUID(), thoughtId);
}

function seedChronology(ndb: NetworkDb, thoughtId: string): void {
  ndb
    .prepare(
      `INSERT INTO comments (id, owner_type, owner_id, kind, body_md, body_html, valid_from,
                             version, created_at, updated_at, created_by, updated_by)
       VALUES (?, 'thought', ?, 'chronological', 'запись', 'запись', '2024-01-01', 1, '2024', '2024', 'u', 'u')`,
    )
    .run(randomUUID(), thoughtId);
}

/** Собрать корень AST из узла (версия подставляется автоматически). */
function ast(filter: FilterAstNode): FilterAst {
  return { version: FILTER_AST_VERSION, filter };
}

/** Прогнать AST через единый исполнитель и вернуть отсортированные заголовки. */
function runAst(ndb: NetworkDb, tree: FilterAst): string[] {
  const req: CanonicalQueryRequest = { sort: 'alpha', order: 'asc', limit: 200, offset: 0, count: true, ast: tree };
  const res = queryThoughts(ndb, 'u', req, { emptyFilterMode: 'all', maxLimit: 200 });
  return res.items.map((i) => i.title).sort();
}

/** Лист-условие по операнду (без labels). */
function leaf(entity: Record<string, unknown>, operator: string, value?: unknown): FilterAstNode {
  return (value === undefined ? { entity, operator } : { entity, operator, value }) as FilterAstNode;
}

describe('AST operator vocabulary (aee021c8)', { skip: !nativeAvailable() }, () => {
  it('count on structural collections: children/parents, boundary «count = 0» (c76f688b)', () => {
    const ndb = createInMemoryNetworkDb();
    const root = seedThought(ndb, 'Версия X');
    const c1 = seedThought(ndb, 'Работа 1');
    const c2 = seedThought(ndb, 'Работа 2');
    const c3 = seedThought(ndb, 'Работа 3');
    seedThought(ndb, 'Сирота');
    seedLink(ndb, root, c1);
    seedLink(ndb, root, c2);
    seedLink(ndb, root, c3);

    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'children' }, 'gt', 2))), ['Версия X']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'children' }, 'eq', 3))), ['Версия X']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'children' }, 'between', [1, 2]))), []);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'parents' }, 'eq', 0))), ['Версия X', 'Сирота']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'parents' }, 'not_empty'))), ['Работа 1', 'Работа 2', 'Работа 3']);
  });

  /**
   * Наборные операторы на структурных «Родители»/«Потомки» (карточка 759eedeb:
   * старый сохранённый отбор падал 422 — профиль `THOUGHT_OPERATOR_SETS`
   * перечислял `any_of`/`all_of`/`none_of`, а исполнитель их не знал).
   *
   * Семантика СПИСКА значений — по требованию 92b9c55b и ярлыку редактора
   * «содержит все из»: `any_of` — хотя бы один родитель/потомок входит в набор
   * (паритет с `in`), `none_of` — ни одного (`not_in`), `all_of` — КАЖДЫЙ
   * перечисленный id присутствует среди родителей/потомков (точечный join по
   * ребру, НЕ поддерево и НЕ квантификатор `all_in` под-выборки).
   */
  function seedSetOperatorFixture(ndb: NetworkDb): {
    g1: string;
    g2: string;
    g3: string;
    both: string;
    one: string;
    other: string;
  } {
    const g1 = seedThought(ndb, 'Группа 1');
    const g2 = seedThought(ndb, 'Группа 2');
    const g3 = seedThought(ndb, 'Группа 3');
    const both = seedThought(ndb, 'Ребёнок обоих'); // родители g1 и g2
    const one = seedThought(ndb, 'Ребёнок первой'); // родитель g1
    const other = seedThought(ndb, 'Ребёнок третьей'); // родитель g3
    seedThought(ndb, 'Сирота'); // без родителей
    seedLink(ndb, g1, both);
    seedLink(ndb, g2, both);
    seedLink(ndb, g1, one);
    seedLink(ndb, g3, other);
    return { g1, g2, g3, both, one, other };
  }

  it('наборные по «Родителям»: any_of ≡ in, none_of ≡ not_in, all_of — «есть все перечисленные»', () => {
    const ndb = createInMemoryNetworkDb();
    const { g1, g2, g3 } = seedSetOperatorFixture(ndb);
    const set = [g1, g2];

    // Паритет со списком: any_of даёт ровно то же, что `in`, none_of — что `not_in`.
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'parents' }, 'any_of', set))),
      runAst(ndb, ast(leaf({ kind: 'parents' }, 'in', set))),
    );
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'parents' }, 'any_of', set))),
      ['Ребёнок обоих', 'Ребёнок первой'],
    );
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'parents' }, 'none_of', set))),
      runAst(ndb, ast(leaf({ kind: 'parents' }, 'not_in', set))),
    );
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'parents' }, 'none_of', set))), [
      'Группа 1',
      'Группа 2',
      'Группа 3',
      'Ребёнок третьей',
      'Сирота',
    ]);

    // all_of — КАЖДЫЙ из перечисленных обязан быть родителем.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'parents' }, 'all_of', [g1, g2]))), ['Ребёнок обоих']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'parents' }, 'all_of', [g1]))), [
      'Ребёнок обоих',
      'Ребёнок первой',
    ]);
    // Нет мысли, у которой есть И g1, И g3.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'parents' }, 'all_of', [g1, g3]))), []);
    // Пустой список — вакуумно истинно (ср. «все в» без значений, сценарий c76f688b).
    assert.equal(runAst(ndb, ast(leaf({ kind: 'parents' }, 'all_of', []))).length, 7);
  });

  it('наборные по «Потомкам»: any_of ≡ in, none_of ≡ not_in, all_of — «есть все перечисленные»', () => {
    const ndb = createInMemoryNetworkDb();
    const { both, one, other } = seedSetOperatorFixture(ndb);
    const kids = [both, one];

    // Паритет: потомки g1 = {both, one}, потомок g2 = {both}, потомок g3 = {other}.
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'children' }, 'any_of', kids))),
      runAst(ndb, ast(leaf({ kind: 'children' }, 'in', kids))),
    );
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'children' }, 'any_of', kids))), ['Группа 1', 'Группа 2']);
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'children' }, 'none_of', kids))),
      runAst(ndb, ast(leaf({ kind: 'children' }, 'not_in', kids))),
    );
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'children' }, 'none_of', kids))), [
      'Группа 3',
      'Ребёнок обоих',
      'Ребёнок первой',
      'Ребёнок третьей',
      'Сирота',
    ]);

    // all_of — среди потомков есть КАЖДЫЙ перечисленный.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'children' }, 'all_of', kids))), ['Группа 1']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'children' }, 'all_of', [both]))), ['Группа 1', 'Группа 2']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'children' }, 'all_of', [both, other]))), []);
  });

  it('старый сохранённый отбор: наборный оператор на структурном операнде применяется без 422 (759eedeb)', () => {
    const ndb = createInMemoryNetworkDb();
    const { g1, g2, g3, other } = seedSetOperatorFixture(ndb);
    // Ровно та форма, что сохранил прежний конструктор: лист AST со СПИСКОМ id.
    for (const kind of ['parents', 'children'] as const) {
      for (const operator of ['any_of', 'all_of', 'none_of'] as const) {
        const titles = runAst(ndb, ast(leaf({ kind }, operator, [g1, g2])));
        assert.ok(Array.isArray(titles), `${kind} ${operator}: исполнение без ошибки`);
      }
      // Индивидуальный id тоже принимается (не только оба «групповых»): у
      // «Родителей» — id родителя, у «Потомков» — id потомка.
      const single = kind === 'parents' ? g3 : other;
      assert.ok(runAst(ndb, ast(leaf({ kind }, 'any_of', [single]))).length >= 1, `${kind}: одиночный id в наборе`);
    }
  });

  it('count on attachments and chronology; «не между» отрицает', () => {
    const ndb = createInMemoryNetworkDb();
    const many = seedThought(ndb, 'С вложениями');
    const one = seedThought(ndb, 'С одним вложением');
    seedAttachment(ndb, many);
    seedAttachment(ndb, many);
    seedAttachment(ndb, one);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'attachments' }, 'gte', 2))), ['С вложениями']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'attachments' }, 'between', [1, 1]))), ['С одним вложением']);

    const diary = seedThought(ndb, 'С дневником');
    seedChronology(ndb, diary);
    seedChronology(ndb, diary);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'chronology' }, 'eq', 2))), ['С дневником']);
    // «Не между [0,1]» = количество > 1 → только мысль с двумя записями.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'chronology' }, 'not_between', [0, 1]))), ['С дневником']);
  });

  it('count on link property: both sides (direction) and «count = 0»', () => {
    const ndb = createInMemoryNetworkDb();
    const lt = seedLinkType(ndb, 'зависит от', 'нужен для');
    const prop = seedProperty(ndb, 'зависит от', 'link', { link_type_id: lt, direction: 'out' });
    const a = seedThought(ndb, 'A');
    const b = seedThought(ndb, 'B');
    const hub = seedThought(ndb, 'Хаб');
    seedLink(ndb, a, hub, lt);
    seedLink(ndb, b, hub, lt);

    // Прямая сторона (out): из A/B по одному ребру, у хаба ноль.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'eq', 0))), ['Хаб']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'gte', 1))), ['A', 'B']);
    // Обратная сторона (in): у хаба два входящих ребра.
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'property', property_id: prop, direction: 'in' }, 'eq', 2))),
      ['Хаб'],
    );
  });

  it('count on multiple scalar property (url JSON array and text comma-joined)', () => {
    const ndb = createInMemoryNetworkDb();
    const urlProp = seedProperty(ndb, 'сайты', 'url', { multiple: true });
    const textProp = seedProperty(ndb, 'города', 'text', { multiple: true });
    const u1 = seedThought(ndb, 'U1');
    const u2 = seedThought(ndb, 'U2');
    seedValue(ndb, u1, urlProp, 'url', '["https://a","https://b","https://c"]');
    seedValue(ndb, u2, urlProp, 'url', '["https://x"]');
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: urlProp }, 'eq', 3))), ['U1']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: urlProp }, 'gt', 1))), ['U1']);

    const t1 = seedThought(ndb, 'T1');
    seedValue(ndb, t1, textProp, 'text', 'Москва, Питер, Тверь');
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: textProp }, 'eq', 3))), ['T1']);
  });

  it('scalar comparisons: numbers, dates, strings (lexicographic), «между» inclusive', () => {
    const ndb = createInMemoryNetworkDb();
    const num = seedProperty(ndb, 'оценка', 'number');
    const date = seedProperty(ndb, 'срок', 'date');
    const n1 = seedThought(ndb, 'N1');
    const n2 = seedThought(ndb, 'N2');
    seedValue(ndb, n1, num, 'number', 1);
    seedValue(ndb, n2, num, 'number', 10);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: num }, 'gt', 5))), ['N2']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: num }, 'between', [1, 5]))), ['N1']);

    const d1 = seedThought(ndb, 'D1');
    const d2 = seedThought(ndb, 'D2');
    seedValue(ndb, d1, date, 'date', '2024-01-01');
    seedValue(ndb, d2, date, 'date', '2024-06-01');
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: date }, 'between', ['2024-01-01', '2024-03-01']))), ['D1']);

    // Строки (лексикографически) — отдельная сеть: у всех мыслей значение есть,
    // поэтому отрицание «не между» видно без примеси отсутствующих значений.
    const tdb = createInMemoryNetworkDb();
    const tprop = seedProperty(tdb, 'имя', 'text');
    seedValue(tdb, seedThought(tdb, 'S1'), tprop, 'text', 'apple');
    seedValue(tdb, seedThought(tdb, 'S2'), tprop, 'text', 'banana');
    assert.deepEqual(runAst(tdb, ast(leaf({ kind: 'property', property_id: tprop }, 'gt', 'apple'))), ['S2']);
    assert.deepEqual(runAst(tdb, ast(leaf({ kind: 'property', property_id: tprop }, 'not_between', ['a', 'z']))), []);
  });

  it('текстовые операторы регистронезависимы (ADR 9779dd21): eq/ne/contains/in и строковые gt/lt', () => {
    const ndb = createInMemoryNetworkDb();
    const prop = seedProperty(ndb, 'статус', 'text');
    seedValue(ndb, seedThought(ndb, 'Мысль C'), prop, 'text', 'Черновик');
    seedValue(ndb, seedThought(ndb, 'Мысль Z'), prop, 'text', 'закрыто');
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'eq', 'черновик'))), ['Мысль C']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'ne', 'ЧЕРНОВИК'))), ['Мысль Z']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'contains', 'ЕРН'))), ['Мысль C']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'in', ['черновик']))), ['Мысль C']);
    // Строковые «больше/меньше» — тоже регистронезависимы ('ч' > 'п' > 'з').
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'gt', 'П'))), ['Мысль C']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'lt', 'п'))), ['Мысль Z']);
  });

  it('множественное свойство без значения = пустой набор: is_empty и «количество = 0» (блокер 2)', () => {
    const ndb = createInMemoryNetworkDb();
    const urlProp = seedProperty(ndb, 'сайты', 'url', { multiple: true });
    const withValue = seedThought(ndb, 'Есть');
    seedThought(ndb, 'Нет');
    seedValue(ndb, withValue, urlProp, 'url', '["https://a","https://b"]');
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: urlProp }, 'is_empty'))), ['Нет']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: urlProp }, 'not_empty'))), ['Есть']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: urlProp }, 'eq', 0))), ['Нет']);
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: urlProp }, 'eq', 2))), ['Есть']);
    // «Не между [1,1]» = количество вне диапазона: и 0, и 2 — вне → обе мысли.
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'property', property_id: urlProp }, 'not_between', [1, 1]))),
      ['Есть', 'Нет'],
    );
  });

  it('явный entity.direction учитывается в eq/in свойства-связи (блокер 3)', () => {
    const ndb = createInMemoryNetworkDb();
    const lt = seedLinkType(ndb, 'зависит от', 'нужен для');
    const prop = seedProperty(ndb, 'зависит от', 'link', { link_type_id: lt, direction: 'out' });
    const a = seedThought(ndb, 'A');
    seedThought(ndb, 'B');
    const hub = seedThought(ndb, 'Хаб');
    seedLink(ndb, a, hub, lt);
    // Прямая сторона (out) по цели A — рёбер нет; обратная (in) — у хаба есть
    // входящее от A.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'eq', a))), []);
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'property', property_id: prop, direction: 'in' }, 'eq', a))),
      ['Хаб'],
    );
    // Обратное имя свойства-связи даёт ту же обратную сторону.
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'property', property: 'нужен для' }, 'in', [a]))),
      ['Хаб'],
    );
  });

  it('«имеет свойство»: thought effective+individual set; type effective set with inheritance', () => {
    const ndb = createInMemoryNetworkDb();
    const parentType = seedThoughtType(ndb, 'работа');
    const childType = seedThoughtType(ndb, 'задача', parentType);
    const otherType = seedThoughtType(ndb, 'прочее');
    const prop = seedProperty(ndb, 'статус', 'text');
    // Свойство привязано к родительскому типу — эффективно и для потомка.
    bindProperty(ndb, parentType, prop);
    seedThought(ndb, 'Наследник', { type_id: childType });
    const individual = seedThought(ndb, 'Индивидуальный', { type_id: otherType });
    seedValue(ndb, individual, prop, 'text', 'черновик');
    seedThought(ndb, 'Пустой', { type_id: otherType });

    // Мысль: эффективный набор типа (наследование) + индивидуальное значение.
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'properties' }, 'has', [prop]))),
      ['Индивидуальный', 'Наследник'],
    );
    // Тип: эффективные свойства самого типа с наследованием.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'type' }, 'has', [prop]))), ['Наследник']);
    assert.deepEqual(
      runAst(ndb, ast(leaf({ kind: 'type' }, 'not_has', [prop]))),
      ['Индивидуальный', 'Пустой'],
    );
  });

  it('«Найти слова»: области чекбоксами; ни одной (в т.ч. без scope) — условие отключено', () => {
    const ndb = createInMemoryNetworkDb();
    seedThought(ndb, 'Альфа мысль');
    seedThought(ndb, 'Бета');
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'keywords', scope: ['title'] }, 'matches', 'альфа'))), ['Альфа мысль']);
    // Пустой набор областей — условие отключено: лист никого не отсекает.
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'keywords', scope: [] }, 'matches', 'альфа'))), ['Альфа мысль', 'Бета']);
    // Отсутствие scope — тоже отключено (режима «искать везде» нет).
    assert.deepEqual(runAst(ndb, ast(leaf({ kind: 'keywords' }, 'matches', 'альфа'))), ['Альфа мысль', 'Бета']);
  });

  it('honest unsupported for other subprojects: subqueries and foreign operands', () => {
    const ndb = createInMemoryNetworkDb();
    const prop = seedProperty(ndb, 'срок', 'date');
    const cases: FilterAst[] = [
      ast(leaf({ kind: 'property', property_id: prop }, 'in', { query: leaf({ kind: 'type' }, 'in', ['t']), operator: 'in' })),
      // «В иерархии» поддержана (задача e62aa4db) только для родителей/потомков,
      // типа и свойства-ссылки; чужой операнд честно отдаёт unsupported.
      ast(leaf({ kind: 'attachments' }, 'in_hierarchy', ['t'])),
    ];
    for (const tree of cases) {
      assert.throws(
        () => runAst(ndb, tree),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
    }
  });
});
