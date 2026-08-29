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
import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import type { Logger } from '../logger.js';
import { networkDbPath, networkDir, networkMigrationsDir } from '../paths.js';
import { runMigrations } from './migrator.js';
import { setupLayerContext } from './layer-chain.js';

/**
 * Process-wide registry of opened network databases, keyed by
 * `(networkId, layerId)` (task S3, docs/13-layers.md §4.2).
 *
 * A connection is bound to a layer context: its temp `layer_chain` fixes what
 * the `*_v` views resolve. The same `data.db` is therefore opened once per
 * (network, layer) pair — with WAL and a single better-sqlite3 writer process
 * this is safe; reads of layered connections run on their own WAL snapshots.
 * Lookups go through {@link openNetworkDb}; never construct a {@link NetworkDb}
 * for a file-based network directly outside of that helper.
 */
const registry = new Map<string, NetworkDb>();

/** Registry key of a (network, layer) pair. */
function registryKey(networkId: string, layerId: string): string {
  return `${networkId}\u0000${layerId}`;
}

/**
 * Typed accessor for a single network's `data.db`.
 *
 * Construct directly only with an already-open connection (used by tests that
 * manage their own PRAGMA/migrations on an in-memory database); for the
 * production file-based lifecycle use {@link openNetworkDb}. The constructor
 * fills the connection's `layer_chain` for `layerId` (default — the base
 * layer), so reads through the `*_v` views work from the first statement.
 */
export class NetworkDb {
  /** Logical network id this connection belongs to. */
  readonly networkId: string;
  /**
   * Layer context of this connection (task S3, docs/13-layers.md §4.2): the
   * `*_v` views resolve rows along this layer's ancestor chain. Writes still
   * go to the base layer until materialisation lands (S4+).
   */
  layerId: string;
  /** Absolute path of the underlying `data.db` file (`:memory:` for tests). */
  readonly dbPath: string;
  private readonly db: Database.Database;
  private closed = false;

  constructor(db: Database.Database, networkId: string, dbPath: string, layerId: string = BASE_LAYER_ID) {
    this.db = db;
    this.networkId = networkId;
    this.dbPath = dbPath;
    this.layerId = layerId;
    setupLayerContext(db, layerId);
  }

  /**
   * Switch this connection's layer context: refills `layer_chain` and makes the
   * `*_v` views resolve along the new layer's ancestor chain. The production
   * path for changing context is a separate pooled connection
   * ({@link openNetworkDb} with another `layerId`); this method serves tests
   * and one-connection tools (e.g. CLI sweeps) that cannot open a second
   * connection to an in-memory database.
   */
  useLayer(layerId: string): void {
    this.assertOpen();
    setupLayerContext(this.db, layerId);
    this.layerId = layerId;
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

  /** Throw when the connection is already closed. */
  private assertOpen(): void {
    if (this.closed) {
      throw new Error('NetworkDb is closed');
    }
  }

  /** Close the underlying connection. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

/**
 * Register SQL helpers used by network migrations.
 *
 * `type_name_key` computes the normalized type-name key (trim + lowercase,
 * same as shared `typeNameKey`) for the backfill in migration 017; `gen_uuid`
 * (deterministic flag only to satisfy SQLite's rules for `DEFAULT (expr)`,
 * each call still returns a fresh UUID, see migration 025) supplies row ids
 * for `thought_synonyms`/`comment_targets` rows created without an explicit id.
 * Both must exist on the connection before `runMigrations` executes. Exported
 * so tests that apply migrations to their own connections can register the
 * helpers the same way production code does.
 */
export function registerMigrationHelpers(db: Database.Database): void {
  db.function('type_name_key', (value: unknown) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
  db.function('gen_uuid', { deterministic: true }, () => randomUUID());
}

/**
 * Open (or reuse) the `data.db` for `networkId` under `dataDir` in the context
 * of `layerId` (default — the base layer).
 *
 * On first open for a given (network, layer) pair the network directory tree
 * `networks/<id>/{,attachments/,snapshots/}` is created, the database file is
 * opened with `journal_mode=WAL` and `foreign_keys=ON`, pending migrations
 * from `migrations/network/` are applied, and the connection's temp
 * `layer_chain` is filled for `layerId` — reads through the `*_v` views then
 * resolve along that layer's ancestor chain (docs/13-layers.md §4.2).
 * Subsequent calls with the same pair return the already-open {@link NetworkDb}
 * from the registry without touching the filesystem again.
 *
 * @param dataDir - absolute ETN data directory (`ETN_DATA_DIR`).
 * @param networkId - network UUID (also the directory name under `networks/`).
 * @param log - optional logger for migration progress.
 * @param layerId - layer context of the connection (task S3). Until layer
 *   selection lands (S7) every caller works in the base layer.
 */
export function openNetworkDb(
  dataDir: string,
  networkId: string,
  log?: Logger,
  layerId: string = BASE_LAYER_ID,
): NetworkDb {
  const key = registryKey(networkId, layerId);
  const existing = registry.get(key);
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

  let ndb: NetworkDb;
  try {
    ndb = new NetworkDb(db, networkId, dbPath, layerId);
  } catch (err) {
    // The layer context must exist before reads run (setupLayerContext);
    // a bad layerId must not leak the freshly opened connection.
    db.close();
    throw err;
  }
  registry.set(key, ndb);
  return ndb;
}

/**
 * Return the already-open {@link NetworkDb} for `networkId` (base-layer
 * connection by default, or the connection of a specific layer), or
 * `undefined` if that pair is not currently open. Does not touch the
 * filesystem.
 */
export function getOpenNetworkDb(networkId: string, layerId: string = BASE_LAYER_ID): NetworkDb | undefined {
  return registry.get(registryKey(networkId, layerId));
}

/**
 * Close and drop registry entries of `networkId`. Without `layerId` every
 * layer-context connection of the network is closed (used when a whole network
 * goes away); with it — only that layer's connection. Safe to call when
 * nothing is open (returns `false`).
 *
 * @returns `true` if at least one connection was closed, `false` otherwise.
 */
export function closeNetworkDb(networkId: string, layerId?: string): boolean {
  if (layerId !== undefined) {
    const key = registryKey(networkId, layerId);
    const ndb = registry.get(key);
    if (!ndb) {
      return false;
    }
    ndb.close();
    registry.delete(key);
    return true;
  }
  let closed = false;
  for (const key of [...registry.keys()]) {
    if (registry.get(key)?.networkId !== networkId) continue;
    registry.get(key)?.close();
    registry.delete(key);
    closed = true;
  }
  return closed;
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
 * Build an in-memory {@link NetworkDb} with migrations already applied, bound
 * to the base-layer context by default (or to `layerId` — task S3 tests build
 * layered hierarchies in raw SQL and read them through the resolution views).
 *
 * Intended for unit tests of the domain services (tasks C3–C6): avoids disk I/O
 * and registry interactions. The returned instance is **not** registered, so it
 * must be closed by the caller (and is not affected by {@link closeAll}).
 *
 * Requires the `better-sqlite3` native binding; callers usually gate the whole
 * suite on a `nativeAvailable()` check.
 */
export function createInMemoryNetworkDb(layerId: string = BASE_LAYER_ID): NetworkDb {
  const db = new DatabaseConstructor(':memory:');
  db.pragma('foreign_keys = ON');
  registerMigrationHelpers(db);
  runMigrations(db, networkMigrationsDir());
  return new NetworkDb(db, 'in-memory', ':memory:', layerId);
}
