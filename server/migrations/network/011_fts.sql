-- FTS5 full-text search tables and synchronisation triggers
-- (docs/02-data-model.md §3.11, docs/03-server-api.md §12).
--
-- Three FTS5 indexes cover the search scenario:
--   * fts_thought_names — thought titles + synonyms;
--   * fts_thought_texts — bodies of comments attached to thoughts;
--   * fts_link_texts   — bodies of comments attached to links.
--
-- The fourth search group ("chronology") is a kind='chronological' filter over
-- the same FTS tables, not a separate index. `tokenize = 'unicode61
-- remove_diacritics 2'` handles Cyrillic and Latin without extra dictionaries.
--
-- The FTS rowid mirrors the rowid of the source row (thoughts.rowid /
-- comments.rowid), which keeps trigger-driven DELETE/UPDATE exact and cheap.
-- thought_id/link_id are UNINDEXED payload columns returned in search hits.

CREATE VIRTUAL TABLE IF NOT EXISTS fts_thought_names USING fts5(
  thought_id UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_thought_texts USING fts5(
  thought_id UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_link_texts USING fts5(
  link_id UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ---------------------------------------------------------------------------
-- thoughts ↔ fts_thought_names (text = title + synonyms)
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_thoughts_ai_names AFTER INSERT ON thoughts BEGIN
  INSERT INTO fts_thought_names (rowid, thought_id, text)
  VALUES (
    NEW.rowid,
    NEW.id,
    NEW.title || COALESCE((
      SELECT ' ' || group_concat(synonym, ' ') FROM thought_synonyms WHERE thought_id = NEW.id
    ), '')
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_thoughts_ad_names AFTER DELETE ON thoughts BEGIN
  DELETE FROM fts_thought_names WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER IF NOT EXISTS trg_thoughts_au_names AFTER UPDATE ON thoughts BEGIN
  DELETE FROM fts_thought_names WHERE rowid = OLD.rowid;
  INSERT INTO fts_thought_names (rowid, thought_id, text)
  VALUES (
    NEW.rowid,
    NEW.id,
    NEW.title || COALESCE((
      SELECT ' ' || group_concat(synonym, ' ') FROM thought_synonyms WHERE thought_id = NEW.id
    ), '')
  );
END;

-- ---------------------------------------------------------------------------
-- thought_synonyms ↔ fts_thought_names (rebuild the thought's names row)
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS trg_synonyms_ai_names AFTER INSERT ON thought_synonyms BEGIN
  DELETE FROM fts_thought_names WHERE rowid = (SELECT rowid FROM thoughts WHERE id = NEW.thought_id);
  INSERT INTO fts_thought_names (rowid, thought_id, text)
  SELECT t.rowid, t.id,
         t.title || COALESCE((
           SELECT ' ' || group_concat(s.synonym, ' ') FROM thought_synonyms s WHERE s.thought_id = t.id
         ), '')
  FROM thoughts t WHERE t.id = NEW.thought_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_synonyms_ad_names AFTER DELETE ON thought_synonyms BEGIN
  DELETE FROM fts_thought_names WHERE rowid = (SELECT rowid FROM thoughts WHERE id = OLD.thought_id);
  INSERT INTO fts_thought_names (rowid, thought_id, text)
  SELECT t.rowid, t.id,
         t.title || COALESCE((
           SELECT ' ' || group_concat(s.synonym, ' ') FROM thought_synonyms s WHERE s.thought_id = t.id
         ), '')
  FROM thoughts t WHERE t.id = OLD.thought_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_synonyms_au_names AFTER UPDATE ON thought_synonyms BEGIN
  DELETE FROM fts_thought_names WHERE rowid = (SELECT rowid FROM thoughts WHERE id = OLD.thought_id);
  INSERT INTO fts_thought_names (rowid, thought_id, text)
  SELECT t.rowid, t.id,
         t.title || COALESCE((
           SELECT ' ' || group_concat(s.synonym, ' ') FROM thought_synonyms s WHERE s.thought_id = t.id
         ), '')
  FROM thoughts t WHERE t.id = NEW.thought_id;
END;

-- ---------------------------------------------------------------------------
-- comments ↔ fts_thought_texts / fts_link_texts (text = body_md)
-- ---------------------------------------------------------------------------
-- One FTS row per comment (rowid = comments.rowid). Conditional writes use
-- `INSERT ... SELECT ... WHERE <owner_type>` so a single trigger pair handles
-- both thought- and link-owned comments and owner-type changes cleanly.

CREATE TRIGGER IF NOT EXISTS trg_comments_ai_fts AFTER INSERT ON comments BEGIN
  INSERT INTO fts_thought_texts (rowid, thought_id, text)
  SELECT NEW.rowid, NEW.owner_id, NEW.body_md WHERE NEW.owner_type = 'thought';
  INSERT INTO fts_link_texts (rowid, link_id, text)
  SELECT NEW.rowid, NEW.owner_id, NEW.body_md WHERE NEW.owner_type = 'link';
END;

CREATE TRIGGER IF NOT EXISTS trg_comments_ad_fts AFTER DELETE ON comments BEGIN
  DELETE FROM fts_thought_texts WHERE rowid = OLD.rowid;
  DELETE FROM fts_link_texts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER IF NOT EXISTS trg_comments_au_fts AFTER UPDATE ON comments BEGIN
  DELETE FROM fts_thought_texts WHERE rowid = OLD.rowid;
  DELETE FROM fts_link_texts WHERE rowid = OLD.rowid;
  INSERT INTO fts_thought_texts (rowid, thought_id, text)
  SELECT NEW.rowid, NEW.owner_id, NEW.body_md WHERE NEW.owner_type = 'thought';
  INSERT INTO fts_link_texts (rowid, link_id, text)
  SELECT NEW.rowid, NEW.owner_id, NEW.body_md WHERE NEW.owner_type = 'link';
END;
