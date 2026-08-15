/**
 * Editor group: properties (H11, 08-ui-spec.md §6.3; 09-scenarios.md D4).
 *
 * Thought-only. When the thought has a type with property definitions, a table
 * of value editors is rendered per `value_type`:
 *  - text/number/date → inputs, saved on blur (empty → remove);
 *  - bool → checkbox;
 *  - thought_ref → picker over the duplicate-search dialog, stores the
 *    referenced thought id (titles resolved via `thoughts.resolve`).
 *
 * Values are written with `properties.set`, cleared with `properties.remove`;
 * realtime `property-value.*` events reload the table when the open entity is
 * the owner (a single module-level listener keeps closures bounded).
 */

import type { PropertyDefinition, PropertyValue } from '@etn/shared';

import { onRealtimeEvent } from '../realtime.js';
import { button, div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { requireNetworkId } from '../app.js';
import { registerGroupBuilder, type EditorContext } from './editor.js';
import { pickThoughtRef } from './thought-picker.js';

/** Reload callback of the currently mounted properties table (or null). */
let currentReload: (() => void) | null = null;
let wired = false;

/** Registers the properties group (thoughts only). */
export function registerPropertiesGroup(): void {
  registerGroupBuilder((ctx) => {
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

/** Counts the type's property definitions for the group badge (thoughts only). */
async function countProperties(ctx: EditorContext): Promise<string | undefined> {
  const typeId = ctx.thought?.type_id ?? null;
  if (typeId === null) return undefined;
  const networkId = requireNetworkId();
  try {
    const defs = await etn.types.listTypeProperties(networkId, 'thought_type', typeId);
    return `(${defs.length})`;
  } catch {
    return undefined;
  }
}

/** Builds the properties table for the current thought. */
function buildPropertiesBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const thoughtId = ctx.ownerId;
  const typeId = ctx.thought?.type_id ?? null;

  const box = div('properties-body');
  if (typeId === null) {
    box.append(el('p', 'muted', 'У мысли нет типа — свойства недоступны.'));
    return box;
  }
  // Guarded above; the fallback is unreachable but keeps closure typing honest.
  const typedId: string = typeId;

  const tableWrap = div('admin-table-wrap');
  tableWrap.style.maxHeight = '320px';
  // The group machinery builds the body before mounting it into the editor —
  // start with a placeholder so the first (pre-mount) load never shows a gap.
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
    let definitions: PropertyDefinition[];
    let values: PropertyValue[];
    try {
      [definitions, values] = await Promise.all([
        etn.types.listTypeProperties(networkId, 'thought_type', typedId),
        etn.properties.get(networkId, 'thought', thoughtId),
      ]);
      const refIds = values.map((v) => v.value).filter((v): v is string => typeof v === 'string');
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
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(el('th', undefined, 'Свойство'), el('th', undefined, 'Значение'));
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    for (const definition of definitions) {
      const value = valueByProp.get(definition.id);
      const row = el('tr');
      row.append(
        el(
          'td',
          undefined,
          `${definition.key}${definition.required ? ' *' : ''} (${typeName(definition.value_type)})`,
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
    definition: PropertyDefinition,
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
          const row = div('form-row');
          row.style.marginBottom = '0';
          row.append(
            input,
            buildValueOptionsCaret(
              input,
              options,
              definition.config?.multiple === true,
              commitValue,
            ),
          );
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
        const input = el('input', 'text-input prop-editor');
        input.type = 'text';
        input.value = typeof stored === 'string' ? (refTitles.get(stored) ?? stored) : '';
        input.readOnly = true;
        input.placeholder = 'выбрать мысль…';
        // Type filter from the definition config (list form supersedes the
        // legacy single id); an input aid — stored values are untouched.
        const filterIds = (
          definition.config?.allowed_type_ids ??
          (definition.config?.allowed_type_id !== undefined
            ? [definition.config.allowed_type_id]
            : [])
        ).filter((id) => id !== '');
        const row = div('form-row');
        row.style.marginBottom = '0';
        row.append(
          input,
          button(
            'выбрать',
            () => {
              void pickThoughtRef(networkId, filterIds).then(async (id) => {
                // No realtime echo to the actor (04-realtime.md §5) — reload
                // the table after a successful save so the resolved title and
                // the clear button appear at once.
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
 * Builds the ▾ button that opens a dropdown of a text property's predefined
 * options under `input` (body-mounted, fixed — the same approach and classes
 * as the type combobox).
 *
 * Single mode: clicking a row fills the input with the option. Multiple mode:
 * rows are checkboxes; the input holds the comma-joined selection (options
 * order) and remains hand-editable. The result is committed once, when the
 * dropdown closes; keyboard-only edits commit on the input's blur as usual.
 */
function buildValueOptionsCaret(
  input: HTMLInputElement,
  options: string[],
  multiple: boolean,
  commit: (value: string) => void,
): HTMLElement {
  let list: HTMLDivElement | null = null;

  const close = (): void => {
    if (list === null) return;
    list.remove();
    list = null;
    window.removeEventListener('mousedown', onOutside, true);
    commit(input.value);
  };

  const onOutside = (event: MouseEvent): void => {
    if (
      list !== null &&
      event.target instanceof Node &&
      !list.contains(event.target) &&
      event.target !== input
    ) {
      close();
    }
  };

  const openList = (): void => {
    if (list !== null) {
      close();
      return;
    }
    list = div('type-combo-list');
    const selected = new Set(multiple ? splitMultiValue(input.value) : []);
    for (const option of options) {
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
          close();
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
    if (multiple) {
      const done = button('Готово', () => close(), 'btn small');
      done.style.margin = '4px';
      list.append(done);
    }
    document.body.append(list);
    // Place under the input, flipping up when the screen edge interferes.
    const rect = input.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const width = Math.max(rect.width, Math.min(listRect.width, 320));
    const left = Math.max(6, Math.min(rect.left, window.innerWidth - width - 6));
    let top = rect.bottom + 2;
    if (top + listRect.height > window.innerHeight - 6 && rect.top > listRect.height + 6) {
      top = Math.max(6, rect.top - listRect.height - 2);
    }
    list.style.left = `${Math.round(left)}px`;
    list.style.top = `${Math.round(top)}px`;
    list.style.width = `${Math.round(width)}px`;
    window.addEventListener('mousedown', onOutside, true);
  };

  return button(
    '▾',
    openList,
    'btn small',
    multiple ? 'Выбрать несколько значений' : 'Выбрать значение из списка',
  );
}
