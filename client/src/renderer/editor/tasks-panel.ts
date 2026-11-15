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
 * редактора; команды «⋮» — отмена/перенос/снятие дат всех невыполненных по этой
 * мысли (ошибка 3cef7466).
 *
 * **Устаревание** (`0e85b66e`, ошибки d318a647/45480290). Серая ТОЛЬКО строка,
 * изменённая из панели (чекбокс, перенос, снятие дат, инлайн-правка); внешнее
 * изменение записи красит все её строки — событие слоя не знает номера строки.
 * Состав секций пересобирает только явное «Обновить», а инлайн-правка строку
 * перечитывает точечно (новый текст виден сразу).
 *
 * Состояние пустой панели: группа `main.tasks` скрывается (`hidden`), и
 * комментарий занимает вкладку целиком; раскладку зон пересчитывает редактор
 * по событию `etn:zone-visibility`.
 */

import type { Comment, TaskDTO, TaskMassAction, TaskMassFilter, TaskOpAction } from '@etn/shared';

import { confirmDialog } from '../lib/dialog.js';
import { openDatePeriodDialog } from '../lib/date-period-dialog.js';
import { div, errText } from '../lib/dom.js';
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
  panelNeedsRefresh,
  planTaskBulk,
  replaceTaskLine,
  taskCounters,
  taskRowKey,
  taskRowsForFilter,
  taskRowView,
  taskZoneVisible,
  type TaskPanelRow,
  type TaskPanelStaleness,
} from '../lib/ui/task-panel-model.js';
import { requireNetworkId } from '../app.js';
import { onReconnected, store } from '../state.js';
import {
  openLinkInEditor,
  openRecordInEditor,
  openThoughtInEditor,
  registerMainSection,
  showEditorMainTab,
  type EditorContext,
  type TabPaneLifecycle,
} from './editor.js';
import type { GroupSpec } from './group.js';
import { renderMarkdownWithWikiLinks } from './wiki-link-resolver.js';

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
  registerMainSection(createEditorTasksSection);
}

/**
 * Секция `main.tasks` как `GroupSpec` (`null` — у связи зоны задач нет).
 * Отдельная фабрика: шапку зоны (бейдж счётчиков, «Обновить», «⋮») проверяет
 * DOM-тест без монтирования всего редактора (0.16.1, блокер приёмки 710b68aa).
 */
export function createEditorTasksSection(
  ctx: EditorContext,
  lifecycle: TabPaneLifecycle,
): GroupSpec | null {
  if (ctx.ownerType !== 'thought') return null;
  const host = div('main-tasks-body');
  const panel = mountEditorTasksPanel(host, ctx, lifecycle);
  return {
    id: 'main.tasks',
    title: t('editor.title.tasks'),
    // Панель раскрыта по умолчанию: свёрнутость `main.tasks` — пользовательский
    // персист (`editor_collapsed_groups`), дефолт — раскрытая зона.
    defaultCollapsed: false,
    // Бейдж шапки: счётчики публикует тело панели событием `etn:set-count`.
    // Без `lazyCount` группы не создавали узел бейджа, и счётчики (требование
    // f3893859 «заголовок панели: «Задачи», счётчики») не показывались.
    lazyCount: true,
    actions: panel.headActions(),
    buildBody: () => host,
  };
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
  /** Строки, изменённые из панели (`comment_id:line_no`) — серые точечно. */
  let staleRows = new Set<string>();
  /** Записи, изменённые вне панели: событие слоя не знает номера строки. */
  let staleComments = new Set<string>();
  /** Показанное состояние чекбоксов строк, переключённых из панели (d318a647). */
  const toggledDone = new Map<string, boolean>();
  /** Известные ревизии источников — адрес `expected_revision` (d318a647). */
  const commentVersions = new Map<string, number>();
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
      // «Сделать бессрочными» — массовая форма команды строки (ошибка 3cef7466).
      menuAction(t('tasks.undateAllThought'), () => void runBulk(filter, 'undate-all')),
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
      staleRows = new Set<string>();
      staleComments = new Set<string>();
      toggledDone.clear();
      commentVersions.clear();
      for (const row of items) rememberVersion(row.comment_id, row.revision);
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

  /** Признаки устаревания для модели: строки — из панели, записи — снаружи. */
  function staleness(): TaskPanelStaleness {
    return { rows: staleRows, comments: staleComments };
  }

  /** Запомнить ревизию источника (адрес `expected_revision` и маркер). */
  function rememberVersion(commentId: string, version: number): void {
    commentVersions.set(commentId, Math.max(commentVersions.get(commentId) ?? 0, version));
    if (version > state.maxRevision) state.maxRevision = version;
  }

  /** Применить новые ревизии источников после операции (может не прийти). */
  function applyRevisions(revisions: readonly Comment[] | undefined): void {
    for (const revision of revisions ?? []) rememberVersion(revision.id, revision.version);
  }

  /**
   * Строка view-модели: неактуальная строка серая (решение 2026-11-12), серая
   * строка — точечно (правка из панели) либо вся запись (внешнее изменение);
   * переключённая из панели строка показывает новое состояние чекбокса
   * (ошибка d318a647).
   */
  function viewRow(row: TaskDTO): TaskPanelRow {
    const address = taskRowKey(row);
    const view = taskRowView(row, staleness(), toggledDone.get(address));
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
      stale: panelNeedsRefresh({ rows: visible, stale: staleness(), markerAdvanced }),
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

  /**
   * Ревизия источника строки — для `expected_revision` операций. Сначала
   * известная ревизия комментария: правка одной строки поднимает ревизию всей
   * записи, и снапшот соседней строки уже отстал (ошибка d318a647).
   */
  function revisionOf(row: TaskPanelRow): number {
    const known = commentVersions.get(row.commentId);
    if (known !== undefined) return known;
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

  /**
   * Чекбокс: одиночный клик переключает строку источника (без режима правки).
   * Команда работает и на серой строке; серой становится ТОЛЬКО эта строка, а
   * повторный клик снимает отметку (ошибка d318a647).
   */
  async function toggleTask(row: TaskPanelRow, done: boolean): Promise<void> {
    const networkId = requireNetworkId();
    const address = row.key;
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
      applyRevisions(result.revisions);
      // Локальная правка НЕ перечитывает список: строка серая, «Обновить»
      // подсвечена — состав секций пересоберёт только явное нажатие.
      staleRows.add(address);
      toggledDone.set(address, done);
      publish();
    } catch (err) {
      staleRows.add(address);
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
      const updated = await etn.comments.update(
        networkId,
        row.commentId,
        { body_md: next },
        comment.version,
      );
      // Сохранённая строка перечитывается ТОЧЕЧНО: панель показывает новый
      // текст сразу и не сереет (ошибка 45480290).
      await refreshCommentRows(row.commentId, updated.version);
      publish();
      return true;
    } catch (err) {
      notice(t('tasks.errorEdit', [errText(err)]), 'error');
      return false;
    }
  }

  /**
   * Перечитать строки ОДНОГО комментария-источника после инлайн-правки (ошибка
   * 45480290). Строки записи заменяются целиком: правка могла снять маркер
   * задачи, сменить срок или отметку, и прежние строки этой записи больше не
   * отражают её текст.
   */
  async function refreshCommentRows(commentId: string, version: number): Promise<void> {
    const networkId = requireNetworkId();
    rememberVersion(commentId, version);
    const fresh: TaskDTO[] = [];
    let cursor: string | undefined;
    do {
      const page = await etn.tasks.list(networkId, {
        comment_id: commentId,
        limit: TASKS_PAGE_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      fresh.push(...page.items);
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    const member = { thought_id: ctx.ownerId, today: todayLocal() };
    state = {
      rows: [
        ...state.rows.filter((item) => item.comment_id !== commentId),
        ...taskRowsForFilter(fresh, member),
      ],
      maxRevision: state.maxRevision,
    };
    for (const item of fresh) rememberVersion(item.comment_id, item.revision);
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
      // Постоянный комментарий записи «Дневника» не имеет: его источник
      // открывается карточкой владельца на вкладке «Основное», без
      // pending-записи (замечание приёмки 710b68aa). Запись выбирает только
      // хроно-строка.
      const permanent = dto.kind === 'permanent';
      if (dto.owner_type === 'thought') {
        if (permanent) {
          openThoughtInEditor(dto.owner_id);
          showEditorMainTab();
        } else {
          openRecordInEditor(dto.owner_id, dto.comment_id);
        }
        return;
      }
      if (dto.owner_type === 'link') {
        openLinkInEditor(await etn.links.get(networkId, dto.owner_id));
        if (permanent) showEditorMainTab();
        return;
      }
      // Публикация: ленивый импорт — статический замкнул бы цикл экранов.
      const { openPublicationInWorkspace } = await import('../screens/active-view.js');
      await openPublicationInWorkspace(dto.owner_id);
    } catch (err) {
      notice(t('tasks.errorOpenSource', [errText(err)]), 'error');
    }
  }

  /**
   * Команда строки: перенести даты / сделать бессрочной / отменить задачу
   * (источник — `openSource`). «Перенести на дату» — операция `set_due`, поэтому
   * она работает и у строки без дат (ошибка 3f9ea2ee).
   */
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
    let action: TaskOpAction = 'cancel';
    let payload: { days?: number; months?: number; date?: string } = {};
    if (command === 'move') {
      if (shift?.date !== undefined) {
        const anchor = row.due ?? row.periodFrom;
        if (anchor !== null && shiftToDate(anchor, shift.date) === null) {
          notice(t('tasks.moveNotNeeded'), 'info');
          return;
        }
        // Срок задаёт сервер: у строки с датами сдвигаются все ссылки (период
        // сохраняется), у бессрочной появляется новая date-ссылка.
        action = 'set_due';
        payload = { date: shift.date };
      } else {
        action = 'move';
        payload = shift ?? {};
      }
    } else if (command === 'undate') {
      // «Сделать бессрочной»: все date-ссылки строки удаляются (ошибка 3cef7466).
      action = 'undate';
    }
    try {
      const result = await etn.tasks.patch(networkId, {
        ops: [
          {
            comment_id: row.commentId,
            line_no: row.lineNo,
            action,
            ...payload,
            expected_revision: revisionOf(row),
          },
        ],
      });
      const first = result.results[0];
      if (first !== undefined && !first.ok) {
        notice(taskErrorText(first.error), 'error');
        return;
      }
      applyRevisions(result.revisions);
      staleRows.add(row.key);
      publish();
    } catch (err) {
      notice(t('tasks.errorRowCommand', [errText(err)]), 'error');
    }
  }

  /** Ключ вопроса подтверждения массовой команды (по её виду). */
  function bulkQuestionKey(
    command: TaskMassAction,
  ): 'tasks.bulkCancelQuestion' | 'tasks.bulkMoveQuestion' | 'tasks.bulkUndateQuestion' {
    if (command === 'cancel-all') return 'tasks.bulkCancelQuestion';
    if (command === 'move-all') return 'tasks.bulkMoveQuestion';
    return 'tasks.bulkUndateQuestion';
  }

  /** Массовая команда по мысли: подтверждение → команда → полное перечитывание. */
  async function runBulk(
    filter: TaskMassFilter,
    command: TaskMassAction,
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
      t(bulkQuestionKey(command), [selected.length]),
      // Красная кнопка — только у снятия задач: снятие дат отменяется «Обновить».
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
    renderEditorTaskRowText(node, row.text, requireNetworkId());
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
      const version = typeof data.version === 'number' ? data.version : null;
      // Эхо собственной правки: строка уже помечена серой точечно, запись
      // целиком красить нельзя (ошибка d318a647).
      if (data.id !== undefined && version !== null && commentVersions.get(data.id) === version) {
        return;
      }
      if (panelMarkerAdvanced(version, state.maxRevision)) {
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

/**
 * Нарисовать снапшот текста строки зоны «Задачи» редактора мысли: markdown +
 * кликабельные ID-ссылки. Резолв — по ГОТОВОМУ DOM (общий вход
 * `renderMarkdownWithWikiLinks`): отрендеренный markdown несёт
 * `<span class="wiki-link" data-wiki-id>`, которого резолвер строки сниппета не
 * видит, поэтому подпись оставалась пустой, ссылка — некликабельной (Д1
 * репроверки `7677fe06`, блокер 399c25d5). Вынесено из замыкания панели ради
 * теста: DOM-шим не разбирает `innerHTML` на узлы, поэтому проверяется сам
 * рендер строки.
 */
export function renderEditorTaskRowText(node: HTMLElement, text: string, networkId: string): void {
  renderMarkdownWithWikiLinks(node, text, networkId);
}
