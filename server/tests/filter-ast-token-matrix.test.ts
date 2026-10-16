/**
 * Матрица токенов AST — сплошная перепроверка (0.13.1, задача ccededb1 «Токены AST:
 * сплошная перепроверка всех вариантов во всех точках применения»).
 *
 * Задача-контроль по прямому требованию пользователя («Замечания визуальной
 * проверки часть 9»): «токены в AST работают неправильно… нужно перепроверить все
 * варианты». Эталон семантики — требование 3697eb65 «Токены отбора разрешаются
 * сервером относительно мысли-контекста», ADR 7c1c5bf5 «Токены отбора — закрытое
 * пространство имён», требование 1b77decd («первый день недели — настройка сети»)
 * и требование 469d8d69 («голая дата = сутки UTC»).
 *
 * Матрица: токен × операнд × ФОРМА значения × точка × условие.
 *   * токены — $today/$now, $weekStart/$weekEnd, $monthStart/$monthEnd,
 *     $yearStart/$yearEnd, $user, арифметика ±N d/w/mo/y (и ±N h/mi со временем);
 *   * операнды профиля «мысли» — created_at/updated_at, автор/редактор, свойство
 *     (дата/текст/число/булево/связь);
 *   * формы — объект `{ token }`, СТРОКА `"$…"` (плоская `definition v1` и клиент
 *     хранят токен строкой), легаси-точечные глобальные (`$week.start`…);
 *   * условия — first_day_of_week 1/7, сутки UTC и включительная верхняя граница,
 *     стыки календаря (29.02, 31.01+1mo), профиль без времени.
 *
 * Тест-долг верификации d52e4d79 — прямой тест половины, которой не было: строка
 * значения свойства, ЦЕЛИКОМ равная ИЗВЕСТНОМУ токену, трактуется как токен;
 * неизвестная `$`-строка — литерал (вторая половина уже была).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import {
  queryThoughts,
  type ThoughtQueryRequest,
  type ThoughtQueryOptions,
} from '../src/domain/query-service.js';
import { parseChronicleQueryBody, queryChronicle } from '../src/domain/chronicle-service.js';
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

/** Среда 2026-09-09 13:37:45.123Z; неделя (пн..вс) 07.09 … 13.09. */
const NOW_MS = Date.parse('2026-09-09T13:37:45.123Z');
const USER = 'me';

const leaf = (entity: Record<string, unknown>, operator: string, value?: unknown): FilterAstNode =>
  (value === undefined ? { entity, operator } : { entity, operator, value }) as FilterAstNode;

const ast = (filter: FilterAstNode): FilterAst => ({ version: FILTER_AST_VERSION, filter });

function seedThought(
  ndb: NetworkDb,
  title: string,
  opts: { id?: string; createdBy?: string; createdAt?: string; updatedAt?: string } = {},
): string {
  const id = opts.id ?? randomUUID();
  const created = opts.createdAt ?? '2024-01-01T00:00:00.000Z';
  const updated = opts.updatedAt ?? created;
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, 0, 0, 1, ?, ?, ?, ?)`,
    )
    .run(
      id,
      title,
      title.normalize('NFC').trim().toLowerCase(),
      created,
      opts.createdBy ?? 'u',
      updated,
      opts.createdBy ?? 'u',
    );
  return id;
}

function seedProperty(ndb: NetworkDb, name: string, valueType: string, config: string | null = null): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO properties (id, layer_id, name, name_key, value_type, config, description, created_at, updated_at)
       VALUES (?, ?, ?, lower(?), ?, ?, NULL, '2024', '2024')`,
    )
    .run(id, BASE_LAYER, name, name, valueType, config);
  return id;
}

const VALUE_COLUMN: Record<string, string> = {
  text: 'value_text',
  number: 'value_number',
  bool: 'value_bool',
  date: 'value_date',
  url: 'value_text',
};

function seedValue(
  ndb: NetworkDb,
  thoughtId: string,
  propertyId: string,
  valueType: string,
  value: string | number | boolean,
): void {
  const column = VALUE_COLUMN[valueType] ?? 'value_text';
  ndb
    .prepare(
      `INSERT INTO property_values (id, owner_type, owner_id, property_id, ${column}, updated_at)
       VALUES (?, 'thought', ?, ?, ?, '2024')`,
    )
    .run(randomUUID(), thoughtId, propertyId, value);
}

function seedLinkType(ndb: NetworkDb, forward: string, reverse: string): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO link_types (id, name_forward, name_forward_key, name_reverse, name_reverse_key,
                               version, created_at, updated_at, created_by)
       VALUES (?, ?, lower(?), ?, lower(?), 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'u')`,
    )
    .run(id, forward, forward, reverse, reverse);
  return id;
}

function seedTypedLink(ndb: NetworkDb, sourceId: string, targetId: string, typeId: string): void {
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(randomUUID(), sourceId, targetId, typeId);
}

function runAst(
  ndb: NetworkDb,
  tree: FilterAst,
  tokenContext?: ThoughtQueryOptions['tokenContext'],
): { titles: string[]; unresolved: number; reasons: string[] } {
  const req: ThoughtQueryRequest = {
    sort: 'alpha',
    order: 'asc',
    limit: 200,
    offset: 0,
    count: true,
    ast: tree,
  };
  const opts: ThoughtQueryOptions = { emptyFilterMode: 'all', maxLimit: 200 };
  if (tokenContext !== undefined) opts.tokenContext = tokenContext;
  const res = queryThoughts(ndb, USER, req, opts);
  return {
    titles: res.items.map((i) => i.title).sort(),
    unresolved: res.unresolved?.length ?? 0,
    reasons: (res.unresolved ?? []).map((i) => i.reason),
  };
}

const ctx = (extra: Partial<NonNullable<ThoughtQueryOptions['tokenContext']>> = {}) => ({
  nowMs: NOW_MS,
  userId: USER,
  firstDayOfWeek: 1,
  withTime: false,
  ...extra,
});

describe(
  'Матрица токенов AST (ccededb1): форма значения по операндам',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    /**
     * Общая фикстура: три мысли.
     *   * «Моя сегодня» — created/updated 09.09, автор `me`;
     *   * «Моя раньше» — created/updated 01.08, автор `me`;
     *   * «Чужая» — created/updated 09.09, автор `other`.
     */
    function fixture(): { ndb: NetworkDb; mineToday: string; mineEarlier: string; foreign: string } {
      const ndb = createInMemoryNetworkDb();
      const mineToday = seedThought(ndb, 'Моя сегодня', {
        createdBy: USER,
        createdAt: '2026-09-09T10:00:00.000Z',
        updatedAt: '2026-09-09T10:00:00.000Z',
      });
      const mineEarlier = seedThought(ndb, 'Моя раньше', {
        createdBy: USER,
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-01T10:00:00.000Z',
      });
      const foreign = seedThought(ndb, 'Чужая', {
        createdBy: 'other',
        createdAt: '2026-09-09T11:00:00.000Z',
        updatedAt: '2026-09-09T11:00:00.000Z',
      });
      return { ndb, mineToday, mineEarlier, foreign };
    }

    it('created_at: строковая и объектная формы токена эквивалентны', () => {
      const { ndb } = fixture();
      try {
        const asString = runAst(ndb, ast(leaf({ kind: 'created_at' }, 'gte', '$today')), ctx());
        const asObject = runAst(
          ndb,
          ast(leaf({ kind: 'created_at' }, 'gte', { token: '$today' })),
          ctx(),
        );
        assert.deepEqual(asString.titles, asObject.titles);
        assert.deepEqual(asString.titles, ['Моя сегодня', 'Чужая']);
        assert.equal(asString.unresolved, 0);
      } finally {
        ndb.close();
      }
    });

    it('updated_at: строковая и объектная формы токена эквивалентны', () => {
      const { ndb } = fixture();
      try {
        const asString = runAst(ndb, ast(leaf({ kind: 'updated_at' }, 'lte', '$today')), ctx());
        const asObject = runAst(
          ndb,
          ast(leaf({ kind: 'updated_at' }, 'lte', { token: '$today' })),
          ctx(),
        );
        assert.deepEqual(asString.titles, asObject.titles);
        assert.equal(asString.unresolved, 0);
      } finally {
        ndb.close();
      }
    });

    it('author: объектная и строковая формы "$user" дают один результат (мои мысли)', () => {
      const { ndb } = fixture();
      try {
        const asObject = runAst(
          ndb,
          ast(leaf({ kind: 'author' }, 'eq', { token: '$user' })),
          ctx(),
        );
        assert.deepEqual(asObject.titles, ['Моя раньше', 'Моя сегодня'], 'объект-токен $user');
        assert.equal(asObject.unresolved, 0);
        const asString = runAst(ndb, ast(leaf({ kind: 'author' }, 'eq', '$user')), ctx());
        assert.deepEqual(
          asString.titles,
          asObject.titles,
          'строковый токен "$user" в операнде «Автор» обязан раскрыться так же, как объектный',
        );
        assert.equal(asString.unresolved, 0);
      } finally {
        ndb.close();
      }
    });

    it('editor: строковая форма "$user" раскрывается (паритет с author)', () => {
      const { ndb } = fixture();
      try {
        const asString = runAst(ndb, ast(leaf({ kind: 'editor' }, 'eq', '$user')), ctx());
        assert.deepEqual(asString.titles, ['Моя раньше', 'Моя сегодня']);
        assert.equal(asString.unresolved, 0);
      } finally {
        ndb.close();
      }
    });

    it('author in: строковый токен элементом списка раскрывается', () => {
      const { ndb } = fixture();
      try {
        const res = runAst(ndb, ast(leaf({ kind: 'author' }, 'in', ['$user', 'other'])), ctx());
        assert.deepEqual(res.titles, ['Моя раньше', 'Моя сегодня', 'Чужая']);
        assert.equal(res.unresolved, 0);
      } finally {
        ndb.close();
      }
    });

    it('свойство-связь: объектная и строковая формы "$user" эквивалентны (операнд «Свойство»)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const linkTypeId = seedLinkType(ndb, 'Ссылается', 'Ссылаются');
        const prop = seedProperty(
          ndb,
          'ссылка',
          'link',
          JSON.stringify({ link_type_id: linkTypeId, direction: 'out' }),
        );
        const owner = seedThought(ndb, 'Владелец');
        seedThought(ndb, 'Пользователь', { id: USER });
        seedTypedLink(ndb, owner, USER, linkTypeId);
        seedThought(ndb, 'Без ребра');

        const asObject = runAst(
          ndb,
          ast(leaf({ kind: 'property', property_id: prop }, 'eq', { token: '$user' })),
          ctx(),
        );
        assert.deepEqual(asObject.titles, ['Владелец']);
        const asString = runAst(
          ndb,
          ast(leaf({ kind: 'property', property_id: prop }, 'eq', '$user')),
          ctx(),
        );
        assert.deepEqual(asString.titles, asObject.titles, 'строковый токен в свойстве-связи = объектному');
        assert.equal(asString.unresolved, 0);
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'Матрица токенов AST (ccededb1): строковое значение свойства — токен vs литерал (тест-долг d52e4d79)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('текст-значение, ЦЕЛИКОМ равное ИЗВЕСТНОМУ токену ($today), трактуется как ТОКЕН', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const prop = seedProperty(ndb, 'заметка', 'text');
        // Мысль A: значение свойства — ЛИТЕРАЛ "$today" (данные не раскрываются).
        const a = seedThought(ndb, 'Литерал-доллар');
        seedValue(ndb, a, prop, 'text', '$today');
        // Мысль B: значение — раскрытая дата токена; сюда попадает условие `eq "$today"`.
        const b = seedThought(ndb, 'Значение-дата');
        seedValue(ndb, b, prop, 'text', '2026-09-09');
        const c = seedThought(ndb, 'Другое');
        seedValue(ndb, c, prop, 'text', 'обычный текст');

        const res = runAst(
          ndb,
          ast(leaf({ kind: 'property', property_id: prop }, 'eq', '$today')),
          ctx(),
        );
        assert.deepEqual(
          res.titles,
          ['Значение-дата'],
          'условие-строка "$today" раскрывается в дату и матчит значение-дату, а литерал "$today" — нет',
        );
        assert.equal(res.unresolved, 0);
      } finally {
        ndb.close();
      }
    });

    it('текст-значение, ЦЕЛИКОМ равное ИЗВЕСТНОМУ токену ($user), трактуется как ТОКЕН', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const prop = seedProperty(ndb, 'заметка', 'text');
        const literal = seedThought(ndb, 'Литерал-доллар');
        seedValue(ndb, literal, prop, 'text', '$user');
        const me = seedThought(ndb, 'Значение-пользователь');
        seedValue(ndb, me, prop, 'text', USER);
        seedThought(ndb, 'Другое');

        const res = runAst(
          ndb,
          ast(leaf({ kind: 'property', property_id: prop }, 'eq', '$user')),
          ctx(),
        );
        assert.deepEqual(res.titles, ['Значение-пользователь'], 'условие-строка "$user" раскрывается в id пользователя');
        assert.equal(res.unresolved, 0);
      } finally {
        ndb.close();
      }
    });

    it('текст-значение, начинающееся с "$", но НЕ известный токен — ЛИТЕРАЛ', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const prop = seedProperty(ndb, 'заметка', 'text');
        const t = seedThought(ndb, 'С пометкой');
        seedValue(ndb, t, prop, 'text', '$notatoken');
        seedThought(ndb, 'Другая');

        const res = runAst(
          ndb,
          ast(leaf({ kind: 'property', property_id: prop }, 'eq', '$notatoken')),
          ctx(),
        );
        assert.deepEqual(res.titles, ['С пометкой']);
        assert.equal(res.unresolved, 0);
      } finally {
        ndb.close();
      }
    });

    it('текст-значение с ПРИМЕСЬЮ вокруг известного токена — ЛИТЕРАЛ (не токен)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const prop = seedProperty(ndb, 'заметка', 'text');
        const t = seedThought(ndb, 'Склеенное');
        seedValue(ndb, t, prop, 'text', 'до $today после');
        seedThought(ndb, 'Другая');

        const res = runAst(
          ndb,
          ast(leaf({ kind: 'property', property_id: prop }, 'eq', 'до $today после')),
          ctx(),
        );
        assert.deepEqual(res.titles, ['Склеенное'], 'текст с примесью остаётся литералом');
        assert.equal(res.unresolved, 0);
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'Матрица токенов AST (ccededb1): календарные границы, арифметика, стыки',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    /** Фикстура датового свойства: по одной мысли на ключевые даты 2026 года. */
    function dateFixture(): { ndb: NetworkDb; prop: string; dates: Record<string, string> } {
      const ndb = createInMemoryNetworkDb();
      const prop = seedProperty(ndb, 'срок', 'date');
      const data: Record<string, string> = {
        'Начало года': '2026-01-01',
        'Конец января': '2026-01-31',
        'Конец февраля': '2026-02-28',
        'Конец месяца': '2026-09-30',
        'Начало месяца': '2026-09-01',
        'Воскресенье 06.09': '2026-09-06',
        'Понедельник 07.09': '2026-09-07',
        'Среда 09.09': '2026-09-09',
        'Суббота 12.09': '2026-09-12',
        'Воскресенье 13.09': '2026-09-13',
        'Понедельник 14.09': '2026-09-14',
        'Конец года': '2026-12-31',
      };
      for (const [title, date] of Object.entries(data)) {
        const id = seedThought(ndb, title);
        seedValue(ndb, id, prop, 'date', date);
      }
      return { ndb, prop, dates: data };
    }

    const eq = (ndb: NetworkDb, prop: string, token: unknown, c = ctx()) =>
      runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'eq', token)), c);

    it('$weekStart/$weekEnd: первый день недели 1 (пн) и 7 (вс) — согласованная граница', () => {
      const { ndb, prop } = dateFixture();
      try {
        // fdw=1: неделя 07.09…13.09.
        assert.deepEqual(eq(ndb, prop, { token: '$weekStart' }, ctx({ firstDayOfWeek: 1 })).titles, [
          'Понедельник 07.09',
        ]);
        assert.deepEqual(eq(ndb, prop, { token: '$weekEnd' }, ctx({ firstDayOfWeek: 1 })).titles, [
          'Воскресенье 13.09',
        ]);
        // fdw=7: неделя 06.09…12.09.
        assert.deepEqual(eq(ndb, prop, { token: '$weekStart' }, ctx({ firstDayOfWeek: 7 })).titles, [
          'Воскресенье 06.09',
        ]);
        assert.deepEqual(eq(ndb, prop, { token: '$weekEnd' }, ctx({ firstDayOfWeek: 7 })).titles, [
          'Суббота 12.09',
        ]);
      } finally {
        ndb.close();
      }
    });

    it('легаси-точечные $week.start/$week.end ≡ каноническим', () => {
      const { ndb, prop } = dateFixture();
      try {
        assert.deepEqual(
          eq(ndb, prop, { token: '$week.start' }).titles,
          eq(ndb, prop, { token: '$weekStart' }).titles,
        );
        assert.deepEqual(
          eq(ndb, prop, { token: '$week.end' }).titles,
          eq(ndb, prop, { token: '$weekEnd' }).titles,
        );
      } finally {
        ndb.close();
      }
    });

    it('$monthStart/$monthEnd/$yearStart/$yearEnd — календарные края', () => {
      const { ndb, prop } = dateFixture();
      try {
        assert.deepEqual(eq(ndb, prop, { token: '$monthStart' }).titles, ['Начало месяца']);
        assert.deepEqual(eq(ndb, prop, { token: '$monthEnd' }).titles, ['Конец месяца']);
        assert.deepEqual(eq(ndb, prop, { token: '$yearStart' }).titles, ['Начало года']);
        assert.deepEqual(eq(ndb, prop, { token: '$yearEnd' }).titles, ['Конец года']);
        assert.deepEqual(
          eq(ndb, prop, { token: '$month.start' }).titles,
          eq(ndb, prop, { token: '$monthStart' }).titles,
        );
        assert.deepEqual(
          eq(ndb, prop, { token: '$year.end' }).titles,
          eq(ndb, prop, { token: '$yearEnd' }).titles,
        );
      } finally {
        ndb.close();
      }
    });

    it('$today ±Nd / ±Nw сдвигает границу', () => {
      const { ndb, prop } = dateFixture();
      try {
        assert.deepEqual(eq(ndb, prop, { token: '$today+1d' }).titles, []);
        assert.deepEqual(eq(ndb, prop, { token: '$today-2d' }).titles, ['Понедельник 07.09']);
        assert.deepEqual(eq(ndb, prop, { token: '$today-1w' }).titles, []);
        assert.deepEqual(eq(ndb, prop, { token: '$today+3d' }).titles, ['Суббота 12.09']);
      } finally {
        ndb.close();
      }
    });

    it('$monthEnd±1mo и прижимание дня к концу месяца (31.01+1mo = 28.02)', () => {
      const { ndb, prop } = dateFixture();
      try {
        // $today = 09.09; $monthEnd = 30.09; -1mo = 31.08 → прижимание к 31 (в августе 31 день).
        assert.deepEqual(eq(ndb, prop, { token: '$monthEnd' }).titles, ['Конец месяца']);
        // Токен-арифметика от 31.01: $monthStart-... не выразима без базы; проверяем
        // через движок отдельным сидом: $today+1mo от 31.01 → 28.02.
        const jan31 = runAst(
          ndb,
          ast(leaf({ kind: 'property', property_id: prop }, 'eq', { token: '$today+1mo' })),
          ctx({ nowMs: Date.parse('2026-01-31T10:00:00.000Z') }),
        );
        assert.deepEqual(jan31.titles, ['Конец февраля']);
      } finally {
        ndb.close();
      }
    });

    it('$yearStart+1y / $yearEnd-1y — годовой сдвиг от краёв года', () => {
      const { ndb, prop } = dateFixture();
      try {
        assert.deepEqual(
          eq(ndb, prop, { token: '$yearStart+1y' }, ctx({ nowMs: Date.parse('2025-06-01T00:00:00.000Z') }))
            .titles,
          ['Начало года'],
        );
        assert.deepEqual(
          eq(ndb, prop, { token: '$yearEnd-1y' }, ctx({ nowMs: Date.parse('2027-06-01T00:00:00.000Z') }))
            .titles,
          ['Конец года'],
        );
      } finally {
        ndb.close();
      }
    });

    it('открытые границы: операнд created_at eq "$today" — только СУТКИ UTC (469d8d69)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Начало суток', { createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z' });
        seedThought(ndb, 'Конец суток', { createdAt: '2026-09-09T23:59:59.999Z', updatedAt: '2026-09-09T23:59:59.999Z' });
        seedThought(ndb, 'Следующие сутки', { createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z' });
        const res = runAst(ndb, ast(leaf({ kind: 'created_at' }, 'eq', '$today')), ctx());
        assert.deepEqual(res.titles, ['Конец суток', 'Начало суток'], 'eq по дате = попадание в сутки UTC');
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'Матрица токенов AST (ccededb1): профиль без времени и токены времени',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('в профиле без времени $now/$hourStart и h/mi → unresolved time_context_required', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const prop = seedProperty(ndb, 'срок', 'date');
        const t = seedThought(ndb, 'Мысль');
        seedValue(ndb, t, prop, 'date', '2026-09-09');
        for (const token of ['$now', '$hourStart', '$hourEnd', '$today+1h', '$today-30mi']) {
          const res = runAst(
            ndb,
            ast(leaf({ kind: 'property', property_id: prop }, 'eq', { token })),
            ctx({ withTime: false }),
          );
          assert.deepEqual(res.titles, [], token);
          assert.deepEqual(res.reasons, ['time_context_required'], token);
        }
      } finally {
        ndb.close();
      }
    });

    it('в профиле СО временем те же токены разрешаются (не time_context_required)', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const prop = seedProperty(ndb, 'срок', 'date');
        seedThought(ndb, 'Мысль');
        for (const token of ['$now', '$hourStart', '$today+1h']) {
          const res = runAst(
            ndb,
            ast(leaf({ kind: 'property', property_id: prop }, 'eq', { token })),
            ctx({ withTime: true }),
          );
          assert.ok(
            !res.reasons.includes('time_context_required'),
            `токен времени ${token} в профиле со временем не должен требовать time_context`,
          );
        }
      } finally {
        ndb.close();
      }
    });

    it('датовый токен на ЧИСЛОВОМ свойстве — явная ошибка типа, а не молчаливое совпадение', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const numProp = seedProperty(ndb, 'число', 'number');
        const t = seedThought(ndb, 'Мысль');
        seedValue(ndb, t, numProp, 'number', 5);
        assert.throws(
          () =>
            runAst(
              ndb,
              ast(leaf({ kind: 'property', property_id: numProp }, 'eq', { token: '$today+1d' })),
              ctx(),
            ),
          (err: unknown) => err instanceof EtnError && err.code === 'VALIDATION_ERROR',
          'раскрытый датовый токен не подставляется молча в числовую клаузу',
        );
      } finally {
        ndb.close();
      }
    });

    it('$thought в СЕТЕВОМ профиле (без мысли-контекста) неразрешим — строковая и объектная формы', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const prop = seedProperty(ndb, 'заметка', 'text');
        const t = seedThought(ndb, 'Мысль');
        seedValue(ndb, t, prop, 'text', 'значение');
        for (const value of ['$thought', ['$thought'], { token: '$thought' }]) {
          const res = runAst(ndb, ast(leaf({ kind: 'property', property_id: prop }, 'eq', value)), ctx());
          assert.deepEqual(res.titles, [], JSON.stringify(value));
          assert.deepEqual(res.reasons, ['unknown_token'], JSON.stringify(value));
        }
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'Матрица токенов AST (5a855ef8): строковый токен в операндах-идентификаторах',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    /**
     * Операнды-ИДЕНТИФИКАТОРЫ профиля «мысли»: «Мысль» (`id`), структурные
     * «Родители»/«Потомки», «Тип», «Тип связи». Их строковое значение — UUID
     * мысли/типа/типа связи, токеном-строкой не бывает легитимным литералом,
     * поэтому строковая форма обязана раскрываться так же, как объектная
     * (`{ token }`): известный токен раскрывается, неизвестный `$…` даёт
     * `unresolved.unknown_token`, а `$…`-мусор (не токен) остаётся литералом.
     */
    const OPERANDS: readonly Record<string, unknown>[] = [
      { kind: 'id' },
      { kind: 'parents' },
      { kind: 'children' },
      { kind: 'type' },
      { kind: 'link_type' },
    ];

    function fixture(): NetworkDb {
      const ndb = createInMemoryNetworkDb();
      seedThought(ndb, 'Мысль');
      return ndb;
    }

    it('$thought строкой ≡ объектом → unresolved.unknown_token (все пять операндов)', () => {
      const ndb = fixture();
      try {
        for (const entity of OPERANDS) {
          const asString = runAst(ndb, ast(leaf(entity, 'eq', '$thought')), ctx());
          const asObject = runAst(ndb, ast(leaf(entity, 'eq', { token: '$thought' })), ctx());
          assert.deepEqual(
            asString.titles,
            asObject.titles,
            `${JSON.stringify(entity)}: строковый токен обязан совпасть с объектным`,
          );
          assert.deepEqual(asString.reasons, ['unknown_token'], JSON.stringify(entity));
          assert.deepEqual(asString.reasons, asObject.reasons, JSON.stringify(entity));
        }
      } finally {
        ndb.close();
      }
    });

    it('$thought строкой в СПИСКЕ (in) ≡ объектом — все пять операндов', () => {
      const ndb = fixture();
      try {
        for (const entity of OPERANDS) {
          const asString = runAst(ndb, ast(leaf(entity, 'in', ['$thought'])), ctx());
          const asObject = runAst(ndb, ast(leaf(entity, 'in', [{ token: '$thought' }])), ctx());
          assert.deepEqual(asString.titles, asObject.titles, JSON.stringify(entity));
          assert.deepEqual(asString.reasons, ['unknown_token'], JSON.stringify(entity));
        }
      } finally {
        ndb.close();
      }
    });

    it('$notatoken строкой остаётся ЛИТЕРАЛОМ (unresolved пуст) во всех пяти операндах', () => {
      const ndb = fixture();
      try {
        for (const entity of OPERANDS) {
          const res = runAst(ndb, ast(leaf(entity, 'eq', '$notatoken')), ctx());
          assert.deepEqual(res.titles, [], JSON.stringify(entity));
          assert.equal(res.unresolved, 0, `${JSON.stringify(entity)}: $…-мусор — литерал, не токен`);
        }
      } finally {
        ndb.close();
      }
    });

    it('известный токен $user строкой ≡ объектом (литерал-id, пустой результат без диагностики)', () => {
      const ndb = fixture();
      try {
        for (const entity of OPERANDS) {
          const asString = runAst(ndb, ast(leaf(entity, 'eq', '$user')), ctx());
          const asObject = runAst(ndb, ast(leaf(entity, 'eq', { token: '$user' })), ctx());
          assert.deepEqual(asString.titles, asObject.titles, JSON.stringify(entity));
          assert.equal(asString.unresolved, 0, JSON.stringify(entity));
        }
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'Матрица токенов AST (ccededb1): хроника — форма токена в операндах записи',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    function seedChronComment(ndb: NetworkDb, title: string, validFrom: string, author: string): string {
      const id = randomUUID();
      ndb
        .prepare(
          `INSERT INTO comments (id, layer_id, owner_type, owner_id, kind, title, body_md, body_html,
                                 valid_from, valid_to, use_time, version,
                                 created_at, updated_at, created_by, updated_by, created_at_ms, updated_at_ms)
           VALUES (?, ?, 'thought', ?, 'chronological', ?, '', '', ?, ?, 0, 1, '2024', '2024', ?, ?, 0, 0)`,
        )
        .run(id, ndb.layerId, randomUUID(), title, validFrom, validFrom, author, author);
      return id;
    }

    const runChron = (ndb: NetworkDb, filter: FilterAst['filter']) => {
      const request = parseChronicleQueryBody(
        { ast: { version: FILTER_AST_VERSION, filter }, order: 'asc', limit: 100, offset: 0 },
        'matrix',
      );
      return queryChronicle(ndb, request, { userId: USER, now: () => new Date(NOW_MS), withTime: true });
    };

    it('record_time: строковая и объектная формы границы эквивалентны', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedChronComment(ndb, 'Внутри', '2026-09-08T10:00:00.000Z', 'me');
        seedChronComment(ndb, 'Вне', '2026-08-01T10:00:00.000Z', 'me');
        const asString = runChron(ndb, leaf({ kind: 'record_time' }, 'between', ['$weekStart', '$monthEnd']));
        const asObject = runChron(ndb, leaf({ kind: 'record_time' }, 'between', [
          { token: '$weekStart' },
          { token: '$monthEnd' },
        ]));
        assert.deepEqual(
          asString.rows.map((r) => r.id),
          asObject.rows.map((r) => r.id),
          'строковая форма границы времени записи = объектной',
        );
        // Одиночная граница строкой-токеном тоже принимается (gte).
        const single = runChron(ndb, leaf({ kind: 'record_time' }, 'gte', '$weekStart'));
        assert.deepEqual(single.rows.map((r) => r.title), ['Внутри']);
      } finally {
        ndb.close();
      }
    });

    it('record_author: объектная и строковая формы "$user" эквивалентны', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const mine = seedChronComment(ndb, 'Моя', '2026-09-08T10:00:00.000Z', USER);
        const other = seedChronComment(ndb, 'Чужая', '2026-09-08T11:00:00.000Z', 'other');
        const asObject = runChron(ndb, leaf({ kind: 'record_author' }, 'eq', { token: '$user' }));
        assert.deepEqual(asObject.rows.map((r) => r.id), [mine]);
        const asString = runChron(ndb, leaf({ kind: 'record_author' }, 'eq', '$user'));
        assert.deepEqual(
          asString.rows.map((r) => r.id),
          asObject.rows.map((r) => r.id),
          'строковый токен "$user" в «Авторе записи» обязан раскрыться так же, как объектный',
        );
        assert.ok(other.length > 0);
      } finally {
        ndb.close();
      }
    });
  },
);

describe(
  'Матрица токенов AST (ccededb1): «Есть слова» — форма токена (ошибка d166cfe9)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    /** Фикстура: литерал «$today» в заголовке и заголовок с РАСКРЫТОЙ датой токена. */
    function keywordFixture(): { ndb: NetworkDb } {
      const ndb = createInMemoryNetworkDb();
      seedThought(ndb, 'Заметка $today');
      seedThought(ndb, 'Заметка 2026-09-09');
      return { ndb };
    }

    const kw = (value: unknown): FilterAst => ast(leaf({ kind: 'keywords', scope: ['title'] }, 'matches', value));

    it('keywords: строковая форма "$today" ≡ объектной (паритет форм)', () => {
      const { ndb } = keywordFixture();
      try {
        const asObject = runAst(ndb, kw({ token: '$today' }), ctx());
        assert.deepEqual(asObject.titles, ['Заметка 2026-09-09'], 'объектная форма раскрывает токен в дату');
        assert.equal(asObject.unresolved, 0);
        const asString = runAst(ndb, kw('$today'), ctx());
        assert.deepEqual(
          asString.titles,
          asObject.titles,
          'строковый токен "$today" в «Есть слова» обязан раскрыться так же, как объектный',
        );
        assert.equal(asString.unresolved, 0);
      } finally {
        ndb.close();
      }
    });

    it('keywords: неизвестный токен "$thought" отвергается unresolved-диагностикой в обеих формах', () => {
      const { ndb } = keywordFixture();
      try {
        for (const value of ['$thought', { token: '$thought' }]) {
          const res = runAst(ndb, kw(value), ctx());
          assert.deepEqual(res.titles, [], JSON.stringify(value));
          assert.deepEqual(res.reasons, ['unknown_token'], JSON.stringify(value));
        }
      } finally {
        ndb.close();
      }
    });

    it('keywords: неизвестная «$»-строка и строка с примесью текста остаются ЛИТЕРАЛОМ', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        seedThought(ndb, 'Пометка $notatoken');
        seedThought(ndb, 'Текст до $today после');
        seedThought(ndb, 'Заметка 2026-09-09');
        const unknown = runAst(ndb, kw('$notatoken'), ctx());
        assert.deepEqual(unknown.titles, ['Пометка $notatoken'], 'неизвестный $… — литерал');
        assert.equal(unknown.unresolved, 0);
        const mixed = runAst(ndb, kw('до $today после'), ctx());
        assert.deepEqual(mixed.titles, ['Текст до $today после'], 'строка с примесью — литерал, а не токен');
        assert.equal(mixed.unresolved, 0);
      } finally {
        ndb.close();
      }
    });

    it('keywords: FTS-сужатель НЕ ставится для значения-токена, но ставится для литерала (ловушка d166cfe9)', () => {
      const { ndb } = keywordFixture();
      try {
        const captured: string[] = [];
        const orig = ndb.prepare.bind(ndb) as (sql: string) => unknown;
        (ndb as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
          captured.push(sql);
          return orig(sql);
        };
        try {
          runAst(ndb, kw('$today'), ctx());
          assert.ok(
            !captured.some((s) => s.includes('fts_thought_names MATCH')),
            'для значения-токена сужатель по СЫРОМУ «$today» отсекал бы раскрытую дату',
          );
          captured.length = 0;
          runAst(ndb, kw('заметка'), ctx());
          assert.ok(
            captured.some((s) => s.includes('fts_thought_names MATCH')),
            'для обычного литерала FTS-сужатель (314cbb8d) обязан остаться',
          );
        } finally {
          (ndb as unknown as { prepare: (sql: string) => unknown }).prepare = orig;
        }
      } finally {
        ndb.close();
      }
    });
  },
);
