/**
 * MCP operation limits (task F6, docs/05-mcp-server.md §6.2).
 *
 * Two limits protect the server from runaway agents:
 *   * `max_nodes_per_subgraph` — caps any subgraph/neighbour traversal so an
 *     agent cannot pull the whole network in one call;
 *   * `max_writes_per_minute` — per authenticated principal sliding-window
 *     budget for mutating tool calls.
 *
 * Values come from the L1 settings table in `_system.db`
 * (`mcp.max_nodes_per_subgraph`, `mcp.max_writes_per_minute`, seeded by
 * migration `008_settings.sql`) with the `@etn/shared` {@link MCP_DEFAULTS} as
 * fallback. Exceeding the write budget raises `RATE_LIMITED` (the MCP-visible
 * equivalent of HTTP 429).
 */

import { MCP_DEFAULTS, SETTING_KEY } from '@etn/shared';

import type { SystemDb } from '../db/system-db.js';

/** Resolved numeric limits for one MCP server instance. */
export interface ResolvedMcpLimits {
  /** Hard cap on nodes returned by subgraph/neighbour traversals. */
  maxNodesPerSubgraph: number;
  /** Mutating tool calls allowed per rolling minute per principal. */
  maxWritesPerMinute: number;
}

/**
 * Parse a settings value into a positive integer. Settings values are
 * JSON-encoded per `008_settings.sql` (numeric seeds are stored bare), so both
 * `"60"` and `60` parse correctly; anything unusable falls back to `fallback`.
 */
function parseSettingInt(raw: string | null, fallback: number): number {
  if (raw === null) {
    return fallback;
  }
  let value: unknown = raw;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    // Not valid JSON — use the raw string (bare numeric seed).
  }
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read both limits from `_system.db.settings`, falling back to shared defaults.
 *
 * `perKeyMaxWritesPerMinute` (task O8) is the authenticated key's override from
 * `api_keys.max_writes_per_minute` (`null` — no override). When non-null it
 * replaces the server-wide `mcp.max_writes_per_minute`, so a bulk-import key can
 * hold a different budget than the global runaway-agent protection.
 */
export function resolveMcpLimits(
  systemDb: SystemDb,
  perKeyMaxWritesPerMinute: number | null = null,
): ResolvedMcpLimits {
  return {
    maxNodesPerSubgraph: parseSettingInt(
      systemDb.getSetting(SETTING_KEY.MCP_MAX_NODES_PER_SUBGRAPH),
      MCP_DEFAULTS.MAX_NODES_PER_SUBGRAPH,
    ),
    maxWritesPerMinute:
      perKeyMaxWritesPerMinute ??
      parseSettingInt(
        systemDb.getSetting(SETTING_KEY.MCP_MAX_WRITES_PER_MINUTE),
        MCP_DEFAULTS.MAX_WRITES_PER_MINUTE,
      ),
  };
}

/**
 * Sliding-window write counter (one instance per MCP server, i.e. per
 * authenticated key session). `tryConsume` records one write and reports
 * whether the budget for the last 60 seconds is exhausted.
 */
export class WriteRateLimiter {
  /** Timestamps (ms) of writes within the current window, oldest first. */
  private readonly stamps: number[] = [];

  constructor(
    private readonly maxPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Drop stamps older than the 60-second window. */
  private prune(): void {
    const cutoff = this.now() - 60_000;
    while (this.stamps.length > 0 && (this.stamps[0] as number) <= cutoff) {
      this.stamps.shift();
    }
  }

  /**
   * Attempt to record one write. Returns `false` (and records nothing) when
   * the per-minute budget is exhausted.
   */
  tryConsume(): boolean {
    this.prune();
    if (this.stamps.length >= this.maxPerMinute) {
      return false;
    }
    this.stamps.push(this.now());
    return true;
  }

  /** Number of writes recorded in the current window (tests/introspection). */
  count(): number {
    this.prune();
    return this.stamps.length;
  }
}
