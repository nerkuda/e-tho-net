/**
 * Tab «Отборы» редактора типа мысли (задача b8301c16, требование 344b8798
 * «Редактор типа мысли разнесён по вкладкам», 0.7.3).
 *
 * Внутри вкладки:
 *   * список отборов этого типа (только собственных — порядок в списке =
 *     серверный порядок, без предков, требование 344b8798);
 *   * кнопки «Изменить» / «Удалить» / «По умолчанию» / «Снять с умолчания»
 *     на каждой строке;
 *   * перестановка порядка кнопками «▲ / ▼» (оптимистичное обновление с
 *     откатом по ошибке);
 *   * кнопка «+» открывает диалог отбора {@link openViewEditorDialog} с
 *     пустой формой;
 *   * «Изменить» открывает тот же диалог, заполненный по текущему отбору.
 *
 * Поведение «по умолчанию»: сервер снимает прежнюю пометку транзакционно,
 * достаточно одного PATCH (домен 17eb741e / требование 7263e565).
 *
 * Список обновляется по realtime-событиям `thought-type-view.{created,
 * updated, deleted}` для текущего типа — внешние клиенты тоже
 * синхронизируются без перезагрузки диалога.
 *
 * Когда `typeId` ещё не присвоен (тип создаётся — диалог открыт с
 * `current === null`), вкладка показывает подсказку «сохраните тип, чтобы
 * добавлять отборы»: после создания сервер уже назначит id и вкладка
 * станет живой при следующем открытии редактора.
 */

import type { ThoughtTypeView } from '@etn/shared';

import { requireNetworkId } from '../../app.js';
import { confirmDialog, errorDialog } from '../../lib/dialog.js';
import { button, div, el, errText, span } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { notice } from '../../lib/notice.js';
import { onRealtimeEvent } from '../../realtime.js';

import { openViewEditorDialog } from './filter-dialog.js';
import {
  ownViewsOf,
  planClearDefault,
  planReorder,
  planSetDefault,
  sortViewsByPosition,
} from './views-tab-pure.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface BuildViewsTabOpts {
  networkId?: string;
  /** Resolves the type id lazily — `null` пока тип создаётся в этом сеансе. */
  getTypeId: () => string | null;
  /** Имя типа — попадает в заголовок диалога отбора. */
  typeName: () => string;
  /** Уведомляет диалог о внешних изменениях (например, после удаления типа). */
  onChanged?: () => void;
}

export interface ViewsTab {
  /** Корневой элемент вкладки (один `.form-stack`-блок). */
  root: HTMLElement;
  /** Перечитывает список с сервера; безопасно вызывать многократно. */
  refresh: () => Promise<void>;
  /** Снимает подписку realtime — вызывается на закрытии диалога. */
  dispose: () => void;
}

/**
 * Builds the «Отборы» tab content for the thought-type editor.
 *
 * Returns a stable root element and two control handles. The caller mounts
 * the root inside its tab pane and calls `dispose()` from the dialog's
 * `onClose` to drop the realtime subscription.
 */
export function buildViewsTab(opts: BuildViewsTabOpts): ViewsTab {
  const networkId = opts.networkId ?? requireNetworkId();
  const getTypeId = opts.getTypeId;
  const getTypeName = opts.typeName;

  const root = div('form-stack views-tab');
  const headerRow = div('form-row views-tab-header');
  const headerLabel = el(
    'span',
    'muted',
    'Отборы — публикуют кнопки полосы под мыслью в фокусе',
  );
  headerLabel.style.flex = '1';
  const addBtn = button('+ отбор', () => void onAdd(), 'btn small', 'Создать отбор');
  headerRow.append(headerLabel, addBtn);
  const tableWrap = div('admin-table-wrap views-tab-table-wrap');
  const errorLine = span('', 'error-text');
  root.append(headerRow, tableWrap, errorLine);

  /** Latest loaded snapshot — drives both the rendered rows and any
   *  optimistic mutation; reset by `load()`. */
  let views: ThoughtTypeView[] = [];
  let loading = false;

  /** Индекс строки, подсвеченной при навигации клавишами (стрелки + Enter). */
  let selectedIdx = -1;

  const applySelection = (): void => {
    const rows = tableWrap.querySelectorAll<HTMLTableRowElement>('.views-tab-table tbody tr');
    rows.forEach((r, i) => r.classList.toggle('selected', i === selectedIdx));
  };
  const selectedView = (): ThoughtTypeView | null => {
    const rows = Array.from(tableWrap.querySelectorAll<HTMLTableRowElement>('.views-tab-table tbody tr'));
    const row = rows[selectedIdx];
    if (row === undefined) return null;
    const viewId = row.dataset['viewId'];
    return views.find((v) => v.id === viewId) ?? null;
  };

  // Навигация клавишами: стрелки — по строкам, Enter — открыть отбор.
  tableWrap.tabIndex = 0;
  tableWrap.addEventListener('keydown', (event) => {
    const rows = Array.from(tableWrap.querySelectorAll<HTMLTableRowElement>('.views-tab-table tbody tr'));
    if (rows.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedIdx = selectedIdx < 0 ? 0 : Math.min(rows.length - 1, selectedIdx + 1);
      applySelection();
      rows[selectedIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedIdx = selectedIdx < 0 ? 0 : Math.max(0, selectedIdx - 1);
      applySelection();
      rows[selectedIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      const v = selectedView();
      if (v !== null) {
        event.preventDefault();
        void onEdit(v);
      }
    }
  });

  const unsubscribeRealtime = onRealtimeEvent((evt) => {
    if (
      evt.type !== 'thought-type-view.created' &&
      evt.type !== 'thought-type-view.updated' &&
      evt.type !== 'thought-type-view.deleted'
    ) {
      return;
    }
    const typeId = getTypeId();
    if (typeId === null) return;
    if (evt.data.thought_type_id !== typeId) return;
    void load();
  });

  /** Loads (or reloads) the views and repaints. */
  async function load(): Promise<void> {
    const typeId = getTypeId();
    if (typeId === null) {
      renderEmptyTypeHint();
      return;
    }
    if (loading) return;
    loading = true;
    try {
      const resp = await etn.thoughtTypeViews.list(networkId, typeId, { includeEffective: false });
      // The IPC returns both `data` (own views) and `meta.effective` (own +
      // ancestors). Per требование 344b8798: показываем ТОЛЬКО собственные.
      views = ownViewsOf(resp.data, typeId);
      renderRows();
    } catch (err) {
      tableWrap.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
    } finally {
      loading = false;
    }
  }

  function renderEmptyTypeHint(): void {
    tableWrap.replaceChildren();
    tableWrap.append(
      el(
        'p',
        'muted views-tab-empty',
        'Сохраните тип, чтобы добавлять отборы — у нового типа ещё нет id.',
      ),
    );
    errorLine.textContent = '';
  }

  /** Paints the rows into `tableWrap` from the cached `views`. */
  function renderRows(): void {
    tableWrap.replaceChildren();
    if (views.length === 0) {
      tableWrap.append(el('p', 'muted views-tab-empty', 'У типа пока нет отборов.'));
      errorLine.textContent = '';
      return;
    }
    const sorted = sortViewsByPosition(views);
    const table = el('table', 'table-list views-tab-table');
    const head = el('thead');
    const headRow = el('tr');
    headRow.append(
      el('th', 'views-tab-col-name', 'Имя'),
      el('th', 'views-tab-col-default', 'умлоч.'),
      el('th', 'views-tab-col-actions'),
      el('th', 'views-tab-col-desc', 'Описание'),
    );
    head.append(headRow);
    table.append(head);
    const tbody = el('tbody');
    sorted.forEach((view, idx) => tbody.append(buildRow(view, idx, sorted)));
    table.append(tbody);
    tableWrap.append(table);
    // Перечитали список — восстановим/обнулим подсветку выбранной строки.
    if (selectedIdx >= sorted.length) selectedIdx = -1;
    applySelection();
    errorLine.textContent = '';
  }

  /** One row: name/default/actions/description. */
  function buildRow(view: ThoughtTypeView, idx: number, sorted: ThoughtTypeView[]): HTMLElement {
    const tr = el('tr');
    tr.dataset['viewId'] = view.id;

    // Имя — 40% ширины, обрезается; двойной клик открывает редактор.
    const nameCell = el('td', 'views-tab-name-cell');
    const nameEl = el('span', 'views-tab-name', view.name);
    nameEl.title = view.name;
    nameCell.append(nameEl);
    nameCell.addEventListener('dblclick', () => void onEdit(view));
    tr.append(nameCell);

    // По умолчанию — только галочка у помеченного.
    const defaultCell = el('td', 'views-tab-default');
    defaultCell.title = view.is_default ? 'Открывается по умолчанию' : '';
    if (view.is_default) defaultCell.append(el('span', 'views-tab-default-mark', '✓'));
    tr.append(defaultCell);

    // Кнопки: порядок, «по умолчанию» и удаление — эмодзи.
    const actions = el('td', 'views-tab-actions');
    actions.append(
      button('▲', () => void onMove(view, idx, idx - 1, sorted), 'btn small', 'Выше'),
      button('▼', () => void onMove(view, idx, idx + 1, sorted), 'btn small', 'Ниже'),
      button(
        view.is_default ? '☆' : '⭐',
        () => (view.is_default ? void onClearDefault(view) : void onSetDefault(view)),
        'btn small',
        view.is_default ? 'Снять признак «по умолчанию»' : 'Сделать отбором по умолчанию',
      ),
      button('🗑️', () => void onDelete(view), 'btn small', 'Удалить отбор'),
    );
    tr.append(actions);

    // Описание — последняя колонка, обрезается; двойной клик открывает редактор.
    const descCell = el('td', 'views-tab-desc-cell');
    const descEl = el('span', 'views-tab-desc muted', (view.description ?? '').slice(0, 160) || '—');
    descEl.title = view.description ?? '';
    descCell.append(descEl);
    descCell.addEventListener('dblclick', () => void onEdit(view));
    tr.append(descCell);

    // Одиночный клик подсвечивает строку для клавишной навигации.
    tr.addEventListener('click', () => {
      const rows = Array.from(tableWrap.querySelectorAll<HTMLTableRowElement>('.views-tab-table tbody tr'));
      selectedIdx = rows.indexOf(tr);
      applySelection();
    });

    return tr;
  }

  function onAdd(): void {
    const typeId = getTypeId();
    if (typeId === null) {
      notice('Сначала сохраните тип, чтобы добавлять отборы.', 'info');
      return;
    }
    openViewEditorDialog({
      networkId,
      thoughtTypeId: typeId,
      typeName: getTypeName(),
      view: null,
      onSaved: () => {
        void load();
        opts.onChanged?.();
      },
    });
  }

  function onEdit(view: ThoughtTypeView): void {
    openViewEditorDialog({
      networkId,
      thoughtTypeId: view.thought_type_id,
      typeName: getTypeName(),
      view,
      onSaved: () => {
        void load();
        opts.onChanged?.();
      },
    });
  }

  async function onDelete(view: ThoughtTypeView): Promise<void> {
    const ok = await confirmDialog(
      'Удалить отбор',
      `Удалить отбор «${view.name}»? Это действие необратимо.`,
      true,
    );
    if (!ok) return;
    try {
      await etn.thoughtTypeViews.remove(networkId, view.thought_type_id, view.id, view.version);
      // Realtime event «thought-type-view.deleted» сам перечитает список;
      // подстраховка — локально убираем строку до прихода события.
      views = views.filter((v) => v.id !== view.id);
      renderRows();
      opts.onChanged?.();
    } catch (err) {
      errorDialog('Удалить отбор', err);
      void load();
    }
  }

  async function onSetDefault(view: ThoughtTypeView): Promise<void> {
    const plan = planSetDefault(views, view.id);
    if (plan === null) return;
    const prev = views.map((v) => ({ ...v }));
    // Optimistic local flip: the row gets the badge, the previous default
    // loses it. Server-side transactional clear runs in parallel.
    views = views.map((v) =>
      v.id === view.id ? { ...v, is_default: true } : { ...v, is_default: false },
    );
    renderRows();
    try {
      await etn.thoughtTypeViews.update(
        networkId,
        view.thought_type_id,
        view.id,
        { is_default: true },
        view.version,
      );
      opts.onChanged?.();
    } catch (err) {
      errorDialog('Сделать отбором по умолчанию', err);
      views = prev;
      renderRows();
      void load();
    }
  }

  async function onClearDefault(view: ThoughtTypeView): Promise<void> {
    const plan = planClearDefault(views, view.id);
    if (plan === null) return;
    const prev = views.map((v) => ({ ...v }));
    views = views.map((v) => (v.id === view.id ? { ...v, is_default: false } : v));
    renderRows();
    try {
      await etn.thoughtTypeViews.update(
        networkId,
        view.thought_type_id,
        view.id,
        { is_default: false },
        view.version,
      );
      opts.onChanged?.();
    } catch (err) {
      errorDialog('Снять признак «по умолчанию»', err);
      views = prev;
      renderRows();
      void load();
    }
  }

  async function onMove(
    view: ThoughtTypeView,
    fromIndex: number,
    toIndex: number,
    sorted: ThoughtTypeView[],
  ): Promise<void> {
    const plan = planReorder(sorted, fromIndex, toIndex);
    if (plan === null) return;
    const prev = views.map((v) => ({ ...v }));
    // Apply the swap locally — both rows get their new `position`. The
    // server doesn't renumber siblings on update, so the next `load()`
    // could in theory disagree until both PATCHes land; we keep the
    // optimistic swap until either error forces a rollback.
    views = views.map((v) => {
      if (v.id === plan.movedId) return { ...v, position: plan.movedPosition };
      if (v.id === plan.neighbourId) return { ...v, position: plan.neighbourPosition };
      return v;
    });
    renderRows();
    try {
      await Promise.all([
        etn.thoughtTypeViews.update(
          networkId,
          view.thought_type_id,
          plan.movedId,
          { position: plan.movedPosition },
          sorted.find((v) => v.id === plan.movedId)!.version,
        ),
        etn.thoughtTypeViews.update(
          networkId,
          view.thought_type_id,
          plan.neighbourId,
          { position: plan.neighbourPosition },
          sorted.find((v) => v.id === plan.neighbourId)!.version,
        ),
      ]);
      opts.onChanged?.();
    } catch (err) {
      errorDialog('Переставить отбор', err);
      views = prev;
      renderRows();
      void load();
    }
  }

  // Изначально вкладка подписывалась на realtime, но никогда не грузила
  // список при построении — `load()` вызывался только по событиям и в
  // обработчиках, поэтому при открытии редактора существующего типа вкладка
  // оставалась пустой (ошибка 9792d55a). Загружаем сразу: для нового типа
  // `getTypeId()` вернёт null → покажется подсказка, для существующего —
  // список отборов.
  void load();

  return {
    root,
    refresh: () => load(),
    dispose: () => unsubscribeRealtime(),
  };
}
