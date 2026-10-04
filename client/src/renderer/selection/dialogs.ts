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
import { t } from '../lib/i18n.js';

import { requireNetworkId, scheduleRefresh } from '../app.js';
import { signalPublicationCompositionChanged } from '../lib/live/index.js';
import { buildValueEditor } from '../editor/value-editor.js';
import { div, el } from '../lib/dom.js';
import { operationError } from '../lib/ui/messages.js';
import { etn } from '../lib/etn.js';
import { buildEntityCombo } from '../lib/entity-picker.js';
import { showDialog } from '../lib/dialog.js';
import { notice } from '../lib/notice.js';
import { notifyPropertyValuesRefreshed } from '../lib/property-values-refresh.js';
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
 * `undefined` when cancelled — including dismissal by any close path
 * («Отмена», Esc, ×, backdrop click). The pick also becomes the add-dialog
 * default (`last_used_link_type_id`, L4).
 */
export function pickLinkType(title: string): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    /**
     * Единственная точка завершения промиса. Отмена — ЛЮБОЙ путь закрытия
     * каркаса (ошибка a68bacff): кнопки завершают его явно, а Esc и × —
     * через `onClose`. Флаг `settled` не даёт позднему событию
     * `remove` переиграть уже принятое решение.
     */
    let settled = false;
    const finish = (value: string | null | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const combo = buildEntityCombo({
      networkId: requireNetworkId(),
      kind: 'link-types',
      value: store.state.lastUsedLinkTypeId,
      emptyLabel: 'Без типа',
      placeholder: t('actions.search'),
      onChange: () => undefined,
    });
    showDialog({
      title,
      body: combo.root,
      size: 's',
      buttons: [
        { label: t('actions.cancel'), onClick: () => finish(undefined) },
        {
          label: t('actions.apply'),
          primary: true,
          onClick: () => {
            const id = combo.value();
            store.update({ lastUsedLinkTypeId: id });
            finish(id);
          },
        },
      ],
      // Esc и × — отмена: контракт «`undefined` on cancel»,
      // ровно как по кнопке «Отмена» (ошибка a68bacff).
      onClose: () => finish(undefined),
      onMount: () => focusCombo(combo.root),
    });
  });
}

// ---------------------------------------------------------------------------
// Thought type picker («Изменить тип мыслей»)
// ---------------------------------------------------------------------------

/**
 * Asks for a thought type. Resolves the chosen type id, `null` to clear the
 * type, or `undefined` when cancelled — including dismissal by any close path
 * («Отмена», Esc, ×, backdrop click).
 */
export function pickThoughtType(initial: string | null): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    /** Единственная точка завершения промиса — см. {@link pickLinkType}. */
    let settled = false;
    const finish = (value: string | null | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const combo = buildEntityCombo({
      networkId: requireNetworkId(),
      kind: 'thought-types',
      value: initial,
      emptyLabel: 'Без типа',
      placeholder: t('actions.search'),
      onChange: () => undefined,
    });
    showDialog({
      title: 'Изменить тип мыслей',
      body: combo.root,
      size: 's',
      buttons: [
        { label: t('actions.cancel'), onClick: () => finish(undefined) },
        {
          label: t('actions.apply'),
          primary: true,
          onClick: () => finish(combo.value()),
        },
      ],
      // Esc и × — отмена: контракт «`undefined` on cancel»,
      // ровно как по кнопке «Отмена» (ошибка a68bacff).
      onClose: () => finish(undefined),
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
    label: t('actions.apply'),
    primary: true,
    keepOpen: true,
    onClick: (close: () => void) => void applyAll(close),
  };
  showDialog({
    title: 'Значения свойств выделенных мыслей',
    body,
    size: 'm',
    // Грязная форма (требование b58f6aad): Esc/крестик при заполненных
    // значениях требуют подтверждения; «Сохранить» идёт тем же путём, что
    // «Применить». Явное «Закрыть» закрывает молча.
    dirty: {
      isDirty: () => [...rows.values()].some((row) => row.value !== null && row.value !== ''),
      save: (close) => void applyAll(close),
    },
    buttons: [{ label: t('actions.close'), onClick: () => undefined }, applyBtn],
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
    const appliedIds: string[] = [];
    for (const row of filled) {
      for (const ref of selectedRefs) {
        const defs = ref.type_id === null ? undefined : defsByType.get(ref.type_id);
        if (defs === undefined || !defs.some((d) => d.id === row.def.id)) continue;
        try {
          await etn.properties.set(networkId, 'thought', ref.id, row.def.key, row.value);
          applied += 1;
          appliedIds.push(ref.id);
        } catch {
          failed += 1;
        }
      }
    }
    // Изменённые мысли — чтобы рабочая область публикации не зажгла stale от
    // значения посторонней сборке мысли (ужесточение G4, задача 8a039ea3).
    if (applied > 0) signalPublicationCompositionChanged(appliedIds);
    if (applied > 0) notice(`Значения применены (${applied}).`, 'success');
    if (failed > 0) notice(`Не удалось применить: ${failed}.`, 'error');
    // Своя запись значения (в т.ч. свойства-связи) не поднимает версию мысли, а
    // собственное событие приходит асинхронно (B1), поэтому ни таблица
    // значений свойств открытой карточки, ни карта о новом ребре не узнают до
    // прихода события / смены фокуса (ошибка 4ba1fccc). Локальное уведомление —
    // идемпотентный ускоритель. Правка массовая — ключ не един, значит
    // перечитываем всё; уведомляем и освежаем окрестность фокуса ТОЛЬКО когда
    // хоть одна запись удалась, на полной неудаче молчим.
    if (applied > 0) {
      notifyPropertyValuesRefreshed();
      scheduleRefresh();
    }
    closeDialog();
  }

  void (async () => {
    let refs: ThoughtRef[];
    try {
      refs = await etn.thoughts.resolve(networkId, ids.slice(0, 100));
    } catch (err) {
      body.replaceChildren(operationError(err));
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
      body.replaceChildren(operationError(err));
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
