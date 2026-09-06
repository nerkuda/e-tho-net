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
 *  - `visit_history`  — thoughts opened in the editor, common to every
 *    screen of a tab (L4, unified in 0.5.5).
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

/**
 * Row of `visit_history` (07-client-electron.md §3.5, фаза Q; unified in
 * 0.5.5, task «Переделать историю посещения мыслей»): one common list of
 * thoughts opened in the thought editor, shared by every screen of a tab
 * (map/structures/chronicle) — there is no more per-view scoping.
 */
export interface VisitHistoryRow {
  profile_id: string;
  network_id: string;
  /** `null` для legacy-строк (миграции 001–004 до введения табов). */
  tab_id: string | null;
  thought_id: string;
  seq: number;
  visited_at: string;
}

/** Workspace view modes (08-ui-spec.md §15.1, задача f27809d0 «События»). */
export type TabViewMode = 'map' | 'structures' | 'chronicle' | 'activity';

/** Row of `tabs` (07-client-electron.md §3.6, фаза Q). */
export interface TabRow {
  profile_id: string;
  tab_id: string;
  slot_idx: number;
  network_id: string;
  focus_id: string | null;
  view_mode: TabViewMode | null;
  structures_state: string | null;
  chronicle_state: string | null;
  /** Per-tab persisted filter for the «События» view (задача f27809d0). */
  activity_state: string | null;
  /** Change-layer of the tab (S11, 13-layers.md §10.3); NULL — the base. */
  layer_id: string | null;
  last_active_at: string;
}

/** Input for {@link LocalDb.upsertTab}. */
export interface NewTab {
  tab_id: string;
  slot_idx: number;
  network_id: string;
  focus_id?: string | null;
  view_mode?: TabViewMode | null;
  structures_state?: string | null;
  chronicle_state?: string | null;
  activity_state?: string | null;
  layer_id?: string | null;
  last_active_at?: string;
}

/** Partial update for {@link LocalDb.upsertTab}. */
export interface TabStatePatch {
  slot_idx?: number;
  network_id?: string;
  focus_id?: string | null;
  view_mode?: TabViewMode | null;
  structures_state?: string | null;
  chronicle_state?: string | null;
  /** Per-tab persisted filter for the «События» view (задача f27809d0). */
  activity_state?: string | null;
  layer_id?: string | null;
  last_active_at?: string;
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

  /**
   * Deletes a profile by id, plus every per-profile row it owns (defect
   * e28df893: the schema has no FK from `ui_state`, `drafts`, `tabs`,
   * `focus_history`, `visit_history` and `structures_history` back to
   * `server_profiles`, so a plain DELETE would leave orphan rows). All
   * writes run inside one transaction so a partial failure cannot strand
   * a half-deleted profile.
   */
  public deleteProfile(id: string): void {
    const tx = this.db.transaction((pid: string) => {
      this.db.prepare('DELETE FROM ui_state WHERE profile_id = ?').run(pid);
      this.db.prepare('DELETE FROM drafts WHERE profile_id = ?').run(pid);
      this.db.prepare('DELETE FROM visit_history WHERE profile_id = ?').run(pid);
      this.db.prepare('DELETE FROM focus_history WHERE profile_id = ?').run(pid);
      this.db.prepare('DELETE FROM structures_history WHERE profile_id = ?').run(pid);
      this.db.prepare('DELETE FROM tabs WHERE profile_id = ?').run(pid);
      this.db.prepare('DELETE FROM server_profiles WHERE id = ?').run(pid);
    });
    tx(id);
  }

  // -------------------------------------------------------------------------
  // ui_state (L4, 07-client-electron.md §3.2)
  // -------------------------------------------------------------------------

  /** Returns the raw JSON string stored for `(profile, network, key[, tabId])`, or `null`. */
  public getUiState(
    profileId: string,
    networkId: string,
    key: string,
    tabId: string | null = null,
  ): string | null {
    const effectiveKey = composeUiStateKey(key, tabId);
    const row = this.db
      .prepare('SELECT value FROM ui_state WHERE profile_id = ? AND network_id = ? AND key = ?')
      .get(profileId, networkId, effectiveKey) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  /** Upserts `ui_state[(profile, network, key[, tabId])] = value`, refreshing `updated_at`. */
  public setUiState(
    profileId: string,
    networkId: string,
    key: string,
    value: string,
    tabId: string | null = null,
  ): void {
    const effectiveKey = composeUiStateKey(key, tabId);
    this.db
      .prepare(
        'INSERT INTO ui_state (profile_id, network_id, key, value, updated_at) ' +
          "VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))\n" +
          'ON CONFLICT(profile_id, network_id, key) DO UPDATE SET value = excluded.value, ' +
          'updated_at = excluded.updated_at',
      )
      .run(profileId, networkId, effectiveKey, value);
  }

  /** Removes a single ui_state entry (no-op if absent). */
  public deleteUiState(
    profileId: string,
    networkId: string,
    key: string,
    tabId: string | null = null,
  ): void {
    const effectiveKey = composeUiStateKey(key, tabId);
    this.db
      .prepare('DELETE FROM ui_state WHERE profile_id = ? AND network_id = ? AND key = ?')
      .run(profileId, networkId, effectiveKey);
  }

  // -------------------------------------------------------------------------
  // drafts (07-client-electron.md §3.3)
  // -------------------------------------------------------------------------

  /**
   * Upserts a draft by its edit target — one draft per
   * (profile, network, entity type, entity id, field). The id only matters on
   * insert; re-saving a field refreshes the existing row instead of piling up
   * stale drafts (migration 003, 07-client-electron.md §3.3).
   */
  public upsertDraft(draft: NewDraft): void {
    this.db
      .prepare(
        'INSERT INTO drafts (id, profile_id, network_id, entity_type, entity_id, field, value, base_version, status) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\n' +
          'ON CONFLICT(profile_id, network_id, entity_type, entity_id, field) DO UPDATE SET ' +
          'value = excluded.value, base_version = excluded.base_version, ' +
          'status = excluded.status, ' +
          "created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')",
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

  /** Id of the single draft row for an edit target (one per field), or null. */
  public getDraftId(
    profileId: string,
    networkId: string,
    entityType: string,
    entityId: string,
    field: string,
  ): string | null {
    const row = this.db
      .prepare(
        'SELECT id FROM drafts WHERE profile_id = ? AND network_id = ? AND entity_type = ? ' +
          'AND entity_id = ? AND field = ?',
      )
      .get(profileId, networkId, entityType, entityId, field) as { id: string } | undefined;
    return row?.id ?? null;
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
  // visit history (L4, 07-client-electron.md §3.5, 11-settings-and-state.md §2.3)
  //
  // Unified in 0.5.5 (task «Переделать историю посещения мыслей»): ONE list
  // of thoughts opened in the thought editor per (profile, network, tab) —
  // common to every screen. Previously the map (focus_history), the
  // structures view (structures_history) and the chronicle
  // (chronicle_history, which also carried links) kept separate histories;
  // that made it impossible to return via history from one screen to a
  // thought seen on another.
  // -------------------------------------------------------------------------

  /**
   * (Re)inserts a thought into the visit history at the front (highest
   * `seq`). `INSERT OR REPLACE` keeps a single row per
   * `(profile_id, network_id, tab_id, thought_id)`, bumping it to the most
   * recent slot. `tabId = null` — legacy записи (до введения табов).
   */
  public pushVisitHistory(
    profileId: string,
    networkId: string,
    tabId: string | null,
    thoughtId: string,
  ): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO visit_history (profile_id, network_id, tab_id, thought_id, seq, visited_at) ' +
          'VALUES (?, ?, ?, ?, ' +
          '(SELECT COALESCE(MAX(seq), 0) + 1 FROM visit_history WHERE profile_id = ? AND network_id = ? AND tab_id IS ?), ' +
          "strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
      )
      .run(profileId, networkId, tabId, thoughtId, profileId, networkId, tabId);
  }

  /** Removes a single thought from the visit history (no-op if absent). */
  public removeVisitHistory(
    profileId: string,
    networkId: string,
    tabId: string | null,
    thoughtId: string,
  ): void {
    this.db
      .prepare(
        'DELETE FROM visit_history WHERE profile_id = ? AND network_id = ? AND tab_id IS ? AND thought_id = ?',
      )
      .run(profileId, networkId, tabId, thoughtId);
  }

  /** Drops the whole visit history of a profile × network × tab. */
  public clearVisitHistory(profileId: string, networkId: string, tabId: string | null): void {
    this.db
      .prepare('DELETE FROM visit_history WHERE profile_id = ? AND network_id = ? AND tab_id IS ?')
      .run(profileId, networkId, tabId);
  }

  /**
   * Returns the ordered list of history `thought_id`s, freshest first.
   * Defaults to {@link FOCUS_HISTORY_LIMIT} entries.
   */
  public listVisitHistory(
    profileId: string,
    networkId: string,
    tabId: string | null,
    limit = FOCUS_HISTORY_LIMIT,
  ): string[] {
    const rows = this.db
      .prepare(
        'SELECT thought_id FROM visit_history WHERE profile_id = ? AND network_id = ? AND tab_id IS ? ' +
          'ORDER BY seq DESC LIMIT ?',
      )
      .all(profileId, networkId, tabId, limit) as { thought_id: string }[];
    return rows.map((r) => r.thought_id);
  }

  /**
   * Rotates the visit history on an editor-thought change `oldId → newId` in
   * one transaction, per the algorithm from the task («Переделать историю
   * посещения мыслей»): the thought being LEFT enters history now — the
   * thought being entered never does (until something else supersedes it):
   *  1. `newId` leaves history (it becomes "current");
   *  2. `oldId` enters history at the front (skipped when `oldId` is `null`);
   *  3. history is trimmed to {@link FOCUS_HISTORY_LIMIT}.
   *
   * Passing `oldId === newId` is a no-op. `tabId = null` для legacy-данных.
   */
  public rotateVisitHistory(
    profileId: string,
    networkId: string,
    tabId: string | null,
    oldId: string | null,
    newId: string,
  ): void {
    if (oldId === newId) return;
    const tx = this.db.transaction(
      (p: string, n: string, t: string | null, old: string | null, newIdTx: string) => {
        this.db
          .prepare(
            'DELETE FROM visit_history WHERE profile_id = ? AND network_id = ? AND tab_id IS ? AND thought_id = ?',
          )
          .run(p, n, t, newIdTx);
        if (old !== null) {
          this.pushVisitHistory(p, n, t, old);
        }
        this.db
          .prepare(
            'DELETE FROM visit_history WHERE profile_id = ? AND network_id = ? AND tab_id IS ? ' +
              'AND seq NOT IN (SELECT seq FROM visit_history WHERE profile_id = ? AND network_id = ? AND tab_id IS ? ' +
              'ORDER BY seq DESC LIMIT ?)',
          )
          .run(p, n, t, p, n, t, FOCUS_HISTORY_LIMIT);
      },
    );
    tx(profileId, networkId, tabId, oldId, newId);
  }

  // -------------------------------------------------------------------------
  // tabs (L4, 07-client-electron.md §3.6, фаза Q)
  // -------------------------------------------------------------------------

  /** Lists all open tabs for a profile, ordered by `slot_idx` ascending. */
  public listTabs(profileId: string): TabRow[] {
    return this.db
      .prepare(
        'SELECT * FROM tabs WHERE profile_id = ? ORDER BY slot_idx ASC',
      )
      .all(profileId) as TabRow[];
  }

  /** Returns a single tab by id, or `null` if not found. */
  public getTab(profileId: string, tabId: string): TabRow | null {
    const row = this.db
      .prepare('SELECT * FROM tabs WHERE profile_id = ? AND tab_id = ?')
      .get(profileId, tabId) as TabRow | undefined;
    return row ?? null;
  }

  /**
   * Upserts a tab row by `(profile_id, tab_id)`. Sets `last_active_at` to the
   * current timestamp if not provided.
   */
  public upsertTab(profileId: string, tab: NewTab): void {
    const lastActive = tab.last_active_at ?? nowIso();
    this.db
      .prepare(
        'INSERT INTO tabs (profile_id, tab_id, slot_idx, network_id, focus_id, view_mode, structures_state, chronicle_state, activity_state, layer_id, last_active_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n' +
          'ON CONFLICT(profile_id, tab_id) DO UPDATE SET ' +
          'slot_idx = excluded.slot_idx, ' +
          'network_id = excluded.network_id, ' +
          'focus_id = excluded.focus_id, ' +
          'view_mode = excluded.view_mode, ' +
          'structures_state = excluded.structures_state, ' +
          'chronicle_state = excluded.chronicle_state, ' +
          'activity_state = excluded.activity_state, ' +
          'layer_id = excluded.layer_id, ' +
          'last_active_at = excluded.last_active_at',
      )
      .run(
        profileId,
        tab.tab_id,
        tab.slot_idx,
        tab.network_id,
        tab.focus_id ?? null,
        tab.view_mode ?? null,
        tab.structures_state ?? null,
        tab.chronicle_state ?? null,
        tab.activity_state ?? null,
        tab.layer_id ?? null,
        lastActive,
      );
  }

  /**
   * Applies a partial update to a tab row. `null` for nullable fields clears
   * them (e.g. `focus_id: null` сбрасывает фокус).
   */
  public updateTabState(profileId: string, tabId: string, patch: TabStatePatch): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.slot_idx !== undefined) {
      sets.push('slot_idx = ?');
      values.push(patch.slot_idx);
    }
    if (patch.network_id !== undefined) {
      sets.push('network_id = ?');
      values.push(patch.network_id);
    }
    if (patch.focus_id !== undefined) {
      sets.push('focus_id = ?');
      values.push(patch.focus_id);
    }
    if (patch.view_mode !== undefined) {
      sets.push('view_mode = ?');
      values.push(patch.view_mode);
    }
    if (patch.structures_state !== undefined) {
      sets.push('structures_state = ?');
      values.push(patch.structures_state);
    }
    if (patch.chronicle_state !== undefined) {
      sets.push('chronicle_state = ?');
      values.push(patch.chronicle_state);
    }
    if (patch.activity_state !== undefined) {
      sets.push('activity_state = ?');
      values.push(patch.activity_state);
    }
    if (patch.layer_id !== undefined) {
      sets.push('layer_id = ?');
      values.push(patch.layer_id);
    }
    if (patch.last_active_at !== undefined) {
      sets.push('last_active_at = ?');
      values.push(patch.last_active_at);
    }
    if (sets.length === 0) return;
    values.push(profileId, tabId);
    this.db
      .prepare(`UPDATE tabs SET ${sets.join(', ')} WHERE profile_id = ? AND tab_id = ?`)
      .run(...values);
  }

  /** Removes a tab by id (no-op if absent). */
  public deleteTab(profileId: string, tabId: string): void {
    this.db
      .prepare('DELETE FROM tabs WHERE profile_id = ? AND tab_id = ?')
      .run(profileId, tabId);
  }

  /**
   * Reorders tabs by the given `orderedIds` list (one transaction). Any tab
   * not in the list keeps its relative order at the end (defensive — caller
   * must pass the complete list).
   */
  public reorderTabs(profileId: string, orderedIds: string[]): void {
    const tx = this.db.transaction((ids: string[]) => {
      const stmt = this.db.prepare(
        'UPDATE tabs SET slot_idx = ? WHERE profile_id = ? AND tab_id = ?',
      );
      ids.forEach((tabId, idx) => {
        stmt.run(idx, profileId, tabId);
      });
    });
    tx(orderedIds);
  }

  /** Touches `last_active_at` to the current time (called on tab activation). */
  public touchTab(profileId: string, tabId: string): void {
    this.db
      .prepare(
        "UPDATE tabs SET last_active_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') " +
          'WHERE profile_id = ? AND tab_id = ?',
      )
      .run(profileId, tabId);
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

// -------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------

/** Current ISO-8601 timestamp in UTC (`YYYY-MM-DDTHH:MM:SSZ`). */
function nowIso(): string {
  // Match SQL `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` formatting in JS so that
  // `last_active_at` reads consistently from both writers.
  const d = new Date();
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Compose the effective `ui_state.key` for a (profile, network, baseKey, tabId)
 * tuple (07-client-electron.md §3.2 + §3.6). `tabId = null` оставляет ключ как
 * есть — это legacy-формат (один таб на сеть).
 */
function composeUiStateKey(baseKey: string, tabId: string | null): string {
  return tabId === null ? baseKey : `${baseKey}:${tabId}`;
}
