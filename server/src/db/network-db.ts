/**
 * `NetworkDb` — typed wrapper over a single network's `data.db` SQLite database
 * (docs/02-data-model.md §3).
 *
 * Responsibilities (task C1):
 *   * open (or create) the per-network directory tree
 *     `networks/<id>/{,attachments/,snapshots/}` and the `data.db` file;
 *   * enable `journal_mode=WAL` and `foreign_keys=ON`;
 *   * apply pending network migrations via the shared {@link runMigrations}
 *     runner (docs/02-data-model.md §5);
 *   * keep a process-wide registry of opened networks so the same file is never
 *     opened twice, and expose orderly shutdown ({@link closeNetworkDb} /
 *     {@link closeAll}).
 *
 * The class is a deliberately thin layer over `better-sqlite3`: domain services
 * (tasks C3–C6) prepare their own statements through {@link NetworkDb.prepare}
 * and run multi-statement operations inside {@link NetworkDb.transaction}.
 * `better-sqlite3` statements are synchronous and re-entrant within a
 * transaction, which matches the ETN domain layer's needs.
 *
 * Booleans map to INTEGER 0/1 at the SQLite boundary; the domain services
 * convert to/from real booleans when materialising `@etn/shared` types.
 */

import path from 'node:path';
import { mkdirSync } from 'node:fs';

import type Database from 'better-sqlite3';
import DatabaseConstructor from 'better-sqlite3';

import type { Logger } from '../logger.js';
import { networkDbPath, networkDir, networkMigrationsDir } from '../paths.js';
import { runMigrations } from './migrator.js';

/**
 * Process-wide registry of opened network databases, keyed by `networkId`.
 *
 * A single server process keeps one open connection per network for its whole
 * lifetime (MVP has no clustering). Lookups go through {@link openNetworkDb};
 * never construct a {@link NetworkDb} for a file-based network directly outside
 * of that helper.
 */
const registry = new Map<string, NetworkDb>();

/**
 * Typed accessor for a single network's `data.db`.
 *
 * Construct directly only with an already-open connection (used by tests that
 * manage their own PRAGMA/migrations on an in-memory database); for the
 * production file-based lifecycle use {@link openNetworkDb}.
 */
export class NetworkDb {
  /** Logical network id this connection belongs to. */
  readonly networkId: string;
  /** Absolute path of the underlying `data.db` file (`:memory:` for tests). */
  readonly dbPath: string;
  private readonly db: Database.Database;
  private closed = false;

  constructor(db: Database.Database, networkId: string, dbPath: string) {
    this.db = db;
    this.networkId = networkId;
    this.dbPath = dbPath;
  }

  /**
   * Compile a SQL string into a reusable {@link Database.Statement}. Domain
   * services call this per-operation; `better-sqlite3` compilation is cheap and
   * statements are safely GC-able once dropped.
   */
  prepare(sql: string): Database.Statement {
    return this.db.prepare(sql);
  }

  /**
   * Run `fn` inside a single SQLite transaction with automatic rollback on
   * throw. Use to keep multi-statement domain operations atomic (e.g. creating
   * a thought together with its link and synonyms).
   */
  transaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped();
  }

  /** Execute raw SQL (multiple statements allowed). Used by migrations/tests. */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Run a PRAGMA and return its rows. */
  pragma(pragma: string): unknown {
    return this.db.pragma(pragma);
  }

  /** True once {@link close} has been called. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Close the underlying connection. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

/**
 * Register SQL helpers used by network migrations. `type_name_key` computes
 * the normalized type-name key (trim + lowercase, same as shared `typeNameKey`)
 * for the backfill in migration 017; it must exist on the connection before
 * `runMigrations` executes. Exported so tests that apply migrations to their
 * own connections can register the helpers the same way production code does.
 */
export function registerMigrationHelpers(db: Database.Database): void {
  db.function('type_name_key', (value: unknown) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
}

/**
 * Open (or reuse) the `data.db` for `networkId` under `dataDir`.
 *
 * On first open for a given id the network directory tree
 * `networks/<id>/{,attachments/,snapshots/}` is created, the database file is
 * opened with `journal_mode=WAL` and `foreign_keys=ON`, and pending migrations
 * from `migrations/network/` are applied. Subsequent calls with the same
 * `networkId` return the already-open {@link NetworkDb} from the registry
 * without touching the filesystem again.
 *
 * @param dataDir - absolute ETN data directory (`ETN_DATA_DIR`).
 * @param networkId - network UUID (also the directory name under `networks/`).
 * @param log - optional logger for migration progress.
 */
export function openNetworkDb(dataDir: string, networkId: string, log?: Logger): NetworkDb {
  const existing = registry.get(networkId);
  if (existing) {
    return existing;
  }

  // Create the full directory tree for the network (docs/02-data-model.md §4):
  // networks/<id>/, attachments/, snapshots/. `attachments/` is reserved for a
  // future upload feature; `snapshots/` for `VACUUM INTO` backups.
  const dir = networkDir(dataDir, networkId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(dir, 'attachments'), { recursive: true });
  mkdirSync(path.join(dir, 'snapshots'), { recursive: true });

  const dbPath = networkDbPath(dataDir, networkId);
  const db = new DatabaseConstructor(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  registerMigrationHelpers(db);

  runMigrations(db, networkMigrationsDir(), log);

  const ndb = new NetworkDb(db, networkId, dbPath);
  registry.set(networkId, ndb);
  return ndb;
}

/**
 * Return the already-open {@link NetworkDb} for `networkId`, or `undefined` if
 * the network is not currently open. Does not touch the filesystem.
 */
export function getOpenNetworkDb(networkId: string): NetworkDb | undefined {
  return registry.get(networkId);
}

/**
 * Close and drop the registry entry for `networkId`. Safe to call when the
 * network is not open (returns `false`).
 *
 * @returns `true` if a connection was closed, `false` if nothing was open.
 */
export function closeNetworkDb(networkId: string): boolean {
  const ndb = registry.get(networkId);
  if (!ndb) {
    return false;
  }
  ndb.close();
  registry.delete(networkId);
  return true;
}

/**
 * Close every open network database. Intended for orderly server shutdown and
 * tests that need a clean slate.
 */
export function closeAll(): void {
  for (const ndb of registry.values()) {
    ndb.close();
  }
  registry.clear();
}

/**
 * Build an in-memory {@link NetworkDb} with migrations already applied.
 *
 * Intended for unit tests of the domain services (tasks C3–C6): avoids disk I/O
 * and registry interactions. The returned instance is **not** registered, so it
 * must be closed by the caller (and is not affected by {@link closeAll}).
 *
 * Requires the `better-sqlite3` native binding; callers usually gate the whole
 * suite on a `nativeAvailable()` check.
 */
export function createInMemoryNetworkDb(): NetworkDb {
  const db = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  registerMigrationHelpers(db);
  runMigrations(db, networkMigrationsDir());
  return new NetworkDb(db, 'in-memory', ':memory:');
}
