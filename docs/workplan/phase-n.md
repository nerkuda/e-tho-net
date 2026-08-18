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

## N2. Обогащённое чтение мысли: счётчики и постоянный комментарий
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** N1
- **Описание:** по запросу пользователя: чтение мысли одним вызовом должно
  сразу давать «сигналы полноты» — нужно ли тянуть родителей/потомков,
  вложения и хронику. В `etn.thoughts.get` и ресурс `etn.thought` добавляется
  блок `meta`: `parents_count`/`children_count` (активные связи),
  `attachments_count`, `chrono_count` (хронологические комментарии) и
  `permanent` — постоянный комментарий с обрезкой больших текстов: первая
  порция `body_md` до `PERMANENT_COMMENT_PREVIEW_CHARS` (2000) + метаданные
  `chars_returned`/`chars_total`/`truncated`, чтобы агент знал, что текст
  обрезан и полный можно получить отдельным запросом.
- **DoD:**
  - [x] Тип `ThoughtMeta` в `@etn/shared`.
  - [x] `getThoughtMeta` в `server/src/domain/thought-meta.ts` (4 COUNT по
    индексам + 1 SELECT по уникальному индексу permanent; обрезка 2000).
  - [x] `meta` в ответах `etn.thoughts.get` (tools.ts) и `etn://…/thoughts/{id}`
    (resources.ts); REST-чтение мысли не меняется.
  - [x] Тесты `tests/thought-meta.test.ts` (счётчики, отсутствие permanent,
    обрезка длинного текста).
  - [x] Спека `docs/05-mcp-server.md` §3/§4.1; typecheck зелёный; проверка
    через MCP stdio.

## N3. «Использование» мысли: счётчик в meta и список с группировкой по свойствам
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** N2
- **Описание:** по запросу пользователя: формальные связи через
  `thought_ref`-свойства (группа «Использование» в редакторе, REST
  `GET /thoughts/{id}/usage`, `findThoughtUsage`) не видны MCP-агентам.
  Добавляется: (1) `usage_count` в блок `meta` чтения мысли (как другие
  счётчики — по `property_values.value_thought_ref`); (2) MCP-инструмент
  `etn.thoughts.usage` и ресурс `etn://…/thoughts/{id}/usage`, возвращающие
  `{ total, groups: [{property_id, key, thoughts[]}] }` — те же данные, что
  в редакторе (группировка по свойству, сортировка по key и названию).
- **DoD:**
  - [x] `usage_count` в `ThoughtMeta` и `getThoughtMeta`.
  - [x] Инструмент `etn.thoughts.usage` (tools.ts) + ресурс `etn.thought.usage`
    (resources.ts) на базе `findThoughtUsage`; `MCP_TOOL_NAMES` — 21.
  - [x] Спека `docs/05-mcp-server.md` §3/§4.1 и `docs/mcp-clients.md`.
  - [x] Тесты: `usage_count` в thought-meta.test.ts; вызов инструмента в
    mcp-tools.test.ts; typecheck зелёный; проверка через MCP stdio.
