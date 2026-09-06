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

import type { ActivityEntityType, ActivityRow, StructureAuthorOp } from '@etn/shared';

import { requireNetworkId } from '../../app.js';
import { setThoughtEditorTarget } from '../../editor/editor.js';
import { confirmDialog, errorDialog, showDialog } from '../../lib/dialog.js';
import { button, div, el, errText, span, setTooltip } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { formatDateTime } from '../../lib/metadata.js';
import { notice } from '../../lib/notice.js';
import {
  buildUserMultiSelectWidget,
  buildUserSelectWidget,
  resolve,
  ensureLoaded,
  subscribe,
  subscribe as subscribeUsers,
} from '../../lib/users.js';
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

/**
 * Кэш имён для подстановки в `entity_title` и колонку «Слой»
 * (замечание пользователя: «в представлении все id заменялись именами»).
 *
 *  - `typeNames` — имена типов мыслей и связей из `store.state` (там уже есть);
 *  - `layerTitles` — `id → title` (подтягивается из `etn.layers.list`);
 *  - `thoughtTitles` — `id → title` (резолвится пачкой через
 *    `etn.thoughts.resolve` при появлении в ленте).
 *
 * Кэш живёт между запросами — после первой отрисовки имена известны.
 */
const typeNames = new Map<string, string>();
const layerTitles = new Map<string, string>();
const thoughtTitles = new Map<string, string>();
/** Set of thought ids we've already requested — avoid request storms. */
const thoughtResolvePending = new Set<string>();

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

  // Layout: filter panel on the left + table on the right (как в
  // «Структурах мыслей» — замечание пользователя, п. 5).
  const panel = div('activity-filter');
  const results = div('activity-results');
  hostEl.append(panel, results);

  mountFilterPanel(panel);

  // Maintenance commands + pager live inside the results column so destructive
  // actions stay visibly apart from the table.
  const toolbar = div('activity-toolbar');
  toolbar.append(
    button('Свернуть до даты…', () => void rollupDialog(), 'btn small'),
    button('Обрезать до даты…', () => void truncateDialog(), 'btn small danger'),
  );
  results.append(toolbar);

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
  results.append(tableWrapEl, pager);

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
let keywordsInput: HTMLInputElement | null = null;
let entityTypesBox: HTMLElement | null = null;
let actionsBox: HTMLElement | null = null;

function mountFilterPanel(area: HTMLElement): void {
  area.replaceChildren();
  const scroll = div('activity-filter-scroll');
  area.append(scroll);

  // --- keywords (поиск по `entity_title`) -----------------------------
  const kwTitle = el('div', 'act-f-title', 'Ключевые слова');
  scroll.append(kwTitle);
  keywordsInput = el('input', 'text-input act-f-input') as HTMLInputElement;
  keywordsInput.type = 'text';
  keywordsInput.placeholder = 'название* -тест';
  keywordsInput.title = 'Поиск по снимку entity_title (через пробел, * и - как в Структурах)';
  keywordsInput.addEventListener('input', () => {
    filter = { ...filter, keywords: keywordsInput!.value };
  });
  keywordsInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void applyQuery();
  });
  scroll.append(keywordsInput);

  // --- period ---------------------------------------------------------
  const periodTitle = el('div', 'act-f-title', 'Период');
  scroll.append(periodTitle);
  const periodRow = div('act-f-row');
  fromInput = el('input', 'text-input activity-date') as HTMLInputElement;
  fromInput.type = 'date';
  fromInput.title = 'Начало периода (включительно)';
  fromInput.addEventListener('change', () => {
    filter = { ...filter, fromMs: fromInput!.value };
    void applyQuery();
  });
  toInput = el('input', 'text-input activity-date') as HTMLInputElement;
  toInput.type = 'date';
  toInput.title = 'Конец периода (включительно)';
  toInput.addEventListener('change', () => {
    filter = { ...filter, toMs: toInput!.value };
    void applyQuery();
  });
  periodRow.append(span('с', 'act-f-label'), fromInput, span('по', 'act-f-label'), toInput);
  scroll.append(periodRow);

  // --- author (задача 59119797, эволюция операторов) ------------------
  const userTitle = el('div', 'act-f-title', 'Участник');
  scroll.append(userTitle);
  const userBlock = buildActivityUserBlock();
  scroll.append(userBlock);

  // --- entity types ---------------------------------------------------
  const entityTitle = el('div', 'act-f-title', 'Тип сущности');
  scroll.append(entityTitle);
  entityTypesBox = div('activity-pills');
  for (const opt of ENTITY_TYPE_OPTIONS) {
    entityTypesBox.append(buildPill(opt.value, ENTITY_LABELS[opt.value] ?? opt.value, 'entity'));
  }
  scroll.append(entityTypesBox);

  // --- actions --------------------------------------------------------
  const actionTitle = el('div', 'act-f-title', 'Действие');
  scroll.append(actionTitle);
  actionsBox = div('activity-pills');
  for (const action of ACTIONS) {
    actionsBox.append(buildPill(action, ACTION_LABELS[action], 'action'));
  }
  scroll.append(actionsBox);

  // --- apply / clear --------------------------------------------------
  const footer = div('act-f-footer');
  const apply = el('button', 'act-f-apply', 'Применить');
  apply.type = 'button';
  apply.addEventListener('click', () => void applyQuery());
  const clearBtn = el('button', 'act-f-clear', 'Очистить');
  clearBtn.type = 'button';
  clearBtn.addEventListener('click', () => {
    filter = { ...DEFAULT_FILTER };
    repaintControls();
    void applyQuery();
  });
  footer.append(apply, clearBtn);
  area.append(footer);

  repaintControls();
}

/** Builds the «Участник» block: оператор + селектор (single/multi/hint). */
function buildActivityUserBlock(): HTMLElement {
  const block = div('act-f-author');
  const row = div('act-f-row');
  const opSelect = el('select', 'select-input act-f-op') as HTMLSelectElement;
  for (const op of ['eq', 'ne', 'in', 'not_in'] as StructureAuthorOp[]) {
    const o = el('option', '', AUTHOR_OP_LABELS[op]) as HTMLOptionElement;
    o.value = op;
    opSelect.append(o);
  }
  opSelect.value = filter.userOp;
  opSelect.addEventListener('change', () => {
    const op = opSelect.value as StructureAuthorOp;
    filter = {
      ...filter,
      userOp: op,
      ...(op !== 'eq' && op !== 'ne' ? { userId: '' } : {}),
      ...(op !== 'in' && op !== 'not_in' ? { userIds: [] } : {}),
    };
    repaintControls();
  });
  row.append(span('условие', 'act-f-label'), opSelect);
  block.append(row);

  const valueBox = div('act-f-author-value');
  block.append(valueBox);

  const renderValue = (): void => {
    valueBox.replaceChildren();
    if (filter.userOp === 'in' || filter.userOp === 'not_in') {
      valueBox.append(
        buildUserMultiSelectWidget({
          label: 'участники',
          currentIds: filter.userIds,
          onChange: (ids) => {
            filter = { ...filter, userIds: ids };
          },
        }),
      );
      return;
    }
    valueBox.append(
      buildUserSelectWidget({
        label: 'участник',
        currentId: filter.userId,
        onChange: (id) => {
          filter = { ...filter, userId: id };
        },
      }),
    );
  };
  renderValue();
  // Перерисовка виджета при смене оператора/значения.
  subscribe(renderValue);
  return block;
}

/** Russian labels для оператора (тот же словарь, что и в Структурах/Хронике). */
const AUTHOR_OP_LABELS: Record<StructureAuthorOp, string> = {
  eq: 'равен',
  ne: 'не равен',
  in: 'в списке',
  not_in: 'не в списке',
  empty: 'не заполнено',
  not_empty: 'заполнено',
};

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
  if (keywordsInput !== null) keywordsInput.value = filter.keywords;
  if (fromInput !== null) fromInput.value = filter.fromMs;
  if (toInput !== null) toInput.value = filter.toMs;
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
    // То же самое для пользователей: оператор eq/ne — один запрос на id;
    // in/not_in — серия запросов (как для типов сущностей) с объединением.
    // empty/not_empty — фильтр применяется клиентом (нет серверной поддержки).
    const userQueryIds = userQueryIdsForOperator();
    const buckets: ActivityRow[] = [];
    let bucketTotal = 0;
    for (const et of types) {
      for (const uid of userQueryIds) {
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
        if (uid !== null) params.user_id = uid;
        const result = await etn.activity.list(networkId, params);
        // Filter by action client-side (the server has no `action` filter on
        // `/activity`, requirement b0c7a57c); page-level pagination is applied
        // per-type. The resulting set is small enough for `O(n log n)` to be a
        // no-op.
        let filtered = actions === null
          ? result.rows
          : result.rows.filter((r) => actions.has(r.action as ActionFilter));
        // empty/not_empty по пользователю — клиентский фильтр: `user_id IS NULL`.
        if (filter.userOp === 'empty') {
          filtered = filtered.filter((r) => r.user_id === '');
        } else if (filter.userOp === 'not_empty') {
          filtered = filtered.filter((r) => r.user_id !== '');
        }
        for (const r of filtered) buckets.push(r);
        bucketTotal += result.total;
      }
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
    // Клиентский фильтр по keywords — минисинтаксис применяется к
    // `entity_title` (аналог полнотекстового поиска Структур).
    const keywords = filter.keywords.trim() === '' ? null : parseKeywords(filter.keywords);
    const page = keywords === null
      ? merged.slice(0, PAGE_SIZE)
      : merged
          .filter((r) => matchesKeywords(r.entity_title, keywords))
          .slice(0, PAGE_SIZE);
    if (seq !== querySeq) return;
    rows = page;
    total = bucketTotal;
    // Подтягиваем имена типов (уже в store), слоёв (однократно) и мыслей
    // (пачками по мере появления в ленте). После получения имён таблица
    // перерисовывается — UUIDы в снимках заменяются именами.
    refreshTypeNames();
    void refreshLayerTitles(networkId).then(() => {
      if (seq !== querySeq) return;
      renderTable();
    });
    void resolveMissingThoughtTitles(page, networkId, seq);
    renderTable();
  } catch (err) {
    if (seq !== querySeq) return;
    renderError(err);
  }
}

/**
 * Выдаёт список `user_id` для запросов к серверу в зависимости от оператора.
 * - `eq`/`ne` — массив из одного id (`null`, если id пустой).
 * - `in` — все выбранные id (или один пустой запрос, если никого).
 * - `not_in` — сервер не умеет NOT IN; пропускаем фильтр на сервере и
 *   отфильтруем на клиенте (см. `applyQuery`).
 * - `empty`/`not_empty` — без id (фильтр по NULL на клиенте).
 */
function userQueryIdsForOperator(): Array<string | null> {
  if (filter.userOp === 'empty' || filter.userOp === 'not_empty') return [null];
  if (filter.userOp === 'eq' || filter.userOp === 'ne') {
    return [filter.userId === '' ? null : filter.userId];
  }
  // `in` / `not_in` — серия запросов по одному id.
  return filter.userIds.length === 0 ? [null] : filter.userIds.map((id) => id);
}

/** Минисинтаксис ключевых слов: те же правила, что и в Структурах. */
interface ParsedKeywords {
  include: string[];
  exclude: string[];
}

function parseKeywords(raw: string): ParsedKeywords {
  const tokens = raw.split(/\s+/).filter((t) => t !== '');
  const include: string[] = [];
  const exclude: string[] = [];
  for (const t of tokens) {
    if (t.startsWith('-') && t.length > 1) exclude.push(t.slice(1).toLowerCase());
    else include.push(t.toLowerCase());
  }
  return { include, exclude };
}

function matchesKeywords(text: string, kw: ParsedKeywords): boolean {
  const lower = text.toLowerCase();
  for (const inc of kw.include) {
    const pattern = buildKwPattern(inc);
    if (!pattern.test(lower)) return false;
  }
  for (const exc of kw.exclude) {
    const pattern = buildKwPattern(exc);
    if (pattern.test(lower)) return false;
  }
  return true;
}

function buildKwPattern(token: string): RegExp {
  // Звёздочка — подстановочный знак; иначе — точное вхождение.
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(escaped, 'i');
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
  // deletion — it's the whole point of the journal). UUIDы в снимке
  // подменяются именами из кэша (замечание пользователя — замена id на
  // имена в представлении).
  const entityCell = el('td', 'activity-entity');
  const typeLabel = ENTITY_LABELS[row.entity_type] ?? row.entity_type;
  const resolvedTitle = resolveEntityTitle(row.entity_type, row.entity_title);
  entityCell.append(span(`${typeLabel}: `, 'muted'), span(resolvedTitle || '—'));
  if (row.entity_title === '') entityCell.classList.add('muted');

  // Layer: заголовок слоя из кэша, иначе короткий id (ещё не подтянулся).
  const layerCell = el('td', 'activity-layer');
  if (row.layer_id === null) {
    layerCell.append(span('—', 'muted'));
  } else {
    layerCell.append(span(layerDisplayName(row.layer_id)));
  }

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

/** UUID-префикс для regex-подстановки (8-4-4-4-12 hex, lower-case). */
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Подставляет имена из кэша вместо UUIDов в `entity_title`. Не найденные в
 * кэше id остаются как есть — пользователь увидит их короткий вид до тех
 * пор, пока кэш не наполнится (после чего строка перерисуется).
 */
function resolveEntityTitle(entityType: string, title: string): string {
  if (!title) return title;
  return title.replace(UUID_RE, (match) => {
    const lower = match.toLowerCase();
    const name = resolveIdName(entityType, lower);
    return name ?? match;
  });
}

/**
 * Контекстно-зависимый поиск имени по id. В снимках разных сущностей
 * встречаются id типов мыслей, типов связей и самих мыслей — для каждого
 * контекста нужен свой источник.
 */
function resolveIdName(entityType: string, id: string): string | null {
  // Снимок связи содержит source_id → target_id и (опц.) тип связи.
  if (entityType === 'link') {
    return thoughtTitles.get(id) ?? typeNames.get(id) ?? null;
  }
  // Снимок мысли: «мысль типа <id>, …».
  if (entityType === 'thought') {
    return typeNames.get(id) ?? null;
  }
  if (entityType === 'thought_type' || entityType === 'link_type' || entityType === 'property') {
    return typeNames.get(id) ?? null;
  }
  return null;
}

/**
 * Собирает все id, которые нужно подтянуть из сети для текущего набора строк.
 * Возвращает массив thought ids (для типов имён берёмся прямо из store).
 */
function collectMissingThoughtIds(rs: ActivityRow[]): string[] {
  const missing: string[] = [];
  for (const r of rs) {
    for (const m of r.entity_title.matchAll(UUID_RE)) {
      const id = m[0].toLowerCase();
      if (thoughtTitles.has(id) || thoughtResolvePending.has(id)) continue;
      // Запрашиваем только для id, которые могут быть id мысли (link,
      // thought): подтип.typeClause/«→» всегда id мысли либо id типа.
      if (r.entity_type === 'link' || r.entity_type === 'thought') {
        missing.push(id);
        thoughtResolvePending.add(id);
      }
    }
  }
  return missing;
}

/** Подтягивает имена типов мыслей/связей/свойств из `store.state`. */
function refreshTypeNames(): void {
  typeNames.clear();
  for (const t of store.state.thoughtTypes) typeNames.set(t.id, t.name);
  for (const t of store.state.linkTypes) {
    // В снимках используется прямое имя forward для типа связи.
    typeNames.set(t.id, t.name_forward);
  }
}

/**
 * Резолвит пачку UUIDов из снимков в имена мыслей (для снимков `link` и
 * `thought`, где id может быть id источника/назначения/типа). После
 * получения имён таблица перерисовывается — UUIDы заменяются заголовками.
 */
async function resolveMissingThoughtTitles(
  page: ActivityRow[],
  networkId: string,
  seq: number,
): Promise<void> {
  const ids = collectMissingThoughtIds(page);
  if (ids.length === 0) return;
  try {
    const refs = await etn.thoughts.resolve(networkId, ids);
    for (const ref of refs) thoughtTitles.set(ref.id, ref.title);
    if (seq !== querySeq) return;
    renderTable();
  } catch {
    // Оставляем id в снимках — пользователь увидит короткие обозначения.
  } finally {
    for (const id of ids) thoughtResolvePending.delete(id);
  }
}

/** Подтягивает имена слоёв сети (однократно). */
async function refreshLayerTitles(networkId: string): Promise<void> {
  try {
    const layers = await etn.layers.list(networkId);
    layerTitles.clear();
    for (const l of layers) layerTitles.set(l.id, l.title);
  } catch {
    // Не критично — оставляем пустой кэш, ячейки покажут короткие id.
  }
}

/**
 * Возвращает человеко-читаемое имя слоя (если уже в кэше) либо короткий id.
 * Используется и в ячейке «Слой», и в диалоге снимка.
 */
export function layerDisplayName(id: string): string {
  return layerTitles.get(id) ?? shortId(id);
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
  addRow('Название', row.entity_title === '' ? '—' : resolveEntityTitle(row.entity_type, row.entity_title));
  addRow('Автор', row.user_name ?? row.user_id);
  addRow('Когда', formatDateTime(row.occurred_at_ms));
  addRow('Слой', row.layer_id === null ? '—' : layerDisplayName(row.layer_id));
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
