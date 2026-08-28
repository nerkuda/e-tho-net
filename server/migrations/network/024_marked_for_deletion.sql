-- marked_for_deletion: mark-for-deletion (trash) columns (docs/02-data-model.md §3.1.2, task S13).
--
-- A plain, branchable-in-the-future field: thoughts and links get
-- `marked_for_deletion` plus the audit columns that record who marked it and
-- when. Marking is reversible (PATCH marked_for_deletion: false) and does NOT
-- hide the row — it only makes physical deletion a deliberate, checked step
-- (03-server-api.md §6.5/§6.5a/§14b). The layer-tombstone `deleted` column is
-- a separate concern introduced by phase S2 (0.5.2), not here.

ALTER TABLE thoughts ADD COLUMN marked_for_deletion INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thoughts ADD COLUMN marked_for_deletion_at TEXT;
ALTER TABLE thoughts ADD COLUMN marked_for_deletion_by TEXT;

ALTER TABLE links ADD COLUMN marked_for_deletion INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN marked_for_deletion_at TEXT;
ALTER TABLE links ADD COLUMN marked_for_deletion_by TEXT;

-- The trash list (GET /trash) reads only the narrow `marked_for_deletion = 1`
-- slice, so the indexes are partial (02-data-model.md §3.1/§3.6).
CREATE INDEX IF NOT EXISTS idx_thoughts_marked_for_deletion
  ON thoughts (marked_for_deletion) WHERE marked_for_deletion = 1;
CREATE INDEX IF NOT EXISTS idx_links_marked_for_deletion
  ON links (marked_for_deletion) WHERE marked_for_deletion = 1;
