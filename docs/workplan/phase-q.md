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
  `[📂 Сеть ▾] [tabs…][+] [overflow ▾]    [👤 User] [☰]`. Табы занимают всё
  свободное место между `[📂 Сеть ▾]` и `[👤 User]`. Не поместившиеся
  сворачиваются в дропдаун, который «отрастает» справа от «+». Таб «+»
  всегда видим.

## Q1. Миграция локальной БД под табы
- **Статус:** `todo` · **Зависимости:** —
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
  - [ ] `client/migrations/005_tabs.sql` — таблица `tabs`, ALTER `focus_history`,
    `structures_history`, `chronicle_history` (PK с `tab_id`); индексы.
  - [ ] `LocalDb`: методы `listTabs`, `getTab`, `upsertTab`, `deleteTab`,
    `reorderTabs`; расширение `focusHistory*` и `chronicleHistory*` параметром
    `tabId`.
  - [ ] UI-state (`getState/setState`) принимает опциональный `tabId`;
    legacy-ключи продолжают работать.
  - [ ] Спеки `docs/07-client-electron.md` §3.2/§3.5 + новый §3.6,
    `docs/11-settings-and-state.md` §2.3.
  - [ ] `npm run typecheck` зелёный.

## Q2. Пул `RealtimeClient` + IPC `etn.tabs.*`
- **Статус:** `todo` · **Зависимости:** Q1
- **Описание:** сейчас `client/src/main/ipc/register.ts:34-188` держит один
  `RealtimeClient` и переключает `getNetworkId()` через
  `disconnect()/connect()`. Заменить на пул `RealtimeClient` с
  `Map<networkId, {client, refCount}>`. IPC `etn.tabs.*`:
  `list/open/activate/close/reorder/updateState`. Серверный контракт
  не меняется (один WS = одна сеть); на клиенте держим по сокету на
  каждую открытую сеть.
- **DoD:**
  - [ ] Модуль `client/src/main/realtime/tab-rt-pool.ts` (acquire/release,
    refcount, единый applier/broadcast).
  - [ ] `client/src/main/ipc/contract.ts` — домен `etn.tabs.*`;
    `etn.ui.getState/setState` принимает `tabId?`.
  - [ ] `client/src/main/ipc/handlers.ts` — хендлеры `tabs.*`.
  - [ ] `client/src/main/ipc/register.ts` — пул вместо одного `RealtimeClient`.
  - [ ] `client/src/preload/index.ts` — `etn.tabs.*` в `window.etn`.
  - [ ] Спеки `docs/07-client-electron.md` §2/§4.2/§6/§7,
    `docs/04-realtime.md` §2.
  - [ ] `npm run typecheck` зелёный.

## Q3. Tab strip UI + overflow + DnD + toolbar reorg
- **Статус:** `todo` · **Зависимости:** Q1
- **Описание:** удалить кнопку «Меню сети» из существующего toolbar; верхняя
  строка заменяется на
  `[📂 Сеть ▾] [tabs…][+] [overflow ▾]    [👤 User] [☰]`. Логика пунктов меню
  сети переезжает из `workspace-menus.ts:33-57`. Реализовать:
  `client/src/renderer/screens/tabs/tabs.ts` (хост tab-strip),
  `tab-overflow.ts` (расчёт видимости, дропдаун),
  `tab-dnd.ts` (pointer-gesture DnD, только среди видимых).
- **DoD:**
  - [ ] Новый `client/src/renderer/screens/tabs/` (4 файла).
  - [ ] `workspace.ts`: верхняя строка переразметка; точка монтирования
    `tab-strip-host` + `net-menu-host`.
  - [ ] `workspace-menus.ts`: `wireNetMenu` на новом хосте; сохранены пункты.
  - [ ] CSS: `--tab-w`, `--tab-w-min`, `--tab-strip-h`, стили strip+overflow.
  - [ ] DnD reorder среди видимых; «+» и overflow не перетаскиваются.
  - [ ] Закрытие «✕»; если закрыт последний «настоящий» таб → `showScreen('networks')`.
  - [ ] Спека `docs/08-ui-spec.md` §1 (новый layout), §8 (меню сети).
  - [ ] `npm run typecheck` зелёный.

## Q4. Snapshot состояния таба и dirty-маркер
- **Статус:** `todo` · **Зависимости:** Q2, Q3
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
  - [ ] `state.ts`: поля `tabs`, `activeTabId`; `setActiveTab(tabId)` с
    snapshot/restore.
  - [ ] `app.ts`: старт через `tabs.list()` + `networks.list()`;
    `openNetwork` → `tabs.open` + `setActiveTab`.
  - [ ] `structures.ts:196-198`, `chronicle.ts:111-124`,
    `active-view.ts:18-27` — параметризованы `tabId`.
  - [ ] `realtime.ts:81-98` — `markTabDirty` в `onEvent`; broadcast
    `tabs:clean` при активации.
  - [ ] Persist + restore по сценариям QA §4.1–§4.7.
  - [ ] Спеки `docs/11-settings-and-state.md` §2.3 (per-tab history),
    `docs/08-ui-spec.md` §1 (dirty-маркер).
  - [ ] `npm run typecheck` зелёный.

## Q5. Inaccessible state + заглушка «нет доступа»
- **Статус:** `todo` · **Зависимости:** Q3, Q4
- **Описание:** при старте клиента для каждого таба проверяем доступ через
  `etn.networks.list()` (или `etn.networks.get(networkId)`); если сеть
  отсутствует или `403`/`404` — `inaccessible=true`, заголовок рендерится
  `opacity: 0.5` (блеклый). При активации такого таба — заглушка «Нет
  доступа к сети» с кнопкой «Закрыть таб». При `realtime:network.lost` в
  активной сети — существующее поведение `backToNetworks` сохраняется.
- **DoD:**
  - [ ] Доступ проверяется при `tabs.list()` + фоновом `networks.list()`.
  - [ ] Рендер `inaccessible` табов: `opacity: 0.5` + tooltip.
  - [ ] Заглушка при активации: текст + кнопка «Закрыть таб».
  - [ ] Спека `docs/08-ui-spec.md` §1 (inaccessible + заглушка).
  - [ ] `npm run typecheck` зелёный.

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
