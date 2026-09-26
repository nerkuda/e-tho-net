/**
 * «Хроника» workspace view (L20, 08-ui-spec.md §17).
 *
 * The third workspace view: a filter panel on top (four rows), the table of
 * chronological comments (С / По / Заголовок / Мысли·связи / Автор / Создан /
 * Изменён / Кратко, paged by 50), the bottom view/edit area (same as the
 * editor's «Хроника» tab, plus target chips). Thoughts opened here land in the
 * unified visit history (0.5.5) shared by every screen — the chronicle keeps no
 * history of its own anymore.
 *
 * The table is the unit facade `lib/ui/table.ts` in cell mode (`nav: 'cell'`):
 * ↑/↓ move between rows, ←/→ between columns and, inside a column, between its
 * focusable elements (chips), Tab moves to the next column, Enter activates the
 * focused chip. Thought chips are drag sources; drops land on a row (attach),
 * on the table head/empty space (new comment) or on the filter panel (add to
 * «мысли»). Sorting is controlled by the facade (`defaultSort` +
 * `sortMode: 'toggle'`: Создан/Изменён cycle desc↔asc with the vendor header
 * marker). The custom table markup (`<table>`, arrow handlers, cursor repaint,
 * local sort) was removed with the Z5 translation — the guard
 * `tests/guard-ui-tables.test.ts` no longer allows this file.
 */

import {
  CHRONICLE_PAGE_SIZE,
  UI_STATE_KEY,
  type ChronicleRow,
  type ChronicleTarget,
  type Comment,
  type CommentTarget,
  type Link,
  type ThoughtRef,
} from '@etn/shared';
import { t } from '../../lib/i18n.js';

import { findRootThought, requireNetworkId } from '../../app.js';
import { pickThoughtsDialog, pickedThoughtIds } from '../../canvas/add-dialog.js';
// Чипы мыслей в таблице и в редакторе собирает общая фабрика облачка
// (профиль `chip`): значок, цвета, начертание, бледность, метка корзины.
import { createThoughtCloud } from '../../lib/thought-cloud.js';
import { wireExternalDragSource, registerDropActions } from '../../canvas/drag-cloud.js';
import { openLinkInEditor, setThoughtEditorTarget } from '../../editor/editor.js';
import { applyGroupClamp } from '../../editor/list-heights.js';
import { createMarkdownField, editMarkdownField } from '../../editor/markdown-field.js';
import { rowSplitter } from '../../editor/splitter.js';
import { commentShell } from '../../lib/ui/comment.js';
import { mountFilterPanelFrame } from '../../lib/filter-panel-frame.js';
import { confirmDialog } from '../../lib/dialog.js';
import { div, el, errText, fmtDate, renderHtml, span } from '../../lib/dom.js';
import { operationError } from '../../lib/ui/messages.js';
import { splitterElement } from '../../lib/ui/splitter.js';
import {
  createTable,
  TABLE_FOCUSABLE_CLASS,
  type TableColumn,
  type TableHandle,
} from '../../lib/ui/table.js';
import { etn } from '../../lib/etn.js';
import { formatDateTime, renderAuthorPair } from '../../lib/metadata.js';
import { markCommentPreview, markThoughtCommentPreview } from '../../lib/hover-preview.js';
import { menuAction, showMenuAt, MENU_SEPARATOR, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import { addToSelection, toggleSelection } from '../../selection/selection.js';
import { store } from '../../state.js';
import {
  addThoughtToFilter,
  getFilterState,
  getSavedFilterId,
  mountChronicleFilterPanel,
  setFilterState,
  setSavedFilterId,
  wireChronicleApplyShortcut,
} from './filter-panel.js';
import { parseChronicleState } from './state.js';
import { uiButton } from '../../lib/ui/button.js';
import { fieldInput } from '../../lib/ui/field.js';
// Критерии отбора «Хроники» читает и пишет единый конструктор
// (`lib/filter-builder.ts`) — собственных парсера и конвертера у экрана нет.
import {
  buildChronicleWire as toDefinition,
  parseChronicleCriteria as fromDefinition,
} from '../../lib/filter-builder.js';

/**
 * Границы размера панели отбора «Хроники» (задача 2ebe4206): слева — ширина,
 * вверху (узкое полотно) — высота. Прежний сплиттер высоты тянулся от 80 px;
 * ширину панель раньше не имела вовсе.
 */
const CHRONICLE_FILTER_MIN_W = 230;
const CHRONICLE_FILTER_MAX_W = 480;

let host: HTMLElement | null = null;
/** Composite cache key of the last init: `${networkId}:${tabId}` so the
 *  view re-initialises when EITHER the network or the active tab changes
 *  (per-tab filter snapshot, Q4). `null` until the first call. */
let networkIdSeen: string | null = null;

// ---------------------------------------------------------------------------
// Table state
// ---------------------------------------------------------------------------

let rows: ChronicleRow[] = [];
let total = 0;
let offset = 0;
/** Id of the selected row. */
let selectedRowId: string | null = null;
/** Fresh-comment mode: `null` — show the selected comment; preset targets otherwise. */
let newTargets: CommentTarget[] | null = null;
let tableWrap: HTMLElement | null = null;
/** Статус таблицы (загрузка/ошибка) — сосед таблицы внутри стабильной обёртки. */
let tableStatus: HTMLElement | null = null;
let editorArea: HTMLElement | null = null;
let pagerLabel: HTMLElement | null = null;
/** Единая таблица записей — фасад `lib/ui/table.ts` в режиме ячеек. */
let table: TableHandle<ChronicleRow> | null = null;
/** Loading guard so the table does not flicker with stale data. */
let querySeq = 0;

// ---------------------------------------------------------------------------
// Mount / init
// ---------------------------------------------------------------------------

/** Switches to the chronicle view — lazily loads persisted state (L4). */
export async function ensureChronicleInitialised(): Promise<void> {
  const networkId = store.state.networkId;
  const tabId = store.state.activeTabId;
  if (networkId === null || host === null) return;
  // Q-bugfix: cache key includes the active tab so switching tabs (same
  // network, different snapshot) re-reads `tab.chronicle_state` instead of
  // serving the previous tab's filter.
  const key = `${networkId}:${tabId ?? ''}`;
  if (networkIdSeen === key) return;
  networkIdSeen = key;

  rows = [];
  total = 0;
  offset = 0;
  selectedRowId = null;
  newTargets = null;

  // Q4: prefer per-tab persisted state, fall back to legacy ui_state.
  try {
    let raw: string | null = null;
    if (tabId !== null) {
      const tab = store.state.tabs.find((t) => t.tab_id === tabId);
      raw = tab?.chronicle_state ?? null;
    }
    if (raw === null) {
      raw = await etn.ui.getState(networkId, UI_STATE_KEY.CHRONICLE_STATE);
    }
    if (raw !== null && raw !== '') {
      const parsed = parseChronicleState(raw);
      setFilterState(fromDefinition(parsed.filter));
      offset = parsed.offset;
      setSavedFilterId(parsed.savedFilterId);
    }
  } catch {
    // Fall back to the empty filter.
  }
  await applyQuery(false);
}

/** Persists the current filter + page to L4 (per-tab, Q4). */
function persistState(): void {
  const tabId = store.state.activeTabId;
  if (tabId === null) return;
  void etn.tabs
    .updateState(tabId, {
      chronicle_state: JSON.stringify({
        filter: toDefinition(getFilterState()),
        offset,
        savedFilterId: getSavedFilterId(),
      }),
    })
    .catch(() => undefined);
}

/** Builds and mounts the whole chronicle view into its host. */
export function mountChronicle(hostEl: HTMLElement): void {
  host = hostEl;
  hostEl.replaceChildren();

  const filterArea = div('chron-filter-area');
  // Размер и скрытость панели отбора ведёт общий каркас (задача 2ebe4206):
  // положение по ширине полотна (слева/вверху), перетаскивание границы —
  // ширина слева, высота вверху; состояние — `ui_state.chronicle_filter_panel`.
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

  mountChronicleFilterPanel(filterArea, { apply: () => void applyQuery(true) });

  const top = div('chron-top');
  const wrap = div('admin-table-wrap chron-table-wrap');
  tableWrap = wrap;
  // Единая таблица строится один раз при монтировании; обновление данных —
  // `setRows`, поэтому обёртка и сам элемент таблицы не пересобираются
  // (высота, вытянутая сплиттером, не теряется).
  tableStatus = div('muted');
  tableStatus.hidden = true;
  table = buildTable();
  table.element.classList.add('chron-table');
  wrap.append(tableStatus, table.element);
  const pager = div('chron-pager');
  pagerLabel = span('', 'muted');
  pager.append(
    uiButton({
      label: '≪',
      role: 'secondary',
      size: 's',
      onClick: () => gotoPage(0),
    }),
    uiButton({
      label: '‹',
      role: 'secondary',
      size: 's',
      onClick: () => gotoPage(offset - CHRONICLE_PAGE_SIZE),
    }),
    pagerLabel,
    uiButton({
      label: '›',
      role: 'secondary',
      size: 's',
      onClick: () => gotoPage(offset + CHRONICLE_PAGE_SIZE),
    }),
    uiButton({
      label: '≫',
      role: 'secondary',
      size: 's',
      onClick: () => gotoPage(Math.floor((total - 1) / CHRONICLE_PAGE_SIZE) * CHRONICLE_PAGE_SIZE),
    }),
  );
  top.append(wrap, pager);
  editorArea = div('chron-editor');

  // The drag is remembered as the table's exact fixed height (ee745368, L4
  // `chronicle_list_heights`); it is applied inline — the wrap element is
  // stable for the whole mount, only rows are re-rendered inside it.
  applyGroupClamp(wrap, 'chronicle.table');
  main.append(
    top,
    rowSplitter(() => wrap, {
      min: 48,
      persistKey: 'chronicle.table',
    }),
    editorArea,
  );

  wireChronicleApplyShortcut(hostEl);
  registerDropActions({
    chronicleAttach: (thoughtId, rowId) => void attachThoughtToRow(thoughtId, rowId),
    chronicleNewEntry: (thoughtId) => startNew([{ owner_type: 'thought', owner_id: thoughtId }]),
    chronicleFilterAdd: (thoughtId) => addThoughtToFilter(thoughtId),
  });
  showEmptyEditor();

  // Restore the view when the network opens with `active_view = 'chronicle'`
  // (the switcher path calls ensureChronicleInitialised directly, L20).
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
// Query
// ---------------------------------------------------------------------------

/** Runs the chronicle query. With `reset` the pager jumps to the first page. */
async function applyQuery(reset: boolean): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || tableWrap === null) return;
  if (reset) {
    offset = 0;
  }
  persistState();

  const seq = ++querySeq;
  renderLoading();
  try {
    const result = await etn.chronicle.query(networkId, {
      ...toDefinition(getFilterState()),
      limit: CHRONICLE_PAGE_SIZE,
      offset,
    });
    if (seq !== querySeq) return;
    rows = result.rows;
    total = result.total;
    if (selectedRowId !== null && !rows.some((r) => r.id === selectedRowId)) {
      selectedRowId = null;
      newTargets = null;
      showEmptyEditor();
    }
    renderTable();
  } catch (err) {
    if (seq !== querySeq) return;
    renderError(err);
  }
}

/** Re-fetches the page and keeps the selection alive where possible. */
export function scheduleChronicleRefresh(): void {
  void applyQuery(false);
}

/** The thought disappeared — refresh the table if it is visible in any row. */
export function invalidateChronicleThought(id: string): void {
  if (host === null) return;
  if (rows.some((r) => r.targets.some((t) => t.kind === 'thought' && t.thought.id === id))) {
    scheduleChronicleRefresh();
  }
}

function renderLoading(): void {
  if (tableStatus === null || table === null) return;
  tableStatus.hidden = false;
  tableStatus.textContent = t('common.loading');
  table.element.hidden = true;
}

function renderError(err: unknown): void {
  if (tableStatus === null || table === null) return;
  tableStatus.hidden = false;
  tableStatus.replaceChildren(operationError(err));
  table.element.hidden = true;
}

/** Показывает таблицу (снимает статус загрузки/ошибки). */
function showTable(): void {
  if (tableStatus === null || table === null) return;
  tableStatus.hidden = true;
  table.element.hidden = false;
}

function gotoPage(next: number): void {
  const last = Math.max(0, Math.floor((total - 1) / CHRONICLE_PAGE_SIZE) * CHRONICLE_PAGE_SIZE);
  const clamped = Math.max(0, Math.min(next, last));
  if (clamped === offset && rows.length > 0) return;
  offset = clamped;
  void applyQuery(false);
}

// ---------------------------------------------------------------------------
// Table (фасад `lib/ui/table.ts`, режим ячеек)
// ---------------------------------------------------------------------------

/** Единая таблица записей: колонки §17, сортировка по датам, DnD чипов. */
function buildTable(): TableHandle<ChronicleRow> {
  table?.destroy();
  return createTable<ChronicleRow>({
    columns: chronicleColumns(),
    rows: [],
    rowKey: (row) => row.id,
    emptyText: t('chrono.empty'),
    emptyHint: t('chrono.emptyHint'),
    ariaLabel: t('chrono.aria'),
    // Клавиатура §17: строки (↑/↓) + колонки и чипы (←/→, Tab), Enter — чип.
    nav: 'cell',
    // Сортировка §17: Создан/Изменён, цикл desc↔asc, по умолчанию Создан DESC.
    sortMode: 'toggle',
    defaultSort: { key: 'created_at', dir: 'desc' },
    current: selectedRowId,
    // Текущую строку подсвечивает фасад; смена текущей строки грузит запись в
    // нижнюю область (замена собственного обработчика стрелок из §17).
    onCurrentChange: (_key, row) => {
      if (row !== null) selectRow(row);
    },
    rowMenu: (row) => rowMenuItems(row.id),
  });
}

/** Колонки таблицы хроники (§17 + авторы и даты, требование 9ef6d037). */
function chronicleColumns(): TableColumn<ChronicleRow>[] {
  return [
    {
      key: 'valid_from',
      header: t('chrono.col.from'),
      width: '7rem',
      text: (row) => fmtDate(row.valid_from),
      render: (row) => dateCell(fmtDate(row.valid_from), beyondFrom(row)),
    },
    {
      key: 'valid_to',
      header: t('chrono.col.to'),
      width: '7rem',
      text: (row) => (row.valid_to === null ? '…' : fmtDate(row.valid_to)),
      render: (row) => dateCell(row.valid_to === null ? '…' : fmtDate(row.valid_to), beyondTo(row)),
    },
    {
      key: 'title',
      header: t('chrono.col.title'),
      width: '14rem',
      text: (row) => row.title ?? '—',
      render: (row) => box('chron-title', span(row.title ?? '—')),
    },
    {
      key: 'targets',
      header: t('chrono.col.targets'),
      text: (row) => targetsText(row.targets),
      render: (row) => targetsCell(row),
    },
    {
      key: 'author',
      header: t('chrono.col.author'),
      width: '10rem',
      text: (row) => row.created_by,
      render: (row) =>
        box(
          'author-cell',
          renderAuthorPair(row.created_by, row.updated_by, row.updated_at, row.created_at),
        ),
    },
    {
      key: 'created_at',
      header: t('chrono.col.created'),
      width: '11rem',
      sortable: true,
      defaultSortDir: 'desc',
      sortValue: (row) => parseTime(row.created_at),
      text: (row) => formatDateTime(row.created_at),
      render: (row) => box('date-cell', span(formatDateTime(row.created_at))),
    },
    {
      key: 'updated_at',
      header: t('chrono.col.updated'),
      width: '11rem',
      sortable: true,
      defaultSortDir: 'desc',
      sortValue: (row) => parseTime(row.updated_at),
      text: (row) => formatDateTime(row.updated_at),
      render: (row) => box('date-cell', span(formatDateTime(row.updated_at))),
    },
    {
      key: 'snippet',
      header: t('chrono.col.snippet'),
      text: (row) => row.snippet,
      render: (row) => {
        const cell = div('chron-snippet');
        renderHtml(cell, row.snippet);
        return cell;
      },
    },
  ];
}

/** Дата с приглушением, если она за пределами периода отбора (§17). */
function dateCell(text: string, muted: boolean): HTMLElement {
  const cell = div(muted ? 'chron-date muted' : 'chron-date');
  cell.append(span(text));
  return cell;
}

function box(cls: string, content: Node): HTMLElement {
  const cell = div(cls);
  cell.append(content);
  return cell;
}

/** «с» серым, если начало за пределами периода. */
function beyondFrom(row: ChronicleRow): boolean {
  const filter = getFilterState();
  return filter.dateFrom !== '' && row.valid_from < filter.dateFrom;
}

/** «по» серым, если конец за пределами периода или запись открыта. */
function beyondTo(row: ChronicleRow): boolean {
  const filter = getFilterState();
  return filter.dateTo !== '' && (row.valid_to === null || row.valid_to > filter.dateTo);
}

/** Миллисекундная метка даты (для сортировки ленты, требование 9ef6d037). */
function parseTime(value: string): number {
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

function renderTable(): void {
  if (table === null || pagerLabel === null) return;
  showTable();
  table.setRows(rows);
  table.setCurrent(selectedRowId);
  repaintPager();
}

function repaintPager(): void {
  if (pagerLabel === null) return;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + rows.length, total);
  pagerLabel.textContent = t('chrono.pager.range', [from, to, total]);
}

/** The «source — тип — target» heading used for link previews (a link has no
 *  title of its own — the same composite the chip itself displays; the canvas
 *  link popover uses the analogous `bundleTypeNames`). */
function linkChipTitle(sourceTitle: string, typeForward: string | null, targetTitle: string): string {
  return typeForward === null
    ? `${sourceTitle} — ${targetTitle}`
    : `${sourceTitle} — ${typeForward} — ${targetTitle}`;
}

/** Текст привязок колонки для копирования (TSV). */
function targetsText(targets: ChronicleTarget[]): string {
  return targets
    .map((target) =>
      target.kind === 'thought'
        ? target.thought.title
        : linkChipTitle(
            target.link.source.title,
            target.link.type_name_forward,
            target.link.target.title,
          ),
    )
    .join(', ');
}

/** Ячейка «мысли/связи»: чипы привязок (фокусируемые элементы ячейки). */
function targetsCell(row: ChronicleRow): HTMLElement {
  const cell = div('chron-targets');
  for (const chip of buildTargetChips(row.targets, row.id)) cell.append(chip);
  return cell;
}

/** Builds the chip list of the «мысли/связи» column. */
function buildTargetChips(targets: ChronicleTarget[], rowId: string): HTMLElement[] {
  return targets.map((target) => {
    if (target.kind === 'thought') {
      const chip = thoughtChip(target.thought);
      // Фокусируемый элемент ячейки: фасад ходит по нему ←/→ и активирует Enter,
      // проставляя подсветку (режим `nav: 'cell'`).
      chip.classList.add(TABLE_FOCUSABLE_CLASS);
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        void openChronicleThought(target.thought.id);
      });
      chip.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTargetMenu(e.clientX, e.clientY, rowId, 'thought', target.thought.id);
      });
      wireExternalDragSource(chip, target.thought.id, 'chronicle');
      return chip;
    }
    const chip = el('span', 'chron-chip link');
    chip.classList.add(TABLE_FOCUSABLE_CLASS);
    const title = linkChipTitle(
      target.link.source.title,
      target.link.type_name_forward,
      target.link.target.title,
    );
    chip.append(
      span('🔗', 'chip-icon'),
      span(target.link.source.title, 'chip-title'),
      span(
        target.link.type_name_forward === null ? ' — ' : ` — ${target.link.type_name_forward} — `,
        'chip-type muted',
      ),
      span(target.link.target.title, 'chip-title'),
    );
    // Ctrl+hover on a link chip previews its permanent comment (preview stage
    // 3, same marking as the canvas link popover's 📝 indicator).
    markCommentPreview(chip, 'link', target.link.id, title);
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      void openChronicleLinkById(target.link.id);
    });
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showTargetMenu(e.clientX, e.clientY, rowId, 'link', target.link.id);
    });
    return chip;
  });
}

/** A styled thought chip (icon + title), shared with the editor area. */
export function thoughtChip(ref: ThoughtRef): HTMLElement {
  // Мини-облачко собирает общая фабрика: разметка, значок (своя иконка, иначе
  // типовая по цепочке, иначе 💭), цвета и начертание, бледность неактуальной,
  // метка корзины у помеченной; обрезка названия — раскладкой с подсказкой.
  // Класс `chron-chip thought` — стиль строки-чипа (навигацию ведёт фасад по
  // `ui-table-focusable`).
  const chip = createThoughtCloud(ref, { profile: 'chip' });
  chip.classList.add('chron-chip', 'thought');
  // Ctrl+hover on a thought chip shows its permanent comment (preview stage 3).
  markThoughtCommentPreview(chip, ref.id, ref.title);
  return chip;
}

// ---------------------------------------------------------------------------
// Row selection & the bottom editor
// ---------------------------------------------------------------------------

function selectRow(row: ChronicleRow): void {
  selectedRowId = row.id;
  newTargets = null;
  void (async () => {
    const networkId = requireNetworkId();
    try {
      const comment = await etn.comments.get(networkId, row.id);
      if (selectedRowId !== row.id) return;
      buildEditor(comment);
    } catch (err) {
      notice(`Не удалось загрузить комментарий: ${errText(err)}`, 'error');
    }
  })();
}

/** Shows an empty editor area — nothing is selected yet (§17). */
function showEmptyEditor(): void {
  if (editorArea === null) return;
  selectedRowId = null;
  newTargets = null;
  table?.setCurrent(null);
  const shell = commentShell({
    variant: 'fill',
    state: { kind: 'empty', text: 'Выберите запись из таблицы или добавьте новую.' },
  });
  editorArea.replaceChildren(shell.root);
}

/** Local today in YYYY-MM-DD (input[type=date] format). */
function todayIso(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** State of the comment being edited in the bottom area (null = not built). */
let editorState: { commentId: string | null; version: number; targets: CommentTarget[] } | null = null;
/** Root of the editor's target chips (refreshed in place on attach/detach). */
let editorTargetsBox: HTMLElement | null = null;

/**
 * Builds the bottom editor: metadata row + target chips + markdown field.
 * `existing === null` starts a fresh comment (created on the first non-empty
 * blur); its attachments come from `newTargets` or, when absent, from the
 * filter's «мысли» (without subordinates), falling back to HOME.
 */
function buildEditor(existing: Comment | null, startEdit = false): void {
  if (editorArea === null) return;
  const networkId = requireNetworkId();
  const titleInput = fieldInput({ extraClass: 'chrono-meta-input' });
  titleInput.type = 'text';
  titleInput.value = existing?.title ?? '';
  titleInput.maxLength = 200;
  titleInput.placeholder = 'Заголовок';
  const fromInput = fieldInput({ extraClass: 'chrono-meta-input' });
  fromInput.type = 'date';
  fromInput.value = existing?.valid_from.slice(0, 10) ?? todayIso();
  const toInput = fieldInput({ extraClass: 'chrono-meta-input' });
  toInput.type = 'date';
  toInput.value = existing?.valid_to?.slice(0, 10) ?? '';

  editorState = {
    commentId: existing?.id ?? null,
    version: existing?.version ?? 0,
    targets: existing?.targets ?? newTargets ?? [],
  };

  const metaRow = div('chrono-meta-row');
  metaRow.append(titleInput, fromInput, toInput);
  if (existing !== null) {
    metaRow.append(
      uiButton({
        label: t('actions.delete'),
        role: 'danger',
        size: 's',
        title: 'Удалить хронологический комментарий',
        onClick: () => void removeComment(existing),
      }),
    );
  }

  /** Saves the metadata fields of an existing comment. */
  const commitMeta = (): void => {
    const s = editorState;
    if (s === null || s.commentId === null) return;
    void (async () => {
      try {
        const updated = await etn.comments.update(
          networkId,
          s.commentId!,
          {
            title: titleInput.value.trim() || null,
            valid_from: fromInput.value,
            valid_to: toInput.value === '' ? null : toInput.value,
          },
          s.version,
        );
        s.version = updated.version;
        scheduleChronicleRefresh();
      } catch (err) {
        notice(`Не удалось сохранить: ${errText(err)}`, 'error');
      }
    })();
  };
  titleInput.addEventListener('blur', commitMeta);
  fromInput.addEventListener('blur', commitMeta);
  toInput.addEventListener('blur', commitMeta);

  editorTargetsBox = div('chron-target-chips');
  repaintEditorTargets();

  // Оболочка комментария: панель действий — метаданные и чипы целей, тело —
  // встроенное поле markdown, режим зеркалится в `data-mode` (задача 9cb87c42).
  const shell = commentShell({
    variant: 'fill',
    tools: [metaRow, editorTargetsBox],
  });

  const widget = createMarkdownField({
    md: existing?.body_md ?? '',
    html: existing?.body_html ?? '',
    // L24: a record's own thought target is never offered as an auto-mention
    // (its name/synonyms are not underlined in the record text). A getter —
    // targets change after the first save / attach / detach, and the field
    // re-renders the view without being rebuilt.
    getMentionsExcludeThoughtId: () =>
      editorState?.targets.find((t) => t.owner_type === 'thought')?.owner_id,
    onSave: async (md) => {
      const s = editorState;
      if (s === null) return '';
      if (md.trim() === '' && s.commentId === null) return '';
      let html: string;
      if (s.commentId === null) {
        // First non-empty blur creates the comment. Default attachment: the
        // filter's «мысли» (without subordinates), else the HOME thought.
        let targets = s.targets;
        if (targets.length === 0) {
          const filter = getFilterState();
          if (filter.thoughtIds.length > 0) {
            targets = filter.thoughtIds.map((id) => ({ owner_type: 'thought' as const, owner_id: id }));
          } else {
            const home = await findRootThought(networkId);
            targets = [{ owner_type: 'thought', owner_id: home.id }];
          }
        }
        const created = await etn.comments.createMulti(networkId, targets, {
          kind: 'chronological',
          title: titleInput.value.trim() || null,
          body_md: md,
          valid_from: fromInput.value,
          valid_to: toInput.value === '' ? null : toInput.value,
        });
        s.commentId = created.id;
        s.version = created.version;
        s.targets = created.targets;
        selectedRowId = created.id;
        repaintEditorTargets();
        html = created.body_html;
      } else {
        const updated = await etn.comments.update(networkId, s.commentId, { body_md: md }, s.version);
        s.version = updated.version;
        html = updated.body_html;
      }
      scheduleChronicleRefresh();
      return html;
    },
    onEditChange: (editing) => shell.setMode(editing ? 'edit' : 'view'),
  });

  shell.setField(widget);
  shell.setState({ kind: 'ready' });
  editorArea.replaceChildren(shell.root);
  if (startEdit) editMarkdownField(widget);
}

/** Repaints the attachment chips of the bottom editor (reads `editorState`). */
function repaintEditorTargets(): void {
  if (editorTargetsBox === null) return;
  const s = editorState;
  if (s === null) return;
  editorTargetsBox.replaceChildren();
  for (const target of s.targets) {
    const chip =
      target.owner_type === 'thought' ? thoughtChipForId(target.owner_id) : linkChipForId(target.owner_id);
    chip.classList.add('chron-chip');
    chip.addEventListener('click', () => {
      if (target.owner_type === 'thought') void openChronicleThought(target.owner_id);
      else void openChronicleLinkById(target.owner_id);
    });
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showEditorTargetMenu(e.clientX, e.clientY, target);
    });
    editorTargetsBox!.append(chip);
  }
  if (s.targets.length === 0) {
    editorTargetsBox.append(span('Привязок нет — при создании будет привязана мысль из отбора или начальная мысль.', 'muted'));
  }
}

/** A thought chip of the editor area, resolved by id. */
function thoughtChipForId(id: string): HTMLElement {
  const chip = el('span', 'chron-chip thought');
  chip.dataset['id'] = id;
  chip.append(span('💭', 'chip-icon'), span(id, 'chip-title'));
  void etn.thoughts
    .resolve(requireNetworkId(), [id])
    .then((refs) => {
      const ref = refs[0];
      if (ref === undefined || !chip.isConnected) return;
      const styled = thoughtChip(ref);
      chip.replaceChildren(...Array.from(styled.children));
      chip.dataset['id'] = ref.id;
      // The resolve copies only the children — re-mark the Ctrl-hover preview
      // that `thoughtChip` put on the styled chip's dataset.
      markThoughtCommentPreview(chip, ref.id, ref.title);
    })
    .catch(() => undefined);
  return chip;
}

/** A link chip of the editor area, resolved by id. */
function linkChipForId(id: string): HTMLElement {
  const chip = el('span', 'chron-chip link');
  chip.append(span('🔗', 'chip-icon'), span(id, 'chip-title'));
  void (async () => {
    try {
      const link = await etn.links.get(requireNetworkId(), id);
      if (!chip.isConnected) return;
      const refs = await etn.thoughts.resolve(requireNetworkId(), [link.source_id, link.target_id]);
      const src = refs.find((r) => r.id === link.source_id);
      const dst = refs.find((r) => r.id === link.target_id);
      if (src === undefined || dst === undefined) return;
      const typeName = link.type_id === null
        ? null
        : store.state.linkTypes.find((t) => t.id === link.type_id)?.name_forward ?? null;
      chip.replaceChildren(
        span('🔗', 'chip-icon'),
        span(src.title, 'chip-title'),
        span(typeName === null ? ' — ' : ` — ${typeName} — `, 'chip-type muted'),
        span(dst.title, 'chip-title'),
      );
      // Ctrl+hover previews the link's permanent comment (same as the table's
      // link chips — the raw-id placeholder stays unmarked).
      markCommentPreview(chip, 'link', id, linkChipTitle(src.title, typeName, dst.title));
    } catch {
      // The chip falls back to the raw id.
    }
  })();
  return chip;
}

/** Deletes the selected comment (confirmation). */
async function removeComment(existing: Comment): Promise<void> {
  const ok = await confirmDialog('Удалить комментарий', 'Удалить хронологический комментарий?', true);
  if (!ok) return;
  const networkId = requireNetworkId();
  try {
    const fresh = await etn.comments.get(networkId, existing.id);
    await etn.comments.remove(networkId, fresh.id, fresh.version);
    if (selectedRowId === existing.id) {
      selectedRowId = null;
      editorState = null;
      showEmptyEditor();
    }
    await applyQuery(false);
  } catch (err) {
    notice(`Не удалось удалить: ${errText(err)}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Row context menu (Добавить / Копировать / Удалить)
// ---------------------------------------------------------------------------

/** Пункты контекстного меню строки (Добавить / Копировать / Удалить). */
function rowMenuItems(rowId: string): MenuItem[] {
  return [
    menuAction(t('chrono.menu.add'), () => void startNewFromFilter()),
    menuAction(t('chrono.menu.copy'), () => void copyComment(rowId)),
    MENU_SEPARATOR,
    menuAction(
      t('actions.delete'),
      () =>
        void (async () => {
          const fresh = await etn.comments.get(requireNetworkId(), rowId);
          await removeComment(fresh);
        })(),
      { danger: true },
    ),
  ];
}

/** Starts a fresh comment whose attachments default to the filter's «мысли». */
async function startNewFromFilter(): Promise<void> {
  const filter = getFilterState();
  let targets: CommentTarget[];
  if (filter.thoughtIds.length > 0) {
    targets = filter.thoughtIds.map((id) => ({ owner_type: 'thought' as const, owner_id: id }));
  } else {
    const home = await findRootThought(requireNetworkId());
    targets = [{ owner_type: 'thought', owner_id: home.id }];
  }
  startNew(targets);
}

/** Starts a fresh comment with the given preset attachments. */
function startNew(targets: CommentTarget[]): void {
  selectedRowId = null;
  newTargets = targets;
  table?.setCurrent(null);
  buildEditor(null, true);
}

/** Copies the comment (targets + title + body; dates = today). */
async function copyComment(id: string): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const source = await etn.comments.get(networkId, id);
    const created = await etn.comments.createMulti(networkId, source.targets, {
      kind: 'chronological',
      title: source.title,
      body_md: source.body_md,
      valid_from: todayIso(),
      valid_to: todayIso(),
    });
    selectedRowId = created.id;
    newTargets = null;
    await applyQuery(false);
    buildEditor(created);
  } catch (err) {
    notice(`Не удалось скопировать: ${errText(err)}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Target (chip) menus
// ---------------------------------------------------------------------------

/** Context menu of a table-column chip. */
function showTargetMenu(
  x: number,
  y: number,
  rowId: string,
  ownerType: 'thought' | 'link',
  ownerId: string,
): void {
  const items: MenuItem[] = [
    menuAction(t('chrono.menu.open'), () => {
      if (ownerType === 'thought') void openChronicleThought(ownerId);
      else void openChronicleLinkById(ownerId);
    }),
  ];
  if (ownerType === 'thought') {
    items.push(
      menuAction(t('selection.add'), () => addToSelection([ownerId])),
      menuAction(t('selection.remove'), () => toggleSelection([ownerId])),
    );
  }
  items.push(
    MENU_SEPARATOR,
    menuAction(t('chrono.menu.detach'), () => void detachTarget(rowId, ownerType, ownerId)),
    menuAction(t('chrono.menu.attach'), () => void attachPickedThought(rowId)),
  );
  showMenuAt(x, y, items);
}

/** Context menu of an editor-area chip. */
function showEditorTargetMenu(x: number, y: number, target: CommentTarget): void {
  const s = editorState;
  if (s === null || s.commentId === null) return;
  const items: MenuItem[] = [
    menuAction(t('chrono.menu.open'), () => {
      if (target.owner_type === 'thought') void openChronicleThought(target.owner_id);
      else void openChronicleLinkById(target.owner_id);
    }),
  ];
  if (target.owner_type === 'thought') {
    items.push(
      menuAction(t('selection.add'), () => addToSelection([target.owner_id])),
      menuAction(t('selection.remove'), () => toggleSelection([target.owner_id])),
    );
  }
  items.push(
    MENU_SEPARATOR,
    menuAction(t('chrono.menu.detach'), () =>
      void (async () => {
        try {
          const updated = await etn.comments.removeTarget(
            requireNetworkId(),
            s.commentId!,
            target.owner_type,
            target.owner_id,
            s.version,
          );
          s.version = updated.version;
          s.targets = updated.targets;
          repaintEditorTargets();
          scheduleChronicleRefresh();
        } catch (err) {
          notice(`Не удалось отвязать: ${errText(err)}`, 'error');
        }
      })(),
    ),
    menuAction(t('chrono.menu.attach'), () =>
      void (async () => {
        const result = await pickThoughtsDialog({
          networkId: requireNetworkId(),
          allowCreate: false,
          allowLinkType: false,
        });
        if (result === null || s.commentId === null) return;
        let attached = 0;
        for (const id of pickedThoughtIds(result)) {
          if (s.targets.some((t) => t.owner_type === 'thought' && t.owner_id === id)) continue;
          try {
            const updated = await etn.comments.addTarget(
              requireNetworkId(),
              s.commentId,
              'thought',
              id,
              s.version,
            );
            s.version = updated.version;
            s.targets = updated.targets;
            attached++;
          } catch (err) {
            notice(`Не удалось привязать: ${errText(err)}`, 'error');
          }
        }
        if (attached === 0) notice('Мысли уже привязаны к этой записи.', 'info');
        repaintEditorTargets();
        scheduleChronicleRefresh();
      })(),
    ),
  );
  showMenuAt(x, y, items);
}

/** Detaches one target of a table row (auto-re-attach to HOME on the server). */
async function detachTarget(rowId: string, ownerType: 'thought' | 'link', ownerId: string): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const fresh = await etn.comments.get(networkId, rowId);
    await etn.comments.removeTarget(networkId, rowId, ownerType, ownerId, fresh.version);
    if (selectedRowId === rowId) {
      const updated = await etn.comments.get(networkId, rowId);
      if (editorState !== null && editorState.commentId === rowId) {
        editorState.version = updated.version;
        editorState.targets = updated.targets;
        repaintEditorTargets();
      }
    }
    await applyQuery(false);
  } catch (err) {
    notice(`Не удалось отвязать: ${errText(err)}`, 'error');
  }
}

/** Attaches picked thoughts to the row's comment (drop target / picker). */
async function attachPickedThought(rowId: string): Promise<void> {
  const result = await pickThoughtsDialog({
    networkId: requireNetworkId(),
    allowCreate: false,
    allowLinkType: false,
  });
  if (result === null) return;
  for (const id of pickedThoughtIds(result)) await attachThoughtToRow(id, rowId);
}

/** Attaches a thought to the row's comment (drop target / picker). */
async function attachThoughtToRow(thoughtId: string, rowId: string): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const fresh = await etn.comments.get(networkId, rowId);
    if (fresh.targets.some((t) => t.owner_type === 'thought' && t.owner_id === thoughtId)) {
      notice('Мысль уже привязана к этой записи.', 'info');
      return;
    }
    await etn.comments.addTarget(networkId, rowId, 'thought', thoughtId, fresh.version);
    if (selectedRowId === rowId) {
      const updated = await etn.comments.get(networkId, rowId);
      if (editorState !== null && editorState.commentId === rowId) {
        editorState.version = updated.version;
        editorState.targets = updated.targets;
        repaintEditorTargets();
      }
    }
    await applyQuery(false);
  } catch (err) {
    notice(`Не удалось привязать мысль: ${errText(err)}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Opening entities from the chronicle view (editor + history)
// ---------------------------------------------------------------------------

/** Opens a thought in the editor (the canvas focus stays) and records it in
 *  the unified visit history (0.5.5). The full entity rides along in the
 *  store (`structuresActiveThought*`) — without the passenger the editor
 *  falls back to the focused thought (same mechanism as the structures view,
 *  L15). */
export async function openChronicleThought(id: string): Promise<void> {
  const networkId = requireNetworkId();
  const thought = await etn.thoughts.get(networkId, id);
  await setThoughtEditorTarget(thought);
}

/** Opens a link in the editor (a link is not a thought — it does not enter
 *  the visit history). */
export async function openChronicleLink(link: Link): Promise<void> {
  openLinkInEditor(link);
}

/** Resolves and opens a link by id (from chips / history entries). */
export async function openChronicleLinkById(id: string): Promise<void> {
  const link = await etn.links.get(requireNetworkId(), id);
  await openChronicleLink(link);
}
