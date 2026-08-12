-- audit_log: administrative and security-critical events
-- (docs/02-data-model.md §2.6, docs/06-auth.md §8, §9).
--
-- NOTE (Phase-A delta — already approved for B3): the category column accepts
-- 'system' as well — used by `etn init` (action = 'init') per docs/06-auth.md
-- §8. The §2.6 table lists only auth/user/network/membership/data; docs should
-- add 'system'. No CHECK constraint is used so future categories don't require
-- a migration; the application validates via @etn/shared AUDIT_CATEGORIES.

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,                   -- ISO-8601 UTC
  actor_user_id TEXT,                            -- NULL = system actor
  network_id    TEXT,                            -- NULL = system-level op
  category      TEXT NOT NULL,                   -- auth | user | network | membership | data | system
  action        TEXT NOT NULL,                   -- create | update | delete | grant | revoke | login | init | ...
  target_type   TEXT,                            -- 'user' | 'network' | 'thought' | ...
  target_id     TEXT,
  details       TEXT                             -- JSON
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_network ON audit_log (network_id);
