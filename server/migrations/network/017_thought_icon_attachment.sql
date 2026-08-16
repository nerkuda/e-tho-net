-- Thought icon ← attachment link (docs/02-data-model.md §3.1, workplan L16).
--
-- `icon_attachment_id` references the attachment whose full image is shown
-- when the user Ctrl-hovers the thought icon. The icon itself stays a
-- self-contained preview (`icon` + `icon_kind='image'`, ≤256 KiB) so all
-- clients render it without resolving the attachment.
--
-- Plain ADD COLUMN is safe and transactional; the migrator never re-runs the
-- file, so no IF NOT EXISTS is needed (same note as migrations 013/015).

ALTER TABLE thoughts ADD COLUMN icon_attachment_id TEXT;
