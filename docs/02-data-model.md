# 02. Модель данных

## 1. Обзор

Хранение разделено на две зоны:

- **`_system.db`** (одна общая БД) — глобальные данные сервера: пользователи,
  API-key, реестр мыслесетей, членство, роли, серверные пользовательские
  настройки, журнал аудита.
- **`networks/<network_id>/data.db`** (отдельная БД на каждую мыслесеть) — все
  данные сети: мысли, связи, типы, свойства, комментарии, вложения, поиск.

Обе БД — SQLite в режиме **WAL** с включёнными внешними ключами
(`PRAGMA foreign_keys = ON`).

Идентификаторы сущностей — **UUID v4** (строка TEXT, 36 символов) либо
BIGINT-суррогаты. Для переносимости при экспорте/импорте выбран **UUID**.

> Замечание. `better-sqlite3` возвращает ROWID автоматически; мы во всех
> пользовательских таблицах используем явный `id TEXT PRIMARY KEY` (UUID),
> суррогаты оставляем только для внутренних связных таблиц (например, свойств).

## 2. `_system.db`

### 2.1. users

Пользователи сервера.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT PK | UUID |
| `username` | TEXT UNIQUE NOT NULL | Логин, уникальный в рамках сервера |
| `display_name` | TEXT | Отображаемое имя |
| `is_admin` | INTEGER NOT NULL DEFAULT 0 | 1 — администратор системы |
| `is_first_user` | INTEGER NOT NULL DEFAULT 0 | 1 для пользователя, созданного `etn init` (неудаляемый root-admin) |
| `disabled` | INTEGER NOT NULL DEFAULT 0 | 1 — учётка отключена |
| `created_at` | TEXT NOT NULL | ISO-8601 UTC |
| `updated_at` | TEXT NOT NULL | ISO-8601 UTC |

Индексы: `idx_users_username` (UNIQUE).

Инвариант: пользователь с `is_first_user = 1` нельзя удалить и нельзя снять у
него `is_admin`.

### 2.2. api_keys

API-key для авторизации клиентов и MCP-агентов. У одного пользователя может быть
несколько ключей (например, отдельный — для MCP-агента, отдельный — для десктопа).

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT PK | UUID |
| `user_id` | TEXT NOT NULL FK → users.id ON DELETE CASCADE | Владелец |
| `label` | TEXT | Метка («desktop», «mcp-agent») |
| `key_hash` | TEXT NOT NULL UNIQUE | SHA-256 от ключа; сам ключ не хранится |
| `key_prefix` | TEXT NOT NULL | Первые 8 символов ключа (для отображения `etn_abc12345…`) |
| `created_at` | TEXT NOT NULL | |
| `last_used_at` | TEXT | |
| `disabled` | INTEGER NOT NULL DEFAULT 0 | |

Индексы: `idx_api_keys_hash` (UNIQUE), `idx_api_keys_user`.

Формат ключа: `etn_<32 hex>` (длина 36). Хранится только хеш. Префикс
используется для отображения в админ-панели без раскрытия.

### 2.3. networks

Реестр мыслесетей.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT PK | UUID (он же — имя каталога `networks/<id>/`) |
| `display_name` | TEXT NOT NULL | Имя (пользователь может менять) |
| `owner_id` | TEXT NOT NULL FK → users.id ON DELETE RESTRICT | Владелец |
| `description` | TEXT | |
| `created_at` | TEXT NOT NULL | |
| `updated_at` | TEXT NOT NULL | |

Имя файла/каталога (`id`) неизменно. `display_name` меняется свободно.

### 2.4. network_members

Членство пользователей в мыслесетях.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `network_id` | TEXT NOT NULL FK → networks.id ON DELETE CASCADE | |
| `user_id` | TEXT NOT NULL FK → users.id ON DELETE CASCADE | |
| `role` | TEXT NOT NULL | `'owner'` или `'member'` |
| `added_at` | TEXT NOT NULL | |
| `added_by` | TEXT NOT NULL FK → users.id | Кто добавил |
| PRIMARY KEY | `(network_id, user_id)` | |

Инварианты:
- ровно одна строка с `role = 'owner'` на сеть (владелец не может выйти из сети,
  пока не передаст владение).
- администратор системы может управлять любой записью в этой таблице напрямую,
  минуя владельца.

### 2.5. user_preferences (серверные)

Настройки, влияющие на выборку данных с сервера (поэтому хранятся на сервере, а
не на клиенте).

| Столбец | Тип | Описание |
|---------|-----|----------|
| `user_id` | TEXT NOT NULL FK → users.id ON DELETE CASCADE | |
| `network_id` | TEXT NOT NULL FK → networks.id ON DELETE CASCADE | |
| `key` | TEXT NOT NULL | Имя настройки |
| `value` | TEXT NOT NULL | JSON-значение |
| `updated_at` | TEXT NOT NULL | |
| PRIMARY KEY | `(user_id, network_id, key)` | |

Зарезервированные ключи:
- `show_inactive` (bool) — показывать ли неактуальные мысли/связи.
  По умолчанию `false`.

Клиентские UI-state (свёрнутые группы, сортировки зон, положение редактора)
хранится **локально** на клиенте — см. [07-client-electron.md](07-client-electron.md).

### 2.6. audit_log

Журнал административных и критичных операций.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | INTEGER PK AUTOINCREMENT | |
| `ts` | TEXT NOT NULL | |
| `actor_user_id` | TEXT | Кто (NULL — система) |
| `network_id` | TEXT | Контекст сети (NULL — системная операция) |
| `category` | TEXT NOT NULL | `auth`, `user`, `network`, `membership`, `data` |
| `action` | TEXT NOT NULL | `create`, `update`, `delete`, `grant`, `revoke`, `login`, ... |
| `target_type` | TEXT | `user`, `network`, `thought`, ... |
| `target_id` | TEXT | |
| `details` | TEXT | JSON |

Индекс: `idx_audit_ts`, `idx_audit_actor`, `idx_audit_network`.

### 2.7. client_request_cache

Дедупликация запросов по `client_request_id`.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `request_id` | TEXT PK | UUID от клиента |
| `user_id` | TEXT NOT NULL | |
| `ts` | TEXT NOT NULL | |
| `status` | INTEGER NOT NULL | HTTP-статус сохранённого ответа |
| `body` | TEXT | JSON-ответ |

TTL: 10 минут. Очистка по джобе.

## 3. `networks/<id>/data.db`

### 3.1. thoughts

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT PK | UUID |
| `title` | TEXT NOT NULL | Заголовок (до 400 символов; длина проверяется приложением) |
| `title_norm` | TEXT NOT NULL | Нормализованный заголовок для поиска (lowercase, trim, Unicode NFC) |
| `type_id` | TEXT FK → thought_types.id ON DELETE SET NULL | Тип мысли |
| `icon` | TEXT | Эмодзи или путь/URL картинки |
| `icon_kind` | TEXT NOT NULL DEFAULT `'emoji'` | `'emoji'` \| `'image'` |
| `icon_attachment_id` | TEXT | Id вложения-картинки этой мысли, чей оригинал показывается по `Ctrl+наведению` на иконку (L16). `NULL` — обычная иконка без вложения-источника |
| `active` | INTEGER NOT NULL DEFAULT 1 | 0 — неактуальная |
| `is_protected` | INTEGER NOT NULL DEFAULT 0 | 1 — системная мысль (HOME); нельзя удалить |
| `is_root` | INTEGER NOT NULL DEFAULT 0 | 1 — корневая мысль сети (HOME) |
| `fg_color` | TEXT | Цвет текста. `NULL` — наследуется от типа (или дефолт приложения) |
| `bg_color` | TEXT | Цвет фона облачка. `NULL` — наследуется от типа (или дефолт приложения) |
| `font_bold` | INTEGER NOT NULL DEFAULT 0 | Жирность (значение; `font_manual` бит 0 решает, ручная ли она) |
| `font_italic` | INTEGER NOT NULL DEFAULT 0 | Наклон (`font_manual` бит 1) |
| `font_underline` | INTEGER NOT NULL DEFAULT 0 | Подчёркивание (`font_manual` бит 2) |
| `font_strike` | INTEGER NOT NULL DEFAULT 0 | Зачёркивание (`font_manual` бит 3) |
| `font_manual` | INTEGER NOT NULL DEFAULT 0 | Bitmap ручных шрифтовых полей: бит 0=bold, 1=italic, 2=underline, 3=strike. Поля без бита наследуются от типа (см. §3.1.1) |

> Визуальные настройки делятся на две модели: **`icon`/`fg_color`/`bg_color`**
> используют NULL-семантику (`NULL` = «наследовать от типа»), а **`font_*`** —
> bitmap-колонку `font_manual` (т.к. `font_*` хранятся как `NOT NULL` и пересоздание
> таблицы под nullable небезопасно при включённых FK). Подробно — в §3.1.1.

#### 3.1.1. Наследование визуального стиля от типа

**Хранение (БД):** `icon`/`fg_color`/`bg_color` используют NULL-семантику
(`NULL` = наследовать); `font_*` хранят значение 0/1, а признак «ручное ли поле»
живёт в bitmap `font_manual` (бит 0=bold, 1=italic, 2=underline, 3=strike). Так
`font_*` остаются `NOT NULL`, не требуя пересоздания таблицы (небезопасного при
включённых FK).

**Контракт (API/DTO):** для единообразия сервер выставляет `font_*` в `Thought`/
`ThoughtRef` как `boolean | null` — `null` = «наследуется от типа», `true`/`false`
= ручное значение. При чтении сервер превращает `(font_bold, бит font_manual)` в
`null`/`true`/`false`; при записи `ThoughtUpdateInput.font_* === null` сбрасывает
ручную настройку (снимает бит), `true`/`false` — ставит бит и значение.

При разрешении стиля облачка (`resolveCloudStyle`):

- `icon` / `icon_kind`: `thought.icon ?? thought.type.icon ?? 💬` (наследует
  иконку **и `icon_kind`** от типа).
- `fg_color` / `bg_color`: `NULL` → цвет типа → дефолт приложения.
- `font_*`: `thought.font_X ?? thought.type.font_X ?? false`.

**Смена типа мысли** (`PATCH { type_id }`) меняет только те визуальные поля,
которые не были заданы вручную: NULL-цвета, NULL-иконка и `font_*`=`null` начинают
наследоваться от нового типа. Ручные настройки (не-`NULL` цвета/иконка, `font_*`
со значением) сохраняются. Свойства прежнего типа **скрываются**, но их значения
в `property_values` **не очищаются** — при возврате прежнего типа они снова
отображаются (значения привязаны к `property_id` определения на типе, которое не
удаляется).

Кнопка **«Сброс»** в диалоге настроек убирает все ручные настройки: `icon` →
`NULL`, `fg_color`/`bg_color` → `NULL`, все `font_*` → `NULL` (снимает биты
`font_manual`) — мысль снова отображается стилем выбранного типа.
| `version` | INTEGER NOT NULL DEFAULT 1 | Версия для разрешения конфликтов |
| `created_at` | TEXT NOT NULL | |
| `created_by` | TEXT NOT NULL | user_id |
| `updated_at` | TEXT NOT NULL | |
| `updated_by` | TEXT NOT NULL | user_id |

> `last_viewed_at` и ручной порядок отображения — **per-user**, хранятся в
> таблицах `thought_views` и `user_focus_*` (см. п. 3.10), не в самой мысли.

Индексы: `idx_thoughts_title_norm`, `idx_thoughts_type`, `idx_thoughts_active`,
`idx_thoughts_updated_at`.

Инвариант: ровно одна мысль с `is_root = 1` в сети (создаётся при инициализации
сети как «HOME»). Эта же мысль имеет `is_protected = 1`.

### 3.2. thought_synonyms

Синонимы мыслей (для дедупликации и поиска).

| Столбец | Тип | Описание |
|---------|-----|----------|
| `thought_id` | TEXT NOT NULL FK → thoughts.id ON DELETE CASCADE | |
| `synonym` | TEXT NOT NULL | |
| `synonym_norm` | TEXT NOT NULL | |
| PRIMARY KEY | `(thought_id, synonym_norm)` | |

Индекс: `idx_synonyms_norm` для быстрого поиска дубликатов.

Синоним может содержать символы подстановки `*`: `*` означает «любое количество
любых символов в пределах одного слова» и не пересекает границу слова. Слова
многословного синонима должны встречаться в тексте подряд в заданном порядке;
отличаться могут только части слов на месте `*`. Пример: синоним `Петров* Игор*`
соответствует `Петрова Игоря`, но не `Петрович передал Игорю`. Подстановки
учитываются при поиске дубликатов (08-ui-spec.md §4.4) и поиске упоминаний
(03-server-api.md §13).

### 3.3. thought_types

Пользовательские типы мыслей.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT PK | UUID |
| `name` | TEXT NOT NULL | Имя типа |
| `name_key` | TEXT NOT NULL UNIQUE | Нормализованное имя (`trim` + lowercase) — сравнение имён регистронезависимо: `Тип` = `тип` = `ТИП` |
| `icon` | TEXT | Иконка типа по умолчанию |
| `icon_kind` | TEXT NOT NULL DEFAULT `'emoji'` | `'emoji'` \| `'image'` — вид иконки по умолчанию |
| `fg_color` | TEXT | Цвет текста по умолчанию |
| `bg_color` | TEXT | Цвет фона облачка по умолчанию |
| `font_bold`/`font_italic`/`font_underline`/`font_strike` | INTEGER | Стили по умолчанию (`NULL` — наследуется от дефолта приложения) |
| `description` | TEXT | Комментарий типа (для AI и пользователя) |
| `version` | INTEGER NOT NULL DEFAULT 1 | |
| `created_at` / `updated_at` / `created_by` | ... | |

### 3.4. type_properties

Свойства, доступные мыслям определённого типа (или связям — см. `applies_to`).

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT PK | UUID |
| `owner_type` | TEXT NOT NULL | `'thought_type'` \| `'link_type'` |
| `owner_id` | TEXT NOT NULL | FK на thought_types.id или link_types.id (без SQL-FK, полиморфно) |
| `key` | TEXT NOT NULL | Имя свойства |
| `value_type` | TEXT NOT NULL | `'text'` \| `'date'` \| `'number'` \| `'bool'` \| `'thought_ref'` \| `'url'` (хранится в `value_text` как `text`) |
| `config` | TEXT | JSON-конфигурация свойства. Ключи: `default_value` — значение по умолчанию (L6, не задаётся для `thought_ref`); для `value_type = 'text'` — `options` (предустановленный список значений — подсказка ввода, не ограничение) и `multiple` (разрешить несколько значений через запятую); для `value_type = 'thought_ref'` — `allowed_type_id` (легаси-форма: один тип) / `allowed_type_ids` (список типов: поиск при заполнении идёт только по ним; при записи значение проверяется по этому списку). Смена `options` / `allowed_type_ids` никогда не обрабатывает уже сохранённые значения |
| `required` | INTEGER NOT NULL DEFAULT 0 | |
| `position` | INTEGER NOT NULL DEFAULT 0 | Порядок отображения |
| UNIQUE | `(owner_type, owner_id, key)` | |

Смена `value_type` существующего свойства (L6): сервер в той же транзакции
преобразует все хранимые значения к новому типу (текст↔число/булево/дата —
по возможности), несовместимые значения удаляются. Ссылки на мысли
(`thought_ref`) не конвертируются. Значения адресуются по `property_id`, поэтому
переименование `key` значения не теряет.

### 3.5. property_values

Значения свойств (полиморфная EAV).

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT PK | UUID |
| `owner_type` | TEXT NOT NULL | `'thought'` \| `'link'` |
| `owner_id` | TEXT NOT NULL | FK на thoughts.id или links.id |
| `property_id` | TEXT NOT NULL | FK на type_properties.id |
| `value_text` | TEXT | |
| `value_date` | TEXT | ISO-8601 |
| `value_number` | REAL | |
| `value_bool` | INTEGER | |
| `value_thought_ref` | TEXT | FK на thoughts.id (без SQL-FK; валидируется приложением) |
| `updated_at` | TEXT NOT NULL | |
| UNIQUE | `(owner_type, owner_id, property_id)` | |

Значение пишется только в один столбец `value_*` согласно `value_type` свойства.
Остальные — NULL.

### 3.6. links

Связи между мыслями. Направленные: от `source_id` к `target_id`.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT PK | UUID |
| `source_id` | TEXT NOT NULL FK → thoughts.id ON DELETE CASCADE | Мысль-источник |
| `target_id` | TEXT NOT NULL FK → thoughts.id ON DELETE CASCADE | Мысль-назначение |
| `type_id` | TEXT FK → link_types.id ON DELETE SET NULL | Тип связи |
| `color` | TEXT | Переопределение цвета линии. `NULL` — наследуется от типа связи |
| `style` | TEXT | Переопределение стиля (`'solid'`/`'dashed'`/`'dotted'`). `NULL` — от типа |
| `width` | INTEGER | Переопределение толщины. `NULL` — от типа |
| `active` | INTEGER NOT NULL DEFAULT 1 | |
| `version` | INTEGER NOT NULL DEFAULT 1 | |
| `created_at` / `updated_at` / `created_by` / `updated_by` | | |
| UNIQUE | `(source_id, target_id, type_id)` | Запрет дублирования связей того же типа между той же парой |

> Стиль линии связи разрешается как `link.color ?? link.type.color`,
> `link.style ?? link.type.style`, `link.width ?? link.type.width`. `NULL`
> (значение по умолчанию) — «наследовать от типа связи», не-`NULL` — ручной
> override конкретной связи (виден на холсте). Кнопка «Сброс» в диалоге настроек
> связи выставляет эти поля в `NULL`.

> Ручной порядок отображения связей — per-user, хранится в `user_focus_order`
> (см. п. 3.10.4), а не в самой связи.

Индексы: `idx_links_source`, `idx_links_target`, `idx_links_type`,
`idx_links_active`.

Инвариант: `source_id <> target_id` (петли запрещены на уровне приложения).

### 3.7. link_types

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT PK | UUID |
| `name_forward` | TEXT NOT NULL | Имя от источника к назначению |
| `name_forward_key` | TEXT NOT NULL | Нормализованное имя (регистронезависимое сравнение) |
| `name_reverse` | TEXT NOT NULL | Имя от назначения к источнику |
| `name_reverse_key` | TEXT NOT NULL | Нормализованное имя (регистронезависимое сравнение) |
| `color` | TEXT | Цвет линии |
| `style` | TEXT NOT NULL DEFAULT `'solid'` | `'solid'` \| `'dashed'` \| `'dotted'` |
| `width` | INTEGER NOT NULL DEFAULT 1 | Толщина |
| `description` | TEXT | Комментарий типа (для AI и пользователя) |
| `version` / `created_at` / `updated_at` / `created_by` | | |

UNIQUE на `(name_forward_key, name_reverse_key)` — пара имён уникальна
регистронезависимо; перестановка имён (`parent/child` и `child/parent`) — это
другой тип (направленность значима).

### 3.8. comments

Комментарии для мыслей и связей; постоянные или хронологические.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT PK | UUID |
| `owner_type` | TEXT NOT NULL | `'thought'` \| `'link'` |
| `owner_id` | TEXT NOT NULL | |
| `kind` | TEXT NOT NULL | `'permanent'` \| `'chronological'` |
| `title` | TEXT | Заголовок (для хронологических) |
| `body_md` | TEXT NOT NULL | Markdown-текст |
| `body_html` | TEXT NOT NULL | Пре-рендеренный HTML (кешируется) |
| `valid_from` | TEXT NOT NULL | Дата начала (для permanent — равна created_at) |
| `valid_to` | TEXT | Дата окончания (NULL — бессрочно; для permanent — NULL) |
| `version` | INTEGER NOT NULL DEFAULT 1 | |
| `created_at` / `updated_at` / `created_by` / `updated_by` | | |

Индексы: `idx_comments_owner` `(owner_type, owner_id)`,
`idx_comments_chrono` `(owner_type, owner_id, valid_from)`.

#### 3.8.1. comment_targets (L20)

Привязки хронологического комментария к мыслям/связям (m2m): одна запись
может быть привязана к **нескольким** владельцам сразу (например, к нескольким
мыслям и связи). `comments.owner_type/owner_id` хранят **первичную** (первую)
привязку; полный набор — в `comment_targets`.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `comment_id` | TEXT NOT NULL | → `comments.id` (без SQL-FK, полиморфность) |
| `owner_type` | TEXT NOT NULL | `'thought'` \| `'link'` |
| `owner_id` | TEXT NOT NULL | |
| PRIMARY KEY | `(comment_id, owner_type, owner_id)` | Контроль дублей привязок |

Индекс: `idx_comment_targets_owner` `(owner_type, owner_id)` — список
комментариев владельца (включая вторичные привязки). Миграция 019 выполняет
бэкфилл: каждый существующий комментарий получает одну строку со своим
первичным владельцем.

Инварианты:
- для пары `(owner_type, owner_id)` допускается **один** комментарий с
  `kind = 'permanent'`. Постоянный комментарий всегда имеет ровно одну
  привязку (дополнительные привязки запрещены).
- хронологических — сколько угодно; у хронологического — 1..N привязок.
  Отвязка последней привязки автоматически привязывает запись к HOME
  (защищённая мысль сети) — запись не может остаться без владельца.
- FTS-индексы (`fts_thought_texts`/`fts_link_texts`) индексируют текст
  комментария по **первичной** привязке; при переносе primary триггеры
  перестраивают строку. Тексты комментариев вторичных владельцев в FTS не
  попадают (отбор «Хроники» ищет по телам через `comment_targets` напрямую).

### 3.9. attachments

Вложения для мыслей и связей.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT PK | UUID |
| `owner_type` | TEXT NOT NULL | `'thought'` \| `'link'` |
| `owner_id` | TEXT NOT NULL | |
| `kind` | TEXT NOT NULL | `'url'` \| `'file'` |
| `url` | TEXT | Для `kind = 'url'` |
| `file_path` | TEXT | Для `kind = 'file'` (путь в ОС пользователя) |
| `file_size` | INTEGER | |
| `mime_type` | TEXT | |
| `title` | TEXT | Заголовок (для URL — заголовок страницы) |
| `icon` | TEXT | Превью-иконка как `data:` URL (favicon сайта для URL-вложений; L1) |
| `description` | TEXT | Комментарий |
| `position` | INTEGER NOT NULL DEFAULT 0 | Порядок |
| `created_at` / `created_by` | | |

Индекс: `idx_attachments_owner` `(owner_type, owner_id)`.

Вложение-файл может быть:
- **загружено на сервер** (`POST …/attachments/file`): бинарник сохраняется в
  `networks/<id>/attachments/` рядом с `data.db` (единое хранилище, бэкапится
  вместе с БД), а `file_path` указывает на сохранённую копию. Используется при
  вставке файлов из буфера обмена в комментарии (08-ui-spec.md §6.4);
- **просто путём в ОС клиента** (`POST …/attachments { kind:'file' }`):
  перетаскивание файла в зону вложений, бинарник не копируется.

При **удалении** вложения сервер удаляет и сохранённую копию файла, если
`file_path` лежит внутри `networks/<id>/attachments/`; пути в ОС клиента не
трогаются. `PATCH /attachments/{id}` может перенести вложение к другому
владельцу (`owner_type`/`owner_id`; новый владелец должен существовать).

В комментариях картинки ссылаются схемой `etnimg://` (привилегированный
протокол Electron-клиента, отдаёт локальные файлы) либо `file://`/`http(s)`/
`data:`; рендерер разрешает их только в позиции изображений (§3.8).

### 3.10. Пер-пользовательские настройки и состояние в сети

Эти таблицы хранят данные уровня **L3 (пользователь × сеть)** — одинаковые на
всех клиентах одного пользователя, синхронизируются между ними через real-time
события `audience=user` (см. [04-realtime.md](04-realtime.md), п. 4.8 и
[11-settings-and-state.md](11-settings-and-state.md), п. 2).

#### 3.10.1. user_preferences

Общие per-user-per-network настройки (влияют на выборку данных сервером).

| Столбец | Тип | Описание |
|---------|-----|----------|
| `user_id` | TEXT NOT NULL | |
| `key` | TEXT NOT NULL | Имя настройки |
| `value` | TEXT NOT NULL | JSON |
| `updated_at` | TEXT NOT NULL | |
| PRIMARY KEY | `(user_id, key)` | |

Зарезервированные ключи: `show_inactive` (bool, default `false`).

#### 3.10.2. thought_views

Метка просмотра для целей сортировки «по дате последнего просмотра». Не хранит
фокус-мысль — фокус это клиентское состояние (L4).

| Столбец | Тип | Описание |
|---------|-----|----------|
| `user_id` | TEXT NOT NULL | |
| `thought_id` | TEXT NOT NULL FK → thoughts.id ON DELETE CASCADE | |
| `last_viewed_at` | TEXT NOT NULL | |
| PRIMARY KEY | `(user_id, thought_id)` | |

#### 3.10.3. user_focus_preferences

Выбор сортировки зоны холста для конкретной фокус-мысли.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `user_id` | TEXT NOT NULL | |
| `focus_thought_id` | TEXT NOT NULL FK → thoughts.id ON DELETE CASCADE | |
| `dir` | TEXT NOT NULL | `'children'` \| `'parents'` \| `'siblings'` |
| `sort` | TEXT NOT NULL | `'manual'` \| `'alpha'` \| `'created'` \| `'viewed'` |
| `sort_order` | TEXT NOT NULL | `'asc'` \| `'desc'` |
| `updated_at` | TEXT NOT NULL | |
| PRIMARY KEY | `(user_id, focus_thought_id, dir)` | |

#### 3.10.4. user_focus_order

Ручной порядок мыслей зоны фокуса (только при `sort='manual'`). Для родственников
(`dir='siblings'`) записи не создаются.

| Столбец | Тип | Описание |
|---------|-----|----------|
| `user_id` | TEXT NOT NULL | |
| `focus_thought_id` | TEXT NOT NULL FK → thoughts.id ON DELETE CASCADE | |
| `dir` | TEXT NOT NULL | `'children'` \| `'parents'` |
| `thought_id` | TEXT NOT NULL FK → thoughts.id ON DELETE CASCADE | Ребёнок или родитель |
| `position` | INTEGER NOT NULL | |
| `updated_at` | TEXT NOT NULL | |
| PRIMARY KEY | `(user_id, focus_thought_id, dir, thought_id)` | |

Индекс: `idx_user_focus_order_pos (user_id, focus_thought_id, dir, position)`.

Алгоритм применения сортировки и поведения при изменении порядка —
см. [11-settings-and-state.md](11-settings-and-state.md), п. 3.

#### 3.10.5. saved_filters

Именованные отборы видов «Структуры мыслей» (08-ui-spec.md §15) и «Хроника»
(08-ui-spec.md §17): критерии + сортировка, сохранённые пользователем для
повторного применения. Уровень L3 — одинаковы на всех клиентах пользователя,
синхронизируются событиями `saved-filter.*` (`audience=user`, см.
[04-realtime.md](04-realtime.md) п. 4.8).

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | TEXT NOT NULL | UUID |
| `user_id` | TEXT NOT NULL | Владелец (только свои отборы доступны через API) |
| `view` | TEXT NOT NULL | `'structures'` \| `'chronicle'` — к какому виду относится отбор |
| `name` | TEXT NOT NULL | Имя отбора (уникально в пределах пользователя и вида) |
| `definition` | TEXT NOT NULL | JSON: для structures — `{ keywords?, type_ids?, link_type_ids?, properties?, show_inactive?, sort, order }` (03-server-api.md §6.10/§18); для chronicle — `{ keywords?, thought_ids?, include_subtree?, type_ids?, link_type_ids?, link_scope?, date_from?, date_to?, order }` (03-server-api.md §20) |
| `created_at` | TEXT NOT NULL | |
| `updated_at` | TEXT NOT NULL | |
| PRIMARY KEY | `(id)` | |
| UNIQUE | `(user_id, view, name)` | Повторное имя в том же виде → 409 `DUPLICATE` |

#### 3.10.6. user_pinned_thoughts

Закреплённые мысли пользователя (08-ui-spec.md §16): упорядоченный список для
быстрого перехода. Уровень L3 — одинаковы на всех клиентах пользователя,
синхронизируются событием `pinned-thoughts.updated` (`audience=user`, см.
[04-realtime.md](04-realtime.md) п. 4.8). Запись семантики — replace: при
каждом изменении клиент присылает полный порядок, сервер перезаписывает
таблицу, `position` = индекс в массиве (как `user_focus_order`).

| Столбец | Тип | Описание |
|---------|-----|----------|
| `user_id` | TEXT NOT NULL | Владелец (только свой список доступен через API) |
| `thought_id` | TEXT NOT NULL FK → thoughts.id ON DELETE CASCADE | Закреплённая мысль |
| `position` | INTEGER NOT NULL | 0-based порядок в списке |
| `pinned_at` | TEXT NOT NULL | ISO-8601 UTC момента закрепления |
| PRIMARY KEY | `(user_id, thought_id)` | Дубли закреплённых не допускаются |

Индекс: `idx_user_pinned_thoughts_pos (user_id, position)`.

Лимит 20 закреплённых — ограничение приложения (`PINNED_THOUGHTS_LIMIT` в
shared), а не CHECK: сервис отклоняет более длинные списки `VALIDATION_ERROR`.
При удалении мысли её запись удаляется каскадом (FK); отдельное событие не
эмитится — клиенты убирают чип по `thought.deleted`.

### 3.11. Полнотекстовый поиск (FTS5)

Четыре FTS-таблицы покрывают сценарий поиска (см. [08-ui-spec.md](08-ui-spec.md),
раздел «Поиск»):

```sql
-- 1. По именам мыслей и синонимам
CREATE VIRTUAL TABLE fts_thought_names USING fts5(
    thought_id UNINDEXED,
    text,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- 2. По текстам постоянных и хронологических комментариев мыслей
CREATE VIRTUAL TABLE fts_thought_texts USING fts5(
    thought_id UNINDEXED,
    text,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- 3. По заголовкам и текстам комментариев связей
CREATE VIRTUAL TABLE fts_link_texts USING fts5(
    link_id UNINDEXED,
    text,
    tokenize = 'unicode61 remove_diacritics 2'
);
```

> Четвёртая группа «найдено в хронологии» из сценария поиска покрывается
> отдельным фильтром по `comments.kind = 'chronological'` поверх
> `fts_thought_texts`/`fts_link_texts`.

Триггеры синхронизируют FTS с изменениями:
- `INSERT/UPDATE/DELETE` на `thoughts` → обновить `fts_thought_names`
  (text = title + синонимы).
- `INSERT/UPDATE/DELETE` на `thought_synonyms` → обновить `fts_thought_names`.
- `INSERT/UPDATE/DELETE` на `comments` → обновить соответствующую FTS.

`tokenize = 'unicode61 remove_diacritics 2'` корректно работает с кириллицей и
латиницей без дополнительных словарей.

### 3.12. embeddings (зарезервировано на будущее)

| Столбец | Тип | Описание |
|---------|-----|----------|
| `owner_type` | TEXT NOT NULL | `'thought'` \| `'link'` \| `'comment'` |
| `owner_id` | TEXT NOT NULL | |
| `model` | TEXT NOT NULL | Имя модели-эмбеддера |
| `vector` | BLOB | Упакованный массив float32 |
| `ts` | TEXT NOT NULL | |
| PRIMARY KEY | `(owner_type, owner_id, model)` | |

Сам векторный поиск на MVP не реализуется; таблица заведена, чтобы будущий
семантический поиск через MCP-агента не требовал миграций.

## 4. Инициализация новой мыслесети

При `POST /networks` сервер:

1. Генерирует `network_id` (UUID).
2. Создаёт каталог `networks/<network_id>/` и `attachments/`, `snapshots/`
   внутри.
3. Открывает `data.db`, выполняет миграции схемы (см. п. 6).
4. В транзакции создаёт корневую мысль:
   ```sql
   INSERT INTO thoughts (id, title, title_norm, is_protected, is_root,
                         active, version, created_at, created_by, updated_at, updated_by)
   VALUES (:id, 'HOME', 'home', 1, 1, 1, 1, :now, :owner, :now, :owner);
   ```
5. В `_system.db` добавляет запись в `networks` и `network_members`
   (`role = 'owner'`).
6. Эмитит `network.created` (по необходимости).

## 5. Миграции

Каждая БД имеет таблицу `_migrations`:

| Столбец | Тип |
|---------|-----|
| `id` | INTEGER PK |
| `name` | TEXT NOT NULL |
| `applied_at` | TEXT NOT NULL |

Миграции хранятся в репозитории в `migrations/system/*.sql` и
`migrations/network/*.sql`. Сервер при старте применяет все нужные миграции к
`_system.db` и при открытии сети — к её `data.db`. Миграции идемпотентны в
контрольной точке (CREATE IF NOT EXISTS), а необратимые миграции выполняются в
транзакции.

## 6. Удаление мыслесети

Только администратор. Операция:

1. `PRAGMA wal_checkpoint(TRUNCATE)` на `data.db`.
2. `CLOSE` соединения с `data.db`.
3. Удаление каталога `networks/<id>/`.
4. В `_system.db`: `DELETE FROM networks WHERE id = ?` (каскад удаляет
   `network_members`, серверные `user_preferences`).
5. Запись в `audit_log`.

## 7. Резервное копирование

- Стандартный бэкап = копирование `networks/<id>/` (все WAL/SHM-файлы включены)
  и `_system.db`. Перед копированием — `wal_checkpoint(TRUNCATE)`.
- Снапшот конкретной сети через `VACUUM INTO 'snapshots/<ts>.db'` — единый файл
  без WAL.

## 8. Открытые вопросы (для следующей итерации)

- Ограничение длины `title` (400) — хранить как `TEXT` без проверки в БД или
  ввести `CHECK(length(title) <= 400)`? Предлагаю: проверка в приложении, без
  CHECK, чтобы не блокировать миграции при изменении лимита.
- Нужно ли отдельное хранение Markdown AST для комментариев или достаточно
  `body_md` + `body_html`? Предлагаю достаточно.
- Стратегия `value_thought_ref` при удалении мысли-цели: `ON DELETE SET NULL`
  (через явный cleanup-джоб, т.к. нет SQL-FK).
