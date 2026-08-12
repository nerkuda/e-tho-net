/**
 * Lightweight SQL migration runner for the client local DB
 * (docs/07-client-electron.md §3, workplan G3).
 *
 * Mirrors the server-side migrator principle (workplan B2) but is intentionally
 * minimal: migration files live in `client/migrations/NNN_<slug>.sql`, are
 * discovered by numeric prefix, applied in order, and tracked in a per-DB
 * `_migrations` table. Each migration runs inside a transaction and is expected
 * to be idempotent at its checkpoint (`CREATE TABLE IF NOT EXISTS`, etc.) so a
 * partially-applied history can be re-run safely.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

/** A single migration loaded from disk. */
export interface Migration {
  /** Numeric id parsed from the `NNN_` filename prefix. */
  id: number;
  /** Filename, including the `.sql` suffix. */
  name: string;
  /** Raw SQL body. */
  sql: string;
}

/** Record of a migration that has been written to `_migrations`. */
export interface AppliedMigration {
  id: number;
  name: string;
}

/** File extension for migration files. */
const MIGRATION_SUFFIX = '.sql';

/** DDL that creates the bookkeeping table itself. */
const MIGRATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS _migrations (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
`;

interface MigrationRow {
  id: number;
  name: string;
}

/**
 * Loads `*.sql` migration files from `dir`, deriving their numeric id from the
 * leading `NNN_` prefix, and returns them sorted ascending by id.
 *
 * @throws if a migration filename lacks the `NNN_` prefix or two files share
 *   the same id.
 */
export function loadMigrations(dir: string): Migration[] {
  const names = fs.readdirSync(dir).filter((f) => f.endsWith(MIGRATION_SUFFIX));
  const migrations: Migration[] = [];
  for (const name of names) {
    const match = /^(\d+)_/.exec(name);
    if (!match) {
      throw new Error(`ETN: миграция должна начинаться с числа: ${name}`);
    }
    const id = Number.parseInt(match[1]!, 10);
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    migrations.push({ id, name, sql });
  }

  migrations.sort((a, b) => a.id - b.id);

  // Detect duplicate ids (e.g. two files with the same numeric prefix).
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.id === migrations[i - 1]!.id) {
      throw new Error(
        `ETN: дублирующийся id миграции ${migrations[i]!.id} (${migrations[i]!.name}, ${migrations[i - 1]!.name})`,
      );
    }
  }

  return migrations;
}

/**
 * Applies pending migrations from `dir` to `db`.
 *
 * Ensures the `_migrations` table exists, then runs each not-yet-recorded file
 * inside a transaction (DDL + insert of the bookkeeping row). Already-applied
 * migrations are skipped, making the runner safe to call on every startup.
 *
 * @returns the migrations applied during this call (empty if the DB was current).
 */
export function migrateDatabase(db: Database.Database, dir: string): AppliedMigration[] {
  db.exec(MIGRATIONS_SCHEMA);

  const appliedRows = db.prepare('SELECT id, name FROM _migrations').all() as MigrationRow[];
  const appliedIds = new Set(appliedRows.map((r) => r.id));

  const recordApplied = db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)');
  const newlyApplied: AppliedMigration[] = [];

  for (const migration of loadMigrations(dir)) {
    if (appliedIds.has(migration.id)) continue;

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      recordApplied.run(migration.id, migration.name);
    });
    apply();

    newlyApplied.push({ id: migration.id, name: migration.name });
  }

  return newlyApplied;
}
