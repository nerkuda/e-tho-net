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
  box.append(tableWrap);

  const refTitles = new Map<string, string>();
  currentReload = () => void reload();
  void reload();

  /** Loads definitions + values and renders the table. */
  async function reload(): Promise<void> {
    if (!box.isConnected) return; // stale body replaced by a newer render
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

    const save = (value: unknown | null): void => {
      void (async () => {
        try {
          if (value === null) {
            await etn.properties.remove(networkId, 'thought', thoughtId, definition.key);
          } else {
            await etn.properties.set(networkId, 'thought', thoughtId, definition.key, value);
          }
        } catch (err) {
          cell.append(span(` Ошибка: ${errText(err)}`, 'error-text'));
        }
      })();
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
        input.addEventListener('blur', () => {
          const next = input.value;
          if (next === '') save(null);
          else if (next !== stored) save(next);
        });
        cell.append(input);
        break;
      }
      case 'number': {
        const input = el('input', 'text-input prop-editor');
        input.type = 'number';
        input.value = typeof stored === 'number' ? String(stored) : '';
        input.addEventListener('blur', () => {
          const next = input.value === '' ? null : Number(input.value);
          if (next === null) save(null);
          else if (next !== stored && Number.isFinite(next)) save(next);
        });
        cell.append(input);
        break;
      }
      case 'date': {
        const input = el('input', 'text-input prop-editor');
        input.type = 'date';
        input.value = typeof stored === 'string' ? stored.slice(0, 10) : '';
        input.addEventListener('blur', () => {
          if (input.value === '') save(null);
          else save(input.value);
        });
        cell.append(input);
        break;
      }
      case 'bool': {
        const input = el('input');
        input.type = 'checkbox';
        input.checked = stored === true;
        input.addEventListener('change', () => save(input.checked));
        cell.append(input);
        break;
      }
      case 'thought_ref': {
        const input = el('input', 'text-input prop-editor');
        input.type = 'text';
        input.value = typeof stored === 'string' ? (refTitles.get(stored) ?? stored) : '';
        input.readOnly = true;
        input.placeholder = 'выбрать мысль…';
        const row = div('form-row');
        row.style.marginBottom = '0';
        row.append(
          input,
          button(
            'выбрать',
            () => {
              void pickThoughtRef(networkId, definition.config?.allowed_type_id).then((id) => {
                if (id !== null) save(id);
              });
            },
            'btn small',
          ),
        );
        if (stored !== null) {
          row.append(button('✕', () => save(null), 'btn small', 'Очистить значение'));
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
