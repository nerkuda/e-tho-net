/**
 * Тесты миграции `043_type_properties_canonical_unique.sql` (ошибка
 * e7dfb36a-406c-4f0f-9abb-b90518f103e9 «Привязка свойства к типу падает с 500:
 * UNIQUE-ключ type_properties расходится с кодом»).
 *
 * Ранняя (dev) редакция миграции 041 пересобирала `type_properties` с
 * пятиколоночным ключом `UNIQUE (owner_type, owner_id, property_id, side,
 * layer_id)` и без частичного
 * `idx_type_properties_owner_property_layer_side`. Файл 041 к тому моменту уже
 * был записан в `_migrations`, поэтому более поздняя редакция
 * (`ALTER TABLE … ADD COLUMN side`) к таким базам не применяется — схема
 * остаётся расходящейся навсегда. `createTypeProperty`
 * (server/src/domain/property-service.ts) пишет привязку через
 * `ON CONFLICT (owner_type, owner_id, property_id, layer_id)`, и на такой
 * таблице SQLite бросает `SQLITE_ERROR: ON CONFLICT clause does not match any
 * PRIMARY KEY or UNIQUE constraint` — это не EtnError, поэтому REST отдаёт 500.
 *
 * Четыре сценария:
 *   * регрессия: «пострадавший» вид таблицы воспроизводит симптом (привязка
 *     падает SQLITE_ERROR), после 043 схема канонична и привязка проходит;
 *   * каноничная база: 043 пересобирает таблицу, но не меняет ни строк, ни
 *     колонок, ни ограничений, ни индексов (условного DDL в SQLite нет);
 *   * дедупликация: пятиколоночный ключ допускал две строки одной тройки
 *     (owner_type, owner_id, property_id, layer_id) — выживает `side='source'`,
 *     иначе `side='target'`, иначе строка с минимальным `pk`;
 *   * повторный прогон файла на уже открытом соединении (temp-представления
 *     слоёв `*_v` живы) — не падает и не теряет данные.
 *
 * Пропущено, когда недоступен нативный модуль `better-sqlite3`.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import { NetworkDb, registerMigrationHelpers } from '../src/db/network-db.js';
import { runMigrations } from '../src/db/migrator.js';
import { createTypeProperty } from '../src/domain/property-service.js';
import { createThoughtType } from '../src/domain/thought-type-service.js';
import { networkMigrationsDir } from '../src/paths.js';

/** Файл миграции, ради которой заведён этот набор. */
const MIGRATION = '043_type_properties_canonical_unique.sql';

/** Автор записей в тесте. */
const ACTOR = '11111111-1111-4111-8111-111111111111';

/** True when the `better-sqlite3` native binding loads. */
function nativeAvailable(): boolean {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Свежая сеть, доведённая ровно до 042 — состояние «каноничная схема, 043 ещё
 * не применена». Возвращает соединение и обёртку (её конструктор создаёт
 * temp-представления слоёв `*_v`, как это делает `openNetworkDb` для
 * существующей сети).
 */
function pre043Db(): { db: Database.Database; ndb: NetworkDb } {
  const dir = mkdtempSync(path.join(tmpdir(), 'etn-mig043-'));
  for (const f of readdirSync(networkMigrationsDir()).filter(
    (f) => f.endsWith('.sql') && f < '043',
  )) {
    cpSync(path.join(networkMigrationsDir(), f), path.join(dir, f));
  }
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  registerMigrationHelpers(db);
  runMigrations(db, dir);
  rmSync(dir, { recursive: true, force: true });
  return { db, ndb: new NetworkDb(db, 'mig-043', ':memory:') };
}

/** Записать миграцию в очередь: сеть «догоняет» схему при следующем открытии. */
function forgetMigration(db: Database.Database, name: string): void {
  db.prepare('DELETE FROM _migrations WHERE name = ?').run(name);
}

/** Идентификатор живой привязки — цель `ON CONFLICT` в доменном коде. */
const ON_CONFLICT_TARGET = 'owner_type, owner_id, property_id, layer_id';

/** Список табличных UNIQUE-ограничений `type_properties` (нормализованный). */
function uniqueKeys(db: Database.Database): string[] {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'type_properties'")
    .get() as { sql: string } | undefined;
  const out: string[] = [];
  const re = /UNIQUE\s*\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(row?.sql ?? '')) !== null) {
    out.push(m[1]!.replace(/\s+/g, ' ').trim());
  }
  return out.sort();
}

/** Снимок таблицы: колонки, уникальные ключи, индексы и строки. */
interface TableSnapshot {
  columns: string[];
  uniques: string[];
  indexes: string[];
  rows: unknown[];
}

function snapshot(db: Database.Database): TableSnapshot {
  const columns = (
    db.prepare('SELECT name FROM pragma_table_info(?)').all('type_properties') as {
      name: string;
    }[]
  ).map((r) => r.name);
  const indexes = (
    db
      .prepare(
        `SELECT name, COALESCE(sql, '') AS sql FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'type_properties' ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>
  ).map((r) => `${r.name}: ${r.sql.replace(/\s+/g, ' ').trim()}`);
  const rows = db.prepare('SELECT * FROM type_properties ORDER BY pk').all();
  return { columns, uniques: uniqueKeys(db), indexes, rows };
}

/**
 * Привести `type_properties` к «пострадавшему» виду: пятиколоночный ключ
 * `UNIQUE (owner_type, owner_id, property_id, side, layer_id)`, частичного
 * индекса по стороне нет — ровно то, что оставила ранняя редакция 041 в базах
 * полигона и пользователя. Строки при этом сохраняются.
 *
 * `legacy_alter_table` — чтобы пересборка-«заготовка» переживала живые
 * temp-представления `*_v` (см. одноимённый шаг в самой миграции 043).
 */
function toAffectedShape(db: Database.Database): void {
  db.exec(`
    PRAGMA legacy_alter_table = ON;
    CREATE TABLE type_properties_affected (
      pk           INTEGER PRIMARY KEY AUTOINCREMENT,
      id           TEXT NOT NULL,
      layer_id     TEXT NOT NULL DEFAULT '${BASE_LAYER_ID}'
                   REFERENCES layers (id) ON DELETE CASCADE,
      deleted      INTEGER NOT NULL DEFAULT 0,
      base_version INTEGER NOT NULL DEFAULT 0,
      owner_type   TEXT NOT NULL,
      owner_id     TEXT NOT NULL,
      property_id  TEXT NOT NULL,
      required     INTEGER NOT NULL DEFAULT 0,
      position     INTEGER NOT NULL DEFAULT 0,
      side         TEXT CHECK (side IS NULL OR side IN ('source', 'target')),
      UNIQUE (id, layer_id),
      UNIQUE (owner_type, owner_id, property_id, side, layer_id)
    );
    INSERT INTO type_properties_affected (pk, id, layer_id, deleted, base_version,
                                          owner_type, owner_id, property_id, required, position, side)
    SELECT pk, id, layer_id, deleted, base_version,
           owner_type, owner_id, property_id, required, position, side
      FROM type_properties;
    DROP TABLE type_properties;
    ALTER TABLE type_properties_affected RENAME TO type_properties;
    CREATE INDEX idx_type_properties_owner ON type_properties (owner_type, owner_id, position);
    CREATE INDEX idx_type_properties_layer ON type_properties (layer_id);
    CREATE INDEX idx_type_properties_property ON type_properties (property_id);
    PRAGMA legacy_alter_table = OFF;
  `);
}

/** Живая привязка в основе — сырыми колонками (дедупликация тестируется ниже домена). */
function seedBinding(
  db: Database.Database,
  row: {
    pk: number;
    id: string;
    ownerId: string;
    propertyId: string;
    side: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO type_properties (pk, id, layer_id, deleted, base_version,
                                  owner_type, owner_id, property_id, required, position, side)
     VALUES (?, ?, ?, 0, 0, 'thought_type', ?, ?, 0, 0, ?)`,
  ).run(row.pk, row.id, BASE_LAYER_ID, row.ownerId, row.propertyId, row.side);
}

describe('migration 043: канонический UNIQUE-ключ type_properties', { skip: !nativeAvailable() }, () => {
  it('регрессия e7dfb36a: «пострадавший» ключ ломает привязку, 043 её чинит', () => {
    const { db, ndb } = pre043Db();
    try {
      const type = createThoughtType(ndb, { name: 'Тип-репро' }, ACTOR);
      toAffectedShape(db);

      // Симптом: SQLite не находит цель ON CONFLICT — это SQLITE_ERROR, а не
      // EtnError; именно поэтому HTTP-слой отдаёт 500 «Внутренняя ошибка».
      assert.throws(
        () =>
          createTypeProperty(ndb, 'thought_type', type.id, { key: 'Проверка', value_type: 'text' }, ACTOR),
        (err: unknown) => {
          const e = err as Error & { code?: string };
          assert.equal(e.code, 'SQLITE_ERROR', `ожидался SQLITE_ERROR, получено: ${String(err)}`);
          assert.match(e.message, /ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint/);
          return true;
        },
      );

      // Сеть открывается новой сборкой: 043 доводит схему до канонической.
      const res = runMigrations(db, networkMigrationsDir());
      assert.deepEqual(res.applied, [MIGRATION]);
      assert.deepEqual(uniqueKeys(db), ['id, layer_id', ON_CONFLICT_TARGET]);

      // Та же привязка тем же доменным путём проходит.
      const binding = createTypeProperty(
        ndb,
        'thought_type',
        type.id,
        { key: 'Проверка', value_type: 'text' },
        ACTOR,
      );
      assert.ok(binding.id.length > 0);
      const row = db
        .prepare('SELECT side, deleted FROM type_properties WHERE id = ? AND layer_id = ?')
        .get(binding.id, BASE_LAYER_ID) as { side: string | null; deleted: number } | undefined;
      assert.ok(row !== undefined, 'строка привязки должна лежать в type_properties');
      assert.equal(row.deleted, 0);
    } finally {
      db.close();
    }
  });

  it('каноничная база: пересборка не меняет ни строк, ни колонок, ни ограничений, ни индексов', () => {
    const { db, ndb } = pre043Db();
    try {
      const type = createThoughtType(ndb, { name: 'Тип-канон' }, ACTOR);
      const scalar = createTypeProperty(
        ndb,
        'thought_type',
        type.id,
        { key: 'скаляр', value_type: 'text' },
        ACTOR,
      );
      seedBinding(db, {
        pk: 900,
        id: '99999999-9999-4999-8999-999999999999',
        ownerId: type.id,
        propertyId: scalar.id,
        side: 'source',
      });
      const before = snapshot(db);
      assert.ok(before.rows.length > 0, 'снимок должен быть непустым');

      forgetMigration(db, MIGRATION);
      assert.deepEqual(runMigrations(db, networkMigrationsDir()).applied, [MIGRATION]);

      const after = snapshot(db);
      assert.deepEqual(after.rows, before.rows, 'строки не должны меняться');
      assert.deepEqual(after.columns, before.columns, 'колонки не должны меняться');
      assert.deepEqual(after.uniques, before.uniques, 'уникальные ключи не должны меняться');
      assert.deepEqual(after.indexes, before.indexes, 'индексы не должны меняться');
    } finally {
      db.close();
    }
  });

  it('дедупликация: выживает source, иначе target, иначе минимальный pk', () => {
    const { db, ndb } = pre043Db();
    try {
      const type = createThoughtType(ndb, { name: 'Тип-дубли' }, ACTOR);
      toAffectedShape(db);

      // Группа 1: target с меньшим pk и source с большим — побеждает source
      // (привязка источника покрывает оба направления, правило миграции 042).
      seedBinding(db, { pk: 10, id: 'dup-1-target', ownerId: type.id, propertyId: 'p-1', side: 'target' });
      seedBinding(db, { pk: 11, id: 'dup-1-source', ownerId: type.id, propertyId: 'p-1', side: 'source' });
      // Группа 2: NULL с меньшим pk и target с большим — побеждает target.
      seedBinding(db, { pk: 12, id: 'dup-2-null', ownerId: type.id, propertyId: 'p-2', side: null });
      seedBinding(db, { pk: 13, id: 'dup-2-target', ownerId: type.id, propertyId: 'p-2', side: 'target' });
      // Группа 3: два NULL-а (пятиколоночный ключ считает NULL-ы различными) —
      // побеждает минимальный pk.
      seedBinding(db, { pk: 14, id: 'dup-3-first', ownerId: type.id, propertyId: 'p-3', side: null });
      seedBinding(db, { pk: 15, id: 'dup-3-second', ownerId: type.id, propertyId: 'p-3', side: null });

      forgetMigration(db, MIGRATION);
      assert.deepEqual(runMigrations(db, networkMigrationsDir()).applied, [MIGRATION]);

      const rows = db
        .prepare(
          `SELECT pk, id, side FROM type_properties
            WHERE owner_id = ? AND property_id IN ('p-1', 'p-2', 'p-3')
            ORDER BY property_id`,
        )
        .all(type.id) as Array<{ pk: number; id: string; side: string | null }>;
      assert.deepEqual(rows, [
        { pk: 11, id: 'dup-1-source', side: 'source' },
        { pk: 13, id: 'dup-2-target', side: 'target' },
        { pk: 14, id: 'dup-3-first', side: null },
      ]);

      // Повторный прогон на каноничной таблице результат не меняет.
      forgetMigration(db, MIGRATION);
      assert.deepEqual(runMigrations(db, networkMigrationsDir()).applied, [MIGRATION]);
      const again = db
        .prepare(
          `SELECT pk, id, side FROM type_properties
            WHERE owner_id = ? AND property_id IN ('p-1', 'p-2', 'p-3')
            ORDER BY property_id`,
        )
        .all(type.id);
      assert.deepEqual(again, rows);
    } finally {
      db.close();
    }
  });

  it('повторный прогон на уже открытом соединении (temp-представления слоёв живы) не падает', () => {
    const { db, ndb } = pre043Db();
    try {
      // `new NetworkDb` в pre043Db уже создал temp-представления `*_v` —
      // повторяем прогон файла на этом же соединении.
      const type = createThoughtType(ndb, { name: 'Тип-слой' }, ACTOR);
      createTypeProperty(ndb, 'thought_type', type.id, { key: 'поле', value_type: 'text' }, ACTOR);
      const before = snapshot(db);

      forgetMigration(db, MIGRATION);
      // Без `PRAGMA legacy_alter_table = ON` внутри 043 подмена падает:
      // `error in view type_properties_v: no such table: main.type_properties`.
      assert.deepEqual(runMigrations(db, networkMigrationsDir()).applied, [MIGRATION]);

      assert.deepEqual(snapshot(db).rows, before.rows, 'строки должны пережить пересборку');
      const visible = db.prepare('SELECT COUNT(*) AS c FROM type_properties_v').get() as {
        c: number;
      };
      assert.equal(visible.c, before.rows.length, 'представление слоя должно читаться');
    } finally {
      db.close();
    }
  });
});
