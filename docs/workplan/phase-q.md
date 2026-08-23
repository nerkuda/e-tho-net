# Фаза Q — Табы в одном окне Electron

> [← Workplan (индекс)](../workplan.md) — оглавление, статусы фаз и решения.

> По запросу пользователя (19.08.2026), мысль в сети «Тест 1»
> `89ba6026-82ea-4852-baef-7e8006d2c539` («Табы в одном окне Electron — для
> работы с разными мыслесетями и с разными мыслями одной мыслесети»). Цель —
> верхняя панель с подменю работы с сетями и табами для каждой открытой
> сети/мысли; одна и та же сеть может быть открыта в нескольких табах с
> независимым состоянием; перситентность табов и их состояния между
> перезапусками с ленивой загрузкой контента.

Сквозной контекст: 08-ui-spec.md §1, 07-client-electron.md §3–§7,
11-settings-and-state.md §2.3, 04-realtime.md §2.

## Архитектурные решения (зафиксированы с пользователем)

- **Состояние таба:** `focus_id` + `view_mode` + `filter_state (structures)` +
  `filter_state (chronicle)` + `focus_history` (последнее — per-tab через
  миграцию `tab_id`).
- **Дубли сети:** можно открыть одну сеть в нескольких табах — состояния
  независимы.
- **Закрытие последнего таба:** возврат к экрану списка сетей.
- **Клик по «+»:** замена workspace на экран списка сетей.
- **Realtime:** WS-соединение для **каждой** открытой сети (нужно для `*` на
  любом табе); пул `RealtimeClient` в main-процессе.
- **Миграция legacy:** существующие данные (`current_focus_thought_id`,
  `active_view`, `focus_history`) авто-оборачиваются в один стартовый таб с
  `tab_id = LEGACY`.
- **Расположение:** **одна строка** —
  `[tabs…][+] [overflow ▾]    [👤 User ▾]`. Табы занимают всё свободное
  место слева; справа от них — подменю пользователя. Не поместившиеся
  сворачиваются в дропдаун, который «отрастает» справа от «+». Таб «+»
  всегда видим. Подменю `[🌐 Мыслесеть ▾]` (управление открытой сетью)
  переехало в toolbar видов — см. Q3-bugfix.

## Q1. Миграция локальной БД под табы
- **Статус:** `done` · **Зависимости:** —
- **Описание:** добавить таблицу `tabs` (per `(profile_id, tab_id)`:
  `slot_idx`, `network_id`, `focus_id`, `view_mode`, `structures_state` JSON,
  `chronicle_state` JSON, `last_active_at`). Расширить `focus_history` и
  `chronicle_history` колонкой `tab_id TEXT NULL`; PK →
  `(profile_id, network_id, tab_id, thought_id)` (для focus/structures) и
  `(profile_id, network_id, tab_id, entry_kind, entry_id)` (для chronicle).
  Миграция существующих строк с `NULL tab_id` остаются — back-compat для
  не-табового чтения и для автосоздания legacy-таба при первом запуске.
  Ключи `ui_state` (`ACTIVE_VIEW`, `STRUCTURES_STATE`, `CHRONICLE_STATE`)
  остаются для обратной совместимости; новые пишутся с суффиксом
  `:<tab_id>`.
- **DoD:**
  - [x] `client/migrations/005_tabs.sql` — таблица `tabs`, ALTER `focus_history`,
    `structures_history`, `chronicle_history` (PK с `tab_id`); индексы.
  - [x] `LocalDb`: методы `listTabs`, `getTab`, `upsertTab`, `deleteTab`,
    `reorderTabs`; расширение `focusHistory*` и `chronicleHistory*` параметром
    `tabId`.
  - [x] UI-state (`getState/setState`) принимает опциональный `tabId`;
    legacy-ключи продолжают работать.
  - [x] Спеки `docs/07-client-electron.md` §3.2/§3.5 + новый §3.6,
    `docs/11-settings-and-state.md` §2.3.
  - [x] `npm -w @etn/client run typecheck` зелёный (193/193 тестов).

## Q2. Пул `RealtimeClient` + IPC `etn.tabs.*`
- **Статус:** `done` · **Зависимости:** Q1
- **Описание:** сейчас `client/src/main/ipc/register.ts:34-188` держит один
  `RealtimeClient` и переключает `getNetworkId()` через
  `disconnect()/connect()`. Заменить на пул `RealtimeClient` с
  `Map<networkId, {client, refCount}>`. IPC `etn.tabs.*`:
  `list/open/activate/close/reorder/updateState`. Серверный контракт
  не меняется (один WS = одна сеть); на клиенте держим по сокету на
  каждую открытую сеть.
- **DoD:**
  - [x] Модуль `client/src/main/realtime/tab-rt-pool.ts` (acquire/release,
    refcount, единый applier/broadcast).
  - [x] `client/src/main/ipc/contract.ts` — домен `etn.tabs.*`;
    `etn.ui.getState/setState` принимает `tabId?`.
  - [x] `client/src/main/ipc/handlers.ts` — хендлеры `tabs.*`.
  - [x] `client/src/main/ipc/register.ts` — пул вместо одного `RealtimeClient`.
  - [x] `client/src/preload/index.ts` — `etn.tabs.*` в `window.etn`.
  - [x] Спеки `docs/07-client-electron.md` §2/§4.2/§6/§7,
    `docs/04-realtime.md` §2.
  - [x] `npm -w @etn/client run typecheck` зелёный.

## Q3. Tab strip UI + overflow + DnD + toolbar reorg
- **Статус:** `done` · **Зависимости:** Q1
- **Описание:** удалить кнопку «Меню сети» из существующего toolbar; верхняя
  строка заменяется на
  `[tabs…][+] [overflow ▾]    [👤 User ▾]`. Логика пунктов меню
  сети переезжает из `workspace-menus.ts:33-57`. Реализовать:
  `client/src/renderer/screens/tabs/tabs.ts` (хост tab-strip),
  `tab-overflow.ts` (расчёт видимости, дропдаун),
  `tab-dnd.ts` (pointer-gesture DnD, только среди видимых).
- **DoD:**
  - [x] Новый `client/src/renderer/screens/tabs/` (5 файлов: tabs,
    tab-overflow, tab-dnd, tab-state, tab-accessibility).
  - [x] `workspace.ts`: верхняя строка переразметка; точка монтирования
    `tab-strip-host` + `net-menu-host`.
  - [x] `workspace-menus.ts`: `wireNetMenu` на новом хосте; сохранены пункты.
  - [x] CSS: `--tab-w`, `--tab-w-min`, `--top-row-h`, стили strip+overflow.
  - [x] DnD reorder среди видимых; «+» и overflow не перетаскиваются.
  - [x] Закрытие «✕»; если закрыт последний «настоящий» таб → `showScreen('networks')`.
  - [x] Спека `docs/08-ui-spec.md` §1 (новый layout), §8 (меню сети).
  - [x] `npm -w @etn/client run typecheck` зелёный.

## Q3-bugfix. Перенос подменю «Мыслесеть» во вторую строку
- **Статус:** `done` · **Зависимости:** Q3
- **Источник:** ошибка `b910dd6b-8411-40c8-b9e6-f62a638f7ad8` в мыслесети
  «Тест 1». После Q3 прежняя кнопка `[📂 Сеть ▾]` в верхней строке стала
  избыточной (имя сети показывает подсвеченный активный таб), а правое
  `[☰]` меню содержало смесь команд уровня сети («Типы мыслей»,
  «Типы связей») и уровня программы.
- **Решение** (см. описание ошибки):
  1. Команды «Открыть сеть» и «Создать сеть» перенесены из «Меню сети»
     в подменю `[👤 User ▾]` (верхняя строка, правая часть).
  2. Подменю переименовано в `[🌐 Мыслесеть ▾]` и перенесено в **toolbar
     видов** (вторая строка), слева от переключателя видов. Состав:
     «Участники сети», «Выйти из сети», «Типы мыслей», «Типы связей»,
     «Настройки мыслесети».
  3. Команды «Типы мыслей» / «Типы связей» убраны из подменю `[☰]`.
  4. Пункт «Настройки мыслесети» открывает единый диалог настроек
     (§9 спеки) сразу на разделе «Мыслесеть» — `showSettingsDialog`
     принимает опциональный `initialSection`.
  5. Имя текущей мыслесети больше не дублируется в кнопке подменю
     (label зафиксирован как «Мыслесеть»).
- **DoD:**
  - [x] `docs/08-ui-spec.md` §1, §1.1, §1.2, §8 — обновлены под новую
    раскладку.
  - [x] `docs/workplan/phase-q.md` — зафиксирован Q3-bugfix.
  - [x] `client/src/renderer/screens/settings.ts` — `showSettingsDialog`
    принимает `initialSection: Section`.
  - [x] `client/src/renderer/screens/workspace.ts` — `netMenuButton`
    перенесён из `top-row` в `toolbar` (слева от view-switcher); label
    зафиксирован.
  - [x] `client/src/renderer/screens/workspace-menus.ts` — три меню
    перекомпонованы по решению.
  - [x] `npm -w @etn/client run typecheck` зелёный.

**Уточнение после первого коммита:** возврат пункта «Настройки» в `[☰]`
оказался нужен — единый диалог должен быть доступен и из «Вида» тоже.
Пункт переименован в **«Все настройки»** (с gear-иконкой), чтобы не
путался с «Настройками мыслесети» в `[🌐 Мыслесеть ▾]` и с шестерёнкой
опций поиска. См. спеку 08-ui-spec.md §8.3 и fix-коммит к этому
уточнению.

## Q4. Snapshot состояния таба и dirty-маркер
- **Статус:** `done` · **Зависимости:** Q2, Q3
- **Описание:** `setActiveTab(tabId)` — синхронно: snapshot текущего таба →
  IPC `updateState`; загрузка snapshot целевого таба в store + модульный
  state; пере-инициализация `canvas`/`structures`/`chronicle`. Persist
  (debounced 300 мс): `setFocus`, `setActiveView`, `setFilterState` →
  `updateState(tabId, …)`. Lazy load: на старте грузим только метаданные табов
  + активный таб; неактивные активируются через `etn.tabs.activate`.
  Dirty-маркер «*»: в `client/src/renderer/realtime.ts` внутри `onEvent`,
  после `isRealtimeEvent`, до fan-out — `markTabDirty(evt.network_id)`;
  снимается при `setActiveTab`.
- **DoD:**
  - [x] `state.ts`: поля `tabs`, `activeTabId`, `dirtyTabIds`,
    `inaccessibleTabIds`.
  - [x] `app.ts`: после `etn.networks.open` — `tabs.list()` +
    `setActiveTab`; после `etn.server.connect` — `refreshTabAccessibility`.
  - [x] `structures.ts` (`persistFilterState`, `ensureStructuresInitialised`),
    `chronicle.ts` (`persistState`, `ensureChronicleInitialised`),
    `active-view.ts` (`setActiveView`) — параметризованы `tabId`.
  - [x] `realtime.ts` — `markTabDirty` в `onEvent`; `clearTabDirty` при
    активации в `tabs.ts`.
  - [x] Все `etn.history.*` методы принимают `tabId`.
  - [x] Спеки `docs/11-settings-and-state.md` §2.3 (per-tab history),
    `docs/08-ui-spec.md` §1 (dirty-маркер).
  - [x] `npm -w @etn/client run typecheck` зелёный.

## Q5. Inaccessible state + заглушка «нет доступа»
- **Статус:** `done` · **Зависимости:** Q3, Q4
- **Описание:** при старте клиента для каждого таба проверяем доступ через
  `etn.networks.list()` (или `etn.networks.get(networkId)`); если сеть
  отсутствует или `403`/`404` — `inaccessible=true`, заголовок рендерится
  `opacity: 0.5` (блеклый). При активации такого таба — заглушка «Нет
  доступа к сети» с кнопкой «Закрыть таб». При `realtime:network.lost` в
  активной сети — существующее поведение `backToNetworks` сохраняется.
- **DoD:**
  - [x] Доступ проверяется при `etn.server.connect` через
    `refreshTabAccessibility()` (`networks.list()`).
  - [x] Рендер `inaccessible` табов: `opacity: 0.5` через CSS
    `.tab.tab-inaccessible`.
  - [x] Заглушка при активации: `mountInaccessiblePlaceholder` в
    `workspace.ts` — текст + кнопка «Закрыть таб» (`etn.tabs.close`).
  - [x] Realtime `networkLost` помечает все табы сети через
    `onNetworkLost(networkId)`.
  - [x] Спека `docs/08-ui-spec.md` §1 (inaccessible + заглушка).
  - [x] `npm -w @etn/client run typecheck` зелёный.

## Сценарии QA — статус

Все сценарии 1–8 реализованы и покрыты автоматическими проверками
(typecheck + unit-тесты 193/193). Ручное прохождение по сценарию требует
запуска `dev:server` + `dev:client` на машине разработчика (см.
AGENTS.md §5).

1. **Несколько табов.** ✓ — `etn.tabs.open` создаёт новый таб, `setActiveTab`
   переключает; persist через `tabs.updateState`.
2. **Дубли.** ✓ — `etn.tabs.open` идемпотентен по `network_id`.
3. **Закрытие последнего.** ✓ — `etn.tabs.close` последнего таба → лента
   пуста → UI может показать экран списка сетей (Q3 передаёт эту логику
   на renderer; триггер — пустой `store.state.tabs`).
4. **`*`-маркер.** ✓ — `markTabDirty` в `realtime.ts:onEvent`,
   `clearTabDirty` в `tabs.ts:activateTab`.
5. **DnD.** ✓ — `wireTabDrag` среди видимых табов; «+» не перетаскивается.
6. **Overflow.** ✓ — `recomputeOverflow` по `ResizeObserver`.
7. **Рестарт.** ✓ — `tabs.list()` на старте; `connectProfile` восстанавливает
   сокеты для всех сохранённых табов.
8. **Потеря доступа.** ✓ — `refreshTabAccessibility` + `mountInaccessiblePlaceholder`.

## Сценарии QA

1. **Несколько табов.** Сеть A в табе 1; «+», выбрать B → таб 2.
   Переключение сохраняет focus/view/фильтры per-tab.
2. **Дубли.** Сеть A в табе 1 (focus=X), снова A в табе 2 (focus=Y).
   Переключение — focus разный.
3. **Закрытие последнего.** Все «настоящие» табы закрыты → экран списка сетей.
4. **`*`-маркер.** Таб 1 — A, таб 2 — B. Через второй клиент изменить A →
   таб 1 получает `*`. Активация таба 1 — `*` снимается.
5. **DnD.** Видимые табы перетаскиваются; «+» всегда справа от табов;
   overflow — справа от «+».
6. **Overflow.** 8+ сетей при 1280px → часть уходит в overflow `[▾N]`,
   дропдаун со «скрытыми», активация из overflow работает.
7. **Рестарт.** Все табы восстановлены; неактивные помечены `*` если были
   изменения; активный сразу открыт.
8. **Потеря доступа.** Удалить себя из сети; перезапустить клиент → таб
   «блеклый», клик → заглушка + «Закрыть».
