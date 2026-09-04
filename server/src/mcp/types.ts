/**
 * Internal types of the MCP facade (phase F, docs/05-mcp-server.md).
 *
 * The MCP server is a thin facade over the same domain layer as REST, acting
 * on behalf of the user whose API-key authenticated the session (05 §2.1). An
 * {@link McpAuthContext} is resolved from a raw key string by the injected
 * {@link McpAuthProvider}; every tool/resource callback receives the context
 * through its {@link McpRuntime}.
 */

import type { SystemDb } from '../db/system-db.js';
import type { FileLog } from '../log/file-log.js';
import type { Logger } from '../logger.js';
import type { PubSub } from '../realtime/pubsub.js';

/**
 * Authenticated principal of one MCP session: the API-key owner and the key's
 * own identity (its `read_only` flag gates mutating tools, 05 §6.3).
 */
export interface McpAuthContext {
  /** Owning user id — the agent acts as this user. */
  userId: string;
  /** Owning user login (diagnostics/logs). */
  username: string;
  /** `api_keys.id` of the key used for the session. */
  keyId: string;
  /** Display prefix of the key (`etn_xxxxxxxx…`, diagnostics only). */
  keyPrefix: string;
  /** True when the key was created with `read_only` — mutating tools reject. */
  readOnly: boolean;
  /**
   * Per-key override of the write rate limit (05-mcp-server.md §6.2, task O8);
   * `null` — inherit the server-wide `mcp.max_writes_per_minute`.
   */
  maxWritesPerMinute: number | null;
  /** Whether the owning user is a server administrator (not used on MVP). */
  isAdmin: boolean;
}

/**
 * Resolves a raw API-key string into an {@link McpAuthContext}, or `null` when
 * the key is malformed, unknown, disabled, or belongs to a disabled user.
 */
export type McpAuthProvider = (rawApiKey: string) => McpAuthContext | null;

/** Dependencies shared by every MCP entry point (HTTP endpoint, stdio CLI). */
export interface McpBaseDeps {
  /** Open `_system.db` accessor (auth, membership, audit, settings). */
  systemDb: SystemDb;
  /** Absolute ETN data directory (`networks/<id>/data.db` lives here). */
  dataDir: string;
  /** Real-time broker — domain events from MCP tools fan out like REST ones. */
  pubsub: PubSub;
  /** API-key → principal resolution (injected for testability). */
  authProvider: McpAuthProvider;
  /** Application logger. */
  logger: Logger;
  /**
   * File journal for diagnostics (task 1dd33e23 §3): when present, every tool
   * call's name + duration is journaled (INFO while logging is enabled).
   * Optional so tests and foreign embeddings keep working unchanged.
   */
  fileLog?: FileLog;
}

/** Dependencies of one concrete {@link createMcpServer} instance. */
export interface McpDeps extends McpBaseDeps {
  /** Authenticated principal this server instance acts on behalf of. */
  auth: McpAuthContext;
}
