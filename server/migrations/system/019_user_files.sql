-- user_files (0.16.1, tasks 8e007e63 + 5db41abf; entity 62fd29b5, ADR a5888535).
--
-- ВНИМАНИЕ (задача 5db41abf). Эта миграция ПЕРЕПИСАНА НА МЕСТЕ (0.16.1 ещё не
-- выпущена), а migrator учитывает только имя файла и не видит изменения
-- содержимого. Стенды и рабочие каталоги, созданные до коммита 83cfc20c, НЕ
-- стартуют («no such column: network_id»): сбросьте `_system.db` или пересоздайте
-- таблицу `user_files`.
--
-- Files of the server-level user IN A NETWORK: the stored file belongs to the
-- pair (user, network) — every network has its own map wallpaper (API operation
-- 31ef478a, revision 2026-11-13). At the moment the single kind is
-- 'map_wallpaper' (the map background image).
-- Deliberately NOT attachments (they live in a network DB with multi-ownership,
-- 10 MiB limit and no lightness metadata) and NOT user_settings (JSON values).
--
-- One active file per (user, network, kind): the primary key doubles as the
-- UNIQUE invariant, and a new upload overwrites both the row and the file on
-- disk within that pair — the previous file is removed physically (no
-- multi-ownership).
--
-- network_id is a plain TEXT id: networks live in separate databases, so there
-- is no FOREIGN KEY to `networks` (SQLite cannot reference across databases).
-- Deleting a network removes its user_files rows and files in code
-- (NetworkServiceImpl.deleteNetwork → removeNetworkUserFiles).
--
-- file_path is absolute: <ETN_DATA_DIR>/users/<user_id>/files/<name>. Those
-- files are NOT part of the automatic DB backup (ADR a5888535): the source image
-- stays with the user, the server copy is restored by re-uploading.
--
-- user_id cascades: deleting a user removes the rows; the route layer removes
-- the user's directory physically (server/src/routes/users.ts).

CREATE TABLE IF NOT EXISTS user_files (
  user_id      TEXT    NOT NULL,                    -- FK → users.id (CASCADE)
  network_id   TEXT    NOT NULL,                    -- network uuid the image was chosen for
  kind         TEXT    NOT NULL,                    -- file kind, e.g. 'map_wallpaper'
  file_path    TEXT    NOT NULL,                    -- absolute path under ETN_DATA_DIR/users/
  content_hash TEXT    NOT NULL,                    -- SHA-256 of the stored bytes
  file_size    INTEGER NOT NULL,                    -- bytes after the client-side downscale
  mime_type    TEXT    NOT NULL,                    -- image/jpeg | image/png | image/webp
  meta         TEXT    NOT NULL,                    -- JSON {width,height,avg_luminance,...}
  updated_at   INTEGER NOT NULL,                    -- epoch ms of the last overwrite
  PRIMARY KEY (user_id, network_id, kind),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Deleting a network looks rows up by network_id alone (no user_id prefix in
-- that query), so the primary key does not serve it.
CREATE INDEX IF NOT EXISTS idx_user_files_network ON user_files (network_id);
