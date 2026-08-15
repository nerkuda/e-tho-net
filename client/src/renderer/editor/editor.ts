/**
 * Editor shell (H8–H12, 08-ui-spec.md §6): header + tabs (L7).
 *
 * H8 ships the shell and the header:
 *  - position switcher (left/right/top/bottom/hidden → L4 `editor_position`);
 *  - thought header: title, synonyms (comma string), type, icon (emoji),
 *    active, fg/bg colors, four font-style toggles — every change saves via
 *    `thoughts.update` with `If-Match`;
 *  - link header (when a link is picked): type + active via `links.update`.
 *
 * L7 turns the group stack below the header into tabs (08-ui-spec.md §6.3):
 * «Основное», «Вложения (N)», «Связи», «Хроника (N)». A tab's content is
 * built lazily on first activation and cached for the lifetime of one editor
 * render (a signature change rebuilds everything). The active tab survives
 * focus changes. Modules register tab content builders (`registerTabContent`),
 * tab badge counters (`registerTabCount`) and «Основное» sections
 * (`registerMainSection` — collapsible groups).
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
import { applyThoughtIcon, resolveCloudStyle } from '../canvas/canvas.js';
import { setLinkSettingsOpener } from '../canvas/context-menu.js';
import { setLinkEditorOpener } from '../canvas/links.js';
import { canSave, clearDraft, findDraft, offlineNotice, saveDraft } from '../drafts.js';
import { button, clear, div, el, errText, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { showMenuAt, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { createTypeCombobox } from '../lib/type-combobox.js';
import { focusEdgesSignature, patchFocusEdge, store } from '../state.js';
import { groupSection, setCollapseChangeHandler, type GroupSpec } from './group.js';
import { registerCommentSections } from './comments.js';
import { registerAttachmentsTab } from './attachments.js';
import { registerPropertiesGroup } from './properties.js';
import { registerLinksTab } from './links-tab.js';
import { showIconDialog } from './icon-dialog.js';
import { showLinkStyleDialog, showThoughtStyleDialog } from './style-dialog.js';

/** What the editor currently edits. */
export interface EditorContext {
  ownerType: 'thought' | 'link';
  ownerId: string;
  thought: Thought | null;
  link: Link | null;
}

/** Editor tab ids (08-ui-spec.md §6.3). */
export type EditorTabId = 'main' | 'attachments' | 'links' | 'chrono';

/** Builds the content of one tab for the current entity. */
export type TabContentBuilder = (ctx: EditorContext) => HTMLElement;

/** Resolves a tab's `(N)` badge count for the current entity. */
export type TabCountLoader = (ctx: EditorContext) => Promise<number | undefined>;

/** Builds one collapsible group of the «Основное» tab (or null to skip). */
export type MainSectionBuilder = (ctx: EditorContext) => GroupSpec | null;

/** Static tab bar definition; badges come from registered count loaders. */
const TABS: Array<{ id: EditorTabId; title: string; counted: boolean }> = [
  { id: 'main', title: 'Основное', counted: false },
  { id: 'attachments', title: 'Вложения', counted: true },
  { id: 'links', title: 'Связи', counted: false },
  { id: 'chrono', title: 'Хроника', counted: true },
];

const tabContentBuilders = new Map<EditorTabId, TabContentBuilder>();
const tabCountLoaders = new Map<EditorTabId, TabCountLoader>();
const mainSectionBuilders: MainSectionBuilder[] = [];

/** The active tab — module-level so it survives focus/entity changes (L7). */
let activeTab: EditorTabId = 'main';

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
}

/** Opens a link in the editor without changing the focus (H6/H11). */
export function openLinkInEditor(link: Link): void {
  store.update({ editorTarget: { kind: 'link', id: link.id, link } });
}

/** Current editor context: the picked link or the focused thought. */
export function currentEditorContext(): EditorContext | null {
  const target = store.state.editorTarget;
  if (target !== null && target.kind === 'link') {
    return { ownerType: 'link', ownerId: target.id, thought: null, link: target.link };
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
  positionButton = button('▾', () => void openPositionMenu(), 'btn small');
  setTooltip(positionButton, 'Положение редактора');
  header.append(titleEl, positionButton);
  scrollBox = div('editor-scroll');
  host.append(header, scrollBox);

  setCollapseChangeHandler((entityId, groupId, collapsed) => {
    const map = store.state.collapsedGroups;
    const entity = { ...(map[entityId] ?? {}) };
    entity[groupId] = collapsed;
    store.update({ collapsedGroups: { ...map, [entityId]: entity } });
    persistCollapsed();
  });

  // Editor sections and tabs (H9–H12, L7).
  registerPropertiesGroup();
  registerCommentSections();
  registerAttachmentsTab();
  registerLinksTab();

  // Clicking a link line on the canvas opens the link here (H6 ↔ H8) and marks
  // it as the sticky canvas selection.
  setLinkEditorOpener((link) => {
    store.update({ editorTarget: { kind: 'link', id: link.id, link }, selectedLinkId: link.id });
  });

  // The link context menu ("Изменить свойства") opens the same settings dialog
  // as the editor's ⚙ button.
  setLinkSettingsOpener(openLinkSettings);

  store.subscribe(() => {
    if (host?.isConnected === true) void render();
  });
  void render();
}

/** Renders the editor for the current target (signature-guarded). */
async function render(): Promise<void> {
  if (host === null || scrollBox === null || positionButton === null) return;
  const ctx = currentEditorContext();

  // Panel title reflects what is selected (08-ui-spec.md §6.2).
  if (titleEl !== null) {
    titleEl.textContent = ctx === null ? '' : ctx.ownerType === 'link' ? 'Связь' : 'Мысль';
  }

  const signature =
    ctx === null
      ? 'null'
      : `${ctx.ownerType}|${ctx.ownerId}|${ctx.thought?.version ?? ''}|${ctx.link?.version ?? ''}` +
        `|${focusEdgesSignature(store.state.focus)}|${store.state.editorPosition}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  clear(scrollBox);
  tabCountSpans.clear();
  renderCtx = ctx;

  if (ctx === null) {
    const empty = div('editor-empty');
    empty.textContent = 'Выберите мысль или связь.';
    scrollBox.append(empty);
    return;
  }

  if (ctx.ownerType === 'thought' && ctx.thought !== null) {
    scrollBox.append(buildThoughtHeader(ctx.thought));
  } else if (ctx.ownerType === 'link' && ctx.link !== null) {
    scrollBox.append(buildLinkHeader(ctx.link));
  }

  // --- tab bar (L7) ---------------------------------------------------------
  const tabBar = div('editor-tabs');
  const buttons = new Map<EditorTabId, HTMLButtonElement>();
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
    tab.addEventListener('click', () => activateTab(def.id));
    buttons.set(def.id, tab);
    tabBar.append(tab);
  }

  // --- tab panes (lazily built, cached for this render) ---------------------
  const paneHost = div('tab-pane-root');
  const built = new Map<EditorTabId, HTMLElement>();

  const buildPane = (id: EditorTabId): HTMLElement => {
    const pane = div(`tab-pane${id === 'main' ? '' : ' fixed'}`);
    if (id === 'main') {
      for (const section of mainSectionBuilders) {
        const spec = section(ctx);
        if (spec !== null) pane.append(groupSection(spec, ctx.ownerId));
      }
      return pane;
    }
    const builder = tabContentBuilders.get(id);
    pane.append(builder !== undefined ? builder(ctx) : el('p', 'muted', 'Нет содержимого.'));
    return pane;
  };

  function activateTab(id: EditorTabId): void {
    activeTab = id;
    for (const [tabId, tab] of buttons) {
      tab.classList.toggle('active', tabId === id);
    }
    let pane = built.get(id);
    if (pane === undefined) {
      pane = buildPane(id);
      built.set(id, pane);
    }
    paneHost.replaceChildren(pane);
  }

  scrollBox.append(tabBar, paneHost);
  activateTab(activeTab);
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
 * Saves thought header fields. On success the store focus is patched with the
 * updated entity; on a version conflict the focus is refetched and the user is
 * notified (09-scenarios.md F2). Resolves `true` on success.
 */
async function saveThought(patch: ThoughtUpdateInput): Promise<boolean> {
  const networkId = requireNetworkId();
  const focus = store.state.focus;
  if (focus === null) return false;
  try {
    const updated = await etn.thoughts.update(
      networkId,
      focus.focused.id,
      patch,
      focus.focused.version,
    );
    store.update({ focus: { ...focus, focused: updated } });
    // A type change re-skins the focus cloud (type icon/colours) — reconcile
    // the whole focus from the server so nothing lags behind the patch.
    if (patch.type_id !== undefined) scheduleRefresh();
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

/** Saves link header fields (type/style/colour/width/active). */
async function saveLink(link: Link, patch: LinkUpdateInput): Promise<void> {
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
  } catch (err) {
    if (isVersionConflict(err)) {
      notice('⚠ Связь изменена другим пользователем.', 'error');
    } else {
      notice(`Не удалось сохранить: ${errText(err)}`, 'error');
    }
  }
}

// ---------------------------------------------------------------------------
// Thought header
// ---------------------------------------------------------------------------

/** Builds the thought header form (08-ui-spec.md §6.2.1). */
function buildThoughtHeader(thought: Thought): HTMLElement {
  const box = div('editor-fields');
  const networkId = requireNetworkId();

  // Top row: clickable icon box + large multiline title (no field labels —
  // placeholders only, 08-ui-spec.md §6.2).
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
    if (hit !== null && titleArea.value !== hit.value) {
      titleArea.value = hit.value;
      titleDraftId = hit.id;
      resizeTitle();
      notice('Восстановлен несохранённый черновик заголовка.');
    }
  });

  const commitTitle = (): void => {
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
      if (ok) void clearDraft(titleDraftId);
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

  topRow.append(iconBox, titleArea);
  box.append(topRow);

  // Synonyms (single line, comma-separated).
  const synonymsInput = el('input', 'text-input synonyms-input');
  synonymsInput.type = 'text';
  synonymsInput.value = thought.synonyms.join(', ');
  synonymsInput.placeholder = 'Синонимы (через запятую)';
  const commitSynonyms = (): void => {
    const synonyms = synonymsInput.value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
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

  // Bottom row: type + settings (⚙) + active toggle.
  const row = div('editor-header-row');

  // Searchable type picker (L6): rows carry the type's icon and style.
  const typeCombo = createTypeCombobox({
    options: () =>
      store.state.thoughtTypes.map((t) => ({
        id: t.id,
        label: t.name,
        icon: { icon: t.icon, kind: t.icon_kind },
        style: {
          fg: t.fg_color,
          bg: t.bg_color,
          bold: t.font_bold,
          italic: t.font_italic,
          underline: t.font_underline,
          strike: t.font_strike,
        },
      })),
    value: thought.type_id,
    placeholder: 'без типа',
    emptyLabel: 'без типа',
    onChange: (typeId) => void saveThought({ type_id: typeId }),
  });

  const settingsBtn = button('⚙', () => openThoughtSettings(thought), 'icon-btn');
  setTooltip(settingsBtn, 'Цвет и стиль');

  const activeLabel = el('label', 'checkbox-row');
  const activeCheck = el('input');
  activeCheck.type = 'checkbox';
  activeCheck.checked = thought.active;
  activeCheck.disabled = thought.is_protected && thought.is_root; // HOME always active
  activeCheck.addEventListener('change', () => {
    void saveThought({ active: activeCheck.checked });
  });
  activeLabel.append(activeCheck, span('актуально'));

  row.append(typeCombo.root, settingsBtn, activeLabel);
  box.append(row);

  // The title height depends on layout; size it once mounted.
  queueMicrotask(resizeTitle);
  return box;
}

/** Opens the thought settings dialog (colours + font style + reset). */
function openThoughtSettings(thought: Thought): void {
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
  });
}

/**
 * Opens the icon picker (Emoji/File/URL, 08-ui-spec.md §6.8). The picked value
 * is saved through `saveThought`; «Очистить» nulls the icon so the type default
 * shows through.
 */
function changeThoughtIcon(thought: Thought): void {
  void showIconDialog({
    current: { icon: thought.icon, kind: thought.icon_kind },
    onPick: (result) => saveThought({ icon: result.icon, icon_kind: result.kind }),
  });
}

/** Builds the link header form (type + active). */
function buildLinkHeader(link: Link): HTMLElement {
  const box = div('editor-fields');

  // Single row: link type + settings (⚙) + active toggle (08-ui-spec.md §6.2.2).
  const row = div('editor-header-row');

  // Searchable type picker (L6): rows show forward/reverse names + line look.
  const typeCombo = createTypeCombobox({
    options: () =>
      store.state.linkTypes.map((t) => ({
        id: t.id,
        label: `${t.name_forward} / ${t.name_reverse}`,
        line: { color: t.color, style: t.style, width: t.width },
      })),
    value: link.type_id,
    placeholder: 'без типа',
    emptyLabel: 'без типа',
    onChange: (typeId) => void saveLink(link, { type_id: typeId }),
  });

  const settingsBtn = button('⚙', () => openLinkSettings(link), 'icon-btn');
  setTooltip(settingsBtn, 'Цвет и стиль линии');

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
  const type = store.state.linkTypes.find((t) => t.id === link.type_id);
  void showLinkStyleDialog({
    resolved: {
      color: link.color ?? type?.color ?? null,
      style: link.style ?? type?.style ?? 'solid',
      width: link.width ?? type?.width ?? 1,
    },
    onApply: (patch) => saveLink(link, patch),
  });
}
