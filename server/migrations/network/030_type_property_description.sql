-- type_properties.description + type_property_overrides.description
-- (task «Добавить описание (description) к определениям свойств типов»).
--
-- The definition column mirrors thought_types/link_types `description`: the
-- AI- and user-facing hint of what the property means and which format its
-- values take. A child type inherits the description together with the
-- property (L21 effective chain) and may override it for itself through
-- type_property_overrides.description.
--
-- type_property_overrides.default_value stays NOT NULL: a description-only
-- override stores the JSON literal 'null' (no default override), which
-- readers already treat as "no override" (JSON.parse('null') === null). The
-- row is deleted once it overrides neither the default nor the description.

ALTER TABLE type_properties ADD COLUMN description TEXT;

ALTER TABLE type_property_overrides ADD COLUMN description TEXT;
