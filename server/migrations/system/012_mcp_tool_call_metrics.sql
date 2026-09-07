-- mcp_tool_call_metrics: aggregate counter of MCP tool calls (task 940a499d,
-- entity b05c48df, docs/05-mcp-server.md §5.1). Unlike thought_read_metrics
-- (which lives in the network's data.db) this table lives in `_system.db`:
-- a call may target no network at all (`etn.networks.list`, `etn.metrics.tools`),
-- so the counter cannot ride on a network database. Not branchable — telemetry
-- is an exploitation fact, not network content, and never enters change layers.
--
-- One row per (tool_name, network_id, api_key_id): an aggregate, not an event
-- journal. Arguments are deliberately NOT stored (they carry network content;
-- per-change forensics live in audit_log). Reads/writes, successes and errors
-- all count; the increment happens in the shared tool-registration wrapper.
--
-- NULL-safety of the unique key: SQLite treats NULLs as distinct inside a
-- plain UNIQUE constraint, so `ON CONFLICT` would never fire for network-less
-- calls. The expression unique index below folds NULL into '' and is the
-- actual conflict target of the upsert; the table-level UNIQUE documents the
-- natural key and still covers the non-NULL case.

CREATE TABLE IF NOT EXISTS mcp_tool_call_metrics (
  tool_name     TEXT NOT NULL,                     -- e.g. 'etn.thoughts.write'
  network_id    TEXT,                              -- NULL — call outside any network
  api_key_id    TEXT NOT NULL,                     -- separates agents from each other
  calls_count   INTEGER NOT NULL DEFAULT 0,
  errors_count  INTEGER NOT NULL DEFAULT 0,
  first_call_at TEXT,                              -- ISO-8601, set on the first insert
  last_call_at  TEXT,                              -- ISO-8601, bumped on every upsert
  UNIQUE (tool_name, network_id, api_key_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_tool_call_metrics_key
  ON mcp_tool_call_metrics (tool_name, IFNULL(network_id, ''), api_key_id);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_call_metrics_network
  ON mcp_tool_call_metrics (network_id);
