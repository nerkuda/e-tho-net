-- api_keys: bearer tokens for REST/WebSocket/MCP auth (docs/02-data-model.md
-- §2.2, docs/06-auth.md §2, §6.3).
--
-- Only SHA-256(full_key) is stored in key_hash; the full key is returned to the
-- user exactly once at creation and is never recoverable. key_prefix holds the
-- first 8 hex chars after "etn_" for display (etn_a1b2c3d4…).
--
-- NOTE (Phase-A delta — already approved for B3): the read_only column is
-- required by docs/06-auth.md §6.3 (MCP read-only mode) and @etn/shared ApiKey,
-- but is absent from the §2.2 schema table. It is added here; docs/02-data-model.md
-- §2.2 should be updated to document it.

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,                 -- UUID v4
  user_id      TEXT NOT NULL,                    -- owner
  label        TEXT,                             -- free-form, e.g. "desktop", "mcp-agent"
  key_hash     TEXT NOT NULL,                    -- SHA-256 of the full key (see idx_api_keys_hash)
  key_prefix   TEXT NOT NULL,                    -- first 8 hex chars after "etn_"
  read_only    INTEGER NOT NULL DEFAULT 0,       -- 1 = mutating endpoints blocked (06-auth.md §6.3)
  created_at   TEXT NOT NULL,
  last_used_at TEXT,                             -- updated on each successful auth (best-effort)
  disabled     INTEGER NOT NULL DEFAULT 0,       -- 1 = revoked
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Unique hash lookup (O(1) auth check); docs §2.2 lists idx_api_keys_hash UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
-- Per-user key listing.
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
