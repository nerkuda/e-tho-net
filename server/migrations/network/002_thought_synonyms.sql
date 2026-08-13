-- thought_synonyms: alternative names for dedup/search (docs/02-data-model.md §3.2).
--
-- (thought_id, synonym_norm) is the natural key: two synonyms that normalise to
-- the same string are the same synonym. The non-normalised form is kept for
-- display. Cascade-deleted with the owning thought.

CREATE TABLE IF NOT EXISTS thought_synonyms (
  thought_id   TEXT NOT NULL,
  synonym      TEXT NOT NULL,                     -- display form
  synonym_norm TEXT NOT NULL,                     -- lowercase trim NFC
  PRIMARY KEY (thought_id, synonym_norm),
  FOREIGN KEY (thought_id) REFERENCES thoughts (id) ON DELETE CASCADE
);

-- Fast lookup of duplicate candidates by normalised synonym text.
CREATE INDEX IF NOT EXISTS idx_synonyms_norm ON thought_synonyms (synonym_norm);
