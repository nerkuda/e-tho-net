-- 045: целевые частичные покрывающие индексы связей и снос неселективных
-- idx_links_active/idx_thoughts_active (тех.проект e29c0f00, этап 1; ADR
-- 6e4fef59 «Целевые индексы связей вместо idx_links_active и
-- idx_thoughts_active»; требования 7da6de92 и 42fb69a4).
--
-- Зачем. idx_links_active и idx_thoughts_active почти неселективны (активна
-- почти каждая строка): без статистики планировщик опирается именно на них и
-- получает план O(мысли × рёбра) — EXISTS-проверка и пустой фильтр «Структур»
-- считают секундами (исследование 603a8bcb: пустой фильтр 339 мс, EXISTS
-- 630 мс). Статистика (ANALYZE в конце миграций, требование 239be851) снимает
-- первую проблему, но неселективные индексы всё равно остаются приманкой для
-- планировщика. Поэтому они удаляются ПОЛНОСТЬЮ — при отсутствии регресса по
-- perf-стенду (условие ADR/требования 42fb69a4; стенд
-- server/tests/perf-query-stand.test.ts показывает отсутствие регресса ни на
-- одном горячем запросе).
--
-- Целевые индексы (требование 7da6de92):
--   * idx_links_target_live — частичный покрывающий
--     (target_id, type_id, source_id) WHERE deleted = 0: EXISTS-проверки и
--     отбор по родителю (входящие рёбра) идут индексом без обращения к
--     таблице;
--   * idx_links_source_live — парный по source_id покрывающий
--     (source_id, target_id, type_id, active, marked_for_deletion) WHERE
--     deleted = 0: обходы исходящих рёбер (BFS walkSubtree) без lookup'а
--     строки таблицы.
-- Оба частичные по `deleted = 0`, поэтому применимы только к чтениям через
-- `*_v` (у них предикат `deleted = 0` есть) — это все доменные чтения.
--
-- Не трогаем:
--   * idx_links_triple_live — UNIQUE живых троек слоя (029), снимать нельзя;
--   * idx_links_source/idx_links_target — неселективные, но нужны как
--     fallback для чтений по физической таблице без предиката deleted.

DROP INDEX IF EXISTS idx_links_active;
DROP INDEX IF EXISTS idx_thoughts_active;

CREATE INDEX IF NOT EXISTS idx_links_target_live
  ON links (target_id, type_id, source_id) WHERE deleted = 0;

CREATE INDEX IF NOT EXISTS idx_links_source_live
  ON links (source_id, target_id, type_id, active, marked_for_deletion)
  WHERE deleted = 0;
