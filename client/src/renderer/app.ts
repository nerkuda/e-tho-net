/**
 * Application controller: boot, connection, network opening, focus switching.
 *
 * Owns the top-level flows that span modules:
 *  - boot: pick the active profile → networks screen, or onboarding;
 *  - `openNetwork` (H3): network meta + L3/L4 state + initial focus;
 *  - `setFocus`/`refreshFocus` (H5): focus switching with history rotation;
 *  - `disconnect` (H18): back to onboarding.
 *
 * The canvas/editor/statusbar render from the store and subscribe to changes;
 * this module only mutates the store.
 */

import type { Thought } from '@etn/shared';

import { errorDialog, hasOpenDialog } from './lib/dialog.js';
import { errText, hasTextSelection } from './lib/dom.js';
import { describeConnectFailure } from './lib/connect-failure.js';
import { etn } from './lib/etn.js';
import {
  activateFocusQuery,
  deactivateFocusQuery,
  findRootThought,
  refreshFocusOrNull,
  resetFocusToHome,
  publishFocusResponse,
} from './lib/layer-resync.js';
import {
  GLOBAL_CONTEXT_ID,
  defineKeyContext,
  installKeymap,
  isEditableTarget,
  type KeyBindingDef,
  type KeyCommandHandler,
} from './lib/keymap.js';
import { queryKeys } from './lib/live/query-keys.js';
import {
  LOCAL_CAUSE,
  REALTIME_CONTROL_CAUSE,
  REALTIME_REFETCH_MAX_WAIT_MS,
  REALTIME_REFETCH_WINDOW_MS,
  invalidateQueries,
  isRealtimeCause,
  setQueryData,
  type InvalidationCause,
} from './lib/live/query-registry.js';
import { notice } from './lib/notice.js';
import { logUiEvent } from './lib/ui-log.js';
import { UI_STATE_KEY, PREF_KEY, parseStoredCanvasLinkFilter } from '@etn/shared';
import { applyCanvasZoom } from './canvas/canvas-zoom.js';
import { getCanvasCursor, resetCanvasCursor } from './canvas/kbd-nav.js';
import { resolveThoughtCopyTarget, screenThoughtSource } from './lib/screen-thought-source.js';
import {
  defaultEventAreaW,
  parseCanvasLayout,
  parseCanvasZoom,
  parseCollapsedGroups,
  parseCloudGap,
  parseCloudWidth,
  parseLinkTypeId,
  parseListHeights,
  parseWindowLayout,
  pickMostRecentTab,
} from './lib/pure.js';
import { initListClamps } from './editor/list-heights.js';
import { noteThoughtRemoved, noteThoughtWillOpen } from './history.js';
import { initRealtime, refreshRealtimeStatuses, setRealtimeEffects } from './realtime.js';
import { applyDerivedRealtime } from './realtime-effects.js';
import { initTheme } from './lib/theme.js';
import { initLang } from './lib/lang.js';
import { loadUserSettings, resetUserSettings } from './lib/user-settings.js';
import { initLayerTheme } from './lib/layer-colors.js';
import { initLockCache, refresh as refreshLockCache } from './lib/lock-cache.js';
import { initLockReconnect } from './lib/lock-guard.js';
import { ensureLoaded as ensureUserNamesLoaded } from './lib/users.js';
import { initTransclusionSourceCache } from './editor/transclusion.js';
import { invalidateAllRefs, invalidateRef } from './canvas/canvas.js';
import { invalidateHistoryBar } from './screens/history-bar.js';
import { refreshTabAccessibility } from './screens/tabs/tab-accessibility.js';
import { refreshSearchIfVisible } from './search/search.js';
import {
  invalidateStructuresThought,
  scheduleStructuresRefresh,
} from './screens/structures/structures.js';
import { showScreen } from './screens/screens.js';
import { serverLabelOf, store, type WorkspaceView } from './state.js';
import { syncLayersForTab } from './screens/layers.js';

/** Debounce for coalescing realtime-triggered refreshes, ms. */
const REFRESH_DEBOUNCE_MS = 200;

let refreshTimer: number | null = null;
/** Жёсткий срок realtime-волны fallback-перечитывания (не продлевается). */
let refreshMaxWaitTimer: number | null = null;

/** Снять оба таймера fallback-перечитывания окрестности. */
function clearRefreshTimers(): void {
  if (refreshTimer !== null) {
    window.clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (refreshMaxWaitTimer !== null) {
    window.clearTimeout(refreshMaxWaitTimer);
    refreshMaxWaitTimer = null;
  }
}

/** Принудительный/финальный проход fallback-перечитывания. */
function runFallbackRefresh(): void {
  clearRefreshTimers();
  void refreshFocus().catch(() => undefined);
}

/**
 * Re-exported from `lib/layer-resync.ts` for callers that already import
 * `findRootThought` from here (chronicle.ts, others). The implementation
 * lives there to keep the focus-side helpers canvas-free and individually
 * testable.
 */
export { findRootThought } from './lib/layer-resync.js';

/**
 * Opens a network (H3): loads L2 meta, L3 preferences and L4 ui_state, picks
 * the initial focus (stored focus → HOME) and mounts the workspace.
 *
 * When called with `tabId`, the per-tab snapshot (focus_id, view_mode)
 * takes priority over the legacy network-level L4 keys — duplicates of the
 * same network each get their own snapshot, and switching tabs inside the
 * workspace restores the right focus / view.
 */
export async function openNetwork(networkId: string, tabId?: string): Promise<void> {
  // The cursor lives on a cloud from the previously open network — drop it
  // before anything else, otherwise a quick Ctrl+V in the new network would
  // target an id that no longer exists on the map.
  resetCanvasCursor();
  // Слой данных (G2): снимаем подписку прошлой окрестности — иначе её
  // слушатель писал бы фокус закрытой сети в store.
  deactivateFocusQuery();
  const network = await etn.networks.open(networkId);
  // The pool was created lazily by `networks.open`; refresh the per-network
  // status snapshot so the indicator does not wait for the next broadcast
  // (defect de34b35b, verify remark 4).
  void refreshRealtimeStatuses();
  const prefs = await etn.networks.getPreferences(networkId);
  const showInactivePref = prefs.find((p) => p.key === PREF_KEY.SHOW_INACTIVE);
  const showInactive =
    typeof showInactivePref?.value === 'boolean' ? showInactivePref.value : false;
  // «Показывать содержимое корзины» (задача 77923b49): по умолчанию `true` —
  // помеченные на удаление элементы видны с признаком корзины (355319d4).
  const showTrashPref = prefs.find((p) => p.key === PREF_KEY.SHOW_TRASH);
  const showTrash = typeof showTrashPref?.value === 'boolean' ? showTrashPref.value : true;
  // Requirement «Дефолт и хранение фильтра типов связей на карте» (0.8.1):
  // `null` — no explicit preference, the server (and the filter dialog)
  // fall back to the live `show_on_map` default.
  const canvasLinkFilterPref = prefs.find((p) => p.key === PREF_KEY.CANVAS_LINK_FILTER);
  const canvasLinkFilter = parseStoredCanvasLinkFilter(canvasLinkFilterPref?.value);

  const [cloudWidthRaw, cloudGapRaw, posRaw, collapsedRaw, focusRaw, linkTypeRaw, layoutRaw, canvasLayoutRaw, canvasZoomRaw, activeViewRaw, pinsRaw, heightsRaw, chronicleHeightsRaw] =
    await Promise.all([
      etn.ui.getState(networkId, UI_STATE_KEY.CLOUD_WIDTH),
      etn.ui.getState(networkId, UI_STATE_KEY.CLOUD_GAP),
      etn.ui.getState(networkId, UI_STATE_KEY.EDITOR_POSITION),
      etn.ui.getState(networkId, UI_STATE_KEY.EDITOR_COLLAPSED_GROUPS),
      etn.ui.getState(networkId, UI_STATE_KEY.CURRENT_FOCUS_THOUGHT_ID),
      etn.ui.getState(networkId, UI_STATE_KEY.LAST_USED_LINK_TYPE_ID),
      etn.ui.getState(networkId, UI_STATE_KEY.WINDOW_LAYOUT),
      etn.ui.getState(networkId, UI_STATE_KEY.CANVAS_LAYOUT),
      etn.ui.getState(networkId, UI_STATE_KEY.CANVAS_ZOOM),
      etn.ui.getState(networkId, UI_STATE_KEY.ACTIVE_VIEW),
      etn.pins.list(networkId),
      etn.ui.getState(networkId, UI_STATE_KEY.EDITOR_LIST_HEIGHTS),
      etn.ui.getState(networkId, UI_STATE_KEY.CHRONICLE_LIST_HEIGHTS),
    ]);

  const editorPosition = (
    ['left', 'right', 'top', 'bottom', 'hidden'].includes(posRaw ?? '') ? posRaw : 'right'
  ) as 'left' | 'right' | 'top' | 'bottom' | 'hidden';

  const editorSize = parseWindowLayout(layoutRaw);
  // Status-bar event-area width: older payloads have no `e` key (the field
  // was introduced to fix the bottom-bar jitter — see bug de07e690-…). In
  // that case we fall back to the current window's default so the area lands
  // at `max(200px, 18%)` without waiting for the first drag.
  const eventAreaW = editorSize.e ?? defaultEventAreaW(window.innerWidth);
  const canvasLayout = parseCanvasLayout(canvasLayoutRaw);
  // Saved list max-heights (ee745368): both L4 blobs merge into one map —
  // the editor applies its keys as --clamp-* variables on the scroll box,
  // the chronicle screen clamps its areas inline on mount (persistKeys are
  // namespaced: `chronicle.*` vs the editor keys).
  initListClamps({
    ...parseListHeights(heightsRaw),
    ...parseListHeights(chronicleHeightsRaw),
  });

  const [linkTypes, thoughtTypes] = await Promise.all([
    etn.types.listLinkTypes(networkId),
    etn.types.listThoughtTypes(networkId),
  ]);

  store.update({
    network,
    networkId,
    showInactive,
    showTrash,
    canvasLinkFilter,
    cloudWidth: parseCloudWidth(cloudWidthRaw),
    cloudGap: parseCloudGap(cloudGapRaw),
    canvasZoom: parseCanvasZoom(canvasZoomRaw),
    editorPosition,
    editorW: editorSize.w,
    editorH: editorSize.h,
    selectionW: editorSize.s,
    usageW: editorSize.u,
    eventAreaW,
    zoneTopSplit: canvasLayout.topSplit,
    zoneChildrenShare: canvasLayout.childrenShare,
    collapsedGroups: parseCollapsedGroups(collapsedRaw),
    linkTypes,
    thoughtTypes,
    lastUsedLinkTypeId: parseLinkTypeId(linkTypeRaw),
    focus: null,
    selection: [],
    editorTarget: null,
    structuresActiveThoughtId: null,
    structuresActiveThought: null,
    pins: (pinsRaw ?? []).map((p) => p.thought_id),
  });
  // Срез слоя `pins` (G5): порядок закреплённых для панели — из ответа сети.
  setQueryData(queryKeys.pins(), (pinsRaw ?? []).map((p) => p.thought_id));

  // Холодная синхронизация захватов (0.12.2, задача 8e4e3dc5): клик по
  // легаси-ссылке проверяет, не захвачена ли цель другим пользователем, а
  // `refresh()` до этого не вызывал никто — захват, взятый до подключения,
  // оставался невидимым. Best-effort, ошибку глотает сам `refresh`.
  void refreshLockCache();
  // Кэш имён участников — для показа держателя захвата именем, а не UUID
  // (ошибка cb9b466f): читается один раз на сеть/пользователя, best-effort.
  ensureUserNamesLoaded();

  // Q3: refresh tab list and activate the right entry. When the caller
  // supplies `tabId` (the picker / tab activation), that exact tab wins —
  // duplicate opens of the same network don't collapse onto the first
  // existing tab.
  let activeTabId: string | null = null;
  let activeTabView: WorkspaceView | null = null;
  let activeTabFocusId: string | null = null;
  let activeTabLayerId: string | null = null;
  try {
    let tabs = await etn.tabs.list();
    let target: { tab_id: string } | null = null;
    if (tabId !== undefined) {
      target = tabs.find((t) => t.tab_id === tabId) ?? null;
    }
    // No matching tab yet? The networks screen entry opens without a tab —
    // create one so the strip populates. Duplicates are explicit and
    // re-openings of the same network still create a fresh tab.
    if (target === null) {
      const fresh = await etn.tabs.open(networkId);
      tabs = await etn.tabs.list();
      target = tabs.find((t) => t.tab_id === fresh.tab_id) ?? { tab_id: fresh.tab_id };
    }
    const fullTarget = tabs.find((t) => t.tab_id === target!.tab_id) ?? null;
    activeTabId = fullTarget?.tab_id ?? target!.tab_id;
    activeTabView = fullTarget?.view_mode ?? null;
    activeTabFocusId = fullTarget?.focus_id ?? null;
    activeTabLayerId = fullTarget?.layer_id ?? null;
    store.update({
      tabs,
      activeTabId,
    });
  } catch {
    // ignore — workspace still usable without tab strip state
  }

  // S11 (13-layers.md §10.3): the layer is a property of the TAB. Align the
  // server-side session to the tab's layer BEFORE the focus loads — the focus
  // (and every later read/write) must resolve in this tab's layer, not in
  // whatever layer the previous tab left behind. Failures keep the base layer
  // and an empty layer list; the menu recovers on the next open.
  try {
    await syncLayersForTab(networkId, activeTabLayerId);
  } catch {
    // offline / layer deleted elsewhere — the workspace stays usable
  }

  // Q-bugfix: per-tab view_mode takes priority over the legacy L4 key, so
  // switching tabs inside a network actually swaps the view (not just the
  // highlighted tab).
  const viewFromTab = activeTabView;
  const knownView = (value: string | null): value is WorkspaceView =>
    value === 'structures' || value === 'chronicle' || value === 'publications';
  const resolvedView: WorkspaceView =
    knownView(viewFromTab)
      ? viewFromTab
      : knownView(activeViewRaw)
        ? activeViewRaw
        : 'map';
  store.update({ activeView: resolvedView });

  showScreen('workspace');

  // Q-bugfix: per-tab focus_id takes priority over the legacy L4 key. The
  // tab's focus was already persisted by the previous `setFocus` call (or by
  // a previous session), so we just LOAD it — `loadFocusForTab` does not
  // rotate the per-tab history and does not re-persist.
  let initial: Thought | null = null;
  const preferredFocusId = activeTabFocusId ?? focusRaw;
  if (preferredFocusId !== null && preferredFocusId !== '') {
    try {
      initial = await etn.thoughts.get(networkId, preferredFocusId);
    } catch {
      initial = null; // stored focus vanished — fall through to HOME
    }
  }
  if (initial !== null) {
    await loadFocusForTab(initial.id, networkId, activeTabId);
  } else {
    const root = await findRootThought(networkId);
    await loadFocusForTab(root.id, networkId, activeTabId);
  }

  // 8efd5cf8 (Q5): `store.tabs` is only populated HERE — the accessibility
  // pass fired right after `server.connect` (boot / restoreSession) runs
  // against an empty tab list and marks nothing, so a tab whose network died
  // while the client was away stays unmarked until the «+» picker happens to
  // open. Re-running the pass at the end of every open covers every path that
  // fills the store (session restore, the networks screen, the picker, tab
  // activation) and also clears stale marks when a network becomes visible
  // again.
  void refreshTabAccessibility();
}

/**
 * Loads the focus response for `thoughtId` into the store WITHOUT rotating
 * the per-tab history and WITHOUT re-persisting `focus_id` (it was already
 * saved when the user originally navigated there). Used on tab activation
 * and on `openNetwork`'s initial-focus path so the history of one tab does
 * not get polluted with another tab's previous focus.
 */
export async function loadFocusForTab(
  thoughtId: string,
  networkId: string,
  tabId: string | null,
): Promise<void> {
  try {
    const response = await etn.thoughts.focus(networkId, thoughtId);
    // Слой данных (G2): свежий ответ идёт в кэш `focus:@id`, активная
    // окрестность подписывается на него — холст рисует из кэша.
    publishFocusResponse(response);
    activateFocusQuery(networkId, thoughtId);
    store.update({ editorTarget: null, selectedLinkId: null });
  } catch {
    // The persisted thought vanished (deleted, no access) — fall back to a
    // blank focus so the workspace isn't stuck showing the previous network's
    // neighbourhood. The HOME recovery happens via `findRootThought` in
    // `openNetwork` when this returns no focus at all.
    return;
  }
  // Defensive: if the persisted focus_id on the tab row got lost somehow,
  // restore it now — better than a workspace that opens on a stale HOME
  // after every restart.
  if (tabId !== null) {
    const current = store.state.tabs.find((t) => t.tab_id === tabId);
    if (current !== undefined && current.focus_id !== thoughtId) {
      void etn.tabs.updateState(tabId, { focus_id: thoughtId }).catch(() => undefined);
      const updated = store.state.tabs.map((t) =>
        t.tab_id === tabId ? { ...t, focus_id: thoughtId } : t,
      );
      store.update({ tabs: updated });
    }
  }
}

/**
 * Derives the per-zone sort and display order from a focus response, so the
 * cloud drag module can decide reorder-vs-bounce-back and rebuild an order.
 *
 * (`zoneStateFromFocus` and `ensureManualPositionsInitialized` live in
 * `lib/layer-resync.ts` — imported above — so the focus-reset path is
 * canvas-free and individually testable.)
 */

/**
 * Focuses a thought (H5): fetches the focus response, rotates local history
 * (H7) and persists the L4 current-focus key.
 */
export async function setFocus(id: string): Promise<void> {
  const startedAt = Date.now();
  const networkId = requireNetworkId();
  const tabId = store.state.activeTabId;
  const response = await etn.thoughts.focus(networkId, id);
  // Unified visit history (0.5.5): records whatever thought was current a
  // moment ago (the previous focus, or a thought/link open in the editor
  // without moving the focus) — not necessarily the old focus. Must run
  // before the store update below (same reasoning as before: the history bar
  // re-renders from store changes, so this needs to land first).
  await noteThoughtWillOpen(id);
  // Слой данных (G2): ответ фокуса кладётся в кэш `focus:@id` (мутатор-путь),
  // активная окрестность подписывается на ключ. Ручного перечитывания
  // окрестности нет — холст перерисовывается из кэша.
  publishFocusResponse(response);
  activateFocusQuery(networkId, id);
  store.update({
    editorTarget: null,
    selectedLinkId: null,
    structuresActiveThoughtId: null,
    structuresActiveThought: null,
  });
  // Milestone journal mark (task 92b89e6f): the focus response has landed and
  // the canvas/store now render it — the closing bracket of the
  // `ui.cloud.click` → `ui.focus.applied` pipeline.
  logUiEvent('ui.focus.applied', { id, ms: Date.now() - startedAt });
  // Q4: persist focus_id on the tab row so it survives restarts and tab
  // switches. Falls back to the legacy ui_state key when no tab is active
  // (shouldn't happen post-Q3, but defensible).
  if (tabId !== null) {
    void etn.tabs.updateState(tabId, { focus_id: id }).catch(() => undefined);
  } else {
    void etn.ui.setState(networkId, UI_STATE_KEY.CURRENT_FOCUS_THOUGHT_ID, id).catch(() => undefined);
  }
}

/**
 * Refetches the current focus without touching the focus history (used for
 * realtime refreshes and `resume.stale`).
 *
 * Returns when the focus was either re-read or silently kept (no thought to
 * refresh, or the focused thought is not present in the current layer — that
 * is `refreshFocusOrNull`'s job and its `null` is treated as "nothing to
 * do" here; layer switches handle the 404 case separately, in
 * `resyncAfterLayerSwitch`).
 */
export async function refreshFocus(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  await refreshFocusOrNull(networkId);
}

/**
 * Coalesces consecutive focus-refresh requests into one call.
 *
 * Слой данных (G2): вместо прямого перечитывания `thoughts.focus()` гасим
 * `focus`-ключи реестра — активная окрестность (подписана, пока холст
 * смонтирован) перезапросится роутером/слоем.
 *
 * `cause` — причина инвалидации. Realtime-событие отдаётся реестру как есть:
 * он сам коалесирует волну в окне {@link REALTIME_REFETCH_WINDOW_MS} с жёстким
 * сроком {@link REALTIME_REFETCH_MAX_WAIT_MS} от первого события, поэтому
 * второй дебаунс здесь не нужен (иначе задержка складывалась бы). Локальные
 * вызовы сохраняют прежнее окно {@link REFRESH_DEBOUNCE_MS} и микротаску —
 * действия пользователя не задерживаются.
 */
export function scheduleRefresh(cause?: InvalidationCause): void {
  if (isRealtimeCause(cause)) {
    const touched = invalidateQueries(queryKeys.focusAll(), cause);
    // Переходный fallback: экрана на слое ещё нет (или запрос не подписан) —
    // окрестность перечитываем напрямую, но тоже по закрытию окна волны.
    if (touched.length === 0) {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(runFallbackRefresh, REALTIME_REFETCH_WINDOW_MS);
      // Жёсткий срок волны — от первого события, поток его не продлевает
      // (иначе fallback так же голодал бы, как реестр до блокера 96d7f05d).
      if (refreshMaxWaitTimer === null) {
        refreshMaxWaitTimer = window.setTimeout(
          runFallbackRefresh,
          REALTIME_REFETCH_MAX_WAIT_MS,
        );
      }
    }
    return;
  }
  // Локальная причина: прежнее окно дебаунса и микротаска, без realtime-срока.
  clearRefreshTimers();
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    const touched = invalidateQueries(queryKeys.focusAll(), LOCAL_CAUSE);
    // Переходный fallback: экрана на слое ещё нет (или запрос не подписан) —
    // окрестность перечитываем напрямую, как раньше. Как только холст
    // подпишется на `focus:@id`, перезапрос пойдёт через слой.
    if (touched.length === 0) void refreshFocus().catch(() => undefined);
  }, REFRESH_DEBOUNCE_MS);
}

/**
 * Full resync of the visible state after the session's layer changed
 * (13-layers.md §12: the layer switch invalidates the client cache as a
 * whole). `refreshFocus` alone is not enough: the editor and the
 * structures/chronicle views carry their own cached snapshots (a thought
 * loaded into `editorTarget`, the active structures thought) that were read
 * in the previous layer's context — drop them and re-read everything the
 * new layer resolves. Called on the local layer switch (`selectLayerForTab`)
 * and on the server-side `layer.switched`/`layer.deleted` control frames.
 *
 * If the previously focused thought is not present in the new layer (it was
 * created in a non-base layer that the tab just left), the focus refresh
 * 404s — fall back to HOME so the editor/canvas have a valid row to render
 * instead of pinning the stale entity from the previous layer's context
 * (ETN error dc4e0c07).
 */
export async function resyncAfterLayerSwitch(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  // Cloud metadata (trash mark, active, colors) and the indicator counts were
  // resolved in the previous layer's context — drop them so the re-read below
  // re-resolves everything through the new layer chain (13-layers.md §12).
  // A stale trash badge here is exactly bug 0.5.4: a mark lifted in a layer
  // kept hiding on the base cloud after switching back.
  invalidateAllRefs();
  invalidateQueries(queryKeys.indicatorsAll(), LOCAL_CAUSE);
  // Re-read the focus FIRST: the editor follows it once the cached snapshots
  // are dropped below, and this way it renders straight into the new layer's
  // data instead of flashing the old layer's focus for a frame.
  //
  // If the focused thought is not present in the new layer (it was created in
  // a non-base layer that the tab just left), `refreshFocusOrNull` returns
  // `null` — fall back to HOME so the editor/canvas have a valid row in the
  // new layer instead of pinning the stale entity from the previous layer's
  // context. Without this, the editor would keep rendering the cached header
  // and every property fetch would 404 with a raw server string in the UI
  // (ETN error dc4e0c07).
  const focusOk = await refreshFocusOrNull(networkId);
  if (focusOk === null) {
    await resetFocusToHome(networkId);
  }
  store.update({
    editorTarget: null,
    selectedLinkId: null,
    structuresActiveThoughtId: null,
    structuresActiveThought: null,
  });
  scheduleStructuresRefresh();
  // «Дневник» (G3) — тем же слоем: гасим ключ ленты, экран перечитает её сам.
  invalidateQueries(queryKeys.chronicleFeedAll(), LOCAL_CAUSE);
}

/** Returns to the network list (e.g. after `network-lost`). */
export function backToNetworks(): void {
  // Смена сети — уничтожение контекста: отложенные fallback-перечитывания
  // окрестности старой сети не должны сработать после перехода.
  clearRefreshTimers();
  deactivateFocusQuery();
  store.resetNetwork();
  showScreen('networks');
}

/**
 * Restores the saved session after a successful connect: when the profile has
 * locally saved tabs (open networks, per-tab focus / view — the settings of a
 * previous run), drop the user straight into the most recently active one —
 * exactly like a client restart (Q-bugfix). Without saved tabs (first-time
 * connect, cleared cache) the network list offers the choice (H3).
 *
 * Shared by `boot()` and by the onboarding reconnect paths, so reconnecting to
 * a previously used server no longer forces a network re-pick (bug
 * be430215: every re-pick opened a duplicate tab of an already open network).
 */
export async function restoreSession(): Promise<void> {
  // Серверные настройки пользователя (уровень «пользователь × сервер», ADR
  // 3a829d25, задача d534eb35): сочетания клавиш комментария. Общая точка
  // после успешного подключения — boot() и оба пути онбординга зовут
  // restoreSession(). Недоступные настройки не блокируют вход: при сбое
  // остаются умолчания.
  await loadUserSettings().catch(() => undefined);
  // Q5: warm the `networkList` cache early so the first tab-strip render has
  // display_names. The accessibility marking itself re-runs at the end of
  // `openNetwork`, once `store.tabs` is populated — marking here raced an
  // empty tab list and never fired (defect 8efd5cf8).
  void refreshTabAccessibility();
  const tabs = await etn.tabs.list().catch(() => []);
  const mostRecent = pickMostRecentTab(tabs);
  if (mostRecent !== null) {
    const opened = await openNetwork(mostRecent.network_id, mostRecent.tab_id)
      .then(() => true)
      .catch(() => false);
    if (opened) return;
    // The saved tab's network can't be opened (deleted server-side, access
    // revoked) — the network list is the sane fallback, not a blank window.
  }
  showScreen('networks');
}

/** Disconnects the profile and returns to onboarding (H18 user menu). */
export async function disconnect(): Promise<void> {
  await etn.server.disconnect();
  clearRefreshTimers();
  deactivateFocusQuery();
  // Сочетания клавиш принадлежат пользователю сервера (L3s): при отключении
  // возвращаем умолчания, чтобы их не унаследовал следующий пользователь.
  resetUserSettings();
  store.resetNetwork();
  store.update({ me: null, profileId: null });
  showScreen('onboarding');
}

/** The current network id, or throws (callers require an open network). */
export function requireNetworkId(): string {
  const id = store.state.networkId;
  if (id === null) throw new Error('Сеть не открыта.');
  return id;
}

/**
 * Actor-side cleanup after deleting a thought (workplan L4). B1 техпроекта
 * 269016e2: the server delivers `thought.deleted` to the acting client too
 * (asynchronously), so this local mirror only makes the effect immediate — the
 * arriving event is idempotent afterwards.
 *
 *   * the thought leaves the local focus history (after the rotation that
 *     `setFocus` performs), caches and the selection;
 *   * when the deleted thought was the focus, the focus moves to the freshest
 *     surviving history entry (the "previous" thought) or, failing that, to
 *     the protected root thought (HOME);
 *   * otherwise the canvas just refreshes (the thought leaves its zone).
 */
export async function onThoughtDeleted(deletedId: string, realtime = false): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  // Причина дальнейших инвалидаций: realtime-канал (focus-lost от сервера)
  // или локальное действие (удаление из корзины/контекстного меню).
  const cause = realtime ? REALTIME_CONTROL_CAUSE : LOCAL_CAUSE;
  const wasFocus = store.state.focus?.focused.id === deletedId;
  if (store.state.selection.includes(deletedId)) {
    store.update({ selection: store.state.selection.filter((id) => id !== deletedId) });
  }
  // The server cascades the pin row (FK ON DELETE CASCADE) without an event —
  // drop it from the local panel here (L18).
  if (store.state.pins.includes(deletedId)) {
    store.update({ pins: store.state.pins.filter((id) => id !== deletedId) });
  }
  if (wasFocus) {
    const nextId = await pickFocusAfterDeletion(networkId, deletedId);
    if (nextId !== null) {
      try {
        await setFocus(nextId);
      } catch {
        // The picked thought vanished between validation and focus — HOME is
        // undeletable, fall back to it.
        try {
          await setFocus((await findRootThought(networkId)).id);
        } catch {
          // Nothing focusable — leave the UI as is (server will reconcile).
        }
      }
    }
  } else {
    scheduleRefresh(cause);
  }
  // setFocus's rotation may have just pushed the deleted id (as the old
  // focus) into the unified history — prune it afterwards so it never
  // lingers in «последние», and drop it from the in-memory tracker too so it
  // is never resurrected as "the previous thought" on the next transition.
  noteThoughtRemoved(deletedId);
  await etn.history.remove(deletedId, store.state.activeTabId).catch(() => undefined);
  invalidateQueries(queryKeys.indicators(deletedId), cause);
  invalidateRef(deletedId, realtime);
  invalidateHistoryBar();
  invalidateStructuresThought(deletedId);
  refreshSearchIfVisible();
}

/**
 * Picks the next focus after the focused thought was deleted: the freshest
 * history entry that still exists, else the protected root (HOME).
 */
async function pickFocusAfterDeletion(
  networkId: string,
  deletedId: string,
): Promise<string | null> {
  const profileId = store.state.profileId;
  if (profileId !== null) {
    try {
      const entries = await etn.history.list(profileId, networkId, store.state.activeTabId, 10);
      for (const entry of entries) {
        if (entry.thoughtId === deletedId) continue;
        try {
          await etn.thoughts.get(networkId, entry.thoughtId);
          return entry.thoughtId;
        } catch {
          // Stale history entry — try the next one.
        }
      }
    } catch {
      // History unavailable — fall back to HOME.
    }
  }
  try {
    return (await findRootThought(networkId)).id;
  } catch {
    return null;
  }
}

/**
 * Сообщение о неудаче автоподключения при запуске (ошибка 390e9746). Экран
 * подключения забирает его один раз и показывает у списка сохранённых
 * серверов: раньше отказ молча переключал на онбординг.
 */
let bootConnectFailure: string | null = null;

/**
 * Забрать (и погасить) сообщение об отказе автоподключения при запуске.
 * `null` — отказа не было.
 */
export function takeBootConnectFailure(): string | null {
  const message = bootConnectFailure;
  bootConnectFailure = null;
  return message;
}

/**
 * Boot: initialise realtime plumbing, then route to onboarding (no active
 * profile) or to the last-active tab (Q-bugfix) — when the user has
 * previously opened tabs, drop them straight into the workspace; otherwise
 * (first-time / cleared cache) show the network list.
 */
export async function boot(): Promise<void> {
  // Theme first (L10): the attribute must be on the root before any screen
  // mounts, otherwise the first paint flashes in the light theme.
  await initTheme();
  // Язык интерфейса (L5 `client_meta.lang`, задача 57f09136): словарь должен
  // быть выбран до монтажа первого экрана, иначе тексты придут на исходном ru.
  await initLang();
  // Layer colour indication (0.6.4 §2.2a): one store subscription writing
  // the --layer-* overrides (or clearing them) whenever the current layer,
  // its colours or the theme change.
  initLayerTheme();
  initLockCache();
  // Захваты живут только вместе с realtime-сессией: после переподключения
  // кэш перечитывается с сервера, а захваты открытых редакторов берутся
  // заново (ошибка 0702efb6).
  initLockReconnect();
  // Центральная инвалидация кэша источников трансклюзий по событиям `comment.*`
  // (задача a4f4113d): правка постоянного комментария-источника любой веткой —
  // своя или чужая — сбрасывает закэшированное тело, чтобы отрисовка блока не
  // показывала устаревший текст.
  initTransclusionSourceCache();
  initRealtime();
  setRealtimeEffects({
    // Full visible resync, not just a focus refresh (defect de34b35b):
    // `resume.stale` means the event window was exceeded — the editor and the
    // structures/chronicle snapshots are just as stale as the focus.
    onStale: () => {
      void resyncAfterLayerSwitch();
    },
    onFocusLost: () => {
      // Another user deleted our focused thought — same recovery as the
      // local delete: previous from the history, else HOME.
      const deletedId = store.state.focus?.focused.id;
      if (deletedId !== undefined) void onThoughtDeleted(deletedId, true);
    },
    onNetworkLost: () => backToNetworks(),
    onLayerControl: (payload) => {
      // S11: the session's layer changed server-side — re-sync layers +
      // overrides and fully re-read the visible state (13-layers.md §12),
      // dropping the cached editor/structures snapshots of the old layer.
      if (payload.networkId !== store.state.networkId) return;
      void syncLayersForTab(store.state.networkId, payload.layer.id).then(() =>
        resyncAfterLayerSwitch(),
      );
    },
    // G6: единственная точка производных эффектов события (store-срезы,
    // бесхитростные кэши UI, каталоги типов). Прежний мост `onRealtimeEvent`
    // снесён вместе со старым switch — прямых подписок на шину нет.
    onEventApplied: (evt) => applyDerivedRealtime(evt),
  });

  const profiles = await etn.server.listProfiles();
  const active = profiles.find((p) => p.isActive);
  if (active !== undefined) {
    // The status tooltip names the server; resolve it before the first
    // connect attempt so even «Подключение…» has a name (de34b35b, GUI review).
    const serverLabel = serverLabelOf(active);
    try {
      const me = await etn.server.connect(active.id);
      store.update({ profileId: active.id, serverLabel, me });
      // The realtime pool now exists: pull the per-network status snapshot
      // (defect de34b35b, verify remark 4).
      void refreshRealtimeStatuses();
      // Q-bugfix: restore the previous session — saved tabs go straight to
      // the most recently active one, no forced re-pick from the network list.
      await restoreSession();
      return;
    } catch (err) {
      // Connection failed (server down, key revoked) — onboarding offers a retry
      // and names the actual cause with the server address (ошибка 390e9746).
      store.update({ profileId: active.id, serverLabel, me: null });
      bootConnectFailure = describeConnectFailure(err, {
        label: active.label,
        baseUrl: active.baseUrl,
      });
      showScreen('onboarding');
      return;
    }
  }
  store.update({ profileId: null, serverLabel: null, me: null });
  showScreen('onboarding');
}

/** Global keyboard shortcuts (08-ui-spec.md §13): Ctrl+Shift+F, Escape,
 *  Ctrl+±/0, and the copy/paste bindings of workplan L26 (Ctrl+C, Ctrl+V).
 *
 *  Все команды регистрируются в общеклиентском диспетчере контекстов
 *  (`lib/keymap.ts`, ADR `b420b08c`): он владеет единственной точкой перехвата
 *  `keydown` на уровне приложения. Локальный `window.addEventListener` здесь
 *  больше не заводится — это запрет ADR. Экраны и поля вместо собственных
 *  слушателей регистрируют свои контексты (`defineKeyContext` +
 *  `pushKeyContext`). */
export function initKeyboard(): void {
  // Native text copies (the CM6 editor, inputs, text selections outside
  // editables) must supersede the internal thought clipboard — the same
  // "every copy displaces the previous one" rule as the system clipboard
  // (bug 731a9d16). Thought copies never fire a native copy event, so they
  // keep the snapshot.
  void import('./canvas/clipboard.js').then((m) => m.initNativeCopyTracking());
  defineKeyContext({ id: GLOBAL_CONTEXT_ID, bindings: globalKeyBindings() });
  installKeymap();
}

/** Привязки глобального контекста: команды уровня приложения. Порядок в
 *  массиве не важен — сочетания не пересекаются; проигравший по модификаторам
 *  вариант возвращает `false` и уступает нативной обработке. */
function globalKeyBindings(): KeyBindingDef[] {
  const bindings: KeyBindingDef[] = [];
  /** Регистрирует команду под несколькими сочетаниями (Ctrl и Meta-варианты). */
  const bind = (
    command: string,
    chords: string[],
    run: KeyCommandHandler,
    when?: (event: KeyboardEvent) => boolean,
  ): void => {
    for (const chord of chords) {
      bindings.push(when === undefined ? { command, chord, run } : { command, chord, run, when });
    }
  };

  // Copy / paste of thoughts (workplan L26). Only fire when the focus is
  // *not* inside an editable surface — there the native Ctrl+C/V must run
  // (CM6 comment editor, add dialog input, …).
  bind('app.copyThought', ['Ctrl+C', 'Meta+C'], (event) => {
    if (isEditableTarget(event.target)) return false;
    // Открытый модальный диалог приоритетнее команд карты (ошибка 82346a49):
    // на кнопке диалога `isEditableTarget` уже не спасает, и Ctrl+C копировал
    // мысль под подложкой. В полях диалога Ctrl+C по-прежнему остаётся
    // нативным — проверка выше отдаёт событие раньше.
    if (hasOpenDialog()) return false;
    if (event.shiftKey || event.altKey) return false;
    // A visible DOM text selection (e.g. inside the comment view mode,
    // b6690109) outranks the thought copy: no preventDefault, the native copy
    // puts the selected text on the system clipboard.
    if (hasTextSelection(document.getSelection())) return false;
    if (store.state.screen !== 'workspace' || store.state.networkId === null) return false;
    // Экраны без мыслей (Дневник, События, Публикации) не перехватывают Ctrl+C:
    // копирование мысли там не поддерживается — работает нативное копирование
    // текста (ошибка 00275531).
    if (!supportsThoughtCopy()) return false;
    void globalCopy(currentThoughtCopyTarget());
    return true;
  });

  bind('app.pasteThought', ['Ctrl+V', 'Meta+V'], (event) => {
    if (isEditableTarget(event.target)) return false;
    // Модальный диалог глушит команды карты (ошибка 82346a49); в полях
    // диалога нативная вставка остаётся — её отдаёт проверка выше.
    if (hasOpenDialog()) return false;
    if (event.shiftKey || event.altKey) return false;
    if (store.state.screen !== 'workspace' || store.state.networkId === null) return false;
    if (!supportsThoughtCopy()) return false;
    void globalPaste(currentThoughtPasteTarget());
    return true;
  });

  // Глобальный поиск клиента перенесён на Ctrl+Shift+F (0.12.1, задача
  // 045f98db, требование 778e13f4): Ctrl+F закреплён за поиском внутри
  // текущего текстового поля (панель поиска комментария, ТП1).
  bind('app.focusMapSearch', ['Ctrl+Shift+F', 'Meta+Shift+F'], (event) => {
    // Ctrl+Shift+F focuses the canvas search row — hidden in the structures view
    // (§15.1) and while a comment/field is being edited (native find should
    // not be hijacked there), so the shortcut does nothing in those cases.
    if (isEditableTarget(event.target)) return false;
    // Под модальным диалогом поиск карты молчит (ошибка 82346a49): иначе фокус
    // уходил в строку поиска за подложкой и ломал Tab-ловушку диалога.
    if (hasOpenDialog()) return false;
    if (store.state.screen === 'workspace' && store.state.activeView === 'map') {
      document.querySelector<HTMLInputElement>('.search-input')?.focus();
      return true;
    }
    return false;
  });

  // Canvas zoom (L9): '+'/'=' (both main-row layouts), numpad 'Add';
  // '-'/'Subtract'; '0' resets. Только при РЕАЛЬНО ВИДИМОМ холсте (ошибка
  // 63967c21): вид «Карта» без перекрытий. Раскладка (позиция редактора,
  // доли зон холста) холст не скрывает — скрывают его смена вида и
  // непрозрачные панели поверх (см. `canvasVisible`).
  bind(
    'canvas.zoomIn',
    ['Ctrl+=', 'Ctrl++', 'Ctrl+Shift+=', 'Ctrl+Add', 'Meta+=', 'Meta++', 'Meta+Add'],
    () => {
      applyCanvasZoom('in');
      return true;
    },
    canvasVisible,
  );
  bind(
    'canvas.zoomOut',
    ['Ctrl+-', 'Ctrl+Subtract', 'Meta+-', 'Meta+Subtract'],
    () => {
      applyCanvasZoom('out');
      return true;
    },
    canvasVisible,
  );
  bind(
    'canvas.zoomReset',
    ['Ctrl+0', 'Meta+0'],
    () => {
      applyCanvasZoom('reset');
      return true;
    },
    canvasVisible,
  );

  return bindings;
}

/** Виды, где вообще поддерживается копирование/вставка МЫСЛИ (ошибка
 *  00275531): карта и структуры. На Дневнике, Событиях и Публикациях мысль не
 *  копируется — Ctrl+C/V отдаются нативному копированию текста. */
function supportsThoughtCopy(): boolean {
  const view = store.state.activeView;
  return view === 'map' || view === 'structures';
}

/** Холст карты реально виден И доступен для взаимодействия (ошибки 63967c21,
 *  1a3a476e): рабочий стол, вид «Карта» и ни одного перекрытия поверх холста.
 *  Перекрытия — ровно те, что накрывают холст в `screens/workspace.ts`: сеть без
 *  доступа (`.workspace-placeholder`, `inaccessibleTabIds`) и панель выбора сети
 *  (`.workspace-picker`, `pickerOpen`); оба — `position: absolute; inset: 0`
 *  с непрозрачным фоном, то есть холст под ними не виден. Плюс открытый
 *  модальный диалог (`hasOpenDialog`): его подложка `.dialog-backdrop`
 *  полупрозрачна — холст «виден», но взаимодействие модально заблокировано,
 *  поэтому команды масштаба обязаны молчать (ошибка 1a3a476e). Раскладка холст
 *  не скрывает: позиция редактора его только сужает, доли зон (`canvas_layout`) —
 *  внутренние границы. Команды масштаба не должны срабатывать «невидимо» —
 *  тот же класс, что ошибка 00275531 (команда по состоянию чужого вида). */
function canvasVisible(): boolean {
  const st = store.state;
  if (st.screen !== 'workspace' || st.activeView !== 'map') return false;
  if (st.pickerOpen) return false;
  if (hasOpenDialog()) return false;
  const tabId = st.activeTabId;
  return !(tabId !== null && st.inaccessibleTabIds.has(tabId));
}

/** Цель Ctrl+C: на карте — курсор/фокус холста, в структурах — выделенная на
 *  экране мысль (источник вида {@link screenThoughtSource}), иначе `null`. */
function currentThoughtCopyTarget(): string | null {
  const view = store.state.activeView;
  return resolveThoughtCopyTarget({
    view,
    screenId: screenThoughtSource(view)?.() ?? null,
    cursorId: getCanvasCursor(),
    focusId: store.state.focus?.focused.id ?? null,
  });
}

/** Цель Ctrl+V: на карте — прежнее правило (одноэлементное выделение → курсор →
 *  фокус), в структурах — выделенная на экране мысль, иначе `null`. */
function currentThoughtPasteTarget(): string | null {
  const view = store.state.activeView;
  if (view !== 'map') return screenThoughtSource(view)?.() ?? null;
  const selection = store.state.selection;
  if (selection.length === 1 && selection[0] !== undefined) return selection[0];
  if (selection.length === 0) return getCanvasCursor() ?? store.state.focus?.focused.id ?? null;
  return store.state.focus?.focused.id ?? null;
}

/** Ctrl+C: copy the thought under the dashed cursor frame on the canvas, or —
 *  when no cursor is active — the focused thought. The cursor is updated
 *  synchronously by the cloud click handler, while `store.state.focus.focused`
 *  is only refreshed when `setFocus` runs (single-click only sets
 *  `editorTarget`), so the cursor is the reliable "what the user actually
 *  clicked" signal.
 *
 *  The selection panel is NEVER a source for Ctrl+C (bug 627a0822: with a
 *  non-empty panel the shortcut used to copy the whole panel instead of the
 *  clicked thought, and a later Ctrl+V in a comment editor pasted references
 *  to every panel thought). Copying the panel's thoughts is available only
 *  through the «Скопировать мысли» command of the panel's «Действия» menu —
 *  deliberately without a hotkey. Every thought copy also mirrors the copied
 *  thoughts' wiki-links into the system clipboard (bug 290a50c0). Always
 *  returns a visible notice — silent failures (no focus, fetch error) were
 *  reported as "Ctrl+C does nothing at all" and the user had no way to tell
 *  whether the handler even fired. */
async function globalCopy(targetId: string | null): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  if (targetId === null) {
    notice(
      'Не выбрана мысль для копирования. Выделите мысль на карте или в структурах.',
      'error',
    );
    return;
  }
  const { buildSingleThoughtSnapshot } = await import('./canvas/clipboard.js');
  try {
    const thought = await etn.thoughts.get(networkId, targetId);
    const { makeSelectionSnapshotDeps } = await import('./selection/selection.js');
    await buildSingleThoughtSnapshot(thought, makeSelectionSnapshotDeps(networkId));
    notice(`Скопировано: «${thought.title}»`);
  } catch (err) {
    errorDialog('Копировать', err);
  }
}

/** Ctrl+V: paste the clipboard under the cloud with the dashed cursor frame
 *  on the canvas, or read the system clipboard's text and apply the "paste
 *  text into cloud" rules. Same cursor-over-focus rule as `globalCopy`: the
 *  cursor is the click-synchronous "where does the new content go" signal,
 *  while the editor focus may still point at a previously focused thought.
 *  With multiple thoughts selected we fall back to the canvas focus. */
async function globalPaste(targetId: string | null): Promise<void> {
  if (targetId === null) {
    notice(
      'Не выбрана мысль для вставки. Кликните на мысль на карте или выделите её.',
      'error',
    );
    return;
  }
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const { pasteThoughtsTo, hasClipboard, pasteTextToCloud, systemClipboardHasThoughts } =
    await import('./canvas/clipboard.js');
  // Bug 290a50c0: the internal snapshot is only valid while the system
  // clipboard still holds the wiki-links our copy wrote there. When another
  // program (or a native text copy) has overwritten the buffer since, the
  // snapshot is stale — paste the system text by the §4.3.4 rules instead,
  // exactly as when there is no snapshot at all.
  if (hasClipboard() && (await systemClipboardHasThoughts())) {
    await pasteThoughtsTo(targetId);
    scheduleRefresh(LOCAL_CAUSE);
    return;
  }
  // Snapshot absent or stale — the system clipboard text wins (paste into
  // cloud by the §4.3.4 text rules).
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim() === '') return;
    await pasteTextToCloud(text, targetId);
    scheduleRefresh(LOCAL_CAUSE);
  } catch (err) {
    // Clipboard read denied or unavailable — surface the error so the user
    // isn't left wondering why nothing happened.
    notice(`Не удалось прочитать системный буфер: ${errText(err)}`, 'error');
  }
}

/** Test seam: the global Ctrl+C handler and its target resolver. Guards the
 *  regression of bug 627a0822 — Ctrl+C must copy the cursor/focus thought even
 *  while the selection panel holds thoughts, never the panel's contents — and
 *  of bug 00275531 — on the structures screen it copies the screen selection.
 *  `globalKeyBindings` + `canvasVisible` guard bug 63967c21 — the canvas zoom
 *  commands must not fire while the canvas is hidden (another view or an
 *  opaque overlay). */
export const appInternals = {
  globalCopy,
  currentThoughtCopyTarget,
  canvasVisible,
  globalKeyBindings,
  /** Окно локального дебаунса `scheduleRefresh` (read-only для тестов). */
  refreshDebounceMs: REFRESH_DEBOUNCE_MS,
};
