-- Case-insensitive uniqueness of type names (docs/02-data-model.md §3.3/§3.7):
-- `name_key` (thought types) and `name_forward_key`/`name_reverse_key` (link
-- types) hold the normalized name — trimmed and lower-cased, so `Тип`, `тип`
-- and `ТИП` collide. The keys are maintained by the domain services; the
-- UNIQUE indexes guard races. The `type_name_key` SQL function (same
-- normalization as shared `typeNameKey`) is registered by the server on every
-- connection before migrations run.
--
-- Plain ADD COLUMN is safe and transactional; the migrator never re-runs the
-- file, so no IF NOT EXISTS is needed (same note as migration 013/015).

ALTER TABLE thought_types ADD COLUMN name_key TEXT NOT NULL DEFAULT '';
UPDATE thought_types SET name_key = type_name_key(name);

ALTER TABLE link_types ADD COLUMN name_forward_key TEXT NOT NULL DEFAULT '';
ALTER TABLE link_types ADD COLUMN name_reverse_key TEXT NOT NULL DEFAULT '';
UPDATE link_types SET name_forward_key = type_name_key(name_forward);
UPDATE link_types SET name_reverse_key = type_name_key(name_reverse);

CREATE UNIQUE INDEX IF NOT EXISTS idx_thought_types_name_key ON thought_types (name_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_link_types_name_keys
  ON link_types (name_forward_key, name_reverse_key);
