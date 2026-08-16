/**
 * Repository over the client local SQLite store (docs/07-client-electron.md §3,
 * workplan G3).
 *
 * `LocalDb` owns a single `better-sqlite3` connection to `userData/local.db`,
 * applies migrations on construction, and exposes a minimal read/write surface
 * per table:
 *  - `client_meta`    — installation state, L5 (incl. `client_id`, G4);
 *  - `server_profiles`— saved server connections with an encrypted API-key;
 *  - `ui_state`       — per-client UI state, L4;
 *  - `drafts`         — pending edits, offline safety net;
 *  - `focus_history`  — recently focused thoughts, L4.
 *
 * The store holds **no** authoritative network data — the client is online-only
 * and every data request goes to the server.
 */
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { FOCUS_HISTORY_LIMIT } from '@etn/shared';
import { migrateDatabase, type AppliedMigration } from './migrator.js';

/** Constructor options for {@link LocalDb}. */
export interface LocalDbOptions {
  /** Absolute path of the local DB file. Parent directory is created if missing. */
  dbPath: string;
  /**
   * Directory with `NNN_*.sql` migrations. When provided, migrations run on
   * construction. Omit to manage migrations manually (e.g. in-memory tests).
   */
  migrationsDir?: string;
}

/** Lifecycle status of a draft (07-client-electron.md §3.3). */
export type DraftStatus = 'pending' | 'sent' | 'failed';

/** Row of `server_profiles` (07-client-electron.md §3.1). `is_active` is 0/1. */
export interface ServerProfileRow {
  id: string;
  label: string;
  base_url: string;
  api_key_encrypted: Buffer | null;
  user_id: string | null;
  is_active: number;
  created_at: string;
}

/** Input for {@link LocalDb.insertProfile}. */
export interface NewServerProfile {
  id: string;
  label: string;
  base_url: string;
  api_key_encrypted?: Buffer | null;
  user_id?: string | null;
  is_active?: boolean;
}

/** Row of `ui_state` (07-client-electron.md §3.2). */
export interface UiStateRow {
  profile_id: string;
  network_id: string;
  key: string;
  value: string | null;
  updated_at: string;
}

/** Row of `drafts` (07-client-electron.md §3.3). */
export interface DraftRow {
  id: string;
  profile_id: string;
  network_id: string;
  entity_type: string;
  entity_id: string;
  field: string;
  value: string | null;
  base_version: number | null;
  created_at: string;
  status: DraftStatus;
}

/** Input for {@link LocalDb.upsertDraft}. */
export interface NewDraft {
  id: string;
  profile_id: string;
  network_id: string;
  entity_type: string;
  entity_id: string;
  field: string;
  value?: string | null;
  base_version?: number | null;
  status?: DraftStatus;
}

/** Row of `focus_history` (07-client-electron.md §3.5). */
export interface FocusHistoryRow {
  profile_id: string;
  network_id: string;
  thought_id: string;
  seq: number;
  visited_at: string;
}

/** Which view a visit history belongs to (docs/11-settings-and-state.md §2.3.1). */
export type HistoryScope = 'focus' | 'structures';

/** Physical table of a history scope (fixed map — never built from input). */
const HISTORY_TABLES: Record<HistoryScope, string> = {
  focus: 'focus_history',
  structures: 'structures_history',
};

/** Resolve a scope to its table, rejecting unknown values from IPC input. */
function historyTable(scope: HistoryScope): string {
  const table = HISTORY_TABLES[scope];
  if (table === undefined) {
    throw new Error(`Unknown history scope: ${String(scope)}`);
  }
  return table;
}

/**
 * SQLite-backed local store. Instantiate one per application lifetime (main
 * process). Call {@link close} on quit to release the file handle.
 */
export class LocalDb {
  private readonly db: Database.Database;

  public constructor(opts: LocalDbOptions) {
    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    if (opts.migrationsDir !== undefined) {
      migrateDatabase(this.db, opts.migrationsDir);
    }
  }

  /**
   * Applies migrations from `dir` and returns the ones newly applied. Useful when
   * the directory was not supplied to the constructor.
   */
  public migrate(dir: string): AppliedMigration[] {
    return migrateDatabase(this.db, dir);
  }

  // -------------------------------------------------------------------------
  // client_meta (L5)
  // -------------------------------------------------------------------------

  /** Returns the raw string value of `client_meta[key]`, or `null` if absent. */
  public getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM client_meta WHERE key = ?').get(key) as
      { value: string | null } | undefined;
    return row?.value ?? null;
  }

  /** Upserts `client_meta[key] = value`. */
  public setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO client_meta (key, value) VALUES (?, ?)\n' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  /** Deletes `client_meta[key]` if it exists (no-op otherwise). */
  public deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM client_meta WHERE key = ?').run(key);
  }

  // -------------------------------------------------------------------------
  // server_profiles (07-client-electron.md §3.1)
  // -------------------------------------------------------------------------

  /** Inserts a new server profile. */
  public insertProfile(profile: NewServerProfile): void {
    this.db
      .prepare(
        'INSERT INTO server_profiles (id, label, base_url, api_key_encrypted, user_id, is_active) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        profile.id,
        profile.label,
        profile.base_url,
        profile.api_key_encrypted ?? null,
        profile.user_id ?? null,
        profile.is_active ? 1 : 0,
      );
  }

  /** Returns a profile by id, or `null` if not found. */
  public getProfile(id: string): ServerProfileRow | null {
    const row = this.db.prepare('SELECT * FROM server_profiles WHERE id = ?').get(id) as
      ServerProfileRow | undefined;
    return row ?? null;
  }

  /** Returns all saved profiles ordered by creation time (oldest first). */
  public listProfiles(): ServerProfileRow[] {
    return this.db
      .prepare('SELECT * FROM server_profiles ORDER BY created_at ASC')
      .all() as ServerProfileRow[];
  }

  /**
   * Atomically activates `id` and deactivates every other profile. Pass `null`
   * to clear the active profile.
   */
  public setActiveProfile(id: string | null): void {
    const clear = this.db.prepare('UPDATE server_profiles SET is_active = 0');
    const set = this.db.prepare('UPDATE server_profiles SET is_active = 1 WHERE id = ?');
    const tx = this.db.transaction((target: string | null) => {
      clear.run();
      if (target !== null) set.run(target);
    });
    tx(id);
  }

  /** Returns the currently active profile, or `null` if none is active. */
  public getActiveProfile(): ServerProfileRow | null {
    const row = this.db
      .prepare('SELECT * FROM server_profiles WHERE is_active = 1 LIMIT 1')
      .get() as ServerProfileRow | undefined;
    return row ?? null;
  }

  /** Deletes a profile by id. */
  public deleteProfile(id: string): void {
    this.db.prepare('DELETE FROM server_profiles WHERE id = ?').run(id);
  }

  // -------------------------------------------------------------------------
  // ui_state (L4, 07-client-electron.md §3.2)
  // -------------------------------------------------------------------------

  /** Returns the raw JSON string stored for `(profile, network, key)`, or `null`. */
  public getUiState(profileId: string, networkId: string, key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM ui_state WHERE profile_id = ? AND network_id = ? AND key = ?')
      .get(profileId, networkId, key) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  /** Upserts `ui_state[(profile, network, key)] = value`, refreshing `updated_at`. */
  public setUiState(profileId: string, networkId: string, key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO ui_state (profile_id, network_id, key, value, updated_at) ' +
          "VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))\n" +
          'ON CONFLICT(profile_id, network_id, key) DO UPDATE SET value = excluded.value, ' +
          'updated_at = excluded.updated_at',
      )
      .run(profileId, networkId, key, value);
  }

  /** Removes a single ui_state entry (no-op if absent). */
  public deleteUiState(profileId: string, networkId: string, key: string): void {
    this.db
      .prepare('DELETE FROM ui_state WHERE profile_id = ? AND network_id = ? AND key = ?')
      .run(profileId, networkId, key);
  }

  // -------------------------------------------------------------------------
  // drafts (07-client-electron.md §3.3)
  // -------------------------------------------------------------------------

  /** Inserts or replaces a draft by `id`. */
  public upsertDraft(draft: NewDraft): void {
    this.db
      .prepare(
        'INSERT INTO drafts (id, profile_id, network_id, entity_type, entity_id, field, value, base_version, status) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\n' +
          'ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, ' +
          'network_id = excluded.network_id, entity_type = excluded.entity_type, ' +
          'entity_id = excluded.entity_id, field = excluded.field, value = excluded.value, ' +
          'base_version = excluded.base_version, status = excluded.status',
      )
      .run(
        draft.id,
        draft.profile_id,
        draft.network_id,
        draft.entity_type,
        draft.entity_id,
        draft.field,
        draft.value ?? null,
        draft.base_version ?? null,
        draft.status ?? 'pending',
      );
  }

  /** Returns a draft by id, or `null`. */
  public getDraft(id: string): DraftRow | null {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as
      DraftRow | undefined;
    return row ?? null;
  }

  /** Lists drafts for a (profile, network), optionally filtered by status. */
  public listDrafts(profileId: string, networkId: string, status?: DraftStatus): DraftRow[] {
    if (status !== undefined) {
      return this.db
        .prepare(
          'SELECT * FROM drafts WHERE profile_id = ? AND network_id = ? AND status = ? ORDER BY created_at ASC',
        )
        .all(profileId, networkId, status) as DraftRow[];
    }
    return this.db
      .prepare(
        'SELECT * FROM drafts WHERE profile_id = ? AND network_id = ? ORDER BY created_at ASC',
      )
      .all(profileId, networkId) as DraftRow[];
  }

  /** Updates the lifecycle status of a draft. */
  public updateDraftStatus(id: string, status: DraftStatus): void {
    this.db.prepare('UPDATE drafts SET status = ? WHERE id = ?').run(status, id);
  }

  /** Deletes a draft by id. */
  public deleteDraft(id: string): void {
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
  }

  // -------------------------------------------------------------------------
  // visit histories (L4, 07-client-electron.md §3.5, 11-settings-and-state.md §2.3)
  // -------------------------------------------------------------------------

  /**
   * (Re)inserts a thought into a visit history at the front (highest `seq`).
   * `INSERT OR REPLACE` keeps a single row per
   * `(profile_id, network_id, thought_id)`, bumping it to the most recent slot.
   */
  public pushFocusHistory(
    profileId: string,
    networkId: string,
    thoughtId: string,
    scope: HistoryScope = 'focus',
  ): void {
    const table = historyTable(scope);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${table} (profile_id, network_id, thought_id, seq, visited_at) ` +
          'VALUES (?, ?, ?, ' +
          `(SELECT COALESCE(MAX(seq), 0) + 1 FROM ${table} WHERE profile_id = ? AND network_id = ?), ` +
          "strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
      )
      .run(profileId, networkId, thoughtId, profileId, networkId);
  }

  /** Removes a single thought from a visit history (no-op if absent). */
  public removeFocusHistory(
    profileId: string,
    networkId: string,
    thoughtId: string,
    scope: HistoryScope = 'focus',
  ): void {
    this.db
      .prepare(
        `DELETE FROM ${historyTable(scope)} WHERE profile_id = ? AND network_id = ? AND thought_id = ?`,
      )
      .run(profileId, networkId, thoughtId);
  }

  /** Drops the whole visit history of one view (profile × network). */
  public clearFocusHistory(
    profileId: string,
    networkId: string,
    scope: HistoryScope = 'focus',
  ): void {
    this.db
      .prepare(`DELETE FROM ${historyTable(scope)} WHERE profile_id = ? AND network_id = ?`)
      .run(profileId, networkId);
  }

  /**
   * Returns the ordered list of history `thought_id`s, freshest first.
   * Defaults to {@link FOCUS_HISTORY_LIMIT} entries.
   */
  public listFocusHistory(
    profileId: string,
    networkId: string,
    limit = FOCUS_HISTORY_LIMIT,
    scope: HistoryScope = 'focus',
  ): string[] {
    const rows = this.db
      .prepare(
        `SELECT thought_id FROM ${historyTable(scope)} WHERE profile_id = ? AND network_id = ? ` +
          'ORDER BY seq DESC LIMIT ?',
      )
      .all(profileId, networkId, limit) as { thought_id: string }[];
    return rows.map((r) => r.thought_id);
  }

  /**
   * Rotates focus history on a focus change `oldId → newId` in one transaction,
   * per the algorithm in docs/07-client-electron.md §3.5:
   *  1. `newId` leaves history (it becomes the focus);
   *  2. `oldId` enters history at the front (skipped when `oldId` is `null`);
   *  3. history is trimmed to {@link FOCUS_HISTORY_LIMIT}.
   *
   * Passing `oldId === newId` is a no-op. The full UI wiring lands in H7.
   */
  public rotateFocusHistory(
    profileId: string,
    networkId: string,
    oldId: string | null,
    newId: string,
    scope: HistoryScope = 'focus',
  ): void {
    if (oldId === newId) return;
    const table = historyTable(scope);
    const tx = this.db.transaction(
      (p: string, n: string, old: string | null, newIdTx: string) => {
        this.db
          .prepare(`DELETE FROM ${table} WHERE profile_id = ? AND network_id = ? AND thought_id = ?`)
          .run(p, n, newIdTx);
        if (old !== null) {
          this.pushFocusHistory(p, n, old, scope);
        }
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE profile_id = ? AND network_id = ? ` +
              `AND seq NOT IN (SELECT seq FROM ${table} WHERE profile_id = ? AND network_id = ? ` +
              'ORDER BY seq DESC LIMIT ?)',
          )
          .run(p, n, p, n, FOCUS_HISTORY_LIMIT);
      },
    );
    tx(profileId, networkId, oldId, newId);
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /** Returns the underlying connection. Escape hatch for advanced queries. */
  public getRawConnection(): Database.Database {
    return this.db;
  }

  /** Closes the DB connection. Safe to call once; further use will throw. */
  public close(): void {
    this.db.close();
  }
}
