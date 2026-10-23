/**
 * Focus filter strip (task 02ba2ae7, spec df84de22 «Полоса отборов под
 * фокусом», 0.14.1).
 *
 * A horizontal row of buttons that lives between the focus cloud and the
 * children zone. Left-to-right:
 *   1. «Потомки» (always first; the canvas's native children-zone mode).
 *   2. The effective set of views for the focused thought, in the
 *      server-supplied order (root → type → custom; `position` inside each
 *      level — requirement eaca1253 and 045f539a). Type views are painted
 *      straight, inherited ones are dimmed; custom (out-of-type) views of the
 *      thought are painted italic AFTER all type views.
 *   3. «⋯» dropdown for buttons that don't fit the available width.
 *   4. «+» to add a new view: a menu «Новый отбор типа мысли» /
 *      «Новый отбор вне типа» for typed thoughts, the custom editor straight
 *      away for type-less ones (spec df84de22).
 *
 * Exactly one button is active. A persisted per-focus choice wins over the
 * focus's default view; the default opens only when no choice is stored
 * (spec df84de22, «Сохранённый выбор пользователя переживает смену фокуса и
 * перезагрузку»). The per-focus selection persists across focus changes
 * inside the same tab (L4 `focus_filter_strip` JSON).
 *
 * The only source of the effective set is `GET /thoughts/{id}/views?
 * include_effective=true` (requirement 045f539a): rows carry `scope`,
 * `defined_on`, `inherited`, `is_default` and the `definition`, so the strip
 * needs neither a second list call nor `thoughts.get.meta.views`.
 *
 * The lower zone renders the result of the selected mode: children of the
 * focus (the canvas default) or the result of running the picked view
 * against the focus. The strip drives the canvas via {@link getActiveMode}
 * and {@link takeViewResult}; the canvas treats the view result like a
 * regular children page but disables the actions that only make sense for
 * actual focus children (manual order, double-click-to-add).
 */

import { UI_STATE_KEY } from '@etn/shared';
import type { FocusResponse, ThoughtRef, ThoughtViewScope } from '@etn/shared';

import { openViewEditorDialog } from '../screens/thought-type/filter-dialog.js';
import { openCanvasLinkFilterDialog } from './link-filter-dialog.js';
import { confirmDialog } from '../lib/dialog.js';
import { etn } from '../lib/etn.js';
import { div } from '../lib/dom.js';
import { svgIcon } from '../lib/ui/icon.js';
import { isInBaseLayer } from '../lib/layer-base.js';
import { showMenuAt, menuAction, menuChoice, MENU_SEPARATOR, type MenuItem } from '../lib/menu.js';
import { asRealtimeCause, onQueryInvalidated } from '../lib/live/index.js';
import { notice } from '../lib/notice.js';
import { t } from '../lib/i18n.js';
import { store } from '../state.js';

/** Mode of the lower zone: children of the focus or a specific view's run. */
export type StripMode =
  | { kind: 'children' }
  | {
      kind: 'view';
      viewId: string;
      /** `name_key` — по нему сервер находит отбор в эффективном наборе. */
      viewName: string;
      /** Владелец отбора: тип мысли или сама мысль (требование 045f539a). */
      scope: ThoughtViewScope;
      /** Id владельца: тип (`scope: 'type'`) или мысль (`scope: 'thought'`). */
      definedOn: string;
    };

/** Result of the most recent view run, kept in memory for the canvas to
 *  paint into the children zone. Cleared on focus change or when the user
 *  switches back to «Потомки». */
export interface ViewResult {
  viewId: string;
  viewName: string;
  /** Владелец отбора (0.14.1): тип или мысль. */
  scope: ThoughtViewScope;
  /** Id владельца отбора — тип для типового, мысль для внетипового. */
  definedOn: string;
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
/** Currently focused thought title (used in menu labels/confirmations). */
let currentFocusTitle = '';
/** Currently focused thought type id (`null` — безтиповая мысль). */
let currentFocusTypeId: string | null = null;

/** Per-focus mode persistence. Loaded once per tab from L4 and patched on
 *  every click. Unknown entries (`viewId` not in the current effective set)
 *  fall back to the default view or children when restoring. */
let persisted: PersistedStrip = {};

/** Latest effective-views list for the focus (types + custom, server order),
 *  kept so a view button can resolve the same row and its `definition`. */
let effectiveViews: EffectiveViewRow[] = [];

/** Per-button paint data — the order is server-supplied (types by chain then
 *  custom, `position` inside each level). `inherited` carries the dimmed hint
 *  of a type view declared on an ancestor; `scope === 'thought'` is the
 *  italic out-of-type view of the focused thought. */
interface EffectiveViewRow {
  id: string;
  name: string;
  name_key: string;
  description: string | null;
  /** JSON-строка определения — второй list-запрос больше не нужен. */
  definition: string;
  /** Владелец отбора: тип мысли или сама мысль (требование 045f539a). */
  scope: ThoughtViewScope;
  /** Id владельца: тип (для `scope: 'type'`) или мысль. */
  defined_on: string;
  /** `true` — типовой отбор определён на типе-предке (приглушённый). */
  inherited: boolean;
  /** Position within the owner level (for the dropdown overflow list). */
  position: number;
  version: number;
  /** `true` — этот отбор открывается по умолчанию (эффективный дефолт).
   *  Годится только для выбора открываемого отбора; владельческие действия
   *  (меню «по умолчанию», начальное значение редактора) читают
   *  {@link own_default} — ошибки d056d106/29f93e71. */
  is_default: boolean;
  /**
   * Собственная пометка «по умолчанию» строки владельца — без учёта
   * наследования и перекрытия внетиповым дефолтом мысли (0.14.1).
   * Для внетиповой строки — достоверный источник предупреждения
   * move-to-thought (внетиповые не скрываются). Для типовой строки
   * ненадёжен: при перекрытии одноимённым внетиповым строки в наборе нет
   * вовсе, поэтому дефолт типа-получателя при move-to-type спрашивается
   * отдельным запросом собственных отборов типа (раунд 3).
   */
  own_default: boolean;
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

/** Parses one persisted entry. `scope`/`definedOn` are re-resolved against the
 *  effective set on every render, so an older shape (flat `viewTypeId`, no
 *  scope) is accepted and never trusted for display/route decisions. */
function parsePersistedMode(value: unknown): StripMode | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (obj['kind'] === 'children') return { kind: 'children' };
  if (obj['kind'] === 'view') {
    const viewId = obj['viewId'];
    const viewName = obj['viewName'];
    if (typeof viewId !== 'string' || typeof viewName !== 'string') return null;
    // Старый persisted хранил только `viewTypeId` (типовой отбор). Эти поля
    // перерезолвятся по эффективному набору при рендере; храним их лишь как
    // толерантный разбор, а не как источник истины.
    const definedOn = obj['definedOn'] ?? obj['viewTypeId'];
    const scope = obj['scope'];
    return {
      kind: 'view',
      viewId,
      viewName,
      scope: scope === 'thought' ? 'thought' : 'type',
      definedOn: typeof definedOn === 'string' ? definedOn : '',
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
  stripEl.setAttribute('aria-label', t('strip.ariaLabel'));
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
 * Repaints the strip for the current focus. Pass `null` when the canvas has
 * no focus (the strip hides itself).
 *
 * `opts.resetActiveIfDeleted` — realtime-перестройка после удаления отбора:
 * если активным был удалённый отбор, полоса уходит на «Потомки», а не на
 * дефолт (спека df84de22). Перенос (`reason: 'moved'`) этим флагом НЕ
 * помечается: id жив, чип остаётся активным и лишь перерезолвит владельца.
 */
export async function renderStrip(
  focus: FocusResponse | null,
  opts?: { resetActiveIfDeleted?: boolean },
): Promise<void> {
  if (stripEl === null || buttonsEl === null || host === null) return;
  if (focus === null) {
    stripEl.classList.add('hidden');
    currentFocusId = null;
    currentFocusTitle = '';
    currentFocusTypeId = null;
    effectiveViews = [];
    return;
  }
  const focusChanged = focus.focused.id !== currentFocusId;
  currentFocusId = focus.focused.id;
  currentFocusTitle = focus.focused.title;
  currentFocusTypeId = focus.focused.type_id ?? null;
  // Per-focus bookkeeping resets ONLY on a real focus change. `renderStrip`
  // runs on EVERY canvas render (a store notification, the zone pager, a
  // realtime refresh of the same focus), not just on a focus switch: dropping
  // the cached run result there let a superseded run hand `null` to the canvas
  // and paint the lower zone empty until the user toggled the mode by hand
  // (ошибка 90811979). The definition cache is dropped with it and re-read lazily.
  if (focusChanged) {
    lastResult = null;
    invalidateViewDefinitionCache();
  }
  // Единственный источник набора — `GET /thoughts/{id}/views?include_effective=true`
  // (требование 045f539a): и типовые по цепочке, и внетиповые, со `scope`,
  // `defined_on`, `inherited`, `is_default` и `definition`. Двухшаговый
  // fallback (`thoughts.get.meta.views` + list) убран.
  const views = await loadEffectiveViews(focus);
  effectiveViews = views;
  // Pick the mode: persisted > default view > «Потомки». Персист переживает
  // смену фокуса и перезагрузку; дефолт открывается только без сохранённого
  // выбора (спека df84de22).
  const prevMode = currentMode;
  const persistedMode = persisted[focus.focused.id];
  const persistedRow = persistedMode?.kind === 'view'
    ? views.find((v) => v.id === persistedMode.viewId)
    : undefined;
  const isValidPersisted =
    persistedMode !== undefined &&
    (persistedMode.kind === 'children' || persistedRow !== undefined);
  const defaultView = views.find((v) => v.is_default);
  const activeDeletedByRealtime =
    opts?.resetActiveIfDeleted === true &&
    prevMode.kind === 'view' &&
    !views.some((v) => v.id === prevMode.viewId);
  let mode: StripMode;
  if (activeDeletedByRealtime) {
    // Правило «удалённый активный → Потомки» (спека df84de22), не меняя
    // общее правило «фокус → дефолт».
    mode = { kind: 'children' };
  } else if (persistedMode !== undefined && isValidPersisted && persistedMode.kind === 'children') {
    // Сохранённый выбор «Потомки» обязан пережить ЛЮБУЮ перерисовку полосы
    // (store-нотификация, pager, realtime), а не только смену фокуса: иначе
    // дефолтный отбор возвращается сам через тик после клика по «Потомки».
    mode = { kind: 'children' };
  } else if (persistedMode !== undefined && isValidPersisted && persistedRow !== undefined) {
    // Имя/владельца берём из ЭФФЕКТИВНОГО набора, а не из persisted: realtime-
    // переименование и перенос владельца не должны ломать run и курсив.
    mode = viewModeFromRow(persistedRow);
  } else if (defaultView !== undefined) {
    mode = viewModeFromRow(defaultView);
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

/** Режим отбора по строке эффективного набора (владелец — из строки). */
function viewModeFromRow(row: EffectiveViewRow): StripMode {
  return {
    kind: 'view',
    viewId: row.id,
    viewName: row.name_key,
    scope: row.scope,
    definedOn: row.defined_on,
  };
}

// ---------------------------------------------------------------------------
// Effective-view resolution
// ---------------------------------------------------------------------------

/**
 * Loads the effective set of views for the focused thought from the single
 * source `GET /thoughts/{id}/views?include_effective=true` (типовые по
 * цепочке + внетиповые). Order is server-supplied (types by chain, then
 * custom; `position` inside each level) — НЕ пересортировываем (ошибка
 * 9792d55a). Работает и для безтиповой мысли: сервер подставляет корневой
 * тип, и внетиповые отборы мысли приходят тем же набором (требование
 * 23e0f78e).
 */
async function loadEffectiveViews(focus: FocusResponse): Promise<EffectiveViewRow[]> {
  const networkId = store.state.networkId;
  if (networkId === null) return [];
  let rows: readonly unknown[] = [];
  try {
    const resp = await etn.thoughtCustomViews.list(networkId, focus.focused.id, {
      includeEffective: true,
    });
    rows = Array.isArray(resp.meta.effective) ? resp.meta.effective : [];
  } catch {
    // Сеть/мысль исчезла или сервер недоступен — полоса без отборов.
    return [];
  }
  const out: EffectiveViewRow[] = [];
  for (const [idx, value] of rows.entries()) {
    if (value === null || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (
      typeof row['id'] !== 'string' ||
      typeof row['name'] !== 'string' ||
      typeof row['name_key'] !== 'string'
    ) {
      continue;
    }
    const scope: ThoughtViewScope = row['scope'] === 'thought' ? 'thought' : 'type';
    out.push({
      id: row['id'],
      name: row['name'],
      name_key: row['name_key'],
      description: typeof row['description'] === 'string' ? row['description'] : null,
      definition: typeof row['definition'] === 'string' ? row['definition'] : '',
      scope,
      defined_on: typeof row['defined_on'] === 'string' ? row['defined_on'] : '',
      inherited: scope === 'type' && row['inherited'] === true,
      position: typeof row['position'] === 'number' ? row['position'] : idx,
      version: typeof row['version'] === 'number' ? row['version'] : 0,
      is_default: row['is_default'] === true,
      own_default: row['own_default'] === true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Button builders
// ---------------------------------------------------------------------------

function buildChildrenButton(mode: StripMode): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'canvas-filter-strip-btn';
  btn.dataset['mode'] = 'children';
  btn.textContent = t('strip.children');
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
  // Владелец — в data-атрибуте: по нему пробы стенда проверяют курсив
  // внетипового и приглушение унаследованного (спека df84de22).
  btn.dataset['viewScope'] = view.scope;
  // Баг 3: обрезаем отображаемое имя после 30-го символа; полное имя — в
  // тултипе (с описанием, если оно есть), чтобы его можно было прочитать.
  btn.textContent = view.name.length > 30 ? `${view.name.slice(0, 30)}…` : view.name;
  btn.title = view.description !== null && view.description !== ''
    ? `${view.name}\n${view.description}`
    : view.name;
  // Унаследованный типовой отбор — приглушённый БЕЗ курсива; внетиповой
  // отбор самой мысли — курсив (спека df84de22, DoD стилей).
  if (view.inherited) btn.classList.add('inherited');
  if (view.scope === 'thought') btn.classList.add('out-of-type');
  if (mode.kind === 'view' && mode.viewId === view.id) btn.classList.add('active');
  btn.addEventListener('click', () => {
    if (
      currentMode.kind === 'view' &&
      currentMode.viewId === view.id
    ) {
      return;
    }
    setMode(viewModeFromRow(view), true);
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

/** Подпись отбора в меню `⋯`: внетиповые помечены «вне типа» (спека
 *  df84de22), унаследованные типовые — «унаследован». */
function overflowLabel(view: EffectiveViewRow): string {
  if (view.scope === 'thought') return `${view.name} ${t('strip.outOfTypeMark')}`;
  return view.name + (view.inherited ? ` ${t('strip.inheritedMark')}` : '');
}

function buildOverflowButton(views: EffectiveViewRow[], mode: StripMode): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'canvas-filter-strip-btn canvas-filter-strip-overflow';
  btn.textContent = '⋯';
  btn.title = t('strip.overflowTitle');
  btn.addEventListener('click', (event) => {
    const items: MenuItem[] = views.map((view) =>
      menuChoice(
        overflowLabel(view),
        mode.kind === 'view' && mode.viewId === view.id,
        () => {
          setMode(viewModeFromRow(view), true);
          persistForCurrentFocus();
          notifyModeChange();
        },
      ),
    );
    if (items.length === 0) {
      items.push(menuAction(t('strip.noViews'), undefined, { disabled: true }));
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
  btn.title = t('strip.addView');
  // «+» доступна у любой мысли (требование 23e0f78e снято в 0.14.1): у
  // типизированной — меню двух пунктов, у безтиповой — сразу редактор
  // внетипового отбора (спека df84de22).
  btn.addEventListener('click', () => {
    // Отборы — сервисный инструмент общего пользования; правка в слоях
    // изменений запрещена (задача d9b66617). Кнопку оставляем видимой, чтобы
    // пользователь видел, что функция существует, но сейчас недоступна.
    // Гейт стоит ДО меню/диалога (спека df84de22).
    if (!isInBaseLayer()) {
      notice(t('strip.addBaseLayerOnly'), 'info');
      return;
    }
    const networkId = store.state.networkId;
    if (networkId === null) return;
    const typeId = currentFocusTypeId;
    if (typeId === null) {
      // Безтиповая мысль — добавлять можно только внетиповой отбор.
      openCreateDialog('thought');
      return;
    }
    const rect = btn.getBoundingClientRect();
    showMenuAt(rect.left, rect.bottom, [
      menuAction(t('strip.addTypeView'), () => openCreateDialog('type')),
      menuAction(t('strip.addThoughtView'), () => openCreateDialog('thought')),
    ]);
  });

  /** Открыть редактор нового отбора выбранного владельца. */
  function openCreateDialog(owner: ThoughtViewScope): void {
    const networkId = store.state.networkId;
    if (networkId === null) return;
    const focusId = currentFocusId;
    if (focusId === null) return;
    const typeId = currentFocusTypeId;
    const typeName = typeId === null
      ? ''
      : store.state.thoughtTypes.find((row) => row.id === typeId)?.name ?? '';
    // Детерминированное переключение на новый отбор (ошибка 04da7519):
    // после сохранения новый отбор сразу становится активным, выбор
    // персистится, а канвасный render исполняет его через
    // `runActiveViewIfNeeded`. Кнопку/имя дорисует realtime-событие
    // `thought-type-view.created` / `thought-custom-view.created`.
    const onSaved = (savedView: { id: string; name_key: string }): void => {
      setMode(
        {
          kind: 'view',
          viewId: savedView.id,
          viewName: savedView.name_key,
          scope: owner,
          definedOn: owner === 'type' ? typeId ?? '' : focusId,
        },
        true,
      );
      persistForCurrentFocus();
      notifyModeChange();
    };
    if (owner === 'type' && typeId !== null) {
      openViewEditorDialog({
        networkId,
        thoughtTypeId: typeId,
        typeName,
        view: null,
        onSaved,
      });
    } else {
      openViewEditorDialog({
        networkId,
        ownerThoughtId: focusId,
        thoughtName: currentFocusTitle,
        view: null,
        onSaved,
      });
    }
  }
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
  btn.title = t('strip.linkFilter');
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
  // меню остаются видимыми, но клик показывает понятное сообщение. Гейт
  // стоит ДО подтверждений и записи (спека df84de22).
  const inBase = isInBaseLayer();
  const guard = (message: string): boolean => {
    if (inBase) return true;
    notice(message, 'info');
    return false;
  };
  const items: MenuItem[] = [
    menuAction(t('strip.menuEdit'), () => {
      if (!guard(t('strip.editBaseLayerOnly'))) return;
      openViewEditorForExisting(networkId, view);
    }),
    menuAction(
      // Подпись и переключение — по СОБСТВЕННОЙ пометке строки, а не по
      // эффективной: при внетиповом дефолте мысли эффективный `is_default`
      // типовой строки занулён, а действие адресует отбор владельца
      // (`defined_on`) — иначе «Сделать» повторяло бы no-op, а снять пометку
      // с полосы было бы нельзя (ошибка d056d106).
      view.own_default ? t('strip.menuClearDefault') : t('strip.menuMakeDefault'),
      () => {
        if (!guard(t('strip.editBaseLayerOnly'))) return;
        void setDefault(networkId, view, !view.own_default);
      },
      // Пометку «по умолчанию» у унаследованного типового отбора ставит его
      // собственный тип; снять уже стоящую (собственную у владельца) можно и
      // здесь — как раньше.
      { disabled: view.scope === 'type' && view.inherited && !view.own_default },
    ),
    MENU_SEPARATOR,
    view.scope === 'thought'
      ? menuAction(
          t('strip.menuMoveToType'),
          () => {
            if (!guard(t('strip.editBaseLayerOnly'))) return;
            void moveViewToType(networkId, view);
          },
          // У безтиповой мысли переносить некуда (спека df84de22).
          { disabled: currentFocusTypeId === null },
        )
      : menuAction(t('strip.menuMoveToThought'), () => {
          if (!guard(t('strip.editBaseLayerOnly'))) return;
          void moveViewToThought(networkId, view);
        }),
    MENU_SEPARATOR,
    menuAction(
      t('strip.menuDelete'),
      () => {
        if (!guard(t('strip.deleteBaseLayerOnly'))) return;
        void deleteView(networkId, view);
      },
      {
        danger: true,
        // Унаследованный отбор удаляется из редактора его собственного типа:
        // адрес пути — тип-владелец, а не фокус.
        disabled: view.inherited,
      },
    ),
  ];
  showMenuAt(x, y, items);
}

/** Имя типа по id (для заголовков/подтверждений); `''` — тип не в каталоге. */
function typeNameOf(typeId: string): string {
  return store.state.thoughtTypes.find((row) => row.id === typeId)?.name ?? '';
}

/**
 * Opens the editor dialog for an existing view. Строка эффективного набора уже
 * несёт `definition`/`version` — второй list-запрос не нужен (спека df84de22).
 */
function openViewEditorForExisting(networkId: string, row: EffectiveViewRow): void {
  const view = {
    id: row.id,
    name: row.name,
    description: row.description,
    definition: row.definition,
    is_default: row.is_default,
    version: row.version,
  };
  // Детерминированное обновление того же клиента (ошибка 04da7519):
  // realtime-событие тоже перестраивает полосу, но два пути гоняют между
  // собой, и протухший ответ `runActiveViewIfNeeded` возвращает null —
  // нижняя зона красится пустым/старым. Поэтому при правке активного отбора
  // переисполняем результат немедленно, не дожидаясь realtime.
  const onSaved = (savedView: { id: string; name_key: string }): void => {
    void (async () => {
      if (currentMode.kind === 'view' && currentMode.viewId === savedView.id) {
        // Отбор могли переименовать — обновляем кэшированное имя перед
        // перезапуском, чтобы run выполнился по актуальному определению.
        currentMode.viewName = savedView.name_key;
        // Определение могло поменяться (условия/sort/limit и т.п.) —
        // сбрасываем кеш признака `keywords`, чтобы новый run прочитал
        // свежую `definition`.
        invalidateViewDefinitionCache();
        const focus = store.state.focus;
        if (focus !== null) {
          await runActiveViewIfNeeded(focus.focused.id);
          notifyModeChange();
        }
      }
    })();
  };
  if (row.scope === 'type') {
    openViewEditorDialog({
      networkId,
      thoughtTypeId: row.defined_on,
      typeName: typeNameOf(row.defined_on),
      view,
      onSaved,
    });
  } else {
    openViewEditorDialog({
      networkId,
      ownerThoughtId: row.defined_on,
      thoughtName: currentFocusTitle,
      view,
      onSaved,
    });
  }
}

async function setDefault(
  networkId: string,
  view: EffectiveViewRow,
  nextDefault: boolean,
): Promise<void> {
  try {
    if (view.scope === 'type') {
      await etn.thoughtTypeViews.update(
        networkId,
        view.defined_on,
        view.id,
        { is_default: nextDefault },
        view.version,
      );
    } else {
      await etn.thoughtCustomViews.update(
        networkId,
        view.defined_on,
        view.id,
        { is_default: nextDefault },
        view.version,
      );
    }
    notice(
      nextDefault ? t('strip.defaultSet') : t('strip.defaultCleared'),
      'info',
    );
    // Realtime-событие `*.updated` перерисует полосу.
  } catch (err) {
    notice(formatStripError(err, t('strip.defaultFailed')), 'error');
  }
}

/**
 * Есть ли у мысли-получателя собственный внетиповой отбор по умолчанию
 * (пометка не переедет). Считается по `own_default` — собственной пометке
 * строки, а НЕ по эффективному `is_default`: эффективный флаг зануляется,
 * когда у мысли есть внетиповой дефолт. Внетиповые строки в эффективном
 * наборе не перекрываются, поэтому `own_default` у них достоверен.
 */
function hasOwnThoughtDefault(views: EffectiveViewRow[]): boolean {
  return views.some((row) => row.scope === 'thought' && row.own_default);
}

/**
 * Есть ли у типа-получателя СВОЙ отбор по умолчанию — спрашиваем источник
 * истины отдельным запросом, а не выводим из эффективного набора мысли.
 *
 * Эффективный набор для этого не годится: одноимённый внетиповой отбор мысли
 * перекрывает типовой ЦЕЛИКОМ — строки нет в наборе, и `own_default` скрытого
 * дефолта недоступен (проверка раунда 2, overlay-репро w6: клиент молчал, а
 * сервер пометку снимал). `list` без `include_effective` отдаёт в `data`
 * только собственные отборы типа, где `is_default` — собственная пометка.
 *
 * Ошибка запроса перенос НЕ блокирует: сервер — гарант снятия пометки,
 * подтверждение просто открывается без третьего элемента (недоступность
 * подсказки не должна запрещать штатную операцию).
 */
async function typeRecipientHasOwnDefault(
  networkId: string,
  typeId: string,
): Promise<boolean> {
  try {
    const result = await etn.thoughtTypeViews.list(networkId, typeId, {
      includeEffective: false,
    });
    return result.data.some((row) => row.is_default);
  } catch {
    return false;
  }
}

/**
 * Перенос «вне типа → тип» (операция 85414fbd). Подтверждение называет
 * эффект на все мысли типа и снятие пометки «по умолчанию» при занятом
 * собственном дефолте получателя (спека df84de22). Дефолт получателя
 * читается из собственных отборов типа ({@link typeRecipientHasOwnDefault}).
 */
async function moveViewToType(networkId: string, view: EffectiveViewRow): Promise<void> {
  const focusId = currentFocusId;
  const typeId = currentFocusTypeId;
  if (focusId === null || typeId === null) return;
  const recipientHasDefault = await typeRecipientHasOwnDefault(networkId, typeId);
  const message =
    t('strip.transferToTypeConfirm', [view.name || view.name_key, typeNameOf(typeId)]) +
    (recipientHasDefault ? ` ${t('strip.transferDefaultNote')}` : '');
  const ok = await confirmDialog(t('strip.transferToTypeTitle'), message, false);
  if (!ok) return;
  try {
    const moved = await etn.thoughtCustomViews.moveToType(networkId, view.defined_on, view.id);
    notice(t('strip.transferDone'), 'info');
    if (currentMode.kind === 'view' && currentMode.viewId === view.id) {
      // id при переносе сохраняется — активный чип остаётся, меняется лишь
      // владелец (курсив → обычный).
      setMode(
        {
          kind: 'view',
          viewId: moved.id,
          viewName: moved.name_key,
          scope: 'type',
          definedOn: typeId,
        },
        true,
      );
      persistForCurrentFocus();
      notifyModeChange();
    }
  } catch (err) {
    notice(formatStripError(err, t('strip.transferFailed')), 'error');
  }
}

/**
 * Перенос «тип → вне» (операция 85414fbd) на мысль в фокусе. Для
 * унаследованного отбора подтверждение называет ещё и типы-потомки
 * типа-владельца; при занятом собственном дефолте получателя — снятие
 * пометки (спека df84de22).
 */
async function moveViewToThought(networkId: string, view: EffectiveViewRow): Promise<void> {
  const focusId = currentFocusId;
  if (focusId === null) return;
  // Адрес пути — `defined_on` (для унаследованного это тип-владелец).
  const ownerTypeName = typeNameOf(view.defined_on);
  let message = t('strip.transferToThoughtConfirm', [
    view.name || view.name_key,
    ownerTypeName,
    currentFocusTitle,
  ]);
  if (view.inherited) {
    message += ` ${t('strip.transferInheritedNote', ownerTypeName)}`;
  }
  if (hasOwnThoughtDefault(effectiveViews)) {
    message += ` ${t('strip.transferDefaultNote')}`;
  }
  const ok = await confirmDialog(t('strip.transferToThoughtTitle'), message, false);
  if (!ok) return;
  try {
    const moved = await etn.thoughtTypeViews.moveToThought(
      networkId,
      view.defined_on,
      view.id,
      focusId,
    );
    notice(t('strip.transferDone'), 'info');
    if (currentMode.kind === 'view' && currentMode.viewId === view.id) {
      setMode(
        {
          kind: 'view',
          viewId: moved.id,
          viewName: moved.name_key,
          scope: 'thought',
          definedOn: focusId,
        },
        true,
      );
      persistForCurrentFocus();
      notifyModeChange();
    }
  } catch (err) {
    notice(formatStripError(err, t('strip.transferFailed')), 'error');
  }
}

async function deleteView(networkId: string, view: EffectiveViewRow): Promise<void> {
  // Унаследованный отбор удаляется из редактора его собственного типа —
  // кнопка в контекстном меню уже `disabled: view.inherited`, но прямой
  // вызов из кода не должен молча отправлять DELETE на чужой тип.
  if (view.inherited) return;
  // Симметрия с `onDelete` во вкладке «Отборы» редактора типа
  // (regression a62190d1): без подтверждения клик по «Удалить отбор» молча
  // стирал отбор — действие необратимое. Текст называет владельца
  // (спека df84de22, DoD).
  const message = view.scope === 'type'
    ? t('strip.deleteTypeConfirm', [view.name || view.name_key, typeNameOf(view.defined_on)])
    : t('strip.deleteThoughtConfirm', [view.name || view.name_key, currentFocusTitle]);
  const ok = await confirmDialog(t('strip.deleteTitle'), message, true);
  if (!ok) return;
  try {
    if (view.scope === 'type') {
      await etn.thoughtTypeViews.remove(networkId, view.defined_on, view.id, view.version);
    } else {
      await etn.thoughtCustomViews.remove(networkId, view.defined_on, view.id, view.version);
    }
    notice(t('strip.deleted'), 'info');
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
    notice(formatStripError(err, t('strip.deleteFailed')), 'error');
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

/**
 * Кеш признака «определение отбора использует критерий `keywords`», ключ —
 * `viewId`. Читается из определения ({@link prefetchViewDefinition}) при запуске
 * отбора. Нужен холсту, чтобы решать, переисполнять ли отбор на правку заголовка/
 * синонимов мысли (блокер G3): без `keywords` такие поля состав отбора не меняют.
 *
 * Полоса НЕ ведёт собственного мнения о сортировке: сохранённую сортировку
 * (плоскую пару `sort`/`order` либо многоуровневый `ast.sort`, в т.ч. по
 * свойству реестра) читает ИСПОЛНИТЕЛЬ из определения отбора
 * (`server/.../thought-type-views-service.ts`: `readSavedSort`/`ast.sort`) —
 * полоса лишь просит исполнить отбор. Фильтровать или подменять сохранённую
 * сортировку на стороне исполнителя запрещено (ADR 23fab347, ошибки
 * 33a3e285/119b314f).
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

/** Drops the cached view keyword usage (вызывается при rebuild полосы). */
function invalidateViewDefinitionCache(): void {
  viewKeywordsCache.clear();
}

/**
 * Взять определение отбора из уже загруженного эффективного набора и
 * закешировать признак использования `keywords`. Второй list-запрос больше не
 * нужен: строка эффективного набора несёт `definition` (спека df84de22).
 * Сортировку полоса здесь НЕ разбирает и НЕ кеширует: её исполняет сервер по
 * определению отбора (ADR 23fab347).
 */
function prefetchViewDefinition(viewId: string): void {
  if (viewKeywordsCache.has(viewId)) return;
  const row = effectiveViews.find((v) => v.id === viewId);
  if (row === undefined || row.definition === '') {
    viewKeywordsCache.set(viewId, false);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.definition) as unknown;
  } catch {
    viewKeywordsCache.set(viewId, false);
    return;
  }
  viewKeywordsCache.set(viewId, definitionUsesKeywords(parsed));
}

export async function runActiveViewIfNeeded(focusId: string): Promise<ViewResult | null> {
  if (currentMode.kind !== 'view') return null;
  const networkId = store.state.networkId;
  if (networkId === null) return null;
  const seq = ++runSeq;
  try {
    // Прочитать определение — только ради кеша признака `keywords` (G3).
    // Сортировку не передаём: исполнитель читает её из определения отбора сам
    // (`readSavedSort` для плоской пары, `ast.sort` для многоуровневой), поэтому
    // ни отбраковать, ни подменить её полоса не может (ADR 23fab347).
    prefetchViewDefinition(currentMode.viewId);
    const resp = await etn.thoughtTypeViews.run(
      networkId,
      focusId,
      currentMode.viewName,
      undefined,
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
      // Владелец — из ответа сервера; fallback на активный режим для
      // совместимости (старый сервер не присылал scope/defined_on).
      scope: resp.meta.view.scope ?? currentMode.scope,
      definedOn: resp.meta.view.defined_on ?? currentMode.definedOn,
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
    notice(formatStripError(err, t('strip.runFailed')), 'error');
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
    // Сортировку не передаём — ту же сохранённую сортировку определения
    // читает исполнитель, поэтому страница догружается в том же порядке
    // (ADR 23fab347). `limit`/`offset` — только пагинация.
    const resp = await etn.thoughtTypeViews.run(networkId, focusId, currentMode.viewName, {
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

/**
 * Payload, который полоса читает из realtime-событий отборов. Типовые события
 * несут `thought_type_id`, внетиповые — `thought_id`; `reason: 'moved'`
 * отличает перенос владельца от удаления (операция 85414fbd).
 */
export interface ViewRealtimePayload {
  thought_type_id?: string;
  thought_id?: string;
  view_id?: string;
  type?: string;
  reason?: 'moved';
}

/** Called by the realtime UI bridge (и подпиской на инвалидации ниже), когда
 *  приходит событие `thought-type-view.*` или `thought-custom-view.*`. Полоса
 *  перестраивается всегда — и для безтиповой мысли тоже (отборы корневого типа
 *  и внетиповые; спека df84de22). */
export function onThoughtTypeViewRealtime(payload: ViewRealtimePayload): void {
  // Удалённый активный отбор → «Потомки». Перенос (`reason: 'moved'`) — НЕ
  // удаление: id жив, чип остаётся активным и лишь перерезолвит владельца.
  const isPlainDelete =
    payload.type !== undefined &&
    payload.type.endsWith('.deleted') &&
    payload.reason !== 'moved';
  const resetActiveIfDeleted =
    isPlainDelete &&
    payload.view_id !== undefined &&
    currentMode.kind === 'view' &&
    currentMode.viewId === payload.view_id;
  void refreshStripFromRealtime(resetActiveIfDeleted);
}

let realtimeRebuildSeq = 0;
async function refreshStripFromRealtime(resetActiveIfDeleted: boolean): Promise<void> {
  const focus = store.state.focus;
  if (focus === null) return;
  const seq = ++realtimeRebuildSeq;
  // The event carries a view definition change: the cached `keywords` flag may
  // be stale, while the focus itself did not change (so `renderStrip` no longer
  // drops the cache on its own).
  invalidateViewDefinitionCache();
  await renderStrip(
    focus,
    resetActiveIfDeleted ? { resetActiveIfDeleted: true } : undefined,
  );
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

// Слой (G6): `thought-type-view.*` гасит ключ `views:@<typeId>`,
// `thought-custom-view.*` — `thought-views:@<thoughtId>`. Полоса
// перестраивается из подписки на инвалидацию (прямой realtime-хук не нужен),
// но payload события нужен: по нему отличаются перенос и удаление
// (`asRealtimeCause`).
onQueryInvalidated((prefix, _keys, cause) => {
  const realtime = asRealtimeCause(cause);
  const data = (realtime?.data ?? {}) as ViewRealtimePayload;
  if (prefix.startsWith('thought-views:@')) {
    const thoughtId = prefix.slice('thought-views:@'.length);
    // Внетиповые отборы чужой мысли эффективный набор фокуса не меняют.
    if (thoughtId !== currentFocusId) return;
    onThoughtTypeViewRealtime({
      ...data,
      thought_id: thoughtId,
      ...(realtime !== null ? { type: realtime.type } : {}),
    });
    return;
  }
  if (prefix.startsWith('views:@')) {
    onThoughtTypeViewRealtime({
      ...data,
      thought_type_id: prefix.slice('views:@'.length),
      ...(realtime !== null ? { type: realtime.type } : {}),
    });
  }
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
      items.push(
        menuChoice(overflowLabel(captured), currentMode.kind === 'view' && currentMode.viewId === captured.id, () => {
          setMode(viewModeFromRow(captured), true);
          persistForCurrentFocus();
          notifyModeChange();
        }),
      );
    }
    if (items.length === 0) {
      items.push(menuAction(t('strip.noViews'), undefined, { disabled: true }));
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
