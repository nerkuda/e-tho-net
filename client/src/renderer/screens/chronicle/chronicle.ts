/**
 * Вид «Дневник» (рабочий стол) — 0.10.1, задача T6 64ca2b48.
 *
 * Экран (L20, был «Хроника»): в левой панели отбора первым элементом идёт
 * календарь месяца (0.10.1, элементы 9b424548/55b07702), в центре —
 * непрокручиваемая панель с кнопкой «Добавить запись дневника» и ниже лента
 * дневниковых записей, сгруппированная по локальным дням наблюдателя; панель
 * отбора — общий каркас `lib/filter-form.ts` (состав — набор «Структур»).
 *
 * Ключевые поведения заданы элементами спеки и требованиями:
 *  * «Вид «Дневник» (рабочий стол)» 9b424548 — компоновка;
 *  * «Календарь месяца в «Дневнике»» 55b07702 — клик по дате/неделе = «Применить»
 *    с новым периодом, остальные критерии не трогаются, лента перезагружается;
 *  * «Лента дневных записей» e01f383a — группировка по дням, дозагрузка «+50»,
 *    чипсы привязок с «+»/«✕», правка по месту;
 *  * «Sticky-панель новой записи» a2b993d7 + требование 26f0aa52 — «Добавить»
 *    сразу создаёт нормальную хроно-запись (дата + привязка, без содержания);
 *    псевдозаписи/слота нет (ТП «Дневник без псевдослота»);
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
import {
  cancelMarkdownFieldEdit,
  commitMarkdownField,
  createMarkdownField,
  editMarkdownField,
  focusMarkdownFieldStart,
} from '../../editor/markdown-field.js';
import { confirmDialog } from '../../lib/dialog.js';
import { div, el, errText, span } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { mountFilterPanelFrame } from '../../lib/filter-panel-frame.js';
import { markCommentPreview, markThoughtCommentPreview } from '../../lib/hover-preview.js';
import { svgIcon } from '../../lib/ui/icon.js';
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
import { operationError } from '../../lib/ui/messages.js';
import { reconcileKeyed } from '../../lib/ui/keyed-list.js';
import { splitterElement } from '../../lib/ui/splitter.js';
import { TABLE_ROW_KEY_ATTR } from '../../lib/ui/table.js';
import { shouldLoadMore, type ZonePagingCounters } from '../../lib/zone-paging.js';
import { store } from '../../state.js';
import { t } from '../../lib/i18n.js';
import { parseChronicleCriteria, defaultChronicleCriteriaState } from '../../lib/filter-builder.js';
import { matchesKeyPrefix, queryKeys } from '../../lib/live/query-keys.js';
import {
  invalidateQueries,
  onQueryInvalidated,
  registerQuery,
  setQueryData,
} from '../../lib/live/query-registry.js';
import { buildMonthCalendar, type MonthCalendarHandle } from '../../lib/month-calendar.js';
import {
  applyPeriodToFilter,
  attachmentOwnerForRow,
  clampPseudoDate,
  collectRowsToDepth,
  dayPeriod,
  formatDayLabel,
  groupByLocalDays,
  hasRowId,
  insertRowByDay,
  isLastChip,
  isWeekend,
  localDay,
  localDayEnd,
  localDayStart,
  parentThoughtIds,
  periodValuesForRange,
  resolvePeriodDay,
  rowDays,
  todayLocal,
  visibleChips,
  weekPeriod,
} from './diary.js';
import { recordDisplayTitle, recordTitleFromBody } from '../../lib/record-title.js';
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
import {
  applyRecordCollapsed,
  applyRecordCollapsedForDay,
  dayOfCard,
  findRecordCard,
  recordCollapseKey,
  type RecordGroupLabels,
} from './record-groups.js';
import { type RecordTitleHandle } from './record-title.js';
import { buildRecordHead } from './record-head.js';
import { parseChronicleState } from './state.js';
import { renderRecordView } from './record-body.js';
import { htmlHasTransclusionMarkup } from '../../editor/transclusion.js';

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
/**
 * Id of the HOME (root) thought — primary owner of a day record.
 *
 * HOME — идентификатор, разрешаемый ПО СЕТИ, поэтому его кэш привязан к сети
 * (`homeNetworkId`); при смене сети он недействителен (ошибка ab4e499f).
 * Смена сети/вкладки сбрасывает кэш в `ensureChronicleInitialised` вместе с
 * остальным состоянием вида; `homeNetworkId` дополнительно закрывает гонку,
 * когда промис прежней сети завершается уже после смены (см. `getHome`).
 */
let homeId: string | null = null;
let homeNetworkId: string | null = null;
let homePromise: Promise<string> | null = null;
/** Stable scroll container of the feed (`.chron-table-wrap`). */
let feedWrap: HTMLElement | null = null;
/** Stable list element re-rendered inside the container (never rebuilt). */
let feedList: HTMLElement | null = null;
/** Контроллер клавиатурной навигации ленты (0.10.1, приёмка №9). */
let feedNav: FeedNavHandle | null = null;
/**
 * Единый контроллер правки карточки записи (ТП «Дневник без псевдослота»):
 * режим правки принадлежит КАРТОЧКЕ — вход в правку любого поля (заголовок или
 * тело) открывает ОБА поля, выход идёт едиными жестами (Ctrl+Enter/«Записать»/
 * клик вне — запись обоих одним PATCH; Esc/«Отменить» — откат обоих). Вход в
 * правку по навигации идёт от DOM-узла карточки (требование 165323a7).
 */
interface CardEditor {
  readonly row: ChronicleRow;
  /** Идёт ли единая правка карточки сейчас. */
  editing(): boolean;
  /** Войти в правку с фокусом в заголовке. */
  openTitle(): void;
  /** Войти в правку с фокусом в теле. */
  openBody(): void;
}

const cardEditors = new WeakMap<HTMLElement, CardEditor>();
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

/** Свёрнутые группы дат ленты (0.10.1, приёмка №2); состояние — L4 `ui_state`. */
const collapsedDays = new Set<string>();

let collapsedDaysLoaded = false;

/**
 * Свёрнутые ТЕЛА записей ленты (0.10.2, задача 41ed99ab): ключи вхождений
 * {@link recordCollapseKey} «день + id». Единица свёрнутости — вхождение, а не
 * запись; состояние — L4 `ui_state` рядом с `diary_collapsed_days`.
 */
const collapsedRecords = new Set<string>();

let collapsedRecordsLoaded = false;

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

/** Загрузить свёрнутые тела записей из клиентских настроек экрана (L4). */
async function loadCollapsedRecords(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || collapsedRecordsLoaded) return;
  collapsedRecordsLoaded = true;
  try {
    const raw = await etn.ui.getState(networkId, UI_STATE_KEY.DIARY_COLLAPSED_RECORDS);
    collapsedRecords.clear();
    if (raw !== null && raw !== '') {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const key of parsed) if (typeof key === 'string') collapsedRecords.add(key);
      }
    }
  } catch {
    // Настройка недоступна — считаем, что всё развёрнуто.
  }
}

/** Сохранить свёрнутые тела записей в клиентские настройки экрана (L4). */
function persistCollapsedRecords(): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  void etn.ui
    .setState(
      networkId,
      UI_STATE_KEY.DIARY_COLLAPSED_RECORDS,
      JSON.stringify([...collapsedRecords]),
    )
    .catch(() => undefined);
}

/** Переключить свёрнутость группы даты (0.10.1, приёмка №2). */
function toggleDayCollapsed(day: string): void {
  setDayCollapsed(day, !collapsedDays.has(day));
}

/** Переключить свёрнутость тела записи (0.10.2, задача 41ed99ab). */
function toggleRecordCollapsed(day: string, id: string): void {
  setRecordCollapsed(day, id, !collapsedRecords.has(recordCollapseKey(day, id)));
}

/** Подписи заголовка группы дат из словаря (для in-place переключения). */
function dayGroupLabels(): DayGroupLabels {
  return { expand: t('listActions.expand'), collapse: t('listActions.collapse') };
}

/** Подписи заголовка записи из словаря (для in-place переключения). */
function recordGroupLabels(): RecordGroupLabels {
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

/**
 * Привести свёрнутость тела записи к состоянию (0.10.2, задача 41ed99ab):
 * единая точка для клика по заголовку и для клавиатуры (←/→). Запись
 * переключается НА МЕСТЕ (`applyRecordCollapsed`) — фокус на заголовке и
 * позиция прокрутки сохраняются. Фокус после переключения возвращает
 * контроллер навигации. Пока заголовок правится, сворачивание недоступно.
 */
function setRecordCollapsed(day: string, id: string, collapsed: boolean): void {
  const key = recordCollapseKey(day, id);
  if (collapsedRecords.has(key) === collapsed) return;
  if (collapsed) collapsedRecords.add(key);
  else collapsedRecords.delete(key);
  persistCollapsedRecords();
  if (feedList === null) return;
  const card = findRecordCard(feedList, day, id);
  if (card === null) {
    renderFeed();
    return;
  }
  applyRecordCollapsed(card, collapsed, recordGroupLabels());
}

/**
 * Свернуть/развернуть записи ОДНОГО дня (контекстное меню группы дня, 0.10.2,
 * задача 41ed99ab). Обе команды доступны всегда. «Развернуть записи дня»
 * разворачивает и сам день — иначе эффект не виден. Переключение — на месте.
 */
function setDayRecordsCollapsed(day: string, collapsed: boolean): void {
  const { from, to } = currentFromTo();
  const group = groupByLocalDays(rows, { from, to }).find((d) => d.day === day);
  if (group !== undefined) {
    for (const row of group.rows) {
      const key = recordCollapseKey(day, row.id);
      if (collapsed) collapsedRecords.add(key);
      else collapsedRecords.delete(key);
    }
  }
  persistCollapsedRecords();
  // «Развернуть записи дня» возвращает и сам день — иначе эффект не виден.
  if (!collapsed && collapsedDays.has(day)) setDayCollapsed(day, false);
  const section = feedList !== null ? findDaySection(feedList, day) : null;
  if (section !== null) {
    const labels = recordGroupLabels();
    for (const card of Array.from(section.querySelectorAll<HTMLElement>('.diary-record'))) {
      const id = card.getAttribute(TABLE_ROW_KEY_ATTR) ?? '';
      if (id === '') continue;
      // Ключ собираем и с карточки DOM: дозагруженная строка могла ещё не
      // попасть в `rows` (та же природа, что у «Свернуть все»).
      if (collapsed) collapsedRecords.add(recordCollapseKey(day, id));
      applyRecordCollapsed(card, collapsedRecords.has(recordCollapseKey(day, id)), labels);
    }
    persistCollapsedRecords();
  }
  feedNav?.refresh();
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
  month = null;
  fullRefreshPending = false;
  collapsedDaysLoaded = false;
  collapsedDays.clear();
  collapsedRecordsLoaded = false;
  collapsedRecords.clear();
  // Подсветка перехода — состояние текущего входа, не персистится.
  jumpHighlightId = null;
  recordSearch?.hide();
  // Кэш HOME — тоже состояние сети: без сброса в сети, открытой не первой,
  // первичная привязка новой записи уходила бы с HOME прежней сети и сервер
  // отвечал `thought … not found` (ошибка ab4e499f).
  homeId = null;
  homeNetworkId = null;
  homePromise = null;

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
  await loadCollapsedRecords();
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

/** Builds and mounts the whole diary view into its host. Returns a teardown
 *  handle that releases the store subscription and the feed navigator
 *  (ошибка 37b713de). */
export function mountChronicle(hostEl: HTMLElement): () => void {
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
      onClick: () => void addRecord(),
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
    onSetRecordCollapsed: (day, id, collapsed) => setRecordCollapsed(day, id, collapsed),
    onEditTitle: (_id, card) => cardEditors.get(card)?.openTitle(),
    onEditBody: (_id, card) => cardEditors.get(card)?.openBody(),
    onEditDates: (_id, card) => {
      const editor = cardEditors.get(card);
      if (editor !== undefined) void editRecordDates(editor.row);
    },
    onAddThought: (id) => void pickAndAttach(id),
  });

  main.append(addBar, feedWrap);
  void refreshCalendarCounts();

  // Лента — запрос слоя: подписка на инвалидации ключа `chronicle-feed` (G3).
  bindChronicleFeed();

  wireChronicleApplyShortcut(hostEl);
  registerDropActions({
    chronicleAttach: (thoughtId, rowId) => void attachToRecord(rowId, [thoughtId]),
    chronicleNewEntry: (thoughtId) => void addRecord([thoughtId]),
    chronicleFilterAdd: (thoughtId) => addThoughtToFilter(thoughtId),
  });

  const unsubscribe = store.subscribe(() => {
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
    // Показ скрытого вида снимает отложенную пометку одним перезапросом
    // (ошибка 8e702d8c) — событий копилось сколько угодно, запрос один.
    if (store.state.activeView === 'chronicle' && fullRefreshPending) {
      fullRefreshPending = false;
      void refreshFeedAndCalendar();
    }
  });

  return () => {
    unsubscribe();
    feedNav?.destroy();
    feedNav = null;
    host = null;
  };
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

/**
 * Re-fetches the feed (used after edits and real-time events).
 *
 * `preserveDepth` — перезапрос до УЖЕ загруженной глубины (`rows.length`):
 * refresh текущего вида не должен терять дозагруженные «+50» страницы (ошибка
 * f5809943 — завершение правки записи сбрасывало прокрутку в начало). Страницы
 * собираются {@link collectRowsToDepth} ДО единственной перерисовки. Смена
 * отбора/периода идёт без флага: лента показывается с первой страницы (это
 * ожидаемое поведение, `applyFilter`/`jumpToRecord`).
 */
async function reload(preserveDepth = false): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || feedList === null) return;
  // Отбор — часть ключа запроса слоя: смена критериев/периода переносит снимок
  // на новый ключ (инвалидации роутера адресуют актуальный ключ).
  retargetChronicleFeed();
  const seq = ++querySeq;
  renderStatus('loading');
  try {
    const def = chronicleQueryDefinition();
    const result = await collectRowsToDepth(
      preserveDepth ? rows.length : CHRONICLE_PAGE_SIZE,
      CHRONICLE_PAGE_SIZE,
      (offset, limit) => etn.chronicle.query(networkId, { ...def, limit, offset }),
    );
    if (seq !== querySeq) return;
    rows = result.rows;
    total = result.total;
    pendingReconcile = false;
    renderFeed();
    publishChronicleSnapshot();
  } catch (err) {
    if (seq !== querySeq) return;
    renderStatus('error', err);
  }
}

/**
 * Refresh ТЕКУЩЕГО вида с сохранением уже загруженной глубины ленты — единая
 * точка для всех локальных refresh-путей (0.10.2, ошибка f5809943 и её
 * продолжение b72e199e): правка/удаление записи и локальная вставка не должны
 * терять дозагруженные «+50» страницы. Смена отбора/периода идёт через
 * {@link reload} без флага — лента показывается с первой страницы.
 */
async function reloadKeepingDepth(): Promise<void> {
  await reload(true);
}

/** Fetches the next «+50» page and appends it (scroll pagination). */
async function loadMore(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || loadingMore || rows.length >= total) return;
  // После локальной вставки offset-страница сдвинулась бы: подтягиваем первую
  // страницу заново (данные важнее экономии запроса); прокрутку держит renderFeed.
  // Глубину сохраняем — иначе перезапрос усекает ленту до одной страницы и
  // клампит прокрутку (тот же класс, что f5809943).
  if (pendingReconcile) {
    await reloadKeepingDepth();
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
    publishChronicleSnapshot();
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

// ---------------------------------------------------------------------------
// Лента «Дневника» на слое данных (G3 тех.проекта 269016e2)
// ---------------------------------------------------------------------------
//
// Лента — производный запрос слоя под ключом `chronicle-feed:@<filter>`. На
// чужие изменения (комментарии/мысли/связи/типы/предпочтения) ключ гасит
// роутер (`event-router.ts`), на локальные мутации — их же инвалидация
// (`invalidateQueries`, mutator-путь). Экран применяет ОДИН путь — отложенный
// полный перезапрос ленты ДО уже загруженной глубины (окно дебаунса 250 мс
// сохранено, ошибка f5809943), после чего публикует снимок в кэш слоя.
// Прежний bespoke-инкремент (`realtime-apply.ts`, `applyChronicleRealtime`,
// `applyChronicleOps`, `invalidateChronicleThought`) снесён: классификация
// события вне слоя запрещена, решение «когда обновлять» принято слоем.

/** Ключ кэша-снимка ленты по ТЕКУЩЕМУ отбору (запрос слоя). */
function chronicleFilterKey(): string {
  return JSON.stringify(chronicleQueryDefinition());
}

let chronicleQueryKey: string | null = null;
let chronicleInvalidationUnsub: (() => void) | null = null;
let chronicleSnapshotSeq = 0;

/** Окно дебаунса перезапроса ленты: одна пачка событий → один перезапрос. */
const CHRONICLE_REFRESH_WINDOW_MS = 250;
let feedRefreshTimer: number | null = null;
/**
 * Скрытый экран получил событие (ошибка 8e702d8c): снимок грязный, перезапрос
 * отложен до показа вида «Дневник».
 */
let fullRefreshPending = false;

/** Зарегистрировать ключ снимка ленты в реестре (инвалидации его видят). */
function retargetChronicleFeed(): void {
  const key = queryKeys.chronicleFeed(chronicleFilterKey());
  if (key === chronicleQueryKey) return;
  chronicleQueryKey = key;
  registerQuery(key, null);
}

/** Подписать ленту на инвалидации своих ключей слоя (один раз). */
function bindChronicleFeed(): void {
  retargetChronicleFeed();
  if (chronicleInvalidationUnsub !== null) return;
  chronicleInvalidationUnsub = onQueryInvalidated((prefix) => {
    // Содержимое ленты (записи): роутер гасит `chronicle-feed`.
    if (matchesKeyPrefix(prefix, 'chronicle-feed')) {
      scheduleChronicleFeedRefresh();
      return;
    }
    // Правка/удаление мысли адресна: перечитываем ленту ТОЛЬКО если мысль видна
    // чипсом загруженной записи (замечание G3: невидимая правка не тратит запрос).
    if (prefix.startsWith('chronicle-thought:@')) {
      const id = prefix.slice('chronicle-thought:@'.length);
      if (rows.some((row) => row.targets.some((t) => t.kind === 'thought' && t.thought.id === id))) {
        scheduleChronicleFeedRefresh();
      }
      return;
    }
    // Связь-чипс — симметрично.
    if (prefix.startsWith('chronicle-link:@')) {
      const id = prefix.slice('chronicle-link:@'.length);
      if (rows.some((row) => row.targets.some((t) => t.kind === 'link' && t.link.id === id))) {
        scheduleChronicleFeedRefresh();
      }
    }
  });
}

/**
 * Отложенный перезапрос ленты по инвалидации слоя. Глубину ленты сохраняем
 * (`reloadKeepingDepth`) — дозагруженные «+50» не теряются, прокрутка не
 * прыгает (ошибка f5809943); календарь и его счётчики синхронизируются следом.
 *
 * Скрытый экран (активен другой вид) сетевых перезагрузок вхолостую не гоняет —
 * по образцу «Структур» (ошибка 8e702d8c): помечаем снимок «грязным», перезапрос
 * идёт при показе вида (см. store-подписчик в `mountChronicle`).
 */
function scheduleChronicleFeedRefresh(): void {
  if (host === null) return;
  if (store.state.activeView !== 'chronicle') {
    fullRefreshPending = true;
    return;
  }
  if (feedRefreshTimer !== null) window.clearTimeout(feedRefreshTimer);
  feedRefreshTimer = window.setTimeout(() => {
    feedRefreshTimer = null;
    if (host === null) return;
    void refreshFeedAndCalendar();
  }, CHRONICLE_REFRESH_WINDOW_MS);
}

/**
 * Перезапрос ленты до глубины + синхронизация календаря и счётчиков.
 *
 * Снимает отложенный перезапрос окна дебаунса: локальная мутация, которой
 * нужен свежий DOM сразу (например, прокрутка к перемещённой записи), зовёт
 * этот путь напрямую — второй сетевой заход не планируется.
 */
async function refreshFeedAndCalendar(): Promise<void> {
  if (feedRefreshTimer !== null) {
    window.clearTimeout(feedRefreshTimer);
    feedRefreshTimer = null;
  }
  await reloadKeepingDepth();
  syncCalendar();
  void refreshCalendarCounts();
}

/** Опубликовать снимок ленты в кэш слоя (наблюдатели/диагностика). */
export function publishChronicleSnapshot(): void {
  retargetChronicleFeed();
  if (chronicleQueryKey === null) return;
  setQueryData(chronicleQueryKey, { seq: ++chronicleSnapshotSeq, rows, total });
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

/** Локальный день записи HOME — границы применённого периода ленты. */
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
      // День передаём ЯВНО: `reconcileKeyed` зовёт `build`/`update` ДО вставки
      // узла в DOM, поэтому `dayOfCard(card)` в этот момент ещё null, и
      // восстановление сохранённой свёрнутости не сработало бы (блокер проверки
      // 41ed99ab, круг 1).
      build: (row) => buildRecordCard(row, day.day),
      update: (card, row) => updateRecordCard(card, row, day.day),
    });
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
    // Производный заголовок записи с пустым `title` берётся из тела (0.10.2,
    // задача 41ed99ab): у локальной строки `snippet` считается из `body_md`.
    snippet: recordTitleFromBody(comment.body_md),
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


/**
 * Локальная вставка только что созданной записи: строка встаёт на своё место
 * (`insertRowByDay`), лента пересобирается keyed-сверкой без сетевого
 * перезапроса — соседние карточки и прокрутка сохраняются. Метка дня календаря
 * обновляется сразу (`syncCalendar` + `refreshCalendarCounts`).
 *
 * Дедупликация по id: строку могла вставить другая ветка (realtime-событие,
 * перезагрузка/сверка) — повторная вставка дала бы ленте два узла с одним
 * ключом и уронила `reconcileKeyed`. Строка уже в ленте — вторую не вставляем,
 * но СЛИВАЕМ свежие поля.
 */
async function insertCreatedRecord(row: ChronicleRow): Promise<void> {
  if (hasRowId(rows, row.id)) {
    rows = rows.map((existing) => (existing.id === row.id ? row : existing));
  } else {
    const home = homeId ?? (await getHome().catch(() => null));
    rows = insertRowByDay(rows, row, getFilterState().order, home);
    total += 1;
  }
  pendingReconcile = true;
  renderFeed();
  publishChronicleSnapshot();
  syncCalendar();
  void refreshCalendarCounts();
  feedNav?.refresh();
}

/**
 * «Добавить»: СРАЗУ создаёт обычную хроно-запись (привязки — HOME и, при
 * drop-жесте, указанные мысли; дата — `clamp(сегодня, период)`, текущее время),
 * без заголовка и текста. Карточка встаёт на место локально и открывается в
 * единой правке с фокусом в заголовке (требование 26f0aa52, модель немедленного
 * создания). Пустые записи не чистятся автоматически.
 */
async function addRecord(presetThoughtIds: string[] = []): Promise<void> {
  if (host === null) return;
  const filter = getFilterState();
  const targetDay = clampPseudoDate(
    todayLocal(),
    resolvePeriodDay(filter.dateFrom),
    resolvePeriodDay(filter.dateTo),
  );
  const networkId = requireNetworkId();
  try {
    const home = await getHome();
    const targets: CommentTarget[] = [{ owner_type: 'thought', owner_id: home }];
    for (const id of presetThoughtIds) {
      if (id === home || targets.some((t) => t.owner_id === id)) continue;
      targets.push({ owner_type: 'thought', owner_id: id });
    }
    // Дата — указанный день + текущее время (ADR 994d076a): голую дату не шлём,
    // `valid_to` обязан быть непустым (требование d58aa1a4).
    const now = new Date().toISOString();
    const { from: validFrom, to: validTo } = resolvePeriodInstants(
      { from: targetDay, to: targetDay },
      { from: now, to: now },
    );
    const created = await etn.comments.createMulti(networkId, targets, {
      kind: 'chronological',
      title: null,
      body_md: '',
      valid_from: validFrom,
      valid_to: validTo,
      use_time: false,
    });
    const localRow = await localRowFromComment(created, home);
    if (localRow === null) {
      await reload();
      syncCalendar();
      return;
    }
    await insertCreatedRecord(localRow);
    // Новая карточка — сразу в правке, фокус в поле заголовка.
    const card = feedList?.querySelector<HTMLElement>(`[${TABLE_ROW_KEY_ATTR}="${created.id}"]`);
    if (card !== null && card !== undefined) {
      feedNav?.selectRecord(created.id, localDay(created.valid_from));
      cardEditors.get(card)?.openTitle();
    }
  } catch (err) {
    notice(t('diary.createFailed', [errText(err)]), 'error');
  }
}
/** Свернуть/развернуть все показанные группы дат И тела записей (кнопки панели). */
function setAllDaysCollapsed(collapsed: boolean): void {
  collapsedDays.clear();
  collapsedRecords.clear();
  const { from, to } = currentFromTo();
  if (collapsed) {
    for (const day of groupByLocalDays(rows, { from, to })) {
      collapsedDays.add(day.day);
      for (const row of day.rows) collapsedRecords.add(recordCollapseKey(day.day, row.id));
    }
  }
  // Переключение секций НА МЕСТЕ (требование 165323a7) — фокус и прокрутка
  // сохраняются. Ключи свёрнутости собираем и с ФАКТИЧЕСКИХ карточек DOM, а не
  // только с `rows`: дозагруженные «+50» карточки могли ещё не попасть в `rows`
  // на момент нажатия, и «Свернуть все» оставляло их развёрнутыми (замечание
  // проверки 41ed99ab, круг 1).
  if (feedList !== null) {
    const labels = dayGroupLabels();
    const recLabels = recordGroupLabels();
    let touched = false;
    for (const section of Array.from(feedList.querySelectorAll<HTMLElement>('.diary-day'))) {
      const day = section.dataset['day'] ?? '';
      if (day === '') continue;
      applyDayCollapsed(section, collapsed, labels);
      // Кнопки верхней панели действуют и на записи (0.10.2, задача 41ed99ab).
      for (const card of Array.from(section.querySelectorAll<HTMLElement>('.diary-record'))) {
        const id = card.getAttribute(TABLE_ROW_KEY_ATTR) ?? '';
        if (id === '') continue;
        if (collapsed) collapsedRecords.add(recordCollapseKey(day, id));
        applyRecordCollapsed(card, collapsed, recLabels);
      }
      touched = true;
    }
    if (touched) {
      persistCollapsedDays();
      persistCollapsedRecords();
      feedNav?.refresh();
      return;
    }
  }
  persistCollapsedDays();
  persistCollapsedRecords();
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
  // Выходной день (сб/вс) красится отдельным токеном (0.10.2, задача 41ed99ab).
  if (isWeekend(day)) head.classList.add('is-weekend');
  // Контекстное меню группы дня: обе команды записей дня доступны всегда.
  head.addEventListener('contextmenu', (event: MouseEvent) => {
    event.preventDefault();
    showMenuAt(event.clientX, event.clientY, [
      menuAction(t('diary.collapseDayRecords'), () => setDayRecordsCollapsed(day, true)),
      menuAction(t('diary.expandDayRecords'), () => setDayRecordsCollapsed(day, false)),
    ]);
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
function buildRecordCard(row: ChronicleRow, day: string): HTMLElement {
  const card = div('diary-record');
  // `data-row-key` ставится атрибутом: `dataset['data-row-key']` бросает
  // исключение (имя свойства dataset не может содержать дефис) — ошибка
  // 6 сентября (0.10.1, дефект приёмки).
  card.setAttribute(TABLE_ROW_KEY_ATTR, row.id);
  fillRecordCard(card, row, day);
  return card;
}

/**
 * Обновление существующей карточки при keyed-сверке: перерисовывается ТОЛЬКО
 * содержимое, сам узел карточки (и его DOM-позиция) сохраняется, поэтому правка
 * одной записи не пересоздаёт соседние карточки и не сбрасывает прокрутку.
 * Карточка В ЕДИНОЙ ПРАВКЕ не трогается: пересборка отсоединила бы живой
 * редактор и потеряла несохранённый текст — обновление ждёт выхода из правки.
 */
function updateRecordCard(card: HTMLElement, row: ChronicleRow, day: string): void {
  if (cardEditors.get(card)?.editing() === true) return;
  fillRecordCard(card, row, day);
}

/**
 * Наполнить карточку содержимым записи (общая сборка и обновление) и завести
 * ЕДИНЫЙ контроллер её правки (ТП «Дневник без псевдослота»).
 *
 * Шапка (строка полей + строка заголовка) собирается единым конструктором
 * `buildRecordHead`; строка 1 — дата/период, облачка привязок, «+ мысль», меню
 * записи. Тело — оболочка комментария (`lib/ui/comment.ts`): в просмотре полный
 * `body_html`, в правке — общее поле markdown. Запись со ссылкой-трансклюзией
 * достраивается полем markdown уже в просмотре (серверный `body_html` её не
 * разворачивает — ошибка `e5e1f609`), см. `htmlHasTransclusionMarkup`.
 *
 * Режим правки принадлежит КАРТОЧКЕ: вход в правку заголовка ИЛИ тела открывает
 * оба поля; Ctrl+Enter / «Записать» / клик вне пишут оба одним PATCH; Esc /
 * «Отменить» откатывают оба (требование 26f0aa52).
 */
function fillRecordCard(card: HTMLElement, row: ChronicleRow, day: string): void {
  // Запись, к которой выполнен переход поиска, подсвечена (T7); при правке
  // класс пересчитывается (запись могла перестать быть целью перехода).
  card.classList.toggle('diary-record-target', row.id === jumpHighlightId);

  let editing = false;
  /** md тела загружен (лента несёт только `body_html`/`snippet`). */
  let bodyLoaded = false;
  let bodyDraft = '';
  let widget: HTMLElement | null = null;
  let title: RecordTitleHandle | null = null;

  const shell = commentShell({ variant: 'plain' });
  const body = div('diary-record-body');
  renderRecordView(shell, row);
  body.append(shell.root);

  /**
   * Создать поле markdown тела при первом входе в правку (ленивое создание).
   * Полный `body_md` ленты не несёт — он точечно дочитывается `etn.comments.get`
   * (как и раньше). `null` — загрузка не удалась (сообщение уже показано).
   */
  const ensureWidget = async (): Promise<HTMLElement | null> => {
    if (widget !== null) return widget;
    if (!bodyLoaded) {
      try {
        const comment = await etn.comments.get(requireNetworkId(), row.id);
        bodyDraft = comment.body_md;
        row.body_html = comment.body_html;
        row.version = comment.version;
        bodyLoaded = true;
      } catch (err) {
        notice(t('diary.loadFailed', [errText(err)]), 'error');
        return null;
      }
    }
    if (!body.isConnected) return null;
    // Вставка картинки из буфера: цель вложения — первая привязанная мысль
    // записи, иначе HOME (паритет с постоянным комментарием мысли).
    const owner = attachmentOwnerForRow(row.targets, homeId);
    widget = createMarkdownField({
      md: bodyDraft,
      html: row.body_html,
      placeholder: t('diary.emptyRecordHint'),
      // Каретка/выделение при входе в правку — в месте клика в просмотре
      // (требование bac754e4, задача 189da39e).
      sourceMapView: true,
      // Группа единой правки — вся карточка: переход фокуса заголовок↔тело и
      // клик по её элементам (дата, чипсы, «+ мысль») правку не закрывают.
      editGroup: () => card,
      // Заголовок пишется тем же PATCH: коммит уходит, когда изменён заголовок
      // (тело поле видит само). При неизменных обоих полях PATCH не уходит.
      externalChanges: () =>
        (title !== null ? title.value().trim() : row.title ?? '') !== (row.title ?? ''),
      ...(owner !== null ? { attachmentsOwner: owner } : {}),
      // Контекст комментария (карточка 34ffbd75 + ТЗ5 «Дневник без псевдослота»):
      // флоу «создать мысль по legacy-ссылке», команды вставки ссылки/
      // трансклюзии и родители новой мысли — ВСЕ цели-чипсы записи.
      ...(owner !== null
        ? {
            commentContext: {
              ownerType: 'thought' as const,
              ownerId: owner.ownerId,
              commentKind: 'chronological' as const,
              getCommentId: () => row.id,
              getParentThoughtIds: () => parentThoughtIds(row.targets),
            },
          }
        : {}),
      onInput: (md) => {
        bodyDraft = md;
      },
      onSave: (md) => saveBoth(md),
      onEditChange: (isEdit) => {
        editing = isEdit;
        shell.setMode(isEdit ? 'edit' : 'view');
        if (isEdit) {
          // Единая правка: вход в тело открывает и заголовок (без кражи фокуса).
          if (title !== null && !title.isEditing()) title.beginEdit(false);
        } else {
          if (title !== null && title.isEditing()) title.endEdit(false, false);
          // Выход из правки — фокус возвращается в навигацию записи.
          feedNav?.focusNavigation();
        }
      },
    });
    shell.setField(widget);
    return widget;
  };

  // Просмотр тела в ленте — готовый серверный `body_html`, собранный из
  // ИСХОДНОГО `body_md`, поэтому ссылка-трансклюзия в нём не развёрнута и блок
  // невидим (ошибка e5e1f609). Записи с такой ссылкой достраиваются полем
  // markdown — тем же путём, что комментарий мысли: поле разворачивает
  // трансклюзии единым рендерером с блочными обёртками. Признак ищется по
  // разметке, `body_md` дочитывается точечно только для таких записей. Ждём
  // монтирования карточки (`ensureWidget` не создаёт поле до `body.isConnected`),
  // поэтому откладываем на макрозадачу; `setTimeout`, а не rAF — кадры скрытого
  // окна заторможены (грабли 03e33360).
  if (htmlHasTransclusionMarkup(row.body_html)) {
    setTimeout(() => {
      if (body.isConnected) void ensureWidget();
    }, 0);
  }

  /**
   * Войти в единую правку с фокусом в заданном поле: тело создаётся при первом
   * входе, заголовок открывается тем же действием (через `onEditChange`).
   */
  const enterBodyEdit = async (focus: 'title' | 'body'): Promise<void> => {
    const w = await ensureWidget();
    if (w === null) return;
    if (editing) {
      if (focus === 'title') title?.beginEdit(true);
      else focusMarkdownFieldStart(w);
      return;
    }
    editMarkdownField(w);
    if (focus === 'title') title?.beginEdit(true);
  };

  /** ЕДИНАЯ запись обоих полей одним PATCH (требование 26f0aa52). */
  const saveBoth = async (md: string): Promise<string> => {
    const networkId = requireNetworkId();
    const nextTitle = (title !== null ? title.value() : row.title ?? '').trim();
    const fresh = await etn.comments.get(networkId, row.id);
    const updated = await etn.comments.update(
      networkId,
      row.id,
      { title: nextTitle === '' ? null : nextTitle, body_md: md },
      fresh.version,
    );
    applySaved(updated);
    // Локальная мутация — тем же путём, что чужая: гасим ключ слоя, лента
    // перечитается отложенно (единственный путь обновления, G3).
    invalidateQueries(queryKeys.chronicleFeedAll());
    return updated.body_html;
  };

  /** Перенести сохранённые поля в строку ленты и в заголовок-компонент. */
  const applySaved = (updated: Comment): void => {
    row.title = updated.title;
    row.body_html = updated.body_html;
    row.version = updated.version;
    row.snippet = recordTitleFromBody(updated.body_md);
    bodyDraft = updated.body_md;
    bodyLoaded = true;
    if (title !== null) {
      title.setContent(
        updated.title ?? '',
        recordDisplayTitle(updated.title, updated.body_md) || t('diary.emptyTitle'),
      );
    }
  };

  /** Откат ОБОИХ полей к сохранённым значениям (Esc / «Отменить»). */
  const cancelEdit = (): void => {
    if (widget !== null) cancelMarkdownFieldEdit(widget);
    if (title !== null && title.isEditing()) title.endEdit(false, false);
    editing = false;
  };

  const editor: CardEditor = {
    row,
    editing: () => editing,
    // Вход в правку заголовка через компонент: он же откроет и тело (`onBeginEdit`).
    openTitle: () => title?.beginEdit(true),
    openBody: () => void enterBodyEdit('body'),
  };

  const head = buildRecordHead({
    dayLabel: recordDateLabel(row),
    onDateClick: () => void editRecordDates(row),
    dateTitle: 'Период дневниковой записи',
    chips: buildChipsRow(row),
    onAddThought: () => void pickAndAttach(row.id),
    trailing: iconButton({
      icon: svgIcon('menu', 16),
      title: 'Действия с дневниковой записью',
      role: 'ghost',
      size: 's',
      class: 'diary-record-actions',
      onClick: (event) => showMenuAt(event.clientX, event.clientY, recordMenuItems(row)),
    }),
    title: {
      value: row.title ?? '',
      label: recordTitleLabel(row),
      editHint: t('diary.titleEditHint'),
      placeholder: t('diary.titlePlaceholder'),
      // Единая правка: уход фокуса заголовок↔тело правку не закрывает.
      commitOnBlur: false,
      // Одиночный клик в просмотре сворачивает/разворачивает тело записи.
      onToggle: () => {
        const d = dayOfCard(card);
        if (d === null) return;
        toggleRecordCollapsed(d, row.id);
      },
      // Двойной клик / вход в правку заголовка открывает и тело записи.
      onBeginEdit: () => void enterBodyEdit('title'),
      // Enter в заголовке: Ctrl/Cmd — записать оба поля, иначе — фокус в тело,
      // курсор в позицию 0.
      onEnter: (event) => {
        const w = widget;
        if (w === null) return;
        if (event.ctrlKey || event.metaKey) commitMarkdownField(w);
        else focusMarkdownFieldStart(w);
      },
      onEscape: () => cancelEdit(),
    },
  });
  title = head.title;
  cardEditors.set(card, editor);

  // Двойной клик по СТАТИЧНОМУ просмотру (поле ещё не создано) входит в правку
  // тела. После создания поля его собственный обработчик ведёт правку сам.
  shell.root.addEventListener('dblclick', () => {
    if (widget === null) editor.openBody();
  });

  card.replaceChildren(head.root, body);
  // Свёрнутость тела записи переприменяется при keyed-обновлении карточки и
  // realtime (0.10.2, задача 41ed99ab): день приходит ЯВНЫМ параметром (на
  // момент `build` карточка ещё не вставлена, `dayOfCard` вернул бы null).
  applyRecordCollapsedForDay(card, day, row.id, collapsedRecords, recordGroupLabels());
}

/** Подпись даты/периода записи — единый помощник периода дневниковой записи. */
function recordDateLabel(row: ChronicleRow): string {
  return formatRecordPeriod(row.valid_from, row.valid_to, row.use_time === true);
}

/** Отображаемый заголовок записи; пустой — «Пустая запись» из словаря. */
function recordTitleLabel(row: ChronicleRow): string {
  return recordDisplayTitle(row.title, row.snippet) || t('diary.emptyTitle');
}

function recordMenuItems(row: ChronicleRow): MenuItem[] {
  return [
    menuAction(t('chrono.menu.copy'), () => void copyRecord(row.id)),
    MENU_SEPARATOR,
    menuAction(t('actions.delete'), () => void removeRecord(row.id), { danger: true }),
  ];
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
    // Локальная мутация — тем же путём, что чужая: гасим ключ слоя, лента
    // перечитается отложенно (единственный путь обновления, G3).
    invalidateQueries(queryKeys.chronicleFeedAll());
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
    // Локальная мутация — тем же путём, что чужая: гасим ключ слоя, лента
    // перечитается отложенно до уже загруженной глубины (дозагруженные «+50»
    // не теряем, прокрутка не прыгает — f5809943).
    invalidateQueries(queryKeys.chronicleFeedAll());
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
    // Локальная мутация — через слой: гасим ключ ленты (единственный путь, G3).
    invalidateQueries(queryKeys.chronicleFeedAll());
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
    // и поднимает в верхний блок) — гасим ключ ленты и дожидаемся свежего DOM
    // тем же путём, что отложенный перезапрос (сняв его таймер).
    invalidateQueries(queryKeys.chronicleFeedAll());
    await refreshFeedAndCalendar();
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
    // Локальная мутация — через слой: гасим ключ ленты и ДОЖИДАЕМСЯ свежего DOM
    // (снятый отложенный перезапрос — `refreshFeedAndCalendar`), иначе прокрутка
    // к перемещённой записи смотрела бы на старую ленту.
    invalidateQueries(queryKeys.chronicleFeedAll());
    await refreshFeedAndCalendar();
    // Перемещённая вниз запись должна быть видна: прокручиваем к её карточке, а
    // если день записи ниже загруженной страницы — показываем ленту с начала
    // (ошибка 810520c5, симметрично 368747a6).
    if (firstBinding) revealRecord(rowId);
  } catch (err) {
    notice(t('diary.attachFailed', [errText(err)]), 'error');
  }
}

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
  const networkId = requireNetworkId();
  if (homeId !== null && homeNetworkId === networkId) return homeId;
  if (homePromise === null || homeNetworkId !== networkId) {
    homeNetworkId = networkId;
    homePromise = findRootThought(networkId)
      .then((root) => {
        // Промис мог завершиться уже после смены сети: не затираем кэш HOME
        // чужой сети (ошибка ab4e499f).
        if (homeNetworkId === networkId) homeId = root.id;
        return root.id;
      })
      .catch((err: unknown) => {
        // Сбой разрешения HOME не кэшируем навсегда: сбрасываем промис, чтобы
        // следующее обращение сделало новую попытку, а не осталось в fallback до
        // перезагрузки экрана (ошибка 810520c5).
        if (homeNetworkId === networkId) {
          homePromise = null;
          homeNetworkId = null;
        }
        throw err;
      });
  }
  return homePromise;
}
