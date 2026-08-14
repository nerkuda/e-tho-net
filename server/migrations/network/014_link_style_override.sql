-- Per-link line-style override (docs/02-data-model.md §3.6, 08-ui-spec.md §6.9).
--
-- A link may override its type's colour / dash style / width. All three columns
-- are nullable: NULL = "inherit from the link's type" (the default), a non-NULL
-- value is a manual override shown on the canvas (08-ui-spec.md §6.2.2). The
-- "Сброс" button in the link settings dialog nulls them.
--
-- ADD COLUMN is safe and transactional (see 013 for why a table rebuild is
-- avoided). The migrator records each file in `_migrations` and never re-runs
-- it, so plain ADD COLUMN (no IF NOT EXISTS — unsupported by SQLite) suffices.

ALTER TABLE links ADD COLUMN color TEXT;
ALTER TABLE links ADD COLUMN style TEXT;
ALTER TABLE links ADD COLUMN width INTEGER;
