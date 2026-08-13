-- property_values: polymorphic EAV store for property values
-- (docs/02-data-model.md §3.5). Exactly one value_* column is populated per row,
-- according to the definition's value_type; the rest stay NULL. The application
-- (property-service, task C6) enforces the single-column rule and type checks.
--
-- owner is polymorphic (thought/link, no SQL FK). property_id has a real FK to
-- type_properties: deleting a definition cascades its stored values.

CREATE TABLE IF NOT EXISTS property_values (
  id                TEXT PRIMARY KEY,             -- UUID v4
  owner_type        TEXT NOT NULL,                -- 'thought' | 'link'
  owner_id          TEXT NOT NULL,                -- FK (no SQL constraint) → thoughts/links
  property_id       TEXT NOT NULL,                -- FK → type_properties.id
  value_text        TEXT,                         -- populated when value_type = 'text'
  value_date        TEXT,                         -- populated when value_type = 'date' (ISO-8601)
  value_number      REAL,                         -- populated when value_type = 'number'
  value_bool        INTEGER,                      -- populated when value_type = 'bool'
  value_thought_ref TEXT,                         -- populated when value_type = 'thought_ref' (no SQL FK)
  updated_at        TEXT NOT NULL,                -- ISO-8601 UTC
  UNIQUE (owner_type, owner_id, property_id),
  FOREIGN KEY (property_id) REFERENCES type_properties (id) ON DELETE CASCADE
);

-- Look up all values of an owner; verify a single (owner, property) value.
CREATE INDEX IF NOT EXISTS idx_property_values_owner ON property_values (owner_type, owner_id);
