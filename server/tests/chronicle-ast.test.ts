/**
 * Отбор хроники на общий AST (задача 4752b065; требования 62475a6e «операнды
 * профиля», 0c83819c «REST/MCP компилируется в общий AST», ADR 06a15c16
 * «двухфазность», ADR 3301223f «keyword_scope»).
 *
 * Покрытие:
 *   1. Сценарий 130908bf «дневник — записи месяца с целями-тратами»: время
 *      записи между `$monthStart`/`$monthEnd` + заголовок содержит «расход» +
 *      «Цели» в под-выборке мыслей (двухфазность, хотя бы одна цель).
 *   2. Пограничный сценарий 31b6425b: запись без времени не проходит условие по
 *      времени; запись без целей не проходит «Цели»; исполнение не падает.
 *   3. XOR `ast` ↔ плоские критерии; видимость по профилю хроники.
 *   4. Компилятор: плоское тело и эквивалентное AST дают один набор (путём А/Б).
 *   5. «Цели»: расширение на связь-цель, `is_empty`/`not_empty`/`all_of`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { EtnError, FILTER_AST_VERSION, type FilterAst } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createComment, createCommentWithTargets } from '../src/domain/comment-service.js';
import { parseChronicleQueryBody, queryChronicle } from '../src/domain/chronicle-service.js';

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
const NOW = () => new Date('2024-03-15T12:00:00.000Z');

function seedThought(ndb: NetworkDb, title: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             type_id, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 0, 0, NULL, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase());
  return id;
}

function seedLink(ndb: NetworkDb, source: string, target: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, NULL, 1, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(id, source, target);
  return id;
}

function seedPropertyDefinition(ndb: NetworkDb, key: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, '00000000-0000-4000-8000-0000000000ba5e', ?, lower(?), 'text', NULL, NULL, '2024', '2024')`,
    )
    .run(id, key, key);
  return id;
}

function seedPropertyValue(ndb: NetworkDb, thoughtId: string, propertyId: string, value: string): void {
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, value_text, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

/**
 * Прямая вставка хроно-комментария (обход домена) — для «без целей» (нет
 * `comment_targets`) и легаси-состояний. `owner` заполняет строку комментария,
 * `attach` управляет наличием привязки в `comment_targets` (основа отбора).
 */
function rawComment(
  ndb: NetworkDb,
  opts: {
    title: string;
    body: string;
    valid_from: string;
    owner: { type: 'thought' | 'link'; id: string };
    attach: boolean;
  },
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO comments (id, layer_id, owner_type, owner_id, kind, title, body_md, body_html,
                             valid_from, valid_to, use_time, version,
                             created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 'chronological', ?, ?, ?, ?, ?, 0, 1, '2024', '2024', 'u', 'u', 0, 0)`,
    )
    .run(
      id,
      ndb.layerId,
      opts.owner.type,
      opts.owner.id,
      opts.title,
      opts.body,
      `<p>${opts.body}</p>`,
      opts.valid_from,
      opts.valid_from,
    );
  if (opts.attach) {
    ndb
      .prepare(
        `INSERT INTO comment_targets (id, comment_id, owner_type, owner_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(randomUUID(), id, opts.owner.type, opts.owner.id);
  }
  return id;
}

function runAst(ndb: NetworkDb, filter: FilterAst['filter']): { ids: string[]; total: number } {
  const request = parseChronicleQueryBody(
    { ast: { version: FILTER_AST_VERSION, filter }, order: 'asc', limit: 100, offset: 0 },
    'test',
  );
  const res = queryChronicle(ndb, request, { userId: USER, now: NOW, withTime: true });
  return { ids: res.rows.map((r) => r.id), total: res.total };
}

describe('хроника: отбор на общий AST (задача 4752b065)', { skip: !nativeAvailable() }, () => {
  it('сценарий 130908bf: время между $monthStart/$monthEnd + «расход» в заголовке + цели-траты', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const pSum = seedPropertyDefinition(ndb, 'Сумма расхода');
      const pCost = seedPropertyDefinition(ndb, 'Стоимость покупки');
      const expense1 = seedThought(ndb, 'Еда');
      const expense2 = seedThought(ndb, 'Такси');
      const plain = seedThought(ndb, 'Прочее');
      seedPropertyValue(ndb, expense1, pSum, '500');

      const rec1 = createComment(
        ndb, 'thought', expense1,
        { kind: 'chronological', title: 'Расход на еду', body_md: 'продукты', valid_from: '2024-03-05T10:00:00.000Z' }, USER,
      ).id;
      // Цель не попала в под-выборку (у неё нет «Суммы расхода»/«Стоимости покупки»).
      createComment(
        ndb, 'thought', expense2,
        { kind: 'chronological', title: 'Расход такси', body_md: 'поездка', valid_from: '2024-03-06T10:00:00.000Z' }, USER,
      );
      // Вне месяца.
      createComment(
        ndb, 'thought', expense1,
        { kind: 'chronological', title: 'Расход старая', body_md: 'архив', valid_from: '2024-02-01T10:00:00.000Z' }, USER,
      );
      // Цель-СВЯЗЬ, конец которой (expense1) в под-выборке — расширение семантики.
      const link = seedLink(ndb, expense1, plain);
      const rec4 = createComment(
        ndb, 'link', link,
        { kind: 'chronological', title: 'Расход по связи', body_md: 'связь', valid_from: '2024-03-07T10:00:00.000Z' }, USER,
      ).id;
      // Мысль-цель без свойств.
      createComment(
        ndb, 'thought', plain,
        { kind: 'chronological', title: 'Расход чужой', body_md: 'мимо', valid_from: '2024-03-08T10:00:00.000Z' }, USER,
      );

      const filter: FilterAst['filter'] = {
        op: 'and',
        children: [
          { entity: { kind: 'record_time' }, operator: 'between', value: [{ token: '$monthStart' }, { token: '$monthEnd' }] },
          { entity: { kind: 'record_title' }, operator: 'contains', value: 'расход' },
          {
            entity: { kind: 'targets' },
            operator: 'in',
            value: {
              query: {
                op: 'or',
                children: [
                  { entity: { kind: 'property', property_id: pSum }, operator: 'not_empty' },
                  { entity: { kind: 'property', property_id: pCost }, operator: 'not_empty' },
                ],
              },
              operator: 'in',
            },
          },
        ],
      };
      const { ids, total } = runAst(ndb, filter);
      assert.equal(total, 2, 'две записи месяца: цель-мысль и цель-связь');
      assert.deepEqual(ids, [rec1, rec4], 'порядок по valid_from asc; чужие/вне месяца/вне под-выборки отсеяны');
    } finally {
      ndb.close();
    }
  });

  it('пограничный 31b6425b: запись без целей и запись вне времени не проходят условия, исполнение не падает', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const pSum = seedPropertyDefinition(ndb, 'Сумма расхода');
      const expense = seedThought(ndb, 'Еда');
      seedPropertyValue(ndb, expense, pSum, '500');

      const inMonth = createComment(
        ndb, 'thought', expense,
        { kind: 'chronological', title: 'Расход', body_md: 'x', valid_from: '2024-03-05T10:00:00.000Z' }, USER,
      ).id;
      // Запись без целей: строка комментария есть, привязок в `comment_targets` нет.
      // (После миграции 046 `valid_from` хроно-записи NOT NULL — «без времени»
      // как NULL-состояние невыразимо; условие по времени для отсутствующей
      // характеристики проверяется на записи вне периода.)
      const orphan = rawComment(ndb, {
        title: 'Расход без целей', body: 'x', valid_from: '2024-03-09T00:00:00.000Z',
        owner: { type: 'thought', id: expense }, attach: false,
      });
      // Запись вне периода (характеристика «время» не удовлетворяет условию).
      const outOfRange = rawComment(ndb, {
        title: 'Расход старая', body: 'x', valid_from: '2024-02-01T00:00:00.000Z',
        owner: { type: 'thought', id: expense }, attach: true,
      });

      const timeFilter: FilterAst['filter'] = {
        op: 'and',
        children: [
          { entity: { kind: 'record_time' }, operator: 'between', value: [{ token: '$monthStart' }, { token: '$monthEnd' }] },
          { entity: { kind: 'record_title' }, operator: 'contains', value: 'расход' },
        ],
      };
      const timeRes = runAst(ndb, timeFilter);
      assert.deepEqual(timeRes.ids, [inMonth, orphan], 'обе записи месяца; вне периода — отсеяна');
      assert.ok(!timeRes.ids.includes(outOfRange), 'запись вне периода не проходит по времени');

      const targetsFilter: FilterAst['filter'] = {
        entity: { kind: 'targets' },
        operator: 'not_empty',
      };
      const targetsRes = runAst(ndb, targetsFilter);
      assert.ok(targetsRes.ids.includes(inMonth));
      assert.ok(!targetsRes.ids.includes(orphan), 'запись без привязок не проходит «Цели»');
      assert.equal(targetsRes.ids.length, 2, 'три записи, одна без привязок — не проходит');

      const targetsIn: FilterAst['filter'] = {
        entity: { kind: 'targets' },
        operator: 'in',
        value: {
          query: { entity: { kind: 'property', property_id: pSum }, operator: 'not_empty' },
          operator: 'in',
        },
      };
      assert.ok(runAst(ndb, targetsIn).ids.includes(inMonth), 'цель в под-выборке — проходит');
      assert.ok(!runAst(ndb, targetsIn).ids.includes(orphan), 'запись без целей и здесь не проходит');
    } finally {
      ndb.close();
    }
  });

  it('включающие границы «Времени записи»: ровно на $monthStart проходит between/gte; $monthStart+1d не проходит lte $monthStart', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const thought = seedThought(ndb, 'Границы');
      // Запись ровно на границе начала месяца (valid_from == valid_to == $monthStart).
      const onStart = createComment(
        ndb, 'thought', thought,
        { kind: 'chronological', title: 'граница', body_md: 'x', valid_from: '2024-03-01T00:00:00.000Z' }, USER,
      ).id;
      // Запись на $monthStart+1d.
      const dayAfter = createComment(
        ndb, 'thought', thought,
        { kind: 'chronological', title: 'день+1', body_md: 'x', valid_from: '2024-03-02T00:00:00.000Z' }, USER,
      ).id;

      const between: FilterAst['filter'] = {
        entity: { kind: 'record_time' },
        operator: 'between',
        value: [{ token: '$monthStart' }, { token: '$monthEnd' }],
      };
      // Границы ВКЛЮЧИТЕЛЬНЫ: запись ровно на $monthStart входит. Мутация
      // «эксклюзивный between» (`>`/`<` вместо `>=`/`<=`) роняет это утверждение.
      assert.deepEqual(runAst(ndb, between).ids, [onStart, dayAfter], 'between включает обе границы');

      const gte: FilterAst['filter'] = {
        entity: { kind: 'record_time' }, operator: 'gte', value: { token: '$monthStart' },
      };
      assert.deepEqual(runAst(ndb, gte).ids, [onStart, dayAfter], 'gte включает запись ровно на границе');

      const lte: FilterAst['filter'] = {
        entity: { kind: 'record_time' }, operator: 'lte', value: { token: '$monthStart' },
      };
      assert.deepEqual(runAst(ndb, lte).ids, [onStart], 'lte включает границу и отсекает $monthStart+1d');
      assert.ok(!runAst(ndb, lte).ids.includes(dayAfter), '$monthStart+1d не проходит lte $monthStart');
    } finally {
      ndb.close();
    }
  });

  it('XOR: `ast` несовместим с плоскими критериями — VALIDATION_ERROR', () => {
    assert.throws(
      () => parseChronicleQueryBody(
        { ast: { version: FILTER_AST_VERSION, filter: { op: 'and', children: [] } }, keywords: 'x' },
        'r',
      ),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR' && /несовместимо/.test(e.message),
    );
    // Пагинация и order допустимы с AST.
    assert.doesNotThrow(() =>
      parseChronicleQueryBody(
        { ast: { version: FILTER_AST_VERSION, filter: { op: 'and', children: [] } }, limit: 10, offset: 5, order: 'desc' },
        'r',
      ),
    );
  });

  it('видимость по профилю: чужой операнд и чужой оператор отвергаются', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      // Операнд мыслей (`active`) невидим в профиле хроники.
      assert.throws(
        () => runAst(ndb, { entity: { kind: 'active' }, operator: 'eq', value: true } as FilterAst['filter']),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
      // «Текст записи» поддерживает строковые операторы (содержит/равно — ошибка
      // 609deba0 п.5), но не числовое сравнение.
      assert.doesNotThrow(() =>
        runAst(ndb, { entity: { kind: 'record_body' }, operator: 'contains', value: 'x' } as FilterAst['filter']),
      );
      assert.throws(
        () => runAst(ndb, { entity: { kind: 'record_body' }, operator: 'gt', value: 'x' } as FilterAst['filter']),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
      );
      // Видимый операнд записи — без ошибки.
      assert.doesNotThrow(() => runAst(ndb, { entity: { kind: 'record_title' }, operator: 'matches', value: 'x' }));
    } finally {
      ndb.close();
    }
  });

  it('компилятор: плоское тело (пути А/Б + период) и эквивалентное AST дают один набор', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const food = seedThought(ndb, 'Еда');
      const other = seedThought(ndb, 'Прочее');
      const a = createComment(
        ndb, 'thought', food,
        { kind: 'chronological', title: 'закупка', body_md: 'продукты', valid_from: '2024-03-05T10:00:00.000Z' }, USER,
      ).id;
      const b = createComment(
        ndb, 'thought', other,
        { kind: 'chronological', title: 'поездка', body_md: 'такси', valid_from: '2024-03-06T10:00:00.000Z' }, USER,
      ).id;

      // Плоское тело: слова по телу/заголовку записи (путь Б) + период.
      const flatReq = parseChronicleQueryBody(
        { keywords: 'продукты', date_from: '2024-03-01', date_to: '2024-03-31', order: 'asc', limit: 100, offset: 0 },
        'r',
      );
      const flat = queryChronicle(ndb, flatReq, { userId: USER, now: NOW, withTime: true }).rows.map((r) => r.id);

      // Эквивалент в AST: тело записи «Есть слова» И период.
      const astFilter: FilterAst['filter'] = {
        op: 'and',
        children: [
          { entity: { kind: 'record_body' }, operator: 'matches', value: 'продукты' },
          { entity: { kind: 'record_time' }, operator: 'gte', value: '2024-03-01' },
          { entity: { kind: 'record_time' }, operator: 'lte', value: '2024-03-31' },
        ],
      };
      assert.deepEqual(runAst(ndb, astFilter).ids, flat, 'плоское тело и AST эквивалентны');
      assert.deepEqual(flat, [a], 'совпадение по телу записи; вторая запись отсеяна');
      assert.ok(!flat.includes(b));
    } finally {
      ndb.close();
    }
  });

  it('«Цели»: быстрое `is_empty` находит записи без привязок; `all_of` — все цели в под-выборке', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const pSum = seedPropertyDefinition(ndb, 'Сумма расхода');
      const good = seedThought(ndb, 'Еда');
      const bad = seedThought(ndb, 'Такси');
      seedPropertyValue(ndb, good, pSum, '500');

      const goodRec = createComment(
        ndb, 'thought', good,
        { kind: 'chronological', title: 'r1', body_md: 'x', valid_from: '2024-03-05T00:00:00.000Z' }, USER,
      ).id;
      // Две цели: одна подходит, другая нет → all_of не проходит.
      const mixedRec = createCommentWithTargets(
        ndb,
        [{ owner_type: 'thought', owner_id: good }, { owner_type: 'thought', owner_id: bad }],
        { kind: 'chronological', title: 'r2', body_md: 'x', valid_from: '2024-03-06T00:00:00.000Z' }, USER,
      ).id;
      const orphanRec = rawComment(ndb, {
        title: 'r3', body: 'x', valid_from: '2024-03-07T00:00:00.000Z',
        owner: { type: 'thought', id: bad }, attach: false,
      });

      assert.deepEqual(runAst(ndb, { entity: { kind: 'targets' }, operator: 'is_empty' }).ids, [orphanRec]);

      const allOf: FilterAst['filter'] = {
        entity: { kind: 'targets' },
        operator: 'all_of',
        value: {
          query: { entity: { kind: 'property', property_id: pSum }, operator: 'not_empty' },
          operator: 'all_in',
        },
      };
      assert.deepEqual(runAst(ndb, allOf).ids, [goodRec], 'смешанная запись (r2) и запись без целей не проходят all_of');
      assert.ok(!runAst(ndb, allOf).ids.includes(mixedRec));
    } finally {
      ndb.close();
    }
  });

  it('«Цели»: список мыслей и «в иерархии» (ошибка 609deba0 п.1)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const root = seedThought(ndb, 'Поездка');
      const child = seedThought(ndb, 'Билеты');
      seedLink(ndb, root, child); // структурная связь: root → child

      const childRec = createCommentWithTargets(
        ndb,
        [{ owner_type: 'thought', owner_id: child }],
        { kind: 'chronological', title: 'r1', body_md: 'x', valid_from: '2024-03-05T00:00:00.000Z' }, USER,
      ).id;
      const rootRec = createCommentWithTargets(
        ndb,
        [{ owner_type: 'thought', owner_id: root }],
        { kind: 'chronological', title: 'r2', body_md: 'x', valid_from: '2024-03-06T00:00:00.000Z' }, USER,
      ).id;

      // «Список»: значение — явный набор id (без под-выборки).
      const listIn: FilterAst['filter'] = { entity: { kind: 'targets' }, operator: 'in', value: [child] };
      assert.deepEqual(runAst(ndb, listIn).ids, [childRec], 'список целей — вхождение цели');

      // «В иерархии»: корень и его структурные потомки.
      const inHierarchy: FilterAst['filter'] = { entity: { kind: 'targets' }, operator: 'in_hierarchy', value: [root] };
      assert.deepEqual(
        runAst(ndb, inHierarchy).ids.sort(),
        [childRec, rootRec].sort(),
        'цель-потомок выбранной мысли проходит «в иерархии»',
      );

      // «Не в иерархии»: запись без целей не проходит (строгость как у not_in).
      const notInHierarchy: FilterAst['filter'] = {
        entity: { kind: 'targets' }, operator: 'not_in_hierarchy', value: [child],
      };
      assert.deepEqual(runAst(ndb, notInHierarchy).ids, [rootRec], 'root вне поддерева child проходит not_in_hierarchy');
    } finally {
      ndb.close();
    }
  });
});

/**
 * Условие авторства записи — значения-ТОКЕНЫ (задача 347b307e, арбитраж
 * оркестратора 2026-10-14).
 *
 * Набор «Мои записи за неделю» панели «Дневника» несёт `record_author eq $user`.
 * Прежде значение-токен в `record_author` молча терялось (`1=1`) — набор
 * показал бы ВСЕ записи. Теперь токен раскрывается (`$user` — владелец ключа), а
 * нераскрытый/недопустимый/пустой — ЯВНАЯ ошибка, а не молчаливое `1=1`.
 */
describe('хроника: авторство записи раскрывает токены (задача 347b307e)', { skip: !nativeAvailable() }, () => {
  it('record_author eq $user видит только свои записи', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Мысль дневника');
      const mine = createComment(
        ndb, 'thought', target,
        { kind: 'chronological', title: 'Моя', body_md: 'x', valid_from: '2024-03-05T00:00:00.000Z' }, USER,
      ).id;
      const other = createComment(
        ndb, 'thought', target,
        { kind: 'chronological', title: 'Чужая', body_md: 'x', valid_from: '2024-03-06T00:00:00.000Z' }, 'user-2',
      ).id;

      const mineOnly: FilterAst['filter'] = {
        entity: { kind: 'record_author' }, operator: 'eq', value: { token: '$user' },
      };
      assert.deepEqual(runAst(ndb, mineOnly).ids, [mine], '$user → только записи владельца ключа');

      const notMine: FilterAst['filter'] = {
        entity: { kind: 'record_author' }, operator: 'ne', value: { token: '$user' },
      };
      assert.deepEqual(runAst(ndb, notMine).ids, [other], 'ne $user → только чужие записи');

      const list: FilterAst['filter'] = {
        entity: { kind: 'record_author' }, operator: 'in', value: [{ token: '$user' }, { token: '$user' }],
      };
      assert.deepEqual(runAst(ndb, list).ids, [mine], 'список с токеном раскрывается поэлементно');
    } finally {
      ndb.close();
    }
  });

  it('нераскрытый/недопустимый/пустой токен авторства — VALIDATION_ERROR, не молчаливое 1=1', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Мысль');
      createComment(
        ndb, 'thought', target,
        { kind: 'chronological', title: 'r', body_md: 'x', valid_from: '2024-03-05T00:00:00.000Z' }, USER,
      );

      const unknownToken: FilterAst['filter'] = {
        entity: { kind: 'record_author' }, operator: 'eq', value: { token: '$foo' },
      };
      assert.throws(
        () => runAst(ndb, unknownToken),
        (err: unknown) => err instanceof EtnError && err.code === 'VALIDATION_ERROR',
        'неизвестный токен отвергается',
      );

      const thoughtToken: FilterAst['filter'] = {
        entity: { kind: 'record_author' }, operator: 'eq', value: { token: '$thought.author' },
      };
      assert.throws(
        () => runAst(ndb, thoughtToken),
        (err: unknown) => err instanceof EtnError && err.code === 'VALIDATION_ERROR',
        'токен контекста мысли недопустим в условии авторства',
      );

      const emptyValue: FilterAst['filter'] = { entity: { kind: 'record_author' }, operator: 'eq' };
      assert.throws(
        () => runAst(ndb, emptyValue),
        (err: unknown) => err instanceof EtnError && err.code === 'VALIDATION_ERROR',
        'пустое значение в eq — явная ошибка, а не 1=1',
      );
    } finally {
      ndb.close();
    }
  });

  it('record_author eq $user без пользователя запроса — явная диагностика, а не «не задано значение»', () => {
    // Путь, который падал в parity-прогоне (ошибка 1936c70e): сохранённое тело
    // набора уходит в queryChronicle БЕЗ `opts.userId`, `$user` подставляется
    // пустой строкой, и прежний код сообщал невнятное «не задано значение
    // условия». Теперь диагностика называет причину и одинакова у всех входов.
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Мысль дневника');
      createComment(
        ndb, 'thought', target,
        // Запись внутри недели, вычисленной от `NOW` (пн 2024-03-11 … вс 2024-03-17).
        { kind: 'chronological', title: 'Моя', body_md: 'x', valid_from: '2024-03-14T10:00:00.000Z' }, USER,
      );
      // Сохранённое тело набора («Мои записи за неделю») как в БД: { ast, order }.
      const request = parseChronicleQueryBody(
        {
          ast: {
            version: FILTER_AST_VERSION,
            filter: {
              op: 'and',
              children: [
                { entity: { kind: 'record_time' }, operator: 'between', value: [{ token: '$weekStart' }, { token: '$weekEnd' }] },
                { entity: { kind: 'record_author' }, operator: 'eq', value: { token: '$user' } },
              ],
            },
          },
          order: 'asc',
          limit: 100,
          offset: 0,
        },
        'test',
      );
      // Без пользователя запроса — явная ошибка с настоящей причиной.
      assert.throws(
        () => queryChronicle(ndb, request, { now: NOW, withTime: true }),
        (err: unknown) =>
          err instanceof EtnError &&
          err.code === 'VALIDATION_ERROR' &&
          /«\$user»/.test(err.message) &&
          /пользовател/i.test(err.message),
        'без пользователя запроса токен $user — явная ошибка, а не пустое условие',
      );
      // С пользователем запроса (как в REST/MCP) набор исполняется — только свои.
      const mine = queryChronicle(ndb, request, { userId: USER, now: NOW, withTime: true });
      assert.equal(mine.total, 1, 'набор «Мои записи за неделю» исполняется с пользователем запроса');
    } finally {
      ndb.close();
    }
  });

  it('время записи: равно/не равно «голой даты» — пересечение интервала с сутками (ошибка 03db4cb0)', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const thought = seedThought(ndb, 'Сутки');
      // Запись внутри 15-го.
      const inDay = createComment(
        ndb, 'thought', thought,
        { kind: 'chronological', title: 'в сутках', body_md: 'x', valid_from: '2024-03-15T05:00:00.000Z', valid_to: '2024-03-15T06:00:00.000Z' }, USER,
      ).id;
      // Длинный интервал, ПЕРЕСЕКАЮЩИЙ 15-е (равенство дате — «попадание в период»).
      const span = createComment(
        ndb, 'thought', thought,
        { kind: 'chronological', title: 'через 15-е', body_md: 'x', valid_from: '2024-03-01T00:00:00.000Z', valid_to: '2024-03-31T00:00:00.000Z' }, USER,
      ).id;
      // Запись до суток.
      const before = createComment(
        ndb, 'thought', thought,
        { kind: 'chronological', title: 'до суток', body_md: 'x', valid_from: '2024-03-10T05:00:00.000Z', valid_to: '2024-03-10T06:00:00.000Z' }, USER,
      ).id;

      // «равно 2024-03-15» = пересечение интервала записи с сутками 15-го; порядок — по valid_from.
      assert.deepEqual(
        runAst(ndb, { entity: { kind: 'record_time' }, operator: 'eq', value: '2024-03-15' }).ids,
        [span, inDay],
        '«равно голой дате» — сутки целиком, включая интервал-пересечение',
      );
      assert.deepEqual(
        runAst(ndb, { entity: { kind: 'record_time' }, operator: 'ne', value: '2024-03-15' }).ids,
        [before],
        '«не равно голой дате» исключает сутки целиком',
      );
      // Паритет с «между» совпавших границ — та же семантика интервала.
      assert.deepEqual(
        runAst(ndb, { entity: { kind: 'record_time' }, operator: 'eq', value: '2024-03-15' }).ids,
        runAst(ndb, { entity: { kind: 'record_time' }, operator: 'between', value: ['2024-03-15', '2024-03-15'] }).ids,
        '«равно дате» = «между [дата, дата]»',
      );
      // Токен `$today` раскрывается в «голую дату» — то же покрытие суток (часы — NOW теста).
      assert.deepEqual(
        runAst(ndb, { entity: { kind: 'record_time' }, operator: 'eq', value: { token: '$today' } }).ids,
        [span, inDay],
        '«равно $today» = сутки токена',
      );
    } finally {
      ndb.close();
    }
  });
});
