-- Style inheritance for thoughts (docs/02-data-model.md §3.1.1).
--
-- Two changes:
--   1. thoughts.font_manual — INTEGER bitmap marking which font_* fields are set
--      manually (bit 0=bold, 1=italic, 2=underline, 3=strike). Fields without
--      their bit are inherited from the thought's type. The API/DTO still
--      surfaces font_* as `boolean | null` (null = "inherit from type"); the
--      service translates to/from the bitmap.
--   2. thought_types.icon_kind — kind of the type's default icon, so a thought
--      may inherit a typed image icon (not just an emoji glyph).
--
-- Why a bitmap instead of nullable font_*: SQLite cannot relax NOT NULL on a
-- column without a full table rebuild, and rebuilding `thoughts` is unsafe here
-- (foreign_keys=ON and the migrator runs each file in one transaction, so a
-- DROP TABLE would issue an implicit DELETE whose ON DELETE CASCADE would wipe
-- links/synonyms/comments/attachments/property_values). ADD COLUMN is safe and
-- transactional.
--
-- Idempotency note: the migrator records each file in `_migrations` and never
-- re-runs it, so plain `ALTER TABLE … ADD COLUMN` (no IF NOT EXISTS — SQLite
-- does not support that clause for ADD COLUMN) is sufficient. Re-applying after
-- deleting the bookkeeping row would fail with "duplicate column"; delete the
-- columns manually in that exceptional case.

ALTER TABLE thoughts ADD COLUMN font_manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thought_types ADD COLUMN icon_kind TEXT NOT NULL DEFAULT 'emoji';
