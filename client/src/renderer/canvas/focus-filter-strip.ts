/**
 * Focus filter strip (task 02ba2ae7, spec 9984aa98 «Полоса отборов под мыслью
 * в фокусе», 0.7.3).
 *
 * A horizontal row of buttons that lives between the focus cloud and the
 * children zone. Left-to-right:
 *   1. «Потомки» (always first; the canvas's native children-zone mode).
 *   2. The effective set of views for the focused thought's type, in the
 *      server-supplied order (root → type, then `position` inside each level
 *      — requirement eaca1253).
 *   3. «⋯» dropdown for buttons that don't fit the available width.
 *   4. «+» to add a new view (opens the editor dialog — stage 8).
 *
 * Exactly one button is active. On focus switch the active mode is reset
 * to the focus's default view (or «Потомки» when no default is set); the
 * per-focus selection persists across focus changes inside the same tab
 * (L4 `focus_filter_strip` JSON).
 *
 * The lower zone renders the result of the selected mode: children of the
 * focus (the canvas default) or the result of running the picked view
 * against the focus. The strip drives the canvas via {@link getActiveMode}
 * and {@link takeViewResult}; the canvas treats the view result like a
 * regular children page but disables the actions that only make sense for
 * actual focus children (manual order, double-click-to-add).
 */

import { UI_STATE_KEY } from '@etn/shared';
import type { FocusResponse, ThoughtRef } from '@etn/shared';
import type { StructureSort, SortOrder } from '@etn/shared';

import { openViewEditorDialog } from '../screens/thought-type/filter-dialog.js';
import { openCanvasLinkFilterDialog } from './link-filter-dialog.js';
import { confirmDialog } from '../lib/dialog.js';
import { etn } from '../lib/etn.js';
import { div } from '../lib/dom.js';
import { isFilterSort, isSortOrder, sortValueLabel } from '../lib/filter-builder.js';
import { svgIcon } from '../lib/ui/icon.js';
import { isInBaseLayer } from '../lib/layer-base.js';
import { showMenuAt, MENU_SEPARATOR, type MenuItem } from '../lib/menu.js';
import { onQueryInvalidated } from '../lib/live/index.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';

/** Mode of the lower zone: children of the focus or a specific view's run. */
export type StripMode =
  | { kind: 'children' }
  | { kind: 'view'; viewId: string; viewName: string; viewTypeId: string };

/** Result of the most recent view run, kept in memory for the canvas to
 *  paint into the children zone. Cleared on focus change or when the user
 *  switches back to «Потомки». */
export interface ViewResult {
  viewId: string;
  viewName: string;
  viewTypeId: string;
  /** Context thought id the view was run for. */
  focusId: string;
  items: ThoughtRef[];
  /** Direction flags for ellipse fill, `id → { has_incoming, has_outgoing }`. */
  directions: Record<string, { has_incoming: boolean; has_outgoing: boolean }>;
  /** `[]` — empty because no match, `null` — empty because tokens did not
   *  resolve (the lower zone shows the explanation text). */
  unresolved: ReadonlyArray<{ token: string; reason: string }> | null;
  /** True when the run returned no rows AND no unresolved tokens. */
  empty: boolean;
  /** Общее число мыслей отбора по серверу (`meta.total`). Индикатор-число
   *  нижней зоны показывает именно его, а не длину загруженной порции
   *  (ошибка 4493811f). */
  total: number;
  /** offset следующей порции отбора — сколько сырых строк сервера уже
   *  израсходовано (учитывает и отфильтрованную контекстную мысль). */
  nextOffset: number;
  /** Порции исчерпаны: загружено всё (`items.length >= total`) или сервер
   *  вернул пустую страницу. */
  exhausted: boolean;
}

/**
 * Размер порции результата отбора в нижней зоне карты. Совпадает с дефолтом
 * сервера для `POST /thoughts/{id}/views/{view}/run` (`runViewForThought`:
 * `options?.limit ?? 100`), поэтому первая порция запрашивается без явного
 * `limit`, а offset следующей равен этому размеру. Динамическая пагинация
 * отбора — требование карточки ошибки 4493811f.
 */
export const VIEW_PAGE_SIZE = 100;

/** Per-focus mode map persisted to L4 as a JSON string. Unknown modes fall
 *  back to the focus's default view (or «Потомки»). */
type PersistedStrip = Record<string, StripMode>;

let host: HTMLElement | null = null;
let stripEl: HTMLElement | null = null;
let buttonsEl: HTMLElement | null = null;
let overflowBtn: HTMLButtonElement | null = null;

/** Current active mode for the focused thought. */
let currentMode: StripMode = { kind: 'children' };
/** Last view run result; `null` until the user clicks a view button. */
let lastResult: ViewResult | null = null;
/** Currently focused thought id (used as the map key in L4). */
let currentFocusId: string | null = null;
/** Currently focused thought type id (cached for the «+» button enable rule). */
let currentFocusTypeId: string | null | undefined = undefined;

/** Per-focus mode persistence. Loaded once per tab from L4 and patched on
 *  every click. Unknown entries (`viewId` not in the current effective set)
 *  fall back to children when restoring. */
let persisted: PersistedStrip = {};

/** Latest effective-views list for the focus's type, kept so a view button
 *  can resolve to the same `name_key`/`id` even if `meta.views` is stale. */
let effectiveViews: EffectiveViewRow[] = [];

/** Per-button paint data — the order is server-supplied (root → type,
 *  then `position`). `inherited` carries visual hints («унаследован»). */
interface EffectiveViewRow {
  id: string;
  name: string;
  name_key: string;
  description: string | null;
  /** `true` — defined on a type ancestor (greyed tooltip). */
  inherited: boolean;
  /** Id of the type this view is defined on (relevant for delete-owner UX). */
  defined_on: string;
  /** Position within the type level (for the dropdown overflow list). */
  position: number;
  version: number;
  /** `true` — this is the focus's default view. */
  is_default: boolean;
  /** `true` — defined on the focus's own type (vs. inherited). */
  isOwn: boolean;
}

/** Subscribers notified on every mode change. The canvas listens so it can
 *  re-render the lower zone without waiting for the next focus change. */
type ModeListener = (mode: StripMode) => void;
const modeListeners: ModeListener[] = [];

/** Adds a listener for mode changes. Returns an unsubscribe handle. */
export function onModeChange(listener: ModeListener): () => void {
  modeListeners.push(listener);
  return () => {
    const idx = modeListeners.indexOf(listener);
    if (idx >= 0) modeListeners.splice(idx, 1);
  };
}

/**
 * Test seam: число живых подписчиков смены режима. Нужен сторожу
 * `guard-canvas-teardown.test.ts`, который проверяет, что teardown канваса
 * снимает слушателя и они не накапливаются между монтированиями рабочего
 * пространства (ошибка 37b713de). Продуктовый код им не пользуется.
 */
export function debugModeListenerCount(): number {
  return modeListeners.length;
}

/** Returns the current strip mode for the canvas render path. */
export function getActiveMode(): StripMode {
  return currentMode;
}

/** Returns the last view run result, or `null` when the active mode is
 *  «Потомки» or a view has not been run yet. */
export function takeViewResult(): ViewResult | null {
  return lastResult;
}

/** Drops the cached view result (called when the user goes back to
 *  «Потомки» so the next focus render does not briefly flash stale data). */
export function clearViewResult(): void {
  lastResult = null;
}

/**
 * Есть ли мысль среди строк ТЕКУЩЕГО результата отбора (замечание G2 65286909).
 * Холст по этому признаку решает, переисполнять ли отбор на инвалидацию
 * `focus:@<id>`: правка мысли, уже видимой строкой отбора, могла изменить строку
 * и требует переисполнения; правка мысли вне окрестности И вне отбора —
 * не требует (не тратим лишний `views.run`).
 */
export function isThoughtInViewResult(id: string): boolean {
  return lastResult !== null && lastResult.items.some((item) => item.id === id);
}

/**
 * Realtime-путь (ошибка 4fca95c9): вернуть `true`, если активен режим отбора —
 * его результат мог устареть от только что пришедшего события о мыслях/рёбрах/
 * значениях свойств, и холст обязан перерисоваться, иначе `render()` не побежит
 * (результат отбора не входит в ключ перерисовки `canvasRenderKey`) и
 * `runActiveViewIfNeeded` не переисполнит отбор. Сбрасывает кэш, чтобы при
 * задержке рендера нижняя зона не мигнула устаревшими строками.
 *
 * В режиме «Потомки» возвращает `false`: там нижняя зона — сама окрестность
 * фокуса, и её изменения отлавливаются ключом перерисовки.
 */
export function invalidateViewResultForRealtime(): boolean {
  if (currentMode.kind !== 'view') return false;
  lastResult = null;
  return true;
}

// ---------------------------------------------------------------------------
// Persistence (L4 `focus_filter_strip`)
// ---------------------------------------------------------------------------

/** Loads the persisted strip state from L4. Called once per tab mount. */
export async function loadPersistedStrip(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) {
    persisted = {};
    return;
  }
  try {
    const raw = await etn.ui.getState(networkId, UI_STATE_KEY.FOCUS_FILTER_STRIP);
    if (raw === null || raw === '') {
      persisted = {};
      return;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      persisted = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const mode = parsePersistedMode(value);
        if (mode !== null) persisted[key] = mode;
      }
    } else {
      persisted = {};
    }
  } catch {
    persisted = {};
  }
}

/** Parses one persisted entry; tolerates older shapes that lack
 *  `viewTypeId` (the editor dialog re-resolves it on the next render). */
function parsePersistedMode(value: unknown): StripMode | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (obj['kind'] === 'children') return { kind: 'children' };
  if (obj['kind'] === 'view') {
    const viewId = obj['viewId'];
    const viewName = obj['viewName'];
    const viewTypeId = obj['viewTypeId'];
    if (typeof viewId !== 'string' || typeof viewName !== 'string') return null;
    return {
      kind: 'view',
      viewId,
      viewName,
      viewTypeId: typeof viewTypeId === 'string' ? viewTypeId : '',
    };
  }
  return null;
}

/** Saves the full per-focus map back to L4 (best-effort, swallow errors). */
function persistStrip(): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  void etn.ui.setState(networkId, UI_STATE_KEY.FOCUS_FILTER_STRIP, JSON.stringify(persisted)).catch(() => {
    /* L4 is best-effort */
  });
}

// ---------------------------------------------------------------------------
// Mount + render
// ---------------------------------------------------------------------------

/** Mounts the strip into the canvas host and wires up the bus. Called once
 *  from `mountCanvas` right after the focus row is created. The strip lives
 *  between the focus row and the horizontal splitter so the splitter drag
 *  still resizes the children zone; the strip's height is fixed by content. */
export function mountFilterStrip(canvasHost: HTMLElement): void {
  host = canvasHost;
  stripEl = div('canvas-filter-strip');
  stripEl.setAttribute('role', 'toolbar');
  stripEl.setAttribute('aria-label', 'Полоса отборов');
  buttonsEl = div('canvas-filter-strip-buttons');
  stripEl.append(buttonsEl);
  stripEl.classList.add('hidden');
  // The host keeps its DOM order (top, focusRow, splitterH, zoneChildren,
  // empty, layerLabel) — we insert the strip *between* focusRow and the
  // horizontal splitter so the splitter drag still controls the children
  // zone height. insertBefore preserves the host's existing children.
  const focusRowEl = host.querySelector<HTMLElement>('.canvas-focus-row');
  const splitterH = host.querySelector<HTMLElement>('.zone-splitter-h');
  if (focusRowEl !== null && splitterH !== null) {
    host.insertBefore(stripEl, splitterH);
  } else if (focusRowEl !== null) {
    focusRowEl.insertAdjacentElement('afterend', stripEl);
  } else {
    host.append(stripEl);
  }
}

/**
 * Repaints the strip for the current focus. Pass `null` when the canvas
 * has no focus (the strip hides itself). The effective views list is
 * computed from the focus's `meta.views` (server-supplied) plus a fallback
 * to a direct `thoughtTypeViews.list` when the focus is typed but `meta`
 * is missing the views block (the canonical list lives in MCP `meta.views`,
 * but the focus REST endpoint does not currently carry it — see below).
 *
 * Note: the focus REST endpoint returns parents/children/siblings only;
 * `meta.views` lives on `etn.thoughts.get`. Until the focus endpoint ships
 * it, the strip fetches the focused thought once per focus change to
 * learn the effective set. The fallback keeps the strip correct today and
 * disappears automatically when the focus response carries the block.
 */
export async function renderStrip(focus: FocusResponse | null): Promise<void> {
  if (stripEl === null || buttonsEl === null || host === null) return;
  if (focus === null) {
    stripEl.classList.add('hidden');
    currentFocusId = null;
    currentFocusTypeId = undefined;
    effectiveViews = [];
    return;
  }
  const focusChanged = focus.focused.id !== currentFocusId;
  currentFocusId = focus.focused.id;
  currentFocusTypeId = focus.focused.type_id ?? null;
  // Per-focus bookkeeping resets ONLY on a real focus change. `renderStrip`
  // runs on EVERY canvas render (a store notification, the zone pager, a
  // realtime refresh of the same focus), not just on a focus switch: dropping
  // the cached run result there let a superseded run hand `null` to the canvas
  // and paint the lower zone empty until the user toggled the mode by hand
  // (ошибка 90811979). The sort cache is dropped with it and re-read lazily.
  if (focusChanged) {
    lastResult = null;
    invalidateViewSortCache();
    // Сообщение о неподдерживаемой сортировке — тоже заново на новый фокус.
    unsupportedSortNotified = null;
  }
  // Resolve the effective chain. The focus endpoint doesn't ship
  // `meta.views` yet, so the strip reads the focus via `thoughts.get` and
  // falls back to a `thoughtTypeViews.list` direct call for typed thoughts
  // (the root-type path is the same: `thoughtTypeViews.list` accepts the
  // root id; requirement 23e0f78e).
  const views = await loadEffectiveViews(focus);
  effectiveViews = views;
  // Pick the mode: persisted > default view > «Потомки».
  const persistedMode = persisted[focus.focused.id];
  const isValidPersisted =
    persistedMode !== undefined &&
    (persistedMode.kind === 'children' ||
      views.some((v) => v.id === persistedMode.viewId));
  const defaultView = views.find((v) => v.is_default);
  let mode: StripMode;
  if (isValidPersisted && persistedMode !== undefined) {
    mode = persistedMode;
  } else if (defaultView !== undefined) {
    mode = {
      kind: 'view',
      viewId: defaultView.id,
      viewName: defaultView.name_key,
      viewTypeId: defaultView.defined_on,
    };
  } else {
    mode = { kind: 'children' };
  }
  setMode(mode, /* fireListeners */ true);

  // Paint the buttons.
  clear(buttonsEl);
  buttonsEl.append(buildChildrenButton(mode));
  for (const view of views) {
    buttonsEl.append(buildViewButton(view, mode));
  }
  overflowBtn = buildOverflowButton(views, mode);
  buttonsEl.append(overflowBtn);
  buttonsEl.append(buildAddButton());
  buttonsEl.append(buildFilterButton());
  stripEl.classList.remove('hidden');
  layoutStrip(views);
}

// ---------------------------------------------------------------------------
// Effective-view resolution
// ---------------------------------------------------------------------------

/**
 * Loads the effective set of views for the focused thought. Order is
 * server-supplied (`root → type`, then `position` inside each level); we
 * re-fetch on every focus change because the focus endpoint doesn't carry
 * `meta.views` yet (the list endpoint accepts the type id, not the focus).
 */
  async function loadEffectiveViews(focus: FocusResponse): Promise<EffectiveViewRow[]> {
  const networkId = store.state.networkId;
  if (networkId === null) return [];

  // 1. Try `meta.views` on the focused thought (zero-cost when the server
  //    eventually ships it on the focus response too).
  type RawView = {
    id: string;
    name: string;
    name_key: string;
    description: string | null;
    defined_on: string;
    inherited: boolean;
    is_default: boolean;
    position?: number;
    version?: number;
  };
  const views: RawView[] = [];
  try {
    const thought = await etn.thoughts.get(networkId, focus.focused.id);
    const metaViews = (thought as unknown as { meta?: { views?: unknown[] } }).meta?.views;
    if (Array.isArray(metaViews)) {
      for (const v of metaViews) {
        if (v === null || typeof v !== 'object') continue;
        const row = v as Record<string, unknown>;
        if (
          typeof row['id'] === 'string' &&
          typeof row['name'] === 'string' &&
          typeof row['name_key'] === 'string' &&
          typeof row['defined_on'] === 'string'
        ) {
          views.push({
            id: row['id'],
            name: row['name'],
            name_key: row['name_key'],
            description: typeof row['description'] === 'string' ? row['description'] : null,
            defined_on: row['defined_on'],
            inherited: row['inherited'] === true,
            is_default: row['is_default'] === true,
          });
        }
      }
    }
  } catch {
    // Ignore — fall back to a direct list.
  }

  // 2. Fallback: ask the type's views list directly. The list endpoint
  //    returns both own (`data`) and effective (`meta.effective`) views;
  //    we re-read the effective chain so the strip sees inherited views
  //    even when `meta.views` is missing on `thoughts.get`.
  if (views.length === 0) {
    const typeId = focus.focused.type_id;
    if (typeId !== null && typeId !== undefined) {
      try {
        const resp = await etn.thoughtTypeViews.list(networkId, typeId, { includeEffective: true });
        if (Array.isArray(resp.meta.effective)) {
          for (const v of resp.meta.effective) {
            views.push({
              id: v.id,
              name: v.name,
              name_key: v.name_key,
              description: v.description,
              defined_on: v.thought_type_id,
              inherited: v.thought_type_id !== typeId,
              is_default: v.is_default === true,
              position: v.position,
              version: v.version,
            });
          }
        }
      } catch {
        // Type may have been deleted; render the strip without views.
      }
    } else {
      // Type-less thought: requirement 23e0f78e — root-type views apply,
      // but the list endpoint requires a real type id. The effective chain
      // still arrives on `thoughts.get.meta.views` (the server uses the
      // root id under the hood); if step 1 produced nothing, render empty.
    }
  }

  // Сохраняем порядок сервера как есть: эффективный набор уже собран как
  // «корень → тип, внутри уровня по position» (getEffectiveViewsForThought,
  // требование eaca1253). Пересортировка здесь по глобальному `position`
  // переплетает уровни для унаследованных отборов (каждый уровень типов
  // нумерует свои `position` с 0) — ошибка 9792d55a, поэтому НЕ сортируем.
  return views.map((v, idx): EffectiveViewRow => ({
    id: v.id,
    name: v.name,
    name_key: v.name_key,
    description: v.description,
    inherited: v.inherited,
    defined_on: v.defined_on,
    position: v.position ?? idx,
    version: v.version ?? 0,
    is_default: v.is_default,
    isOwn: !v.inherited,
  }));
}

// ---------------------------------------------------------------------------
// Button builders
// ---------------------------------------------------------------------------

function buildChildrenButton(mode: StripMode): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'canvas-filter-strip-btn';
  btn.dataset['mode'] = 'children';
  btn.textContent = 'Потомки';
  if (mode.kind === 'children') btn.classList.add('active');
  btn.addEventListener('click', () => {
    if (currentMode.kind === 'children') return;
    setMode({ kind: 'children' }, true);
    persistForCurrentFocus();
    notifyModeChange();
    // Re-render the strip so the active marker moves; the canvas listens
    // and repaints the children zone.
  });
  return btn;
}

function buildViewButton(view: EffectiveViewRow, mode: StripMode): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'canvas-filter-strip-btn';
  btn.dataset['viewId'] = view.id;
  // Баг 3: обрезаем отображаемое имя после 30-го символа; полное имя — в
  // тултипе (с описанием, если оно есть), чтобы его можно было прочитать.
  btn.textContent = view.name.length > 30 ? `${view.name.slice(0, 30)}…` : view.name;
  btn.title = view.description !== null && view.description !== ''
    ? `${view.name}\n${view.description}`
    : view.name;
  if (view.inherited) btn.classList.add('inherited');
  if (mode.kind === 'view' && mode.viewId === view.id) btn.classList.add('active');
  btn.addEventListener('click', () => {
    if (
      currentMode.kind === 'view' &&
      currentMode.viewId === view.id
    ) {
      return;
    }
    setMode(
      {
        kind: 'view',
        viewId: view.id,
        viewName: view.name_key,
        viewTypeId: view.defined_on,
      },
      true,
    );
    persistForCurrentFocus();
    notifyModeChange();
  });
  btn.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showViewMenu(event.clientX, event.clientY, view);
  });
  return btn;
}

function buildOverflowButton(views: EffectiveViewRow[], mode: StripMode): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'canvas-filter-strip-btn canvas-filter-strip-overflow';
  btn.textContent = '⋯';
  btn.title = 'Не поместившиеся отборы';
  btn.addEventListener('click', (event) => {
    const items: MenuItem[] = views.map((view) => ({
      label: view.name + (view.inherited ? ' (унаследован)' : ''),
      checked: mode.kind === 'view' && mode.viewId === view.id,
      onClick: () => {
        setMode(
          {
            kind: 'view',
            viewId: view.id,
            viewName: view.name_key,
            viewTypeId: view.defined_on,
          },
          true,
        );
        persistForCurrentFocus();
        notifyModeChange();
      },
    }));
    if (items.length === 0) {
      items.push({ label: 'Нет отборов', disabled: true });
    }
    const rect = btn.getBoundingClientRect();
    showMenuAt(rect.left, rect.bottom, items);
    event.stopPropagation();
  });
  return btn;
}

function buildAddButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'canvas-filter-strip-btn canvas-filter-strip-add';
  btn.textContent = '+';
  btn.title = 'Добавить отбор';
  // Requirement 23e0f78e: type-less thoughts have no type to attach the
  // view to — disable the button. The root type isn't a real type and the
  // user cannot add views to it from the canvas; the editor dialog owns
  // that path.
  const typed = currentFocusTypeId !== null && currentFocusTypeId !== undefined;
  btn.disabled = !typed;
  if (!typed) btn.title = 'Добавление отбора недоступно у мысли без типа';
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    // Отборы — сервисный инструмент общего пользования; правка в слоях
    // изменений запрещена (задача d9b66617). Кнопку оставляем видимой, чтобы
    // пользователь видел, что функция существует, но сейчас недоступна.
    if (!isInBaseLayer()) {
      notice('Для добавления отборов переключитесь в Основу.', 'info');
      return;
    }
    const networkId = store.state.networkId;
    const typeId = currentFocusTypeId;
    if (networkId === null || typeId === null || typeId === undefined) return;
    const typeName = store.state.thoughtTypes.find((t) => t.id === typeId)?.name ?? '';
    openViewEditorDialog({
      networkId,
      thoughtTypeId: typeId,
      typeName,
      view: null,
      // Детерминированное переключение на новый отбор (ошибка 04da7519):
      // после сохранения новый отбор сразу становится активным, выбор
      // персистится, а канвасный render исполняет его через
      // `runActiveViewIfNeeded`. Кнопку/имя дорисует realtime-событие
      // `thought-type-view.created`.
      onSaved: (savedView) => {
        setMode(
          {
            kind: 'view',
            viewId: savedView.id,
            viewName: savedView.name_key,
            viewTypeId: savedView.thought_type_id,
          },
          true,
        );
        persistForCurrentFocus();
        notifyModeChange();
      },
    });
  });
  return btn;
}

/** Кнопка-воронка фильтра типов связей на карте (0.8.1, задача «Фильтр
 *  типов связей на карте мыслей», элемент интерфейса «Диалог фильтра типов
 *  связей на карте»). В отличие от «+» доступна всегда — фильтр является
 *  настройкой сети, а не типа мысли в фокусе. */
function buildFilterButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'canvas-filter-strip-btn canvas-filter-strip-filter';
  btn.append(svgIcon('filter', 14));
  btn.title = 'Фильтр типов связей на карте';
  btn.addEventListener('click', () => {
    const networkId = store.state.networkId;
    if (networkId === null) return;
    openCanvasLinkFilterDialog(networkId);
  });
  return btn;
}

/** Context menu for a view button (right-click). Spec `9984aa98` mentions
 *  «Изменить» and «Удалить» only; «Сделать по умолчанию» is a useful
 *  one-click shortcut and matches the same patch path. */
function showViewMenu(x: number, y: number, view: EffectiveViewRow): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  // В слоях изменений правка отборов запрещена (задача d9b66617) — пункты
  // меню остаются видимыми, но клик показывает понятное сообщение.
  const inBase = isInBaseLayer();
  const items: MenuItem[] = [
    {
      label: 'Изменить отбор',
      onClick: () => {
        if (!inBase) {
          notice('Для изменения отбора переключитесь в Основу.', 'info');
          return;
        }
        openViewEditorForExisting(networkId, view);
      },
    },
    {
      label: view.is_default ? 'Снять «по умолчанию»' : 'Сделать отбор по умолчанию',
      // You can only flip `is_default` on views of the focus's own type —
      // inherited defaults are governed by their declaring type (spec).
      disabled: !view.isOwn && !view.is_default,
      onClick: () => {
        if (!inBase) {
          notice('Для изменения отбора переключитесь в Основу.', 'info');
          return;
        }
        void setDefault(networkId, view, !view.is_default);
      },
    },
    MENU_SEPARATOR,
    {
      label: 'Удалить отбор',
      danger: true,
      // Deleting an inherited view from the focus's canvas would mislead:
      // the operation would target a different type. Disable; users delete
      // inherited views from the editor of their declaring type.
      disabled: view.inherited,
      onClick: () => {
        if (!inBase) {
          notice('Для удаления отбора переключитесь в Основу.', 'info');
          return;
        }
        void deleteView(networkId, view);
      },
    },
  ];
  showMenuAt(x, y, items);
}

/**
 * Opens the editor dialog for an existing view. The strip only carries the
 * view's `EffectiveViewRow` (no `definition`); we resolve the full
 * `ThoughtTypeView` via the IPC list before opening the dialog (a single
 * round-trip keeps the dialog self-contained).
 */
async function openViewEditorForExisting(
  networkId: string,
  row: EffectiveViewRow,
): Promise<void> {
  try {
    const resp = await etn.thoughtTypeViews.list(networkId, row.defined_on, { includeEffective: false });
    const full = resp.data.find((v) => v.id === row.id);
    if (full === undefined) {
      notice('Не удалось открыть отбор для правки.', 'error');
      return;
    }
    const typeName =
      store.state.thoughtTypes.find((t) => t.id === row.defined_on)?.name ?? '';
    openViewEditorDialog({
      networkId,
      thoughtTypeId: row.defined_on,
      typeName,
      view: full,
      // Детерминированное обновление того же клиента (ошибка 04da7519):
      // realtime-событие `thought-type-view.updated` тоже перестраивает
      // полосу, но два пути гоняют между собой, и протухший ответ
      // `runActiveViewIfNeeded` возвращает null — нижняя зона красится
      // пустым/старым. Поэтому при правке активного отбора переисполняем
      // результат немедленно, не дожидаясь realtime.
      onSaved: (savedView) => {
        void (async () => {
          if (currentMode.kind === 'view' && currentMode.viewId === savedView.id) {
            // Отбор могли переименовать — обновляем кэшированное имя перед
            // перезапуском, чтобы run выполнился по актуальному определению.
            currentMode.viewName = savedView.name_key;
            // Определение могло поменяться (sort/order/limit и т.п.) —
            // сбрасываем кеш, чтобы новый run прочитал свежую `definition`.
            invalidateViewSortCache();
            const focus = store.state.focus;
            if (focus !== null) {
              await runActiveViewIfNeeded(focus.focused.id);
              notifyModeChange();
            }
          }
        })();
      },
    });
  } catch (err) {
    notice(formatStripError(err, 'Не удалось открыть отбор для правки.'), 'error');
  }
}

async function setDefault(
  networkId: string,
  view: EffectiveViewRow,
  nextDefault: boolean,
): Promise<void> {
  try {
    await etn.thoughtTypeViews.update(
      networkId,
      view.defined_on,
      view.id,
      { is_default: nextDefault },
      view.version,
    );
    notice(nextDefault ? 'Отбор помечен «по умолчанию».' : 'Пометка «по умолчанию» снята.', 'info');
    // The realtime `thought-type-view.updated` event will repaint the strip;
    // nothing more to do here.
  } catch (err) {
    notice(formatStripError(err, 'Не удалось изменить пометку.'), 'error');
  }
}

async function deleteView(networkId: string, view: EffectiveViewRow): Promise<void> {
  // Унаследованный отбор удаляется из редактора его собственного типа —
  // кнопка в контекстном меню уже `disabled: view.inherited`, но прямой
  // вызов из кода не должен молча отправлять DELETE на чужой тип.
  if (view.inherited) return;
  // Симметрия с `onDelete` во вкладке «Отборы» редактора типа
  // (regression a62190d1): без подтверждения клик по «Удалить отбор» молча
  // стирал отбор — действие необратимое.
  const ok = await confirmDialog(
    'Удалить отбор',
    `Удалить отбор «${view.name || view.name_key}»? Это действие необратимо.`,
    true,
  );
  if (!ok) return;
  try {
    await etn.thoughtTypeViews.remove(networkId, view.defined_on, view.id, view.version);
    notice('Отбор удалён.', 'info');
    // If the deleted view was active, switch to «Потомки» immediately. The
    // realtime event will arrive shortly; preempt it so the strip does not
    // briefly flash the deleted button.
    if (currentMode.kind === 'view' && currentMode.viewId === view.id) {
      // Удаление активного отбора всегда переключает на «Потомки»
      // (ошибка 04da7519), а не на отбор по умолчанию.
      setMode({ kind: 'children' }, true);
      persistForCurrentFocus();
      notifyModeChange();
    }
  } catch (err) {
    notice(formatStripError(err, 'Не удалось удалить отбор.'), 'error');
  }
}

function formatStripError(err: unknown, fallback: string): string {
  if (err !== null && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return `${fallback} ${msg}`;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Mode helpers
// ---------------------------------------------------------------------------

function setMode(mode: StripMode, fireListeners: boolean): void {
  currentMode = mode;
  if (stripEl === null || buttonsEl === null) return;
  // Repaint the `.active` marker without rebuilding the buttons (a rebuild
  // would lose the user's scroll position and re-fetch metadata).
  for (const btn of buttonsEl.querySelectorAll<HTMLButtonElement>('.canvas-filter-strip-btn')) {
    const modeAttr = btn.dataset['mode'];
    const viewId = btn.dataset['viewId'];
    let isActive = false;
    if (mode.kind === 'children' && modeAttr === 'children') isActive = true;
    if (mode.kind === 'view' && viewId === mode.viewId) isActive = true;
    btn.classList.toggle('active', isActive);
  }
  if (fireListeners) {
    // listeners are notified by the caller so click and event paths share
    // a single notify (avoid duplicate canvas rerenders).
  }
}

function persistForCurrentFocus(): void {
  if (currentFocusId === null) return;
  if (currentMode.kind === 'children') {
    persisted[currentFocusId] = { kind: 'children' };
  } else {
    // `currentMode` is already a `StripMode` with the right `kind` — spread
    // it directly (the explicit `kind: 'view'` would just overwrite).
    persisted[currentFocusId] = currentMode;
  }
  persistStrip();
}

function notifyModeChange(): void {
  for (const listener of modeListeners) listener(currentMode);
}

// ---------------------------------------------------------------------------
// Run a view against the focused thought
// ---------------------------------------------------------------------------

/**
 * Runs the currently active view against the focused thought and caches the
 * result for the canvas to paint. Called when the canvas detects that the
 * strip mode is `view` but no result has been cached yet (focus switch,
 * mode switch, or realtime view update). Safe to call multiple times — the
 * server call is cancelled if a newer run starts.
 */
let runSeq = 0;

/** Ключ последнего показанного сообщения о неподдерживаемой сортировке —
 *  сообщение выводится один раз на фокус/отбор, а не на каждый ре-рендер. */
let unsupportedSortNotified: string | null = null;

/**
 * Cache of `sort`/`order` parsed from each view's definition, keyed by
 * `viewId`. `null` — определение уже пытались прочитать и распарсить не
 * удалось (битый JSON / отсутствуют поля). Сбрасывается при смене фокуса
 * (renderStrip) и realtime-событиях по отборам — см. `invalidateViewSortCache`.
 */
const viewSortOrderCache = new Map<string, ViewSortOrder | null>();

/**
 * Использует ли определение отбора критерий `keywords` (блокер G3). Кеш по
 * `viewId`: заполняется при чтении определения ({@link loadViewSortOrder}).
 * Нужен холсту, чтобы решать, переисполнять ли отбор на правку заголовка/
 * синонимов мысли: без `keywords` такие поля состав отбора не меняют.
 */
const viewKeywordsCache = new Map<string, boolean>();

/** Есть ли в определении непустой критерий `keywords`. */
function definitionUsesKeywords(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const kw = (parsed as { keywords?: unknown }).keywords;
  return typeof kw === 'string' && kw.trim() !== '';
}

/**
 * Использует ли `keywords` активный отбор холста. `false`, пока определение не
 * прочитано (отбор не исполнялся) — тогда лишний `views.run` не запускаем.
 */
export function activeViewUsesKeywords(): boolean {
  if (currentMode.kind !== 'view') return false;
  return viewKeywordsCache.get(currentMode.viewId) ?? false;
}

/**
 * Сортировка/направление отбора, прочитанные из `definition`.
 * `unsupported` — сохранённые значения ВНЕ единого набора конструктора
 * (`lib/filter-builder.ts`, требование «Сортировки отбора: единый набор…»):
 * исполнение идёт со значениями по умолчанию, но о расхождении сообщается
 * явно — молча отбрасывать сохранённую сортировку запрещено (ошибка 33a3e285).
 */
interface ViewSortOrder {
  sort: StructureSort;
  order: SortOrder;
  unsupported: { sort?: string; order?: string } | null;
}

/** Drops every cached view `sort`/`order` (вызывается при rebuild полосы). */
function invalidateViewSortCache(): void {
  viewSortOrderCache.clear();
  viewKeywordsCache.clear();
}

/** Загружает `sort`/`order` из определения отбора и кеширует по `viewId`.
 *  Серверная операция `etn.thoughtTypeViews.run` сама по себе сортирует
 *  результат `alpha asc` (домен `thought-type-views-service.ts`), и без
 *  явных `sort`/`order` opts порядок отбора игнорируется — клиент должен
 *  передавать `sort`/`order`, прочитанные из `definition`. Кеш по `viewId`
 *  избавляет от повторного `list` на каждый ре-рендер.
 *
 *  Полоса НЕ имеет собственного мнения о допустимых сортировках: множество
 *  определяет конструктор (`isFilterSort`), а исполнитель принимает всё,
 *  что конструктор позволил сохранить. Значения вне набора (легаси
 *  `updated` из старого диалога) возвращаются с `unsupported` — исполнение
 *  продолжается, но сообщается явно. */
async function loadViewSortOrder(
  networkId: string,
  viewTypeId: string,
  viewId: string,
): Promise<ViewSortOrder | null> {
  const cached = viewSortOrderCache.get(viewId);
  if (cached !== undefined) return cached;
  try {
    const resp = await etn.thoughtTypeViews.list(networkId, viewTypeId, {
      includeEffective: false,
    });
    const full = resp.data.find((v) => v.id === viewId);
    if (full === undefined) {
      viewKeywordsCache.set(viewId, false);
      viewSortOrderCache.set(viewId, null);
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(full.definition) as unknown;
    } catch {
      viewKeywordsCache.set(viewId, false);
      viewSortOrderCache.set(viewId, null);
      return null;
    }
    // Использует ли отбор `keywords` — нужно холсту для признака «состав мог
    // измениться» на правку заголовка/синонимов (блокер G3).
    viewKeywordsCache.set(viewId, definitionUsesKeywords(parsed));
    const obj = parsed as { sort?: unknown; order?: unknown };
    const sort = obj?.sort;
    const order = obj?.order;
    if (typeof sort !== 'string' || typeof order !== 'string') {
      viewSortOrderCache.set(viewId, null);
      return null;
    }
    if (!isFilterSort(sort) || !isSortOrder(order)) {
      // Сохранённое значение вне единого набора (ошибка 33a3e285): дефолт
      // исполнения, но значение запоминаем, чтобы сообщить явно.
      const value: ViewSortOrder = {
        sort: 'alpha',
        order: 'asc',
        unsupported: {
          ...(!isFilterSort(sort) ? { sort } : {}),
          ...(!isSortOrder(order) ? { order } : {}),
        },
      };
      viewSortOrderCache.set(viewId, value);
      return value;
    }
    const value: ViewSortOrder = { sort, order, unsupported: null };
    viewSortOrderCache.set(viewId, value);
    return value;
  } catch {
    viewSortOrderCache.set(viewId, null);
    return null;
  }
}

/**
 * Явное сообщение о неподдерживаемом сохранённом значении сортировки —
 * молчание запрещено (требование «Сортировки отбора: единый набор…»).
 */
function formatUnsupportedSortNotice(unsupported: { sort?: string; order?: string }): string {
  const parts: string[] = [];
  if (unsupported.sort !== undefined) parts.push(`сортировка ${sortValueLabel(unsupported.sort)}`);
  if (unsupported.order !== undefined) parts.push(`направление «${unsupported.order}»`);
  return (
    `Сохранённый отбор содержит неподдерживаемое значение (${parts.join(', ')}) — ` +
    'результат отсортирован по названию.'
  );
}

export async function runActiveViewIfNeeded(focusId: string): Promise<ViewResult | null> {
  if (currentMode.kind !== 'view') return null;
  const networkId = store.state.networkId;
  if (networkId === null) return null;
  const seq = ++runSeq;
  try {
    // Передаём `sort`/`order` из определения отбора — иначе сервер возвращает
    // фиксированный `alpha asc` и порядок отбора (например, «по дате
    // создания») теряется (ошибка 119b314f). REST `run` уже принимает эти
    // opts и применяет через `sortItems` (server/routes/thought-type-views.ts).
    const sortOrder = await loadViewSortOrder(
      networkId,
      currentMode.viewTypeId,
      currentMode.viewId,
    );
    // Сохранённое значение сортировки вне единого набора конструктора —
    // исполняем со значением по умолчанию, но сообщаем явно, один раз на
    // фокус/отбор (ошибка 33a3e285: молча терять сохранённую сортировку
    // запрещено).
    if (sortOrder !== null && sortOrder.unsupported !== null) {
      const key = `${currentMode.viewId}|${JSON.stringify(sortOrder.unsupported)}`;
      if (unsupportedSortNotified !== key) {
        unsupportedSortNotified = key;
        notice(formatUnsupportedSortNotice(sortOrder.unsupported), 'info');
      }
    }
    const resp = await etn.thoughtTypeViews.run(
      networkId,
      focusId,
      currentMode.viewName,
      sortOrder === null || sortOrder.unsupported !== null
        ? undefined
        : { sort: sortOrder.sort, order: sortOrder.order },
    );
    // Stale response (the focus changed or the user re-clicked) — drop it.
    // Hand back only a cached result that belongs to THIS focus: a result for
    // another focus would paint foreign thoughts into the lower zone, and
    // `null` must mean "no fresh result", never "the view is empty"
    // (ошибка 90811979).
    if (seq !== runSeq) {
      return lastResult !== null && lastResult.focusId === focusId ? lastResult : null;
    }
    const unresolved = resp.meta.unresolved;
    const hasUnresolved = Array.isArray(unresolved) && unresolved.length > 0;
    const items = resp.data;
    // `meta.total` — полное число совпадений по серверу; индикатор нижней зоны
    // обязан показывать его, а не длину первой порции (ошибка 4493811f).
    const total = resp.meta.total;
    lastResult = {
      viewId: currentMode.viewId,
      viewName: resp.meta.view.name,
      viewTypeId: resp.meta.view.type_id,
      focusId,
      items,
      directions: resp.meta.directions ?? {},
      unresolved: hasUnresolved ? (unresolved as ReadonlyArray<{ token: string; reason: string }>) : null,
      empty: items.length === 0 && !hasUnresolved,
      total,
      nextOffset: VIEW_PAGE_SIZE,
      exhausted: items.length >= total,
    };
    return lastResult;
  } catch (err) {
    notice(formatStripError(err, 'Не удалось исполнить отбор.'), 'error');
    lastResult = null;
    return null;
  }
}

/**
 * Есть ли ещё неподгруженные мысли отбора в нижней зоне карты. `false`, когда
 * режим — «Потомки», результата ещё нет или порции исчерпаны (ошибка 4493811f).
 */
export function hasMoreViewResult(): boolean {
  return (
    lastResult !== null &&
    !lastResult.exhausted &&
    lastResult.items.length < lastResult.total
  );
}

/**
 * Догружает ОДНУ следующую порцию результата активного отбора (ошибка
 * 4493811f, требование «динамическая пагинация»). Запрашивает страницу
 * `views.run` с явным `limit`/`offset`, дописывает новые строки (без
 * дубликатов и без самой фокусной мысли) и обновляет `total`/`exhausted`.
 * Возвращает обновлённый результат или `null`, если догружать нечего либо
 * порцию перекрыл более свежий запуск отбора.
 */
export async function loadMoreViewResult(focusId: string): Promise<ViewResult | null> {
  if (currentMode.kind !== 'view') return null;
  const result = lastResult;
  if (
    result === null ||
    result.focusId !== focusId ||
    result.viewId !== currentMode.viewId
  ) {
    return null;
  }
  if (result.exhausted) return result;
  const networkId = store.state.networkId;
  if (networkId === null) return result;
  // Запуск отбора мог быть перекрыт (смена фокуса/режима/realtime): тогда
  // `runSeq` уже сдвинут, а `lastResult` заменён/сброшен — порцию не применяем.
  const seq = runSeq;
  try {
    const sortOrder = await loadViewSortOrder(
      networkId,
      currentMode.viewTypeId,
      currentMode.viewId,
    );
    const resp = await etn.thoughtTypeViews.run(networkId, focusId, currentMode.viewName, {
      ...(sortOrder === null || sortOrder.unsupported !== null
        ? {}
        : { sort: sortOrder.sort, order: sortOrder.order }),
      limit: VIEW_PAGE_SIZE,
      offset: result.nextOffset,
    });
    if (seq !== runSeq || lastResult !== result) return lastResult;
    const known = new Set(result.items.map((item) => item.id));
    const fresh = resp.data.filter((item) => item.id !== focusId && !known.has(item.id));
    // `items`/`total`/`nextOffset`/`exhausted` — поля одного результата; правим
    // на месте, чтобы `takeViewResult()` отдавал канвасу ту же ссылку.
    result.items = [...result.items, ...fresh];
    result.total = resp.meta.total;
    result.nextOffset += VIEW_PAGE_SIZE;
    // Порции исчерпаны, когда загружены все совпадения (`meta.total`) или
    // сервер вернул пустую страницу. Длина `resp.data` не показатель: первая
    // же страница может быть короче лимита, если сервер исключил контекстную
    // мысль (ошибка 4493811f).
    result.exhausted = resp.data.length === 0 || result.items.length >= result.total;
    return result;
  } catch {
    // Best effort: следующий скролл нижней зоны повторит попытку.
    return result;
  }
}

// ---------------------------------------------------------------------------
// Realtime hooks
// ---------------------------------------------------------------------------

/** Called by the realtime UI bridge when any thought-type-view event
 *  arrives (created/updated/deleted). The strip rebuilds itself when the
 *  event touches the focused thought's type. */
export function onThoughtTypeViewRealtime(
  payload: { thought_type_id?: string; view_id?: string; type?: string },
): void {
  if (currentFocusTypeId === undefined || currentFocusTypeId === null) return;
  // Same own-type view or an inherited view on a parent type — both
  // affect the effective chain visible in the strip.
  // We always rebuild: the event data doesn't carry the type chain, but
  // the cost is small (one `thoughts.get` plus one list call at most).
  void refreshStripFromRealtime(payload);
}

let realtimeRebuildSeq = 0;
async function refreshStripFromRealtime(
  _payload: { thought_type_id?: string; view_id?: string; type?: string },
): Promise<void> {
  const focus = store.state.focus;
  if (focus === null) return;
  const seq = ++realtimeRebuildSeq;
  // The event carries a view definition change: the cached `sort`/`order` of
  // the views may be stale, while the focus itself did not change (so
  // `renderStrip` no longer drops the cache on its own).
  invalidateViewSortCache();
  await renderStrip(focus);
  if (seq !== realtimeRebuildSeq) return;
  // The mode may have shifted to a default view after the rebuild; the
  // canvas needs to know so it can re-render the lower zone.
  notifyModeChange();
  // Re-run the view if the active mode is a view (children don't need a
  // refresh — `scheduleRefresh` is handled at the realtime bridge level).
  if (currentMode.kind === 'view') {
    await runActiveViewIfNeeded(focus.focused.id);
    notifyModeChange();
  }
}

// Слой (G6): `thought-type-view.*` роутер гасит ключ `views:@<typeId>` — полоса
// перестраивается из подписки на инвалидацию, без прямого realtime-хука.
onQueryInvalidated((prefix) => {
  if (!prefix.startsWith('views:@')) return;
  onThoughtTypeViewRealtime({ thought_type_id: prefix.slice('views:@'.length) });
});

/** Re-renders the strip when the focused thought changes. The canvas
 *  invokes this after a focus switch so the strip resets to the new
 *  focus's default mode. */
export function onFocusChange(_focusId: string | null): void {
  // The canvas calls `renderStrip` itself after every focus change; this
  // hook exists for symmetry and as a place to drop future per-focus
  // bookkeeping (e.g. clearing lastResult). No-op today.
}

// ---------------------------------------------------------------------------
// Overflow layout
// ---------------------------------------------------------------------------

/**
 * Hides buttons that don't fit the available width and surfaces them
 * under the «⋯» dropdown instead. The computation is intentionally
 * simple: measure each button, hide from the right until everything fits.
 * A ResizeObserver keeps it in sync with the canvas width.
 */
let layoutObserver: ResizeObserver | null = null;

function layoutStrip(views: EffectiveViewRow[]): void {
  if (stripEl === null || buttonsEl === null) return;
  if (layoutObserver === null) {
    layoutObserver = new ResizeObserver(() => layoutStrip(effectiveViews));
    layoutObserver.observe(stripEl);
  }
  // First, show everything.
  const all = Array.from(buttonsEl.querySelectorAll<HTMLElement>('.canvas-filter-strip-btn'));
  for (const elx of all) elx.classList.remove('hidden');
  if (overflowBtn !== null) overflowBtn.classList.add('hidden');

  // Measure: does the row fit?
  const available = stripEl.clientWidth - 4;
  const totalWidth = Array.from(buttonsEl.children).reduce(
    (sum, child) => sum + (child as HTMLElement).offsetWidth,
    0,
  );
  if (totalWidth <= available) return;

  // Hide view buttons from the right one by one until the row fits. The
  // «+» and «Потомки» buttons always stay visible (a hidden «Потомки»
  // would be a regression for keyboard users).
  const viewButtons = Array.from(
    buttonsEl.querySelectorAll<HTMLElement>('.canvas-filter-strip-btn[data-view-id]'),
  );
  let visibleEnd = viewButtons.length;
  while (visibleEnd > 0) {
    const current = Array.from(buttonsEl.children).reduce(
      (sum, child) =>
        child.classList.contains('hidden') ? sum : sum + (child as HTMLElement).offsetWidth,
      0,
    );
    if (current <= available) break;
    visibleEnd -= 1;
    viewButtons[visibleEnd]?.classList.add('hidden');
  }
  // Always show the overflow button if at least one view button is hidden.
  const anyHidden = viewButtons.some((b) => b.classList.contains('hidden'));
  if (anyHidden && overflowBtn !== null) {
    overflowBtn.classList.remove('hidden');
    // Rebuild the dropdown menu from the visible-from-overflow list.
    rebuildOverflowMenu(views, viewButtons);
  }
}

function rebuildOverflowMenu(
  views: EffectiveViewRow[],
  viewButtons: HTMLElement[],
): void {
  if (overflowBtn === null) return;
  // The dropdown shows every button that is currently hidden. We rebuild
  // the click handler so it shows the right subset.
  const newBtn = overflowBtn.cloneNode(true) as HTMLButtonElement;
  overflowBtn.replaceWith(newBtn);
  overflowBtn = newBtn;
  newBtn.addEventListener('click', (event) => {
    const items: MenuItem[] = [];
    for (let i = 0; i < views.length; i += 1) {
      const view = views[i];
      const btn = viewButtons[i];
      if (view === undefined || btn === undefined || !btn.classList.contains('hidden')) continue;
      const captured = view;
      items.push({
        label: captured.name + (captured.inherited ? ' (унаследован)' : ''),
        checked: currentMode.kind === 'view' && currentMode.viewId === captured.id,
        onClick: () => {
          setMode(
            {
              kind: 'view',
              viewId: captured.id,
              viewName: captured.name_key,
              viewTypeId: captured.defined_on,
            },
            true,
          );
          persistForCurrentFocus();
          notifyModeChange();
        },
      });
    }
    if (items.length === 0) {
      items.push({ label: 'Нет отборов', disabled: true });
    }
    const rect = newBtn.getBoundingClientRect();
    showMenuAt(rect.left, rect.bottom, items);
    event.stopPropagation();
  });
}

// ---------------------------------------------------------------------------
// DOM helper
// ---------------------------------------------------------------------------

/** Removes every child node — local copy of the canvas's `clear` helper. */
function clear(elx: HTMLElement): void {
  while (elx.firstChild !== null) elx.removeChild(elx.firstChild);
}
