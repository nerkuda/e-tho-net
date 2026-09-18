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

import type { EffectiveTypeProperty, ThoughtRef } from '@etn/shared';

import { requireNetworkId } from '../app.js';
import { buildValueEditor } from '../editor/value-editor.js';
import { div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { createTypeCombobox } from '../lib/type-combobox.js';
import { linkTypeOptions, thoughtTypeOptions } from '../lib/type-tree.js';
import { showDialog } from '../lib/dialog.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';

/** A value editor state row kept until «Применить». */
interface PropertyRowState {
  def: EffectiveTypeProperty;
  /** `null`/undefined — the row is left empty and is not applied. Свойство-связь
   *  хранит здесь `string[]` (список целей, инструкция a47947c8) или `null`. */
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
      options: () => linkTypeOptions(store.state.linkTypes),
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
// Thought type picker («Изменить тип мыслей»)
// ---------------------------------------------------------------------------

/**
 * Asks for a thought type. Resolves the chosen type id, `null` to clear the
 * type, or `undefined` when cancelled.
 */
export function pickThoughtType(initial: string | null): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    const combo = createTypeCombobox({
      options: () => thoughtTypeOptions(store.state.thoughtTypes),
      value: initial,
      emptyLabel: 'Без типа',
      placeholder: 'Поиск типа…',
      onChange: () => undefined,
    });
    showDialog({
      title: 'Изменить тип мыслей',
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
  let defsByType = new Map<string, EffectiveTypeProperty[]>();

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
    defsByType = new Map<string, EffectiveTypeProperty[]>();
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

  /** Builds the value editor cell for one property row.
   *  Поле строит общий редактор значения `editor/value-editor.ts`
   *  (стандарт S2, задача 77e7cafd): вид, `config.multiple` (чипы),
   *  `config.options`; для связи — чип-редактор целей с живым поиском и
   *  пикером. «Применить» уже пишет по одному свойству за раз через
   *  `etn.properties.set`, поэтому `save` здесь только буферизует выбор в
   *  `state.value` (сеть трогает лишь `applyAll`). Для да/нет — трёхзначное
   *  поле («—» = оставить без изменений); история последних значений — по
   *  id свойства (требование f6399882). */
  function buildValueCell(state: PropertyRowState): HTMLTableCellElement {
    const cell = el('td');
    cell.append(
      buildValueEditor({
        networkId,
        ownerType: 'thought',
        ownerId: '',
        definition: state.def,
        value: null,
        save: async (next) => {
          state.value = next;
          return true;
        },
        commitOn: 'change',
        historyPropertyId: state.def.property_id,
        boolTriState: true,
      }),
    );
    return cell;
  }
}
