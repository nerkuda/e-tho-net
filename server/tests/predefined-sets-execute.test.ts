/**
 * Проверка DoD задачи 347b307e «условия исполняются» — на ИСПОЛНЕНИИ тел
 * (единый движок отбора), а не только на сборке AST (замечание верификатора,
 * круг проверки 1).
 *
 * Здесь ПРОГОНЯЮТСЯ реальным запросом все шесть предопределённых наборов обеих
 * панелей: четыре набора «Структур» — через `queryThoughts` (профиль
 * `thoughts`), два набора «Дневника» — через `queryChronicle` (профиль
 * `chronicle`). Тела наборов совпадают с `PREDEFINED_FILTERS` панелей
 * (формулировки заказчика; токены `$weekStart`/`$weekEnd`/`$today-30d`/`$today`,
 * автор записи — `$user`).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { FILTER_AST_VERSION, type FilterAst, type FilterAstNode } from '@etn/shared';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createComment } from '../src/domain/comment-service.js';
import { parseChronicleQueryBody, queryChronicle } from '../src/domain/chronicle-service.js';
import { queryThoughts, type ThoughtQueryRequest } from '../src/domain/query-service.js';

const USER = 'user-1';
const OTHER = 'user-2';
/** Четверг; неделя (пн..вс) — 2026-10-12 … 2026-10-18. */
const NOW_MS = Date.parse('2026-10-15T12:00:00.000Z');
const NOW = (): Date => new Date(NOW_MS);

function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Тела предопределённых наборов (зеркало `PREDEFINED_FILTERS` панелей)
// ---------------------------------------------------------------------------

const leaf = (entity: Record<string, unknown>, operator: string, value?: unknown): FilterAstNode =>
  (value === undefined ? { entity, operator } : { entity, operator, value }) as FilterAstNode;

const and = (...children: FilterAstNode[]): FilterAstNode => ({ op: 'and', children });

/** «Структуры»: 1 — Сиротские мысли (без родителей). */
const SIROTY = and(
  leaf({ kind: 'parents' }, 'is_empty'),
  leaf({ kind: 'active' }, 'eq', true),
  leaf({ kind: 'trashed' }, 'eq', false),
);
/** «Структуры»: 2 — Создано на этой неделе. */
const THIS_WEEK = and(
  leaf({ kind: 'created_at' }, 'between', [{ token: '$weekStart' }, { token: '$weekEnd' }]),
  leaf({ kind: 'active' }, 'eq', true),
  leaf({ kind: 'trashed' }, 'eq', false),
);
/** «Структуры»: 3 — Создано за 30 дней. */
const LAST_30 = and(
  leaf({ kind: 'created_at' }, 'between', [{ token: '$today-30d' }, { token: '$today' }]),
  leaf({ kind: 'active' }, 'eq', true),
  leaf({ kind: 'trashed' }, 'eq', false),
);
/** «Структуры»: 4 — Помеченные на удаление. */
const TRASHED = and(leaf({ kind: 'trashed' }, 'eq', true));

/** «Дневник»: 1 — Мои записи за неделю. */
const MY_WEEK = and(
  leaf({ kind: 'record_time' }, 'between', [{ token: '$weekStart' }, { token: '$weekEnd' }]),
  leaf({ kind: 'record_author' }, 'eq', { token: '$user' }),
);
/** «Дневник»: 2 — Записи за 30 дней. */
const RECORDS_30 = and(
  leaf({ kind: 'record_time' }, 'between', [{ token: '$today-30d' }, { token: '$today' }]),
);

// ---------------------------------------------------------------------------
// Сид и прогон
// ---------------------------------------------------------------------------

function seedThought(
  ndb: NetworkDb,
  title: string,
  opts: { createdAt: string; active?: number; trashed?: number },
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             version, created_at, created_by, updated_at, updated_by, marked_for_deletion)
       VALUES (?, ?, ?, NULL, ?, 0, 0, 1, ?, 'u', ?, 'u', ?)`,
    )
    .run(
      id,
      title,
      title.normalize('NFC').trim().toLowerCase(),
      opts.active ?? 1,
      opts.createdAt,
      opts.createdAt,
      opts.trashed ?? 0,
    );
  return id;
}

function seedLink(ndb: NetworkDb, sourceId: string, targetId: string): void {
  ndb
    .prepare(
      `INSERT INTO links (id, source_id, target_id, type_id, active, version,
                          created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, NULL, 1, 1, '2024', '2024', 'u', 'u')`,
    )
    .run(randomUUID(), sourceId, targetId);
}

function runStructures(ndb: NetworkDb, filter: FilterAstNode): string[] {
  const req: ThoughtQueryRequest = {
    sort: 'alpha',
    order: 'asc',
    limit: 200,
    offset: 0,
    count: true,
    ast: { version: FILTER_AST_VERSION, filter } as FilterAst,
  };
  const res = queryThoughts(ndb, USER, req, {
    emptyFilterMode: 'all',
    maxLimit: 200,
    profile: 'thoughts',
    tokenContext: { nowMs: NOW_MS, userId: USER, firstDayOfWeek: 1, withTime: false },
  });
  return res.items.map((i) => i.title).sort((a, b) => a.localeCompare(b, 'ru'));
}

function runChronicle(ndb: NetworkDb, filter: FilterAstNode): string[] {
  const request = parseChronicleQueryBody(
    { ast: { version: FILTER_AST_VERSION, filter }, order: 'asc', limit: 100, offset: 0 },
    'test',
  );
  const res = queryChronicle(ndb, request, {
    userId: USER,
    now: NOW,
    firstDayOfWeek: 1,
    withTime: true,
  });
  return res.rows.map((r) => r.title ?? '').sort((a, b) => a.localeCompare(b, 'ru'));
}

describe('предопределённые наборы исполняются движком (DoD 347b307e)', { skip: !nativeAvailable() }, () => {
  it('«Структуры»: четыре набора дают ожидаемые наборы мыслей', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const root = seedThought(ndb, 'Корень с ребёнком', { createdAt: '2026-10-01T00:00:00.000Z' });
      const child = seedThought(ndb, 'Мысль с родителем', { createdAt: '2026-10-15T09:00:00.000Z' });
      seedLink(ndb, root, child);
      seedThought(ndb, 'Сирота сегодня', { createdAt: '2026-10-15T05:09:50.000Z' });
      seedThought(ndb, 'Старая сирота', { createdAt: '2026-08-01T00:00:00.000Z' });
      seedThought(ndb, 'Неактивная', { createdAt: '2026-10-15T10:00:00.000Z', active: 0 });
      seedThought(ndb, 'В корзине', { createdAt: '2026-10-15T10:00:00.000Z', trashed: 1 });

      // «Корень с ребёнком» — источник связи, входящих «родителей» нет, поэтому
      // он тоже сирота (структурные «Родители» = входящие рёбра).
      assert.deepEqual(
        runStructures(ndb, SIROTY),
        ['Корень с ребёнком', 'Сирота сегодня', 'Старая сирота'],
        'сироты: нет родителей, только активные и без корзины',
      );
      assert.deepEqual(
        runStructures(ndb, THIS_WEEK),
        ['Мысль с родителем', 'Сирота сегодня'],
        'неделя + активные без корзины',
      );
      assert.deepEqual(
        runStructures(ndb, LAST_30),
        ['Корень с ребёнком', 'Мысль с родителем', 'Сирота сегодня'],
        '30 дней включает сегодня созданную мысль (весь граничный день)',
      );
      assert.deepEqual(runStructures(ndb, TRASHED), ['В корзине'], 'набор корзины');
    } finally {
      ndb.close();
    }
  });

  it('«Дневник»: два набора дают ожидаемые записи', () => {
    const ndb = createInMemoryNetworkDb();
    try {
      const target = seedThought(ndb, 'Цель', { createdAt: '2026-01-01T00:00:00.000Z' });
      const record = (title: string, validFrom: string, author: string): void => {
        createComment(
          ndb,
          'thought',
          target,
          { kind: 'chronological', title, body_md: 'x', valid_from: validFrom },
          author,
        );
      };
      record('Моя сегодня', '2026-10-15T05:00:00.000Z', USER);
      record('Чужая сегодня', '2026-10-15T06:00:00.000Z', OTHER);
      record('Моя прошлая неделя', '2026-10-08T10:00:00.000Z', USER);
      record('Моя 40 дней', '2026-09-05T10:00:00.000Z', USER);

      assert.deepEqual(
        runChronicle(ndb, MY_WEEK),
        ['Моя сегодня'],
        '«Мои записи за неделю»: период + автор $user',
      );
      assert.deepEqual(
        runChronicle(ndb, RECORDS_30),
        ['Моя прошлая неделя', 'Моя сегодня', 'Чужая сегодня'],
        '«Записи за 30 дней»: период покрывает весь граничный день, автор не фильтруется',
      );
    } finally {
      ndb.close();
    }
  });
});
