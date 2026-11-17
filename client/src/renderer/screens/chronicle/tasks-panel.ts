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
 *  • держит «устарело»: правка ИЗ панели красит ТОЛЬКО свою строку (адрес
 *    `comment_id`+`line_no`), внешнее событие слоя — всю запись (номера строки
 *    в событии нет), эхо собственной правки не красит ничего; состав секций
 *    пересобирает «Обновить» (0e85b66e, ошибки d318a647/45480290);
 *  • после инлайн-правки перечитывает строки ОДНОЙ записи: новый текст виден
 *    сразу, «Обновить» для этого не нужна (ошибка 45480290).
 *
 * Состояние переключателя «показывать выполненные» и карта свёрнутых блоков
 * панели — L4 `ui_state` (`UI_STATE_KEY.DIARY_TASKS_PANEL`), как прочие
 * механики «Дневника» (сворачивание — ошибка d0801eea).
 *
 * События читаются через `onRoutedRealtimeEvent` (санкционированный канал
 * побочных эффектов реактивного слоя): ключа запроса здесь нет намеренно —
 * перечитывание обязано быть РУЧНЫМ («Обновить»), иначе серая строка исчезала
 * бы сама до нажатия пользователя.
 */

import {
  UI_STATE_KEY,
  type Comment,
  type Reminder,
  type ReminderListResult,
  type TaskDTO,
  type TaskMassAction,
  type TaskMassFilter,
  type TaskNestedLine,
  type TaskOpAction,
  type TaskScope,
} from '@etn/shared';

import { requireNetworkId } from '../../app.js';
import { renderMarkdownWithWikiLinks } from '../../editor/wiki-link-resolver.js';
import { confirmDialog } from '../../lib/dialog.js';
import {
  datePeriodValueFromInstants,
  openDatePeriodDialog,
  resolveDatePeriodInstants,
} from '../../lib/date-period-dialog.js';
import { errText } from '../../lib/dom.js';
import { etn } from '../../lib/etn.js';
import { formatDateParts, getLang, t } from '../../lib/i18n.js';
import { onRoutedRealtimeEvent } from '../../lib/live/event-router.js';
import { notice } from '../../lib/notice.js';
import {
  createPublicationCloud,
  type PublicationCloudInput,
} from '../../lib/ui/publication-cloud.js';
import { createThoughtCloud, type ThoughtCloudInput } from '../../lib/thought-cloud.js';
import { openReminderEditor } from '../../lib/reminder-editor.js';
import { store } from '../../state.js';
import {
  REMINDER_PANEL_ROW_CLASS,
  TASK_PANEL_COLLAPSE_KEYS,
  TASK_PANEL_ROW_CLASS,
  mountTaskPanel,
  type ReminderPanelSectionView,
  type ReminderRowAction,
  type TaskPanelSectionView,
  type TaskPanelSubject,
  type TaskPanelView,
  type TaskRowCommand,
  type TaskShift,
} from '../../lib/ui/task-panel.js';
import {
  REMINDERS_OVERDUE_DAYS,
  calendarDaysBetween,
  flatReminderRows,
  groupPanelRows,
  nestedLinesByParent,
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
  taskRowsForFilter,
  type PanelGroup,
  type ReminderPanelRow,
  type TaskPanelChildRow,
  type TaskPanelRow,
  type TaskPanelStaleness,
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
  /**
   * Панель свёрнута/развёрнута штатной кареткой: «Дневник» прячет слайдер
   * высоты, доступный только развёрнутой панели (пункт B ТЗ 2026-11-17).
   */
  onPanelCollapsed?(collapsed: boolean): void;
}

/** Дескриптор панели для экрана. */
export interface TasksPanelHandle {
  /** Перечитать панель (смена периода/отбора, показ вида). */
  refresh(): void;
  /** Снять подписки и размонтировать компоненту. */
  destroy(): void;
  /**
   * Панель свёрнута штатной кареткой: слайдер высоты прячется (пункт B ТЗ
   * 2026-11-17 — высота доступна только развёрнутой панели).
   */
  panelCollapsed(): boolean;
  /** Высота панели из `ui_state`, `null` — высота по умолчанию. */
  panelHeight(): number | null;
  /** Запомнить высоту панели (слайдер) и применить её сразу. */
  setPanelHeight(height: number): void;
}

/** Предел строк на один запрос списка задач (сервер: `TASKS_MAX_LIMIT`). */
const TASKS_PAGE_LIMIT = 200;

/** Границы высоты панели, px: ниже — нечитаемо, выше — не оставляет ленты. */
export const TASKS_PANEL_H_MIN = 120;
export const TASKS_PANEL_H_MAX = 900;
/** Минимум места для ленты при перетаскивании слайдера, px. */
export const TASKS_PANEL_FEED_MIN = 160;
/** Задержка записи настроек панели после драга слайдера, мс. */
const PERSIST_DEBOUNCE_MS = 400;

/** Локальная настройка панели в `ui_state`. */
interface TasksPanelSettings {
  showDone: boolean;
  /**
   * Свёрнутость блоков панели: ключ → свёрнут (ошибка d0801eea). Карта, а не
   * поля под каждый блок: новый блок не требует правки формата.
   */
  collapsed?: Record<string, boolean>;
  /** Высота панели, px (пункт B ТЗ 2026-11-17). Не задана — по умолчанию. */
  height?: number;
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
  /** Вложенные не-задачные строки страниц (`include_nested`, пункт F ТЗ). */
  nested: TaskNestedLine[];
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
    nested: [],
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
  /** Свёрнутые блоки панели: ключ → свёрнут (ошибка d0801eea). */
  let collapsed: Record<string, boolean> = {};
  /**
   * Строки, изменённые ИЗ ПАНЕЛИ (`comment_id:line_no`): серая только эта
   * строка, остальные строки записи остаются рабочими (ошибка d318a647).
   */
  let staleRows = new Set<string>();
  /** Записи, изменённые ВНЕ панели: событие слоя не знает номера строки. */
  let staleComments = new Set<string>();
  /**
   * Показанное состояние чекбоксов строк, переключённых из панели: снапшот
   * `state` до «Обновить» не перечитывается, а галочка обязана отвечать на
   * повторный клик (ошибка d318a647).
   */
  const toggledDone = new Map<string, boolean>();
  /**
   * Последние известные ревизии комментариев-источников. Своя правка строки
   * поднимает ревизию ВСЕЙ записи: остальные строки той же записи должны слать
   * новое `expected_revision`, иначе сервер ответит 409 (ошибка d318a647).
   */
  const commentVersions = new Map<string, number>();
  let remindersChanged = false;
  /** Глобальный маркер `max_revision` ушёл вперёд после загрузки (0e85b66e). */
  let markerAdvanced = false;
  let loadSeq = 0;
  /** Снимок текстов для отмены массовой команды (требование e6af8b9e). */
  let undoSnapshot: Array<{ id: string; body_md: string; version: number }> | null = null;
  /**
   * Кэш субъектов строк: снапшот мысли/публикации для облачка и названий
   * (пункты C и E ТЗ 2026-11-17). Ключ — `<вид>:<id>`, как в раскладке строк.
   */
  const subjectData = new Map<string, ThoughtCloudInput | PublicationCloudInput>();
  /** Загружены ли настройки панели из `ui_state`. */
  let settingsLoaded = false;
  /** Высота панели из `ui_state` (пункт B ТЗ 2026-11-17), `null` — по умолчанию. */
  let panelHeightValue: number | null = null;
  /** Таймер отложенной записи настроек: слайдер пишет их на каждом тике драга. */
  let persistTimer: number | null = null;

  const panel = mountTaskPanel(host, {
    refresh: () => void loadPanel(),
    undo: () => void undoBulk(),
    setShowDone: (next) => {
      if (next === showDone) return;
      showDone = next;
      persistSettings();
      renderView();
    },
    collapsedOf: (key) => collapsed[key],
    setCollapsed: (key, value) => {
      collapsed = { ...collapsed, [key]: value };
      persistSettings();
      // Свёрнутость всей панели ведёт доступность слайдера высоты (пункт B).
      if (key === TASK_PANEL_COLLAPSE_KEYS.panel) deps.onPanelCollapsed?.(value);
    },
    toggle: (row, done) => void toggleTask(row, done),
    loadRawLine: (row) => loadRawLine(row),
    editLine: (row, text) => saveLine(row, text),
    rowCommand: (row, command, shift) => void runRowCommand(row, command, shift),
    bulk: (filter, command, shift) => void runBulk(filter, command, shift),
    reminderAction: (row, action, until) => void runReminderAction(row, action, until),
    reminderGroupDismiss: (title, rows) => void runReminderGroupDismiss(title, rows),
    pickDate: (initial) => pickDate(initial),
    pickDateTime: (initialIso) => pickDateTime(initialIso),
    openDay: (day) => deps.openDay(day),
    renderText: (node, row) => renderRowText(node, row),
    renderSubject: (node, subject) => renderSubject(node, subject),
    panelHeight: () => panelHeightValue,
    setPanelHeight: (height) => {
      panelHeightValue = height;
      // Драг зовёт `setPanelHeight` на каждом тике: пишем `ui_state` отложенно.
      schedulePersist();
    },
  });

  /** Прочитать настройки панели (L4 `ui_state`). */
  async function loadSettings(): Promise<void> {
    try {
      const raw = await etn.ui.getState(requireNetworkId(), UI_STATE_KEY.DIARY_TASKS_PANEL);
      if (disposed) return;
      if (raw !== null && raw !== '') {
        const parsed = JSON.parse(raw) as Partial<TasksPanelSettings>;
        showDone = parsed.showDone === true;
        const saved = parsed.collapsed;
        if (saved !== undefined && saved !== null && typeof saved === 'object') {
          collapsed = { ...saved };
        }
        // Высота панели (пункт B ТЗ 2026-11-17): только положительное число в
        // допустимых границах, иначе — высота по умолчанию.
        const height = parsed.height;
        if (typeof height === 'number' && Number.isFinite(height)) {
          panelHeightValue = Math.min(TASKS_PANEL_H_MAX, Math.max(TASKS_PANEL_H_MIN, height));
        }
      }
    } catch {
      // Настройки нет или она повреждена — дефолт (выполненные скрыты, блоки развёрнуты).
    } finally {
      settingsLoaded = true;
      // Стартовая свёрнутость панели (из `ui_state`) — сразу же решает, виден
      // ли слайдер высоты (пункт B ТЗ 2026-11-17).
      deps.onPanelCollapsed?.(collapsed[TASK_PANEL_COLLAPSE_KEYS.panel] === true);
      renderView();
    }
  }

  /** Сохранить настройки панели. */
  function persistSettings(): void {
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (!settingsLoaded) return;
    const payload: TasksPanelSettings = { showDone, collapsed };
    if (panelHeightValue !== null) payload.height = panelHeightValue;
    void etn.ui
      .setState(requireNetworkId(), UI_STATE_KEY.DIARY_TASKS_PANEL, JSON.stringify(payload))
      .catch(() => undefined);
  }

  /**
   * Отложенная запись настроек: драг слайдера высоты даёт десятки вызовов в
   * секунду, а `ui_state` — запись в БД. Переключатели панели пишутся сразу
   * ({@link persistSettings}), слайдер — через этот таймер.
   */
  function schedulePersist(): void {
    if (persistTimer !== null) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      persistTimer = null;
      persistSettings();
    }, PERSIST_DEBOUNCE_MS);
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
          include_nested: true,
        }),
        etn.tasks.list(networkId, {
          scope: 'overdue',
          today,
          limit: TASKS_PAGE_LIMIT,
          count: true,
          include_nested: true,
        }),
        etn.tasks.list(networkId, {
          scope: 'undated',
          today,
          limit: TASKS_PAGE_LIMIT,
          count: true,
          include_nested: true,
        }),
        etn.tasks.list(networkId, {
          scope: 'done',
          from: period.from,
          to: period.to,
          today,
          limit: TASKS_PAGE_LIMIT,
          count: true,
          include_nested: true,
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
        nested: [
          ...(periodPage.nested ?? []),
          ...(overduePage.nested ?? []),
          ...(undatedPage.nested ?? []),
          ...(donePage.nested ?? []),
        ],
      };
      staleRows = new Set<string>();
      staleComments = new Set<string>();
      toggledDone.clear();
      commentVersions.clear();
      for (const row of [...state.period, ...state.overdue, ...state.undated, ...state.done]) {
        rememberVersion(row.comment_id, row.revision);
      }
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

  /**
   * Доразрешить субъектов задач и напоминаний: снапшоты мыслей и публикаций
   * (кэш на сессию панели) — из них берутся названия групп и облачка строк.
   */
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
    const missingThoughts = [...ids].filter((id) => !subjectData.has(`thought:${id}`));
    const missingPublications = [...publicationIds].filter(
      (id) => !subjectData.has(`publication:${id}`),
    );
    await Promise.allSettled([
      ...missingThoughts.map(async (id) => {
        subjectData.set(`thought:${id}`, await etn.thoughts.get(networkId, id));
      }),
      ...missingPublications.map(async (id) => {
        const publication = await etn.publications.get(networkId, id);
        subjectData.set(`publication:${id}`, { id: publication.id, title: publication.title });
      }),
    ]);
    if (seq === loadSeq) renderView();
  }

  /** Название субъекта строки (мысль/публикация) с фолбэком на id. */
  function subjectTitle(kind: 'thought' | 'publication', id: string): string {
    return subjectData.get(`${kind}:${id}`)?.title ?? id;
  }

  /**
   * Заголовок группы по режиму и диапазону (локализованный). Вид субъекта —
   * параметр: режим «по мыслям» группирует строки и мыслей, и публикаций, а
   * ключ названия у видов разный (`thought:<id>` / `publication:<id>`), поэтому
   * жёсткий 'thought' показывал GUID публикации (блокер репроверки 64f7976a).
   */
  function groupTitle(
    group: PanelGroup<TaskPanelRow | ReminderPanelRow>,
    subjectKind: 'thought' | 'publication' = 'thought',
  ): string {
    if (group.kind === 'thoughts') {
      if (group.subjectId === null) return t('tasks.groupNoThought');
      return subjectTitle(subjectKind, group.subjectId);
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

  /**
   * Оформление заголовка подгруппы (пункт E ТЗ 2026-11-17): группа-мысль —
   * облачко мысли/публикации с иконкой, группа-дата (дни, недели, месяцы) —
   * иконка календарика перед названием.
   */
  function subgroupDecoration(
    group: PanelGroup<TaskPanelRow | ReminderPanelRow>,
    subjectKind: 'thought' | 'publication',
  ): { subject?: TaskPanelSubject | null; icon?: 'calendar' } {
    if (group.kind === 'thoughts') {
      if (group.subjectId === null) return {};
      return {
        subject: {
          kind: subjectKind,
          id: group.subjectId,
          title: subjectTitle(subjectKind, group.subjectId),
        },
      };
    }
    return { icon: 'calendar' };
  }

  /**
   * Облачко субъекта (пункт C ТЗ 2026-11-17): строки напоминаний и заголовки
   * групп-мыслей. Мысль — эталонное облачко `lib/thought-cloud` в профиле чипа
   * поля свойств; публикация — облачко публикации `lib/ui`. Панель фабрик не
   * знает: экран рисует по данным `renderSubject`.
   */
  function renderSubject(host: HTMLElement, subject: TaskPanelSubject): void {
    if (subject.kind === 'publication') {
      host.append(
        createPublicationCloud({ id: subject.id, title: subject.title }, { width: 'container' }),
      );
      return;
    }
    const data = subjectData.get(`${subject.kind}:${subject.id}`);
    const input: ThoughtCloudInput = data ?? { id: subject.id, title: subject.title };
    host.append(createThoughtCloud(input, { profile: 'chip', width: 'container' }));
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

  /**
   * Секция задач: строки → группы порогов → подгруппы вида. «Без срока» —
   * ПЛОСКАЯ секция: все её строки без дат, и вложенная группа «Без даты»
   * повторяла бы заголовок секции (ошибка f517d83a). Сворачивается такая
   * секция как обычная, счётчик строк — в её шапке.
   */
  function taskSection(
    key: string,
    title: string,
    rows: TaskDTO[],
    scope: TaskScope,
    children: ReadonlyMap<string, readonly TaskPanelChildRow[]>,
  ): TaskPanelSectionView {
    const today = todayLocal();
    const views = rows.map((row) => {
      const address = taskRowKey(row);
      return taskRowView(row, staleness(), toggledDone.get(address), {
        today,
        children: children.get(address) ?? [],
      });
    });
    if (scope === 'undated') {
      return { key, title, flat: true, subgroups: [], rows: views };
    }
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
        ...subgroupDecoration(group, 'thought'),
      })),
    };
  }

  /** Секция напоминаний: вхождения → группы порогов → подгруппы вида. */
  function reminderSection(
    key: ReminderPanelSectionView['key'],
    title: string,
    rows: ReminderPanelRow[],
  ): ReminderPanelSectionView {
    // Пункт D ТЗ 2026-11-17: при ОДНОЙ выбранной дате периода напоминания
    // показываются плоским хронологическим списком — без групп по датам/мыслям.
    if (effectivePeriod().from === effectivePeriod().to) {
      return { key, title, flat: true, subgroups: [], rows: flatReminderRows(rows) };
    }
    const mode = taskGroupingMode(rows.length);
    const groups = groupPanelRows(rows, mode, { firstDayOfWeek: firstDayOfWeek() });
    return {
      key,
      title,
      subgroups: groups.map((group) => {
        // Вид субъекта берём у СТРОК группы, а не угадываем: в группе «по
        // мыслям» лежат и мысли, и публикации (строки уже несут `subjectType`).
        const subjectKind = group.rows[0]?.subjectType ?? 'thought';
        return {
          key: group.key,
          title: groupTitle(group, subjectKind),
          kind: group.kind,
          filter: {},
          rows: group.rows,
          ...subgroupDecoration(group, subjectKind),
        };
      }),
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

  /** Признаки устаревания для модели: строки — из панели, записи — снаружи. */
  function staleness(): TaskPanelStaleness {
    return { rows: staleRows, comments: staleComments };
  }

  /** Запомнить ревизию комментария-источника (адрес `expected_revision`). */
  function rememberVersion(commentId: string, version: number): void {
    commentVersions.set(commentId, Math.max(commentVersions.get(commentId) ?? 0, version));
    if (version > state.maxRevision) state.maxRevision = version;
  }

  /**
   * Применить новые ревизии источников после операции: их видят последующие
   * операции и маркер устаревания панели. `revisions` может отсутствовать в
   * ответе (старый сервер/подставной клиент) — тогда просто ничего не помним.
   */
  function applyRevisions(revisions: readonly Comment[] | undefined): void {
    for (const revision of revisions ?? []) rememberVersion(revision.id, revision.version);
  }

  /** Собрать снимок панели и отрисовать его. */
  function renderView(): void {
    if (disposed) return;
    const taskRows = [...state.period, ...state.overdue, ...state.undated, ...state.done];
    const counters = taskCounters(taskRows);
    const stale = panelNeedsRefresh({
      rows: taskRows,
      stale: staleness(),
      remindersChanged,
      markerAdvanced,
    });

    const todayStart = Date.parse(localDayStart(todayLocal()));
    const todayEnd = Date.parse(localDayEnd(todayLocal()));
    /** Названия субъектов напоминаний — ключ `<вид>:<id>` (кэш экрана). */
    const reminderTitles = new Map<string, string>();
    for (const reminder of state.reminders.reminders) {
      reminderTitles.set(
        `${reminder.subject_type}:${reminder.subject_id}`,
        subjectTitle(reminder.subject_type, reminder.subject_id),
      );
    }
    // Просроченные вхождения (момент показа раньше начала местных суток) —
    // признак строки и красная дата (пункт D ТЗ 2026-11-17).
    const reminderRows = reminderPanelRows(
      state.reminders,
      reminderTitles,
      repeatLabel,
      todayStart,
    );
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
    // Вложенные не-задачные строки страниц по адресу родителя (пункт F ТЗ).
    const nestedChildren = nestedLinesByParent(state.nested);
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
          nestedChildren,
        ),
        ...(state.overdue.length > 0
          ? [
              taskSection(
                'overdue',
                t('tasks.sectionOverdue'),
                state.overdue,
                'overdue',
                nestedChildren,
              ),
            ]
          : []),
        ...(state.undated.length > 0
          ? [
              taskSection(
                'undated',
                t('tasks.sectionUndated'),
                state.undated,
                'undated',
                nestedChildren,
              ),
            ]
          : []),
      ],
      reminderSections: sections,
      loading,
      error: loadError,
    };
    panel.render(view);
  }

  /**
   * Ревизия источника строки — для `expected_revision` операций. Сначала
   * известная ревизия комментария (`commentVersions`): правка ОДНОЙ строки
   * поднимает ревизию всей записи, и снапшот соседней строки уже отстал
   * (ошибка d318a647). Снапшот строки — запасной источник.
   */
  function revisionOf(row: TaskPanelRow): number {
    const known = commentVersions.get(row.commentId);
    if (known !== undefined) return known;
    const all = [...state.period, ...state.overdue, ...state.undated, ...state.done];
    const ref = all.find(
      (item) => item.comment_id === row.commentId && item.line_no === row.lineNo,
    );
    return ref?.revision ?? 1;
  }

  /**
   * Абсолютная дата «перенести на…» → серверный сдвиг в днях. Экран считает его
   * только чтобы отличить «дата совпала с якорем» (статус «Перенос не
   * требуется») от настоящего переноса: сам сдвиг считает сервер по операции
   * `set_due`, у которой та же арифметика (`shiftTaskLineDates`).
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
    if (code === 'undate_not_allowed') return t('tasks.errorChronicleUndate');
    return t('tasks.errorGeneric');
  }

  /**
   * Чекбокс: одиночный клик переключает строку источника (без режима правки).
   * Это КОМАНДА, а не правка текста, поэтому серая строка тоже переключается
   * (повторный клик снимает отметку), а серой становится ТОЛЬКО эта строка —
   * остальные строки записи остаются рабочими (ошибка d318a647).
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
      // подсвечена — состав секций пересоберёт только явное нажатие (0e85b66e).
      staleRows.add(address);
      toggledDone.set(address, done);
      renderView();
    } catch (err) {
      staleRows.add(address);
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
      const updated = await etn.comments.update(
        networkId,
        row.commentId,
        { body_md: next },
        comment.version,
      );
      // Сохранённая строка перечитывается ТОЧЕЧНО: панель показывает новый
      // текст сразу и не сереет, остальные строки записи не трогаются
      // (ошибка 45480290).
      await refreshCommentRows(row.commentId, updated.version);
      renderView();
      return true;
    } catch (err) {
      notice(t('tasks.errorEdit', [errText(err)]), 'error');
      return false;
    }
  }

  /**
   * Перечитать строки ОДНОГО комментария-источника (ошибка 45480290): после
   * инлайн-правки снапшот правленой строки обязан обновиться без «Обновить».
   * Строки записи раскладываются по тем же секциям, что и при загрузке: правка
   * могла сменить срок (строка переезжает в «Без срока»/из него) или отметку
   * (задача уходит в выполненные). Неполная страница (запись длиннее предела)
   * раскладывается по прежним местам — пересборка секций ждёт «Обновить».
   */
  async function refreshCommentRows(commentId: string, version: number): Promise<void> {
    const networkId = requireNetworkId();
    rememberVersion(commentId, version);
    const page = await etn.tasks.list(networkId, {
      comment_id: commentId,
      today: todayLocal(),
      limit: TASKS_PAGE_LIMIT,
    });
    const sections: Array<{
      key: 'period' | 'overdue' | 'undated' | 'done';
      filter: TaskMassFilter;
    }> = bucketFilters();
    if (page.cursor !== null) {
      // Неполная выборка: заменяем только прочитанные строки, место строки в
      // секции сохраняем (пересборка по неполным данным потеряла бы строки).
      const fresh = new Map(page.items.map((item) => [taskRowKey(item), item]));
      const next = {
        ...state,
        period: state.period.map((item) => fresh.get(taskRowKey(item)) ?? item),
        overdue: state.overdue.map((item) => fresh.get(taskRowKey(item)) ?? item),
        undated: state.undated.map((item) => fresh.get(taskRowKey(item)) ?? item),
        done: state.done.map((item) => fresh.get(taskRowKey(item)) ?? item),
      };
      state = next;
      return;
    }
    // Полная выборка записи: строки записи уходят из всех секций и встают в те,
    // которым отвечают сейчас.
    const next: TasksPanelState = {
      ...state,
      period: state.period.filter((item) => item.comment_id !== commentId),
      overdue: state.overdue.filter((item) => item.comment_id !== commentId),
      undated: state.undated.filter((item) => item.comment_id !== commentId),
      done: state.done.filter((item) => item.comment_id !== commentId),
    };
    for (const item of page.items) {
      for (const bucket of sections) {
        if (taskRowsForFilter([item], bucket.filter).length > 0) next[bucket.key].push(item);
      }
    }
    state = next;
  }

  /** Фильтры секций панели — те же, что у загрузки (раскладка строки по секциям). */
  function bucketFilters(): Array<{
    key: 'period' | 'overdue' | 'undated' | 'done';
    filter: TaskMassFilter;
  }> {
    const period = effectivePeriod();
    const today = todayLocal();
    return [
      {
        key: 'period',
        filter: { scope: 'open', from: period.from, to: period.to, today },
      },
      { key: 'overdue', filter: { scope: 'overdue', today } },
      { key: 'undated', filter: { scope: 'undated', today } },
      { key: 'done', filter: { scope: 'done', from: period.from, to: period.to, today } },
    ];
  }

  /**
   * Команда строки: открыть источник / перенести даты / сделать бессрочной /
   * отменить задачу. «Перенести на дату» — операция `set_due`: срок задаёт
   * сервер, поэтому она работает и у строки без дат (ошибка 3f9ea2ee).
   */
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
    let action: TaskOpAction = 'cancel';
    let payload: { days?: number; months?: number; date?: string } = {};
    if (command === 'move') {
      if (shift?.date !== undefined) {
        const anchor = row.due ?? row.periodFrom;
        if (anchor !== null && shiftToDate(anchor, shift.date) === null) {
          // Дата совпала с якорем строки — молчаливое закрытие выглядело бы как
          // «ничего не произошло» (замечание репроверки 64f7976a).
          notice(t('tasks.moveNotNeeded'), 'info');
          return;
        }
        // У строки с датами сервер сдвигает все ссылки так, чтобы последняя
        // встала на выбранную дату (период сохраняется); у бессрочной —
        // дописывает ссылку в конец строки (ошибка 3f9ea2ee).
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
      renderView();
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

  /** Массовая команда группы: подтверждение со сводкой → команда → undo. */
  async function runBulk(
    filter: TaskMassFilter,
    command: TaskMassAction,
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
      if (resolved === null) {
        // Выбрано «сегодня» — сдвиг нулевой: показываем статус пользователю
        // вместо молчаливого закрытия диалога (замечание репроверки 64f7976a).
        notice(t('tasks.moveNotNeeded'), 'info');
        return;
      }
      effectiveShift = resolved;
    }
    const confirmed = await confirmDialog(
      t('tasks.bulkTitle'),
      t(bulkQuestionKey(command), [plan.rows.length]),
      // Опасной (красной) кнопка подтверждения делается только для снятия
      // задач: снятие дат обратимо командой «Отменить» в панели.
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
      if (action === 'edit-schedule') {
        // Правка расписания — по карточке напоминания (PATCH), вхождение здесь
        // не адресуется: расписание меняется у всего напоминания.
        const reminder = state.reminders.reminders.find((item) => item.id === row.reminderId);
        if (reminder === undefined) return;
        await openReminderEditor({
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          reminder,
          subjectTitle: row.title,
          onSaved: () => {
            void loadPanel();
          },
          // «Не напоминать» удаляет строку — панель обязана её убрать.
          onRemoved: () => {
            void loadPanel();
          },
        });
        return;
      }
      if (action === 'dismiss') {
        // Адрес вхождения: у отложенной строки показан `until`, а исключение
        // обязано лечь на момент РАСПИСАНИЯ (требование 86cb7451).
        await etn.reminders.dismiss(networkId, row.reminderId, row.occurrenceAt);
      } else if (action === 'snooze') {
        if (until === undefined) return;
        await etn.reminders.snooze(networkId, row.reminderId, until, row.occurrenceAt);
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
   * Групповая команда «Отменить все напоминания по группе»: убрать каждое
   * вхождение строк группы (по одному dismiss с адресом вхождения). Ошибка
   * одной строки не отменяет остальные; итог показывается числом убранных.
   */
  async function runReminderGroupDismiss(
    title: string,
    rows: readonly ReminderPanelRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const networkId = requireNetworkId();
    const confirmed = await confirmDialog(
      t('reminder.groupDismiss'),
      t('reminder.groupDismissQuestion', [title]),
      true,
    );
    if (!confirmed || disposed) return;
    let removed = 0;
    for (const row of rows) {
      try {
        await etn.reminders.dismiss(networkId, row.reminderId, row.occurrenceAt);
        removed += 1;
      } catch {
        // Строка могла исчезнуть/смениться между загрузкой и командой —
        // остальные вхождения группы всё равно убираются.
      }
    }
    notice(t('reminder.groupDismissDone', [removed]));
    await loadPanel();
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
    renderTaskRowText(node, row.text, requireNetworkId());
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
      const version = typeof data.version === 'number' ? data.version : null;
      // Эхо СОБСТВЕННОЙ правки: ревизия совпадает с той, что мы только что
      // записали. Строка уже помечена серой точечно (`staleRows`), а запись
      // серой целиком красить нельзя — соседние строки остаются рабочими
      // (ошибка d318a647).
      if (data.id !== undefined && version !== null && commentVersions.get(data.id) === version) {
        return;
      }
      // Глобальный маркер проекции: `max_revision` из GET /tasks сравнивается
      // с ревизией события (уточнение e6d65f51 0.16.1). Ушёл вперёд — в сети
      // изменилась запись, панель показывает «Обновить» ещё до загрузки строк.
      if (panelMarkerAdvanced(version, state.maxRevision)) {
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
      if (persistTimer !== null) {
        window.clearTimeout(persistTimer);
        persistTimer = null;
      }
      unsubscribe();
      panel.destroy();
    },
    panelCollapsed(): boolean {
      return panel.panelCollapsed();
    },
    panelHeight(): number | null {
      return panelHeightValue;
    },
    setPanelHeight(height: number): void {
      panel.setPanelHeight(height);
    },
  };
}

/**
 * Нарисовать снапшот текста строки панели: markdown + кликабельные ID-ссылки.
 * Резолв — по ГОТОВОМУ DOM (общий вход `renderMarkdownWithWikiLinks`): серверный
 * HTML несёт пустые `<span class="wiki-link" data-wiki-id>`, и резолвер по строке
 * сниппета их не видит (блокер 399c25d5).
 */
export function renderTaskRowText(node: HTMLElement, text: string, networkId: string): void {
  renderMarkdownWithWikiLinks(node, text, networkId);
}

/** Классы строк панели — реэкспорт для тестов экрана и стенда. */
export const TASKS_PANEL_ROW_CLASSES = {
  task: TASK_PANEL_ROW_CLASS,
  reminder: REMINDER_PANEL_ROW_CLASS,
} as const;

/** Ключ строки задачи — реэкспорт адреса проекции для тестов. */
export { taskRowKey };
