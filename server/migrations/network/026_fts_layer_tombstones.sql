-- Change layers (фаза S, задача S6; docs/13-layers.md §9, docs/02-data-model.md §3.11).
--
-- Правка FTS-триггеров индекса имён после S4: агрегат синонимов в тексте
-- `fts_thought_names` не отбрасывал надгробия. В основе это было невидимо
-- (там удаление — физический DELETE), но в рабочем слое удаление синонима —
-- материализованное надгробие (13-layers.md §5.2): строка остаётся в таблице
-- с deleted = 1, и пересборка текста строки мысли слоя включала УДАЛЁННЫЙ
-- синоним обратно в индекс. Поиск в слое продолжал находить мысль по
-- синониму, удалённому в этом слое.
--
-- Все пять триггеров, собирающих текст из синонимов (два на `thoughts`,
-- три на `thought_synonyms`), переписаны с `AND deleted = 0` в агрегате.
-- Триггеры комментариев индексируют одну строку и правки не требуют;
-- `trg_thoughts_ad_names` (физический DELETE) не агрегирует синонимов.
--
-- FTS-таблицы не трогаем: строки надгробий самих мыслей/комментариев в
-- индексе остаются, но недостижимы — представления *_v не экспонируют
-- надгробий, и rowid-джойн поиска (S6) их отсекает.

DROP TRIGGER IF EXISTS trg_thoughts_ai_names;
DROP TRIGGER IF EXISTS trg_thoughts_au_names;
DROP TRIGGER IF EXISTS trg_synonyms_ai_names;
DROP TRIGGER IF EXISTS trg_synonyms_ad_names;
DROP TRIGGER IF EXISTS trg_synonyms_au_names;

-- thoughts ↔ fts_thought_names (text = title + живые синонимы того же слоя)

CREATE TRIGGER trg_thoughts_ai_names AFTER INSERT ON thoughts BEGIN
  INSERT INTO fts_thought_names (rowid, thought_id, layer_id, text)
  VALUES (
    NEW.pk,
    NEW.id,
    NEW.layer_id,
    NEW.title || COALESCE((
      SELECT ' ' || group_concat(synonym, ' ') FROM thought_synonyms
      WHERE thought_id = NEW.id AND layer_id = NEW.layer_id AND deleted = 0
    ), '')
  );
END;

CREATE TRIGGER trg_thoughts_au_names AFTER UPDATE ON thoughts BEGIN
  DELETE FROM fts_thought_names WHERE rowid = OLD.pk;
  INSERT INTO fts_thought_names (rowid, thought_id, layer_id, text)
  VALUES (
    NEW.pk,
    NEW.id,
    NEW.layer_id,
    NEW.title || COALESCE((
      SELECT ' ' || group_concat(synonym, ' ') FROM thought_synonyms
      WHERE thought_id = NEW.id AND layer_id = NEW.layer_id AND deleted = 0
    ), '')
  );
END;

-- thought_synonyms ↔ fts_thought_names (пересобирают строку мысли того же слоя)

CREATE TRIGGER trg_synonyms_ai_names AFTER INSERT ON thought_synonyms BEGIN
  DELETE FROM fts_thought_names
   WHERE rowid = (SELECT pk FROM thoughts WHERE id = NEW.thought_id AND layer_id = NEW.layer_id);
  INSERT INTO fts_thought_names (rowid, thought_id, layer_id, text)
  SELECT t.pk, t.id, t.layer_id,
         t.title || COALESCE((
           SELECT ' ' || group_concat(s.synonym, ' ') FROM thought_synonyms s
           WHERE s.thought_id = t.id AND s.layer_id = t.layer_id AND s.deleted = 0
         ), '')
  FROM thoughts t WHERE t.id = NEW.thought_id AND t.layer_id = NEW.layer_id;
END;

CREATE TRIGGER trg_synonyms_ad_names AFTER DELETE ON thought_synonyms BEGIN
  DELETE FROM fts_thought_names
   WHERE rowid = (SELECT pk FROM thoughts WHERE id = OLD.thought_id AND layer_id = OLD.layer_id);
  INSERT INTO fts_thought_names (rowid, thought_id, layer_id, text)
  SELECT t.pk, t.id, t.layer_id,
         t.title || COALESCE((
           SELECT ' ' || group_concat(s.synonym, ' ') FROM thought_synonyms s
           WHERE s.thought_id = t.id AND s.layer_id = t.layer_id AND s.deleted = 0
         ), '')
  FROM thoughts t WHERE t.id = OLD.thought_id AND t.layer_id = OLD.layer_id;
END;

CREATE TRIGGER trg_synonyms_au_names AFTER UPDATE ON thought_synonyms BEGIN
  DELETE FROM fts_thought_names
   WHERE rowid = (SELECT pk FROM thoughts WHERE id = OLD.thought_id AND layer_id = OLD.layer_id);
  INSERT INTO fts_thought_names (rowid, thought_id, layer_id, text)
  SELECT t.pk, t.id, t.layer_id,
         t.title || COALESCE((
           SELECT ' ' || group_concat(s.synonym, ' ') FROM thought_synonyms s
           WHERE s.thought_id = t.id AND s.layer_id = t.layer_id AND s.deleted = 0
         ), '')
  FROM thoughts t WHERE t.id = OLD.thought_id AND t.layer_id = OLD.layer_id;
END;
