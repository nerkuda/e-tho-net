# Фаза D — Сервер: REST API (полный)

> [← Workplan (индекс)](../workplan.md) — оглавление, статусы фаз и решения.


> После C. Задачи D1–D8 можно вести параллельно между собой.

## D1. Routes /thoughts
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** C3, C12
- **Описание:** Все эндпоинты раздела 6: CRUD, focus, neighbors, search, batch,
  resolve, focus-preferences, focus-order.
- **DoD:**
  - [x] end-to-end CRUD через HTTP работает, статусы ошибок соответствуют
    спецификации.
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 6.
- **Note:** `server/src/routes/thoughts.ts` (`createThoughtsRoutes`). Поиск и
  дедупликация (§12, D7) — в отдельных задачах. В `thought-service.getNeighbors`
  добавлен фильтр `type_id` (§6.7), в `link-service` — `findLinksBetween`
  (для batch `unlink_from_focus`). Общий хелпер парсинга тела/If-Match —
  `server/src/routes/helpers.ts`.

## D2. Routes /links
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** C4
- **Описание:** CRUD связей + `GET /thoughts/{id}/links` (с группировкой).
- **DoD:**
  - [x] CRUD связей работает через HTTP; группировка для редактора отдаётся.
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 7.
- **Note:** `server/src/routes/links.ts` (`createLinksRoutes`).

## D3. Routes типов и свойств
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** C5
- **Описание:** Эндпоинты для `thought-types`, `link-types` и их свойств.
- **DoD:**
  - [x] CRUD типов и их свойств работает через HTTP; force-delete работает.
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 8.
- **Note:** `server/src/routes/types.ts` (`createTypesRoutes`). Reorder свойств —
  `PUT …/types/:id/properties/reorder { ordered_ids }` (в спецификации §8 путь
  не зафиксирован — выбрано явное имя).

## D4. Routes /properties
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** C6
- **Описание:** Чтение/запись/удаление значений свойств на мыслях и связях.
- **DoD:**
  - [x] upsert по ключу работает, удаление по ключу работает; ошибки валидации
    соответствуют спецификации.
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 9.
- **Note:** `server/src/routes/properties.ts` (`createPropertiesRoutes`).

## D5. Routes /comments, /attachments
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** C7, C8
- **DoD:**
  - [x] CRUD комментариев и вложений работает через HTTP для обоих типов
    владельцев (thought/link).
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 10–11.
- **Note:** `server/src/routes/comments.ts`, `server/src/routes/attachments.ts`.

## D6. Routes /export и /jobs
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** C13
- **DoD:**
  - [x] экспорт запускается (202 + job_id), статус и скачивание результата
    работают; поиск с фильтрами работает.
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 14.
- **Note:** `server/src/routes/search.ts` (`createSearchRoutes`) — поиск §12,
  экспорт §14 и /jobs. Legacy-маппинг `scope=thoughts`→`names,texts` — здесь.
  В `export-service` у job хранится `format` (для MIME-типа скачивания).

## D7. Маршруты admin: сети и аудит
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** B14
- **Описание:** `GET /admin/networks`, `DELETE /admin/networks/{id}`,
  `PATCH /admin/networks/{id}/members`, `GET /admin/audit`.
- **DoD:**
  - [x] admin управляет любой сетью; `network.deleted` эмитится до удаления
    registry-строки (FK event_log).
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 4.2, 15.
- **Note:** `routes/admin-networks.ts` + `SystemDb.listAllNetworks()`.
  `GET /admin/audit` уже был (B14). Эмиссия realtime событий во все
  D-маршруты (E3-wiring) сделана оркестратором коммитом `8ad36fd`:
  thought/link/type/property/comment/attachment.*, thought-view.updated,
  user-focus-* (audience=user).

## D8. Интеграционные тесты REST
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** D1–D7
- **Описание:** Сквозные HTTP-тесты на ключевые сценарии (создание сети, добавление
  мыслей с дедупликацией через UI-диалог на уровне API, конфликты версий,
  роли/доступ).
- **DoD:**
  - [x] все тесты зелёные; покрытие критичных путей.
- **Спецификация:** [09-scenarios.md](../09-scenarios.md).
- **Note:** `server/tests/routes-thoughts.test.ts`, `routes-links.test.ts`,
  `routes-comments-attachments.test.ts`, `routes-search-export.test.ts` +
  общий хелпер `server/tests/rest-helpers.ts` (реальная сеть через
  `POST /networks`, контекст с HOME). Дедупликация диалога покрыта через
  `GET /thoughts/duplicates` (см. Note в D1).
