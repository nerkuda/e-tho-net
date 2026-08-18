# 05. MCP-сервер

## 1. Назначение

MCP-сервер (Model Context Protocol) — точка подключения внешних AI-агентов
(Claude Desktop, IDE-агенты, кастомные скрипты) к данным ETN. Реализован в том же
серверном процессе, использует тот же доменный слой и те же правила доступа, что
REST. Все изменения, сделанные агентом, идентичны человеческим: проходят
валидацию, контроль прав, порождают real-time события для участников сети.

## 2. Транспорт и аутентификация

- **Транспорт:** stdio (для локальных агентов, запускаемых на сервере) и
  StreamableHTTP (для удалённых) — оба поддерживаются SDK.
- **Аутентификация:** API-key пользователя (или сервисный ключ) передаётся:
  - stdio — через переменную окружения `ETN_API_KEY` или аргумент `--api-key`.
  - HTTP — заголовок `Authorization: Bearer <API-key>` (как в REST).
- Сервер ETN открывает MCP-эндпоинт на отдельном пути `/mcp` (или отдельном
  порту) — отличном от REST, чтобы изолировать трафик агентов.

### 2.1. Модель авторизации

Агент действует от лица пользователя, чей ключ передан. Это означает:
- видит и может менять только сети, в которых пользователь является участником;
- внутри сети — равноправный участник (как человек);
- на сервере отображается в `audit_log` со своим `actor_user_id`.

Никаких специальных «машинных» прав сверх прав пользователя. Это упрощает модель
и не даёт агенту тихо получить доступ к чужим данным.

### 2.2. Многоканальный агент

Если агенту нужен доступ к нескольким сетям — он использует `network_id`
параметром в каждом tool-вызове, ключ пользователя уже даёт ему доступ ко всем
его сетям.

## 3. Ресурсы (Resources)

Ресурсы — данные, которые агент читает по URI (static + templated).

| URI | Описание |
|-----|----------|
| `etn://networks` | Список сетей, доступных пользователю |
| `etn://networks/{network_id}` | Метаданные сети |
| `etn://networks/{network_id}/thoughts/{thought_id}` | Полная мысль: свойства, синонимы, тип, стили |
| `etn://networks/{network_id}/thoughts/{thought_id}/neighbors` | Соседи (parents/children/siblings) |
| `etn://networks/{network_id}/thoughts/{thought_id}/comments` | Комментарии мысли |
| `etn://networks/{network_id}/thoughts/{thought_id}/attachments` | Вложения мысли |
| `etn://networks/{network_id}/links/{link_id}` | Связь с метаданными |
| `etn://networks/{network_id}/thought-types` | Определения типов мыслей |
| `etn://networks/{network_id}/link-types` | Определения типов связей |
| `etn://networks/{network_id}/thought-types/{id}` | Тип и его свойства (включая description — для контекста агента) |

Ресурсы отдаются как JSON (mime `application/json`). Комментарии — как Markdown
(mime `text/markdown`) для прямой передачи агенту.

Описание типов (`thought_types.description`, `link_types.description`) — это и
есть тот самый «комментарий для AI-агентов» из словаря: в нём пользователь
объясняет суть типа и его связей. Ресурс типа возвращает это описание первым
классом.

## 4. Инструменты (Tools)

Все инструменты именуются по схеме `etn.<сущность>.<действие>`.

### 4.1. Поиск и чтение

| Tool | Описание | Параметры |
|------|----------|-----------|
| `etn.networks.list` | Доступные сети | — |
| `etn.thoughts.search` | Полнотекстовый поиск | `network_id`, `query`, `scope?` (`names`/`texts`/`links`/`chronology`/`all`), `in_subtree_of?`, `type_id?`, `limit?` |
| `etn.thoughts.query` | Структурная выборка (список по критериям) | см. §4.1a |
| `etn.thoughts.get` | Полная мысль | `network_id`, `thought_id` |
| `etn.thoughts.neighbors` | Соседи | `network_id`, `thought_id`, `dir`, `depth?` (1 = прямые соседи; >1 — обход) |
| `etn.thoughts.subgraph` | Подграф в радиусе N рёбер | `network_id`, `seed_ids[]`, `radius`, `max_nodes`, `include_comments?` |
| `etn.thoughts.path` | Путь между двумя мыслями | `network_id`, `from_id`, `to_id`, `max_depth` |
| `etn.links.get` | Связь | `network_id`, `link_id` |
| `etn.thoughts.mentions` | Где упоминается мысль | `network_id`, `thought_id` |
| `etn.export.subgraph` | Подграф как Markdown-документ | `network_id`, `seed_ids[]`, `radius`, `format?` (md/html) |

`etn.thoughts.subgraph` — ключевой для RAG-сценариев: агент задаёт радиус
обхода, лимит узлов, и получает JSON-граф с мыслями, связями и (опционально)
комментариями — готовый контекст для генерации.

#### 4.1a. `etn.thoughts.query` — структурная выборка

Список мыслей по критериям **без обязательного текстового запроса** (в
отличие от `etn.thoughts.search`). Нужен, когда искать нечего, а критерий —
структурный: «все ошибки в поддереве проекта», «мысли со свойством
статус = активный», «задачи, изменённые за неделю». Все фильтры
комбинируются (AND).

| Параметр | Тип | Смысл |
|----------|-----|-------|
| `network_id` | string | обязателен |
| `in_subtree_of` | string | ограничить подчинёнными этой мысли: **направленный** обход вниз по активным связям (source → target) на любую глубину |
| `max_depth` | int | максимальная глубина обхода (по умолчанию 20) |
| `type_id` | string[] | фильтр по типам мыслей |
| `active` | `true`/`false`/`any` | актуальность (по умолчанию `true` — только актуальные) |
| `keywords` | string | LIKE-фильтр по названию и синонимам (без FTS) |
| `properties` | array | условия по значениям свойств: `{key, operator, value}` |
| `created_after`/`created_before` | string | ISO-8601, диапазон создания |
| `updated_after`/`updated_before` | string | ISO-8601, диапазон изменения |
| `sort` | `title`/`created_at`/`updated_at` | сортировка (по умолчанию `title`) |
| `order` | `asc`/`desc` | направление (по умолчанию `asc`) |
| `limit`/`offset` | int | пагинация (лимит по умолчанию 50, максимум 200) |

Операторы условия `properties`: `eq`, `ne`, `contains`, `gt`, `gte`, `lt`,
`lte`. Тип переданного `value` сам выбирает колонку значения:
- **число** — `value_number` (все операторы, кроме `contains`);
- **булево** — `value_bool` (`eq`/`ne`);
- **строка** — `contains` по `value_text`; `gt/gte/lt/lte` по `value_date`
  (ISO-8601, лексикографическое сравнение); `eq/ne` по любой текстовой
  колонке (`value_text`/`value_date`/`value_thought_ref`).

Ответ: `{ total, hits: [{id, title, type_id, active, depth}], truncated,
reason }`. `depth` — расстояние от `in_subtree_of` (0 — сам корень; `null`,
если корень не задан). Обход ограничен `max_nodes_per_subgraph` — при
превышении `truncated: true, reason: "max_nodes"`, и лишние узлы в выборку
не попадают.

Пример — все ошибки в поддереве проекта за один вызов:

```json
{
  "network_id": "<net>",
  "in_subtree_of": "<id проекта>",
  "type_id": ["<id типа «ошибка»>"]
}
```

### 4.2. Создание и изменение

| Tool | Описание | Параметры |
|------|----------|-----------|
| `etn.thoughts.create` | Создать мысль | `network_id`, `title`, `synonyms?`, `type_id?`, `active?`, `link?` `{direction, target_thought_id, type_id?}` |
| `etn.thoughts.update` | Изменить мысль | `network_id`, `thought_id`, `changes`, `expected_version?` |
| `etn.thoughts.delete` | Удалить | `network_id`, `thought_id`, `expected_version?` |
| `etn.links.create` | Создать связь | `network_id`, `source_id`, `target_id`, `type_id?` |
| `etn.links.delete` | Удалить связь | `network_id`, `link_id` |
| `etn.comments.upsert` | Создать/обновить комментарий | `network_id`, `owner_type`, `owner_id`, `kind`, `title?`, `body_md`, `valid_from?`, `valid_to?` |
| `etn.attachments.add` | Добавить вложение | `network_id`, `owner_type`, `owner_id`, `kind`, `url?`/`file_path?`, `title?`, `description?` |
| `etn.properties.set` | Установить свойство | `network_id`, `owner_type`, `owner_id`, `key`, `value` |
| `etn.thoughts.set_active` | Изменить актуальность | `network_id`, `thought_id`, `active` |

Все изменяющие инструменты:
- принимают опциональный `expected_version` для optimistic concurrency
  (если не передан — last-write-wins без проверки);
- возвращают `{ id, version, request_id }`;
- порождают стандартные real-time события (см. [04-realtime.md](04-realtime.md)).

### 4.3. Дедупликация (важна для агентов)

| Tool | Описание | Параметры |
|------|----------|-----------|
| `etn.thoughts.find_duplicates` | Поиск существующих по имени/синонимам | `network_id`, `title`, `synonyms?` |

Возвращает матчи с оценкой совпадения (точное/по синониму/частичное). Агент
должен вызывать это **перед** `etn.thoughts.create`, чтобы не плодить дубликаты
(как и человек через диалог добавления). Синонимы с подстановками `*`
(02-data-model.md §3.2) учитываются: у мысли с синонимом `Игорян*` ввод
`Игорянский` даст совпадение по синониму.

## 5. Prompts (шаблоны запросов)

Заранее определённые шаблоны для типовых задач агента:

| Prompt | Назначение |
|--------|------------|
| `etn.summarize_thought` | Краткое резюме мысли и её контекста |
| `etn.suggest_links` | Предложить возможные связи для мысли на основе текстов соседей |
| `etn.detect_duplicates` | Найти кандидаты на слияние в поддереве |
| `etn.generate_report` | Собрать Markdown-документ по подграфу на заданную тему |

Шаблоны параметризуются (например, `network_id`, `thought_id`), возвращают
текстовый промпт, который агент передаёт своей LLM.

## 6. Контроль операций агента

### 6.1. Журналирование
Каждый изменяющий tool-вызов пишется в `audit_log` с `category = 'data'`,
`action` — соответствует типу операции, в `details` — параметры вызова.

### 6.2. Лимиты (опционально на MVP)
- `max_nodes_per_subgraph` (например, 500) — защита от того, что агент вытянет
  всю сеть.
- `max_writes_per_minute` на пользователя — защита от runaway-агента.
Лимиты настраиваются в `_system.db` (`settings`), на MVP — фиксированные дефолты.

### 6.3. Режим read-only для ключа
При создании API-key через `/me/keys` можно указать `read_only: true` — такой
ключ пропускает только resources и read-tools. Удобно для «посмотреть — не
трогать». На уровне MCP-сервера проверяется перед каждым изменяющим tool-вызовом.

## 7. Карта tool → внутренний вызов

MCP-сервер не дублирует логику REST — он обращается к тому же **доменному слою
ядра** (use-cases). Например, `etn.thoughts.create` внутри вызывает
`thoughtService.create(...)`, который:
- проверяет права через access-control;
- пишет в `data.db`;
- эмитит real-time событие;
- возвращает результат.

REST и MCP — два фасада над одним ядром. Это гарантирует идентичность поведения.

## 8. Пример сценария MCP

**«Агент собирает дайджест по теме»**

1. Агент вызывает `etn.thoughts.search { query: "конкуренты 1С", scope: "all" }`.
2. Получает список мыслей с оценками.
3. Для топ-5 вызывает `etn.thoughts.subgraph { seed_ids: [...], radius: 2,
   include_comments: true }`.
4. Формирует контекст, генерирует Markdown-дайджест в своей LLM.
5. Опционально вызывает `etn.comments.upsert` — создаёт хронологический
   комментарий у корневой мысли с этим дайджестом и `valid_from = сегодня`.
6. Участники сети тут же видят новый комментарий через WebSocket.

## 9. Версионирование и совместимость

- MCP-сервер объявляет `protocolVersion` (по спецификации MCP) и список
  поддерживаемых инструментов/ресурсов в `initialize`.
- Добавление новых tools — обратно совместимо. Удаление/переименование — через
  период сосуществования, чтобы не ломать настроенных агентов.
