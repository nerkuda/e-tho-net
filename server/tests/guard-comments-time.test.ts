/**
 * Сторож времени хроно-записей (0.10.1, задача T1 62a0a604; требования
 * «Формат дат хроно-записи» d58aa1a4, «Флаг "учитывать время"» 91ba5b3f,
 * «Миграция дат хроники» 4c316b45; ADR 994d076a; сущность comments f009d46e).
 *
 * Миграция 046 вводит схему и приведение данных:
 *   * `comments.use_time` — булев флаг «учитывать время», NOT NULL, DEFAULT 0;
 *   * «голая дата» (`YYYY-MM-DD`) в `valid_from`/`valid_to` превращается в
 *     `YYYY-MM-DDT00:00:01.000Z` (маркер «время при миграции не задавалось»);
 *   * пустое окончание хронологической записи заполняется её началом
 *     (`valid_to` = `valid_from`), у постоянного остаётся `NULL`.
 *
 * Правило «в хранилище нет date-only и нет пустого `valid_to` у хронологической»
 * держалось бы на дисциплине и на разовом прогоне миграции, поэтому проверяется
 * здесь. Сторож гоняется на свежей in-memory базе после всех миграций и на базе,
 * наполненной данными эпохи date-only (как апгрейд живой сети), и входит в
 * обычный `npm -w @etn/server test`.
 *
 * Валидация ВХОДА на запись (запрет date-only и пустого `valid_to` с понятной
 * ошибкой) — задача T2 (`fca5b507`); этот сторож проверяет только схему и
 * приведение накопленных данных.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import DatabaseConstructor from 'better-sqlite3';
import type Database from 'better-sqlite3';

import { registerMigrationHelpers } from '../src/db/network-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { networkMigrationsDir } from '../src/paths.js';

/** Файл миграции, ради которой заведён этот набор. */
const MIGRATION = '046_comments_time.sql';

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

/** Колонки таблицы (`PRAGMA table_info`). */
interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

/** `PRAGMA table_info` указанной таблицы. */
function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.prepare(`SELECT name, type, "notnull", dflt_value FROM pragma_table_info(?)`).all(table) as ColumnInfo[];
}

/**
 * Применить миграции до 046 (то есть состояние сети до 0.10.1) на in-memory
 * базе — чтобы затем наполнить её данными эпохи date-only и применить 046
 * как апгрейд живой сети.
 */
function pre046Db(): Database.Database {
  const dir = mkdtempSync(path.join(tmpdir(), 'etn-mig-046-'));
  for (const f of readdirSync(networkMigrationsDir()).filter(
    (f) => f.endsWith('.sql') && f < '046',
  )) {
    cpSync(path.join(networkMigrationsDir(), f), path.join(dir, f));
  }
  const db = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  registerMigrationHelpers(db);
  runMigrations(db, dir);
  rmSync(dir, { recursive: true, force: true });
  return db;
}

/** Вставить комментарий в состоянии до 046 (без `use_time`). */
function seedComment(
  db: Database.Database,
  id: string,
  kind: 'permanent' | 'chronological',
  validFrom: string,
  validTo: string | null,
): void {
  db.prepare(
    `INSERT INTO comments
       (id, owner_type, owner_id, kind, title, body_md, body_html,
        valid_from, valid_to, version, created_at, updated_at, created_by, updated_by)
     VALUES (?, 'thought', 't1', ?, NULL, ?, '<p>x</p>',
             ?, ?, 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 'u', 'u')`,
  ).run(id, kind, id, validFrom, validTo);
}

/** Строка комментария для проверок. */
interface CommentRow {
  id: string;
  valid_from: string;
  valid_to: string | null;
  use_time: number;
}

/** Прочитать комментарий по id. */
function readComment(db: Database.Database, id: string): CommentRow {
  return db
    .prepare('SELECT id, valid_from, valid_to, use_time FROM comments WHERE id = ?')
    .get(id) as CommentRow;
}

describe(
  'guard: время хроно-записей (миграция 046)',
  nativeAvailable() ? {} : { skip: 'better-sqlite3 native binding unavailable' },
  () => {
    it('схема: comments.use_time — NOT NULL INTEGER DEFAULT 0', () => {
      const db = pre046Db();
      try {
        // До миграции столбца нет — иначе проверка ниже ничего не доказывает.
        assert.ok(
          !columns(db, 'comments').some((c) => c.name === 'use_time'),
          'до 046 столбца use_time быть не должно',
        );

        const res = runMigrations(db, networkMigrationsDir());
        assert.ok(res.applied.includes(MIGRATION), `${MIGRATION} должен примениться`);

        const col = columns(db, 'comments').find((c) => c.name === 'use_time');
        assert.ok(col, 'после 046 обязателен столбец comments.use_time');
        assert.equal(col!.type, 'INTEGER', 'use_time — INTEGER (bool)');
        assert.equal(col!.notnull, 1, 'use_time обязан быть NOT NULL');
        assert.equal(col!.dflt_value, '0', 'use_time по умолчанию выключен (0)');

        // Новая запись без явного use_time получает выключенный флаг.
        seedComment(db, 'new1', 'chronological', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
        assert.equal(readComment(db, 'new1').use_time, 0, 'новые записи — с флагом 0');
      } finally {
        db.close();
      }
    });

    it('приведение данных: date-only → 00:00:01.000Z, пустой valid_to → valid_from', () => {
      const db = pre046Db();
      try {
        seedComment(db, 'c-date-only', 'chronological', '2024-01-01', null);
        seedComment(db, 'c-open-ended', 'chronological', '2024-02-03T04:05:06.789Z', null);
        seedComment(db, 'c-to-date-only', 'chronological', '2024-03-04T05:06:07.000Z', '2024-03-05');
        seedComment(db, 'c-permanent', 'permanent', '2024-01-01T00:00:00.000Z', null);

        const res = runMigrations(db, networkMigrationsDir());
        assert.deepEqual(res.applied, [MIGRATION, '047_publications.sql']);

        // date-only в valid_from + пустой valid_to → оба стали маркером.
        assert.deepEqual(readComment(db, 'c-date-only'), {
          id: 'c-date-only',
          valid_from: '2024-01-01T00:00:01.000Z',
          valid_to: '2024-01-01T00:00:01.000Z',
          use_time: 0,
        });
        // Полный инстанс не тронут; пустое окончание = началу.
        assert.deepEqual(readComment(db, 'c-open-ended'), {
          id: 'c-open-ended',
          valid_from: '2024-02-03T04:05:06.789Z',
          valid_to: '2024-02-03T04:05:06.789Z',
          use_time: 0,
        });
        // date-only в valid_to сконвертирован, началу не равен.
        assert.deepEqual(readComment(db, 'c-to-date-only'), {
          id: 'c-to-date-only',
          valid_from: '2024-03-04T05:06:07.000Z',
          valid_to: '2024-03-05T00:00:01.000Z',
          use_time: 0,
        });
        // Постоянный комментарий сохраняет valid_to = NULL.
        assert.deepEqual(readComment(db, 'c-permanent'), {
          id: 'c-permanent',
          valid_from: '2024-01-01T00:00:00.000Z',
          valid_to: null,
          use_time: 0,
        });
      } finally {
        db.close();
      }
    });

    it('правило: после 046 нет date-only и нет пустого valid_to у хронологической', () => {
      const db = pre046Db();
      try {
        seedComment(db, 'c1', 'chronological', '2024-01-01', null);
        seedComment(db, 'c2', 'chronological', '2024-05-06T07:08:09.000Z', '2024-05-07');
        seedComment(db, 'c3', 'permanent', '2024-01-01T00:00:00.000Z', null);
        runMigrations(db, networkMigrationsDir());

        const dateOnlyPattern = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';
        const dateOnly = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM comments
                WHERE valid_from GLOB '${dateOnlyPattern}'
                   OR valid_to   GLOB '${dateOnlyPattern}'`,
            )
            .get() as { c: number }
        ).c;
        assert.equal(dateOnly, 0, 'date-only в valid_from/valid_to после 046 запрещён');

        const emptyChrono = (
          db
            .prepare("SELECT COUNT(*) AS c FROM comments WHERE kind = 'chronological' AND valid_to IS NULL")
            .get() as { c: number }
        ).c;
        assert.equal(emptyChrono, 0, 'пустой valid_to у хронологической после 046 запрещён');
      } finally {
        db.close();
      }
    });

    it('повторный прогон приведения данных ничего не меняет (идемпотентность)', () => {
      const db = pre046Db();
      try {
        seedComment(db, 'c1', 'chronological', '2024-01-01', null);
        seedComment(db, 'c2', 'chronological', '2024-05-06T07:08:09.000Z', '2024-05-07');
        seedComment(db, 'c3', 'permanent', '2024-01-01T00:00:00.000Z', null);
        runMigrations(db, networkMigrationsDir());

        const snapshot = () =>
          db
            .prepare('SELECT id, valid_from, valid_to, use_time FROM comments ORDER BY id')
            .all();
        const before = snapshot();

        // Повторяем шаги 2–3 миграции: приведение данных обязано быть
        // идемпотентным (шаг 1, ALTER TABLE, повторно не выполняется —
        // мигратор помнит применённый файл).
        db.exec(
          `UPDATE comments SET valid_from = valid_from || 'T00:00:01.000Z'
             WHERE valid_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';
           UPDATE comments SET valid_to = valid_to || 'T00:00:01.000Z'
             WHERE valid_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';
           UPDATE comments SET valid_to = valid_from
             WHERE kind = 'chronological' AND valid_to IS NULL;`,
        );
        assert.deepEqual(snapshot(), before, 'повторный прогон не меняет данные');

        // И сам мигратор не выполняет файл дважды.
        const res = runMigrations(db, networkMigrationsDir());
        assert.equal(res.applied.length, 0, 'повторный runMigrations ничего не применяет');
        assert.ok(res.skipped.includes(MIGRATION));
        assert.deepEqual(snapshot(), before);
      } finally {
        db.close();
      }
    });
  },
);
