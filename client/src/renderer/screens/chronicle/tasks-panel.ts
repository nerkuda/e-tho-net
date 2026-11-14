/**
 * Экранная обвязка панели «Задачи и напоминания» (0.16.1, задача 64f7976a;
 * требование 6762adb0 «группировка задач периода — пороги и секции»,
 * 0e85b66e «внешнее изменение строки — серым до «Обновить»», e6af8b9e
 * «массовые команды задач», 3616cfec «Просрочено», db1d9548 «Без срока»).
 *
 * Модуль связывает чистую модель (`lib/ui/task-panel-model.ts`) и библиотечную
 * компоненту (`lib/ui/task-panel.ts`) с сетью и состоянием вида:
 *  • читает задачи ТРЕМЯ запросами (`scope=open` в периоде, сквозные
 *    `overdue`/`undated`) плюс выполненные — по переключателю показывать их;
 *  • читает напоминания владельца с раскрытием повторов на период;
 *  • переводит строки в view-модель и раскладывает по секциям/группам;
 *  • исполняет действия (чекбокс, инлайн-правка, команды строки/группы,
 *    отложить/убрать/создать задачу);
 *  • держит «устарело» по событиям слоя: чужая правка источника красит строку
 *    серым и подсвечивает «Обновить», автоперечитывания нет (0e85b66e).
 *
 * Состояние переключателя «показывать выполненные» — L4 `ui_state`
 * (`UI_STATE_KEY.DIARY_TASKS_PANEL`), как прочие механики «Дневника».
 *
 * События читаются через `onRoutedRealtimeEvent` (санкционированный канал
 * побочных эффектов реактивного слоя): ключа запроса здесь нет намеренно —
 * перечитывание обязано быть РУЧНЫМ («Обновить»), иначе серая строка исчезала
 * бы сама до нажатия пользователя.
 */

import {
  UI_STATE_KEY,
  type Reminder,
  type ReminderListResult,
  type TaskDTO,
  type TaskMassFilter,
  type TaskScope,
} from '@etn/shared';

import { requireNetworkId } from '../../app.js';
import { renderMarkdown } from '@etn/markdown';
import { paintWikiIdsInSnippet, resolveWikiIdsInSnippet } from '../../editor/wiki-link-resolver.js';
import { confirmDialog } from '../../lib/dialog.js';
import {
  datePeriodValueFromInstants,
  openDatePeriodDialog,
  resolveDatePeriodInstants,
} from '../../lib/date-period-dialog.js';
import { errText, renderHtml } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { formatDateParts, getLang, t } from '../../lib/i18n.js';
import { onRoutedRealtimeEvent } from '../../lib/live/event-router.js';
import { notice } from '../../lib/notice.js';
import { store } from '../../state.js';
import {
  REMINDER_PANEL_ROW_CLASS,
  TASK_PANEL_ROW_CLASS,
  mountTaskPanel,
  type ReminderPanelSectionView,
  type ReminderRowAction,
  type TaskPanelSectionView,
  type TaskPanelView,
  type TaskRowCommand,
  type TaskShift,
} from '../../lib/ui/task-panel.js';
import {
  calendarDaysBetween,
  groupPanelRows,
  panelMarkerAdvanced,
  panelNeedsRefresh,
  planTaskBulk,
  reminderPanelRows,
  reminderSectionOf,
  replaceTaskLine,
  shiftDay,
  taskCounters,
  taskGroupingMode,
  taskRowKey,
  taskRowView,
  type PanelGroup,
  type ReminderPanelRow,
  type TaskPanelRow,
} from '../../lib/ui/task-panel-model.js';
import { isValidLocalDay } from '../../lib/dates.js';
import { formatDayLabel, localDayEnd, localDayStart, todayLocal } from './diary.js';
/** Зависимости экрана, которые остаются у «Дневника». */
export interface TasksPanelDeps {
  /** Применённый период ленты (локальные дни `YYYY-MM-DD`). */
  getPeriod(): { from: string; to: string };
  /** Открыть день ленты (переход к записи-источнику строки). */
  openDay(day: string): void;
  /** Правки в записях изменились — лента «Дневника» перечитывается. */
  onRecordsChanged(): void;
}

/** Дескриптор панели для экрана. */
export interface TasksPanelHandle {
  /** Перечитать панель (смена периода/отбора, показ вида). */
  refresh(): void;
  /** Снять подписки и размонтировать компоненту. */
  destroy(): void;
}

/** Сколько дней назад смотреть сработавшие напоминания в секции «Просрочено». */
const REMINDERS_OVERDUE_DAYS = 30;

/** Предел строк на один запрос списка задач (сервер: `TASKS_MAX_LIMIT`). */
const TASKS_PAGE_LIMIT = 200;

/** Локальная настройка панели в `ui_state`. */
interface TasksPanelSettings {
  showDone: boolean;
}

/** Состояние одной загрузки: данные + признак устаревания. */
interface TasksPanelState {
  period: TaskDTO[];
  overdue: TaskDTO[];
  undated: TaskDTO[];
  done: TaskDTO[];
  doneTotal: number;
  reminders: ReminderListResult;
  maxRevision: number;
}

/** Пустое состояние до первой загрузки. */
function emptyState(): TasksPanelState {
  return {
    period: [],
    overdue: [],
    undated: [],
    done: [],
    doneTotal: 0,
    reminders: { reminders: [], from: null, to: null },
    maxRevision: 0,
  };
}

/**
 * Смонтировать панель над лентой и запустить первую загрузку. Панель — часть
 * экрана «Дневник»: одна при любом периоде, вне блоков дней.
 */
export function mountTasksPanel(host: HTMLElement, deps: TasksPanelDeps): TasksPanelHandle {
  let disposed = false;
  let loading = false;
  let loadError: string | null = null;
  let state = emptyState();
  let showDone = false;
  let staleComments = new Set<string>();
  let remindersChanged = false;
  /** Глобальный маркер `max_revision` ушёл вперёд после загрузки (0e85b66e). */
  let markerAdvanced = false;
  let loadSeq = 0;
  /** Снимок текстов для отмены массовой команды (требование e6af8b9e). */
  let undoSnapshot: Array<{ id: string; body_md: string; version: number }> | null = null;
  /** Кэш названий субъектов (мысль/публикация) — группировка и строки. */
  const subjectTitles = new Map<string, string>();
  /** Загружено ли «показывать выполненные» из `ui_state`. */
  let settingsLoaded = false;

  const panel = mountTaskPanel(host, {
    refresh: () => void loadPanel(),
    undo: () => void undoBulk(),
    setShowDone: (next) => {
      if (next === showDone) return;
      showDone = next;
      persistSettings();
      renderView();
    },
    toggle: (row, done) => void toggleTask(row, done),
    loadRawLine: (row) => loadRawLine(row),
    editLine: (row, text) => saveLine(row, text),
    rowCommand: (row, command, shift) => void runRowCommand(row, command, shift),
    bulk: (filter, command, shift) => void runBulk(filter, command, shift),
    reminderAction: (row, action, until) => void runReminderAction(row, action, until),
    pickDate: (initial) => pickDate(initial),
    pickDateTime: (initialIso) => pickDateTime(initialIso),
    openDay: (day) => deps.openDay(day),
    renderText: (node, row) => renderRowText(node, row),
  });

  /** Прочитать настройку показа выполненных (L4 `ui_state`). */
  async function loadSettings(): Promise<void> {
    try {
      const raw = await etn.ui.getState(requireNetworkId(), UI_STATE_KEY.DIARY_TASKS_PANEL);
      if (disposed) return;
      if (raw !== null && raw !== '') {
        const parsed = JSON.parse(raw) as Partial<TasksPanelSettings>;
        showDone = parsed.showDone === true;
      }
    } catch {
      // Настройки нет или она повреждена — дефолт (выполненные скрыты).
    } finally {
      settingsLoaded = true;
      renderView();
    }
  }

  /** Сохранить настройку показа выполненных. */
  function persistSettings(): void {
    if (!settingsLoaded) return;
    void etn.ui
      .setState(
        requireNetworkId(),
        UI_STATE_KEY.DIARY_TASKS_PANEL,
        JSON.stringify({ showDone } satisfies TasksPanelSettings),
      )
      .catch(() => undefined);
  }

  /** Окно раскрытия напоминаний: период ленты, «сегодня» и запас просрочки. */
  function reminderWindow(): { from: string; to: string } {
    const period = effectivePeriod();
    const today = todayLocal();
    const fromDay = period.from <= today ? period.from : today;
    const toDay = period.to >= today ? period.to : today;
    return {
      from: localDayStart(shiftDay(fromDay, -REMINDERS_OVERDUE_DAYS)),
      to: localDayEnd(toDay),
    };
  }

  /**
   * Период ленты для запросов: невалидный/пустой период (например, до входа в
   * сеть) заменяется сегодняшним днём — панель не ломается на переходном виде.
   */
  function effectivePeriod(): { from: string; to: string } {
    const period = deps.getPeriod();
    const today = todayLocal();
    const from = isValidLocalDay(period.from) ? period.from : today;
    const to = isValidLocalDay(period.to) ? period.to : today;
    return from <= to ? { from, to } : { from: to, to: from };
  }

  /** Перечитать панель целиком (ручное «Обновить» и смена периода). */
  async function loadPanel(): Promise<void> {
    const networkId = requireNetworkId();
    const period = effectivePeriod();
    const today = todayLocal();
    const window = reminderWindow();
    const seq = ++loadSeq;
    loading = true;
    renderView();
    try {
      const [periodPage, overduePage, undatedPage, donePage, reminderResult] = await Promise.all([
        etn.tasks.list(networkId, {
          scope: 'open',
          from: period.from,
          to: period.to,
          today,
          limit: TASKS_PAGE_LIMIT,
          count: true,
        }),
        etn.tasks.list(networkId, {
          scope: 'overdue',
          today,
          limit: TASKS_PAGE_LIMIT,
          count: true,
        }),
        etn.tasks.list(networkId, {
          scope: 'undated',
          today,
          limit: TASKS_PAGE_LIMIT,
          count: true,
        }),
        etn.tasks.list(networkId, {
          scope: 'done',
          from: period.from,
          to: period.to,
          today,
          limit: TASKS_PAGE_LIMIT,
          count: true,
        }),
        etn.reminders.list(networkId, { from: window.from, to: window.to }),
      ]);
      if (disposed || seq !== loadSeq) return;
      state = {
        period: periodPage.items,
        overdue: overduePage.items,
        undated: undatedPage.items,
        done: donePage.items,
        doneTotal: donePage.total ?? donePage.items.length,
        reminders: reminderResult,
        maxRevision: Math.max(
          periodPage.max_revision,
          overduePage.max_revision,
          undatedPage.max_revision,
          donePage.max_revision,
        ),
      };
      staleComments = new Set<string>();
      remindersChanged = false;
      markerAdvanced = false;
      loadError = null;
      await resolveSubjects(seq);
    } catch (err) {
      if (disposed || seq !== loadSeq) return;
      loadError = errText(err);
    } finally {
      if (!disposed && seq === loadSeq) {
        loading = false;
        renderView();
      }
    }
  }

  /** Доразрешить названия субъектов задач и напоминаний (кэш на сессию панели). */
  async function resolveSubjects(seq: number): Promise<void> {
    const networkId = requireNetworkId();
    const ids = new Set<string>();
    for (const row of [...state.period, ...state.overdue, ...state.undated, ...state.done]) {
      for (const id of row.subject_thoughts) ids.add(id);
    }
    const publicationIds = new Set<string>();
    for (const reminder of state.reminders.reminders) {
      if (reminder.subject_type === 'thought') ids.add(reminder.subject_id);
      else publicationIds.add(reminder.subject_id);
    }
    const missingThoughts = [...ids].filter((id) => !subjectTitles.has(`thought:${id}`));
    const missingPublications = [...publicationIds].filter(
      (id) => !subjectTitles.has(`publication:${id}`),
    );
    await Promise.allSettled([
      ...missingThoughts.map(async (id) => {
        const thought = await etn.thoughts.get(networkId, id);
        subjectTitles.set(`thought:${id}`, thought.title);
      }),
      ...missingPublications.map(async (id) => {
        const publication = await etn.publications.get(networkId, id);
        subjectTitles.set(`publication:${id}`, publication.title);
      }),
    ]);
    if (seq === loadSeq) renderView();
  }

  /** Название субъекта строки (мысль/публикация) с фолбэком на id. */
  function subjectTitle(kind: 'thought' | 'publication', id: string): string {
    return subjectTitles.get(`${kind}:${id}`) ?? id;
  }

  /** Заголовок группы по режиму и диапазону (локализованный). */
  function groupTitle(group: PanelGroup<TaskPanelRow | ReminderPanelRow>): string {
    if (group.kind === 'thoughts') {
      if (group.subjectId === null) return t('tasks.groupNoThought');
      return subjectTitle('thought', group.subjectId);
    }
    if (group.from === null || group.to === null) return t('tasks.groupNoDate');
    if (group.kind === 'dates') return formatDayLabel(group.from);
    if (group.kind === 'weeks') {
      return t('tasks.weekRange', [formatDayLabel(group.from), formatDayLabel(group.to)]);
    }
    return monthLabel(group.from);
  }

  /** Заголовок месяца: месяц и год без «г.» (тот же приём, что у дней ленты). */
  function monthLabel(day: string): string {
    const parts = formatDateParts(new Date(`${day}T00:00:00`), {
      year: 'numeric',
      month: 'long',
    });
    while (parts.length > 1 && parts[parts.length - 1]?.type === 'literal') parts.pop();
    const text = parts
      .map((part) => part.value)
      .join('')
      .trim();
    if (text === '') return day;
    return text.charAt(0).toLocaleUpperCase(getLang()) + text.slice(1);
  }

  /** Фильтр массовой команды группы: адресация проекцией (требование e6af8b9e). */
  function groupFilter(
    group: PanelGroup<TaskPanelRow | ReminderPanelRow>,
    scope: TaskScope,
  ): TaskMassFilter {
    const filter: TaskMassFilter = { scope, today: todayLocal() };
    if (group.kind === 'thoughts') {
      if (group.subjectId !== null) filter.thought_id = group.subjectId;
    } else if (group.from !== null && group.to !== null) {
      filter.from = group.from;
      filter.to = group.to;
    }
    return filter;
  }

  /** Секция задач: строки → группы порогов → подгруппы вида. */
  function taskSection(
    key: string,
    title: string,
    rows: TaskDTO[],
    scope: TaskScope,
  ): TaskPanelSectionView {
    const views = rows.map((row) => taskRowView(row, staleComments));
    const mode = taskGroupingMode(views.length);
    const groups = groupPanelRows(views, mode, { firstDayOfWeek: firstDayOfWeek() });
    return {
      key,
      title,
      subgroups: groups.map((group) => ({
        key: group.key,
        title: groupTitle(group),
        kind: group.kind,
        filter: groupFilter(group, scope),
        rows: group.rows,
      })),
    };
  }

  /** Секция напоминаний: вхождения → группы порогов → подгруппы вида. */
  function reminderSection(
    key: ReminderPanelSectionView['key'],
    title: string,
    rows: ReminderPanelRow[],
  ): ReminderPanelSectionView {
    const mode = taskGroupingMode(rows.length);
    const groups = groupPanelRows(rows, mode, { firstDayOfWeek: firstDayOfWeek() });
    return {
      key,
      title,
      subgroups: groups.map((group) => ({
        key: group.key,
        title:
          group.kind === 'thoughts'
            ? subjectTitle('thought', group.subjectId ?? '')
            : groupTitle(group),
        kind: group.kind,
        filter: {},
        rows: group.rows,
      })),
    };
  }

  /** Первый день недели сети (ISO 1 = пн … 7 = вс, требование 1b77decd). */
  function firstDayOfWeek(): number {
    const value = store.state.network?.first_day_of_week;
    return typeof value === 'number' && value >= 1 && value <= 7 ? value : 1;
  }

  /** Подпись повтора напоминания (закрытая грамматика bbca8f7d). */
  function repeatLabel(reminder: Reminder): string {
    const schedule = reminder.schedule;
    switch (schedule.type) {
      case 'once':
        return t('tasks.repeatOnce');
      case 'weekdays':
        return t('tasks.repeatWeekdays');
      case 'every_days':
        return t('tasks.repeatEveryDays', [schedule.every]);
      case 'weekday_of_month':
        return t('tasks.repeatWeekdayOfMonth');
      case 'day_of_month':
        return t('tasks.repeatDayOfMonth', [schedule.day, schedule.every_months]);
      case 'yearly':
        return t('tasks.repeatYearly', [schedule.day, schedule.month]);
      case 'last_day_of_month':
        return t('tasks.repeatLastDayOfMonth', [schedule.every_months]);
      default:
        return '';
    }
  }

  /** Собрать снимок панели и отрисовать его. */
  function renderView(): void {
    if (disposed) return;
    const taskRows = [...state.period, ...state.overdue, ...state.undated, ...state.done];
    const counters = taskCounters(taskRows);
    const stale = panelNeedsRefresh({
      rows: taskRows,
      staleComments,
      remindersChanged,
      markerAdvanced,
    });

    const reminderRows = reminderPanelRows(state.reminders, subjectTitles, repeatLabel);
    const todayStart = Date.parse(localDayStart(todayLocal()));
    const todayEnd = Date.parse(localDayEnd(todayLocal()));
    const buckets: Record<'overdue' | 'today' | 'period', ReminderPanelRow[]> = {
      overdue: [],
      today: [],
      period: [],
    };
    for (const row of reminderRows) {
      buckets[reminderSectionOf(row, todayStart, todayEnd)].push(row);
    }

    const sections: ReminderPanelSectionView[] = [];
    if (buckets.overdue.length > 0) {
      sections.push(reminderSection('overdue', t('tasks.remindersOverdue'), buckets.overdue));
    }
    if (buckets.today.length > 0) {
      sections.push(reminderSection('today', t('tasks.remindersToday'), buckets.today));
    }
    if (buckets.period.length > 0) {
      sections.push(reminderSection('period', t('tasks.remindersPeriod'), buckets.period));
    }

    const period = effectivePeriod();
    const view: TaskPanelView = {
      stale,
      // «За период» адресуется теми же границами, что показаны лентой; без
      // from/to сервер взял бы всю сеть (блокер приёмки 64f7976a).
      periodFilter: {
        scope: 'open',
        from: period.from,
        to: period.to,
        today: todayLocal(),
      },
      canUndo: undoSnapshot !== null,
      showDone,
      counters,
      reminderCount: reminderRows.length,
      taskSections: [
        taskSection(
          'period',
          t('tasks.sectionMain'),
          [...state.period, ...(showDone ? state.done : [])],
          'open',
        ),
        ...(state.overdue.length > 0
          ? [taskSection('overdue', t('tasks.sectionOverdue'), state.overdue, 'overdue')]
          : []),
        ...(state.undated.length > 0
          ? [taskSection('undated', t('tasks.sectionUndated'), state.undated, 'undated')]
          : []),
      ],
      reminderSections: sections,
      loading,
      error: loadError,
    };
    panel.render(view);
  }

  /** Ревизия источника строки — для `expected_revision` операций. */
  function revisionOf(row: TaskPanelRow): number {
    const all = [...state.period, ...state.overdue, ...state.undated, ...state.done];
    const ref = all.find(
      (item) => item.comment_id === row.commentId && item.line_no === row.lineNo,
    );
    return ref?.revision ?? 1;
  }

  /**
   * Абсолютная дата «перенести на…» → серверный сдвиг в днях. Сервер знает
   * только `days`/`months` (de4cee18), поэтому дата переводится в разницу от
   * якоря строки: срок (или начало периода) встаёт на выбранную дату, период
   * строки сохраняется. `null` — дата та же самая (двигать нечего).
   */
  function shiftToDate(anchor: string, target: string): TaskShift | null {
    const days = calendarDaysBetween(anchor, target);
    if (!Number.isFinite(days) || days === 0) return null;
    return { days };
  }

  /** Диалог «Дата» (общий контрол периода, ADR d4d53fe6); `null` — отмена. */
  async function pickDate(initial: string): Promise<string | null> {
    const day = isValidLocalDay(initial) ? initial : todayLocal();
    const value = await openDatePeriodDialog({
      allowPeriod: false,
      allowTime: false,
      title: t('tasks.pickDateTitle'),
      initial: { mode: 'date', from: day, to: day },
    });
    return value === null ? null : value.from;
  }

  /** Диалог даты и времени отложенного вхождения; `null` — отмена. */
  async function pickDateTime(initialIso: string): Promise<string | null> {
    const previous = { from: initialIso, to: initialIso };
    const value = await openDatePeriodDialog({
      allowPeriod: false,
      allowTime: true,
      title: t('tasks.snoozeDateTimeTitle'),
      initial: datePeriodValueFromInstants(initialIso, initialIso, true, true),
    });
    if (value === null) return null;
    return resolveDatePeriodInstants(value, previous).from;
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
      // подсвечена — состав секций пересоберёт только явное нажатие (0e85b66e).
      staleComments.add(row.commentId);
      renderView();
    } catch (err) {
      staleComments.add(row.commentId);
      renderView();
      notice(t('tasks.errorToggle', [errText(err)]), 'error');
    }
  }

  /**
   * Сырая строка `body_md` для инлайн-правки. Компонент показывает снапшот без
   * маркера (`TaskDTO.text`), поэтому править его нельзя — читаем источник и
   * отдаём строку целиком, с `- [ ] ` / `- [x] `.
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
      renderView();
      return true;
    } catch (err) {
      notice(t('tasks.errorEdit', [errText(err)]), 'error');
      return false;
    }
  }

  /** Команда строки: открыть источник / перенести даты / отменить задачу. */
  async function runRowCommand(
    row: TaskPanelRow,
    command: TaskRowCommand,
    shift?: TaskShift,
  ): Promise<void> {
    if (command === 'open-source') {
      const day = row.due ?? row.periodFrom;
      if (day !== null) deps.openDay(day);
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
      if (resolved === null) return;
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
      renderView();
    } catch (err) {
      notice(t('tasks.errorRowCommand', [errText(err)]), 'error');
    }
  }

  /** Массовая команда группы: подтверждение со сводкой → команда → undo. */
  async function runBulk(
    filter: TaskMassFilter,
    command: 'cancel-all' | 'move-all',
    shift?: TaskShift,
  ): Promise<void> {
    const networkId = requireNetworkId();
    // Подтверждение считает СТРОКИ, а сервер адресует записи: одна правка
    // `body_md` на запись, но задач в записи может быть несколько (e6af8b9e).
    const plan = planTaskBulk([...state.period, ...state.overdue, ...state.undated], filter);
    if (plan.rows.length === 0) {
      notice(t('tasks.bulkEmpty'), 'info');
      return;
    }
    let effectiveShift = shift;
    if (command === 'move-all' && shift?.date !== undefined) {
      // Массовый перенос — единый сдвиг от «сегодня» (периоды строк
      // сохраняются); выбранная дата задаёт величину сдвига.
      const resolved = shiftToDate(todayLocal(), shift.date);
      if (resolved === null) return;
      effectiveShift = resolved;
    }
    const confirmed = await confirmDialog(
      t('tasks.bulkTitle'),
      t(command === 'cancel-all' ? 'tasks.bulkCancelQuestion' : 'tasks.bulkMoveQuestion', [
        plan.rows.length,
      ]),
      command === 'cancel-all',
    );
    if (!confirmed) return;
    try {
      // Прежние тексты — для отмены команды (undo): правки идут в записях-
      // источниках, поэтому откат — восстановление `body_md` с новой ревизией.
      const snapshot = await Promise.all(
        plan.commentIds.map((id) => etn.comments.get(networkId, id)),
      );
      undoSnapshot = snapshot.map((comment) => ({
        id: comment.id,
        body_md: comment.body_md,
        version: comment.version,
      }));
      const result = await etn.tasks.patch(networkId, {
        action: command,
        filter,
        ...(effectiveShift !== undefined ? effectiveShift : {}),
      });
      const failed = result.results.filter((item) => !item.ok);
      if (failed.length > 0) {
        notice(t('tasks.bulkPartial', [failed.length]), 'warning');
      }
      await loadPanel();
      deps.onRecordsChanged();
    } catch (err) {
      undoSnapshot = null;
      notice(t('tasks.bulkFailed', [errText(err)]), 'error');
    }
  }

  /** Отмена последней массовой команды: возврат прежних текстов записей. */
  async function undoBulk(): Promise<void> {
    if (undoSnapshot === null) return;
    const networkId = requireNetworkId();
    const snapshot = undoSnapshot;
    undoSnapshot = null;
    try {
      for (const entry of snapshot) {
        const current = await etn.comments.get(networkId, entry.id);
        if (current.body_md === entry.body_md) continue;
        await etn.comments.update(networkId, entry.id, { body_md: entry.body_md }, current.version);
      }
      await loadPanel();
      deps.onRecordsChanged();
    } catch (err) {
      notice(t('tasks.undoFailed', [errText(err)]), 'error');
    }
  }

  /** Действие над вхождением напоминания. */
  async function runReminderAction(
    row: ReminderPanelRow,
    action: ReminderRowAction,
    until?: string,
  ): Promise<void> {
    const networkId = requireNetworkId();
    try {
      if (action === 'open-subject') {
        if (row.subjectType === 'thought') {
          const { openThoughtInEditor } = await import('../../editor/editor.js');
          openThoughtInEditor(row.subjectId);
        } else {
          // Ленивый импорт: статический замкнул бы цикл
          // active-view → chronicle → tasks-panel (см. открытие вида).
          const { openPublicationInWorkspace } = await import('../active-view.js');
          await openPublicationInWorkspace(row.subjectId);
        }
        return;
      }
      if (action === 'dismiss') {
        await etn.reminders.dismiss(networkId, row.reminderId);
      } else if (action === 'snooze') {
        if (until === undefined) return;
        await etn.reminders.snooze(networkId, row.reminderId, until);
      } else {
        await createTaskForToday(row);
        return;
      }
      await loadPanel();
    } catch (err) {
      notice(t('tasks.reminderActionFailed', [errText(err)]), 'error');
    }
  }

  /**
   * «Создать задачу на сегодня» (требование 7fcdf583): строка в СЕГОДНЯШНЕЙ
   * хроно-записи; записи дня нет — она создаётся. Мысль — с ID-ссылкой,
   * публикация — названием без ссылки. Расписание напоминания продолжается.
   */
  async function createTaskForToday(row: ReminderPanelRow): Promise<void> {
    const networkId = requireNetworkId();
    const today = todayLocal();
    const line =
      row.subjectType === 'thought'
        ? `- [ ] [[#${row.subjectId}]] [[${today}]]`
        : `- [ ] ${row.title} [[${today}]]`;
    const home = await import('../../lib/home.js').then((mod) => mod.getHomeId(networkId));
    const comments = await etn.comments.list(networkId, 'thought', home);
    const todayStart = Date.parse(localDayStart(today));
    const todayEnd = Date.parse(localDayEnd(today));
    const record = comments.find((comment) => {
      if (comment.kind !== 'chronological') return false;
      const from = Date.parse(comment.valid_from);
      const to = Date.parse(comment.valid_to ?? comment.valid_from);
      return from <= todayEnd && to >= todayStart;
    });
    if (record !== undefined) {
      const body = record.body_md === '' ? line : `${record.body_md}\n${line}`;
      await etn.comments.update(networkId, record.id, { body_md: body }, record.version);
    } else {
      const now = new Date().toISOString();
      await etn.comments.createMulti(networkId, [{ owner_type: 'thought', owner_id: home }], {
        kind: 'chronological',
        title: null,
        body_md: line,
        valid_from: now,
        valid_to: now,
        use_time: false,
      });
    }
    deps.onRecordsChanged();
    await loadPanel();
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

  /**
   * События слоя: чужая правка источника — серая строка и подсветка
   * «Обновить»; события напоминаний — тоже подсветка (0e85b66e).
   */
  const unsubscribe = onRoutedRealtimeEvent((event) => {
    if (disposed) return;
    if (event.network_id !== store.state.networkId) return;
    if (event.type === 'reminders.changed') {
      remindersChanged = true;
      renderView();
      return;
    }
    if (event.type === 'comment.updated') {
      const data = event.data as { id?: string; version?: unknown };
      // Глобальный маркер проекции: `max_revision` из GET /tasks сравнивается
      // с ревизией события (уточнение e6d65f51 0.16.1). Ушёл вперёд — в сети
      // изменилась запись, панель показывает «Обновить» ещё до загрузки строк.
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
      if (markerAdvanced || staleComments.size > 0) renderView();
      return;
    }
    if (event.type === 'comment.created' || event.type === 'comment.deleted') {
      const id =
        (event.data as { comment?: { id?: string }; id?: string }).comment?.id ??
        (event.data as { id?: string }).id;
      if (id !== undefined && loadedCommentIds().has(id)) {
        staleComments.add(id);
        renderView();
      }
    }
  });

  /** Комментарии-источники, загруженные в панель. */
  function loadedCommentIds(): Set<string> {
    return new Set(
      [...state.period, ...state.overdue, ...state.undated, ...state.done].map(
        (row) => row.comment_id,
      ),
    );
  }

  // Первая загрузка: настройка → данные (порядок важен — переключатель
  // выполненных влияет на состав показываемых строк).
  void loadSettings().then(() => loadPanel());

  return {
    refresh(): void {
      void loadPanel();
    },
    destroy(): void {
      disposed = true;
      unsubscribe();
      panel.destroy();
    },
  };
}

/** Классы строк панели — реэкспорт для тестов экрана и стенда. */
export const TASKS_PANEL_ROW_CLASSES = {
  task: TASK_PANEL_ROW_CLASS,
  reminder: REMINDER_PANEL_ROW_CLASS,
} as const;

/** Ключ строки задачи — реэкспорт адреса проекции для тестов. */
export { taskRowKey };
