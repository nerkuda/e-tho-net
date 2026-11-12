-- user_files (0.16.1, task 8e007e63; entity 62fd29b5, ADR a5888535).
--
-- Files of the server-level user — outside any network: at the moment the single
-- kind is 'map_wallpaper' (the map background image, API operation 31ef478a).
-- Deliberately NOT attachments (they live in a network DB with multi-ownership,
-- 10 MiB limit and no lightness metadata) and NOT user_settings (JSON values).
--
-- One active file per (user, kind): the primary key doubles as the UNIQUE
-- invariant, and a new upload overwrites both the row and the file on disk —
-- the previous file is removed physically (no multi-ownership).
--
-- file_path is absolute: <ETN_DATA_DIR>/users/<user_id>/files/<name>. Those
-- files are NOT part of the automatic DB backup (ADR a5888535): the source image
-- stays with the user, the server copy is restored by re-uploading.
--
-- user_id cascades: deleting a user removes the rows; the route layer removes
-- the user's directory physically (server/src/routes/users.ts).

CREATE TABLE IF NOT EXISTS user_files (
  user_id      TEXT    NOT NULL,                    -- FK → users.id (CASCADE)
  kind         TEXT    NOT NULL,                    -- file kind, e.g. 'map_wallpaper'
  file_path    TEXT    NOT NULL,                    -- absolute path under ETN_DATA_DIR/users/
  content_hash TEXT    NOT NULL,                    -- SHA-256 of the stored bytes
  file_size    INTEGER NOT NULL,                    -- bytes after the client-side downscale
  mime_type    TEXT    NOT NULL,                    -- image/jpeg | image/png | image/webp
  meta         TEXT    NOT NULL,                    -- JSON {width,height,avg_luminance,...}
  updated_at   INTEGER NOT NULL,                    -- epoch ms of the last overwrite
  PRIMARY KEY (user_id, kind),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
