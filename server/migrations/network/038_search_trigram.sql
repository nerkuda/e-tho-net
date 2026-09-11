-- Full-text search: переход на токенизатор FTS5 `trigram` (ошибка 0258fd9d
-- «Не ищет мысль по части слова не с начала», версия 0.7.5).
--
-- Токенизатор `unicode61` индексирует ТОКЕНЫ (границы — пробелы/пунктуация) и
-- умеет искать только по ПРЕФИКСУ токена (`"публик"*` находит «публикация»,
-- но не «опубликовано» — «публик» не с начала токена). `trigram` индексирует
-- перекрывающиеся окна из 3 символов независимо от границ слов, поэтому
-- `MATCH '"публик"'` находит вхождение в любой позиции текста — то, что и
-- просит задача. Проверено эмпирически на этой сборке (better-sqlite3
-- 11.1.2 / SQLite 3.46.0): кейс-фолдинг кириллицы уже встроен в сам
-- токенизатор (`"БЕТА"` находит «бета-тема») — никакого кастомного
-- lower()/ESCAPE-кода не нужно (в отличие от провалившейся попытки через
-- ручной LIKE-проход, см. хронокомментарии задачи 0258fd9d).
--
-- `rank`/`bm25()` продолжают работать как раньше — сортировка результатов не
-- меняется. Единственное ограничение индекса: триграмме нужно ≥3 символа на
-- фрагмент (`MATCH '"ха"'` даёт 0 строк, не ошибку) — короче документирован
-- как Tier 1 ограничение в server/src/domain/search-service.ts.
--
-- Таблицы пересоздаются (FTS5 не даёт ALTER TOKENIZE), данные — полный
-- бэкфилл из исходных таблиц. Триггеры (`trg_thoughts_*`, `trg_synonyms_*`,
-- `trg_comments_*`) НЕ трогаем: они обращаются к FTS-таблицам по имени и не
-- зависят от токенизатора (задача S6/026 их уже актуализировала с учётом
-- `layer_id`/надгробий) — после пересоздания таблиц продолжают работать как
-- есть. Бэкфилл синонимов использует текущую (после 026) корректную формулу
-- `deleted = 0`, так что заодно переиндексирует любые унаследованные от
-- старых записей «мёртвые» синонимы.
--
-- Область влияния: `fts_thought_texts`/`fts_link_texts` используются также
-- `findMentions()` (`search-service.ts`) как черновой кандидат-фильтр перед
-- точным regex-чеком — смена токенизатора безопасна для него (полнее
-- фильтрует кандидатов, regex всё равно сверяет точно), кроме литералов
-- короче 3 символов: соответствующий guard добавлен в `candidateMatchForTerm`
-- в этом же коммите.

DROP TABLE fts_thought_names;
DROP TABLE fts_thought_texts;
DROP TABLE fts_link_texts;

CREATE VIRTUAL TABLE fts_thought_names USING fts5(
  thought_id UNINDEXED,
  layer_id UNINDEXED,
  text,
  tokenize = 'trigram case_sensitive 0'
);

CREATE VIRTUAL TABLE fts_thought_texts USING fts5(
  thought_id UNINDEXED,
  layer_id UNINDEXED,
  text,
  tokenize = 'trigram case_sensitive 0'
);

CREATE VIRTUAL TABLE fts_link_texts USING fts5(
  link_id UNINDEXED,
  layer_id UNINDEXED,
  text,
  tokenize = 'trigram case_sensitive 0'
);

INSERT INTO fts_thought_names (rowid, thought_id, layer_id, text)
SELECT t.pk, t.id, t.layer_id,
       t.title || COALESCE((
         SELECT ' ' || group_concat(s.synonym, ' ') FROM thought_synonyms s
         WHERE s.thought_id = t.id AND s.layer_id = t.layer_id AND s.deleted = 0
       ), '')
FROM thoughts t;

INSERT INTO fts_thought_texts (rowid, thought_id, layer_id, text)
SELECT c.pk, c.owner_id, c.layer_id, c.body_md FROM comments c WHERE c.owner_type = 'thought';

INSERT INTO fts_link_texts (rowid, link_id, layer_id, text)
SELECT c.pk, c.owner_id, c.layer_id, c.body_md FROM comments c WHERE c.owner_type = 'link';
