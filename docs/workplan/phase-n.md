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
  порция `body_md` до `COMMENT_PREVIEW_CHARS` (2000) + метаданные
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

## N4. Резолв `thought_ref`-значений в чтении мысли
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** N3
- **Описание:** по запросу пользователя (принято полностью): значения
  свойств в `etn.thoughts.get` и ресурсе `etn.thought` для `value_type =
  'thought_ref'` отдавались голым UUID — агенту приходилось вызывать
  `etn.thoughts.get` на каждую формальную ссылку. Теперь `thought_ref`
  резолвится одним LEFT JOIN в `{id, title}`; `title: null` — висячая ссылка
  на удалённую мысль (`value_thought_ref` без SQL FK). REST-чтение мысли не
  меняется: новая доменная функция `getPropertyValuesResolved`
  (property-service), в REST — прежний `getPropertyValues`.
- **DoD:**
  - [x] Типы `ResolvedThoughtRefValue`/`ResolvedPropertyValue` в `@etn/shared`.
  - [x] `getPropertyValuesResolved` в property-service (один запрос с LEFT JOIN).
  - [x] Использование в `etn.thoughts.get` (tools.ts) и ресурсе `etn.thought`
    (resources.ts).
  - [x] Спека `docs/05-mcp-server.md` §3/§4.1 и `docs/mcp-clients.md`.
  - [x] Тесты: доменный (property-service.test.ts, в т.ч. висячая ссылка) и
    MCP (mcp-tools.test.ts); typecheck зелёный; проверка через MCP stdio.

## N5. Превью комментариев в `etn.thoughts.subgraph`
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** N2
- **Описание:** по запросу пользователя (с заданными ограничениями): с
  `include_comments: true` `subgraph` отдавал все комментарии всех узлов без
  ограничений. Теперь — превью: `permanent` — как в `meta` (обрезка до
  `COMMENT_PREVIEW_CHARS`); `chronological` — последние
  `CHRONO_PREVIEW_MAX_ENTRIES` (10) записей по `valid_from` DESC, каждая с
  телом ≤ `COMMENT_PREVIEW_CHARS` и метаданными
  `chars_returned`/`chars_total`/`truncated`; уровень списка —
  `total`/`returned`/`truncated` («получено x записей из y всего»). Константа
  переименована в общую `COMMENT_PREVIEW_CHARS`; превью permanent вынесено из
  thought-meta в `getPermanentPreview` (comment-service), оба инструмента его
  переиспользуют.
- **DoD:**
  - [x] Константы `COMMENT_PREVIEW_CHARS`/`CHRONO_PREVIEW_MAX_ENTRIES` и типы
    `ChronoEntryPreview`/`ChronologicalPreview`/`CommentsPreview` в `@etn/shared`.
  - [x] `getCommentsPreview`/`getPermanentPreview` в comment-service;
    thought-meta переиспользует `getPermanentPreview`.
  - [x] Новый формат `comments` в `etn.thoughts.subgraph` (tools.ts).
  - [x] Спека `docs/05-mcp-server.md` §4.1 и `docs/mcp-clients.md`.
  - [x] Тесты: доменные (comment-service.test.ts — лимит записей, обрезка
    тела, пустой владелец) и MCP (mcp-tools.test.ts); typecheck зелёный;
    проверка через MCP stdio.

## N6. Каталоги типов (`thought_types`/`link_types`) в ответах read-инструментов
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** N4
- **Описание:** по запросу пользователя: `type_id`/`link_type_id` в ответах
  отдавались голыми UUID — агент не мог понять, как связаны мысли, без
  дополнительных запросов, а повторять название/описание в каждой записи —
  раздувание контекста. Решение — «reference tables» (по согласованному
  дизайну): каждый read-ответ несёт каталоги **только использованных** типов
  с полями для AI: `thought_types` = `{id, name, description, icon}`,
  `link_types` = `{id, name_forward, name_reverse, description, color, style}`
  (оба имени — агент выбирает по направлению ребра). Охват: `subgraph`
  (типы узлов + типы рёбер), `neighbors` (depth=1 и depth>1), `query`,
  `path`, `usage`; ресурс `etn://…/neighbors` — тот же формат. `search` не
  трогается: его хиты не несут `type_id` (REST-контракт).
- **DoD:**
  - [x] Типы `ThoughtTypeRef`/`LinkTypeRef` в `@etn/shared` (types/mcp.ts).
  - [x] `catalogs.ts` (server/src/mcp): `thoughtTypeCatalog`/`linkTypeCatalog`
    — словари по id, неизвестные/удалённые типы пропускаются (без SQL FK).
  - [x] Каталоги в tools.ts (subgraph/neighbors/query/path/usage) и в ресурсе
    `etn.thought.neighbors` (resources.ts).
  - [x] Спека `docs/05-mcp-server.md` §3/§4.1 («Каталоги типов в ответах») и
    `docs/mcp-clients.md`.
  - [x] Тесты mcp-tools.test.ts (каталоги в subgraph/neighbors/query/path/
    usage, description резолвится; пустой каталог у usage без ссылок);
    typecheck зелёный; проверка через MCP stdio на живой сети (каталог
    «софт»/«каталог» с описаниями, 21 инструмент).
