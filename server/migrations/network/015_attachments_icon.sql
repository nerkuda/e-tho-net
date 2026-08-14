-- Attachment preview icons (docs/02-data-model.md §3.9, workplan L1).
--
-- `icon` holds a small `data:` URL preview: the site favicon for URL
-- attachments (auto-fetched on creation, best-effort). Nullable — most file
-- attachments have no separate preview (image files preview via etnimg).
--
-- Plain ADD COLUMN is safe and transactional; the migrator never re-runs the
-- file, so no IF NOT EXISTS is needed (same note as migration 013).

ALTER TABLE attachments ADD COLUMN icon TEXT;
