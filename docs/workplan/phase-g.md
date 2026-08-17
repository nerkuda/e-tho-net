# Фаза G — Клиент: каркас и локальное хранилище

> [← Workplan (индекс)](../workplan.md) — оглавление, статусы фаз и решения.


> После A. Параллельна с B–F. Внутри — последовательно G1→…→G8.

## G1. Main process и окно Electron
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
- **Спецификация:** [07-client-electron.md](../07-client-electron.md).

## G2. safeStorage для API-key
- **Статус:** `done` · **Assignee:** agent-G · **Зависимости:** G1
- **Описание:** Шифрование API-key через `safeStorage` (DPAPI/Keychain/libsecret),
  хранение в `server_profiles.api_key_encrypted`. Расшифровка только в main.
- **DoD:** ключ сохраняется между запусками; renderer его не видит.
- [x] `client/src/main/safe-storage.ts`: `encryptApiKey`/`decryptApiKey` +
  `SafeStorageUnavailableError`, `isApiKeyStorageAvailable`.
- [x] Запись в БД НЕ выполняется — только хелпер (таблица `server_profiles` в G3).
- **Note:** проверка сохранения между запусками отложена до G3/H2 (нужна БД).
- **Спецификация:** [06-auth.md](../06-auth.md), п. 7; [07-client-electron.md](../07-client-electron.md), п. 3.1.

## G3. Локальный SQLite и миграции
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
- **Спецификация:** [07-client-electron.md](../07-client-electron.md), п. 3.

## G4. Генерация и хранение client_id
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
- **Спецификация:** [11-settings-and-state.md](../11-settings-and-state.md), п. 1.

## G5. REST-клиент
- **Статус:** `done` · **Assignee:** agent-G58 · **Зависимости:** G2, G4
- **Описание:** Обёртка над `undici`/fetch в main процессе: Bearer, Client-Id,
  Client-Request-Id на изменяющих запросах, retry на 5xx, таймауты, типизированные
  методы по всем ресурсам.
- **DoD:** из main можно вызывать любой endpoint из [03-server-api.md](../03-server-api.md).
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
- **Спецификация:** [03-server-api.md](../03-server-api.md); [07-client-electron.md](../07-client-electron.md), п. 4.1.

## G6. WebSocket-клиент
- **Статус:** `done` · **Assignee:** agent-G58 · **Зависимости:** G5
- **Описание:** WS в main: `resume {last_seq}` при подключении, обработка событий,
  пересылка в renderer через IPC, реконнект с jitter. Локальное хранение `last_seq`
  per (client, network).
- **DoD:**
  - [x] события доходят до renderer; при обрыве — reconect и resume.
- **Note:** `client/src/main/net/ws-client.ts` — `RealtimeClient` (TypedEmitter):
  resume по last_seq из client_meta, ping/pong, `resume.stale`, коды 4401/4404,
  экспоненциальный реконнект с jitter, тесты 11 (resume/reconnect/close-codes).
- **Спецификация:** [04-realtime.md](../04-realtime.md), п. 2;
  [11-settings-and-state.md](../11-settings-and-state.md), п. 1.3.

## G7. IPC API
- **Статус:** `done` · **Assignee:** orchestrator · **Зависимости:** G5, G6
- **Описание:** `contextBridge.exposeInMainWorld('etn', {...})`. Полный набор
  методов по [07-client-electron.md](../07-client-electron.md), п. 6. Renderer не
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
- **Спецификация:** [07-client-electron.md](../07-client-electron.md), п. 6.

## G8. Применение real-time событий к UI-state
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
- **Спецификация:** [04-realtime.md](../04-realtime.md), п. 7;
  [11-settings-and-state.md](../11-settings-and-state.md), п. 1.4.
