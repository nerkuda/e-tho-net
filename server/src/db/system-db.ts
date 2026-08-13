/**
 * `SystemDb` — typed wrapper over the `_system.db` SQLite database
 * (docs/02-data-model.md §2).
 *
 * Responsibilities (task B4):
 *   * open the database file (creating it if missing), set `journal_mode=WAL`
 *     and `foreign_keys=ON`, and apply pending migrations;
 *   * own the prepared statements and expose the small set of operations needed
 *     by tasks B5 (API-key auth) and B6 (`etn init`). Richer CRUD (admin/user
 *     routes, preferences, audit query) is layered on top in B12–B14.
 *
 * Booleans map to INTEGER 0/1 at the SQLite boundary; the {@link User} / {@link
 * ApiKey} domain types carry real booleans (per @etn/shared).
 */

import type Database from 'better-sqlite3';
import DatabaseConstructor from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

import type { ApiKey, AuditCategory, NetworkRole, User } from '@etn/shared';
import { IDEMPOTENCY_TTL_MINUTES } from '@etn/shared';

import type { Logger } from '../logger.js';
import { systemDbPath, systemMigrationsDir } from '../paths.js';
import { runMigrations } from './migrator.js';

/** Raw `users` row shape (INTEGER booleans). */
interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  is_admin: number;
  is_first_user: number;
  disabled: number;
  created_at: string;
  updated_at: string;
}

/** Raw `api_keys` row shape (INTEGER booleans). */
interface ApiKeyRow {
  id: string;
  user_id: string;
  label: string | null;
  key_hash: string;
  key_prefix: string;
  read_only: number;
  disabled: number;
  created_at: string;
  last_used_at: string | null;
}

/** Convert a raw users row to a {@link User} (booleans). */
function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    username: r.username,
    display_name: r.display_name,
    is_admin: r.is_admin === 1,
    is_first_user: r.is_first_user === 1,
    disabled: r.disabled === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Convert a raw api_keys row to an {@link ApiKey} (booleans, hash omitted). */
function rowToApiKey(r: ApiKeyRow): ApiKey {
  return {
    id: r.id,
    user_id: r.user_id,
    label: r.label,
    prefix: r.key_prefix,
    read_only: r.read_only === 1,
    disabled: r.disabled === 1,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
  };
}

/** Input for {@link SystemDb.createUser}. */
export interface CreateUserParams {
  id: string;
  username: string;
  displayName: string | null;
  /** Defaults to false. */
  isAdmin?: boolean;
  /** Defaults to false; set true only for the `etn init` root user. */
  isFirstUser?: boolean;
}

/** Input for {@link SystemDb.createApiKey}. */
export interface CreateApiKeyParams {
  id: string;
  userId: string;
  label: string | null;
  /** SHA-256 hex digest of the full key. */
  keyHash: string;
  /** First {@link API_KEY_PREFIX_LENGTH} hex chars after `etn_`. */
  keyPrefix: string;
  /** Defaults to false. */
  readOnly?: boolean;
}

/** Input for {@link SystemDb.insertAuditLog}. */
export interface InsertAuditLogParams {
  /** User performing the action; `null`/omitted for the system actor. */
  actorUserId?: string | null;
  /** Network context; `null`/omitted for system-level operations. */
  networkId?: string | null;
  category: AuditCategory;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** Any JSON-serialisable value; stored as TEXT. */
  details?: unknown;
}

/** Result of {@link SystemDb.findApiKeyByHash} — key plus its owner. */
export interface ApiKeyWithUser {
  apiKey: ApiKey;
  user: User;
}

/** A still-fresh cached idempotent response (02-data-model.md §2.7). */
export interface CachedResponse {
  status: number;
  /** JSON-encoded body as stored. */
  body: string | null;
}

/**
 * Typed accessor for `_system.db`.
 *
 * Construct directly with an open {@link Database} connection (used by tests
 * that manage their own PRAGMA/migrations), or via {@link SystemDb.open} for the
 * full production lifecycle.
 */
export class SystemDb {
  private readonly db: Database.Database;
  private readonly stInsertUser: Database.Statement;
  private readonly stGetUserById: Database.Statement;
  private readonly stGetUserByUsername: Database.Statement;
  private readonly stInsertApiKey: Database.Statement;
  private readonly stFindKeyByHash: Database.Statement;
  private readonly stTouchKeyUsed: Database.Statement;
  private readonly stInsertAudit: Database.Statement;
  private readonly stCountFirstUser: Database.Statement;
  private readonly stGetMemberRole: Database.Statement;
  private readonly stFindCache: Database.Statement;
  private readonly stSaveCache: Database.Statement;
  private readonly stPurgeCache: Database.Statement;

  /**
   * Wrap an already-open connection and prepare all statements. Does not run
   * PRAGMAs or migrations — callers that need those use {@link SystemDb.open}.
   */
  constructor(db: Database.Database) {
    this.db = db;
    this.stInsertUser = db.prepare(
      'INSERT INTO users (id, username, display_name, is_admin, is_first_user, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.stGetUserById = db.prepare('SELECT * FROM users WHERE id = ? LIMIT 1');
    this.stGetUserByUsername = db.prepare('SELECT * FROM users WHERE username = ? LIMIT 1');
    this.stInsertApiKey = db.prepare(
      'INSERT INTO api_keys (id, user_id, label, key_hash, key_prefix, read_only, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.stFindKeyByHash = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? LIMIT 1');
    this.stTouchKeyUsed = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');
    this.stInsertAudit = db.prepare(
      'INSERT INTO audit_log (ts, actor_user_id, network_id, category, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.stCountFirstUser = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_first_user = 1');
    this.stGetMemberRole = db.prepare(
      'SELECT role FROM network_members WHERE user_id = ? AND network_id = ? LIMIT 1',
    );
    this.stFindCache = db.prepare(
      'SELECT status, body, ts FROM client_request_cache WHERE request_id = ? AND user_id = ? LIMIT 1',
    );
    this.stSaveCache = db.prepare(
      'INSERT OR REPLACE INTO client_request_cache (request_id, user_id, ts, status, body) VALUES (?, ?, ?, ?, ?)',
    );
    this.stPurgeCache = db.prepare('DELETE FROM client_request_cache WHERE ts < ?');
  }

  /** TTL window for cached idempotent responses, in milliseconds. */
  private static readonly TTL_MS = IDEMPOTENCY_TTL_MINUTES * 60_000;

  /**
   * Open (or create) `_system.db` under `dataDir`, enable WAL and foreign keys,
   * apply pending migrations, and return a ready {@link SystemDb}.
   *
   * @param dataDir - absolute ETN data directory.
   * @param log - optional logger for migration progress.
   */
  static open(dataDir: string, log?: Logger): SystemDb {
    mkdirSync(dataDir, { recursive: true });
    // Static import is safe: the native binding is only touched on
    // `new Database(...)`, so importing the module does not fail on hosts where
    // the addon is not built (typecheck still works via @types/better-sqlite3).
    const db = new DatabaseConstructor(systemDbPath(dataDir));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db, systemMigrationsDir(), log);
    return new SystemDb(db);
  }

  /** Insert a user and return the domain object. */
  createUser(params: CreateUserParams): User {
    const now = new Date().toISOString();
    const isAdmin = params.isAdmin === true ? 1 : 0;
    const isFirstUser = params.isFirstUser === true ? 1 : 0;
    this.stInsertUser.run(
      params.id,
      params.username,
      params.displayName,
      isAdmin,
      isFirstUser,
      now,
      now,
    );
    return {
      id: params.id,
      username: params.username,
      display_name: params.displayName,
      is_admin: params.isAdmin === true,
      is_first_user: params.isFirstUser === true,
      disabled: false,
      created_at: now,
      updated_at: now,
    };
  }

  /** Look up a user by id, or `null` if absent. */
  getUserById(id: string): User | null {
    const row = this.stGetUserById.get(id) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  /** Look up a user by username (case-sensitive), or `null` if absent. */
  getUserByUsername(username: string): User | null {
    const row = this.stGetUserByUsername.get(username) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  /** Insert an API-key row and return the domain object (without the secret). */
  createApiKey(params: CreateApiKeyParams): ApiKey {
    const now = new Date().toISOString();
    const readOnly = params.readOnly === true ? 1 : 0;
    this.stInsertApiKey.run(
      params.id,
      params.userId,
      params.label,
      params.keyHash,
      params.keyPrefix,
      readOnly,
      now,
    );
    return {
      id: params.id,
      user_id: params.userId,
      label: params.label,
      prefix: params.keyPrefix,
      read_only: params.readOnly === true,
      disabled: false,
      created_at: now,
      last_used_at: null,
    };
  }

  /**
   * Find a non-disabled key by its SHA-256 hash together with its (non-disabled)
   * owner. Returns `null` when the hash is unknown, the key is disabled, or the
   * owning user is disabled — all three must forbid authentication
   * (docs/06-auth.md §3).
   */
  findApiKeyByHash(keyHash: string): ApiKeyWithUser | null {
    const row = this.stFindKeyByHash.get(keyHash) as ApiKeyRow | undefined;
    if (!row || row.disabled === 1) {
      return null;
    }
    const user = this.getUserById(row.user_id);
    if (!user || user.disabled) {
      return null;
    }
    return { apiKey: rowToApiKey(row), user };
  }

  /** Best-effort update of `last_used_at` for a key (docs/06-auth.md §3.5). */
  touchApiKeyUsed(keyId: string): void {
    this.stTouchKeyUsed.run(new Date().toISOString(), keyId);
  }

  /** Append an audit-log row. `details` is JSON-stringified. */
  insertAuditLog(params: InsertAuditLogParams): void {
    const detailsJson = params.details === undefined ? null : JSON.stringify(params.details);
    this.stInsertAudit.run(
      new Date().toISOString(),
      params.actorUserId ?? null,
      params.networkId ?? null,
      params.category,
      params.action,
      params.targetType ?? null,
      params.targetId ?? null,
      detailsJson,
    );
  }

  /** True when a root admin (`is_first_user = 1`) already exists. */
  hasFirstUser(): boolean {
    const row = this.stCountFirstUser.get() as { c: number };
    return row.c > 0;
  }

  /**
   * Look up a user's role within a network, or `null` when they are not a
   * member (02-data-model.md §2.4). Used by the access-control layer (task B9).
   */
  getMemberRole(userId: string, networkId: string): NetworkRole | null {
    const row = this.stGetMemberRole.get(userId, networkId) as { role: NetworkRole } | undefined;
    return row?.role ?? null;
  }

  /**
   * Find a still-fresh cached response for `(requestId, userId)`
   * (02-data-model.md §2.7, 01-architecture.md §6). Returns `null` when no row
   * exists, the row belongs to a different user, or it has exceeded the
   * {@link IDEMPOTENCY_TTL_MINUTES} window.
   */
  findCachedResponse(requestId: string, userId: string): CachedResponse | null {
    const row = this.stFindCache.get(requestId, userId) as
      { status: number; body: string | null; ts: string } | undefined;
    if (row === undefined) {
      return null;
    }
    const ageMs = Date.now() - Date.parse(row.ts);
    if (Number.isNaN(ageMs) || ageMs > SystemDb.TTL_MS) {
      return null;
    }
    return { status: row.status, body: row.body };
  }

  /**
   * Persist a successful (2xx) response so a retried request with the same
   * `Client-Request-Id` replays it instead of re-executing the handler
   * (01-architecture.md §6).
   */
  saveCachedResponse(requestId: string, userId: string, status: number, body: string | null): void {
    this.stSaveCache.run(requestId, userId, new Date().toISOString(), status, body);
  }

  /**
   * Delete cache rows whose `ts` predates `olderThan` (ISO-8601). Returns the
   * number of removed rows. Driven by the periodic cleanup job in task B11.
   */
  purgeExpiredCache(olderThanIso: string): number {
    const info = this.stPurgeCache.run(olderThanIso);
    return info.changes;
  }

  /**
   * Run `fn` inside a single SQLite transaction. Rolls back on throw.
   * Use to keep multi-statement operations atomic (e.g. user + key + audit).
   */
  transaction<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped();
  }

  /** Close the underlying connection. */
  close(): void {
    this.db.close();
  }
}
