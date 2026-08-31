-- 007: unified visit history — «Переделать историю посещения мыслей» (0.5.5).
-- Replaces the two per-view histories (focus_history, structures_history)
-- with a single visit_history: one common list of thoughts opened in the
-- thought editor, shared by every screen (map/structures/chronicle) of a tab
-- (docs/07-client-electron.md §3.5, 11-settings-and-state.md §2.3).
--
-- The chronicle's own mixed thought+link history (chronicle_history) is
-- retired too — the bottom-bar history now tracks only thoughts opened in
-- the editor, regardless of which screen opened them.
--
-- Data carried over: focus_history rows only (renamed as-is). Both
-- structures_history and chronicle_history are local UI convenience caches,
-- not authoritative data — dropping their rows on upgrade is harmless; the
-- unified history rebuilds naturally as the user keeps navigating.

ALTER TABLE focus_history RENAME TO visit_history;
DROP INDEX IF EXISTS idx_focus_history_seq;
CREATE INDEX IF NOT EXISTS idx_visit_history_seq
  ON visit_history (profile_id, network_id, tab_id, seq DESC);

DROP TABLE IF EXISTS structures_history;
DROP INDEX IF EXISTS idx_structures_history_seq;

DROP TABLE IF EXISTS chronicle_history;
DROP INDEX IF EXISTS idx_chronicle_history_seq;
