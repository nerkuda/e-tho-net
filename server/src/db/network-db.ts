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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import DatabaseConstructor from 'better-sqlite3';

import { BASE_LAYER_ID } from '@etn/shared';

import type { Logger } from '../logger.js';
import { networkDbPath, networkDir, networkMigrationsDir, systemDbPath } from '../paths.js';
import { runMigrations } from './migrator.js';
import { rebuildLayerSnapshot, setupLayerContext, type LayerContext } from './layer-chain.js';
import { permanentCommentId } from './comment-permanent-id.js';
import { propertyValueId } from './property-value-id.js';
import { applyConnectionPragmas } from './pragmas.js';

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

/**
 * Networks whose `object_locks` table has already been wiped on the first open
 * of the current process (задача 2031df5e, требование 9ac48831 «сброс захватов
 * — старт»).
 *
 * `object_locks` — это физическая (не ветвимая) таблица сети; чистка должна
 * случаться ровно один раз за процесс на сеть, а не на пару
 * `(networkId, layerId)`. Иначе открытие новой (сетевой, послойной) пары
 * стирает захваты, поставленные через базовый слой — ломает идемпотентность
 * `etn.locks.acquire` (баг мысли `06764ca2-…`): пользователь ставит захват на
 * базе, переключается на новый слой через `etn.layers.select`, следующий
 * `acquire` открывает `(network, newLayer)` впервые и уничтожает свой же
 * захват из базы, после чего `INSERT` новой строки возвращает уже новый
 * `lock_id`. Ловит и реальный сценарий: тот же эффект даёт WS-гейтвей,
 * открывающий соединение на `conn.layerId` напрямую для visibility-check.
 */
const firstOpenedNetworks = new Set<string>();

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
  /** Абсолютный путь underlying `data.db` (`:memory:` for tests). */
  readonly dbPath: string;
  private readonly db: Database.Database;
  private closed = false;
  /**
   * Установленный контекст слоя (см. `layer-chain.ts`): цепочка предков, её
   * подпись и признак «чтения идут по снапшоту видимости».
   */
  private layerContext: LayerContext;
  /** Сигнал соединения на момент сборки снапшота (см. {@link readSignal}). */
  private layerSignal = '';
  /** Снапшот собран внутри транзакции соединения — на её исход он не опирается. */
  private snapshotTxnScoped = false;
  /** Кэш `SELECT total_changes()` — сигнальная проверка идёт на каждом чтении. */
  private signalStmt: Database.Statement | null = null;

  constructor(db: Database.Database, networkId: string, dbPath: string, layerId: string = BASE_LAYER_ID) {
    this.db = db;
    this.networkId = networkId;
    this.dbPath = dbPath;
    this.layerId = layerId;
    this.layerContext = setupLayerContext(db, layerId);
    this.layerSignal = this.readSignal();
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
    this.layerContext = setupLayerContext(this.db, layerId, this.layerContext.key);
    // Подпись та же — снапшот не пересобирался, и сигнал остаётся прежним:
    // если данные с тех пор изменились, читатель пересоберёт снапшот сам.
    if (this.layerContext.rebuilt) {
      this.layerSignal = this.readSignal();
      this.snapshotTxnScoped = false;
    }
    this.layerId = layerId;
  }

  /**
   * Compile a SQL string into a reusable {@link Database.Statement}.
   *
   * In a layer context, statements that return rows (SELECT…) additionally
   * guard the layer visibility snapshot: before a read runs,
   * {@link refreshLayerSnapshot} rebuilds the snapshot if the connection's write
   * signal moved. This is the single choke point for reads, so no domain call
   * site has to remember to invalidate; writes need no hook at all — the signal
   * (`total_changes()` of this connection plus `PRAGMA data_version`, which
   * catches commits of other connections) covers both own writes and foreign
   * commits. In the base context there is no snapshot, so nothing is guarded.
   */
  prepare(sql: string): Database.Statement {
    const stmt = this.db.prepare(sql);
    return stmt.reader && this.layerContext.usesSnapshot ? this.guardSnapshotRead(stmt) : stmt;
  }

  /**
   * Signal of the connection's data state: row changes made by this connection
   * (`total_changes()`, catches own writes including raw SQL and RETURNING)
   * plus `data_version` (bumped by commits of OTHER connections — the WAL
   * reader must not serve a stale layer snapshot after a foreign commit).
   *
   * Both parts are cheap scalars; the `total_changes` statement is cached.
   */
  private readSignal(): string {
    this.signalStmt ??= this.db.prepare('SELECT total_changes() AS c');
    const changes = (this.signalStmt.get() as { c: number }).c;
    const dataVersion = this.db.pragma('data_version', { simple: true }) as number;
    return `${dataVersion}:${changes}`;
  }

  /**
   * Rebuild the layer visibility snapshot when the data state moved since it was
   * built (ADR 6582c287: инвалидация при смене слоя и при изменении версий
   * слоя в рамках соединения). The signal is re-read AFTER the rebuild because
   * the rebuild itself writes to the temp snapshot tables and moves
   * `total_changes()`.
   *
   * A rebuild that happened inside a transaction is transaction-scoped: SQLite
   * rolls it back with the transaction, while the signal is a plain field and
   * would not follow. Such a rebuild is remembered ({@link snapshotTxnScoped})
   * and the signal is dropped on leaving the outermost transaction, so a
   * rolled-back domain write cannot leave a snapshot of its intent behind.
   */
  private refreshLayerSnapshot(): void {
    if (this.closed) return;
    if (this.layerSignal !== '' && this.readSignal() === this.layerSignal) return;
    rebuildLayerSnapshot(this.db);
    this.layerSignal = this.readSignal();
    this.snapshotTxnScoped = this.db.inTransaction;
  }

  /**
   * Wrap a row-returning statement so every execution first refreshes the
   * snapshot. Only `get`/`all`/`iterate` are intercepted; everything else is
   * forwarded (getters like `reader` run with the real statement as `this`).
   */
  private guardSnapshotRead(stmt: Database.Statement): Database.Statement {
    return new Proxy(stmt, {
      get: (target, prop) => {
        if (prop === 'get' || prop === 'all' || prop === 'iterate') {
          const method = (target as unknown as Record<string, (...args: unknown[]) => unknown>)[
            prop as string
          ]!;
          return (...args: unknown[]): unknown => {
            this.refreshLayerSnapshot();
            return method.apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as Database.Statement;
  }

  /**
   * Run `fn` inside a single SQLite transaction with automatic rollback on
   * throw. Use to keep multi-statement domain operations atomic (e.g., creating
   * a thought together with its link and synonyms).
   *
   * The layer snapshot is a transactional temp object: a rollback of this
   * transaction also reverts a rebuild that happened inside it. Leaving the
   * outermost transaction therefore marks the snapshot signal unknown when it
   * was rebuilt in-transaction — the next read rebuilds from the committed
   * state, so a rejected write cannot leave a snapshot of its rolled-back
   * intent behind (see {@link refreshLayerSnapshot}).
   */
  transaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    try {
      return wrapped();
    } finally {
      if (this.snapshotTxnScoped && !this.db.inTransaction) {
        this.snapshotTxnScoped = false;
        this.layerSignal = '';
      }
    }
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

  /**
   * Выполнить `PRAGMA optimize` перед закрытием соединения (требование
   * 1119cbec, ADR 0fac2771): SQLite сам решает, для каких изменившихся таблиц
   * обновить статистику. С SQLite 3.46+ объём анализа ограничивается
   * автоматически (`analysis_limit` не нужен).
   *
   * Вынесено отдельным методом — точка наблюдаемости в тесте жизненного цикла
   * соединения (`NetworkDb.close` обязан вызвать её ровно один раз).
   */
  protected optimizeStatisticsBeforeClose(): void {
    this.db.pragma('optimize');
  }

  /**
   * Close the underlying connection. Idempotent.
   *
   * Перед `close` вызывается {@link optimizeStatisticsBeforeClose}. Ошибку
   * оптимизации проглатываем: закрытие соединения не должно падать из-за
   * вспомогательной статистики.
   */
  close(): void {
    if (this.closed) return;
    try {
      this.optimizeStatisticsBeforeClose();
    } catch {
      // Статистика — вспомогательная; закрытие важнее.
    }
    this.db.close();
    this.closed = true;
  }
}

/**
 * Optional context for migration-time SQL helpers. Passed by production
 * callers ({@link openNetworkDb}) so the authorship backfill in migration 033
 * can read the first-user id; tests may omit it (the helper returns the empty
 * string and the migration falls back to a sentinel).
 */
export interface MigrationHelpersContext {
  /** Id of the root administrator (`users.is_first_user = 1`). Empty when unknown. */
  firstUserId?: string;
  /**
   * Sink for non-fatal migration warnings (`etn_migration_warn`, migration 048).
   * The runner already logs one line per applied file; this carries the finer
   * detail a migration cannot express in DDL — e.g. a row it deliberately left
   * untouched because its deterministic id was already taken in the same layer.
   * Absent in tests / contexts without a logger: warnings are then dropped.
   */
  warn?: (message: string) => void;
}

/**
 * Register the SQL functions used by DOMAIN QUERIES on any network connection
 * (bug 883267ea).
 *
 * These are not migration-only helpers — read paths call them at runtime, so
 * every connection that may execute a query must have them, not just the main
 * thread's:
 *
 *   * `type_name_key` — the normalized type-name key (trim + lowercase, same
 *     as shared `typeNameKey`) is used both by migration 017's backfill and by
 *     property-service reads (`WHERE p.name_key = type_name_key(?)`);
 *   * `unicode_lower` — case-folds non-ASCII text (SQLite's built-in `LOWER()`
 *     only handles ASCII); the structures keyword filter matches the permanent
 *     comment case-insensitively with it (03-server-api.md §6.10, bug fix
 *     0.5.5).
 *
 * Single setup point shared by the main-thread connection
 * ({@link openNetworkDb} / {@link createInMemoryNetworkDb}) and every
 * read-only reader-worker connection (`db/reader-worker.ts`). Before the fix
 * the worker applied only the pragma profile and failed with
 * `no such function: unicode_lower` on any comment-scope keyword search that
 * went through the reader pool.
 */
export function registerQueryFunctions(db: Database.Database): void {
  db.function('type_name_key', (value: unknown) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );
  db.function('unicode_lower', (value: unknown) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  );
}

/**
 * Register SQL helpers used by network migrations.
 *
 * Migration-only helpers (not needed by plain reads):
 *
 *   * `gen_uuid` supplies row ids for `thought_synonyms`/`comment_targets`
 *     rows created without an explicit id (migration 025). Deliberately
 *     registered WITHOUT the `deterministic` flag: SQLite folds a
 *     deterministic no-argument function into a constant per statement, so
 *     `INSERT … SELECT gen_uuid()` in 025 would give every row the same UUID
 *     and trip `UNIQUE (id, layer_id)`; `DEFAULT (expr)` does not require
 *     determinism (only generated columns and index expressions do), so
 *     nothing is lost by leaving the flag off.
 *   * `etn_first_user_id` exposes the id of the server's root administrator
 *     (`is_first_user = 1`) for migrations that need to backfill authorship —
 *     see task 38ba3498 / migration 033. Returns the empty string when the
 *     helper context is not provided (tests / in-memory DBs without
 *     `_system.db`); the migration interprets that as "fall back to a
 *     sentinel".
 *   * `etn_pv_id(owner_type, owner_id, property_id)` computes the
 *     deterministic `property_values` id from the natural key (bug dc119240,
 *     migration 036) — the SAME TypeScript code the domain write path uses
 *     (db/property-value-id.ts), so the migration and runtime can never
 *     disagree on an id. Registered WITH the `deterministic` flag: the
 *     function is pure, and unlike `gen_uuid` folding it into a constant per
 *     statement is exactly the desired semantics.
 *   * `etn_comment_permanent_id(owner_type, owner_id)` is the same bridge for
 *     the permanent-comment id (bug 086cb735, migration 048): it delegates to
 *     the domain's `permanentCommentId` (db/comment-permanent-id.ts), so the
 *     legacy-duplicate normalisation writes exactly the id the write path now
 *     mints. Deterministic, like `etn_pv_id`.
 *   * `etn_migration_warn(text)` records a non-fatal migration warning into
 *     {@link MigrationHelpersContext.warn} and returns NULL — the only channel
 *     a pure-SQL migration has to report a row it chose to leave alone instead
 *     of failing the whole transaction (migration 048's conflict guard).
 *
 * Migrations also use `type_name_key` (017, 021, 032, 042), so this function
 * delegates to {@link registerQueryFunctions} and existing tests that apply
 * migrations on their own connections keep working unchanged. The functions
 * must exist on the connection before `runMigrations` executes. Exported so
 * tests that apply migrations to their own connections can register the
 * helpers the same way production code does.
 */
export function registerMigrationHelpers(
  db: Database.Database,
  ctx: MigrationHelpersContext = {},
): void {
  const firstUserId = ctx.firstUserId ?? '';
  registerQueryFunctions(db);
  db.function('gen_uuid', () => randomUUID());
  db.function('etn_first_user_id', () => firstUserId);
  // Best-effort SHA-256 файла вложения для `attachments.content_hash` (миграция
  // 050, задача 369241e4). Нечитаемый/отсутствующий файл (клиентский локальный
  // путь) даёт NULL — миграция продолжается. Детерминирована по аргументу.
  db.function('etn_file_sha256', { deterministic: true }, (filePath: unknown) => {
    if (typeof filePath !== 'string' || filePath === '') return null;
    try {
      return createHash('sha256').update(readFileSync(filePath)).digest('hex');
    } catch {
      return null;
    }
  });
  db.function(
    'etn_pv_id',
    { deterministic: true },
    (ownerType: unknown, ownerId: unknown, propertyId: unknown) =>
      typeof ownerType === 'string' && typeof ownerId === 'string' && typeof propertyId === 'string'
        ? propertyValueId(ownerType, ownerId, propertyId)
        : null,
  );
  db.function(
    'etn_comment_permanent_id',
    { deterministic: true },
    (ownerType: unknown, ownerId: unknown) =>
      typeof ownerType === 'string' && typeof ownerId === 'string'
        ? permanentCommentId(ownerType, ownerId)
        : null,
  );
  db.function('etn_migration_warn', (message: unknown) => {
    if (typeof message === 'string') {
      ctx.warn?.(message);
    }
    return null;
  });
}

/**
 * Read the id of the server's root administrator (`users.is_first_user = 1`)
 * from `_system.db` for use by the authorship backfill in migration 033.
 *
 * Opens `_system.db` read-only for a single query and closes the connection;
 * network migration 033 is the only consumer. Returns the empty string when
 * the system DB is missing (no `etn init` yet) or has no first user — both
 * mean "no backfill author is known" and the migration falls back to a
 * sentinel.
 */
function readFirstUserId(dataDir: string): string {
  const path = systemDbPath(dataDir);
  if (!existsSync(path)) return '';
  const sysDb = new DatabaseConstructor(path, { readonly: true });
  try {
    const row = sysDb
      .prepare('SELECT id FROM users WHERE is_first_user = 1 LIMIT 1')
      .get() as { id: string } | undefined;
    return row?.id ?? '';
  } finally {
    sysDb.close();
  }
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
  // Единый профиль прагм соединения сети (ADR ff2ee606, требование bc312576):
  // кэш, mmap, temp_store, synchronous, busy_timeout — в одной точке открытия.
  applyConnectionPragmas(db);
  registerMigrationHelpers(db, {
    firstUserId: readFirstUserId(dataDir),
    warn: (message) => log?.warn(message),
  });

  const migrationResult = runMigrations(db, networkMigrationsDir(), log);

  // Статистика планировщика — в конце применения миграций сети (требование
  // 239be851, ADR 0fac2771): без неё планировщик строит O(мысли × рёбра) план
  // (исследование 603a8bcb). Запускаем только когда миграции реально меняли
  // схему/данные — на «степном» открытии статистика уже собрана, а полный
  // ANALYZE на каждом старте не нужен. Любая правка схемы/индексов обязана
  // заканчиваться ANALYZE, поэтому изменение гарантирует его выполнение.
  if (migrationResult.applied.length > 0) {
    db.exec('ANALYZE');
  }

  // Object locks are session-only state — захваты не переживают рестарт
  // сервера (задача 2031df5e, требование 9ac48831 «сброс захватов — старт»).
  // Миграция 034 уже создала таблицу; таблица пуста при первом открытии
  // свежей БД, но после крэша в файле могут остаться строки — удаляем их
  // один раз за процесс на сеть (`firstOpenedNetworks` фиксирует факт
  // чистки; см. пояснение у самого Set).
  if (!firstOpenedNetworks.has(networkId)) {
    firstOpenedNetworks.add(networkId);
    db.prepare('DELETE FROM object_locks WHERE network_id = ?').run(networkId);
  }

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
  applyConnectionPragmas(db);
  registerMigrationHelpers(db);
  const migrationResult = runMigrations(db, networkMigrationsDir());
  // Тот же контракт, что и у файлового открытия: миграции оставили статистику.
  if (migrationResult.applied.length > 0) {
    db.exec('ANALYZE');
  }
  return new NetworkDb(db, 'in-memory', ':memory:', layerId);
}
