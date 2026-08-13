-- embeddings: reserved for future semantic/vector search
-- (docs/02-data-model.md §3.12). The table is created now so a future MCP-driven
-- semantic search does not require a schema migration. MVP does not populate it.

CREATE TABLE IF NOT EXISTS embeddings (
  owner_type TEXT NOT NULL,                       -- 'thought' | 'link' | 'comment'
  owner_id   TEXT NOT NULL,                       -- FK (no SQL constraint) → thoughts/links/comments
  model      TEXT NOT NULL,                       -- embedder model name
  vector     BLOB,                                -- packed float32 array
  ts         TEXT NOT NULL,                       -- ISO-8601 UTC
  PRIMARY KEY (owner_type, owner_id, model)
);
