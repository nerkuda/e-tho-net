# Фаза R — ID-based wiki-ссылки, кросс-сеть, протокол `etn://open`

> [← Workplan (индекс)](../workplan.md) — оглавление, статусы фаз и решения.

> По запросу пользователя (23.08.2026). Цель — закрыть три связанных проблемы
> ETN: (1) wiki-ссылки `[[Имя|alias]]` ломаются при переименовании мысли;
> (2) невозможно сослаться из одной мыслесети на мысль в другой;
> (3) нет внешнего deep-link для открытия ETN с нужной сетью и мыслью
> (по аналогии с `obsidian://open?vault=…&file=…`).

Сквозной контекст: `docs/12-wiki-id-refs.md` (новый), `08-ui-spec.md §6.7`
(таб «Связи»), `03-server-api.md §13` (упоминания), `05-mcp-server.md §4/§5`
(MCP-ресурсы и инструменты), `07-client-electron.md §4` (протоколы Electron).

## Архитектурные решения (зафиксированы с пользователем)

- **Формат в `body_md`:** четыре формы — `[[#<uuid>]]`, `[[#<uuid>|<alias>]]`,
  `[[n:<uuid>#<uuid>]]`, `[[n:<uuid>#<uuid>|<alias>]]` — плюс legacy
  `[[Имя|<alias>]]` без sweep. Миграция legacy через контекстное меню
  «Обновить формат».
- **Серверный `body_html` остаётся stateless.** Для ID-форм рендерер кладёт
  `<span class="wiki-link" data-wiki-id="…" data-wiki-network="…"></span>`
  (пустой текст); клиент резолвит имя на лету батчем `etn.thoughts.resolve`.
  `MD_RENDER_VERSION` не поднимаем.
- **CM6 normal-mode:** `Decoration.replace` на всю ссылку → виджет с актуальным
  именем. Курсор прыгает через блок.
- **CM6 edit-mode:** `Decoration.replace` только на токен `#<id>` → виджет с
  именем; `[[`, `|`, `]]` — обычные символы; токен — `atomic range`
  (Backspace/Delete удаляют целиком). Имя в edit-mode — выделено цветом.
- **Удалённая мысль:** серый курсив, без плейсхолдера «удалённая мысль».
- **Backlinks:** runtime regex по `body_md` (без отдельной таблицы), anti-self,
  коллапс по `(owner_type, owner_id)`. Таб «Связи» — две подсекции в группе
  «Упоминания»: «Ссылки на мысль» (новый, через `etn.thoughts.backlinks`) и
  «Упоминания в тексте» (текущий, через `etn.thoughts.mentions`). Обе свёрнуты
  по умолчанию.
- **`etn://open?net=…&thought=…`:** регистрация в Electron
  (`setAsDefaultProtocolClient` + single instance lock), проверка открытых
  табов нужной сети, переключение или открытие нового таба; при недоступности
  сети или удалённой мысли — сообщение.
- **Порядок работ:** сначала сервер + автотесты (R1–R5), прогон
  `typecheck`/`test`; затем клиент + автотесты (R6–R11), прогон; финал —
  R12 (QA + ручная проверка пользователем).
- **Зависимость:** фаза Q (табы) должна быть `done` до R11 — иначе блокер.

## R1. Спецификация `docs/12-wiki-id-refs.md` + правки существующих документов

- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** новый документ `docs/12-wiki-id-refs.md` с полным описанием
  фичи (формат `body_md`, парсер, рендер, deep-link, MCP-агенты, UX в CM6 и
  view-режиме, миграция legacy). Правки смежных документов:
  `docs/03-server-api.md` (новый §13 «Backlinks» по образцу §13 «Mentions»),
  `docs/05-mcp-server.md` (новые строки в таблице ресурсов и списке
  инструментов), `docs/08-ui-spec.md` (раздел про wiki-ссылки и таб «Связи»),
  `docs/README.md` (строка про `12-wiki-id-refs.md`).
- **DoD:**
  - [ ] `docs/12-wiki-id-refs.md` создан (TL;DR, формат `body_md`, парсер,
    рендер, deep-link, MCP, UI CM6, view-режим, миграция legacy).
  - [ ] `docs/03-server-api.md` — добавлен §13 «Backlinks», контракт
    `GET /networks/{nid}/thoughts/{id}/backlinks` расписан.
  - [ ] `docs/05-mcp-server.md:71-88` — добавлены строки в таблицу ресурсов
    и список инструментов.
  - [ ] `docs/08-ui-spec.md:1066-1074` — обновлены разделы wiki-ссылок
    и таб «Связи».
  - [ ] `docs/README.md:17-29` — добавлена строка про `12-wiki-id-refs.md`.
  - [ ] `npm run typecheck` зелёный (только-docs, типы не меняются, но
    проверяем для дисциплины).
  - [ ] Ручная проверка пользователем (последним пунктом).

## R2. Markdown-рендерер: парсер и HTML для `[[#<id>]]` / `[[n:<net>#<id>]]`

- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** R1
- **Описание:** расширить `markdown/src/wiki-link.ts` для поддержки двух
  новых префиксов внутри `[[…]]`. Парсер: если первый непробельный символ —
  `#`, валидируем UUID (regex из `client/src/renderer/lib/pure.ts:341`);
  если `n:`, валидируем обе UUID-части. Legacy `[[Имя|alias]]` — без
  изменений. `WikiLinkMeta` дополнить `targetId?`, `networkId?`,
  `kind: 'name' | 'id' | 'cross'`. Рендер: для ID-форм —
  `<span class="wiki-link" data-wiki-id="…" [data-wiki-network="…"]
  data-wiki-target="…"></span>` (пустой текст внутри); для legacy — как
  сейчас. Экспорт `WIKI_LINK_ID_ATTR`, `WIKI_LINK_NETWORK_ATTR`.
  `MD_RENDER_VERSION` НЕ поднимаем (формат HTML обратно совместим).
- **Точки расширения:**
  - `markdown/src/wiki-link.ts:11-13` (константы).
  - `markdown/src/wiki-link.ts:16-19` (мета).
  - `markdown/src/wiki-link.ts:21-45` (парсер).
  - `markdown/src/wiki-link.ts:47-55` (рендер).
  - `markdown/src/index.ts:22-24` (реэкспорт).
  - `markdown/tests/renderer.test.ts:57-106` (тесты).
- **DoD:**
  - [ ] Парсер распознаёт `[[uuid]]`, `[[uuid|alias]]`,
    `[[n:<uuid>#<uuid>]]`, `[[n:<uuid>#<uuid>|<alias>]]`.
  - [ ] Невалидный UUID-префикс трактуется как legacy (fallback на имя).
  - [ ] В HTML для ID-форм присутствует `data-wiki-id`, текст внутри
    спана пустой.
  - [ ] Legacy `[[Имя|alias]]` рендерится без изменений (регрессии нет).
  - [ ] Экранирование HTML/XSS в alias по-прежнему работает.
  - [ ] Тесты в `markdown/tests/renderer.test.ts` для всех новых форм +
    регрессионные на legacy.
  - [ ] `npm -w @etn/markdown test` зелёный.
  - [ ] `npm -w @etn/markdown run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## R3. Серверный `etn.thoughts.backlinks` (REST + MCP)

- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** R2
- **Описание:** новый сервис для поиска упоминаний текущей мысли через
  явные `[[#<id>]]`-ссылки в `body_md` комментариев. Реализация — runtime
  regex по `body_md` (решение пользователя: без отдельной таблицы).
- **Точки расширения:**
  - Новый файл `server/src/domain/backlinks-service.ts` — функция
    `findBacklinks(ndb, thoughtId): BacklinkHit[]`.
  - DTO `BacklinkHit` в `shared/src/types/search.ts` (по образцу
    `MentionHit:90-99`).
  - Regex для поиска:
    `/\[\[#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\|[^\]\n]*)?\]\]/gi`
    — ищем `[[#<id>]]` или `[[#<id>|<alias>]]`. Кросс-сеть:
    `\[\[n:[0-9a-f-]+#([0-9a-f-]{36})(\|[^\]\n]*)?\]\]` — берём `id` из
    второй группы. Anti-self: совпадения, где комментарий принадлежит самой
    искомой мысли (`c.owner_id <> ?`), отбрасываем.
  - В одном комментарии несколько совпадений — коллапсируем в один хит
    с лучшим сниппетом (по образцу `findMentions:1077-1089`).
  - REST `GET /networks/:networkId/thoughts/:id/backlinks` в
    `server/src/routes/thoughts.ts:760-771` (рядом с `/mentions`).
  - MCP-инструмент `etn.thoughts.backlinks` в
    `server/src/mcp/tools.ts:776-832` (по образцу `etn.thoughts.usage`) —
    `readOnlyHint: true`, `view: 'compact' | 'full'`.
  - MCP-ресурс `etn.thought.backlinks` в
    `server/src/mcp/resources.ts:183-204` (по образцу `etn.thought.usage`) —
    шаблон `etn://networks/{network_id}/thoughts/{thought_id}/backlinks`,
    `mimeType: JSON_MIME`.
  - IPC-прокладка `'thoughts.backlinks'` в
    `client/src/main/ipc/handlers.ts` (рядом с `thoughts.mentions:353`).
  - Контракт `client/src/main/ipc/contract.ts` — добавить
    `backlinks(networkId, id): Promise<BacklinkHit[]>` рядом с
    `mentions:269`.
- **Тесты:**
  - `server/tests/backlinks-service.test.ts` (новый) — кейсы: находка в
    `body_md`, anti-self, коллапс, legacy `[[Имя]]` не считается, кросс-сеть
    regex, alias в regex, невалидный UUID не считается.
  - Расширить `server/tests/routes-thoughts.test.ts` — REST `/backlinks`
    (по образцу `/mentions` на строке 502).
  - Расширить `server/tests/mcp-tools.test.ts` — инструмент и ресурс.
  - Использовать `createInMemoryNetworkDb()` (по сводке из
    `search-service.test.ts:467`).
- **DoD:**
  - [ ] `findBacklinks(ndb, thoughtId)` корректен (regex + anti-self + коллапс).
  - [ ] REST `/networks/{nid}/thoughts/{id}/backlinks` отвечает 200.
  - [ ] MCP-инструмент `etn.thoughts.backlinks` зарегистрирован в
    `MCP_TOOL_NAMES`, `readOnlyHint: true`.
  - [ ] MCP-ресурс `etn.thought.backlinks` зарегистрирован.
  - [ ] IPC `thoughts.backlinks` в контракте и handler.
  - [ ] Тесты `backlinks-service.test.ts` написаны,
    `routes-thoughts.test.ts` расширен, `mcp-tools.test.ts` расширен.
  - [ ] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## R4. Общий хелпер `shared/src/deep-link.ts` для `etn://open?…`

- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** —
- **Описание:** общий модуль для построения и парсинга deep-link URL.
  Используется клиентом (R11) и MCP-агентами (R5). Экспортирует:
  - `buildDeepLinkUrl({ networkId, thoughtId }): string` →
    `etn://open?net=<uuid>&thought=<uuid>` (URL-encode).
  - `parseDeepLinkUrl(url: string): { networkId, thoughtId } | null` —
    strict-парсер, возвращает `null` для не-`etn://open` URL и невалидных
    UUID.
  - UUID-валидация — переиспользовать regex из
    `client/src/renderer/lib/pure.ts:341` (или вынести в
    `shared/src/lib/uuid.ts`, если R2/R4 пересекаются).
- **Точки расширения:**
  - Новый файл `shared/src/deep-link.ts`.
  - Реэкспорт через `shared/src/index.ts` (если есть центральный barrel).
- **Тесты:** `shared/tests/deep-link.test.ts` (новый) — round-trip,
  невалидный URL, невалидный UUID, query-параметры в другом порядке, лишние
  query-параметры (игнорируем).
- **DoD:**
  - [ ] Хелпер экспортируется из `shared/`.
  - [ ] Тесты round-trip и негативные кейсы зелёные.
  - [ ] `npm -w @etn/shared run typecheck` и `npm -w @etn/shared test`
    (если есть) зелёные.
  - [ ] Ручная проверка пользователем (последним пунктом).

## R5. Расширение MCP-документации для `etn://open?…`

- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** R4
- **Описание:** дополнить `docs/05-mcp-server.md` §4 (таблицу ресурсов)
  строкой про шаблон `etn://open?net={network_id}&thought={thought_id}` как
  «human-friendly link». В БД и коде этого шаблона как MCP-ресурса нет — это
  чисто документационная правка (MCP-агент строит URL через
  `buildDeepLinkUrl` из R4 и возвращает пользователю).
- **DoD:**
  - [ ] В `docs/05-mcp-server.md` §4 добавлена строка про `etn://open?…`
    (назначение: «human-friendly deep link для копирования и передачи
    пользователю»).
  - [ ] Упомянуто, что URL строится через `buildDeepLinkUrl` из
    `@etn/shared`.
  - [ ] Ручная проверка пользователем (последним пунктом).

## R6. CM6-плагин wiki-link: ID-форма, декорации, кеш

- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** R2
- **Описание:** расширить `client/src/renderer/editor/wiki-link.ts` для
  полноценной поддержки `[[#<id>]]`-ссылок в редакторе комментария. Lezer
  распознаёт ID-формы. Новый `StateField<Map<string, { title, exists,
  networkId }>>` — кеш `id → meta`. Декорации (normal/edit-mode по позиции
  курсора): normal — `Decoration.replace` на всю ссылку; edit —
  `Decoration.replace` только на `#<id>`-токен, `atomic range`. Удалённая
  мысль — серый курсив. Цвет в edit-mode для блока `<имя>`.
  `cm.state.doc.toString()` возвращает исходник с `[[#<id>]]` (copy-paste
  сохраняет ссылку).
- **Точки расширения:**
  - `client/src/renderer/editor/wiki-link.ts:32, 40-46, 49-71, 74-76, 78-93`.
  - `client/src/renderer/editor/md-editor.ts:192-195` (подключение).
  - `client/src/renderer/styles.css` (стили `.cm-wiki-id`,
    `.cm-wiki-id-edit`, `.wiki-link-deleted`).
- **Тесты:** `client/tests/wiki-link.test.ts` (расширить — pure-парсер);
  `client/tests/wiki-id-plugin.test.ts` (новый — кеш + декорации
  normal/edit).
- **DoD:**
  - [ ] Lezer подсвечивает ID-формы как `tags.link`.
  - [ ] normal-mode: ссылка отображается как имя/alias, `[[`/`]]`/`#id`/`|`
    скрыты.
  - [ ] edit-mode: имя на месте `#id`, токен atomic range.
  - [ ] Удалённая мысль — серый курсив.
  - [ ] Кеш обновляется батчем `etn.thoughts.resolve`; realtime
    `thought.updated`/`deleted` инвалидирует.
  - [ ] copy-paste сохраняет `[[#<id>]]` в `state.doc`.
  - [ ] Тесты в `client/tests/wiki-link.test.ts` (расширить) и
    `client/tests/wiki-id-plugin.test.ts` (новый).
  - [ ] `npm -w @etn/client test` зелёный.
  - [ ] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## R7. Клиентский view-резолвер `data-wiki-id` → имя

- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** R2
- **Описание:** пост-процессор DOM для view-режима (карточка мысли,
  chronicle, экспорт) — заполняет пустые `<span data-wiki-id="…">` именами
  из БД. Батч `etn.thoughts.resolve` (до 100), локальный кеш на сессию.
  Realtime `thought.updated`/`deleted` обновляет DOM.
- **Точки расширения:**
  - Новый `client/src/renderer/editor/wiki-link-resolver.ts`.
  - Подключить в `markdown-field.ts` (view-режим), chronicle, экспорте.
  - Расширить `client/src/renderer/realtime-ui.ts:60-115`.
- **Тесты:** `client/tests/wiki-link-resolver.test.ts` (jsdom + мок).
- **DoD:**
  - [ ] Пустые спаны `[data-wiki-id]` заполняются после загрузки view.
  - [ ] Локальный кеш на сессию — повторный resolve без сетевого запроса.
  - [ ] Realtime `thought.updated` обновляет текст в DOM без перерендера.
  - [ ] Realtime `thought.deleted` очищает текст и помечает стилем.
  - [ ] Тесты в `client/tests/wiki-link-resolver.test.ts`.
  - [ ] `npm -w @etn/client test` зелёный.
  - [ ] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## R8. Клик-handler: резолюция ID-ссылки и кросс-сеть

- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** R6, R7
- **Описание:** расширить `client/src/renderer/editor/wiki-link.ts:217-231`
  (`initWikiLinkNavigation`) — обработка `data-wiki-id` на клике. Если сеть
  совпадает с активной — `etn.thoughts.get` + `openThoughtByRef`. Если другая
  — переключить активную сеть + `openThoughtByRef`. Недоступная сеть /
  удалённая мысль — сообщения. Legacy `data-wiki-target` без `data-wiki-id`
  — как сейчас.
- **Точки расширения:**
  - `client/src/renderer/editor/wiki-link.ts:217-231`.
  - `client/src/renderer/editor/wiki-link.ts:155-181` (без изменений).
- **Тесты:** `client/tests/wiki-link.test.ts` (мок `etn.thoughts.get`).
- **DoD:**
  - [ ] Клик по `[[#<id>]]` (текущая сеть) открывает мысль.
  - [ ] Клик по `[[n:<net>#<id>]]` переключает сеть и открывает мысль.
  - [ ] Недоступная сеть / удалённая мысль — сообщения.
  - [ ] Legacy продолжает работать.
  - [ ] Тесты в `client/tests/wiki-link.test.ts`.
  - [ ] `npm -w @etn/client test` зелёный.
  - [ ] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## R9. Таб «Связи»: две подгруппы в «Упоминания»

- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** R3
- **Описание:** в `client/src/renderer/editor/links-tab.ts` существующая
  группа «Упоминания» заменяется на контейнер с двумя подсекциями —
  «Ссылки на мысль» (новый, через `etn.thoughts.backlinks`) и
  «Упоминания в тексте» (текущий, через `etn.thoughts.mentions`). Обе
  свёрнуты по умолчанию. Если `comment.*`-событий нет — без
  realtime-обновления (TODO отдельной задачи).
- **Точки расширения:**
  - `client/src/renderer/editor/links-tab.ts:60-140` (`buildLinksTab`).
  - `client/src/renderer/editor/links-tab.ts:307-392` (без изменений).
- **Тесты:** `client/tests/links-tab.test.ts` (моки).
- **DoD:**
  - [ ] Группа «Упоминания» содержит «Ссылки на мысль» и
    «Упоминания в тексте».
  - [ ] Обе свёрнуты по умолчанию.
  - [ ] Бейдж родительской группы = сумма видимых после `showInactive`.
  - [ ] Клик по строке backlinks открывает комментарий-владелец.
  - [ ] Тесты для `buildBacklinksBody` написаны.
  - [ ] `npm -w @etn/client test` зелёный.
  - [ ] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## R10. Контекстное меню legacy «Обновить формат ссылки»

- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** R6
- **Описание:** плагин для CM6, добавляющий пункт контекстного меню на
  legacy-ссылках (только те, у которых нет `data-wiki-id`). Резолюция через
  `etn.thoughts.findDuplicates` или `search({scope:'names'})`. При
  однозначной резолюции — `cm.dispatch({ changes: ... })` для замены.
  При неоднозначной/нулевой — `pickThoughtsDialog`.
- **Точки расширения:**
  - Новый `client/src/renderer/editor/wiki-link-legacy-actions.ts`.
  - Подключить в `md-editor.ts:192-195`.
  - Добавить `data-legacy-link="true"` в рендер при отсутствии
    `data-wiki-id`.
- **Тесты:** `client/tests/wiki-link-legacy-actions.test.ts` (моки).
- **DoD:**
  - [ ] Контекстное меню на legacy-ссылке содержит пункт «Обновить формат».
  - [ ] При однозначной резолюции текст в документе заменяется.
  - [ ] При неоднозначной/нулевой — диалог выбора.
  - [ ] Тесты в `client/tests/wiki-link-legacy-actions.test.ts`.
  - [ ] `npm -w @etn/client test` зелёный.
  - [ ] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## R11. Протокол `etn://open?…` в Electron

- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** R4, R8
- **Описание:** зарегистрировать кастомный протокол `etn://` в Electron.
  Single instance lock, обработчики `second-instance`/`open-url`.
  Парсинг `process.argv` при cold start. Доставка в renderer через
  `webContents.send('etn:deep-link', ...)`. Проверка открытых табов нужной
  сети (по API фазы Q).
- **Точки расширения:**
  - `client/src/main/index.ts:38-40` (registerSchemesAsPrivileged).
  - `client/src/main/index.ts:114-161` (рядом с `registerEtnimgProtocol`).
  - `client/src/main/index.ts:167-203` (whenReady).
  - Новый `client/src/main/ipc/deep-link.ts`.
  - Renderer: `client/src/renderer/editor/deep-link-handler.ts`.
  - Переиспользовать `parseDeepLinkUrl` из R4.
- **Зависимость:** фаза Q (табы) должна быть `done` до R11.
- **Тесты:** `client/tests/deep-link.test.ts` (`parseDeepLinkUrl`,
  `extractDeepLinkFromArgv`, round-trip).
- **DoD:**
  - [ ] `etn://` зарегистрирован в Electron.
  - [ ] `setAsDefaultProtocolClient('etn')` вызван.
  - [ ] `requestSingleInstanceLock` + обработчики `second-instance`/
    `open-url` работают.
  - [ ] При клике на `etn://open?…` из браузера/проводника/Obsidian
    открывается ETN с нужной сетью и мыслью.
  - [ ] Если сеть открыта в табе — переключение на этот таб + фокус.
  - [ ] Если таба нет — открывается новый таб + фокус (или активируется
    сеть, если табы ещё не доступны).
  - [ ] Если сеть недоступна — сообщение.
  - [ ] Если мысль удалена — сообщение.
  - [ ] Cold start (Win/Linux): deep-link из `process.argv` обрабатывается.
  - [ ] Тесты в `client/tests/deep-link.test.ts`.
  - [ ] `npm -w @etn/client test` зелёный.
  - [ ] `npm run typecheck` зелёный.
  - [ ] Ручная проверка пользователем (последним пунктом).

## R12. Сценарии QA + ручная проверка пользователем

- **Статус:** `todo` · **Assignee:** zcode · **Зависимости:** R1–R11
- **Описание:** подготовить набор сценариев по аналогии с
  `phase-q.md:190-227` («Сценарии QA»), пройти их вручную на
  `dev:server` + `dev:client` + packaged build.
- **Сценарии:**
  1. `[[#<id>]]` в редакторе: вставка через автокомплит → отображение
     имени в normal/edit-mode → переименование мысли → имя обновляется
     на лету.
  2. `[[#<id>]]` в view-режиме: пустой спан заполняется именем после
     загрузки.
  3. Удаление мысли, на которую ссылаются → серый курсив в редакторе
     и view.
  4. Кросс-сеть: `[[n:<net>#<id>]]` → клик открывает нужную сеть и мысль.
  5. Legacy `[[Имя|alias]]` работает по-прежнему, контекстное меню
     «Обновить формат» переводит на ID.
  6. Backlinks в табе «Связи» показывают корректные упоминания через
     `[[#<id>]]`.
  7. Deep-link `etn://open?net=…&thought=…`: из Obsidian/браузера
     открывается ETN с нужной сетью и мыслью.
  8. Cold start с deep-link в argv.
  9. Single instance: при уже запущенном ETN клик по `etn://…` не
     плодит новое окно.
- **DoD:**
  - [ ] Все 9 сценариев пройдены пользователем вручную (`dev:server`
    + `dev:client` + packaged build).
  - [ ] Замечания зафиксированы как bug-фиксы вне фазы R (если есть).
  - [ ] Коммит `[R12] docs(plan): R — фаза завершена, QA пройдены` —
    обновить статусы в `phase-r.md` и `workplan.md` §3.
  - [ ] `npm run build` зелёный (все workspace).
  - [ ] Ручная проверка пользователем (финальная подпись).

## Зависимости и порядок коммитов

```
R1  docs(plan): R1 — спецификация docs/12-wiki-id-refs.md + правки
R2  [R2] feat(markdown): парсер и HTML для [[#<id>]] / [[n:<net>#<id>]]
R3  [R3] feat(server): etn.thoughts.backlinks (REST + MCP)
R4  [R4] feat(shared): хелпер buildDeepLinkUrl/parseDeepLinkUrl
R5  [R5] docs(mcp-server): etn://open?… в таблице ресурсов
R6  [R6] feat(client): CM6-плагин wiki-link — ID-форма, декорации, кеш
R7  [R7] feat(client): view-резолвер data-wiki-id → имя
R8  [R8] feat(client): клик-handler — резолюция ID-ссылки и кросс-сеть
R9  [R9] feat(client): таб «Связи» — «Ссылки на мысль» и «Упоминания в тексте»
R10 [R10] feat(client): контекстное меню legacy «Обновить формат»
R11 [R11] feat(client): протокол etn://open?… в Electron
R12 [R12] docs(plan): R — фаза завершена, QA пройдены
```

Между R1–R5 — `npm run typecheck && npm -w @etn/markdown test && npm -w @etn/server test`.
Между R6–R11 — `npm run typecheck && npm -w @etn/client test`.

## Подводные камни

- **DB-тесты под `node --test` SKIPятся** (AGENTS.md §10) — assertions на
  месте, проходят в CI / под реальной БД.
- **CM6 inline-узел `WikiLink` и markdown-it `wiki_link` — два независимых
  парсера.** R2 (markdown-it) и R6 (Lezer) должны быть синхронизированы.
- **Производительность декораций CM6** — пересчёт на каждый selection
  может быть тяжёлым. Реализация — фильтрация по окрестности курсора
  (±100 строк) или двух-`StateField` (локальный/глобальный).
- **Realtime `comment.*` отсутствует** (по `realtime-ui.ts:60-115`
  обрабатываются только `thought.*`/`link.*`/`property-value.*`).
  Backlinks в табе без realtime-обновления; TODO отдельной задачи.
- **Packaged build для `etn://` тестов** — `setAsDefaultProtocolClient`
  в dev регистрирует dev-путь; для полного теста нужен
  `npm -w @etn/client run build`.
- **`UUID_RE`** из `client/src/renderer/lib/pure.ts:341`. Переиспользовать
  или вынести в `shared/src/lib/uuid.ts` (R2/R4 решают).
- **argv на Win/Linux:** `process.argv.find(arg => arg.startsWith('etn://'))`.
