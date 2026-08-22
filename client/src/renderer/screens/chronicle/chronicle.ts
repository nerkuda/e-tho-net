/**
 * «Хроника» workspace view (L20, 08-ui-spec.md §17).
 *
 * The third workspace view: a filter panel on top (four rows), the table of
 * chronological comments (С / По / Заголовок / Мысли·связи / Кратко, paged by
 * 50), the bottom view/edit area (same as the editor's «Хроника» tab, plus
 * target chips) and its own visit history (thoughts AND links, L4
 * `chronicle_history`).
 *
 * The table is keyboard-navigable: ↑/↓ move between rows, ←/→ between
 * columns (inside the «мысли/связи» column — between chips), Tab skips to the
 * next column, Enter opens the focused chip. Thought chips are drag sources;
 * drops land on a row (attach), on the table head/empty space (new comment)
 * or on the filter panel (add to «мысли»).
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

import { findRootThought, requireNetworkId } from '../../app.js';
import { pickThoughtsDialog, pickedThoughtIds } from '../../canvas/add-dialog.js';
import { applyCloudStyle, applyThoughtIcon, resolveCloudStyle } from '../../canvas/canvas.js';
import { wireExternalDragSource, registerDropActions } from '../../canvas/drag-cloud.js';
import { openLinkInEditor } from '../../editor/editor.js';
import { createMarkdownField, editMarkdownField } from '../../editor/markdown-field.js';
import { rowSplitter } from '../../editor/splitter.js';
import { confirmDialog } from '../../lib/dialog.js';
import { button, div, el, errText, fmtDate, renderHtml, span } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { showMenuAt, MENU_SEPARATOR, type MenuItem } from '../../lib/menu.js';
import { notice } from '../../lib/notice.js';
import { addToSelection, toggleSelection } from '../../selection/selection.js';
import { store } from '../../state.js';
import { invalidateHistoryBar } from '../history-bar.js';
import {
  addThoughtToFilter,
  getFilterState,
  getSavedFilterId,
  mountChronicleFilterPanel,
  setFilterState,
  setSavedFilterId,
  wireChronicleApplyShortcut,
} from './filter-panel.js';
import { fromDefinition, parseChronicleState, toDefinition } from './state.js';

let host: HTMLElement | null = null;
/** Per-network lazy init guard (like the structures view). */
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
let tableBody: HTMLElement | null = null;
let editorArea: HTMLElement | null = null;
let pagerLabel: HTMLElement | null = null;
/** Keyboard cursor: row index + column index + chip index (within the chips cell). */
let cursor = { row: -1, col: 0, chip: 0 };
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
  if (networkIdSeen === networkId) return;
  networkIdSeen = networkId;

  rows = [];
  total = 0;
  offset = 0;
  selectedRowId = null;
  newTargets = null;
  cursor = { row: -1, col: 0, chip: 0 };

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
  // Horizontal grab strip between the filter panel and the table: dragging
  // changes the panel's max-height (rowSplitter), the rest flows below.
  const splitter = rowSplitter(() => filterArea, {
    min: 80,
    max: () => filterArea.scrollHeight,
  });
  splitter.classList.add('chron-splitter');
  const main = div('chron-main');
  hostEl.append(filterArea, splitter, main);

  mountChronicleFilterPanel(filterArea, { apply: () => void applyQuery(true) });

  const top = div('chron-top');
  const wrap = div('admin-table-wrap chron-table-wrap');
  tableWrap = wrap;
  const pager = div('chron-pager');
  pagerLabel = span('', 'muted');
  pager.append(
    button('≪', () => gotoPage(0), 'btn small'),
    button('‹', () => gotoPage(offset - CHRONICLE_PAGE_SIZE), 'btn small'),
    pagerLabel,
    button('›', () => gotoPage(offset + CHRONICLE_PAGE_SIZE), 'btn small'),
    button('≫', () => gotoPage(Math.floor((total - 1) / CHRONICLE_PAGE_SIZE) * CHRONICLE_PAGE_SIZE), 'btn small'),
  );
  top.append(wrap, pager);
  editorArea = div('chron-editor');

  main.append(
    top,
    rowSplitter(() => wrap, { min: 48, max: () => wrap.scrollHeight }),
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
    if (
      networkId !== null &&
      networkIdSeen !== networkId &&
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
    // The visit history of the view is cleared on every «Применить» (§17).
    const profileId = store.state.profileId;
    if (profileId !== null) {
      await etn.history.chronicleClear(profileId, networkId, store.state.activeTabId).catch(() => undefined);
      invalidateHistoryBar();
    }
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
    if (cursor.row >= rows.length) cursor = { row: Math.max(0, rows.length - 1), col: 0, chip: 0 };
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
  if (tableWrap === null) return;
  tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
}

function renderError(err: unknown): void {
  if (tableWrap === null) return;
  tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
}

function gotoPage(next: number): void {
  const last = Math.max(0, Math.floor((total - 1) / CHRONICLE_PAGE_SIZE) * CHRONICLE_PAGE_SIZE);
  const clamped = Math.max(0, Math.min(next, last));
  if (clamped === offset && rows.length > 0) return;
  offset = clamped;
  void applyQuery(false);
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

const COLUMNS = ['С', 'По', 'Заголовок', 'Мысли/связи', 'Кратко'] as const;
/** Index of the «мысли/связи» column (chip navigation lives there). */
const CHIPS_COL = 3;

function renderTable(): void {
  if (tableWrap === null || pagerLabel === null) return;
  const table = el('table', 'table-list chron-table');
  const head = el('thead', 'chron-table-head');
  const headRow = el('tr');
  for (const col of COLUMNS) headRow.append(el('th', undefined, col));
  head.append(headRow);
  table.append(head);

  tableBody = el('tbody');
  if (rows.length === 0) {
    const row = el('tr');
    const cell = el('td', 'muted', 'Хронологических комментариев нет.');
    cell.colSpan = COLUMNS.length;
    row.append(cell);
    tableBody.append(row);
  } else {
    rows.forEach((row) => tableBody!.append(buildRow(row)));
  }
  table.append(tableBody);
  tableWrap.replaceChildren(table);
  repaintPager();

  table.addEventListener('click', (event) => {
    const tr = (event.target as HTMLElement | null)?.closest<HTMLElement>('.chron-row');
    if (tr?.dataset['rowId'] !== undefined) {
      const index = rows.findIndex((r) => r.id === tr.dataset['rowId']);
      if (index >= 0) {
        cursor = { row: index, col: 0, chip: 0 };
        selectRow(rows[index]!);
        repaintCursor();
      }
    }
  });
  table.addEventListener('contextmenu', (event) => {
    const tr = (event.target as HTMLElement | null)?.closest<HTMLElement>('.chron-row');
    if (tr?.dataset['rowId'] === undefined) return;
    event.preventDefault();
    const row = rows.find((r) => r.id === tr.dataset['rowId']);
    if (row !== undefined) showRowMenu(event.clientX, event.clientY, row.id);
  });
  table.addEventListener('keydown', onTableKeydown);
}

function repaintPager(): void {
  if (pagerLabel === null) return;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + rows.length, total);
  pagerLabel.textContent = `Записи ${from}–${to} из ${total}`;
}

/** One table row. */
function buildRow(row: ChronicleRow): HTMLElement {
  const tr = el('tr', 'chron-row');
  tr.dataset['rowId'] = row.id;
  tr.tabIndex = 0;
  if (row.id === selectedRowId) tr.classList.add('selected');

  const filter = getFilterState();
  const fromCell = el('td', 'chron-date', fmtDate(row.valid_from));
  if (filter.dateFrom !== '' && row.valid_from < filter.dateFrom) fromCell.classList.add('muted');
  const toCell = el('td', 'chron-date', row.valid_to === null ? '…' : fmtDate(row.valid_to));
  if (filter.dateTo !== '' && (row.valid_to === null || row.valid_to > filter.dateTo)) {
    toCell.classList.add('muted');
  }
  const titleCell = el('td', 'chron-title', row.title ?? '—');
  const targetsCell = el('td', 'chron-targets');
  for (const chip of buildTargetChips(row.targets, row.id)) targetsCell.append(chip);
  const snippetCell = el('td', 'chron-snippet');
  renderHtml(snippetCell, row.snippet);
  tr.append(fromCell, toCell, titleCell, targetsCell, snippetCell);
  return tr;
}

/** Builds the chip list of the «мысли/связи» column. */
function buildTargetChips(targets: ChronicleTarget[], rowId: string): HTMLElement[] {
  return targets.map((target) => {
    if (target.kind === 'thought') {
      const chip = thoughtChip(target.thought);
      chip.classList.add('chron-chip');
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
    chip.append(
      span('🔗', 'chip-icon'),
      span(target.link.source.title, 'chip-title'),
      span(
        target.link.type_name_forward === null ? ' — ' : ` — ${target.link.type_name_forward} — `,
        'chip-type muted',
      ),
      span(target.link.target.title, 'chip-title'),
    );
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
  const chip = el('span', 'chron-chip thought');
  chip.dataset['id'] = ref.id;
  applyCloudStyle(chip, resolveCloudStyle(ref));
  if (ref.active === false) chip.classList.add('muted');
  const iconBox = span('', 'chip-icon');
  applyThoughtIcon(iconBox, ref);
  chip.append(iconBox, span(ref.title, 'chip-title'));
  return chip;
}

/** Repaints the keyboard cursor highlight over the current table. */
function repaintCursor(): void {
  if (tableBody === null) return;
  const trs = Array.from(tableBody.querySelectorAll<HTMLElement>('.chron-row'));
  for (let i = 0; i < trs.length; i++) {
    const tr = trs[i];
    if (tr === undefined) continue;
    tr.querySelectorAll('.cell-selected').forEach((c) => c.classList.remove('cell-selected'));
    tr.querySelectorAll('.chip-selected').forEach((c) => c.classList.remove('chip-selected'));
    if (i !== cursor.row) continue;
    const cells = Array.from(tr.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
    const cell = cells[Math.min(cursor.col, cells.length - 1)];
    cell?.classList.add('cell-selected');
    if (cursor.col === CHIPS_COL) {
      const chips = Array.from(cell?.querySelectorAll<HTMLElement>('.chron-chip') ?? []);
      chips[Math.min(cursor.chip, chips.length - 1)]?.classList.add('chip-selected');
    }
  }
}

/** Arrow-key navigation inside the table (rows, columns, chips; Tab; Enter). */
function onTableKeydown(event: KeyboardEvent): void {
  if (rows.length === 0) return;
  const clampRow = (n: number): number => Math.max(0, Math.min(n, rows.length - 1));
  const chipsCount = (): number => {
    const tr = tableBody?.querySelectorAll<HTMLElement>('.chron-row')[cursor.row];
    if (tr === undefined) return 0;
    const cells = Array.from(tr.children).filter((c): c is HTMLElement => c instanceof HTMLElement);
    return cells[CHIPS_COL]?.querySelectorAll<HTMLElement>('.chron-chip').length ?? 0;
  };
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      cursor = { row: clampRow(cursor.row + 1), col: cursor.col, chip: 0 };
      selectRow(rows[cursor.row]!);
      repaintCursor();
      break;
    case 'ArrowUp':
      event.preventDefault();
      cursor = { row: clampRow(cursor.row - 1), col: cursor.col, chip: 0 };
      selectRow(rows[cursor.row]!);
      repaintCursor();
      break;
    case 'ArrowRight':
      event.preventDefault();
      if (cursor.col === CHIPS_COL && cursor.chip < chipsCount() - 1) {
        cursor = { ...cursor, chip: cursor.chip + 1 };
      } else {
        cursor = { ...cursor, col: Math.min(COLUMNS.length - 1, cursor.col + 1), chip: 0 };
      }
      repaintCursor();
      break;
    case 'ArrowLeft':
      event.preventDefault();
      if (cursor.col === CHIPS_COL && cursor.chip > 0) {
        cursor = { ...cursor, chip: cursor.chip - 1 };
      } else {
        cursor = { ...cursor, col: Math.max(0, cursor.col - 1), chip: 0 };
      }
      repaintCursor();
      break;
    case 'Tab':
      event.preventDefault();
      cursor = { ...cursor, col: Math.min(COLUMNS.length - 1, cursor.col + 1), chip: 0 };
      repaintCursor();
      break;
    case 'Enter': {
      event.preventDefault();
      const tr = tableBody?.querySelectorAll<HTMLElement>('.chron-row')[cursor.row];
      const selectedChip = tr?.querySelector<HTMLElement>('.chip-selected');
      if (selectedChip === undefined) return;
      const row = rows[cursor.row];
      const chip = row?.targets[Math.min(cursor.chip, (row?.targets.length ?? 1) - 1)];
      if (chip === undefined) return;
      if (chip.kind === 'thought') void openChronicleThought(chip.thought.id);
      else void openChronicleLinkById(chip.link.id);
      break;
    }
    default:
      break;
  }
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
  const hint = el('p', 'muted', 'Выберите запись из таблицы или добавьте новую.');
  hint.style.margin = '0';
  const body = div('chron-editor-body');
  body.append(hint);
  editorArea.replaceChildren(body);
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
  const titleInput = el('input', 'text-input chrono-meta-input');
  titleInput.type = 'text';
  titleInput.value = existing?.title ?? '';
  titleInput.maxLength = 200;
  titleInput.placeholder = 'Заголовок';
  const fromInput = el('input', 'text-input chrono-meta-input');
  fromInput.type = 'date';
  fromInput.value = existing?.valid_from.slice(0, 10) ?? todayIso();
  const toInput = el('input', 'text-input chrono-meta-input');
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
      button(
        'Удалить',
        () => void removeComment(existing),
        'btn small danger',
        'Удалить хронологический комментарий',
      ),
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
  });

  const body = div('chron-editor-body');
  body.append(metaRow, editorTargetsBox, widget);
  editorArea.replaceChildren(body);
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

function showRowMenu(x: number, y: number, rowId: string): void {
  const items: MenuItem[] = [
    {
      label: 'Добавить',
      onClick: () => void startNewFromFilter(),
    },
    {
      label: 'Копировать',
      onClick: () => void copyComment(rowId),
    },
    MENU_SEPARATOR,
    {
      label: 'Удалить',
      danger: true,
      onClick: () =>
        void (async () => {
          const fresh = await etn.comments.get(requireNetworkId(), rowId);
          await removeComment(fresh);
        })(),
    },
  ];
  showMenuAt(x, y, items);
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
  cursor = { row: -1, col: 0, chip: 0 };
  repaintTableSelection();
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

function repaintTableSelection(): void {
  if (tableBody === null) return;
  tableBody.querySelectorAll<HTMLElement>('.chron-row').forEach((tr) => {
    tr.classList.toggle('selected', tr.dataset['rowId'] === selectedRowId);
  });
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
    {
      label: 'Открыть',
      onClick: () => {
        if (ownerType === 'thought') void openChronicleThought(ownerId);
        else void openChronicleLinkById(ownerId);
      },
    },
  ];
  if (ownerType === 'thought') {
    items.push(
      {
        label: 'Добавить к выделению',
        onClick: () => addToSelection([ownerId]),
      },
      {
        label: 'Убрать из выделенных',
        onClick: () => toggleSelection([ownerId]),
      },
    );
  }
  items.push(
    MENU_SEPARATOR,
    {
      label: 'Отвязать',
      onClick: () => void detachTarget(rowId, ownerType, ownerId),
    },
    {
      label: 'Связать с…',
      onClick: () => void attachPickedThought(rowId),
    },
  );
  showMenuAt(x, y, items);
}

/** Context menu of an editor-area chip. */
function showEditorTargetMenu(x: number, y: number, target: CommentTarget): void {
  const s = editorState;
  if (s === null || s.commentId === null) return;
  const items: MenuItem[] = [
    {
      label: 'Открыть',
      onClick: () => {
        if (target.owner_type === 'thought') void openChronicleThought(target.owner_id);
        else void openChronicleLinkById(target.owner_id);
      },
    },
  ];
  if (target.owner_type === 'thought') {
    items.push(
      {
        label: 'Добавить к выделению',
        onClick: () => addToSelection([target.owner_id]),
      },
      {
        label: 'Убрать из выделенных',
        onClick: () => toggleSelection([target.owner_id]),
      },
    );
  }
  items.push(
    MENU_SEPARATOR,
    {
      label: 'Отвязать',
      onClick: () =>
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
    },
    {
      label: 'Связать с…',
      onClick: () =>
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
    },
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

/** Opens a thought in the editor (the canvas focus stays) and pushes it into
 *  the chronicle visit history. The full entity rides along in the store
 *  (`structuresActiveThought*`) — without the passenger the editor falls
 *  back to the focused thought (same mechanism as the structures view, L15). */
export async function openChronicleThought(id: string): Promise<void> {
  const networkId = requireNetworkId();
  const thought = await etn.thoughts.get(networkId, id);
  store.update({
    editorTarget: { kind: 'thought', id: thought.id },
    structuresActiveThought: thought,
    structuresActiveThoughtId: thought.id,
    selectedLinkId: null,
  });
  await pushChronicleHistory('thought', id);
}

/** Opens a link in the editor and pushes it into the chronicle visit history. */
export async function openChronicleLink(link: Link): Promise<void> {
  openLinkInEditor(link);
  await pushChronicleHistory('link', link.id);
}

/** Resolves and opens a link by id (from chips / history entries). */
export async function openChronicleLinkById(id: string): Promise<void> {
  const link = await etn.links.get(requireNetworkId(), id);
  await openChronicleLink(link);
}

/** Pushes a thought/link into the chronicle history and repaints the bar. */
async function pushChronicleHistory(kind: 'thought' | 'link', id: string): Promise<void> {
  const profileId = store.state.profileId;
  const networkId = store.state.networkId;
  if (profileId === null || networkId === null) return;
  await etn.history.chroniclePush(profileId, networkId, store.state.activeTabId, kind, id);
  invalidateHistoryBar();
}
