-- type_properties: property definitions attached to a thought type or link type
-- (docs/02-data-model.md §3.4). Polymorphic owner: owner_type + owner_id point
-- at a thought_types or link_types row but there is no SQL FK (polymorphic).
--
-- value_type governs which value_* column is populated in property_values, and
-- config is a JSON blob (e.g. { allowed_type_id } for thought_ref properties).

CREATE TABLE IF NOT EXISTS type_properties (
  id          TEXT PRIMARY KEY,                   -- UUID v4
  owner_type  TEXT NOT NULL,                      -- 'thought_type' | 'link_type'
  owner_id    TEXT NOT NULL,                      -- FK (no SQL constraint) → thought_types/link_types
  key         TEXT NOT NULL,                      -- property name, unique per owner
  value_type  TEXT NOT NULL,                      -- 'text' | 'date' | 'number' | 'bool' | 'thought_ref'
  config      TEXT,                               -- JSON config (e.g. { allowed_type_id })
  required    INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0,         -- display order
  UNIQUE (owner_type, owner_id, key)
);

-- List the properties of a type in display order.
CREATE INDEX IF NOT EXISTS idx_type_properties_owner ON type_properties (owner_type, owner_id, position);
