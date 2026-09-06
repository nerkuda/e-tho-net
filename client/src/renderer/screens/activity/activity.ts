/**
 * «События» workspace view (задача f27809d0 «Вид workspace «События» в
 * клиенте», элемент UI 8cd9ad55 «Лента «События» — вид workspace»,
 * 08-ui-spec.md §18, docs/03-server-api.md §13d).
 *
 * Layout: filter panel on top (one row with period / participant / entity
 * type / action / refresh) + a topbar with maintenance commands «Свернуть до
 * даты…» / «Обрезать до даты…» + the activity table itself.
 *
 * Columns (по UI-элементу 8cd9ad55): время, автор, действие, сущность (по
 * снимку `entity_title`), слой. Сортировка по `occurred_at_ms` убыв — это
 * порядок, в котором сервер возвращает ленту (03-server-api.md §13d).
 *
 * Live update через real-time отсутствует: сервер пока пишет `activity_log`
 * без эмита события `activity.new` (см. задачу f27809d0 §5 — «если уже
 * публикуется»). Подписка на события захвата (`edit.*`) уже есть в realtime
 * и косвенно сужает окно расхождений, но не заменяет полный refresh. Лента
 * обновляется при возврате в вид через `ensureActivityInitialised`.
 *
 * Клик по строке открывает сущность, если она ещё жива (thought/link/...);
 * удалённые сущности показываются read-only с пометкой «удалена».
 */

import type { ActivityEntityType, ActivityRow } from '@etn/shared';

import { requireNetworkId } from '../../app.js';
import { setThoughtEditorTarget } from '../../editor/editor.js';
import { confirmDialog, errorDialog, showDialog } from '../../lib/dialog.js';
import { button, div, el, errText, span, setTooltip } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { formatDateTime } from '../../lib/metadata.js';
import { notice } from '../../lib/notice.js';
import { resolve, ensureLoaded, subscribe as subscribeUsers } from '../../lib/users.js';
import { store } from '../../state.js';
import { UI_STATE_KEY } from '@etn/shared';
import {
  DEFAULT_FILTER,
  ENTITY_TYPE_OPTIONS,
  type ActionFilter,
  type ActivityFilterState,
  parseActivityState,
} from './state.js';

const PAGE_SIZE = 50;
const ENTITY_TYPES: ReadonlyArray<ActivityEntityType> = ENTITY_TYPE_OPTIONS.map((o) => o.value);
const ACTIONS: ReadonlyArray<ActionFilter> = [
  'created',
  'updated',
  'deleted',
  'trashed',
  'restored',
];

/** Russian labels for action codes (the wire format is English). */
const ACTION_LABELS: Record<ActionFilter, string> = {
  created: 'создал(а)',
  updated: 'изменил(а)',
  deleted: 'удалил(а)',
  trashed: 'пометил(а) на удаление',
  restored: 'восстановил(а)',
};

/** Russian labels for entity types used in the «сущность» column. */
const ENTITY_LABELS: Record<string, string> = {
  thought: 'мысль',
  link: 'связь',
  thought_type: 'тип мысли',
  link_type: 'тип связи',
  property: 'свойство',
  comment: 'комментарий',
  attachment: 'вложение',
  layer: 'слой',
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let host: HTMLElement | null = null;
/** Composite cache key `${networkId}:${tabId}` — re-init when either changes
 *  (Q4: per-tab snapshot), `null` until the first init. */
let networkIdSeen: string | null = null;
let filter: ActivityFilterState = { ...DEFAULT_FILTER };
let rows: ActivityRow[] = [];
let total = 0;
let offset = 0;
/** Loading guard against stale data. */
let querySeq = 0;

/** UI refs (populated while mounted). */
let tableWrap: HTMLElement | null = null;
let pagerLabel: HTMLElement | null = null;

// ---------------------------------------------------------------------------
// Mount / init
// ---------------------------------------------------------------------------

/** Switches to the activity view and lazily loads persisted state (L4). */
export async function ensureActivityInitialised(): Promise<void> {
  const networkId = store.state.networkId;
  const tabId = store.state.activeTabId;
  if (networkId === null || host === null) return;
  const key = `${networkId}:${tabId ?? ''}`;
  if (networkIdSeen === key) return;
  networkIdSeen = key;

  rows = [];
  total = 0;
  offset = 0;
  filter = { ...DEFAULT_FILTER };

  try {
    let raw: string | null = null;
    if (tabId !== null) {
      const tab = store.state.tabs.find((t) => t.tab_id === tabId);
      raw = tab?.activity_state ?? null;
    }
    if (raw === null && tabId !== null) {
      // Legacy migration: views persisted to the network-level `ui_state`
      // before per-tab snapshots (Q4) keep working until the user saves
      // again — at which point `persistState` writes to the tab.
      raw = await etn.ui.getState(networkId, UI_STATE_KEY.ACTIVITY_STATE);
    }
    if (raw !== null && raw !== '') {
      const parsed = parseActivityState(raw);
      filter = parsed.filter;
      offset = parsed.offset;
      repaintControls();
    }
  } catch {
    // Fall back to the empty filter.
  }
  // `EnsureLoaded` triggers an async `users` fetch; rows rendered before it
  // resolves fall back to raw ids (`resolve` returns `null` then).
  ensureLoaded();
  await applyQuery();
}

/** Persists filter + page to L4 (per-tab snapshot, Q4). */
function persistState(): void {
  const tabId = store.state.activeTabId;
  if (tabId === null) return;
  void etn.tabs
    .updateState(tabId, {
      activity_state: JSON.stringify({ filter, offset }),
    })
    .catch(() => undefined);
}

/** Mounts the view into the host element; called once from workspace.ts. */
export function mountActivity(hostEl: HTMLElement): void {
  host = hostEl;
  host.replaceChildren();

  // Filter row + maintenance commands (08-ui-spec.md §18).
  const filterArea = div('activity-filter-area');
  hostEl.append(filterArea);
  mountFilterPanel(filterArea);

  // Toolbar of maintenance commands (above the table, separate from the
  // filter row so destructive actions stay visibly apart from search).
  const toolbar = div('activity-toolbar');
  toolbar.append(
    button('Свернуть до даты…', () => void rollupDialog(), 'btn small'),
    button('Обрезать до даты…', () => void truncateDialog(), 'btn small danger'),
  );
  hostEl.append(toolbar);

  // The table takes the remaining height; same wrap pattern as the chronicle
  // screen — scroll on overflow, fixed header.
  const tableWrapEl = div('admin-table-wrap activity-table-wrap');
  tableWrap = tableWrapEl;
  const pager = div('activity-pager');
  pagerLabel = span('', 'muted');
  pager.append(
    button('≪', () => void gotoPage(0), 'btn small'),
    button('‹', () => void gotoPage(offset - PAGE_SIZE), 'btn small'),
    pagerLabel,
    button('›', () => void gotoPage(offset + PAGE_SIZE), 'btn small'),
    button('≫', () => void gotoPage(Math.floor(Math.max(0, total - 1) / PAGE_SIZE) * PAGE_SIZE), 'btn small'),
  );
  hostEl.append(tableWrapEl, pager);

  // Restore the view when the network opens with `active_view = 'activity'`.
  store.subscribe(() => {
    if (host === null || !host.isConnected) return;
    const networkId = store.state.networkId;
    const tabId = store.state.activeTabId;
    if (
      networkId !== null &&
      networkIdSeen !== `${networkId}:${tabId ?? ''}` &&
      store.state.activeView === 'activity'
    ) {
      void ensureActivityInitialised();
      return;
    }
    if (store.state.activeView !== 'activity') return;
    // Re-render names if the user cache fills in after the first paint.
    repaintNames();
  });
  // The names may resolve after the first paint — subscribe and re-render
  // author cells when the user cache changes.
  subscribeUsers(() => repaintNames());
}

// ---------------------------------------------------------------------------
// Filter panel
// ---------------------------------------------------------------------------

let fromInput: HTMLInputElement | null = null;
let toInput: HTMLInputElement | null = null;
let userInput: HTMLInputElement | null = null;
let entityTypesBox: HTMLElement | null = null;
let actionsBox: HTMLElement | null = null;

function mountFilterPanel(area: HTMLElement): void {
  area.replaceChildren();
  const row = div('activity-filter-row');

  fromInput = el('input', 'text-input activity-date') as HTMLInputElement;
  fromInput.type = 'date';
  fromInput.title = 'Начало периода (включительно)';
  fromInput.addEventListener('change', () => {
    filter = { ...filter, fromMs: fromInput!.value };
    void applyQuery();
  });
  const fromLabel = span('Период с', 'activity-label');

  toInput = el('input', 'text-input activity-date') as HTMLInputElement;
  toInput.type = 'date';
  toInput.title = 'Конец периода (включительно)';
  toInput.addEventListener('change', () => {
    filter = { ...filter, toMs: toInput!.value };
    void applyQuery();
  });
  const toLabel = span('по', 'activity-label');

  userInput = el('input', 'text-input activity-user') as HTMLInputElement;
  userInput.type = 'text';
  userInput.placeholder = 'ID участника';
  userInput.title = 'Фильтр по id исполнителя (UUID)';
  userInput.addEventListener('change', () => {
    filter = { ...filter, userId: userInput!.value.trim() };
    void applyQuery();
  });
  const userLabel = span('Участник', 'activity-label');

  // Multi-select checkboxes for entity types and actions (compact pill row).
  entityTypesBox = div('activity-pills');
  for (const opt of ENTITY_TYPE_OPTIONS) {
    entityTypesBox.append(buildPill(opt.value, ENTITY_LABELS[opt.value] ?? opt.value, 'entity'));
  }
  const entityLabel = span('Тип сущности', 'activity-label');

  actionsBox = div('activity-pills');
  for (const action of ACTIONS) {
    actionsBox.append(buildPill(action, ACTION_LABELS[action], 'action'));
  }
  const actionLabel = span('Действие', 'activity-label');

  row.append(
    fromLabel,
    fromInput,
    toLabel,
    toInput,
    userLabel,
    userInput,
    entityLabel,
    entityTypesBox,
    actionLabel,
    actionsBox,
  );
  area.append(row);
  repaintControls();
}

/** A single checkbox-pill («тип сущности» или «действие»). */
function buildPill(value: string, label: string, group: 'entity' | 'action'): HTMLElement {
  const id = `act-pill-${group}-${value}`;
  const labelEl = el('label', 'activity-pill');
  labelEl.htmlFor = id;
  const check = el('input') as HTMLInputElement;
  check.type = 'checkbox';
  check.id = id;
  check.addEventListener('change', () => {
    if (group === 'entity') {
      const next = filter.entityTypes.filter((v) => v !== value);
      if (check.checked) next.push(value as ActivityEntityType);
      filter = { ...filter, entityTypes: next };
    } else {
      const next = filter.actions.filter((v) => v !== value);
      if (check.checked) next.push(value as ActionFilter);
      filter = { ...filter, actions: next };
    }
    void applyQuery();
  });
  labelEl.append(check, span(label));
  return labelEl;
}

function repaintControls(): void {
  if (fromInput !== null) fromInput.value = filter.fromMs;
  if (toInput !== null) toInput.value = filter.toMs;
  if (userInput !== null) userInput.value = filter.userId;
  if (entityTypesBox !== null) {
    const checks = entityTypesBox.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    checks.forEach((c) => {
      c.checked = filter.entityTypes.includes(c.id.replace('act-pill-entity-', '') as ActivityEntityType);
    });
  }
  if (actionsBox !== null) {
    const checks = actionsBox.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    checks.forEach((c) => {
      c.checked = filter.actions.includes(c.id.replace('act-pill-action-', '') as ActionFilter);
    });
  }
}

// ---------------------------------------------------------------------------
// Query + table rendering
// ---------------------------------------------------------------------------

/** Local date string in `YYYY-MM-DD` → `Date.parse`-friendly ISO at midnight
 *  local time. Used to build `from_ms`/`to_ms` query params. */
function dateToMs(value: string, endOfDay: boolean): number | null {
  if (value === '') return null;
  const d = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}

async function applyQuery(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || tableWrap === null) return;
  persistState();
  const seq = ++querySeq;
  renderLoading();
  try {
    const fromMs = dateToMs(filter.fromMs, false);
    const toMs = dateToMs(filter.toMs, true);
    // The server expects a single entity_type — we OR-combine by re-querying
    // for each selected type. For the typical case (≤2 selections) this is
    // cheap; for the rare multi-select it stays predictable.
    const types = filter.entityTypes.length === 0 ? ENTITY_TYPES : filter.entityTypes;
    const actions = filter.actions.length === 0 ? null : new Set(filter.actions);
    const buckets: ActivityRow[] = [];
    let bucketTotal = 0;
    for (const et of types) {
      const params: {
        from_ms?: number;
        to_ms?: number;
        user_id?: string;
        entity_type?: string;
        entity_id?: string;
        limit?: number;
        offset?: number;
      } = {
        entity_type: et,
        limit: PAGE_SIZE,
        offset,
      };
      if (fromMs !== null) params.from_ms = fromMs;
      if (toMs !== null) params.to_ms = toMs;
      if (filter.userId !== '') params.user_id = filter.userId;
      const result = await etn.activity.list(networkId, params);
      // Filter by action client-side (the server has no `action` filter on
      // `/activity`, requirement b0c7a57c); page-level pagination is applied
      // per-type. The resulting set is small enough for `O(n log n)` to be a
      // no-op.
      const filtered = actions === null
        ? result.rows
        : result.rows.filter((r) => actions.has(r.action as ActionFilter));
      for (const r of filtered) buckets.push(r);
      bucketTotal += result.total;
    }
    // Merge by occurred_at_ms DESC and dedupe (rows are unique per `id`).
    const seen = new Set<string>();
    const merged: ActivityRow[] = [];
    buckets
      .sort((a, b) => b.occurred_at_ms - a.occurred_at_ms)
      .forEach((r) => {
        if (seen.has(r.id)) return;
        seen.add(r.id);
        merged.push(r);
      });
    const page = merged.slice(0, PAGE_SIZE);
    if (seq !== querySeq) return;
    rows = page;
    total = bucketTotal;
    renderTable();
  } catch (err) {
    if (seq !== querySeq) return;
    renderError(err);
  }
}

async function gotoPage(next: number): Promise<void> {
  const last = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
  const clamped = Math.max(0, Math.min(next, last));
  if (clamped === offset && rows.length > 0) return;
  offset = clamped;
  await applyQuery();
}

function renderLoading(): void {
  if (tableWrap === null) return;
  tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
}

function renderError(err: unknown): void {
  if (tableWrap === null) return;
  tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
  repaintPager();
}

function repaintPager(): void {
  if (pagerLabel === null) return;
  if (total === 0) {
    pagerLabel.textContent = 'Нет событий';
    return;
  }
  const from = offset + 1;
  const to = Math.min(offset + rows.length, total);
  pagerLabel.textContent = `Записи ${from}–${to} из ${total}`;
}

const COLUMNS = ['Время', 'Автор', 'Действие', 'Сущность', 'Слой'] as const;

function renderTable(): void {
  if (tableWrap === null || pagerLabel === null) return;
  const table = el('table', 'table-list activity-table');
  const head = el('thead', 'activity-table-head');
  const headRow = el('tr');
  for (const col of COLUMNS) headRow.append(el('th', undefined, col));
  head.append(headRow);
  table.append(head);

  const tbody = el('tbody');
  if (rows.length === 0) {
    const row = el('tr');
    const cell = el('td', 'muted', 'Событий нет.');
    cell.colSpan = COLUMNS.length;
    row.append(cell);
    tbody.append(row);
  } else {
    rows.forEach((r) => tbody.append(buildRow(r)));
  }
  table.append(tbody);
  tableWrap.replaceChildren(table);
  repaintPager();

  // Row click — open the entity when it still exists (08-ui-spec.md §18:
  // «удалённые сущности — read-only с пометкой»). We do a quick check: try
  // `GET` and, on `NOT_FOUND`, fall back to a read-only placeholder.
  tbody.addEventListener('click', (event) => {
    const tr = (event.target as HTMLElement | null)?.closest<HTMLElement>('.activity-row');
    if (tr?.dataset['id'] === undefined) return;
    const row = rows.find((r) => r.id === tr.dataset['id']);
    if (row === undefined) return;
    void openEntity(row);
  });
}

/** One table row — click opens the entity when alive. */
function buildRow(row: ActivityRow): HTMLElement {
  const tr = el('tr', 'activity-row');
  tr.dataset['id'] = row.id;
  tr.tabIndex = 0;

  // Time: the server returns wall-clock `occurred_at_ms`; render localised.
  const timeCell = el('td', 'activity-time', formatDateTime(row.occurred_at_ms));

  // Author: prefer the resolved user name, fall back to raw id (user cache may
  // not yet have the id — admin-only endpoint).
  const authorCell = el('td', 'activity-author');
  authorCell.append(renderAuthor(row));

  // Action: human label + the «сущность» link.
  const actionCell = el('td', 'activity-action');
  actionCell.append(
    span(ACTION_LABELS[row.action as ActionFilter] ?? row.action, 'activity-action-label'),
  );

  // Entity: «entity_type: entity_title» snapshot (entity_title survives
  // deletion — it's the whole point of the journal).
  const entityCell = el('td', 'activity-entity');
  const typeLabel = ENTITY_LABELS[row.entity_type] ?? row.entity_type;
  entityCell.append(span(`${typeLabel}: `, 'muted'), span(row.entity_title || '—'));
  if (row.entity_title === '') entityCell.classList.add('muted');

  // Layer: the snapshot id (short form) or «—» if absent.
  const layerCell = el('td', 'activity-layer');
  layerCell.append(span(row.layer_id === null ? '—' : shortId(row.layer_id), 'muted'));

  tr.append(timeCell, authorCell, actionCell, entityCell, layerCell);
  return tr;
}

/** Renders the author cell — cached when the user cache fills in later. */
function renderAuthor(row: ActivityRow): HTMLElement {
  const name = row.user_name ?? resolve(row.user_id) ?? row.user_id;
  const cell = el('span', undefined, name);
  if (name === row.user_id) cell.classList.add('muted');
  return cell;
}

/** Re-renders just the author cells (cheap text rewrite) when the user
 *  cache fills in after the first paint. */
function repaintNames(): void {
  if (tableWrap === null) return;
  const cells = tableWrap.querySelectorAll<HTMLElement>('.activity-author');
  cells.forEach((cell) => {
    const tr = cell.closest<HTMLElement>('.activity-row');
    if (tr === null) return;
    const row = rows.find((r) => r.id === tr.dataset['id']);
    if (row === undefined) return;
    cell.replaceChildren(renderAuthor(row));
  });
}

/** Compact id label (first 8 hex chars) for the «слой» column. */
function shortId(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

// ---------------------------------------------------------------------------
// Open entity from a row click
// ---------------------------------------------------------------------------

/** Opens the row's entity in the editor (or the link editor for links) when
 *  it still exists; otherwise shows a read-only dialog with the snapshot. */
async function openEntity(row: ActivityRow): Promise<void> {
  const networkId = requireNetworkId();
  try {
    switch (row.entity_type) {
      case 'thought': {
        const thought = await etn.thoughts.get(networkId, row.entity_id);
        await setThoughtEditorTarget(thought);
        return;
      }
      case 'link': {
        const link = await etn.links.get(networkId, row.entity_id);
        store.update({
          editorTarget: { kind: 'link', id: link.id, link },
          selectedLinkId: link.id,
        });
        return;
      }
      case 'thought_type':
      case 'link_type':
      case 'property':
      case 'comment':
      case 'attachment':
      case 'layer':
        // No client-side editor for these entity kinds — show the snapshot
        // dialog instead.
        showSnapshotDialog(row);
        return;
      default:
        showSnapshotDialog(row);
    }
  } catch {
    // The entity is gone (or otherwise unreadable) — fall back to the snapshot.
    showSnapshotDialog(row);
  }
}

/** Read-only dialog for an entity that no longer exists or lacks a client
 *  editor. Shows the snapshot title + the action context. */
function showSnapshotDialog(row: ActivityRow): void {
  const typeLabel = ENTITY_LABELS[row.entity_type] ?? row.entity_type;
  const body = div('form-stack');
  body.append(el('p', 'muted', 'Сущность удалена или недоступна. Снимок из журнала:'));
  const table = el('table', 'table-list metadata-table');
  const tbody = el('tbody');
  const addRow = (label: string, value: string): void => {
    const tr = el('tr');
    tr.append(el('th', undefined, label), el('td', undefined, value));
    tbody.append(tr);
  };
  addRow('Тип', typeLabel);
  addRow('Действие', ACTION_LABELS[row.action as ActionFilter] ?? row.action);
  addRow('Название', row.entity_title === '' ? '—' : row.entity_title);
  addRow('Автор', row.user_name ?? row.user_id);
  addRow('Когда', formatDateTime(row.occurred_at_ms));
  addRow('Слой', row.layer_id === null ? '—' : row.layer_id);
  addRow('id сущности', row.entity_id);
  table.append(tbody);
  body.append(table);
  showDialog({
    title: 'Снимок события',
    body,
    width: 560,
    buttons: [{ label: 'Закрыть', primary: true }],
  });
}

// ---------------------------------------------------------------------------
// Maintenance commands — «Свернуть до даты…» / «Обрезать до даты…»
// ---------------------------------------------------------------------------

/** Shows a date picker dialog and, after confirmation, sends the destructive
 *  request. Toasts the resulting `{ removed, kept }` counts. */
async function rollupDialog(): Promise<void> {
  await runMaintenance({
    title: 'Свернуть журнал до даты',
    buttonLabel: 'Свернуть',
    danger: false,
    verb: 'Свернуть',
    success(removed: number, kept: number | undefined): string {
      return kept === undefined
        ? `Удалено записей: ${removed}.`
        : `Удалено ${removed}, оставлено ${kept}.`;
    },
    run: (untilMs) => etn.activity.rollup(requireNetworkId(), untilMs),
  });
}

async function truncateDialog(): Promise<void> {
  await runMaintenance({
    title: 'Обрезать журнал до даты',
    buttonLabel: 'Обрезать',
    danger: true,
    verb: 'Обрезать',
    success(removed: number): string {
      return `Удалено записей: ${removed}.`;
    },
    run: (untilMs) => etn.activity.truncate(requireNetworkId(), untilMs),
  });
}

interface MaintenanceOpts {
  title: string;
  buttonLabel: string;
  danger: boolean;
  verb: string;
  success: (removed: number, kept: number | undefined) => string;
  run: (untilMs: number) => Promise<{ removed: number; kept?: number }>;
}

async function runMaintenance(opts: MaintenanceOpts): Promise<void> {
  const input = el('input', 'text-input activity-date') as HTMLInputElement;
  input.type = 'date';
  setTooltip(input, 'Все записи журнала до этой даты будут затронуты.');
  const field = div('field');
  field.append(el('label', 'field-label', 'Дата (включительно)'), input);
  const body = div('form-stack');
  body.append(
    field,
    el('p', 'muted activity-maintenance-hint', 'Операция необратима — записи будут удалены без возможности восстановления.'),
  );
  const ok = await new Promise<number | null>((resolve) => {
    showDialog({
      title: opts.title,
      body,
      width: 420,
      buttons: [
        { label: 'Отмена', onClick: () => resolve(null) },
        {
          label: opts.buttonLabel,
          primary: !opts.danger,
          danger: opts.danger,
          onClick: () => {
            const value = input.value;
            if (value === '') return resolve(null);
            const ms = dateToMs(value, true);
            if (ms === null) return resolve(null);
            resolve(ms);
          },
        },
      ],
    });
  });
  if (ok === null) return;
  const confirmed = await confirmDialog(
    opts.title,
    `${opts.verb} все записи журнала активности до выбранной даты? Действие необратимо.`,
    opts.danger,
  );
  if (!confirmed) return;
  try {
    const result = await opts.run(ok);
    notice(opts.success(result.removed, result.kept), 'info');
    await applyQuery();
  } catch (err) {
    errorDialog(opts.title, err);
  }
}

// Re-export so the test suite (and any future consumer) can name the filter
// shape without reaching into the state module.
export type { ActivityFilterState };
