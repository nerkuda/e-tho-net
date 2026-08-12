-- event_log: per-network real-time event buffer for resume/replay
-- (docs/04-realtime.md §3, §6). Window enforced by a TTL job (last
-- realtime.event_log_max_rows rows or realtime.event_log_ttl_hours hours).
--
-- `data` stores the full serialised event (actor, audience, meta, payload) so
-- the WebSocket gateway can re-filter audience/echo suppression on replay.

CREATE TABLE IF NOT EXISTS event_log (
  network_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,                   -- monotonic per network (see network_seq)
  ts         TEXT NOT NULL,                      -- ISO-8601 UTC
  type       TEXT NOT NULL,                      -- event type, e.g. 'thought.created'
  data       TEXT NOT NULL,                      -- JSON: full event document
  PRIMARY KEY (network_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log (ts);

-- network_seq: per-network monotonic sequence counter (docs/04-realtime.md §3, §5).
-- Incremented in the same transaction as the change that emits the event, so the
-- (commit, seq) pair is consistent.
CREATE TABLE IF NOT EXISTS network_seq (
  network_id TEXT PRIMARY KEY,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (network_id) REFERENCES networks (id) ON DELETE CASCADE
);
