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
import { t } from '../../lib/i18n.js';

import { requireNetworkId } from '../../app.js';
import { setThoughtEditorTarget } from '../../editor/editor.js';
import { confirmDialog, errorDialog, showDialog } from '../../lib/dialog.js';
import {
  ACTIVITY_ACTION_FILTERS,
  activityRowPasses,
  buildActivityQueryPlan,

  type ActivityActionFilter,
} from '../../lib/filter-builder.js';
import {
  buildAuthorConditionSection,
  buildDatesSection,
  buildFilterFooterButtons,
  buildFilterForm,
  buildKeywordsSection,
  buildPillGroupSection,
  type FilterFormContext,
  type FilterSection,
} from '../../lib/filter-form.js';
import { div, el, span, setTooltip } from '../../lib/dom.js';
import { operationError } from '../../lib/ui/messages.js';
import { etn } from '../../lib/etn.js';
import { formatDateTime } from '../../lib/metadata.js';
import { notice } from '../../lib/notice.js';
import { openLayerPropsDialog } from '../layers.js';
import { showThoughtTypeEditor } from '../type-manager.js';
import { openPropertyManagerEditor } from '../property-manager.js';

import { mountFilterPanelFrame, type FilterPanelFrameHandle } from '../../lib/filter-panel-frame.js';
import { resolve, ensureLoaded, subscribe as subscribeUsers } from '../../lib/users.js';
import { store } from '../../state.js';
import { UI_STATE_KEY } from '@etn/shared';
import { uiButton } from '../../lib/ui/button.js';
import { fieldInput } from '../../lib/ui/field.js';
import { fieldRow } from '../../lib/ui/field.js';
import {
  DEFAULT_FILTER,
  ENTITY_TYPE_OPTIONS,
  type ActionFilter,
  type ActivityFilterState,
  parseActivityState,
} from './state.js';

const PAGE_SIZE = 50;
const ENTITY_TYPES: ReadonlyArray<ActivityEntityType> = ENTITY_TYPE_OPTIONS.map((o) => o.value);
/** Коды действий — словарь единого конструктора отбора. */
const ACTIONS: ReadonlyArray<ActionFilter> = ACTIVITY_ACTION_FILTERS as ReadonlyArray<ActivityActionFilter> as ReadonlyArray<ActionFilter>;

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
/** Индекс строки под курсором клавиатуры (`-1` — без курсора). */
let cursorRow = -1;
/** Индекс строки, по которой кликнули — отметка «выбрано» (запоминается между отрисовками). */
let selectedRowIdx = -1;
/** Ширина из ПРЕЖНЕГО пер-экранного снимка `activity_state` (задача 2ebe4206):
 *  миграционное значение для каркаса панели; размером владеет каркас. */
let panelWidth: number | null = null;
/** Рукоятка общего каркаса панели отбора (скрытость/положение/размер). */
let activityFrame: FilterPanelFrameHandle | null = null;
/** Границы ширины панели (px), как в Структурах мыслей. */
const PANEL_W_MIN = 260;
const PANEL_W_MAX = 480;

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
  panelWidth = null;

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
      panelWidth = parsed.panelWidth;
      // Восстановленный отбор показывает заполненные группы раскрытыми
      // (пустые — свёрнутыми), как «Структуры» при входе в вид.
      periodCollapsed = filter.createdAfter === '' && filter.createdBefore === '';
      authorCollapsed = filter.authorId === '' && filter.authorIds.length === 0;
      entitiesCollapsed = filter.entityTypes.length === 0;
      actionsCollapsed = filter.actions.length === 0;
      renderFilterPanel();
      // Миграционное значение прежнего снимка подхватывает каркас панели.
      activityFrame?.apply();
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

  // Layout: панель отбора + таблица. Размер и скрытость панели ведёт общий
  // каркас (задача 2ebe4206): положение по ширине полотна (слева/вверху) и
  // перетаскивание границы; состояние — `ui_state.activity_filter_panel`.
  const panel = div('activity-filter');
  const splitter = div('activity-splitter');
  const results = div('activity-results');
  hostEl.append(panel, splitter, results);
  activityFrame = mountFilterPanelFrame({
    container: hostEl,
    panel,
    splitter,
    stateKey: UI_STATE_KEY.ACTIVITY_FILTER_PANEL,
    minSize: PANEL_W_MIN,
    maxSize: PANEL_W_MAX,
    minSizeTop: 80,
    maxSizeTop: 600,
    legacySize: () => panelWidth,
  });

  mountFilterPanel(panel);
  // Maintenance commands + pager live inside the results column so destructive
  // actions stay visibly apart from the table.
  const toolbar = div('activity-toolbar');
  toolbar.append(
    uiButton({
      label: 'Свернуть до даты…',
      role: 'secondary',
      size: 's',
      onClick: () => void rollupDialog(),
    }),
    uiButton({
      label: 'Обрезать до даты…',
      role: 'danger',
      size: 's',
      onClick: () => void truncateDialog(),
    }),
  );
  results.append(toolbar);

  const tableWrapEl = div('admin-table-wrap activity-table-wrap');
  tableWrap = tableWrapEl;
  const pager = div('activity-pager');
  pagerLabel = span('', 'muted');
  pager.append(
    uiButton({
      label: '≪',
      role: 'secondary',
      size: 's',
      onClick: () => void gotoPage(0),
    }),
    uiButton({
      label: '‹',
      role: 'secondary',
      size: 's',
      onClick: () => void gotoPage(offset - PAGE_SIZE),
    }),
    pagerLabel,
    uiButton({
      label: '›',
      role: 'secondary',
      size: 's',
      onClick: () => void gotoPage(offset + PAGE_SIZE),
    }),
    uiButton({
      label: '≫',
      role: 'secondary',
      size: 's',
      onClick: () => void gotoPage(Math.floor(Math.max(0, total - 1) / PAGE_SIZE) * PAGE_SIZE),
    }),
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
    // Рамка «открытая в редакторе сущность» реагирует на смену editorTarget.
    repaintCursorAndCurrent();
    // Фон списка меняется автоматически через CSS-переменную --layer-bg,
    // которую выставляет глобальный initLayerTheme() (см. lib/layer-colors.ts).
  });
  // The names may resolve after the first paint — subscribe and re-render
  // author cells when the user cache changes.
  subscribeUsers(() => repaintNames());

  // Keyboard navigation across rows (08-ui-spec.md §18, замечание
  // пользователя — «невозможно перемещаться с помощью клавиш»). Хэндлер
  // вешается на хост, чтобы не зависеть от рендера таблицы.
  hostEl.addEventListener('keydown', onTableKeydown);
}

// ---------------------------------------------------------------------------
// Filter panel
// ---------------------------------------------------------------------------

/** Хост панели отбора (нужен для перерисовки из состояния). */
let filterPanelHost: HTMLElement | null = null;

/**
 * Сворачивание групп панели отбора (задача 2ebe4206): «События» повторяют
 * принцип эталона «Структур» — группы сворачиваются. Состояние временное (не
 * персистится), как у «Структур»; по умолчанию свёрнуты, пока группы пусты.
 */
let periodCollapsed = true;
let authorCollapsed = true;
let entitiesCollapsed = true;
let actionsCollapsed = true;

/** Перестраивает панель отбора из состояния — секции общего каркаса. */
function renderFilterPanel(): void {
  const area = filterPanelHost;
  if (area === null) return;
  area.replaceChildren();

  const sections: FilterSection[] = [];
  const touch = (): void => {
    for (const section of sections) section.refresh();
  };
  const ctx: FilterFormContext = {
    networkId: requireNetworkId(),
    getState: () => filter,
    registry: new Map(),
    touch,
  };

  sections.push(
    buildKeywordsSection(ctx, {
      placeholder: "название* -тест",
      tooltip: "Поиск по снимку entity_title (через пробел, * и - как в Структурах)",
      onEnter: () => void applyQuery(),
    }),
    buildDatesSection(
      ctx,
      { get: () => periodCollapsed, set: (v) => (periodCollapsed = v) },
      {
        title: "Период",
        ranges: [
          {
            label: "Период",
            getFrom: () => filter.createdAfter,
            getTo: () => filter.createdBefore,
            setFrom: (v) => {
              filter.createdAfter = v;
            },
            setTo: (v) => {
              filter.createdBefore = v;
            },
          },
        ],
        isNonEmpty: () => filter.createdAfter !== "" || filter.createdBefore !== "",
      },
    ),
    buildAuthorConditionSection(ctx, {
      title: "Пользователь",
      label: "Пользователь",
      field: "author",
      collapse: { get: () => authorCollapsed, set: (v) => (authorCollapsed = v) },
    }),
    // Словари панели: значения и подписи — параметры общей секции
    // флажков-пилюль; флажки строит каркас и сразу показывает ими
    // применённый отбор (ошибка 83f6028e: своя сборка без восстановления
    // состояния оставляла флажки снятыми при непустом отборе, и непустая
    // лента выглядела как «события не сохраняются»).
    buildPillGroupSection<ActivityEntityType>(ctx, {
      title: "Тип сущности",
      items: ENTITY_TYPE_OPTIONS.map((o) => ({
        value: o.value,
        label: ENTITY_LABELS[o.value] ?? o.value,
      })),
      get: () => filter.entityTypes,
      set: (next) => {
        filter.entityTypes = next;
      },
      collapse: { get: () => entitiesCollapsed, set: (v) => (entitiesCollapsed = v) },
    }),
    buildPillGroupSection<ActionFilter>(ctx, {
      title: "Действие",
      items: ACTIONS.map((a) => ({ value: a, label: ACTION_LABELS[a] })),
      get: () => filter.actions,
      set: (next) => {
        filter.actions = next;
      },
      collapse: { get: () => actionsCollapsed, set: (v) => (actionsCollapsed = v) },
    }),
  );

  buildFilterForm({
    sections,
    footer: [
      buildFilterFooterButtons({
        onApply: () => void applyQuery(),
        onClear: () => {
          filter = { ...DEFAULT_FILTER };
          periodCollapsed = true;
          authorCollapsed = true;
          entitiesCollapsed = true;
          actionsCollapsed = true;
          renderFilterPanel();
          void applyQuery();
        },
      }),
    ],
    mount: area,
  });
}

function mountFilterPanel(area: HTMLElement): void {
  filterPanelHost = area;
  renderFilterPanel();
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
    const fromMs = dateToMs(filter.createdAfter, false);
    const toMs = dateToMs(filter.createdBefore, true);
    // План запроса — единый конвертер критериев конструктора. Часть отбора
    // серверный API не выражает (действие, `empty`/`not_empty`, `ne`/`not_in`,
    // ключевые слова) — эти условия применяются клиентом ниже, в
    // `activityRowPasses`, и помечены в `plan.clientFilter`.
    const plan = buildActivityQueryPlan(filter, ENTITY_TYPES);
    const buckets: ActivityRow[] = [];
    let bucketTotal = 0;
    for (const et of plan.entityTypes) {
      for (const uid of plan.userIds) {
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
        // Клиентская дофильтровка: у сервера нет ни `action`, ни `IS NULL`
        // по автору, ни `NOT IN`, ни полнотекстового мини-синтаксиса по
        // `entity_title` (требование b0c7a57c). Условие не теряется, а
        // применяется явно здесь; пагинация — по типу сущности.
        for (const r of result.rows) {
          if (activityRowPasses(filter, plan, r)) buckets.push(r);
        }
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
    // Ключевые слова уже отфильтрованы `activityRowPasses` (мини-синтаксис
    // по `entity_title`); страница — от объединённого набора.
    const page = merged.slice(0, PAGE_SIZE);
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
  tableWrap.replaceChildren(operationError(err));
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
    // Курсор не должен вылезать за пределы страницы — после смены
    // данных откатываем к 0, если прошлый индекс уже неактуален.
    if (cursorRow >= rows.length) cursorRow = rows.length - 1;
    if (cursorRow < 0 && rows.length > 0) cursorRow = 0;
    rows.forEach((r, index) => tbody.append(buildRow(r, index)));
  }
  table.append(tbody);
  tableWrap.replaceChildren(table);
  repaintPager();
  repaintCursorAndCurrent();
  // Фон .activity-results задан через var(--layer-bg) на CSS-стороне
  // (см. .activity-results в styles.css) — нет нужды красить вручную.

  // Row click — open the entity when it still exists (08-ui-spec.md §18:
  // «удалённые сущности — read-only с пометкой»). We do a quick check: try
  // `GET` and, on `NOT_FOUND`, fall back to a read-only placeholder.
  tbody.addEventListener('click', (event) => {
    const tr = (event.target as HTMLElement | null)?.closest<HTMLElement>('.activity-row');
    if (tr?.dataset['id'] === undefined) return;
    const idx = Number(tr.dataset['idx'] ?? '-1');
    const row = rows.find((r) => r.id === tr.dataset['id']);
    if (row === undefined) return;
    cursorRow = idx;
    selectedRowIdx = idx;
    repaintCursorAndCurrent();
    void openEntity(row);
  });
}

/** One table row — click opens the entity when alive. */
function buildRow(row: ActivityRow, index: number): HTMLElement {
  const tr = el('tr', 'activity-row');
  tr.dataset['id'] = row.id;
  tr.dataset['idx'] = String(index);
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

/**
 * Перерисовывает классы `activity-row-cursor` (строка под курсором
 * клавиатуры) и `activity-row-current` (сущность открыта в редакторе).
 * Вызывается после изменения курсора или смены `editorTarget`.
 */
function repaintCursorAndCurrent(): void {
  if (tableWrap === null) return;
  const currentEntityId = currentEntityIdForRow();
  const trs = tableWrap.querySelectorAll<HTMLElement>('.activity-row');
  trs.forEach((tr) => {
    const idx = Number(tr.dataset['idx'] ?? '-1');
    const rowId = tr.dataset['id'];
    tr.classList.toggle('activity-row-cursor', idx === cursorRow);
    tr.classList.toggle(
      'activity-row-current',
      rowId !== undefined && currentEntityId !== null && rowIdForEntity(currentEntityId) === rowId,
    );
  });
}

/** Id сущности, открытой в редакторе (для подсветки строки). */
function currentEntityIdForRow(): { kind: 'thought' | 'link'; id: string } | null {
  const target = store.state.editorTarget;
  if (target === null) return null;
  if (target.kind === 'thought' || target.kind === 'link') return target;
  return null;
}

/** Сравнивает row.entity_id с текущей открытой сущностью. */
function rowIdForEntity(entity: { kind: 'thought' | 'link'; id: string }): string | null {
  // Возвращаем строку для сравнения c `tr.dataset['id']` (id строки, не сущности).
  // Здесь нужен именно row.id — ассоциация строится по нему, поэтому
  // ищем row с подходящим entity_id/entity_type и возвращаем его id.
  const match = rows.find(
    (r) =>
      (entity.kind === 'thought' && r.entity_type === 'thought' && r.entity_id === entity.id) ||
      (entity.kind === 'link' && r.entity_type === 'link' && r.entity_id === entity.id),
  );
  return match?.id ?? null;
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

/** Arrow-keys / Home / End / Enter — навигация по таблице событий. */
function onTableKeydown(event: KeyboardEvent): void {
  // Не перехватываем ввод в полях фильтра — пользователь может
  // пользоваться стрелками в самом инпуте/селекте.
  const target = event.target as HTMLElement | null;
  if (
    target !== null &&
    (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')
  ) {
    return;
  }
  if (rows.length === 0) return;
  const last = rows.length - 1;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      cursorRow = cursorRow < last ? cursorRow + 1 : 0;
      repaintCursorAndCurrent();
      scrollCursorIntoView();
      break;
    case 'ArrowUp':
      event.preventDefault();
      cursorRow = cursorRow > 0 ? cursorRow - 1 : last;
      repaintCursorAndCurrent();
      scrollCursorIntoView();
      break;
    case 'Home':
      event.preventDefault();
      cursorRow = 0;
      repaintCursorAndCurrent();
      scrollCursorIntoView();
      break;
    case 'End':
      event.preventDefault();
      cursorRow = last;
      repaintCursorAndCurrent();
      scrollCursorIntoView();
      break;
    case 'Enter': {
      event.preventDefault();
      const row = cursorRow >= 0 ? rows[cursorRow] : undefined;
      if (row !== undefined) {
        selectedRowIdx = cursorRow;
        repaintCursorAndCurrent();
        void openEntity(row);
      }
      break;
    }
    case 'PageDown':
      event.preventDefault();
      cursorRow = Math.min(last, cursorRow + 10);
      repaintCursorAndCurrent();
      scrollCursorIntoView();
      break;
    case 'PageUp':
      event.preventDefault();
      cursorRow = Math.max(0, cursorRow - 10);
      repaintCursorAndCurrent();
      scrollCursorIntoView();
      break;
    default:
      return;
  }
}

/** Прокручивает контейнер таблицы так, чтобы курсор был видим. */
function scrollCursorIntoView(): void {
  if (tableWrap === null || cursorRow < 0) return;
  const tr = tableWrap.querySelectorAll<HTMLElement>('.activity-row')[cursorRow];
  if (tr === undefined) return;
  tr.focus({ preventScroll: false });
  tr.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
  // Не переключаем активный слой: событие может относиться к другому слою,
  // а пользователь ожидает продолжить работу в текущем (фон таблицы
  // событий не должен слетать на белый/чёрный). Конкретный слой события
  // передаётся через `at_layer_id` в GET-запросе — сущность открывается
  // в нужном слое без смены сессии (задача 59119797).
  const atLayer = row.layer_id ?? undefined;
  try {
    switch (row.entity_type) {
      case 'thought': {
        const thought = await etn.thoughts.get(networkId, row.entity_id, atLayer);
        await setThoughtEditorTarget(thought);
        return;
      }
      case 'link': {
        const link = await etn.links.get(networkId, row.entity_id, atLayer);
        store.update({
          editorTarget: { kind: 'link', id: link.id, link },
          selectedLinkId: link.id,
        });
        return;
      }
      // Комментарий/вложение: открываем владельца (мысль или связь) — это
      // то, что просил пользователь («событие по комментарию → мысль/связь,
      // к которой он привязан»).
      case 'comment': {
        const comment = await etn.comments.get(networkId, row.entity_id);
        await openCommentOrAttachmentOwner(comment.targets[0], atLayer);
        return;
      }
      case 'attachment': {
        const attachment = await etn.attachments.get(networkId, row.entity_id);
        await openCommentOrAttachmentOwner(
          {
            owner_type: attachment.owner_type,
            owner_id: attachment.owner_id,
          },
          atLayer,
        );
        return;
      }
      case 'thought_type': {
        // Сначала пробуем кэш — избегаем лишнего round-trip.
        const cached = store.state.thoughtTypes.find((t) => t.id === row.entity_id);
        const type = cached ?? (await etn.types.getThoughtType(networkId, row.entity_id));
        void showThoughtTypeEditor(type, () => undefined);
        return;
      }
      case 'link_type': {
        // Редактор типа связи упразднён (требование 09f692ff, задача
        // 09201bd4): единственная точка редактирования типа связи —
        // свойство-связь через единый диалог. Ищем связанное свойство по
        // `link_type_id` в реестре; если его нет — сообщаем пользователю
        // (тип связи без свойства бесполезен в 0.8.1).
        try {
          const rows = await etn.propertyRegistry.list(networkId);
          const prop = rows.find((r) => r.value_type === 'link' && r.config?.link_type_id === row.entity_id);
          if (prop === undefined) {
            notice('Для этого типа связи ещё нет свойства в реестре — редактирование невозможно.');
            return;
          }
          openPropertyManagerEditor(prop, () => undefined);
        } catch (err) {
          errorDialog('Открыть свойство-связь', err);
        }
        return;
      }
      // Слой: диалог свойств слоя (название/комментарий/цвета). Работает
      // по id слоя — даже если он удалён/скрыт, диалог сам покажет снимок
      // через свой fallback (замечание пользователя: «ожидаю диалог свойств»).
      case 'layer': {
        openLayerPropsDialog(networkId, row.entity_id);
        return;
      }
      case 'property':
        // Для свойств клиентского редактора нет — оставляем снимок.
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

/**
 * Открывает владельца комментария/вложения (мысль или связь) в редакторе.
 * Если у комментария нет ни одного target (например, он был удалён вместе
 * с владельцем), показывается снимок из activity_log.
 * `atLayer` пробрасывается в GET — иначе для события из чужого слоя
 * запрос провалится (задача 59119797).
 */
async function openCommentOrAttachmentOwner(
  target: { owner_type: 'thought' | 'link'; owner_id: string } | undefined,
  atLayer?: string,
): Promise<void> {
  if (target === undefined) return; // вызывающий обработает снимок
  const networkId = requireNetworkId();
  if (target.owner_type === 'thought') {
    const thought = await etn.thoughts.get(networkId, target.owner_id, atLayer);
    await setThoughtEditorTarget(thought);
    return;
  }
  const link = await etn.links.get(networkId, target.owner_id, atLayer);
  store.update({
    editorTarget: { kind: 'link', id: link.id, link },
    selectedLinkId: link.id,
  });
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
    size: 'm',
    buttons: [{ label: t('actions.close'), primary: true }],
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
  const input = fieldInput({ extraClass: 'activity-date' }) as HTMLInputElement;
  input.type = 'date';
  setTooltip(input, 'Все записи журнала до этой даты будут затронуты.');
  const dateField = fieldRow({ label: 'Дата (включительно)', control: input });
  const body = div('form-stack');
  body.append(
    dateField,
    el('p', 'muted activity-maintenance-hint', 'Операция необратима — записи будут удалены без возможности восстановления.'),
  );
  const ok = await new Promise<number | null>((resolve) => {
    showDialog({
      title: opts.title,
      body,
      size: 's',
      buttons: [
        { label: t('actions.cancel'), onClick: () => resolve(null) },
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
