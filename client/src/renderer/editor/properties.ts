/**
 * Editor group: properties (H11, 08-ui-spec.md §6.3; 09-scenarios.md D4).
 *
 * Thought-only. When the thought has a type with property definitions, a table
 * of value editors is rendered per `value_type`:
 *  - text/number/date → inputs, saved on blur (empty → remove); a text value
 *    with predefined options also gets a suggestion dropdown that filters as
 *    the user types (an input aid, never a restriction);
 *  - url → input plus an «Открыть» button that hands the value to the OS
 *    default handler (http/https, file://, local paths, registered protocols);
 *  - bool → checkbox;
 *  - thought_ref → editable field doubling as a live candidate search (plus
 *    the duplicate-search dialog picker); stores the referenced thought id,
 *    titles resolved via `thoughts.resolve`. With `config.multiple` the cell
 *    becomes a chip list of the selected thoughts: clicking it (or «выбрать»)
 *    opens the same search dialog in multi mode, each chip is removable.
 *
 * Values are written with `properties.set`, cleared with `properties.remove`;
 * realtime `property-value.*` events reload the table when the open entity is
 * the owner (a single module-level listener keeps closures bounded).
 */

import type { EffectiveTypeProperty, PropertyValue } from '@etn/shared';

import { onRealtimeEvent } from '../realtime.js';
import { button, div, el, errText, positionBodyDropdown, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { expandTypeIdsToSubtree } from '../lib/type-tree.js';
import { requireNetworkId } from '../app.js';
import { store } from '../state.js';
import { registerMainSection, type EditorContext } from './editor.js';
import { wireThoughtRefSearch } from './thought-picker.js';
import {
  firstPickedThoughtId,
  pickThoughtsDialog,
  pickedThoughtIds,
} from '../canvas/add-dialog.js';

/** Reload callback of the currently mounted properties table (or null). */
let currentReload: (() => void) | null = null;
let wired = false;

/** Registers the properties section of the «Основное» tab (thoughts only). */
export function registerPropertiesGroup(): void {
  registerMainSection((ctx) => {
    if (ctx.ownerType !== 'thought') return null;
    return {
      id: 'properties',
      title: 'Свойства',
      loadCount: () => countProperties(ctx),
      buildBody: () => buildPropertiesBody(ctx),
    };
  });
  if (!wired) {
    wired = true;
    onRealtimeEvent((evt) => {
      if (evt.type === 'property-value.set' || evt.type === 'property-value.deleted') {
        currentReload?.();
      }
    });
  }
}

/** Counts the type's effective property definitions for the group badge. */
async function countProperties(ctx: EditorContext): Promise<string | undefined> {
  const networkId = requireNetworkId();
  // L21: an untyped thought shows the root type's properties.
  const typeId = resolveEditorTypeId(ctx);
  if (typeId === null) return undefined;
  try {
    const defs = await etn.types.listTypeProperties(networkId, 'thought_type', typeId);
    return `(${defs.length})`;
  } catch {
    return undefined;
  }
}

/**
 * The type whose properties the editor shows (L21): the thought's own type,
 * or the root type «основной тип» for an untyped thought (its settings apply
 * to every element without a type). `null` when the catalogue has no root
 * (mid-migration edge).
 */
function resolveEditorTypeId(ctx: EditorContext): string | null {
  if (ctx.thought?.type_id != null) return ctx.thought.type_id;
  return store.state.thoughtTypes.find((t) => t.is_root)?.id ?? null;
}

/** Builds the properties table for the current thought. */
function buildPropertiesBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const thoughtId = ctx.ownerId;
  const typeId = resolveEditorTypeId(ctx);

  const box = div('properties-body');
  if (typeId === null) {
    box.append(el('p', 'muted', 'Свойства недоступны.'));
    return box;
  }
  // Guarded above; the fallback is unreachable but keeps closure typing honest.
  const typedId: string = typeId;

  const tableWrap = div('admin-table-wrap prop-wrap');
  // No column headers and at most five visible rows — vertical scroll beyond
  // that (08-ui-spec.md §6.3.1).
  tableWrap.append(el('span', 'muted', 'Загрузка…'));
  box.append(tableWrap);

  const refTitles = new Map<string, string>();
  // Declared BEFORE the initial reload() call below: reload is a hoisted
  // function declaration, and reading this from inside it during the call at
  // the `void reload()` line would hit the temporal dead zone.
  let everMounted = false;
  currentReload = () => void reload();
  void reload();

  /** Loads definitions + values and renders the table. */
  async function reload(): Promise<void> {
    // The first reload starts before the group mounts this box — it must
    // proceed detached. Skip only bodies that were mounted and then replaced
    // by a newer editor render.
    if (everMounted && !box.isConnected) return;
    tableWrap.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let definitions: EffectiveTypeProperty[];
    let values: PropertyValue[];
    try {
      [definitions, values] = await Promise.all([
        etn.types.listTypeProperties(networkId, 'thought_type', typedId),
        etn.properties.get(networkId, 'thought', thoughtId),
      ]);
      // Titles of every referenced thought — single ids and multiple-ref
      // arrays alike (one resolve call, capped at 100 ids).
      const refIds = [
        ...new Set(
          values.flatMap((v) =>
            typeof v.value === 'string'
              ? [v.value]
              : Array.isArray(v.value)
                ? v.value
                : [],
          ),
        ),
      ];
      if (refIds.length > 0) {
        const resolved = await etn.thoughts.resolve(networkId, refIds.slice(0, 100));
        for (const ref of resolved) refTitles.set(ref.id, ref.title);
      }
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    if (box.isConnected) everMounted = true;
    if (definitions.length === 0) {
      tableWrap.replaceChildren(el('p', 'muted', 'У типа нет свойств.'));
      return;
    }

    const valueByProp = new Map(values.map((v) => [v.property_id, v]));
    const table = el('table', 'table-list prop-table');
    // Headerless table (08-ui-spec.md §6.3.1): rows only.
    const tbody = el('tbody');
    for (const definition of definitions) {
      const value = valueByProp.get(definition.id);
      const row = el('tr');
      const source = definition.inherited
        ? ` · из «${definition.defined_on_name}»`
        : '';
      row.append(
        el(
          'td',
          undefined,
          `${definition.key}${definition.required ? ' *' : ''} (${typeName(definition.value_type)})${source}`,
        ),
      );
      row.append(buildEditorCell(definition, value));
      tbody.append(row);
    }
    table.append(tbody);
    tableWrap.replaceChildren(table);
  }

  /** Builds the value editor cell for one property. */
  function buildEditorCell(
    definition: EffectiveTypeProperty,
    current: PropertyValue | undefined,
  ): HTMLElement {
    const cell = el('td');
    const stored = current?.value ?? null;

    const save = async (value: unknown | null): Promise<boolean> => {
      try {
        if (value === null) {
          await etn.properties.remove(networkId, 'thought', thoughtId, definition.key);
        } else {
          await etn.properties.set(networkId, 'thought', thoughtId, definition.key, value);
        }
        return true;
      } catch (err) {
        cell.append(span(` Ошибка: ${errText(err)}`, 'error-text'));
        return false;
      }
    };

    switch (definition.value_type) {
      case 'text':
      case 'url': {
        const input = el('input', 'text-input prop-editor');
        input.type = 'text';
        input.value = typeof stored === 'string' ? stored : '';
        if (definition.value_type === 'url') {
          input.placeholder = 'https://… или путь к файлу';
          input.title = 'URL или путь к файлу';
        }
        // Baseline tracks the last saved value so picker commits and plain
        // blur commits never fire twice for the same value.
        let baseline: string | null = typeof stored === 'string' ? stored : null;
        const commitValue = (value: string): void => {
          const next = value === '' ? null : value;
          if (next === baseline) return;
          baseline = next;
          void save(next);
        };
        input.addEventListener('blur', () => commitValue(input.value));
        // A text property with predefined options (02-data-model.md §3.4)
        // gets a picker — an input aid, never a restriction: the value stays
        // freely editable (08-ui-spec.md §6.3).
        const options =
          definition.value_type === 'text'
            ? (definition.config?.options ?? []).filter((o) => o !== '')
            : [];
        if (options.length > 0) {
          const revertValue = (): void => {
            input.value = baseline ?? '';
          };
          const row = div('form-row');
          row.style.marginBottom = '0';
          row.append(
            input,
            buildValueOptionsCaret(
              input,
              options,
              definition.config?.multiple === true,
              commitValue,
              revertValue,
            ),
          );
          cell.append(row);
        } else if (definition.value_type === 'url') {
          // A url property gets an «Открыть» button: it hands the value to the
          // OS default handler — http/https, `file://`, local paths and other
          // registered protocols (obsidian://, …); a failure to open surfaces
          // as a toast (08-ui-spec.md §6.3.1). Clicking blurs the input first,
          // so the pending edit is committed before it is opened.
          const openBtn = button('Открыть', () => void openUrlExternally(), 'btn small');
          const syncOpenBtn = (): void => {
            openBtn.disabled = input.value.trim() === '';
          };
          async function openUrlExternally(): Promise<void> {
            const value = input.value.trim();
            if (value === '') return;
            const err = await etn.system.openExternal(value);
            if (err !== '') notice(`Не удалось открыть: ${err}`, 'error');
          }
          input.addEventListener('input', syncOpenBtn);
          syncOpenBtn();
          const row = div('form-row');
          row.style.marginBottom = '0';
          row.append(input, openBtn);
          cell.append(row);
        } else {
          cell.append(input);
        }
        break;
      }
      case 'number': {
        const input = el('input', 'text-input prop-editor');
        input.type = 'number';
        input.value = typeof stored === 'number' ? String(stored) : '';
        input.addEventListener('blur', () => {
          const next = input.value === '' ? null : Number(input.value);
          if (next === null) void save(null);
          else if (next !== stored && Number.isFinite(next)) void save(next);
        });
        cell.append(input);
        break;
      }
      case 'date': {
        const input = el('input', 'text-input prop-editor');
        input.type = 'date';
        input.value = typeof stored === 'string' ? stored.slice(0, 10) : '';
        input.addEventListener('blur', () => {
          if (input.value === '') void save(null);
          else void save(input.value);
        });
        cell.append(input);
        break;
      }
      case 'bool': {
        const input = el('input');
        input.type = 'checkbox';
        input.checked = stored === true;
        input.addEventListener('change', () => void save(input.checked));
        cell.append(input);
        break;
      }
      case 'thought_ref': {
        // Type filter from the definition config (list form supersedes the
        // legacy single id); an input aid — stored values are untouched.
        // L21: the filter expands to whole subtrees — a parent type matches
        // its descendants (mirror of the server-side validation).
        const filterIds = expandTypeIdsToSubtree(
          store.state.thoughtTypes,
          (
            definition.config?.allowed_type_ids ??
            (definition.config?.allowed_type_id !== undefined
              ? [definition.config.allowed_type_id]
              : [])
          ).filter((id) => id !== ''),
        );
        // Multiple form (02-data-model.md §3.4): a chip list of the selected
        // thoughts; the dialog picker runs in multi mode (prefilled), each
        // chip is removable (08-ui-spec.md §6.3.1).
        if (definition.config?.multiple === true) {
          const storedIds = Array.isArray(stored)
            ? stored
            : typeof stored === 'string'
              ? [stored]
              : [];
          cell.append(
            buildMultiThoughtRefEditor({
              networkId,
              filterIds,
              titles: refTitles,
              ids: storedIds,
              save: async (ids) => {
                const ok = await save(ids.length > 0 ? ids : null);
                if (ok) void reload();
              },
            }),
          );
          break;
        }
        const input = el('input', 'text-input prop-editor');
        input.type = 'text';
        input.autocomplete = 'off';
        const storedId = typeof stored === 'string' ? stored : null;
        input.value = storedId !== null ? (refTitles.get(storedId) ?? storedId) : '';
        input.placeholder = 'введите название для поиска…';
        // The field doubles as a live search: typing lists candidates (with
        // the type filter applied); only a picked candidate writes the value.
        // The modal picker stays as an alternative way to choose.
        wireThoughtRefSearch(input, {
          networkId,
          typeIds: filterIds,
          // No realtime echo to the actor (04-realtime.md §5) — reload the
          // table after a successful save so the resolved title and the clear
          // button appear at once.
          onPick: async (id) => {
            if (await save(id)) void reload();
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
                if (id !== null && (await save(id))) void reload();
              });
            },
            'btn small',
          ),
        );
        if (stored !== null) {
          row.append(
            button(
              '✕',
              () => {
                void save(null).then((ok) => {
                  if (ok) void reload();
                });
              },
              'btn small',
              'Очистить значение',
            ),
          );
        }
        cell.append(row);
        break;
      }
    }
    return cell;
  }

  /** Human-readable property type name. */
  function typeName(valueType: string): string {
    switch (valueType) {
      case 'text':
        return 'строка';
      case 'number':
        return 'число';
      case 'date':
        return 'дата';
      case 'bool':
        return 'да/нет';
      case 'thought_ref':
        return 'мысль';
      case 'url':
        return 'URL';
      default:
        return valueType;
    }
  }

  return box;
}

/** Test seam for unit tests. */
export const propertiesInternals = { buildPropertiesBody };

// ---------------------------------------------------------------------------
// Multiple thought_ref picker (08-ui-spec.md §6.3.1)
// ---------------------------------------------------------------------------

/**
 * Builds the multi-value `thought_ref` editor (definitions with
 * `config.multiple`): a chip field listing the selected thoughts (the same
 * chip styling as the structures filter panel) plus a «выбрать» button.
 * Clicking either opens the universal thought picker in **multi mode**
 * (prefilled with the current ids, honouring the definition's type filter);
 * applying writes the full replacement list through `save`. Every chip has a
 * «×» removing that single value; removing the last one clears the property.
 *
 * Missing chip titles are resolved in the background via `thoughts.resolve`
 * into the shared `titles` cache, then the chips re-render.
 *
 * Also reused by the selection panel's property-values dialog: there `save`
 * writes the list into the dialog state instead of saving it immediately.
 */
export function buildMultiThoughtRefEditor(opts: {
  networkId: string;
  /** Thought-type filter of the definition config (input aid). */
  filterIds: string[];
  /** Shared id → title cache used for chip labels. */
  titles: Map<string, string>;
  /** Currently selected thought ids. */
  ids: string[];
  /** Writes the full replacement list; an empty list clears the value. */
  save: (ids: string[]) => Promise<unknown> | unknown;
}): HTMLElement {
  const field = div('st-f-chipfield');
  field.tabIndex = 0;
  field.title = 'Выбрать мысли (несколько)';

  const renderChips = (): void => {
    field.replaceChildren();
    if (opts.ids.length === 0) {
      field.append(span('— не задано —', 'st-f-chip-empty'));
      return;
    }
    opts.ids.forEach((id, index) => {
      const chip = div('st-f-chip');
      const label = span(opts.titles.get(id) ?? id, 'st-f-chip-label');
      label.title = opts.titles.get(id) ?? id;
      chip.append(label);
      const removeBtn = el('button', 'st-f-clear-inline', '×');
      removeBtn.type = 'button';
      removeBtn.title = 'Убрать значение';
      removeBtn.addEventListener('click', (event) => {
        // The field's own click opens the picker — stop it here.
        event.stopPropagation();
        void opts.save(opts.ids.filter((_, i) => i !== index));
      });
      chip.append(removeBtn);
      field.append(chip);
    });
  };

  const openPicker = (): void => {
    void pickThoughtsDialog({
      networkId: opts.networkId,
      allowCreate: false,
      allowLinkType: false,
      searchTypeIds: opts.filterIds,
      // Prefill switches the dialog into multi mode automatically.
      selectedIds: opts.ids,
      title: 'Выбрать мысли',
      applyLabel: 'Выбрать',
    }).then((result) => {
      if (result === null) return;
      void opts.save(pickedThoughtIds(result));
    });
  };

  field.addEventListener('click', openPicker);
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openPicker();
  });

  // Resolve chip titles that are not in the cache yet (fresh picks), then
  // re-render; the raw id stays visible when resolve fails.
  const missing = opts.ids.filter((id) => !opts.titles.has(id));
  if (missing.length > 0) {
    void etn.thoughts
      .resolve(opts.networkId, missing)
      .then((refs) => {
        for (const ref of refs) opts.titles.set(ref.id, ref.title);
        renderChips();
      })
      .catch(() => undefined);
  }

  renderChips();
  const row = div('form-row');
  row.style.marginBottom = '0';
  row.append(
    field,
    button('выбрать', openPicker, 'btn small', 'Выбрать мысли (несколько)'),
  );
  return row;
}

// ---------------------------------------------------------------------------
// Predefined text options picker (08-ui-spec.md §6.3)
// ---------------------------------------------------------------------------

/** Splits a stored multi-value string into trimmed non-empty parts. */
export function splitMultiValue(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * The fragment the user is currently typing: the whole input in single mode,
 * the part after the last comma in multiple mode. Lowercased for matching.
 */
export function autocompleteFragment(text: string, multiple: boolean): string {
  const fragment = multiple ? text.slice(Math.max(text.lastIndexOf(',') + 1, 0)) : text;
  return fragment.trim().toLowerCase();
}

/**
 * Options containing the typed fragment (case-insensitive); an empty fragment
 * shows the full catalogue.
 */
export function filterOptionsByFragment(options: string[], fragment: string): string[] {
  if (fragment === '') return options;
  return options.filter((option) => option.toLowerCase().includes(fragment));
}

/**
 * Wires the predefined-options dropdown of a text property to its input and
 * builds the ▾ button (body-mounted, fixed — the same approach and classes as
 * the type combobox).
 *
 * The list opens both on the caret and on typing: rows narrow to options
 * containing the typed fragment — an input aid, never a restriction. Single
 * mode: clicking a row fills the input with the option. Multiple mode: rows
 * are checkboxes; the input holds the comma-joined selection (options order)
 * and stays hand-editable. The result is committed once, when the dropdown
 * closes; Escape reverts to the last committed value instead. Keyboard-only
 * edits (list never opened) commit on the input's blur as usual.
 *
 * Also reused by the selection panel's property-values dialog: there `commit`
 * writes the value into the dialog state instead of saving it immediately.
 */
export function buildValueOptionsCaret(
  input: HTMLInputElement,
  options: string[],
  multiple: boolean,
  commit: (value: string) => void,
  revert: () => void,
): HTMLElement {
  let list: HTMLDivElement | null = null;

  const close = (mode: 'commit' | 'revert'): void => {
    if (list === null) return;
    list.remove();
    list = null;
    window.removeEventListener('mousedown', onOutside, true);
    if (mode === 'revert') revert();
    else commit(input.value);
  };

  const onOutside = (event: MouseEvent): void => {
    if (
      list !== null &&
      event.target instanceof Node &&
      !list.contains(event.target) &&
      event.target !== input
    ) {
      close('commit');
    }
  };

  function renderRows(): void {
    if (list === null) return;
    const fragment = autocompleteFragment(input.value, multiple);
    const visible = filterOptionsByFragment(options, fragment);
    const selected = new Set(multiple ? splitMultiValue(input.value) : []);
    list.replaceChildren();
    for (const option of visible) {
      const row = div('type-combo-item');
      if (multiple) {
        const check = el('input');
        check.type = 'checkbox';
        check.checked = selected.has(option);
        row.append(check);
      }
      row.append(el('span', 'type-combo-label', option));
      // Keep the focus (and selection highlight) in the input — no blur-commit
      // while the user works inside the dropdown.
      row.addEventListener('mousedown', (event) => event.preventDefault());
      row.addEventListener('click', () => {
        if (!multiple) {
          input.value = option;
          close('commit');
          return;
        }
        if (selected.has(option)) selected.delete(option);
        else selected.add(option);
        const check = row.querySelector('input');
        if (check !== null) check.checked = selected.has(option);
        input.value = options.filter((o) => selected.has(o)).join(', ');
      });
      list.append(row);
    }
    if (visible.length === 0) {
      list.append(el('p', 'muted type-combo-empty', 'Совпадений нет.'));
    }
    if (multiple) {
      const done = button('Готово', () => close('commit'), 'btn small');
      done.style.margin = '4px';
      list.append(done);
    }
  }

  const openList = (): void => {
    if (list !== null) {
      renderRows();
      return;
    }
    list = div('type-combo-list');
    renderRows();
    document.body.append(list);
    positionBodyDropdown(list, input);
    window.addEventListener('mousedown', onOutside, true);
  };

  // Typing (re)opens the list with rows narrowed to the typed fragment; the
  // caret shows the full catalogue (an empty fragment matches everything).
  input.addEventListener('input', openList);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && list !== null) {
      event.stopPropagation();
      close('revert');
    }
  });

  return button(
    '▾',
    () => {
      if (list !== null) close('commit');
      else openList();
    },
    'btn small',
    multiple ? 'Выбрать несколько значений' : 'Выбрать значение из списка',
  );
}
