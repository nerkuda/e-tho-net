-- layers.colors (0.6.4, «Цветовая индикация слоёв»; docs/13-layers.md §2.2a).
--
-- Colour indication of change layers: a layer is visually almost
-- indistinguishable from the base, so the user does not understand why others
-- do not see the layer's edits. The layer row now carries a JSON blob:
--
--   { "focus_stripe": {"dark": "#rrggbb", "light": "#rrggbb"},
--     "background":   {"dark": "#rrggbb", "light": "#rrggbb"} }
--
--   * NULL — theme defaults (the base layer is always NULL and rejects
--     colour assignment via the API);
--   * validation (both keys, both themes, #rrggbb hex) lives in the server
--     service, not in SQLite.

ALTER TABLE layers ADD COLUMN colors TEXT;
