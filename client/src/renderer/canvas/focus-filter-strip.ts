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
import type { FocusResponse, ThoughtRef, ThoughtTypeView } from '@etn/shared';
import type { StructureSort, SortOrder } from '@etn/shared';

import { openViewEditorDialog } from '../screens/thought-type/filter-dialog.js';
import { etn } from '../lib/etn.js';
import { div, span } from '../lib/dom.js';
import { showMenuAt, MENU_SEPARATOR, type MenuItem } from '../lib/menu.js';
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
}

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
  currentFocusId = focus.focused.id;
  currentFocusTypeId = focus.focused.type_id ?? null;
  // Reset view-result cache for the new focus.
  lastResult = null;
  // Сбрасываем кеш `sort`/`order` отбора — для нового фокуса отборы могут
  // быть другими. Перечитываем заново при следующем `runActiveViewIfNeeded`.
  invalidateViewSortCache();
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
  let views: RawView[] = [];
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

/** Context menu for a view button (right-click). Spec `9984aa98` mentions
 *  «Изменить» and «Удалить» only; «Сделать по умолчанию» is a useful
 *  one-click shortcut and matches the same patch path. */
function showViewMenu(x: number, y: number, view: EffectiveViewRow): void {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const items: MenuItem[] = [
    {
      label: 'Изменить отбор',
      onClick: () => {
        openViewEditorForExisting(networkId, view);
      },
    },
    {
      label: view.is_default ? 'Снять «по умолчанию»' : 'Сделать отбор по умолчанию',
      // You can only flip `is_default` on views of the focus's own type —
      // inherited defaults are governed by their declaring type (spec).
      disabled: !view.isOwn && !view.is_default,
      onClick: () => {
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

/** Cache of `sort`/`order` parsed from each view's definition, keyed by
 *  `viewId`. `null` — определение уже пытались прочитать и распарсить не
 *  удалось (битый JSON / отсутствуют поля). Сбрасывается при смене фокуса
 *  (renderStrip) и realtime-событиях по отборам — см. `invalidateViewSortCache`. */
const viewSortOrderCache = new Map<
  string,
  { sort: StructureSort; order: SortOrder } | null
>();

/** Drops every cached view `sort`/`order` (вызывается при rebuild полосы). */
function invalidateViewSortCache(): void {
  viewSortOrderCache.clear();
}

/** Загружает `sort`/`order` из определения отбора и кеширует по `viewId`.
 *  Серверная операция `etn.thoughtTypeViews.run` сама по себе сортирует
 *  результат `alpha asc` (домен `thought-type-views-service.ts`), и без
 *  явных `sort`/`order` opts порядок отбора игнорируется — клиент должен
 *  передавать `sort`/`order`, прочитанные из `definition`. Кеш по `viewId`
 *  избавляет от повторного `list` на каждый ре-рендер. */
async function loadViewSortOrder(
  networkId: string,
  viewTypeId: string,
  viewId: string,
): Promise<{ sort: StructureSort; order: SortOrder } | null> {
  const cached = viewSortOrderCache.get(viewId);
  if (cached !== undefined) return cached;
  try {
    const resp = await etn.thoughtTypeViews.list(networkId, viewTypeId, {
      includeEffective: false,
    });
    const full = resp.data.find((v) => v.id === viewId);
    if (full === undefined) {
      viewSortOrderCache.set(viewId, null);
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(full.definition) as unknown;
    } catch {
      viewSortOrderCache.set(viewId, null);
      return null;
    }
    const obj = parsed as { sort?: unknown; order?: unknown };
    const sort = obj?.sort;
    const order = obj?.order;
    if (typeof sort !== 'string' || typeof order !== 'string') {
      viewSortOrderCache.set(viewId, null);
      return null;
    }
    // Принимаем только значения, которые сервер примет (`STRUCTURE_SORTS`
    // и `SORT_ORDERS`). Нештатные значения оставляем на откуп сервера.
    if (sort !== 'alpha' && sort !== 'created' && sort !== 'viewed') {
      viewSortOrderCache.set(viewId, null);
      return null;
    }
    if (order !== 'asc' && order !== 'desc') {
      viewSortOrderCache.set(viewId, null);
      return null;
    }
    const value: { sort: StructureSort; order: SortOrder } = { sort, order };
    viewSortOrderCache.set(viewId, value);
    return value;
  } catch {
    viewSortOrderCache.set(viewId, null);
    return null;
  }
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
    const resp = await etn.thoughtTypeViews.run(
      networkId,
      focusId,
      currentMode.viewName,
      // Тип opts в `rest-client.runThoughtTypeView` объявлен как
      // `'alpha' | 'created' | 'updated'` — это устаревшее значение,
      // серверный `parseSort` валидирует против `STRUCTURE_SORTS`
      // (`'alpha' | 'created' | 'viewed'`, shared/enums.ts), куда «updated»
      // не входит. `sort`/`order` из `definition` уже отфильтрованы в
      // `loadViewSortOrder` под этот набор — приводим к типу opts только
      // на границе IPC.
      sortOrder === null
        ? undefined
        : ({ sort: sortOrder.sort, order: sortOrder.order } as {
            sort: 'alpha' | 'created' | 'updated';
            order: 'asc' | 'desc';
          }),
    );
    // Stale response (focus changed or user re-clicked) — drop it.
    if (seq !== runSeq) return lastResult;
    const unresolved = resp.meta.unresolved;
    const hasUnresolved = Array.isArray(unresolved) && unresolved.length > 0;
    const items = resp.data;
    lastResult = {
      viewId: currentMode.viewId,
      viewName: resp.meta.view.name,
      viewTypeId: resp.meta.view.type_id,
      focusId,
      items,
      directions: resp.meta.directions ?? {},
      unresolved: hasUnresolved ? (unresolved as ReadonlyArray<{ token: string; reason: string }>) : null,
      empty: items.length === 0 && !hasUnresolved,
    };
    return lastResult;
  } catch (err) {
    notice(formatStripError(err, 'Не удалось исполнить отбор.'), 'error');
    lastResult = null;
    return null;
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
