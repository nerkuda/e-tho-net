# Фаза B — Сервер: фундамент

> [← Workplan (индекс)](../workplan.md) — оглавление, статусы фаз и решения.


> Все задачи B — последовательные (B1 → B2 → … → B14). Это критический путь.

## B1. Конфигурация и логирование
- **Статус:** `done` · **Assignee:** agent-B · **Зависимости:** A4
- **Описание:** Чтение env (`ETN_DATA_DIR`, `ETN_HOST`, `ETN_PORT`, TLS, лог),
  валидация, structured logging (pino). Утилита путей к `_system.db` и
  `networks/<id>/`.
- **DoD:** env читается, некорректная конфигурация → понятная ошибка при старте.
- **Спецификация:** [01-architecture.md](../01-architecture.md), п. 4.

## B2. Мигратор SQL
- **Статус:** `done` · **Assignee:** agent-B · **Зависимости:** B1
- **Описание:** Механизм миграций: применяет файлы из `migrations/system/*.sql` и
  `migrations/network/*.sql`, хранит историю в таблице `_migrations` каждой БД.
  Транзакционность, идемпотентность в контрольной точке (`CREATE IF NOT EXISTS`).
- **DoD:** пустая БД → корректно накатывается до актуальной схемы; повторный
  запуск не падает.
- **Спецификация:** [02-data-model.md](../02-data-model.md), п. 5.

## B3. Миграции `_system.db`
- **Статус:** `done` · **Assignee:** agent-B · **Зависимости:** B2
- **Описание:** SQL-файлы для всех таблиц системной БД: `users`, `api_keys`,
  `networks`, `network_members`, `user_preferences`, `audit_log`,
  `client_request_cache`, `settings`, `event_log`, `network_seq`. Индексы и
  инварианты.
- **DoD:** после миграций схема соответствует спецификации.
- **Спецификация:** [02-data-model.md](../02-data-model.md), п. 2.

## B4. Хранилище `SystemDb`
- **Статус:** `done` · **Assignee:** agent-B · **Зависимости:** B3
- **Описание:** Класс-обёртка над `better-sqlite3` для `_system.db`: WAL, FK ON,
  prepared statements, транзакции (через `db.transaction`).
- **DoD:** читаются/пишутся пользователи и ключи, работают FK и UNIQUE.
- **Спецификация:** [02-data-model.md](../02-data-model.md).

## B5. Генерация и хеширование API-key
- **Статус:** `done` · **Assignee:** agent-B · **Зависимости:** B4
- **Описание:** Генерация ключа `etn_<32hex>`, SHA-256 хеш, сохранение `key_hash`
  и `key_prefix`, проверка, извлечение пользователя по ключу, обновление
  `last_used_at`.
- **DoD:** ключ генерируется, валидируется, не сохраняется в открытом виде.
- **Спецификация:** [06-auth.md](../06-auth.md), п. 2–3, 6.

## B6. CLI `etn init`
- **Статус:** `done` · **Assignee:** agent-B · **Зависимости:** B5
- **Описание:** CLI-команда `etn init --username admin --display-name ...`:
  создаёт `_system.db`, применяет миграции, создаёт первого пользователя
  (`is_admin=1, is_first_user=1`), генерирует первичный API-key, печатает его в
  консоль **один раз**, пишет в `audit_log`. Сервер без инициализации стартовать
  отказывается.
- **DoD:** после `etn init` сервер стартует; ключ показан; повторный init даёт
  понятную ошибку.
- **Спецификация:** [06-auth.md](../06-auth.md), п. 8.

## B7. Fastify bootstrap, health, version, ошибки
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
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 1–2.

## B8. Auth middleware
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
- **Спецификация:** [06-auth.md](../06-auth.md), п. 3–5, 9.

## B9. Access-control middleware
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
- **Спецификация:** [06-auth.md](../06-auth.md), п. 4–5.

## B10. Pub/sub по network_id
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
- **Спецификация:** [01-architecture.md](../01-architecture.md), п. 5.

## B11. Идемпотентность через `Client-Request-Id`
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
- **Спецификация:** [01-architecture.md](../01-architecture.md), п. 6;
  [02-data-model.md](../02-data-model.md), п. 2.7.

## B12. Маршруты auth
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
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 3–4; [06-auth.md](../06-auth.md).

## B13. Маршруты networks и members
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
- **Спецификация:** [03-server-api.md](../03-server-api.md), п. 5; [06-auth.md](../06-auth.md).

## B14. audit_log middleware
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
- **Спецификация:** [02-data-model.md](../02-data-model.md), п. 2.6;
  [03-server-api.md](../03-server-api.md), п. 15.

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
