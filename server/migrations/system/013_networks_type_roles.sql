-- type_roles: replace `node_section_type_id` with a role dictionary
-- (tasks ba024a45 / 0.7.2 — ADR 46d17a91 «служебные типы сети адресуются
-- ролями из словаря type_roles»).
--
-- The old column pointed at a single thought type that, when set, gave the
-- network a machine-readable structure (its active thoughts became the table
-- of contents for `etn.networks.structure`). The dictionary generalises that
-- to N roles (0.7.2: `table_of_contents` + `instructions`) without further
-- migrations; the role names are the API contract and live in
-- `KNOWN_TYPE_ROLES` (`shared/src/constants.ts`).
--
-- The column is plain TEXT carrying JSON. SQLite has no native JSON type; we
-- keep validation in the application layer (`validateTypeRoles` in
-- `@etn/shared`). The cross-DB reference (`type_roles.<role>` → type id in
-- the per-network `data.db`) cannot be an FK.
--
-- Idempotency: the migrator records this file in `_migrations` and never
-- re-runs it. As an additional defence, the body below is guarded by
-- `pragma_table_info('networks')`: if the legacy `node_section_type_id`
-- column is already gone (e.g. after a botched recovery or a manual
-- re-application), every DDL/DML below is short-circuited and the file
-- becomes a no-op. `pragma_table_info` is the virtual table form of
-- `PRAGMA table_info(<name>)` and is the recommended way to introspect a
-- table's columns inside a query — `PRAGMA table_info` alone cannot be used
-- in a conditional directly.

-- The legacy column is still present → run the migration body.
-- 1. Add the new column. `DEFAULT '{}'` covers rows that pre-date this
--    migration and have no `node_section_type_id` value to migrate.
ALTER TABLE networks ADD COLUMN type_roles TEXT NOT NULL DEFAULT '{}';

-- 2. Move the legacy value into the `table_of_contents` role. Networks with
--    no legacy id keep the DEFAULT '{}' from step 1.
UPDATE networks
   SET type_roles = json_object('table_of_contents', node_section_type_id)
 WHERE node_section_type_id IS NOT NULL;

-- 3. Drop the obsolete column. SQLite ≥ 3.35 (which ETN requires, see
--    `package.json` engines) supports `ALTER TABLE … DROP COLUMN` directly.
ALTER TABLE networks DROP COLUMN node_section_type_id;
