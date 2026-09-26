/**
 * Вид «Дневник» (рабочий стол) — 0.10.1, задача T6 64ca2b48.
 *
 * Экран (L20, был «Хроника»): в левой колонке — календарь месяца и
 * непрокручиваемая sticky-панель с кнопкой «Добавить хроно-запись», в центре —
 * лента дневниковых записей, сгруппированная по локальным дням наблюдателя;
 * панель отбора — общий каркас `lib/filter-form.ts`.
 *
 * Ключевые поведения заданы элементами спеки и требованиями:
 *  * «Вид «Дневник» (рабочий стол)» 9b424548 — компоновка;
 *  * «Календарь месяца в «Дневнике»» 55b07702 — клик по дате/неделе = «Применить»
 *    с новым периодом, остальные критерии не трогаются, лента перезагружается;
 *  * «Лента дневных записей» e01f383a — группировка по дням, дозагрузка «+50»,
 *    чипсы привязок с «+»/«✕», правка по месту;
 *  * «Sticky-панель новой записи» a2b993d7 + требование 26f0aa52 — псевдо-запись,
 *    в базу не пишется до первого содержания;
 *  * требование 306f74cc — критерии целей (панель, группа «Критерии целей»);
 *  * требование c6ddc1ea — порядок ленты (серверный, класс → даты);
 *  * требование e0970b70 — длительная запись видна в каждом дне периода;
 *  * требование c81964c7 — владелец HOME, чипсы — вторичные привязки;
 *  * требование 80b31f7a — переименование «Хроника» → «Дневник».
 *
 * Правка по месту — оболочка комментария `lib/ui/comment.ts` и общее поле
 * markdown; даты записи и поля периода — общий контрол `lib/period-editor.ts`
 * (своих полей дат у экрана нет, сторож `guard-period-editor`). Состояние
 * (критерии, страница, месяц, выбранный отбор) — L4 `chronicle_state`.
 */

import {
  CHRONICLE_PAGE_SIZE,
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
import { registerDropActions } from '../../canvas/drag-cloud.js';
import { openLinkInEditor, setThoughtEditorTarget } from '../../editor/editor.js';
import { createMarkdownField, editMarkdownField } from '../../editor/markdown-field.js';
import { confirmDialog } from '../../lib/dialog.js';
import { div, el, errText, fmtDate, renderHtml, span } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { mountFilterPanelFrame } from '../../lib/filter-panel-frame.js';
import { markCommentPreview, markThoughtCommentPreview } from '../../lib/hover-preview.js';
import { menuAction, showMenuAt, MENU_SEPARATOR, type MenuItem } from '../../lib/menu.js';
import { formatDateTime } from '../../lib/metadata.js';
import { notice } from '../../lib/notice.js';
import { buildPeriodEditor, type PeriodValue } from '../../lib/period-editor.js';
import { createThoughtCloud } from '../../lib/thought-cloud.js';
import { uiButton } from '../../lib/ui/button.js';
import { commentShell } from '../../lib/ui/comment.js';
import { fieldInput } from '../../lib/ui/field.js';
import { operationError } from '../../lib/ui/messages.js';
import { splitterElement } from '../../lib/ui/splitter.js';
import { TABLE_ROW_KEY_ATTR } from '../../lib/ui/table.js';
import { shouldLoadMore, type ZonePagingCounters } from '../../lib/zone-paging.js';
import { store } from '../../state.js';
import { t } from '../../lib/i18n.js';
import { parseChronicleCriteria } from '../../lib/filter-builder.js';
import { buildMonthCalendar, type MonthCalendarHandle } from './calendar.js';
import {
  applyPeriodToFilter,
  clampPseudoDate,
  dayPeriod,
  groupByLocalDays,
  hasRecordContent,
  isLastChip,
  localDay,
  resolvePeriodDay,
  slotDeleteNeedsNetwork,
  todayLocal,
  visibleChips,
  weekPeriod,
} from './diary.js';
import {
  addThoughtToFilter,
  chronicleDefinition,
  getFilterState,
  getSavedFilterId,
  mountChronicleFilterPanel,
  setFilterState,
  setSavedFilterId,
  wireChronicleApplyShortcut,
} from './filter-panel.js';
import { parseChronicleState } from './state.js';

/**
 * Границы размера панели отбора (задача 2ebe4206): слева — ширина, вверху
 * (узкое полотно) — высота.
 */
const CHRONICLE_FILTER_MIN_W = 230;
const CHRONICLE_FILTER_MAX_W = 480;

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
let refreshTimer: number | null = null;
/** Id of the HOME (root) thought — primary owner of a day record. */
let homeId: string | null = null;
let homePromise: Promise<string> | null = null;
/** Stable scroll container of the feed (`.chron-table-wrap`). */
let feedWrap: HTMLElement | null = null;
/** Stable list element re-rendered inside the container (never rebuilt). */
let feedList: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let calendar: MonthCalendarHandle | null = null;
/** Persisted month of the calendar (`chronicle_state.month`). */
let month: { year: number; month: number } | null = null;
/** Счётчики записей по дням (для календаря), пересчитываются при отрисовке. */
const dayCounts = new Map<string, number>();

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

  const filterArea = div('chron-filter-area');
  const splitter = splitterElement('chron-splitter');
  const main = div('chron-main');
  hostEl.append(filterArea, splitter, main);
  mountFilterPanelFrame({
    container: hostEl,
    panel: filterArea,
    splitter,
    stateKey: UI_STATE_KEY.CHRONICLE_FILTER_PANEL,
    minSize: CHRONICLE_FILTER_MIN_W,
    maxSize: CHRONICLE_FILTER_MAX_W,
    minSizeTop: 80,
    maxSizeTop: 800,
  });

  mountChronicleFilterPanel(filterArea, { apply: () => void applyFilter() });

  // Left column: month calendar + non-scrollable sticky add panel.
  const side = div('chron-side');
  const calWrap = div('chron-cal');
  calendar = buildMonthCalendar({
    today: todayLocal(),
    month: month ?? undefined,
    counts: (day) => dayCount(day),
    onPickDay: (day) => void pickPeriod(dayPeriod(day)),
    onPickWeek: (monday) => void pickPeriod(weekPeriod(monday)),
    onMonthChange: (year, monthNo) => {
      month = { year, month: monthNo };
      persistState();
    },
  });
  calWrap.append(calendar.root);
  const addPanel = div('chron-add');
  addPanel.append(
    uiButton({
      label: t('diary.addRecord'),
      role: 'primary',
      class: 'diary-add-btn',
      onClick: () => startSlot(),
    }),
  );
  side.append(calWrap, addPanel);

  // Center: feed, grouped by local days.
  feedWrap = div('admin-table-wrap chron-table-wrap chron-feed-wrap');
  feedList = div('chron-feed');
  statusEl = div('muted chron-feed-status');
  statusEl.hidden = true;
  feedWrap.append(statusEl, feedList);
  feedWrap.addEventListener('scroll', () => maybeLoadMore());

  main.append(side, feedWrap);

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
  await getHome().catch(() => undefined);
  await reload();
  syncCalendar();
}

/** Re-fetches the first page (used after edits and real-time events). */
async function reload(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || feedList === null) return;
  const seq = ++querySeq;
  renderStatus('loading');
  try {
    const def = chronicleDefinition();
    const result = await etn.chronicle.query(networkId, {
      ...def,
      limit: CHRONICLE_PAGE_SIZE,
      offset: 0,
    });
    if (seq !== querySeq) return;
    rows = result.rows;
    total = result.total;
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
  loadingMore = true;
  const seq = querySeq;
  try {
    const result = await etn.chronicle.query(networkId, {
      ...chronicleDefinition(),
      limit: CHRONICLE_PAGE_SIZE,
      offset: rows.length,
    });
    if (seq !== querySeq) return;
    rows = [...rows, ...result.rows];
    total = result.total;
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

/** Debounced refresh (real-time comment/target events). */
export function scheduleChronicleRefresh(): void {
  if (host === null) return;
  if (refreshTimer !== null) return;
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void reload();
    syncCalendar();
  }, 250);
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
  if (feedList === null) return;
  if (statusEl !== null) statusEl.hidden = true;
  feedList.hidden = false;

  const { from, to } = currentFromTo();
  const days = groupByLocalDays(rows, { from, to });
  // Счётчики календаря — из того же разбора, что и лента.
  dayCounts.clear();
  for (const day of days) dayCounts.set(day.day, day.rows.length);
  // Слот псевдо-записи всегда виден: его день появляется в ленте, даже если в
  // нём ещё нет записей (элемент «Sticky-панель новой записи»).
  if (slot !== null && !days.some((d) => d.day === slot!.day)) {
    days.push({ day: slot.day, rows: [] });
    days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }

  const nodes: HTMLElement[] = [];
  for (const day of days) nodes.push(buildDayBlock(day.day, day.rows));
  if (nodes.length === 0) {
    nodes.push(el('div', 'chron-feed-empty muted', t('diary.feedEmpty')));
  } else if (rows.length < total) {
    nodes.push(el('div', 'chron-feed-more muted', t('diary.moreLeft', [rows.length, total])));
  }
  feedList.replaceChildren(...nodes);
}

function buildDayBlock(day: string, dayRows: ChronicleRow[]): HTMLElement {
  const section = div('diary-day');
  section.dataset['day'] = day;
  section.append(el('div', 'diary-day-head', formatDayLabel(day)));
  const list = div('diary-day-list');
  if (slot !== null && slot.day === day) list.append(slot.root);
  for (const row of dayRows) list.append(buildRecordCard(row));
  section.append(list);
  return section;
}

/** Подпись дня ленты в локальной зоне наблюдателя. */
function formatDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

// ---------------------------------------------------------------------------
// Record card
// ---------------------------------------------------------------------------

function buildRecordCard(row: ChronicleRow): HTMLElement {
  const card = div('diary-record');
  card.dataset[TABLE_ROW_KEY_ATTR] = row.id;

  const head = div('diary-record-head');
  head.append(
    uiButton({
      label: recordDateLabel(row),
      role: 'ghost',
      size: 's',
      class: 'diary-record-date',
      title: 'Изменить дату записи',
      onClick: () => openDateEditor(card, row),
    }),
    buildTitleInput(row),
    uiButton({
      label: 'Действия…',
      role: 'ghost',
      size: 's',
      class: 'diary-record-actions',
      onClick: (event) => showMenuAt(event.clientX, event.clientY, recordMenuItems(row)),
    }),
  );
  card.append(head, buildChipsRow(row), buildBody(row));
  return card;
}

/** Подпись даты/времени записи (время — только при флаге «учитывать время»). */
function recordDateLabel(row: ChronicleRow): string {
  const from = row.use_time ? formatDateTime(row.valid_from) : fmtDate(row.valid_from);
  if (row.valid_to === null || localDay(row.valid_to) === localDay(row.valid_from)) return from;
  const to = row.use_time ? formatDateTime(row.valid_to) : fmtDate(row.valid_to);
  return `${from} — ${to}`;
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

/** Тело записи: превью с подсветкой; двойной клик — правка по месту. */
function buildBody(row: ChronicleRow): HTMLElement {
  const body = div('diary-record-body');
  const snippet = div('diary-snippet');
  renderHtml(snippet, row.snippet);
  body.append(snippet);
  body.addEventListener('dblclick', () => void openBodyEditor(body, row));
  return body;
}

/** Встроенная правка текста записи (оболочка комментария + поле markdown). */
async function openBodyEditor(body: HTMLElement, row: ChronicleRow): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const comment = await etn.comments.get(networkId, row.id);
    if (!body.isConnected) return;
    const shell = commentShell({ variant: 'plain' });
    const widget = createMarkdownField({
      md: comment.body_md,
      html: comment.body_html,
      onSave: async (md) => {
        const fresh = await etn.comments.get(networkId, row.id);
        const updated = await etn.comments.update(networkId, row.id, { body_md: md }, fresh.version);
        scheduleChronicleRefresh();
        return updated.body_html;
      },
      onEditChange: (editing) => shell.setMode(editing ? 'edit' : 'view'),
    });
    shell.setField(widget);
    shell.setState({ kind: 'ready' });
    body.replaceChildren(shell.root);
    editMarkdownField(widget);
  } catch (err) {
    notice(t('diary.loadFailed', [errText(err)]), 'error');
  }
}

/** Правка даты записи общим контролом периода (режим — по флагу времени). */
function openDateEditor(card: HTMLElement, row: ChronicleRow): void {
  const sameDay = localDay(row.valid_to ?? row.valid_from) === localDay(row.valid_from);
  const editor = buildPeriodEditor({
    mode: row.use_time ? 'datetime' : sameDay ? 'date' : 'range',
    value: { from: row.valid_from, to: row.valid_to ?? row.valid_from },
    allowTokens: false,
    label: 'Дата записи',
    onChange: (value: PeriodValue) => void saveRecordDates(row.id, value),
  });
  const box = div('diary-record-date-editor');
  box.append(
    editor.root,
    uiButton({
      label: t('actions.apply'),
      role: 'secondary',
      size: 's',
      onClick: () => box.remove(),
    }),
  );
  const head = card.querySelector('.diary-record-date');
  if (head !== null && head.parentElement !== null) {
    head.replaceWith(box);
  }
}

async function saveRecordDates(id: string, value: PeriodValue): Promise<void> {
  const from = value.from ?? '';
  if (from === '') return;
  const to = value.to ?? from;
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
    await etn.comments.createMulti(networkId, source.targets, {
      kind: 'chronological',
      title: source.title,
      body_md: source.body_md,
      valid_from: today,
      valid_to: today,
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
  box.append(
    uiButton({
      label: '+',
      role: 'ghost',
      size: 's',
      class: 'diary-chip-add',
      title: 'Привязать мысль',
      onClick: () => void pickAndAttach(row.id),
    }),
  );
}

function buildChip(target: ChronicleTarget, rowId: string): HTMLElement {
  const chip = target.kind === 'thought' ? thoughtChip(target.thought) : linkChip(target.link);
  chip.classList.add('diary-chip');
  chip.addEventListener('click', () => {
    if (target.kind === 'thought') void openChronicleThought(target.thought.id);
    else void openChronicleLinkById(target.link.id);
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

async function detachChip(rowId: string, target: ChronicleTarget): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const fresh = await etn.comments.get(networkId, rowId);
    // HOME — служебная первичная привязка, крестика у неё нет (c81964c7).
    const meaningful = fresh.targets.filter(
      (tg) => !(tg.owner_type === 'thought' && tg.owner_id === homeId),
    );
    if (isLastChip(meaningful)) {
      const ok = await confirmDialog(t('diary.detachTitle'), t('diary.detachQuestion'), true);
      if (!ok) return;
    }
    const ownerType = target.kind === 'thought' ? 'thought' : 'link';
    const ownerId = target.kind === 'thought' ? target.thought.id : target.link.id;
    await etn.comments.removeTarget(networkId, rowId, ownerType, ownerId, fresh.version);
    // Снятие последнего чипса оставляет запись (сервер сам возвращает её в HOME
    // и поднимает в верхний блок) — лента перезагружается целиком.
    await reload();
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
      label: '+',
      role: 'ghost',
      size: 's',
      class: 'diary-chip-add',
      title: 'Привязать мысль',
      onClick: () => void addSlotChip(),
    }),
  );
  const body = div('diary-record-body');
  const widget = createMarkdownField({
    md: '',
    html: '',
    onSave: async (md) => {
      const created = await ensureSlot({ body: md });
      return created?.body_html ?? md;
    },
  });
  body.append(widget);

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
    // Временная мера до фикса ошибки 00115e7b: сервер требует непустой
    // `body_md`; при создании записи без текста (заголовок/чипс) шлём пробел.
    const created = await etn.comments.createMulti(networkId, targets, {
      kind: 'chronological',
      title: title.trim() || null,
      body_md: body.trim() === '' ? ' ' : body,
      valid_from: state.from,
      valid_to: state.from,
      use_time: false,
    });
    slot = null;
    state.root.remove();
    await reload();
    syncCalendar();
    return created;
  } catch (err) {
    notice(t('diary.createFailed', [errText(err)]), 'error');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Calendar wiring
// ---------------------------------------------------------------------------

/** Клик календаря = «Применить» с новым периодом (остальные критерии целы). */
async function pickPeriod(period: { from: string; to: string }): Promise<void> {
  // Период пишется в поля панели; прочие критерии не трогаются.
  setFilterState(applyPeriodToFilter(getFilterState(), period));
  persistState();
  await applyFilter();
}

/** Согласовать выделение календаря с полями периода (поля — источник дат). */
function syncCalendar(): void {
  if (calendar === null) return;
  const filter = getFilterState();
  calendar.setSelection(resolvePeriodDay(filter.dateFrom), resolvePeriodDay(filter.dateTo));
  month = calendar.getMonth();
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
    homePromise = findRootThought(requireNetworkId()).then((root) => {
      homeId = root.id;
      return root.id;
    });
  }
  return homePromise;
}
