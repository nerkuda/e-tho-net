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
│  ┌──────────────┐ ┌────────────┐ ┌──────────┐ ┌─────────────┐   │
│  │ Network      │ │ Realtime   │ │ Local    │ │ IPC         │   │
│  │ client       │ │ client     │ │ store    │ │ handlers    │   │
│  │ (REST + WS)  │ │ (events)   │ │ (SQLite) │ │             │   │
│  └──────────────┘ └────────────┘ └──────────┘ └─────────────┘   │
│         │                │             │              │         │
│         └────────────────┴─────────────┴──────────────┘         │
│                              │                                   │
│                    safeStorage (API-key)                         │
└──────────────────────────────┬──────────────────────────────────┘
                               │ IPC (contextBridge)
┌──────────────────────────────┴──────────────────────────────────┐
│ Renderer process (Chromium)                                     │
│                                                                 │
│  UI: холст │ редактор │ поиск │ выделения │ диалоги │ настройки │
│  UI-state: in-memory store + подписки на realtime-события        │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1. Разделение ответственности
- **Main:** сетевые операции, локальная БД, хранение ключей, IPC-обработчики.
  Ключ API в renderer **не попадает**.
- **Renderer:** только UI и UI-state. Все обращения к данным — через IPC
  (например, `window.etn.thoughts.get(id)` → IPC → main → REST).

## 3. Локальное хранилище

`userData/local.db` — SQLite (better-sqlite3), WAL.

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

При открытии сущности черновик **не** переводит поле в режим редактирования:
постоянный комментарий и хронологические комментарии всегда открываются в
режиме просмотра (08-ui-spec.md §6.4, §6.6), а правка начинается только по
двойному клику. Черновик остаётся в локальной БД и переотправляется при
восстановлении соединения (п. 5.2); «мёртвые» черновики, текст которых уже
совпал с сохранённым, удаляются при открытии.

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

### 3.5. focus_history (история фокуса, L4)

История мыслей, побывавших в фокусе на этом клиенте. Локальное состояние per
`(profile_id, network_id)`. См. [11-settings-and-state.md](11-settings-and-state.md),
п. 2.3.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `profile_id` | TEXT NOT NULL | Сервер-профиль |
| `network_id` | TEXT NOT NULL | |
| `thought_id` | TEXT NOT NULL | |
| `seq` | INTEGER NOT NULL | Монотонный счётчик на (profile, network); больший = более свежий |
| `visited_at` | TEXT NOT NULL | |
| PRIMARY KEY | `(profile_id, network_id, thought_id)` | |

Индекс: `idx_focus_history_seq (profile_id, network_id, seq DESC)`.

**Алгоритм при смене фокуса `oldId → newId`** (в одной транзакции локально):

```sql
-- 1. newId больше не в истории — он становится фокусом
DELETE FROM focus_history
  WHERE profile_id = ? AND network_id = ? AND thought_id = ?;   -- newId

-- 2. oldId — в начало истории
INSERT OR REPLACE INTO focus_history (profile_id, network_id, thought_id, seq, visited_at)
  VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM focus_history
                    WHERE profile_id = ? AND network_id = ?), ?);

-- 3. Trim до 50: удалить всё, что не входит в топ-50 свежих
DELETE FROM focus_history
  WHERE profile_id = ? AND network_id = ?
    AND seq NOT IN (
      SELECT seq FROM focus_history
        WHERE profile_id = ? AND network_id = ?
        ORDER BY seq DESC LIMIT 50
    );
```

`oldId = null` (первый вход в сеть, фокус с нуля) → шаг 2 пропускается.
`oldId = newId` (повторный фокус на ту же мысль) → операция в целом no-op.

**Получение истории:**

```sql
SELECT thought_id FROM focus_history
  WHERE profile_id = ? AND network_id = ?
  ORDER BY seq DESC LIMIT 50;
```

Возвращает массив `thought_id`. Метаданные облачек клиент докладывает через
`POST /networks/{nid}/thoughts/resolve` ([03-server-api.md](03-server-api.md),
п. 6.10) или берёт из локального кэша мыслей.

**Очистка:** при получении real-time события `thought.deleted` для мысли в
истории — обязательная локальная чистка
(`DELETE FROM focus_history WHERE profile_id=? AND network_id=? AND thought_id=?`).
Неактуальные (`active=0`) мысли из истории **не** вычищаются — они скрываются на
уровне рендера при выключенном `show_inactive`.

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
    onStatusChange(cb)
  },
  ui: {
    getState(networkId, key), setState(networkId, key, value)
  }
}
```

Все методы асинхронны (`Promise`). Ошибки — стандартизованный `EtnError`
с кодом и деталями.

## 7. Жизненный цикл приложения

1. Запуск → выбор активного профиля (или первоначальная настройка — ввод URL
   сервера + ключ).
2. Проверка `GET /me` → кеширование информации о пользователе.
3. Подключение WebSocket (если был активный profile/network — к ней).
4. Загрузка списка сетей → пользователь выбирает сеть.
5. Загрузка фокуса и рендер UI.
6. Подписка на realtime-события выбранной сети.

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
