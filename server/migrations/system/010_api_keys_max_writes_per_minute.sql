-- Per-key override of the MCP write rate limit (task O8, docs/05-mcp-server.md
-- §6.2, docs/06-auth.md §6).
--
-- `max_writes_per_minute` is NULL by default — the key inherits the server-wide
-- `mcp.max_writes_per_minute` setting from `_system.db.settings`. A non-NULL
-- positive integer overrides it for that key, so a legitimate bulk-import key
-- can be given a higher budget (or a tighter one) without touching the global
-- runaway-agent protection. The MCP facade (`mcp/limits.ts` + `mcp/context.ts`)
-- resolves the effective limit per authenticated key; a bundle call (O1) still
-- costs one write.
--
-- Idempotency: the migrator records this file in `_migrations` and never
-- re-runs it, so a plain `ALTER TABLE … ADD COLUMN` (no `IF NOT EXISTS`, which
-- SQLite does not support for ADD COLUMN) is sufficient.

ALTER TABLE api_keys ADD COLUMN max_writes_per_minute INTEGER;
