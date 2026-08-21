/**
 * User, API-key and server-side user preference types.
 *
 * Field names mirror docs/02-data-model.md §2.1–2.2, §2.5 and §3.10.1 and the
 * REST contract in docs/03-server-api.md §3. Booleans here represent the
 * semantic 0/1 INTEGER columns of SQLite; the server converts at the boundary.
 */

import type { PrefKey } from '../constants.js';

/** A server user — row of `_system.db.users` (02-data-model.md §2.1). */
export interface User {
  id: string;
  /** Unique login name within the server. */
  username: string;
  display_name: string | null;
  /** Global administrator flag (`is_admin`). */
  is_admin: boolean;
  /** Created by `etn init`; cannot be deleted or demoted. */
  is_first_user: boolean;
  /** Disabled accounts cannot authenticate. */
  disabled: boolean;
  /** ISO-8601 UTC. */
  created_at: string;
  updated_at: string;
}

/** Projection of {@link User} returned by `GET /me` (03-server-api.md §3.1). */
export interface CurrentUser {
  id: string;
  username: string;
  display_name: string | null;
  is_admin: boolean;
}

/** Input for `POST /admin/users` (03-server-api.md §4.1). */
export interface CreateUserInput {
  username: string;
  display_name?: string | null;
  is_admin?: boolean;
}

/** Input for `PATCH /admin/users/{id}` (03-server-api.md §4.1). */
export interface UpdateUserInput {
  display_name?: string | null;
  is_admin?: boolean;
  disabled?: boolean;
}

/**
 * Public shape of an API-key row.
 *
 * The full key is returned exactly once at creation via {@link ApiKeyWithSecret};
 * listing endpoints expose only {@link ApiKey.prefix}.
 *
 * NOTE: `read_only` is required by docs/06-auth.md §6.3 and the MCP read-only
 * mode (05-mcp-server.md §6.3), but is not listed in the api_keys schema of
 * 02-data-model.md §2.2 — the storage layer (tasks B3/B5) must add the column.
 */
export interface ApiKey {
  id: string;
  user_id: string;
  /** Free-form label, e.g. "desktop", "mcp-agent". */
  label: string | null;
  /** First 8 chars of the random part, for display as `etn_a1b2c3d4…`. */
  prefix: string;
  /** Read-only keys cannot call mutating endpoints (06-auth.md §6.3). */
  read_only: boolean;
  /**
   * Per-key override of the MCP write rate limit (05-mcp-server.md §6.2,
   * task O8). `null` — inherit the server-wide `mcp.max_writes_per_minute`.
   */
  max_writes_per_minute: number | null;
  disabled: boolean;
  created_at: string;
  last_used_at: string | null;
}

/** Result of key creation — carries the full secret exactly once. */
export interface ApiKeyWithSecret extends ApiKey {
  /** Full key `etn_<32hex>`, returned only at creation. */
  key: string;
}

/** Input for key creation endpoints (03-server-api.md §3.2, §4.1). */
export interface CreateApiKeyInput {
  label?: string | null;
  read_only?: boolean;
  /** Per-key MCP write rate limit override; `null`/omitted — server default. */
  max_writes_per_minute?: number | null;
}

/**
 * Input for key edit endpoints (03-server-api.md §3.2, §4.1, task O8). Only the
 * MCP write rate limit override is editable after creation; other key fields
 * (label, read_only) are immutable without re-issuing the key.
 */
export interface UpdateApiKeyInput {
  /** `null` clears the override, falling back to the server-wide default. */
  max_writes_per_minute?: number | null;
}

/**
 * Server-side per-user preference entry.
 *
 * At the API level these are scoped by `(network_id, user_id)` from the request
 * context, so the entry itself only carries the key/value. See
 * 11-settings-and-state.md §2.1 L3 and 02-data-model.md §2.5 / §3.10.1.
 */
export interface UserPreferenceEntry {
  key: PrefKey | (string & {});
  /** JSON value (already parsed by the transport layer). */
  value: unknown;
  updated_at: string;
}
