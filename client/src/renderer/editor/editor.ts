/**
 * Editor (H8–H12, 08-ui-spec.md §6): header + collapsible groups.
 *
 * H8 ships the shell and the header:
 *  - position switcher (left/right/top/bottom/hidden → L4 `editor_position`);
 *  - thought header: title, synonyms (comma string), type, icon (emoji),
 *    active, fg/bg colors, four font-style toggles — every change saves via
 *    `thoughts.update` with `If-Match`;
 *  - link header (when a link is picked): type + active via `links.update`.
 *
 * H9–H12 register group builders via {@link registerGroupBuilder}; the editor
 * renders every registered group for the current entity inside collapsible
 * sections whose state persists per entity (L4 `editor_collapsed_groups`).
 */

import {
  EtnError,
  UI_STATE_KEY,
  type Link,
  type Thought,
  type ThoughtUpdateInput,
} from '@etn/shared';

import { refreshFocus, requireNetworkId } from '../app.js';
import { setLinkEditorOpener } from '../canvas/links.js';
import { canSave, clearDraft, findDraft, offlineNotice, saveDraft } from '../drafts.js';
import { button, clear, div, el, errText, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { showMenuAt, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';
import { groupSection, setCollapseChangeHandler, type GroupSpec } from './group.js';
import { registerCommentGroups } from './comments.js';
import { registerAttachmentGroup } from './attachments.js';
import { registerPropertiesGroup } from './properties.js';
import { registerLinksGroup } from './links-group.js';
import { registerMentionsGroup } from './mentions.js';

/** What the editor currently edits. */
export interface EditorContext {
  ownerType: 'thought' | 'link';
  ownerId: string;
  thought: Thought | null;
  link: Link | null;
}

/** Group builder signature — H9–H12 modules register these. */
export type GroupBuilder = (ctx: EditorContext) => GroupSpec | null;

const groupBuilders: GroupBuilder[] = [];
let host: HTMLElement | null = null;
let scrollBox: HTMLElement | null = null;
let positionButton: HTMLButtonElement | null = null;
let lastSignature = '';

/** Registers an editor group builder (H9–H12). */
export function registerGroupBuilder(builder: GroupBuilder): void {
  groupBuilders.push(builder);
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

/** Mounts the editor into the workspace editor host. */
export function mountEditor(editorHost: HTMLElement): void {
  host = editorHost;
  host.replaceChildren();

  const header = div('editor-header');
  const title = span('Редактор', 'editor-title');
  positionButton = button('▾', () => void openPositionMenu(), 'btn small');
  setTooltip(positionButton, 'Положение редактора');
  header.append(title, positionButton);
  scrollBox = div('editor-scroll');
  host.append(header, scrollBox);

  setCollapseChangeHandler((entityId, groupId, collapsed) => {
    const map = store.state.collapsedGroups;
    const entity = { ...(map[entityId] ?? {}) };
    entity[groupId] = collapsed;
    store.update({ collapsedGroups: { ...map, [entityId]: entity } });
    persistCollapsed();
  });

  // Editor groups (H9–H12).
  registerCommentGroups();
  registerAttachmentGroup();
  registerPropertiesGroup();
  registerLinksGroup();
  registerMentionsGroup();

  // Clicking a link line on the canvas opens the link here (H6 ↔ H8).
  setLinkEditorOpener((link) => {
    store.update({ editorTarget: { kind: 'link', id: link.id, link } });
  });

  store.subscribe(() => {
    if (host?.isConnected === true) void render();
  });
  void render();
}

/** Renders the editor for the current target (signature-guarded). */
async function render(): Promise<void> {
  if (host === null || scrollBox === null || positionButton === null) return;
  const ctx = currentEditorContext();

  const signature =
    ctx === null
      ? 'null'
      : `${ctx.ownerType}|${ctx.ownerId}|${ctx.thought?.version ?? ''}|${ctx.link?.version ?? ''}|${store.state.editorPosition}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  clear(scrollBox);

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

  const groups = div('editor-groups');
  for (const builder of groupBuilders) {
    const spec = builder(ctx);
    if (spec !== null) groups.append(groupSection(spec, ctx.ownerId));
  }
  scrollBox.append(groups);
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
  store.update({ editorPosition: position });
  const networkId = store.state.networkId;
  if (networkId !== null) {
    await etn.ui.setState(networkId, UI_STATE_KEY.EDITOR_POSITION, position).catch(() => undefined);
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

/** Saves link header fields (type/active). */
async function saveLink(
  link: Link,
  patch: { type_id?: string | null; active?: boolean },
): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const updated = await etn.links.update(networkId, link.id, patch, link.version);
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

/** Builds the thought header form (08-ui-spec.md §6.2). */
function buildThoughtHeader(thought: Thought): HTMLElement {
  const box = div('editor-fields');
  const networkId = requireNetworkId();

  const titleInput = el('input', 'text-input');
  titleInput.type = 'text';
  titleInput.value = thought.title;
  titleInput.maxLength = 400;

  // Draft mirroring (H19): the in-progress title is saved locally and cleared
  // after a successful send; an existing draft restores the unsaved value.
  let titleDraftId: string | null = null;
  let titleDraftTimer: number | null = null;
  titleInput.addEventListener('input', () => {
    if (titleDraftTimer !== null) window.clearTimeout(titleDraftTimer);
    titleDraftTimer = window.setTimeout(() => {
      void saveDraft({
        networkId,
        entityType: 'thought',
        entityId: thought.id,
        field: 'title',
        value: titleInput.value,
        baseVersion: thought.version,
      }).then((id) => {
        titleDraftId = id;
      });
    }, 800);
  });
  void findDraft(networkId, 'thought', thought.id).then((hit) => {
    if (hit !== null && titleInput.value !== hit.value) {
      titleInput.value = hit.value;
      titleDraftId = hit.id;
      notice('Восстановлен несохранённый черновик заголовка.');
    }
  });

  const commitTitle = (): void => {
    const value = titleInput.value.trim();
    if (value === '' || value === thought.title) {
      titleInput.value = thought.title;
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
  titleInput.addEventListener('blur', commitTitle);
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      titleInput.blur();
    }
  });
  box.append(editorField('Заголовок', titleInput));

  const synonymsInput = el('input', 'text-input');
  synonymsInput.type = 'text';
  synonymsInput.value = thought.synonyms.join(', ');
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
  box.append(editorField('Синонимы (через запятую)', synonymsInput));

  // Row: type + icon + active.
  const row1 = div('editor-header-row');

  const typeSelect = el('select', 'select-input');
  const typePlaceholder = el('option', undefined, 'без типа');
  typePlaceholder.value = '';
  typeSelect.append(typePlaceholder);
  for (const type of store.state.thoughtTypes) {
    const option = el('option', undefined, type.name);
    option.value = type.id;
    typeSelect.append(option);
  }
  typeSelect.value = thought.type_id ?? '';
  typeSelect.addEventListener('change', () => {
    void saveThought({ type_id: typeSelect.value === '' ? null : typeSelect.value });
  });

  const iconInput = el('input', 'text-input icon-input');
  iconInput.type = 'text';
  iconInput.value = thought.icon ?? '';
  iconInput.maxLength = 8;
  iconInput.placeholder = 'эмодзи';
  iconInput.addEventListener('blur', () => {
    const value = iconInput.value.trim();
    void saveThought({ icon: value === '' ? null : value, icon_kind: 'emoji' });
  });

  const activeLabel = el('label', 'checkbox-row');
  const activeCheck = el('input');
  activeCheck.type = 'checkbox';
  activeCheck.checked = thought.active;
  activeCheck.disabled = thought.is_protected && thought.is_root; // HOME always active
  activeCheck.addEventListener('change', () => {
    void saveThought({ active: activeCheck.checked });
  });
  activeLabel.append(activeCheck, span('активна'));

  row1.append(typeSelect, iconInput, activeLabel);
  box.append(editorField('Тип / иконка / активность', row1));

  // Row: colors + font toggles.
  const row2 = div('editor-header-row');

  const fgColor = el('input', 'color-input');
  fgColor.type = 'color';
  fgColor.value = thought.fg_color ?? '#20242d';
  fgColor.title = 'Цвет текста';
  fgColor.addEventListener('change', () => {
    void saveThought({ fg_color: fgColor.value });
  });

  const bgColor = el('input', 'color-input');
  bgColor.type = 'color';
  bgColor.value = thought.bg_color ?? '#ffffff';
  bgColor.title = 'Цвет фона';
  bgColor.addEventListener('change', () => {
    void saveThought({ bg_color: bgColor.value });
  });

  const toggles = div('font-toggles');
  const fontToggle = (
    glyph: string,
    title: string,
    on: boolean,
    apply: (value: boolean) => void,
  ): void => {
    const btn = button(
      glyph,
      () => apply(!btn.classList.contains('on')),
      `font-toggle${on ? ' on' : ''}`,
    );
    setTooltip(btn, title);
    toggles.append(btn);
  };
  fontToggle('Ж', 'Жирный', thought.font_bold, (v) => void saveThought({ font_bold: v }));
  fontToggle('Н', 'Курсив', thought.font_italic, (v) => void saveThought({ font_italic: v }));
  fontToggle(
    'П',
    'Подчёркнутый',
    thought.font_underline,
    (v) => void saveThought({ font_underline: v }),
  );
  fontToggle('З', 'Зачёркнутый', thought.font_strike, (v) => void saveThought({ font_strike: v }));

  row2.append(fgColor, bgColor, toggles);
  box.append(editorField('Цвет и стиль', row2));

  return box;
}

/** Builds the link header form (type + active). */
function buildLinkHeader(link: Link): HTMLElement {
  const box = div('editor-fields');

  const typeName = store.state.linkTypes.find((t) => t.id === link.type_id);
  const titleLine = el('p', 'muted', `Связь ${typeName?.name_forward ?? 'без типа'}`);
  titleLine.style.margin = '0 0 10px';
  box.append(titleLine);

  const typeSelect = el('select', 'select-input');
  const typePlaceholder = el('option', undefined, 'без типа');
  typePlaceholder.value = '';
  typeSelect.append(typePlaceholder);
  for (const type of store.state.linkTypes) {
    const option = el('option', undefined, `${type.name_forward} / ${type.name_reverse}`);
    option.value = type.id;
    typeSelect.append(option);
  }
  typeSelect.value = link.type_id ?? '';
  typeSelect.addEventListener('change', () => {
    void saveLink(link, { type_id: typeSelect.value === '' ? null : typeSelect.value });
  });
  box.append(editorField('Тип связи', typeSelect));

  const activeLabel = el('label', 'checkbox-row');
  const activeCheck = el('input');
  activeCheck.type = 'checkbox';
  activeCheck.checked = link.active;
  activeCheck.addEventListener('change', () => {
    void saveLink(link, { active: activeCheck.checked });
  });
  activeLabel.append(activeCheck, span('активна'));
  box.append(activeLabel);

  return box;
}

/** Standard editor field: label above the control. */
function editorField(label: string, control: HTMLElement): HTMLElement {
  const box = div('editor-field');
  box.append(el('label', 'field-label', label));
  box.append(control);
  return box;
}
