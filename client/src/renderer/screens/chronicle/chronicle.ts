/**
 * Вид «Дневник» (рабочий стол) — 0.10.1, задача T6 64ca2b48.
 *
 * Экран (L20, был «Хроника»): в левой панели отбора первым элементом идёт
 * календарь месяца (0.10.1, элементы 9b424548/55b07702), в центре —
 * непрокручиваемая панель с кнопкой «Добавить хроно-запись» и ниже лента
 * дневниковых записей, сгруппированная по локальным дням наблюдателя; панель
 * отбора — общий каркас `lib/filter-form.ts` (состав — набор «Структур»).
 *
 * Ключевые поведения заданы элементами спеки и требованиями:
 *  * «Вид «Дневник» (рабочий стол)» 9b424548 — компоновка;
 *  * «Календарь месяца в «Дневнике»» 55b07702 — клик по дате/неделе = «Применить»
 *    с новым периодом, остальные критерии не трогаются, лента перезагружается;
 *  * «Лента дневных записей» e01f383a — группировка по дням, дозагрузка «+50»,
 *    чипсы привязок с «+»/«✕», правка по месту;
 *  * «Sticky-панель новой записи» a2b993d7 + требование 26f0aa52 — псевдо-запись,
 *    в базу не пишется до первого содержания;
 *  * требование 306f74cc — критерии целей (критерии панели едут в `targets`);
 *  * требование c6ddc1ea — порядок ленты (серверный, класс → даты);
 *  * требование e0970b70 — длительная запись видна в каждом дне периода;
 *  * требование c81964c7 — владелец HOME, чипсы — вторичные привязки;
 *  * требование 80b31f7a — переименование «Хроника» → «Дневник».
 *
 * Правка по месту — оболочка комментария `lib/ui/comment.ts` и общее поле
 * markdown; даты записи и поля периода — общий контрол `lib/period-editor.ts`
 * (своих полей дат у экрана нет, сторож `guard-period-editor`). Значения
 * контрола, уходящие в запись, переводятся в полные UTC-инстансы помощником
 * `resolvePeriodInstants`: смена только даты сохраняет время суток, `valid_to`
 * непуст (ADR 994d076a, требование d58aa1a4). Состояние (критерии, страница,
 * месяц, выбранный отбор) — L4 `chronicle_state`.
 */

import {
  CHRONICLE_PAGE_SIZE,
  CHRONICLE_QUERY_MAX_LIMIT,
  STRUCTURE_KEYWORD_SCOPES,
  UI_STATE_KEY,
  type AnyRealtimeEvent,
  type ChronicleRow,
  type ChronicleTarget,
  type ChronicleTargetLink,
  type Comment,
  type CommentTarget,
  type Link,
  type ThoughtRef,
} from '@etn/shared';

import { findRootThought, requireNetworkId } from '../../app.js';
import { pickThoughtsDialog, pickedThoughtIds } from '../../canvas/add-dialog.js';
import { showThoughtContextMenu } from '../../canvas/context-menu.js';
import { registerDropActions } from '../../canvas/drag-cloud.js';
import { openLinkInEditor, setThoughtEditorTarget } from '../../editor/editor.js';
import { createMarkdownField, editMarkdownField } from '../../editor/markdown-field.js';
import { confirmDialog } from '../../lib/dialog.js';
import { div, el, errText, fmtDate, span } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { mountFilterPanelFrame } from '../../lib/filter-panel-frame.js';
import { markCommentPreview, markThoughtCommentPreview } from '../../lib/hover-preview.js';
import { svgIcon } from '../../lib/icons.js';
import { menuAction, showMenuAt, MENU_SEPARATOR, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import {
  resolvePeriodInstants,
} from '../../lib/period-editor.js';
import {
  datePeriodValueFromInstants,
  formatRecordPeriod,
  openDatePeriodDialog,
  resolveDatePeriodInstants,
  type DatePeriodValue,
} from '../../lib/date-period-dialog.js';
import { createThoughtCloud } from '../../lib/thought-cloud.js';
import {
  RECORD_SEARCH_MAX_RESULTS,
  mountRecordSearch,
  parseRecordSearchSettings,
  serializeRecordSearchSettings,
  type RecordSearchHandle,
  type RecordSearchSettings,
} from '../../lib/record-search.js';
import { iconButton, uiButton } from '../../lib/ui/button.js';
import { commentShell } from '../../lib/ui/comment.js';
import { fieldInput } from '../../lib/ui/field.js';
import { operationError } from '../../lib/ui/messages.js';
import { reconcileKeyed } from '../../lib/ui/keyed-list.js';
import { splitterElement } from '../../lib/ui/splitter.js';
import { TABLE_ROW_KEY_ATTR } from '../../lib/ui/table.js';
import { shouldLoadMore, type ZonePagingCounters } from '../../lib/zone-paging.js';
import { store } from '../../state.js';
import { t } from '../../lib/i18n.js';
import { parseChronicleCriteria, defaultChronicleCriteriaState, hasAnyFilterCriteria } from '../../lib/filter-builder.js';
import { createRealtimeBatch } from '../../lib/realtime-batch.js';
import {
  chronicleAllowsIncremental,
  commentUpdateNeedsReload,
  hasDiaryAttachment,
  mergeCommentChanges,
  rowVisibleInPeriod,
  type ChronicleCriteriaSnapshot,
} from './realtime-apply.js';
import { buildMonthCalendar, type MonthCalendarHandle } from '../../lib/month-calendar.js';
import {
  applyPeriodToFilter,
  attachmentOwnerForRow,
  clampPseudoDate,
  compareDays,
  dayInPeriod,
  dayPeriod,
  formatDayLabel,
  groupByLocalDays,
  hasRecordContent,
  insertRowByDay,
  isLastChip,
  localDay,
  localDayEnd,
  localDayStart,
  periodValuesForRange,
  resolvePeriodDay,
  rowDays,
  slotDeleteNeedsNetwork,
  todayLocal,
  visibleChips,
  weekPeriod,
} from './diary.js';
import {
  addThoughtToFilter,
  chronicleDefinition,
  chronicleQueryDefinition,
  getFilterState,
  getSavedFilterId,
  mountChronicleFilterPanel,
  setFilterState,
  setSavedFilterId,
  wireChronicleApplyShortcut,
} from './filter-panel.js';
import { attachFeedNav, type FeedNavHandle } from './feed-nav.js';
import { applyDayCollapsed, findDaySection, type DayGroupLabels } from './day-groups.js';
import { parseChronicleState } from './state.js';
import { renderRecordView } from './record-body.js';

/**
 * Границы размера панели отбора (задача 2ebe4206): слева — ширина, вверху
 * (узкое полотно) — высота.
 */
const CHRONICLE_FILTER_MIN_W = 230;
const CHRONICLE_FILTER_MAX_W = 480;

/**
 * Потолок страниц запроса счётчиков календаря (страница — `CHRONICLE_QUERY_MAX_LIMIT`):
 * защита от неограниченного цикла на месяце с очень большим числом записей.
 */
const CAL_COUNTS_MAX_PAGES = 20;

let host: HTMLElement | null = null;
/** Composite cache key of the last init: `${networkId}:${tabId}`. */
let networkIdSeen: string | null = null;

// ---------------------------------------------------------------------------
// Feed state
// ---------------------------------------------------------------------------

let rows: ChronicleRow[] = [];
let total = 0;
/** Loading guard so a stale page does not clobber a newer one. */
let querySeq = 0;
let loadingMore = false;
/**
 * Локально вставленная запись ещё не подтверждена серверной страницей
 * (0.10.1, итерация приёмки №8, п.2): следующий запрос «+50» идёт полной
 * перезагрузкой, а не offset-пагинацией, чтобы не потерять/не удвоить строку.
 */
let pendingReconcile = false;
/** Id of the HOME (root) thought — primary owner of a day record. */
let homeId: string | null = null;
let homePromise: Promise<string> | null = null;
/** Stable scroll container of the feed (`.chron-table-wrap`). */
let feedWrap: HTMLElement | null = null;
/** Stable list element re-rendered inside the container (never rebuilt). */
let feedList: HTMLElement | null = null;
/** Контроллер клавиатурной навигации ленты (0.10.1, приёмка №9). */
let feedNav: FeedNavHandle | null = null;
/**
 * Обработчики карточек записей (оболочка комментария + строка), заведённые при
 * сборке карточки: вход в правку текста по навигации идёт от DOM-узла карточки
 * (требование 165323a7), а не от повторного поиска строки.
 */
const recordShells = new WeakMap<
  HTMLElement,
  { row: ChronicleRow; shell: ReturnType<typeof commentShell>; body: HTMLElement }
>();
let statusEl: HTMLElement | null = null;
let calendar: MonthCalendarHandle | null = null;
/** Persisted month of the calendar (`chronicle_state.month`). */
let month: { year: number; month: number } | null = null;
/** Счётчики записей по дням (для календаря), пересчитываются при отрисовке. */
const dayCounts = new Map<string, number>();
/** Запись, к которой выполнен переход: карточка подсвечена до следующего применения. */
let jumpHighlightId: string | null = null;
/** Строка поиска дневниковых записей (0.10.1, задача 46057359). */
let recordSearch: RecordSearchHandle | null = null;

// ---------------------------------------------------------------------------
// Pseudo-record (slot) state
// ---------------------------------------------------------------------------

interface SlotState {
  day: string;
  commentId: string | null;
  root: HTMLElement;
  titleInput: HTMLInputElement;
  /** Дата записи по умолчанию (`clamp(сегодня, начало, конец периода)`). */
  from: string;
}

let slot: SlotState | null = null;

/** Свёрнутые группы дат ленты (0.10.1, приёмка №2); состояние — L4 `ui_state`. */
const collapsedDays = new Set<string>();

let collapsedDaysLoaded = false;

/** Загрузить свёрнутые группы дат из клиентских настроек экрана (L4). */
async function loadCollapsedDays(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || collapsedDaysLoaded) return;
  collapsedDaysLoaded = true;
  try {
    const raw = await etn.ui.getState(networkId, UI_STATE_KEY.DIARY_COLLAPSED_DAYS);
    collapsedDays.clear();
    if (raw !== null && raw !== '') {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const day of parsed) if (typeof day === 'string') collapsedDays.add(day);
      }
    }
  } catch {
    // Настройка недоступна — считаем, что всё развёрнуто.
  }
}

/** Сохранить свёрнутые группы дат в клиентские настройки экрана (L4). */
function persistCollapsedDays(): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  void etn.ui
    .setState(networkId, UI_STATE_KEY.DIARY_COLLAPSED_DAYS, JSON.stringify([...collapsedDays]))
    .catch(() => undefined);
}

/** Переключить свёрнутость группы даты (0.10.1, приёмка №2). */
function toggleDayCollapsed(day: string): void {
  setDayCollapsed(day, !collapsedDays.has(day));
}

/** Подписи заголовка группы дат из словаря (для in-place переключения). */
function dayGroupLabels(): DayGroupLabels {
  return { expand: t('listActions.expand'), collapse: t('listActions.collapse') };
}

/**
 * Привести свёрнутость группы дня к заданному состоянию (0.10.1, приёмка №9):
 * единая точка для клика по заголовку и для клавиатуры (Enter/«влево»/«вправо»).
 *
 * Группа переключается НА МЕСТЕ (`applyDayCollapsed`): узлы ленты не
 * пересобираются, поэтому фокус клавиатурной навигации и позиция прокрутки
 * сохраняются (требование 165323a7, «Устойчивость»; ошибки ab78e7b5,
 * 407b1827). Полная перерисовка остаётся только запасным путём, когда секции
 * дня в текущем DOM нет (её ещё не показывали).
 */
function setDayCollapsed(day: string, collapsed: boolean): void {
  if (collapsedDays.has(day) === collapsed) return;
  if (collapsed) collapsedDays.add(day);
  else collapsedDays.delete(day);
  persistCollapsedDays();
  const section = feedList !== null ? findDaySection(feedList, day) : null;
  if (section !== null) {
    applyDayCollapsed(section, collapsed, dayGroupLabels());
    feedNav?.refresh();
    return;
  }
  renderFeed();
}

// ---------------------------------------------------------------------------
// Mount / init
// ---------------------------------------------------------------------------

/** Switches to the diary view — lazily loads persisted state (L4). */
export async function ensureChronicleInitialised(): Promise<void> {
  const networkId = store.state.networkId;
  const tabId = store.state.activeTabId;
  if (networkId === null || host === null) return;
  const key = `${networkId}:${tabId ?? ''}`;
  if (networkIdSeen === key) return;
  networkIdSeen = key;

  rows = [];
  total = 0;
  slot = null;
  month = null;
  collapsedDaysLoaded = false;
  collapsedDays.clear();
  // Подсветка перехода — состояние текущего входа, не персистится.
  jumpHighlightId = null;
  recordSearch?.hide();

  try {
    let raw: string | null = null;
    if (tabId !== null) {
      const tab = store.state.tabs.find((tb) => tb.tab_id === tabId);
      raw = tab?.chronicle_state ?? null;
    }
    if (raw === null) {
      raw = await etn.ui.getState(networkId, UI_STATE_KEY.CHRONICLE_STATE);
    }
    if (raw !== null && raw !== '') {
      const parsed = parseChronicleState(raw);
      setFilterState(parseChronicleCriteria(parsed.filter));
      setSavedFilterId(parsed.savedFilterId);
      if (parsed.month !== null) month = parsed.month;
    }
  } catch {
    // Fall back to the empty filter.
  }
  await getHome().catch(() => undefined);
  await loadCollapsedDays();
  await reload();
  syncCalendar();
}

/** Persists the current filter + month to L4 (per-tab). */
function persistState(): void {
  const tabId = store.state.activeTabId;
  if (tabId === null) return;
  void etn.tabs
    .updateState(tabId, {
      chronicle_state: JSON.stringify({
        filter: chronicleDefinition(),
        month: month ?? calendar?.getMonth() ?? null,
        savedFilterId: getSavedFilterId(),
      }),
    })
    .catch(() => undefined);
}

/** Builds and mounts the whole diary view into its host. */
export function mountChronicle(hostEl: HTMLElement): void {
  host = hostEl;
  hostEl.replaceChildren();
  feedNav?.destroy();
  feedNav = null;

  const filterArea = div('chron-filter-area');
  const splitter = splitterElement('chron-splitter');
  const main = div('chron-main');
  // Строка поиска записей — над панелью отбора и лентой, во всю ширину области
  // дневника (0.10.1, задача 46057359). Каркас панели отбора переезжает на
  // внутренний контейнер: полотно вида остаётся колонкой (строка + каркас).
  const searchArea = div('chron-search-area');
  const frameHost = div('chron-frame');
  hostEl.append(searchArea, frameHost);
  frameHost.append(filterArea, splitter, main);
  mountFilterPanelFrame({
    container: frameHost,
    panel: filterArea,
    splitter,
    stateKey: UI_STATE_KEY.CHRONICLE_FILTER_PANEL,
    minSize: CHRONICLE_FILTER_MIN_W,
    maxSize: CHRONICLE_FILTER_MAX_W,
    minSizeTop: 80,
    maxSizeTop: 800,
  });

  // Строка поиска дневниковых записей — переиспользуемый компонент
  // (`lib/record-search.ts`): мини-синтаксис keywords, выпадающий список
  // записей, настройки «неактивные мысли»/«корзина», переход к записи.
  recordSearch = mountRecordSearch(searchArea, {
    search: (query) => searchRecords(query),
    onPick: (row) => void jumpToRecord(row),
    loadSettings: () => loadRecordSearchSettings(),
    saveSettings: (settings) => persistRecordSearchSettings(settings),
  });

  // Календарь — первый элемент панели отбора (0.10.1, элемент 9b424548).
  const calWrap = div('chron-cal');
  calendar = buildMonthCalendar({
    today: todayLocal(),
    month: month ?? undefined,
    counts: (day) => dayCount(day),
    onPickDay: (day) => void pickPeriod(dayPeriod(day)),
    onPickWeek: (monday) => void pickPeriod(weekPeriod(monday)),
    onToday: () => goToday(),
    onMonthChange: (year, monthNo) => {
      month = { year, month: monthNo };
      persistState();
      void refreshCalendarCounts();
    },
  });
  calWrap.append(calendar.root);

  mountChronicleFilterPanel(
    filterArea,
    {
      apply: () => void applyFilter(),
      jumpToRecord: (row) => void jumpToRecord(row),
    },
    { header: [calWrap] },
  );

  // Верхняя (непрокручиваемая) панель над лентой: кнопка «Добавить
  // хроно-запись» и компактные иконки «Развернуть все»/«Свернуть все» рядом
  // (0.10.1, приёмка №2 — кнопки не во всю ширину).
  const addBar = div('chron-addbar');
  addBar.append(
    div('chron-addbar-actions'),
  );
  const addActions = addBar.firstElementChild as HTMLElement;
  addActions.append(
    uiButton({
      label: t('diary.addRecord'),
      role: 'primary',
      class: 'diary-add-btn',
      onClick: () => startSlot(),
    }),
    iconButton({
      icon: svgIcon('chevrons-down', 16),
      title: t('diary.expandAll'),
      role: 'ghost',
      size: 's',
      class: 'diary-expand-all',
      onClick: () => setAllDaysCollapsed(false),
    }),
    iconButton({
      icon: svgIcon('chevrons-up', 16),
      title: t('diary.collapseAll'),
      role: 'ghost',
      size: 's',
      class: 'diary-collapse-all',
      onClick: () => setAllDaysCollapsed(true),
    }),
  );

  // Центр: лента, сгруппированная по локальным дням.
  feedWrap = div('admin-table-wrap chron-table-wrap chron-feed-wrap');
  feedList = div('chron-feed');
  statusEl = div('muted chron-feed-status');
  statusEl.hidden = true;
  feedWrap.append(statusEl, feedList);
  feedWrap.addEventListener('scroll', () => maybeLoadMore());
  // Лента — фокусируемая область: клавиатурная навигация слушает keydown здесь
  // (требование 165323a7). Клик по карточке/заголовку тоже делает сущность текущей.
  feedWrap.tabIndex = 0;
  feedNav = attachFeedNav(feedWrap, {
    onSetDayCollapsed: (day, collapsed) => setDayCollapsed(day, collapsed),
    onEditBody: (_id, card) => openCardBodyEditor(card),
    onEditDates: (_id, card) => editCardDates(card),
    onAddThought: (id) => void pickAndAttach(id),
  });

  main.append(addBar, feedWrap);
  void refreshCalendarCounts();

  wireChronicleApplyShortcut(hostEl);
  registerDropActions({
    chronicleAttach: (thoughtId, rowId) => void attachToRecord(rowId, [thoughtId]),
    chronicleNewEntry: (thoughtId) => startSlot(undefined, [thoughtId]),
    chronicleFilterAdd: (thoughtId) => addThoughtToFilter(thoughtId),
  });

  store.subscribe(() => {
    if (host === null || !host.isConnected) return;
    const networkId = store.state.networkId;
    const tabId = store.state.activeTabId;
    if (
      networkId !== null &&
      networkIdSeen !== `${networkId}:${tabId ?? ''}` &&
      store.state.activeView === 'chronicle'
    ) {
      void ensureChronicleInitialised();
    }
  });
}

// ---------------------------------------------------------------------------
// Query / feed loading
// ---------------------------------------------------------------------------

/** Applies the current filter from scratch (the «Применить» path). */
async function applyFilter(): Promise<void> {
  // Ручное применение снимает подсветку перехода.
  jumpHighlightId = null;
  persistState();
  await getHome().catch(() => undefined);
  await reload();
  // Смена отбора показывает ленту с начала: reload пересобирает её с якорем,
  // поэтому позицию сбрасываем явно поверх.
  if (feedWrap !== null) feedWrap.scrollTop = 0;
  syncCalendar();
  void refreshCalendarCounts();
}

/** Re-fetches the first page (used after edits and real-time events). */
async function reload(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || feedList === null) return;
  const seq = ++querySeq;
  renderStatus('loading');
  try {
    const def = chronicleQueryDefinition();
    const result = await etn.chronicle.query(networkId, {
      ...def,
      limit: CHRONICLE_PAGE_SIZE,
      offset: 0,
    });
    if (seq !== querySeq) return;
    rows = result.rows;
    total = result.total;
    pendingReconcile = false;
    renderFeed();
  } catch (err) {
    if (seq !== querySeq) return;
    renderStatus('error', err);
  }
}

/** Fetches the next «+50» page and appends it (scroll pagination). */
async function loadMore(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || loadingMore || rows.length >= total) return;
  // После локальной вставки offset-страница сдвинулась бы: подтягиваем первую
  // страницу заново (данные важнее экономии запроса); прокрутку держит renderFeed.
  if (pendingReconcile) {
    await reload();
    return;
  }
  loadingMore = true;
  const seq = querySeq;
  try {
    const result = await etn.chronicle.query(networkId, {
      ...chronicleQueryDefinition(),
      limit: CHRONICLE_PAGE_SIZE,
      offset: rows.length,
    });
    if (seq !== querySeq) return;
    rows = [...rows, ...result.rows];
    total = result.total;
    // Дозагрузка «+50» дописывает страницу — прокрутка не должна прыгать вверх.
    renderFeed();
  } catch {
    // A failed page keeps what is already shown; the next scroll retries.
  } finally {
    loadingMore = false;
  }
}

function maybeLoadMore(): void {
  if (feedWrap === null) return;
  const counters: ZonePagingCounters = { loaded: rows.length, total, loading: loadingMore };
  if (shouldLoadMore(counters, feedWrap)) void loadMore();
}

/**
 * Realtime-путь «Дневника» (задача afcfb144, уровень 3 тех.проекта `1d48df6d`).
 *
 * **Таблица «событие → действие».**
 *
 * | Событие | Инкрементально | Fallback (полный перезапрос) |
 * |---|---|---|
 * | `comment.created` | хроно-запись хотя бы с одной привязкой, отбор — только период/порядок: точечный доар не-HOME целей + вставка одной строки в свой день | прочие критерии в отборе (текст/цели/автор); сборка строки/доар не удалась; привязок нет или вне периода — игнор |
 * | `comment.updated` | строка в ленте: слияние полей, доар `body_html` при неполном payload, переразрешение `targets`, перестановка по дате; строки нет — додар полного комментария и вставка, если запись попала в период; выход из периода — удаление строки | при доп. критериях изменение текста/заголовка/привязок, а также событие по записи вне ленты (вхождение в отбор без сервера не проверить) |
 * | `comment.deleted` | строка в ленте → удаление одной строки | нет строки или владелец не мысль — игнор |
 * | прочее (в т.ч. `thought.deleted` по чипсам) | — | `scheduleChronicleRefresh` (полный перезапрос) |
 *
 * Очередь событий за окно дебаунса применяется ОДНИМ батчем → один `renderFeed`
 * на окно; fallback-событие в окне отменяет батч и зовёт {@link reloadAndSync}.
 */
type ChronicleRealtimeOp =
  | { kind: 'created'; comment: Comment }
  | { kind: 'updated'; id: string; changes: Partial<Comment> }
  | { kind: 'deleted'; id: string };

const realtimeBatch = createRealtimeBatch<ChronicleRealtimeOp>({
  windowMs: 250,
  applyBatch: (ops) => {
    void applyChronicleOps(ops);
  },
  applyFull: () => {
    void reloadAndSync();
  },
});

/** Полный путь realtime: перезапрос первой страницы + пересчёт календаря. */
async function reloadAndSync(): Promise<void> {
  await reload();
  syncCalendar();
  void refreshCalendarCounts();
}

/** Критерии, при которых новую/изменённую запись нельзя признать входящей в отбор. */
function chronicleCriteriaSnapshot(): ChronicleCriteriaSnapshot {
  const f = getFilterState();
  const hasAuthor =
    f.authorOp !== 'eq' ||
    f.authorId !== '' ||
    f.authorIds.length > 0 ||
    f.editorOp !== 'eq' ||
    f.editorId !== '' ||
    f.editorIds.length > 0;
  return {
    keywords: f.keywords,
    hasTargetCriteria: hasAnyFilterCriteria(f.targets),
    hasAuthorCriteria: hasAuthor,
  };
}

/**
 * Дебounced refresh (real-time comment/target events) — полный путь. Локальные
 * производители зовут его сами; чужое realtime-эхо до рендерера не доходит.
 * Внутри окна дебаунса батч инкрементальных событий отменяется: полный путь
 * важнее экономии.
 */
export function scheduleChronicleRefresh(): void {
  if (host === null) return;
  realtimeBatch.markFull();
}

/**
 * Принять чужое хроно-событие: классифицировать и положить в очередь окна или
 * пометить окно как fallback. Событие по записи, которой нет в ленте,
 * игнорируется.
 */
export function applyChronicleRealtime(evt: AnyRealtimeEvent): void {
  if (host === null) return;
  switch (evt.type) {
    case 'comment.created': {
      const comment = evt.data.comment;
      if (comment.kind !== 'chronological') return;
      if (!chronicleAllowsIncremental(chronicleCriteriaSnapshot())) {
        realtimeBatch.markFull();
        return;
      }
      realtimeBatch.push({ kind: 'created', comment });
      return;
    }
    case 'comment.updated': {
      const { id, changes } = evt.data;
      // Запись не в загруженной странице: перенос даты в видимый период обязан
      // показать её (замечание проверки уровня 3) — идём тем же инкрементальным
      // путём с точечным додаром полного комментария. Но только при отборе без
      // доп. критериев: иначе вхождение в отбор без сервера не проверить.
      if (!rows.some((r) => r.id === id)) {
        if (!chronicleAllowsIncremental(chronicleCriteriaSnapshot())) {
          realtimeBatch.markFull();
          return;
        }
        realtimeBatch.push({ kind: 'updated', id, changes });
        return;
      }
      if (commentUpdateNeedsReload(changes, chronicleCriteriaSnapshot())) {
        realtimeBatch.markFull();
        return;
      }
      realtimeBatch.push({ kind: 'updated', id, changes });
      return;
    }
    case 'comment.deleted': {
      const { id, owner_type } = evt.data;
      if (owner_type !== 'thought') return;
      if (!rows.some((r) => r.id === id)) return;
      realtimeBatch.push({ kind: 'deleted', id });
      return;
    }
    default:
      return;
  }
}

/**
 * Применить накопленный батч к снимку ленты и ОДИН раз пересобрать её. Любая
 * неуверенность (не собралась локальная строка, не удался доар) откатывает
 * окно на полный перезапрос — данные важнее экономии запроса.
 */
async function applyChronicleOps(ops: readonly ChronicleRealtimeOp[]): Promise<void> {
  const { from, to } = currentFromTo();
  const order = getFilterState().order;
  let changed = false;
  for (const op of ops) {
    if (op.kind === 'deleted') {
      if (rows.some((r) => r.id === op.id)) {
        rows = rows.filter((r) => r.id !== op.id);
        total = Math.max(0, total - 1);
        changed = true;
      }
      continue;
    }
    if (op.kind === 'created') {
      if (!hasDiaryAttachment(op.comment.targets)) continue;
      const home = homeId ?? (await getHome().catch(() => null));
      if (home === null) {
        await reloadAndSync();
        return;
      }
      const built = await localRowFromComment(op.comment, home);
      if (built === null) {
        await reloadAndSync();
        return;
      }
      if (!rowVisibleInPeriod(built, from, to)) continue;
      if (rows.some((r) => r.id === built.id)) continue;
      rows = insertRowByDay(rows, built, order, home);
      total += 1;
      // Локальная вставка сдвигает страницу — следующий «+50» идёт полной
      // перезагрузкой, а не offset-пагинацией (иначе дубль/пропуск).
      pendingReconcile = true;
      changed = true;
      continue;
    }
    // updated
    const idx = rows.findIndex((r) => r.id === op.id);
    if (idx < 0) {
      // Записи нет в загруженной странице: додар полного комментария и вставка
      // строки, если она попадает в применённый период (замечание проверки).
      const home = homeId ?? (await getHome().catch(() => null));
      if (home === null) {
        await reloadAndSync();
        return;
      }
      let comment: Comment;
      try {
        comment = await etn.comments.get(requireNetworkId(), op.id);
      } catch {
        // Вхождение записи в отбор/период без додара не проверить — полный
        // путь, а не глушение: иначе перенос даты в видимый период не покажется
        // до постороннего обновления (ошибка 820608e4).
        await reloadAndSync();
        return;
      }
      if (comment.kind !== 'chronological' || !hasDiaryAttachment(comment.targets)) continue;
      const built = await localRowFromComment(comment, home);
      if (built === null) {
        await reloadAndSync();
        return;
      }
      if (!rowVisibleInPeriod(built, from, to) || rows.some((r) => r.id === built.id)) continue;
      rows = insertRowByDay(rows, built, order, home);
      total += 1;
      pendingReconcile = true;
      changed = true;
      continue;
    }
    let row = rows[idx]!;
    let changes = op.changes;
    if (changes.body_md !== undefined && changes.body_html === undefined) {
      try {
        const fresh = await etn.comments.get(requireNetworkId(), op.id);
        changes = { ...changes, body_html: fresh.body_html };
      } catch {
        continue; // доар не удался — строку не трогаем, следующий перезапрос поправит
      }
    }
    row = mergeCommentChanges(row, changes);
    if (changes.targets !== undefined) {
      const home = homeId ?? (await getHome().catch(() => null));
      if (home === null) {
        await reloadAndSync();
        return;
      }
      const targets = await resolveRowTargets(changes.targets, home);
      if (targets === null) {
        await reloadAndSync();
        return;
      }
      row = { ...row, targets };
    }
    if (!rowVisibleInPeriod(row, from, to)) {
      rows = rows.filter((r) => r.id !== op.id);
      total = Math.max(0, total - 1);
      changed = true;
      continue;
    }
    // Переставить на место по тому же порядку, что серверный: правка даты
    // сдвигает запись в ленте, а не только её содержимое. Класс записи считается
    // по РАЗРЕШЁННОМУ HOME: при `homeId === null` `recordClass` даёт 1 всем
    // строкам и позиция разойдётся с серверной — недоступный HOME уводит в
    // полный путь (ошибка 89409d57).
    const homeForOrder = homeId ?? (await getHome().catch(() => null));
    if (homeForOrder === null) {
      await reloadAndSync();
      return;
    }
    rows = insertRowByDay(
      rows.filter((r) => r.id !== op.id),
      row,
      order,
      homeForOrder,
    );
    changed = true;
  }
  if (changed) {
    renderFeed();
    syncCalendar();
    void refreshCalendarCounts();
  }
}

/**
 * The thought disappeared — refresh the feed if it is an attachment of any
 * loaded record.
 */
export function invalidateChronicleThought(id: string): void {
  if (host === null) return;
  if (rows.some((row) => row.targets.some((t) => t.kind === 'thought' && t.thought.id === id))) {
    scheduleChronicleRefresh();
  }
}

function renderStatus(kind: 'loading' | 'error', err?: unknown): void {
  if (statusEl === null) return;
  statusEl.hidden = false;
  if (kind === 'loading') {
    statusEl.replaceChildren(span(t('common.loading'), 'muted'));
  } else {
    statusEl.replaceChildren(operationError(err));
  }
  if (feedList !== null) feedList.hidden = kind === 'error';
}

// ---------------------------------------------------------------------------
// Feed rendering
// ---------------------------------------------------------------------------

/** Локальный день HOME-записи — для слота псевдо-записи. */
function currentFromTo(): { from: string; to: string } {
  const filter = getFilterState();
  return { from: resolvePeriodDay(filter.dateFrom), to: resolvePeriodDay(filter.dateTo) };
}

/** Число записей, попавших в день (счётчик календаря). */
function dayCount(day: string): number {
  return dayCounts.get(day) ?? 0;
}

function renderFeed(): void {
  const list = feedList;
  if (list === null) return;
  if (statusEl !== null) statusEl.hidden = true;
  list.hidden = false;

  const { from, to } = currentFromTo();
  // Направление сортировки ленты (0.10.1, итерация приёмки №8, п.3): сервер
  // отдаёт строки в выбранном порядке, клиент уважает его и в группировке дней.
  const order = getFilterState().order;
  const days = groupByLocalDays(rows, { from, to, order });
  // Счётчики календаря приходят из отдельного запроса по месяцу
  // (`refreshCalendarCounts`) — они не зависят от применённого периода, поэтому
  // видны и на выделенной, и на невыделенной дате (0.10.1, дефект приёмки).
  // Слот псевдо-записи виден, как и запись, ТОЛЬКО в своём периоде (ошибка
  // effefba3): если применённый период не содержит её день, слот не
  // показывается — иначе зависшая псевдо-запись (без `data-row-key`, с
  // некликабельной датой) торчала бы при любом периоде. День слота при этом
  // остаётся в его состоянии: при возврате периода псевдо-запись показывается
  // снова (черновик в узле сохраняется).
  const slotNow = slot;
  const slotDay = slotNow !== null && dayInPeriod(slotNow.day, from, to) ? slotNow.day : null;
  if (slotDay !== null && !days.some((d) => d.day === slotDay)) {
    days.push({ day: slotDay, rows: [] });
    days.sort((a, b) => compareDays(a.day, b.day, order));
  }

  // Инкрементальное обновление ленты (уровень 2 тех.проекта `1d48df6d`):
  // ВНЕШНИЙ уровень — группы дней по ключу дня (`data-day`), ВНУТРЕННИЙ —
  // карточки записей по `data-row-key`. Неизменные узлы не пересоздаются,
  // поэтому прокрутка, hover, фокус и открытые редакторы переживают правку
  // записи, realtime-перезапрос и дозагрузку «+50».
  reconcileKeyed(list, days, {
    keyAttr: 'data-day',
    key: (day) => day.day,
    build: (day) => buildDaySection(day.day),
    update: (section, day) => updateDaySection(section, day.day),
  });

  for (const day of days) {
    const section = findDaySection(list, day.day);
    if (section === null) continue;
    const dayList = section.querySelector<HTMLElement>('.diary-day-list');
    if (dayList === null) continue;
    reconcileKeyed(dayList, day.rows, {
      keyAttr: TABLE_ROW_KEY_ATTR,
      key: (row) => row.id,
      build: (row) => buildRecordCard(row),
      update: (card, row) => updateRecordCard(card, row),
    });
    // Слот псевдо-записи — ВНЕ reconcile: сверка снимает его как безключевой
    // узел, поэтому возвращаем ТОТ ЖЕ элемент наверх списка дня. Identity узла
    // и текст живого редактора сохраняются (элемент «Sticky-панель новой
    // записи»). Показываем только когда его день в применённом периоде
    // (ошибка effefba3): вне периода узел остаётся отсоединённым.
    if (slotNow !== null && slotDay === day.day) dayList.prepend(slotNow.root);
  }

  // Хвост ленты («пусто»/«осталось N») — вне reconcile, монтируется после:
  // пересобирается целиком на каждой отрисовке.
  if (days.length === 0) {
    list.append(el('div', 'chron-feed-empty muted', t('diary.feedEmpty')));
  } else if (rows.length < total) {
    list.append(el('div', 'chron-feed-more muted', t('diary.moreLeft', [rows.length, total])));
  }
  // Переприменить выделение «текущей» сущности после перерисовки (требование
  // 165323a7): оно сохраняется, если сущность ещё видима, и сбрасывается иначе.
  feedNav?.refresh();
}

/**
 * Строка ленты из только что созданной записи (0.10.1, итерация приёмки №8,
 * п.2). `Comment` не несёт развёрнутых целей, поэтому не-HOME привязки
 * доразрешаются точечным чтением мысли (`etn.thoughts.get`; `Thought`
 * структурно включает `ThoughtRef`). Любая неурядица возвращает `null` —
 * вызывающий откатывается на полную перезагрузку ленты (в этом случае
 * спокойствие позиции не гарантируется, зато данные точны).
 */
async function localRowFromComment(
  comment: Comment,
  home: string,
): Promise<ChronicleRow | null> {
  const targets = await resolveRowTargets(comment.targets, home);
  if (targets === null) return null;
  return {
    id: comment.id,
    title: comment.title,
    valid_from: comment.valid_from,
    valid_to: comment.valid_to,
    use_time: comment.use_time === true,
    version: comment.version,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    created_by: comment.created_by,
    updated_by: comment.updated_by,
    snippet: '',
    body_html: comment.body_html,
    targets,
  };
}

/**
 * Привязки записи для ленты: HOME — служебная и в чипсах не показывается,
 * остальные мысли доразрешаются точечным чтением (`etn.thoughts.get`).
 * `null` — встретилась не-support'имая привязка (связь) или доар не удался;
 * вызывающий откатывается на полную перезагрузку (realtime) либо на серверную
 * строку.
 */
async function resolveRowTargets(
  targets: readonly CommentTarget[],
  home: string,
): Promise<ChronicleTarget[] | null> {
  const networkId = requireNetworkId();
  const out: ChronicleTarget[] = [];
  for (const target of targets) {
    if (target.owner_type !== 'thought') return null;
    if (target.owner_id === home) continue;
    try {
      const thought = await etn.thoughts.get(networkId, target.owner_id);
      out.push({ kind: 'thought', thought });
    } catch {
      return null;
    }
  }
  return out;
}

/** Обновить строку «осталось N» без перерисовки ленты (её счётчик сдвинулся). */
function updateMoreLine(): void {
  if (feedList === null) return;
  const more = feedList.querySelector<HTMLElement>('.chron-feed-more');
  if (more !== null) more.textContent = t('diary.moreLeft', [rows.length, total]);
}

/**
 * Локальная вставка созданной записи: слот превращается в карточку записи на
 * месте (0.10.1, итерация приёмки №8, п.2) — DOM-позиция и скролл сохраняются,
 * соседние карточки не пересобираются. `feedList` при этом не перерисовывается
 * целиком; счётчики календаря обновляются отдельным запросом (фоном).
 *
 * Место строки в ленте считается по РАЗРЕШЁННОМУ HOME (`homeId ?? getHome()`), а
 * не по модульному `homeId`: при `homeId === null` `recordClass` даёт 1 всем
 * строкам и позиция расходится с серверной (та же природа, что 89409d57).
 * Недоступный HOME уводит в полный путь — слот убираем, лента перезагружается
 * (ошибка 810520c5).
 */
async function insertCreatedRecord(row: ChronicleRow): Promise<void> {
  const home = homeId ?? (await getHome().catch(() => null));
  const slotRoot = slot?.root ?? null;
  if (home === null) {
    slot = null;
    slotRoot?.remove();
    await reload();
    return;
  }
  const card = buildRecordCard(row);
  const inPlace = slotRoot !== null && slotRoot.parentElement !== null;
  if (inPlace) slotRoot!.replaceWith(card);
  rows = insertRowByDay(rows, row, getFilterState().order, home);
  total += 1;
  pendingReconcile = true;
  slot = null;
  if (inPlace) updateMoreLine();
  else renderFeed();
  feedNav?.refresh();
}
/** Свернуть/развернуть все показанные группы дат (кнопки верхней панели). */
function setAllDaysCollapsed(collapsed: boolean): void {
  collapsedDays.clear();
  if (collapsed) {
    const { from, to } = currentFromTo();
    for (const day of groupByLocalDays(rows, { from, to })) collapsedDays.add(day.day);
    if (slot !== null) collapsedDays.add(slot.day);
  }
  persistCollapsedDays();
  // Как и одиночная группа, «свернуть/развернуть все» переключает секции
  // НА МЕСТЕ — фокус и прокрутка сохраняются (требование 165323a7).
  if (feedList !== null) {
    const labels = dayGroupLabels();
    let touched = false;
    for (const section of Array.from(feedList.querySelectorAll<HTMLElement>('.diary-day'))) {
      const day = section.dataset['day'] ?? '';
      if (day === '') continue;
      applyDayCollapsed(section, collapsed, labels);
      touched = true;
    }
    if (touched) {
      feedNav?.refresh();
      return;
    }
  }
  renderFeed();
}

/**
 * Секция дня ленты: заголовок-кнопка сворачивания + пустой список записей.
 * Список наполняется отдельным (внутренним) keyed-проходом `renderFeed`.
 */
function buildDaySection(day: string): HTMLElement {
  const section = div('diary-day');
  section.dataset['day'] = day;
  // Заголовок — кнопка: клик сворачивает/разворачивает группу (0.10.1,
  // приёмка №2). Шрифт даты — вдвое крупнее (CSS-токен темы).
  const head = uiButton({
    label: formatDayLabel(day),
    role: 'ghost',
    class: 'diary-day-head',
    onClick: () => toggleDayCollapsed(day),
  });
  head.prepend(svgIcon('chevron-down', 18));
  const list = div('diary-day-list');
  section.append(head, list);
  // Начальное состояние группы — тем же помощником, что и in-place переключение
  // (одна точка правды о классах/атрибутах свёрнутой группы).
  applyDayCollapsed(section, collapsedDays.has(day), dayGroupLabels());
  return section;
}

/** Обновление существующей секции дня при keyed-сверке: свёрнутость на месте. */
function updateDaySection(section: HTMLElement, day: string): void {
  applyDayCollapsed(section, collapsedDays.has(day), dayGroupLabels());
}

// ---------------------------------------------------------------------------
// Record card
// ---------------------------------------------------------------------------

/** Карточка записи ленты. Ключ строки (`data-row-key`) вешает keyed-сверка. */
function buildRecordCard(row: ChronicleRow): HTMLElement {
  const card = div('diary-record');
  // `data-row-key` ставится атрибутом: `dataset['data-row-key']` бросает
  // исключение (имя свойства dataset не может содержать дефис) — ошибка
  // 6 сентября (0.10.1, дефект приёмки).
  card.setAttribute(TABLE_ROW_KEY_ATTR, row.id);
  fillRecordCard(card, row);
  return card;
}

/**
 * Обновление существующей карточки при keyed-сверке: перерисовывается ТОЛЬКО
 * содержимое, сам узел карточки (и его DOM-позиция) сохраняется, поэтому правка
 * одной записи не пересоздаёт соседние карточки и не сбрасывает прокрутку.
 */
function updateRecordCard(card: HTMLElement, row: ChronicleRow): void {
  fillRecordCard(card, row);
}

/** Наполнить карточку содержимым записи (общая сборка и обновление). */
function fillRecordCard(card: HTMLElement, row: ChronicleRow): void {
  // Запись, к которой выполнен переход поиска, подсвечена (T7); при правке
  // класс пересчитывается (запись могла перестать быть целью перехода).
  card.classList.toggle('diary-record-target', row.id === jumpHighlightId);

  // Строка 1: значение даты/периода (клик — диалог «Дата/период»), облачка
  // привязок, кнопка «+ мысль», у правого края «бутерброд» меню записи.
  const head = div('diary-record-head');
  head.append(
    uiButton({
      label: recordDateLabel(row),
      role: 'ghost',
      size: 's',
      class: 'diary-record-date',
      title: 'Период дневниковой записи',
      onClick: () => void editRecordDates(row),
    }),
    buildChipsRow(row),
    uiButton({
      label: '+ мысль',
      role: 'ghost',
      size: 's',
      class: 'diary-chip-add',
      title: 'Добавить мысль',
      onClick: () => void pickAndAttach(row.id),
    }),
    iconButton({
      icon: svgIcon('menu', 16),
      title: 'Действия с дневниковой записью',
      role: 'ghost',
      size: 's',
      class: 'diary-record-actions',
      onClick: (event) => showMenuAt(event.clientX, event.clientY, recordMenuItems(row)),
    }),
  );
  // Строка 2 — заголовок, далее оболочка комментария. `buildRecordBody` кладёт
  // дескриптор оболочки в `recordShells` под этот самый узел карточки.
  card.replaceChildren(head, buildTitleInput(row), buildRecordBody(row, card));
}

/** Подпись даты/периода записи — единый помощник периода дневниковой записи. */
function recordDateLabel(row: ChronicleRow): string {
  return formatRecordPeriod(row.valid_from, row.valid_to, row.use_time === true);
}

/** Инпут заголовка записи: правка по месту с сохранением по blur. */
function buildTitleInput(row: ChronicleRow): HTMLElement {
  const input = fieldInput({ extraClass: 'diary-record-title' });
  input.type = 'text';
  input.value = row.title ?? '';
  input.placeholder = t('diary.titlePlaceholder');
  input.maxLength = 200;
  input.addEventListener('blur', () => {
    const next = input.value.trim();
    if (next === (row.title ?? '')) return;
    void patchRecord(row.id, { title: next || null });
  });
  return input;
}

function recordMenuItems(row: ChronicleRow): MenuItem[] {
  return [
    menuAction(t('chrono.menu.copy'), () => void copyRecord(row.id)),
    MENU_SEPARATOR,
    menuAction(t('actions.delete'), () => void removeRecord(row.id), { danger: true }),
  ];
}

/**
 * Тело записи: единая оболочка комментария (`lib/ui/comment.ts`) в режиме
 * ПРОСМОТРА показывает ПОЛНЫЙ `body_html` записи (0.10.1, приёмка №3) —
 * заголовки, списки, выделения видны целиком, без выжимки `snippet`. Сборка
 * тела вынесена в `./record-body.js` ради поведенческого теста. Двойной клик —
 * правка тем же полем markdown, что в редакторе мысли. Пустая запись тоже даёт
 * кликабельную область и приглашение (0.10.1, приёмка №2).
 *
 * Дескриптор оболочки кладётся в `recordShells` под узел карточки: вход в правку
 * текста по клавиатуре (Enter на элементе «комментарий», требование 165323a7)
 * идёт от DOM-узла, который передаёт контроллер навигации.
 */
function buildRecordBody(row: ChronicleRow, card: HTMLElement): HTMLElement {
  const body = div('diary-record-body');
  const shell = commentShell({ variant: 'plain' });
  renderRecordView(shell, row);
  shell.root.addEventListener('dblclick', () => void openBodyEditor(body, row, shell));
  body.append(shell.root);
  recordShells.set(card, { row, shell, body });
  return body;
}

/**
 * Вход в правку текста записи по клавиатурной навигации (Enter на элементе
 * «комментарий»): карточка → её оболочка комментария (требование 165323a7).
 */
function openCardBodyEditor(card: HTMLElement): void {
  const handle = recordShells.get(card);
  if (handle === undefined) return;
  void openBodyEditor(handle.body, handle.row, handle.shell);
}

/**
 * Вход в диалог «Дата/период» по клавиатурной навигации (Enter на поле
 * «дата/период», требование 165323a7): строка записи берётся из дескриптора
 * карточки, переданной контроллером.
 */
function editCardDates(card: HTMLElement): void {
  const handle = recordShells.get(card);
  if (handle === undefined) return;
  void editRecordDates(handle.row);
}

/** Встроенная правка текста записи (оболочка комментария + поле markdown). */
async function openBodyEditor(
  body: HTMLElement,
  row: ChronicleRow,
  shell: ReturnType<typeof commentShell>,
): Promise<void> {
  // Уже в правке либо поле уже установлено — вложенное поле само откроет
  // правку по двойному клику, повторный запрос не нужен.
  if (shell.root.dataset['mode'] === 'edit' || body.querySelector('.md-field') !== null) return;
  const networkId = requireNetworkId();
  try {
    const comment = await etn.comments.get(networkId, row.id);
    if (!body.isConnected) return;
    // Вставка картинки из буфера (приёмка №10, ошибка 8f090884): цель вложения —
    // первая привязанная мысль записи, иначе HOME (паритет с постоянным
    // комментарием мысли). Владелец не задан — поле просто пропускает файлы.
    const owner = attachmentOwnerForRow(row.targets, homeId);
    const widget = createMarkdownField({
      md: comment.body_md,
      html: comment.body_html,
      placeholder: t('diary.emptyRecordHint'),
      ...(owner !== null ? { attachmentsOwner: owner } : {}),
      onSave: async (md) => {
        const fresh = await etn.comments.get(networkId, row.id);
        const updated = await etn.comments.update(networkId, row.id, { body_md: md }, fresh.version);
        scheduleChronicleRefresh();
        return updated.body_html;
      },
      onEditChange: (editing) => {
        shell.setMode(editing ? 'edit' : 'view');
        // Выход из правки (Esc/клик вне, требование 165323a7) — фокус
        // возвращается в навигацию записи.
        if (!editing) feedNav?.focusNavigation();
      },
    });
    shell.setField(widget);
    shell.setMode('edit');
    editMarkdownField(widget);
  } catch (err) {
    notice(t('diary.loadFailed', [errText(err)]), 'error');
  }
}

/**
 * Правка даты записи диалогом «Дата/период» (0.10.1, приёмка №5/№6). Инлайн-контрол
 * с переключателем режимов упразднён: клик по значению открывает модальный
 * диалог; период разрешён. Время РАЗРЕШЕНО ВСЕГДА (кнопка «С указанием времени» —
 * часть диалога): у записи без `use_time` время стартует скрытым, пользователь
 * включает его кнопкой, вводит значение — «ОК» пишет `use_time: true` и инстансы
 * со временем (путь сохранения — `saveRecordDates`). «ОК» применяет значение,
 * Esc/«Отмена» ничего не меняют.
 */
async function editRecordDates(row: ChronicleRow): Promise<void> {
  const previous = { from: row.valid_from, to: row.valid_to ?? row.valid_from };
  const result = await openDatePeriodDialog({
    allowPeriod: true,
    allowTime: true,
    // Время показано, только когда запись его уже учитывает; иначе — скрыто.
    initial: datePeriodValueFromInstants(
      previous.from,
      previous.to,
      row.use_time === true,
      true,
    ),
  });
  if (result === null) return;
  await saveRecordDates(row.id, result, previous);
}

/**
 * Сохраняет даты записи. Значение диалога переводится ЕГО ЖЕ помощником
 * `resolveDatePeriodInstants` (0.10.1, итерация приёмки №8, п.1): раньше экран
 * повторял ту же конверсию своими строками (`resolvePeriodInstants` +
 * `setInstantTime`), и расхождение двух реализаций не ловилось тестом на
 * диалоге. Теперь источник конверсии один — компонент диалога: смена только
 * даты сохраняет время суток, незаданный конец равен началу (`valid_to` непуст,
 * требование d58aa1a4), при `hasTime` время выставляется с сохранением
 * секунд/миллисекунд (ADR 994d076a). `previous` — исходные инстансы записи.
 */
async function saveRecordDates(
  id: string,
  value: DatePeriodValue,
  previous: { from: string; to: string },
): Promise<void> {
  if (value.from === '') return;
  const { from, to } = resolveDatePeriodInstants(value, previous);
  const networkId = requireNetworkId();
  try {
    const fresh = await etn.comments.get(networkId, id);
    await etn.comments.update(
      networkId,
      id,
      { valid_from: from, valid_to: to, use_time: value.hasTime === true },
      fresh.version,
    );
    scheduleChronicleRefresh();
  } catch (err) {
    notice(t('diary.saveFailed', [errText(err)]), 'error');
  }
}

/** Обновляет поля записи (свежая версия — иначе VERSION_CONFLICT). */
async function patchRecord(id: string, patch: Record<string, unknown>): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const fresh = await etn.comments.get(networkId, id);
    await etn.comments.update(networkId, id, patch, fresh.version);
    scheduleChronicleRefresh();
  } catch (err) {
    notice(t('diary.saveFailed', [errText(err)]), 'error');
  }
}

async function removeRecord(id: string): Promise<void> {
  const ok = await confirmDialog(t('diary.deleteTitle'), t('diary.deleteQuestion'), true);
  if (!ok) return;
  const networkId = requireNetworkId();
  try {
    const fresh = await etn.comments.get(networkId, id);
    await etn.comments.remove(networkId, id, fresh.version);
    await reload();
  } catch (err) {
    notice(t('diary.deleteFailed', [errText(err)]), 'error');
  }
}

/** Копирует запись (привязки + заголовок + текст; даты = сегодня). */
async function copyRecord(id: string): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const source = await etn.comments.get(networkId, id);
    const today = todayLocal();
    // Даты = сегодня + текущее время; голую дату не шлём (ADR 994d076a,
    // требование d58aa1a4 — полные UTC-инстансы, `valid_to` непуст).
    const now = new Date().toISOString();
    const { from, to } = resolvePeriodInstants(
      { from: today, to: today },
      { from: now, to: now },
    );
    await etn.comments.createMulti(networkId, source.targets, {
      kind: 'chronological',
      title: source.title,
      body_md: source.body_md,
      valid_from: from,
      valid_to: to,
      use_time: false,
    });
    await reload();
  } catch (err) {
    notice(t('diary.copyFailed', [errText(err)]), 'error');
  }
}

// ---------------------------------------------------------------------------
// Chips (attachments)
// ---------------------------------------------------------------------------

function buildChipsRow(row: ChronicleRow): HTMLElement {
  const box = div('diary-record-chips');
  repaintChips(box, row);
  return box;
}

function repaintChips(box: HTMLElement, row: ChronicleRow): void {
  box.replaceChildren();
  const chips = visibleChips(row.targets, homeId);
  for (const target of chips) box.append(buildChip(target, row.id));
}

function buildChip(target: ChronicleTarget, rowId: string): HTMLElement {
  const chip = target.kind === 'thought' ? thoughtChip(target.thought) : linkChip(target.link);
  chip.classList.add('diary-chip');
  chip.addEventListener('click', () => {
    if (target.kind === 'thought') void openChronicleThought(target.thought.id);
    else void openChronicleLinkById(target.link.id);
  });
  // Правый клик. Облачко мысли получает общее меню мысли (спецификация
  // «Контекстное меню мысли»; регресс 0.10.1 — правка T6 сняла его вместе с
  // прежним самодельным `showTargetMenu`), а команды записи «Отвязать»/
  // «Связать с…» добавляются блоком опций контекста. У чипа связи — своё
  // короткое меню записи: общее меню мысли к связи неприменимо.
  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (target.kind === 'thought') {
      showThoughtContextMenu(
        event,
        { id: target.thought.id, title: target.thought.title, dir: 'siblings' },
        {
          // Открытие из дневника — в редактор, фокус холста не двигаем.
          openHandler: (id) => void openChronicleThought(id),
          // Рядом с открытием обязателен «В фокус» (спецификация «Контекстное
          // меню мысли»): поставить мысль в фокус и переключить экран на «Карту
          // мыслей». Единый путь — общий `focusThoughtOnMap` (ошибка 562356a9),
          // а не пара «setActiveView + setFocus» копией. Импорт ленивый:
          // active-view статически тянет chronicle — замкнул бы цикл.
          focusHandler: () => {
            void import('../active-view.js').then(({ focusThoughtOnMap }) =>
              focusThoughtOnMap(target.thought.id),
            );
          },
          extraItems: [
            menuAction(t('chrono.menu.detach'), () => void detachChip(rowId, target)),
            menuAction(t('chrono.menu.attach'), () => void pickAndAttach(rowId)),
          ],
        },
      );
      return;
    }
    showDiaryLinkMenu(event, rowId, target);
  });
  chip.append(
    uiButton({
      label: '✕',
      role: 'ghost',
      size: 's',
      class: 'diary-chip-remove',
      title: 'Снять привязку',
      onClick: (event) => {
        event.stopPropagation();
        void detachChip(rowId, target);
      },
    }),
  );
  return chip;
}

/**
 * Мини-меню чипа связи в ленте дневника. Общее меню мысли сюда не подходит
 * (связь — не мысль), но операции контекста записи те же: открыть, отвязать,
 * связать. Пункты собираются словарём `lib/menu.ts` (сторож
 * `guard-canvas-menu-dictionary`).
 */
function showDiaryLinkMenu(event: MouseEvent, rowId: string, target: ChronicleTarget): void {
  if (target.kind !== 'link') return;
  showMenuAt(event.clientX, event.clientY, [
    menuAction(t('chrono.menu.open'), () => void openChronicleLinkById(target.link.id)),
    MENU_SEPARATOR,
    menuAction(t('chrono.menu.detach'), () => void detachChip(rowId, target)),
    menuAction(t('chrono.menu.attach'), () => void pickAndAttach(rowId)),
  ]);
}

async function detachChip(rowId: string, target: ChronicleTarget): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const fresh = await etn.comments.get(networkId, rowId);
    // HOME — служебная первичная привязка, крестика у неё нет (c81964c7).
    const meaningful = fresh.targets.filter(
      (tg) => !(tg.owner_type === 'thought' && tg.owner_id === homeId),
    );
    // Снятие последнего содержательного чипса меняет класс записи на 0 — сервер
    // возвращает её в HOME и поднимает в верхний блок (c81964c7).
    const movesToHome = isLastChip(meaningful);
    if (movesToHome) {
      const ok = await confirmDialog(t('diary.detachTitle'), t('diary.detachQuestion'), true);
      if (!ok) return;
    }
    const ownerType = target.kind === 'thought' ? 'thought' : 'link';
    const ownerId = target.kind === 'thought' ? target.thought.id : target.link.id;
    await etn.comments.removeTarget(networkId, rowId, ownerType, ownerId, fresh.version);
    // Снятие последнего чипса оставляет запись (сервер сам возвращает её в HOME
    // и поднимает в верхний блок) — лента перезагружается целиком.
    await reload();
    // Перемещение записи в другой блок меняет состав верхней части ленты:
    // keyed-сверка держит позицию прокрутки, поэтому перемещённая запись может
    // остаться вне вида. Показываем ленту с начала (ошибка 368747a6).
    if (movesToHome && feedWrap !== null) feedWrap.scrollTop = 0;
  } catch (err) {
    notice(t('diary.detachFailed', [errText(err)]), 'error');
  }
}

async function pickAndAttach(rowId: string): Promise<void> {
  const result = await pickThoughtsDialog({
    networkId: requireNetworkId(),
    allowCreate: false,
    allowLinkType: false,
  });
  if (result === null) return;
  await attachToRecord(rowId, pickedThoughtIds(result));
}

async function attachToRecord(rowId: string, thoughtIds: string[]): Promise<void> {
  const networkId = requireNetworkId();
  if (thoughtIds.length === 0) return;
  try {
    const fresh = await etn.comments.get(networkId, rowId);
    // Первая содержательная привязка выводит запись из HOME-блока вниз (класс
    // записи становится > 0). Сверяемся с РАЗРЕШЁННЫМ HOME: при `homeId === null`
    // HOME-цель не отличить от обычной (ошибка 810520c5, корень 89409d57).
    const home = homeId ?? (await getHome().catch(() => null));
    const firstBinding =
      home !== null &&
      !fresh.targets.some((tg) => tg.owner_type === 'thought' && tg.owner_id !== home);
    let version = fresh.version;
    let attached = 0;
    for (const id of thoughtIds) {
      if (fresh.targets.some((tg) => tg.owner_type === 'thought' && tg.owner_id === id)) continue;
      const updated = await etn.comments.addTarget(networkId, rowId, 'thought', id, version);
      version = updated.version;
      attached++;
    }
    if (attached === 0) notice(t('diary.alreadyAttached'), 'info');
    await reload();
    // Перемещённая вниз запись должна быть видна: прокручиваем к её карточке, а
    // если день записи ниже загруженной страницы — показываем ленту с начала
    // (ошибка 810520c5, симметрично 368747a6).
    if (firstBinding) revealRecord(rowId);
  } catch (err) {
    notice(t('diary.attachFailed', [errText(err)]), 'error');
  }
}

// ---------------------------------------------------------------------------
// Pseudo-record (slot)
// ---------------------------------------------------------------------------

/**
 * Creates a pseudo-record slot: an empty card that writes nothing to the
 * network until the first content (title/text/binding) — requirement 26f0aa52.
 */
function startSlot(day?: string, presetThoughtIds: string[] = []): void {
  if (host === null) return;
  if (slot !== null && presetThoughtIds.length === 0) {
    slot.titleInput.focus();
    return;
  }
  const filter = getFilterState();
  const targetDay =
    day ??
    clampPseudoDate(
      todayLocal(),
      resolvePeriodDay(filter.dateFrom),
      resolvePeriodDay(filter.dateTo),
    );

  const root = div('diary-record diary-slot');
  const head = div('diary-record-head');
  const titleInput = fieldInput({ extraClass: 'diary-record-title' });
  titleInput.type = 'text';
  titleInput.placeholder = t('diary.titlePlaceholder');
  titleInput.maxLength = 200;
  head.append(
    el('span', 'diary-record-date', fmtDate(targetDay)),
    titleInput,
    uiButton({
      label: '✕',
      role: 'ghost',
      size: 's',
      class: 'diary-slot-cancel',
      title: t('diary.slotCancel'),
      onClick: () => cancelSlot(),
    }),
  );

  const chipsBox = div('diary-record-chips');
  chipsBox.append(
    uiButton({
      label: '+ мысль',
      role: 'ghost',
      size: 's',
      class: 'diary-chip-add',
      title: 'Добавить мысль',
      onClick: () => void addSlotChip(),
    }),
  );
  const body = div('diary-record-body');
  // Псевдо-запись — тоже через единую оболочку комментария (0.10.1, приёмка
  // №2); пустое тело даёт область двойного клика для входа в правку.
  const slotShell = commentShell({ variant: 'plain' });
  // Вставка картинки из буфера в псевдо-записи (приёмка №10): пока чипсов нет,
  // цель вложения — первая заданная мысль (drop) либо HOME.
  const slotOwnerId = presetThoughtIds[0] ?? homeId;
  const widget = createMarkdownField({
    md: '',
    html: '',
    placeholder: t('diary.emptyRecordHint'),
    ...(slotOwnerId !== null
      ? { attachmentsOwner: { ownerType: 'thought' as const, ownerId: slotOwnerId } }
      : {}),
    onSave: async (md) => {
      const created = await ensureSlot({ body: md });
      return created?.body_html ?? md;
    },
    onEditChange: (editing) => slotShell.setMode(editing ? 'edit' : 'view'),
  });
  slotShell.setField(widget);
  slotShell.setState({ kind: 'ready' });
  body.append(slotShell.root);

  root.append(head, chipsBox, body);
  const state: SlotState = {
    day: targetDay,
    commentId: null,
    root,
    titleInput,
    from: targetDay,
  };
  slot = state;

  titleInput.addEventListener('blur', () => void ensureSlot({}));

  async function addSlotChip(): Promise<void> {
    const result = await pickThoughtsDialog({
      networkId: requireNetworkId(),
      allowCreate: false,
      allowLinkType: false,
    });
    if (result === null) return;
    const ids = pickedThoughtIds(result);
    if (ids.length === 0) return;
    await ensureSlot({ extraThoughtIds: ids });
  }

  renderFeed();
  titleInput.focus();

  // Preset bindings (drop on the feed / empty space) create the record at once.
  if (presetThoughtIds.length > 0) void ensureSlot({ extraThoughtIds: presetThoughtIds });
}

/** Отменяет пустой слот: без id — только в клиенте, без сети (требование 26f0aa52). */
function cancelSlot(): void {
  if (slot === null) return;
  if (slotDeleteNeedsNetwork(slot.commentId)) {
    void removeRecord(slot.commentId!);
    return;
  }
  slot = null;
  renderFeed();
}

/**
 * First content creates the record (owner HOME, date = pseudo date). Until then
 * nothing is written. Returns the created/updated comment (or null when empty).
 */
async function ensureSlot(opts: {
  title?: string | null;
  body?: string;
  extraThoughtIds?: string[];
}): Promise<Comment | null> {
  const state = slot;
  if (state === null) return null;
  const networkId = requireNetworkId();
  const title = opts.title !== undefined ? (opts.title ?? '') : state.titleInput.value;
  const body = opts.body ?? '';
  const extra = opts.extraThoughtIds ?? [];
  if (!hasRecordContent({ title, body, bindings: extra.length })) return null;
  try {
    const home = await getHome();
    const targets: CommentTarget[] = [{ owner_type: 'thought', owner_id: home }];
    for (const id of extra) {
      if (id !== home) targets.push({ owner_type: 'thought', owner_id: id });
    }
    // Содержание записи держится на любом из: текст, заголовок, чипс
    // (требование 26f0aa52). Сервер допускает пустой `body_md`, пока есть
    // непустой заголовок или привязка вне HOME, поэтому текст шлём как есть.
    //
    // Дата записи — псевдо-день + текущее время суток (ADR 994d076a: «при
    // создании — указанная дата + текущее время»). Голую дату не шлём: она
    // теряет время суток, а `valid_to` обязан быть непустым (d58aa1a4).
    const now = new Date().toISOString();
    const { from: validFrom, to: validTo } = resolvePeriodInstants(
      { from: state.from, to: state.from },
      { from: now, to: now },
    );
    const created = await etn.comments.createMulti(networkId, targets, {
      kind: 'chronological',
      title: title.trim() || null,
      body_md: body,
      valid_from: validFrom,
      valid_to: validTo,
      use_time: false,
    });
    // Спокойная лента (0.10.1, итерация приёмки №8, п.2): слот превращается в
    // карточку записи НА МЕСТЕ, без полной перерисовки ленты и перескока
    // скролла. Если локальную строку собрать не удалось (нестандартные цели) —
    // откат на полную перезагрузку ради точности данных.
    const localRow = await localRowFromComment(created, home);
    if (localRow !== null) {
      await insertCreatedRecord(localRow);
      syncCalendar();
      void refreshCalendarCounts();
    } else {
      slot = null;
      state.root.remove();
      await reload();
      syncCalendar();
    }
    return created;
  } catch (err) {
    notice(t('diary.createFailed', [errText(err)]), 'error');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Calendar wiring
// ---------------------------------------------------------------------------

/**
 * Клик календаря = «Применить» с новым периодом (остальные критерии целы).
 * Период пишется в поля панели С УЧЁТОМ режима (приёмка №2, 0.10.1): в
 * «Пресетах» шаблон (день=сегодня, неделя/месяц/год, иначе день-арифметика)
 * распознаётся в токены, в «Датах» — точные даты (правило
 * `periodValuesForRange`).
 */
async function pickPeriod(period: { from: string; to: string }): Promise<void> {
  const mode = getFilterState().dateMode;
  const next = periodValuesForRange(period.from, period.to, todayLocal(), mode);
  setFilterState(applyPeriodToFilter(getFilterState(), next));
  persistState();
  await applyFilter();
}

/** Кнопка «Сегодня»: показать текущий месяц и выделить текущую дату. */
function goToday(): void {
  const today = todayLocal();
  month = null;
  calendar?.showDate(today);
  void pickPeriod(dayPeriod(today));
}

/** Согласовать выделение календаря с полями периода (поля — источник дат). */
function syncCalendar(): void {
  if (calendar === null) return;
  const filter = getFilterState();
  calendar.setSelection(resolvePeriodDay(filter.dateFrom), resolvePeriodDay(filter.dateTo));
  month = calendar.getMonth();
}

/**
 * Показать ДЕНЬ ЗАПИСИ в календаре при переходе к записи (0.10.1, ошибка
 * ecd91c1d): пункт «Открыть в дневнике» обязан «установить в календаре дату из
 * записи» (чек-лист задачи 8012a9b0, п.2) — то есть сменить ОТОБРАЖАЕМЫЙ месяц,
 * а не только выделение. Без этого календарь оставался на месяце, сохранённом
 * в состоянии вкладки, и дня записи в его сетке нет: ни отметки, ни выделения,
 * а отметки записей — по не относящемуся к записи месяцу. `showDate` уведомляет
 * `onMonthChange`: месяц персистится, счётчики дней пересчитываются для нового
 * месяца; следом `syncCalendar` проставляет выделение дня.
 */
function showRecordDayInCalendar(day: string): void {
  if (calendar === null || day === '') return;
  calendar.showDate(day);
  syncCalendar();
}

/**
 * Счётчики записей по дням ОТОБРАЖАЕМОГО месяца (0.10.1, элемент 55b07702):
 * отдельный запрос по границам месяца с текущими критериями, БЕЗ периода —
 * поэтому счётчик виден и на выделенной, и на невыделенной дате. Числа дней
 * считаются тем же разбором длительности записи, что и лента (`rowDays`).
 */
async function refreshCalendarCounts(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || calendar === null) return;
  const { year, month: monthNo } = calendar.getMonth();
  const first = `${year}-${pad2(monthNo)}-01`;
  const last = new Date(Date.UTC(year, monthNo, 0)).toISOString().slice(0, 10);
  const def = chronicleDefinition();
  const tally = new Map<string, number>();
  try {
    let offset = 0;
    for (let page = 0; page < CAL_COUNTS_MAX_PAGES; page += 1) {
      const res = await etn.chronicle.query(networkId, {
        ...def,
        // Границы месяца — ЛОКАЛЬНЫЕ сутки (как и период ленты): «голая дата» на
        // сервере = сутки UTC (469d8d69) и запись у локальной полуночи первого/1-го
        // числа выпадала бы из счётчиков месяца (приёмка №4, задача fd9eef49).
        date_from: localDayStart(first),
        date_to: localDayEnd(last),
        limit: CHRONICLE_QUERY_MAX_LIMIT,
        offset,
      });
      for (const row of res.rows) {
        for (const day of rowDays(row, first, last)) tally.set(day, (tally.get(day) ?? 0) + 1);
      }
      offset += res.rows.length;
      if (res.rows.length === 0 || offset >= res.total) break;
    }
  } catch {
    return; // сеть недоступна — оставляем прежние счётчики
  }
  dayCounts.clear();
  for (const [day, count] of tally) dayCounts.set(day, count);
  const filter = getFilterState();
  calendar.setSelection(resolvePeriodDay(filter.dateFrom), resolvePeriodDay(filter.dateTo));
}

/** Двузначная запись числа. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Поиск дневниковых записей и переход к записи (0.10.1, задача 46057359)
// ---------------------------------------------------------------------------

/**
 * Живой поиск записей строкой (задача 46057359): только хроно-записи, критерий
 * — мини-синтаксис keywords (как у строки поиска карты). Период и прочие
 * критерии панели не применяются: строка ищет по всей сети, иначе запись вне
 * текущего периода не нашлась бы. Настройки «неактивные мысли»/«корзина» —
 * клиентский отбор результатов (компонент `lib/record-search.ts`).
 */
async function searchRecords(query: string): Promise<ChronicleRow[]> {
  const networkId = store.state.networkId;
  if (networkId === null) return [];
  const result = await etn.chronicle.query(networkId, {
    keywords: query,
    // Область поиска — все три явно: строка ищет записи и по их собственному
    // тексту/заголовку (область `comment`), независимо от флагов панели отбора
    // (0.10.1, задача 46057359). Без `comment` сервер не ищет по тексту записи.
    keyword_scope: [...STRUCTURE_KEYWORD_SCOPES],
    order: 'desc',
    limit: RECORD_SEARCH_MAX_RESULTS,
    offset: 0,
  });
  return result.rows;
}

/** Настройки строки поиска записей из L4 `ui_state` (0.10.1, задача 46057359). */
async function loadRecordSearchSettings(): Promise<RecordSearchSettings | null> {
  const networkId = store.state.networkId;
  if (networkId === null) return null;
  const raw = await etn.ui.getState(networkId, UI_STATE_KEY.RECORD_SEARCH).catch(() => null);
  if (raw === null) return null;
  try {
    return parseRecordSearchSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Сохранить настройки строки поиска записей в L4 `ui_state`. */
function persistRecordSearchSettings(settings: RecordSearchSettings): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  void etn.ui
    .setState(networkId, UI_STATE_KEY.RECORD_SEARCH, serializeRecordSearchSettings(settings))
    .catch(() => undefined);
}

/**
 * Прокручивает ленту к записи, делает её текущей и подсвечивает карточку.
 * Текущей запись делает контроллер навигации (`selectRecord`): выделение
 * переприменяется после перерисовки ленты (`feedNav.refresh`, требование 4).
 */
function focusRecord(id: string, day: string): void {
  jumpHighlightId = id;
  feedNav?.selectRecord(id, day);
  renderFeed();
  const card = feedList?.querySelector<HTMLElement>(`[${TABLE_ROW_KEY_ATTR}="${id}"]`);
  card?.scrollIntoView({ block: 'center' });
}

/**
 * Показывает запись после её перемещения между блоками ленты: прокручивает к
 * карточке записи, а если карточки в загруженной странице нет (день записи ниже
 * текущей позиции) — показывает ленту с начала. Keyed-сверка сохраняет позицию
 * прокрутки, поэтому перемещённая запись иначе остаётся вне вида (ошибка
 * 810520c5, симметрично 368747a6).
 */
function revealRecord(id: string): void {
  const card = feedList?.querySelector<HTMLElement>(`[${TABLE_ROW_KEY_ATTR}="${id}"]`);
  if (card !== null && card !== undefined) {
    card.scrollIntoView({ block: 'center' });
    return;
  }
  if (feedWrap !== null) feedWrap.scrollTop = 0;
}

/** Догружает страницы ленты, пока запись не появится (она внутри периода). */
async function loadUntilRecord(id: string): Promise<boolean> {
  while (!rows.some((r) => r.id === id) && rows.length < total) {
    const before = rows.length;
    await loadMore();
    if (rows.length === before) break; // догрузка не продвинулась — не крутимся
  }
  return rows.some((r) => r.id === id);
}

/**
 * Переход к найденной записи (0.10.1, задача 46057359): период панели ← ДАТА
 * НАЧАЛА записи (её локальные сутки), программное «Применить», прокрутка ленты
 * и подсветка записи. Если запись не проходит текущий отбор (кроме периода) —
 * отбор СБРАСЫВАЕТСЯ, период остаётся датой начала записи; временной выборки с
 * плашкой больше нет (решение пользователя 2026-09-27).
 */
async function jumpToRecord(row: ChronicleRecordRef): Promise<void> {
  const startDay = localDay(row.valid_from);
  if (startDay === '') return;
  // Поля периода панели обязаны ПОКАЗЫВАТЬ дату начала записи (DoD 4, доработка
  // приёмки): значение пишется через mode-конвертер `periodValuesForRange` — как
  // в клике по календарю (`pickPeriod`). Сырые инстансы `localDayStart/End`
  // period-editor в режиме «Пресеты» не отображает (показывал «сегодня»).
  // «Пресеты» → токен `$today±Nd`, «Даты» → точная дата; раскрытие в ЛОКАЛЬНЫЕ
  // сутки наблюдателя делает запрос (`chronicleQueryDefinition` →
  // `resolvePeriodForQuery`), поэтому запись у полуночи не выпадает (ADR 994d076a).
  const mode = getFilterState().dateMode;
  const values = periodValuesForRange(startDay, startDay, todayLocal(), mode);
  jumpHighlightId = null;
  // 1) Дата начала записи, прочие критерии отбора сохраняются.
  setFilterState(applyPeriodToFilter(getFilterState(), values));
  persistState();
  await getHome().catch(() => undefined);
  await reload();
  // Календарь — на месяц записи (чек-лист 8012a9b0, п.2), иначе дня записи в
  // его сетке нет и переход выглядит как «отметок нет» (ошибка ecd91c1d).
  showRecordDayInCalendar(startDay);
  if (await loadUntilRecord(row.id)) {
    focusRecord(row.id, startDay);
    return;
  }
  // 2) Запись не проходит отбор — сброс отбора, дата начала записи остаётся.
  const fresh = defaultChronicleCriteriaState();
  fresh.dateMode = mode;
  fresh.dateFrom = values.from;
  fresh.dateTo = values.to;
  setFilterState(fresh);
  setSavedFilterId(null);
  persistState();
  await reload();
  showRecordDayInCalendar(startDay);
  await loadUntilRecord(row.id);
  focusRecord(row.id, startDay);
}

/** Минимальная ссылка на дневниковую запись для перехода к ней. */
export interface ChronicleRecordRef {
  id: string;
  valid_from: string;
  valid_to: string | null;
}

/**
 * Открыть экран «Дневник» на конкретной записи (0.10.1, задача 8012a9b0):
 * переключить вид, установить в календаре дату записи и сделать запись текущей
 * в ленте. Единый вход для пункта меню строки вкладки «Дневник» редактора —
 * механика перехода одна (`jumpToRecord`), второй копии нет.
 */
export async function openChronicleRecord(record: ChronicleRecordRef): Promise<void> {
  // Ленивый импорт: статический замкнул бы цикл active-view → chronicle.
  const { setActiveView } = await import('../active-view.js');
  setActiveView('chronicle');
  await ensureChronicleInitialised();
  await jumpToRecord(record);
}

// ---------------------------------------------------------------------------
// Chips rendering helpers
// ---------------------------------------------------------------------------

/** A styled thought chip (icon + title), shared with the editor area. */
export function thoughtChip(ref: ThoughtRef): HTMLElement {
  const chip = createThoughtCloud(ref, { profile: 'chip' });
  chip.classList.add('chron-chip', 'thought');
  markThoughtCommentPreview(chip, ref.id, ref.title);
  return chip;
}

/** A link chip «source — type — target». */
function linkChip(link: ChronicleTargetLink): HTMLElement {
  const chip = el('span', 'chron-chip link');
  const sourceTitle = link.source.title;
  const targetTitle = link.target.title;
  chip.append(
    span('🔗', 'chip-icon'),
    span(sourceTitle, 'chip-title'),
    span(
      link.type_name_forward === null ? ' — ' : ` — ${link.type_name_forward} — `,
      'chip-type muted',
    ),
    span(targetTitle, 'chip-title'),
  );
  chip.title =
    link.type_name_forward === null
      ? `${sourceTitle} — ${targetTitle}`
      : `${sourceTitle} — ${link.type_name_forward} — ${targetTitle}`;
  markCommentPreview(chip, 'link', link.id, chip.title);
  return chip;
}

// ---------------------------------------------------------------------------
// Opening entities from the diary view (editor + history)
// ---------------------------------------------------------------------------

export async function openChronicleThought(id: string): Promise<void> {
  const networkId = requireNetworkId();
  const thought = await etn.thoughts.get(networkId, id);
  await setThoughtEditorTarget(thought);
}

export async function openChronicleLink(link: Link): Promise<void> {
  openLinkInEditor(link);
}

export async function openChronicleLinkById(id: string): Promise<void> {
  const link = await etn.links.get(requireNetworkId(), id);
  await openChronicleLink(link);
}

// ---------------------------------------------------------------------------
// HOME thought
// ---------------------------------------------------------------------------

async function getHome(): Promise<string> {
  if (homeId !== null) return homeId;
  if (homePromise === null) {
    homePromise = findRootThought(requireNetworkId())
      .then((root) => {
        homeId = root.id;
        return root.id;
      })
      .catch((err: unknown) => {
        // Сбой разрешения HOME не кэшируем навсегда: сбрасываем промис, чтобы
        // следующее обращение сделало новую попытку, а не осталось в fallback до
        // перезагрузки экрана (ошибка 810520c5).
        homePromise = null;
        throw err;
      });
  }
  return homePromise;
}
