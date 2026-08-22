-- Self-description of a thought network (task O5, docs/02-data-model.md §2.3,
-- docs/05-mcp-server.md §3 + §4.1).
--
-- `description` was already present (migration 003) and is the free-form
-- one-or-two-paragraph summary seen by both humans and AI agents. Three more
-- markdown text fields let the owner curate exactly how AI agents should treat
-- the network: when to route queries to it, which conventions to follow when
-- writing, and worked examples. Agents are expected to fetch only the fields
-- relevant to the current task (per-use-case routing in `when_to_use`).
--
-- `node_section_type_id` is a forward reference into `thought_types` in the
-- per-network `data.db` (no FK can be declared across DBs in SQLite). When
-- set, every active thought of that type is treated as a "node section" of
-- the network structure (task O5 §"Структура сети"). The referenced type
-- cannot be deleted while any network still points at it (enforced in code).
--
-- Idempotency: the migrator records this file in `_migrations` and never
-- re-runs it, so a plain `ALTER TABLE … ADD COLUMN` (no `IF NOT EXISTS`,
-- which SQLite does not support for ADD COLUMN) is sufficient.

ALTER TABLE networks ADD COLUMN when_to_use TEXT;
ALTER TABLE networks ADD COLUMN conventions TEXT;
ALTER TABLE networks ADD COLUMN examples TEXT;
ALTER TABLE networks ADD COLUMN node_section_type_id TEXT;
