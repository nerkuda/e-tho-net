/**
 * Search (H13, 08-ui-spec.md §3; 09-scenarios.md B3).
 *
 * - toolbar input + drop panel with two zones: «результаты поиска» (four
 *   collapsible groups «Найдено по именам/текстам/связям/в хронологии»,
 *   snippets render server `<mark>` highlights via innerHTML) and «настройки
 *   поиска», revealed by the funnel toggle in the panel's top corner;
 * - activation (Ctrl+Shift+F / focus) reveals the drop panel and restores the
 *   previous `search_state` (text + options) from L4 ui_state; Escape hides the
 *   panel again;
 * - the server search runs for queries of 3+ characters: debounced 250 ms while
 *   typing or on Enter; shorter queries only show a hint;
 * - a whole-query UUID is a thought id lookup (§3.1): it bypasses the options
 *   and resolves the thought via `thoughts.get` into a single
 *   «Мысль по ID» section (absent thought → explicit notice);
 * - empty result groups render collapsed; ↑/↓ walk group headers and hits,
 *   Ctrl+↑/↓ jump to the first/last row, Enter activates the selected row
 *   exactly like a click on it (group header — collapse/expand, thought hit —
 *   focus, link hit — editor) and reruns the search when no row is selected;
 *   the next activation re-highlights the last chosen hit;
 * - the query is highlighted inside the result clouds' titles
 *   (`searchHighlightTerms` + the factory's `highlightTerms` option): every
 *   case-insensitive occurrence of any query term is wrapped in `<mark>`, the
 *   same look the server snippets use; a hit whose match is in its text or
 *   synonyms keeps an unhighlighted title (задача a1766c7d);
 * - the panel is a bordered dropdown: left edge aligned with the search input
 *   (JS-anchored), right margin 10% and max height 50% of the window;
 * - the «настройки поиска» zone sits right of the results (30% of the panel
 *   width) on windows wider than 1000 px and above them otherwise; the switch
 *   reacts to window resizes without a restart (`searchSettingsPlacement`);
 * - the settings zone hosts the unified filter editor (profile `thoughts`):
 *   the MENTAL settings — the subroot («Родители в иерархии» row), thought
 *   types, «показывать неактуальные» and «корзина» — are editor rows compiled
 *   into the shared AST (`buildSearchAst`); the search text `q` and the CORPUS
 *   settings — search areas (мысли/связи/хроники → `scope`) — stay plain FTS
 *   request params (requirement db84b5e1, ADR 7581ac14). The zone keeps one
 *   plain row «Места поиска:» (scope checkboxes, FIRST in the zone) and a
 *   permanently visible footer of commands («Очистить» + «Добавить отбор…»).
 *   The корпусные fields «Ограничения»/«Автор»/«Редактор» are removed from the
 *   UI (customer decision 2026-10-15, задача 4b1cc3d4); rows wrap when narrow;
 * - the map search passes the focused thought as `focus_thought_id`, so an AST
 *   condition with the `$thought` token («По родителю в фокусе») resolves
 *   server-side; without a focus the token is unresolved and the response
 *   carries `unresolved` diagnostics, shown above the result groups (задача
 *   4b1cc3d4);
 * - the zone's visibility is toggled by the funnel button in the panel's top
 *   corner (default off) and remembered in L4 `ui_state`
 *   (`search_settings_open`), like `search_state`;
 * - clicking a thought hit focuses it; clicking a link hit focuses its source
 *   and opens the link in the editor (spec §3.1);
 * - right-click on a thought hit — and `Shift+F10`/`ContextMenu` on the focused
 *   cloud — opens the SHARED thought menu (`canvas/context-menu.ts`), the same
 *   command set as on the canvas; opening the menu neither moves the canvas
 *   focus nor closes the search panel (ошибка ffc173c9).
 */

import { focusFromUi, setFocus } from '../app.js';
// Хиты-мысли в результатах поиска рисует общая фабрика облачка (профиль
// `tree`): значок, цвета, начертание и бледность — как на холсте (§2.2, §6.7).
import { createThoughtCloud, type ThoughtCloudActions } from '../lib/thought-cloud.js';
import { openLinkInEditor } from '../editor/editor.js';
import {
  paintWikiIdsInSnippet,
  resolveWikiIdsInSnippet,
} from '../editor/wiki-link-resolver.js';
import { resolveFirstDayOfWeek } from '../lib/dates.js';
import { div, el, errText, renderHtml, span } from '../lib/dom.js';
import { operationError } from '../lib/ui/messages.js';
import { etn } from '../lib/etn.js';
import { isInsideDialog } from '../lib/dialog.js';
import { defineKeyContext, pushKeyContext } from '../lib/keymap.js';
import { modifierChordVariants } from '../lib/keymap-chords.js';
import { isInsidePopover } from '../lib/ui/popover.js';
import { isInsideSuggestDropdown } from '../lib/suggest-dropdown.js';
import { markCommentPreview, markThoughtCommentPreview } from '../lib/hover-preview.js';
import { svgIcon } from '../lib/ui/icon.js';
import {
  isNotFoundError,
  isSearchSettingsOpenStored,
  parseThoughtIdLookupQuery,
  parseThoughtIdQuery,
  searchHighlightTerms,
  searchPanelClosesOnTap,
  searchSettingsPlacement,
} from '../lib/pure.js';
import {
  addSearchQuickCondition,
  buildSearchAst,
  buildSearchCriteriaWire,
  clearSearchCorpusFields,
  defaultSearchCriteriaState,
  parseSearchCriteria,
  searchCriteriaToStored,
  SEARCH_QUICK_CONDITIONS,
  type SearchCriteriaState,
} from '../lib/filter-builder.js';
import { buildFilterEditor, type FilterEditorHandle } from '../lib/filter-editor.js';
import { createDebouncedWriter } from '../lib/debounced-writer.js';
import { menuAction, isInsideMenu, showMenuAt } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { t } from '../lib/i18n.js';
import {
  UI_STATE_KEY,
  type Link,
  type SearchResponse,
  type SearchScope,
  type Thought,
  type TokenIssue,
} from '@etn/shared';
import { store } from '../state.js';
import { requireNetworkId } from '../app.js';
import { iconButton, uiButton } from '../lib/ui/button.js';
import { checkboxRow } from '../lib/ui/choice-row.js';

/**
 * Настройки строки поиска карты (§3.2): критерии — общая модель конструктора
 * отбора (`lib/filter-builder.ts`); собственной модели (`SearchOptions`) и
 * собственного парсера сохранённого больше нет. Своё у поиска — группы
 * результатов и поддерево, они лежат в расширении общей модели.
 */
export type SearchOptions = SearchCriteriaState;

/** Minimum trimmed query length for a server search (08-ui-spec.md §3.1). */
export const MIN_QUERY_LENGTH = 3;

/** Whether the query is long enough to hit the server. */
export function isSearchableQuery(q: string): boolean {
  return q.length >= MIN_QUERY_LENGTH;
}

const DEFAULT_OPTIONS: SearchOptions = defaultSearchCriteriaState();

/** Search panel chrome (input + drop panel with both zones). */
export interface SearchChrome {
  input: HTMLInputElement;
  host: HTMLElement;
}

let chrome: SearchChrome | null = null;
let options: SearchOptions = { ...DEFAULT_OPTIONS };
/** Переключатель-лейка зоны настроек (в верхнем углу панели). */
let settingsToggle: HTMLButtonElement | null = null;
/** Зона «настройки поиска» внутри панели. */
let settingsZone: HTMLElement | null = null;
/** Показана ли зона настроек (нажата ли лейка). */
let settingsOpen = false;
let lastResults: SearchResponse | null = null;
let searchTimer: number | null = null;
let restored = false;
/** `data-key` of the hit activated last — re-highlighted on the next activation. */
let lastSelectedKey: string | null = null;
/** Flat navigation index over group headers + hits of expanded groups. */
let cursor: number | null = null;
/** Счётчик монтирований строки поиска: уникальные id контекстов диспетчера. */
let searchContextSeq = 0;
/** Снятие контекста поля поиска (пока фокус в поле). */
let releaseSearchFieldContext: (() => void) | null = null;
/** Снятие контекста панели (пока панель видима). */
let releaseSearchPanelContext: (() => void) | null = null;

/**
 * Активация строки результата — ровно то, что выполнит клик по ней (одна
 * функция на строку). Enter берёт действие отсюда, а не синтезирует
 * `element.click()` по строке: у хита-мысли обработчик живёт на
 * облачке-ребёнке, и синтетический клик по строке до него не доходит —
 * кнопка Enter молча ничего не делала (задача a1766c7d). Реестр на строку,
 * а не на ключ: строки перерисовываются, старые записи собирает GC.
 */
const rowActivations = new WeakMap<HTMLElement, () => void>();

/** Рукоятка единого редактора мыслевых настроек поиска (профиль `thoughts`). */
let searchEditor: FilterEditorHandle | null = null;
/** Последний увиденный первый день недели сети (пересборка зоны на смене). */
let firstDayOfWeekSeen = 1;

/**
 * Сбрасывает модульное состояние строки поиска перед новым монтированием.
 *
 * Рабочее пространство (а с ним и строка поиска) пересобирается при КАЖДОМ
 * открытии мыслесети (`showScreen('workspace')` → `mountSearch`), но переменные
 * модуля живут между монтированиями. Без сброса настройки одной сети («лейка»,
 * «Ограничивать потомками мыслей» + мысль, места поиска, ограничения) остаются
 * в памяти и показываются в другой сети, а флаг `restored` глушит чтение
 * сохранённого состояния новой сети (ошибка 438092f6). Хранится состояние
 * по-прежнему per-network: ключ L4 `ui_state` уже включает `network_id` — сеть
 * без своей записи получает дефолт, а не чужие настройки.
 *
 * Отложенную запись настройки (`persistWriter`) сброс НЕ снимает: сеть и
 * payload зафиксированы в момент планирования (см.
 * {@link createDebouncedWriter}), поэтому та запись досылает настройку в СВОЮ
 * (старую) сеть и после перемонтирования — иначе правка, сделанная меньше чем
 * за 300 мс до ухода из сети, терялась бы.
 */
function resetSearchState(): void {
  options = defaultSearchCriteriaState();
  settingsOpen = false;
  restored = false;
  lastResults = null;
  lastSelectedKey = null;
  cursor = null;
  searchEditor?.destroy();
  searchEditor = null;
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer);
    searchTimer = null;
  }
}

/**
 * Mounts the search panel (called from the workspace builder). The panel holds
 * the results zone plus the toggleable settings zone; the funnel toggle sits in
 * the panel's top corner (the old toolbar gear is gone, задача a3247f84).
 */
export function mountSearch(next: SearchChrome): () => void {
  // Своё состояние на каждую мыслесеть: панель только что собрана заново под
  // текущую сеть — прежние настройки не должны её пережить (ошибка 438092f6).
  resetSearchState();
  chrome = next;

  const { host, input } = next;
  const fieldContextId = `search-field-${(searchContextSeq += 1)}`;
  const panelContextId = `search-panel-${(searchContextSeq += 1)}`;
  host.replaceChildren();

  const toggle = iconButton({
    icon: svgIcon('filter'),
    title: 'Настройки поиска',
    role: 'ghost',
    class: 'search-settings-toggle',
    onClick: () => {
      setSettingsOpen(!settingsOpen);
      persistSettingsOpen();
    },
  });
  toggle.setAttribute('aria-pressed', 'false');

  // Кнопка-лейка — в верхнем углу панели (заголовочная строка, прижата вправо).
  const panelHeader = div('search-panel-header');
  panelHeader.append(toggle);

  const panelBody = div('search-panel-body');
  const results = div('search-results');
  const settings = div('search-settings');
  buildSettingsZone(settings);
  panelBody.append(results, settings);
  host.append(panelHeader, panelBody);

  settingsToggle = toggle;
  settingsZone = settings;
  // Смена первого дня недели в «Все настройки» перестраивает открытую зону
  // настроек: календарь точной даты читает настройку заново (ошибка b5278f9a).
  firstDayOfWeekSeen = resolveFirstDayOfWeek(store.state.network?.first_day_of_week);
  const unsubscribeFirstDayOfWeek = store.subscribe(() => {
    if (chrome === null || settingsZone === null) return;
    // Выход из сети (`resetNetwork`) синхронно рассылает `networkId: null`:
    // пересобирать зону настроек не из чего — `requireNetworkId()` в
    // `buildSettingsZone` бросил бы, а исключение в подписчике оборвало бы
    // `resetNetwork` до перехода на экран списка сетей (ошибка b5278f9a).
    // Синхронизируем отслеживаемое значение: при следующем открытии сети
    // подписка снова отработает штатно.
    if (store.state.networkId === null) {
      firstDayOfWeekSeen = resolveFirstDayOfWeek(store.state.network?.first_day_of_week);
      return;
    }
    const next = resolveFirstDayOfWeek(store.state.network?.first_day_of_week);
    if (next === firstDayOfWeekSeen) return;
    firstDayOfWeekSeen = next;
    rebuildSettingsZone();
  });
  setSettingsOpen(settingsOpen);
  // Нажатость лейки — клиентское состояние (переживает перезапуск); читаем
  // сразу при монтировании, не дожидаясь первого фокуса инпута. Ширина окна
  // определяет положение зоны и пересчитывается на каждом ресайзе.
  applySettingsPlacement();
  void loadSettingsOpen();

  input.addEventListener('focus', () => {
    positionPanel();
    applySettingsPlacement();
    host.classList.remove('hidden');
    // Пока панель видима, её контекст на стеке диспетчера: Escape закрывает
    // панель, даже если фокус ушёл из поля (ADR b420b08c, задача fd3d84f4).
    releaseSearchPanelContext ??= pushKeyContext(panelContextId);
    if (!restored) {
      restored = true;
      void restoreState();
    }
    refreshOnActivation();
  });
  input.addEventListener('input', () => {
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void run(), 250);
  });
  // Клавиатура поля поиска — через общеклиентский диспетчер: пока фокус в поле,
  // его контекст на вершине стека (ADR b420b08c, задача fd3d84f4).
  const handleFieldKey = (event: KeyboardEvent): boolean => {
    if (event.key === 'Enter') {
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      const rows = collectNavRows();
      const row = cursor === null ? undefined : rows[cursor];
      if (row !== undefined) {
        // Действие строки — то же, что клик по ней (см. activateRow).
        row.activate();
      } else {
        // Ни одна строка не выбрана: Enter — команда поиска (документация
        // рекомендует её для крупных сетей).
        void run();
      }
      return true;
    } else if (event.ctrlKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      // Ctrl+↑/↓ jump to the first/last row (Enter — with or without Ctrl —
      // activates the selected row above).
      const rows = collectNavRows();
      if (rows.length === 0) return false;
      cursor = event.key === 'ArrowUp' ? 0 : rows.length - 1;
      rows.forEach((row, i) => row.el.classList.toggle('selected', i === cursor));
      rows[cursor]!.el.scrollIntoView({ block: 'nearest' });
      return true;
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const rows = collectNavRows();
      if (rows.length === 0) return false;
      moveCursor(event.key === 'ArrowDown' ? 1 : -1);
      return true;
    } else if (event.key === 'Escape') {
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      hidePanel();
      input.blur();
      return true;
    }
    return false;
  };
  defineKeyContext({
    id: fieldContextId,
    bindings: [
      // Прежний обработчик срабатывал на Enter НЕЗАВИСИМО от модификаторов
      // (комментарий старого кода: «Enter — with or without Ctrl — activates the
      // selected row above») — нажатие выражено привязкой на каждое подмножество
      // (`lib/keymap-chords.ts`).
      ...modifierChordVariants('Enter').map((chord) => ({
        command: 'search.enter',
        chord,
        run: handleFieldKey,
      })),
      { command: 'search.first', chord: 'Ctrl+ArrowUp', run: handleFieldKey },
      { command: 'search.last', chord: 'Ctrl+ArrowDown', run: handleFieldKey },
      { command: 'search.up', chord: 'ArrowUp', run: handleFieldKey },
      { command: 'search.down', chord: 'ArrowDown', run: handleFieldKey },
      { command: 'search.escape', chord: 'Escape', run: handleFieldKey },
    ],
  });
  const onFieldFocusIn = (): void => {
    releaseSearchFieldContext ??= pushKeyContext(fieldContextId);
  };
  const onFieldFocusOut = (): void => {
    releaseSearchFieldContext?.();
    releaseSearchFieldContext = null;
  };
  input.addEventListener('focusin', onFieldFocusIn as EventListener);
  input.addEventListener('focusout', onFieldFocusOut as EventListener);

  // Keep the dropdown anchored to the input while the search row/window
  // resizes; the same resize re-decides where the settings zone goes (right of
  // the results or above them, задача a3247f84) — no restart needed.
  const onWindowResize = (): void => {
    positionPanel();
    applySettingsPlacement();
  };
  window.addEventListener('resize', onWindowResize);
  const panelObserver = new ResizeObserver(positionPanel);
  panelObserver.observe(input);

  // Close the panel on a completed click outside it (the input and the toggle
  // inside the panel keep it open) and on Escape while it is visible, even if
  // the input lost focus. The outside click is applied on `pointerup`, not on
  // `pointerdown` — see the drag-cloud exception below.
  // Клик по всплывающему слою, открытому ИЗ панели, — не «вне панели»:
  // общая выпадашка подсказок и модальный диалог живут в `document.body`.
  // Иначе нажатие на строку подсказки прячет панель, поле теряет фокус,
  // список подсказок закрывается до `click` — выбранный тип (фокус, тип
  // связи) не доезжает до отбора (ошибка 72a06e01).
  /**
   * Нажатие вне панели НЕ закрывает её сразу: закрытие откладывается до
   * `pointerup`. Иначе жест «облачко карты → условие отбора» невозможен —
   * панель исчезает на старте перетаскивания вместе с целью броска (критерий 6
   * задачи 31b228f0). Обычный клик вне панели закрывает её на отпускании;
   * начавшийся drag-cloud отменяет закрытие (признак активного жеста —
   * класс `cloud-dragging`, который ставит `canvas/drag-cloud.ts`).
   */
  let panelClosePending = false;
  const onDocumentPointerDown = (event: Event): void => {
    if (host.classList.contains('hidden')) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (!searchPanelClosesOnTap({
      // Панель и её поле поиска (поле живёт в строке L18, вне хоста панели).
      insidePanel: host.contains(target) || input.contains(target),
      insideSuggest: isInsideSuggestDropdown(target),
      insideDialog: isInsideDialog(target),
      // Списки выбора редактора отбора (и прочие панели `lib/ui`) порталятся в
      // `document.body` — клик по ним не закрывает строку поиска (ошибка
      // 50d9bf4e п. B1).
      insideFloating: isInsidePopover(target),
      // Строка меню (`lib/menu.ts`): подменю «Добавить отбор…» порталится в
      // `document.body`. Настоящий клик по нему (`pointerdown`) обязан не
      // закрывать панель — иначе команда применяется «вслепую», а условия и
      // результаты прячутся вместе с панелью (задача 4b1cc3d4, ошибка ddff7ca7).
      insideMenu: isInsideMenu(target),
    })) {
      return;
    }
    panelClosePending = true;
  };
  const onDocumentPointerUp = (): void => {
    if (!panelClosePending) return;
    panelClosePending = false;
    // Жест перетаскивания начался после нажатия — панель обязана дожить до
    // броска в условие. `pointerup` приходит раньше `mouseup`, поэтому класс
    // ещё стоит (снимает его drag-cloud на своём `mouseup`).
    if (document.body.classList.contains('cloud-dragging')) return;
    hidePanel();
  };
  const onDocumentPointerCancel = (): void => {
    panelClosePending = false;
  };
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('pointerup', onDocumentPointerUp);
  document.addEventListener('pointercancel', onDocumentPointerCancel);
  // Контекст панели: Escape при видимой панели, даже когда фокус не в поле
  // (раньше — document-слушатель; ADR b420b08c, задача fd3d84f4).
  defineKeyContext({
    id: panelContextId,
    bindings: [
      {
        command: 'search.panel.escape',
        chord: 'Escape',
        run: (event) => {
          if (event.key === 'Escape' && !host.classList.contains('hidden')) {
            if (searchTimer !== null) window.clearTimeout(searchTimer);
            hidePanel();
          }
          return true;
        },
      },
      // Меню мысли с клавиатуры (спецификация «Контекстное меню мысли»,
      // ошибка ffc173c9): `Shift+F10` и клавиша `ContextMenu` на облачке
      // результата открывают то же общее меню, что и правый клик. Локального
      // `keydown` у панели нет — только привязки общего диспетчера
      // (`lib/keymap.ts`, ADR b420b08c). Фокус не на облачке — `false`, событие
      // уходит по стеку контекстов ниже.
      {
        command: 'search.cloud.menu',
        chord: 'Shift+F10',
        run: openFocusedResultCloudMenu,
      },
      {
        command: 'search.cloud.menu',
        chord: 'ContextMenu',
        run: openFocusedResultCloudMenu,
      },
    ],
  });

  // Release the global listeners/observer on workspace teardown — they live on
  // `window`/`document`, not on the host element, so wiping the DOM does not
  // remove them and each remount would add another set (ошибка 37b713de).
  return () => {
    // Редактор живёт в настройках поиска; снимаем его контексты/подписки до
    // отключения панели от документа.
    searchEditor?.destroy();
    searchEditor = null;
    unsubscribeFirstDayOfWeek();
    window.removeEventListener('resize', onWindowResize);
    document.removeEventListener('pointerdown', onDocumentPointerDown);
    document.removeEventListener('pointerup', onDocumentPointerUp);
    document.removeEventListener('pointercancel', onDocumentPointerCancel);
    input.removeEventListener('focusin', onFieldFocusIn as EventListener);
    input.removeEventListener('focusout', onFieldFocusOut as EventListener);
    releaseSearchFieldContext?.();
    releaseSearchFieldContext = null;
    releaseSearchPanelContext?.();
    releaseSearchPanelContext = null;
    panelObserver.disconnect();
    chrome = null;
  };
}

/**
 * Shows/hides the «настройки поиска» zone and reflects the state on the funnel
 * toggle (pressed class + `aria-pressed`).
 */
function setSettingsOpen(open: boolean): void {
  settingsOpen = open;
  if (settingsZone !== null) settingsZone.classList.toggle('hidden', !open);
  if (settingsToggle !== null) {
    settingsToggle.classList.toggle('pressed', open);
    settingsToggle.setAttribute('aria-pressed', open ? 'true' : 'false');
  }
}

/**
 * Puts the settings zone right of the results (`side`) or above them (`top`)
 * depending on the app window width; re-applied on every resize.
 */
function applySettingsPlacement(): void {
  if (chrome === null) return;
  const mode = searchSettingsPlacement(window.innerWidth);
  chrome.host.classList.toggle('search-settings-side', mode === 'side');
  chrome.host.classList.toggle('search-settings-top', mode === 'top');
}

/**
 * Restores the toggle state from the local L4 `ui_state` — that is what makes
 * it survive a panel reopen and a client restart (per client × user × network).
 */
async function loadSettingsOpen(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const raw = await etn.ui
    .getState(networkId, UI_STATE_KEY.SEARCH_SETTINGS_OPEN)
    .catch(() => null);
  if (chrome === null) return;
  setSettingsOpen(isSearchSettingsOpenStored(raw));
}

/** Persists the toggle state to the local L4 `ui_state`. */
function persistSettingsOpen(): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  void etn.ui
    .setState(networkId, UI_STATE_KEY.SEARCH_SETTINGS_OPEN, settingsOpen ? '1' : '0')
    .catch(() => undefined);
}

/** Anchors the drop panel: left edge under the search input, below its row. */
function positionPanel(): void {
  if (chrome === null) return;
  const root = chrome.host.parentElement;
  if (root === null) return;
  const rootRect = root.getBoundingClientRect();
  const inputRect = chrome.input.getBoundingClientRect();
  // The input lives in the map-view search row (L18), not in the toolbar.
  const row = chrome.input.parentElement;
  if (row === null) return;
  chrome.host.style.left = `${Math.max(0, inputRect.left - rootRect.left)}px`;
  chrome.host.style.top = `${row.getBoundingClientRect().bottom - rootRect.top + 6}px`;
}

/** Hides the drop panel (query, results and the selected row are kept). */
export function hidePanel(): void {
  if (chrome !== null) chrome.host.classList.add('hidden');
  releaseSearchPanelContext?.();
  releaseSearchPanelContext = null;
  cursor = null;
}

/**
 * Re-runs the search on every panel activation so the list never serves stale
 * data — a thought deleted while the panel was hidden must not linger in the
 * results. The last chosen hit is re-highlighted after the fresh render.
 */
function refreshOnActivation(): void {
  if (chrome === null) return;
  if (isSearchableQuery(chrome.input.value.trim())) {
    void run().then(() => applySelection(lastSelectedKey, true));
  } else {
    applySelection(lastSelectedKey, true);
  }
}

/**
 * Re-runs the search when the panel is already visible and the query is live —
 * called after a deletion so the deleted thought leaves the visible list at
 * once (B1: the actor's own event arrives asynchronously).
 */
export function refreshSearchIfVisible(): void {
  if (chrome === null || chrome.host.classList.contains('hidden')) return;
  if (isSearchableQuery(chrome.input.value.trim())) void run();
}

/** One keyboard-navigable row: a group header or a hit of an expanded group. */
interface NavRow {
  el: HTMLElement;
  kind: 'header' | 'hit';
  /**
   * Действие строки — то же, что клик по ней. Заголовок сворачивает/разворачивает
   * группу, хит выполняет свою активацию (мысль — в фокус, связь/хронология —
   * хит открывается).
   */
  activate: () => void;
}

/**
 * Запускает действие строки так же, как это сделал бы клик по ней. Хиты берут
 * зарегистрированную активацию — ту же функцию обслуживает и клик; строки без
 * записи (например, собранные вне рендера результатов) падают на обычный
 * `click()`, который сворачивает/разворачивает группу или всплывает к строке.
 */
function activateRow(el: HTMLElement): void {
  const activate = rowActivations.get(el);
  if (activate !== undefined) activate();
  else el.click();
}

/** Collects navigable rows from the results DOM (headers + visible hits). */
function collectNavRows(): NavRow[] {
  if (chrome === null) return [];
  const resultsBox = chrome.host.querySelector<HTMLElement>('.search-results');
  if (resultsBox === null) return [];
  const rows: NavRow[] = [];
  for (const group of Array.from(resultsBox.children)) {
    if (!(group instanceof HTMLElement)) continue;
    const header = group.querySelector<HTMLElement>(':scope > .search-group-header');
    const body = group.querySelector<HTMLElement>(':scope > .search-group-body');
    if (header !== null) {
      rows.push({ el: header, kind: 'header', activate: () => activateRow(header) });
    }
    if (body !== null && !body.classList.contains('hidden')) {
      for (const hit of Array.from(body.querySelectorAll(':scope > .search-hit'))) {
        if (hit instanceof HTMLElement) {
          rows.push({ el: hit, kind: 'hit', activate: () => activateRow(hit) });
        }
      }
    }
  }
  return rows;
}

/** Pure index math for ↑/↓ navigation (null cursor enters from either end). */
export function nextNavIndex(cursor: number | null, count: number, delta: 1 | -1): number | null {
  if (count === 0) return null;
  const base = cursor === null || cursor >= count ? (delta === 1 ? -1 : count) : cursor;
  return Math.min(count - 1, Math.max(0, base + delta));
}

/** Moves the keyboard cursor by one row and repaints the selection. */
function moveCursor(delta: 1 | -1): void {
  const rows = collectNavRows();
  const next = nextNavIndex(cursor, rows.length, delta);
  if (next === null) return;
  cursor = next;
  rows.forEach((row, i) => row.el.classList.toggle('selected', i === cursor));
  rows[next]?.el.scrollIntoView({ block: 'nearest' });
}

/** Highlights the hit row with the given key (and syncs the cursor index). */
function applySelection(key: string | null, scroll: boolean): void {
  if (chrome === null) return;
  const resultsBox = chrome.host.querySelector<HTMLElement>('.search-results');
  if (resultsBox === null) return;
  for (const node of Array.from(resultsBox.querySelectorAll('.selected'))) {
    node.classList.remove('selected');
  }
  if (key === null) {
    cursor = null;
    return;
  }
  const row = resultsBox.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  if (row === null) {
    cursor = null;
    return;
  }
  row.classList.add('selected');
  const rows = collectNavRows();
  cursor = rows.findIndex((r) => r.el === row);
  if (scroll) row.scrollIntoView({ block: 'nearest' });
}

/**
 * After a group toggle, keeps the cursor valid: if the selected row became
 * hidden with the collapsed group, the selection moves to that group header.
 */
function syncCursorAfterToggle(header: HTMLElement): void {
  const rows = collectNavRows();
  const selected = rows.find((r) => r.el.classList.contains('selected'));
  if (selected !== undefined) {
    cursor = rows.indexOf(selected);
    return;
  }
  const idx = rows.findIndex((r) => r.el === header);
  cursor = idx >= 0 ? idx : null;
  rows.forEach((row, i) => row.el.classList.toggle('selected', i === cursor));
}

/** Restores the previous query and options from L4 `search_state`. */
async function restoreState(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const raw = await etn.ui.getState(networkId, UI_STATE_KEY.SEARCH_STATE);
  if (raw === null) return;
  try {
    const parsed = JSON.parse(raw) as { q?: unknown; options?: unknown };
    if (typeof parsed.q === 'string' && chrome !== null) {
      chrome.input.value = parsed.q;
    }
    if (typeof parsed.options === 'object' && parsed.options !== null) {
      options = parseSearchCriteria(parsed.options);
      if (chrome !== null) {
        rebuildSettingsZone();
      }
    }
    if (chrome !== null && chrome.input.value !== '') void run();
  } catch {
    // Corrupted state — start fresh.
  }
}

/**
 * Persists the current query + options (debounced).
 *
 * Сеть и полезная нагрузка фиксируются в момент планирования (см. общий
 * {@link createDebouncedWriter}): отложенная запись, пережившая смену сети
 * (перемонтирование), досылается в СВОЮ сеть, а `resetSearchState` её не
 * отменяет — иначе правка, сделанная перед уходом из сети, терялась бы
 * (ошибка 438092f6, замечание верификатора). Набор сохраняемых ключей —
 * конвертер конструктора (совместим с записанным до 0.8.2: те же имена полей).
 */
const persistWriter = createDebouncedWriter((networkId, payload) => {
  void etn.ui.setState(networkId, UI_STATE_KEY.SEARCH_STATE, payload).catch(() => undefined);
});
function persistState(): void {
  const networkId = store.state.networkId;
  if (networkId === null || chrome === null) return;
  persistWriter.schedule(
    networkId,
    JSON.stringify({ q: chrome.input.value, options: searchCriteriaToStored(options) }),
  );
}

/** Resolves the effective scopes for the current option set. */
function scopesFor(o: SearchOptions): SearchScope[] {
  const none = !o.onlyThoughts && !o.onlyLinks && !o.onlyChrono;
  const parts: SearchScope[] = [];
  if (o.onlyThoughts || none) parts.push('names', 'texts');
  if (o.onlyLinks || none) parts.push('links');
  if (o.onlyChrono || none) parts.push('chronology');
  return parts.length >= 4 ? ['all'] : parts;
}

/** Merges several partial search responses into one. */
function mergeResponses(responses: SearchResponse[]): SearchResponse {
  const empty: SearchResponse = {
    by_names: [],
    by_texts: [],
    by_links: [],
    by_chrono: [],
    meta: { total_in_group: { names: 0, texts: 0, links: 0, chronology: 0 } },
  };
  // Диагностика неразрешённых токенов (требование b7fdab20): один AST гоняется
  // по нескольким scope-ам, поэтому один и тот же неразрешённый токен приезжает
  // из каждого ответа — схлопываем по (`path`, `token`, `reason`), порядок — по
  // первому появлению (сервер делает то же для legacy `scope=thoughts`).
  const unresolved: TokenIssue[] = [];
  const seen = new Set<string>();
  for (const response of responses) {
    empty.by_names.push(...response.by_names);
    empty.by_texts.push(...response.by_texts);
    empty.by_links.push(...response.by_links);
    empty.by_chrono.push(...response.by_chrono);
    empty.meta.total_in_group.names += response.meta.total_in_group.names;
    empty.meta.total_in_group.texts += response.meta.total_in_group.texts;
    empty.meta.total_in_group.links += response.meta.total_in_group.links;
    empty.meta.total_in_group.chronology += response.meta.total_in_group.chronology;
    for (const issue of response.unresolved ?? []) {
      const key = `${issue.path}\u0000${issue.token}\u0000${issue.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unresolved.push(issue);
    }
  }
  if (unresolved.length > 0) empty.unresolved = unresolved;
  return empty;
}

/** Runs the search for the current input and options. */
async function run(): Promise<void> {
  if (chrome === null) return;
  const networkId = store.state.networkId;
  const q = chrome.input.value.trim();
  if (networkId === null || !isSearchableQuery(q)) {
    renderResults(null);
    return;
  }
  persistState();
  const resultsBox = chrome.host.querySelector('.search-results');
  if (resultsBox !== null) {
    resultsBox.replaceChildren(el('span', 'muted', 'Поиск…'));
  }
  const idQuery = parseThoughtIdLookupQuery(q);
  if (idQuery !== null) {
    await runById(networkId, idQuery);
    return;
  }
  const scopes = scopesFor(options);
  try {
    // Гибрид (требование b91336e7, ADR 7581ac14): МЫСЛЕВЫЕ настройки —
    // скомпилированный из редактора `ast` (профиль `thoughts`, включая
    // подкорень-паттерн «ИЛИ(id, parents in_hierarchy)»); КОРПУСНЫЕ — плоские
    // `scope`/`link_type_id`/`author_id`/`editor_id`. Плоские мыслевые
    // параметры (type_id/show_inactive/trashed/in/from_thought_id) НЕ
    // передаются: сервер отвергает их вместе с `ast` (VALIDATION_ERROR).
    //
    // Мысль-фокус карты едет отдельным параметром `focus_thought_id`: по ней
    // сервер разрешает токен `$thought` в условиях (команда «По родителю в
    // фокусе»); без фокуса токен неразрешим — сервер вернёт диагностику
    // `unresolved` (задача 4b1cc3d4).
    const focusId = store.state.focus?.focused.id ?? null;
    const ast = buildSearchAst(options, focusId);
    const criteriaWire = buildSearchCriteriaWire(options);
    const responses = await Promise.all(
      scopes.map((scope) =>
        etn.thoughts.search(networkId, {
          q,
          scope,
          ...(ast !== undefined ? { ast } : {}),
          ...(focusId !== null ? { focus_thought_id: focusId } : {}),
          ...criteriaWire,
        }),
      ),
    );
    lastResults = mergeResponses(responses);
    renderResults(lastResults);
  } catch (err) {
    if (resultsBox !== null) {
      resultsBox.replaceChildren(operationError(err, 'Ошибка поиска'));
    }
  }
}

/**
 * Direct lookup when the whole query is a thought id (08-ui-spec.md §3.1): the
 * thought is fetched via `thoughts.get` and shown as the only result section,
 * ignoring all search options (subtree, types, «показывать неактуальные») —
 * inactive thoughts are found as well.
 */
async function runById(networkId: string, id: string): Promise<void> {
  try {
    const thought = await etn.thoughts.get(networkId, id);
    renderIdResult(thought);
  } catch (err) {
    if (isNotFoundError(err)) {
      renderIdResult(null);
      return;
    }
    if (chrome !== null) {
      const resultsBox = chrome.host.querySelector('.search-results');
      if (resultsBox !== null) {
        resultsBox.replaceChildren(operationError(err, 'Ошибка поиска'));
      }
    }
  }
}

/**
 * Renders the single «Мысль по ID» section: the found thought (click → focus,
 * snippet shows the id itself) or the explicit "absent" notice, which must stay
 * visible, so the empty section is rendered expanded.
 */
function renderIdResult(thought: Thought | null): void {
  if (chrome === null) return;
  const resultsBox = chrome.host.querySelector('.search-results');
  if (resultsBox === null) return;
  resultsBox.replaceChildren();
  const section = div('search-group');
  const header = div('search-group-header');
  const caret = span('▾', 'group-caret');
  const label = span(`Мысль по ID (${thought === null ? 0 : 1})`, 'group-title');
  header.append(caret, label);
  const body = div('search-group-body');
  header.addEventListener('click', () => {
    const collapsed = body.classList.toggle('hidden');
    caret.textContent = collapsed ? '▸' : '▾';
    syncCursorAfterToggle(header);
  });
  if (thought !== null) {
    const row = div('search-hit search-hit-cloud');
    const key = `thought:${thought.id}`;
    row.dataset['key'] = key;
    // The «Мысль по ID» row is the only thought fetched via `thoughts.get`,
    // so its full DTO carries every cloud-style field. The row shows the same
    // factory-built cloud as the canvas (08-ui-spec.md §2.2) with the id as
    // the snippet.
    // Клик и Enter выполняют одну и ту же активацию строки (задача a1766c7d).
    const activate = activateHit(key, () => focusFromUi(thought.id));
    rowActivations.set(row, activate);
    row.append(
      createThoughtCloud(thought, {
        profile: 'tree',
        // Ширина — по строке выпадашки (ошибка 265cdb5f): имя обрезается
        // многоточием по списку, а не по холстовым 200px.
        width: 'container',
        highlightTerms: currentHighlightTerms(),
        actions: searchCloudActions(activate, thought.title),
      }),
    );
    const info = div('search-hit-info');
    info.style.flex = '1';
    info.style.minWidth = '0';
    info.append(el('div', 'hit-snippet', thought.id));
    row.append(info);
    // Stage 3: no per-indicator comment/chrono/attachment icons on this row —
    // Ctrl+hover over the row itself shows the thought's permanent comment.
    markThoughtCommentPreview(row, thought.id, thought.title);
    body.append(row);
  } else {
    body.append(el('p', 'muted', 'Мысль с указанным ID отсутствует.'));
  }
  section.append(header, body);
  resultsBox.append(section);
  applySelection(lastSelectedKey, false);
}

/**
 * Активация хитов поиска (единая для всех групп): запоминает выбранный хит,
 * подсвечивает его, прячет панель и возвращает фокус инпуту поиска — затем
 * выполняет действие хита. Возвращённая функция — и обработчик клика, и
 * действие записанной строки для Enter (см. {@link rowActivations}).
 */
function activateHit(key: string, open: () => void): () => void {
  return () => {
    lastSelectedKey = key;
    applySelection(key, true);
    hidePanel();
    // A synthetic Enter click keeps focus in the input; leave it so the
    // canvas/editor receives the following keystrokes.
    if (chrome !== null) chrome.input.blur();
    open();
  };
}

/**
 * Термы подсветки названий результатов — из текущего запроса строки поиска.
 * Совпадение в названии подсвечивается прямо в облачке (фабричная опция
 * `highlightTerms`); хит, совпавший только по тексту или синониму, остаётся
 * с названием без подсветки — так и должно быть (задача a1766c7d).
 */
function currentHighlightTerms(): string[] {
  return chrome === null ? [] : searchHighlightTerms(chrome.input.value);
}

/**
 * Действия облачка-хита поиска: клик и Ctrl+клик — активация строки (та же
 * функция обслуживает Enter, задача a1766c7d), правый клик — ОБЩЕЕ меню мысли.
 * Меню — тот же фасад, что у холста и чипов (`canvas/context-menu.ts`):
 * своего списка команд поиск не заводит (правило «меню одинаково везде»,
 * ошибка f072db61). Фасад импортируется лениво в обработчике: статический
 * импорт дал бы цикл `app → search → canvas/context-menu → app`.
 */
function searchCloudActions(activate: () => void, title: string): ThoughtCloudActions {
  return {
    onClick: activate,
    onCtrlClick: activate,
    onContextMenu: (event, id) => {
      // Меню — отдельный слой: правый клик по облачку не должен открывать
      // меню зоны/экрана под результатами.
      event.stopPropagation();
      openSearchThoughtMenu(id, title, { event });
    },
  };
}

/** Где открыть меню мысли для облачка результата поиска. */
type ThoughtMenuPlace = { event: MouseEvent } | { anchor: Element };

/**
 * Открывает общее меню мысли для облачка результата поиска. Позиция — точка
 * правого клика (`showThoughtContextMenu`) либо край облачка при открытии с
 * клавиатуры (`showThoughtMenuUnder`).
 *
 * `siblingParentId` передаётся ЯВНО (`resolveSiblingParentId`), иначе «налево
 * (родственник)» взяло бы родителя мысли в фокусе карты (ловушка
 * `context-menu.ts:412-413`). После ожидания резолва сверяется сеть: поздний
 * ответ не должен открыть меню для мысли прежней сети (класс a3151e33).
 */
function openSearchThoughtMenu(
  id: string,
  title: string,
  place: ThoughtMenuPlace,
): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  void (async () => {
    try {
      const { showThoughtContextMenu, showThoughtMenuUnder, resolveSiblingParentId } =
        await import('../canvas/context-menu.js');
      const siblingParentId = await resolveSiblingParentId(networkId, id);
      if (store.state.networkId !== networkId) return;
      const target = { id, title, dir: 'siblings' as const, siblingParentId };
      if ('event' in place) showThoughtContextMenu(place.event, target);
      else showThoughtMenuUnder(place.anchor, target);
    } catch (err) {
      notice(errText(err), 'error');
    }
  })();
}

/**
 * Облачко результата под клавиатурным фокусом — якорь меню для `Shift+F10` и
 * клавиши `ContextMenu` (привязки — в контексте панели ниже; локальный
 * `keydown` запрещён сторожем `guard-keymap-single-point`).
 */
function focusedResultCloud(): { id: string; title: string; anchor: HTMLElement } | null {
  if (chrome === null) return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const cloud = active.closest<HTMLElement>('.search-hit .cloud');
  if (cloud === null || !chrome.host.contains(cloud)) return null;
  const id = cloud.dataset['id'];
  if (id === undefined) return null;
  const titleNode = cloud.querySelector<HTMLElement>('.cloud-title');
  return {
    id,
    title: titleNode?.title ?? titleNode?.textContent ?? id,
    anchor: cloud,
  };
}

/** `Shift+F10`/`ContextMenu` на облачке результата: `false` — меню не открыто. */
function openFocusedResultCloudMenu(): boolean {
  const target = focusedResultCloud();
  if (target === null) return false;
  openSearchThoughtMenu(target.id, target.title, { anchor: target.anchor });
  return true;
}

/**
 * Диагностика неразрешённых токенов AST (требование b7fdab20): сервер отдаёт
 * `unresolved` вместо тихой пустоты, а строка поиска показывает предупреждение
 * и пояснение по каждому токену НАД группами результатов. Так условие «Мысль в
 * иерархии $thought» без мысли в фокусе карты видно пользователю, а не выглядит
 * «ничего не найдено» (задача 4b1cc3d4).
 */
function renderUnresolvedDiagnostics(
  box: Element,
  issues: readonly TokenIssue[] | undefined,
): void {
  if (issues === undefined || issues.length === 0) return;
  const block = div('search-diagnostics');
  block.append(el('p', 'search-diagnostic-warning', t('search.unresolvedTokens')));
  for (const issue of issues) {
    block.append(el('div', 'search-diagnostic-item', issue.message));
  }
  box.append(block);
}

/** Renders the four result groups. */
function renderResults(response: SearchResponse | null): void {  if (chrome === null) return;
  const resultsBox = chrome.host.querySelector('.search-results');
  if (resultsBox === null) return;
  resultsBox.replaceChildren();
  if (response === null) {
    resultsBox.append(el('p', 'muted', 'Введите запрос (минимум 3 символа).'));
    return;
  }
  // Диагностика неразрешённых токенов AST (требование b7fdab20) — НАД группами
  // результатов: условие с токеном без контекста обязано быть видимым, а не
  // молча пустым (задача 4b1cc3d4: «По родителю в фокусе» без мысли в фокусе).
  renderUnresolvedDiagnostics(resultsBox, response.unresolved);
  const networkId = requireNetworkId();
  // Группы результатов. Для мыслей иконка, название, цвета и начертание
  // приходят из общей фабрики облачка (мысли выглядят как на холсте); строки
  // связей и хронологии не несут мысли и остаются простыми строками.
  // Термы подсветки — из текущего запроса: совпадения в названии подсвечены
  // прямо в облачке (задача a1766c7d).
  const highlightTerms = currentHighlightTerms();
  const groups: Array<{
    key: 'names' | 'texts' | 'links' | 'chronology';
    title: string;
    hits: Array<{
      /** Фабричное облачко мысли либо глиф-иконка для не-мысленных хитов. */
      lead: HTMLElement;
      /** Заголовок простой строки (связи/хронология); у мыслей — в облачке. */
      title?: string;
      /**
       * Хит-мысль: облачко занимает всю ширину списка (название обрезается
       * по ней, а не по ширине холстового облачка `--cloud-width`), snippet
       * с `<mark>` уходит под облачко (ошибка 265cdb5f).
       */
      isThought: boolean;
      snippet: string;
      /** Stable row key for selection restore + keyboard navigation. */
      key: string;
      /**
       * Активация хита — одна функция на клик и на Enter (задача a1766c7d):
       * у хита-мысли её же исполняют жесты облачка, у простой строки — её
       * обработчик клика.
       */
      activate: () => void;
      /** Stage 3: Ctrl+hover on the row shows the owner's permanent comment
       *  (no per-indicator icons in this list). */
      markPreview: (row: HTMLElement) => void;
    }>;
  }> = [
    {
      key: 'names',
      title: 'Найдено по именам',
      hits: response.by_names.map((hit) => {
        const key = `thought:${hit.thought_id}`;
        const activate = activateHit(key, () => focusFromUi(hit.thought_id));
        return {
          lead: createThoughtCloud(
            { ...hit, id: hit.thought_id },
            {
              profile: 'tree',
              // Ширина — по строке выпадашки (ошибка 265cdb5f): имя обрезается
              // многоточием по списку, а не по холстовым 200px.
              width: 'container',
              highlightTerms,
              actions: searchCloudActions(activate, hit.title),
            },
          ),
          isThought: true,
          snippet: hit.snippet,
          key,
          activate,
          markPreview: (row) => markThoughtCommentPreview(row, hit.thought_id, hit.title),
        };
      }),
    },
    {
      key: 'texts',
      title: 'Найдено по текстам',
      hits: response.by_texts.map((hit) => {
        const key = `thought:${hit.thought_id}`;
        const activate = activateHit(key, () => focusFromUi(hit.thought_id));
        return {
          lead: createThoughtCloud(
            { ...hit, id: hit.thought_id },
            {
              profile: 'tree',
              // Ширина — по строке выпадашки (ошибка 265cdb5f): имя обрезается
              // многоточием по списку, а не по холстовым 200px.
              width: 'container',
              // Совпадение только в тексте — название остаётся без подсветки,
              // если запроса в нём нет.
              highlightTerms,
              actions: searchCloudActions(activate, hit.title),
            },
          ),
          isThought: true,
          snippet: hit.snippet,
          key,
          activate,
          markPreview: (row) => markThoughtCommentPreview(row, hit.thought_id, hit.title),
        };
      }),
    },
    {
      key: 'links',
      title: 'Найдено связей',
      hits: response.by_links.map((hit) => {
        const key = `link:${hit.link_id}`;
        const activate = activateHit(key, () => void openLinkHit(hit.link_id));
        return {
          lead: span('🔗'),
          title: hit.type_name,
          isThought: false,
          snippet: hit.snippet,
          key,
          activate,
          markPreview: (row) => markCommentPreview(row, 'link', hit.link_id, hit.type_name),
        };
      }),
    },
    {
      key: 'chronology',
      title: 'Найдено в хронологии',
      hits: response.by_chrono.map((hit) => {
        const key = `chrono:${hit.owner}:${hit.owner_id}`;
        const activate = activateHit(key, () => void openChronoHit(hit.owner, hit.owner_id));
        return {
          lead: span('📅'),
          title: hit.valid_from.slice(0, 10),
          isThought: false,
          snippet: hit.snippet,
          key,
          activate,
          markPreview: (row) =>
            markCommentPreview(row, hit.owner, hit.owner_id, hit.valid_from.slice(0, 10)),
        };
      }),
    },
  ];

  for (const group of groups) {
    const total = response.meta.total_in_group[group.key];
    const empty = total === 0 || group.hits.length === 0;
    const section = div('search-group');
    const header = div('search-group-header');
    const caret = span(empty ? '▸' : '▾', 'group-caret');
    const label = span(`${group.title} (${total})`, 'group-title');
    header.append(caret, label);
    const body = div('search-group-body');
    if (empty) body.classList.add('hidden');
    header.addEventListener('click', () => {
      const collapsed = body.classList.toggle('hidden');
      caret.textContent = collapsed ? '▸' : '▾';
      syncCursorAfterToggle(header);
    });
    section.append(header, body);
    if (empty) {
      body.append(el('p', 'muted', 'Ничего не найдено.'));
    } else {
      for (const hit of group.hits) {
        const row = div('search-hit');
        row.dataset['key'] = hit.key;
        // Активация строки для Enter — та же функция, что обслуживает клик
        // (задача a1766c7d).
        rowActivations.set(row, hit.activate);
        // Хит-мысль — облачко на всю ширину списка и snippet под ним
        // (ошибка 265cdb5f); строки связи/хронологии остаются в одну строку
        // с глифом-иконкой.
        if (hit.isThought) row.classList.add('search-hit-cloud');
        row.append(hit.lead);
        const info = div('search-hit-info');
        info.style.flex = '1';
        info.style.minWidth = '0';
        if (hit.title !== undefined) {
          info.append(el('div', 'hit-title', hit.title));
        }
        const snippet = el('div', 'hit-snippet');
        // Сниппет несёт сырой `[[#<id>]]` — подставляем имена мыслей: синхронно
        // из кеша (id не мелькает на экране), затем дорезолвиваем батчем
        // (ошибка 2a8181f4).
        renderHtml(snippet, paintWikiIdsInSnippet(hit.snippet, networkId));
        void resolveWikiIdsInSnippet(hit.snippet, networkId).then((resolved) => {
          if (snippet.isConnected) renderHtml(snippet, resolved);
        });
        info.append(snippet);
        row.append(info);
        hit.markPreview(row);
        // Мысль активируется облачком (у него свои действия) и записью в
        // реестре строк; строки связи и хронологии — своим кликом. Ошибка
        // 65382113: после перевода на фабрику облачка обработчик клика
        // перестал доставаться этим строкам — связь и хронология не
        // открывались ни мышью, ни Enter.
        if (!hit.isThought) row.addEventListener('click', hit.activate);
        body.append(row);
      }
    }
    resultsBox.append(section);
  }
  applySelection(lastSelectedKey, false);
}

/**
 * Порт хитового перехода (тестовый шов, как `setCommentThoughtInsertPort`):
 * связь, установка фокуса и открытие редактора. Боевой порт — системные
 * функции; подмена позволяет проверить классификацию отказов (stale 404
 * молчит, сетевой отказ — тост) без живого сервера и DOM редактора
 * (ошибка 53d21e82).
 */
export interface SearchHitPort {
  /** Связь по id; 404 — хит устарел (связь удалили после поиска). */
  getLink(networkId: string, linkId: string): Promise<Link>;
  /** Установка фокуса карты; 404 — мысль-источник удалена (тоже stale). */
  setFocus(thoughtId: string): Promise<void>;
  /** Открыть связь в редакторе — только после успешной установки фокуса. */
  openLinkInEditor(link: Link): void;
}

let hitPort: SearchHitPort | null = null;

/** Подменяет порт хитового перехода (тестовый шов); `null` — системный порт. */
export function setSearchHitPort(port: SearchHitPort | null): void {
  hitPort = port;
}

/** Действующий порт хитового перехода: системные функции по умолчанию. */
function searchHitPort(): SearchHitPort {
  return (
    hitPort ?? {
      getLink: (networkId, linkId) => etn.links.get(networkId, linkId),
      setFocus,
      openLinkInEditor,
    }
  );
}

/**
 * Отказ открытия хита связи. Stale-хит (404/неразрешённый) — тишина: связь
 * или её источник удалили после поиска, шуметь не о чем. Любой другой отказ
 * (сеть, сервер) — тост из словаря: иначе клик по строке не даёт видимого
 * результата и выглядит «зависшим» (ошибка 53d21e82).
 */
function reportHitFailure(error: unknown): void {
  if (isNotFoundError(error)) return;
  notice(t('search.hitOpenFailed', errText(error)), 'error');
}

/**
 * Opens a link hit: focuses the source thought, opens the link editor.
 *
 * Stale-хит и сетевой отказ различаются (ошибка 53d21e82): прежний общий
 * `catch {}` глотал оба, и при недоступном сервере пользователь не получал
 * ни фокуса, ни редактора, ни сообщения. `openLinkInEditor` выполняется
 * только после успешной установки фокуса — при любом отказе он не нужен.
 */
async function openLinkHit(linkId: string): Promise<void> {
  try {
    const port = searchHitPort();
    const link = await port.getLink(requireNetworkId(), linkId);
    await port.setFocus(link.source_id);
    port.openLinkInEditor(link);
  } catch (error) {
    reportHitFailure(error);
  }
}

/** Opens a chronology hit on its owner (thought → focus, link → editor). */
async function openChronoHit(owner: 'thought' | 'link', ownerId: string): Promise<void> {
  if (owner === 'thought') {
    focusFromUi(ownerId);
    return;
  }
  try {
    const port = searchHitPort();
    const link = await port.getLink(requireNetworkId(), ownerId);
    port.openLinkInEditor(link);
  } catch (error) {
    reportHitFailure(error);
  }
}

/**
 * Builds the «настройки поиска» zone (задача 4b1cc3d4). Порядок зоны:
 *   1) строка «Места поиска» (области FTS) — САМОЙ ПЕРВОЙ;
 *   2) единый редактор мыслевых условий (профиль `thoughts`);
 *   3) постоянно видимый ПОДВАЛ команд — «Очистить» и подменю «Добавить
 *      отбор…» (не уезжает при прокрутке тела зоны, стили `search.css`).
 *
 * Корпусные поля «Ограничения» (типы связей), «Автор» и «Редактор» сняты с
 * панели СОВСЕМ — решение заказчика (2026-10-15): их фильтрация ХИТОВ (связи
 * по типу, хроно по авторству) не выражается редактором мыслевых условий;
 * потеря объявлена осознанной и зафиксирована в спеке. Серверный API поиска
 * параметры (`link_type_id`/`author_id`/`editor_id`) сохраняет для прямых
 * клиентов и агентов.
 */
function buildSettingsZone(zone: HTMLElement): void {
  // Пересборка зоны настроек заменяет редактор — прежний размонтируем.
  searchEditor?.destroy();
  searchEditor = null;
  zone.replaceChildren();

  // Поля сняты с UI, но состояние читается из старого L4-снимка (`search_state`)
  // целиком: обнуляем корпусные поля при каждой сборке зоны (в т.ч. после
  // `restoreState` → `rebuildSettingsZone`), иначе восстановленный снимок дал бы
  // НЕВИДИМЫЙ фильтр — на панели поля нет, а параметр уезжает в запрос (класс
  // ошибок ca864656/32fd6125). `buildSearchCriteriaWire` затем не отдаёт пустые.
  clearSearchCorpusFields(options);

  // --- строка: места поиска (области FTS) — первой -------------------------
  const mkCheck = (
    label: string,
    key: 'onlyThoughts' | 'onlyLinks' | 'onlyChrono',
  ): HTMLElement => {
    return checkboxRow({
      label,
      checked: options[key],
      onChange: (checked) => {
        options = { ...options, [key]: checked };
        persistState();
        refreshSearchIfVisible();
      },
    }).row;
  };
  const placesRow = div('search-settings-row');
  placesRow.append(
    span('Места поиска:', 'search-settings-label'),
    mkCheck('мысли', 'onlyThoughts'),
    mkCheck('связи', 'onlyLinks'),
    mkCheck('хроники', 'onlyChrono'),
  );

  // --- мыслевые настройки: единый редактор (профиль «мысли») ---------------
  // Реестр свойств пуст: строка поиска исторически не отбирает по свойствам
  // (как лента «События»); остальные операнды профиля `thoughts` доступны и без
  // реестра. Подкорень — строка «Родители в иерархии» (корень добавляет
  // `buildSearchAst`); типы мыслей — строка «Тип в иерархии»; видимость —
  // строки «Актуальность»/«Помечено на удаление». Заголовок места — свой, из
  // словаря (задача 4b1cc3d4), а не профильный «Показать мысли по условиям:».
  searchEditor = buildFilterEditor({
    profile: 'thoughts',
    networkId: requireNetworkId(),
    // Функция, а не снимок: календарь точной даты читает настройку в момент
    // открытия (ошибка b5278f9a).
    firstDayOfWeek: () => store.state.network?.first_day_of_week,
    title: t('filterEditor.titleSearch'),
    data: {
      registry: new Map(),
      linkTypes: store.state.linkTypes,
      thoughtTypes: store.state.thoughtTypes,
      contextual: ['parents', 'children', 'type', 'active', 'trashed'],
    },
    getState: () => options,
    touch: () => {
      persistState();
      refreshSearchIfVisible();
      searchEditor?.refresh();
    },
    // Набор текста в поле значения (ошибка 7d36f439): состояние сохраняется, а
    // строка поиска НЕ пересобирается — поле ввода не теряет фокус и каретку.
    touchValue: () => {
      persistState();
      refreshSearchIfVisible();
    },
    // Сортировка и футер у строки поиска свои/отсутствуют: порядок задаёт
    // релевантность FTS (ORDER BY rank), сохранённых отборов нет.
    sort: false,
    footer: false,
    buttons: { standard: false },
    host: {
      apply: () => refreshSearchIfVisible(),
    },
  });

  // Тело зоны — ЕДИНСТВЕННАЯ прокручиваемая часть: строка мест поиска и дерево
  // условий. Подвал команд вынесен из тела и не прокручивается (CSS
  // `.search-settings-body` / `.search-settings-actions`, задача 4b1cc3d4).
  const body = div('search-settings-body');
  body.append(placesRow, searchEditor.root);

  // --- подвал: постоянно видимые команды отбора ----------------------------
  const actions = div('search-settings-actions');
  const clearButton = uiButton({
    label: t('search.clearConditions'),
    role: 'ghost',
    size: 's',
    title: t('search.clearConditionsTitle'),
    // «Очистить» — штатная очистка единого редактора (`handle.clear`): снимает
    // все группы и условия ОСНОВНОЙ группы, пустая основная группа остаётся;
    // места поиска и прочие настройки зоны не трогает (задача 4b1cc3d4).
    onClick: () => searchEditor?.clear(),
  });
  const addButton = uiButton({
    label: t('search.addFilter'),
    role: 'ghost',
    size: 's',
    title: t('search.addFilterTitle'),
    onClick: (event) => openQuickCommandsMenu(event),
  });
  actions.append(clearButton, addButton);

  zone.append(body, actions);
}

/**
 * Открывает подменю «Добавить отбор…» (задача 4b1cc3d4): меню общей словарной
 * фабрики (`lib/menu.ts`) с тремя быстрыми командами отбора. Меню — уровневая
 * выпадашка панели; команды выполняет {@link runQuickCommand}.
 */
function openQuickCommandsMenu(event: MouseEvent): void {
  const anchor = event.currentTarget as HTMLElement | null;
  const rect = anchor?.getBoundingClientRect();
  showMenuAt(rect?.left ?? 8, rect?.bottom ?? 8, [
    menuAction(t('search.cmdParentInFocus'), () => runQuickCommand('parentInFocus')),
    menuAction(t('search.cmdOnlyActive'), () => runQuickCommand('onlyActive')),
    menuAction(t('search.cmdOnlyNotTrashed'), () => runQuickCommand('onlyNotTrashed')),
  ]);
}

/**
 * Выполняет быструю команду отбора: кладёт её условие в ОСНОВНУЮ группу
 * редактора (идемпотентно — повторный клик не плодит дубли,
 * {@link addSearchQuickCondition}).
 *
 * «По родителю в фокусе» без мысли в фокусе карты — подсказка-тост, условие не
 * добавляется: значение-токен `$thought` осталось бы неразрешимым, и поиск шёл
 * бы с диагностикой `unresolved` вместо результата (задача 4b1cc3d4).
 */
function runQuickCommand(
  command: 'parentInFocus' | 'onlyActive' | 'onlyNotTrashed',
): void {
  if (command === 'parentInFocus' && (store.state.focus?.focused.id ?? null) === null) {
    notice(t('search.focusRequired'));
    return;
  }
  const next = addSearchQuickCondition(options.tree ?? null, SEARCH_QUICK_CONDITIONS[command]());
  if (!next.added) return; // условие уже есть — дерево не меняется
  options = { ...options, tree: next.tree };
  persistState();
  refreshSearchIfVisible();
  searchEditor?.refresh();
}

/** Rebuilds the settings zone after options change (editor + plain rows). */
function rebuildSettingsZone(): void {
  if (chrome === null || settingsZone === null) return;
  buildSettingsZone(settingsZone);
}

/** Test seam. */
export const searchInternals = {
  scopesFor,
  mergeResponses,
  DEFAULT_OPTIONS,
  isSearchableQuery,
  parseThoughtIdQuery,
  parseThoughtIdLookupQuery,
  MIN_QUERY_LENGTH,
  nextNavIndex,
  openLinkHit,
  openChronoHit,
};
