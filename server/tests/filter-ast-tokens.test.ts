/**
 * Токены как значения листьев AST-исполнителя (0.13.1, задача 0f1b9892, этап 2
 * поверх T1 9c156b8c и T3 aee021c8).
 *
 * Проверяет требование «Токены отбора: календарные границы и арифметика ±N с
 * единицами» (84b52caa), ADR «профили контекста отбора» (0c02ab4f) и пограничный
 * сценарий cbc22d19 (стыки календаря):
 *   * `{ token: "$today" }` и `±N`-арифметика раскрываются сервером и матчат
 *     дату значения свойства;
 *   * «между» с обеими совпавшими границами (одиночный токен) эквивалентно
 *     равенству, границы включительны;
 *   * `$weekStart`/`$weekEnd` учитывают настройку сети «первый день недели»,
 *     переданную в `tokenContext.firstDayOfWeek`;
 *   * `$now`/`$hourStart` и `h`/`mi` в профиле без времени (`withTime: false`)
 *     дают `unresolved` (`time_context_required`);
 *   * `$thought.*` без контекста мысли неразрешим; неразрешимый токен даёт
 *     ПУСТОЙ результат с пояснением (требование b7fdab20), а не молчаливую потерю.
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
  type ThoughtQueryOptions,
} from '../src/domain/query-service.js';
import { parseFilterAst } from '../src/domain/filter-ast.js';
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

function seedDate(ndb: NetworkDb, thoughtId: string, propertyId: string, value: string): void {
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

function runAst(
  ndb: NetworkDb,
  tree: FilterAst,
  tokenContext?: ThoughtQueryOptions['tokenContext'],
): { titles: string[]; unresolved: number; reasons: string[] } {
  const req: CanonicalQueryRequest = {
    sort: 'alpha',
    order: 'asc',
    limit: 200,
    offset: 0,
    count: true,
    ast: tree,
  };
  const opts: ThoughtQueryOptions = { emptyFilterMode: 'all', maxLimit: 200 };
  if (tokenContext !== undefined) opts.tokenContext = tokenContext;
  const res = queryThoughts(ndb, 'u', req, opts);
  return {
    titles: res.items.map((i) => i.title).sort(),
    unresolved: res.unresolved?.length ?? 0,
    reasons: (res.unresolved ?? []).map((i) => i.reason),
  };
}

const leaf = (entity: Record<string, unknown>, operator: string, value?: unknown): FilterAstNode =>
  (value === undefined ? { entity, operator } : { entity, operator, value }) as FilterAstNode;

describe(
  'AST-токены: раскрытие резолвером и неразрешимость (0f1b9892)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    const nowMs = Date.parse('2026-09-09T13:37:45.123Z'); // среда

    it('$today раскрывается и матчит дату значения свойства', () => {
      const ndb = createInMemoryNetworkDb();
      const prop = seedProperty(ndb, 'срок', 'date');
      const today = seedThought(ndb, 'Сегодня');
      seedDate(ndb, today, prop, '2026-09-09');
      const tomorrow = seedThought(ndb, 'Завтра');
      seedDate(ndb, tomorrow, prop, '2026-09-10');

      const res = runAst(
        ndb,
        ast(leaf({ kind: 'property', property_id: prop }, 'eq', { token: '$today' })),
        { nowMs },
      );
      assert.deepEqual(res.titles, ['Сегодня']);
      assert.equal(res.unresolved, 0);
    });

    it('арифметика ±Nd в токене сдвигает границу', () => {
      const ndb = createInMemoryNetworkDb();
      const prop = seedProperty(ndb, 'срок', 'date');
      const plus7 = seedThought(ndb, 'Через неделю');
      seedDate(ndb, plus7, prop, '2026-09-16');
      seedThought(ndb, 'Сегодня без значения');

      const res = runAst(
        ndb,
        ast(leaf({ kind: 'property', property_id: prop }, 'eq', { token: '$today+7d' })),
        { nowMs },
      );
      assert.deepEqual(res.titles, ['Через неделю']);
      assert.equal(res.unresolved, 0);
    });

    it('клэмпинг месяцев: 31.01+1mo матчит последний день февраля', () => {
      const ndb = createInMemoryNetworkDb();
      const prop = seedProperty(ndb, 'срок', 'date');
      const feb28 = seedThought(ndb, 'Конец февраля');
      seedDate(ndb, feb28, prop, '2026-02-28');
      const jan31Ms = Date.parse('2026-01-31T10:00:00.000Z');

      const res = runAst(
        ndb,
        ast(leaf({ kind: 'property', property_id: prop }, 'eq', { token: '$today+1mo' })),
        { nowMs: jan31Ms },
      );
      assert.deepEqual(res.titles, ['Конец февраля']);
    });

    it('«между» с обеими совпавшими границами (один токен) = равенство, включительно', () => {
      const ndb = createInMemoryNetworkDb();
      const prop = seedProperty(ndb, 'срок', 'date');
      const today = seedThought(ndb, 'Ровно сегодня');
      seedDate(ndb, today, prop, '2026-09-09');
      const other = seedThought(ndb, 'Другой день');
      seedDate(ndb, other, prop, '2026-09-10');

      const res = runAst(
        ndb,
        ast(leaf({ kind: 'property', property_id: prop }, 'between', { token: '$today' })),
        { nowMs },
      );
      assert.deepEqual(res.titles, ['Ровно сегодня']);
    });

    it('$weekStart учитывает первый день недели сети из tokenContext', () => {
      const ndb = createInMemoryNetworkDb();
      const prop = seedProperty(ndb, 'срок', 'date');
      const sunday = seedThought(ndb, 'Воскресенье 06.09');
      seedDate(ndb, sunday, prop, '2026-09-06');
      const monday = seedThought(ndb, 'Понедельник 07.09');
      seedDate(ndb, monday, prop, '2026-09-07');

      // Первый день недели — понедельник: $weekStart = 07.09.
      const asMonday = runAst(
        ndb,
        ast(leaf({ kind: 'property', property_id: prop }, 'eq', { token: '$weekStart' })),
        { nowMs, firstDayOfWeek: 1 },
      );
      assert.deepEqual(asMonday.titles, ['Понедельник 07.09']);

      // Первый день недели — воскресенье: $weekStart = 06.09.
      const asSunday = runAst(
        ndb,
        ast(leaf({ kind: 'property', property_id: prop }, 'eq', { token: '$weekStart' })),
        { nowMs, firstDayOfWeek: 7 },
      );
      assert.deepEqual(asSunday.titles, ['Воскресенье 06.09']);
    });

    it('$now/$hourStart и h/mi в профиле без времени — unresolved, результат пуст', () => {
      const ndb = createInMemoryNetworkDb();
      const prop = seedProperty(ndb, 'срок', 'date');
      const t = seedThought(ndb, 'Есть значение');
      seedDate(ndb, t, prop, '2026-09-09');

      for (const token of ['$now', '$hourStart', '$today+1h']) {
        const res = runAst(
          ndb,
          ast(leaf({ kind: 'property', property_id: prop }, 'eq', { token })),
          { nowMs, withTime: false },
        );
        assert.deepEqual(res.titles, [], token);
        assert.equal(res.unresolved, 1, token);
        assert.deepEqual(res.reasons, ['time_context_required'], token);
      }
    });

    it('$thought.[…] без контекста мысли неразрешим → пустой результат с пояснением (b7fdab20)', () => {
      const ndb = createInMemoryNetworkDb();
      const prop = seedProperty(ndb, 'срок', 'date');
      const t = seedThought(ndb, 'Мысль');
      seedDate(ndb, t, prop, '2026-09-09');

      const res = runAst(
        ndb,
        ast(leaf({ kind: 'property', property_id: prop }, 'eq', { token: '$thought.[срок]' })),
        { nowMs },
      );
      assert.deepEqual(res.titles, []);
      assert.ok(res.unresolved >= 1, 'неразрешимый токен должен быть назван');
    });

    it('неизвестный токен — unresolved, а не молчаливая потеря условия', () => {
      const ndb = createInMemoryNetworkDb();
      const prop = seedProperty(ndb, 'срок', 'date');
      const t = seedThought(ndb, 'Мысль');
      seedDate(ndb, t, prop, '2026-09-09');

      const res = runAst(
        ndb,
        ast(leaf({ kind: 'property', property_id: prop }, 'eq', { token: '$nonexistent' })),
        { nowMs },
      );
      assert.deepEqual(res.titles, []);
      assert.deepEqual(res.reasons, ['unknown_token']);
    });
  },
);

// ============================================================================
// 2. Токены-границы в «между» (ошибка c89c2fa8): форма + исполнение обеих границ
// ============================================================================

describe('AST «между» с токенами-границами (c89c2fa8, требование 84b52caa)', () => {
  const nowMs = Date.parse('2026-09-09T13:37:45.123Z'); // среда

  const betweenTree = (value: unknown): unknown => ({
    version: FILTER_AST_VERSION,
    filter: { entity: { kind: 'created_at' }, operator: 'between', value },
  });

  it('форма принимает список из двух токенов', () => {
    const ast = parseFilterAst(
      betweenTree([{ token: '$monthStart' }, { token: '$monthEnd' }]),
    );
    assert.deepEqual((ast.filter as { value: unknown }).value, [
      { token: '$monthStart' },
      { token: '$monthEnd' },
    ]);
  });

  it('форма принимает токен + литерал (смешанные границы)', () => {
    const ast = parseFilterAst(
      betweenTree([{ token: '$weekStart-1d' }, '2026-09-30']),
    );
    assert.deepEqual((ast.filter as { value: unknown }).value, [
      { token: '$weekStart-1d' },
      '2026-09-30',
    ]);
  });

  it('форма отвергает список из одного и из трёх элементов', () => {
    for (const bad of [[{ token: '$today' }], [{ token: '$today' }, '2026-09-10', '2026-09-11']]) {
      assert.throws(
        () => parseFilterAst(betweenTree(bad)),
        (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
        JSON.stringify(bad),
      );
    }
  });

  it('форма отвергает мусорный элемент списка (не скаляр и не токен)', () => {
    assert.throws(
      () => parseFilterAst(betweenTree([{ token: '$today' }, { foo: 'bar' }])),
      (e: unknown) => e instanceof EtnError && e.code === 'VALIDATION_ERROR',
    );
  });

  it('исполнитель раскрывает ОБЕ границы-токена и сравнивает включительно', () => {
    const ndb = createInMemoryNetworkDb();
    const prop = seedProperty(ndb, 'срок', 'date');
    const inRange = seedThought(ndb, 'В диапазоне');
    seedDate(ndb, inRange, prop, '2026-09-10');
    const lowEdge = seedThought(ndb, 'Нижняя граница');
    seedDate(ndb, lowEdge, prop, '2026-09-09');
    const out = seedThought(ndb, 'Вне диапазона');
    seedDate(ndb, out, prop, '2026-09-12');

    const res = runAst(
      ndb,
      ast(leaf({ kind: 'property', property_id: prop }, 'between', [
        { token: '$today' },
        { token: '$today+2d' },
      ])),
      { nowMs },
    );
    // $today = 09-09, $today+2d = 09-11 → [09-09, 09-11] включительно.
    assert.deepEqual(res.titles, ['В диапазоне', 'Нижняя граница']);
    assert.equal(res.unresolved, 0);
  });

  it('исполнитель раскрывает токен + литерал как разные границы', () => {
    const ndb = createInMemoryNetworkDb();
    const prop = seedProperty(ndb, 'срок', 'date');
    const t = seedThought(ndb, 'Между');
    seedDate(ndb, t, prop, '2026-09-10');
    const after = seedThought(ndb, 'Позже');
    seedDate(ndb, after, prop, '2026-09-30');

    const res = runAst(
      ndb,
      ast(leaf({ kind: 'property', property_id: prop }, 'between', [
        { token: '$today' },
        '2026-09-20',
      ])),
      { nowMs },
    );
    assert.deepEqual(res.titles, ['Между']);
  });

  it('неразрешимая граница-токен → пустой результат с пояснением (обе границы видны)', () => {
    const ndb = createInMemoryNetworkDb();
    const prop = seedProperty(ndb, 'срок', 'date');
    const t = seedThought(ndb, 'Мысль');
    seedDate(ndb, t, prop, '2026-09-10');

    const res = runAst(
      ndb,
      ast(leaf({ kind: 'property', property_id: prop }, 'between', [
        { token: '$today' },
        { token: '$nonexistent' },
      ])),
      { nowMs },
    );
    assert.deepEqual(res.titles, []);
    assert.deepEqual(res.reasons, ['unknown_token']);
  });
});

describe('«между»-токены: полный путь форма → единый исполнитель (c89c2fa8)', () => {
  it('parseFilterAst → queryThoughts раскрывает обе границы', () => {
    const ndb = createInMemoryNetworkDb();
    const prop = seedProperty(ndb, 'срок', 'date');
    const a = seedThought(ndb, 'Девятое');
    seedDate(ndb, a, prop, '2026-09-09');
    const b = seedThought(ndb, 'Одиннадцатое');
    seedDate(ndb, b, prop, '2026-09-11');
    const c = seedThought(ndb, 'Двенадцатое');
    seedDate(ndb, c, prop, '2026-09-12');

    // Форма проходит валидатор и исполняется тем же движком (путь T7 — единый).
    const parsed = parseFilterAst({
      version: FILTER_AST_VERSION,
      filter: {
        entity: { kind: 'property', property_id: prop },
        operator: 'between',
        value: [{ token: '$today' }, { token: '$today+2d' }],
      },
    });
    const req: CanonicalQueryRequest = {
      sort: 'alpha', order: 'asc', limit: 200, offset: 0, count: true, ast: parsed,
    };
    const res = queryThoughts(ndb, 'u', req, {
      emptyFilterMode: 'all',
      maxLimit: 200,
      tokenContext: { nowMs: Date.parse('2026-09-09T12:00:00.000Z') },
    });
    assert.deepEqual(res.items.map((i) => i.title).sort(), ['Девятое', 'Одиннадцатое']);
    assert.equal(res.unresolved?.length ?? 0, 0);
  });
});
