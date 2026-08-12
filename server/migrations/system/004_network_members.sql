-- network_members: user membership in networks (docs/02-data-model.md §2.4).
--
-- Invariants (enforced at the application layer):
--   * exactly one row with role = 'owner' per network;
--   * the owner cannot leave until ownership is transferred;
--   * a system admin may edit any row here directly (for management) but still
--     needs a membership row to READ the network's data.

CREATE TABLE IF NOT EXISTS network_members (
  network_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,                      -- 'owner' | 'member'
  added_at   TEXT NOT NULL,                      -- ISO-8601 UTC
  added_by   TEXT NOT NULL,                      -- user id of the actor who added
  PRIMARY KEY (network_id, user_id),
  FOREIGN KEY (network_id) REFERENCES networks (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  FOREIGN KEY (added_by) REFERENCES users (id)
);

-- Reverse lookup: which networks does a user belong to?
CREATE INDEX IF NOT EXISTS idx_network_members_user ON network_members (user_id);
