/**
 * Панель «Задачи» вкладки «Основное» редактора МЫСЛИ (0.16.1, задача
 * `710b68aa`; элемент интерфейса `f3893859`, элементы строки `498f23e0`,
 * требования `e6d65f51`/`e6af8b9e`/`0e85b66e`).
 *
 * **Состав.** Любые строки задач (`- [ ]` / `- [X]`) в записях и комментариях,
 * содержащие ID-ссылку на эту мысль: выборка `GET /tasks?thought_id=` идёт по
 * `task_row_subjects` (индекс `thought_id`), текст/период/состояние берутся из
 * проекции — парсинг на лету не выполняется (ADR `d0c07f33`). Напоминаний в
 * панели нет (они в шапке редактора, задача 7).
 *
 * **Порядок.** Строки без даты — всегда вверху, дальше по возрастанию срока;
 * активные сверху, выполненные — в сворачиваемой секции «Выполненные задачи
 * (n)».
 *
 * **Шапка.** Панель монтируется БЕЗ своей шапки (`headless`): заголовок
 * «Задачи», счётчики и кнопки «Обновить»/«⋮» ставит группа `main.tasks`
 * редактора; команды «⋮» — отмена/перенос всех невыполненных по этой мысли.
 *
 * **Устаревание** (`0e85b66e`). Переключение чекбокса и любое внешнее изменение
 * источника красят строку серой и подсвечивают «Обновить»; состав секций
 * пересобирает только явное нажатие — задача уезжает в «Выполненные»/обратно
 * при перечитывании, а не сама по себе.
 *
 * Состояние пустой панели: группа `main.tasks` скрывается (`hidden`), и
 * комментарий занимает вкладку целиком; раскладку зон пересчитывает редактор
 * по событию `etn:zone-visibility`.
 */

import type { TaskDTO, TaskMassFilter } from '@etn/shared';

import { renderMarkdown } from '@etn/markdown';

import { confirmDialog } from '../lib/dialog.js';
import { openDatePeriodDialog } from '../lib/date-period-dialog.js';
import { div, errText, renderHtml } from '../lib/dom.js';
import { todayLocal } from '../lib/dates.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { onRoutedRealtimeEvent } from '../lib/live/event-router.js';
import { MENU_SEPARATOR, menuAction, menuSubmenu, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import {
  mountTaskPanel,
  type TaskPanelHandle,
  type TaskPanelSectionView,
  type TaskPanelView,
  type TaskRowCommand,
  type TaskShift,
} from '../lib/ui/task-panel.js';
import {
  calendarDaysBetween,
  orderTaskRowsUndatedFirst,
  panelMarkerAdvanced,
  planTaskBulk,
  replaceTaskLine,
  taskCounters,
  taskRowView,
  taskZoneVisible,
  type TaskPanelRow,
} from '../lib/ui/task-panel-model.js';
import { requireNetworkId } from '../app.js';
import { onReconnected, store } from '../state.js';
import {
  openLinkInEditor,
  openRecordInEditor,
  registerMainSection,
  type EditorContext,
  type TabPaneLifecycle,
} from './editor.js';
import { paintWikiIdsInSnippet, resolveWikiIdsInSnippet } from './wiki-link-resolver.js';

/** Предел строк на один запрос списка задач (сервер: `TASKS_MAX_LIMIT`). */
const TASKS_PAGE_LIMIT = 200;

/** Состояние одной загрузки панели. */
interface EditorTasksState {
  rows: TaskDTO[];
  maxRevision: number;
}

/** Пустое состояние до первой загрузки. */
function emptyState(): EditorTasksState {
  return { rows: [], maxRevision: 0 };
}

/**
 * Регистрирует секцию `main.tasks` вкладки «Основное» (только мысль, только
 * после группы `permanent`). Порядок регистрации задаёт порядок зон вкладки.
 */
export function registerEditorTasksSection(): void {
  registerMainSection((ctx, lifecycle) => {
    if (ctx.ownerType !== 'thought') return null;
    const host = div('main-tasks-body');
    const panel = mountEditorTasksPanel(host, ctx, lifecycle);
    return {
      id: 'main.tasks',
      title: t('editor.title.tasks'),
      // Панель раскрыта по умолчанию: свёрнутость `main.tasks` — пользовательский
      // персист (`editor_collapsed_groups`), дефолт — раскрытая зона.
      defaultCollapsed: false,
      actions: panel.headActions(),
      buildBody: () => host,
    };
  });
}

/**
 * Экранная обвязка панели: загрузка, действия строк/массовых команд, realtime.
 * Живёт ровно с телом группы — `lifecycle.onDispose` снимает подписку.
 */
function mountEditorTasksPanel(
  host: HTMLElement,
  ctx: EditorContext,
  lifecycle: TabPaneLifecycle,
): TaskPanelHandle {
  let disposed = false;
  let loading = false;
  let loadError: string | null = null;
  let state = emptyState();
  let staleComments = new Set<string>();
  let markerAdvanced = false;
  let loadSeq = 0;
  /** Снимок обновления при обрыве связи: перечитать по восстановлению. */
  let retryStop: (() => void) | null = null;

  const panel = mountTaskPanel(
    host,
    {
      refresh: () => void loadTasks(),
      // «Отменить» массовой команды в панели редактора нет — команда адресуется
      // мыслью и перечитывается сразу (снимок отмены не нужен).
      undo: () => undefined,
      // Показ выполненных — не переключатель панели: выполненные всегда в
      // собственной сворачиваемой секции.
      setShowDone: () => undefined,
      toggle: (row, done) => void toggleTask(row, done),
      loadRawLine: (row) => loadRawLine(row),
      editLine: (row, text) => saveLine(row, text),
      rowCommand: (row, command, shift) => void runRowCommand(row, command, shift),
      bulk: (filter, command, shift) => void runBulk(filter, command, shift),
      // Напоминаний в панели редактора нет — действия вхождений не вызываются.
      reminderAction: () => undefined,
      reminderGroupDismiss: () => undefined,
      pickDate: (initial) => pickDate(initial),
      pickDateTime: async () => null,
      // Клик по дате открывает запись-источник, а не день ленты «Дневника».
      openDay: () => undefined,
      openRowSource: (row) => void openSource(row),
      headMenu: () => headMenu(),
      renderText: (node, row) => renderRowText(node, row),
    },
    { headless: true },
  );

  lifecycle.onDispose(() => {
    disposed = true;
    retryStop?.();
    retryStop = null;
    panel.destroy();
  });

  /** Меню «⋮» шапки: массовые команды по невыполненным строкам этой мысли. */
  function headMenu(): MenuItem[] {
    const filter = thoughtFilter();
    return [
      menuAction(t('tasks.cancelAllThought'), () => void runBulk(filter, 'cancel-all')),
      menuSubmenu(t('tasks.moveAllThought'), [
        menuAction(t('tasks.shiftDay'), () => void runBulk(filter, 'move-all', { days: 1 })),
        menuAction(t('tasks.shiftWeek'), () => void runBulk(filter, 'move-all', { days: 7 })),
        menuAction(t('tasks.shiftMonth'), () => void runBulk(filter, 'move-all', { months: 1 })),
        MENU_SEPARATOR,
        menuAction(t('tasks.moveDate'), () => void pickBulkDate(filter)),
      ]),
    ];
  }

  /** Фильтр массовой команды: невыполненные строки этой мысли. */
  function thoughtFilter(): TaskMassFilter {
    return { scope: 'open', thought_id: ctx.ownerId, today: todayLocal() };
  }

  /**
   * Перечитать панель целиком (ручное «Обновить»): все страницы по мысли,
   * сквозной маркер проекции — для подсветки «Обновить» по событиям.
   */
  async function loadTasks(): Promise<void> {
    if (disposed) return;
    const networkId = requireNetworkId();
    const seq = (loadSeq += 1);
    loading = true;
    publish();
    try {
      const items: TaskDTO[] = [];
      let maxRevision = 0;
      let cursor: string | undefined;
      do {
        const page = await etn.tasks.list(networkId, {
          thought_id: ctx.ownerId,
          limit: TASKS_PAGE_LIMIT,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        items.push(...page.items);
        maxRevision = Math.max(maxRevision, page.max_revision);
        cursor = page.cursor ?? undefined;
      } while (cursor !== undefined);
      if (disposed || seq !== loadSeq) return;
      retryStop?.();
      retryStop = null;
      state = { rows: items, maxRevision };
      staleComments = new Set<string>();
      markerAdvanced = false;
      loadError = null;
    } catch (err) {
      if (disposed || seq !== loadSeq) return;
      loadError = errText(err);
      retryStop?.();
      retryStop = onReconnected(networkId, () => void loadTasks());
    } finally {
      if (!disposed && seq === loadSeq) {
        loading = false;
        publish();
      }
    }
  }

  /** Строки задачи в порядке панели: без даты вверху, дальше срок по возрастанию. */
  function ordered(rows: readonly TaskDTO[]): TaskDTO[] {
    return orderTaskRowsUndatedFirst(rows);
  }

  /** Строка view-модели: неактуальная строка серая (решение 2026-11-12). */
  function viewRow(row: TaskDTO): TaskPanelRow {
    const view = taskRowView(row, staleComments);
    if (row.subject_state === 'inactive') view.stale = true;
    return view;
  }

  /** Собрать снимок панели, синхронизировать видимость зоны и отрисовать. */
  function publish(): void {
    if (disposed) return;
    // Неактуальные строки: настройка сети решает, серая она или скрыта
    // (владелец/субъект неактуальны).
    const visible = state.rows.filter(
      (row) => row.subject_state === 'active' || store.state.showInactive,
    );
    const active = ordered(visible.filter((row) => !row.done)).map(viewRow);
    const done = ordered(visible.filter((row) => row.done)).map(viewRow);
    const counters = taskCounters(visible);

    const sections: TaskPanelSectionView[] = [];
    if (active.length > 0) {
      sections.push({ key: 'active', title: '', flat: true, subgroups: [], rows: active });
    }
    if (done.length > 0) {
      sections.push({
        key: 'done',
        title: t('tasks.doneGroup'),
        flat: true,
        collapsible: true,
        collapsed: true,
        subgroups: [],
        rows: done,
      });
    }

    const view: TaskPanelView = {
      stale: staleComments.size > 0 || markerAdvanced,
      periodFilter: thoughtFilter(),
      canUndo: false,
      showDone: true,
      counters,
      reminderCount: 0,
      taskSections: sections,
      reminderSections: [],
      loading,
      error: loadError,
    };
    panel.render(view);
    syncZone(
      taskZoneVisible({
        rowCount: visible.length,
        loading,
        hasError: loadError !== null,
      }),
    );
  }

  /**
   * Синхронизировать видимость зоны `main.tasks`: пустая панель не показывается
   * (комментарий занимает вкладку), раскладку пересчитывает редактор по событию.
   */
  function syncZone(visible: boolean): void {
    const group = host.closest<HTMLElement>('.group');
    if (group === null || group.hidden === !visible) return;
    group.hidden = !visible;
    group.dispatchEvent(new CustomEvent('etn:zone-visibility', { bubbles: true }));
  }

  /** Ревизия источника строки — для `expected_revision` операций. */
  function revisionOf(row: TaskPanelRow): number {
    const ref = state.rows.find(
      (item) => item.comment_id === row.commentId && item.line_no === row.lineNo,
    );
    return ref?.revision ?? 1;
  }

  /** DTO строки по ключу панели (адрес источника для «Открыть источник»). */
  function rowDto(row: TaskPanelRow): TaskDTO | null {
    return (
      state.rows.find((item) => item.comment_id === row.commentId && item.line_no === row.lineNo) ??
      null
    );
  }

  /** Текст ошибки операции строки (коды операции de4cee18). */
  function taskErrorText(code: string | undefined): string {
    if (code === 'line_not_found') return t('tasks.errorLineNotFound');
    if (code === 'not_a_task') return t('tasks.errorNotATask');
    if (code === 'comment_not_found') return t('tasks.errorCommentNotFound');
    if (code === 'undated') return t('tasks.errorUndated');
    return t('tasks.errorGeneric');
  }

  /** Чекбокс: одиночный клик переключает строку источника (без режима правки). */
  async function toggleTask(row: TaskPanelRow, done: boolean): Promise<void> {
    const networkId = requireNetworkId();
    try {
      const result = await etn.tasks.patch(networkId, {
        ops: [
          {
            comment_id: row.commentId,
            line_no: row.lineNo,
            action: 'toggle',
            done,
            expected_revision: revisionOf(row),
          },
        ],
      });
      const first = result.results[0];
      if (first !== undefined && !first.ok) {
        notice(taskErrorText(first.error), 'error');
        return;
      }
      // Локальная правка НЕ перечитывает список: строка серая, «Обновить»
      // подсвечена — состав секций пересоберёт только явное нажатие.
      staleComments.add(row.commentId);
      publish();
    } catch (err) {
      staleComments.add(row.commentId);
      publish();
      notice(t('tasks.errorToggle', [errText(err)]), 'error');
    }
  }

  /**
   * Сырая строка `body_md` для инлайн-правки: снапшот `TaskDTO.text` маркера не
   * содержит, поэтому правится источник целиком (маркер и чекбокс на месте).
   */
  async function loadRawLine(row: TaskPanelRow): Promise<string | null> {
    const networkId = requireNetworkId();
    try {
      const comment = await etn.comments.get(networkId, row.commentId);
      const line = comment.body_md.split('\n')[row.lineNo];
      if (line === undefined) {
        notice(taskErrorText('line_not_found'), 'error');
        return null;
      }
      return line;
    } catch (err) {
      notice(t('tasks.errorEdit', [errText(err)]), 'error');
      return null;
    }
  }

  /** Инлайн-правка СЫРОЙ markdown строки (правка `body_md` источника). */
  async function saveLine(row: TaskPanelRow, rawLine: string): Promise<boolean> {
    const networkId = requireNetworkId();
    try {
      const comment = await etn.comments.get(networkId, row.commentId);
      const next = replaceTaskLine(comment.body_md, row.lineNo, rawLine);
      if (next === null) {
        notice(taskErrorText('line_not_found'), 'error');
        return false;
      }
      if (next === comment.body_md) return true;
      await etn.comments.update(networkId, row.commentId, { body_md: next }, comment.version);
      staleComments.add(row.commentId);
      publish();
      return true;
    } catch (err) {
      notice(t('tasks.errorEdit', [errText(err)]), 'error');
      return false;
    }
  }

  /** Абсолютная дата → серверный сдвиг от якоря строки (`null` — двигать нечего). */
  function shiftToDate(anchor: string, target: string): TaskShift | null {
    const days = calendarDaysBetween(anchor, target);
    if (!Number.isFinite(days) || days === 0) return null;
    return { days };
  }

  /** Диалог «Дата» (общий контрол периода); `null` — отмена. */
  async function pickDate(initial: string): Promise<string | null> {
    const value = await openDatePeriodDialog({
      allowPeriod: false,
      allowTime: false,
      title: t('tasks.pickDateTitle'),
      initial: { mode: 'date', from: initial, to: initial },
    });
    return value === null ? null : value.from;
  }

  /**
   * Открыть запись/комментарий-источник строки. Постоянный комментарий открывает
   * карточку владельца, запись — её саму (вкладка «Дневник» владельца-мысли).
   */
  async function openSource(row: TaskPanelRow): Promise<void> {
    const dto = rowDto(row);
    if (dto === null) return;
    const networkId = requireNetworkId();
    try {
      if (dto.owner_type === 'thought') {
        openRecordInEditor(dto.owner_id, dto.comment_id);
        return;
      }
      if (dto.owner_type === 'link') {
        openLinkInEditor(await etn.links.get(networkId, dto.owner_id));
        return;
      }
      // Публикация: ленивый импорт — статический замкнул бы цикл экранов.
      const { openPublicationInWorkspace } = await import('../screens/active-view.js');
      await openPublicationInWorkspace(dto.owner_id);
    } catch (err) {
      notice(t('tasks.errorOpenSource', [errText(err)]), 'error');
    }
  }

  /** Команда строки: перенести даты / отменить задачу (источник — `openSource`). */
  async function runRowCommand(
    row: TaskPanelRow,
    command: TaskRowCommand,
    shift?: TaskShift,
  ): Promise<void> {
    if (command === 'open-source') {
      await openSource(row);
      return;
    }
    const networkId = requireNetworkId();
    let effectiveShift = shift;
    if (command === 'move' && shift?.date !== undefined) {
      const anchor = row.due ?? row.periodFrom;
      if (anchor === null) {
        notice(taskErrorText('undated'), 'error');
        return;
      }
      const resolved = shiftToDate(anchor, shift.date);
      if (resolved === null) {
        notice(t('tasks.moveNotNeeded'), 'info');
        return;
      }
      effectiveShift = resolved;
    }
    try {
      const result = await etn.tasks.patch(networkId, {
        ops: [
          {
            comment_id: row.commentId,
            line_no: row.lineNo,
            action: command === 'move' ? 'move' : 'cancel',
            ...(effectiveShift !== undefined ? effectiveShift : {}),
            expected_revision: revisionOf(row),
          },
        ],
      });
      const first = result.results[0];
      if (first !== undefined && !first.ok) {
        notice(taskErrorText(first.error), 'error');
        return;
      }
      staleComments.add(row.commentId);
      publish();
    } catch (err) {
      notice(t('tasks.errorRowCommand', [errText(err)]), 'error');
    }
  }

  /** Массовая команда по мысли: подтверждение → команда → полное перечитывание. */
  async function runBulk(
    filter: TaskMassFilter,
    command: 'cancel-all' | 'move-all',
    shift?: TaskShift,
  ): Promise<void> {
    const networkId = requireNetworkId();
    let effectiveShift = shift;
    if (command === 'move-all' && shift?.date !== undefined) {
      const resolved = shiftToDate(todayLocal(), shift.date);
      if (resolved === null) {
        notice(t('tasks.moveNotNeeded'), 'info');
        return;
      }
      effectiveShift = resolved;
    }
    const selected = planTaskBulk(
      state.rows.filter((row) => row.subject_state === 'active' || store.state.showInactive),
      filter,
    ).rows;
    if (selected.length === 0) {
      notice(t('tasks.bulkEmpty'), 'info');
      return;
    }
    const confirmed = await confirmDialog(
      t('tasks.bulkTitle'),
      t(command === 'cancel-all' ? 'tasks.bulkCancelQuestion' : 'tasks.bulkMoveQuestion', [
        selected.length,
      ]),
      command === 'cancel-all',
    );
    if (!confirmed || disposed) return;
    try {
      const result = await etn.tasks.patch(networkId, {
        action: command,
        filter,
        ...(effectiveShift !== undefined ? effectiveShift : {}),
      });
      const failed = result.results.filter((item) => !item.ok);
      if (failed.length > 0) notice(t('tasks.bulkPartial', [failed.length]), 'warning');
      await loadTasks();
    } catch (err) {
      notice(t('tasks.bulkFailed', [errText(err)]), 'error');
    }
  }

  /** «Перенести… на дату» для массовой команды: произвольная дата. */
  async function pickBulkDate(filter: TaskMassFilter): Promise<void> {
    const date = await pickDate(todayLocal());
    if (date !== null) await runBulk(filter, 'move-all', { date });
  }

  /** Нарисовать снапшот текста строки: markdown + кликабельные ID-ссылки. */
  function renderRowText(node: HTMLElement, row: TaskPanelRow): void {
    const networkId = requireNetworkId();
    const html = renderMarkdown(row.text === '' ? '' : row.text);
    renderHtml(node, paintWikiIdsInSnippet(html, networkId));
    if (html === '') return;
    void resolveWikiIdsInSnippet(html, networkId).then((resolved) => {
      if (node.isConnected) renderHtml(node, resolved);
    });
  }

  /** Комментарии-источники, загруженные в панель. */
  function loadedCommentIds(): Set<string> {
    return new Set(state.rows.map((row) => row.comment_id));
  }

  /**
   * События слоя: чужая правка источника — серая строка и подсветка
   * «Обновить»; состав секций меняется только по нажатию (требование 0e85b66e).
   */
  const unsubscribe = onRoutedRealtimeEvent((event) => {
    if (disposed) return;
    if (event.network_id !== store.state.networkId) return;
    if (event.type === 'comment.updated') {
      const data = event.data as { id?: string; version?: unknown };
      if (
        panelMarkerAdvanced(
          typeof data.version === 'number' ? data.version : null,
          state.maxRevision,
        )
      ) {
        markerAdvanced = true;
      }
      if (data.id !== undefined && loadedCommentIds().has(data.id)) {
        staleComments.add(data.id);
      }
      if (markerAdvanced || staleComments.size > 0) publish();
      return;
    }
    if (event.type === 'comment.created' || event.type === 'comment.deleted') {
      const id =
        (event.data as { comment?: { id?: string }; id?: string }).comment?.id ??
        (event.data as { id?: string }).id;
      if (id !== undefined && loadedCommentIds().has(id)) {
        staleComments.add(id);
        publish();
      }
    }
  });
  lifecycle.onDispose(() => unsubscribe());

  void loadTasks();

  return panel;
}
