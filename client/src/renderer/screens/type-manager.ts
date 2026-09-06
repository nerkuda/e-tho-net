/**
 * Type catalogue management (L6 + L21 hierarchy, 08-ui-spec.md §8.4).
 *
 * Opened from the toolbar «Вид» menu:
 *  - «Типы мыслей» / «Типы связей» — a **tree** of types (root «основной тип»
 *    always expanded, other nodes collapsed; the root has no delete mark and
 *    is not assignable to thoughts/links): icon, name rendered with the
 *    type's own colours/font, short description. Both lists carry a
 *    «Количество» column (own record count; a group type shows the sum over
 *    its subtree, task «Улучшить диалог редактирования типов мыслей и
 *    связей»), a name-search row (matches + their ancestor chains stay
 *    visible, branches auto-expand) and — thought types only, being the deep
 *    hierarchy — «Свернуть все»/«Развернуть все». «Добавить» opens the
 *    editor, each row has a delete button (the server rejects deleting the
 *    root or a type that still has subordinate types). Deleting a used type
 *    is forced: thoughts/links keep existing with `type_id = null`, and the
 *    type's property bindings are dropped server-side (stored values become
 *    values-outside-type).
 *
 * Type editors (task «Улучшить диалог редактирования типов мыслей и связей»)
 * are one and the same staged form for a NEW and an EXISTING type: icon,
 * colours/font (or line style), parent, description, comment template and
 * the own property bindings are editable right away, nothing is inert, and
 * nothing touches the server until «Применить и закрыть» is pressed.
 * «Отмена» (also Esc/×/backdrop) closes the dialog discarding the whole
 * draft. Reparenting is validated as before: the parent picker filters
 * cycles/depth client-side and the server rejects a type in use, cycles and
 * nesting past 4 levels.
 *
 * Property sections (since 0.6.5):
 *  - «Свойства типа» — the type's own BINDINGS to the network property
 *    registry, staged in a local draft (`type-property-draft.ts`): the
 *    editor attaches existing registry properties or creates new ones, and
 *    on existing bindings it toggles `required` and reorders ▲/▼. All edits
 *    are local until the editor's «Применить и закрыть» reconciles them
 *    with the server (unbinds first, then attaches/creates, then `set-role`
 *    patches, one trailing reorder). The property's NATURE (name, value
 *    type, config, description) is NOT editable here — it is shared by every
 *    type that binds it and lives in the registry; the table's «✎» button
 *    jumps to the property manager dialog with a banner warning about the
 *    network-wide impact.
 *  - «Унаследованные свойства» — read-only bindings inherited from the
 *    ancestors; only the default value and description may be overridden per
 *    type (and the override can be reset back to the ancestor's value). The
 *    override dialogs keep their own explicit «Применить» and write
 *    immediately. `required` is NOT editable on inherited bindings — it
 *    belongs to the type that attached the binding, the inherited view is a
 *    preview of the effective value. For a type that is still being created
 *    the section previews what the picked parent will pass down.
 *
 * Link-type editor: forward/reverse names, ⚙ (line-style dialog, type mode —
 * a reset inherits the parent's style since L21), description and the same
 * property sections (link types gained a property table in L21).
 */

import type {
  EffectiveTypeProperty,
  IconKind,
  LinkType,
  PropertyDefinition,
  PropertyValueType,
  ThoughtType,
  ThoughtTypeInput,
  ThoughtTypeUpdateInput,
  LinkTypeUpdateInput,
  TypeOwnerType,
} from '@etn/shared';
import { typeNameKey } from '@etn/shared';

import { requireNetworkId, scheduleRefresh } from '../app.js';
import { applyThoughtIcon } from '../canvas/canvas.js';
import { confirmDialog, errorDialog, showDialog, type DialogButton } from '../lib/dialog.js';
import { button, div, el, errText, setTooltip, span, applyFontFlags } from '../lib/dom.js';
import { svgIcon } from '../lib/icons.js';
import { etn } from '../lib/etn.js';
import {
  MAX_TYPE_DEPTH,
  aggregateTypeCounts,
  flattenTypeTree,
  buildTypeTree,
  findRootType,
  orderedTypeRows,
  resolveLinkTypeVisual,
  resolveThoughtTypeVisual,
  subtreeTypeIds,
  typeDepth,
  subtreeHeight,
  typeSearchVisibleIds,
  type FlatTypeRow,
} from '../lib/type-tree.js';
import { createTypeCombobox } from '../lib/type-combobox.js';
import {
  draftPropertiesFrom,
  nextDraftPropertyId,
  opToAttachInput,
  planPropertyDiff,
  type DraftProperty,
} from '../lib/type-property-draft.js';
import {
  openPropertyManagerEditor,
  type RegistryRow,
} from './property-manager.js';
import { store } from '../state.js';
import { showIconDialog } from '../editor/icon-dialog.js';
import { createMarkdownField } from '../editor/markdown-field.js';
import { showLinkStyleDialog, showThoughtStyleDialog } from '../editor/style-dialog.js';
import { renderMarkdown } from '@etn/markdown';
import { buildMetadataRows, type MetadataFields } from '../lib/metadata.js';

/** Human-readable property value-type labels. */
const VALUE_TYPE_LABELS: Record<PropertyValueType, string> = {
  text: 'строка',
  number: 'число',
  date: 'дата',
  bool: 'булево',
  thought_ref: 'ссылка на мысль',
  url: 'URL (сайт или файл)',
};

/** Reloads the thought-type catalogue (selects and cloud styles read it). */
async function refreshThoughtTypes(): Promise<void> {
  const networkId = requireNetworkId();
  store.update({ thoughtTypes: await etn.types.listThoughtTypes(networkId) });
}

/** Reloads the link-type catalogue (line labels/colours read it). */
async function refreshLinkTypes(): Promise<void> {
  const networkId = requireNetworkId();
  store.update({ linkTypes: await etn.types.listLinkTypes(networkId) });
}

/** Applies a type's own colours/font flags to an element (list name cells). */
function applyTypeStyle(
  target: HTMLElement,
  t: Pick<ThoughtType, 'fg_color' | 'bg_color' | 'font_bold' | 'font_italic' | 'font_underline' | 'font_strike'>,
): void {
  if (t.fg_color !== null) target.style.color = t.fg_color;
  if (t.bg_color !== null) target.style.background = t.bg_color;
  applyFontFlags(target, {
    bold: t.font_bold ?? false,
    italic: t.font_italic ?? false,
    underline: t.font_underline ?? false,
    strike: t.font_strike ?? false,
  });
}

/** Shape of the staged thought-type draft — the editable fields the new-type
 *  dialog applies on «Применить и закрыть». */
export interface ThoughtTypeDraft {
  name: string;
  parent_id: string | null;
  description: string;
  icon: string | null;
  icon_kind: IconKind;
  fg_color: string | null;
  bg_color: string | null;
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
}

/**
 * Builds the minimal `POST /thought-types` payload from the staged draft
 * (regression for 0ab4749b — `font_bold должен быть логическим значением`).
 *
 * The server treats `font_*` / `fg_color` / `bg_color` / `icon` as
 * `null`-or-value (`null` — inherit from parent), and `font_*` are
 * `boolean | null` on the wire. Sending `null` for an untouched field IS
 * legal, but the minimal payload keeps the create free of obvious
 * `null on first sight` noise and avoids the historical regression of
 * accidentally pushing the dialog's initial `null` defaults through the
 * route layer. Each field is included only when it differs from the
 * create-time default.
 */
export function buildCreateTypeInput(
  draft: ThoughtTypeDraft,
  descriptionRaw: string,
  nextTemplate: string | null,
): ThoughtTypeInput {
  const input: ThoughtTypeInput = { name: draft.name };
  if (draft.parent_id !== null) input.parent_id = draft.parent_id;
  const descriptionValue = descriptionRaw.trim() === '' ? null : descriptionRaw.trim();
  if (descriptionValue !== null) input.description = descriptionValue;
  if (draft.icon !== null) {
    input.icon = draft.icon;
    input.icon_kind = draft.icon_kind;
  }
  if (draft.fg_color !== null) input.fg_color = draft.fg_color;
  if (draft.bg_color !== null) input.bg_color = draft.bg_color;
  if (draft.font_bold !== null) input.font_bold = draft.font_bold;
  if (draft.font_italic !== null) input.font_italic = draft.font_italic;
  if (draft.font_underline !== null) input.font_underline = draft.font_underline;
  if (draft.font_strike !== null) input.font_strike = draft.font_strike;
  if (nextTemplate !== null) input.comment_template_md = nextTemplate;
  return input;
}

// ---------------------------------------------------------------------------
// Tree rows for the catalogue dialogs (L21): expand/collapse per dialog.
// ---------------------------------------------------------------------------

/** Rows of a type tree restricted to the expanded nodes. */
function visibleRows<T extends { id: string; parent_id: string | null; is_root: boolean }>(
  types: readonly T[],
  expanded: ReadonlySet<string>,
): FlatTypeRow<T>[] {
  return flattenTypeTree(buildTypeTree(types), expanded);
}

/** The ▸/▾ expander button of a tree row (hidden for leaves). */
function treeToggle(
  row: FlatTypeRow<{ id: string; parent_id: string | null; is_root: boolean }>,
  expanded: ReadonlySet<string>,
  onToggle: () => void,
  /** While a name search is filtering the list, branches are shown by the
   *  search itself (matches + ancestor chain) — the toggle renders expanded
   *  and inert so it does not fight the search's own expansion. */
  forceOpen = false,
): HTMLElement {
  const btn = button('', onToggle, 'btn small type-tree-toggle', row.hasChildren ? 'Развернуть/свернуть' : '');
  btn.textContent = row.hasChildren ? (forceOpen || expanded.has(row.type.id) ? '▾' : '▸') : '';
  btn.disabled = !row.hasChildren || forceOpen;
  return btn;
}

// ---------------------------------------------------------------------------
// Thought types: tree list + editor
// ---------------------------------------------------------------------------

/** Opens the thought-types tree dialog (L6/L21). */
export function showThoughtTypesDialog(): void {
  const networkId = requireNetworkId();
  const errorLine = span('', 'error-text');
  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '340px';
  const body = div('form-stack');

  // Toolbar (top of the list, task «Улучшить диалог…»): «Добавить»,
  // «Свернуть все»/«Развернуть все» and the name-search box.
  const toolbar = div('form-row type-list-toolbar');
  const searchInput = el('input', 'text-input') as HTMLInputElement;
  searchInput.type = 'text';
  searchInput.placeholder = 'Поиск по названию…';
  toolbar.append(
    button('Добавить', () => showThoughtTypeEditor(null, onChanged), 'btn small', 'Создать тип'),
    button('Свернуть все', () => collapseAll(), 'btn small', 'Свернуть всю иерархию'),
    button('Развернуть все', () => expandAll(), 'btn small', 'Развернуть всю иерархию'),
    searchInput,
  );
  body.append(toolbar, tableWrap, errorLine);

  // L21: the root type is always expanded; everything else starts collapsed.
  let expanded = new Set<string>();
  let searchQuery = '';
  // Last loaded catalogue — tree toggles/search re-render from this cache,
  // without a network round-trip and without the «Загрузка…» placeholder, so
  // expanding/collapsing/typing does not flicker or jump the scroll position.
  let cachedTypes: ThoughtType[] | null = null;
  let cachedCounts: Record<string, number> | null = null;

  const onChanged = (): void => void reload();

  async function reload(useCache = false): Promise<void> {
    const scrollTop = tableWrap.scrollTop;
    let types: ThoughtType[];
    let counts: Record<string, number>;
    if (useCache && cachedTypes !== null && cachedCounts !== null) {
      types = cachedTypes;
      counts = cachedCounts;
    } else {
      tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
      try {
        [types, counts] = await Promise.all([
          etn.types.listThoughtTypes(networkId),
          etn.types.getThoughtTypeCounts(networkId),
        ]);
      } catch (err) {
        tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
        return;
      }
      cachedTypes = types;
      cachedCounts = counts;
    }
    if (expanded.size === 0) {
      expanded = new Set(types.filter((t) => t.is_root).map((t) => t.id));
    }
    const aggregated = aggregateTypeCounts(types, counts);
    const searching = searchQuery.trim() !== '';
    const keepIds = typeSearchVisibleIds(types, searchQuery);
    // Searching shows every matched branch fully expanded (task's «ветви до
    // совпадений разворачиваются автоматически»); otherwise the manual
    // expand/collapse state applies as before.
    const rows = (
      searching ? flattenTypeTree(buildTypeTree(types), new Set(types.map((t) => t.id))) : visibleRows(types, expanded)
    ).filter((row) => keepIds.has(row.type.id));
    const table = el('table', 'table-list');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th', undefined, 'Тип'),
      el('th', undefined, 'Комментарий'),
      el('th', undefined, 'Количество'),
      el('th'),
    );
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    if (rows.length === 0) {
      const emptyRow = el('tr');
      const emptyCell = el('td', 'muted', searching ? 'Ничего не найдено.' : 'Нет типов.');
      emptyCell.colSpan = 4;
      emptyRow.append(emptyCell);
      tbody.append(emptyRow);
    }
    for (const row of rows) {
      const type = row.type;
      const tr = el('tr');
      if (type.is_root) tr.classList.add('type-tree-root');
      const nameCell = el('td');
      nameCell.style.whiteSpace = 'nowrap';
      const nameWrap = span('', 'type-tree-name');
      nameWrap.style.paddingLeft = `${Math.max(0, row.depth - 1) * 18}px`;
      nameWrap.append(treeToggle(row, expanded, () => void toggle(type.id), searching));
      // L21: the row shows the EFFECTIVE look — a subordinate type renders
      // with the icon/colours/font inherited from its ancestors.
      const visual = resolveThoughtTypeVisual(types, type.id);
      const icon = span('', 'mini-icon');
      applyThoughtIcon(icon, { icon: visual.icon, icon_kind: visual.icon_kind, type_id: null });
      const name = span(type.name, 'type-list-name');
      applyTypeStyle(name, {
        fg_color: visual.fg_color,
        bg_color: visual.bg_color,
        font_bold: visual.font_bold ?? false,
        font_italic: visual.font_italic ?? false,
        font_underline: visual.font_underline ?? false,
        font_strike: visual.font_strike ?? false,
      });
      nameWrap.append(icon, name);
      nameCell.append(nameWrap);
      const descCell = el('td', 'muted', (type.description ?? '').slice(0, 120));
      descCell.style.maxWidth = '280px';
      descCell.style.overflow = 'hidden';
      descCell.style.textOverflow = 'ellipsis';
      descCell.style.whiteSpace = 'nowrap';
      const countCell = el('td', 'muted', String(aggregated[type.id] ?? 0));
      countCell.style.textAlign = 'right';
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      if (!type.is_root) {
        actions.append(button('✕', () => void removeRow(type), 'btn small', 'Удалить тип'));
      }
      tr.append(nameCell, descCell, countCell, actions);
      // Clicks on the ▸/▾ toggle or the ✕ button must not open the editor.
      tr.addEventListener('click', (event) => {
        if (event.target instanceof HTMLElement && event.target.closest('button') !== null) return;
        showThoughtTypeEditor(type, onChanged);
      });
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
    tableWrap.scrollTop = scrollTop;
  }

  /** Expands/collapses a node and re-renders from the cache (no round-trip). */
  function toggle(typeId: string): void {
    if (expanded.has(typeId)) expanded.delete(typeId);
    else expanded.add(typeId);
    void reload(true);
  }

  /** «Развернуть все»: opens every branch of the hierarchy. */
  function expandAll(): void {
    if (cachedTypes !== null) expanded = new Set(cachedTypes.map((t) => t.id));
    void reload(true);
  }

  /** «Свернуть все»: back to just the root expanded (the initial state). */
  function collapseAll(): void {
    if (cachedTypes !== null) expanded = new Set(cachedTypes.filter((t) => t.is_root).map((t) => t.id));
    void reload(true);
  }

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    void reload(true);
  });

  /** Deletes a thought type (forced: thoughts detached, values dropped). */
  async function removeRow(type: ThoughtType): Promise<void> {
    const ok = await confirmDialog(
      'Удалить тип',
      `Удалить тип «${type.name}»? Мысли этого типа останутся и станут без типа; ` +
        'значения свойств этого типа будут удалены.',
      true,
    );
    if (!ok) return;
    try {
      await etn.types.removeThoughtType(networkId, type.id, type.version, true);
      await refreshThoughtTypes();
      scheduleRefresh();
      onChanged();
    } catch (err) {
      errorDialog('Удалить тип', err);
    }
  }

  showDialog({
    title: 'Типы мыслей',
    body,
    width: 640,
    buttons: [{ label: 'Закрыть', primary: true }],
  });
  void reload();
}

// ---------------------------------------------------------------------------
// Parent picker (L21) — shared by both type editors
// ---------------------------------------------------------------------------

/**
 * The parent-picker combobox of a type editor. Options exclude the root type
 * (it is represented by the single «без родителя» entry — attaching under
 * the root is the same thing, 08-ui-spec.md §8.1), the edited type itself,
 * its descendants and any parent that would push the tree past
 * {@link MAX_TYPE_DEPTH} levels. The full tree is expanded on open; typing
 * filters it to matching rows. Rows carry the same icon/style (thoughts) or
 * line swatch (links) as the other type lists.
 */
function buildParentPicker(opts: {
  kinds: 'thought' | 'link';
  /** The edited type (null while it is being created). */
  currentId: () => string | null;
  /** Current parent id; the root id is normalized to `null` («без родителя»). */
  value: string | null;
  onChange: (parentId: string | null) => void;
}): { root: HTMLElement } {
  const { kinds, currentId, value, onChange } = opts;
  const types = (): typeof store.state.thoughtTypes | typeof store.state.linkTypes =>
    kinds === 'thought' ? store.state.thoughtTypes : store.state.linkTypes;
  const rootId = types().find((t) => t.is_root)?.id ?? null;
  const combo = createTypeCombobox({
    options: () => {
      // Candidate parents: every type except the root, the edited one and its
      // descendants; the depth cap must hold for the resulting subtree.
      const allowed = (id: string): boolean => {
        if (id === rootId) return false;
        const selfId = currentId();
        if (selfId !== null) {
          if (id === selfId) return false;
          if (subtreeTypeIds(types(), selfId).has(id)) return false;
        }
        const subtree = selfId !== null ? subtreeHeight(types(), selfId) : 1;
        return typeDepth(types(), id) + subtree <= MAX_TYPE_DEPTH;
      };
      if (kinds === 'thought') {
        return orderedTypeRows(store.state.thoughtTypes)
          .filter((row) => allowed(row.type.id))
          .map((row) => ({
            id: row.type.id,
            label: row.type.name,
            parent_id: row.type.parent_id,
            depth: row.depth,
            has_children: row.hasChildren,
            selectable: true,
            icon: { icon: row.type.icon, kind: row.type.icon_kind },
            style: {
              fg: row.type.fg_color,
              bg: row.type.bg_color,
              bold: row.type.font_bold ?? false,
              italic: row.type.font_italic ?? false,
              underline: row.type.font_underline ?? false,
              strike: row.type.font_strike ?? false,
            },
          }));
      }
      return orderedTypeRows(store.state.linkTypes)
        .filter((row) => allowed(row.type.id))
        .map((row) => {
          const line = resolveLinkTypeVisual(store.state.linkTypes, row.type.id);
          return {
            id: row.type.id,
            label: `${row.type.name_forward} / ${row.type.name_reverse}`,
            parent_id: row.type.parent_id,
            depth: row.depth,
            has_children: row.hasChildren,
            selectable: true,
            line: { color: line.color, style: line.style, width: line.width },
          };
        });
    },
    // The root id is not an option — normalize it to the «без родителя» entry.
    value: value !== null && value === rootId ? null : value,
    placeholder: 'без родителя',
    emptyLabel: 'без родителя',
    expandAll: true,
    onChange,
  });
  return { root: combo.root };
}

/**
 * Extra options of the type editors ({@link showThoughtTypeEditor},
 * {@link showLinkTypeEditor}) for the quick type creation flow: the type
 * combobox passes the typed query so the new type's name starts prefilled.
 */
export interface TypeEditorExtras {
  /** Prefills the name of a NEW type (its forward name for link types). */
  initialName?: string;
}

/**
 * Opens the thought-type editor; `type === null` edits a NEW type (L6/L21).
 *
 * One and the same form for a new and an existing type (task «Улучшить диалог
 * редактирования типов мыслей и связей»): the icon, colours/font style,
 * comment template, parent and the own property definitions are editable
 * right away — nothing is inert — and nothing touches the server until
 * «Применить и закрыть» is pressed. «Отмена» (also Esc/×/backdrop) closes the
 * dialog discarding the whole draft; no type is created on that path. The
 * inherited-default overrides of an existing type keep their own explicit
 * «Применить»/«Сбросить» buttons inside their small dialog (as before).
 * Reparenting validation is unchanged: the parent picker filters
 * cycles/depth client-side and the server re-checks on apply.
 *
 * `extras.initialName` prefills the name of a new type (the type-combobox
 * «Создать новый» row). The returned promise resolves when the dialog closes:
 * with the id of the type created in this session, or `null` when the dialog
 * closed without creating one (also for an existing type).
 */
export function showThoughtTypeEditor(
  type: ThoughtType | null,
  onChanged: () => void,
  extras?: TypeEditorExtras,
): Promise<string | null> {
  const networkId = requireNetworkId();
  // The type as last seen by the SERVER: the initial one, the freshly created
  // one, or the patched one after a successful apply (a failed apply keeps it
  // at the last consistent state so a retry re-diffs correctly).
  let current: ThoughtType | null = type;
  // The id of the type created in this session — handed to the caller when
  // the dialog closes.
  let createdId: string | null = null;
  const errorLine = span('', 'error-text');
  const body = div('form-stack');

  // Duplicate-name guard: type names are unique ignoring case (08-ui-spec.md
  // §8.4). The catalogue is loaded once on open; the server re-checks on apply.
  const DUP_NAME_MSG = 'Тип с таким именем уже существует.';
  let allTypes: ThoughtType[] = [];
  let applyBtn: HTMLButtonElement | null = null;

  // ---- The staged draft: every editable field, applied only on demand ----
  const draft = {
    name: type?.name ?? extras?.initialName ?? '',
    icon: type?.icon ?? null,
    icon_kind: type?.icon_kind ?? 'emoji',
    fg_color: type?.fg_color ?? null,
    bg_color: type?.bg_color ?? null,
    font_bold: type?.font_bold ?? null,
    font_italic: type?.font_italic ?? null,
    font_underline: type?.font_underline ?? null,
    font_strike: type?.font_strike ?? null,
    parent_id: type !== null && type.parent_id !== null ? type.parent_id : null,
    description: type?.description ?? '',
  };
  /** Draft of the comment template (staged like everything else). */
  let templateMd = type?.comment_template_md ?? '';

  // Top row: icon · name · settings (⚙) — all active from the very start.
  const topRow = div('editor-top-row');
  const iconBox = el('button', 'editor-icon-box') as HTMLButtonElement;
  iconBox.type = 'button';
  setTooltip(iconBox, 'Иконка типа');
  const renderIcon = (): void => {
    applyThoughtIcon(iconBox, { icon: draft.icon, icon_kind: draft.icon_kind, type_id: null });
  };
  renderIcon();
  iconBox.addEventListener('click', () => {
    showIconDialog({
      current: { icon: draft.icon, kind: draft.icon_kind },
      onPick: (result) => {
        draft.icon = result.icon;
        draft.icon_kind = result.kind;
        renderIcon();
        return Promise.resolve(true);
      },
    });
  });
  const nameInput = el('input', 'text-input');
  nameInput.type = 'text';
  nameInput.value = draft.name;
  nameInput.maxLength = 200;
  nameInput.placeholder = 'Название типа (обязательно)';
  const settingsBtn = button('', openStyle, 'icon-btn', 'Настройки типа');
  settingsBtn.append(svgIcon('settings', 14));
  topRow.append(iconBox, nameInput, settingsBtn);
  body.append(topRow);

  // Parent picker (L21). The root type has no parent; the picked value is
  // staged and re-checked by the server on apply (a type in use cannot be
  // reparented, no cycles, max 4 levels).
  const parentField = div('field');
  const parentLabel = el('p', 'muted', 'Родитель (наследование свойств и стиля)');
  parentLabel.style.margin = '8px 0 2px';
  if (type?.is_root === true) {
    const rootNote = el('p', 'muted', 'Корневой тип — родителя не имеет.');
    rootNote.style.margin = '0';
    parentField.append(rootNote);
  } else {
    const picker = buildParentPicker({
      kinds: 'thought',
      currentId: () => current?.id ?? null,
      value: draft.parent_id,
      onChange: (parentId) => {
        draft.parent_id = parentId;
        if (current === null) props.refreshPreview();
      },
    });
    parentField.append(picker.root);
  }
  body.append(parentField);

  // Comment (type description / usage rules) — placeholder only, no label.
  const descArea = el('textarea', 'textarea-input');
  descArea.value = draft.description;
  descArea.rows = 3;
  descArea.placeholder = 'Комментарий: описание типа, правила применения…';
  body.append(descArea);

  // Шаблон постоянного комментария мысли (08-ui-spec.md §8.4, 02-data-model.md
  // §3.3). Поле — как у всех markdown-полей приложения: HTML-просмотр по
  // умолчанию, двойной клик переключает в CodeMirror-редактор, blur или
  // Ctrl+Enter сохраняет, Esc — отмена. С задачи «Улучшить диалог…» шаблон
  // тоже черновой: поле коммитит текст локально (onSave без сети), а на сервер
  // markdown уходит одним пакетом по «Применить и закрыть».
  const templateLabel = el(
    'p',
    'muted',
    'Шаблон комментария (применяется к пустому комментарию мысли при создании/назначении типа)',
  );
  templateLabel.style.margin = '8px 0 2px';
  body.append(templateLabel);
  /** Last markdown committed inside the field (Esc reverts the mirror to it). */
  let committedTemplateMd = templateMd;
  body.append(
    createMarkdownField({
      md: templateMd,
      html: renderTemplateHtml(templateMd),
      onInput: (md) => {
        templateMd = md;
      },
      onSave: async (md) => {
        templateMd = md;
        committedTemplateMd = md;
        return renderTemplateHtml(md);
      },
      onCancel: () => {
        templateMd = committedTemplateMd;
      },
      minRows: 5,
    }),
  );

  body.append(errorLine);

  // Property sections (own staged + inherited). For a new type the inherited
  // preview follows the picked parent; for an existing type the inherited
  // defaults keep their explicit per-dialog «Применить» (as before).
  const props = buildStagedPropertySection({
    networkId,
    ownerType: 'thought_type',
    typeId: type?.id ?? null,
    previewParentId: () =>
      draft.parent_id ?? findRootType(store.state.thoughtTypes)?.id ?? null,
    onOverrideApplied: onChanged,
  });
  body.append(props.root);

  // Блок «Метаданные» — автор, даты, id сущности (задача 04cd9794). Показываем
  // только когда редактируется существующий тип; для нового id ещё не
  // присвоен и блок ограничится подсказкой.
  if (type !== null) {
    body.append(buildMetadataRowsFromType(type));
  }

  /** Existing type with the same normalized name as `name` (self excluded). */
  function nameClash(name: string): ThoughtType | null {
    const key = typeNameKey(name);
    return (
      allTypes.find((t) => t.id !== (current?.id ?? null) && typeNameKey(t.name) === key) ?? null
    );
  }

  /** Live duplicate check on the name field: warn + disable the apply button. */
  function revalidateName(): void {
    if (nameClash(nameInput.value) !== null) {
      errorLine.textContent = DUP_NAME_MSG;
      if (applyBtn !== null) applyBtn.disabled = true;
    } else {
      if (errorLine.textContent === DUP_NAME_MSG) errorLine.textContent = '';
      if (applyBtn !== null) applyBtn.disabled = false;
    }
  }

  // Fresh catalogue for the live duplicate check (the server re-checks anyway).
  void etn.types
    .listThoughtTypes(networkId)
    .then((list) => {
      allTypes = list;
      revalidateName();
    })
    .catch(() => {});
  // Keep the staged draft in sync with the inputs on every keystroke.
  // Without these listeners `draft.name` and `draft.description` are
  // initialised once and never updated, so any payload builder that reads
  // `draft.*` (e.g. `buildCreateTypeInput` for the create path) would push a
  // stale value to the server — the regression tracked in card
  // `aa32ab49-…` («Создание типа мысли: 422 «name обязателен»…»): after
  // `f178f8f` + `e59c258` the create payload took `name` from `draft.name`
  // (= `''`) instead of the live `nameInput.value`.
  // The PATCH path of `apply()` reads `nameInput.value.trim()` directly, so
  // it does not strictly need the listener — adding it anyway keeps the
  // staged-form pattern uniform and prevents the same class of bug if a
  // future field is wired through `draft.*` only.
  nameInput.addEventListener('input', () => {
    draft.name = nameInput.value;
    revalidateName();
  });
  descArea.addEventListener('input', () => {
    draft.description = descArea.value;
  });

  /** Applies the whole draft to the server, then closes the dialog. */
  async function apply(close: () => void): Promise<void> {
    const name = nameInput.value.trim();
    if (name === '') {
      errorLine.textContent = 'Название типа обязательно.';
      return;
    }
    if (nameClash(name) !== null) {
      errorLine.textContent = DUP_NAME_MSG;
      return;
    }
    const description = descArea.value.trim();
    const nextTemplate = templateMd.trim() === '' ? null : templateMd;
    try {
      if (current === null) {
        // New type: one create carries every staged field at once. The
        // server treats `font_*` / `fg_color` / `bg_color` / `icon` as
        // `null`-or-value (inherit from parent when null), and `font_*` are
        // strictly `boolean | null` — sending `null` is legal, but the
        // minimal payload (only the fields the user actually set) keeps the
        // create free of obvious "null on first sight" noise. Each field is
        // added only when it differs from the create-time default (null for
        // strings/colours/font flags, empty description, no template).
        const input = buildCreateTypeInput(draft, description, nextTemplate);
        current = await etn.types.createThoughtType(networkId, input);
        createdId = current.id;
      } else {
        // Existing type: patch only the changed fields (If-Match version).
        const input: ThoughtTypeUpdateInput = {};
        if (name !== current.name) input.name = name;
        if (draft.parent_id !== (current.parent_id ?? null)) input.parent_id = draft.parent_id;
        if (draft.icon !== current.icon) {
          input.icon = draft.icon;
          input.icon_kind = draft.icon_kind;
        }
        if (draft.fg_color !== current.fg_color) input.fg_color = draft.fg_color;
        if (draft.bg_color !== current.bg_color) input.bg_color = draft.bg_color;
        if (draft.font_bold !== current.font_bold) input.font_bold = draft.font_bold;
        if (draft.font_italic !== current.font_italic) input.font_italic = draft.font_italic;
        if (draft.font_underline !== current.font_underline) input.font_underline = draft.font_underline;
        if (draft.font_strike !== current.font_strike) input.font_strike = draft.font_strike;
        if ((description === '' ? null : description) !== current.description) {
          input.description = description === '' ? null : description;
        }
        if (nextTemplate !== (current.comment_template_md ?? null)) {
          input.comment_template_md = nextTemplate;
        }
        if (Object.keys(input).length > 0) {
          current = await etn.types.updateThoughtType(networkId, current.id, input, current.version);
        }
      }
      // Staged property definitions go after the type itself exists.
      if (!(await props.applyChanges(current.id))) return; // error shown, dialog stays
      await refreshThoughtTypes();
      scheduleRefresh();
      onChanged();
      close();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  function openStyle(): void {
    showThoughtStyleDialog({
      resolved: {
        fg: draft.fg_color,
        bg: draft.bg_color,
        bold: draft.font_bold ?? false,
        italic: draft.font_italic ?? false,
        underline: draft.font_underline ?? false,
        strike: draft.font_strike ?? false,
      },
      mode: 'type',
      // Patches the local draft only; the server sees it on «Применить и
      // закрыть». `null` still means «inherit from the parent type» (L21).
      onApply: (patch) => {
        if (patch.icon !== undefined) draft.icon = patch.icon;
        if (patch.fg_color !== undefined) draft.fg_color = patch.fg_color;
        if (patch.bg_color !== undefined) draft.bg_color = patch.bg_color;
        if (patch.font_bold !== undefined) draft.font_bold = patch.font_bold;
        if (patch.font_italic !== undefined) draft.font_italic = patch.font_italic;
        if (patch.font_underline !== undefined) draft.font_underline = patch.font_underline;
        if (patch.font_strike !== undefined) draft.font_strike = patch.font_strike;
        return Promise.resolve(true);
      },
    });
  }

  /** Markdown → HTML для просмотра шаблона. Пустой ввод — пусто. */
  function renderTemplateHtml(md: string): string {
    if (md.trim() === '') return '';
    return renderMarkdown(md);
  }

  // The promise resolves on dialog close (`onClose` fires from the backdrop's
  // remove event — Esc, × and both footer buttons all land there).
  return new Promise<string | null>((resolve) => {
    showDialog({
      title: type === null ? 'Новый тип мысли' : 'Тип мысли',
      body,
      width: 560,
      buttons: [
        { label: 'Отмена' },
        {
          label: 'Применить и закрыть',
          primary: true,
          keepOpen: true,
          onClick: (close) => void apply(close),
          ref: (btn) => {
            applyBtn = btn;
          },
        },
      ],
      onMount: () => nameInput.focus(),
      onClose: () => resolve(createdId),
    });
  });
}

// ---------------------------------------------------------------------------
// Property-definition tables + property dialog (both type kinds)
// ---------------------------------------------------------------------------

/**
 * Handle of a staged property section — the type editor applies it on demand.
 */
interface StagedPropertySection {
  root: HTMLElement;
  /** Re-reads the inherited preview of a NEW type after its picked parent
   *  changed (existing types keep their own inherited list). */
  refreshPreview(): void;
  /**
   * Sends the staged own-binding changes of the draft to `typeId`; resolves
   * `false` — with the error already rendered — when the server rejected
   * something. The snapshot is updated after every applied op, so a retry
   * re-diffs only what is still missing.
   */
  applyChanges(typeId: string): Promise<boolean>;
}

/**
 * Builds the staged property sections of a type editor (0.6.5, task
 * «Клиент: редактор типа подключает свойство из справочника»).
 *
 * The own-bindings table is a list of {@link DraftProperty} rows. The user
 * adds bindings via «Добавить свойство» — a dialog over the network
 * property registry (search, pick an existing one OR create a brand-new one
 * and attach in the same server-side transaction). The role of an existing
 * binding is edited locally: `required` toggle and ▲/▼ reorder. The
 * property's NATURE (name, value type, config, description) is not editable
 * here — the table's «✎» button opens the property manager dialog with a
 * banner that flags the network-wide impact. «✕» unbinds with a
 * confirmation that values stay as values-outside-type.
 *
 * Reconciliation with the server happens in
 * {@link StagedPropertySection.applyChanges} on the editor's
 * «Применить и закрыть»:
 *   1. unbind removed bindings,
 *   2. attach new ones (registry rows are created through the shared
 *      property editor first),
 *   3. set-role patches for `required` toggles,
 *   4. one trailing reorder.
 *
 * The inherited section is read-only with its explicit per-dialog
 * default-override buttons applied immediately (unchanged behaviour — the
 * small dialog owns its own «Применить»). For a NEW type
 * (`typeId = null`) the own draft starts empty and the inherited section
 * is a live preview of whatever the picked parent will pass down
 * ({@link opts.previewParentId}, re-read on reparent).
 */
function buildStagedPropertySection(opts: {
  networkId: string;
  ownerType: TypeOwnerType;
  /** An existing type's id, or null while a NEW type is being edited. */
  typeId: string | null;
  /** For a new type: the type whose effective properties it will inherit. */
  previewParentId: () => string | null;
  /** Fired after an inherited default override was applied on the server. */
  onOverrideApplied?: () => void;
}): StagedPropertySection {
  const { networkId, ownerType, typeId, previewParentId, onOverrideApplied } = opts;
  const box = div('form-stack');
  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '220px';
  // The first load often starts before the dialog mounts this box — show the
  // placeholder up front instead of a blank gap.
  tableWrap.append(el('span', 'muted', 'Загрузка…'));
  const errorLine = span('', 'error-text');
  const label = el('p', 'muted', 'Свойства');
  label.style.margin = '8px 0 2px';
  box.append(label, tableWrap, errorLine);
  box.append(
    button(
      'Добавить свойство',
      () => void openAttachPropertyDialog(),
      'btn small',
      'Подключить свойство из справочника сети',
    ),
  );

  /** Server-side snapshot of the type's OWN bindings (kept in sync after
   *  every applied op — the base the next diff is computed against). */
  let originalOwn: PropertyDefinition[] = [];
  /** The staged draft rows, in the drafted order. */
  let ownDraft: DraftProperty[] = [];
  /** Own bindings removed from the draft during this session. */
  let deletedIds: string[] = [];
  /** Inherited bindings shown below the own table (an existing type: its
   *  own inherited set; a new type: the picked parent's whole set). */
  let inherited: EffectiveTypeProperty[] = [];
  /** Whether the user has staged any own-row change — after that, reloads
   *  must not re-seed the draft from the server snapshot. */
  let draftTouched = false;
  /** Snapshot of the registry rows (id → RegistryRow) used by the attach
   *  dialog so the «Создать и подключить» path can prefill from a typed
   *  query without a second registry round-trip. */
  let registryCache: Map<string, RegistryRow> = new Map();

  /**
   * «Добавить свойство» dialog: pick an existing registry property (или
   * создать новое в общем редакторе свойства и затем выбрать его). Returns
   * the staged row the caller appends to {@link ownDraft} (or `null` when
   * the user cancelled).
   */
  async function openAttachPropertyDialog(): Promise<void> {
    // The warning's «descendants» check needs the edited type's id and name;
    // both exist only for an already-created type.
    const editedType =
      typeId === null
        ? null
        : ownerType === 'thought_type'
          ? store.state.thoughtTypes.find((t) => t.id === typeId) ?? null
          : store.state.linkTypes.find((t) => t.id === typeId) ?? null;
    const picked = await openAttachDialog({
      networkId,
      ownerType,
      types: pickTypeList(),
      typeId,
      editedTypeName:
        editedType === null
          ? null
          : 'name' in editedType
            ? editedType.name
            : editedType.name_forward,
      existingPropertyIds: new Set(ownDraft.map((d) => d.property_id)),
      inheritedPropertyIds: new Set(inherited.map((d) => d.property_id)),
    });
    if (picked === null) return;
    ownDraft = [...ownDraft, picked];
    draftTouched = true;
    render();
  }

  /** The list of types that the «already bound to a descendant» warning
   *  walks through when the user picks a property the server will dedupe
   *  from the subtree. `null` while the type is being created — the editor
   *  has no id yet, so the warning would be empty anyway. */
  function pickTypeList(): ThoughtType[] | LinkType[] | null {
    if (typeId === null) return null;
    return ownerType === 'thought_type' ? store.state.thoughtTypes : store.state.linkTypes;
  }

  /** Opens the default-override dialog of an inherited property (L21) —
   *  unchanged instant behaviour, the small dialog owns its «Применить». */
  function showOverrideDialog(def: EffectiveTypeProperty): void {
    openDefaultOverrideDialog({
      networkId,
      ownerType,
      typeId: typeId as string,
      def,
      onDone: () => {
        onOverrideApplied?.();
        void reload();
      },
    });
  }

  /** Opens the description-override dialog of an inherited property — the
   *  description analogue of {@link showOverrideDialog}. */
  function showDescriptionOverrideDialog(def: EffectiveTypeProperty): void {
    openDescriptionOverrideDialog({
      networkId,
      ownerType,
      typeId: typeId as string,
      def,
      onDone: () => {
        onOverrideApplied?.();
        void reload();
      },
    });
  }

  /** Drops the type's description override (back to the ancestor's own). */
  async function clearDescriptionOverride(def: EffectiveTypeProperty): Promise<void> {
    try {
      await etn.types.setPropertyDescriptionOverride(networkId, ownerType, typeId as string, def.id, null);
      onOverrideApplied?.();
      await reload();
    } catch (err) {
      errorDialog('Сбросить переопределение описания', err);
    }
  }

  /** Moves a draft row one slot up/down (the order is applied on save). */
  function move(rowId: string, delta: -1 | 1): void {
    const from = ownDraft.findIndex((d) => d.id === rowId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ownDraft.length) return;
    ownDraft.splice(to, 0, ...ownDraft.splice(from, 1));
    draftTouched = true;
    render();
  }

  /** Toggles the `required` flag of a draft row (applied on «Применить и
   *  закрыть» — the table does not write the server mid-edit). */
  function setRequired(rowId: string, required: boolean): void {
    const row = ownDraft.find((d) => d.id === rowId);
    if (row === undefined || row.required === required) return;
    row.required = required;
    draftTouched = true;
    render();
  }

  /** Opens the property manager dialog on the registry row that backs this
   *  binding. The dialog itself warns about the network-wide impact. */
  function editNature(row: DraftProperty): void {
    const reg = registryCache.get(row.property_id);
    if (reg === undefined) return;
    openPropertyManagerEditor(reg, () => void reload());
  }

  /** Stages the unbinding of one own row (persisted by «Применить и
   *  закрыть»). Values are NOT deleted — they become values-outside-type. */
  async function unbind(row: DraftProperty): Promise<void> {
    const ok = await confirmDialog(
      'Отключить свойство',
      `Отключить свойство «${row.key}» от типа? Значения останутся у мыслей и связей ` +
        'и будут показаны в группе «Свойства вне типа».',
      true,
    );
    if (!ok) return;
    if (!row.isNew) deletedIds = [...deletedIds, row.id];
    ownDraft = ownDraft.filter((d) => d.id !== row.id);
    draftTouched = true;
    render();
  }

  /** Renders the staged own table + the inherited table. */
  function render(): void {
    tableWrap.replaceChildren();

    if (inherited.length > 0) {
      const inhLabel = el(
        'p',
        'muted',
        typeId === null
          ? 'Унаследованные свойства (передадутся от выбранного родителя)'
          : 'Унаследованные свойства (тип значения не меняется; переопределяются значение по умолчанию и описание; обязательность задаётся на типе, который подключил свойство)',
      );
      inhLabel.style.margin = '0 0 2px';
      tableWrap.append(inhLabel);
      const inhTable = el('table', 'table-list prop-table');
      const inhHead = el('thead');
      const inhHeadRow = el('tr');
      inhHeadRow.append(
        el('th', undefined, 'Имя'),
        el('th', undefined, 'Тип'),
        el('th', undefined, 'Источник'),
        el('th', undefined, 'По умолчанию'),
        el('th'),
      );
      inhHead.append(inhHeadRow);
      inhTable.append(inhHead);
      const inhBody = el('tbody');
      for (const def of inherited) {
        const row = el('tr');
        const nameCell = el('td', undefined, def.key);
        if (def.description !== null) {
          setTooltip(nameCell, def.description);
          nameCell.append(span(' ⓘ', 'muted'));
        }
        row.append(nameCell);
        row.append(el('td', 'muted', VALUE_TYPE_LABELS[def.value_type]));
        row.append(el('td', 'muted', def.defined_on_name));
        row.append(
          el(
            'td',
            'muted',
            formatDefault(def.default_value) +
              (def.overridden_here ? ' ●' : '') +
              (def.description_overridden ? ' ◆' : ''),
          ),
        );
        const actions = el('td');
        actions.style.whiteSpace = 'nowrap';
        // Override buttons exist only for an already-created type: the
        // override row needs a server id to attach to.
        if (typeId !== null && def.value_type !== 'thought_ref') {
          actions.append(
            button('по умолчанию…', () => showOverrideDialog(def), 'btn small', 'Переопределить значение по умолчанию'),
          );
        }
        if (typeId !== null) {
          actions.append(
            button('описание…', () => showDescriptionOverrideDialog(def), 'btn small', 'Переопределить описание свойства'),
          );
        }
        if (typeId !== null && def.overridden_here) {
          actions.append(
            button('сбросить', () => void clearOverride(def), 'btn small', 'Сбросить переопределение'),
          );
        }
        if (typeId !== null && def.description_overridden) {
          actions.append(
            button('сбросить ◆', () => void clearDescriptionOverride(def), 'btn small', 'Сбросить переопределение описания'),
          );
        }
        row.append(actions);
        inhBody.append(row);
      }
      inhTable.append(inhBody);
      tableWrap.append(inhTable);
      const ownLabel = el('p', 'muted', 'Свойства типа');
      ownLabel.style.margin = '8px 0 2px';
      tableWrap.append(ownLabel);
    }

    const table = el('table', 'table-list prop-table');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th', undefined, 'Имя'),
      el('th', undefined, 'Тип'),
      el('th', undefined, 'Обязательное'),
      el('th'),
    );
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    for (const row of ownDraft) {
      const tr = el('tr');
      const nameCell = el('td', undefined, row.key);
      if (row.description !== null) {
        setTooltip(nameCell, row.description);
        nameCell.append(span(' ⓘ', 'muted'));
      }
      tr.append(nameCell);
      tr.append(el('td', 'muted', VALUE_TYPE_LABELS[row.value_type]));
      const requiredCell = el('td');
      const requiredCheck = el('input') as HTMLInputElement;
      requiredCheck.type = 'checkbox';
      requiredCheck.checked = row.required;
      requiredCheck.addEventListener('change', () => {
        setRequired(row.id, requiredCheck.checked);
      });
      requiredCell.append(requiredCheck);
      tr.append(requiredCell);
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      actions.append(
        button('▲', () => move(row.id, -1), 'btn small', 'Выше'),
        button('▼', () => move(row.id, 1), 'btn small', 'Ниже'),
        button(
          '✎',
          () => editNature(row),
          'btn small',
          'Править природу свойства (имя, тип значения, описание) — действует во всех типах сразу',
        ),
        button('✕', () => void unbind(row), 'btn small', 'Отключить свойство от типа'),
      );
      tr.append(actions);
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.append(table);
    if (ownDraft.length === 0 && inherited.length === 0) {
      tableWrap.append(el('p', 'muted', 'У типа нет свойств.'));
    }
  }

  /** Drops the type's default-value override (back to the ancestor default). */
  async function clearOverride(def: EffectiveTypeProperty): Promise<void> {
    try {
      await etn.types.setPropertyDefaultOverride(networkId, ownerType, typeId as string, def.id, null);
      onOverrideApplied?.();
      await reload();
    } catch (err) {
      errorDialog('Сбросить переопределение', err);
    }
  }

  /** Loads (or reloads) the bindings from the server, plus the registry
   *  snapshot the «✎» button uses to jump into the property manager. */
  let everMounted = false;
  async function reload(): Promise<void> {
    // The table is built BEFORE its dialog mounts it, so the first reload runs
    // while still detached and must proceed. Skip only bodies that were
    // mounted and then discarded (the dialog closed or a newer body took over).
    if (everMounted && !box.isConnected) return;
    const sourceId = typeId ?? previewParentId();
    if (sourceId === null) {
      // No catalogue at all (mid-migration) — show the empty state rather
      // than a forever-«Загрузка…» placeholder.
      render();
      return;
    }
    try {
      const [defs, registryRows] = await Promise.all([
        etn.types.listTypeProperties(networkId, ownerType, sourceId),
        // The registry powers the «✎» button (jump into the property manager);
        // it is also the source of truth for the attach dialog's «Создать и
        // подключить» suggestion when the user types a name the registry
        // already has. Cheap call (flat list).
        etn.propertyRegistry.list(networkId),
      ]);
      registryCache = new Map(registryRows.map((row) => [row.id, row]));
      if (typeId !== null) {
        // An existing type: own rows seed the draft (once), inherited shown.
        originalOwn = defs.filter((d) => !d.inherited);
        inherited = defs.filter((d) => d.inherited);
        if (ownDraft.length === 0 && deletedIds.length === 0 && !draftTouched) {
          ownDraft = draftPropertiesFrom(originalOwn);
        }
      } else {
        // A new type: EVERYTHING the parent carries will be inherited.
        inherited = defs;
      }
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    if (box.isConnected) everMounted = true;
    render();
  }

  /**
   * Applies the staged own-binding changes to `targetId` (the created or
   * existing type). See {@link StagedPropertySection.applyChanges}. The
   * order matches the planner: unbinds first (so a freed binding never
   * collides with an attach of the same property), then
   * attaches/creates, then `set-role` patches, one trailing reorder.
   */
  async function applyChanges(targetId: string): Promise<boolean> {
    const plan = planPropertyDiff(originalOwn, ownDraft, deletedIds);
    for (const op of plan.ops) {
      try {
        if (op.kind === 'unbind') {
          await etn.types.removeTypeProperty(networkId, ownerType, targetId, op.id);
          originalOwn = originalOwn.filter((d) => d.id !== op.id);
          ownDraft = ownDraft.filter((d) => d.id !== op.id);
        } else if (op.kind === 'attach') {
          const created = await etn.types.createTypeProperty(
            networkId,
            ownerType,
            targetId,
            opToAttachInput(op),
          );
          // Bind the placeholder id to the real server id, so a retry after a
          // later failure does not try to create the same row twice.
          const row = ownDraft.find((d) => d.id === op.draftId);
          if (row !== undefined) {
            row.id = created.id;
            row.isNew = false;
            // The server returns the resolved nature in the binding payload —
            // refresh the immutable snapshot so the table keeps showing what
            // the registry now holds.
            row.property_id = created.property_id;
            row.key = created.key;
            row.value_type = created.value_type;
            row.config = created.config;
            row.description = created.description;
          }
          originalOwn = [...originalOwn, created];
        } else {
          await etn.types.updateTypeProperty(networkId, ownerType, targetId, op.id, {
            required: op.required,
          });
          originalOwn = originalOwn.map((d) =>
            d.id === op.id ? ({ ...d, required: op.required } as PropertyDefinition) : d,
          );
        }
      } catch (err) {
        errorLine.textContent = errText(err);
        render();
        return false;
      }
    }
    if (plan.needsReorder) {
      try {
        await etn.types.reorderTypeProperties(
          networkId,
          ownerType,
          targetId,
          ownDraft.map((d) => d.id),
        );
      } catch (err) {
        errorLine.textContent = errText(err);
        return false;
      }
    }
    deletedIds = [];
    errorLine.textContent = '';
    render();
    // Refresh the inherited view too: reparenting on the same apply may have
    // changed what this type receives from its ancestors.
    if (typeId !== null) void reload();
    return true;
  }

  void reload();
  return {
    root: box,
    refreshPreview: (): void => {
      if (typeId === null) void reload();
    },
    applyChanges,
  };
}

/**
 * Result of the «Добавить свойство» dialog: a new draft row the caller
 * appends to its own-bindings list (or `null` when the user cancelled).
 * The row is fully resolved — the registry id (`property_id`) and the
 * immutable nature snapshot are both known — so the table can render it
 * without a second registry round-trip.
 */
type AttachDialogResult = DraftProperty;

/**
 * «Добавить свойство» dialog (0.6.5, переработан по итогам приёмки — ошибка
 * «Диалог "Добавить свойство" в редакторе типа: непонятный интерфейс»).
 *
 * One pick list over the network property registry, one search box, two
 * bottom buttons:
 *   * **Выбрать** — attach the highlighted registry property (double-click on
 *     the row and Ctrl+Enter do the same). Properties the type already
 *     carries — own or inherited — stay VISIBLE but marked «подключено» /
 *     «унаследовано» and cannot be picked (the duplicate check up front; the
 *     server re-checks on attach);
 *   * **Добавить** — open the SHARED property editor (the exact dialog the
 *     property manager uses) to create a brand-new registry row; after
 *     «Записать и закрыть» the list refreshes and the fresh property is the
 *     highlighted row, ready to be picked. One editor everywhere — nothing
 *     is created inline any more.
 *
 * Attaching a property some DESCENDANT of the edited type already carries
 * asks first — naming the concrete types and what exactly happens (their own
 * bindings are taken over by inheritance; values never change).
 */
async function openAttachDialog(opts: {
  networkId: string;
  /** The edited type's kind — scopes the usage lookup of the warning. */
  ownerType: TypeOwnerType;
  /** Catalogues used by the «already bound to a descendant» warning. `null`
   *  suppresses the check (the editor is creating a new type that has no
   *  descendants yet). */
  types: readonly ThoughtType[] | readonly LinkType[] | null;
  /** The edited type's id — roots the «descendants already carry it» check.
   *  `null` while a NEW type is being created (no descendants yet). */
  typeId: string | null;
  /** The edited type's display name for warning texts (null for a new type). */
  editedTypeName: string | null;
  /** Property ids the type already carries (own bindings + this session's
   *  staged rows) — shown as «подключено», not pickable. */
  existingPropertyIds: ReadonlySet<string>;
  /** Property ids inherited from the type's ancestors (or the picked parent's
   *  whole set for a new type) — shown as «унаследовано», not pickable. */
  inheritedPropertyIds: ReadonlySet<string>;
}): Promise<AttachDialogResult | null> {
  const { networkId, ownerType, types, typeId, editedTypeName, existingPropertyIds, inheritedPropertyIds } = opts;
  let registryRows: RegistryRow[];
  try {
    registryRows = await etn.propertyRegistry.list(networkId);
  } catch (err) {
    errorDialog('Добавить свойство', err);
    return null;
  }

  return new Promise((resolve) => {
    const searchInput = el('input', 'text-input') as HTMLInputElement;
    searchInput.type = 'text';
    searchInput.placeholder = 'Поиск по имени или описанию…';

    const resultsWrap = div('admin-table-wrap');
    resultsWrap.style.maxHeight = '260px';

    /** The highlighted registry row (a PICKABLE one), or null. */
    let selected: RegistryRow | null = null;

    /** Why a row cannot be picked, or null when it can. */
    const blockReason = (row: RegistryRow): string | null =>
      existingPropertyIds.has(row.id)
        ? 'подключено'
        : inheritedPropertyIds.has(row.id)
          ? 'унаследовано'
          : null;

    /** The registry rows matching the current search query, alphabetical. */
    const visibleRows = (): RegistryRow[] => {
      const fragments = searchInput.value
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter((s) => s.length > 0);
      return registryRows
        .filter((row) => {
          const haystack = `${row.name.toLowerCase()}\n${(row.description ?? '').toLowerCase()}`;
          return fragments.every((f) => haystack.includes(f));
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    };

    const pickableRows = (): RegistryRow[] =>
      visibleRows().filter((row) => blockReason(row) === null);

    /** Moves the `.selected` row class to the current `selected` row (no list
     *  rebuild — a click or an arrow key must not flicker the whole table)
     *  and scrolls it into view. */
    function applySelection(): void {
      const selectedId = selected?.id ?? null;
      for (const tr of resultsWrap.querySelectorAll<HTMLTableRowElement>('tbody tr')) {
        tr.classList.toggle('selected', tr.dataset['propId'] === selectedId);
      }
      resultsWrap
        .querySelector<HTMLTableRowElement>('tr.selected')
        ?.scrollIntoView({ block: 'nearest' });
    }

    /** Re-renders the result list. `preferId` forces the highlight onto that
     *  row (after the shared editor created it); otherwise the CURRENT
     *  selection survives when still visible and pickable, and falls back to
     *  the first pickable row (never null when one exists — «Выбрать» and
     *  Ctrl+Enter always have a target). */
    function rerenderResults(preferId?: string): void {
      const filtered = visibleRows();
      const isSelectable = (row: RegistryRow): boolean =>
        blockReason(row) === null && filtered.some((r) => r.id === row.id);
      if (preferId !== undefined) {
        const preferred = filtered.find((r) => r.id === preferId);
        selected = preferred !== undefined && blockReason(preferred) === null ? preferred : null;
      }
      if (selected === null || !isSelectable(selected)) {
        selected = filtered.find((r) => blockReason(r) === null) ?? null;
      }

      if (filtered.length === 0) {
        resultsWrap.replaceChildren(el('p', 'muted', 'Ничего не найдено.'));
        return;
      }
      const table = el('table', 'table-list');
      const tbody = el('tbody');
      for (const row of filtered) {
        const blocked = blockReason(row);
        const tr = el('tr');
        tr.dataset['propId'] = row.id;
        if (blocked !== null) tr.classList.add('row-disabled');
        const nameCell = el('td', undefined, row.name);
        nameCell.style.whiteSpace = 'nowrap';
        if (row.description !== null) setTooltip(nameCell, row.description);
        const typeCell = el('td', 'muted', VALUE_TYPE_LABELS[row.value_type]);
        const countCell = el('td', 'muted', `в ${row.types_count} типах`);
        countCell.style.textAlign = 'right';
        const markCell = el('td', 'muted', blocked ?? '');
        markCell.style.whiteSpace = 'nowrap';
        tr.append(nameCell, typeCell, markCell, countCell);
        if (blocked === null) {
          tr.addEventListener('click', () => {
            selected = row;
            applySelection();
          });
          tr.addEventListener('dblclick', () => {
            selected = row;
            void choose();
          });
        } else {
          setTooltip(tr, blocked === 'подключено'
            ? 'Свойство уже подключено к этому типу'
            : 'Свойство уже наследуется этим типом от предка');
        }
        tbody.append(tr);
      }
      table.append(tbody);
      resultsWrap.replaceChildren(table);
      applySelection();
    }

    searchInput.addEventListener('input', () => rerenderResults());
    // Keyboard: ↑/↓ moves the highlight over pickable rows. Ctrl+Enter is
    // the dialog stack's built-in «click the primary button» — «Выбрать».
    searchInput.addEventListener('keydown', (event) => {
      const rows = pickableRows();
      if (rows.length === 0) return;
      const at = rows.findIndex((r) => r.id === selected?.id);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        selected = rows[Math.min(rows.length - 1, at + 1)] ?? rows[0]!;
        applySelection();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        selected = rows[Math.max(0, at - 1)] ?? rows[0]!;
        applySelection();
      }
    });

    /** Resolves the dialog with the highlighted pickable row. */
    async function choose(): Promise<void> {
      if (selected === null) return;
      const warning = await warnDescendantBindings(networkId, selected, {
        ownerType,
        types,
        typeId,
        editedTypeName,
      });
      if (warning !== null) {
        const ok = await confirmDialog('Подключить свойство', warning, true);
        if (!ok) return;
      }
      close();
      resolve(attachDraftFromExisting(selected));
    }

    const body = div('form-stack');
    body.append(searchInput, resultsWrap);
    rerenderResults();

    /** Re-fetches the registry (after the shared editor created a row) and
     *  re-renders, highlighting `highlightId` when present. */
    const refreshRegistry = async (highlightId: string | null): Promise<void> => {
      try {
        registryRows = await etn.propertyRegistry.list(networkId);
      } catch {
        /* keep the stale list — the editor already reported its own error */
      }
      if (highlightId !== null) rerenderResults(highlightId);
      else rerenderResults();
    };

    const close = showDialog({
      title: 'Добавить свойство',
      body,
      width: 560,
      buttons: [
        { label: 'Отмена' },
        {
          label: 'Добавить…',
          keepOpen: true,
          onClick: () => {
            openPropertyManagerEditor(
              null,
              () => void refreshRegistry(null),
              // Highlight the fresh row so one more Enter/«Выбрать» attaches it.
              (created) => void refreshRegistry(created.id),
            );
          },
        },
        {
          label: 'Выбрать',
          primary: true,
          keepOpen: true,
          onClick: () => void choose(),
        },
      ],
      onMount: () => searchInput.focus(),
    });
  });
}

/** Builds the draft row for «attach existing» — `property_id` set, nature
 *  snapshot copied from the registry row. */
function attachDraftFromExisting(row: RegistryRow): DraftProperty {
  return {
    id: nextDraftPropertyId(),
    isNew: true,
    property_id: row.id,
    required: false,
    key: row.name,
    value_type: row.value_type,
    config: row.config,
    description: row.description,
  };
}

/**
 * Returns a human-readable warning when attaching `row` will take over the
 * bindings of the edited type's DESCENDANTS, or `null` when nothing like
 * that happens (the common case — most picks are warning-free).
 *
 * The server's subtree dedupe is automatic (0.6.5, 03-server-api.md §8):
 * attaching a property a descendant already carries is allowed, the
 * descendant's own binding is dropped in the same transaction, and the
 * stored values never change — from that point the descendant inherits the
 * property from the edited type. The warning names the concrete types and
 * spells out both what disappears (their own «Свойства типа» row) and what
 * never changes (the values), so the user can decide knowingly.
 *
 * Exact check (0.6.5 приёмка): the property's usage is fetched and crossed
 * with the edited type's subtree — the previous types_count-based heuristic
 * warned on EVERY property bound anywhere, even when no descendant carried
 * it.
 */
async function warnDescendantBindings(
  networkId: string,
  row: RegistryRow,
  ctx: {
    ownerType: TypeOwnerType;
    types: readonly ThoughtType[] | readonly LinkType[] | null;
    /** The edited type's id — `null` while a NEW type is being created. */
    typeId: string | null;
    /** The edited type's display name (null for a new type). */
    editedTypeName: string | null;
  },
): Promise<string | null> {
  const { ownerType, types, typeId, editedTypeName } = ctx;
  // A brand-new type has no descendants to take over.
  if (types === null || typeId === null || editedTypeName === null) return null;
  // Fast pre-filter: nobody bound the property at all — no request needed.
  if (row.types_count === 0) return null;
  const descendants = subtreeTypeIds(types, typeId);
  descendants.delete(typeId);
  if (descendants.size === 0) return null;
  let usage: Awaited<ReturnType<typeof etn.propertyRegistry.usage>>;
  try {
    usage = await etn.propertyRegistry.usage(networkId, row.id);
  } catch {
    // No usage data — do not scare the user; the server re-checks on attach.
    return null;
  }
  const names = usage.bindings
    .filter((b) => b.owner_type === ownerType && descendants.has(b.owner_id))
    .map((b) => b.owner_name);
  if (names.length === 0) return null;
  const nameList = names.map((n) => `«${n}»`).join(', ');
  return (
    `Свойство «${row.name}» подключено к типам-потомкам ${nameList}. ` +
    `Если подключить его к типу «${editedTypeName}», у потомков снимутся их собственные ` +
    'подключения этого свойства (они станут наследовать его от вашего типа). ' +
    'Значения свойств в мыслях и связях при этом не изменятся.'
  );
}

/** Human-readable default value for a table cell. */
function formatDefault(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  return String(value);
}

/**
 * Builds an input for a "default value" field matching a value type, reading
 * its current value into `read()`. Thought-ref defaults are not supported — a
 * default target makes no sense across thoughts. Shared with the inherited
 * default-override dialog (L21).
 */
function defaultInputFor(
  valueType: PropertyValueType,
  current: unknown,
  read: (value: unknown) => void,
): HTMLElement {
  switch (valueType) {
    case 'text':
    case 'url': {
      const input = el('input', 'text-input');
      input.type = 'text';
      input.value = typeof current === 'string' ? current : '';
      input.placeholder = valueType === 'url' ? 'https://… или путь к файлу' : 'текст по умолчанию';
      input.addEventListener('change', () => read(input.value.trim() === '' ? null : input.value.trim()));
      return input;
    }
    case 'number': {
      const input = el('input', 'text-input');
      input.type = 'number';
      input.value = typeof current === 'number' ? String(current) : '';
      input.addEventListener('change', () => {
        read(input.value === '' ? null : Number(input.value));
      });
      return input;
    }
    case 'date': {
      const input = el('input', 'text-input');
      input.type = 'date';
      input.value = typeof current === 'string' ? current : '';
      input.addEventListener('change', () => read(input.value === '' ? null : input.value));
      return input;
    }
    case 'bool': {
      const input = el('input');
      input.type = 'checkbox';
      input.checked = current === true;
      input.addEventListener('change', () => read(input.checked));
      return input;
    }
    case 'thought_ref':
      return span('не задаётся', 'muted');
  }
}

/**
 * The default-value override dialog (L21): sets the effective default of an
 * inherited property for this type, or resets the override.
 */
function openDefaultOverrideDialog(opts: {
  networkId: string;
  ownerType: TypeOwnerType;
  typeId: string;
  def: EffectiveTypeProperty;
  onDone: () => void;
}): void {
  const { networkId, ownerType, typeId, def, onDone } = opts;
  const errorLine = span('', 'error-text');
  let value: unknown = def.default_value;
  const defaultHost = div('form-row');
  const renderDefault = (): void => {
    defaultHost.replaceChildren(
      defaultInputFor(def.value_type, value, (v) => {
        value = v;
      }),
    );
  };
  renderDefault();

  const body = div('form-stack');
  const hint = el(
    'p',
    'muted',
    `Свойство «${def.key}» наследуется от типа «${def.defined_on_name}». ` +
      'Здесь задаётся значение по умолчанию только для этого типа.',
  );
  hint.style.margin = '0';
  body.append(hint, defaultHost, errorLine);

  /** Applies the override (or clears it when the field is empty). */
  async function apply(close: () => void): Promise<void> {
    try {
      await etn.types.setPropertyDefaultOverride(
        networkId,
        ownerType,
        typeId,
        def.id,
        (value ?? null) as string | number | boolean | null,
      );
      onDone();
      close();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  showDialog({
    title: `Значение по умолчанию — «${def.key}»`,
    body,
    width: 460,
    buttons: [
      { label: 'Отменить' },
      ...(def.overridden_here
        ? [
            {
              label: 'Сбросить переопределение',
              keepOpen: true,
              onClick: (close: () => void): void => {
                void (async () => {
                  try {
                    await etn.types.setPropertyDefaultOverride(
                      networkId,
                      ownerType,
                      typeId,
                      def.id,
                      null,
                    );
                    onDone();
                    close();
                  } catch (err) {
                    errorLine.textContent = errText(err);
                  }
                })();
              },
            } satisfies DialogButton,
          ]
        : []),
      { label: 'Применить', primary: true, keepOpen: true, onClick: (close) => void apply(close) },
    ],
  });
}

/**
 * The description-override dialog (task «Добавить описание (description) к
 * определениям свойств типов»): the description analogue of {@link
 * openDefaultOverrideDialog} — sets the effective description of an inherited
 * property for this type, or resets the override. Empty field = no override.
 */
function openDescriptionOverrideDialog(opts: {
  networkId: string;
  ownerType: TypeOwnerType;
  typeId: string;
  def: EffectiveTypeProperty;
  onDone: () => void;
}): void {
  const { networkId, ownerType, typeId, def, onDone } = opts;
  const errorLine = span('', 'error-text');

  const area = el('textarea', 'textarea-input');
  area.value = def.description ?? '';
  area.rows = 5;
  area.placeholder = 'Описание свойства для этого типа (пусто — наследуется от родителя)';

  const body = div('form-stack');
  const hint = el(
    'p',
    'muted',
    `Свойство «${def.key}» наследуется от типа «${def.defined_on_name}». ` +
      'Здесь задаётся описание свойства только для этого типа (и его подчинённых, пока те не переопределят сами).',
  );
  hint.style.margin = '0';
  body.append(hint, area, errorLine);

  /** Applies the override (or clears it when the field is empty). */
  async function apply(close: () => void): Promise<void> {
    const description = area.value.trim();
    try {
      await etn.types.setPropertyDescriptionOverride(
        networkId,
        ownerType,
        typeId,
        def.id,
        description === '' ? null : description,
      );
      onDone();
      close();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  showDialog({
    title: `Описание свойства — «${def.key}»`,
    body,
    width: 460,
    buttons: [
      { label: 'Отменить' },
      ...(def.description_overridden
        ? [
            {
              label: 'Сбросить переопределение',
              keepOpen: true,
              onClick: (close: () => void): void => {
                void (async () => {
                  try {
                    await etn.types.setPropertyDescriptionOverride(
                      networkId,
                      ownerType,
                      typeId,
                      def.id,
                      null,
                    );
                    onDone();
                    close();
                  } catch (err) {
                    errorLine.textContent = errText(err);
                  }
                })();
              },
            } satisfies DialogButton,
          ]
        : []),
      { label: 'Применить', primary: true, keepOpen: true, onClick: (close) => void apply(close) },
    ],
  });
}

// ---------------------------------------------------------------------------
// Link types: tree list + editor
// ---------------------------------------------------------------------------

/** Opens the link-types tree dialog (L6/L21). */
export function showLinkTypesDialog(): void {
  const networkId = requireNetworkId();
  const errorLine = span('', 'error-text');
  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '340px';
  const body = div('form-stack');

  // Toolbar (task «Улучшить диалог…»): «Добавить» and the name-search box
  // (no collapse buttons here — same search behaviour as the thought types:
  // matches + ancestor chain stay visible, branches auto-expand).
  const toolbar = div('form-row type-list-toolbar');
  const searchInput = el('input', 'text-input') as HTMLInputElement;
  searchInput.type = 'text';
  searchInput.placeholder = 'Поиск по названию…';
  toolbar.append(
    button('Добавить', () => showLinkTypeEditor(null, onChanged), 'btn small', 'Создать тип'),
    searchInput,
  );
  body.append(toolbar, tableWrap, errorLine);

  let expanded = new Set<string>();
  let searchQuery = '';
  // Last loaded catalogue — tree toggles/search re-render from this cache
  // (see the thought-types dialog for the reasoning: no flicker, no scroll
  // jump).
  let cachedTypes: LinkType[] | null = null;
  let cachedCounts: Record<string, number> | null = null;

  const onChanged = (): void => void reload();

  async function reload(useCache = false): Promise<void> {
    const scrollTop = tableWrap.scrollTop;
    let types: LinkType[];
    let counts: Record<string, number>;
    if (useCache && cachedTypes !== null && cachedCounts !== null) {
      types = cachedTypes;
      counts = cachedCounts;
    } else {
      tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
      try {
        [types, counts] = await Promise.all([
          etn.types.listLinkTypes(networkId),
          etn.types.getLinkTypeCounts(networkId),
        ]);
      } catch (err) {
        tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
        return;
      }
      cachedTypes = types;
      cachedCounts = counts;
    }
    if (expanded.size === 0) {
      expanded = new Set(types.filter((t) => t.is_root).map((t) => t.id));
    }
    const aggregated = aggregateTypeCounts(types, counts);
    const searching = searchQuery.trim() !== '';
    const keepIds = typeSearchVisibleIds(types, searchQuery);
    // Searching shows every matched branch fully expanded, as in the
    // thought-types list; otherwise the manual expand/collapse state applies.
    const rows = (
      searching ? flattenTypeTree(buildTypeTree(types), new Set(types.map((t) => t.id))) : visibleRows(types, expanded)
    ).filter((row) => keepIds.has(row.type.id));
    const table = el('table', 'table-list');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th', undefined, 'Имя (от источника к назначению / обратно)'),
      el('th', undefined, 'Комментарий'),
      el('th', undefined, 'Количество'),
      el('th'),
    );
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    if (rows.length === 0) {
      const emptyRow = el('tr');
      const emptyCell = el('td', 'muted', searching ? 'Ничего не найдено.' : 'Нет типов.');
      emptyCell.colSpan = 4;
      emptyRow.append(emptyCell);
      tbody.append(emptyRow);
    }
    for (const row of rows) {
      const type = row.type;
      const tr = el('tr');
      if (type.is_root) tr.classList.add('type-tree-root');
      const nameCell = el('td');
      nameCell.style.whiteSpace = 'nowrap';
      const nameWrap = span('', 'type-tree-name');
      nameWrap.style.paddingLeft = `${Math.max(0, row.depth - 1) * 18}px`;
      nameWrap.append(treeToggle(row, expanded, () => void toggle(type.id), searching));
      // Line swatch: effective colour/dash/width of the type chain (L21).
      const swatch = span('', 'link-type-swatch');
      const resolved = resolveLinkTypeVisual(types, type.id);
      swatch.style.borderTop = `${Math.max(1, Math.min(6, resolved.width))}px ${resolved.style} ${resolved.color ?? '#9aa3b2'}`;
      nameWrap.append(swatch, span(` ${type.name_forward} / ${type.name_reverse}`));
      nameCell.append(nameWrap);
      const descCell = el('td', 'muted', (type.description ?? '').slice(0, 120));
      descCell.style.maxWidth = '260px';
      descCell.style.overflow = 'hidden';
      descCell.style.textOverflow = 'ellipsis';
      descCell.style.whiteSpace = 'nowrap';
      const countCell = el('td', 'muted', String(aggregated[type.id] ?? 0));
      countCell.style.textAlign = 'right';
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      if (!type.is_root) {
        actions.append(button('✕', () => void removeRow(type), 'btn small', 'Удалить тип'));
      }
      tr.append(nameCell, descCell, countCell, actions);
      // Clicks on the ▸/▾ toggle or the ✕ button must not open the editor.
      tr.addEventListener('click', (event) => {
        if (event.target instanceof HTMLElement && event.target.closest('button') !== null) return;
        showLinkTypeEditor(type, onChanged);
      });
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
    tableWrap.scrollTop = scrollTop;
  }

  /** Expands/collapses a node and re-renders from the cache (no round-trip). */
  function toggle(typeId: string): void {
    if (expanded.has(typeId)) expanded.delete(typeId);
    else expanded.add(typeId);
    void reload(true);
  }

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    void reload(true);
  });

  /** Deletes a link type (forced: links stay, become untyped). */
  async function removeRow(type: LinkType): Promise<void> {
    const ok = await confirmDialog(
      'Удалить тип связи',
      `Удалить тип «${type.name_forward} / ${type.name_reverse}»? Связи этого типа останутся ` +
        'и станут без типа; значения свойств этого типа будут удалены.',
      true,
    );
    if (!ok) return;
    try {
      await etn.types.removeLinkType(networkId, type.id, type.version, true);
      await refreshLinkTypes();
      scheduleRefresh();
      onChanged();
    } catch (err) {
      errorDialog('Удалить тип связи', err);
    }
  }

  showDialog({
    title: 'Типы связей',
    body,
    width: 640,
    buttons: [{ label: 'Закрыть', primary: true }],
  });
  void reload();
}

/**
 * Opens the link-type editor; `type === null` edits a NEW type (L6/L21).
 *
 * Same staged form as the thought-type editor (task «Улучшить диалог
 * редактирования типов мыслей и связей»): line style, parent, description and
 * the own property definitions are editable right away, nothing touches the
 * server until «Применить и закрыть», and «Отмена» discards the whole draft.
 * Reparenting validation is unchanged (client-side picker filters + the
 * server re-checks on apply).
 *
 * `extras.initialName` prefills the forward name of a new type (the
 * type-combobox «Создать новый» row); the reverse name stays empty for the
 * user to fill. The returned promise resolves when the dialog closes: with
 * the id of the type created in this session, or `null` otherwise.
 */
export function showLinkTypeEditor(
  type: LinkType | null,
  onChanged: () => void,
  extras?: TypeEditorExtras,
): Promise<string | null> {
  const networkId = requireNetworkId();
  // The type as last seen by the SERVER (see showThoughtTypeEditor).
  let current: LinkType | null = type;
  let createdId: string | null = null;
  const errorLine = span('', 'error-text');
  const body = div('form-stack');

  // Duplicate-pair guard: a link type is identified by its forward/reverse
  // name pair, unique ignoring case (08-ui-spec.md §8.4). The catalogue is
  // loaded once on open; the server re-checks on apply.
  const DUP_PAIR_MSG = 'Тип связи с такими именами уже существует.';
  let allTypes: LinkType[] = [];
  let applyBtn: HTMLButtonElement | null = null;

  // ---- The staged draft ----
  const draft = {
    name_forward: type?.name_forward ?? extras?.initialName ?? '',
    name_reverse: type?.name_reverse ?? '',
    parent_id: type !== null && type.parent_id !== null ? type.parent_id : null,
    color: type?.color ?? null,
    style: type?.style ?? null,
    width: type?.width ?? null,
    description: type?.description ?? '',
  };

  // Top row: forward · reverse names · settings (⚙) — active from the start.
  const namesRow = div('form-row type-editor-row');
  const forwardInput = el('input', 'text-input');
  forwardInput.type = 'text';
  forwardInput.value = draft.name_forward;
  forwardInput.maxLength = 200;
  forwardInput.placeholder = 'От источника к назначению (обязательно)';
  const reverseInput = el('input', 'text-input');
  reverseInput.type = 'text';
  reverseInput.value = draft.name_reverse;
  reverseInput.maxLength = 200;
  reverseInput.placeholder = 'От назначения к источнику (обязательно)';
  const settingsBtn = button('', openStyle, 'icon-btn', 'Настройки типа');
  settingsBtn.append(svgIcon('settings', 14));
  namesRow.append(forwardInput, reverseInput, settingsBtn);
  body.append(namesRow);

  // Parent picker (L21), same rules as the thought-type editor.
  const parentField = div('field');
  if (type?.is_root === true) {
    const rootNote = el('p', 'muted', 'Корневой тип — родителя не имеет.');
    rootNote.style.margin = '0';
    parentField.append(rootNote);
  } else {
    const picker = buildParentPicker({
      kinds: 'link',
      currentId: () => current?.id ?? null,
      value: draft.parent_id,
      onChange: (parentId) => {
        draft.parent_id = parentId;
        if (current === null) props.refreshPreview();
      },
    });
    parentField.append(picker.root);
  }
  body.append(parentField);

  // Comment (type description / usage rules) — placeholder only, no label.
  const descArea = el('textarea', 'textarea-input');
  descArea.value = draft.description;
  descArea.rows = 3;
  descArea.placeholder = 'Комментарий: описание типа, правила применения…';
  body.append(descArea);

  body.append(errorLine);

  // Property sections (L21: link types gained the property table), staged.
  const props = buildStagedPropertySection({
    networkId,
    ownerType: 'link_type',
    typeId: type?.id ?? null,
    previewParentId: () => draft.parent_id ?? findRootType(store.state.linkTypes)?.id ?? null,
    onOverrideApplied: onChanged,
  });
  body.append(props.root);

  // Блок «Метаданные» — автор, даты, id сущности (задача 04cd9794). Только
  // при редактировании существующего типа; для нового id ещё не присвоен.
  if (type !== null) {
    body.append(buildMetadataRowsFromLinkType(type));
  }

  /** Existing type with the same normalized name pair (self excluded). */
  function pairClash(forward: string, reverse: string): LinkType | null {
    const fwdKey = typeNameKey(forward);
    const revKey = typeNameKey(reverse);
    return (
      allTypes.find(
        (t) =>
          t.id !== (current?.id ?? null) &&
          typeNameKey(t.name_forward) === fwdKey &&
          typeNameKey(t.name_reverse) === revKey,
      ) ?? null
    );
  }

  /** Live duplicate check on the name fields: warn + disable the apply button. */
  function revalidateNames(): void {
    if (pairClash(forwardInput.value, reverseInput.value) !== null) {
      errorLine.textContent = DUP_PAIR_MSG;
      if (applyBtn !== null) applyBtn.disabled = true;
    } else {
      if (errorLine.textContent === DUP_PAIR_MSG) errorLine.textContent = '';
      if (applyBtn !== null) applyBtn.disabled = false;
    }
  }

  // Fresh catalogue for the live duplicate check (the server re-checks anyway).
  void etn.types
    .listLinkTypes(networkId)
    .then((list) => {
      allTypes = list;
      revalidateNames();
    })
    .catch(() => {});
  forwardInput.addEventListener('input', revalidateNames);
  reverseInput.addEventListener('input', revalidateNames);

  /** Applies the whole draft to the server, then closes the dialog. */
  async function apply(close: () => void): Promise<void> {
    const nameForward = forwardInput.value.trim();
    const nameReverse = reverseInput.value.trim();
    if (nameForward === '' || nameReverse === '') {
      errorLine.textContent = 'Оба имени обязательны.';
      return;
    }
    if (pairClash(nameForward, nameReverse) !== null) {
      errorLine.textContent = DUP_PAIR_MSG;
      return;
    }
    const description = descArea.value.trim();
    try {
      if (current === null) {
        // New type: one create carries every staged field at once.
        current = await etn.types.createLinkType(networkId, {
          name_forward: nameForward,
          name_reverse: nameReverse,
          parent_id: draft.parent_id,
          color: draft.color,
          style: draft.style,
          width: draft.width,
          description: description === '' ? null : description,
        });
        createdId = current.id;
      } else {
        // Existing type: patch only the changed fields (If-Match version).
        const input: LinkTypeUpdateInput = {};
        if (nameForward !== current.name_forward) input.name_forward = nameForward;
        if (nameReverse !== current.name_reverse) input.name_reverse = nameReverse;
        if (draft.parent_id !== (current.parent_id ?? null)) input.parent_id = draft.parent_id;
        if (draft.color !== current.color) input.color = draft.color;
        if (draft.style !== current.style) input.style = draft.style;
        if (draft.width !== current.width) input.width = draft.width;
        if ((description === '' ? null : description) !== current.description) {
          input.description = description === '' ? null : description;
        }
        if (Object.keys(input).length > 0) {
          current = await etn.types.updateLinkType(networkId, current.id, input, current.version);
        }
      }
      if (!(await props.applyChanges(current.id))) return; // error shown, dialog stays
      await refreshLinkTypes();
      scheduleRefresh();
      onChanged();
      close();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  function openStyle(): void {
    // Show the effective line style (resolved along the chain, L21): the
    // draft's own value, else the picked parent's chain.
    const resolved = resolveLinkTypeVisual(
      store.state.linkTypes,
      current?.id ?? draft.parent_id ?? null,
    );
    showLinkStyleDialog({
      resolved: {
        color: draft.color,
        style: draft.style ?? resolved.style,
        width: draft.width ?? resolved.width,
      },
      mode: 'type',
      // Patches the local draft only; the server sees it on «Применить и
      // закрыть». A reset returns null = inherit from the parent chain.
      onApply: (patch) => {
        if (patch.color !== undefined) draft.color = patch.color;
        if (patch.style !== undefined) draft.style = patch.style;
        if (patch.width !== undefined) draft.width = patch.width;
        return Promise.resolve();
      },
    });
  }

  // The promise resolves on dialog close (`onClose` fires from the
  // backdrop's remove event — Esc, × and both footer buttons all land there).
  return new Promise<string | null>((resolve) => {
    showDialog({
      title: type === null ? 'Новый тип связи' : 'Тип связи',
      body,
      width: 560,
      buttons: [
        { label: 'Отмена' },
        {
          label: 'Применить и закрыть',
          primary: true,
          keepOpen: true,
          onClick: (close) => void apply(close),
          ref: (btn) => {
            applyBtn = btn;
          },
        },
      ],
      onMount: () => forwardInput.focus(),
      onClose: () => resolve(createdId),
    });
  });
}

// ---------------------------------------------------------------------------
// Метаданные (задача 04cd9794)
// ---------------------------------------------------------------------------

/** Преобразует ThoughtType DTO в плоский набор полей для блока «Метаданные». */
function buildMetadataRowsFromType(type: ThoughtType): HTMLElement {
  const fields: MetadataFields = {
    id: type.id,
    createdAtMs: type.created_at_ms ?? type.created_at,
    createdBy: type.created_by ?? null,
    updatedAtMs: type.updated_at_ms ?? type.updated_at,
    updatedBy: type.updated_by ?? null,
  };
  return buildMetadataRows(fields);
}

/** Преобразует LinkType DTO в плоский набор полей для блока «Метаданные». */
function buildMetadataRowsFromLinkType(type: LinkType): HTMLElement {
  const fields: MetadataFields = {
    id: type.id,
    createdAtMs: type.created_at_ms ?? type.created_at,
    createdBy: type.created_by ?? null,
    updatedAtMs: type.updated_at_ms ?? type.updated_at,
    updatedBy: type.updated_by ?? null,
  };
  return buildMetadataRows(fields);
}
