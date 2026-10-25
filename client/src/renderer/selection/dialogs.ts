/**
 * Dialogs of the selection panel (08-ui-spec.md §5).
 *
 * - «Тип связи» picker — a searchable link-type combobox where "no type" is a
 *   valid choice (batch ops accept `link_type_id: null`);
 * - «Изменить тип» — a searchable thought-type combobox over the catalogue,
 *   "no type" clears the type of every selected thought;
 * - «Изменить значение свойства» — массовое изменение значений свойств
 *   выделенных мыслей (0.14.1, задача 6ebcd8d6; спека панели 2fc9d85c):
 *   строки строятся по ЗНАЧЕНИЯМ выделенных (типовые и внетиповые без
 *   различия), строка — (свойство, сторона), чекбокс включает строку,
 *   «+ свойство» добавляет строку из справочника сети. Чистая арифметика
 *   (union/сравнение/план применения) — `selection/property-bulk.ts`.
 */

import type {
  LinkPropertyValues,
  PropertyValue,
} from '@etn/shared';
import { THOUGHT_RESOLVE_MAX_IDS } from '@etn/shared';
import { t } from '../lib/i18n.js';

import { requireNetworkId, scheduleRefresh } from '../app.js';
import { signalPublicationCompositionChanged } from '../lib/live/index.js';
import { buildValueEditor } from '../editor/value-editor.js';
import { div, el, errText, span } from '../lib/dom.js';
import { operationError } from '../lib/ui/messages.js';
import { etn } from '../lib/etn.js';
import { buildEntityCombo } from '../lib/entity-picker.js';
import {
  buildPropertyList,
  buildPropertyListRows,
  ensurePropertyLinkTypes,
  type PropertyListRow,
  type PropertyRegistryRow,
} from '../lib/property-list.js';
import { confirmDialog, errorDialog, showDialog } from '../lib/dialog.js';
import { notifyPropertyValuesRefreshed } from '../lib/property-values-refresh.js';
import { store } from '../state.js';
import { choiceControl } from '../lib/ui/choice-row.js';
import { uiButton } from '../lib/ui/button.js';
import {
  buildBulkPropertyRows,
  bulkLinkEditorValue,
  bulkRowFromRegistry,
  clearingThoughtCount,
  isBulkFormDirty,
  planBulkApply,
  sortBulkRows,
  type BulkApplyOperation,
  type BulkPropertyRow,
  type BulkRowSelection,
  type BulkThought,
} from './property-bulk.js';

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
      emptyLabel: t('selection.picker.noType'),
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
      emptyLabel: t('selection.picker.noType'),
      placeholder: t('actions.search'),
      onChange: () => undefined,
    });
    showDialog({
      title: t('selection.thoughtType.title'),
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

/** Состояние одной строки формы: модель, отметка и текущее значение поля. */
interface BulkRowState {
  model: BulkPropertyRow;
  checked: boolean;
  /** Значение из редактора; `null` — пусто (для отмеченной строки — очистка). */
  value: unknown | null;
  /** Галочку уже ставили — подпись «не будет применено» показывается после снятия. */
  wasChecked: boolean;
  rowEl: HTMLTableRowElement;
  checkbox: HTMLInputElement;
  editorBox: HTMLElement;
  hintsEl: HTMLElement;
}

/** Предел одновременных запросов при чтении значений и применении. */
const BULK_CONCURRENCY = 8;

/** Тип записи чтения значений свойства (скаляр или проекция рёбер). */
type PropertyValueEntry = PropertyValue | LinkPropertyValues;

/** Предел числа причин отказа в отчёте диалога (остальные — счётчиком). */
const BULK_FAILURE_LINES = 20;

/**
 * Открывает диалог массового изменения значений свойств для выделенных мыслей.
 * Диалог НЕ закрывается после «Применить»: значения перечитываются, галочки
 * сбрасываются, итог операций остаётся видимым (спека 2fc9d85c, решение
 * предполёта 2026-10-23).
 */
export function showSelectionPropertiesDialog(ids: string[]): void {
  const networkId = requireNetworkId();
  const processed = ids.slice(0, THOUGHT_RESOLVE_MAX_IDS);
  const truncated = ids.length > processed.length;

  /** Мысли, по которым идёт работа; заполняется загрузкой. */
  let thoughts: BulkThought[] = [];
  /** Реестр сети — определения свойств для всех строк. */
  let registry: PropertyRegistryRow[] = [];
  /** Снимок значений: id мысли → ответ `properties.get`. */
  let valuesByThought = new Map<string, readonly PropertyValueEntry[]>();
  /** Строки таблицы в порядке показа. */
  let rows: BulkPropertyRow[] = [];
  /** Состояния строк по ключу (свойство-сторона). */
  const rowStates = new Map<string, BulkRowState>();
  /** Идёт применение — повторный клик «Применить» игнорируется. */
  let applying = false;

  const body = div('form-stack prop-bulk');
  const loadingEl = span(t('selection.properties.loading'), 'muted');
  body.append(loadingEl);
  /** Тело таблицы и подсказка пустого набора — ссылки для точечного обновления. */
  let tbodyEl: HTMLElement | null = null;
  let emptyEl: HTMLElement | null = null;

  // Итог операций живёт в футере (виден при прокрутке таблицы); причины —
  // блоком над таблицей, к нему прокручиваем тело после применения.
  const summaryEl = span('', 'prop-bulk-summary muted');
  const reportEl = div('prop-bulk-report');
  reportEl.hidden = true;

  let applyBtn: HTMLButtonElement | null = null;

  showDialog({
    title: t('selection.properties.title'),
    body,
    size: 'm',
    // Грязная форма — от ИСХОДНОГО снимка (галочка/значение отличаются):
    // Esc и крестик требуют подтверждения, «Закрыть» — явная отмена молча.
    // Метки свои: семантика диалога — «применить», а не «сохранить»
    // (ошибка ed299fa0); «Применить» подтверждения идёт тем же путём, что
    // кнопка футера.
    dirty: {
      isDirty: () => isBulkFormDirty(rows, currentSelection()),
      save: (close) => void applyAll(true, close),
      labels: {
        title: t('selection.properties.dirtyTitle'),
        message: t('selection.properties.dirtyMessage'),
        save: t('actions.apply'),
        discard: t('selection.properties.dirtyDiscard'),
        stay: t('dialog.unsaved.stay'),
      },
    },
    footerError: summaryEl,
    buttons: [
      { label: t('actions.close'), onClick: () => undefined },
      {
        label: t('actions.apply'),
        primary: true,
        keepOpen: true,
        ref: (button) => {
          applyBtn = button;
          button.disabled = true;
        },
        onClick: () => void applyAll(false, () => undefined),
      },
    ],
  });

  void load();

  /** Перечитывает выделенные мысли, реестр и значения; перерисовывает таблицу. */
  async function load(): Promise<void> {
    body.replaceChildren(loadingEl);
    try {
      const refs = await etn.thoughts.resolve(networkId, processed);
      thoughts = refs.map((ref) => ({ id: ref.id, title: ref.title }));
      registry = await etn.propertyRegistry.list(networkId);
      // Имена сторон свойств-связей: каталог типов связей может отставать.
      await ensurePropertyLinkTypes(networkId, registry);
      valuesByThought = await readValues();
    } catch (err) {
      body.replaceChildren(operationError(err));
      return;
    }
    rows = buildBulkPropertyRows({
      thoughts,
      registry,
      linkTypes: store.state.linkTypes,
      values: valuesByThought,
    });
    renderTable();
  }

  /** Читает значения свойств по каждой обработанной мысли порциями. */
  async function readValues(): Promise<Map<string, readonly PropertyValueEntry[]>> {
    const result = new Map<string, readonly PropertyValueEntry[]>();
    for (let start = 0; start < thoughts.length; start += BULK_CONCURRENCY) {
      const chunk = thoughts.slice(start, start + BULK_CONCURRENCY);
      const entries = await Promise.all(
        chunk.map((thought) => etn.properties.get(networkId, 'thought', thought.id)),
      );
      entries.forEach((list, index) => result.set(chunk[index]!.id, list));
    }
    return result;
  }

  /**
   * Полная перерисовка формы: шапка-предупреждения, (+) и таблица/подсказка.
   * `autoCheckedKey` — ключ строки, добавленной через (+) на пустой таблице:
   * перерисовка строит её заново, и авто-галочка должна пережить пересборку.
   */
  function renderTable(autoCheckedKey?: string): void {
    rowStates.clear();
    body.replaceChildren();

    if (truncated) {
      body.append(
        span(t('selection.properties.truncated', [processed.length, ids.length]), 'muted'),
      );
    }

    const toolbar = div('form-row type-list-toolbar prop-bulk-toolbar');
    toolbar.append(
      uiButton({
        label: t('selection.properties.add'),
        role: 'secondary',
        size: 's',
        title: t('selection.properties.addHint'),
        onClick: () => void openPropertyPicker(),
      }),
    );
    body.append(toolbar, reportEl);
    tbodyEl = null;
    emptyEl = null;

    if (rows.length === 0) {
      emptyEl = span(t('selection.properties.empty'), 'muted prop-bulk-empty');
      body.append(emptyEl);
      updateApplyState();
      return;
    }

    const table = el('table', 'table-list prop-table prop-bulk-table');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th'),
      el('th', undefined, t('selection.properties.columnProperty')),
      el('th', undefined, t('selection.properties.columnValue')),
    );
    thead.append(headRow);
    tbodyEl = el('tbody');
    for (const model of rows) {
      const state = buildRowState(model, model.key === autoCheckedKey);
      rowStates.set(model.key, state);
      tbodyEl.append(state.rowEl);
    }
    table.append(thead, tbodyEl);
    body.append(table);
    updateApplyState();
  }

  /**
   * Строит строку формы: чекбокс, имя со счётчиком, редактор значения.
   * `checked` — авто-галочка «+ свойство» (пустое значение — семантика
   * «галочка без значения»); строки, попавшие в диалог по значениям/типам,
   * приходят со снятой галочкой.
   */
  function buildRowState(model: BulkPropertyRow, checked = false): BulkRowState {
    const state: BulkRowState = {
      model,
      checked,
      value: model.value,
      wasChecked: checked,
      rowEl: el('tr'),
      checkbox: choiceControl('checkbox', { checked }),
      editorBox: div('prop-bulk-value'),
      hintsEl: div('prop-bulk-hints'),
    };
    state.rowEl.dataset['rowKey'] = model.key;

    const checkCell = el('td', 'prop-bulk-check-cell');
    state.checkbox.addEventListener('change', () => {
      state.checked = state.checkbox.checked;
      if (state.checked) state.wasChecked = true;
      updateRowState(state);
    });
    state.checkbox.setAttribute('aria-label', model.name);
    checkCell.append(state.checkbox);

    const nameCell = el('td', 'prop-bulk-name-cell');
    nameCell.append(span(model.name, 'prop-name'));
    nameCell.append(
      span(
        t('selection.properties.present', [model.presentCount, model.totalCount]),
        'muted prop-bulk-count',
      ),
    );

    const valueCell = el('td', 'prop-bulk-value-cell');
    state.editorBox.append(buildRowEditor(state));
    valueCell.append(state.editorBox, state.hintsEl);

    state.rowEl.append(checkCell, nameCell, valueCell);
    updateRowState(state);
    return state;
  }

  /** Значение для редактора: связь — рёбра с подписями, остальное — как есть. */
  function editorValueOf(state: BulkRowState): unknown {
    if (state.value === null) return null;
    return state.model.valueType === 'link'
      ? bulkLinkEditorValue(state.model, state.value)
      : state.value;
  }

  /** Собирает общий редактор значения для строки (стандарт S2). */
  function buildRowEditor(state: BulkRowState): HTMLElement {
    const model = state.model;
    const differing = !model.uniform;
    return buildValueEditor({
      networkId,
      // Владельца НЕ передаём: это не карточка мысли, контекстного меню чипов
      // и «удалить совсем» здесь нет (дефект владельца `''` из предполёта).
      ownerType: undefined,
      ownerId: undefined,
      definition: model.definition,
      value: editorValueOf(state),
      save: async (next) => {
        state.value = next;
        updateRowState(state);
        return true;
      },
      commitOn: 'change',
      historyPropertyId: model.propertyId,
      boolTriState: true,
      ...(differing && (model.valueType === 'text' || model.valueType === 'url')
        ? { placeholder: t('selection.properties.different') }
        : {}),
    });
  }

  /** Обновляет приглушение поля, подписи строки и доступность «Применить». */
  function updateRowState(state: BulkRowState): void {
    state.editorBox.classList.toggle('prop-bulk-value-off', !state.checked);
    state.editorBox.setAttribute('aria-disabled', String(!state.checked));

    const hints: HTMLElement[] = [];
    if (!state.model.uniform && state.model.valueType !== 'text' && state.model.valueType !== 'url') {
      hints.push(span(t('selection.properties.different'), 'prop-bulk-hint'));
    }
    if (
      state.checked &&
      state.value === null &&
      state.model.presentCount > 0
    ) {
      hints.push(
        span(
          t('selection.properties.willClear', state.model.presentCount),
          'prop-bulk-hint prop-bulk-hint-warn',
        ),
      );
    }
    if (!state.checked && state.wasChecked) {
      hints.push(span(t('selection.properties.notApplied'), 'prop-bulk-hint'));
    }
    state.hintsEl.replaceChildren(...hints);
    updateApplyState();
  }

  /** Отметки строк — вход чистой логики плана/очистки/dirty. */
  function currentSelection(): BulkRowSelection[] {
    return [...rowStates.values()].map((state) => ({
      key: state.model.key,
      checked: state.checked,
      value: state.value,
    }));
  }

  /** «Применить» недоступна без отмеченных строк и во время применения. */
  function updateApplyState(): void {
    if (applyBtn === null) return;
    const anyChecked = [...rowStates.values()].some((state) => state.checked);
    applyBtn.disabled = applying || !anyChecked;
  }

  /**
   * Применяет отмеченные строки: по одной операции на пару (мысль, строка).
   * Частичная неудача не останавливает проход; итог N/M и причины остаются в
   * диалоге. `closeAfter` — путь подтверждения закрытия «Сохранить».
   */
  async function applyAll(closeAfter: boolean, close: () => void): Promise<void> {
    if (applying) return;
    const selection = currentSelection();
    const thoughtIds = thoughts.map((thought) => thought.id);
    const operations = planBulkApply(rows, selection, thoughtIds);
    if (operations.length === 0) {
      if (closeAfter) close();
      return;
    }

    const clearing = clearingThoughtCount(rows, selection);
    if (clearing > 0) {
      const confirmed = await confirmDialog(
        t('selection.properties.clearTitle'),
        t('selection.properties.clearMessage', clearing),
        true,
        t('selection.properties.clearConfirm'),
      );
      if (!confirmed) return;
    }

    applying = true;
    updateApplyState();

    let applied = 0;
    const failures: Array<{ operation: BulkApplyOperation; reason: string }> = [];
    const changedThoughts = new Set<string>();
    for (let start = 0; start < operations.length; start += BULK_CONCURRENCY) {
      const chunk = operations.slice(start, start + BULK_CONCURRENCY);
      const results = await Promise.allSettled(chunk.map((operation) => runOperation(operation)));
      results.forEach((result, index) => {
        const operation = chunk[index]!;
        if (result.status === 'fulfilled') {
          applied += 1;
          changedThoughts.add(operation.thoughtId);
        } else {
          failures.push({ operation, reason: errText(result.reason) });
        }
      });
    }

    // Изменённые мысли — чтобы рабочая область публикации не зажгла stale от
    // значения посторонней сборке мысли (ужесточение G4, задача 8a039ea3).
    if (applied > 0) signalPublicationCompositionChanged([...changedThoughts]);
    // Своя запись не поднимает версию мысли, собственное событие приходит
    // асинхронно (B1): уведомляем таблицу значений открытой карточки и
    // обновляем окрестность фокуса (ошибка 4ba1fccc).
    if (applied > 0) {
      notifyPropertyValuesRefreshed();
      scheduleRefresh();
    }

    // Перечитывание значений и сброс галочек — диалог остаётся открытым.
    await load();
    showReport(applied, failures);
    applying = false;
    updateApplyState();
    // Прокрутка живёт на теле каркаса (`.dialog-body`), а не на нашем стеке:
    // после применения показываем шапку с причинами отказа.
    const scroller = body.parentElement;
    if (scroller != null) scroller.scrollTop = 0;

    if (closeAfter && failures.length === 0) close();
  }

  /** Одна операция плана: запись значения либо очистка у конкретной мысли. */
  async function runOperation(operation: BulkApplyOperation): Promise<void> {
    if (operation.kind === 'set') {
      await etn.properties.set(
        networkId,
        'thought',
        operation.thoughtId,
        operation.propertyKey,
        operation.value,
        operation.side,
      );
      return;
    }
    await etn.properties.remove(
      networkId,
      'thought',
      operation.thoughtId,
      operation.propertyKey,
      operation.side,
    );
  }

  /** Итог операций в футере + причины отказа списком над таблицей. */
  function showReport(
    applied: number,
    failures: ReadonlyArray<{ operation: BulkApplyOperation; reason: string }>,
  ): void {
    summaryEl.textContent =
      failures.length === 0
        ? t('selection.properties.applied', applied)
        : `${t('selection.properties.applied', applied)}, ${t('selection.properties.failed', failures.length)}`;
    summaryEl.classList.toggle('prop-bulk-summary-error', failures.length > 0);
    if (failures.length === 0) {
      reportEl.hidden = true;
      reportEl.replaceChildren();
      return;
    }
    const title = span(t('selection.properties.applyFailed'), 'error-text prop-bulk-report-title');
    const list = el('ul', 'prop-bulk-report-list');
    for (const failure of failures.slice(0, BULK_FAILURE_LINES)) {
      const thought = thoughts.find((candidate) => candidate.id === failure.operation.thoughtId);
      const row = rows.find((candidate) => candidate.key === failure.operation.rowKey);
      list.append(
        el(
          'li',
          undefined,
          t('selection.properties.failureLine', [
            thought?.title ?? failure.operation.thoughtId,
            row?.name ?? failure.operation.propertyKey,
            failure.reason,
          ]),
        ),
      );
    }
    if (failures.length > BULK_FAILURE_LINES) {
      list.append(
        el(
          'li',
          'muted',
          t('selection.properties.failureMore', failures.length - BULK_FAILURE_LINES),
        ),
      );
    }
    reportEl.replaceChildren(title, list);
    reportEl.hidden = false;
  }

  /**
   * «+ свойство»: пикер справочника сети (общий `property-list`, режим
   * `picker`). Строки, уже показанные в таблице, и структурные исключены;
   * у свойства-связи выбирается сторона. «Создать новое…» здесь НЕТ — это
   * режим пикера, а не урезание карточки (её пикер не трогаем).
   */
  async function openPropertyPicker(): Promise<void> {
    let fresh: PropertyRegistryRow[];
    try {
      fresh = await etn.propertyRegistry.list(networkId);
      await ensurePropertyLinkTypes(networkId, fresh);
    } catch (err) {
      errorDialog(t('selection.properties.addTitle'), err);
      return;
    }
    const shown = new Set(rowStates.keys());
    const list = buildPropertyList({
      mode: 'picker',
      searchPlaceholder: t('actions.search'),
      excludeRow: (row) => row.structural || shown.has(row.id),
      callbacks: {
        onActivate: (row) => choose(row),
      },
    });
    list.setRows(buildPropertyListRows(fresh, store.state.linkTypes));

    const pickerBody = div('form-stack list-dialog-body');
    pickerBody.append(list.root);

    const close = showDialog({
      title: t('selection.properties.addTitle'),
      body: pickerBody,
      size: 'l',
      fixedHeight: true,
      buttons: [
        { label: t('actions.cancel') },
        {
          label: t('selection.picker.select'),
          primary: true,
          keepOpen: true,
          onClick: () => {
            const row = list.selected();
            if (row !== null) choose(row);
          },
        },
      ],
      onMount: () => list.focus(),
    });

    /** Добавляет выбранную строку в таблицу с установленной галочкой. */
    function choose(row: PropertyListRow): void {
      if (row.structural) return;
      close();
      const model = bulkRowFromRegistry(
        row.registry,
        row.side,
        store.state.linkTypes,
        thoughts.length,
      );
      if (rowStates.has(model.key)) return;
      rows = sortBulkRows([...rows, model]);
      const state = buildRowState(model, true);
      rowStates.set(model.key, state);
      updateRowState(state);
      if (tbodyEl === null) {
        // Таблицы ещё нет (подсказка пустого набора): пересборка строит строки
        // заново — передаём ключ, чтобы авто-галочка не потерялась.
        renderTable(model.key);
        return;
      }
      // Переставляем существующие строки, не пересобирая редакторы: у
      // отредактированных полей сохраняются значения и фокус.
      emptyEl?.remove();
      emptyEl = null;
      tbodyEl.replaceChildren(...rows.map((candidate) => rowStates.get(candidate.key)!.rowEl));
    }
  }
}
