/**
 * Read-metrics domain service (workplan task O10, docs/05-mcp-server.md §5.1,
 * docs/02-data-model.md §3.13).
 *
 * Maintains the network-wide aggregate `thought_read_metrics` that counts how
 * many times each thought has been returned by an MCP read tool. The
 * counter is intentionally **not** persisted to `audit_log` (workplan O10
 * explicitly forbids per-read audit entries) and **not** mixed with the
 * per-user `thought_views` table — both would inflate either the realtime
 * feed or the human focus-sort history.
 *
 * Writes happen from the MCP read tools after they have produced their
 * response: one batched `INSERT … SELECT … FROM json_each(?)` statement
 * covers the entire set of returned ids (de-duplicated on the server
 * before the call so a thought that appears twice in a search result does
 * not double-count). `thought_read_metrics.thought_id` is FK CASCADE-clean
 * with `thoughts` — deleting a thought wipes its counter automatically.
 *
 * Reads go through `getTopReads` / `getColdReads` and power the
 * `etn.metrics.reads` MCP tool (top hot spots vs. cold dead zones).
 */

import type { NetworkDb } from '../db/network-db.js';
import type {
  McpMetricsReadsItem,
  McpMetricsReadsKind,
} from '@etn/shared';

/** Default page size for `etn.metrics.reads` results. */
export const READ_METRICS_DEFAULT_LIMIT = 20;
/** Hard cap on `etn.metrics.reads` results — matches the other read tools. */
export const READ_METRICS_MAX_LIMIT = 200;

export interface RecordReadsOptions {
  /** ISO-8601 timestamp stamped on the increment (server supplies one per call). */
  now: string;
}

export interface ReadMetricsListOptions {
  /** Effective page size after clamping; required. */
  limit: number;
  /**
   * ISO-8601 timestamp. Only consulted by `getColdReads`: thoughts whose
   * `last_read_at` is `null` or strictly less than this value are returned.
   */
  since?: string;
  /** When `false` (default), only `active = 1` thoughts are considered. */
  includeInactive?: boolean;
}

/**
 * Increment `reads_count` for every existing thought id in `ids` and stamp
 * `last_read_at = now`. A no-op for an empty list. Duplicate ids collapse
 * before the SQL call so the counter moves at most once per id per call.
 *
 * The single statement joins `json_each(?)` against `thoughts` — ids that
 * no longer exist (or never did) are silently skipped, so the call is safe
 * to issue against any read response without pre-validation.
 */
export function recordReads(
  ndb: NetworkDb,
  ids: readonly string[],
  options: RecordReadsOptions,
): void {
  if (ids.length === 0) return;
  const unique = Array.from(new Set(ids));
  const json = JSON.stringify(unique);
  ndb
    .prepare(
      `INSERT INTO thought_read_metrics (thought_id, reads_count, first_read_at, last_read_at)
         SELECT t.id, 1, ?, ?
           FROM thoughts_v t
           JOIN json_each(?) AS j ON j.value = t.id
       ON CONFLICT(thought_id) DO UPDATE SET
              reads_count = reads_count + 1,
              last_read_at = excluded.last_read_at`,
    )
    .run(options.now, options.now, json);
}

interface RawMetricsRow {
  thought_id: string;
  title: string;
  type_id: string | null;
  reads_count: number;
  first_read_at: string | null;
  last_read_at: string | null;
}

/**
 * Read top-N most-read thoughts (workplan O10, "hot spots"). Ordered by
 * `reads_count DESC, last_read_at DESC` so freshly-read nodes win ties.
 * Thoughts without any read counter never appear here — see
 * {@link getColdReads} for the complementary query.
 */
export function getTopReads(
  ndb: NetworkDb,
  options: ReadMetricsListOptions,
): McpMetricsReadsItem[] {
  const rows = ndb
    .prepare(
      `SELECT t.id          AS thought_id,
              t.title       AS title,
              t.type_id     AS type_id,
              m.reads_count AS reads_count,
              m.first_read_at AS first_read_at,
              m.last_read_at  AS last_read_at
         FROM thought_read_metrics m
         JOIN thoughts_v t ON t.id = m.thought_id
        WHERE (? = 1 OR t.active = 1)
        ORDER BY m.reads_count DESC, m.last_read_at DESC
        LIMIT ?`,
    )
    .all(options.includeInactive === true ? 1 : 0, options.limit) as RawMetricsRow[];
  return rows.map(rowToItem);
}

/**
 * Read cold thoughts — never read, or not read since `since` (workplan O10,
 * "dead zones"). `since = undefined` means "never read at all" — the entire
 * `thought_read_metrics` table is excluded and the result is built from
 * `thoughts` via a LEFT JOIN. With `since`, only rows whose `last_read_at`
 * is `null` or strictly older than the cutoff are returned.
 *
 * Ordered by `updated_at DESC` so the freshest un-touched nodes surface
 * first — that is usually the signal the owner is looking for ("my most
 * recent notes are being ignored").
 */
export function getColdReads(
  ndb: NetworkDb,
  options: ReadMetricsListOptions,
): McpMetricsReadsItem[] {
  const since = options.since ?? null;
  const rows = ndb
    .prepare(
      `SELECT t.id          AS thought_id,
              t.title       AS title,
              t.type_id     AS type_id,
              COALESCE(m.reads_count, 0) AS reads_count,
              m.first_read_at AS first_read_at,
              m.last_read_at  AS last_read_at
         FROM thoughts_v t
         LEFT JOIN thought_read_metrics m ON m.thought_id = t.id
        WHERE (m.thought_id IS NULL
               OR m.last_read_at IS NULL
               OR (CAST(? AS TEXT) IS NOT NULL AND m.last_read_at < CAST(? AS TEXT)))
          AND (? = 1 OR t.active = 1)
        ORDER BY t.updated_at DESC, t.created_at DESC
        LIMIT ?`,
    )
    .all(since, since, options.includeInactive === true ? 1 : 0, options.limit) as RawMetricsRow[];
  return rows.map(rowToItem);
}

/** Convert the raw SQL row into the shared MCP DTO shape. */
function rowToItem(row: RawMetricsRow): McpMetricsReadsItem {
  return {
    thought_id: row.thought_id,
    title: row.title,
    type_id: row.type_id,
    reads_count: row.reads_count,
    first_read_at: row.first_read_at,
    last_read_at: row.last_read_at,
  };
}

/** Resolve the effective limit and selection for `etn.metrics.reads`. */
export function clampReadMetricsParams(input: {
  kind?: McpMetricsReadsKind;
  limit?: number;
}): { kind: McpMetricsReadsKind; limit: number } {
  const kind: McpMetricsReadsKind = input.kind ?? 'top';
  const limit = Math.min(
    Math.max(input.limit ?? READ_METRICS_DEFAULT_LIMIT, 1),
    READ_METRICS_MAX_LIMIT,
  );
  return { kind, limit };
}
