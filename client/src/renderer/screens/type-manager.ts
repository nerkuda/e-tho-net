/**
 * Type catalogue management (L6 + L21 hierarchy, 08-ui-spec.md §8.1).
 *
 * Opened from the toolbar «Вид» menu:
 *  - «Типы мыслей» / «Типы связей» — a **tree** of types (root «основной тип»
 *    always expanded, other nodes collapsed; the root has no delete mark and
 *    is not assignable to thoughts/links): icon, name rendered with the
 *    type's own colours/font, short description. «Добавить» opens the editor,
 *    each row has a delete button (the server rejects deleting the root or a
 *    type that still has subordinate types). Deleting a used type is forced:
 *    thoughts/links keep existing with `type_id = null`, and the type's
 *    property definitions (with all stored values) are dropped server-side.
 *
 * Type editors: icon (same picker as the thought editor), required name, ⚙
 * (the same style dialog, type mode), free-form description and the **parent
 * picker** (L21 — a type tree; clearing it equals attaching under the root).
 * Reparenting is validated server-side: rejected while the type is in use,
 * must not create cycles and the nesting is capped at 4 levels.
 *
 * Property sections (L21):
 *  - «Свойства типа» — the type's own definitions: key, value type, default
 *    value, reorder and delete (as before).
 *  - «Унаследованные свойства» — read-only definitions inherited from the
 *    ancestors; only the default value may be overridden per type (and the
 *    override can be reset back to the ancestor's default).
 *
 * Link-type editor: forward/reverse names, ⚙ (line-style dialog, type mode —
 * a reset inherits the parent's style since L21), description and the same
 * property sections (link types gained a property table in L21).
 */

import type {
  EffectiveTypeProperty,
  LinkType,
  PropertyDefinition,
  PropertyDefinitionUpdateInput,
  PropertyValueType,
  ThoughtType,
  TypeOwnerType,
} from '@etn/shared';
import { typeNameKey } from '@etn/shared';

import { requireNetworkId, scheduleRefresh } from '../app.js';
import { applyThoughtIcon } from '../canvas/canvas.js';
import { confirmDialog, errorDialog, showDialog, type DialogButton } from '../lib/dialog.js';
import { button, div, el, errText, setTooltip, span, applyFontFlags } from '../lib/dom.js';
import { svgIcon } from '../lib/icons.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import {
  MAX_TYPE_DEPTH,
  flattenTypeTree,
  buildTypeTree,
  orderedTypeRows,
  resolveLinkTypeVisual,
  subtreeTypeIds,
  typeDepth,
  subtreeHeight,
  type FlatTypeRow,
} from '../lib/type-tree.js';
import { createTypeCombobox } from '../lib/type-combobox.js';
import { store } from '../state.js';
import { showIconDialog } from '../editor/icon-dialog.js';
import { showLinkStyleDialog, showThoughtStyleDialog } from '../editor/style-dialog.js';

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
): HTMLElement {
  const btn = button('', onToggle, 'btn small type-tree-toggle', row.hasChildren ? 'Развернуть/свернуть' : '');
  btn.textContent = row.hasChildren ? (expanded.has(row.type.id) ? '▾' : '▸') : '';
  btn.disabled = !row.hasChildren;
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
  body.append(tableWrap, errorLine);
  body.append(
    button('Добавить', () => showThoughtTypeEditor(null, onChanged), 'btn small', 'Создать тип'),
  );

  // L21: the root type is always expanded; everything else starts collapsed.
  let expanded = new Set<string>();

  const onChanged = (): void => void reload();

  async function reload(): Promise<void> {
    tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let types: ThoughtType[];
    try {
      types = await etn.types.listThoughtTypes(networkId);
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    if (expanded.size === 0) {
      expanded = new Set(types.filter((t) => t.is_root).map((t) => t.id));
    }
    const table = el('table', 'table-list');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(el('th', undefined, 'Тип'), el('th', undefined, 'Комментарий'), el('th'));
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    for (const row of visibleRows(types, expanded)) {
      const type = row.type;
      const tr = el('tr');
      if (type.is_root) tr.classList.add('type-tree-root');
      const nameCell = el('td');
      nameCell.style.whiteSpace = 'nowrap';
      const nameWrap = span('', 'type-tree-name');
      nameWrap.style.paddingLeft = `${Math.max(0, row.depth - 1) * 18}px`;
      nameWrap.append(treeToggle(row, expanded, () => void toggle(type.id)));
      const icon = span('', 'mini-icon');
      applyThoughtIcon(icon, { icon: type.icon, icon_kind: type.icon_kind, type_id: null });
      const name = span(type.name, 'type-list-name');
      applyTypeStyle(name, type);
      nameWrap.append(icon, name);
      nameCell.append(nameWrap);
      const descCell = el('td', 'muted', (type.description ?? '').slice(0, 120));
      descCell.style.maxWidth = '280px';
      descCell.style.overflow = 'hidden';
      descCell.style.textOverflow = 'ellipsis';
      descCell.style.whiteSpace = 'nowrap';
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      if (!type.is_root) {
        actions.append(button('✕', () => void removeRow(type), 'btn small', 'Удалить тип'));
      }
      tr.append(nameCell, descCell, actions);
      tr.addEventListener('click', () => showThoughtTypeEditor(type, onChanged));
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
  }

  /** Expands/collapses a node and re-renders (no server round-trip). */
  function toggle(typeId: string): void {
    if (expanded.has(typeId)) expanded.delete(typeId);
    else expanded.add(typeId);
    void reload();
  }

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
 * The parent-picker combobox of a type editor. Options exclude the type
 * itself, its descendants and any parent that would push the tree past
 * {@link MAX_TYPE_DEPTH} levels. The empty entry is the root type — «очистка
 * родителя равносильна присвоению корневого типа» (08-ui-spec.md §8.1).
 */
function buildParentPicker(opts: {
  kinds: 'thought' | 'link';
  /** The edited type (null while it is being created). */
  currentId: () => string | null;
  value: string | null;
  onChange: (parentId: string | null) => void;
}): { root: HTMLElement } {
  const { kinds, currentId, value, onChange } = opts;
  const types = (): typeof store.state.thoughtTypes | typeof store.state.linkTypes =>
    kinds === 'thought' ? store.state.thoughtTypes : store.state.linkTypes;
  const combo = createTypeCombobox({
    options: () => {
      // Candidate parents: every type except the edited one and its
      // descendants; the depth cap must hold for the resulting subtree.
      const allowed = (id: string): boolean => {
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
          }));
      }
      return orderedTypeRows(store.state.linkTypes)
        .filter((row) => allowed(row.type.id))
        .map((row) => ({
          id: row.type.id,
          label: `${row.type.name_forward} / ${row.type.name_reverse}`,
          parent_id: row.type.parent_id,
          depth: row.depth,
          has_children: row.hasChildren,
          selectable: true,
        }));
    },
    value,
    placeholder: 'основной тип',
    emptyLabel: 'основной тип (без родителя)',
    onChange,
  });
  return { root: combo.root };
}

/** Opens the thought-type editor; `type === null` creates a new type (L6/L21). */
export function showThoughtTypeEditor(type: ThoughtType | null, onChanged: () => void): void {
  const networkId = requireNetworkId();
  // Kept fresh after every immediate patch (icon/style) for If-Match versions.
  let current = type;
  const errorLine = span('', 'error-text');
  const body = div('form-stack');

  // Duplicate-name guard: type names are unique ignoring case (08-ui-spec.md
  // §8.1). The catalogue is loaded once on open; the server re-checks on save.
  const DUP_NAME_MSG = 'Тип с таким именем уже существует.';
  let allTypes: ThoughtType[] = [];
  let createBtn: HTMLButtonElement | null = null;

  // Top row: icon · name · settings (⚙). The icon and ⚙ stay visible but
  // inert until the new type is actually created («Создать и продолжить»).
  const topRow = div('editor-top-row');
  const iconBox = el('button', 'editor-icon-box') as HTMLButtonElement;
  iconBox.type = 'button';
  setTooltip(iconBox, 'Иконка типа');
  const renderIcon = (): void => {
    applyThoughtIcon(iconBox, {
      icon: current?.icon ?? null,
      icon_kind: current?.icon_kind ?? 'emoji',
      type_id: null,
    });
  };
  renderIcon();
  iconBox.addEventListener('click', () => {
    if (current === null) return;
    showIconDialog({
      current: { icon: current.icon, kind: current.icon_kind },
      onPick: (result) => patchType({ icon: result.icon, icon_kind: result.kind }),
    });
  });
  const nameInput = el('input', 'text-input');
  nameInput.type = 'text';
  nameInput.value = type?.name ?? '';
  nameInput.maxLength = 200;
  nameInput.placeholder = 'Название типа (обязательно)';
  const settingsBtn = button('', openStyle, 'icon-btn', 'Настройки типа');
  settingsBtn.append(svgIcon('settings', 14));
  topRow.append(iconBox, nameInput, settingsBtn);
  body.append(topRow);

  // Parent picker (L21). The root type has no parent; reparenting a type in
  // use is rejected by the server (the message surfaces in the error line).
  let pickedParentId: string | null = type === null ? null : (type.parent_id ?? null);
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
      value: type?.parent_id ?? null,
      onChange: (parentId) => {
        pickedParentId = parentId;
        if (current !== null) {
          void patchType({ parent_id: parentId } as Parameters<typeof patchType>[0]);
        }
      },
    });
    parentField.append(picker.root);
  }
  body.append(parentField);

  // Comment (type description / usage rules) — placeholder only, no label.
  const descArea = el('textarea', 'textarea-input');
  descArea.value = type?.description ?? '';
  descArea.rows = 3;
  descArea.placeholder = 'Комментарий: описание типа, правила применения…';
  body.append(descArea);

  body.append(errorLine);

  // Property sections — always visible; a placeholder row until the type exists.
  const propsHost = div('form-stack');
  body.append(propsHost);
  renderProps();

  if (type === null) {
    const actions = div('form-row');
    createBtn = button(
      'Создать и продолжить',
      () => void commitNew(),
      'btn',
      'Создать тип и продолжить',
    );
    actions.append(createBtn);
    body.append(actions);
  }

  /** Applies an immediate patch (icon, style, parent) to the existing type.
   *  `font_* = null` means «inherit from the parent type» (L21). */
  async function patchType(
    patch: {
      parent_id?: string | null;
      icon?: string | null;
      icon_kind?: import('@etn/shared').IconKind;
      fg_color?: string | null;
      bg_color?: string | null;
      font_bold?: boolean | null;
      font_italic?: boolean | null;
      font_underline?: boolean | null;
      font_strike?: boolean | null;
    },
  ): Promise<boolean> {
    if (current === null) return false;
    try {
      current = await etn.types.updateThoughtType(networkId, current.id, patch, current.version);
      await refreshThoughtTypes();
      renderIcon();
      onChanged();
      return true;
    } catch (err) {
      errorDialog('Изменить тип', err);
      return false;
    }
  }

  function openStyle(): void {
    if (current === null) return;
    showThoughtStyleDialog({
      resolved: {
        fg: current.fg_color,
        bg: current.bg_color,
        bold: current.font_bold ?? false,
        italic: current.font_italic ?? false,
        underline: current.font_underline ?? false,
        strike: current.font_strike ?? false,
      },
      mode: 'type',
      onApply: (patch) => patchType(patch),
    });
  }

  /** Shows the property sections, or a hint while the type is not created yet. */
  function renderProps(): void {
    propsHost.replaceChildren();
    const label = el('p', 'muted', 'Свойства');
    label.style.margin = '8px 0 2px';
    propsHost.append(label);
    if (current !== null) {
      propsHost.append(buildPropertiesTable(networkId, 'thought_type', current.id, onChanged));
    } else {
      propsHost.append(el('p', 'muted', 'Свойства станут доступны после создания типа.'));
    }
    settingsBtn.disabled = current === null;
    iconBox.disabled = current === null;
  }

  /** Existing type with the same normalized name as `name` (self excluded). */
  function nameClash(name: string): ThoughtType | null {
    const key = typeNameKey(name);
    return (
      allTypes.find((t) => t.id !== (current?.id ?? null) && typeNameKey(t.name) === key) ?? null
    );
  }

  /** Live duplicate check on the name field: warn + disable the create button. */
  function revalidateName(): void {
    if (nameClash(nameInput.value) !== null) {
      errorLine.textContent = DUP_NAME_MSG;
      if (createBtn !== null) createBtn.disabled = true;
    } else {
      if (errorLine.textContent === DUP_NAME_MSG) errorLine.textContent = '';
      if (createBtn !== null) createBtn.disabled = false;
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

  /** Creates the type and unlocks the icon, settings and properties. */
  async function commitNew(): Promise<void> {
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
    try {
      current = await etn.types.createThoughtType(networkId, {
        name,
        parent_id: pickedParentId,
        description: description === '' ? null : description,
      });
      await refreshThoughtTypes();
      onChanged();
      errorLine.textContent = '';
      renderProps();
      nameInput.focus();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  /** Autosaves the name/description of an existing type on blur. */
  async function saveNameDesc(): Promise<void> {
    if (current === null) return;
    const name = nameInput.value.trim();
    if (name === '') {
      nameInput.value = current.name;
      errorLine.textContent = 'Название не может быть пустым — возвращено прежнее.';
      return;
    }
    if (nameClash(name) !== null) {
      errorLine.textContent = DUP_NAME_MSG;
      return;
    }
    const description = descArea.value.trim();
    const nextDesc = description === '' ? null : description;
    if (name === current.name && nextDesc === current.description) return;
    try {
      current = await etn.types.updateThoughtType(
        networkId,
        current.id,
        { name, description: nextDesc },
        current.version,
      );
      await refreshThoughtTypes();
      onChanged();
      errorLine.textContent = '';
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }
  nameInput.addEventListener('input', revalidateName);
  nameInput.addEventListener('blur', () => void saveNameDesc());
  descArea.addEventListener('blur', () => void saveNameDesc());

  showDialog({
    title: type === null ? 'Новый тип мысли' : 'Тип мысли',
    body,
    width: 560,
    buttons: [{ label: 'Закрыть', primary: true }],
    onMount: () => nameInput.focus(),
  });
}

// ---------------------------------------------------------------------------
// Property-definition tables + property dialog (both type kinds)
// ---------------------------------------------------------------------------

/**
 * Builds the property sections of a type (L6/L21): the type's own
 * definitions (editable) and the inherited ones (read-only except the
 * default-value override). Clicking an own row opens the property dialog;
 * «Добавить свойство» opens it for a new property.
 */
function buildPropertiesTable(
  networkId: string,
  ownerType: TypeOwnerType,
  typeId: string,
  onTouched: () => void,
): HTMLElement {
  const box = div('form-stack');
  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '220px';
  // The first load often starts before the dialog mounts this box — show the
  // placeholder up front instead of a blank gap.
  tableWrap.append(el('span', 'muted', 'Загрузка…'));
  const errorLine = span('', 'error-text');
  box.append(tableWrap, errorLine);
  box.append(
    button('Добавить свойство', () => showPropertyDialog(null), 'btn small', 'Новое свойство'),
  );

  let defs: EffectiveTypeProperty[] = [];

  /** Opens the property dialog; reloads the table when it commits a change. */
  function showPropertyDialog(def: PropertyDefinition | null): void {
    openPropertyDialog({
      networkId,
      ownerType,
      typeId,
      def,
      onDone: () => {
        onTouched();
        void reload();
      },
    });
  }

  /** Opens the default-override dialog of an inherited property (L21). */
  function showOverrideDialog(def: EffectiveTypeProperty): void {
    openDefaultOverrideDialog({
      networkId,
      ownerType,
      typeId,
      def,
      onDone: () => {
        onTouched();
        void reload();
      },
    });
  }

  /** Moves an own definition one slot up/down and persists the new order. */
  async function move(defId: string, delta: -1 | 1): Promise<void> {
    const ids = defs.filter((d) => !d.inherited).map((d) => d.id);
    const from = ids.indexOf(defId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    try {
      await etn.types.reorderTypeProperties(networkId, ownerType, typeId, ids);
      await reload();
    } catch (err) {
      errorDialog('Изменить порядок', err);
    }
  }

  /** Deletes one own definition (its stored values cascade server-side). */
  async function remove(def: EffectiveTypeProperty): Promise<void> {
    const ok = await confirmDialog(
      'Удалить свойство',
      `Удалить свойство «${def.key}»? Значения этого свойства у всех элементов будут удалены.`,
      true,
    );
    if (!ok) return;
    try {
      await etn.types.removeTypeProperty(networkId, ownerType, typeId, def.id);
      onTouched();
      await reload();
    } catch (err) {
      errorDialog('Удалить свойство', err);
    }
  }

  /** Renders the own + inherited definition tables from the server. */
  let everMounted = false;
  async function reload(): Promise<void> {
    // The table is built BEFORE its dialog mounts it, so the first reload runs
    // while still detached and must proceed. Skip only bodies that were
    // mounted and then discarded (the dialog closed or a newer body took over).
    if (everMounted && !box.isConnected) return;
    try {
      defs = await etn.types.listTypeProperties(networkId, ownerType, typeId);
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    if (box.isConnected) everMounted = true;
    const own = defs.filter((d) => !d.inherited);
    const inherited = defs.filter((d) => d.inherited);
    tableWrap.replaceChildren();

    if (inherited.length > 0) {
      const inhLabel = el('p', 'muted', 'Унаследованные свойства (тип значения не меняется; переопределяется только значение по умолчанию)');
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
        row.append(el('td', undefined, def.key));
        row.append(el('td', 'muted', VALUE_TYPE_LABELS[def.value_type]));
        row.append(el('td', 'muted', def.defined_on_name));
        row.append(
          el('td', 'muted', formatDefault(def.default_value) + (def.overridden_here ? ' ●' : '')),
        );
        const actions = el('td');
        actions.style.whiteSpace = 'nowrap';
        if (def.value_type !== 'thought_ref') {
          actions.append(
            button('по умолчанию…', () => showOverrideDialog(def), 'btn small', 'Переопределить значение по умолчанию'),
          );
        }
        if (def.overridden_here) {
          actions.append(
            button('сбросить', () => void clearOverride(def), 'btn small', 'Сбросить переопределение'),
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
      el('th', undefined, 'По умолчанию'),
      el('th'),
    );
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    for (const def of own) {
      const row = el('tr');
      row.append(el('td', undefined, def.key));
      row.append(el('td', 'muted', VALUE_TYPE_LABELS[def.value_type]));
      row.append(el('td', 'muted', formatDefault(def.config?.default_value ?? null)));
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      actions.append(
        button('▲', () => void move(def.id, -1), 'btn small', 'Выше'),
        button('▼', () => void move(def.id, 1), 'btn small', 'Ниже'),
        button('✕', () => void remove(def), 'btn small', 'Удалить свойство'),
      );
      row.append(actions);
      // Clicking a row (outside its action buttons) edits the property.
      row.addEventListener('click', (event) => {
        if (event.target instanceof HTMLElement && event.target.closest('button') !== null) return;
        showPropertyDialog(def);
      });
      tbody.append(row);
    }
    table.append(tbody);
    tableWrap.append(table);
    if (own.length === 0 && inherited.length === 0) {
      tableWrap.replaceChildren(el('p', 'muted', 'У типа нет свойств.'));
    }
  }

  /** Drops the type's default-value override (back to the ancestor default). */
  async function clearOverride(def: EffectiveTypeProperty): Promise<void> {
    try {
      await etn.types.setPropertyDefaultOverride(networkId, ownerType, typeId, def.id, null);
      onTouched();
      await reload();
    } catch (err) {
      errorDialog('Сбросить переопределение', err);
    }
  }

  void reload();
  return box;
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
 * default target makes no sense across thoughts.
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
 * The property editor dialog (L6): title, value type, default value.
 * New: «Добавить» / «Отменить». Existing: «Применить» / «Удалить» / «Отменить».
 *
 * Changing the value type asks for confirmation first — the server rewrites
 * every stored value of the property to the new type and clears those that do
 * not fit; a notice marks the processing window.
 */
function openPropertyDialog(opts: {
  networkId: string;
  ownerType: TypeOwnerType;
  typeId: string;
  def: PropertyDefinition | null;
  onDone: () => void;
}): void {
  const { networkId, ownerType, typeId, def, onDone } = opts;
  const isNew = def === null;
  const errorLine = span('', 'error-text');

  const keyInput = el('input', 'text-input');
  keyInput.type = 'text';
  keyInput.value = def?.key ?? '';
  keyInput.maxLength = 200;
  keyInput.placeholder = 'Заголовок свойства (обязательно)';

  const typeSelect = el('select', 'select-input');
  for (const [value, label] of Object.entries(VALUE_TYPE_LABELS)) {
    const option = el('option', undefined, label);
    option.value = value;
    typeSelect.append(option);
  }
  typeSelect.value = def?.value_type ?? 'text';

  // The default-value input is rebuilt when the value type changes (the
  // in-progress default does not carry over).
  let defaultValue: unknown = def?.config?.default_value ?? null;
  const defaultHost = div('form-row');
  const renderDefault = (): void => {
    defaultHost.replaceChildren(
      defaultInputFor(typeSelect.value as PropertyValueType, defaultValue, (v) => {
        defaultValue = v;
      }),
    );
  };
  renderDefault();

  // Text options («выбирать из списка» + «несколько значений», 08-ui-spec.md
  // §8.1): an input aid for filling values, never a restriction — arbitrary
  // typed values stay allowed, and trimming the list never touches stored
  // values (02-data-model.md §3.4).
  let choiceOn = def?.value_type === 'text' && (def.config?.options?.length ?? 0) > 0;
  let multipleOn = def?.config?.multiple === true;
  let optionsText = choiceOn ? (def?.config?.options ?? []).join('\n') : '';
  const textExtrasHost = div('form-stack');

  // thought_ref type filter: pick from thoughts of the selected types only
  // (L21: the type list is the tree; a selected parent matches its whole
  // subtree on the server). Changing it later never reprocesses stored values.
  const typeFilter = new Set<string>(
    def?.value_type === 'thought_ref'
      ? (def.config?.allowed_type_ids ??
          (def.config?.allowed_type_id !== undefined ? [def.config.allowed_type_id] : []))
      : [],
  );
  const refFilterHost = div('form-stack');

  const renderTextExtras = (): void => {
    textExtrasHost.replaceChildren();
    if (typeSelect.value !== 'text') return;
    const choiceRow = el('label', 'checkbox-row');
    const choiceCheck = el('input');
    choiceCheck.type = 'checkbox';
    choiceCheck.checked = choiceOn;
    choiceCheck.addEventListener('change', () => {
      choiceOn = choiceCheck.checked;
      renderTextExtras();
    });
    choiceRow.append(choiceCheck, span('выбирать из списка'));
    textExtrasHost.append(choiceRow);
    if (!choiceOn) return;
    const area = el('textarea', 'textarea-input');
    area.value = optionsText;
    area.rows = 4;
    area.placeholder = 'Варианты значения — по одному в строке';
    area.addEventListener('input', () => {
      optionsText = area.value;
    });
    const multiRow = el('label', 'checkbox-row');
    const multiCheck = el('input');
    multiCheck.type = 'checkbox';
    multiCheck.checked = multipleOn;
    multiCheck.addEventListener('change', () => {
      multipleOn = multiCheck.checked;
    });
    multiRow.append(multiCheck, span('несколько значений (через запятую)'));
    textExtrasHost.append(area, multiRow);
  };

  const renderRefFilter = (): void => {
    refFilterHost.replaceChildren();
    if (typeSelect.value !== 'thought_ref') return;
    const label = el('p', 'muted', 'Отбор по типам (вместе с подчинёнными) — поиск идёт только по ним:');
    label.style.margin = '0';
    refFilterHost.append(label);
    const boxEl = div('type-filter-box');
    const rows = orderedTypeRows(store.state.thoughtTypes).filter((row) => !row.type.is_root);
    if (rows.length === 0) {
      boxEl.append(el('p', 'muted', 'В сети ещё нет типов мыслей.'));
    }
    for (const row of rows) {
      const lab = el('label', 'checkbox-row');
      lab.style.marginLeft = `${Math.max(0, row.depth - 2) * 16}px`;
      const check = el('input');
      check.type = 'checkbox';
      check.checked = typeFilter.has(row.type.id);
      check.addEventListener('change', () => {
        if (check.checked) typeFilter.add(row.type.id);
        else typeFilter.delete(row.type.id);
      });
      lab.append(check, span(row.type.name));
      boxEl.append(lab);
    }
    refFilterHost.append(boxEl);
  };
  renderTextExtras();
  renderRefFilter();

  typeSelect.addEventListener('change', () => {
    defaultValue = null;
    // The type-specific extras do not carry over to the new value type.
    choiceOn = false;
    multipleOn = false;
    optionsText = '';
    typeFilter.clear();
    renderDefault();
    renderTextExtras();
    renderRefFilter();
  });

  const body = div('form-stack');
  body.append(
    keyInput,
    typeSelect,
    defaultHost,
    textExtrasHost,
    refFilterHost,
    errorLine,
  );

  /**
   * The config patch: default value + the type-specific extras. Returns
   * `null` for an empty config so untouched definitions keep `config = null`.
   */
  const configPatch = (): { config: PropertyDefinition['config'] | null } => {
    const after = defaultValue === undefined || defaultValue === '' ? null : defaultValue;
    const config: Record<string, unknown> = { ...(def?.config ?? {}) };
    if (after === null) {
      delete config['default_value'];
    } else {
      config['default_value'] = after;
    }
    if (typeSelect.value === 'text') {
      const opts = optionsText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      if (choiceOn && opts.length > 0) {
        config['options'] = opts;
        if (multipleOn) config['multiple'] = true;
        else delete config['multiple'];
      } else {
        delete config['options'];
        delete config['multiple'];
      }
    } else {
      delete config['options'];
      delete config['multiple'];
    }
    if (typeSelect.value === 'thought_ref') {
      // The list form supersedes the legacy single `allowed_type_id`.
      delete config['allowed_type_id'];
      if (typeFilter.size > 0) config['allowed_type_ids'] = [...typeFilter];
      else delete config['allowed_type_ids'];
    } else {
      delete config['allowed_type_id'];
      delete config['allowed_type_ids'];
    }
    return { config: (Object.keys(config).length === 0 ? null : config) as PropertyDefinition['config'] | null };
  };

  /** Creates the property. */
  async function create(close: () => void): Promise<void> {
    const key = keyInput.value.trim();
    if (key === '') {
      errorLine.textContent = 'Заголовок свойства обязателен.';
      return;
    }
    try {
      await etn.types.createTypeProperty(networkId, ownerType, typeId, {
        key,
        value_type: typeSelect.value as PropertyValueType,
        ...configPatch(),
      });
      onDone();
      close();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  /** Applies key/value_type/default changes (with confirmation on the type). */
  async function apply(close: () => void): Promise<void> {
    if (def === null) return;
    const key = keyInput.value.trim();
    if (key === '') {
      errorLine.textContent = 'Заголовок свойства обязателен.';
      return;
    }
    const nextType = typeSelect.value as PropertyValueType;
    const changes: PropertyDefinitionUpdateInput = {};
    if (key !== def.key) changes.key = key;
    if (nextType !== def.value_type) changes.value_type = nextType;

    const nextConfig = configPatch().config;
    if (JSON.stringify(nextConfig ?? {}) !== JSON.stringify(def.config ?? {})) {
      changes.config = nextConfig;
    }

    if (Object.keys(changes).length === 0) {
      close();
      return;
    }
    if (changes.value_type !== undefined) {
      const ok = await confirmDialog(
        'Сменить тип значения',
        `Сменить тип значения свойства «${def.key}»? Значения этого свойства во всех ` +
          'элементах будут преобразованы к новому типу; несовместимые — очищены.',
        true,
      );
      if (!ok) return;
      notice('Ждите: выполняется обработка значений…');
    }
    try {
      await etn.types.updateTypeProperty(networkId, ownerType, typeId, def.id, changes);
      if (changes.value_type !== undefined) notice('Обработка выполнена.');
      onDone();
      close();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  /** Deletes the property after a confirmation. */
  async function removeDef(close: () => void): Promise<void> {
    if (def === null) return;
    const ok = await confirmDialog(
      'Удалить свойство',
      `Удалить свойство «${def.key}»? Значения этого свойства у всех элементов будут удалены.`,
      true,
    );
    if (!ok) return;
    try {
      await etn.types.removeTypeProperty(networkId, ownerType, typeId, def.id);
      onDone();
      close();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  const buttons: DialogButton[] = isNew
    ? [
        { label: 'Отменить' },
        { label: 'Добавить', primary: true, keepOpen: true, onClick: (close) => void create(close) },
      ]
    : [
        { label: 'Отменить' },
        {
          label: 'Удалить',
          danger: true,
          keepOpen: true,
          onClick: (close) => void removeDef(close),
        },
        { label: 'Применить', primary: true, keepOpen: true, onClick: (close) => void apply(close) },
      ];

  showDialog({
    title: isNew ? 'Новое свойство' : `Свойство «${def.key}»`,
    body,
    width: 460,
    buttons,
    onMount: () => keyInput.focus(),
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
  body.append(tableWrap, errorLine);
  body.append(
    button('Добавить', () => showLinkTypeEditor(null, onChanged), 'btn small', 'Создать тип'),
  );

  let expanded = new Set<string>();

  const onChanged = (): void => void reload();

  async function reload(): Promise<void> {
    tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let types: LinkType[];
    try {
      types = await etn.types.listLinkTypes(networkId);
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    if (expanded.size === 0) {
      expanded = new Set(types.filter((t) => t.is_root).map((t) => t.id));
    }
    const table = el('table', 'table-list');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th', undefined, 'Имя (от источника к назначению / обратно)'),
      el('th', undefined, 'Комментарий'),
      el('th'),
    );
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    for (const row of visibleRows(types, expanded)) {
      const type = row.type;
      const tr = el('tr');
      if (type.is_root) tr.classList.add('type-tree-root');
      const nameCell = el('td');
      nameCell.style.whiteSpace = 'nowrap';
      const nameWrap = span('', 'type-tree-name');
      nameWrap.style.paddingLeft = `${Math.max(0, row.depth - 1) * 18}px`;
      nameWrap.append(treeToggle(row, expanded, () => void toggle(type.id)));
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
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      if (!type.is_root) {
        actions.append(button('✕', () => void removeRow(type), 'btn small', 'Удалить тип'));
      }
      tr.append(nameCell, descCell, actions);
      tr.addEventListener('click', () => showLinkTypeEditor(type, onChanged));
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
  }

  /** Expands/collapses a node and re-renders (no server round-trip). */
  function toggle(typeId: string): void {
    if (expanded.has(typeId)) expanded.delete(typeId);
    else expanded.add(typeId);
    void reload();
  }

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

/** Opens the link-type editor; `type === null` creates a new type (L6/L21). */
export function showLinkTypeEditor(type: LinkType | null, onChanged: () => void): void {
  const networkId = requireNetworkId();
  let current = type;
  const errorLine = span('', 'error-text');
  const body = div('form-stack');

  // Duplicate-pair guard: a link type is identified by its forward/reverse
  // name pair, unique ignoring case (08-ui-spec.md §8.1). The catalogue is
  // loaded once on open; the server re-checks on save.
  const DUP_PAIR_MSG = 'Тип связи с такими именами уже существует.';
  let allTypes: LinkType[] = [];
  let createBtn: HTMLButtonElement | null = null;

  // Top row: forward · reverse names · settings (⚙). The ⚙ stays visible but
  // inert until the new type is created («Создать и продолжить»).
  const namesRow = div('form-row type-editor-row');
  const forwardInput = el('input', 'text-input');
  forwardInput.type = 'text';
  forwardInput.value = type?.name_forward ?? '';
  forwardInput.maxLength = 200;
  forwardInput.placeholder = 'От источника к назначению (обязательно)';
  const reverseInput = el('input', 'text-input');
  reverseInput.type = 'text';
  reverseInput.value = type?.name_reverse ?? '';
  reverseInput.maxLength = 200;
  reverseInput.placeholder = 'От назначения к источнику (обязательно)';
  const settingsBtn = button('', openStyle, 'icon-btn', 'Настройки типа');
  settingsBtn.append(svgIcon('settings', 14));
  namesRow.append(forwardInput, reverseInput, settingsBtn);
  body.append(namesRow);

  // Parent picker (L21), same rules as the thought-type editor.
  let pickedParentId: string | null = type === null ? null : (type.parent_id ?? null);
  const parentField = div('field');
  if (type?.is_root === true) {
    const rootNote = el('p', 'muted', 'Корневой тип — родителя не имеет.');
    rootNote.style.margin = '0';
    parentField.append(rootNote);
  } else {
    const picker = buildParentPicker({
      kinds: 'link',
      currentId: () => current?.id ?? null,
      value: type?.parent_id ?? null,
      onChange: (parentId) => {
        pickedParentId = parentId;
        if (current !== null) {
          void patchStyle({ parent_id: parentId });
        }
      },
    });
    parentField.append(picker.root);
  }
  body.append(parentField);

  // Comment (type description / usage rules) — placeholder only, no label.
  const descArea = el('textarea', 'textarea-input');
  descArea.value = type?.description ?? '';
  descArea.rows = 3;
  descArea.placeholder = 'Комментарий: описание типа, правила применения…';
  body.append(descArea);

  body.append(errorLine);

  // Property sections (L21: link types gained the property table).
  const propsHost = div('form-stack');
  body.append(propsHost);
  renderProps();

  if (type === null) {
    const actions = div('form-row');
    createBtn = button(
      'Создать и продолжить',
      () => void commitNew(),
      'btn',
      'Создать тип и продолжить',
    );
    actions.append(createBtn);
    body.append(actions);
  }

  /** Applies an immediate patch (parent, line style) to the existing type.
   *  `style`/`width = null` mean «inherit from the parent type» (L21). */
  async function patchStyle(
    patch: {
      parent_id?: string | null;
      color?: string | null;
      style?: import('@etn/shared').LinkStyle | null;
      width?: number | null;
    },
  ): Promise<void> {
    if (current === null) return;
    // Only the fields present in the patch are sent — an absent field must
    // keep its stored value, not fall back to «inherit».
    const input: import('@etn/shared').LinkTypeUpdateInput = {};
    if (patch.parent_id !== undefined) input.parent_id = patch.parent_id;
    if (patch.color !== undefined) input.color = patch.color;
    if (patch.style !== undefined) input.style = patch.style;
    if (patch.width !== undefined) input.width = patch.width;
    try {
      current = await etn.types.updateLinkType(networkId, current.id, input, current.version);
      await refreshLinkTypes();
      onChanged();
    } catch (err) {
      errorDialog('Изменить тип связи', err);
    }
  }

  function openStyle(): void {
    if (current === null) return;
    // Show the effective line style (resolved along the chain, L21).
    const resolved = resolveLinkTypeVisual(store.state.linkTypes, current.id);
    showLinkStyleDialog({
      resolved: {
        color: current.color,
        style: current.style ?? resolved.style,
        width: current.width ?? resolved.width,
      },
      mode: 'type',
      // A reset in type mode returns null = inherit from the parent chain.
      onApply: (patch) => patchStyle(patch),
    });
  }

  /** Shows the property sections, or a hint while the type is not created yet. */
  function renderProps(): void {
    propsHost.replaceChildren();
    const label = el('p', 'muted', 'Свойства');
    label.style.margin = '8px 0 2px';
    propsHost.append(label);
    if (current !== null) {
      propsHost.append(buildPropertiesTable(networkId, 'link_type', current.id, onChanged));
    } else {
      propsHost.append(el('p', 'muted', 'Свойства станут доступны после создания типа.'));
    }
    settingsBtn.disabled = current === null;
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

  /** Live duplicate check on the name fields: warn + disable the create button. */
  function revalidateNames(): void {
    if (pairClash(forwardInput.value, reverseInput.value) !== null) {
      errorLine.textContent = DUP_PAIR_MSG;
      if (createBtn !== null) createBtn.disabled = true;
    } else {
      if (errorLine.textContent === DUP_PAIR_MSG) errorLine.textContent = '';
      if (createBtn !== null) createBtn.disabled = false;
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

  /** Creates the type and unlocks the settings button. */
  async function commitNew(): Promise<void> {
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
      current = await etn.types.createLinkType(networkId, {
        name_forward: nameForward,
        name_reverse: nameReverse,
        parent_id: pickedParentId,
        description: description === '' ? null : description,
      });
      await refreshLinkTypes();
      onChanged();
      errorLine.textContent = '';
      settingsBtn.disabled = false;
      renderProps();
      forwardInput.focus();
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }

  /** Autosaves the names/description of an existing type on blur. */
  async function saveFields(): Promise<void> {
    if (current === null) return;
    const nameForward = forwardInput.value.trim();
    const nameReverse = reverseInput.value.trim();
    if (nameForward === '' || nameReverse === '') {
      forwardInput.value = current.name_forward;
      reverseInput.value = current.name_reverse;
      errorLine.textContent = 'Оба имени обязательны — возвращены прежние.';
      return;
    }
    if (pairClash(nameForward, nameReverse) !== null) {
      errorLine.textContent = DUP_PAIR_MSG;
      return;
    }
    const description = descArea.value.trim();
    const nextDesc = description === '' ? null : description;
    if (
      nameForward === current.name_forward &&
      nameReverse === current.name_reverse &&
      nextDesc === current.description
    ) {
      return;
    }
    try {
      current = await etn.types.updateLinkType(
        networkId,
        current.id,
        { name_forward: nameForward, name_reverse: nameReverse, description: nextDesc },
        current.version,
      );
      await refreshLinkTypes();
      onChanged();
      errorLine.textContent = '';
    } catch (err) {
      errorLine.textContent = errText(err);
    }
  }
  forwardInput.addEventListener('input', revalidateNames);
  reverseInput.addEventListener('input', revalidateNames);
  forwardInput.addEventListener('blur', () => void saveFields());
  reverseInput.addEventListener('blur', () => void saveFields());
  descArea.addEventListener('blur', () => void saveFields());

  settingsBtn.disabled = type === null;

  showDialog({
    title: type === null ? 'Новый тип связи' : 'Тип связи',
    body,
    width: 560,
    buttons: [{ label: 'Закрыть', primary: true }],
    onMount: () => forwardInput.focus(),
  });
}
