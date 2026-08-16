# 03. REST API сервера

## 1. Общие принципы

- Базовый префикс: `/api/v1`.
- Транспорт: HTTPS (HTTP разрешён только для локальной разработки).
- Авторизация: заголовок `Authorization: Bearer <API-key>`. См. [06-auth.md](06-auth.md).
- Формат обмена: `application/json; charset=utf-8`.
- Идемпотентность изменяющих запросов: заголовок
  `Client-Request-Id: <UUID>` (см. [01-architecture.md](01-architecture.md), п. 6).
- Оптимистичный контроль версий: изменяющие запросы передают
  `If-Match: <version>`; сервер отвергает изменение при несовпадении (409).

## 2. Формат ответов

Успех:

```json
{ "data": { ... }, "meta": { "version": 7, "updated_at": "..." } }
```

Список:

```json
{ "data": [ ... ], "meta": { "total": 123, "offset": 0, "limit": 50 } }
```

Ошибка:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "title must not be empty",
    "details": [ { "field": "title", "issue": "required" } ],
    "request_id": "..."
  }
}
```

### 2.1. Коды ошибок

| HTTP | code | Когда |
|------|------|-------|
| 400 | `BAD_REQUEST` | Невалидное тело запроса |
| 401 | `UNAUTHORIZED` | Нет/невалидный API-key |
| 403 | `FORBIDDEN` | Нет прав на ресурс |
| 404 | `NOT_FOUND` | Ресурс не существует |
| 409 | `VERSION_CONFLICT` | Не совпала `If-Match` версия |
| 409 | `DUPLICATE` | Нарушен UNIQUE-констрейнт |
| 422 | `VALIDATION_ERROR` | Ошибка бизнес-валидации (например, нельзя удалить HOME) |
| 500 | `INTERNAL` | Внутренняя ошибка |

## 3. Аутентификация и сам пользователь

### 3.1. Проверка токена
```
GET /api/v1/me
→ 200 { data: { id, username, display_name, is_admin } }
```

### 3.2. Управление своими API-key
```
GET    /api/v1/me/keys                 # список (только prefix, без полного ключа)
POST   /api/v1/me/keys                 { label } → 201 { data: { id, key, prefix } }
                                       # полный ключ возвращается ТОЛЬКО при создании
DELETE /api/v1/me/keys/{id}            # отозвать
```

## 4. Администрирование (только admin)

### 4.1. Пользователи
```
GET    /api/v1/admin/users             # список
POST   /api/v1/admin/users             { username, display_name, is_admin? }
                                       → 201 + автоматически сгенерированный API-key
                                       # admin решает, передать его новому пользователю
GET    /api/v1/admin/users/{id}
PATCH  /api/v1/admin/users/{id}        { display_name?, is_admin?, disabled? }
DELETE /api/v1/admin/users/{id}        # запрещено для is_first_user=1 → 422

POST   /api/v1/admin/users/{id}/keys   { label }
                                       → 201 { key, prefix } # для передачи пользователю
DELETE /api/v1/admin/users/{id}/keys/{key_id}
```

### 4.2. Мыслесети (админ)
```
GET    /api/v1/admin/networks                       # все сети
DELETE /api/v1/admin/networks/{network_id}          # удалить сеть (см. data-model п.6)
PATCH  /api/v1/admin/networks/{network_id}/members  # принудительно менять членство
```

## 5. Мыслесети

### 5.1. Список доступных пользователю
```
GET /api/v1/networks
→ 200 { data: [ { id, display_name, owner: {id, display_name},
                  role: "owner"|"member", members_count, my_focus_thought_id } ] }
```

### 5.2. Создание
```
POST /api/v1/networks
{ display_name: "Моя сеть", description? }
→ 201 { data: { id, display_name, owner_id, created_at } }
# Автоматически: создатель становится owner, создаётся мысль "HOME".
```

### 5.3. Управление (владелец)
```
GET   /api/v1/networks/{id}
PATCH /api/v1/networks/{id}                { display_name?, description? }

GET   /api/v1/networks/{id}/members        # список участников
POST  /api/v1/networks/{id}/members        { user_id }     # добавить (member)
PATCH /api/v1/networks/{id}/members/{uid}  { role }        # передача владения
DELETE /api/v1/networks/{id}/members/{uid}                 # исключить
```

Передача владения: `PATCH { role: "owner" }` переводит текущего владельца в
`member`, нового — в `owner`, в одной транзакции.

### 5.4. Серверные предпочтения пользователя в сети
```
GET   /api/v1/networks/{id}/preferences              # все ключи
PUT   /api/v1/networks/{id}/preferences/{key}        { value: <json> }
```

Поддержанные ключи: `show_inactive`. Полный перечень настроек по уровням —
см. [11-settings-and-state.md](11-settings-and-state.md), п. 2.

## 6. Мысли

Все эндпоинты ниже работают в контексте сети: `/api/v1/networks/{nid}/...`.

### 6.1. Получение
```
GET /api/v1/networks/{nid}/thoughts/{id}
→ 200 { data: { id, title, type_id, icon, icon_kind, active, is_protected,
                fg_color, bg_color, font_bold, font_italic, font_underline, font_strike,
                synonyms: [...], version, created_at, updated_at } }
# last_viewed_at — per-user, живёт в thought_views, возвращается в focus response
# или через GET /thoughts/{id}/view.
```

### 6.2. Фокус
```
POST /api/v1/networks/{nid}/thoughts/{id}/focus
# Записывает thought_views (last_viewed_at для текущего пользователя);
# возвращает соседей для холста (с учётом show_inactive и сортировок фокуса):
→ 200 { data: { focused: {...},
                parents:  [ ... ],      # источники связей (active-фильтр по pref)
                children: [ ... ],      # назначения связей
                siblings: [ ... ],      # мысли с тем же родителем
                edges:    [ ... ],      # все active-связи среди видимых мыслей
                sorts:    { parents: "...", children: "..." } } }
# Фокус-мысль как «последняя просмотренная» НЕ сохраняется сервером — это
# клиентское состояние (L4 в [11-settings-and-state.md](11-settings-and-state.md)).
```

Зоны **взаимоисключающи**: мысль встречается не более чем в одной из
`parents`/`children`/`siblings` (приоритет: фокус > parents > children >
siblings; [08-ui-spec.md](08-ui-spec.md) §2.1). `edges` от этого не зависят —
они строятся по всем видимым мыслям, даже если мысль попала в другую зону.

Каждый элемент в `parents`/`children`/`siblings`:
```json
{ "id": "...", "title": "...", "type_id": "...", "icon": "...",
  "active": 1, "link_id": "...", "link_type_id": "...", "link_active": 1 }
```

`edges` — все active-связи (с учётом `show_inactive`), у которых **оба конца** входят в
множество `{focused} ∪ parents ∪ children ∪ siblings`. В отличие от `parents`/`children`
(несут только связь с фокусом), здесь — связи между любыми двумя видимыми мыслями,
включая сосед↔сосед; нужны холсту для отрисовки всех видимых связей:
```json
{ "id": "...", "source_id": "...", "target_id": "...", "type_id": "..." }
```

`sorts` — текущая сортировка порядка¬ble-зон для пользователя (`manual`/`alpha`/`created`/`viewed`),
с дефолтом `created`; siblings порядка не имеют.

### 6.3. Создание
```
POST /api/v1/networks/{nid}/thoughts
{
  title: "Имя мысли",
  synonyms?: ["син1", "син2"],          # или строка через запятую — оба варианта
  type_id?: "...",
  icon?: "...", icon_kind?: "emoji"|"image",
  active?: true,                         # default true
  fg_color?, bg_color?, font_*?,
  create_link?: {                        # сразу создать связь с родителем
    direction: "parent"|"child",         # parent: новая мысль — источник к target_id
    target_thought_id: "...",            # child: новая мысль — назначение для target_id
    type_id?: "..."
  }
}
→ 201 { data: { id, ..., version: 1 }, meta: { request_id } }
```

Поведение дедупликации описано в [08-ui-spec.md](08-ui-spec.md), диалог добавления.
На уровне API дедупликация НЕ выполняется — клиент предоставляет точное имя и
синонимы. Дедупликация — функция диалога поиска существующих мыслей.

### 6.4. Изменение
```
PATCH /api/v1/networks/{nid}/thoughts/{id}
If-Match: <version>
{ title?, synonyms?, type_id?, icon?, icon_kind?, active?,
  fg_color?, bg_color?, font_bold?, font_italic?, font_underline?, font_strike? }
→ 200 { data: {..., version: N+1} }
# 422 если is_protected=1 и попытка удалить (через DELETE) или сменить active у is_root.
```

### 6.5. Удаление
```
DELETE /api/v1/networks/{nid}/thoughts/{id}
If-Match: <version>
→ 204
# 422 для is_protected=1
# Каскад: thoughts → thought_synonyms, links (с обеих сторон), comments, attachments, property_values
```

### 6.6. Групповые операции
```
POST /api/v1/networks/{nid}/thoughts/batch
{
  ids: ["...", "..."],
  op: "set_type"|"clear_type"|"set_active"|"set_inactive"|"delete"|
       "link_to_focus"|"unlink_from_focus",
  args: { type_id?, active?, focus_thought_id?, link_type_id?, direction? }
}
→ 200 { data: { affected: N, failures: [ {id, code, message} ] } }
```

`link_to_focus` — создать связи между всеми `ids` и мыслью в фокусе клиента
(`focus_thought_id` передаётся явно). `direction` — `parent`/`child`.

### 6.7. Соседи без смены фокуса (для drag-операций, выбора)
```
GET /api/v1/networks/{nid}/thoughts/{id}/neighbors?dir=parents|children|siblings
&sort=alpha|created|viewed|manual&order=asc|desc
&limit=50&offset=0&type_id=...
```

### 6.8. Сортировка зон фокуса (per-user, per-focus)

Порядок и выбор сортировки хранятся на сервере per `(user_id, focus_thought_id,
dir)`, синхронизируются между клиентами того же пользователя через real-time
(audience=user). См. [02-data-model.md](02-data-model.md), п. 3.10 и
[11-settings-and-state.md](11-settings-and-state.md), п. 3.

```
# Выбор сортировки для (фокус, направление)
PUT  /api/v1/networks/{nid}/thoughts/{fid}/focus-preferences
     { dir: "children"|"parents"|"siblings",
       sort: "manual"|"alpha"|"created"|"viewed",
       order: "asc"|"desc" }
→ 200 { data: { focus_thought_id, dir, sort, order } }

# Ручной порядок мыслей (только для dir=children|parents; siblings ручного порядка не имеет)
POST /api/v1/networks/{nid}/thoughts/{fid}/focus-order
     { dir: "children"|"parents",
       ordered_ids: ["id1","id2","id3"] }
# Сервер записывает position = индекс в массиве для каждого thought_id в
# user_focus_order; прочие записи по (user, focus, dir) удаляются.
→ 200 { data: { focus_thought_id, dir, ordered_ids } }
```

### 6.9. Пакетное получение метаданных мыслей
```
POST /api/v1/networks/{nid}/thoughts/resolve
{ ids: ["id1","id2","id3", ...] }     # до 100 за запрос
→ 200 { data: [ { id, title, type_id, icon, icon_kind, active,
                  fg_color, bg_color, font_bold, font_italic, font_underline, font_strike } ] }
# Несуществующие/удалённые id в ответ не попадают.
# Используется клиентом для отображения истории фокуса, упоминаний и т.п. —
# где нужен массовый «облегчённый» набор облачков без полных связей/комментариев.
```

### 6.10. Отбор мыслей для «Структур» (L15)
```
POST /api/v1/networks/{nid}/thoughts/query
{
  keywords?: "счет* -вод*",       # мини-синтаксис, см. ниже; AND по словам
  type_ids?: ["..."],             # типы мыслей (OR внутри списка)
  link_type_ids?: ["..."],        # мысль имеет active-связь любого из типов
                                  # в любом направлении (source или target)
  properties?: [                  # все условия объединяются по AND
    { property_id: "...", op: "contains"|"eq"|"gt"|"lt"|"in"|"not_in",
      value: "..." | 42 | true | ["Москва", "Воронеж"] }
  ],
  show_inactive?: false,          # как в focus/поиске
  sort: "alpha"|"created"|"viewed",
  order: "asc"|"desc",
  limit: 100, offset: 0           # limit клампится в 1..100
}
→ 200 { data: [ ThoughtRef... ], meta: { total, limit, offset } }
```

- **Пустой фильтр** (нет `keywords`, `type_ids`, `link_type_ids` и `properties`)
  возвращает ровно одну мысль — HOME (`is_root=1`), `meta.total=1`.
- **Мини-синтаксис keywords**: слова разделяются пробелами, порядок любой,
  все обязательны (AND). `*` внутри слова — любое количество любых символов
  (`счет*` → подстрока с префиксом «счет»); слово без `*` — точная подстрока.
  `-слово` — исключение: слова не должно быть ни в названии, ни в синонимах.
  Пример: `счет* -вод*` соответствует «Счетчик электричества», но не
  «счета за воду». Реализация — параметризованный `LIKE … ESCAPE '\'` по
  нормализованным `title_norm`/`synonym_norm` (`%`, `_`, `\` экранируются).
- **Операции свойств** применяются к колонке типа значения определения
  (`value_text/value_number/value_date/value_bool/value_thought_ref`); допустимые
  `op` зависят от `value_type`: text/url — `contains|eq|in|not_in`;
  number/date — `eq|gt|lt`; bool — `eq`; thought_ref — `eq|in|not_in`.
  `in`/`not_in` принимают массив значений (OR внутри списка).
- Сортировка: `alpha` — по заголовку (NOCASE), `created` — по `created_at`,
  `viewed` — по `thought_views.last_viewed_at` текущего пользователя
  (NULL — последними при `asc`).
- Условие с несуществующим `property_id` игнорируется: определение свойства
  могло быть удалено после сохранения отбора — остальные условия применяются.

### 6.11. Иерархия одного уровня (для дерева «Структур»)
```
GET /api/v1/networks/{nid}/thoughts/{id}/hierarchy
    ?dir=parents|children&show_inactive=&exclude_ids=id1,id2,...
→ 200 { data: {
     neighbors: [ ThoughtRef... ],   # родители (источники связей) или дети (цели)
     edges:     [ { id, source_id, target_id, type_id, color, style, width } ],
                                      # active-связи между {id} и соседями
     truncated: false,                # true — соседей больше лимита (100)
     directions: { "<thought_id>": { has_incoming, has_outgoing }, ... }
                                      # наличие active входящих/исходящих связей
                                      # у узла и соседей — закраска эллипсов дерева
   } }
```

- Соседи исключаются по `exclude_ids` **до** применения лимита — так клиент
  убирает повторы в пределах ветки раскрытия (дедуп per-ветка, 08-ui-spec.md
  §15.5): например, дети A = {Б, В}; при раскрытии Б с `exclude_ids=[A,Б,В]`
  из детей {В, Г} вернётся только Г.
- До 1000 id в `exclude_ids`; сортировка соседей — `alpha asc` (дерево
  показывает единый стабильный порядок).

## 7. Связи

### 7.1. CRUD
```
POST   /api/v1/networks/{nid}/links
       { source_id, target_id, type_id?, active? }
GET    /api/v1/networks/{nid}/links/{id}
PATCH  /api/v1/networks/{nid}/links/{id}    If-Match
       { source_id?, target_id?, type_id?, active? }
DELETE /api/v1/networks/{nid}/links/{id}    If-Match
```

Инварианты:
- `source_id <> target_id` → 422.
- `(source_id, target_id, type_id)` UNIQUE → 409 `DUPLICATE`.
- `type_id` может быть NULL (нетипизированная связь).
- PATCH: `source_id`/`target_id` передаются **только вместе** — смена концов
  инвертирует связь (источник ⇄ назначение). Оба конца должны существовать
  (404), петля → 422, дубль в новом направлении (с учётом `type_id`) → 409.
  Инвариант UNIQUE проверяется для результирующей пары.

### 7.2. Связи мысли (для редактора)
```
GET /api/v1/networks/{nid}/thoughts/{id}/links?group=type
→ 200 { data: {
  by_type: [ { type_id, type_name, items: [ {link, target_thought} ] } ],
  untyped_parents: [ {link, source_thought} ],
  untyped_children: [ {link, target_thought} ]
} }
```

## 8. Типы мыслей и связей

```
GET    /api/v1/networks/{nid}/thought-types
POST   /api/v1/networks/{nid}/thought-types
PATCH  /api/v1/networks/{nid}/thought-types/{id}     If-Match
DELETE /api/v1/networks/{nid}/thought-types/{id}     If-Match
       # 422 если есть мысли с этим типом и не передан ?force=1
       # при force=1 → type_id мыслям обнуляется, определения свойств типа
       # и все их значения удаляются (каскад, L6)

GET/POST/PATCH/DELETE /api/v1/networks/{nid}/link-types  (аналогично:
       # при force=1 → связи остаются без типа, свойства и значения удаляются)
```

Свойства типов: `/thought-types/{id}/properties` и `/link-types/{id}/properties`
(CRUD `type_properties`):

```
GET    …/types/{id}/properties                       — список определений
POST   …/types/{id}/properties                       { key, value_type, config?, required?, position? }
PATCH  …/types/{id}/properties/{propertyId}          { key?, value_type?, config?, required?, position? }
DELETE …/types/{id}/properties/{propertyId}          # значения свойства удаляются каскадом
PUT    …/types/{id}/properties/reorder               { ordered_ids: [...] } → position = index
# config — JSON; config.default_value хранит значение по умолчанию (L6).
# value_type: text | date | number | bool | thought_ref | url (url → value_text).
# PATCH value_type — сервер в той же транзакции преобразует все хранимые
#   значения свойства к новому типу, несовместимые — удаляет (L6).
# PATCH key — переименование; хранимые значения остаются привязаны (property_id).
```

## 9. Свойства

```
GET    /api/v1/networks/{nid}/thoughts/{id}/properties
PUT    /api/v1/networks/{nid}/thoughts/{id}/properties/{key}   { value: ... }
DELETE /api/v1/networks/{nid}/thoughts/{id}/properties/{key}
# Аналогично для /links/{id}/properties
# PUT — upsert; валидация по определению свойства в типе.
```

### 9.1. Использование мысли (обратный поиск по thought_ref)

```
GET /api/v1/networks/{nid}/thoughts/{id}/usage
# Все мысли, в свойствах которых (value_type="thought_ref") использована
# данная мысль. Группировка по свойствам, сортировка по имени свойства,
# затем по заголовку мысли.
→ 200 { data: { total: <число ссылок>,
                groups: [ { property_id, key, thoughts: [ThoughtRef] } ] } }
```

## 10. Комментарии

```
GET    /api/v1/networks/{nid}/thoughts/{id}/comments
POST   /api/v1/networks/{nid}/thoughts/{id}/comments
       { kind: "permanent"|"chronological", title?, body_md,
         valid_from?, valid_to? }       # для permanent valid_from/valid_to игнорируются
PATCH  /api/v1/networks/{nid}/comments/{id}   If-Match
DELETE /api/v1/networks/{nid}/comments/{id}   If-Match
# 409 если попытка создать второй permanent для того же владельца.
# Сервер рендерит body_html из body_md через общий markdown-рендерер.
# Аналогично для /links/{id}/comments
```

## 11. Вложения

```
GET    /api/v1/networks/{nid}/thoughts/{id}/attachments
POST   /api/v1/networks/{nid}/thoughts/{id}/attachments
       { kind: "url"|"file", url?|file_path?, title?, description?, mime_type? }
       # Для kind="url" сервер (best-effort, таймауты 4 c) загружает страницу,
       # заполняет пустой title из <title> и сохраняет favicon в icon (data: URL,
       # ≤64 КиБ). Недоступность сети не ломает создание.
POST   /api/v1/networks/{nid}/thoughts/{id}/attachments/file
       { title?, mime_type, data_base64 }
       # Сервер сохраняет бинарник (≤10 МиБ) в networks/<nid>/attachments/
       # рядом с data.db и создаёт kind="file" вложение с file_path на копию.
       → 201 { data: Attachment }
PATCH  /api/v1/networks/{nid}/attachments/{id}
       { url?|file_path?|title?|description?|mime_type?|position?|icon?|
         owner_type?, owner_id? }
       # owner_type/owner_id переносят вложение к другому владельцу
       # (404, если новый владелец не существует). icon — только data: URL.
DELETE /api/v1/networks/{nid}/attachments/{id}
       # Удаляет и серверную копию файла, если file_path лежит в
       # networks/{nid}/attachments/; клиентские пути не трогает.
GET    /api/v1/networks/{nid}/attachments/{id}/content
       # Контент текстового вложения (kind="file", mime text/* или расширение
       # .txt/.md/.markdown) для встроенного просмотра/редактирования в клиенте:
       # text — содержимое (≤200 000 символов, truncated=true при обрезке),
       # html — markdown-рендер (тот же безопасный рендерер, что у комментариев;
       # null для не-markdown). Для прочих вложений text=null, html=null.
→ 200 { data: { mime_type, text: string|null, html: string|null, truncated: boolean } }
PUT    /api/v1/networks/{nid}/attachments/{id}/content
       { data_base64, mime_type? }
       # Перезаписывает файл текстового вложения (≤10 МиБ decoded) по file_path
       # и обновляет file_size/mime_type. Только kind="file" и только
       # text-подобные вложения (mime text/* или .txt/.md/.markdown), иначе
       # 422 VALIDATION_ERROR. Версионности нет (last-write-wins, как у PATCH).
       # Эмитит attachment.updated.
→ 200 { data: { html: string|null } }   # markdown-рендер нового содержимого
# Аналогично для /links/{id}/attachments
```

## 12. Поиск

```
GET /api/v1/networks/{nid}/search?q=<text>&...
Опциональные параметры:
  in=subtree&from_thought_id=<id>      # только в поддереве
  scope=thoughts|links|chronology|all  # default all
  type_id=<id>&type_id=<id>            # фильтр по типам мыслей (множественный)
  link_type_id=<id>                    # фильтр по типам связей
  show_inactive=true|false             # default: из preferences.show_inactive
  limit=50&offset=0
→ 200 { data: {
  by_names:   [ {thought_id, title, icon, icon_kind, snippet, highlights: [...]} ],
  by_texts:   [ {thought_id, title, icon, icon_kind, snippet, comment_id, highlights} ],
  by_links:   [ {link_id, type_name, snippet, highlights} ],
  by_chrono:  [ {owner: "thought"|"link", owner_id, comment_id, valid_from, valid_to, snippet, highlights} ]
}, meta: { total_in_group: {...} } }
```

Сервер возвращает **snippets** с подсветкой `<mark>...</mark>` вокруг матчей; клиент
рендерит их в соответствии с темой. `icon`/`icon_kind` в `by_names`/`by_texts` —
иконка найденной мысли (клиент показывает её в списке результатов).

## 13. Упоминания (для редактора)

```
GET /api/v1/networks/{nid}/thoughts/{id}/mentions
# Возвращает мысли/связи, в текстах (комментариях) которых встречается title или синоним.
→ 200 { data: [ { owner_type, owner_id, title, comment_id, snippet } ] }
```

Реализация: подготовленный запрос по FTS с перечислением title+синонимов цели.

## 14. Экспорт

```
POST /api/v1/networks/{nid}/export
{ thought_ids: [...], format: "markdown"|"pdf"|"html" }
→ 202 { data: { job_id } }

GET /api/v1/jobs/{job_id}
→ 200 { data: { status, download_url? } }

GET <download_url>   # бинарный поток файла, временный URL с TTL
```

Экспорт — асинхронная задача (PDF/HTML генерируются ресурсоёмко). Markdown —
синхронно (можно вернуть сразу, без job_id).

## 15. Журнал аудита (только admin)

```
GET /api/v1/admin/audit?actor=&network=&category=&from=&to=&limit=&offset=
```

## 16. Системные эндпоинты

```
GET /api/v1/health      → 200 { status: "ok", version, uptime }
GET /api/v1/version     → версия сервера и совместимый диапазон клиентов
```

## 17. Совместимость версий

- Любой клиент при подключении проверяет `GET /api/v1/version`. Если версия сервера
  вне поддерживаемого диапазона — клиент блокирует работу и показывает сообщение.
- Все изменения API идут под новым minor/major в `/api/v1` с возможным выкатом
  `/api/v2` параллельно. На MVP — только `v1`.

## 18. Сохранённые отборы («Структуры мыслей», L3)

Именованные отборы критериев + сортировки (см. §6.10), хранятся per-user в
network-БД (`saved_filters`, [02-data-model.md](02-data-model.md) §3.10.5) и
синхронизируются между клиентами пользователя событиями `saved-filter.*`
(`audience=user`). Пользователь видит и меняет **только свои** отборы;
публикация другим пользователям — вне MVP.

```
GET    /api/v1/networks/{nid}/saved-filters
       → 200 { data: [ { id, name, definition, created_at, updated_at } ] }  # по имени (alpha)
POST   /api/v1/networks/{nid}/saved-filters        # Client-Request-Id
       { name: "Мои счета", definition: { keywords?, type_ids?, link_type_ids?,
         properties?, show_inactive?, sort, order } }
       → 201 { data: { id, name, definition, created_at, updated_at } }
       # name — 1..200 символов; 409 DUPLICATE при повторном имени;
       # definition валидируется как в §6.10
PATCH  /api/v1/networks/{nid}/saved-filters/{fid}  # Client-Request-Id; только свой
       { name?, definition? }                      # 409 при конфликте имени
DELETE /api/v1/networks/{nid}/saved-filters/{fid}  # только свой
```

События после мутаций: `saved-filter.created/updated` (полный объект),
`saved-filter.deleted` (`{ id }`) — [04-realtime.md](04-realtime.md) п. 4.8.

