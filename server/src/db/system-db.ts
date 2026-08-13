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

import type {
  ApiKey,
  AuditCategory,
  AuditLogEntry,
  AuditQuery,
  Network,
  NetworkListItem,
  NetworkMember,
  NetworkRole,
  User,
} from '@etn/shared';
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
  private readonly stListUsers: Database.Statement;
  private readonly stListKeysByUser: Database.Statement;
  private readonly stGetKeyById: Database.Statement;
  private readonly stDisableKey: Database.Statement;
  private readonly stCountOwnedNetworks: Database.Statement;
  private readonly stUpdateUser: Database.Statement;
  private readonly stDeleteUser: Database.Statement;
  private readonly stInsertNetwork: Database.Statement;
  private readonly stGetNetworkById: Database.Statement;
  private readonly stUpdateNetwork: Database.Statement;
  private readonly stListNetworksForUser: Database.Statement;
  private readonly stInsertMember: Database.Statement;
  private readonly stDeleteMember: Database.Statement;
  private readonly stListMembers: Database.Statement;
  private readonly stSetMemberRole: Database.Statement;
  private readonly stSetNetworkOwner: Database.Statement;
  private readonly stGetPreference: Database.Statement;
  private readonly stUpsertPreference: Database.Statement;
  private readonly stListPreferences: Database.Statement;

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
    this.stListUsers = db.prepare('SELECT * FROM users ORDER BY created_at');
    this.stListKeysByUser = db.prepare(
      'SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at',
    );
    this.stGetKeyById = db.prepare('SELECT * FROM api_keys WHERE id = ? LIMIT 1');
    this.stDisableKey = db.prepare('UPDATE api_keys SET disabled = 1 WHERE id = ?');
    this.stCountOwnedNetworks = db.prepare('SELECT COUNT(*) AS c FROM networks WHERE owner_id = ?');
    this.stUpdateUser = db.prepare(
      'UPDATE users SET display_name = ?, is_admin = ?, disabled = ?, updated_at = ? WHERE id = ?',
    );
    this.stDeleteUser = db.prepare('DELETE FROM users WHERE id = ?');
    this.stInsertNetwork = db.prepare(
      'INSERT INTO networks (id, display_name, owner_id, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.stGetNetworkById = db.prepare('SELECT * FROM networks WHERE id = ? LIMIT 1');
    this.stUpdateNetwork = db.prepare(
      'UPDATE networks SET display_name = ?, description = ?, updated_at = ? WHERE id = ?',
    );
    this.stListNetworksForUser = db.prepare(
      `SELECT n.id AS id, n.display_name AS display_name, n.owner_id AS owner_id,
              n.description AS description, n.created_at AS created_at, n.updated_at AS updated_at,
              m.role AS role, ou.display_name AS owner_display_name,
              (SELECT COUNT(*) FROM network_members WHERE network_id = n.id) AS members_count
       FROM network_members m
       JOIN networks n ON n.id = m.network_id
       JOIN users ou ON ou.id = n.owner_id
       WHERE m.user_id = ?
       ORDER BY n.created_at`,
    );
    this.stInsertMember = db.prepare(
      'INSERT INTO network_members (network_id, user_id, role, added_at, added_by) VALUES (?, ?, ?, ?, ?)',
    );
    this.stDeleteMember = db.prepare(
      'DELETE FROM network_members WHERE network_id = ? AND user_id = ?',
    );
    this.stListMembers = db.prepare(
      `SELECT m.network_id AS network_id, m.user_id AS user_id, m.role AS role,
              m.added_at AS added_at, m.added_by AS added_by, u.display_name AS display_name,
              u.username AS username
       FROM network_members m JOIN users u ON u.id = m.user_id
       WHERE m.network_id = ? ORDER BY m.added_at`,
    );
    this.stSetMemberRole = db.prepare(
      'UPDATE network_members SET role = ? WHERE network_id = ? AND user_id = ?',
    );
    this.stSetNetworkOwner = db.prepare(
      'UPDATE networks SET owner_id = ?, updated_at = ? WHERE id = ?',
    );
    this.stGetPreference = db.prepare(
      'SELECT value, updated_at FROM user_preferences WHERE user_id = ? AND network_id = ? AND key = ? LIMIT 1',
    );
    this.stUpsertPreference = db.prepare(
      'INSERT INTO user_preferences (user_id, network_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, network_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    );
    this.stListPreferences = db.prepare(
      'SELECT key, value, updated_at FROM user_preferences WHERE user_id = ? AND network_id = ? ORDER BY key',
    );
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

  /** List all users ordered by creation time (admin view, task B12). */
  listUsers(): User[] {
    const rows = this.stListUsers.all() as UserRow[];
    return rows.map(rowToUser);
  }

  /** List the API-keys owned by `userId` (display only — no secret, task B12). */
  listApiKeysByUser(userId: string): ApiKey[] {
    const rows = this.stListKeysByUser.all(userId) as ApiKeyRow[];
    return rows.map(rowToApiKey);
  }

  /** Fetch a single API-key by id, or `null` (for ownership checks on revoke). */
  getApiKeyById(keyId: string): ApiKey | null {
    const row = this.stGetKeyById.get(keyId) as ApiKeyRow | undefined;
    return row ? rowToApiKey(row) : null;
  }

  /** Disable (revoke) an API-key by id. Idempotent for already-disabled keys. */
  disableApiKey(keyId: string): void {
    this.stDisableKey.run(keyId);
  }

  /** Count networks currently owned by `userId` (DELETE-user guard, 06-auth.md §4.3). */
  countOwnedNetworks(userId: string): number {
    const row = this.stCountOwnedNetworks.get(userId) as { c: number };
    return row.c;
  }

  /**
   * Patch a user's mutable fields. Callers enforce the invariants
   * (first-user demotion, etc.) before calling — this method only persists.
   */
  updateUser(
    id: string,
    params: { displayName: string | null; isAdmin: boolean; disabled: boolean },
  ): void {
    this.stUpdateUser.run(
      params.displayName,
      params.isAdmin ? 1 : 0,
      params.disabled ? 1 : 0,
      new Date().toISOString(),
      id,
    );
  }

  /**
   * Delete a user. Cascades to `api_keys` and `network_members` (FK ON DELETE
   * CASCADE); callers must first transfer ownership of any owned networks
   * (`networks.owner_id` is `ON DELETE RESTRICT`).
   */
  deleteUser(id: string): void {
    this.stDeleteUser.run(id);
  }

  // -------------------------------------------------------------------------
  // Networks & membership (registry rows in `_system.db`; task B13)
  // -------------------------------------------------------------------------

  /** Insert a network registry row. Per-DB setup is done by NetworkService (C10). */
  createNetworkRow(
    id: string,
    ownerId: string,
    displayName: string,
    description: string | null,
  ): Network {
    const now = new Date().toISOString();
    this.stInsertNetwork.run(id, displayName, ownerId, description, now, now);
    return {
      id,
      display_name: displayName,
      owner_id: ownerId,
      description,
      created_at: now,
      updated_at: now,
    };
  }

  /** Fetch a network registry row by id, or `null`. */
  getNetworkById(id: string): Network | null {
    const row = this.stGetNetworkById.get(id) as
      | {
          id: string;
          display_name: string;
          owner_id: string;
          description: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      display_name: row.display_name,
      owner_id: row.owner_id,
      description: row.description,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** Patch a network's editable fields (display_name, description). */
  updateNetwork(id: string, fields: { displayName: string; description: string | null }): void {
    this.stUpdateNetwork.run(fields.displayName, fields.description, new Date().toISOString(), id);
  }

  /**
   * List the networks a user belongs to, with their role and owner reference
   * (03-server-api.md §5.1). `my_focus_thought_id` is L4 client state and is
   * always `null` from the server.
   */
  listNetworksForUser(userId: string): NetworkListItem[] {
    const rows = this.stListNetworksForUser.all(userId) as Array<{
      id: string;
      display_name: string;
      owner_id: string;
      description: string | null;
      created_at: string;
      updated_at: string;
      role: NetworkRole;
      owner_display_name: string | null;
      members_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      display_name: r.display_name,
      owner: { id: r.owner_id, display_name: r.owner_display_name },
      role: r.role,
      members_count: r.members_count,
      my_focus_thought_id: null,
    }));
  }

  /** Add a member row. Caller validates role/owner invariants. */
  addNetworkMember(networkId: string, userId: string, role: NetworkRole, addedBy: string): void {
    this.stInsertMember.run(networkId, userId, role, new Date().toISOString(), addedBy);
  }

  /** Remove a member row. Returns the number of rows deleted (0 if absent). */
  removeNetworkMember(networkId: string, userId: string): number {
    const info = this.stDeleteMember.run(networkId, userId);
    return info.changes;
  }

  /**
   * A membership row augmented with the user's display name + username, for the
   * members-list endpoint (03-server-api.md §5.3).
   */
  listNetworkMembers(
    networkId: string,
  ): Array<NetworkMember & { username: string; display_name: string | null }> {
    const rows = this.stListMembers.all(networkId) as Array<{
      network_id: string;
      user_id: string;
      role: NetworkRole;
      added_at: string;
      added_by: string;
      username: string;
      display_name: string | null;
    }>;
    return rows.map((r) => ({
      network_id: r.network_id,
      user_id: r.user_id,
      role: r.role,
      added_at: r.added_at,
      added_by: r.added_by,
      username: r.username,
      display_name: r.display_name,
    }));
  }

  /**
   * Transfer ownership of a network atomically: demote the current owner to
   * `member`, promote `newOwnerId` to `owner`, and update `networks.owner_id`.
   * Both membership rows must already exist. Runs in a single transaction.
   */
  transferNetworkOwnership(networkId: string, oldOwnerId: string, newOwnerId: string): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      // Promote the new owner and demote the previous one in one transaction.
      this.stSetMemberRole.run('owner', networkId, newOwnerId);
      this.stSetMemberRole.run('member', networkId, oldOwnerId);
      this.stSetNetworkOwner.run(newOwnerId, now, networkId);
    });
  }

  /** Read one user preference for a network, or `null` when unset. */
  getNetworkPreference(
    userId: string,
    networkId: string,
    key: string,
  ): { value: unknown; updated_at: string } | null {
    const row = this.stGetPreference.get(userId, networkId, key) as
      { value: string; updated_at: string } | undefined;
    if (row === undefined) {
      return null;
    }
    return { value: JSON.parse(row.value), updated_at: row.updated_at };
  }

  /** Upsert a user preference (value JSON-encoded). */
  setNetworkPreference(userId: string, networkId: string, key: string, value: unknown): void {
    this.stUpsertPreference.run(
      userId,
      networkId,
      key,
      JSON.stringify(value),
      new Date().toISOString(),
    );
  }

  /** List all preferences of a user in a network. */
  listNetworkPreferences(
    userId: string,
    networkId: string,
  ): Array<{ key: string; value: unknown; updated_at: string }> {
    const rows = this.stListPreferences.all(userId, networkId) as Array<{
      key: string;
      value: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value), updated_at: r.updated_at }));
  }

  // -------------------------------------------------------------------------
  // Audit-log query (task B14, 03-server-api.md §15)
  // -------------------------------------------------------------------------

  /** Raw audit row shape. */
  private static readonly MAX_AUDIT_LIMIT = 500;

  /** Build the WHERE clause + bind params for an {@link AuditQuery}. */
  private static auditFilter(query: AuditQuery): { where: string; params: string[] } {
    const clauses: string[] = [];
    const params: string[] = [];
    if (query.actor !== undefined) {
      clauses.push('actor_user_id = ?');
      params.push(query.actor);
    }
    if (query.network !== undefined) {
      clauses.push('network_id = ?');
      params.push(query.network);
    }
    if (query.category !== undefined) {
      clauses.push('category = ?');
      params.push(query.category);
    }
    if (query.from !== undefined) {
      clauses.push('ts >= ?');
      params.push(query.from);
    }
    if (query.to !== undefined) {
      clauses.push('ts <= ?');
      params.push(query.to);
    }
    return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  /**
   * Query the audit log with optional filters, newest first. `limit` defaults
   * to 50 and is capped at 500; `offset` defaults to 0.
   */
  queryAudit(query: AuditQuery): AuditLogEntry[] {
    const { where, params } = SystemDb.auditFilter(query);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), SystemDb.MAX_AUDIT_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);
    const sql = `SELECT id, ts, actor_user_id, network_id, category, action, target_type, target_id, details
                 FROM audit_log ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as Array<{
      id: number;
      ts: string;
      actor_user_id: string | null;
      network_id: string | null;
      category: AuditCategory;
      action: string;
      target_type: string | null;
      target_id: string | null;
      details: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      actor_user_id: r.actor_user_id,
      network_id: r.network_id,
      category: r.category,
      action: r.action,
      target_type: r.target_type,
      target_id: r.target_id,
      details: r.details === null ? null : JSON.parse(r.details),
    }));
  }

  /** Count rows matching the same filter (for pagination metadata). */
  countAudit(query: AuditQuery): number {
    const { where, params } = SystemDb.auditFilter(query);
    const sql = `SELECT COUNT(*) AS c FROM audit_log ${where}`;
    const row = this.db.prepare(sql).get(...params) as { c: number };
    return row.c;
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
