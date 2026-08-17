# Фаза N — MCP: структурная выборка `etn.thoughts.query`

> [← Workplan (индекс)](../workplan.md) — оглавление, статусы фаз и решения.


> По запросу пользователя (17.08.2026): агентам нужен один вызов MCP вместо
> цепочки «найти тип → найти корень → обойти поддерево → отфильтровать», а
> также фильтрация по значениям свойств и датам, которой нет в
> полнотекстовом поиске.

## N1. MCP-инструмент `etn.thoughts.query`
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** F (MCP-сервер)
- **Описание:** новый read-only MCP-инструмент структурной выборки мыслей —
  «список по критериям» без обязательного текстового запроса (в отличие от
  `etn.thoughts.search`, где `query` обязателен и работает FTS5). Критерии
  комбинируются (AND): `in_subtree_of` + `max_depth` (направленный обход
  вниз по активным связям, depth каждой мысли в ответе), `type_id[]`,
  `active` (`true`/`false`/`any`), `keywords` (LIKE по названию и синонимам),
  `properties[]` (условия по значениям свойств: `key` + `operator`
  eq/ne/contains/gt/gte/lt/lte + `value`; типы значений сами определяют
  колонку — число → `value_number`, булев → `value_bool`, строка →
  `value_text`/`value_date`/`value_thought_ref` по оператору), диапазоны
  `created_*`/`updated_*` (ISO-8601), `sort`/`order`, `limit`/`offset`.
  Ответ: `{ total, hits: [{id, title, type_id, active, depth}] , truncated,
  reason }`. Обход ограничен `max_nodes_per_subgraph`; сервис —
  `server/src/domain/query-service.ts`, переиспользует паттерны
  `search-service` (clause/join) и `traverse` (BFS с visited-set, циклы-safe).
- **DoD:**
  - [x] Типы `ThoughtQuery*` в `@etn/shared` (types/query.ts).
  - [x] `query-service.ts`: направленный обход вниз с depth, фильтры
    тип/актуальность/ключевые слова/свойства/даты, пагинация, сортировка.
  - [x] Инструмент `etn.thoughts.query` в `mcp/tools.ts` + описание в
    `docs/05-mcp-server.md` §4.1a и `docs/mcp-clients.md` §4.
  - [x] Тесты `tests/query-service.test.ts` (native-доступны — зелёные, 7/7).
  - [x] Typecheck зелёный; ручная проверка через MCP stdio (20 инструментов,
    выборка ошибок в поддереве ETN одним вызовом, валидация операторов).
