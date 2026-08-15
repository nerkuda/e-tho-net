/**
 * Type catalogue management (L6, 08-ui-spec.md §8.1).
 *
 * Opened from the toolbar «Вид» menu:
 *  - «Типы мыслей» — list of thought types: icon, name rendered with the
 *    type's own colours/font, short description; alphabetical (server order);
 *    «Добавить» opens the editor, each row has a delete button. Deleting a
 *    type is forced: thoughts keep existing with `type_id = null`, and the
 *    type's property definitions (with all stored values) are dropped
 *    server-side.
 *  - «Типы связей» — list of link types (`name_forward / name_reverse` +
 *    description), same flow; links stay and become untyped.
 *
 * Thought-type editor: icon (same picker as the thought editor), required
 * name, ⚙ opens the same style dialog as the thought editor (type mode), a
 * free-form description ("комментарий": type purpose / usage rules) and the
 * property-definition table — key, value type, default value (stored as
 * `config.default_value`), reorder and delete.
 *
 * Link-type editor: forward/reverse names (required), ⚙ opens the same
 * line-style dialog as the link editor (type mode), description.
 */

import type { LinkType, PropertyDefinition, PropertyValueType, ThoughtType } from '@etn/shared';

import { requireNetworkId, scheduleRefresh } from '../app.js';
import { applyThoughtIcon } from '../canvas/canvas.js';
import { confirmDialog, errorDialog, showDialog } from '../lib/dialog.js';
import { button, div, el, errText, setTooltip, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { store } from '../state.js';
import { showIconDialog } from '../editor/icon-dialog.js';
import { showLinkStyleDialog, showThoughtStyleDialog } from '../editor/style-dialog.js';

/** Human-readable property value-type labels. */
const VALUE_TYPE_LABELS: Record<PropertyValueType, string> = {
  text: 'текст',
  number: 'число',
  date: 'дата',
  bool: 'да/нет',
  thought_ref: 'мысль',
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

/** Applies a type's colours/font flags to an element (list name cells). */
function applyTypeStyle(
  target: HTMLElement,
  t: Pick<ThoughtType, 'fg_color' | 'bg_color' | 'font_bold' | 'font_italic' | 'font_underline' | 'font_strike'>,
): void {
  if (t.fg_color !== null) target.style.color = t.fg_color;
  if (t.bg_color !== null) target.style.background = t.bg_color;
  target.classList.toggle('font-bold', t.font_bold);
  target.classList.toggle('font-italic', t.font_italic);
  target.classList.toggle('font-underline', t.font_underline);
  target.classList.toggle('font-strike', t.font_strike);
}

// ---------------------------------------------------------------------------
// Thought types: list + editor
// ---------------------------------------------------------------------------

/** Opens the thought-types list dialog (L6). */
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
    const table = el('table', 'table-list');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(el('th', undefined, 'Тип'), el('th', undefined, 'Комментарий'), el('th'));
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    for (const type of types) {
      const row = el('tr');
      const nameCell = el('td');
      const icon = span('', 'mini-icon');
      applyThoughtIcon(icon, { icon: type.icon, icon_kind: type.icon_kind, type_id: null });
      const name = span(type.name, 'type-list-name');
      applyTypeStyle(name, type);
      nameCell.append(icon, name);
      const descCell = el('td', 'muted', (type.description ?? '').slice(0, 120));
      descCell.style.maxWidth = '280px';
      descCell.style.overflow = 'hidden';
      descCell.style.textOverflow = 'ellipsis';
      descCell.style.whiteSpace = 'nowrap';
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      actions.append(button('✕', () => void removeRow(type), 'btn small', 'Удалить тип'));
      row.append(nameCell, descCell, actions);
      row.addEventListener('click', () => showThoughtTypeEditor(type, onChanged));
      tbody.append(row);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
    if (types.length === 0) tableWrap.replaceChildren(el('p', 'muted', 'Типов нет.'));
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

/** Opens the thought-type editor; `type === null` creates a new type (L6). */
export function showThoughtTypeEditor(type: ThoughtType | null, onChanged: () => void): void {
  const networkId = requireNetworkId();
  // Kept fresh after every immediate patch (icon/style) for If-Match versions.
  let current = type;
  const errorLine = span('', 'error-text');
  const body = div('form-stack');

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
  const settingsBtn = button('⚙', openStyle, 'icon-btn');
  setTooltip(settingsBtn, 'Настройки типа');
  topRow.append(iconBox, nameInput, settingsBtn);
  body.append(topRow);

  // Comment (type description / usage rules) — placeholder only, no label.
  const descArea = el('textarea', 'textarea-input');
  descArea.value = type?.description ?? '';
  descArea.rows = 3;
  descArea.placeholder = 'Комментарий: описание типа, правила применения…';
  body.append(descArea);

  body.append(errorLine);

  // Property table — always visible; a placeholder row until the type exists.
  const propsHost = div('form-stack');
  body.append(propsHost);
  renderProps();

  if (type === null) {
    const actions = div('form-row');
    actions.append(
      button('Создать и продолжить', () => void commitNew(), 'btn', 'Создать тип и продолжить'),
    );
    body.append(actions);
  }

  /** Applies an immediate patch (icon, style) to the existing type. */
  async function patchType(
    patch: {
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
      // The type's font flags are NOT NULL: a reset arrives as null → false.
      const input = {
        ...patch,
        font_bold: patch.font_bold ?? false,
        font_italic: patch.font_italic ?? false,
        font_underline: patch.font_underline ?? false,
        font_strike: patch.font_strike ?? false,
      };
      current = await etn.types.updateThoughtType(networkId, current.id, input, current.version);
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
        bold: current.font_bold,
        italic: current.font_italic,
        underline: current.font_underline,
        strike: current.font_strike,
      },
      mode: 'type',
      onApply: (patch) => patchType(patch),
    });
  }

  /** Shows the property table, or a hint while the type is not created yet. */
  function renderProps(): void {
    propsHost.replaceChildren();
    const label = el('p', 'muted', 'Свойства типа');
    label.style.margin = '8px 0 2px';
    propsHost.append(label);
    if (current !== null) {
      propsHost.append(buildPropertiesTable(networkId, current.id, onChanged));
    } else {
      propsHost.append(el('p', 'muted', 'Свойства станут доступны после создания типа.'));
    }
    settingsBtn.disabled = current === null;
    iconBox.disabled = current === null;
  }

  /** Creates the type and unlocks the icon, settings and properties. */
  async function commitNew(): Promise<void> {
    const name = nameInput.value.trim();
    if (name === '') {
      errorLine.textContent = 'Название типа обязательно.';
      return;
    }
    const description = descArea.value.trim();
    try {
      current = await etn.types.createThoughtType(networkId, {
        name,
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
// Property-definition table (thought-type editor)
// ---------------------------------------------------------------------------

/**
 * Builds the property-definition table of a thought type: key, value type,
 * default value (`config.default_value`), reorder and delete (L6). Operations
 * commit immediately through the types API.
 */
function buildPropertiesTable(networkId: string, typeId: string, onTouched: () => void): HTMLElement {
  const box = div('form-stack');
  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '220px';
  const errorLine = span('', 'error-text');
  box.append(tableWrap, errorLine);
  box.append(button('Добавить свойство', () => void appendDraft(), 'btn small'));

  let defs: PropertyDefinition[] = [];

  /** Persists a new default into the definition's config. */
  async function saveDefault(def: PropertyDefinition, value: unknown): Promise<void> {
    const config: Record<string, unknown> = { ...(def.config ?? {}) };
    if (value === null || value === '' || value === undefined) {
      delete config['default_value'];
    } else {
      config['default_value'] = value;
    }
    try {
      await etn.types.updateTypeProperty(networkId, 'thought_type', typeId, def.id, {
        config: config as PropertyDefinition['config'],
      });
      await reload();
    } catch (err) {
      errorDialog('Значение по умолчанию', err);
    }
  }

  /** Moves a definition one slot up/down and persists the new order. */
  async function move(defId: string, delta: -1 | 1): Promise<void> {
    const ids = defs.map((d) => d.id);
    const from = ids.indexOf(defId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    try {
      await etn.types.reorderTypeProperties(networkId, 'thought_type', typeId, ids);
      await reload();
    } catch (err) {
      errorDialog('Изменить порядок', err);
    }
  }

  /** Deletes one definition (its stored values cascade server-side). */
  async function remove(def: PropertyDefinition): Promise<void> {
    const ok = await confirmDialog(
      'Удалить свойство',
      `Удалить свойство «${def.key}»? Значения этого свойства у всех мыслей будут удалены.`,
      true,
    );
    if (!ok) return;
    try {
      await etn.types.removeTypeProperty(networkId, 'thought_type', typeId, def.id);
      await reload();
    } catch (err) {
      errorDialog('Удалить свойство', err);
    }
  }

  /** Builds the default-value editor for one definition. */
  function defaultEditor(def: PropertyDefinition): HTMLElement {
    const stored = def.config?.default_value ?? null;
    switch (def.value_type) {
      case 'text': {
        const input = el('input', 'text-input prop-editor');
        input.type = 'text';
        input.value = typeof stored === 'string' ? stored : '';
        input.addEventListener('blur', () => void saveDefault(def, input.value.trim()));
        return input;
      }
      case 'number': {
        const input = el('input', 'text-input prop-editor');
        input.type = 'number';
        input.value = typeof stored === 'number' ? String(stored) : '';
        input.addEventListener('blur', () => {
          const n = input.value === '' ? null : Number(input.value);
          if (n === null || Number.isFinite(n)) void saveDefault(def, n);
        });
        return input;
      }
      case 'date': {
        const input = el('input', 'text-input prop-editor');
        input.type = 'date';
        input.value = typeof stored === 'string' ? stored : '';
        input.addEventListener('blur', () => void saveDefault(def, input.value === '' ? null : input.value));
        return input;
      }
      case 'bool': {
        const input = el('input');
        input.type = 'checkbox';
        input.checked = stored === true;
        input.addEventListener('change', () => void saveDefault(def, input.checked));
        return input;
      }
      default:
        // thought_ref defaults are not supported — a default target makes no
        // sense across thoughts.
        return span('—', 'muted');
    }
  }

  /** Adds the "new property" draft row on top of the table. */
  function appendDraft(): void {
    const row = el('tr', 'prop-draft-row');
    const keyCell = el('td');
    const keyInput = el('input', 'text-input prop-editor');
    keyInput.type = 'text';
    keyInput.placeholder = 'имя свойства';
    keyCell.append(keyInput);
    const typeCell = el('td');
    const typeSelect = el('select', 'select-input');
    for (const [value, label] of Object.entries(VALUE_TYPE_LABELS)) {
      const option = el('option', undefined, label);
      option.value = value;
      typeSelect.append(option);
    }
    typeCell.append(typeSelect);
    const actions = el('td');
    actions.style.whiteSpace = 'nowrap';
    actions.append(
      button(
        'Создать',
        () => {
          void (async () => {
            const key = keyInput.value.trim();
            if (key === '') {
              errorLine.textContent = 'Имя свойства обязательно.';
              return;
            }
            errorLine.textContent = '';
            try {
              await etn.types.createTypeProperty(networkId, 'thought_type', typeId, {
                key,
                value_type: typeSelect.value as PropertyValueType,
                position: defs.length,
              });
              onTouched();
              await reload();
            } catch (err) {
              errorLine.textContent = errText(err);
            }
          })();
        },
        'btn small',
      ),
    );
    row.append(keyCell, typeCell, el('td'), actions);
    const table = tableWrap.querySelector('table');
    table?.querySelector('tbody')?.prepend(row);
    keyInput.focus();
  }

  /** Renders the definitions table from the server. */
  async function reload(): Promise<void> {
    if (!box.isConnected) return;
    try {
      defs = await etn.types.listTypeProperties(networkId, 'thought_type', typeId);
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
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
    for (const def of defs) {
      const row = el('tr');
      // The key identifies stored values — it is fixed after creation.
      row.append(el('td', undefined, def.key));
      // The value type governs the storage column — fixed after creation too.
      row.append(el('td', 'muted', VALUE_TYPE_LABELS[def.value_type]));
      const defaultCell = el('td');
      defaultCell.append(defaultEditor(def));
      row.append(defaultCell);
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      actions.append(
        button('▲', () => void move(def.id, -1), 'btn small', 'Выше'),
        button('▼', () => void move(def.id, 1), 'btn small', 'Ниже'),
        button('✕', () => void remove(def), 'btn small', 'Удалить свойство'),
      );
      row.append(actions);
      tbody.append(row);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
    if (defs.length === 0) tableWrap.replaceChildren(el('p', 'muted', 'У типа нет свойств.'));
  }

  void reload();
  return box;
}

// ---------------------------------------------------------------------------
// Link types: list + editor
// ---------------------------------------------------------------------------

/** Opens the link-types list dialog (L6). */
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
    for (const type of types) {
      const row = el('tr');
      const nameCell = el('td', undefined, `${type.name_forward} / ${type.name_reverse}`);
      const descCell = el('td', 'muted', (type.description ?? '').slice(0, 120));
      descCell.style.maxWidth = '260px';
      descCell.style.overflow = 'hidden';
      descCell.style.textOverflow = 'ellipsis';
      descCell.style.whiteSpace = 'nowrap';
      const actions = el('td');
      actions.style.whiteSpace = 'nowrap';
      actions.append(button('✕', () => void removeRow(type), 'btn small', 'Удалить тип'));
      row.append(nameCell, descCell, actions);
      row.addEventListener('click', () => showLinkTypeEditor(type, onChanged));
      tbody.append(row);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
    if (types.length === 0) tableWrap.replaceChildren(el('p', 'muted', 'Типов нет.'));
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

/** Opens the link-type editor; `type === null` creates a new type (L6). */
export function showLinkTypeEditor(type: LinkType | null, onChanged: () => void): void {
  const networkId = requireNetworkId();
  let current = type;
  const errorLine = span('', 'error-text');
  const body = div('form-stack');

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
  const settingsBtn = button('⚙', openStyle, 'icon-btn');
  setTooltip(settingsBtn, 'Настройки типа');
  namesRow.append(forwardInput, reverseInput, settingsBtn);
  body.append(namesRow);

  // Comment (type description / usage rules) — placeholder only, no label.
  const descArea = el('textarea', 'textarea-input');
  descArea.value = type?.description ?? '';
  descArea.rows = 3;
  descArea.placeholder = 'Комментарий: описание типа, правила применения…';
  body.append(descArea);

  body.append(errorLine);

  if (type === null) {
    const actions = div('form-row');
    actions.append(
      button('Создать и продолжить', () => void commitNew(), 'btn', 'Создать тип и продолжить'),
    );
    body.append(actions);
  }

  /** Applies an immediate line-style patch to the existing type. */
  async function patchStyle(
    patch: { color?: string | null; style?: import('@etn/shared').LinkStyle | null; width?: number | null },
  ): Promise<void> {
    if (current === null) return;
    try {
      // A link type has no null-style semantics — plain defaults instead.
      current = await etn.types.updateLinkType(
        networkId,
        current.id,
        {
          color: patch.color ?? null,
          style: patch.style ?? 'solid',
          width: patch.width ?? 1,
        },
        current.version,
      );
      await refreshLinkTypes();
      onChanged();
    } catch (err) {
      errorDialog('Изменить тип связи', err);
    }
  }

  function openStyle(): void {
    if (current === null) return;
    showLinkStyleDialog({
      resolved: {
        color: current.color,
        style: current.style,
        width: current.width,
      },
      mode: 'type',
      onApply: (patch) => patchStyle(patch),
    });
  }

  /** Creates the type and unlocks the settings button. */
  async function commitNew(): Promise<void> {
    const nameForward = forwardInput.value.trim();
    const nameReverse = reverseInput.value.trim();
    if (nameForward === '' || nameReverse === '') {
      errorLine.textContent = 'Оба имени обязательны.';
      return;
    }
    const description = descArea.value.trim();
    try {
      current = await etn.types.createLinkType(networkId, {
        name_forward: nameForward,
        name_reverse: nameReverse,
        description: description === '' ? null : description,
      });
      await refreshLinkTypes();
      onChanged();
      errorLine.textContent = '';
      settingsBtn.disabled = false;
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
