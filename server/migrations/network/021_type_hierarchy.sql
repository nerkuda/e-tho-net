-- Type hierarchy (L21, docs/02-data-model.md §3.3/§3.7/§3.4.1): thought_types
-- and link_types become trees with a single undeletable root «основной тип».
--
--  * `parent_id` — parent type (FK, enforced by the app; NULL only on the
--    root). Every existing type is attached under the newly seeded root, so
--    the migration is a no-op behaviour-wise until the user edits the tree.
--  * `is_root` — marks the root; the app guarantees exactly one row per table.
--  * link_types inheritance: `style`/`width` are physically NOT NULL, so the
--    own-vs-inherited distinction lives in the `style_set`/`width_set` flags
--    (`color` is already nullable and keeps its NULL = inherit meaning).
--    Existing rows whose style/width equal the application defaults ('solid'/
--    1) flip the flags off, so they start inheriting from the root (which
--    itself resolves to the same defaults — no visible change).
--  * `type_property_overrides` — per-type default-value overrides of
--    inherited property definitions (02-data-model.md §3.4.1).
--
-- Tables are NOT rebuilt: DROP TABLE under foreign_keys=ON runs an implicit
-- DELETE that would null out links.type_id (see 013 for the same concern), so
-- everything is done with additive ADD COLUMN + backfill UPDATEs.
--
-- Fixed root ids are shared across networks on purpose: ids are unique per
-- network database only, and a constant keeps the root easy to spot in dumps.
-- The migrator never re-runs this file.

ALTER TABLE thought_types ADD COLUMN parent_id TEXT REFERENCES thought_types (id);
ALTER TABLE thought_types ADD COLUMN is_root INTEGER NOT NULL DEFAULT 0;

ALTER TABLE link_types ADD COLUMN parent_id TEXT REFERENCES link_types (id);
ALTER TABLE link_types ADD COLUMN is_root INTEGER NOT NULL DEFAULT 0;
ALTER TABLE link_types ADD COLUMN style_set INTEGER NOT NULL DEFAULT 1;
ALTER TABLE link_types ADD COLUMN width_set INTEGER NOT NULL DEFAULT 1;

UPDATE link_types SET style_set = CASE WHEN style = 'solid' THEN 0 ELSE 1 END;
UPDATE link_types SET width_set = CASE WHEN width = 1 THEN 0 ELSE 1 END;

-- Seed the thought-type root. If a type named «основной тип» already exists,
-- the INSERT is skipped and that type is promoted to the root instead.
INSERT INTO thought_types
  (id, name, name_key, icon, icon_kind, parent_id, is_root,
   fg_color, bg_color, font_bold, font_italic, font_underline, font_strike,
   description, version, created_at, updated_at, created_by)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'основной тип', type_name_key('основной тип'),
   NULL, 'emoji', NULL, 1,
   NULL, NULL, NULL, NULL, NULL, NULL,
   'Корневой тип иерархии: его настройки применяются к мыслям без типа и наследуются всеми типами.',
   1, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 'system')
ON CONFLICT (name_key) DO NOTHING;

UPDATE thought_types SET is_root = 1, parent_id = NULL
 WHERE name_key = type_name_key('основной тип') AND is_root = 0;

UPDATE thought_types
   SET parent_id = (SELECT id FROM thought_types WHERE is_root = 1)
 WHERE is_root = 0 AND parent_id IS NULL;

-- Seed the link-type root, same conflict handling.
INSERT INTO link_types
  (id, name_forward, name_forward_key, name_reverse, name_reverse_key,
   parent_id, is_root, color, style, width, style_set, width_set,
   description, version, created_at, updated_at, created_by)
VALUES
  ('00000000-0000-4000-8000-000000000002',
   'основной тип', type_name_key('основной тип'),
   'основной тип', type_name_key('основной тип'),
   NULL, 1, NULL, 'solid', 1, 0, 0,
   'Корневой тип иерархии: его настройки применяются к связям без типа и наследуются всеми типами.',
   1, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 'system')
ON CONFLICT (name_forward_key, name_reverse_key) DO NOTHING;

UPDATE link_types SET is_root = 1, parent_id = NULL
 WHERE name_forward_key = type_name_key('основной тип')
   AND name_reverse_key = type_name_key('основной тип')
   AND is_root = 0;

UPDATE link_types
   SET parent_id = (SELECT id FROM link_types WHERE is_root = 1)
 WHERE is_root = 0 AND parent_id IS NULL;

CREATE TABLE IF NOT EXISTS type_property_overrides (
  id            TEXT NOT NULL,                           -- UUID
  owner_type    TEXT NOT NULL,                           -- 'thought_type' | 'link_type'
  type_id       TEXT NOT NULL,                           -- the type overriding the default
  property_id   TEXT NOT NULL REFERENCES type_properties (id) ON DELETE CASCADE,
  default_value TEXT NOT NULL,                           -- JSON-encoded value (string|number|boolean)
  created_at    TEXT NOT NULL,                           -- ISO-8601 UTC
  updated_at    TEXT NOT NULL,                           -- ISO-8601 UTC
  PRIMARY KEY (id),
  UNIQUE (owner_type, type_id, property_id)
);
