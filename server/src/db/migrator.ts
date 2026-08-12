/**
 * Generic SQL migration runner for `better-sqlite3` databases.
 *
 * Each database (`_system.db`, per-network `data.db`) owns a `_migrations`
 * table (docs/02-data-model.md §5) that records which migration files have been
 * applied. This module applies every `*.sql` file from a directory, in
 * alphabetical order, that has not yet been recorded. Each file runs in its own
 * transaction; on failure the transaction rolls back and the row is not
 * recorded, so the next run retries from the same point.
 *
 * Idempotency at the checkpoint is the SQL author's responsibility
 * (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`); the runner guarantees only
 * that an already-recorded migration is never re-executed.
 */

import type Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Logger } from '../logger.js';

/** Outcome of a single {@link runMigrations} call. */
export interface MigrationResult {
  /** File names applied during this run, in execution order. */
  applied: string[];
  /** File names skipped because they were already recorded. */
  skipped: string[];
}

/**
 * Error raised when a migration directory is missing or a migration fails.
 * The failing file name is included in the message; the original cause is
 * attached via `Error.cause`.
 */
export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/** DDL for the `_migrations` bookkeeping table (idempotent). */
const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);
`;

/** Row shape of `_migrations`. */
interface MigrationRow {
  name: string;
}

/**
 * Apply pending `*.sql` migrations from `migrationsDir` to `db`.
 *
 * Files are read in alphabetical order so that a fixed-width numeric prefix
 * (`001_`, `002_`, …) defines the application order. A file already present in
 * `_migrations` is skipped. Each pending file is executed inside a transaction;
 * the bookkeeping row is inserted in the same transaction so a failure leaves no
 * partial state.
 *
 * @param db - open `better-sqlite3` connection (system or network database).
 * @param migrationsDir - absolute path to a directory of `*.sql` files.
 * @param log - optional logger; emits one line per applied migration.
 * @returns the lists of applied and skipped file names.
 * @throws {MigrationError} if `migrationsDir` does not exist or a migration fails.
 */
export function runMigrations(
  db: Database.Database,
  migrationsDir: string,
  log?: Logger,
): MigrationResult {
  if (!existsSync(migrationsDir)) {
    throw new MigrationError(`Migrations directory does not exist: ${migrationsDir}`);
  }

  // Ensure the bookkeeping table exists, then load already-applied file names.
  db.exec(MIGRATIONS_TABLE_SQL);
  const rows = db.prepare('SELECT name FROM _migrations').all() as MigrationRow[];
  const appliedSet = new Set(rows.map((r) => r.name));

  // List *.sql files in stable alphabetical order.
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const file of files) {
    if (appliedSet.has(file)) {
      result.skipped.push(file);
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sql = readFileSync(filePath, 'utf8');

    // Single transaction: DDL/DML + bookkeeping row succeed or roll back together.
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        new Date().toISOString(),
      );
    });

    try {
      apply();
    } catch (err) {
      throw new MigrationError(`Failed to apply migration "${file}": ${(err as Error).message}`, {
        cause: err,
      });
    }

    result.applied.push(file);
    log?.info({ migration: file }, 'Applied database migration');
  }

  return result;
}
