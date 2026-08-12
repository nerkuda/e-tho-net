-- client_request_cache: idempotency cache keyed by Client-Request-Id
-- (docs/02-data-model.md §2.7, docs/01-architecture.md §6). Rows expire after
-- IDEMPOTENCY_TTL_MINUTES (10) via a cleanup job.

CREATE TABLE IF NOT EXISTS client_request_cache (
  request_id TEXT PRIMARY KEY,                   -- UUID supplied by the client
  user_id    TEXT NOT NULL,
  ts         TEXT NOT NULL,                      -- ISO-8601 UTC
  status     INTEGER NOT NULL,                   -- stored HTTP status of the response
  body       TEXT                                -- JSON-encoded response body
);

-- TTL sweep support: find rows older than the cutoff.
CREATE INDEX IF NOT EXISTS idx_client_request_cache_ts ON client_request_cache (ts);
