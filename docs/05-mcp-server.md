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

## 3. Самоописание сети (Self-Description, O5)

Чтобы агенту не приходилось угадывать «куда и как писать», владелец сети
заполняет четыре markdown-поля в настройках (`networks.description`,
`when_to_use`, `conventions`, `examples`, см. `02-data-model.md` §2.3) и
выбирает **узловой тип раздела** (`node_section_type_id` — тип мысли, чьи
активные экземпляры образуют «структуру» сети).

Поля:

| Поле | Что в нём | Кто читает |
|------|-----------|-----------|
| `description` | Назначение сети в 1–2 абзацах | Человек + агент при выборе сети |
| `when_to_use` | Когда агенту обращаться к сети: список use cases, для каждого — какие поля сети читать | Агент при маршрутизации между сетями |
| `conventions` | Правила записи: формат хронологий, пометка активности, нейминг, ссылки на типы и шаблоны | Агент перед `create` / `update` |
| `examples` | Примеры хороших и плохих записей | Агент при сомнениях по форме |

Конвенция заполнения `when_to_use`: для каждого use case указываются
релевантные поля сети (например, «Кодирование → structure, conventions»).
Агент не читает все поля подряд, а берёт только нужные текущей задаче.

Структура сети: владелец выбирает тип мысли — узловой раздел. Все активные
мысли этого типа становятся узловыми разделами структуры
(`etn.networks.structure` §5.1). Иерархия — обычными parent-child связями.
Тип, указанный в настройках сети, **нельзя удалить**
(`DELETE /networks/{id}/thought-types/{tid}` отклоняется с `VALIDATION_ERROR`),
пока ссылка не снята.

`etn.networks.list` (§5.1) возвращает `description` и `when_to_use` целиком
плюс `has_structure: true|false` — агенту этого достаточно, чтобы решить, в
какую сеть идти. `conventions`/`examples` намеренно не отдаются в списке
(компактность); агент запрашивает `GET /networks/{id}` или ресурс
`etn://networks/{network_id}` когда уже выбрал сеть.

## 4. Ресурсы (Resources)

Ресурсы — данные, которые агент читает по URI (static + templated).

| URI | Описание |
|-----|----------|
| `etn://networks` | Список сетей, доступных пользователю (включая `description`/`when_to_use`/`has_structure`, см. §3) |
| `etn://networks/{network_id}` | Метаданные сети (все 4 markdown-поля + `node_section_type_id`, см. §3) |
| `etn://networks/{network_id}/thoughts/{thought_id}` | Полная мысль: свойства, синонимы, тип, стили + блок `meta` (см. ниже) |
| `etn://networks/{network_id}/thoughts/{thought_id}/neighbors` | Соседи (parents/children/siblings) + каталоги `link_types`/`thought_types` |
| `etn://networks/{network_id}/thoughts/{thought_id}/usage` | «Использование» мысли: кто ссылается на неё через thought_ref-свойства, сгруппировано по свойству |
| `etn://networks/{network_id}/thoughts/{thought_id}/comments` | Комментарии мысли |
| `etn://networks/{network_id}/thoughts/{thought_id}/attachments` | Вложения мысли |
| `etn://networks/{network_id}/links/{link_id}` | Связь с метаданными |
| `etn://networks/{network_id}/thought-types` | Определения типов мыслей |
| `etn://networks/{network_id}/link-types` | Определения типов связей |
| `etn://networks/{network_id}/thought-types/{id}` | Тип и его свойства (включая description — для контекста агента) |

Ресурсы отдаются как JSON (mime `application/json`). Комментарии — как Markdown
(mime `text/markdown`) для прямой передачи агенту.

Блок `meta` в чтении мысли (`etn://…/thoughts/{id}` и `etn.thoughts.get`) —
«сигналы полноты» (task N2): сколько у мысли входящих/исходящих **активных**
связей (`parents_count`/`children_count`), вложений (`attachments_count`),
хронологических записей (`chrono_count`) и **формальных связей** через
`thought_ref`-свойства (`usage_count`, task N3) — агент по ним решает, какие
отдельные ресурсы/инструменты запрашивать. Поле `permanent` — постоянный
комментарий (ровно один на мысль) с обрезкой больших текстов: `body_md` —
первые `COMMENT_PREVIEW_CHARS` (2000) символов, `chars_returned` /
`chars_total` / `truncated` сообщают, обрезан ли текст, `id` — адрес
комментария; `null`, когда постоянного комментария нет. **Полный текст**
обрезанного комментария (и любого другого, по id или по мысли) агент
получает инструментом `etn.comments.get` — превью всегда несёт `id`, по
которому можно запросить целиком.

Значения свойств в чтении мысли отдаются резолвнутыми (task N4):
`thought_ref`-значение — это `{id, title}`, а не голый UUID, — агенту не нужны
отдельные вызовы `etn.thoughts.get` на каждую формальную ссылку; `title:
null` означает висячую ссылку на удалённую мысль. Обратное направление
(кто ссылается на мысль) — инструмент `etn.thoughts.usage` / ресурс
`etn.thought.usage` (task N3).

Описание типов (`thought_types.description`, `link_types.description`) — это и
есть тот самый «комментарий для AI-агентов» из словаря: в нём пользователь
объясняет суть типа и его связей. Ресурс типа возвращает это описание первым
классом.

## 5. Инструменты (Tools)

Все инструменты именуются по схеме `etn.<сущность>.<действие>`.

### Аннотации инструментов (task O7)

В каждой регистрации (`mcp/tools.ts`) инструмент несёт блок `annotations`
спецификации MCP — три хинта, помогающие клиенту принять решение о
разрешениях без ручной настройки:

| Хинт | Смысл | Кому ставим |
|------|-------|-------------|
| `readOnlyHint: true` | Инструмент не меняет состояние сети (нет DB-записей, real-time событий, `audit_log`-строк). Клиент может выдавать доступ без ручного подтверждения | всем read-инструментам §5.1 + `etn.thoughts.find_duplicates` (4.3) + `etn.attachments.search` |
| `destructiveHint: true` | Инструмент удаляет сущности (откатить нельзя) — клиент обязан запросить подтверждение пользователя | `etn.thoughts.delete`, `etn.links.delete`, `etn.comments.delete` |
| `idempotentHint: true` | Повторный вызов с теми же аргументами не даёт дополнительного эффекта (финальное состояние то же) — клиент может безопасно ретраить | `etn.thoughts.set_active`, `etn.properties.set`, `etn.thoughts.upsert_bundle` (upsert-семантика O1) |

Остальные мутирующие инструменты (`create`/`update`/`links.create`,
`comments.upsert`/`update`, `attachments.add`/`copy`) аннотаций не несут:
`readOnlyHint` для них ложен, `destructiveHint`/`idempotentHint` не описаны в
DoD — клиент по умолчанию показывает обычный промпт подтверждения для любого
записывающего вызова. Хинты — **подсказки** (по спеке MCP), а не гарантии;
сервер всегда проверяет права и rate-limit перед самой записью.

Канонический реестр — `MCP_TOOL_ANNOTATIONS` в `@etn/shared` (тип
`McpToolAnnotations`); фронтенд регистрации использует его при создании
объекта `tool` MCP SDK. Агентский клиент (`MCP client.listTools`) получает
блок `annotations` для каждой записи и показывает его в диалоге разрешений.

### 5.1. Поиск и чтение

| Tool | Аннотации | Описание | Параметры |
|------|-----------|----------|-----------|
| `etn.networks.list` | `read-only` | Доступные сети + `description`/`when_to_use`/`has_structure` (см. §3) | — |
| `etn.networks.structure` | `read-only` | Структура сети: активные мысли узлового типа (превью постоянного комментария, свойства, счётчики, каталог типов). Когда `node_section_type_id` не задан — пустой `sections` | `network_id` |
| `etn.thoughts.search` | `read-only` | Полнотекстовый поиск | `network_id`, `query`, `scope?` (`names`/`texts`/`links`/`chronology`/`all`), `in_subtree_of?`, `type_id?`, `limit?` |
| `etn.thoughts.query` | `read-only` | Структурная выборка (список по критериям) | см. §5.1a |
| `etn.thoughts.get` | `read-only` | Полная мысль (+ блок `meta`: счётчики связей/вложений/хроники, превью постоянного комментария; `thought_ref`-значения свойств резолвнуты в `{id, title}`) | `network_id`, `thought_id` |
| `etn.thoughts.neighbors` | `read-only` | Соседи (+ каталоги `link_types`/`thought_types`) | `network_id`, `thought_id`, `dir`, `depth?` (1 = прямые соседи; >1 — обход) |
| `etn.thoughts.subgraph` | `read-only` | Подграф в радиусе N рёбер (+ каталоги `thought_types`/`link_types`) | `network_id`, `seed_ids[]`, `radius`, `max_nodes`, `include_comments?` |
| `etn.thoughts.path` | `read-only` | Путь между двумя мыслями (+ каталог `thought_types`) | `network_id`, `from_id`, `to_id`, `max_depth` |
| `etn.links.get` | `read-only` | Связь | `network_id`, `link_id` |
| `etn.thoughts.mentions` | `read-only` | Где упоминается мысль | `network_id`, `thought_id` |
| `etn.thoughts.usage` | `read-only` | «Использование» мысли (формальные связи): кто ссылается на неё через thought_ref-свойства, сгруппировано по свойству (+ каталог `thought_types`) | `network_id`, `thought_id` |
| `etn.comments.get` | `read-only` | Полный текст одного комментария: по `comment_id` (любой) или по `thought_id` (постоянный). Нужен, когда превью (`meta.permanent`, комментарии `subgraph`) показывает `truncated: true` — id есть в самом превью | `network_id` + ровно одно из `comment_id`/`thought_id` |
| `etn.export.subgraph` | `read-only` | Подграф как Markdown-документ | `network_id`, `seed_ids[]`, `radius`, `format?` (md/html) |
| `etn.types.list` | `read-only` | Оба каталога типов целиком (не только использованные в другом ответе), с иерархией и эффективными свойствами — см. §5.1b | `network_id` |

`etn.networks.structure` — входная точка агента в базу знаний сети (O5).
Возвращает активные мысли `node_section_type_id` с обогащением:

- `permanent` — превью постоянного комментария по правилам N2/N5
  (`chars_returned`/`chars_total`/`truncated` + `comment_id` для полного
  чтения через `etn.comments.get`);
- `properties` — резолвнутые значения свойств (`thought_ref` → `{id,title}`);
- `counters` — `parents_count`, `children_count`, `attachments_count`,
  `usage_count`;
- `thought_types` — каталог типов мыслей, реально использованных в разделах
  (плюс сам `node_section_type_id`).

Когда у сети нет `node_section_type_id`, ответ — `{ has_structure: false,
sections: [] }`: агенту остаётся `etn.thoughts.search` / `etn.thoughts.query`.

`etn.thoughts.subgraph` — ключевой для RAG-сценариев: агент задаёт радиус
обхода, лимит узлов, и получает JSON-граф с мыслями, связями и (опционально)
комментариями — готовый контекст для генерации.

С `include_comments: true` комментарии отдаются **превью** (task N5), чтобы
большой подграф не раздувал контекст: для каждого узла — `permanent`
(обрезка до `COMMENT_PREVIEW_CHARS`, как в `meta`) и `chronological` —
последние `CHRONO_PREVIEW_MAX_ENTRIES` (10) записей по `valid_from` DESC,
каждая с телом не длиннее `COMMENT_PREVIEW_CHARS` и метаданными
`chars_returned`/`chars_total`/`truncated`; уровень списка несёт
`total`/`returned`/`truncated` — агент видит, что записей больше. Каждое
превью несёт `id` комментария: полный текст конкретной записи — через
`etn.comments.get`, все комментарии мысли целиком — ресурсом
`etn://…/comments`.

L20: `etn.comments.get` дополнительно возвращает `targets` — все привязки
комментария (`{ owner_type, owner_id }`), включая вторичные (см.
03-server-api.md §10.1).

O3: `etn.comments.upsert` принимает опциональный параметр `targets[]`
(`{owner_type, owner_id}`, 1..100, дубли схлопываются) — альтернатива
одиночным `owner_type`+`owner_id` для `kind: 'chronological'`: первый элемент
становится первичным владельцем, остальные — вторичными привязками
(`comment_targets`, та же доменная функция, что и REST-путь §10.1). Ровно
одна из двух форм обязательна; `permanent`-комментарий по-прежнему допускает
только одиночную форму (у него ровно один владелец). Точечное
привязывание/отвязывание одного дополнительного владельца к уже созданной
записи (`POST/DELETE …/comments/{id}/targets`) остаётся только в REST/клиенте.

#### Каталоги типов в ответах (task N6)

Read-инструменты, возвращающие списки мыслей/связей, несут `type_id` /
`link_type_id` как **ключи** в сопроводительных справочниках — «reference
tables» (только реально использованные в ответе типы, а не весь каталог
сети), чтобы агент не делал дополнительные запросы и не получал повторяющийся
текст в каждой записи:

- `thought_types`: `{ [type_id]: {id, name, parent_id, is_root, description,
  icon} }` — в ответах `etn.thoughts.subgraph` (по узлам),
  `etn.thoughts.neighbors`, `etn.thoughts.query` (по хитам),
  `etn.thoughts.path` (по пути) и `etn.thoughts.usage` (по использующим
  мыслям);
- `link_types`: `{ [link_type_id]: {id, name_forward, name_reverse, parent_id,
  is_root, description, color, style} }` — в `etn.thoughts.subgraph` (по
  рёбрам) и `etn.thoughts.neighbors` (по связям соседей).

`parent_id`/`is_root` (L21) описывают иерархию типов: `is_root: true` — корневой
тип «основной тип» (не назначается мыслям/связям; его настройки применяются к
элементам без типа), остальные наследуют свойства/стиль от `parent_id`. Отбор
по `type_id` (например, в `etn.thoughts.query`) соответствует типу **и всем его
подчинённым** (OR).

`description` — тот самый «комментарий для AI» из определения типа (см. §3):
роль типа и требования по нему; для связи даны оба имени — агент выбирает по
направлению ребра (source → target = `name_forward`). Неизвестные/удалённые
типы пропускаются (`type_id` без SQL FK). Формат у инструмента и парного
ресурса (`etn://…/neighbors`) одинаковый.

#### 5.1a. `etn.thoughts.query` — структурная выборка

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
reason, thought_types }`. `depth` — расстояние от `in_subtree_of` (0 — сам
корень; `null`, если корень не задан). `thought_types` — каталог типов,
встретившихся в хитах (см. «Каталоги типов в ответах»). Обход ограничен
`max_nodes_per_subgraph` — при превышении `truncated: true, reason:
"max_nodes"`, и лишние узлы в выборку не попадают.

Пример — все ошибки в поддереве проекта за один вызов:

```json
{
  "network_id": "<net>",
  "in_subtree_of": "<id проекта>",
  "type_id": ["<id типа «ошибка»>"]
}
```

#### 5.1b. `etn.types.list` — каталог типов с эффективными свойствами (task O4, O16)

В отличие от reference-таблиц N6 (только типы, реально встретившиеся в
ответе), `etn.types.list` отдаёт **оба каталога целиком**: все типы мыслей и
все типы связей сети, включая корневой тип. У каждой записи, помимо полей
N6-каталога (`id`, `name`/`name_forward`+`name_reverse`, `parent_id`,
`is_root`, `description`, ...), — `properties[]`: **эффективный** список
определений свойств типа (L21, docs/03-server-api.md §8.2) — собственные плюс
унаследованные от предков по цепочке, от корня вниз; у каждого элемента —
`key`, `value_type`, `required`, `config` (в т.ч. `options`/
`allowed_type_ids`/`default_value`), `inherited`, `defined_on`,
`defined_on_name`, эффективный `default_value` (переопределение типа или
собственный дефолт свойства), `overridden_here`.

Параметры:

- `network_id` — обязательный.
- `in_subtree_of` *(task O16, опц.)* — `thought_id`. Когда задан, ответ
  ограничивается только теми `thought_types`/`link_types`, чьи id
  присутствуют в **поддереве** мысли (children по `source→target`,
  `UNION`-дедупликация против циклов, лимит — `TRAVERSAL_DEFAULTS.MAX_DEPTH`,
  переопределяется `max_depth`). У каждой записи появляется `usage_count` —
  сколько мыслей этого типа в поддереве для `thought_types`, и сколько
  активных связей этого типа (оба конца — в поддереве) для `link_types`.
  Неактивные мысли и связи пропускаются, как и в `etn.thoughts.search`.
- `max_depth` *(опц.)* — переопределение лимита глубины обхода
  (1..`TRAVERSAL_DEFAULTS.MAX_DEPTH`).

Когда `in_subtree_of` задан, ответ несёт блок `scope` с эхом параметров и
счётчиками (`thought_types_total`, `link_types_total`). При несуществующем
`thought_id` — `NOT_FOUND`. При пустом поддереве (нет детей) ответ —
пустые `thought_types` / `link_types`, `scope` присутствует. Агент не
загружает «всё подряд»: добавил/удалил мысль — выборка меняется сама, ручной
поддержки нет.

Типичный сценарий (cookbook в `docs/mcp-clients.md` §8.2): после
`etn.networks.structure` агент получает список разделов сети; для
конкретного раздела вызывает
`etn.types.list { network_id, in_subtree_of: <section.id> }` — и видит
только типы, реально используемые в этом разделе, с числом использований.

##### Тип по имени вместо `type_id` (task O4)

##### Тип по имени вместо `type_id` (task O4)

`etn.thoughts.create`, `etn.links.create` и `etn.thoughts.upsert_bundle`
(§5.2, §5.2a) принимают параметр `type` (строка) как альтернативу `type_id` —
ровно одно из двух, иначе `VALIDATION_ERROR`. Резолв — по `name_key`
(case-insensitive, та же нормализация, что и при проверке дублей имени типа);
для связей — по `name_forward` **или** `name_reverse`. Ошибки: имя не найдено
— `NOT_FOUND`; имя соответствует нескольким типам — `VALIDATION_ERROR` с
`details.candidates` (для мыслей на практике недостижимо — `name_key`
глобально уникален; для связей возможно по-настоящему: `name_forward` одного
типа может совпасть с `name_reverse` другого, поскольку уникальна только
**пара** имён).

### 5.2. Создание и изменение

| Tool | Аннотации | Описание | Параметры |
|------|-----------|----------|-----------|
| `etn.thoughts.create` | — | Создать мысль; тип — `type_id` или `type` (по имени, task O4, см. §5.1b) | `network_id`, `title`, `synonyms?`, `type_id?`\|`type?`, `active?`, `link?` `{direction, target_thought_id, type_id?\|type?}` |
| `etn.thoughts.update` | — | Изменить мысль | `network_id`, `thought_id`, `changes`, `expected_version?` |
| `etn.thoughts.delete` | `destructive` | Удалить | `network_id`, `thought_id`, `expected_version?` |
| `etn.links.create` | — | Создать связь; тип — `type_id` или `type` (по `name_forward`/`name_reverse`, task O4, см. §5.1b) | `network_id`, `source_id`, `target_id`, `type_id?`\|`type?` |
| `etn.links.delete` | `destructive` | Удалить связь | `network_id`, `link_id` |
| `etn.comments.upsert` | — | Создать/обновить комментарий; для `chronological` — ровно одно из `owner_type`+`owner_id` (одна привязка) или `targets[]` (несколько, 1..100, первый — первичный владелец; для `permanent` только одиночная форма) | `network_id`, `owner_type`+`owner_id` \| `targets[]` (`{owner_type, owner_id}`), `kind`, `title?`, `body_md`, `valid_from?`, `valid_to?` |
| `etn.comments.update` | — | Изменить комментарий по `comment_id` (chronological или permanent; last-write-wins по полям, `valid_from`/`valid_to` применяются только к chronological) | `network_id`, `comment_id`, `changes` (`title?`, `body_md?`, `valid_from?`, `valid_to?`), `expected_version?` |
| `etn.comments.delete` | `destructive` | Удалить комментарий (вместе со всеми привязками к владельцам) | `network_id`, `comment_id`, `expected_version?` |
| `etn.attachments.add` | — | Добавить вложение | `network_id`, `owner_type`, `owner_id`, `kind`, `url?`/`file_path?`, `title?`, `description?` |
| `etn.attachments.copy` | — | Скопировать вложение в одну или несколько мыслей (workplan L25) | `network_id`, `attachment_id`, `target_owner_type: "thought"`, `target_owner_ids[]` |
| `etn.attachments.search` | `read-only` | Поиск вложений сети (workplan L25) | `network_id`, `q`, `exclude_owner_type?`, `exclude_owner_id?`, `kind?`, `limit?`, `offset?` |

`etn.attachments.copy` возвращает массив `McpMutationResult` — по одному на
каждую созданную строку; цели с уже имеющимся вложением того же kind и того же
url/file_path пропускаются без ошибки и без записи в массив (как и в
`POST /attachments/{id}/copy`, 03-server-api.md §11).

`etn.attachments.search` — read-инструмент: `q` обязателен (без него пустой
массив), синтаксис как в §12 поиска мыслей (include-AND, `-word` исключение);
возвращает массив `Attachment[]`.
| `etn.properties.set` | `idempotent` | Установить свойство: одно (`key`+`value`) или набор (`values: {key: value\|null}` одной транзакцией) | `network_id`, `owner_type`, `owner_id` + ровно одно из `key`+`value` / `values` |
| `etn.thoughts.set_active` | `idempotent` | Изменить актуальность | `network_id`, `thought_id`, `active` |
| `etn.thoughts.upsert_bundle` | `idempotent` | Составная запись «единицы знания» одной транзакцией | см. §5.2a |

Все изменяющие инструменты:
- принимают опциональный `expected_version` для optimistic concurrency
  (если не передан — last-write-wins без проверки);
- возвращают `{ id, version, request_id }`;
- порождают стандартные real-time события (см. [04-realtime.md](04-realtime.md)).

#### 5.2b. `warnings` — «карточка неполная» (задача O6)

Тип мысли может объявлять `required`-свойства в `type_properties` (02-data-model.md
§3.4). Когда `etn.thoughts.create`, `etn.thoughts.update` (с `changes.type_id`) или
`etn.thoughts.upsert_bundle` создают/дополняют мысль и карточка получается неполной
(некоторые `required`-свойства остались без значений), в ответе появляется
неломающий блок `warnings: ThoughtCardWarning[]`:

```jsonc
{
  "code": "REQUIRED_PROPERTY_MISSING",
  "key": "status",                  // property key — адресуем в properties.set
  "property_id": "<uuid>",          // type_properties.id
  "defined_on": "<type-uuid>",      // тип, на котором объявлено свойство
  "value_type": "text",             // ожидаемый тип значения
  "inherited": false                // true для свойств, пришедших от предка по L21
}
```

Правила:

- Проверка идёт по эффективному списку свойств типа (L21, свои + унаследованные)
  против живой таблицы `property_values`. Дефолты (`config.default_value` /
  `type_property_overrides.default_value`) **не** маскируют warning — они применяются
  к будущим значениям, а в `property_values` на момент проверки записи нет.
- `warnings` появляется только когда есть расхождения. Для `etn.thoughts.upsert_bundle`
  поле присутствует **всегда** (включая пустой массив `[]`) — форма стабильна,
  агенту удобно парсить.
- `updateThought` возвращает `warnings` **только** при смене `type_id` — это единственное
  поле в `changes`, после которого может вырасти новый список обязательств
  (переименование/рестайлинг/`active` контракт свойств не меняют).
- Мысль без типа → `warnings` отсутствует; корневой тип специально не объявляет
  `required`-свойств (его настройки применяются к безтиповым мыслям, 08-ui-spec.md §8.1).

REST-контракт не меняется (тип `warnings` опционален на уровне MCP-фасада); UI/клиент
получает то же, что и раньше. Агент узнаёт о неполной карточке из ответа `create` /
`update` / `upsert_bundle` и дозаполняет её одним `etn.properties.set` (или новым
`upsert_bundle`, который сразу принесёт свойства).

`etn.properties.set` (task O2) принимает либо одиночную форму `key` + `value`
(обратная совместимость; `value: null` — очистка значения), либо карту
`values: {key: value|null}` — набор свойств пишется **одной транзакцией**:
ошибка валидации любого ключа откатывает весь набор. Ответ одиночной формы —
`{ id, version: 0, request_id }`; формы `values` — `{ values: {key: {id}},
version: 0, request_id }`. Набор стоит одной записи для rate-limit (§6.2),
событие `property-value.set` эмитится по одному на каждое значение.

> **Live-рассылка зависит от транспорта.** В HTTP-режиме (`ETN_MCP_ENABLED=1`,
> `/mcp`) события публикуются в тот же внутрипроцессный брокер, что и REST —
> подключённые клиенты получают их сразу. В stdio-режиме (`etn mcp` —
> отдельный процесс) событие пишется в общий `event_log`; сервер подхватывает
> его event-log relay'ем с задержкой до 300 мс (см. [04-realtime.md](04-realtime.md)
> §5.1), при недоступном сервере клиенты догонят запись через `resume` при
> переподключении.

#### 5.2a. `etn.thoughts.upsert_bundle` — составная запись «единицы знания» (task O1)

Создание одной осмысленной мысли обычным путём требует 5–8 последовательных
вызовов (`thoughts.create` → `comments.upsert` → `properties.set` × N →
`links.create` × M → `attachments.add`), и каждый промежуточный шаг неатомарен
— упавший агент оставляет мысль без свойств и связей. `upsert_bundle` пишет
мысль + постоянный (`permanent`) комментарий + карту свойств + связи +
вложения **одной SQL-транзакцией**: любая ошибка на любом шаге (несуществующий
`target_thought_id`, дублирующая связь, невалидное значение свойства, …)
откатывает весь вызов целиком — в базе не остаётся ни новой мысли, ни частично
применённых свойств.

| Параметр | Тип | Смысл |
|----------|-----|-------|
| `network_id` | string | обязателен |
| `thought_id` | string | адресует **существующую** мысль для дополнения на месте (без пересоздания). Обязателен ровно один из `thought_id`/`thought` |
| `thought` | object | `{title, synonyms?, type_id?\|type?, active?}` — спецификация новой/сопоставляемой мысли; `type` резолвит тип по имени (task O4, см. §5.1b), ровно одно из `type_id`/`type` |
| `on_duplicate` | `fail`\|`reuse`\|`update` | политика при совпадении `thought.title`/`synonyms` с существующей мыслью (см. ниже); по умолчанию `fail`. Игнорируется, если задан `thought_id` |
| `comment` | object | `{title?, body_md, valid_from?, valid_to?}` — постоянный комментарий владельца (create-or-update, как `etn.comments.upsert` с `kind: 'permanent'`) |
| `properties` | object | карта `{key: value}` — по одному вызову `properties.set` на ключ, в общей транзакции |
| `links` | array | `[{direction, target_thought_id, type_id?\|type?}]` — связи мысли-владельца с другими мыслями (направление — как у `link` в `etn.thoughts.create`); `type` резолвит тип связи по имени (task O4), ровно одно из `type_id`/`type` на каждую связь |
| `attachments` | array | `[{kind, url?/file_path?, title?, description?}]` |

Если `thought_id` не задан, мысль ищется/создаётся так же, как в паре
`find_duplicates` → `create`, но без гонки между вызовами: сервер сам вызывает
`find_duplicates(thought.title, thought.synonyms)` внутри транзакции.
- Совпадений нет — мысль создаётся (`thought_action: "created"`).
- Есть совпадение — по `on_duplicate`:
  - `fail` (по умолчанию) — ошибка `DUPLICATE` с `details.candidates` (тот же
    формат, что у `etn.thoughts.find_duplicates`); ничего не записывается;
  - `reuse` — берётся лучший (`find_duplicates`-приоритет: точный
    title > synonym > partial) кандидат как есть, `comment`/`properties`/
    `links`/`attachments` дополняют его (`thought_action: "reused"`);
  - `update` — лучший кандидат ещё и патчится полями `thought`
    (`thought_action: "updated"`).

Ответ: `{ id, version, thought_action: "created"|"updated"|"reused", matched_on:
"title"|"synonym"|"partial"|null, comment?: {id, version}, properties?: {[key]:
{id}}, links?: [{id, version}], attachments?: [{id}], warnings: ThoughtCardWarning[],
request_id }`.
`matched_on` — чем совпал кандидат, приведший к `reused`/`updated`; `null` для
свежесозданной или явно адресованной (`thought_id`) мысли. `warnings` — массив
`REQUIRED_PROPERTY_MISSING` по эффективному списку свойств типа (см. §5.2b), всегда
присутствует (пустой, когда карточка полная).

Real-time и `audit_log`: событие своего типа на каждую фактически
изменённую/созданную сущность (`thought.created`/`thought.updated` — не
эмитится при `reused`, `comment.created`/`comment.updated`,
`property-value.set` × N, `link.created` × M, `attachment.created` × K), но
**один** вызов `requireWriteBudget`/одна запись `audit_log` на весь bundle —
для лимита `max_writes_per_minute` (§6.2) bundle всегда стоит как одна запись,
сколько бы сущностей он ни затронул.

### 5.3. Дедупликация (важна для агентов)

| Tool | Аннотации | Описание | Параметры |
|------|-----------|----------|-----------|
| `etn.thoughts.find_duplicates` | `read-only` | Поиск существующих по имени/синонимам | `network_id`, `title`, `synonyms?` |

Возвращает матчи с оценкой совпадения (точное/по синониму/частичное). Агент
должен вызывать это **перед** `etn.thoughts.create`, чтобы не плодить дубликаты
(как и человек через диалог добавления). Синонимы с подстановками `*`
(02-data-model.md §3.2) учитываются: у мысли с синонимом `Игорян*` ввод
`Игорянский` даст совпадение по синониму.

## 6. Prompts (шаблоны запросов)

Заранее определённые шаблоны для типовых задач агента:

| Prompt | Назначение |
|--------|------------|
| `etn.summarize_thought` | Краткое резюме мысли и её контекста |
| `etn.suggest_links` | Предложить возможные связи для мысли на основе текстов соседей |
| `etn.detect_duplicates` | Найти кандидаты на слияние в поддереве |
| `etn.generate_report` | Собрать Markdown-документ по подграфу на заданную тему |

Шаблоны параметризуются (например, `network_id`, `thought_id`), возвращают
текстовый промпт, который агент передаёт своей LLM.

## 7. Контроль операций агента

### 6.1. Журналирование
Каждый изменяющий tool-вызов пишется в `audit_log` с `category = 'data'`,
`action` — соответствует типу операции, в `details` — параметры вызова.

### 6.2. Лимиты (опционально на MVP)
- `max_nodes_per_subgraph` (например, 500) — защита от того, что агент вытянет
  всю сеть.
- `max_writes_per_minute` на пользователя — защита от runaway-агента.
Лимиты настраиваются в `_system.db` (`settings`), на MVP — фиксированные дефолты.

**Per-key переопределение (task O8).** API-ключ может нести собственный
`max_writes_per_minute` (`api_keys.max_writes_per_minute`; `NULL` — серверный
дефолт `mcp.max_writes_per_minute`). Задаётся при создании ключа (`POST
/me/keys`, `POST /admin/users/{id}/keys`) и меняется админом/владельцем через
`PATCH …/keys/{id}` (06-auth.md §6.2a–6.2b). MCP-слой резолвит эффективный
лимит на ключ при открытии сессии; bundle-вызов `etn.thoughts.upsert_bundle`
(O1) считается одной записью для этого лимита.

### 6.3. Режим read-only для ключа
При создании API-key через `/me/keys` можно указать `read_only: true` — такой
ключ пропускает только resources и read-tools. Удобно для «посмотреть — не
трогать». На уровне MCP-сервера проверяется перед каждым изменяющим tool-вызовом.

## 8. Карта tool → внутренний вызов

MCP-сервер не дублирует логику REST — он обращается к тому же **доменному слою
ядра** (use-cases). Например, `etn.thoughts.create` внутри вызывает
`thoughtService.create(...)`, который:
- проверяет права через access-control;
- пишет в `data.db`;
- эмитит real-time событие;
- возвращает результат.

REST и MCP — два фасада над одним ядром. Это гарантирует идентичность поведения.

## 9. Пример сценария MCP

**«Агент собирает дайджест по теме»**

1. Агент вызывает `etn.thoughts.search { query: "конкуренты 1С", scope: "all" }`.
2. Получает список мыслей с оценками.
3. Для топ-5 вызывает `etn.thoughts.subgraph { seed_ids: [...], radius: 2,
   include_comments: true }`.
4. Формирует контекст, генерирует Markdown-дайджест в своей LLM.
5. Опционально вызывает `etn.comments.upsert` — создаёт хронологический
   комментарий у корневой мысли с этим дайджестом и `valid_from = сегодня`.
6. Участники сети тут же видят новый комментарий через WebSocket.

## 10. Версионирование и совместимость

- MCP-сервер объявляет `protocolVersion` (по спецификации MCP) и список
  поддерживаемых инструментов/ресурсов в `initialize`.
- Добавление новых tools — обратно совместимо. Удаление/переименование — через
  период сосуществования, чтобы не ломать настроенных агентов.
