# Workplan — ETN MVP

План работ по реализации MVP системы ETN. Авторитетный источник для
агентов-разработчиков: здесь они берут задачи, отмечают выполнение и сверяются с
зависимостями. Технические спецификации — в соседних документах `docs/`; план
**не** дублирует их, а ссылается.

## 1. Принципы работы с планом

### 1.1. Жизненный цикл задачи

Каждая задача имеет статус:

| Статус | Значение |
|--------|----------|
| `todo` | Не начата; можно брать, если все зависимости `done`. |
| `in_progress` | Взята в работу; обязательно поле `Assignee`. |
| `done` | Завершена; все пункты DoD выполнены, тесты проходят, commit в репозитории. |
| `blocked` | Не может быть взята по внешней причине (указать в `Note`). |

Поток:

1. Агент выбирает задачу со статусом `todo`, у которой **все** зависимости имеют
   статус `done`.
2. Меняет статус на `in_progress`, заполняет `Assignee` (свой идентификатор).
3. Знакомится со спецификацией (ссылка в задании) и существующим кодом.
4. Реализует, пишет тесты.
5. Убеждается: `npm run typecheck` и `npm test` проходят, новые пункты DoD
   отмечены.
6. Делает коммит с сообщением вида `[<TASK_ID>] краткое описание`.
7. Меняет статус на `done`.

### 1.2. Соглашения

- **Один агент — одна задача в работе одновременно.**
- Коммит-сообщение начинается с ID задачи: `[B7] feat(server): Fastify bootstrap`.
- Все спецификации в `docs/` — **авторитетный источник**. Если при реализации
  обнаружено противоречие — остановиться, поднять вопрос, не молча править код
  или спецификацию.
- Запрещено ломать уже `done` задачи. Если изменение требует правки в чужой
  области — согласовать с тем, кто её делал (или через issue).
- Если задача оказалась больше, чем казалось — разбить на подзадачи в коммите и
  обновить этот план.
- Любые артефактные данные (`*.db`, `etn_data/`, `.env`) **не** коммитятся.

### 1.3. Общие критерии готовности (DoD) для любой задачи

- Код на TypeScript, проходит `npm run typecheck` для затронутых workspace.
- `npm test` для затронутых workspace проходит.
- Публичные API покрыты TSDoc.
- Спецификация, на которую ссылается задача, соблюдена.
- Коммит содержит ID задачи.

## 2. Граф зависимостей между фазами

```
                       A (подготовка монорепо)
                       │
            ┌──────────┴───────────────┐
            ▼                          ▼
   B (сервер: фундамент)        G (клиент: каркас)
            │                          │
            ▼                          │
   C (сервер: домен)                   │
            │                          │
   ┌────────┼────────┐                 │
   ▼        ▼        ▼                 │
   D        E        F                 │
 (REST)   (WS)    (MCP)                │
            │                          │
            └─────────────┬────────────┘
                          ▼
                    H (клиент: UI)
                          │
                          ▼
                    I (интеграция, тесты)
                          │
                   ┌──────┴──────┐
                   ▼             ▼
                   J          K
           (документы)  (упаковка, релиз)
```

**Последовательные:** A → B → C; D/E/F стартуют после C (но между собой
параллельны); H стартует после G и минимально готового D+E; I после всего; J/K в
конце.

**Параллельные:** G можно вести параллельно с B–F; D, E, F можно вести
параллельно после C; внутри H многие задачи параллельны (см. разд. 4).

## 3. Фаза A — Подготовка монорепо

> Все задачи фазы A — последовательные (каждая опирается на предыдущую).
> Стартовая точка проекта.

### A1. Нормализация переносов строк и git attributes
- **Статус:** `done` · **Assignee:** agent-A · **Зависимости:** —
- **Описание:** Создать `.gitattributes` (`* text=auto eol=lf` для согласованности
  CRLF/LF на Windows/Linux). Убедиться, что `.gitignore` корректно исключает
  runtime-данные.
- **DoD:**
  - [x] Создан `.gitattributes`.
  - [x] `git status` чист, нет неожиданных modified-файлов из-за CRLF.
- **Спецификация:** —.

### A2. Настройка ESLint и Prettier
- **Статус:** `done` · **Assignee:** agent-A · **Зависимости:** A1
- **Описание:** В корне — `eslint.config.js` (flat config, ESLint 9),
  `.prettierrc`, скрипты `lint`/`format`. Общие правила TypeScript.
- **DoD:**
  - [x] `npm run lint` работает из корня, проверяет все workspace.
  - [x] `npm run format` приводит код к единому стилю.
- **Note:** оркестратор дополнил конфиг отключением `no-require-imports` для
  root CommonJS-файлов и добавил `docs/`/`*.md` в `.prettierignore`.
- **Спецификация:** —.

### A3. CI (GitHub Actions)
- **Статус:** `done` · **Assignee:** agent-A · **Зависимости:** A2
- **Описание:** `.github/workflows/ci.yml` — на push/PR: install, typecheck, lint,
  build, test. Кеширование `node_modules` и `~/.npm`.
- **DoD:**
  - [x] На push в main/PR пайплайн запускается.
  - [ ] Шаги typecheck, lint, build, test — все зелёные (проверится на первом
    реальном пуше; локально все шаги проходят).
- **Note:** `cache: 'npm'` требует `package-lock.json` в репо — закоммичен.
- **Спецификация:** —.

### A4. shared/: базовые типы
- **Статус:** `done` · **Assignee:** agent-A4 · **Зависимости:** A1
- **Описание:** В `shared/src/` описать общие типы: DTO для REST-запросов/ответов,
  типы real-time событий, перечисления (роли, типы свойств, аудит-категории),
  константы (имена настроек, лимиты по умолчанию). Без логики — только типы и
  константы.
- **DoD:**
  - [x] `npm run build:shared` проходит.
  - [x] `@etn/shared` импортируется из server и client.
  - **Note:** типы/константы/ошибки готовы; package.json (`main`/`types`) и
    project references в server/client уже настроены. Финальную проверку
    `npm run build:shared` + `npm run typecheck` выполняет оркестратор
    (в рамках A4 `npm install`/`typecheck` агентом не запускались). Фактический
    код импорта появится в задачах B1/G1 вместе с первым кодом server/client.
- **Спецификация:** [02-data-model.md](02-data-model.md),
  [03-server-api.md](03-server-api.md), [04-realtime.md](04-realtime.md),
  [11-settings-and-state.md](11-settings-and-state.md).

## 4. Фаза B — Сервер: фундамент

> Все задачи B — последовательные (B1 → B2 → … → B14). Это критический путь.

### B1. Конфигурация и логирование
- **Статус:** `done` · **Assignee:** agent-B · **Зависимости:** A4
- **Описание:** Чтение env (`ETN_DATA_DIR`, `ETN_HOST`, `ETN_PORT`, TLS, лог),
  валидация, structured logging (pino). Утилита путей к `_system.db` и
  `networks/<id>/`.
- **DoD:** env читается, некорректная конфигурация → понятная ошибка при старте.
- **Спецификация:** [01-architecture.md](01-architecture.md), п. 4.

### B2. Мигратор SQL
- **Статус:** `done` · **Assignee:** agent-B · **Зависимости:** B1
- **Описание:** Механизм миграций: применяет файлы из `migrations/system/*.sql` и
  `migrations/network/*.sql`, хранит историю в таблице `_migrations` каждой БД.
  Транзакционность, идемпотентность в контрольной точке (`CREATE IF NOT EXISTS`).
- **DoD:** пустая БД → корректно накатывается до актуальной схемы; повторный
  запуск не падает.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 5.

### B3. Миграции `_system.db`
- **Статус:** `done` · **Assignee:** agent-B · **Зависимости:** B2
- **Описание:** SQL-файлы для всех таблиц системной БД: `users`, `api_keys`,
  `networks`, `network_members`, `user_preferences`, `audit_log`,
  `client_request_cache`, `settings`, `event_log`, `network_seq`. Индексы и
  инварианты.
- **DoD:** после миграций схема соответствует спецификации.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 2.

### B4. Хранилище `SystemDb`
- **Статус:** `done` · **Assignee:** agent-B · **Зависимости:** B3
- **Описание:** Класс-обёртка над `better-sqlite3` для `_system.db`: WAL, FK ON,
  prepared statements, транзакции (через `db.transaction`).
- **DoD:** читаются/пишутся пользователи и ключи, работают FK и UNIQUE.
- **Спецификация:** [02-data-model.md](02-data-model.md).

### B5. Генерация и хеширование API-key
- **Статус:** `done` · **Assignee:** agent-B · **Зависимости:** B4
- **Описание:** Генерация ключа `etn_<32hex>`, SHA-256 хеш, сохранение `key_hash`
  и `key_prefix`, проверка, извлечение пользователя по ключу, обновление
  `last_used_at`.
- **DoD:** ключ генерируется, валидируется, не сохраняется в открытом виде.
- **Спецификация:** [06-auth.md](06-auth.md), п. 2–3, 6.

### B6. CLI `etn init`
- **Статус:** `done` · **Assignee:** agent-B · **Зависимости:** B5
- **Описание:** CLI-команда `etn init --username admin --display-name ...`:
  создаёт `_system.db`, применяет миграции, создаёт первого пользователя
  (`is_admin=1, is_first_user=1`), генерирует первичный API-key, печатает его в
  консоль **один раз**, пишет в `audit_log`. Сервер без инициализации стартовать
  отказывается.
- **DoD:** после `etn init` сервер стартует; ключ показан; повторный init даёт
  понятную ошибку.
- **Спецификация:** [06-auth.md](06-auth.md), п. 8.

### B7. Fastify bootstrap, health, version, ошибки
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** B6
- **Описание:** Запуск Fastify, плагины (`@fastify/websocket`, CORS, error handler
  в стандартном формате `{ error: { code, message, details, request_id } }),
  `GET /api/v1/health`, `GET /api/v1/version`. Чтение TLS-конфигурации.
- **DoD:** `/health` отвечает 200, ошибки в едином формате.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 1–2.

### B8. Auth middleware
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** B7, B5
- **Описание:** Fastify preHandler: проверка `Authorization: Bearer`, поиск по
  `key_hash`, контекст запроса (`user`, `key_id`, `client_id` из заголовка
  `Client-Id`). Защита от перебора (счётчик 401, 429).
- **DoD:** без ключа → 401; с невалидным — 401; с валидным — `request.user`
  заполнен.
- **Спецификация:** [06-auth.md](06-auth.md), п. 3–5, 9.

### B9. Access-control middleware
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** B8
- **Описание:** Хелперы `requireAuth`, `requireAdmin`, `requireNetworkMember(role?)`
  с кешем членства (in-memory, сбрасывается на события member.*). Логика: админ
  может управлять членством, но не читать данные сети без членства.
- **DoD:** роли проверяются; несанкционированный доступ → 403.
- **Спецификация:** [06-auth.md](06-auth.md), п. 4–5.

### B10. Pub/sub по network_id
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** B4
- **Описание:** `EventEmitter` с каналами по `network_id`, типизированные события
  из `@etn/shared`. Подписка для WebSocket-шлюза (фаза E) и для внутренних нужд.
- **DoD:** emit/test проходят, слушатели получают события.
- **Спецификация:** [01-architecture.md](01-architecture.md), п. 5.

### B11. Идемпотентность через `Client-Request-Id`
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** B4
- **Описание:** Middleware: если есть заголовок `Client-Request-Id`, после
  успешной обработки кешировать ответ в `client_request_cache` (TTL 10 мин).
  Повторный запрос с тем же id — вернуть кешированный. Очистка по джобе.
- **DoD:** повторный запрос с тем же id возвращает тот же ответ без
  повторного выполнения.
- **Спецификация:** [01-architecture.md](01-architecture.md), п. 6;
  [02-data-model.md](02-data-model.md), п. 2.7.

### B12. Маршруты auth
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** B8
- **Описание:** `GET /me`, `/me/keys` (CRUD), `/admin/users` (CRUD + key gen),
  `/admin/users/{id}/keys`. Полный ключ возвращается только при создании.
- **DoD:** пользователь видит свои данные; админ управляет пользователями и
  ключами; первый пользователь не удаляется.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 3–4; [06-auth.md](06-auth.md).

### B13. Маршруты networks и members
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** B9, B12
- **Описание:** `GET/POST/PATCH /networks`, `GET/POST/DELETE
  /networks/{id}/members`, `PATCH` для передачи владения,
  `GET/PUT /networks/{id}/preferences[/{key}]`. Создание сети делегирует фазе C
  (C10), но маршрут описывается здесь; пока можно заглушкой, если C10 не готов.
- **DoD:** владелец управляет членством; админ может управлять любой сетью;
  preferences читаются/пишутся.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 5; [06-auth.md](06-auth.md).

### B14. audit_log middleware
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** B4
- **Описание:** Хелпер для записи в `audit_log` (категория, действие, цель,
  details). Применяется в admin-операциях, изменениях членства, auth-событиях.
  Позже используется в C/D.
- **DoD:** действия админа и auth-события журналируются; `GET /admin/audit`
  отдаёт с фильтрами.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 2.6;
  [03-server-api.md](03-server-api.md), п. 15.

> **Note (B1–B6, agent-B).** Фаза реализована в ветке
> `task/b1-b6-server-foundation` (коммиты `[B1]`…`[B6]`). Ключевые решения и
> расхождения:
>
> - **Project references.** `server/tsconfig.json` ссылался на `../shared` через
>   `references`, но `shared/tsconfig.json` не имел `composite: true`, из-за чего
>   `tsc --noEmit` сервера падал (блокер от фазы A). Включить `composite`
>   невозможно — оно конфликтует с `tsc --noEmit` в shared. Ссылка убрана:
>   `@etn/shared` резолвится через `node_modules` (sym­link workspace) и собранный
>   `shared/dist`.
> - **`settings` seeded.** В `008_settings.sql` засеяны дефолты `MCP_DEFAULTS`,
>   `REALTIME_DEFAULTS`, `AUTH_DEFAULTS` (5 ключей из `SETTING_KEY`) плюс
>   `traversal.max_depth` и `traversal.query_timeout_ms` из `TRAVERSAL_DEFAULTS`.
>   По `11-settings-and-state.md` §5.3 traversal — это дефолт параметра и
>   хард-лимит, а не L1-настройка; строки добавлены как seed, чтобы админ мог
>   переопределять дефолт без правки кода. `SETTING_KEY` в `@etn/shared` эти два
>   ключа пока не перечисляет — нужен follow-up `docs:`/shared.
> - **`api_keys.read_only`** и **`audit_log.category='system'`** включены в
>   миграции с комментарием (расхождения фазы A).
> - **better-sqlite3 native** на машине сборки не собран (`Could not locate the
>   bindings file`). `typecheck`, `lint`, сборка `dist` и тесты, не требующие
>   native (config, api-key, парсер CLI, инвентарь миграций), проходят. Тесты с
>   real БД (migrator apply, SystemDb, system-migrations apply, CLI integration)
>   оформлены и `skip`'ты с понятной причиной — зелёные, как только native
>   будет собран. Runtime-проверка `etn init` невозможна до сборки native.
> - **Гонка working-tree.** Параллельный клиентский агент переключил общую
>   рабочую копию на `task/g1-g4-client-bootstrap`, из-за чего коммиты B1/B2
>   первоначально ушли на ту ветку. Восстановлено cherry-pick на
>   `task/b1-b6-server-foundation`; на ветке G остались дубли (старые хэши
>   `25a9cb1`, `f62e893`) — при слиянии G их нужно исключить.

## 5. Фаза C — Сервер: доменный слой

> Все задачи C — последовательные (C1 → C2 → …). После завершения C стартуют D,
> E, F параллельно.

### C1. Хранилище `NetworkDb`
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** B4
- **Описание:** Открытие/создание `<network_id>/data.db`, WAL, FK ON, lifecycle
  (открытие по требованию, корректное закрытие). Реестр открытых сетей в памяти.
- **DoD:** сеть открывается повторно без ошибок; WAL-файлы создаются.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 3.

### C2. Миграции `data.db`
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C1
- **Описание:** Все таблицы: `thoughts`, `thought_synonyms`, `thought_types`,
  `link_types`, `type_properties`, `property_values`, `links`, `comments`,
  `attachments`, `user_preferences`, `thought_views`, `user_focus_preferences`,
  `user_focus_order`, `embeddings` (зарезервирована). FTS5-таблицы и триггеры
  синхронизации.
- **DoD:** схема накатывается; FTS обновляется триггерами на INSERT/UPDATE/DELETE.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 3, 3.11.

### C3. Сервис мыслей
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C2
- **Описание:** `create`, `get`, `update` (с `version`/`If-Match`), `delete`
  (защита `is_protected`), `focus` (обновление `thought_views`, возврат соседей с
  учётом `show_inactive` и сортировок пользователя), `neighbors`. Дедупликация на
  уровне приложения НЕ выполняется — её делает UI.
- **DoD:** CRUD работает; соседи возвращаются в нужном порядке; HOME не удалить.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 6;
  [02-data-model.md](02-data-model.md).

### C4. Сервис связей
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C3
- **Описание:** `create` (с проверкой `source≠target` и UNIQUE), `update`, `delete`,
  `listByThought` (с группировкой по типам и фильтром `show_inactive`).
- **DoD:** петель нет, дубликатов нет, связи группируются для редактора.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 7.

### C5. Сервис типов мыслей и связей
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C3
- **Описание:** CRUD `thought_types` и `link_types`, включая `description` (для
  AI). Управление свойствами типа (`type_properties`).
- **DoD:** типы создаются, назначаются мыслям; description сохраняется.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 8.

### C6. Сервис значений свойств
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C5
- **Описание:** `get/set/delete property_values` для мыслей и связей. Валидация по
  `value_type` свойства (text/date/number/bool/thought_ref). При `thought_ref` —
  опциональная проверка типа цели.
- **DoD:** значения пишутся в нужный `value_*` столбец; типы соблюдаются.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 3.4–3.5;
  [03-server-api.md](03-server-api.md), п. 9.

### C7. Сервис комментариев
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C3
- **Описание:** CRUD `comments`. Инвариант: один `permanent` на владельца. Рендер
  `body_md` → `body_html` (общий markdown-рендерер с поддержкой картинок, таблиц,
  кода, цитат).
- **DoD:** создаётся permanent и chronological; второй permanent — 409; HTML
  кешируется.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 3.8;
  [03-server-api.md](03-server-api.md), п. 10.

### C8. Сервис вложений
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C3
- **Описание:** CRUD `attachments` для мыслей и связей. На MVP `kind=file` хранит
  только путь (без загрузки). MIME-тип опционален.
- **DoD:** вложения добавляются/удаляются.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 3.9;
  [03-server-api.md](03-server-api.md), п. 11.

### C9. Сервис поиска (FTS5)
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C2
- **Описание:** Поиск по четырём группам (имена/тексты/связи/хронология) с
  фильтрами (subtree, scope, типы мыслей/связей, show_inactive). Snippet с
  `<mark>`-подсветкой. Список упоминаний для мысли.
- **DoD:** поиск работает по всем 4 группам; фильтры применяются.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 12–13;
  [02-data-model.md](02-data-model.md), п. 3.11.

### C10. Создание мыслесети с HOME
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C1, B13
- **Описание:** При `POST /networks` — генерация `network_id`, каталог
  `networks/<id>/{,attachments/,snapshots/}`, `data.db` с миграциями, корневая
  мысль HOME (`is_root=1, is_protected=1`), запись в `networks` и
  `network_members(role=owner)`. Удаление сети (админ) — `wal_checkpoint`,
  удаление каталога, `DELETE FROM networks`.
- **DoD:** сеть создаётся с HOME; повторное открытие работает; удаление чистит
  файлы и `_system.db`.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 4, 6.

### C11. Helper обхода графа (защита от зацикливания)
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C3
- **Описание:** TypeScript helper `traverse(seedIds, { maxDepth, maxNodes,
  direction })` с `Set<id> visited`. Рекурсивные CTE с path-проверкой для SQL-пути.
  Лимиты: `max_depth` (default 20), `max_nodes` (из L1-настройки), query timeout.
- **DoD:** на графе с циклами A→B→C→A не уходит в бесконечность; возвращает
  частичный результат при превышении лимитов (`meta.truncated`).
- **Спецификация:** [11-settings-and-state.md](11-settings-and-state.md), п. 5.

### C12. user_focus_preferences/order и thought_views
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C3, C4
- **Описание:** Запись/чтение `user_focus_preferences` и `user_focus_order`,
  обновление `thought_views` при фокусе. Алгоритм применения сортировки для зоны
  (manual/alpha/created/viewed × asc/desc).
- **DoD:** при `sort=manual` мысли в зоне идут в заданном порядке; переключение
  sort сохраняется per (user, focus, dir).
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 3.10;
  [11-settings-and-state.md](11-settings-and-state.md), п. 3.

### C13. Сервис экспорта
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C3, C7
- **Описание:** Markdown (синхронно), PDF/HTML (асинхронно через job). По списку
  `thought_ids`: заголовки, постоянный комментарий, хронология, связи. Job-очередь
  (in-memory на MVP).
- **DoD:** Markdown-экспорт работает; PDF/HTML через job отдаёт результат.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 14.

## 6. Фаза D — Сервер: REST API (полный)

> После C. Задачи D1–D8 можно вести параллельно между собой.

### D1. Routes /thoughts
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C3, C12
- **Описание:** Все эндпоинты раздела 6: CRUD, focus, neighbors, search, batch,
  resolve, focus-preferences, focus-order.
- **DoD:** end-to-end CRUD через HTTP работает, статусы ошибок соответствуют
  спецификации.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 6.

### D2. Routes /links
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C4
- **Описание:** CRUD связей + `GET /thoughts/{id}/links` (с группировкой).
- **DoD:** — · **Спецификация:** [03-server-api.md](03-server-api.md), п. 7.

### D3. Routes типов и свойств
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C5
- **Описание:** Эндпоинты для `thought-types`, `link-types` и их свойств.
- **DoD:** — · **Спецификация:** [03-server-api.md](03-server-api.md), п. 8.

### D4. Routes /properties
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C6
- **Описание:** Чтение/запись/удаление значений свойств на мыслях и связях.
- **DoD:** — · **Спецификация:** [03-server-api.md](03-server-api.md), п. 9.

### D5. Routes /comments, /attachments
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C7, C8
- **DoD:** — · **Спецификация:** [03-server-api.md](03-server-api.md), п. 10–11.

### D6. Routes /export и /jobs
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** C13
- **DoD:** — · **Спецификация:** [03-server-api.md](03-server-api.md), п. 14.

### D7. Маршруты admin: сети и аудит
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** B14
- **Описание:** `GET /admin/networks`, `DELETE /admin/networks/{id}`,
  `PATCH /admin/networks/{id}/members`, `GET /admin/audit`.
- **DoD:** — · **Спецификация:** [03-server-api.md](03-server-api.md), п. 4.2, 15.

### D8. Интеграционные тесты REST
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** D1–D7
- **Описание:** Сквозные HTTP-тесты на ключевые сценарии (создание сети, добавление
  мыслей с дедупликацией через UI-диалог на уровне API, конфликты версий,
  роли/доступ).
- **DoD:** все тесты зелёные; покрытие критичных путей.
- **Спецификация:** [09-scenarios.md](09-scenarios.md).

## 7. Фаза E — Сервер: real-time (WebSocket)

> После C. Параллельна с D и F. Внутри фазы — последовательно E1→…→E6.

### E1. WebSocket-шлюз
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** B7, B8
- **Описание:** `@fastify/websocket`, маршрут `/api/v1/realtime?network_id=...`.
  Проверка ключа и членства; закрытие 4401/4404. Структура подключения:
  `(user_id, client_id, network_id)`. Реестры `byClient`, `byNetwork`.
- **DoD:** подключение с валидным ключом держится; невалидное — закрывается с
  кодом.
- **Спецификация:** [04-realtime.md](04-realtime.md), п. 2; [11-settings-and-state.md](11-settings-and-state.md), п. 1.

### E2. event_log и network_seq
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** E1, B10
- **Описание:** В каждой изменяющей операции в той же транзакции — инкремент
  `network_seq`, запись события в `event_log`. TTL-очистка по джобе.
- **DoD:** на каждое изменение создаётся событие с уникальным `seq`.
- **Спецификация:** [04-realtime.md](04-realtime.md), п. 5; [02-data-model.md](02-data-model.md).

### E3. Эмиссия событий из доменного слоя
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** E2
- **Описание:** После коммита транзакции — `pubsub.emit(network_id, event)`. Все
  типы событий из `@etn/shared`. Связать с C3–C13 (внести эмитты в сервисы).
- **DoD:** на каждое REST-изменение эмиттится корректное событие.
- **Спецификация:** [04-realtime.md](04-realtime.md), п. 4.

### E4. Audience filtering
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** E3
- **Описание:** Доставка: `audience=network` → всем подписчикам сети;
  `audience=user` → только тому же `user_id`. Подавление эха по `actor.client_id`.
- **DoD:** приватные настройки доходят только владельцу; эхо автору не
  применяется повторно.
- **Спецификация:** [04-realtime.md](04-realtime.md), п. 5; [11-settings-and-state.md](11-settings-and-state.md), п. 4.

### E5. Resume и last_seq
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** E4
- **Описание:** Сообщение `resume { last_seq }` → отдача событий из `event_log` с
  большим `seq`. При выходе за окно — `resume.stale`. Пинг/понг, реконнект.
- **DoD:** после обрыва клиент получает пропущенные события.
- **Спецификация:** [04-realtime.md](04-realtime.md), п. 2.1–2.2, 6;
  [11-settings-and-state.md](11-settings-and-state.md), п. 1.3.

### E6. Несколько клиентов одного пользователя
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** E5
- **Описание:** Тестирование сценария: один пользователь, два `client_id`
  одновременно. Каждый независимо получает поток и имеет свой `last_seq` (на
  клиенте).
- **DoD:** сценарий `F1` из [09-scenarios.md](09-scenarios.md) проходит.
- **Спецификация:** [11-settings-and-state.md](11-settings-and-state.md), п. 1.5.

## 8. Фаза F — Сервер: MCP

> После C. Параллельна с D и E.

### F1. Каркас MCP-сервера
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** A4
- **Описание:** Использование `@modelcontextprotocol/sdk`, два транспорта (stdio +
  StreamableHTTP), эндпоинт `/mcp`. `initialize` с `protocolVersion` и списком
  tools/resources/prompts.
- **DoD:** MCP-клиент может подключиться и получить список инструментов.
- **Спецификация:** [05-mcp-server.md](05-mcp-server.md), п. 2.

### F2. Авторизация MCP
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** F1, B8
- **Описание:** API-key через env/аргумент (stdio) или Bearer (HTTP). Учёт
  `read_only` флага ключа. Повторное использование auth-слоя сервера.
- **DoD:** с невалидным ключом MCP-вызовы отвергаются; с read_only — изменяющие
  tools недоступны.
- **Спецификация:** [05-mcp-server.md](05-mcp-server.md), п. 2; [06-auth.md](06-auth.md).

### F3. Resources
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** F1
- **Описание:** Реализовать все `etn://` URI из спецификации: networks, thoughts,
  neighbors, comments, attachments, links, types. JSON + Markdown-контент.
- **DoD:** ресурсы читаются по URI.
- **Спецификация:** [05-mcp-server.md](05-mcp-server.md), п. 3.

### F4. Tools
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** F3, C3–C13
- **Описание:** Все инструменты из спецификации: search, get, neighbors, subgraph,
  path, mentions, create/update/delete thoughts и links, comments.upsert,
  attachments.add, properties.set, find_duplicates, export.subgraph. Изменяющие
  вызывают тот же доменный слой, что и REST → события real-time идут тем же путём.
- **DoD:** инструмент создает мысль → участники видят её через WebSocket.
- **Спецификация:** [05-mcp-server.md](05-mcp-server.md), п. 4.

### F5. Prompts
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** F4
- **Описание:** Шаблоны `etn.*` (summarize, suggest_links, detect_duplicates,
  generate_report).
- **DoD:** — · **Спецификация:** [05-mcp-server.md](05-mcp-server.md), п. 5.

### F6. Лимиты и журналирование MCP
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** F4
- **Описание:** `max_nodes_per_subgraph`, `max_writes_per_minute` (L1-настройки),
  запись tool-вызовов в `audit_log`.
- **DoD:** лимиты работают; превышение → частичный результат или 429.
- **Спецификация:** [05-mcp-server.md](05-mcp-server.md), п. 6.

## 9. Фаза G — Клиент: каркас и локальное хранилище

> После A. Параллельна с B–F. Внутри — последовательно G1→…→G8.

### G1. Main process и окно Electron
- **Статус:** `done` · **Assignee:** agent-G · **Зависимости:** A4
- **Описание:** `electron-vite`, main process: окно 1280×800, devTools в dev,
  загрузка renderer. Базовый `BrowserWindow`, меню.
- **DoD:** `npm run dev:client` открывает окно.
- [x] `client/electron.vite.config.ts` (main/preload/renderer, externalize deps).
- [x] `client/src/main/index.ts` — `BrowserWindow` 1280×800, dev-сервер vs
  собранный `dist/renderer/index.html`, `contextIsolation`+`sandbox`.
- [x] Минимальный renderer-плейсхолдер «ETN — подключение к серверу» (H2 — формы).
- [x] `npm -w @etn/client run typecheck` зелёный.
- **Note:** запуск Electron runtime не проверялся — блокируется отсутствующей
  native-сборкой `better-sqlite3` (инициализация LocalDb в main при ready).
  Оркестратор пересобирает native в фоне; код открытия окна готов.
- **Спецификация:** [07-client-electron.md](07-client-electron.md).

### G2. safeStorage для API-key
- **Статус:** `done` · **Assignee:** agent-G · **Зависимости:** G1
- **Описание:** Шифрование API-key через `safeStorage` (DPAPI/Keychain/libsecret),
  хранение в `server_profiles.api_key_encrypted`. Расшифровка только в main.
- **DoD:** ключ сохраняется между запусками; renderer его не видит.
- [x] `client/src/main/safe-storage.ts`: `encryptApiKey`/`decryptApiKey` +
  `SafeStorageUnavailableError`, `isApiKeyStorageAvailable`.
- [x] Запись в БД НЕ выполняется — только хелпер (таблица `server_profiles` в G3).
- **Note:** проверка сохранения между запусками отложена до G3/H2 (нужна БД).
- **Спецификация:** [06-auth.md](06-auth.md), п. 7; [07-client-electron.md](07-client-electron.md), п. 3.1.

### G3. Локальный SQLite и миграции
- **Статус:** `done` · **Assignee:** agent-G · **Зависимости:** G1
- **Описание:** `userData/local.db`, схема: `server_profiles`, `ui_state`,
  `drafts`, `focus_history`, `client_meta`. Мигратор.
- **DoD:** БД создаётся при первом запуске; схема накатывается.
- [x] `client/migrations/001_init.sql` — все 5 таблиц + `_migrations` +
  `idx_focus_history_seq`.
- [x] `client/src/main/db/migrator.ts` — обнаружение `NNN_*.sql`,
  транзакционное применение, идемпотентность в контрольной точке.
- [x] `client/src/main/db/local-db.ts` — `LocalDb` (WAL, FK ON, auto-migrate),
  методы read/write по каждой таблице, `rotateFocusHistory` (07 §3.5).
- [x] `client/src/main/db/paths.ts` — путевые хелперы + `DEV_USER_DATA_DIR`.
- **Note:** идемпотентность/накат проверены только typecheck'ом — runtime-тест
  невозможен без native `better-sqlite3`. После сборки native мигратор
  поднимется автоматически при первом запуске.
- **Спецификация:** [07-client-electron.md](07-client-electron.md), п. 3.

### G4. Генерация и хранение client_id
- **Статус:** `done` · **Assignee:** agent-G · **Зависимости:** G3
- **Описание:** При первом запуске — UUIDv4 в `client_meta.client_id`. Заголовок
  `Client-Id` во всех запросах.
- **DoD:** идентификатор стабилен между запусками; передаётся серверу.
- [x] `client/src/main/client-id.ts`: `getOrCreateClientId`/`getClientId` —
  UUIDv4 в `client_meta.client_id` (L5), валидация формата, перегенерация при
  повреждённом значении.
- [x] Интеграция в `main/index.ts`: открытие LocalDb на `app.whenReady()` и
  инициализация `client_id`; close на `before-quit`.
- **Note:** фактическая передача заголовка `Client-Id` серверу — в G5 (REST) и
  G6 (WS); здесь только стабильный id и его хранилище.
- **Спецификация:** [11-settings-and-state.md](11-settings-and-state.md), п. 1.

### G5. REST-клиент
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** G2, G4
- **Описание:** Обёртка над `undici`/fetch в main процессе: Bearer, Client-Id,
  Client-Request-Id на изменяющих запросах, retry на 5xx, таймауты, типизированные
  методы по всем ресурсам.
- **DoD:** из main можно вызывать любой endpoint из [03-server-api.md](03-server-api.md).
- **Спецификация:** [03-server-api.md](03-server-api.md); [07-client-electron.md](07-client-electron.md), п. 4.1.

### G6. WebSocket-клиент
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** G5
- **Описание:** WS в main: `resume {last_seq}` при подключении, обработка событий,
  пересылка в renderer через IPC, реконнект с jitter. Локальное хранение `last_seq`
  per (client, network).
- **DoD:** события доходят до renderer; при обрыве — reconect и resume.
- **Спецификация:** [04-realtime.md](04-realtime.md), п. 2;
  [11-settings-and-state.md](11-settings-and-state.md), п. 1.3.

### G7. IPC API
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** G5, G6
- **Описание:** `contextBridge.exposeInMainWorld('etn', {...})`. Полный набор
  методов по [07-client-electron.md](07-client-electron.md), п. 6. Renderer не
  касается сети напрямую.
- **DoD:** в renderer доступен типизированный `window.etn` со всеми методами.
- **Спецификация:** [07-client-electron.md](07-client-electron.md), п. 6.

### G8. Применение real-time событий к UI-state
- **Статус:** `todo` · **Assignee:** — · **Зависимости:** G7
- **Описание:** В renderer — стор UI-state, подписка на `realtime:event`.
  Применение created/updated/deleted/reordered. Подавление эха по
  `actor.client_id`/`request_id`. Конфликты → уведомление.
- **DoD:** на событие другого пользователя UI обновляется без перезагрузки.
- **Спецификация:** [04-realtime.md](04-realtime.md), п. 7;
  [11-settings-and-state.md](11-settings-and-state.md), п. 1.4.

## 10. Фаза H — Клиент: UI

> После G и минимально готовых D1 (thoughts), D2 (links), E (real-time).
> Многие задачи H параллельны — см. граф ниже.

Параллельные группы внутри H:
- **Слой представления холста:** H4 → H5 → H6 (последовательно).
- **Редактор:** H8 → {H9, H10, H11, H12} (H9–H12 параллельны после H8).
- **Прочее:** H1, H2, H3, H13, H14, H15, H16, H17, H19 — параллельны между собой,
  зависят только от G и готовы частей D.

### H1. Layout и каркас
- **Статус:** `todo` · **Зависимости:** G7
- **Описание:** Toolbar, статус-бар (с placeholder под историю), зоны холста,
  контейнер редактора с переключаемым положением.
- **DoD:** окно выглядит как в [08-ui-spec.md](08-ui-spec.md), п. 1.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 1.

### H2. Экран первичной настройки
- **Статус:** `todo` · **Зависимости:** G7
- **Описание:** Форма URL + API-key, проверка через `GET /me`, сохранение профиля.
  Понятные ошибки.
- **DoD:** новый пользователь подключается с нуля.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 12; [09-scenarios.md](09-scenarios.md), A4.

### H3. Список мыслесетей и создание
- **Статус:** `todo` · **Зависимости:** H2
- **DoD:** — · **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 8; [09-scenarios.md](09-scenarios.md), A1.

### H4. Холст: виртуальная сетка и облачка
- **Статус:** `todo` · **Зависимости:** H1, D1
- **Описание:** Движок рендера (Canvas или виртуализированный SVG/DOM). Расчёт
  `cols × rows` по размеру зоны, фиксированный размер облачка по L4-настройкам,
  структура облачка (иконка слева, 2 строки заголовка, индикаторы).
- **DoD:** зоны отображают облачка по сетке; при resize окна число столбцов
  пересчитывается.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 2.1.1, 2.2.1.

### H5. Холст: фокус-облачко, эллипсы, drag
- **Статус:** `todo` · **Зависимости:** H4
- **Описание:** Фокус в центре (переменная ширина, до 4 строк). Эллипсы как
  утолщения сторон рамки, индикация связей. Drag с эллипса → диалог добавления.
- **DoD:** клик по мысли → фокус; drag с эллипса → диалог.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 2.2.2, 2.3;
  [09-scenarios.md](09-scenarios.md), B1, C1, C4.

### H6. Холст: связи
- **Статус:** `todo` · **Зависимости:** H5
- **Описание:** Линии от нижнего эллипса источника к верхнему назначения, подписи
  типа, hover-tooltips, объединение нескольких связей в «толстую» линию с
  раскрывающимся списком.
- **DoD:** — · **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 2.4.

### H7. История фокуса в статус-баре
- **Статус:** `todo` · **Зависимости:** H5, G3
- **Описание:** Три облачка + dropdown. Алгоритм смены фокуса (DELETE newId +
  INSERT oldId + TRIM 50). Чистка при `thought.deleted`. Мини-облачка через
  `POST /thoughts/resolve`.
- **DoD:** история корректно обновляется; клик возвращает к прошлой мысли.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 11.1;
  [11-settings-and-state.md](11-settings-and-state.md), п. 2.3;
  [09-scenarios.md](09-scenarios.md), B4.

### H8. Редактор: шапка
- **Статус:** `todo` · **Зависимости:** H1
- **Описание:** Заголовок, синонимы (строка через запятую), тип, иконка,
  активность, цвета, стиль шрифта. Положение редактора переключается.
- **DoD:** изменения сохраняются; свернутые группы запоминаются per сущность.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 6.1, 6.2.

### H9. Редактор: постоянный и хронологические комментарии
- **Статус:** `todo` · **Зависимости:** H8, D5
- **Описание:** Markdown-редактор (рекомендация TipTap) с режимами просмотр/правка,
  медиа. Хронология — таблица с диалогом.
- **DoD:** — · **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 6.3, 6.4, 6.6.

### H10. Редактор: вложения
- **Статус:** `todo` · **Зависимости:** H8, D5
- **DoD:** — · **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 6.5.

### H11. Редактор: свойства и связи
- **Статус:** `todo` · **Зависимости:** H8, D3, D4, D2
- **DoD:** — · **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 6.3, 6.7.

### H12. Редактор: упоминания
- **Статус:** `todo` · **Зависимости:** H8
- **DoD:** — · **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 6.3.

### H13. Поиск
- **Статус:** `todo` · **Зависимости:** H1, D1
- **Описание:** Строка с восстановлением предыдущего запроса, опции (subtree,
  scope, типы), четыре группы результатов с `<mark>`.
- **DoD:** — · **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 3;
  [09-scenarios.md](09-scenarios.md), B3.

### H14. Диалог добавления мыслей
- **Статус:** `todo` · **Зависимости:** H5
- **Описание:** Живой поиск дубликатов по `title`/`synonyms`, режим одна/несколько,
  парсинг `|` для синонимов, вставка многострочного буфера.
- **DoD:** дубликаты предлагаются; пакетный режим работает.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 4; [09-scenarios.md](09-scenarios.md), C1, C2.

### H15. Контекстные меню и сортировка зон
- **Статус:** `todo` · **Зависимости:** H5
- **Описание:** Контекстное меню мысли,drag-reorder, сохранение порядка через
  focus-preferences/order.
- **DoD:** — · **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 2.6, 2.7.

### H16. Панель выделения и групповые операции
- **Статус:** `todo` · **Зависимости:** H5, D1
- **DoD:** — · **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 5;
  [09-scenarios.md](09-scenarios.md), E.

### H17. Админ-панель
- **Статус:** `todo` · **Зависимости:** H2
- **Описание:** Пользователи, ключи (один раз показ + копирование), сети, аудит.
- **DoD:** — · **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 10;
  [09-scenarios.md](09-scenarios.md), A6, I.

### H18. Настройки видимости и размеры облачка
- **Статус:** `todo` · **Зависимости:** H1, H4
- **Описание:** `show_inactive` (L3), `cloud_width`/`cloud_gap` (L4 с клиппингом).
- **DoD:** — · **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 9;
  [11-settings-and-state.md](11-settings-and-state.md), п. 2.4.

### H19. Черновики и обработка offline
- **Статус:** `todo` · **Зависимости:** G8
- **Описание:** При начале правки — draft в локальной БД, при отправке — очистка.
  При offline — индикатор, блокировка сохранения, retry.
- **DoD:** при обрыве связи правка не теряется; сценарий J1 проходит.
- **Спецификация:** [07-client-electron.md](07-client-electron.md), п. 5;
  [09-scenarios.md](09-scenarios.md), J.

## 11. Фаза I — Интеграция и тестирование

> После H. Возможно частичное перекрытие с поздними задачами H.

### I1. E2E по сценариям
- **Статус:** `todo` · **Зависимости:** все H
- **Описание:** Прогнать все сценарии из [09-scenarios.md](09-scenarios.md) вручную
  или автотестами (Playwright для renderer).
- **DoD:** все сценарии проходят.

### I2. Юнит-тесты критичных путей
- **Статус:** `todo` · **Зависимости:** D8, E6
- **Описание:** Покрытие: auth + roles, graph traverse (циклы/лимиты), конфликты
  версий, дедупликация мыслей, real-time audience filtering.
- **DoD:** критичные пути покрыты; порог покрытия зафиксирован.

### I3. Тест производительности
- **Статус:** `todo` · **Зависимости:** D8
- **Описание:** 2–5 одновременных клиентов, сеть 1k–10k мыслей. Замеры: отклик
  фокуса/поиска/real-time.
- **DoD:** подтверждена работоспособность в целевых параметрах; узкие места
  зафиксированы.

### I4. Исправление багов
- **Статус:** `todo` · **Зависимости:** I1–I3
- **DoD:** критичные баги закрыты.

## 12. Фаза J — Пользовательская документация

> После стабилизации в I.

### J1. Корневой README — финальная версия
- **Статус:** `todo` · **Зависимости:** —
- **DoD:** отражает актуальную установку/запуск.

### J2. `docs/install-server.md`
- **Статус:** `todo` · **Зависимости:** K2
- **Описание:** Требования, установка через Docker и вручную, переменные окружения,
  первый запуск `etn init`.
- **DoD:** новый администратор разворачивает сервер по документу.

### J3. `docs/install-client.md`
- **Статус:** `todo` · **Зависимости:** K1
- **Описание:** Установка клиента на Windows/macOS/Linux, подключение к серверу.
- **DoD:** — .

### J4. `docs/admin-guide.md`
- **Статус:** `todo` · **Зависимости:** —
- **Описание:** Управление пользователями и ключами, сетями и доступом,
  аудитом, бэкапом.
- **DoD:** — .

### J5. `docs/user-guide.md`
- **Статус:** `todo` · **Зависимости:** —
- **Описание:** Подключение, навигация по холсту, редактор, поиск, история фокуса,
  совместная работа, типы, экспорт.
- **DoD:** — .

### J6. `docs/mcp-clients.md`
- **Статус:** `todo` · **Зависимости:** F6
- **Описание:** Подключение Claude Desktop / IDE / кастом-агента к ETN MCP-серверу.
  Примеры.
- **DoD:** — .

### J7. `CHANGELOG.md`
- **Статус:** `todo` · **Зависимости:** —
- **DoD:** первая запись о MVP.

## 13. Фаза K — Упаковка и релиз

> Финал. K1 и K2 можно вести параллельно.

### K1. electron-builder
- **Статус:** `todo` · **Зависимости:** H
- **Описание:** Конфигурация сборки для Windows (nsis), macOS (dmg), Linux
  (AppImage/deb). Подпись (опционально).
- **DoD:** артефакты собираются на CI.

### K2. Docker-образ сервера
- **Статус:** `todo` · **Зависимости:** D8
- **Описание:** `Dockerfile`, том для `ETN_DATA_DIR`, docker-compose пример.
- **DoD:** `docker compose up` поднимает рабочий сервер.

### K3. Release workflow
- **Статус:** `todo` · **Зависимости:** K1, K2
- **Описание:** GitHub Actions: по тегу — сборка клиента и образа сервера, публикация
  в Releases.
- **DoD:** тег → релиз с артефактами.

### K4. Автообновление клиента
- **Статус:** `todo` · **Зависимости:** K3
- **Описание:** `electron-updater`, источник обновлений (GitHub Releases или
  static-хост). Проверка совместимости с сервером.
- **DoD:** клиент обновляется автоматически.

## 14. Сводный взгляд на параллелизм

| Что можно делать одновременно | Условие |
|-------------------------------|---------|
| B (сервер: фундамент) и G (клиент: каркас) | после A |
| D, E, F (REST, WS, MCP) | после C |
| Внутри H: рендер холста, редактор, поиск, выделения, диалоги, админка | после старта H4/H8, каждое по своим зависимостям |
| J (документация) и K (упаковка) | после I (документы — после стабилизации) |

## 15. Контрольные точки (milestones)

| ID | Что готово | По завершении фазы |
|----|------------|--------------------|
| ~~M1~~ | ~~Каркас + CI зелёный~~ — **достигнут локально** (commit `5e3d2a0`). CI на GitHub проверится первым push. | A ✅ |
| M2 | Сервер отвечает, `etn init` работает, auth | B |
| M3 | Полный доменный слой и создание сети с HOME | C |
| M4 | Полный REST + real-time + MCP | D, E, F |
| M5 | Клиент подключается и хранит состояние | G |
| M6 | Полный UI, сценарии проходят | H + I1 |
| M7 | MVP готов к релизу | I, J, K |

## 16. Известные риски и решения

- **Производительность холста на больших сетях.** H4 — выбранный движок рендера
  должен быть бенчмаркнут до реализации H5–H6. Если DOM/SVG тормозит — переход на
  Canvas/WebGL. Зафиксировать решение в H4.
- **Конфликты при активном соавторстве.** Политика last-write-wins per field может
  оказаться недостаточной. На I1 проверить сценарий F2; если плохо — заложить
  CRDT в следующий релиз.
- **MCP-агент, плодящий дубликаты.** F4 должен строго требовать вызова
  `find_duplicates` перед `create`. Покрыть тестом в F4/I2.
- **Рост `_system.db.event_log`.** E2 — TTL-очистка обязательна; на I3 проверить,
  что окно 24ч/10000 событий достаточно.
- **Эволюция спецификаций.** Любое изменение `docs/` после начала реализации —
  через отдельный коммит с пометкой `docs:` и обновлением затронутых задач в этом
  плане.

### Расхождения, выявленные при реализации (требуют решений)

> Обнаружено агентом-A4 на фазе A. Каждое должно быть закрыто до или в ходе
> связанной фазы; спецификации править отдельным `docs:`-коммитом.

- **`better-sqlite3` native-сборка.** На машине разработки нет Python в PATH, и
  node-gyp не собирает расширение. Блокер для запуска кода в фазах B, G3 и далее.
  Решения: (а) установить Python 3.x и сделать доступным в PATH; (б) проверить
  наличие prebuilt-binary для текущей пары Node 24/Windows; (в) рассмотреть замену
  на `node:sqlite` (нативный, Node 22+, экспериментальный). **Решить до B6** — на
  этапе `etn init` и первого открытия `_system.db`.
- **`SearchScope` — гранулярный vs REST.** В `03-server-api.md` §12 используется
  `scope=thoughts|links|chronology|all`, а в `05-mcp-server.md` §4.1 и в shared —
  `names|texts|links|chronology|all`. Принято: shared хранит гранулярный; REST-слой
  (D1) маппит legacy-значение `thoughts` → `names,texts`. Обновить `03-server-api.md`.
- **`EtnErrorCode`.** В shared добавлены `RATE_LIMITED` (HTTP 429, из `06-auth.md`
  §9) и `PROTECTED_ENTITY` (удаление/изменение `is_protected`), которых нет в
  таблице кодов `03-server-api.md` §2.1. Обновить таблицу + зафиксировать
  HTTP-маппинг (429 и 422 соответственно).
- **`api_keys.read_only`.** Колонки нет в схеме `02-data-model.md` §2.2, но нужна
  (`06-auth.md` §6.3, MCP §6.3). **B3** должен включить её в миграцию `_system.db`.
- **`AuditCategory.system`.** В `02-data-model.md` §2.6 перечислены
  `auth/user/network/membership/data` без `system`, но `etn init` пишет
  `category=system` (`06-auth.md` §8). Обновить §2.6.
- **`FocusNeighbor` для UI.** Минимальный набор полей из `03-server-api.md` §6.2
  не содержит цветов/стилей/`icon_kind`, нужных для рендера облачка (H4/H5). До
  H4 расширить (либо через `/thoughts/resolve`, либо расширить `FocusNeighbor`).
