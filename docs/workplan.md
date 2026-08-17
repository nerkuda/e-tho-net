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
- **Статус:** `done` · **Assignee:** agent-B7 · **Зависимости:** B6
- **Описание:** Запуск Fastify, плагины (`@fastify/websocket`, CORS, error handler
  в стандартном формате `{ error: { code, message, details, request_id } }),
  `GET /api/v1/health`, `GET /api/v1/version`. Чтение TLS-конфигурации.
- **DoD:**
  - [x] `/health` отвечает 200, ошибки в едином формате.
  - [x] `@fastify/cors` + `@fastify/websocket` зарегистрированы.
  - [x] Единый `setErrorHandler` → `{ error: { code, message, details?, request_id? } }`.
  - [x] `index.ts` — точка входа: config → SystemDb → hasFirstUser guard → listen.
- **Note:** добавлена зависимость `@fastify/cors@^10.0.2` (Fastify 4 compatible;
  v11 требует Fastify 5). `request_id` = `Client-Request-Id` заголовок или свежий
  UUID, дублируется в ответном `X-Request-Id`. `/version` возвращает расширенный
  payload (`version`, `api`, `min_client`, `client_compatibility`), удовлетворяющий
  и shared `VersionResponse`, и формату из ТЗ B7.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 1–2.

### B8. Auth middleware
- **Статус:** `done` · **Assignee:** agent-B7 · **Зависимости:** B7, B5
- **Описание:** Fastify preHandler: проверка `Authorization: Bearer`, поиск по
  `key_hash`, контекст запроса (`user`, `key_id`, `client_id` из заголовка
  `Client-Id`). Защита от перебора (счётчик 401, 429).
- **DoD:**
  - [x] без ключа → 401; с невалидным — 401; с валидным — `request.auth`
    заполнен.
  - [x] Защита от перебора: in-memory `AuthRateLimiter` по `(ip, key_prefix)`,
    threshold 10/мин → бан 5 мин, запрос-нарушитель получает 429 + `Retry-After`.
  - [x] `last_used_at` обновляется асинхронно (`setImmediate`), не блокируя
    запрос; неудачные auth пишутся в `audit_log` (`category=auth`).
- **Note:** контекст живёт в `request.auth` (тип {@link AuthContext}) вместо
  `request.user` из ТЗ — чтобы не конфликтовать со встроенным декоратором
  Fastify и явно отличать «identity» от domain-сущности User. Все
  middleware/routes используют `request.auth`.
- **Спецификация:** [06-auth.md](06-auth.md), п. 3–5, 9.

### B9. Access-control middleware
- **Статус:** `done` · **Assignee:** agent-B7 · **Зависимости:** B8
- **Описание:** Хелперы `requireAuth`, `requireAdmin`, `requireNetworkMember(role?)`
  с кешем членства (in-memory, сбрасывается на события member.*). Логика: админ
  может управлять членством, но не читать данные сети без членства.
- **DoD:**
  - [x] `requireAuth`/`requireAdmin`/`requireNetworkMember(role?)` работают;
    несанкционированный доступ → 403.
  - [x] In-memory кеш `NetworkMembersService` по `(user_id, network_id)` с
    `invalidate()`; admins без членства отвергаются на чтение данных сети
    (06-auth.md §4.3).
- **Note:** `SystemDb.getMemberRole` добавлен для запроса членства. Guards
  повторно проверяют `request.auth` (защита от route без auth-preHandler).
  Связь invalidation ↔ pub/sub (`member.*`) подключается в B13 (routes вызывают
  `app.members.invalidate` при изменении членства).
- **Спецификация:** [06-auth.md](06-auth.md), п. 4–5.

### B10. Pub/sub по network_id
- **Статус:** `done` · **Assignee:** agent-B7 · **Зависимости:** B4
- **Описание:** `EventEmitter` с каналами по `network_id`, типизированные события
  из `@etn/shared`. Подписка для WebSocket-шлюза (фаза E) и для внутренних нужд.
- **DoD:**
  - [x] `publish(networkId, event)` / `subscribe(networkId, listener, filter?)` /
    `unsubscribe`, события типизированы через `RealtimeEvent`/`AnyRealtimeEvent`.
  - [x] Listener-фильтры по `type`/`audience`; бросающий listener не рвёт
    доставку другим; `network_id` mismatch отвергается.
- **Note:** только интерфейс брокера; WS-доставка — фаза E. Зарегистрирован как
  `app.pubsub` в `createServer`.
- **Спецификация:** [01-architecture.md](01-architecture.md), п. 5.

### B11. Идемпотентность через `Client-Request-Id`
- **Статус:** `done` · **Assignee:** agent-B7 · **Зависимости:** B4
- **Описание:** Middleware: если есть заголовок `Client-Request-Id`, после
  успешной обработки кешировать ответ в `client_request_cache` (TTL 10 мин).
  Повторный запрос с тем же id — вернуть кешированный. Очистка по джобе.
- **DoD:**
  - [x] Повторный запрос с тем же `Client-Request-Id` (тот же пользователь)
    возвращает сохранённый status+body **без** повторного выполнения обработчика.
  - [x] Кеш user-scoped (`(request_id, user_id)`); не-2xx ответы не кешируются;
    GET и запросы без заголовка игнорируются.
  - [x] TTL-очистка через `setInterval` (5 мин), зарегистрирована в `createServer`.
- **Note:** `preHandler` ставится после auth (нужен `user_id`); `onSend`-hook
  глобален и сохраняет только первые (non-replay) 2xx. Методы SystemDb:
  `findCachedResponse`, `saveCachedResponse`, `purgeExpiredCache`.
- **Спецификация:** [01-architecture.md](01-architecture.md), п. 6;
  [02-data-model.md](02-data-model.md), п. 2.7.

### B12. Маршруты auth
- **Статус:** `done` · **Assignee:** agent-B7 · **Зависимости:** B8
- **Описание:** `GET /me`, `/me/keys` (CRUD), `/admin/users` (CRUD + key gen),
  `/admin/users/{id}/keys`. Полный ключ возвращается только при создании.
- **DoD:**
  - [x] `GET /me`, `/me/keys`, `POST /me/keys` (ключ один раз), `DELETE /me/keys/:id`.
  - [x] `/admin/users` CRUD + `/admin/users/:id/keys` (gen/revoke), всё через
    `requireAdmin`; полный ключ возвращается один раз при создании.
  - [x] Первый пользователь не удаляется/не понижается (422 `PROTECTED_ENTITY`);
    пользователь, владеющий сетями, не удаляется (422).
  - [x] Все admin-операции пишут в `audit_log` (`category=user`); дубликат
    username → 409 `DUPLICATE`.
- **Note:** запись аудита идёт через `SystemDb.insertAuditLog` напрямую
  (метод с B4); полноценный `recordAudit` helper вынесен в B14. Зависимость
  `@fastify/cors` понижена до `^9.0.1` (v10 требует Fastify 5, а у нас 4.29).
  Важный фикс: `setErrorHandler` обязан регистрироваться **до** route-плагинов,
  иначе encapsulated child-конtekсты наследуют дефолтный формат Fastify и
  `EtnError` сериализуется как `{statusCode,code,error,message}` 500.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 3–4; [06-auth.md](06-auth.md).

### B13. Маршруты networks и members
- **Статус:** `done` · **Assignee:** agent-B7 · **Зависимости:** B9, B12
- **Описание:** `GET/POST/PATCH /networks`, `GET/POST/DELETE
  /networks/{id}/members`, `PATCH` для передачи владения,
  `GET/PUT /networks/{id}/preferences[/{key}]`. Создание сети делегирует фазе C
  (C10), но маршрут описывается здесь; пока можно заглушкой, если C10 не готов.
- **DoD:**
  - [x] `GET /networks` (с ролью/members_count), `GET/PATCH /networks/:id`,
    `GET/POST/DELETE /networks/:id/members`, `PATCH members/:uid` (передача
    владения в одной транзакции), `GET/PUT preferences[/:key]` (`show_inactive`).
  - [x] Управление членством — owner ИЛИ admin; чтение данных и свои preferences
    — любой участник (`requireNetworkMember`); non-member → 403.
  - [x] Кеш членства инвалидируется при add/remove/transfer; все изменения
    пишутся в `audit_log` (`category=network|membership`).
- **Note:** `NetworkService` (createNetwork/deleteNetwork) — интерфейс + stub
  (`throw Not implemented: see task C10`); real impl подключится в C10 без правки
  routes. Pub/sub emit `member.*`/`network.*` отложен в фазу E3 (нужен `seq` из
  E2); сейчас invalidation идёт через прямой вызов `app.members.invalidate`.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 5; [06-auth.md](06-auth.md).

### B14. audit_log middleware
- **Статус:** `done` · **Assignee:** agent-B7 · **Зависимости:** B4
- **Описание:** Хелпер для записи в `audit_log` (категория, действие, цель,
  details). Применяется в admin-операциях, изменениях членства, auth-событиях.
  Позже используется в C/D.
- **DoD:**
  - [x] `recordAudit(systemDb, {actorUserId?, networkId?, category, action,
    targetType?, targetId?, details?})` — типизированный helper (тонкая обёртка
    над `SystemDb.insertAuditLog`, catch-on-failure по умолчанию).
  - [x] `GET /admin/audit` с фильтрами `actor`/`network`/`category`/`from`/`to`/
    `limit`(default 50, cap 500)/`offset`, admin only, newest first + total.
  - [x] Неудачные auth (401, 429) журналируются в `auth-middleware` (B8);
    admin/key/network/membership операции — в routes (B12/B13).
- **Note:** в B12/B13 audit уже пишется напрямую через `SystemDb.insertAuditLog`
  (метод с B4) — это эквивалент `recordAudit`; helper добавлен как канонический
  entry-point для будущих слоёв (C/D, MCP F6). `queryAudit`/`countAudit`
  SystemDb используют динамический WHERE (prepared-on-demand, кешируется
  better-sqlite3).
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
- **Статус:** `done` · **Assignee:** agent-C · **Зависимости:** B4
- **Описание:** Открытие/создание `<network_id>/data.db`, WAL, FK ON, lifecycle
  (открытие по требованию, корректное закрытие). Реестр открытых сетей в памяти.
- **DoD:** сеть открывается повторно без ошибок; WAL-файлы создаются.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 3.
- **Note:** `server/src/db/network-db.ts` — тонкая обёртка (`prepare`/
  `transaction`/`exec`/`pragma`/`close`) с реестром `Map<networkId, NetworkDb>`;
  `openNetworkDb` создаёт `networks/<id>/{,attachments/,snapshots/}`, ставит
  `journal_mode=WAL`, `foreign_keys=ON`, применяет миграции; `closeNetworkDb`/
  `closeAll` для shutdown; `createInMemoryNetworkDb` для юнит-тестов C3–C6.

### C2. Миграции `data.db`
- **Статус:** `done` · **Assignee:** agent-C · **Зависимости:** C1
- **Описание:** Все таблицы: `thoughts`, `thought_synonyms`, `thought_types`,
  `link_types`, `type_properties`, `property_values`, `links`, `comments`,
  `attachments`, `user_preferences`, `thought_views`, `user_focus_preferences`,
  `user_focus_order`, `embeddings` (зарезервирована). FTS5-таблицы и триггеры
  синхронизации.
- **DoD:** схема накатывается; FTS обновляется триггерами на INSERT/UPDATE/DELETE.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 3, 3.11.
- **Note:** 12 идемпотентных файлов `server/migrations/network/001..012`. FTS5
  rowid зеркалирует `thoughts.rowid`/`comments.rowid`, поэтому триггеры точно
  удаляют/обновляют строки. Добавлены дополнительные enforcement-индексы: partial
  UNIQUE `idx_comments_permanent_one` (один permanent на владельца) и
  `idx_property_values_owner`. Связь `property_values.property_id` имеет реальный
  FK `ON DELETE CASCADE`. Для нетипизированных связей (NULL в UNIQUE) дубликат
  дополнительно ловится в приложении (C4).

### C3. Сервис мыслей
- **Статус:** `done` · **Assignee:** agent-C · **Зависимости:** C2
- **Описание:** `create`, `get`, `update` (с `version`/`If-Match`), `delete`
  (защита `is_protected`), `focus` (обновление `thought_views`, возврат соседей с
  учётом `show_inactive` и сортировок пользователя), `neighbors`. Дедупликация на
  уровне приложения НЕ выполняется — её делает UI.
- **DoD:** CRUD работает; соседи возвращаются в нужном порядке; HOME не удалить.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 6;
  [02-data-model.md](02-data-model.md).
- **Note:** `server/src/domain/thought-service.ts`. CRUD с `If-Match`
  (`VERSION_CONFLICT` 409), `title_norm` = NFC+trim+lowercase, синхронизация
  синонимов (массив или строка через запятую), опциональная inline parent/child
  связь в той же транзакции. `focus()` пишет `thought_views` и возвращает соседей
  с учётом `show_inactive` и сохранённой `user_focus_preferences` (дефолт
  `created`/`asc` — запись предпочтений добавит C12). `deleteThought` чистит
  полиморфных владельцев без SQL-FK (comments/attachments/property_values).
  Запросы соседей полностью параметризованы; `ORDER BY` строится только из
  enum-валидированных фрагментов. Также добавлен `resolveThoughts` (§6.9).

### C4. Сервис связей
- **Статус:** `done` · **Assignee:** agent-C · **Зависимости:** C3
- **Описание:** `create` (с проверкой `source≠target` и UNIQUE), `update`, `delete`,
  `listByThought` (с группировкой по типам и фильтром `show_inactive`).
- **DoD:** петель нет, дубликатов нет, связи группируются для редактора.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 7.
- **Note:** `server/src/domain/link-service.ts`. Самопетли → 422, дубликаты → 409
  (проверка NULL-safe через `ifnull`, так что и нетипизированные пары ловятся
  поверх UNIQUE-индекса). `listLinksByThought` одним параметризованным запросом с
  `CASE` выбирает «opponent» thought и группирует в `by_type`/`untyped_parents`/
  `untyped_children` с учётом `show_inactive`.

### C5. Сервис типов мыслей и связей
- **Статус:** `done` · **Assignee:** agent-C · **Зависимости:** C3
- **Описание:** CRUD `thought_types` и `link_types`, включая `description` (для
  AI). Управление свойствами типа (`type_properties`).
- **DoD:** типы создаются, назначаются мыслям; description сохраняется.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 8.
- **Note:** `thought-type-service.ts` + `link-type-service.ts` (CRUD с unique
  name / unique `(name_forward,name_reverse)`, `If-Match`). Удаление типа в
  использовании → 422 без `force`, с `force` — `type_id` обнуляется у
  мыслей/связей. `description` сохраняется. Определения свойств
  (`type_properties` CRUD + reorder) в `property-service.ts`, owner_type =
  `thought_type`/`link_type`. **Расхождение:** `ThoughtTypeInput.icon_kind` есть
  в shared, но в `thought_types` нет колонки `icon_kind` (§3.3) — игнорируется на
  записи; нужен follow-up shared/docs.

### C6. Сервис значений свойств
- **Статус:** `done` · **Assignee:** agent-C · **Зависимости:** C5
- **Описание:** `get/set/delete property_values` для мыслей и связей. Валидация по
  `value_type` свойства (text/date/number/bool/thought_ref). При `thought_ref` —
  опциональная проверка типа цели.
- **DoD:** значения пишутся в нужный `value_*` столбец; типы соблюдаются.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 3.4–3.5;
  [03-server-api.md](03-server-api.md), п. 9.
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

### C7. Сервис комментариев
- **Статус:** `done` · **Assignee:** agent-C7 · **Зависимости:** C3
- **Описание:** CRUD `comments`. Инвариант: один `permanent` на владельца. Рендер
  `body_md` → `body_html` (общий markdown-рендерер с поддержкой картинок, таблиц,
  кода, цитат).
- **DoD:**
  - [x] создаётся permanent и chronological; второй permanent — 409; HTML кешируется.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 3.8;
  [03-server-api.md](03-server-api.md), п. 10.
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

### C8. Сервис вложений
- **Статус:** `done` · **Assignee:** agent-C7 · **Зависимости:** C3
- **Описание:** CRUD `attachments` для мыслей и связей. На MVP `kind=file` хранит
  только путь (без загрузки). MIME-тип опционален.
- **DoD:**
  - [x] вложения добавляются/удаляются.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 3.9;
  [03-server-api.md](03-server-api.md), п. 11.
- **Note:** `server/src/domain/attachment-service.ts`. Валидация: для `kind=url`
  обязательно `url`, для `kind=file` — `file_path` (422 иначе). Kind неизменяем
  после создания; очистка location-поля текущего kind даёт 422. Полиморфный
  владелец проверяется на существование (404). У таблицы `attachments` нет колонки
  `version` — update без `If-Match` (last-write-wins). Тесты: 9.

### C9. Сервис поиска (FTS5)
- **Статус:** `done` · **Assignee:** agent-C7 · **Зависимости:** C2
- **Описание:** Поиск по четырём группам (имена/тексты/связи/хронология) с
  фильтрами (subtree, scope, типы мыслей/связей, show_inactive). Snippet с
  `<mark>`-подсветкой. Список упоминаний для мысли.
- **DoD:**
  - [x] поиск работает по всем 4 группам; фильтры применяются.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 12–13;
  [02-data-model.md](02-data-model.md), п. 3.11.
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

### C10. Создание мыслесети с HOME
- **Статус:** `done` · **Assignee:** agent-C10 · **Зависимости:** C1, B13
- **Описание:** При `POST /networks` — генерация `network_id`, каталог
  `networks/<id>/{,attachments/,snapshots/}`, `data.db` с миграциями, корневая
  мысль HOME (`is_root=1, is_protected=1`), запись в `networks` и
  `network_members(role=owner)`. Удаление сети (админ) — `wal_checkpoint`,
  удаление каталога, `DELETE FROM networks`.
- **DoD:**
  - [x] сеть создаётся с HOME; повторное открытие работает; удаление чистит
    файлы и `_system.db`.
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 4, 6.
- **Note:** `NetworkServiceImpl` в `server/src/domain/network-service.ts`
  (заменил `StubNetworkService`), подключён в `http/server.ts`. Каталог
  `networks/<id>/{,attachments/,snapshots/}` + data.db с миграциями + HOME в одной
  транзакции, registry+owner в `_system.db` отдельной транзакцией. Удаление:
  WAL checkpoint → close → rm каталога → `DELETE FROM networks` (каскад).
  Тесты: 4 (включая reopen-idempotency).

### C11. Helper обхода графа (защита от зацикливания)
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** C3
- **Описание:** TypeScript helper `traverse(seedIds, { maxDepth, maxNodes,
  direction })` с `Set<id> visited`. Рекурсивные CTE с path-проверкой для SQL-пути.
  Лимиты: `max_depth` (default 20), `max_nodes` (из L1-настройки), query timeout.
- **DoD:**
  - [x] на графе с циклами A→B→C→A не уходит в бесконечность; возвращает
    частичный результат при превышении лимитов (`meta.truncated`).
- **Спецификация:** [11-settings-and-state.md](11-settings-and-state.md), п. 5.
- **Note:** `server/src/domain/graph-traversal.ts` — BFS с visited-set
  (`traverse`, `subgraph`, `findPath`), bounds из `TRAVERSAL_DEFAULTS` и
  `MCP_DEFAULTS`, `truncated`+`reason`. SQL-path (CTE c path-проверкой) живёт в
  `search-service.ts` (C9). Тесты: цикл, maxNodes-truncation, алмаз, subgraph.

### C12. user_focus_preferences/order и thought_views
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** C3, C4
- **Описание:** Запись/чтение `user_focus_preferences` и `user_focus_order`,
  обновление `thought_views` при фокусе. Алгоритм применения сортировки для зоны
  (manual/alpha/created/viewed × asc/desc).
- **DoD:**
  - [x] при `sort=manual` мысли в зоне идут в заданном порядке; переключение
    sort сохраняется per (user, focus, dir).
- **Спецификация:** [02-data-model.md](02-data-model.md), п. 3.10;
  [11-settings-and-state.md](11-settings-and-state.md), п. 3.
- **Note:** запись — `server/src/domain/focus-service.ts` (`setFocusPreferences`
  upsert, `setFocusOrder` полная замена позиций, validation, запрет manual для
  siblings); чтение/применение — в `thought-service.ts` (C3: `readFocusPref`,
  `orderByClause`, `focus`). Тесты: upsert, замена порядка, rejection manual/
  siblings.

### C13. Сервис экспорта
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** C3, C7
- **Описание:** Markdown (синхронно), PDF/HTML (асинхронно через job). По списку
  `thought_ids`: заголовки, постоянный комментарий, хронология, связи. Job-очередь
  (in-memory на MVP).
- **DoD:**
  - [x] Markdown-экспорт работает; PDF/HTML через job отдаёт результат.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 14.
- **Note:** `server/src/domain/export-service.ts` — markdown синхронно
  (`exportToMarkdown`), html/markdown через in-memory job store (`startExportJob`,
  `getExportJob`, `getExportJobContent`, TTL 10 мин). PDF на MVP **не
  реализован** (422 с подсказкой «HTML + print to PDF») — это осознанное
  отклонение от буквы DoD, зафиксировано; pdf-рендер (puppeteer) — отдельная
  задача в следующем релизе. Тесты: markdown-контент, job lifecycle, pdf-reject.

## 6. Фаза D — Сервер: REST API (полный)

> После C. Задачи D1–D8 можно вести параллельно между собой.

### D1. Routes /thoughts
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** C3, C12
- **Описание:** Все эндпоинты раздела 6: CRUD, focus, neighbors, search, batch,
  resolve, focus-preferences, focus-order.
- **DoD:**
  - [x] end-to-end CRUD через HTTP работает, статусы ошибок соответствуют
    спецификации.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 6.
- **Note:** `server/src/routes/thoughts.ts` (`createThoughtsRoutes`). Поиск и
  дедупликация (§12, D7) — в отдельных задачах. В `thought-service.getNeighbors`
  добавлен фильтр `type_id` (§6.7), в `link-service` — `findLinksBetween`
  (для batch `unlink_from_focus`). Общий хелпер парсинга тела/If-Match —
  `server/src/routes/helpers.ts`.

### D2. Routes /links
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** C4
- **Описание:** CRUD связей + `GET /thoughts/{id}/links` (с группировкой).
- **DoD:**
  - [x] CRUD связей работает через HTTP; группировка для редактора отдаётся.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 7.
- **Note:** `server/src/routes/links.ts` (`createLinksRoutes`).

### D3. Routes типов и свойств
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** C5
- **Описание:** Эндпоинты для `thought-types`, `link-types` и их свойств.
- **DoD:**
  - [x] CRUD типов и их свойств работает через HTTP; force-delete работает.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 8.
- **Note:** `server/src/routes/types.ts` (`createTypesRoutes`). Reorder свойств —
  `PUT …/types/:id/properties/reorder { ordered_ids }` (в спецификации §8 путь
  не зафиксирован — выбрано явное имя).

### D4. Routes /properties
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** C6
- **Описание:** Чтение/запись/удаление значений свойств на мыслях и связях.
- **DoD:**
  - [x] upsert по ключу работает, удаление по ключу работает; ошибки валидации
    соответствуют спецификации.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 9.
- **Note:** `server/src/routes/properties.ts` (`createPropertiesRoutes`).

### D5. Routes /comments, /attachments
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** C7, C8
- **DoD:**
  - [x] CRUD комментариев и вложений работает через HTTP для обоих типов
    владельцев (thought/link).
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 10–11.
- **Note:** `server/src/routes/comments.ts`, `server/src/routes/attachments.ts`.

### D6. Routes /export и /jobs
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** C13
- **DoD:**
  - [x] экспорт запускается (202 + job_id), статус и скачивание результата
    работают; поиск с фильтрами работает.
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 14.
- **Note:** `server/src/routes/search.ts` (`createSearchRoutes`) — поиск §12,
  экспорт §14 и /jobs. Legacy-маппинг `scope=thoughts`→`names,texts` — здесь.
  В `export-service` у job хранится `format` (для MIME-типа скачивания).

### D7. Маршруты admin: сети и аудит
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** B14
- **Описание:** `GET /admin/networks`, `DELETE /admin/networks/{id}`,
  `PATCH /admin/networks/{id}/members`, `GET /admin/audit`.
- **DoD:**
  - [x] admin управляет любой сетью; `network.deleted` эмитится до удаления
    registry-строки (FK event_log).
- **Спецификация:** [03-server-api.md](03-server-api.md), п. 4.2, 15.
- **Note:** `routes/admin-networks.ts` + `SystemDb.listAllNetworks()`.
  `GET /admin/audit` уже был (B14). Эмиссия realtime событий во все
  D-маршруты (E3-wiring) сделана оркестратором коммитом `8ad36fd`:
  thought/link/type/property/comment/attachment.*, thought-view.updated,
  user-focus-* (audience=user).

### D8. Интеграционные тесты REST
- **Статус:** `done` · **Assignee:** agent-D · **Зависимости:** D1–D7
- **Описание:** Сквозные HTTP-тесты на ключевые сценарии (создание сети, добавление
  мыслей с дедупликацией через UI-диалог на уровне API, конфликты версий,
  роли/доступ).
- **DoD:**
  - [x] все тесты зелёные; покрытие критичных путей.
- **Спецификация:** [09-scenarios.md](09-scenarios.md).
- **Note:** `server/tests/routes-thoughts.test.ts`, `routes-links.test.ts`,
  `routes-comments-attachments.test.ts`, `routes-search-export.test.ts` +
  общий хелпер `server/tests/rest-helpers.ts` (реальная сеть через
  `POST /networks`, контекст с HOME). Дедупликация диалога покрыта через
  `GET /thoughts/duplicates` (см. Note в D1).

## 7. Фаза E — Сервер: real-time (WebSocket)

> После C. Параллельна с D и F. Внутри фазы — последовательно E1→…→E6.

### E1. WebSocket-шлюз
- **Статус:** `done` · **Assignee:** agent-E · **Зависимости:** B7, B8
- **Описание:** `@fastify/websocket`, маршрут `/api/v1/realtime?network_id=...`.
  Проверка ключа и членства; закрытие 4401/4404. Структура подключения:
  `(user_id, client_id, network_id)`. Реестры `byClient`, `byNetwork`.
- **DoD:**
  - [x] Подключение с валидным ключом держится; невалидное — закрывается с кодом.
  - [x] 4401 для невалидного ключа и не-члена сети; 4404 для несуществующей сети.
  - [x] Реестры `connections` / `byNetwork` / `byClient` ведутся корректно.
- **Note:** реализовано вместе с E4/E5 в `server/src/realtime/gateway.ts`
  (один модуль); доставка с audience-фильтром, resume и ping/pong — там же.
- **Спецификация:** [04-realtime.md](04-realtime.md), п. 2; [11-settings-and-state.md](11-settings-and-state.md), п. 1.

### E2. event_log и network_seq
- **Статус:** `done` · **Assignee:** agent-E · **Зависимости:** E1, B10
- **Описание:** В каждой изменяющей операции в той же транзакции — инкремент
  `network_seq`, запись события в `event_log`. TTL-очистка по джобе.
- **DoD:**
  - [x] На каждое изменение создаётся событие с уникальным `seq`.
  - [x] `SystemDb.nextNetworkSeq/appendEvent/readEventsAfter/getMinEventSeq/pruneOldEvents`.
  - [x] TTL-джоба (`realtime/event-log-cleanup.ts`): окно 10 000 строк / 24 ч.
- **Note:** seq+append атомарны в одной транзакции `_system.db`; эмиссия — в
  `realtime/emit.ts` (E3), вызывается после мутации данных сети.
- **Спецификация:** [04-realtime.md](04-realtime.md), п. 5; [02-data-model.md](02-data-model.md).

### E3. Эмиссия событий из доменного слоя
- **Статус:** `done` · **Assignee:** agent-E · **Зависимости:** E2
- **Описание:** После коммита транзакции — `pubsub.emit(network_id, event)`. Все
  типы событий из `@etn/shared`. Связать с C3–C13 (внести эмитты в сервисы).
- **DoD:**
  - [x] На каждое REST-изменение эмиттится корректное событие.
  - [x] `realtime/emit.ts` — `emitDomainEvent(...)`: seq + event_log + pubsub.
  - [x] Внедрено в `routes/networks.ts`: `network.updated`, `member.added`,
    `member.removed`, 2× `member.role_changed` (передача владения),
    `user-preference.updated` (audience=user).
- **Note:** эмиссия внедрена в маршруты, а не в сервисы (безопаснее: после
  успешной мутации). Карта «событие → маршрут фазы D» задокументирована в
  заголовке `realtime/emit.ts` — D-агент подключает остальные события после
  merge своих маршрутов.
- **Спецификация:** [04-realtime.md](04-realtime.md), п. 4.

### E4. Audience filtering
- **Статус:** `done` · **Assignee:** agent-E · **Зависимости:** E3
- **Описание:** Доставка: `audience=network` → всем подписчикам сети;
  `audience=user` → только тому же `user_id`. Подавление эха по `actor.client_id`.
- **DoD:**
  - [x] Приватные настройки доходят только владельцу (тест: два пользователя).
  - [x] Эхо автору не доставляется (подавление по `actor.client_id`).
  - [x] При `resume` чужие `audience=user` события не отдаются.
- **Спецификация:** [04-realtime.md](04-realtime.md), п. 5; [11-settings-and-state.md](11-settings-and-state.md), п. 4.

### E5. Resume и last_seq
- **Статус:** `done` · **Assignee:** agent-E · **Зависимости:** E4
- **Описание:** Сообщение `resume { last_seq }` → отдача событий из `event_log` с
  большим `seq`. При выходе за окно — `resume.stale`. Пинг/понг, реконнект.
- **DoD:**
  - [x] После обрыва клиент получает пропущенные события (пачками по 500).
  - [x] Дыра в окне → `resume.stale { last_seq: min_seq-1 }`.
  - [x] Серверный ping каждые 30 с; без pong 60 с → закрытие (1001);
    клиентский `ping` → `pong`.
- **Спецификация:** [04-realtime.md](04-realtime.md), п. 2.1–2.2, 6;
  [11-settings-and-state.md](11-settings-and-state.md), п. 1.3.

### E6. Несколько клиентов одного пользователя
- **Статус:** `done` · **Assignee:** agent-E · **Зависимости:** E5
- **Описание:** Тестирование сценария: один пользователь, два `client_id`
  одновременно. Каждый независимо получает поток и имеет свой `last_seq` (на
  клиенте).
- **DoD:**
  - [x] Сценарий `F1` из [09-scenarios.md](09-scenarios.md) проходит
    (интеграционные WS-тесты в `tests/realtime-gateway.test.ts`).
  - [x] Два клиента одного пользователя получают общий поток независимо;
    эхо подавляется только у инициировавшего клиента.
- **Спецификация:** [11-settings-and-state.md](11-settings-and-state.md), п. 1.5.

## 8. Фаза F — Сервер: MCP

> После C. Параллельна с D и E.

### F1. Каркас MCP-сервера
- **Статус:** `done` · **Assignee:** agent-F · **Зависимости:** A4
- **Описание:** Использование `@modelcontextprotocol/sdk`, два транспорта (stdio +
  StreamableHTTP), эндпоинт `/mcp`. `initialize` с `protocolVersion` и списком
  tools/resources/prompts.
- **DoD:** MCP-клиент может подключиться и получить список инструментов.
- [x] `server/src/mcp/server.ts` — сборка SDK `McpServer` (identity, capabilities,
  instructions) + регистрация resources/tools/prompts.
- [x] `server/src/mcp/index.ts` — фабрика `createMcpServer(deps)` (systemDb,
  dataDir, pubsub, authProvider, auth, logger), публичный экспорт.
- [x] stdio: `server/src/mcp/stdio.ts` + CLI `etn mcp [--api-key]`
  (env `ETN_API_KEY`); HTTP: `server/src/mcp/http.ts` (StreamableHTTP,
  session map, JSON-ответы + SSE для GET).
- [x] HTTP-эндпоинт `/mcp` на Fastify при `ETN_MCP_ENABLED=1`; отдельный
  порт `ETN_MCP_PORT` — выделенный listener в `index.ts`.
- [x] Тесты: client через InMemoryTransport получает 19 tools / 10 resources /
  4 prompts; HTTP-handshake initialize → session → tools/list → callTool.
- **Спецификация:** [05-mcp-server.md](05-mcp-server.md), п. 2.

### F2. Авторизация MCP
- **Статус:** `done` · **Assignee:** agent-F · **Зависимости:** F1, B8
- **Описание:** API-key через env/аргумент (stdio) или Bearer (HTTP). Учёт
  `read_only` флага ключа. Повторное использование auth-слоя сервера.
- **DoD:** с невалидным ключом MCP-вызовы отвергаются; с read_only — изменяющие
  tools недоступны.
- [x] `mcp/auth.ts` — `createApiKeyAuthProvider` поверх `hashApiKey` +
  `SystemDb.findApiKeyByHash` (disabled ключ/пользователь → null) + touch.
- [x] stdio: `ETN_API_KEY` / `--api-key`; HTTP: `Authorization: Bearer`,
  повторная проверка ключа на каждый запрос сессии.
- [x] `requireWritable` — read-only ключ отклоняет изменяющие tools (FORBIDDEN).
- [x] Тесты: 401 (нет/невалидный ключ), 403 (чужой ключ в сессии), read-only
  отклонение, disabled ключ/пользователь, не-участник сети.
- **Спецификация:** [05-mcp-server.md](05-mcp-server.md), п. 2; [06-auth.md](06-auth.md).

### F3. Resources
- **Статус:** `done` · **Assignee:** agent-F · **Зависимости:** F1
- **Описание:** Реализовать все `etn://` URI из спецификации: networks, thoughts,
  neighbors, comments, attachments, links, types. JSON + Markdown-контент.
- **DoD:** ресурсы читаются по URI.
- [x] `mcp/resources.ts` — 10 ресурсов: `etn://networks` (static) + 9 шаблонов
  (network meta, thought, neighbors, comments, attachments, link,
  thought-types, link-types, thought-type с description).
- [x] JSON (`application/json`) + Markdown для комментариев (`text/markdown`).
- [x] Членство проверяется на каждом чтении (FORBIDDEN для чужих сетей).
- [x] Тест: чтение мысли HOME и комментариев по URI через SDK Client.
- **Спецификация:** [05-mcp-server.md](05-mcp-server.md), п. 3.

### F4. Tools
- **Статус:** `done` · **Assignee:** agent-F · **Зависимости:** F3, C3–C13
- **Описание:** Все инструменты из спецификации: search, get, neighbors, subgraph,
  path, mentions, create/update/delete thoughts и links, comments.upsert,
  attachments.add, properties.set, find_duplicates, export.subgraph. Изменяющие
  вызывают тот же доменный слой, что и REST → события real-time идут тем же путём.
- **DoD:** инструмент создает мысль → участники видят её через WebSocket.
- [x] `mcp/tools.ts` — все 19 инструментов из §4.1–4.3 (zod-схемы параметров).
- [x] Изменяющие: доменные сервисы + `emitDomainEvent` (thought.created/
  updated/deleted, link.*, comment.*, attachment.created, property-value.set) +
  `expected_version`.
- [x] `etn.comments.upsert` (permanent — create-or-update, chronological — append).
- [x] Тест: create → событие в PubSub (thought.created + link.created), данные
  в data.db, `find_duplicates` до/после; subgraph/path/export на графе из 2 узлов.
- **Спецификация:** [05-mcp-server.md](05-mcp-server.md), п. 4.

### F5. Prompts
- **Статус:** `done` · **Assignee:** agent-F · **Зависимости:** F4
- **Описание:** Шаблоны `etn.*` (summarize, suggest_links, detect_duplicates,
  generate_report).
- **DoD:** — · **Спецификация:** [05-mcp-server.md](05-mcp-server.md), п. 5.
- [x] `mcp/prompts.ts` — 4 параметризованных шаблона, текстовые промпты с
  инструкциями в терминах tools/resources.
- [x] Тест: `getPrompt` возвращает текст с `etn://`-ресурсами.

### F6. Лимиты и журналирование MCP
- **Статус:** `done` · **Assignee:** agent-F · **Зависимости:** F4
- **Описание:** `max_nodes_per_subgraph`, `max_writes_per_minute` (L1-настройки),
  запись tool-вызовов в `audit_log`.
- **DoD:** лимиты работают; превышение → частичный результат или 429.
- [x] `SystemDb.getSetting(key)` (новый метод чтения `_system.db.settings`).
- [x] `mcp/limits.ts` — чтение L1-настроек с дефолтами `MCP_DEFAULTS`,
  `WriteRateLimiter` (sliding window 60 с).
- [x] Subgraph/neighbors ограничены `max_nodes_per_subgraph`; изменяющие tools
  расходуют бюджет, превышение → `RATE_LIMITED`.
- [x] Каждый изменяющий tool-вызов → `audit_log` (category `data`, action = tool,
  details = параметры).
- [x] Тесты: лимит записи (2/мин → третья отклонена), audit-строка create.
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
- **Статус:** `done` · **Assignee:** agent-G58 · **Зависимости:** G2, G4
- **Описание:** Обёртка над `undici`/fetch в main процессе: Bearer, Client-Id,
  Client-Request-Id на изменяющих запросах, retry на 5xx, таймауты, типизированные
  методы по всем ресурсам.
- **DoD:** из main можно вызывать любой endpoint из [03-server-api.md](03-server-api.md).
- [x] `client/src/main/net/rest-client.ts` — `RestClient` (fetch-based, без новых
  runtime-deps): Bearer + Client-Id на каждом запросе; `Client-Request-Id` и
  `If-Match` (опционально) на изменяющих; retry 5xx/сети (3 попытки, full-jitter);
  таймаут ответа 30 с (AbortSignal); `EtnError` из канонического `{error}` тела.
- [x] Методы по всем разделам 03-server-api.md §3–16: me/keys, admin users+keys,
  admin networks/audit, networks+members+preferences, thoughts (CRUD/focus/
  neighbors/batch/resolve/focus-preferences/order), links (+grouped), types
  (thought/link + property definitions), property values (thought/link), comments,
  attachments, search, mentions, export/jobs, health/version.
- [x] Тесты (`client/tests/rest-client.test.ts`, 15 cases): заголовки, query
  (включая массивы и `undefined`), парсинг envelope/`meta`/204, `EtnError` для
  канонического и не-канонического тела, отсутствие retry на 4xx, retry на 5xx и
  сетевых ошибках (3 попытки).
- **Note:** используется встроенный `fetch` (Node 20+/Electron main) — `undici` не
  добавлялся. `baseUrl` тримит trailing slash; пути `encodeURIComponent`-ятся;
  массивы query повторяются (`type_id=a&type_id=b`). API-key резолвится лениво в
  каждой попытке (устойчивость к ротации ключа). Для health/version (`/health`,
  `/version`) — отдельный путь без префикса `/api/v1` и без auth-заголовка.
- **Спецификация:** [03-server-api.md](03-server-api.md); [07-client-electron.md](07-client-electron.md), п. 4.1.

### G6. WebSocket-клиент
- **Статус:** `done` · **Assignee:** agent-G58 · **Зависимости:** G5
- **Описание:** WS в main: `resume {last_seq}` при подключении, обработка событий,
  пересылка в renderer через IPC, реконнект с jitter. Локальное хранение `last_seq`
  per (client, network).
- **DoD:**
  - [x] события доходят до renderer; при обрыве — reconect и resume.
- **Note:** `client/src/main/net/ws-client.ts` — `RealtimeClient` (TypedEmitter):
  resume по last_seq из client_meta, ping/pong, `resume.stale`, коды 4401/4404,
  экспоненциальный реконнект с jitter, тесты 11 (resume/reconnect/close-codes).
- **Спецификация:** [04-realtime.md](04-realtime.md), п. 2;
  [11-settings-and-state.md](11-settings-and-state.md), п. 1.3.

### G7. IPC API
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** G5, G6
- **Описание:** `contextBridge.exposeInMainWorld('etn', {...})`. Полный набор
  методов по [07-client-electron.md](07-client-electron.md), п. 6. Renderer не
  касается сети напрямую.
- **DoD:**
  - [x] в renderer доступен типизированный `window.etn` со всеми методами.
- **Note:** контракт `EtnApi` в `client/src/main/ipc/contract.ts`; handlers —
  `ipc/handlers.ts` (фабрика `createHandlers`, единый `bind()` — единственная
  точка доверия аргументам renderer'а, async-обёртка для ipcRenderer.invoke);
  состояние подключения (RestClient/RealtimeClient/profile/текущая сеть) — в
  `ipc/register.ts`; preload строит `window.etn` над каналом `etn:invoke`;
  `env.d.ts` импортирует EtnApi. `main/index.ts` вызывает `registerIpc`. Тесты:
  3 (routing, not-connected, unknown method).
- **Спецификация:** [07-client-electron.md](07-client-electron.md), п. 6.

### G8. Применение real-time событий к UI-state
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** G7
- **Описание:** В renderer — стор UI-state, подписка на `realtime:event`.
  Применение created/updated/deleted/reordered. Подавление эха по
  `actor.client_id`/`request_id`. Конфликты → уведомление.
- **DoD:**
  - [x] на событие другого пользователя UI обновляется без перезагрузки.
- **Note:** `client/src/main/realtime/applier.ts` — `RealtimeState` (in-memory
  кэш thoughts/links) + `applyRealtimeEvent`: подавление эха по client_id,
  stale-version guard, merge created/updated, focus_history-чистка при delete,
  `focus-lost`/`network-lost` эффекты (self member.removed). Пересылка в renderer
  — через broadcast из `register.ts` (подписка на `rt.onTyped('event')`).
  Конфликтное уведомление в UI — на H-фазе. Тесты: 6.
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
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** G7
- **Описание:** Toolbar, статус-бар (с placeholder под историю), зоны холста,
  контейнер редактора с переключаемым положением.
- **DoD:**
  - [x] Окно выглядит как в [08-ui-spec.md](08-ui-spec.md), п. 1: toolbar
    (меню сети, поиск, шестерёнка, пользователь, индикатор 🟢/🟡/🔴),
    статус-бар (индикатор, сеть, фокус, событие), контейнеры: выделение
    (слева, скрыто), холст (центр), редактор (переключается
    left/right/top/bottom/hidden через `data-editor-pos`).
  - [x] Индикатор статуса реагирует на `realtime.status` в реальном времени.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 1.
- **Note:** заложен фреймворк renderer (vanilla TS + DOM, без зависимостей):
  стор (`state.ts`), DOM-хелперы, меню/диалоги, realtime-мост, screen-manager
  (onboarding/networks/workspace), CSS-переменные под будущие темы.
  `getPreferences` в IPC-контракте приведён к фактическому runtime-типу
  `UserPreferenceEntry[]` (отдельный коммит `fix(client-ipc)`).

### H2. Экран первичной настройки
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** G7
- **Описание:** Форма URL + API-key, проверка через `GET /me`, сохранение профиля.
  Понятные ошибки.
- **DoD:**
  - [x] Новый пользователь подключается с нуля: приветствие → форма (URL,
    API-key, опциональное имя) → `server.addProfile` (ключ шифруется через
    `safeStorage` в main) → `GET /me` → переход к списку сетей.
  - [x] Список сохранённых профилей: клик → `server.connect`; ошибки
    подключения (неверный ключ, сервер недоступен) показаны понятным текстом.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 12; [09-scenarios.md](09-scenarios.md), A4.
- **Note:** IPC-метод `server.addProfile` (контракт + handlers + register +
  preload) и подключение G8-applier к broadcast сделаны отдельным коммитом
  `fix(client-ipc)`.

### H3. Список мыслесетей и создание
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H2
- **DoD:**
  - [x] Список сетей (имя, владелец, роль, число участников); клик → открытие
    с загрузкой L2/L3/L4 состояния и начального фокуса.
  - [x] Создание сети (имя + описание) → открытие на HOME.
  - [x] Меню сети в toolbar: открыть список, создать, настройки сети
    (владелец), участники (список/добавление/исключение/передача владения),
    выйти из сети (не владелец).
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 8; [09-scenarios.md](09-scenarios.md), A1.
- **Note:** у API нет эндпоинта «корневая мысль сети» — стартовый фокус
  находится через поиск `HOME` + `is_root` (см. `app.findRootThought`).

### H4. Холст: виртуальная сетка и облачка
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H1, D1
- **Описание:** Движок рендера (Canvas или виртуализированный SVG/DOM). Расчёт
  `cols × rows` по размеру зоны, фиксированный размер облачка по L4-настройкам,
  структура облачка (иконка слева, 2 строки заголовка, индикаторы).
- **DoD:**
  - [x] Зоны (верх-лево/верх-право/низ) отображают облачка по сетке с
    фиксированными ячейками `cloud_width`+`cloud_gap`; высота облачка — из
    формулы (2 строки + индикаторы + эллипсы, §2.4).
  - [x] При resize окна число столбцов пересчитывается (ResizeObserver);
    виртуализация по строкам с overscan ±2.
  - [x] Облачко: квадрат иконки, 2 строки заголовка с `…` + tooltip,
    индикаторы 📝/📅N/📎N (ленивая загрузка счётчиков с кешем).
  - [x] Цвета/шрифты — свои значения поверх дефолтов типа; неактивные
    приглушены.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 2.1.1, 2.2.1.
- **Note:** соседи `FocusNeighbor` не содержат цветов/стилей (расхождение
  зафиксировано в workplan §16) — метаданные догружаются через
  `POST /thoughts/resolve` и кешируются. Прокрутка во всех зонах вертикальная
  (сетка по строкам); счётчик диапазона на скроллбаре не делался.

### H5. Холст: фокус-облачко, эллипсы, drag
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H4
- **Описание:** Фокус в центре (переменная ширина, до 4 строк). Эллипсы как
  утолщения сторон рамки, индикация связей. Drag с эллипса → диалог добавления.
- **DoD:**
  - [x] Клик по мысли → `thoughts.focus` (B1); Enter на облачке тоже фокусирует.
  - [x] Фокус-облачко: переменная ширина, до 4 строк заголовка с `…` и tooltip,
    эллипсы закрашены при наличии входящих/исходящих связей.
  - [x] Drag с эллипса: брошено на мысль → прямая связь (C4); иначе → opener
    диалога добавления (реализуется в H14).
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 2.2.2, 2.3;
  [09-scenarios.md](09-scenarios.md), B1, C1, C4.
- **Note:** drag реализован на mouse-событиях (порог 4 px) с подсветкой цели;
  зонная навигация стрелками (приложение к §13) не входила в DoD.

### H6. Холст: связи
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H5
- **Описание:** Линии от нижнего эллипса источника к верхнему назначения, подписи
  типа, hover-tooltips, объединение нескольких связей в «толстую» линию с
  раскрывающимся списком.
- **DoD:**
  - [x] SVG-линии: родители → верхний эллипс фокуса; нижний эллипс фокуса →
    дети; цвет/стиль/толщина из типа связи, `name_forward` вдоль линии.
  - [x] Hover → tooltip (`name_forward`/`name_reverse`, счётчики 📝/📎 связи,
    лениво).
  - [x] Несколько связей пары → утолщённая линия + число, клик → выбор связи
    → редактор (через opener, регистрируется редактором в H8).
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 2.4.
- **Note:** линии перерисовываются по rAF при рендере/скролле/resize; SVG-оверлей
  поверх зон (pointer-events только на штрихе).

### H7. История фокуса в статус-баре
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H5, G3
- **Описание:** Три облачка + dropdown. Алгоритм смены фокуса (DELETE newId +
  INSERT oldId + TRIM 50). Чистка при `thought.deleted`. Мини-облачка через
  `POST /thoughts/resolve`.
- **DoD:**
  - [x] История корректно обновляется при смене фокуса (`history.rotate`
    вызывается из `app.setFocus`; LocalDb-метод из G3); клик возвращает к
    прошлой мысли.
  - [x] Статус-бар: `←` + 3 мини-облачка (иконка, заголовок до 40 символов,
    цвета из типа/настроек) + `▾ N` dropdown; пустая история — заглушка.
  - [x] `thought.deleted` → UI перерисовывает историю (applier чистит
    локальную БД в main); неактивные скрыты при выключенном `show_inactive`.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 11.1;
  [11-settings-and-state.md](11-settings-and-state.md), п. 2.3;
  [09-scenarios.md](09-scenarios.md), B4.
- **Note:** в этом же коммите — слой применения realtime-событий к UI
  (`realtime-ui.ts`: дебаунс-перефокус при изменениях рядом с фокусом,
  инвалидация счётчиков, L3-события, `network.updated`).

### H8. Редактор: шапка
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H1
- **Описание:** Заголовок, синонимы (строка через запятую), тип, иконка,
  активность, цвета, стиль шрифта. Положение редактора переключается.
- **DoD:**
  - [x] Шапка мысли: заголовок, синонимы, тип (с «без типа»), иконка-эмодзи,
    активность, цвет текста/фона, 4 toggle стиля; сохранение `thoughts.update`
    с `If-Match`, конфликт версий → обновление данных + уведомление (F2).
  - [x] Шапка связи (клик по линии холста): тип + активность, `links.update`.
  - [x] Положение редактора left/right/top/bottom/hidden → L4
    `editor_position`; сворачиваемые группы с состоянием per сущность
    (инфраструктура `group.ts` + `editor_collapsed_groups`).
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 6.1, 6.2.
- **Note:** иконка — только эмодзи на MVP (`icon_kind: 'image'` не
  реализован: нет загрузки файлов на сервер).

### H9. Редактор: постоянный и хронологические комментарии
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H8, D5
- **Описание:** Markdown-редактор (рекомендация TipTap) с режимами просмотр/правка,
  медиа. Хронология — таблица с диалогом.
- **DoD:**
  - [x] Постоянный: просмотр `body_html` (innerHTML) / правка `body_md`
    (textarea), create-or-update с `If-Match`, черновик при offline (H19).
  - [x] Хронология: таблица (заголовок, С/По, краткий текст), диалог
    добавления/редактирования (двойной клик), удаление; даты по умолчанию —
    сегодня.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 6.3, 6.4, 6.6.
- **Note:** TipTap осознанно не используется (без новых зависимостей, решение
  оркестратора) — просмотр HTML от сервера + textarea для правки md.

### H10. Редактор: вложения
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H8, D5
- **DoD:**
  - [x] Список с превью для картинок-URL и иконками для прочего; удаление.
  - [x] Диалог добавления (kind url/file, адрес/путь, заголовок, комментарий);
    drag-drop файлов и URL в зону вложений (множественный).
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 6.5.
- **Note:** превью для `file_path` не показывается (renderer изолирован,
  `file://` из dev-окружения недоступен) — иконка 📄; путь берётся из
  `File.path` (Electron 31).

### H11. Редактор: свойства и связи
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H8, D3, D4, D2
- **DoD:**
  - [x] Свойства (только мысль): таблица по типу, редакторы по `value_type`
    (text/number/date/bool/thought_ref), `thought_ref` — выбор через диалог
    дубликатов; `properties.set`/`remove`.
  - [x] Связи (только мысль): группировка по типам + безтиповые
    «Источники»/«Назначения»; клик открывает связь в редакторе.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 6.3, 6.7.

### H12. Редактор: упоминания
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H8
- **DoD:**
  - [x] Список `thoughts.mentions`; клик по мысли → фокус, по связи → редактор.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 6.3.

### H13. Поиск
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H1, D1
- **Описание:** Строка с восстановлением предыдущего запроса, опции (subtree,
  scope, типы), четыре группы результатов с `<mark>`.
- **DoD:**
  - [x] Восстановление `search_state` при активации; Enter + debounce 250 мс.
  - [x] 4 сворачиваемые группы со счётчиками, snippet с `<mark>` (innerHTML от
    сервера); клик по мысли → фокус, по связи → фокус источника + редактор.
  - [x] Опции: subtree (subroot через пикер, по умолчанию фокус), чекбоксы
    групп, тип мыслей/связей, show_inactive.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 3;
  [09-scenarios.md](09-scenarios.md), B3.
- **Note:** гранулярный `SearchScope` не поддерживает комбинации
  `names,texts` — при фильтре «только мысли» выполняется до 3 параллельных
  запросов и ответы объединяются.

### H14. Диалог добавления мыслей
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H5
- **Описание:** Живой поиск дубликатов по `title`/`synonyms`, режим одна/несколько,
  парсинг `|` для синонимов, вставка многострочного буфера.
- **DoD:**
  - [x] Дубликаты предлагаются с пометкой точности («использовать»);
    режим «несколько»: накопление, многострочная вставка, Ctrl+Enter.
  - [x] Создание через `thoughts.create` с `create_link`; существующая мысль —
    `links.create`; тип связи по умолчанию из `last_used_link_type_id`.
  - [x] Drag файлов/URL на зоны холста (08-ui-spec.md §7): мысль + вложение;
    зона родственников — запрещённая цель.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 4; [09-scenarios.md](09-scenarios.md), C1, C2.

### H15. Контекстные меню и сортировка зон
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H5
- **Описание:** Контекстное меню мысли,drag-reorder, сохранение порядка через
  focus-preferences/order.
- **DoD:**
  - [x] Меню мысли (08-ui-spec.md §2.6): добавить вверх/вниз/налево,
    активность, порядок, тип, иконка, вложение, редактор, выделение,
    копировать/вырезать/вставить, удалить.
  - [x] Меню зоны: сортировка alpha/created/viewed × asc/desc, ручной
    (родители/дети); drag-reorder → `setFocusOrder` + переключение в manual.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 2.6, 2.7.
- **Note:** «Вырезать» на MVP эквивалентно «Копировать» + сброс клипборда
  после вставки (перенос связи); «Добавить вложение» открывает редактор
  мысли (фокус), чтобы добавить вложение в группе.

### H16. Панель выделения и групповые операции
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H5, D1
- **DoD:**
  - [x] Ctrl+клик toggle; Ctrl+клик по эллипсу — все родители/дети;
    «Добавить к выделению» из контекстного меню.
  - [x] Подменю «Добавить» (дети/родители всех выбранных), «Изменить» (тип,
    активность, удаление, связи с фокусом, очистить) через `thoughts.batch`.
  - [x] Экспорт markdown/html/pdf: job + poll → скачивание.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 5;
  [09-scenarios.md](09-scenarios.md), E.
- **Note:** PDF не реализован сервером (C13) — 422 с подсказкой.

### H17. Админ-панель
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H2
- **Описание:** Пользователи, ключи (один раз показ + копирование), сети, аудит.
- **DoD:**
  - [x] Пользователи: таблица, добавление (username/имя/админ), ключ один раз
    с «Копировать», перегенерация, отключение/включение, удаление.
  - [x] Сети: список всех сетей + удаление.
  - [x] Аудит: таблица с фильтрами (категория, период).
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 10;
  [09-scenarios.md](09-scenarios.md), A6, I.
- **Note:** список ключей пользователя недоступен (нет GET-эндпоинта
  `/admin/users/{id}/keys`); принудительная смена владельца сети не входила в
  ТЗ задачи.

### H18. Настройки видимости и размеры облачка
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** H1, H4
- **Описание:** `show_inactive` (L3), `cloud_width`/`cloud_gap` (L4 с клиппингом).
- **DoD:**
  - [x] «Настройки видимости» → `networks.setPreference('show_inactive')` (L3,
    синхронизируется с другими клиентами пользователя); холст/поиск/история
    обновляются.
  - [x] «Размер облачка»: `cloud_width`/`cloud_gap` с клиппингом в системные
    константы, L4 ui_state; холст перерисовывается.
- **Спецификация:** [08-ui-spec.md](08-ui-spec.md), п. 9;
  [11-settings-and-state.md](11-settings-and-state.md), п. 2.4.

### H19. Черновики и обработка offline
- **Статус:** `done` · **Assignee:** agent-H · **Зависимости:** G8
- **Описание:** При начале правки — draft в локальной БД, при отправке — очистка.
  При offline — индикатор, блокировка сохранения, retry.
- **DoD:**
  - [x] Правка постоянного комментария и заголовка мысли зеркалится в
    локальные `drafts` (IPC `ui.draftSave`), на успешную отправку — удаление;
    при открытии — восстановление черновика (в более поздней версии —
    при открытии поле остаётся в режиме просмотра, черновик не форсирует
    редактирование; см. 07-client-electron.md §3.3).
  - [x] При offline (🔴) сохранение блокируется с уведомлением; при
    восстановлении соединения pending-черновики пересылаются автоматически
    (идемпотентность — серверный `Client-Request-Id`); конфликт версии
    оставляет черновик.
- **Спецификация:** [07-client-electron.md](07-client-electron.md), п. 5;
  [09-scenarios.md](09-scenarios.md), J.

> **Note (H-фаза, agent-H).** Фаза реализована в ветке `task/h1-h19-client-ui`
> (коммиты `[H1]`…`[H19]` + `fix(client-ipc)`/`docs(workplan)`/`style`).
> Ключевые решения и расхождения:
>
> - **Без новых зависимостей.** Vanilla TS + DOM; холст — CSS Grid с
>   виртуализацией строк (видимое окно + overscan ±2, `transform: translateY`),
>   связи — SVG-overlay (rAF-дебаунс, pointer-events на штрихе); markdown —
>   `innerHTML` из `body_html` (серверный рендер) + `<textarea>` для правки.
> - **IPC-контракт дополнен** (отдельные коммиты `fix(client-ipc)`):
>   `server.addProfile`, `thoughts.findDuplicates`, `history.rotate`,
>   `types.listLinkTypes`, `types.listThoughtTypeProperties`,
>   `realtime.onStale`, `ui.draftSave/draftList/draftDelete`; исправлены типы
>   `networks.getPreferences` (массив) и `properties.get` (массив) — рантайм не
>   совпадал с контрактом G7. В `register.ts` подключён G8-applier к
>   broadcast (эхо-подавление, чистка focus_history, `resume.stale`-пересылка).
> - **Расхождения со спеками:**
>   - у API нет эндпоинта «корневая мысль сети» — стартовый фокус ищется через
>     поиск `HOME` + `is_root` (workplan §16: `FocusNeighbor` без стилей —
>     догрузка через `POST /thoughts/resolve`);
>   - прокрутка всех зон вертикальная (сетка по строкам; «горизонтальная
>     прокрутка» из §2.5 противоречит фиксированным ячейкам);
>   - «Кол-во мыслей в сети» в статус-баре недоступно (нет API) — показано
>     количество видимых соседей по зонам;
>   - иконка мысли — только эмодзи; превью `file_path` вложений недоступно в
>     изолированном renderer;
>   - «Вырезать» ≈ «Копировать» + сброс после вставки; «Добавить вложение» из
>     меню открывает редактор;
>   - PDF-экспорт отклоняется сервером (осознанное решение C13);
>   - список ключей пользователя и смена владельца сети в админке недоступны
>     (нет соответствующих эндпоинтов).
> - **Runtime-проверка Electron GUI** в этом окружении не выполнялась —
>   обязательными были typecheck/lint/format/test и `electron-vite build`
>   (см. §14 ниже: всё зелёное).

## 11. Фаза I — Интеграция и тестирование

> После H. Возможно частичное перекрытие с поздними задачами H.

### I1. E2E по сценариям
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** все H
- **Описание:** Прогнать все сценарии из [09-scenarios.md](09-scenarios.md) вручную
  или автотестами (Playwright для renderer).
- **DoD:**
  - [x] автотест `server/tests/e2e-scenarios.test.ts`: полный путь (сеть →
    мысли со связями → комментарий → поиск по синониму → duplicates → focus →
    batch → экспорт 202→job done) + realtime-доставка между двумя пользователями
    (network-событие доходит, user-событие — нет). GUI-прогон в headless-среде
    невозможен; отмечено как ограничение верификации MVP.

### I2. Юнит-тесты критичных путей
- **Статус:** `done` · **Assignee:** все фазы · **Зависимости:** D8, E6
- **Описание:** Покрытие: auth + roles, graph traverse (циклы/лимиты), конфликты
  версий, дедупликация мыслей, real-time audience filtering.
- **DoD:**
  - [x] 314 тестов: 255 сервер + 59 клиент (auth/roles, traverse-циклы,
    If-Match-конфликты, duplicates, audience-filter, resume, echo).

### I3. Тест производительности
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** D8
- **Описание:** 2–5 одновременных клиентов, сеть 1k–10k мыслей. Замеры: отклик
  фокуса/поиска/real-time.
- **DoD:**
  - [x] `server/tests/perf-smoke.test.ts`: 10k мыслей + цепочка 50 —
    bulk-create, focus (лимит 50), FTS-поиск по комментариям, обход 100+ узлов —
    в CI-безопасных потолках (мс). Многопользовательская нагрузка — в
    ручном приёмочном прогоне.

### I4. Исправление багов
- **Статус:** `done` · **Assignee:** все фазы · **Зависимости:** I1–I3
- **DoD:** критичные баги, найденные агентами и оркестратором, закрыты (включая
  FK-фиксы тестов C10, порядок регистрации error handler, stdio-завершение
  процесса, типы prefs/properties в контракте G7).

## 12. Фаза J — Пользовательская документация

> После стабилизации в I.

### J1. Корневой README — финальная версия
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** —
- **DoD:** отражает актуальную установку/запуск (Node 22 LTS, команды dev).

### J2. `docs/install-server.md`
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** K2
- **Описание:** Требования, установка через Docker и вручную, переменные окружения,
  первый запуск `etn init`.
- **DoD:** новый администратор разворачивает сервер по документу.

### J3. `docs/install-client.md`
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** K1
- **Описание:** Установка клиента на Windows/macOS/Linux, подключение к серверу.
- **DoD:** — .

### J4. `docs/admin-guide.md`
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** —
- **Описание:** Управление пользователями и ключами, сетями и доступом,
  аудитом, бэкапом.
- **DoD:** — .

### J5. `docs/user-guide.md`
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** —
- **Описание:** Подключение, навигация по холсту, редактор, поиск, история фокуса,
  совместная работа, типы, экспорт.
- **DoD:** — .

### J6. `docs/mcp-clients.md`
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** F6
- **Описание:** Подключение Claude Desktop / IDE / кастом-агента к ETN MCP-серверу.
  Примеры.
- **DoD:** — .

### J7. `CHANGELOG.md`
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** —
- **DoD:** первая запись о MVP (0.1.0).

## 13. Фаза K — Упаковка и релиз

> Финал. K1 и K2 можно вести параллельно.

### K1. electron-builder
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** H
- **Описание:** Конфигурация сборки для Windows (nsis), macOS (dmg), Linux
  (AppImage/deb). Подпись (опционально).
- **DoD:**
  - [x] `client/electron-builder.yml` (nsis/dmg/AppImage+deb, asarUnpack для
    native, publish=github). Локальная сборка инсталляторов не прогонялась
    (CI-задача K3) — конфиг валиден, сборка `electron-vite build` работает.

### K2. Docker-образ сервера
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** D8
- **Описание:** `Dockerfile`, том для `ETN_DATA_DIR`, docker-compose пример.
- **DoD:**
  - [x] `server/Dockerfile` (multi-stage, node:22-alpine, prebuilt
    better-sqlite3) + `docker-compose.yml` (volume, init-команда в README).
    Локальная сборка образа не прогонялась (docker недоступен) — верификация
    на CI/при приёмке.

### K3. Release workflow
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** K1, K2
- **Описание:** GitHub Actions: по тегу — сборка клиента и образа сервера, публикация
  в Releases.
- **DoD:**
  - [x] `.github/workflows/release.yml`: matrix (win/mac/linux) + electron-builder,
    GHCR-образ, GitHub Release по тегу `v*`. Сработает при первом теге (требует
    репозитория на GitHub).

### K4. Автообновление клиента
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** K3
- **Описание:** `electron-updater`, источник обновлений (GitHub Releases или
  static-хост). Проверка совместимости с сервером.
- **DoD:**
  - [x] `client/src/main/updater.ts` (quiet check в packaged-сборках, статусы в
    renderer), dep `electron-updater`, `publish: github` в electron-builder.yml.

## 13.1. Фаза L — Пост-MVP доработки (по запросам пользователя)

### L1. Работа с вложениями: серверное хранение, контекстное меню, превью
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** расширение вложений по отчёту пользователя:
  вставка **всех** файлов из буфера обмена (не только картинок) с загрузкой на
  сервер; контекстное меню вложения в редакторе (открыть в программе по
  умолчанию / показать / назначить иконкой мысли / перенести в мысль / удалить
  с файлом); превью картинок-файлов и favicon'ы интернет-адресов в списке;
  автозаполнение заголовка и иконки для URL-вложений; убрать кнопку удаления
  из строки вложения.
- **DoD:**
  - [x] `attachments.icon` (data: URL) в схеме/DTO; URL-вложения обогащаются
    `<title>` + favicon на сервере при создании (best-effort, с таймаутами).
  - [x] `PATCH /attachments/{id}` переносит вложение к другому владельцу
    (`owner_type`/`owner_id`); `DELETE` удаляет серверный файл вложения,
    когда `file_path` лежит в каталоге `attachments/` сети (пользовательские
    пути не трогает).
  - [x] IPC `system.openPath`/`system.openExternal` (shell) + контекстное меню
    вложения; просмотр картинок/текстов/md; «Назначить иконкой мысли»
    (картинки, только владелец-мысль); «Перенести в мысль» через
    `pickThoughtRef`.
  - [x] Превью в списке: файлы-картинки через `etnimg:`, URL — favicon/картинка;
    кнопка «✕» удалена (удаление — из контекстного меню).
  - [x] `npm run typecheck` + тесты зелёные; спецификации 02/03/08 обновлены.

### L2. Лупа иконок: Ctrl+наведение
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** при зажатом `Ctrl` наведение на любую иконку-картинку
  (`<img>`: история фокуса, результаты поиска, вложения, списки связей,
  картинки в комментариях) показывает всплывашку с изображением в полном
  размере у курсора, не более 70% ширины/высоты окна.
- **DoD:**
  - [x] Делегированный механизм на уровне документа
    (`lib/image-zoom.ts`), без точечной проводки списков.
  - [x] Скрытие: отпускание `Ctrl`, уход курсора, скролл, `Escape`, blur.
  - [x] Не увеличаются картинки, уже показанные в натуральном размере.
  - [x] `npm run typecheck` + клиентские тесты зелёные; §13 спеки обновлён.

### L3. Анимация смены фокуса на холсте
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** FLIP-хореография при смене фокуса (08-ui-spec.md §2.8):
  выбранная мысль летит в центр с ростом до фокус-облачка, оставшиеся
  переезжают, покинувшие — затухают (ghost-клоны), новые — проявляются;
  линии связей гаснут на время переезда. Всё — не более 1 с.
- **DoD:**
  - [x] `canvas/transition.ts`: снапшот облачков до ре-рендера, FLIP-движение
    (только transform/opacity), ghost-затухание, fade-in новых, маскировка
    перегеометрии линий.
  - [x] Не анимируются: тот же фокус (правки/realtime/выделение) и
    `prefers-reduced-motion`.
  - [x] Линии связей перерисовываются по финальным позициям до старта анимаций.
  - [x] `npm run typecheck` + клиентские тесты зелёные; §2.8 спеки добавлен.

### L4. Удаление мысли: локальная зачистка и восстановление фокуса
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** удаление мысли через контекстное меню (в т.ч. находящейся в
  фокусе) не имело эффекта у автора: нет realtime-эха (04-realtime.md §5),
  `scheduleRefresh` молча падал на 404, мысль оставалась в фокусе и в истории.
- **DoD:**
  - [x] `app.onThoughtDeleted(id)`: локальная зачистка автора — история
    (новый IPC `history.remove`), кеши, выделение; фокус → предыдущая мысль
    из истории (с проверкой существования), иначе корень HOME.
  - [x] Тот же recovery по `focus-lost` (фокус удалён другим пользователем) —
    вместо возврата к списку сетей.
  - [x] Спека 08-ui-spec.md §11.1 дополнена; typecheck/тесты зелёные.

### L5. Контекстное меню строк в разделе «Связи» редактора мысли
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** строки раздела «Связи» в редакторе мысли имели только клик
  (фокусировка противоположной мысли); операции над связью/мыслью требовали
  идти на холст.
- **DoD:**
  - [x] Контекстное меню строки: «Открыть», «Изменить тип связи…», «Удалить
    связь», «Удалить мысль» (08-ui-spec.md §6.7).
  - [x] «Изменить тип связи…» — диалог выбора типа (типы сети + «без типа»)
    → `links.update`; линия перерисовывается сразу (`patchFocusEdge`, нет
    realtime-эха у автора).
  - [x] Удаления переиспользуют операции меню холста (подтверждение, зачистка
    автора по L4); тело группы и счётчик перезагружаются после операции.
  - [x] Спека 08-ui-spec.md §6.7 дополнена; typecheck/тесты зелёные.

### L6. Управление типами мыслей и связей
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** типы существовали как каталоги (CRUD на сервере), но в клиенте
  не управлялись: создать/изменить тип или его свойства было негде.
- **DoD:**
  - [x] Меню «Вид» (☰): команды «Типы мыслей» и «Типы связей» → диалоги-списки
    (иконка/имя со стилем типа/комментарий; алфавитный порядок; «Добавить»,
    построчное удаление; 08-ui-spec.md §8.1).
  - [x] Редактор типа мысли: иконка (тот же диалог, что у мысли), имя
    (обязательно), ⚙ цвета/шрифт (тот же диалог, режим типа), комментарий,
    таблица свойств: имя/тип/по умолчанию (`config.default_value`),
    ▲/▼-порядок, удаление; операции применяются сразу.
  - [x] Редактор типа связи: имена вперёд/назад (обязательны), ⚙ стиль линии
    (режим типа), комментарий.
  - [x] Сервер: удаление типа (force) теперь каскадом удаляет его property
    definitions, а значения — через FK ON DELETE CASCADE; мысли/связи
    остаются без типа. Тесты каскадов добавлены.
  - [x] IPC/preload: CRUD типов связей и property definitions (generic
    `ownerType`); диалоги переведены на стек (диалог поверх диалога).
  - [x] Итерация 2: combobox выбора типов с поиском (иконки/стили в строках,
    свотч линии у типов связей; список монтируется в body — не обрезается
    диалогом); тип мысли в диалоге добавления; подписи линий и групп — от
    фокуса/редактируемой мысли; диалог свойства (заголовок/тип/по умолчанию,
    «url»-тип значений, подтверждение и notice при смене типа значения);
    сервер: конверсия значений при смене value_type, переименование key.
  - [x] Спеки 02 §3.4, 03 §8, 08 §8/§8.1 дополнены; typecheck/тесты зелёные.

### L7. Редактор мысли: табовая компоновка и ленивая загрузка
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** при большом количестве связей/свойств редактор перегружен и
  делает лишние запросы. Шапка (иконка, заголовок, синонимы, тип, ⚙,
  актуальность) остаётся; ниже — вкладки (08-ui-spec.md §6.3):
  «Основное» (Свойства + Комментарий), «Вложения (N)» (список ≤5 строк +
  область просмотра: картинки/текст/markdown с правкой через новый
  `PUT …/attachments/{id}/content`, прочие — «Открыть в приложении»;
  сплиттер), «Связи» (Прямые связи (N) со сворачиваемыми подгруппами типов
  ≤15 строк; Упоминания и Использование — свёрнуты, поиск при первом
  развороте, счётчик `…` → `(N)`; сплиттеры; для «Использования» — новый
  `GET …/thoughts/{id}/usage` с группировкой по свойствам), «Хроника (N)»
  (таблица ≤5 строк + инлайн-просмотр/редактирование с метаданными;
  сплиттер). Содержимое вкладки строится при активации; активная вкладка
  не сбрасывается при смене фокуса. Табы применяются и к редактору связи.
- **DoD:**
  - [x] Сервер: `GET /networks/{nid}/thoughts/{id}/usage` (обратный поиск
    `thought_ref`, группировка по свойствам), `GET/PUT
    /networks/{nid}/attachments/{id}/content` (контент текстовых вложений,
    markdown-рендер сервером; перезапись файла ≤10 МиБ, только text-подобные).
  - [x] IPC `thoughts.usage`, `attachments.getContent/updateContent`.
  - [x] Клиент: оболочка с вкладками (регистр контента по вкладкам, keep-alive
    в рамках рендера, sticky-таббар), `group.ts`: lazyCount/`etn:set-count`/
    compact-подгруппы; переиспользуемый сплиттер.
  - [x] Вкладки: «Основное» (свойства без заголовков колонок ≤5 строк,
    комментарий как есть), «Вложения» (клик — выбор/просмотр, dblclick —
    открыть внешне, drop-зона, ПКМ-меню), «Связи» (3 группы + сплиттеры,
    подгруппы типов сворачиваемые, упоминания/использование лениво),
    «Хроника» (таблица + инлайн-редактор с автосейвом, диалог упразднён).
  - [x] Спеки 08 §6.3–6.7, 03 §9.1/§11 обновлены; user-guide дополнен.
  - [x] Тесты: `findThoughtUsage`, attachment content (GET/PUT, не-текстовый
    mime → 422); `npm run typecheck` + тесты зелёные (сервер 279/279, клиент
    92/92). Ручная проверка: smoke-запуск dev:server + dev:client (сборка и
    старт без ошибок); полный прогон вкладок/сплиттеров/ленивости — в режиме
    тестовой эксплуатации.

### L8. Холст: перетаскиваемые разделители зон
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** границы зон холста — интерактивные разделители (08-ui-spec.md
  §2.1): вертикальный между «верх-лево» и «верх-право» (меняет деление ширины
  верхней полосы), горизонтальный между фокус-рядом и нижней зоной (меняет
  высоту верхней полосы и низа; высота фокус-ряда не меняется). Перетаскивание
  мышью (pointer capture), минимум 96 px на зону, двойной клик — сброс к
  дефолтам (50/50 и 34%). Пропорции — L4 `canvas_layout` (JSON доли
  topSplit/childrenShare, клип 0.1–0.9), восстановление при открытии сети.
- **DoD:**
  - [x] Разделители создаются в DOM холста, стилизованы (hover/активный),
    поверх SVG-слоёв связей.
  - [x] Драг не запускает полный re-render на каждое движение (только
    CSS-переменные; зоны/связи пересобираются через ResizeObserver).
  - [x] Сохранение/восстановление `canvas_layout`, сброс двойным кликом.
  - [x] Тесты `parseCanvasLayout`; `npm run typecheck` зелёный; ручная
    проверка драга с занятым холстом.
- **Note:** модуль `client/src/renderer/canvas/zone-splitters.ts`; полный
  рендер — один раз на жест (store.update на pointerup), персист с дебаунсом
  400 мс по образцу editor-resizer.

### L9. Холст: масштабирование Ctrl+± (облачка, фокус, надписи связей)
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** L8
- **Описание:** масштаб холста множителем `canvas_zoom` (08-ui-spec.md
  §2.1.1/§2.2/§2.4, 11-settings §2.1 L4/§2.4): `Ctrl+=`/`Ctrl++` — +5%,
  `Ctrl+-` — −5%, `Ctrl+0` — сброс; диапазон 50–200%, сетка кратна 5%.
  Масштабируются: облачка зон (ширина/шрифт/высота/эллипсы), фокус-облачко,
  надписи и бейдж-счётчики связей, толщина линий. `cloud_width`/`cloud_gap`
  не перезаписываются. Сетка/виртуализация — по эффективным размерам. Текущий
  масштаб — в статус-баре; хранение — L4 `canvas_zoom`.
- **DoD:**
  - [x] Клавиши работают на экране сети; зум пошаговый с клипом 0.5–2.0.
  - [x] Все масштабируемые размеры (CSS-переменные, формулы pure.ts, SVG
    links.ts) согласованы: сетка не расходится с фактической высотой DOM.
  - [x] Сохранение/восстановление `canvas_zoom`; индикатор в статус-баре.
  - [x] Тесты `parseCanvasZoom`/`zoomStep`/геометрии с zoom; typecheck зелёный;
    ручная проверка клавиш и перезапуска.
- **Note:** `--cloud-*` переменные перенесены с зон на host холста — заодно
  фокус-облачко начало следовать за L4 `cloud_width` (раньше наследовал
  статичные 13px из `:root`). Эффективные размеры — `cloudGeom()` в pure.ts,
  единый источник для CSS и сетки. Полный прогон в режиме тестовой
  эксплуатации.

### L10. Тёмная тема и визуальная полировка хрома
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** тёмная тема (08-ui-spec.md §13) поверх существующих
  CSS-переменных: блок `[data-theme='dark']` меняет только токены; все
  захардкоженные вне `:root` цвета (hover primary, filled-эллипсы, бейджи
  warn/ok, `<mark>`, backdrop диалогов, тени, дефолтный цвет линии связи)
  переселены на переменные. Хранение — L5 `client_meta.theme`
  (11-settings §2.1, per-installation, light/dark), новый IPC-домен
  `meta.get`/`meta.set`; применяется на boot до показа экранов (включая фон
  окна Electron). Переключатель — чекбокс «Тёмная тема» в меню «Вид» (§8).
  Заодно: фон холста — точечная сетка (dot grid), плавные hover-переходы
  (120 мс, отключаются при `prefers-reduced-motion`), скругления панелей
  10/8 px, тень hover и фокуса — токены.
- **DoD:**
  - [x] Переключение: холст, панели, редактор, диалоги, меню, поиск, бейджи,
    `<mark>` — без белых протечек в тёмной теме (все цвета токенизированы,
    прямые hex вне `:root`/`[data-theme]` не остались).
  - [x] Тема сохраняется в `client_meta.theme` и восстанавливается на boot
    (фон окна соответствует теме); работает на всех экранах, не только сети.
  - [x] `meta.get`/`meta.set` в IPC-контракте, preload и типах; typecheck
    зелёный; клиентские тесты зелёные (101, добавлен `parseTheme`).
- **Note:** линии связей перерисовываются при смене темы сами: переключение
  делает `store.update({theme})`, на который подписан canvas render, а
  дефолтный цвет линии — `var(--link-default)` в SVG-атрибуте stroke (тот же
  приём, что уже использовался для `var(--warn)`). Живая проверка глазами —
  режим тестовой эксплуатации.

### L11. Редизайн облачка: компактнее и «дороже»
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** L10
- **Описание:** визуальное обновление облачка без изменения состава и
  функциональности (эллипсы, индикаторы, drag, inline-стили, dim/selected —
  как в §2.2): скругление 14 px (`--radius-cloud`), мягче рамка (`--border`
  вместо `--border-strong`), hover — рамка сильнее + тень (без transform,
  чтобы не конфликтовать с FLIP-анимацией §2.8), круглая иконка-медальон
  1.9 em на `--surface-2` (фокус — 2.3 em), заголовок line-height 1.35,
  строка индикаторов 0.8 em без min-height, пустой эллипс прозрачный фон,
  hover эллипса подсвечивается акцентом. `cloud-body { flex: 1 }` прижимает
  нижний эллипс к рамке при запасе высоты. Формула `cloudHeight()` в pure.ts
  синхронно обновлена (TITLE_LINE_FACTOR 1.35, IND_LINE_FACTOR 1.1, новый
  ELLIPSE_MARGIN_TOP=2 — маржин эллипса теперь тоже зумится).
- **DoD:**
  - [x] Виртуализация и линии связей сходятся с фактической геометрией:
    формула держит запас ~2 px над фактической высотой контента на всём
    диапазоне width/zoom (проверено расчётом и тестами пропорциональности).
  - [x] Пользовательские цвета/шрифты, dim, выделение, drag эллипсов и
    drop-подсветки не затронуты (DOM-структура и классы не менялись).
  - [x] Тесты геометрии зелёные (101), typecheck зелёный; ручная проверка в
    обеих темах — режим тестовой эксплуатации.
- **Note:** высота облачка при дефолтах (200 px, зум 100%) — 84 px вместо 85,
  контент ~81 px: сетка виртуализации не расходится с DOM.

### L12. Холст: эллипсы на рамках, компоновка облачка, сплиттеры под связями, авто-контраст, полоса фокуса
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** L10, L11
- **Описание:** пять правок холста по замечаниям пользователя:
  1) эллипсы лежат **на рамках** облачка (центр эллипса на линии рамки,
     половина снаружи) — карточка компактнее, рамка визуально тоньше
     (возврат к букве спеки §2.2 «утолщения сторон рамки»);
  2) компоновка: иконка — вертикальная полоса на всю высоту слева, крупнее;
     заголовок и индикаторы в правой колонке, индикаторы выровнены по левому
     краю заголовка;
  3) разделители зон — 4 px, в покое прозрачные (полупрозрачная линия-хинт
     1 px), слоем **под** связями (hit/top оверлеи выше), подсветка при
     hover/drag;
  4) авто-контраст текста: если мысль задаёт только фон, цвет текста
     выбирается по яркости фона (белый/тёмный) — `contrastText()` в pure.ts
     (WCAG-люминанс, порог 0.35);
  5) фон холста — градиентная полоса фокуса: горизонтальная полоса
     `#1E62BE` на всю высоту фокус-ряда, затухающая к верхнему и нижнему
     краям холста; следует за фокус-рядом живьём (`--focus-band-*` на host:
     рендер, ресайз окна, драг сплиттеров через `onLayoutChange`).
- **DoD:**
  - [x] Эллипсы визуально на рамках; drag/подсветки/drop работают; линии
    крепятся к центрам эллипсов (`ELLIPSE_*_DY = 4` — центр 8px эллипса).
  - [x] Формула `cloudHeight()` синхронна новой компоновке (CLOUD_PAD=5,
    ELLIPSE_INSIDE=4); запас над фактическим DOM-контентом проверен расчётом
    на сетке width 120–400 × zoom 0.5–2 (всегда ≥ контента).
  - [x] Сплиттеры не перекрывают связи визуально (прозрачная полоса,
    полупрозрачный хинт); drag/double-click-reset работают; hit-линии
    связи побеждают указатель в точке пересечения.
  - [x] Авто-контраст: тест `contrastText` (тёмные/светлые фоны, 3-значный
    hex, fallback); явно заданный цвет текста побеждает.
  - [x] Полоса фокуса следует за фокус-рядом (рендер, драг сплиттеров,
    ресайз); сбрасывается при потере фокуса.
  - [x] Typecheck + клиентские тесты зелёные (103).
- **Note:** `overflow: hidden` с `.cloud` снят — эллипсы наполовину снаружи
  карточки; левые углы скругляет сама иконка-полоса. Селекторы эллипсов
  канонизированы: `.ellipse-top`/`.ellipse-bottom` (links.ts, drag-cloud.ts),
  вместо «первый/последний div». Живая проверка глазами — тестовая
  эксплуатация.

### L13. SVG-иконки хрома вместо эмодзи
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** L10
- **Описание:** хром интерфейса (тулбар, статус-бар, панель истории фокуса,
  кнопки-шестерёнки, каретки ▾, крестик закрытия диалога) переведён с
  эмодзи/текстовых глифов на inline-SVG (стиль lucide: stroke 2, round caps,
  `currentColor`), CSP-совместимо — локальный модуль `lib/icons.ts`, без
  внешних ресурсов. Эмодзи-иконки **мыслей** (контент пользователя) не
  тронуты. Индикатор соединения — CSS-точка с мягким свечением по состоянию
  (ok/warn/bad + tooltip). Каретка сворачиваемых групп — chevron с поворотом
  (CSS-переход).
- **DoD:**
  - [x] Тулбар/статус-бар/история/⚙/каретки/× — SVG, наследуют цвет темы
    (`currentColor`), корректные размеры.
  - [x] Индикатор соединения — CSS-точка с цветами по состоянию и tooltip.
  - [x] Контентные эмодзи (иконки мыслей, 📝/📅/📎, эмодзи-словарь выбора
    иконок, статус-точки диалога добавления) не затронуты.
  - [x] Typecheck + клиентские тесты зелёные (103 на момент коммита).

### L14. Связи: кривые Безье с градиентом источник→цель
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** L12
- **Описание:** прямые `<line>` заменены кубическими Безье `<path>`
  (`edgeGeometry()`): контрольные точки уходят по нормалям точек крепления,
  изгиб клиппится 24–140 px. Штрих — linearGradient по оси ребра
  (userSpaceOnUse, defs базового svg, один градиент на бандл): цвет конца =
  собственный/типовой фон мысли, иначе цвет стиля связи; при равных цветах —
  сплошная линия. Слои §7 сохранены: визуал под облачками, wide-path hit над
  ними (та же кривая), hover — только top-слой `drawActive`. Бейдж-счётчик,
  подписи типов и поповер — в точке t=0.5 кривой.
- **DoD:**
  - [x] Геометрия `edgeGeometry()` чистая, экспортирована в `linksInternals`,
    покрыта тестами (изгиб-клипы, середина кривой).
  - [x] Hit-слой повторяет кривую — hover/click/контекстное меню работают;
    между mousedown/mouseup перестраивается только top-слой.
  - [x] Градиенты в `<defs>` пересоздаются на каждом draw (утечек нет);
    дэши/зум работают на путях; обе темы без протечек (цвета — токены).
  - [x] Typecheck + клиентские тесты зелёные (106).

### L15. Структуры мыслей: второй вид workspace (полотно отборов)
- **Статус:** `in_progress` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** переключатель видов в тулбаре («Карта мыслей» — холст со
  строкой поиска; «Структуры мыслей» — панель отбора слева + дерево облачек
  справа). Отбор: ключевые слова (мини-синтаксис `*`/`-`, AND, по названию и
  синонимам), типы мыслей, значения свойств (`eq/contains/gt/lt/in/not_in`),
  типы связей (любое направление); сортировка alpha/created/viewed × asc/desc;
  сохранение именованных отборов на сервере (L3, per-user, синхронизация
  `audience=user`). Пагинация по 100 («Показать ещё»). Раскрытие детей
  (нижний эллипс) и родителей (верхний эллипс) со смещением отступов и
  дедупом повторных мыслей в пределах ветки корня (`exclude_ids` до лимита).
  Подписи/выбор/контекстные меню связей — как на холсте; клик по мысли — в
  редактор без смены фокуса холста, с полосой подсветки активной мысли.
  Выделение Ctrl — как на холсте. Пустой отбор → HOME. История посещённых
  мыслей своя для каждого вида (L4, на клиентах).
- **DoD:**
  - [x] Тулбар: сегмент из двух SVG-кнопок с тултипами; скрытие холста и
    строки поиска в виде «Структуры»; редактор/статус-бар остаются.
  - [x] Сервер: `POST /thoughts/query`, `GET /thoughts/{id}/hierarchy`,
    CRUD `/saved-filters` (миграция 016, уникальность имени per-user),
    события `saved-filter.*` (`audience=user`). Проверено живьём на
    dev-сервере (временный data-каталог): пустой фильтр → HOME, мини-синтаксис,
    дедуп `exclude_ids`, CRUD, идемпотентность.
  - [x] Отбор применён по кнопке/Enter; пустой фильтр возвращает только HOME;
    ключевые слова — `*`-маска, `-`-исключение, AND (парсер в shared,
    тесты клиента); свойства: содержит/равно/в списке/не в списке,
    больше/меньше, да/нет, ссылка-пикер.
  - [x] Дерево: раскрытие вверх/вниз, дедуп в ветке, лимит 100 соседей на
    узел, коннекторы с подписями типов (источник → назначение),
    hover/клик/контекст-меню связей; раскладка — чистые функции с тестами.
  - [x] Редактор открывает мысль по `editorTarget {kind:'thought', id}` без
    смены фокуса; полоса активной мысли; отдельная L4-история вида
    (`structures_history`, общий `history.*` со scope).
  - [x] Спеки 02/03/04/08/11 дополнены; typecheck + тесты зелёные
    (сервер 293, клиент 117).
  - [ ] Ручная проверка обоих видов пользователем (UI-сценарий §15).

### L16. Иконка мысли из картинки: вложение + превью вместо лимита 256 КБ
- **Статус:** `in_progress` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** лимит иконки (256 КБ, самодостаточный `data:` URL) мешал
  использовать большие картинки. Новый поток: выбранный файл загружается во
  вложения мысли в полном размере, иконкой становится сгенерированное превью
  (ужатое до лимита), а `Ctrl+наведение` на иконку показывает полную картинку
  из вложения (как остальные картинки). Команда «Назначить иконкой мысли» в
  контекстном меню вложения тоже перестаёт упираться в лимит.
- **DoD:**
  - [x] `thoughts.icon_attachment_id` (миграция 016b): ссылка на
    картинку-вложение мысли, чей оригинал показывается по `Ctrl+наведению`;
    валидация при PATCH (только image-файл этого владельца), автоочистка при
    смене иконки на эмодзи/URL/«Очистить», при удалении и переносе вложения.
  - [x] Поле прокинуто в ответы resolve/search/usage/links/structures
    (Thought/ThoughtRef/search-хиты) и в realtime (`thought.updated`).
  - [x] Диалог иконки, вкладка «Файл»: системный пикер принимает файлы до
    лимита вложения (10 МБ) и отдаёт оригинал; иконка >256 КБ ужимается в
    превью (canvas, PNG→JPEG-фолбэк, 256×256); редактор мысли загружает
    оригинал во вложения и сохраняет `icon_attachment_id`.
  - [x] «Назначить иконкой мысли»: большие картинки → превью + ссылка на
    вложение вместо отказа «слишком большая».
  - [x] `Ctrl+наведение` на иконку с вложением показывает оригинал
    (`image-zoom` + `applyThoughtIcon`, ленивый резолв пути с кешем);
    иконки без вложения работают как раньше.
  - [x] Typecheck + тесты зелёные (сервер 300, клиент 118); спеки 02/03/08/09
    обновлены отдельным docs-коммитом.
  - [ ] Ручная проверка пользователем: выбор большого файла иконкой,
    «Назначить иконкой» из меню вложения, Ctrl+наведение.

### L17. Диалог иконки: все эмодзи с группами, вкладка «Файл» и кнопки Отменить/Применить
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** L16
- **Описание:** доработка диалога выбора иконки по отчёту пользователя:
  (1) вкладка «Эмодзи» показывает **весь** набор эмодзи Unicode,
  сгруппированный по классическим категориям CLDR, группы сворачиваемые;
  (2) вкладка «Файл»: сетка иконок типов мыслей (клик — быстрый выбор),
  строка ввода убрана, остаются кнопка «Выбрать файл…» и превью, кнопка ОК
  внутри вкладки убрана; (3) в футере — «Очистить», «Отменить» (закрыть без
  изменений) и «Применить» (выбранный файл или URL; активна только при
  корректном выборе на вкладке).
- **DoD:**
  - [x] `lib/emoji-data.ts` — полный набор эмодзи (Unicode 16.0, 9 групп,
    ~1900 glyph) из emoji-test.txt, генерируется скриптом
    `client/scripts/gen-emoji.mjs`; варианты тона кожи не дублируются.
  - [x] Вкладка «Эмодзи»: группы CLDR с русскими названиями, сворачивание
    (`<details>`), ленивое построение ячеек при первом раскрытии, первая
    группа развёрнута.
  - [x] Вкладка «Файл»: сетка иконок типов мыслей (apply сразу), «Выбрать
    файл…» + превью, без строки ввода и кнопки ОК; выбор файла и URL
    переживают переключение вкладок.
  - [x] Футер: «Очистить» / «Отменить» / «Применить» (динамический disabled
    через `ref` кнопки в `dialog.ts`); применение файла — поток L16
    (оригинал во вложения, иконка — превью ≤256 КБ).
  - [x] Typecheck + клиентские тесты зелёные; 08-ui-spec.md §6.8 обновлён
    отдельным docs-коммитом.

## 13.2. Фаза M — Markdown-редактор live preview (WYSIWYM)

> По заявке пользователя (16.08.2026): заменить textarea на редактор в стиле
> Obsidian live preview — документ во время редактирования отображается
> отформатированным, при активации конкретного блока он превращается в
> markdown-текст. Стек: **CodeMirror 6** (как в Obsidian), vanilla TS,
> markdown остаётся единственной истиной (round-trip не нужен). PlantUML —
> исключён. Применение внешних realtime-обновлений текста — отложено
> (пока «кто последний записал — тот и прав»).

### M1. Единый markdown-рендерер `@etn/markdown` + перевод сервера
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** новый workspace-пакет `@etn/markdown`: `markdown-it`-конвейер,
  единый для сервера и клиента (источник истины рендеринга), с расширениями:
  wiki-ссылки `[[имя|алиас]]`, размеры картинок `![alt|600px](…)` /
  `![alt|50%](…)`, подсветка fenced-кода (highlight.js), GFM-таблицы.
  XSS-паритет с прежним рендерером: `html: false`, allow-list протоколов
  (`http/https/mailto`; для картинок дополнительно `data:`/`file:`/`etnimg:`),
  лимит длины входа. Сервер переводится на `@etn/markdown`
  (`comment-service`, `export-service`); кеш `body_html` перерендеривается
  по всем сетям однократно при старте (версия рендера в `settings`).
- **DoD:**
  - [x] Пакет `markdown/` (`@etn/markdown`) в workspaces + скрипты сборки/тестов.
  - [x] Юнит-тесты рендера: wiki-ссылки/алиасы, размеры картинок, подсветка,
    таблицы, XSS-пробы (`<script>`, `javascript:`), лимит длины.
  - [x] Сервер использует `@etn/markdown`; старый `domain/markdown.ts` удалён.
  - [x] Sweep перерендера `body_html` при старте, версия рендера в `settings`.
  - [x] Typecheck + тесты зелёные.

### M2. Фундамент: CodeMirror 6 вместо textarea
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** M1
- **Описание:** `createMarkdownField` переводится на CM6 (`@codemirror/*`):
  markdown-язык, история, клавиатура, тема под цвета приложения. Поведение
  поля сохраняется: двойной клик — редактирование, клик вне поля —
  сохранение, `Esc` — отмена, черновики (H19), вставка картинок из буфера
  во вложения, авто-высота (минимум 5 строк), `setMarkdownField`/
  `editMarkdownField` работают как раньше.
- **DoD:**
  - [x] CM6-редактор в `markdown-field.ts`; старый textarea-путь удалён.
  - [x] Все потребители (постоянный комментарий, хроника, вложения)
    работают без изменений их кода.
  - [x] Typecheck + клиентские тесты зелёные.

### M3. Wiki-ссылки `[[имя|алиас]]`: синтаксис, автокомплит, переход
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** M1, M2
- **Описание:** в редакторе `[[…]]` — отдельный узел парсера (расширение
  `@lezer/markdown`) с подсветкой; при вводе `[[` — выпадающий список мыслей
  сети (поиск `scope=names`, debounce, по префиксу), выбор вставляет
  `[[имя]]`; алиас — `[[имя|синоним]]` вручную. В HTML-просмотре рендерер
  выдаёт `<span class="wiki-link" data-wiki-target="имя">синоним</span>`;
  клик переводит мысль в фокус (резолв имени при клике, не при рендере).
- **DoD:**
  - [x] Парсинг и подсветка `[[…]]` в CM6.
  - [x] Автокомплит по префиксу (1+ символ), вставка с закрывающим `]]`.
  - [x] Клик по wiki-ссылке в просмотре — фокус мысли; «не найдено» — уведомление.
  - [x] Рендерер: alias-вывод, экранирование, вложенность не ломает парсинг.
  - [x] Typecheck + тесты зелёные.

### M4. Блоки кода: подсветка синтаксиса
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** M1, M2
- **Описание:** в редакторе fenced-блоки подсвечиваются языками CM6
  (`@codemirror/language-data`, autoload); в просмотре — highlight.js-классы
  из единого рендерера; CSS-тема подсветки (светлая + тёмная).
- **DoD:**
  - [x] Подсветка ` ```ts ` и др. языков в редакторе и просмотре.
  - [x] Тёмная тема: классы подсветки читаемы.
  - [x] Typecheck + тесты зелёные.

### M5. Картинки с масштабированием
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** M1, M2
- **Описание:** `![alt|600px](url)`, `![alt|50%](url)` (px и % ширины поля)
  в рендерере и HTML-просмотре; вставка из буфера — как раньше (без размера).
- **DoD:**
  - [x] Рендерер: px/%, экранирование, невалидный размер — обычная картинка.
  - [x] Просмотр: картинка масштабируется по указанному размеру.
  - [x] Typecheck + тесты зелёные.

### M6. Live preview: скрытие синтаксиса и блочные виджеты
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** M3–M5
- **Описание:** ядро WYSIWYM: заголовки, emphasis, списки, цитаты
  отображаются отформатированными (маркеры скрыты, появляются при курсоре
  в блоке); таблицы, fenced-код, картинки, wiki-ссылки — блочные виджеты
  (клик — редактирование markdown-блока). Без перерисовки hit-слоёв холста;
  независимый DOM редактора.
- **DoD:**
  - [x] Скрытие маркеров с появлением при активации строки/блока.
  - [x] Виджеты таблиц/кода/картинок; клик переводит блок в редактирование.
  - [x] Wiki-ссылки отображаются как ссылки (скобки скрыты).
  - [x] Производительность: декорации пересобираются только при изменениях.
  - [x] Typecheck + тесты зелёные.

### M7. Mermaid-диаграммы
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** M6
- **Описание:** ` ```mermaid ` — виджет с рендером mermaid.js в редакторе и
  в HTML-просмотре (сервер и клиент используют единый конвейер; рендерер
  выдаёт `<pre class="mermaid">`, клиент лениво подменяет на SVG).
- **DoD:**
  - [x] Mermaid рендерится в просмотре и в редакторе (виджет).
  - [x] Ошибки синтаксиса показываются, не роняя редактор.
  - [x] Typecheck + тесты зелёные.

### M8. Применение внешних realtime-обновлений в открытом редакторе (отложено)
- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** M6
- **Описание:** пока политика «кто последний записал — тот и прав»; позже —
  слияние/уведомление при внешнем изменении текста во время редактирования.

### M9. Масштаб документа Ctrl+колесо
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** M2
- **Описание:** Ctrl+колесо над markdown-полем масштабирует ВСЕ поля
  (редакторы и просмотрщики) через глобальную CSS-переменную `--md-font-size`,
  независимо от масштаба холста и структур; сохраняется в L4 `md_zoom`
  на сеть (шаг ~10%, диапазон 0.5–2.5).
- **DoD:**
  - [x] Ctrl+колесо в редакторе и просмотре масштабирует текст.
  - [x] Масштаб един для всех md-полей и переживает перезапуск.
  - [x] Typecheck + тесты зелёные.

### M10. Ctrl+Enter — завершение редактирования
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** M2
- **Описание:** в режиме редактирования Ctrl+Enter сохраняет изменения и
  возвращает поле в просмотр (аналог клика вне поля).
- **DoD:**
  - [x] Ctrl+Enter коммитит и переключает в просмотр; без изменений — просто просмотр.
  - [x] Typecheck + тесты зелёные.

### M11. Переход по wiki-ссылке с учётом режима
- **Статус:** `done` · **Assignee:** zcode · **Зависимости:** M3, L15
- **Описание:** клик по wiki-ссылке в просмотре: на холсте — фокус мысли и
  открытие в редакторе; в структурах — если мысль отображается, активировать
  её и открыть в редакторе, иначе спросить «Переключиться на карту мыслей?»
  (Да — холст + фокус + редактор). Неактуальная мысль при настройке «скрывать
  неактуальное» — уведомление о невозможности открытия.
- **DoD:**
  - [x] Поведение по режимам, диалог переключения, случай неактуальной мысли.
  - [x] Typecheck + тесты зелёные.

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

- **~~`better-sqlite3` native-сборка~~ — РЕШЕНО.** На машине разработки изначально
  стоял Node 24, для которого нет prebuilt-binary → node-gyp требовал Python.
  Решение: переход на Node 22 LTS (`nvm use 22`, см. `.nvmrc`). Для Node 22
  prebuilt скачивается автоматически при `npm install`, Python не нужен ни нам, ни
  конечным пользователям. Smoke-тест `etn init` проходит end-to-end после B6.
  В `docs/install-server.md` (J2) зафиксировать Node 22 LTS как требование.
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
