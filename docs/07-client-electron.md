# 07. Десктоп-клиент (Electron)

## 1. Назначение и ограничения

- Десктоп-клиент — единственный клиент MVP.
- **Онлайн-only.** Работает только при связи с сервером. Локально хранит
  персональные настройки, UI-state и черновики правок.
- Все запросы к данным идут на сервер; локальный SQLite — для персонального
  состояния и кэша, **не для авторитетных данных**.

## 2. Структура процесса

```
┌─────────────────────────────────────────────────────────────────┐
│ Main process (Node.js, Electron)                                │
│                                                                 │
│  ┌──────────────┐ ┌────────────────┐ ┌──────────┐ ┌─────────┐   │
│  │ Network      │ │ Realtime       │ │ Local    │ │ IPC     │   │
│  │ client       │ │ pool           │ │ store    │ │ handlers│   │
│  │ (REST)       │ │ (WS per net)   │ │ (SQLite) │ │         │   │
│  └──────────────┘ └────────────────┘ └──────────┘ └─────────┘   │
│         │                │                │           │         │
│         └────────────────┴────────────────┴───────────┘         │
│                              │                                   │
│                    safeStorage (API-key)                         │
└──────────────────────────────┬──────────────────────────────────┘
                               │ IPC (contextBridge)
┌──────────────────────────────┴──────────────────────────────────┐
│ Renderer process (Chromium)                                     │
│                                                                 │
│  UI: tab-strip │ холст │ редактор │ поиск │ выделения │ диалоги │
│  UI-state: in-memory store (per-active-tab snapshot)            │
│            + подписки на realtime-события (per-active-tab +     │
│            маркер «*» на табах неактивных сетей)                │
└─────────────────────────────────────────────────────────────────┘
```

> **Табы (фаза Q).** В одном окне Electron можно держать несколько
> открытых мыслесетей и несколько табов с одной и той же сетью — см.
> [08-ui-spec.md](08-ui-spec.md) §1. Realtime-клиент в main стал **пулом**
> по сокетам (один WS на сеть), UI-state — снапшот активного таба. Подробности
> в §3.5–§3.6, §4.2, §6.

### 2.1. Разделение ответственности
- **Main:** сетевые операции, локальная БД, хранение ключей, IPC-обработчики,
  пул `RealtimeClient` (см. §4.2). Ключ API в renderer **не попадает**.
- **Renderer:** только UI и UI-state. Все обращения к данным — через IPC
  (например, `window.etn.thoughts.get(id)` → IPC → main → REST). С табами
  renderer держит **список табов** и **id активного**; «текущая сеть» —
  это сеть активного таба; «текущий фокус» — focus активного таба.

## 3. Локальное хранилище

`userData/local.db` — SQLite (better-sqlite3), WAL.

**Каталог профиля (userData).** Весь локальный профиль клиента — `local.db`
(включая `server_profiles` с API-ключами), UI-state, черновики, положение окна —
хранится в каталоге `userData`. По умолчанию: у установленной (packaged)
сборки — `%APPDATA%\@etn\client`, у dev-запуска (electron-vite) — отдельный
`%APPDATA%\@etn-dev`, чтобы разработка никогда не делила профиль с
установленным приложением. Один установленный инстанс можно запускать с
**разными профилями**: каталог профиля задаётся параметром запуска
`--user-data-dir=<path>`:

- собранное приложение:
  `ETN.exe --user-data-dir=C:\etn\profile1`;
- dev (electron-vite): аргументы после `--` передаются в Electron
  (это механизм `ELECTRON_CLI_ARGS`), из каталога `client/`:

  ```
  npm run dev -- -- --user-data-dir=C:\etn\profile1
  ```

  (первый `--` — разделитель npm, второй — разделитель electron-vite; то же
  самое напрямую: `npx electron-vite dev -- --user-data-dir=C:\etn\profile1`).

Относительный путь резолвится от текущего каталога запуска. Без параметра:
packaged-сборка использует общий `%APPDATA%\@etn\client`, dev — свой
`%APPDATA%\@etn-dev`; явный `--user-data-dir` всегда имеет приоритет. Разные
профили полностью изолированы (своя локальная БД, свои серверные профили,
свои настройки окна) и могут работать одновременно: single-instance-блокировка
(см. §7) привязана к `userData`, поэтому два профиля не вытесняют друг друга.
Удаление каталога профиля «сбрасывает» клиент (все локальные настройки и
ключи серверов).

Разбор параметра — `parseUserDataDirArg` в `client/src/main/db/paths.ts`;
main-процесс применяет его через `app.setPath('userData', …)` до
`app.whenReady()` (Electron 31 сам также обрабатывает `--user-data-dir` —
явный разбор даёт единый источник истины для резолва относительных путей).

### 3.1. server_profiles

Подключения к серверам (у пользователя может быть несколько серверов ETN).

| Столбец | Тип |
|---------|-----|
| `id` | TEXT PK (UUID) |
| `label` | TEXT |
| `base_url` | TEXT |
| `api_key_encrypted` | BLOB (через safeStorage) |
| `user_id` | TEXT |
| `is_active` | INTEGER |

API-key шифруется `safeStorage.encryptString(key)` перед записью, расшифровывается
в main-процессе при использовании.

### 3.2. ui_state (персональный UI-state по сети)

| Столбец | Тип | Описание |
|---------|-----|----------|
| `profile_id` | TEXT | Сервер-профиль |
| `network_id` | TEXT | |
| `key` | TEXT | Имя состояния |
| `value` | TEXT | JSON |
| `updated_at` | TEXT | |
| PRIMARY KEY | `(profile_id, network_id, key)` | |

Все значения в этой таблице — уровень **L4 (клиент × пользователь × сеть)** в
классификации [11-settings-and-state.md](11-settings-and-state.md). Серверные
настройки пользователя (`show_inactive`, выбор сортировки фокуса, ручной
порядок) **здесь не хранятся** — они синхронизируются через real-time
(audience=user).

> **Табы (фаза Q).** Состояние, специфичное для конкретного таба (focus,
> view, filter_state), пишется в `ui_state` с суффиксом `:<tab_id>` в
> `key`: `current_focus_thought_id:<tab_id>`,
> `active_view:<tab_id>`, `structures_state:<tab_id>`,
> `chronicle_state:<tab_id>`. Ключи без суффикса остаются для
> обратной совместимости и трактуются как legacy (один таб на сеть).
> См. §3.6 и [08-ui-spec.md](08-ui-spec.md) §1.

Зарезервированные ключи:
- `current_focus_thought_id` — текущий фокус на этом клиенте.
- `current_network_id` — текущая открытая сеть на этом клиенте.
- `cloud_width` — ширина ячейки/облачка холста, px. Клиппится в
  `[CLOUD_WIDTH_MIN, CLOUD_WIDTH_MAX]`. Высота не редактируется (3 строки).
- `cloud_gap` — отступ между ячейками холста, px. Клиппится в
  `[CLOUD_GAP_MIN, CLOUD_GAP_MAX]`.
- `search_state` — последний поисковый запрос (`{ q, scope, options, results }`)
  для восстановления при активации строки поиска.
- `editor_position` — `left`/`right`/`top`/`bottom`/`hidden`.
- `editor_collapsed_groups` — `{ [thoughtId|linkId]: { permanent: bool, chrono: bool, ... } }`.
- `window_layout` — размеры панелей и позиция окна.
- `last_used_link_type_id` — UX-память о выбранном типе связи.

### 3.3. drafts (черновики правок)

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT PK (UUID) |
| `profile_id` | TEXT |
| `network_id` | TEXT |
| `entity_type` | TEXT | `'thought'`/`'link'`/`'comment'`/... |
| `entity_id` | TEXT | |
| `field` | TEXT | Какое поле правится |
| `value` | TEXT | JSON нового значения |
| `base_version` | INTEGER | Версия, на основе которой правится |
| `created_at` | TEXT | |
| `status` | TEXT | `'pending'`/`'sent'`/`'failed'` |

Черновик создаётся, когда пользователь начал редактировать поле, но ещё не
сохранил. Это страховка от потери данных при разрыве связи или закрытии окна.
На ключ `(profile_id, network_id, entity_type, entity_id, field)` существует
уникальный индекс `idx_drafts_one_per_field`: повторное сохранение поля
**обновляет** существующую строку (value, base_version, status, created_at),
а не создаёт новую — промежуточные черновики не накапливаются.

При открытии сущности черновик **не** переводит поле в режим редактирования:
постоянный комментарий и хронологические комментарии всегда открываются в
режиме просмотра (08-ui-spec.md §6.4, §6.6), а правка начинается только по
двойному клику. Черновик остаётся в локальной БД и переотправляется при
восстановлении соединения (п. 5.2); «мёртвые» черновики, текст которых уже
совпал с сохранённым, удаляются при открытии. После **успешного сохранения**
поля (заголовок мысли, постоянный комментарий) удаляются все черновики этого
поля по ключу, а не только последняя известная строка — так debounce, чей id
не успел вернуться к моменту сохранения, тоже не оставляет мусора.

**Восстановление черновика заголовка** (редактор мысли) никогда не затирает
текущее содержимое поля: черновик подставляется, только если поле ещё
содержит сохранённый заголовок (пользователь ничего не печатал) и
`base_version` совпадает с версией мысли. Если версия мысли ушла вперёд —
черновик устарел и остаётся лишь для retry (09-scenarios.md J1); если поле
уже изменено пользователем — черновик удаляется как устаревший.

### 3.4. client_meta (состояние установки, L5)

Уникальное для установки приложения, не зависит от сети/пользователя.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `key` | TEXT PK | Имя |
| `value` | TEXT | JSON или строка |

Зарезервированные ключи:
- `client_id` — UUIDv4 установки. Генерируется один раз при первом запуске;
  передаётся серверу в каждом запросе (`Client-Id`) и при WS-подключении.
- `last_seq` — JSON-объект `{ [network_id]: <seq> }`, позиция в `event_log`
  сети. Обновляется по мере применения пришедших событий. per-client, не per-user
  (см. [11-settings-and-state.md](11-settings-and-state.md), п. 1.3).
- `theme`, `zoom`, `active_profile_id` — UI-настройки установки.

### 3.5. visit_history (история посещения мыслей, L4)

Единая история мыслей, открытых в редакторе на этом клиенте, — общая для
всех видов (карта, структуры, хроника; 0.5.5). Локальное состояние per
`(profile_id, network_id, tab_id)`. См.
[11-settings-and-state.md](11-settings-and-state.md), п. 2.3.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `profile_id` | TEXT NOT NULL | Сервер-профиль |
| `network_id` | TEXT NOT NULL | |
| `tab_id` | TEXT NULL | Идентификатор таба (см. §3.6); `NULL` — legacy-данные до введения табов |
| `thought_id` | TEXT NOT NULL | |
| `seq` | INTEGER NOT NULL | Монотонный счётчик на (profile, network, tab_id); больший = более свежий |
| `visited_at` | TEXT NOT NULL | |
| PRIMARY KEY | `(profile_id, network_id, tab_id, thought_id)` | |

Индекс: `idx_visit_history_seq (profile_id, network_id, tab_id, seq DESC)`.

> **Табы (фаза Q).** PK расширен колонкой `tab_id`; в существующих строках
> `tab_id` остаётся `NULL` — при первом запуске клиента с табами
> автоматически создаётся стартовый таб с `tab_id = 'LEGACY'`, и история
> привязывается к нему (см. §3.6). Для двух табов с одной сетью истории
> независимы — это позволяет вести параллельные контексты в одной сети.

> **Миграция 0.5.5** (`007_unified_visit_history.sql`): таблица
> `focus_history` переименовывается в `visit_history` (строки сохраняются —
> это бывшая история фокуса, становящаяся стартом единой истории); таблицы
> `structures_history` и `chronicle_history` удаляются вместе с индексами —
> это были локальные UI-кэши, их потеря безвредна.

**Алгоритм при открытии мысли в редакторе `oldId → newId`** (в одной
транзакции локально; `?` — `profile_id, network_id, tab_id`). `oldId` —
мысль, открытая в редакторе до перехода; при смене фокуса холста это
прежний фокус, при открытии из «Структур»/«Хроники» — прежняя открытая
мысль. Открытие связи не вызывает операцию (связь — не посещённая мысль):

```sql
-- 1. newId больше не в истории — он открыт в редакторе
DELETE FROM visit_history
  WHERE profile_id = ? AND network_id = ? AND tab_id IS ? AND thought_id = ?;  -- newId

-- 2. oldId — в начало истории (seq — per-tab)
INSERT OR REPLACE INTO visit_history (profile_id, network_id, tab_id, thought_id, seq, visited_at)
  VALUES (?, ?, ?, ?,
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM visit_history
            WHERE profile_id = ? AND network_id = ? AND tab_id IS ?), ?);

-- 3. Trim до 50: удалить всё, что не входит в топ-50 свежих
DELETE FROM visit_history
  WHERE profile_id = ? AND network_id = ? AND tab_id IS ?
    AND seq NOT IN (
      SELECT seq FROM visit_history
        WHERE profile_id = ? AND network_id = ? AND tab_id IS ?
        ORDER BY seq DESC LIMIT 50
    );
```

`oldId = null` (первое открытие в табе, редактор с нуля) → шаг 2 пропускается.
`oldId = newId` (повторное открытие той же мысли) → операция в целом no-op.

**Получение истории:**

```sql
SELECT thought_id FROM visit_history
  WHERE profile_id = ? AND network_id = ? AND tab_id IS ?
  ORDER BY seq DESC LIMIT 50;
```

Возвращает массив `thought_id`. Метаданные облачек клиент докладывает через
`POST /networks/{nid}/thoughts/resolve` ([03-server-api.md](03-server-api.md),
п. 6.10) или берёт из локального кэша мыслей.

**Очистка:** при получении real-time события `thought.deleted` для мысли в
истории — обязательная локальная чистка
(`DELETE FROM visit_history WHERE profile_id=? AND network_id=? AND tab_id IS ? AND thought_id=?`).
Неактуальные (`active=0`) мысли из истории **не** вычищаются — они скрываются на
уровне рендера при выключенном `show_inactive`.

### 3.6. tabs (открытые табы, L4)

Состояние tab-strip клиента (08-ui-spec.md §1). Каждой записи соответствует
один видимый таб; «+» и overflow-элементы — не строки.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `profile_id` | TEXT NOT NULL | Сервер-профиль |
| `tab_id` | TEXT NOT NULL | UUID, стабильный между перезапусками |
| `slot_idx` | INTEGER NOT NULL | Позиция в strip по возрастанию |
| `network_id` | TEXT NOT NULL | Какую сеть открывает таб |
| `focus_id` | TEXT NULL | Текущий focus (или NULL, если ещё не выбран) |
| `view_mode` | TEXT NULL | `'map'` \| `'structures'` \| `'chronicle'` (08-ui-spec.md §15.1) |
| `structures_state` | TEXT NULL | JSON `FilterState` (08-ui-spec.md §15.3) |
| `chronicle_state` | TEXT NULL | JSON `ChronicleFilterState` (08-ui-spec.md §17.7) |
| `layer_id` | TEXT NULL | Слой изменений таба (S11, 13-layers.md §10.3); NULL — основа |
| `last_active_at` | TEXT NOT NULL | ISO-8601 последней активации (для сортировки при необходимости) |
| PRIMARY KEY | `(profile_id, tab_id)` | |

Индекс: `idx_tabs_order (profile_id, slot_idx)`.

**Поведение:**

- Строка создаётся при `etn.tabs.open(networkId)` (см. §6).
- Удаляется при `etn.tabs.close(tabId)` либо при отсутствии ссылки на
  `tab_id` из других таблиц (каскад не нужен — `visit_history`/`ui_state`
  хранят строки с `tab_id`, но потеря orphan-строк допустима: при
  следующем запуске такие табы не появятся, и строки тихо игнорируются).
- При reorder — обновляются только `slot_idx` в одной транзакции
  (метод `reorderTabs(profileId, orderedIds[])`).
- **Слой — свойство таба (S11, 13-layers.md §10.3).** Серверная сессия
  слоёв одна на клиента (ключ `(user_id, client_id)`), поэтому таб хранит
  выбранный слой локально в `layer_id`; при активации таба рендерер
  переключает серверную сессию (`POST …/layers/{id}/select`) и грузит
  список слоёв + перекрытия **до** чтения фокуса — все последующие чтения
  и записи таба идут в его слое. Протухший `layer_id` (слой удалён из
  другого сеанса) ремонтируется сбросом в NULL; серверный control-фрейм
  `layer.deleted` (realtime) делает то же самое живой сессии.
- `focus_id`, `view_mode`, `structures_state`, `chronicle_state` — **не**
  дублируются в `ui_state` для табов, открытых после введения этой
  схемы; пишутся только сюда. Для legacy-таба (`tab_id = 'LEGACY'`)
  значения могут читаться из legacy-ключей `ui_state` (см. §3.2).

**Миграция с legacy:** при первом запуске клиента с табами (если в
`ui_state` есть `current_focus_thought_id`/`active_view`/`structures_state`/
`chronicle_state`, а `tabs` пуста):

1. Создаётся один таб `tab_id = 'LEGACY'`, `slot_idx = 0`,
   `network_id` из `current_network_id` (если есть).
2. Legacy-значения переносятся в строку таба; legacy-ключи `ui_state`
   остаются для чтения в эту же сессию (на случай гонки), но в новых
   записях используются per-tab ключи `:<tab_id>`.

## 4. Сетевой клиент

### 4.1. REST (`netClient`)
- HTTP/HTTPS через `undici` или `electron`'s `net`.
- Автоматически подставляет `Authorization: Bearer <key>`, `Client-Id`,
  `Client-Request-Id` (генерируется на каждый изменяющий запрос).
- Экспоненциальный retry на 5xx и сетевых ошибках (не на 4xx).
- Таймауты: connect 10 с, response 30 с (отдельные — для тяжёлых endpoints).

### 4.2. Realtime (`realtimeClient`)
- WebSocket через `ws` в main-процессе.
- При подключении шлёт `resume { last_seq }` (см. [04-realtime.md](04-realtime.md)).
- События парсятся и пересылаются в renderer через IPC-событие
  `realtime:event`. Renderer применяет к UI-state.
- Автоматический реконнект с jitter.

> **Табы (фаза Q).** Один `RealtimeClient` стал **пулом**:
> `Map<networkId, {client, refCount}>` в `client/src/main/realtime/tab-rt-pool.ts`.
> Сокет поднимается при первом `acquire(networkId)` (например, при открытии
> таба с этой сетью или активации ранее открытого), опускается при
> `refCount → 0` (например, при закрытии последнего таба с этой сетью).
> Серверный контракт «один сокет = одна сеть» сохраняется; см.
> [04-realtime.md](04-realtime.md) §2.0 и [11-settings-and-state.md](11-settings-and-state.md)
> §1.2 — `byClient` уже поддерживает множественные сокеты на одного
> `Client-Id`. `last_seq` остаётся per-network (без изменений в
> `client_meta`).

## 5. Онлайн-only поведение

### 5.1. Индикатор статуса
В строке состояния отображается: `🟢 Подключено`, `🟡 Переподключение…`,
`🔴 Нет связи`. Клиент блокирует UI для изменений в состоянии `🟡/🔴`, но
продолжает показывать последнее полученное состояние (read-only).

### 5.2. Защита правок при разрыве
- Каждое изменение поля через UI сначала пишется в `drafts` со status=`pending`.
- Если сеть доступна — отправляется немедленно, при успехе черновик помечается
  `sent` и удаляется.
- Если сети нет — остаётся `pending`. При восстановлении соединения все
  `pending`-черновики отправляются в порядке создания.
- Если в `drafts.base_version` уже не совпадает с серверной → `409`, показываем
  пользователю конфликт (см. [04-realtime.md](04-realtime.md), п. 8).

### 5.3. Первая загрузка сети
- `GET /networks/{id}` → `POST /thoughts/{focus_id}/focus` → рендер холста.
- Фокус по умолчанию — `last_focus_thought_id` из `thought_views` на сервере.
  Для новой сети — это HOME.

## 6. IPC API (доступный renderer)

Пример контракта (реализуется через `contextBridge.exposeInMainWorld`):

```ts
window.etn = {
  server: {
    listProfiles(),
    connect(profileId),         // проверка ключа + установка realtime
    disconnect(),
    getStatus(): "online"|"reconnecting"|"offline"
  },
  networks: {
    list(),
    get(id), create(name), update(id, fields), delete(id),
    members(id), addMember(id, userId), removeMember(id, userId)
  },
  thoughts: {
    get(networkId, id),
    focus(networkId, id),
    create(networkId, payload),
    update(networkId, id, changes, version),
    delete(networkId, id, version),
    neighbors(networkId, id, dir, opts),
    reorder(networkId, id, payload),
    batch(networkId, op, ids, args),
    search(networkId, query, opts),
    mentions(networkId, id)
  },
  links: { get, create, update, delete, listByThought },
  types: { listThoughtTypes, listLinkTypes, create, update, delete },
  properties: { get, set, delete, listDefinitions },
  comments: { list, create, update, delete },
  attachments: { list, add, update, delete },
  admin: { listUsers, createUser, deleteUser, listKeys, createKey },
  me: { get, listKeys, createKey, deleteKey },
  realtime: {
    onEvent(cb),         // подписка на события в renderer
    onStatusChange(cb),
    onStale(cb), onNetworkLost(cb),
    onLayerControl(cb),  // S11: layer.switched / layer.deleted — полный ресинк
    onSelfMutated(cb)    // S11: своё подавленное эхо (`realtime:selfmut`
                         // {networkId}) — живое обновление перекрытий (08 §2.2)
  },
  tabs: {
    list(): Promise<TabDto[]>,
    open(networkId): Promise<TabDto>,
    activate(tabId): Promise<TabDto | null>,
    close(tabId): Promise<void>,
    reorder(orderedIds: string[]): Promise<void>,
    updateState(tabId, partial: TabStatePatch): Promise<void>,
  },
  layers: {                       // S11, 13-layers.md §10.3 (REST §5a)
    list(networkId), create(networkId, input),
    update(networkId, layerId, changes, expectedVersion?),
    remove(networkId, layerId, cascade?),
    select(networkId, layerId),
    merge(networkId, layerId, tables?),
    diff(networkId, layerId), diffDoc(networkId, layerId),
  },
  ui: {
    getState(networkId, key, tabId?): Promise<string | null>,
    setState(networkId, key, value, tabId?): Promise<void>,
  }
}
```

Все методы асинхронны (`Promise`). Ошибки — стандартизованный `EtnError`
с кодом и деталями.

> **Табы (фаза Q, фаза Q4).** Домен `etn.tabs.*` управляет жизненным
> циклом табов и их состоянием. `tabId` в `etn.ui.*` — опциональный;
> если передан, ключ `ui_state` интерпретируется как
> `key:<tab_id>` (см. §3.2/§3.6). Дополнительные широковещания
> `tabs:dirty {tabId}` (realtime-событие для неактивного таба) и
> `tabs:clean {tabId}` (активация) — для маркера «*».

## 7. Жизненный цикл приложения

1. Запуск → выбор активного профиля (или первоначальная настройка — ввод URL
   сервера + ключ).
2. Проверка `GET /me` → кеширование информации о пользователе.
3. **Подключение WebSocket ко всем открытым сетям (фаза Q).** При наличии
   табов в `tabs` (см. §3.6) — пул `RealtimeClient` поднимает сокет на
   каждую `network_id` (счётчик ссылок ≥1). `last_seq` берётся per-network
   из `client_meta`.
4. Загрузка списка сетей (`etn.networks.list`) и табов
   (`etn.tabs.list`) параллельно. Если для какого-то таба сеть
   отсутствует/недоступна — таб помечается `inaccessible`, заголовок
   рендерится «блеклым» (08-ui-spec.md §1).
5. Активация таба: `etn.tabs.activate(tabId)` возвращает snapshot
   (`focus_id`, `view_mode`, `structures_state`, `chronicle_state`) либо
   `null` для inaccessible. Renderer применяет snapshot к store + модульным
   state-ам, инициализирует `canvas`/`structures`/`chronicle`.
6. Подписка на realtime-события уже работает на уровне пула — renderer
   дополнительно проставляет маркер «*» для табов, чей `network_id`
   совпадает с `evt.network_id`, но `tabId !== activeTabId` (см.
   [08-ui-spec.md](08-ui-spec.md) §1).
7. Пользователь нажимает «+» → переход на экран списка сетей; выбор сети
   → `etn.tabs.open(networkId)` + `etn.tabs.activate`. Закрытие последнего
   «настоящего» таба → возврат на экран списка сетей.

## 8. Обновление приложения

- Electron + `electron-updater` для автообновления из GitHub Releases или
  собственного static-хоста. Подпись обновлений обязательна.
- Обновление клиента независимо от сервера (но с проверкой совместимости через
  `GET /api/v1/version`).

## 9. Платформы MVP

- Windows 10/11 x64.
- macOS (Intel + Apple Silicon).
- Linux x64 (AppImage / deb).

Сборка — `electron-builder`. Платформы и автоматизация CI — вне MVP-спецификации.

## 10. Открытые вопросы

- **Тёмная/светлая тема** — входит ли в MVP? Предлагаю: одна тема (светлая),
  тёмная — следующим шагом. Зафиксировать CSS-переменными с самого начала, чтобы
  добавить вторую тему тривиально.
- **Шрифты и доступность** — масштаб UI через `Cmd/Ctrl +/-`? Предлагаю — да,
  как стандартное поведение Electron.
- **Глобальные горячие клавиши** (вызов окна из любого места) — на MVP не нужно.
