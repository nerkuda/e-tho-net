-- Per-thought read counters for AI-agent usage analytics (workplan task O10,
-- docs/05-mcp-server.md §5.1, docs/02-data-model.md §3.13).
--
-- `thought_views` (§3.10.2) tracks individual focus marks for human clients
-- and drives the "viewed" sort; it is intentionally per-user and must not be
-- polluted by agent traffic. `thought_read_metrics` is the network-wide
-- aggregate — every time an MCP read tool returns a thought (get, subgraph
-- nodes, query hits, search hits in the by_names/by_texts/by_chrono groups,
-- networks.structure sections), the counter is incremented in a single
-- batched UPSERT. The owner uses `etn.metrics.reads` to surface hot spots
-- (high reads_count) and dead zones (zero reads).
--
-- Deletion of a thought cascades to this row via FK; no separate cleanup is
-- needed.

CREATE TABLE IF NOT EXISTS thought_read_metrics (
  thought_id     TEXT PRIMARY KEY,                       -- UUID v4
  reads_count    INTEGER NOT NULL DEFAULT 0,             -- total read touches
  first_read_at  TEXT NOT NULL,                          -- ISO-8601 UTC of first read
  last_read_at   TEXT NOT NULL,                          -- ISO-8601 UTC of latest read
  FOREIGN KEY (thought_id) REFERENCES thoughts (id) ON DELETE CASCADE
);

-- Supports `ORDER BY reads_count DESC, last_read_at DESC` for the top list
-- without a temporary sort. The cold list (`reads_count = 0`) does not need
-- a covering index — it filters from `thoughts` ordered by `updated_at`.
CREATE INDEX IF NOT EXISTS idx_thought_read_metrics_count
  ON thought_read_metrics (reads_count DESC, last_read_at DESC);
