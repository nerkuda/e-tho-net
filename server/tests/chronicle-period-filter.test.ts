/**
 * Контроль применения периода в выборке «Дневника» (0.10.1, приёмка №4, задача
 * fd9eef49). Проверяет НЕ построение периода, а РЕЗУЛЬТАТ запроса: при
 * применении пресета («сегодня», «сегодня−3д…сегодня»), диапазона границ
 * недели и точной даты лента фильтруется соответствующими записями.
 *
 * Отдельно фиксируется ядро дефекта приёмки №4: запись с временем внутри дня
 * (`2026-09-26T17:00:00.000Z`) попадает в выборку своего дня, если клиент
 * отправляет «голую дату» (сутки UTC, требование 469d8d69), — и не попадает,
 * если запросить её токеном, раскрытым относительно ДРУГИХ UTC-суток.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';

import { createInMemoryNetworkDb } from '../src/db/network-db.js';
import type { NetworkDb } from '../src/db/network-db.js';
import { createComment } from '../src/domain/comment-service.js';
import { parseChronicleQueryBody, queryChronicle } from '../src/domain/chronicle-service.js';

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new DatabaseConstructor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function seedThought(ndb: NetworkDb, title: string, home = false): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, active, is_protected, is_root,
                             type_id, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 1, ?, ?, NULL, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase(), home ? 1 : 0, home ? 1 : 0);
  return id;
}

const USER = 'user-1';
/** Момент «сейчас» для раскрытия токенов (UTC). */
const NOW = (): Date => new Date('2026-09-27T12:00:00.000Z');

/** Запрос периода через тот же разбор тела, что REST/MCP. */
function periodQuery(ndb: NetworkDb, dateFrom: string, dateTo: string, now: () => Date = NOW) {
  const request = parseChronicleQueryBody(
    { date_from: dateFrom, date_to: dateTo, order: 'asc', limit: 50, offset: 0 },
    'test-request',
  );
  return queryChronicle(ndb, request, { now, userId: USER });
}

describe(
  'chronicle: применение периода фильтрует ленту (приёмка №4)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    /**
     * Записи одного дня (HOME): 20, 23, 24, 26 (с временем 17:00 — дефектная), 27.
     */
    function seedRecords(): { ndb: NetworkDb; ids: Record<string, string> } {
      const ndb = createInMemoryNetworkDb();
      const home = seedThought(ndb, 'HOME', true);
      const days: Array<[string, string]> = [
        ['2026-09-20', '2026-09-20T10:00:00.000Z'],
        ['2026-09-23', '2026-09-23T10:00:00.000Z'],
        ['2026-09-24', '2026-09-24T10:00:00.000Z'],
        ['2026-09-26', '2026-09-26T17:00:00.000Z'],
        ['2026-09-27', '2026-09-27T10:00:00.000Z'],
      ];
      const ids: Record<string, string> = {};
      for (const [label, instant] of days) {
        ids[label] = createComment(
          ndb,
          'thought',
          home,
          {
            kind: 'chronological',
            body_md: `запись ${label}`,
            valid_from: instant,
            valid_to: instant,
          },
          USER,
        ).id;
      }
      return { ndb, ids };
    }

    it('пресет «сегодня» оставляет только сегодняшние записи', () => {
      const { ndb, ids } = seedRecords();
      try {
        const res = periodQuery(ndb, '$today', '$today');
        assert.deepEqual(res.rows.map((r) => r.id), [ids['2026-09-27']]);
      } finally {
        ndb.close();
      }
    });

    it('пресет «сегодня−3д … сегодня» отбирает ровно последние три дня', () => {
      const { ndb, ids } = seedRecords();
      try {
        const res = periodQuery(ndb, '$today-3d', '$today');
        assert.deepEqual(
          res.rows.map((r) => r.id).sort(),
          [ids['2026-09-24'], ids['2026-09-26'], ids['2026-09-27']].sort(),
        );
      } finally {
        ndb.close();
      }
    });

    it('границы недели недели 39 отбирают записи 21–27 сентября', () => {
      const { ndb, ids } = seedRecords();
      try {
        const res = periodQuery(ndb, '$week.start', '$week.end');
        assert.deepEqual(
          res.rows.map((r) => r.id).sort(),
          [ids['2026-09-23'], ids['2026-09-24'], ids['2026-09-26'], ids['2026-09-27']].sort(),
        );
      } finally {
        ndb.close();
      }
    });

    it('точная дата отбирает только свой день', () => {
      const { ndb, ids } = seedRecords();
      try {
        const res = periodQuery(ndb, '2026-09-23', '2026-09-23');
        assert.deepEqual(res.rows.map((r) => r.id), [ids['2026-09-23']]);
      } finally {
        ndb.close();
      }
    });

    it('запись с временем 17:00Z видна в выборке своего дня (голая дата = сутки UTC)', () => {
      const { ndb, ids } = seedRecords();
      try {
        // Именно это отправляет клиент после раскрытия токена дня (приёмка №4).
        const day = periodQuery(ndb, '2026-09-26', '2026-09-26');
        assert.deepEqual(day.rows.map((r) => r.id), [ids['2026-09-26']]);
        assert.equal(day.rows[0]!.valid_from, '2026-09-26T17:00:00.000Z');

        // Контроль причины дефекта: наблюдатель восточнее UTC, локальное
        // «сегодня» — 27.09, а на сервере (UTC) ещё 26.09. Тот же день 26.09,
        // запрошенный токеном `$today-1d`, раскроется от UTC-суток 26.09 в
        // 25.09 — запись выпадет из своего дня.
        const utcAhead = (): Date => new Date('2026-09-26T22:00:00.000Z');
        const shifted = periodQuery(ndb, '$today-1d', '$today-1d', utcAhead);
        assert.equal(shifted.total, 0, 'токен раскрывается от UTC-суток, а не от локального дня');
        // А раскрытая клиентом «голая дата» того же дня даёт ровно эту запись.
        const resolved = periodQuery(ndb, '2026-09-26', '2026-09-26', utcAhead);
        assert.deepEqual(resolved.rows.map((r) => r.id), [ids['2026-09-26']]);
      } finally {
        ndb.close();
      }
    });
    it('запись у локальной полуночи попадает в ЛОКАЛЬНЫЕ сутки полными инстансами, а не в сутки UTC', () => {
      const ndb = createInMemoryNetworkDb();
      try {
        const home = seedThought(ndb, 'HOME', true);
        // Запись «за 26.09» в поясе UTC+3 хранится как 25.09T21:00Z.
        const id = createComment(
          ndb,
          'thought',
          home,
          {
            kind: 'chronological',
            body_md: 'запись у локальной полуночи',
            valid_from: '2026-09-25T21:00:14.413Z',
            valid_to: '2026-09-25T21:00:14.413Z',
          },
          USER,
        ).id;

        // То, что отправляет клиент после раскрытия периода (локальные сутки,
        // поведение 0.10.1, приёмка №4).
        const day = periodQuery(ndb, '2026-09-25T21:00:00.000Z', '2026-09-26T20:59:59.999Z');
        assert.deepEqual(day.rows.map((r) => r.id), [id], 'локальные сутки 26.09 содержат запись');

        const week = periodQuery(ndb, '2026-09-20T21:00:00.000Z', '2026-09-27T20:59:59.999Z');
        assert.ok(week.rows.some((r) => r.id === id), 'неделя 39 в локальных сутках содержит запись');

        // «Голая дата» = сутки UTC их не покрывает — именно поэтому клиент
        // раскрывает период в полные инстансы локальных суток.
        const bare = periodQuery(ndb, '2026-09-26', '2026-09-26');
        assert.equal(bare.total, 0, 'сутки UTC 26.09 не содержат запись у локальной полуночи');
      } finally {
        ndb.close();
      }
    });
  },
);
