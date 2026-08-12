-- settings: L1 system-wide settings, admin-managed (docs/11-settings-and-state.md
-- §2.1 L1, @etn/shared SETTING_KEY / *_DEFAULTS). Each value is JSON-encoded.
--
-- Seeded defaults mirror @etn/shared constants:
--   MCP_DEFAULTS, REALTIME_DEFAULTS, AUTH_DEFAULTS, TRAVERSAL_DEFAULTS.
--
-- The traversal.* rows are seeded here per task B3 even though docs/11 §5.3
-- treats max_depth as a request parameter and query_timeout_ms as a hard server
-- limit: storing them as L1 rows lets an admin override the *default* without a
-- code change. @etn/shared SETTING_KEY does not yet list these two keys — that
-- gap is flagged for a follow-up `docs:`/shared edit.

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,                   -- dotted setting name
  value      TEXT NOT NULL,                      -- JSON-encoded value
  updated_at TEXT NOT NULL                       -- ISO-8601 UTC
);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('mcp.max_nodes_per_subgraph',  '500',   datetime('now')),
  ('mcp.max_writes_per_minute',   '60',    datetime('now')),
  ('realtime.event_log_ttl_hours', '24',   datetime('now')),
  ('realtime.event_log_max_rows',  '10000', datetime('now')),
  ('auth.bad_attempts_per_minute', '10',   datetime('now')),
  ('traversal.max_depth',          '20',   datetime('now')),
  ('traversal.query_timeout_ms',   '5000', datetime('now'));
