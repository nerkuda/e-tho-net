# 12. ID-based wiki-ссылки, кросс-сеть, протокол `etn://open`

> [← README](README.md) · [← Workplan](workplan.md) · [← Фаза R](workplan/phase-r.md)

## TL;DR

Расширяем формат wiki-ссылок в комментариях с устаревшего «по имени» на «по
ID мысли». Дополнительно: возможность ссылаться на мысль в другой сети и
внешний deep-link `etn://open?net=…&thought=…` для открытия ETN из других
программ (аналог `obsidian://open?vault=…&file=…`).

Три проблемы, которые закрывает эта фича:

1. **Wiki-ссылки ломаются при переименовании.** Сейчас ссылки
   `[[Имя|alias]]` в `body_md` рендерятся в HTML как
   `<span data-wiki-target="Имя">alias</span>`, а резолюция имени → ID идёт
   на клике через FTS5-поиск по текущему списку имён. После переименования
   мысли ссылка может открыть «другую» мысль или сломаться.
2. **Нет кросс-сетевых ссылок.** Из одной мыслесети нельзя сослаться на
   мысль в другой — даже если обе доступны пользователю.
3. **Нет внешнего deep-link.** Нельзя из Obsidian или проводника
   сохранить ссылку на конкретную мысль ETN так, чтобы клик открыл ETN
   с нужной сетью и мыслью.

**Решение** — три взаимосвязанных слоя:

- **Внутри ETN:** `body_md` хранит `[[#<thoughtId>]]` (или
  `[[#<thoughtId>|<alias>]]`) — текущая сеть; `[[n:<networkId>#<thoughtId>|<alias>]]` —
  кросс-сеть. Legacy `[[Имя|<alias>]]` остаётся без изменений.
- **Внешний протокол:** `etn://open?net=<networkId>&thought=<thoughtId>`
  регистрируется в Electron; single instance lock + проверка открытых
  табов нужной сети.
- **UI CM6-редактора:** пользователь **никогда не видит `#<id>`**.
  В normal-mode вся ссылка скрыта за виджетом с актуальным именем;
  в edit-mode (selection пересекает диапазон) `#<id>`-токен заменён
  на имя, остаётся `atomic range`. Удалённая мысль — серый курсив
  без плейсхолдера.

## 1. Формат в `body_md`

| Форма | Назначение | Резолюция |
|---|---|---|
| `[[#<uuid>]]` | Ссылка по ID в текущей сети | прямой `thoughts.get(uuid)` |
| `[[#<uuid>\|<alias>]]` | + алиас для отображения | прямой `thoughts.get(uuid)` |
| `[[n:<uuid>#<uuid>]]` | Кросс-сеть по ID | прямой `thoughts.get(networkId, uuid)` |
| `[[n:<uuid>#<uuid>\|<alias>]]` | кросс-сеть + алиас | прямой `thoughts.get(networkId, uuid)` |
| `[[Имя\|<alias>]]` | Legacy — резолюция по имени | FTS5 по title в текущей сети |

- Префикс `#` (без `n:`) — текущая сеть.
- Префикс `n:` — кросс-сеть: `n:<networkId>#<thoughtId>`.
- Алиас опционален; при отсутствии отображается имя мысли.
- Legacy `[[Имя|alias]]` остаётся для обратной совместимости. **Без sweep
  по существующим `body_md`** — старые ссылки работают как раньше,
  миграция через контекстное меню «Обновить формат» (см. §5).
- Невалидный UUID в префиксе трактуется как legacy (fallback на поиск по
  имени). Это позволяет вставлять `[[имя с #]]` без экранирования.
- Внутри `[[...]]` недопустимы переносы строк (`\n`/`\r`) — как и в legacy.

## 2. Парсер и рендер (`@etn/markdown`)

**Парсер** в `markdown/src/wiki-link.ts:21-45` расширяется:

1. Содержимое между `[[` и `]]` (`content`) — без изменений: trim, проверка
   на пустоту и переносы.
2. Определяем `kind`:
   - `content.startsWith('#')` → ID-форма текущей сети.
   - `content.startsWith('n:')` → кросс-сеть.
   - Иначе → legacy `name`.
3. Для ID-форм валидируем UUID (regex из
   `client/src/renderer/lib/pure.ts:341` —
   `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`).
   Кросс-сеть требует валидности обеих UUID-частей.
4. Невалидный UUID → fallback на legacy `name` (как сейчас).
5. `WikiLinkMeta` дополняется полями `targetId?: string`,
   `networkId?: string`, `kind: 'name' | 'id' | 'cross'`.

**Рендер** в `markdown/src/wiki-link.ts:47-55`:

| Форма | HTML |
|---|---|
| `[[Имя\|alias]]` | `<span class="wiki-link" data-wiki-target="Имя">alias</span>` (как сейчас) |
| `[[#<uuid>]]` / `[[#<uuid>\|alias]]` | `<span class="wiki-link" data-wiki-id="<uuid>" data-wiki-target="<uuid>"></span>` |
| `[[n:<net>#<uuid>]]` / `[[n:<net>#<uuid>\|alias]]` | `<span class="wiki-link" data-wiki-id="<uuid>" data-wiki-network="<net>" data-wiki-target="<uuid>"></span>` |

- Текст внутри спана для ID-форм — **пустой**. Клиент заполняет его на лету
  через `etn.thoughts.resolve` (см. §4).
- Экранирование HTML/XSS в alias и target — как сейчас (`md.utils.escapeHtml`).
- `MD_RENDER_VERSION` **не поднимаем**: формат HTML обратно совместим
  (добавление новых `data-*` атрибутов не ломает старый кеш `body_html`).
- Экспорт констант `WIKI_LINK_ID_ATTR = 'data-wiki-id'`,
  `WIKI_LINK_NETWORK_ATTR = 'data-wiki-network'` через
  `markdown/src/index.ts:22-24`.

## 3. UI в CM6-редакторе (`client/src/renderer/editor/wiki-link.ts`)

Пользователь **никогда не видит `#<id>`** в редакторе — отображается только
актуальное имя мысли. Это ключевое UX-решение фичи.

### 3.1. Lezer-грамматика

Lezer-парсер (`wiki-link.ts:49-71`) расширяется для распознавания ID-форм
**синхронно с markdown-it** (R2). Любые расхождения в двух парсерах
приведут к визуальному рассинхрону между view-режимом и редактором.

### 3.2. Normal-mode (selection не пересекает диапазон)

`Decoration.replace({ widget })` на **весь диапазон**
`[[#<id>|<alias>]]` (или `[[n:...#<id>|<alias>]]`). Виджет
`WikiLinkWidget` рендерит:

```html
<span class="wiki-link">${alias || title || id}</span>
```

- `inclusive: false` — курсор прыгает через блок как через один символ.
- Класс `wiki-link-deleted` (серый курсив) добавляется при `exists: false`
  (мысль удалена).
- `[[`, `]]`, `#<id>`, `|` — **скрыты полностью** за виджетом.

### 3.3. Edit-mode (selection пересекает диапазон)

При попадании selection внутрь `[[...]]` или к её границам — снимаем
`Decoration.replace` на весь диапазон. Вместо этого:

- `Decoration.replace({ widget })` только на **токен `#<id>`** (или
  `n:<net>#<id>`). Виджет рендерит
  `<span class="wiki-link-id">${title}</span>`.
- `[[`, `|`, `]]` — обычные символы в `Doc`.
- Дополнительно — `Decoration.mark({ atomic: true, inclusive: true,
  attributes: { class: 'cm-wiki-id' } })` на этот же токен:
  - `Backspace`/`Delete` рядом с токеном → удаляют его целиком.
  - `ArrowLeft`/`ArrowRight` через токен → перепрыгивают.
  - Посимвольный ввод игнорируется.
- Имя в `<span class="wiki-link-id">` — выделено **цветом**
  (CSS-класс `cm-wiki-id-edit`), чтобы пользователь визуально понимал,
  что это единый объект, а не обычный текст.
- Удалённая мысль: серый курсив (`font-style: italic; color: var(--muted)`).

Пользователь видит `[[<имя>]]` или `[[<имя>|<alias>]]` — `#<id>` физически
невидим, на его месте — спан с именем.

### 3.4. Copy-paste

`cm.state.doc.toString()` возвращает **исходник** с `[[#<id>]]` или
`[[n:<net>#<id>]]`. Это значит:

- При копировании фрагмента текста из редактора сохраняется привязка к мысли.
- Вставка в другой комментарий ETN — работает (CM6-парсер распознаёт).
- Вставка в Obsidian или другой markdown-редактор — сохраняется как
  `[[#<id>]]` (plain text). Это **plain-text deep link**: можно потом
  вставить в ETN, и он будет распознан (если есть мысль с таким ID в
  текущей сети) или как legacy (если ID не найден).

### 3.5. Производительность

`StateField<Map<string, { title, exists, networkId }>>` хранит кеш
`id → meta`. Батч-резолюция через `etn.thoughts.resolve(networkId, ids)` (до
100 ID за раз, по образцу `links-tab.ts:345`). Для кросс-сети — отдельные
батчи по `networkId`.

Пересчёт декораций на каждый `selection` потенциально дорог. Реализация —
пересчитывать декорации только для диапазонов в окрестности курсора
(±100 строк), дальние — кешировать до следующего `docChanged` или
realtime-события. Возможна двух-`StateField` схема (локальный/глобальный).

### 3.6. Автокомплит `[[`

Без изменений в источнике данных (`etn.thoughts.search` с
`scope: 'names'`, кеш 10 с). Изменяется **вставка** при выборе кандидата:

- Было: `apply: ${hit.title}]]` → `[[имя]]`.
- Стало: `apply: #${hit.thought_id}]]` → `[[#<id>]]` (без алиаса).

Decryption.replace (R6) автоматически подхватит и покажет имя. Если
пользователь хочет алиас — дописывает руками после `|`.

## 4. UI в view-режиме (`body_html` после рендера)

Сервер кладёт `<span data-wiki-id="..."></span>` (пустой текст) для ID-форм.
Клиент при загрузке view-режима заполняет текст:

### 4.1. Резолвер `data-wiki-id` → имя

Новый модуль `client/src/renderer/editor/wiki-link-resolver.ts`:

```ts
function resolveWikiLinksInDom(root: HTMLElement, networkId: string): void {
  const spans = root.querySelectorAll('[data-wiki-id]');
  const ids = [...new Set(Array.from(spans).map(s => s.dataset.wikiId!))];
  // батч до 100 ID через etn.thoughts.resolve
  // заполнить textContent = title || '' (с классом wiki-link-deleted при exists=false)
}
```

- Подключается в `markdown-field.ts` (view-режим комментария),
  `chronicle`, экспорте.
- Локальный кеш `Map<networkId, Map<id, …>>` на сессию — повторный
  resolve без сетевого запроса.

### 4.2. Realtime-обновление

Расширить `client/src/renderer/realtime-ui.ts:60-115` (`applyRealtimeToUi`):

- `thought.updated` — найти все `[data-wiki-id="<id>"]`, обновить
  `textContent` и снять класс `wiki-link-deleted`.
- `thought.deleted` — очистить `textContent`, добавить класс
  `wiki-link-deleted`.

## 5. Миграция legacy `[[Имя|alias]]`

**Без sweep по существующим `body_md`** (решение пользователя). Старые
ссылки работают по имени, как сейчас. Миграция — ручная, через
контекстное меню.

### 5.1. Контекстное меню «Обновить формат»

Плагин `client/src/renderer/editor/wiki-link-legacy-actions.ts`:

- Срабатывает на правом клике по спану с `data-wiki-target` без
  `data-wiki-id`.
- Пункт «Обновить формат на `[[#<id>]]`» доступен при однозначной
  резолюции (через `etn.thoughts.findDuplicates` или
  `etn.thoughts.search({scope:'names'})`).
- При выборе — `cm.dispatch({ changes: { from, to, insert: '#<id>' } })`.
  Decryption.replace (R6) подхватит, имя появится автоматически.
- При неоднозначной/нулевой резолюции — диалог `pickThoughtsDialog`
  (как в существующих диалогах выбора мысли).

### 5.2. Поведение legacy при переименовании

Legacy `[[Имя|alias]]` **не обновляется автоматически** при переименовании
мысли. Это явное решение: такие ссылки — целиком на совести пользователя.

## 6. Backlinks: «Ссылки на мысль» в табе «Связи»

### 6.1. Серверный эндпоинт `etn.thoughts.backlinks`

REST: `GET /networks/{networkId}/thoughts/{id}/backlinks` —

`server/src/domain/backlinks-service.ts`:

```ts
function findBacklinks(ndb: NetworkDb, thoughtId: string): BacklinkHit[]
```

- Regex-поиск `[[#<uuid>]]` и `[[n:<net>#<uuid>]]` в `body_md` всех
  комментариев сети.
- Anti-self: совпадения в комментариях самой искомой мысли (`c.owner_id
  <> ?`) отбрасываются.
- Коллапс: несколько совпадений в одном комментарии → один хит с лучшим
  сниппетом.
- Сниппет через `makeSnippet` (как в `findMentions`).
- **Runtime** — без отдельной таблицы (решение пользователя).

MCP-инструмент `etn.thoughts.backlinks` (`readOnlyHint: true`,
`view: 'compact' | 'full'`) и MCP-ресурс `etn.thought.backlinks`
(шаблон `etn://networks/{network_id}/thoughts/{thought_id}/backlinks`)
— по образцу `etn.thoughts.usage`.

### 6.2. UI: две подгруппы в «Упоминания»

В `client/src/renderer/editor/links-tab.ts` существующая группа
«Упоминания» заменяется на контейнер с двумя подсекциями:

- **«Ссылки на мысль»** (id `mentions:backlinks`, defaultCollapsed: true,
  lazyCount: true) — через `etn.thoughts.backlinks`. Клик по строке
  открывает комментарий-владелец (через `setFocus` для мысли или
  `openLinkInEditor` для связи).
- **«Упоминания в тексте»** (id `mentions:text`, defaultCollapsed: true) —
  текущий `buildMentionsBody` через `etn.thoughts.mentions`.

Обе группы свёрнуты по умолчанию — пользователь явно решает, что готов
подождать выполнения запроса.

**Realtime-обновление для backlinks — TODO отдельной задачи.** В текущем
realtime нет `comment.*`-событий (`realtime-ui.ts:60-115` обрабатывает
только `thought.*`/`link.*`/`property-value.*`). Backlinks в табе
обновляются только при ручном `reload()` (раскрытие подгруппы, изменение
фильтра `showInactive`).

## 7. Протокол `etn://open?…`

### 7.1. URL-формат

```
etn://open?net=<networkId>&thought=<thoughtId>
```

Оба параметра — UUID v4. `net` обязателен (мысль всегда в конкретной сети).
Лишние query-параметры игнорируются. URL-encode для UUID не нужен (UUID
содержит только `[0-9a-f-]`), но реализация должна быть готова к нему.

### 7.2. Регистрация в Electron

В `client/src/main/index.ts`:

```ts
protocol.registerSchemesAsPrivileged([
  ...,
  { scheme: 'etn', privileges: { standard: true, secure: true, supportFetchAPI: false } },
]);

app.whenReady().then(() => {
  app.setAsDefaultProtocolClient('etn');
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) app.quit();
  app.on('second-instance', (event, argv) => { /* extractDeepLinkFromArgv(argv) */ });
  app.on('open-url', (event, url) => { /* macOS */ });
});
```

### 7.3. Cold start (Win/Linux)

`process.argv` может содержать `etn://open?…` как последний аргумент.
Извлекаем через `process.argv.find(arg => arg.startsWith('etn://'))`,
парсим через `parseDeepLinkUrl`, отправляем в renderer после создания
окна:

```ts
webContents.send('etn:deep-link', { networkId, thoughtId });
```

### 7.4. Renderer-обработчик

В renderer — обработчик `etn:deep-link`:

1. Проверить, есть ли открытый таб нужной сети (по API фазы Q —
   `etn.tabs.list` или аналогичный).
2. Если есть таб → переключиться на него + `setFocus(thoughtId)`.
3. Если нет таба, сеть доступна → открыть новый таб + фокус.
4. Если сеть недоступна → `notice('Сеть недоступна', 'error')`.
5. Если мысль удалена (404 при попытке фокуса) →
   `notice('Мысль удалена или недоступна', 'error')`.

### 7.5. Тестирование

- В dev-режиме `setAsDefaultProtocolClient` регистрирует путь к dev-EXE.
- Для полного теста в packaged-режиме — `npm -w @etn/client run build`
  + `npm -w @etn/client run dist`.

## 8. MCP-агенты

### 8.1. Новый ресурс и инструмент

- `etn.thought.backlinks` (ресурс, шаблон
  `etn://networks/{network_id}/thoughts/{thought_id}/backlinks`).
- `etn.thoughts.backlinks` (инструмент, `readOnlyHint: true`).

См. `docs/05-mcp-server.md` §4/§5 и `docs/03-server-api.md` §13.

### 8.2. Хелпер `buildDeepLinkUrl`

MCP-агент может построить human-friendly URL через
`buildDeepLinkUrl({ networkId, thoughtId })` из `@etn/shared` и вернуть
пользователю как «ссылку для человека» (для вставки в Obsidian,
markdown-файлы, письма).

Документируется в `docs/05-mcp-server.md` §4 как отдельный шаблон
`etn://open?…` — чисто документационная строка, без отдельного MCP-ресурса.

## 9. Безопасность и авторизация

- **Кросс-сеть:** новый клиентский вызов `etn.thoughts.get(otherNetworkId,
  id)` требует, чтобы у пользователя был доступ к `otherNetworkId`.
  Проверка — на сервере (текущая `requireNetworkMember()` /
  `openMemberNetwork()`).
- **Deep-link:** `etn://open?net=<networkId>` — если у пользователя нет
  доступа к сети, клиент показывает `notice('Сеть недоступна')`. Не
  раскрывает факт существования сети.
- **`data-wiki-network` в HTML:** это публичный атрибут (виден в
  `body_html`). Поскольку `network_id` — UUID (не отображает имя сети),
  раскрытие `network_id` допустимо. Имя сети отображается только в UI
  клиента после авторизации.

## 10. Связь с другими документами

- `docs/02-data-model.md` — без изменений (формат `body_md` не меняется на
  уровне схемы БД).
- `docs/03-server-api.md` §13 — новый раздел «Backlinks».
- `docs/04-realtime.md` — без изменений (realtime `comment.*` события не
  вводятся).
- `docs/05-mcp-server.md` §4/§5 — новые строки в таблицах.
- `docs/06-auth.md` — без изменений (доступ к сети уже контролируется).
- `docs/07-client-electron.md` §4 — новый протокол `etn://`.
- `docs/08-ui-spec.md` §6.4 (комментарий) и §6.7 (таб «Связи») —
  расширения.
- `docs/09-scenarios.md` — без изменений (новые сценарии — в `phase-r.md`).
- `docs/10-glossary.md` — добавить термин «ID-based wiki-link» (TODO
  отдельной правкой).
- `docs/11-settings-and-state.md` — без изменений.

## 11. Подводные камни

1. **DB-тесты под `node --test` SKIPятся** (см. AGENTS.md §10) —
   assertions в тестах `findBacklinks` должны быть на месте, проходят
   в CI / под реальной БД.
2. **CM6 inline-узел `WikiLink` и markdown-it `wiki_link` — два
   независимых парсера.** Синтаксис новой формы должен быть согласован
   в обоих.
3. **Производительность декораций CM6** — пересчёт на каждый selection
   может быть тяжёлым; окрестность ±100 строк или двух-`StateField`.
4. **Realtime `comment.*` отсутствует** — backlinks в табе без
   realtime-обновления; TODO отдельной задачи (завести событие).
5. **Packaged build для `etn://` тестов** — нужен
   `npm -w @etn/client run build`, в dev тестируем через прямую отправку
   URL в renderer.
6. **argv на Win/Linux** — ищем через
   `process.argv.find(arg => arg.startsWith('etn://'))`.
7. **Кросс-сеть и MCP** — `etn.networks.list` уже выдаёт все доступные
   пользователю сети, агент может сам резолвить `network_id` →
   `thought_id`.
