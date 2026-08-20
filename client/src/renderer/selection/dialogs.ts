/**
 * Dialogs of the selection panel (08-ui-spec.md §5).
 *
 * - «Тип связи» picker — a searchable link-type combobox where "no type" is a
 *   valid choice (batch ops accept `link_type_id: null`);
 * - «Изменить тип» — a searchable thought-type combobox over the catalogue,
 *   "no type" clears the type of every selected thought;
 * - «Изменить значение свойства» — one table of every property defined by the
 *   thought types met in the selection; «Применить» writes each filled value
 *   only to the thoughts whose own type defines that property (the server
 *   rejects a key foreign to the owner's type, so the client filters first).
 */

import type { PropertyDefinition, PropertyValueType, ThoughtRef } from '@etn/shared';

import { requireNetworkId } from '../app.js';
import { firstPickedThoughtId, pickThoughtsDialog } from '../canvas/add-dialog.js';
import { buildValueOptionsCaret } from '../editor/properties.js';
import { wireThoughtRefSearch } from '../editor/thought-picker.js';
import { button, div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { createTypeCombobox, type TypeOption } from '../lib/type-combobox.js';
import { orderedTypeRows, resolveLinkTypeVisual } from '../lib/type-tree.js';
import { showDialog } from '../lib/dialog.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';

/** A value editor state row kept until «Применить». */
interface PropertyRowState {
  def: PropertyDefinition;
  /** `null`/undefined — the row is left empty and is not applied. */
  value: unknown;
}

/** Focus the combobox text input once the dialog is mounted. */
function focusCombo(combo: HTMLElement): void {
  combo.querySelector('input')?.focus();
}

// ---------------------------------------------------------------------------
// Link type picker
// ---------------------------------------------------------------------------

/**
 * Asks for a link type. Resolves the chosen type id, `null` for "no type", or
 * `undefined` when cancelled. The pick also becomes the add-dialog default
 * (`last_used_link_type_id`, L4).
 */
export function pickLinkType(title: string): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    const combo = createTypeCombobox({
      options: (): TypeOption[] =>
        orderedTypeRows(store.state.linkTypes).map((row) => {
          const line = resolveLinkTypeVisual(store.state.linkTypes, row.type.id);
          return {
            id: row.type.id,
            label: row.type.name_forward,
            parent_id: row.type.parent_id,
            depth: row.depth,
            has_children: row.hasChildren,
            selectable: !row.type.is_root,
            line: { color: line.color, style: line.style, width: line.width },
          };
        }),
      value: store.state.lastUsedLinkTypeId,
      emptyLabel: 'Без типа',
      placeholder: 'Поиск типа связи…',
      onChange: () => undefined,
    });
    showDialog({
      title,
      body: combo.root,
      width: 420,
      buttons: [
        { label: 'Отмена', onClick: () => resolve(undefined) },
        {
          label: 'OK',
          primary: true,
          onClick: () => {
            const id = combo.value();
            store.update({ lastUsedLinkTypeId: id });
            resolve(id);
          },
        },
      ],
      onMount: () => focusCombo(combo.root),
    });
  });
}

// ---------------------------------------------------------------------------
// Thought type picker («Изменить тип»)
// ---------------------------------------------------------------------------

/**
 * Asks for a thought type. Resolves the chosen type id, `null` to clear the
 * type, or `undefined` when cancelled.
 */
export function pickThoughtType(initial: string | null): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    const combo = createTypeCombobox({
      options: (): TypeOption[] =>
        orderedTypeRows(store.state.thoughtTypes).map((row) => ({
          id: row.type.id,
          label: row.type.name,
          parent_id: row.type.parent_id,
          depth: row.depth,
          has_children: row.hasChildren,
          selectable: !row.type.is_root,
          icon: { icon: row.type.icon, kind: row.type.icon_kind },
          style: {
            fg: row.type.fg_color,
            bg: row.type.bg_color,
            bold: row.type.font_bold ?? false,
            italic: row.type.font_italic ?? false,
            underline: row.type.font_underline ?? false,
            strike: row.type.font_strike ?? false,
          },
        })),
      value: initial,
      emptyLabel: 'Без типа (очистить тип)',
      placeholder: 'Поиск типа…',
      onChange: () => undefined,
    });
    showDialog({
      title: 'Изменить тип',
      body: combo.root,
      width: 420,
      buttons: [
        { label: 'Отмена', onClick: () => resolve(undefined) },
        {
          label: 'OK',
          primary: true,
          onClick: () => resolve(combo.value()),
        },
      ],
      onMount: () => focusCombo(combo.root),
    });
  });
}

// ---------------------------------------------------------------------------
// Property values («Изменить значение свойства»)
// ---------------------------------------------------------------------------

/** Opens the property-value dialog for the selected thoughts. */
export function showSelectionPropertiesDialog(ids: string[]): void {
  const networkId = requireNetworkId();
  const body = div('form-stack');
  body.append(el('span', 'muted', 'Загрузка…'));

  const rows = new Map<string, PropertyRowState>();
  // Filled by the loader below; «Применить» filters on them so the server only
  // sees (thought, key) pairs the thought's own type defines.
  let selectedRefs: ThoughtRef[] = [];
  let defsByType = new Map<string, PropertyDefinition[]>();

  const applyBtn = {
    label: 'Применить',
    primary: true,
    keepOpen: true,
    onClick: (close: () => void) => void applyAll(close),
  };
  showDialog({
    title: 'Значения свойств выделенных мыслей',
    body,
    width: 560,
    buttons: [{ label: 'Закрыть', onClick: () => undefined }, applyBtn],
  });

  /** Writes every filled value to the thoughts whose type defines the property. */
  async function applyAll(closeDialog: () => void): Promise<void> {
    const filled = [...rows.values()].filter((row) => row.value !== null && row.value !== '');
    if (filled.length === 0) {
      notice('Заполните хотя бы одно значение свойства.');
      return;
    }
    let applied = 0;
    let failed = 0;
    for (const row of filled) {
      for (const ref of selectedRefs) {
        const defs = ref.type_id === null ? undefined : defsByType.get(ref.type_id);
        if (defs === undefined || !defs.some((d) => d.id === row.def.id)) continue;
        try {
          await etn.properties.set(networkId, 'thought', ref.id, row.def.key, row.value);
          applied += 1;
        } catch {
          failed += 1;
        }
      }
    }
    if (applied > 0) notice(`Значения применены (${applied}).`);
    if (failed > 0) notice(`Не удалось применить: ${failed}.`, 'error');
    closeDialog();
  }

  void (async () => {
    let refs: ThoughtRef[];
    try {
      refs = await etn.thoughts.resolve(networkId, ids.slice(0, 100));
    } catch (err) {
      body.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    selectedRefs = refs;
    // Property definitions of every thought type met in the selection.
    const typeIds = [...new Set(refs.map((r) => r.type_id).filter((t): t is string => t !== null))];
    defsByType = new Map<string, PropertyDefinition[]>();
    try {
      const perType = await Promise.all(
        typeIds.map(async (typeId) => {
          const defs = await etn.types.listTypeProperties(networkId, 'thought_type', typeId);
          return [typeId, defs] as const;
        }),
      );
      for (const [typeId, defs] of perType) defsByType.set(typeId, defs);
    } catch (err) {
      body.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }

    const typeNames = new Map(store.state.thoughtTypes.map((t) => [t.id, t.name]));
    const table = el('table', 'table-list prop-table');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.append(el('th', undefined, 'Свойство'), el('th', undefined, 'Тип'), el('th', undefined, 'Значение'));
    thead.append(headRow);
    const tbody = el('tbody');
    table.append(thead, tbody);

    for (const [typeId, defs] of defsByType) {
      const typeName = typeNames.get(typeId) ?? '';
      for (const def of defs) {
        if (rows.has(def.id)) continue;
        const state: PropertyRowState = { def, value: null };
        rows.set(def.id, state);
        const row = el('tr');
        row.append(el('td', undefined, def.key));
        row.append(el('td', undefined, typeName));
        row.append(buildValueCell(state));
        tbody.append(row);
      }
    }

    if (rows.size === 0) {
      body.replaceChildren(
        el('p', 'muted', 'У типов выделенных мыслей нет задаваемых свойств.'),
      );
      return;
    }
    body.replaceChildren(
      el('p', 'muted', 'Значения применяются только к мыслям, чей тип предусматривает свойство.'),
      table,
    );
  })();
  /** Titles of picked thought_ref values (resolved once, then cached). */
  const refTitles = new Map<string, string>();

  /** Resolves a thought title for a thought_ref input. */
  async function ensureRefTitle(id: string): Promise<void> {
    if (refTitles.has(id)) return;
    try {
      const resolved = await etn.thoughts.resolve(networkId, [id]);
      const title = resolved[0]?.title;
      if (title !== undefined) refTitles.set(id, title);
    } catch {
      // The raw id is shown when resolve fails.
    }
  }

  /** Builds the value editor cell for one property row. */
  function buildValueCell(state: PropertyRowState): HTMLTableCellElement {
    const cell = el('td');
    const def = state.def;
    const valueType: PropertyValueType = def.value_type;
    if (valueType === 'text' || valueType === 'url') {
      const input = el('input', 'text-input prop-editor');
      input.type = 'text';
      if (valueType === 'url') {
        input.placeholder = 'https://… или путь к файлу';
        input.title = 'URL или путь к файлу';
      }
      input.addEventListener('blur', () => {
        state.value = input.value.trim() === '' ? null : input.value;
      });
      // A text property with predefined options gets the same picker as the
      // editor's properties table (08-ui-spec.md §6.3).
      const options =
        valueType === 'text' ? (def.config?.options ?? []).filter((o) => o !== '') : [];
      if (options.length > 0) {
        const row = div('form-row');
        row.style.marginBottom = '0';
        row.append(
          input,
          buildValueOptionsCaret(
            input,
            options,
            def.config?.multiple === true,
            (value) => {
              state.value = value === '' ? null : value;
            },
            () => {
              input.value = '';
            },
          ),
        );
        cell.append(row);
      } else {
        cell.append(input);
      }
      return cell;
    }
    if (valueType === 'number') {
      const input = el('input', 'text-input prop-editor');
      input.type = 'number';
      input.addEventListener('input', () => {
        const n = Number(input.value);
        state.value = input.value === '' || !Number.isFinite(n) ? null : n;
      });
      cell.append(input);
      return cell;
    }
    if (valueType === 'date') {
      const input = el('input', 'text-input prop-editor');
      input.type = 'date';
      input.addEventListener('input', () => {
        state.value = input.value === '' ? null : input.value;
      });
      cell.append(input);
      return cell;
    }
    if (valueType === 'bool') {
      // Unlike the editor's checkbox, a select — the dialog needs an explicit
      // "leave unchanged" state ('—') next to да/нет.
      const select = el('select', 'select-input');
      select.append(
        el('option', undefined, '—'),
        el('option', undefined, 'да'),
        el('option', undefined, 'нет'),
      );
      select.value = '';
      select.addEventListener('change', () => {
        state.value = select.value === '' ? null : select.value === 'да';
      });
      cell.append(select);
      return cell;
    }
    // thought_ref: the field doubles as a live candidate search (with the
    // definition's type filter), exactly like the editor's properties table;
    // only a picked candidate becomes the value.
    const rebuild = (): void => {
      cell.replaceChildren();
      const input = el('input', 'text-input prop-editor');
      input.type = 'text';
      input.autocomplete = 'off';
      const storedId = typeof state.value === 'string' ? state.value : null;
      input.value = storedId !== null ? (refTitles.get(storedId) ?? storedId) : '';
      input.placeholder = 'введите название для поиска…';
      const filterIds = (
        def.config?.allowed_type_ids ??
        (def.config?.allowed_type_id !== undefined ? [def.config.allowed_type_id] : [])
      ).filter((id) => id !== '');
      wireThoughtRefSearch(input, {
        networkId,
        typeIds: filterIds,
        onPick: async (id) => {
          state.value = id;
          await ensureRefTitle(id);
          rebuild();
        },
      });
      const row = div('form-row');
      row.style.marginBottom = '0';
      row.append(
        input,
        button(
          'выбрать',
          () => {
            void pickThoughtsDialog({
              networkId,
              allowCreate: false,
              allowLinkType: false,
              searchTypeIds: filterIds,
            }).then(async (result) => {
              const id = firstPickedThoughtId(result);
              if (id === null) return;
              state.value = id;
              await ensureRefTitle(id);
              rebuild();
            });
          },
          'btn small',
        ),
      );
      if (storedId !== null) {
        row.append(
          button(
            '✕',
            () => {
              state.value = null;
              rebuild();
            },
            'btn small',
            'Очистить значение',
          ),
        );
      }
      cell.append(row);
    };
    rebuild();
    return cell;
  }
}
