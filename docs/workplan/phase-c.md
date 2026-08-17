# Фаза C — Сервер: доменный слой

> [← Workplan (индекс)](../workplan.md) — оглавление, статусы фаз и решения.


> Все задачи C — последовательные (C1 → C2 → …). После завершения C стартуют D,
> E, F параллельно.

## C1. Хранилище `NetworkDb`
- **Статус:** `done` · **Assignee:** agent-C · **Зависимости:** B4
- **Описание:** Открытие/создание `<network_id>/data.db`, WAL, FK ON, lifecycle
  (открытие по требованию, корректное закрытие). Реестр открытых сетей в памяти.
- **DoD:** сеть открывается повторно без ошибок; WAL-файлы создаются.
- **Спецификация:** [02-data-model.md](../02-data-model.md), п. 3.
- **Note:** `server/src/db/network-db.ts` — тонкая обёртка (`prepare`/
  `transaction`/`exec`/`pragma`/`close`) с реестром `Map<networkId, NetworkDb>`;
  `openNetworkDb` создаёт `networks/<id>/{,attachments/,snapshots/}`, ставит
  `journal_mode=WAL`, `foreign_keys=ON`, применяет миграции; `closeNetworkDb`/
  `closeAll` для shutdown; `createInMemoryNetworkDb` для юнит-тестов C3–C6.

## C2. Миграции `data.db`
- **Статус:** `done` · **Assignee:** agent-C · **Зависимости:** C1
- **Описание:** Все таблицы: `thoughts`, `thought_synonyms`, `thought_types`,
  `link_types`, `type_properties`, `property_values`, `links`, `comments`,
  `attachments`, `user_preferences`, `thought_views`, `user_focus_preferences`,
  `user_focus_order`, `embeddings` (зарезервирована). FTS5-таблицы и триггеры
  синхронизации.
- **DoD:** схема накатывается; FTS обновляется триггерами на INSERT/UPDATE/DELETE.
- **Спецификация:** [02-data-model.md](../02-data-model.md), п. 3, 3.11.
- **Note:** 12 идемпотентных файлов `server/migrations/network/001..012`. FTS5
  rowid зеркалирует `thoughts.rowid`/`comments.rowid`, поэтому триггеры точно
  удаляют/обновляют строки. Добавлены дополнительные enforcement-индексы: partial
  UNIQUE `idx_comments_permanent_one` (один permanent на владельца) и
  `idx_property_values_owner`. Связь `property_values.property_id` имеет реальный
  FK `ON DELETE CASCADE`. Для нетипизированных связей (NULL в UNIQUE) дубликат
  дополнительно ловится в приложении (C4).

## C3. Сервис мыслей
- **Статус:** `done` · **Assignee:** agent-C · **Зависимости:** C2
- **Описание:** `create`, `get`, `update` (с `version`/`If-Match`), `delete`
  (защита `is_protected`), `focus` (обновление `thought_views`, возврат соседей с
  учётом `show_inactive` и сортировок пользователя), `neighbors`. Дедупликация на
  уровне приложения НЕ выполняется — её делает UI.
- **DoD:** CRUD работает; соседи возвращаются в нужном порядке; HOME не удалить.
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 6;
  [02-data-model.md](../02-data-model.md).
- **Note:** `server/src/domain/thought-service.ts`. CRUD с `If-Match`
  (`VERSION_CONFLICT` 409), `title_norm` = NFC+trim+lowercase, синхронизация
  синонимов (массив или строка через запятую), опциональная inline parent/child
  связь в той же транзакции. `focus()` пишет `thought_views` и возвращает соседей
  с учётом `show_inactive` и сохранённой `user_focus_preferences` (дефолт
  `created`/`asc` — запись предпочтений добавит C12). `deleteThought` чистит
  полиморфных владельцев без SQL-FK (comments/attachments/property_values).
  Запросы соседей полностью параметризованы; `ORDER BY` строится только из
  enum-валидированных фрагментов. Также добавлен `resolveThoughts` (§6.9).

## C4. Сервис связей
- **Статус:** `done` · **Assignee:** agent-C · **Зависимости:** C3
- **Описание:** `create` (с проверкой `source≠target` и UNIQUE), `update`, `delete`,
  `listByThought` (с группировкой по типам и фильтром `show_inactive`).
- **DoD:** петель нет, дубликатов нет, связи группируются для редактора.
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 7.
- **Note:** `server/src/domain/link-service.ts`. Самопетли → 422, дубликаты → 409
  (проверка NULL-safe через `ifnull`, так что и нетипизированные пары ловятся
  поверх UNIQUE-индекса). `listLinksByThought` одним параметризованным запросом с
  `CASE` выбирает «opponent» thought и группирует в `by_type`/`untyped_parents`/
  `untyped_children` с учётом `show_inactive`.

## C5. Сервис типов мыслей и связей
- **Статус:** `done` · **Assignee:** agent-C · **Зависимости:** C3
- **Описание:** CRUD `thought_types` и `link_types`, включая `description` (для
  AI). Управление свойствами типа (`type_properties`).
- **DoD:** типы создаются, назначаются мыслям; description сохраняется.
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 8.
- **Note:** `thought-type-service.ts` + `link-type-service.ts` (CRUD с unique
  name / unique `(name_forward,name_reverse)`, `If-Match`). Удаление типа в
  использовании → 422 без `force`, с `force` — `type_id` обнуляется у
  мыслей/связей. `description` сохраняется. Определения свойств
  (`type_properties` CRUD + reorder) в `property-service.ts`, owner_type =
  `thought_type`/`link_type`. **Расхождение:** `ThoughtTypeInput.icon_kind` есть
  в shared, но в `thought_types` нет колонки `icon_kind` (§3.3) — игнорируется на
  записи; нужен follow-up shared/docs.

## C6. Сервис значений свойств
- **Статус:** `done` · **Assignee:** agent-C · **Зависимости:** C5
- **Описание:** `get/set/delete property_values` для мыслей и связей. Валидация по
  `value_type` свойства (text/date/number/bool/thought_ref). При `thought_ref` —
  опциональная проверка типа цели.
- **DoD:** значения пишутся в нужный `value_*` столбец; типы соблюдаются.
- **Спецификация:** [02-data-model.md](../02-data-model.md), п. 3.4–3.5;
  [03-server-api.md](../03-server-api.md), п. 9.
- **Note:** значение валидируется по определению свойства на типе владельца и
  пишется **только** в соответствующий `value_*` столбец (на upsert все `value_*`
  сбрасываются в NULL, затем ставится нужный — правило одной колонки держится
  даже при смене `value_type`). Для `thought_ref` опционально проверяется
  `config.allowed_type_id`. Имя колонки для интерполяции — фиксированный литерал
  `value_*`, производный от enum-валидированного `value_type` (не пользовательский
  ввод).

> **Note (C1–C6, agent-C).** Фаза реализована в ветке `task/c1-c6-domain`
> (коммиты `[C1]`…`[C6]`). Финальные проверки на Node 22 LTS: `npm run
> typecheck` (все workspace), `npm run lint`, `npm run format:check`,
> `npm run build:shared`, `npm -w @etn/server run build` — зелёные;
> `npm -w @etn/server test` → 95 pass / 0 fail (добавлены наборы NetworkDb,
> network-migrations, thought-service, link-service, type-services,
> property-service). better-sqlite3 native собран под Node 22 — тесты с
> реальной БД выполняются на месте (не skip). Границы с B-агентом соблюдены:
> не тронуты `http/`, `routes/`, `auth/`, `realtime/`, `cli.ts`, `config.ts`,
> `logger.ts`, `paths.ts`, `system-db.ts`, `migrator.ts`, `network-service.ts`,
> системные миграции. Новых runtime-зависимостей не потребовалось.

## C7. Сервис комментариев
- **Статус:** `done` · **Assignee:** agent-C7 · **Зависимости:** C3
- **Описание:** CRUD `comments`. Инвариант: один `permanent` на владельца. Рендер
  `body_md` → `body_html` (общий markdown-рендерер с поддержкой картинок, таблиц,
  кода, цитат).
- **DoD:**
  - [x] создаётся permanent и chronological; второй permanent — 409; HTML кешируется.
- **Спецификация:** [02-data-model.md](../02-data-model.md), п. 3.8;
  [03-server-api.md](../03-server-api.md), п. 10.
- **Note:** `server/src/domain/comment-service.ts` + безопасный XSS-free
  markdown-рендерер `server/src/domain/markdown.ts` (без зависимостей: input
  HTML-эскейпится до применения правил, URL-ы валидируются по allow-list
  протоколов, `javascript:`/`data:` (кроме изображений) отбрасываются).
  Инвариант «один permanent на владельца» проверяется в приложении до INSERT и
  дублируется partial unique index. Для permanent `valid_from=created_at`,
  `valid_to=NULL`; для chronological `valid_from` по умолчанию = now, `valid_to`
  по умолчанию = NULL (бессрочно) — пустая строка нормализуется в NULL. CRUD с
  `If-Match` (`VERSION_CONFLICT` 409), проверка существования полиморфного
  владельца (404). Тесты: 16 (7 markdown + 9 service).

## C8. Сервис вложений
- **Статус:** `done` · **Assignee:** agent-C7 · **Зависимости:** C3
- **Описание:** CRUD `attachments` для мыслей и связей. На MVP `kind=file` хранит
  только путь (без загрузки). MIME-тип опционален.
- **DoD:**
  - [x] вложения добавляются/удаляются.
- **Спецификация:** [02-data-model.md](../02-data-model.md), п. 3.9;
  [03-server-api.md](../03-server-api.md), п. 11.
- **Note:** `server/src/domain/attachment-service.ts`. Валидация: для `kind=url`
  обязательно `url`, для `kind=file` — `file_path` (422 иначе). Kind неизменяем
  после создания; очистка location-поля текущего kind даёт 422. Полиморфный
  владелец проверяется на существование (404). У таблицы `attachments` нет колонки
  `version` — update без `If-Match` (last-write-wins). Тесты: 9.

## C9. Сервис поиска (FTS5)
- **Статус:** `done` · **Assignee:** agent-C7 · **Зависимости:** C2
- **Описание:** Поиск по четырём группам (имена/тексты/связи/хронология) с
  фильтрами (subtree, scope, типы мыслей/связей, show_inactive). Snippet с
  `<mark>`-подсветкой. Список упоминаний для мысли.
- **DoD:**
  - [x] поиск работает по всем 4 группам; фильтры применяются.
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 12–13;
  [02-data-model.md](../02-data-model.md), п. 3.11.
- **Note:** `server/src/domain/search-service.ts`. FTS5 используется только для
  `MATCH` и `ORDER BY rank`; подсветка `<mark>` делается в JS по `title`/`body_md`
  из JOIN (FTS5 `snippet()` в этой схеме возвращает UNINDEXED payload-колонку
  вместо `text` — особенность сборки, обойдена детерминированным
  highlighter-ом). Фильтр `in=subtree` — recursive CTE с path-циклозащитой
  (inline, без зависимости от C11). `scope` гранулярный (`names|texts|links|
  chronology|all`); legacy-маппинг `thoughts`→`names,texts` — на уровне REST-слоя
  (D1). `findDuplicates` (title/synonym/partial с приоритетом) и `findMentions`
  (MATCH title+synonyms через OR, исключая self). `resolveThoughts`
  реэкспортирован из thought-service. Тесты: 12. **Расхождение/вопрос:** для
  `total_in_group` делается отдельный COUNT-запрос (window-агрегат нельзя со
  `snippet()`, но теперь snippet в JS — можно было бы вернуть к window; оставлено
  2 запроса как более читаемое).

## C10. Создание мыслесети с HOME
- **Статус:** `done` · **Assignee:** agent-C10 · **Зависимости:** C1, B13
- **Описание:** При `POST /networks` — генерация `network_id`, каталог
  `networks/<id>/{,attachments/,snapshots/}`, `data.db` с миграциями, корневая
  мысль HOME (`is_root=1, is_protected=1`), запись в `networks` и
  `network_members(role=owner)`. Удаление сети (админ) — `wal_checkpoint`,
  удаление каталога, `DELETE FROM networks`.
- **DoD:**
  - [x] сеть создаётся с HOME; повторное открытие работает; удаление чистит
    файлы и `_system.db`.
- **Спецификация:** [02-data-model.md](../02-data-model.md), п. 4, 6.
- **Note:** `NetworkServiceImpl` в `server/src/domain/network-service.ts`
  (заменил `StubNetworkService`), подключён в `http/server.ts`. Каталог
  `networks/<id>/{,attachments/,snapshots/}` + data.db с миграциями + HOME в одной
  транзакции, registry+owner в `_system.db` отдельной транзакцией. Удаление:
  WAL checkpoint → close → rm каталога → `DELETE FROM networks` (каскад).
  Тесты: 4 (включая reopen-idempotency).

## C11. Helper обхода графа (защита от зацикливания)
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** C3
- **Описание:** TypeScript helper `traverse(seedIds, { maxDepth, maxNodes,
  direction })` с `Set<id> visited`. Рекурсивные CTE с path-проверкой для SQL-пути.
  Лимиты: `max_depth` (default 20), `max_nodes` (из L1-настройки), query timeout.
- **DoD:**
  - [x] на графе с циклами A→B→C→A не уходит в бесконечность; возвращает
    частичный результат при превышении лимитов (`meta.truncated`).
- **Спецификация:** [11-settings-and-state.md](../11-settings-and-state.md), п. 5.
- **Note:** `server/src/domain/graph-traversal.ts` — BFS с visited-set
  (`traverse`, `subgraph`, `findPath`), bounds из `TRAVERSAL_DEFAULTS` и
  `MCP_DEFAULTS`, `truncated`+`reason`. SQL-path (CTE c path-проверкой) живёт в
  `search-service.ts` (C9). Тесты: цикл, maxNodes-truncation, алмаз, subgraph.

## C12. user_focus_preferences/order и thought_views
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** C3, C4
- **Описание:** Запись/чтение `user_focus_preferences` и `user_focus_order`,
  обновление `thought_views` при фокусе. Алгоритм применения сортировки для зоны
  (manual/alpha/created/viewed × asc/desc).
- **DoD:**
  - [x] при `sort=manual` мысли в зоне идут в заданном порядке; переключение
    sort сохраняется per (user, focus, dir).
- **Спецификация:** [02-data-model.md](../02-data-model.md), п. 3.10;
  [11-settings-and-state.md](../11-settings-and-state.md), п. 3.
- **Note:** запись — `server/src/domain/focus-service.ts` (`setFocusPreferences`
  upsert, `setFocusOrder` полная замена позиций, validation, запрет manual для
  siblings); чтение/применение — в `thought-service.ts` (C3: `readFocusPref`,
  `orderByClause`, `focus`). Тесты: upsert, замена порядка, rejection manual/
  siblings.

## C13. Сервис экспорта
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** C3, C7
- **Описание:** Markdown (синхронно), PDF/HTML (асинхронно через job). По списку
  `thought_ids`: заголовки, постоянный комментарий, хронология, связи. Job-очередь
  (in-memory на MVP).
- **DoD:**
  - [x] Markdown-экспорт работает; PDF/HTML через job отдаёт результат.
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 14.
- **Note:** `server/src/domain/export-service.ts` — markdown синхронно
  (`exportToMarkdown`), html/markdown через in-memory job store (`startExportJob`,
  `getExportJob`, `getExportJobContent`, TTL 10 мин). PDF на MVP **не
  реализован** (422 с подсказкой «HTML + print to PDF») — это осознанное
  отклонение от буквы DoD, зафиксировано; pdf-рендер (puppeteer) — отдельная
  задача в следующем релизе. Тесты: markdown-контент, job lifecycle, pdf-reject.
