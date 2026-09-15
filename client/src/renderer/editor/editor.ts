/**
 * Editor shell (H8–H12, 08-ui-spec.md §6): header + tabs (L7).
 *
 * H8 ships the shell and the header:
 *  - position switcher (left/right/top/bottom/hidden → L4 `editor_position`);
 *  - thought header (3 строки, задача 8ab775d9): иконка/заголовок, синонимы,
 *    тип ▾ + «актуально» + подменю «Действия» + «Настройки мысли» ⚙; все правки
 *    сохраняются через `thoughts.update` с `If-Match`;
 *  - link header (when a link is picked): type + active via `links.update`.
 *
 * L7 turns the group stack below the header into tabs (08-ui-spec.md §6.3):
 * «Основное», «Свойства», «Вложения (N)», «Упоминания», «Хроника (N)»,
 * «Граф», «Метаданные». A tab's content is built lazily on first activation and
 * cached for the lifetime of one editor render (a signature change rebuilds
 * everything). The active tab survives focus changes (persisted to L4
 * `UI_STATE_KEY.EDITOR_ACTIVE_TAB`). Modules register tab content builders
 * (`registerTabContent`), tab badge counters (`registerTabCount`) and
 * «Основное» sections (`registerMainSection` — без обёртки-группы: секция
 * выводится на всю высоту вкладки).
 *
 * Если все табы не помещаются по ширине — справа появляется кнопка `▾N`,
 * открывающая выпадающий список со скрытыми табами (повторное использование
 * overflow-логики из `screens/tabs/tab-overflow.ts`).
 */

import {
  EtnError,
  UI_STATE_KEY,
  type Link,
  type LinkUpdateInput,
  type Thought,
  type ThoughtUpdateInput,
} from '@etn/shared';

import { refreshFocus, requireNetworkId, scheduleRefresh } from '../app.js';
import {
  applyThoughtIcon,
  invalidateIndicators,
  invalidateRef,
  resolveCloudStyle,
} from '../canvas/canvas.js';
import { setLinkSettingsOpener } from '../canvas/context-menu.js';
import { setLinkEditorOpener } from '../canvas/links.js';
import { noteThoughtWillOpen } from '../history.js';
import { inNeighbourhood } from '../realtime-ui.js';
import { invalidateHistoryBar } from '../screens/history-bar.js';
import { invalidatePinnedBar, invalidatePinnedRef } from '../screens/pinned-bar.js';
import { scheduleStructuresRefresh } from '../screens/structures/structures.js';
import {
  canSave,
  clearDraft,
  clearDraftsFor,
  findDraft,
  offlineNotice,
  saveDraft,
} from '../drafts.js';
import { button, clear, div, el, errText, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { svgIcon } from '../lib/icons.js';
import { showMenuAt, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { logUiEvent } from '../lib/ui-log.js';
import { createTypeCombobox } from '../lib/type-combobox.js';
import { linkTypeOptions, resolveLinkTypeVisual, thoughtTypeOptions } from '../lib/type-tree.js';
import { patchFocusEdge, store } from '../state.js';
import { groupSection, setCollapseChangeHandler, type GroupSpec } from './group.js';
import { rowSplitter } from './splitter.js';
import { setClampRoot } from './list-heights.js';
import { registerCommentSections } from './comments.js';
import { registerAttachmentsTab } from './attachments.js';
import { registerPropertiesGroup } from './properties.js';
import { registerLinksTab } from './links-tab.js';
import { registerGraphTab } from './graph-tab.js';
import { registerMetadataTab } from './metadata-tab.js';
import {
  buildOverflowButton,
  recomputeOverflow,
  type StripElements,
} from '../screens/tabs/tab-overflow.js';
import { showIconDialog, type IconPickResult } from './icon-dialog.js';
import { editMarkdownField } from './markdown-field.js';
import { showLinkStyleDialog, showThoughtStyleDialog } from './style-dialog.js';
import { showLinkTypeEditor, showThoughtTypeEditor } from '../screens/type-manager.js';
import { applyCommentTemplateIfEmpty } from '../lib/comment-template.js';
import {
  acquireOrShowBlocked,
  lockHandleFromOutcome,
  releaseHeld,
  type LockHandle,
} from '../lib/lock-guard.js';

/** What the editor currently edits. */
export interface EditorContext {
  ownerType: 'thought' | 'link';
  ownerId: string;
  thought: Thought | null;
  link: Link | null;
}

/** Editor tab ids (08-ui-spec.md §6.3, задача 8ab775d9). */
export type EditorTabId =
  | 'main'
  | 'properties'
  | 'attachments'
  | 'links'
  | 'chrono'
  | 'graph'
  | 'metadata';

/** Builds the content of one tab for the current entity. */
export type TabContentBuilder = (ctx: EditorContext) => HTMLElement;

/** Resolves a tab's `(N)` badge count for the current entity. */
export type TabCountLoader = (ctx: EditorContext) => Promise<number | undefined>;

/** Builds one collapsible group of the «Основное» tab (or null to skip). */
export type MainSectionBuilder = (ctx: EditorContext) => GroupSpec | null;

/** Static tab bar definition; badges come from registered count loaders. */
const TABS: Array<{ id: EditorTabId; title: string; counted: boolean }> = [
  { id: 'main', title: 'Основное', counted: false },
  { id: 'properties', title: 'Свойства', counted: false },
  { id: 'attachments', title: 'Вложения', counted: true },
  { id: 'links', title: 'Упоминания', counted: false },
  { id: 'chrono', title: 'Хроника', counted: true },
  { id: 'graph', title: 'Граф', counted: false },
  { id: 'metadata', title: 'Метаданные', counted: false },
];

/** Ширины по умолчанию/минимум для overflow-раскладки вкладок редактора. */
const EDITOR_TAB_W_DEFAULT_PX = 110;
const EDITOR_TAB_W_MIN_PX = 80;

const tabContentBuilders = new Map<EditorTabId, TabContentBuilder>();
const tabCountLoaders = new Map<EditorTabId, TabCountLoader>();
const mainSectionBuilders: MainSectionBuilder[] = [];

/** The active tab — module-level so it survives focus/entity changes (L7).
 *  Initial value is loaded from the persisted L4 `EDITOR_ACTIVE_TAB` slot
 *  (задача 8ab775d9), so reopening the editor restores the same tab the
 *  user was on. The module-level shadow stays in sync with `persistActiveTab`. */
let activeTab: EditorTabId = 'main';
let activeTabLoaded = false;

/** Loads the persisted active tab id once. Safe to call repeatedly. */
async function loadActiveTab(): Promise<void> {
  if (activeTabLoaded) return;
  activeTabLoaded = true;
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    const raw = await etn.ui.getState(networkId, UI_STATE_KEY.EDITOR_ACTIVE_TAB);
    if (typeof raw === 'string' && (TABS.find((t) => t.id === raw) ?? null) !== null) {
      activeTab = raw as EditorTabId;
    }
  } catch {
    // Ошибка чтения (нет сети, нет значения) — оставляем дефолт 'main'.
  }
}

let persistActiveTabTimer: number | null = null;
/** Persists the active tab id to the local DB (debounced). */
function persistActiveTab(): void {
  if (persistActiveTabTimer !== null) window.clearTimeout(persistActiveTabTimer);
  persistActiveTabTimer = window.setTimeout(() => {
    persistActiveTabTimer = null;
    const networkId = store.state.networkId;
    if (networkId === null) return;
    void etn.ui
      .setState(networkId, UI_STATE_KEY.EDITOR_ACTIVE_TAB, activeTab)
      .catch(() => undefined);
  }, 200);
}

/** Registers a tab content builder (L7). */
export function registerTabContent(id: EditorTabId, builder: TabContentBuilder): void {
  tabContentBuilders.set(id, builder);
}

/** Registers a tab badge counter (L7). */
export function registerTabCount(id: EditorTabId, loader: TabCountLoader): void {
  tabCountLoaders.set(id, loader);
}

/** Registers a collapsible section of the «Основное» tab (L7). */
export function registerMainSection(builder: MainSectionBuilder): void {
  mainSectionBuilders.push(builder);
} /** Opens a link in the editor without changing the focus (H6/H11). */
export function openLinkInEditor(link: Link): void {
  logUiEvent('ui.editor.opened', { id: link.id, kind: 'link' });
  store.update({ editorTarget: { kind: 'link', id: link.id, link } });
}

/**
 * Opens a thought in the editor without changing the canvas focus (§2.2.4 —
 * a single cloud click / Enter). The editor target switches at once; the full
 * entity rides along as soon as it loads — until then the editor falls back to
 * the focused thought (same mechanism as the structures/chronicle views). The
 * focused thought itself needs no target (editorTarget=null → follow focus).
 *
 * Bug fix (editor shaking on a repeat click of the same thought): this used
 * to unconditionally overwrite `editorTarget` — even when the click landed on
 * the thought already shown in the editor. Re-assigning `{ kind: 'thought',
 * id }` drops the already-loaded `thought` payload, so `render()`'s signature
 * (which reads `ctx.thought?.version`) changes and forces a full DOM rebuild
 * with stale/fallback content; the redundant `etn.thoughts.get` refetch then
 * resolves and forces a second rebuild once the entity comes back — two
 * visible re-renders back to back for a click that changed nothing. A repeat
 * click on the thought already targeted (loaded or still in flight) is now a
 * no-op: same for re-clicking the focused thought while the editor already
 * follows the focus.
 */
export function openThoughtInEditor(id: string): void {
  const focusId = store.state.focus?.focused.id ?? null;
  if (id === focusId) {
    if (
      store.state.editorTarget === null &&
      store.state.selectedLinkId === null &&
      store.state.structuresActiveThoughtId === null
    ) {
      return;
    }
    // Following the focus again: the halo/current-thought pointer is the
    // focus itself everywhere — drop the (possibly stale) override so
    // structures/chronicle screens stop highlighting a thought that is no
    // longer "current" (task «Переделать историю посещения мыслей»).
    store.update({
      editorTarget: null,
      selectedLinkId: null,
      structuresActiveThoughtId: null,
      structuresActiveThought: null,
    });
    return;
  }
  const current = store.state.editorTarget;
  if (current !== null && current.kind === 'thought' && current.id === id) {
    if (store.state.selectedLinkId !== null) store.update({ selectedLinkId: null });
    return;
  }
  // Visit history (0.5.5): the thought that WAS current leaves for the front
  // of the unified history now — must run before the store update below, on
  // the pre-change state. Fire-and-forget here (this call site is
  // synchronous, unlike `setFocus`) — the history panel re-renders once the
  // write lands (`setHistoryChangeListener`).
  void noteThoughtWillOpen(id);
  logUiEvent('ui.editor.opened', { id, kind: 'thought' });
  store.update({
    editorTarget: { kind: 'thought', id },
    selectedLinkId: null,
    // Cross-screen halo (task requirement): any screen that opens a thought
    // becomes the source of truth for "current thought" everywhere — the
    // structures/chronicle views read these same fields for their own halo.
    structuresActiveThoughtId: id,
    structuresActiveThought: null,
  });
  const networkId = store.state.networkId;
  if (networkId === null) return;
  void etn.thoughts
    .get(networkId, id)
    .then((thought) => {
      const target = store.state.editorTarget;
      if (target?.kind === 'thought' && target.id === id) {
        store.update({ editorTarget: { kind: 'thought', id, thought }, structuresActiveThought: thought });
      }
    })
    .catch(() => undefined);
}

/**
 * Applies an already-fetched thought as the editor target from the
 * structures/chronicle views (which do their own fetch to keep their
 * existing error notices — 08-ui-spec.md §15.7/§17) and records it in the
 * unified visit history. Mirrors what {@link openThoughtInEditor} does for
 * the canvas, so every screen feeds the same "current thought" state.
 */
export async function setThoughtEditorTarget(thought: Thought): Promise<void> {
  await noteThoughtWillOpen(thought.id);
  logUiEvent('ui.editor.opened', { id: thought.id, kind: 'thought' });
  store.update({
    editorTarget: { kind: 'thought', id: thought.id, thought },
    structuresActiveThought: thought,
    structuresActiveThoughtId: thought.id,
    selectedLinkId: null,
  });
}

/** Current editor context: a picked thought/link, else the focused thought. */
export function currentEditorContext(): EditorContext | null {
  const target = store.state.editorTarget;
  if (target !== null && target.kind === 'link') {
    return { ownerType: 'link', ownerId: target.id, thought: null, link: target.link };
  }
  if (target !== null && target.kind === 'thought') {
    // Opened by a canvas click/Enter: the entity rides in the target itself.
    if (target.thought !== undefined) {
      return { ownerType: 'thought', ownerId: target.id, thought: target.thought, link: null };
    }
    // Opened from the structures view (L15): the full entity rides along in
    // the store; until it arrives the editor shows a loading placeholder.
    const thought = store.state.structuresActiveThought;
    if (thought !== null && thought.id === target.id) {
      return { ownerType: 'thought', ownerId: target.id, thought, link: null };
    }
    // Neither payload has arrived yet (etn.thoughts.get / structures fetch in
    // flight): a loading placeholder for the *target* thought, not a fallback
    // to the focused thought — falling back here used to flash the focused
    // thought's content for a frame before the real payload replaced it.
    return { ownerType: 'thought', ownerId: target.id, thought: null, link: null };
  }
  const focus = store.state.focus;
  if (focus === null) return null;
  return { ownerType: 'thought', ownerId: focus.focused.id, thought: focus.focused, link: null };
}

/** Persists the collapsed-groups map to the local DB (debounced). */
let persistTimer: number | null = null;
function persistCollapsed(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    const networkId = store.state.networkId;
    if (networkId === null) return;
    void etn.ui
      .setState(
        networkId,
        UI_STATE_KEY.EDITOR_COLLAPSED_GROUPS,
        JSON.stringify(store.state.collapsedGroups),
      )
      .catch(() => undefined);
  }, 300);
}

let host: HTMLElement | null = null;
let scrollBox: HTMLElement | null = null;
let positionButton: HTMLButtonElement | null = null;
let titleEl: HTMLElement | null = null;
let lastSignature = '';

/**
 * Identity part of the render signature (bug 6b757336): `ownerType|ownerId|
 * editorPosition`, without the version. A full DOM rebuild (`renderFull`) is
 * only warranted when this changes — a different entity/dock, not merely a
 * new version of the SAME entity. Kept separate from `lastSignature` (which
 * still includes the version, guarding the early "nothing changed at all"
 * exit) so a version-only change can take the cheaper `patchHeader` path.
 */
let lastIdentitySignature = '';

/**
 * Live DOM handles of the current render, kept at module scope (not local to
 * `render()`) so `patchHeader` can replace just the header and leave the tab
 * bar / pane cache alone on a version-only change of the same entity. Reset
 * on every full rebuild.
 */
let headerEl: HTMLElement | null = null;
let tabBarEl: HTMLElement | null = null;
let paneHostEl: HTMLElement | null = null;
let tabButtons = new Map<EditorTabId, HTMLButtonElement>();
let builtPanes = new Map<EditorTabId, HTMLElement>();

/**
 * Guards the one-time module registrations (sections, tabs, the document
 * listener). `mountEditor` runs again on every network open — `showScreen`
 * rebuilds the whole workspace — and re-registering would append duplicate
 * «Основное» sections («Свойства», «Комментарий») for each open.
 */
let registrationsDone = false;

/** Unsubscribes the store subscription of the previous editor mount. */
let storeUnsubscribe: (() => void) | null = null;
/**
 * Cache of the last (open entity id + layer + version) for the cheap
 * store-subscribe gate in `mountEditor`. Compared against the live
 * `currentEditorContext()` and `store.state.currentLayer` — when all three
 * match, the store update is for canvas-only state and the editor is left
 * alone (bug 206e33a1 «Бессмысленное обновление редактора при получении
 * внешних событий»). The `layerId` leg matters on its own: a layer switch
 * must re-render even when the focused thought is the same id+version in
 * both layers — its properties can differ through shadow overrides, and
 * ETN error dc4e0c07 made the editor keep the old layer's header + a
 * raw 404 in the property list. The render signature guard is still the
 * authoritative filter for an actual rebuild.
 */
let liveRenderedKey: {
  ownerId: string;
  layerId: string | null;
  version: string | number;
} | null = null;

/** Badge spans of the current render, per counted tab (for refreshTabCount). */
const tabCountSpans = new Map<EditorTabId, HTMLElement>();
/** The context of the current render (for refreshTabCount). */
let renderCtx: EditorContext | null = null;

/**
 * Re-resolves one tab's badge count after an in-tab mutation (e.g. an
 * attachment was added) and updates the tab title at once.
 */
export function refreshTabCount(id: EditorTabId): void {
  const badge = tabCountSpans.get(id);
  const loader = tabCountLoaders.get(id);
  if (badge === undefined || loader === undefined || renderCtx === null) return;
  void Promise.resolve(loader(renderCtx)).then((n) => {
    if (n !== undefined) badge.textContent = `(${n})`;
  });
}

/** Mounts the editor into the workspace editor host. */
export function mountEditor(editorHost: HTMLElement): void {
  host = editorHost;
  host.replaceChildren();

  const header = div('editor-header');
  titleEl = span('', 'editor-title');
  positionButton = button('', () => void openPositionMenu(), 'btn small');
  positionButton.append(svgIcon('chevron-down', 12));
  setTooltip(positionButton, 'Положение редактора');
  header.append(titleEl, positionButton);
  scrollBox = div('editor-scroll');
  // Carries the saved list max-heights as --clamp-* variables (ee745368).
  setClampRoot(scrollBox);
  host.append(header, scrollBox);

  // `mountEditor` re-runs on every network open (`showScreen` rebuilds the
  // whole workspace) and replaces `scrollBox` with a brand-new element every
  // time. The module-level DOM handles `patchHeader` relies on (`headerEl` /
  // `tabBarEl` / `paneHostEl`) would otherwise still point at nodes belonging
  // to the PREVIOUS `scrollBox` — if the next render happens to compute the
  // same identity signature as before the remount, `canPatch` could try to
  // `replaceChild` a node that is not a child of the new `scrollBox`
  // (bug 6b757336 fix). Resetting them — and the signatures that gate the
  // patch path — guarantees the first `render()` after any mount always takes
  // the full-rebuild branch, which populates them fresh.
  headerEl = null;
  tabBarEl = null;
  paneHostEl = null;
  tabButtons = new Map();
  builtPanes = new Map();
  lastSignature = '';
  lastIdentitySignature = '';

  // The collapse state is global per group id (ee745368): it survives entity
  // changes and restarts, so switching to another thought does not restore
  // the default expansion of a group the user collapsed.
  setCollapseChangeHandler((groupId, collapsed) => {
    store.update({
      collapsedGroups: { ...store.state.collapsedGroups, [groupId]: collapsed },
    });
    persistCollapsed();
  });

  // Clicking a link line on the canvas opens the link here (H6 ↔ H8) and marks
  // it as the sticky canvas selection.
  setLinkEditorOpener((link) => {
    store.update({ editorTarget: { kind: 'link', id: link.id, link }, selectedLinkId: link.id });
  });

  // The link context menu ("Изменить свойства") opens the same settings dialog
  // as the editor's ⚙ button.
  setLinkSettingsOpener(openLinkSettings);

  // Editor sections and tabs (H9–H12, L7). Registered once: mountEditor runs
  // again per network open, and the section registry is an append-only list.
  if (!registrationsDone) {
    registrationsDone = true;
    registerPropertiesGroup();
    registerCommentSections();
    registerAttachmentsTab();
    registerLinksTab();
    registerGraphTab();
    registerMetadataTab();

    // Pasted-image uploads from any markdown field re-count the «Вложения» tab
    // badge right away (the tab's own list reloads itself via the same event;
    // see attachments.ts). Without this the badge showed a stale 0 until the
    // editor target changed. One document listener for the app lifetime.
    document.addEventListener('etn:attachments-changed', (event) => {
      const detail = (event as CustomEvent<{ ownerType: string; ownerId: string }>).detail;
      const ctx = renderCtx;
      if (ctx !== null && detail?.ownerType === ctx.ownerType && detail?.ownerId === ctx.ownerId) {
        refreshTabCount('attachments');
      }
    });
  }

  // Re-mounting replaces the host — drop the previous mount's subscription
  // before adding the new one (mountEditor runs again per network open).
  storeUnsubscribe?.();
  // Cheap store gate (bug 206e33a1): the editor's open entity didn't change,
  // so the store update is for canvas-only state (focus edges, indicators,
  // pin list, structures/chronicle tabs etc.) that have their own
  // subscriptions. Skip the `render()` call entirely — `render()`'s
  // signature guard would also no-op, but reading `currentEditorContext()`
  // and computing the key on every store tick is wasted work.
  storeUnsubscribe = store.subscribe(() => {
    if (host?.isConnected !== true) return;
    const ctx = currentEditorContext();
    if (ctx === null) {
      // No target: nothing to compare against — defer to render()'s own
      // signature guard (it also handles the null→null fast path).
      void render();
      return;
    }
    const liveVersion = ctx.ownerType === 'thought' ? ctx.thought?.version : ctx.link?.version;
    const liveLayerId = store.state.currentLayer?.id ?? null;
    if (
      liveRenderedKey !== null &&
      liveRenderedKey.ownerId === ctx.ownerId &&
      liveRenderedKey.layerId === liveLayerId &&
      liveRenderedKey.version === (liveVersion ?? '')
    ) {
      return;
    }
    void render();
  });
  // Restore the persisted active tab id (задача 8ab775d9) before the first
  // render so the user lands on the tab they left on, not always «Основное».
  void loadActiveTab().then(() => {
    if (host?.isConnected === true && paneHostEl !== null) {
      activateEditorTab(activeTab);
    }
  });
  void render();
}

/**
 * Builds one tab's pane content against the CURRENT `renderCtx` (not a
 * closure-captured one — `invalidateMainPane` may rebuild the «Основное» pane
 * from a `patchHeader` call that ran after the original full render, when a
 * newer `ctx` is already current).
 */
function buildTabPane(id: EditorTabId): HTMLElement {
  const ctx = renderCtx;
  const pane = div('tab-pane fixed');
  if (ctx === null) return pane;
  if (id === 'main') {
    // Структура вкладки (задача 8ab775d9): в «Основное» живёт постоянный
    // комментарий мысли на всю высоту вкладки, без обёртки-группы. Свойства
    // переехали в отдельную вкладку «Свойства». Если когда-то здесь снова
    // зарегистрируют верхние секции (как было до 0.8.1), вернётся прежняя
    // компоновка «top + splitter + bottom»; сейчас — одиночная секция
    // (комментарий) на всю высоту.
    const specs = mainSectionBuilders
      .map((section) => section(ctx))
      .filter((spec): spec is GroupSpec => spec !== null);
    if (specs.length === 0) {
      pane.append(el('p', 'muted', 'Нет содержимого.'));
      return pane;
    }
    if (specs.length === 1) {
      // Одиночная секция (постоянный комментарий) занимает всю высоту
      // вкладки напрямую — без сворачиваемой группы и её шапки. Обёртка
      // `main-full` обеспечивает flex-растяжение и собственную прокрутку
      // содержимого.
      const wrap = div('main-full');
      const body = specs[0]!.buildBody();
      if (body instanceof Promise) {
        void body.then((el) => wrap.append(el));
      } else {
        wrap.append(body);
      }
      pane.append(wrap);
      return pane;
    }
    const topSpecs = specs.slice(0, -1);
    const bottomSpec = specs[specs.length - 1]!;
    let top: HTMLElement | null = null;
    for (const spec of topSpecs) {
      top = groupSection(spec);
      top.classList.add('tab-top');
      pane.append(top);
    }
    if (top !== null) {
      // Resizes the top group's scrollable table (`.prop-wrap`); inert when
      // the group is collapsed (no body at all, §6.3). The drag is
      // remembered as the table's fixed height (bug 6b757336, ee745368,
      // list-heights.ts).
      const topEl = top;
      pane.append(
        rowSplitter(
          () => topEl.querySelector('.prop-wrap') ?? topEl.querySelector('.group-body'),
          { min: 34, persistKey: 'props' },
        ),
      );
    }
    const bottom = div('main-bottom');
    bottom.append(groupSection(bottomSpec));
    pane.append(bottom);
    return pane;
  }
  const builder = tabContentBuilders.get(id);
  pane.append(builder !== undefined ? builder(ctx) : el('p', 'muted', 'Нет содержимого.'));
  return pane;
}

/** Activates a tab: (re)builds its pane on first activation, caches it after. */
function activateEditorTab(id: EditorTabId): void {
  if (paneHostEl === null) return;
  const changed = activeTab !== id;
  activeTab = id;
  for (const [tabId, tab] of tabButtons) {
    tab.classList.toggle('active', tabId === id);
  }
  let pane = builtPanes.get(id);
  if (pane === undefined) {
    pane = buildTabPane(id);
    builtPanes.set(id, pane);
  }
  paneHostEl.replaceChildren(pane);
  if (changed) persistActiveTab();
}

/**
 * Drops the cached «Основное» pane so it rebuilds from the current `ctx` on
 * next activation (bug 6b757336): a thought's type change can add/remove
 * properties, so the cached properties+comment pane can no longer be trusted
 * as-is. If «Основное» is the active tab this rebuilds it right away — the
 * comment's CodeMirror instance is destroyed in that case, same as before
 * this fix, but only for an actual type change, not for every header save.
 */
function invalidateMainPane(): void {
  builtPanes.delete('main');
  if (activeTab === 'main') activateEditorTab('main');
}

/** Updates the panel title text + trash marker for the current context. */
function updateTitleEl(ctx: EditorContext | null): void {
  if (titleEl === null) return;
  clear(titleEl);
  if (ctx !== null && ctx.ownerType === 'thought' && ctx.thought?.marked_for_deletion === true) {
    const mark = span('', 'editor-trash-mark');
    mark.append(svgIcon('trash', 14));
    setTooltip(mark, 'Мысль находится в корзине');
    titleEl.append(mark);
  }
  titleEl.append(ctx === null ? '' : ctx.ownerType === 'link' ? 'Связь' : 'Мысль');
}

/**
 * Patches the editor for a version-only change of the SAME already-loaded
 * entity (bug 6b757336): replaces just the header — the small, cheap,
 * effectively stateless part — and leaves the tab bar, the pane cache and
 * their DOM (in particular the comment's CodeMirror instance, scroll
 * position and collapsed groups) untouched. Used when a header field save
 * (title/synonyms/type/icon/active/style) bumps `thought.version`/
 * `link.version` on the entity already open — previously this took the same
 * full-teardown path as switching to a different entity, visibly "flashing"
 * the whole editor for a one-field edit.
 */
function patchHeader(ctx: EditorContext): void {
  if (scrollBox === null || headerEl === null) return;
  // Body-mounted widgets (type-combobox dropdowns) anchored to the OLD header
  // nodes must close before those nodes are replaced — same reasoning as the
  // full rebuild below.
  window.dispatchEvent(new Event('etn:editor-rebuild'));

  const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const refocus = activeEl !== null && headerEl.contains(activeEl) ? activeEl : null;

  const prevCtx = renderCtx;
  renderCtx = ctx;
  updateTitleEl(ctx);

  const newHeader =
    ctx.ownerType === 'thought' && ctx.thought !== null
      ? buildThoughtHeader(ctx.thought)
      : ctx.ownerType === 'link' && ctx.link !== null
        ? buildLinkHeader(ctx.link)
        : null;
  if (newHeader === null) return; // guarded by the caller — kept for type-safety only
  scrollBox.replaceChild(newHeader, headerEl);
  headerEl = newHeader;

  if (refocus !== null) restoreEditorFocus(refocus, scrollBox);

  // A thought's type change can add/remove properties (and NULL visual
  // fields inherit new defaults) — the cached «Основное» pane must rebuild.
  // Every other header field (title/synonyms/icon/active/style) leaves the
  // property set and the comment untouched, so no pane invalidation.
  const typeChanged =
    ctx.ownerType === 'thought' &&
    prevCtx?.ownerType === 'thought' &&
    prevCtx.thought?.type_id !== ctx.thought?.type_id;
  if (typeChanged) invalidateMainPane();
}

/** Renders the editor for the current target (signature-guarded). */
async function render(): Promise<void> {
  if (host === null || scrollBox === null || positionButton === null) return;
  const ctx = currentEditorContext();

  // Two-part signature (bug 6b757336). `identitySignature` — the open entity
  // and dock — governs which path runs; `fullSignature` adds the version and
  // guards the "nothing changed at all" early exit that used to be the only
  // check here. The session's `currentLayer` is part of both signatures on
  // purpose (ETN error dc4e0c07): a layer switch must rebuild even when the
  // focused thought is the same id+version in both layers — its properties
  // can differ through shadow overrides, and the editor must not keep the
  // old layer's header + property cache.
  const layerId = store.state.currentLayer?.id ?? '';
  const identitySignature =
    ctx === null ? 'null' : `${ctx.ownerType}|${ctx.ownerId}|${store.state.editorPosition}|${layerId}`;
  const fullSignature =
    ctx === null
      ? 'null'
      : `${identitySignature}|${ctx.thought?.version ?? ''}|${ctx.link?.version ?? ''}`;
  if (fullSignature === lastSignature) return;

  // A version-only change of the SAME already-rendered, already-loaded
  // entity patches just the header (see `patchHeader`) instead of the full
  // teardown+rebuild below — that full rebuild remains a Bug 206e33a1
  // «Бессмысленное обновление редактора при получении внешних событий»
  // concern: it destroys the CodeMirror comment instance, so it must still
  // only run when the open entity itself changes (different id/kind, dock
  // move) or on the very first render of it (loading → loaded — `renderCtx`
  // below is the OLD, still-loading context in that case, so its own
  // `thought`/`link` is null and this correctly falls through to the full
  // rebuild instead of patching a header that was never really built for a
  // loaded entity). `headerEl`/`tabBarEl`/`paneHostEl` are reset to null by
  // `mountEditor` on every (re)mount, so they can only be non-null here when
  // they belong to the CURRENT `scrollBox` — no DOM containment check needed.
  const canPatch =
    ctx !== null &&
    identitySignature === lastIdentitySignature &&
    headerEl !== null &&
    tabBarEl !== null &&
    paneHostEl !== null &&
    ((ctx.ownerType === 'thought' && ctx.thought !== null && renderCtx?.ownerType === 'thought' && renderCtx.thought !== null) ||
      (ctx.ownerType === 'link' && ctx.link !== null && renderCtx?.ownerType === 'link' && renderCtx.link !== null));

  lastSignature = fullSignature;
  lastIdentitySignature = identitySignature;
  // Remember the live open entity so the cheap store-subscribe gate in
  // `mountEditor` can skip unrelated updates (canvas-only state, indicators,
  // pin list, etc.). Cleared here on every rebuild so the next store tick
  // re-reads the live context. The `layerId` leg is what makes a layer
  // switch force a rebuild (ETN error dc4e0c07) — same thought in two
  // layers is still a different render target for the editor.
  liveRenderedKey =
    ctx === null
      ? null
      : {
          ownerId: ctx.ownerId,
          layerId: store.state.currentLayer?.id ?? null,
          version:
            ctx.ownerType === 'thought'
              ? (ctx.thought?.version ?? '')
              : (ctx.link?.version ?? ''),
        };

  if (canPatch) {
    patchHeader(ctx);
    return;
  }

  // --- full teardown + rebuild (different entity, dock move, or first load) -

  // Panel title reflects what is selected (08-ui-spec.md §6.2). A thought in
  // the trash (S13) additionally shows the bright-red trash marker before the
  // word «Мысль» — the editor must state the trashed state explicitly, not
  // only the canvas badge.
  updateTitleEl(ctx);

  // Remember what had the focus: the rebuild destroys the old DOM, and a
  // field focused at that moment (e.g. the type picker reached by Tab from
  // the title) must get the focus back on the fresh render — otherwise the
  // caret is lost and its dropdown stays closed.
  const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const refocus = activeEl !== null && scrollBox.contains(activeEl) ? activeEl : null;

  // Body-mounted widgets (type-combobox dropdowns) must close before the old
  // DOM is destroyed — otherwise their fixed-position lists stay behind as
  // ghosts that neither Escape nor an outside click can dismiss (e.g. Tab
  // from an edited title into the type field opens the list, then a dock
  // move re-renders the editor).
  window.dispatchEvent(new Event('etn:editor-rebuild'));

  clear(scrollBox);
  tabCountSpans.clear();
  headerEl = null;
  tabBarEl = null;
  paneHostEl = null;
  tabButtons = new Map();
  builtPanes = new Map();
  renderCtx = ctx;

  if (ctx === null) {
    const empty = div('editor-empty');
    empty.textContent = 'Выберите мысль или связь.';
    scrollBox.append(empty);
    return;
  }

  if (ctx.ownerType === 'thought' && ctx.thought !== null) {
    headerEl = buildThoughtHeader(ctx.thought);
  } else if (ctx.ownerType === 'link' && ctx.link !== null) {
    headerEl = buildLinkHeader(ctx.link);
  } else if (ctx.ownerType === 'thought' && ctx.thought === null) {
    // The thought is the new editor target but its full entity has not
    // arrived yet (`etn.thoughts.get` in flight from a canvas click, a
    // structure pick or a deep link). The icon slot in the header shows
    // a preloader instead of the previous thought's icon, so a long load
    // (heavy thought with many properties / attachments / comments) is
    // visibly "in progress" rather than a misleading static icon. The
    // thought id sits in the title placeholder so the user sees which
    // card is loading.
    headerEl = buildThoughtHeaderLoading(ctx.ownerId);
  } else if (ctx.ownerType === 'link' && ctx.link === null) {
    headerEl = buildLinkHeaderLoading(ctx.ownerId);
  }
  if (headerEl !== null) scrollBox.append(headerEl);

  // --- tab bar (L7) ---------------------------------------------------------
  const tabBar = div('editor-tabs');
  tabBarEl = tabBar;
  for (const def of TABS) {
    const tab = el('button', 'editor-tab') as HTMLButtonElement;
    tab.type = 'button';
    tab.append(span(def.title, 'editor-tab-title'));
    if (def.counted) {
      const badge = span('', 'editor-tab-count hidden');
      tab.append(badge);
      tabCountSpans.set(def.id, badge);
      const loader = tabCountLoaders.get(def.id);
      if (loader !== undefined) {
        void Promise.resolve(loader(ctx)).then((n) => {
          if (n !== undefined && tab.isConnected) {
            badge.textContent = `(${n})`;
            badge.classList.remove('hidden');
          }
        });
      }
    }
    tab.addEventListener('click', () => activateEditorTab(def.id));
    tabButtons.set(def.id, tab);
    tabBar.append(tab);
  }

  // Кнопка `[▾N]` для табов, не поместившихся в строку. По умолчанию скрыта
  // через атрибут `hidden=true`; `recomputeOverflow` сбрасывает его, когда
  // что-то не влезает. CSS-класс `hidden` НЕ ставим — общий
  // `.hidden { display: none !important }` (styles.css) принудительно прячет
  // элемент по классу и перебивает `hidden=false`, из-за чего кнопка остаётся
  // невидимой даже когда `recomputeOverflow` уже решил её показать (баг
  // проявился в DevTools: `class="tab-overflow hidden" hidden=""` при
  // `textContent="▾3"`).
  const overflowBtn = el('button', 'tab-overflow') as HTMLButtonElement;
  overflowBtn.type = 'button';
  overflowBtn.hidden = true;
  tabBar.append(overflowBtn);

  // Следим за шириной контейнера: при ресайзе окна / панели переразмечаем
  // видимый набор и текст кнопки.
  const stripElements: StripElements<(typeof TABS)[number]> = {
    root: tabBar,
    visible: Array.from(tabButtons.values()),
    hidden: [],
    reserveButton: null,
    overflowButton: overflowBtn,
  };
  // Один раз вешаем обработчик клика через `buildOverflowButton` — он делает
  // `cloneNode + replaceWith`, после чего оригинальная нода отсоединена.
  // Дёргать его в observer нельзя: ссылка `overflowBtn` после первого вызова
  // указывает на отсоединённую ноду, второй вызов привязал бы обработчик к
  // невидимому клону. Observer ограничиваем только пересчётом раскладки —
  // `recomputeOverflow` сам обновляет видимость и текст `[▾N]`.
  const renderEditorOverflowRow = (item: (typeof TABS)[number], close: () => void): HTMLElement => {
    const row = el('div', 'tab-overflow-row');
    const label = el('span', 'tab-overflow-label', item.title);
    label.style.cursor = 'pointer';
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      activateEditorTab(item.id);
      close();
    });
    row.append(label);
    return row;
  };
  const reflowEditorOverflow = (): void => {
    recomputeOverflow(
      stripElements,
      EDITOR_TAB_W_DEFAULT_PX,
      EDITOR_TAB_W_MIN_PX,
      TABS,
    );
  };
  const overflowObserver = new ResizeObserver(reflowEditorOverflow);
  overflowObserver.observe(tabBar);
  // Первый маунт: `ResizeObserver` сработает только при изменении размера,
  // а табы могут уже не помещаться в момент открытия редактора. Прогоняем
  // разметку сразу, чтобы `▾N` появился без ресайза окна. `buildOverflowButton`
  // возвращает живую ноду-клона (исходная отсоединяется через replaceWith) —
  // сохраняем ссылку, чтобы последующие `recomputeOverflow` обновляли
  // именно DOM-кнопку.
  // Первый маунт: `ResizeObserver` сработает только при изменении размера,
  // а табы могут уже не помещаться в момент открытия редактора. Прогоняем
  // разметку сразу, чтобы `▾N` появился без ресайза окна. `buildOverflowButton`
  // возвращает живую ноду-клона (исходная отсоединяется через replaceWith) —
  // сохраняем ссылку, чтобы последующие `recomputeOverflow` обновляли
  // именно DOM-кнопку. Передаём getter `() => stripElements.hidden`, а не
  // сам массив: на момент первого вызова tabBar ещё не в DOM, `clientWidth=0`
  // → recomputeOverflow early-return → `hidden=[]`. ResizeObserver потом
  // заполнит `hidden` реальными элементами, и обработчик должен читать их
  // на момент клика, а не пустой снимок из замыкания.
  reflowEditorOverflow();
  stripElements.overflowButton = buildOverflowButton(
    overflowBtn,
    () => stripElements.hidden,
    renderEditorOverflowRow,
  );

  // --- tab panes (lazily built, cached for this render) ---------------------
  const paneHost = div('tab-pane-root');
  paneHostEl = paneHost;

  scrollBox.append(tabBar, paneHost);
  // Первый `reflowEditorOverflow` выше отработал на отсоединённой `tabBar`
  // (clientWidth=0 → early return). `ResizeObserver` должен вызвать свой
  // callback, когда `tabBar` получает реальный размер после append, но на
  // практике initial observe не всегда срабатывает синхронно в Electron —
  // гарантируем расчёт через `requestAnimationFrame`, иначе в узком окне
  // кнопка `▾N` появится с задержкой в кадр.
  requestAnimationFrame(reflowEditorOverflow);
  activateEditorTab(activeTab);

  if (refocus !== null) restoreEditorFocus(refocus, scrollBox);
}

/** Field classes the editor can refocus after a rebuild (specific, not generic). */
const REFOCUS_MARKERS = new Set([
  'editor-title-input',
  'synonyms-input',
  'type-combo-input',
  'editor-icon-box',
  'md-field-area',
  'chrono-meta-input',
]);

/** Re-focuses the freshly built field that had the focus before the rebuild. */
function restoreEditorFocus(prev: HTMLElement, root: HTMLElement): void {
  const marker = [...prev.classList].find((c) => REFOCUS_MARKERS.has(c));
  if (marker === undefined) return;
  // The header fields live outside the tab panes; tab content matches within
  // the (single) active pane so a links-tab combobox does not steal the focus
  // from the header one (and vice versa).
  const pane = prev.closest('.tab-pane');
  const scope = pane !== null ? (root.querySelector<HTMLElement>('.tab-pane') ?? root) : root;
  const next = scope.querySelector<HTMLElement>(`.${marker}`);
  if (next === null || next.isConnected === false) return;
  if (next.classList.contains('hidden')) return;
  next.focus();
}

/**
 * Moves the caret into the permanent-comment field of the «Основное» tab —
 * the continuation after a type created from the header type picker was
 * applied (карточка ETN «Быстрое создание типа из поля ввода»): the user
 * goes on writing the comment. Activates the tab and expands the collapsed
 * comment group if needed, waits for the field to mount (the editor
 * re-render rebuilds the comment section, whose fetch is asynchronous) and
 * switches it into edit mode — CodeMirror mounts focused with the caret at
 * the end.
 */
function focusEditorComment(): void {
  if (scrollBox === null) return;
  if (activeTab !== 'main') {
    // The first tab button is «Основное» — click reuses the regular lazy
    // pane activation instead of duplicating it here (synchronous: by the
    // next line the main pane is the active one).
    const tab = scrollBox.querySelector<HTMLButtonElement>('.editor-tab');
    if (tab === null) return;
    tab.click();
  }
  // The comment group is the bottom section of the tab; when the user has it
  // collapsed, expand it (a click on the header toggles — only click when
  // the persisted state says it is collapsed).
  if (store.state.collapsedGroups['permanent'] === true) {
    scrollBox.querySelector<HTMLElement>('.main-bottom .group > .group-header')?.click();
  }
  const deadline = Date.now() + 5000;
  const tick = (): void => {
    const field = scrollBox?.querySelector<HTMLElement>('.comment-permanent .md-field') ?? null;
    if (field === null || field.isConnected === false) {
      // Still loading (or a rebuild raced us) — keep waiting a bit.
      if (Date.now() < deadline) window.setTimeout(tick, 50);
      return;
    }
    editMarkdownField(field);
  };
  window.setTimeout(tick, 0);
}

// ---------------------------------------------------------------------------
// Position switcher
// ---------------------------------------------------------------------------

/** Opens the editor position dropdown. */
async function openPositionMenu(): Promise<void> {
  if (positionButton === null) return;
  const positions: Array<{ value: 'left' | 'right' | 'top' | 'bottom' | 'hidden'; label: string }> =
    [
      { value: 'right', label: 'Справа' },
      { value: 'left', label: 'Слева' },
      { value: 'top', label: 'Сверху' },
      { value: 'bottom', label: 'Снизу' },
      { value: 'hidden', label: 'Скрыть' },
    ];
  const items: MenuItem[] = positions.map((p) => ({
    label: p.label,
    checked: store.state.editorPosition === p.value,
    onClick: () => void setEditorPosition(p.value),
  }));
  const rect = positionButton.getBoundingClientRect();
  showMenuAt(rect.right - 140, rect.bottom + 4, items);
}

/** Sets the editor position and persists it (L4). */
export async function setEditorPosition(
  position: 'left' | 'right' | 'top' | 'bottom' | 'hidden',
): Promise<void> {
  // Remember the last *visible* dock so un-hiding the editor restores it.
  if (position === 'hidden') {
    store.update({ editorPosition: 'hidden' });
  } else {
    store.update({ editorPosition: position, lastEditorPosition: position });
  }
  const networkId = store.state.networkId;
  if (networkId !== null) {
    await etn.ui.setState(networkId, UI_STATE_KEY.EDITOR_POSITION, position).catch(() => undefined);
  }
}

/**
 * Toggles the editor visibility: shows it at its last dock when hidden, or hides
 * it when visible. Backed by the toolbar "View" menu — the only way back once
 * the editor (and its own header dropdown) is hidden.
 */
export async function toggleEditorVisibility(): Promise<void> {
  if (store.state.editorPosition === 'hidden') {
    await setEditorPosition(store.state.lastEditorPosition);
  } else {
    await setEditorPosition('hidden');
  }
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/** True when the error is an `If-Match` version conflict. */
function isVersionConflict(err: unknown): boolean {
  return err instanceof EtnError && err.code === 'VERSION_CONFLICT';
}

/**
 * Reflects a successfully updated thought in every place it may currently be
 * shown: the canvas focus cloud / zone clouds, the editor (the focus follower
 * or a picked target), the structures results list, the pinned bar and the
 * history bar. The server never echoes realtime events to the acting client
 * (04-realtime.md §5), so the REST response is the only immediate feedback —
 * without this the old icon/title/style would stay until the next focus fetch.
 *
 * Used by `saveThought` (header edits) and the attachments-tab command
 * «Назначить иконкой мысли» (attachments.ts) — both mutate the same visual
 * fields of a thought the actor may see in several views at once.
 */
export function reflectThoughtUpdate(updated: Thought): void {
  const id = updated.id;
  const focus = store.state.focus;
  if (focus !== null) {
    if (focus.focused.id === id) {
      // The editor (focus follower) and the focus cloud repaint from the store.
      store.update({ focus: { ...focus, focused: updated } });
    } else if (inNeighbourhood(id)) {
      // The thought is visible on the canvas as a focus neighbour — refetch
      // the focus so its icon/type/colours repaint right away. The actor gets
      // no realtime echo, so the stale cached ref must go first.
      invalidateRef(id);
      scheduleRefresh();
    }
  }
  const target = store.state.editorTarget;
  if (target?.kind === 'thought' && target.id === id) {
    // Refresh whichever passenger carries the entity: the canvas click keeps
    // it inside the target, the structures/chronicle views — in
    // `structuresActiveThought`.
    store.update({
      ...(target.thought !== undefined
        ? { editorTarget: { kind: 'thought' as const, id, thought: updated } }
        : {}),
      structuresActiveThought: updated,
      structuresActiveThoughtId: id,
    });
  }
  // The structures results list is server-rendered; reload it so the saved
  // icon/title/type appear right away.
  scheduleStructuresRefresh();
  // The pinned bar and the history bar render the thought from their own
  // cached/last-signature state and don't pick up a store patch alone (the
  // actor gets no realtime echo — same reasoning as above). Force both to
  // refetch so a changed icon/colour/title shows up there too.
  if (store.state.pins.includes(id)) {
    invalidatePinnedRef(id);
    invalidatePinnedBar();
  }
  invalidateHistoryBar();
}

/**
 * Saves thought header fields. On success the change is reflected everywhere
 * through {@link reflectThoughtUpdate}; on a version conflict the focus is
 * refetched and the user is notified (09-scenarios.md F2). Resolves `true` on
 * success.
 */
async function saveThought(patch: ThoughtUpdateInput): Promise<boolean> {
  const networkId = requireNetworkId();
  const ctx = currentEditorContext();
  if (ctx === null || ctx.ownerType !== 'thought' || ctx.thought === null) return false;
  try {
    const updated = await etn.thoughts.update(networkId, ctx.ownerId, patch, ctx.thought.version);
    // Шаблон комментария типа (08-ui-spec.md §8.1): применяется к пустому
    // постоянному комментарию ДО отражения обновления в UI. Следующий ниже
    // `reflectThoughtUpdate` меняет версию мысли в store — редактор
    // перестраивается, и группа «Комментарий» фетчит список комментариев;
    // без упорядочивания этот фетч обгонял `comments.create` и поле
    // оставалось пустым до переоткрытия карточки (гонка, e477173f).
    // Хелпер никогда не бросает — отражение не блокируется ошибкой шаблона.
    if (patch.type_id !== undefined) {
      await applyCommentTemplateIfEmpty(networkId, ctx.ownerId, patch.type_id);
    }
    // Reflect the change wherever the entity is shown (see the helper) — the
    // actor gets no realtime echo, so the stores are patched from the save
    // response.
    reflectThoughtUpdate(updated);
    // A type change re-skins the focus cloud (type icon/colours) — reconcile
    // the whole focus from the server so nothing lags behind the patch.
    if (patch.type_id !== undefined) {
      scheduleRefresh();
    }
    return true;
  } catch (err) {
    if (isVersionConflict(err)) {
      await refreshFocus().catch(() => undefined);
      notice('⚠ Мысль изменена другим пользователем — данные обновлены.', 'error');
    } else {
      notice(`Не удалось сохранить: ${errText(err)}`, 'error');
    }
    return false;
  }
}

/**
 * Saves link header fields (type/style/colour/width/active). Resolves `true`
 * on success — the quick type creation flow uses it to move the caret into
 * the comment field only after the new type really stuck.
 */
async function saveLink(link: Link, patch: LinkUpdateInput): Promise<boolean> {
  const networkId = requireNetworkId();
  try {
    const updated = await etn.links.update(networkId, link.id, patch, link.version);
    // Repaint the line at once — the actor gets no realtime echo
    // (04-realtime.md §5), so the focus edges are patched from the response.
    patchFocusEdge(updated);
    if (patch.active !== undefined) {
      // Activity changes the neighbour zones too — reconcile from server truth.
      scheduleRefresh();
    }
    const target = store.state.editorTarget;
    if (target !== null && target.kind === 'link' && target.id === link.id) {
      store.update({ editorTarget: { kind: 'link', id: updated.id, link: updated } });
    }
    // The structures results list is server-rendered; reload it so the saved
    // link type/style show up right away (the actor gets no realtime echo).
    scheduleStructuresRefresh();
    return true;
  } catch (err) {
    if (isVersionConflict(err)) {
      notice('⚠ Связь изменена другим пользователем.', 'error');
    } else {
      notice(`Не удалось сохранить: ${errText(err)}`, 'error');
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Thought header
// ---------------------------------------------------------------------------

/** Parses the comma-separated synonyms field into a trimmed, non-empty list. */
function parseSynonymsField(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Order-sensitive equality of two synonym lists. */
function synonymsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/**
 * Builds the thought header form (08-ui-spec.md §6.2.1).
 *
 * Структура — три строки (задача 8ab775d9):
 *   1. иконка · заголовок · ⚙ (Настройки мысли)
 *   2. синонимы
 *   3. тип ▾ · «актуально» · подменю «Действия»
 *
 * Bug fix (editor shaking on Tab after a title edit): `blur` on the synonyms
 * field used to save unconditionally, even when the field was untouched.
 * Renaming a thought via Tab triggers an async `saveThought` that, on
 * success, bumps the entity version in the store and forces a full editor
 * re-render (`render()`'s signature guard). Rebuilding the DOM removes the
 * still-focused (but unedited) synonyms input — and removing a focused
 * element fires a synchronous native `blur` on it. That blur used to save
 * synonyms again (a no-op write that still bumps the version), triggering
 * another re-render, another forced blur, another save — an infinite
 * rebuild/save loop the user saw as "shaking", until a real click/Tab moved
 * the focus away mid-loop and the in-flight save above lost the version race
 * (`VERSION_CONFLICT`). The title field already guarded against saving an
 * unchanged value (see `commitTitle` below); the synonyms field now does too.
 */
function buildThoughtHeader(thought: Thought): HTMLElement {
  const box = div('editor-fields');
  const networkId = requireNetworkId();

  // --- Строка 1: иконка · заголовок · ⚙ (Настройки мысли) -----------------
  const topRow = div('editor-top-row');

  const iconBox = el('button', 'editor-icon-box') as HTMLButtonElement;
  iconBox.type = 'button';
  applyThoughtIcon(iconBox, thought);
  setTooltip(iconBox, 'Изменить иконку');
  iconBox.addEventListener('click', () => void changeThoughtIcon(thought));

  const titleArea = el('textarea', 'editor-title-input') as HTMLTextAreaElement;
  titleArea.value = thought.title;
  titleArea.maxLength = 400;
  titleArea.rows = 1;
  titleArea.placeholder = 'Заголовок';
  // A trashed thought shows its title struck-through (S13, 08-ui-spec.md
  // §6.2.1): the field stays fully editable — only the rendering is crossed
  // out, mirroring the dimmed canvas cloud.
  if (thought.marked_for_deletion) titleArea.classList.add('title-strike');
  const resizeTitle = (): void => {
    titleArea.style.height = 'auto';
    // CSS caps the visible height at ~5 lines (max-height + overflow).
    titleArea.style.height = `${titleArea.scrollHeight}px`;
  };

  // Draft mirroring (H19): the in-progress title is saved locally and cleared
  // after a successful send; an existing draft restores the unsaved value.
  let titleDraftId: string | null = null;
  let titleDraftTimer: number | null = null;
  titleArea.addEventListener('input', () => {
    resizeTitle();
    if (titleDraftTimer !== null) window.clearTimeout(titleDraftTimer);
    titleDraftTimer = window.setTimeout(() => {
      void saveDraft({
        networkId,
        entityType: 'thought',
        entityId: thought.id,
        field: 'title',
        value: titleArea.value,
        baseVersion: thought.version,
      }).then((id) => {
        titleDraftId = id;
      });
    }, 800);
  });
  void findDraft(networkId, 'thought', thought.id).then((hit) => {
    if (hit === null) return;
    if (hit.value === thought.title) {
      // The debounced draft fired after the blur save — the text is already
      // on the server; drop the stale draft instead of restoring it.
      void clearDraft(hit.id);
      return;
    }
    if (hit.baseVersion !== null && hit.baseVersion !== thought.version) {
      // The thought was saved since the draft was taken (by this client or
      // another) — the draft is stale and must not overwrite the field; the
      // retry loop still surfaces it on reconnect (09-scenarios.md J1).
      return;
    }
    if (titleArea.value !== thought.title) {
      // The user has already typed a newer value into this field — the draft
      // is an older snapshot of the same edit; drop it instead of clobbering.
      void clearDraft(hit.id);
      return;
    }
    titleArea.value = hit.value;
    titleDraftId = hit.id;
    resizeTitle();
    notice('Восстановлен несохранённый черновик заголовка.');
  });

  const commitTitle = (): void => {
    // The blur save settles the edit — the pending debounce must not mirror
    // it into a stale draft afterwards.
    if (titleDraftTimer !== null) window.clearTimeout(titleDraftTimer);
    titleDraftTimer = null;
    const value = titleArea.value.trim();
    if (value === '' || value === thought.title) {
      titleArea.value = thought.title;
      resizeTitle();
      return;
    }
    if (!canSave()) {
      offlineNotice();
      return;
    }
    void saveThought({ title: value }).then((ok) => {
      if (!ok) return;
      void clearDraft(titleDraftId);
      // Sweep by key: a debounce whose id arrived late (or never) would
      // otherwise leave a stale row behind.
      void clearDraftsFor(networkId, 'thought', thought.id);
    });
  };
  titleArea.addEventListener('blur', commitTitle);
  // Enter inserts a newline; Ctrl/Cmd+Enter commits.
  titleArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      titleArea.blur();
    }
  });

  const settingsBtn = button('', () => openThoughtSettings(thought), 'icon-btn', 'Цвет и стиль');
  settingsBtn.append(svgIcon('settings', 14));
  settingsBtn.setAttribute('aria-label', 'Настройки мысли');

  topRow.append(iconBox, titleArea, settingsBtn);
  box.append(topRow);

  // --- Строка 2: синонимы -------------------------------------------------
  const synonymsInput = el('input', 'text-input synonyms-input');
  synonymsInput.type = 'text';
  synonymsInput.value = thought.synonyms.join(', ');
  synonymsInput.placeholder = 'Синонимы (через запятую)';
  const commitSynonyms = (): void => {
    const synonyms = parseSynonymsField(synonymsInput.value);
    if (synonymsEqual(synonyms, thought.synonyms)) return;
    if (!canSave()) {
      offlineNotice();
      return;
    }
    void saveThought({ synonyms });
  };
  synonymsInput.addEventListener('blur', commitSynonyms);
  synonymsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      synonymsInput.blur();
    }
  });
  box.append(synonymsInput);

  // --- Строка 3: тип ▾ · «актуально» · подменю «Действия» -----------------
  const row = div('editor-header-row');

  // Searchable type picker (L6/L21): the type tree without the hierarchy
  // root (the root is only managed in «Типы мыслей»); rows carry the type's
  // icon and style.
  // Quick type creation (карточка «Быстрое создание типа из поля ввода»):
  // a query without matches grows a «Создать новый» row opening the
  // thought-type editor with the name prefilled; the created type is applied
  // when the dialog closes — the same save path as a regular pick — and the
  // caret then moves into the comment field.
  let focusCommentAfterTypeSave = false;
  const typeCombo = createTypeCombobox({
    options: () => thoughtTypeOptions(store.state.thoughtTypes),
    value: thought.type_id,
    placeholder: 'без типа',
    emptyLabel: 'без типа',
    onChange: (typeId) => {
      void saveThought({ type_id: typeId }).then((ok) => {
        const focusComment = focusCommentAfterTypeSave;
        focusCommentAfterTypeSave = false;
        if (ok && focusComment) focusEditorComment();
      });
    },
    onCreateNew: async (query) => {
      const id = await showThoughtTypeEditor(null, () => undefined, { initialName: query });
      if (id === null) return null;
      focusCommentAfterTypeSave = true;
      return id;
    },
  });

  const activeLabel = el('label', 'checkbox-row');
  const activeCheck = el('input');
  activeCheck.type = 'checkbox';
  activeCheck.checked = thought.active;
  activeCheck.disabled = thought.is_protected && thought.is_root; // HOME always active
  activeCheck.addEventListener('change', () => {
    void saveThought({ active: activeCheck.checked });
  });
  activeLabel.append(activeCheck, span('актуально'));

  // Подменю «Действия» — задача 8ab775d9. Команды зеркалят контекстное меню
  // облачка: «В фокус», toggle выделения, toggle закрепления. Меню открывается
  // и с клавиатуры (Enter/Space).
  const actionsBtn = button('Действия ▾', () => void openThoughtActionsMenu(thought, actionsBtn), 'btn small');
  actionsBtn.type = 'button';

  row.append(typeCombo.root, activeLabel, actionsBtn);
  box.append(row);

  // The title height depends on layout; size it once mounted.
  queueMicrotask(resizeTitle);
  return box;
}

/**
 * Подменю «Действия» в шапке редактора (задача 8ab775d9). Команды зеркалят
 * контекстное меню облачка мысли на холсте: «В фокус», toggle выделения,
 * toggle закрепления. Меню вызывается и с клавиатуры (Enter/Space на кнопке
 * «Действия ▾»).
 */
async function openThoughtActionsMenu(thought: Thought, anchor: HTMLButtonElement): Promise<void> {
  const networkId = requireNetworkId();
  // Импортируем лениво, чтобы не тащить холст в редактор и не плодить
  // циклические зависимости (canvas ↔ editor ↔ canvas/context-menu).
  const { isPinned, togglePinned } = await import('../pinned/pins.js');
  const { addToSelection, removeFromSelection } = await import('../selection/selection.js');
  const { setFocus } = await import('../app.js');
  const inSelection = store.state.selection.includes(thought.id);
  const items: MenuItem[] = [
    {
      label: 'В фокус',
      onClick: () => {
        if (!canSave()) {
          offlineNotice();
          return;
        }
        void setFocus(thought.id);
      },
    },
    {
      label: inSelection ? 'Убрать из выделенных' : 'Добавить к выделению',
      onClick: () => {
        if (inSelection) removeFromSelection([thought.id]);
        else addToSelection([thought.id]);
      },
    },
    {
      label: isPinned(thought.id) ? 'Открепить мысль' : 'Закрепить мысль',
      onClick: () => void togglePinned(thought.id),
    },
    {
      label: 'Копировать ID',
      onClick: () => {
        void navigator.clipboard.writeText(thought.id).then(
          () => notice('ID мысли скопирован.'),
          () => notice('Не удалось скопировать ID.', 'error'),
        );
      },
    },
    {
      label: thought.active ? 'Сделать неактуальной' : 'Сделать актуальной',
      onClick: () => void saveThought({ active: !thought.active }),
    },
  ];
  const rect = anchor.getBoundingClientRect();
  showMenuAt(rect.left, rect.bottom + 2, items);
}

/** Opens the thought settings dialog (colours + font style + reset). */
function openThoughtSettings(thought: Thought): void {
  // Auto-acquire the thought lock for the lifetime of the dialog (task
  // 4f141756): every control commits its change immediately, so the lock
  // outlives the dialog itself. The helper handles LOCKED with a toast;
  // `onClose` releases on any close path (Save / Reset / Cancel / × / Esc).
  let handle: LockHandle | null = null;
  void acquireOrShowBlocked('thought', thought.id).then((outcome) => {
    handle = lockHandleFromOutcome('thought', thought.id, outcome);
  });
  const style = resolveCloudStyle(thought);
  void showThoughtStyleDialog({
    resolved: {
      fg: style.fg,
      bg: style.bg,
      bold: style.bold,
      italic: style.italic,
      underline: style.underline,
      strike: style.strike,
    },
    onApply: (patch) => saveThought(patch),
    onClose: () => void releaseHeld(handle),
  });
}

/**
 * Opens the icon picker (Emoji/File/URL, 08-ui-spec.md §6.8). The picked value
 * is saved through `saveThought`; «Очистить» nulls the icon so the type default
 * shows through. A File pick (L16) first uploads the original into the
 * thought's attachments — the icon becomes a ≤256 KiB preview and
 * `icon_attachment_id` points at the stored attachment so Ctrl-hover shows the
 * full picture.
 */
function changeThoughtIcon(thought: Thought): void {
  void showIconDialog({
    current: { icon: thought.icon, kind: thought.icon_kind },
    onPick: (result) => savePickedIcon(thought, result),
  });
}

/** Persists a picked icon; file picks store the original as an attachment (L16). */
async function savePickedIcon(thought: Thought, result: IconPickResult): Promise<boolean> {
  const networkId = requireNetworkId();
  let attachmentId: string | null = null;
  if (result.source !== undefined) {
    const comma = result.source.dataUrl.indexOf(',');
    const dataBase64 = comma === -1 ? '' : result.source.dataUrl.slice(comma + 1);
    try {
      const attachment = await etn.attachments.uploadFile(networkId, 'thought', thought.id, {
        title: result.source.name.trim() !== '' ? result.source.name.trim() : 'file',
        mime_type: result.source.mime,
        data_base64: dataBase64,
      });
      attachmentId = attachment.id;
    } catch (err) {
      notice(`Не удалось загрузить файл во вложения: ${errText(err)}`, 'error');
      return false;
    }
    // The attachments tab (if built) reloads and the 📎 indicator repaints —
    // same notification path as a paste from the comment field.
    invalidateIndicators(thought.id);
    document.dispatchEvent(
      new CustomEvent('etn:attachments-changed', {
        detail: { ownerType: 'thought', ownerId: thought.id },
      }),
    );
  }
  // `icon_attachment_id: null` clears a stale link on emoji/URL/clear picks.
  return saveThought({
    icon: result.icon,
    icon_kind: result.kind,
    icon_attachment_id: attachmentId,
  });
}

/**
 * Placeholder header shown while a freshly-targeted thought is loading
 * (`etn.thoughts.get` in flight). The icon slot becomes a spinning preloader
 * so the user gets a visible "still working" cue on heavy thoughts that may
 * take up to a few seconds to fully resolve. The thought id sits in the
 * title placeholder — it is the only reliable identifier until the entity
 * arrives, and it also matches the chrome of the focused-thought placeholder
 * the editor shows when the canvas has no network open.
 *
 * Mirrors `buildThoughtHeader`'s top-row structure so the transition to the
 * real header is visually seamless (no height jump, no extra row).
 */
function buildThoughtHeaderLoading(thoughtId: string): HTMLElement {
  const box = div('editor-fields');
  const topRow = div('editor-top-row');

  const iconBox = el('span', 'editor-icon-box editor-icon-loading');
  iconBox.setAttribute('aria-label', 'Загрузка мысли');
  iconBox.append(svgIcon('loader', 18));
  topRow.append(iconBox);

  const titleArea = el('textarea', 'editor-title-input') as HTMLTextAreaElement;
  titleArea.value = `…загрузка ${thoughtId.slice(0, 8)}`;
  titleArea.maxLength = 400;
  titleArea.rows = 1;
  titleArea.readOnly = true;
  titleArea.placeholder = 'Заголовок';
  titleArea.style.height = 'auto';
  titleArea.style.height = `${titleArea.scrollHeight}px`;
  topRow.append(titleArea);

  box.append(topRow);
  // The loading state has no editable metadata yet — render an empty rows
  // container so the header height matches the loaded one (no jump on swap).
  box.append(div('editor-header-row'));
  return box;
}

/**
 * Placeholder header for a link whose entity has not been fetched yet.
 * Currently unused (links always arrive inline from the click handler) but
 * kept for symmetry — the editor's `currentEditorContext()` already returns
 * `link: null` for a freshly-targeted link until the first render, and a
 * future entry point (deep link, paste-id) may need it.
 */
function buildLinkHeaderLoading(linkId: string): HTMLElement {
  const box = div('editor-fields');
  const row = div('editor-header-row');
  const placeholder = el('span', 'muted editor-icon-loading', `…загрузка связи ${linkId.slice(0, 8)}`);
  row.append(placeholder);
  box.append(row);
  return box;
}

/** Builds the link header form (type + active). */
function buildLinkHeader(link: Link): HTMLElement {
  const box = div('editor-fields');

  // Single row: link type + settings (⚙) + active toggle (08-ui-spec.md §6.2.2).
  const row = div('editor-header-row');

  // Searchable type picker (L6/L21): the link-type tree without the root;
  // rows show forward/reverse names and the resolved line look.
  // Quick type creation (карточка «Быстрое создание типа из поля ввода»):
  // a query without matches grows a «Создать новый» row opening the
  // link-type editor with the forward name prefilled; the created type is
  // applied when the dialog closes and the caret moves into the comment
  // field — same flow as in the thought header.
  let focusCommentAfterTypeSave = false;
  const typeCombo = createTypeCombobox({
    options: () => linkTypeOptions(store.state.linkTypes),
    value: link.type_id,
    placeholder: 'без типа',
    emptyLabel: 'без типа',
    onChange: (typeId) => {
      void saveLink(link, { type_id: typeId }).then((ok) => {
        const focusComment = focusCommentAfterTypeSave;
        focusCommentAfterTypeSave = false;
        if (ok && focusComment) focusEditorComment();
      });
    },
    onCreateNew: async (query) => {
      const id = await showLinkTypeEditor(null, () => undefined, { initialName: query });
      if (id === null) return null;
      focusCommentAfterTypeSave = true;
      return id;
    },
  });

  const settingsBtn = button('', () => openLinkSettings(link), 'icon-btn', 'Цвет и стиль линии');
  settingsBtn.append(svgIcon('settings', 14));

  const activeLabel = el('label', 'checkbox-row');
  const activeCheck = el('input');
  activeCheck.type = 'checkbox';
  activeCheck.checked = link.active;
  activeCheck.addEventListener('change', () => {
    void saveLink(link, { active: activeCheck.checked });
  });
  activeLabel.append(activeCheck, span('актуально'));

  row.append(typeCombo.root, settingsBtn, activeLabel);
  box.append(row);

  return box;
}

/** Opens the link settings dialog (line colour/style/width + reset). */
function openLinkSettings(link: Link): void {
  // Auto-acquire the link lock (task 4f141756) — see `openThoughtSettings`.
  let handle: LockHandle | null = null;
  void acquireOrShowBlocked('link', link.id).then((outcome) => {
    handle = lockHandleFromOutcome('link', link.id, outcome);
  });
  // L21: the type line style resolves along the ancestor chain; an untyped
  // link resolves the root type.
  const type = resolveLinkTypeVisual(store.state.linkTypes, link.type_id);
  void showLinkStyleDialog({
    resolved: {
      color: link.color ?? type.color,
      style: link.style ?? type.style,
      width: link.width ?? type.width,
    },
    onApply: (patch) => saveLink(link, patch).then(() => undefined),
    onClose: () => void releaseHeld(handle),
  });
}

/** Test hooks (renderer editor-mount regression test); not part of the app API. */
export const editorInternals = {
  /** Registered «Основное» sections — must not grow per `mountEditor` call. */
  mainSectionCount: (): number => mainSectionBuilders.length,
  /** Comma-separated synonyms field parser (editor-shaking regression). */
  parseSynonymsField,
  /** Order-sensitive synonym list equality (editor-shaking regression). */
  synonymsEqual,
  /** Loader-only thought header for in-flight entity tests (bug 9d1d27c9 §4). */
  buildThoughtHeaderLoading,
  /** Loader-only link header (kept for symmetry with the thought header). */
  buildLinkHeaderLoading,
  /**
   * `saveThought` (template-vs-render ordering regression, карточка
   * e477173f): тест мокает `window.etn` и подписывается на store, проверяя,
   * что шаблонный комментарий создаётся ДО отражения апдейта в store.
   */
  saveThought,
};
