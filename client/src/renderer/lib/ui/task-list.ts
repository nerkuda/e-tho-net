/**
 * Единая компонента списка задач «Задачи и напоминания» (0.16.1, задача
 * `7446eb25`; элементы `f76ed829`/`15f8ea2f`/`498f23e0`, требования
 * `6762adb0`/`0e85b66e`/`e6af8b9e`/`3616cfec`/`db1d9548`).
 *
 * **Зачем.** Рендер панели был общим (`lib/ui/task-panel.ts`), а экранные
 * контроллеры `screens/chronicle/tasks-panel.ts` и `editor/tasks-panel.ts`
 * дублировали слой «загрузка → операции → устаревание → realtime» (~450–500
 * строк копипасты) и разошлись: в карточке мысли не было вложенных строк,
 * «сегодня» (красной просрочки), «Отменить» и переключателя выполненных.
 * Здесь этот слой живёт ОДНИМ экземпляром, а оба экрана — тонкие обвязки.
 *
 * **Два источника выборки** (`source`):
 *  • `period` — панель «Дневника»: четыре среза (`scope=open` в периоде,
 *    сквозные `overdue`/`undated`, `done`), напоминания владельца, `include_nested`,
 *    переключатель выполненных, «Отменить» массовой команды, `today`;
 *  • `thought` — зона «Задачи» карточки мысли: страницы по `thought_id` (keyset-
 *    курсор), выполненные — отдельной сворачиваемой секцией, без напоминаний.
 *    Вложенные строки и `today` теперь есть и здесь — расхождение копипасты
 *    устранено.
 *
 * **Устаревание и «Обновить»** (требование `0e85b66e`, уточнение замечания 2 ТЗ
 * 2026-11-18, замечание 3 вердикта `e984a2db`). Серая строка — снапшот ЭТОЙ
 * строки (правка из панели адресуется `comment_id`+`line_no`); внешнее изменение
 * записи красит всю запись. Кнопка «Обновить» светится при ЛЮБОМ изменении в
 * сети: `comment.updated`/`created`/`deleted` и `reminders.changed` поднимают
 * маркер панели, в том числе для записей, которых панель не загружала (в сети
 * появилась новая задача периода). Эхо своей правки гасится ТОЛЬКО по токену
 * операции (`comment_id:version` ответа на запись) либо по признаку «своя
 * запись ещё в полёте»: сервер публикует событие ДО ответа, поэтому эхо может
 * прийти раньше токена. СВОЯ правка строку серой не делает — снапшот текста
 * перечитывается сразу (дух ошибки `45480290`).
 *
 * **Кэш субъектов и живые облачка** (замечания ТЗ 2026-11-17 C/E и 2026-11-18
 * 5). Снапшоты мыслей/публикаций строк и групп кэшируются на сессию панели;
 * облачко мысли собирается эталоном `lib/thought-cloud` с ДЕЙСТВИЯМИ — клик
 * открывает мысль, правый клик — общее меню мысли вне холста. Клик по
 * заголовку группы-мысли делает то же (экран кладёт облачко в заголовок).
 *
 * **Правки** (замечания 3/4 ТЗ 2026-11-18): чекбокс задачи — команда
 * `PATCH /tasks`; пункт чек-листа под задачей не является задачей проекции и
 * отмечается правкой текста источника; строка задачи с вложенными строками
 * правится БЛОКОМ «как трансклюзия» (диапазон `body_md`).
 *
 * Состояние вида (`ui_state`) читает/пишет сама компонента по ключу
 * `persistence.uiStateKey`: показ выполненных, карта свёрнутых блоков и высота
 * панели. Панель карточки мысли состояние не хранит (`persistence` не задан).
 */

import { addTaskLineMarker, isTaskLineMarker } from '@etn/markdown';
import {
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

import { requireNetworkId } from '../network-id.js';
import { store } from '../../state.js';
import { isValidLocalDay, localDayEnd, localDayStart, todayLocal } from '../dates.js';
import {
  datePeriodValueFromInstants,
  openDatePeriodDialog,
  resolveDatePeriodInstants,
} from '../date-period-dialog.js';
import { confirmDialog } from '../dialog.js';
import { errText } from '../dom.js';
import { etn } from '../etn.js';
import { formatDate, t } from '../i18n.js';
import { onRoutedRealtimeEvent } from '../live/event-router.js';
import { MENU_SEPARATOR, menuAction, menuSubmenu, type MenuItem } from '../menu.js';
import { notice } from '../notice.js';
import { openReminderEditor } from '../reminder-editor.js';
import { createPublicationCloud, type PublicationCloudInput } from './publication-cloud.js';
import { createThoughtCloud, type ThoughtCloudInput } from '../thought-cloud.js';
import {
  TASK_PANEL_COLLAPSE_KEYS,
  mountTaskPanel,
  type ReminderPanelRow,
  type ReminderPanelSectionView,
  type ReminderRowAction,
  type TaskPanelHandle,
  type TaskPanelRow,
  type TaskPanelSectionView,
  type TaskPanelSubject,
  type TaskPanelView,
  type TaskRowCommand,
  type TaskRowEditorFactory,
  type TaskShift,
} from './task-panel.js';
import {
  REMINDERS_OVERDUE_DAYS,
  calendarDaysBetween,
  dailyRecordsOf,
  findTaskLineForDay,
  flatReminderRows,
  nestedLinesByParent,
  orderTaskRowsUndatedFirst,
  panelNeedsRefresh,
  planTaskBulk,
  reminderPanelRows,
  replaceTaskLine,
  replaceTaskLineRange,
  setChecklistLineDone,
  shiftDay,
  taskCounters,
  taskRowKey,
  taskRowView,
  taskRowsForFilter,
  type TaskPanelChildRow,
  type TaskPanelStaleness,
} from './task-panel-model.js';

/** Границы высоты панели, px: ниже — нечитаемо, выше — не оставляет ленты. */
export const TASK_LIST_HEIGHT = { min: 120, max: 900, feedMin: 160 } as const;

/** Предел строк на один запрос списка задач (сервер: `TASKS_MAX_LIMIT`). */
const TASKS_PAGE_LIMIT = 200;

/** Задержка записи настроек панели после драга слайдера, мс. */
const PERSIST_DEBOUNCE_MS = 400;

/**
 * Задержка автоперечитывания панели на событие комментария, мс (0.16.1,
 * уточнение 2026-11-19, пункт 4). Сохранение записи даёт пачку событий
 * (`updated` + перестройка проекции), поэтому перечитывание одно на пачку.
 */
const AUTO_REFRESH_DEBOUNCE_MS = 150;

/** Источник выборки панели. */
export type TaskListSource =
  | {
      /** Панель «Дневника»: срезы периода и напоминания. */
      kind: 'period';
      /** Применённый период ленты (локальные дни `YYYY-MM-DD`). */
      getPeriod(): { from: string; to: string };
    }
  | {
      /** Зона «Задачи» карточки мысли: строки по ID-ссылке на мысль. */
      kind: 'thought';
      /** Мысль-владелец панели. */
      ownerId: string;
    };

/** Вид панели: что показывать и как ведёт себя секция выполненных. */
export interface TaskListViewOptions {
  /** Панель встраивается в чужую шапку: своей шапки и групп-обёрток нет. */
  headless?: boolean;
  /** Показывать группу напоминаний (панель «Дневника»). */
  reminders?: boolean;
  /**
   * Секция выполненных: `toggle` — переключатель «показывать выполненные» в
   * меню группы (Дневник), `collapsed` — отдельная свёрнутая секция (карточка
   * мысли), `none` — не показывать.
   */
  doneSection?: 'toggle' | 'collapsed' | 'none';
  /**
   * Скрывать строки неактуальных субъектов по настройке сети и красить их
   * серым (поведение карточки мысли).
   */
  inactiveRows?: 'off' | 'filter';
  /**
   * «Отменить» последнюю массовую команду (по умолчанию `true` — обе панели:
   * в «Дневнике» кнопка в шапке группы, в карточке мысли — в шапке зоны).
   * `false` — панель без отмены (например, встроенная в чужой экран).
   */
  undo?: boolean;
  /**
   * Перечитывать панель автоматически при `comment.created/updated/deleted`
   * (0.16.1, уточнение 2026-11-19, пункт 4): зона «Задачи» редактора мысли
   * появляется сразу после сохранения комментария, а не после смены мысли.
   * Маркер «Обновить» при этом остаётся штатным путём панели «Дневника».
   */
  autoRefreshOnCommentChange?: boolean;
  /**
   * Облачка субъектов у строк задач (0.16.1, пачка 4, пункт 1). По умолчанию
   * есть: в «Дневнике» субъекты строк разные. Зона «Задачи» редактора мысли их
   * выключает — все её строки принадлежат самой редактируемой мысли.
   */
  rowSubjectClouds?: boolean;
  /** Отрисовка снапшота текста строки (markdown + кликабельные ссылки). */
  renderText(host: HTMLElement, row: TaskPanelRow): void;
}

/** Реакции экрана: всё, что требует знания, куда вести пользователя. */
export interface TaskListActions {
  /** Переход к дню источника строки (панель «Дневника»). */
  openDay?(day: string): void;
  /** Открыть запись-источник строки (панель карточки мысли). */
  openRowSource?(row: TaskPanelRow): void;
  /**
   * Перейти к строке только что созданной задачи (0.16.1, пачка 4, пункт 3).
   * Экран ведёт штатным входом «Открыть источник»: запись становится текущей,
   * отбор/период выставляются по её дате, если её нет в ленте, лента — в
   * начало, тело — в правке, каретка в строку задачи. `lineNo` — номер строки
   * `body_md` с нуля (адрес `PATCH /tasks`).
   */
  openCreatedTask?(ref: { commentId: string; lineNo: number }): void;
  /** Открыть субъект строки/группы (мысль или публикация). */
  openSubject?(subject: TaskPanelSubject): void;
  /** Правки в записях изменились — лента «Дневника» перечитывается. */
  onRecordsChanged?(): void;
  /** Панель свёрнута/развёрнута: экран прячет слайдер высоты. */
  onPanelCollapsed?(collapsed: boolean): void;
  /**
   * Состояние зоны (карточка мысли: пустая панель скрывает группу).
   * `canUndo` — доступна отмена последней массовой команды: зона остаётся
   * видимой, иначе «Отменить» в шапке скрытой группы недоступна (вердикт
   * репроверки `7448ac21`).
   */
  onViewState?(state: {
    rowCount: number;
    loading: boolean;
    hasError: boolean;
    canUndo: boolean;
  }): void;
}

/** Персист панели в `ui_state` (`persistence` не задан — состояние не хранится). */
export interface TaskListPersistence {
  /** Ключ настройки панели в `ui_state`. */
  uiStateKey: string;
  /** Границы высоты панели (по умолчанию {@link TASK_LIST_HEIGHT}). */
  height?: { min: number; max: number; feedMin: number };
}

/** Полная настройка монтирования компоненты. */
export interface TaskListOptions {
  source: TaskListSource;
  view: TaskListViewOptions;
  actions?: TaskListActions;
  persistence?: TaskListPersistence;
  /**
   * Фабрика правки строки — КОМПОНЕНТА РЕДАКТИРОВАНИЯ КОММЕНТАРИЯ (0.16.1,
   * задача `cfb8cb72`, пункт 1). Даёт экран: `lib/ui` не тянет CodeMirror,
   * поэтому панель получает поле правки параметром, а не импортом.
   */
  createRowEditor?: TaskRowEditorFactory;
}

/** Публичный дескриптор панели. */
export interface TaskListHandle {
  /** Перечитать панель (смена периода/отбора, ручное «Обновить»). */
  refresh(): void;
  /** Снять подписки и размонтировать компоненту. */
  destroy(): void;
  /** Кнопки шапки для встраивания (только `headless`). */
  headActions(): HTMLElement[];
  /** Панель свёрнута штатной кареткой. */
  panelCollapsed(): boolean;
  /** Высота панели из `ui_state`, `null` — по умолчанию. */
  panelHeight(): number | null;
  /** Запомнить высоту панели (слайдер) и применить её сразу. */
  setPanelHeight(height: number): void;
}

/** Локальная настройка панели в `ui_state`. */
interface TaskListSettings {
  showDone: boolean;
  /** Свёрнутость блоков панели: ключ → свёрнут (ошибка d0801eea). */
  collapsed?: Record<string, boolean>;
  /** Высота панели, px. Не задана — по умолчанию. */
  height?: number;
}

/** Состояние одной загрузки. */
interface TaskListState {
  /** Срезы панели «Дневника» (разные запросы, не смешиваются). */
  period: TaskDTO[];
  overdue: TaskDTO[];
  undated: TaskDTO[];
  done: TaskDTO[];
  doneTotal: number;
  /** Строки панели карточки мысли (все страницы по мысли). */
  rows: TaskDTO[];
  reminders: ReminderListResult;
  maxRevision: number;
  /** Вложенные не-задачные строки страниц (`include_nested`). */
  nested: TaskNestedLine[];
}

/** Пустое состояние до первой загрузки. */
function emptyState(): TaskListState {
  return {
    period: [],
    overdue: [],
    undated: [],
    done: [],
    doneTotal: 0,
    rows: [],
    reminders: { reminders: [], from: null, to: null },
    maxRevision: 0,
    nested: [],
  };
}

/**
 * Смонтировать единую панель списка задач. Компонента ведёт загрузку, операции,
 * устаревание, realtime и кэш субъектов; экран задаёт только источник, вид и
 * переходы.
 */
export function mountTaskList(host: HTMLElement, options: TaskListOptions): TaskListHandle {
  const { source, view, actions = {}, persistence } = options;
  const doneSection = view.doneSection ?? (source.kind === 'period' ? 'toggle' : 'collapsed');
  const withReminders = view.reminders === true;
  const withUndo = view.undo !== false;
  const heightLimits = persistence?.height ?? TASK_LIST_HEIGHT;

  let disposed = false;
  let loading = false;
  let loadError: string | null = null;
  let state = emptyState();
  let showDone = false;
  let collapsed: Record<string, boolean> = {};
  /** Строки, изменённые ИЗ ПАНЕЛИ (`comment_id:line_no`) — серые точечно. */
  let staleRows = new Set<string>();
  /** Записи, изменённые ВНЕ панели: событие слоя не знает номера строки. */
  let staleComments = new Set<string>();
  /** Показанное состояние чекбоксов строк, переключённых из панели. */
  const toggledDone = new Map<string, boolean>();
  /** Последние известные ревизии комментариев-источников. */
  const commentVersions = new Map<string, number>();
  /**
   * Токены СВОИХ операций (`comment_id:version`): по ним гасится эхо
   * собственной правки, и только по ним. Чужое событие с той же ревизией
   * (совпадение версий) маркер панели поднимает (замечание 2 ТЗ 2026-11-18).
   */
  const ownOpTokens = new Set<string>();
  /**
   * Комментарии с НЕЗАВЕРШЁННОЙ своей записью. Сервер публикует событие слоя до
   * ответа на запись, поэтому эхо приходит раньше, чем известен его токен
   * `comment_id:version` (замечание 3 вердикта `e984a2db`): пока запись в
   * полёте, событие этого комментария считается своим.
   */
  const pendingOwnWrites = new Set<string>();
  /** Ревизии, пришедшие эхом раньше ответа: их токен уже не нужен. */
  const echoedOwnVersions = new Set<string>();
  let remindersChanged = false;
  /** В сети изменилась запись/напоминание — «Обновить» светится. */
  let foreignChange = false;
  /**
   * СВОЯ операция изменила то, что видно только полной пересборкой (срок строки,
   * состав списка, отметка выполнения) — «Обновить» светится (0.16.1, задача
   * `cfb8cb72`, пункты 2 и 4). Пока маркер не погашен, списки не пересобираются:
   * строка остаётся на своём месте.
   */
  let ownRebuildPending = false;
  /**
   * Держать порядок строк панели последней отрисовки до «Обновить» (пункт 2:
   * после `Ctrl+Enter` строка не прыгает вниз списка). Снимается `loadPanel`.
   */
  let holdTaskOrder = false;
  /** Секции задач последней отрисовки — источник порядка при `holdTaskOrder`. */
  let heldTaskSections: TaskPanelSectionView[] | null = null;
  /**
   * Вхождения напоминаний, отмеченные из панели (ключи строк): dismiss ушёл,
   * а до «Обновить» строка держит отметку (пункт 7).
   */
  const reminderDoneKeys = new Set<string>();
  /**
   * Создания задачи на сегодня В ПОЛЁТЕ (ключ субъект+вхождение). Двойное
   * нажатие «Создать» не должно прочитать запись дважды и дописать две строки:
   * второй клик, пока первый не завершён, игнорируется (пачка 4, пункт 4).
   */
  const creatingForToday = new Set<string>();
  let loadSeq = 0;
  /** Снимок текстов для отмены массовой команды. */
  let undoSnapshot: Array<{ id: string; body_md: string; version: number }> | null = null;
  /** Кэш субъектов строк: снапшот мысли/публикации для облачка и названий. */
  const subjectData = new Map<string, ThoughtCloudInput | PublicationCloudInput>();
  let settingsLoaded = false;
  let panelHeightValue: number | null = null;
  let persistTimer: number | null = null;
  let retryStop: (() => void) | null = null;

  const panel: TaskPanelHandle = mountTaskPanel(
    host,
    {
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
        if (key === TASK_PANEL_COLLAPSE_KEYS.panel) actions.onPanelCollapsed?.(value);
      },
      toggle: (row, done) => void toggleTask(row, done),
      loadRawLine: (row) => loadRawLine(row),
      editLine: (row, text) => saveLine(row, text),
      rowCommand: (row, command, shift) => void runRowCommand(row, command, shift),
      bulk: (filter, command, shift) => void runBulk(filter, command, shift),
      reminderAction: (row, action, until) => void runReminderAction(row, action, until),
      reminderDone: (row) => void markReminderDone(row),
      reminderGroupDismiss: (title, rows) => void runReminderGroupDismiss(title, rows),
      pickDate: (initial) => pickDate(initial),
      pickDateTime: (initialIso) => pickDateTime(initialIso),
      openDay: (day) => actions.openDay?.(day),
      openRowSource: actions.openRowSource,
      headMenu: source.kind === 'thought' ? () => thoughtHeadMenu() : undefined,
      renderText: (node, row) => view.renderText(node, row),
      renderSubject: (node, subject) => renderSubject(node, subject),
      panelHeight: () => panelHeightValue,
      setPanelHeight: (height) => {
        panelHeightValue = height;
        schedulePersist();
      },
      toggleChild: (row, child, done) => void toggleChild(row, child, done),
      loadRawBlock: (row) => loadRawBlock(row),
      editBlock: (row, range, text) => editBlock(row, range, text),
    },
    {
      headless: view.headless === true,
      createRowEditor: options.createRowEditor,
      // Облачка строк выключает зона «Задачи» редактора мысли (пункт 1).
      rowSubjectClouds: view.rowSubjectClouds !== false,
    },
  );

  // -------------------------------------------------------------------------
  // Настройки панели (`ui_state`)
  // -------------------------------------------------------------------------

  /** Прочитать настройки панели. */
  async function loadSettings(): Promise<void> {
    if (persistence === undefined) {
      settingsLoaded = true;
      actions.onPanelCollapsed?.(false);
      renderView();
      return;
    }
    try {
      const raw = await etn.ui.getState(requireNetworkId(), persistence.uiStateKey);
      if (disposed) return;
      if (raw !== null && raw !== '') {
        const parsed = JSON.parse(raw) as Partial<TaskListSettings>;
        showDone = parsed.showDone === true;
        const saved = parsed.collapsed;
        if (saved !== undefined && saved !== null && typeof saved === 'object') {
          collapsed = { ...saved };
        }
        const height = parsed.height;
        if (typeof height === 'number' && Number.isFinite(height)) {
          panelHeightValue = Math.min(heightLimits.max, Math.max(heightLimits.min, height));
        }
      }
    } catch {
      // Настройки нет или она повреждена — дефолт (выполненные скрыты, блоки развёрнуты).
    } finally {
      settingsLoaded = true;
      actions.onPanelCollapsed?.(collapsed[TASK_PANEL_COLLAPSE_KEYS.panel] === true);
      renderView();
    }
  }

  /** Сохранить настройки панели. */
  function persistSettings(): void {
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (!settingsLoaded || persistence === undefined) return;
    const payload: TaskListSettings = { showDone, collapsed };
    if (panelHeightValue !== null) payload.height = panelHeightValue;
    void etn.ui
      .setState(requireNetworkId(), persistence.uiStateKey, JSON.stringify(payload))
      .catch(() => undefined);
  }

  /** Отложенная запись настроек (драг слайдера даёт десятки вызовов в секунду). */
  function schedulePersist(): void {
    if (persistTimer !== null) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      persistTimer = null;
      persistSettings();
    }, PERSIST_DEBOUNCE_MS);
  }

  // -------------------------------------------------------------------------
  // Период, окно напоминаний, загрузка
  // -------------------------------------------------------------------------

  /** Период ленты для запросов: невалидный период заменяется сегодняшним днём. */
  function effectivePeriod(): { from: string; to: string } {
    if (source.kind !== 'period') {
      const today = todayLocal();
      return { from: today, to: today };
    }
    const period = source.getPeriod();
    const today = todayLocal();
    const from = isValidLocalDay(period.from) ? period.from : today;
    const to = isValidLocalDay(period.to) ? period.to : today;
    return from <= to ? { from, to } : { from: to, to: from };
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

  /** Перечитать панель целиком (ручное «Обновить» и смена периода). */
  async function loadPanel(): Promise<void> {
    const networkId = requireNetworkId();
    const seq = ++loadSeq;
    loading = true;
    renderView();
    try {
      if (source.kind === 'period') {
        await loadPeriod(networkId, seq);
      } else {
        await loadThought(networkId, seq);
      }
      if (disposed || seq !== loadSeq) return;
      retryStop?.();
      retryStop = null;
      staleRows = new Set<string>();
      staleComments = new Set<string>();
      toggledDone.clear();
      commentVersions.clear();
      ownOpTokens.clear();
      for (const row of allRows()) rememberVersion(row.comment_id, row.revision);
      remindersChanged = false;
      foreignChange = false;
      echoedOwnVersions.clear();
      // Полная пересборка состоялась: держанный порядок снят, отметки
      // напоминаний и маркер своей операции погашены (пункты 2, 4, 7).
      ownRebuildPending = false;
      holdTaskOrder = false;
      reminderDoneKeys.clear();
      loadError = null;
      await resolveSubjects(seq);
    } catch (err) {
      if (disposed || seq !== loadSeq) return;
      loadError = errText(err);
      retryStop?.();
      if (source.kind === 'thought') {
        const { onReconnected } = await import('../../state.js');
        retryStop = onReconnected(networkId, () => void loadPanel());
      }
    } finally {
      if (!disposed && seq === loadSeq) {
        loading = false;
        renderView();
      }
    }
  }

  /** Загрузка панели «Дневника»: четыре среза задач + напоминания. */
  async function loadPeriod(networkId: string, seq: number): Promise<void> {
    const period = effectivePeriod();
    const today = todayLocal();
    const window = reminderWindow();
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
      withReminders
        ? etn.reminders.list(networkId, { from: window.from, to: window.to })
        : Promise.resolve<ReminderListResult>({ reminders: [], from: null, to: null }),
    ]);
    if (disposed || seq !== loadSeq) return;
    state = {
      period: periodPage.items,
      overdue: overduePage.items,
      undated: undatedPage.items,
      done: donePage.items,
      doneTotal: donePage.total ?? donePage.items.length,
      rows: [],
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
  }

  /** Загрузка панели карточки мысли: все страницы по `thought_id`. */
  async function loadThought(networkId: string, seq: number): Promise<void> {
    if (source.kind !== 'thought') return;
    const items: TaskDTO[] = [];
    const nested: TaskNestedLine[] = [];
    let maxRevision = 0;
    let cursor: string | undefined;
    do {
      const page = await etn.tasks.list(networkId, {
        thought_id: source.ownerId,
        today: todayLocal(),
        limit: TASKS_PAGE_LIMIT,
        include_nested: true,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      items.push(...page.items);
      nested.push(...(page.nested ?? []));
      maxRevision = Math.max(maxRevision, page.max_revision);
      cursor = page.cursor ?? undefined;
      if (disposed || seq !== loadSeq) return;
    } while (cursor !== undefined);
    state = {
      period: [],
      overdue: [],
      undated: [],
      done: [],
      doneTotal: 0,
      rows: items,
      reminders: { reminders: [], from: null, to: null },
      maxRevision,
      nested,
    };
  }

  /**
   * Доразрешить субъектов задач и напоминаний: снапшоты мыслей и публикаций
   * (кэш на сессию панели) — из них берутся названия групп и облачка строк.
   */
  async function resolveSubjects(seq: number): Promise<void> {
    const networkId = requireNetworkId();
    const ids = new Set<string>();
    for (const row of allRows()) {
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

  // -------------------------------------------------------------------------
  // Строки, секции, счётчики
  // -------------------------------------------------------------------------

  /** Все загруженные строки (оба источника). */
  function allRows(): TaskDTO[] {
    if (source.kind === 'period') {
      return [...state.period, ...state.overdue, ...state.undated, ...state.done];
    }
    return state.rows;
  }

  /** Строки, видимые панели (учитывает настройку неактуальных у карточки мысли). */
  function visibleRows(rows: readonly TaskDTO[]): TaskDTO[] {
    if (view.inactiveRows !== 'filter') return [...rows];
    return rows.filter((row) => row.subject_state === 'active' || store.state.showInactive);
  }

  /** Название субъекта строки (мысль/публикация) с фолбэком на id. */
  function subjectTitle(kind: 'thought' | 'publication', id: string): string {
    return subjectData.get(`${kind}:${id}`)?.title ?? id;
  }

  /** Признаки устаревания для модели. */
  function staleness(): TaskPanelStaleness {
    return { rows: staleRows, comments: staleComments };
  }

  /** Загруженные строки одного комментария-источника (до своей правки). */
  function rowsOfComment(commentId: string): TaskDTO[] {
    return allRows().filter((row) => row.comment_id === commentId);
  }

  /**
   * Своя правка изменила то, что видно только полной пересборкой (пункт 2):
   * строки записи появились/исчезли или сменили срок. Текст, маркер и пункты
   * чек-листа пересборки не требуют — они обновляются точечно.
   */
  function ownEditStructureChanged(
    before: readonly TaskDTO[],
    fresh: readonly TaskDTO[],
    commentId: string,
  ): boolean {
    const beforeRows = before.filter((row) => row.comment_id === commentId);
    const afterRows = fresh.filter((row) => row.comment_id === commentId);
    if (beforeRows.length !== afterRows.length) return true;
    const afterByKey = new Map(afterRows.map((row) => [taskRowKey(row), row]));
    for (const row of beforeRows) {
      const next = afterByKey.get(taskRowKey(row));
      if (next === undefined) return true;
      if (next.due !== row.due) return true;
      if (next.period_from !== row.period_from || next.period_to !== row.period_to) return true;
      if (next.done !== row.done) return true;
    }
    return false;
  }

  /**
   * Строка проекции → строка панели. Общий путь секций периода и мысли:
   * снапшот текста, вложенные строки и показанная отметка чекбокса.
   */
  function viewRowOf(
    row: TaskDTO,
    children: ReadonlyMap<string, readonly TaskPanelChildRow[]>,
  ): TaskPanelRow {
    const address = taskRowKey(row);
    return taskRowView(row, staleness(), toggledDone.get(address), {
      today: todayLocal(),
      children: children.get(address) ?? [],
    });
  }

  /**
   * ПЛОСКАЯ секция задач (0.16.1, задача `cfb8cb72`, пункт 6): подгрупп нет,
   * список сплошной — одинаковый при любом периоде. Порядок строк задаёт
   * вызывающий (готовые представления приходят уже упорядоченными).
   */
  function flatTaskSection(
    key: string,
    title: string,
    rows: readonly TaskPanelRow[],
  ): TaskPanelSectionView {
    return { key, title, flat: true, subgroups: [], rows: [...rows] };
  }

  /**
   * ЕДИНЫЙ список напоминаний (пункт 6): одна хронологическая секция без
   * подгрупп, просроченные строки в ней же и красные.
   */
  function flatReminderSection(rows: readonly ReminderPanelRow[]): ReminderPanelSectionView {
    return { key: 'all', title: '', flat: true, subgroups: [], rows: flatReminderRows(rows) };
  }

  /**
   * Строки задач в порядке срока (без даты — в конец): «Срочные» — сплошной
   * список, поэтому порядок задаёт срок, а не подгруппы. Сортировка
   * устойчива — строки с одинаковым сроком сохраняют серверный порядок.
   */
  function orderByDue(rows: readonly TaskPanelRow[]): TaskPanelRow[] {
    return [...rows].sort((left, right) => {
      if (left.due === right.due) return 0;
      if (left.due === null) return 1;
      if (right.due === null) return -1;
      return left.due < right.due ? -1 : 1;
    });
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

  /** Секции панели карточки мысли: активные плоским списком, выполненные — свёрнуто. */
  function thoughtSections(): TaskPanelSectionView[] {
    const rows = visibleRows(state.rows);
    const children = nestedLinesByParent(state.nested);
    const viewRow = (row: TaskDTO): TaskPanelRow => {
      const mapped = viewRowOf(row, children);
      // Неактуальный субъект карточки мысли — серая строка (настройка сети).
      if (row.subject_state === 'inactive') mapped.stale = true;
      return mapped;
    };
    const active = orderTaskRowsUndatedFirst(rows.filter((row) => !row.done)).map(viewRow);
    const done = orderTaskRowsUndatedFirst(rows.filter((row) => row.done)).map(viewRow);
    const sections: TaskPanelSectionView[] = [];
    if (active.length > 0) {
      sections.push({ key: 'active', title: '', flat: true, subgroups: [], rows: active });
    }
    if (done.length > 0 && doneSection !== 'none') {
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
    return sections;
  }

  /** Собрать снимок панели и отрисовать его. */
  function renderView(): void {
    if (disposed) return;
    const todayStart = Date.parse(localDayStart(todayLocal()));

    /** Секции задач: у «Дневника» — срезы периода, у карточки мысли — плоские. */
    const freshTaskSections: TaskPanelSectionView[] =
      source.kind === 'period' ? periodTaskSections() : thoughtSections();
    // Пока порядок держится (своя инлайн-правка, пункт 2), секции берутся из
    // последней отрисовки: строка остаётся на месте, текст обновляется.
    const taskSections =
      holdTaskOrder && heldTaskSections !== null
        ? holdSections(heldTaskSections, freshTaskSections)
        : freshTaskSections;
    heldTaskSections = taskSections;

    const taskRows = allRows();
    const counters = taskCounters(
      view.inactiveRows === 'filter' ? visibleRows(taskRows) : taskRows,
    );
    const stale = panelNeedsRefresh({
      rows: taskRows,
      stale: staleness(),
      remindersChanged,
      // Своя операция тоже поднимает маркер: отметка выполнения (пункт 4),
      // смена срока/состава строк (пункт 2) видны только пересборкой списков.
      markerAdvanced: foreignChange || ownRebuildPending,
    });

    /** Названия субъектов напоминаний — ключ `<вид>:<id>`. */
    const reminderTitles = new Map<string, string>();
    for (const reminder of state.reminders.reminders) {
      reminderTitles.set(
        `${reminder.subject_type}:${reminder.subject_id}`,
        subjectTitle(reminder.subject_type, reminder.subject_id),
      );
    }
    const reminderRows = withReminders
      ? reminderPanelRows(
          state.reminders,
          reminderTitles,
          repeatLabel,
          todayStart,
          reminderDoneKeys,
        )
      : [];
    // «Напоминания» — ОДИН список без подгрупп при любом периоде (пункт 6):
    // просроченные строки стоят в нём же и красятся красным.
    const sections: ReminderPanelSectionView[] =
      reminderRows.length > 0 ? [flatReminderSection(reminderRows)] : [];

    const snapshot: TaskPanelView = {
      stale,
      periodFilter: baseFilter('open'),
      canUndo: withUndo && undoSnapshot !== null,
      showDone: doneSection === 'toggle' ? showDone : doneSection !== 'none',
      counters,
      reminderCount: reminderRows.length,
      taskSections,
      reminderSections: sections,
      loading,
      error: loadError,
    };
    panel.render(snapshot);
    actions.onViewState?.({
      rowCount: view.inactiveRows === 'filter' ? visibleRows(taskRows).length : taskRows.length,
      loading,
      hasError: loadError !== null,
      // Отмена живёт в шапке группы: пока она доступна, зона не скрывается.
      canUndo: withUndo && undoSnapshot !== null,
    });
  }

  /**
   * Секции задач панели «Дневника» (0.16.1, задача `cfb8cb72`, пункт 6): две
   * сплошные секции — «Без срока», затем «Срочные», одинаково для любого
   * периода. «Срочные» несут и просроченные строки (они красные), порядок —
   * по сроку. Строка, попавшая и в период, и в сквозную выборку «просрочено»,
   * показывается ОДИН раз: сплошной список не терпит дублей.
   */
  function periodTaskSections(): TaskPanelSectionView[] {
    const nestedChildren = nestedLinesByParent(state.nested);
    const showDoneRows = showDone && doneSection === 'toggle';
    const undated: TaskDTO[] = [...state.undated];
    const dated: TaskDTO[] = [...state.period, ...state.overdue];
    if (showDoneRows) {
      for (const row of state.done) {
        if (row.period_from === null) undated.push(row);
        else dated.push(row);
      }
    }
    const seen = new Set<string>();
    const unique = (rows: readonly TaskDTO[]): TaskDTO[] =>
      rows.filter((row) => {
        const key = taskRowKey(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const undatedViews = orderTaskRowsUndatedFirst(
      unique(undated).map((row) => viewRowOf(row, nestedChildren)),
    );
    const datedViews = orderByDue(unique(dated).map((row) => viewRowOf(row, nestedChildren)));
    const sections: TaskPanelSectionView[] = [];
    if (undatedViews.length > 0) {
      sections.push(flatTaskSection('undated', t('tasks.sectionUndated'), undatedViews));
    }
    if (datedViews.length > 0) {
      sections.push(flatTaskSection('urgent', t('tasks.sectionUrgent'), datedViews));
    }
    return sections;
  }

  /**
   * Секции с ДЕРЖАННЫМ порядком (пункт 2): берём порядок прошлой отрисовки,
   * подставляя свежие представления строк по ключу. Строка, которой в свежих
   * данных нет (перестала быть задачей), остаётся с прежним снапшотом до
   * «Обновить»; новая строка появится после «Обновить» — маркер уже зажжён.
   */
  function holdSections(
    held: readonly TaskPanelSectionView[],
    fresh: readonly TaskPanelSectionView[],
  ): TaskPanelSectionView[] {
    const byKey = new Map<string, TaskPanelRow>();
    for (const section of fresh) {
      for (const row of section.rows ?? []) byKey.set(row.key, row);
    }
    return held.map((section) => ({
      ...section,
      rows: (section.rows ?? []).map((row) => byKey.get(row.key) ?? row),
    }));
  }

  /** Базовый фильтр выборки: «за период» или «по мысли». */
  function baseFilter(scope: TaskScope): TaskMassFilter {
    const today = todayLocal();
    if (source.kind === 'thought') {
      return { scope, thought_id: source.ownerId, today };
    }
    const period = effectivePeriod();
    return { scope, from: period.from, to: period.to, today };
  }

  /** Меню «⋮» шапки панели карточки мысли: массовые команды по этой мысли. */
  function thoughtHeadMenu(): MenuItem[] {
    const filter = baseFilter('open');
    return [
      menuAction(t('tasks.cancelAllThought'), () => void runBulk(filter, 'cancel-all')),
      menuSubmenu(t('tasks.moveAllThought'), [
        menuAction(t('tasks.shiftDay'), () => void runBulk(filter, 'move-all', { days: 1 })),
        menuAction(t('tasks.shiftWeek'), () => void runBulk(filter, 'move-all', { days: 7 })),
        menuAction(t('tasks.shiftMonth'), () => void runBulk(filter, 'move-all', { months: 1 })),
        MENU_SEPARATOR,
        menuAction(t('tasks.moveDate'), () => void pickBulkDate(filter)),
      ]),
      menuAction(t('tasks.undateAllThought'), () => void runBulk(filter, 'undate-all')),
    ];
  }

  // -------------------------------------------------------------------------
  // Кэш ревизий, устаревание, операции
  // -------------------------------------------------------------------------

  /** Запомнить ревизию комментария-источника (адрес `expected_revision`). */
  function rememberVersion(commentId: string, version: number): void {
    commentVersions.set(commentId, Math.max(commentVersions.get(commentId) ?? 0, version));
    if (version > state.maxRevision) state.maxRevision = version;
  }

  /**
   * Запомнить токен СВОЕЙ операции: по нему гасится только её эхо. Эхо,
   * пришедшее ДО ответа (событие публикуется сервером раньше ответа), уже
   * погашено признаком «запись в полёте» — токен для него не нужен.
   */
  function rememberOwnOp(commentId: string, version: number): void {
    const token = `${commentId}:${version}`;
    if (echoedOwnVersions.delete(token)) return;
    ownOpTokens.add(token);
  }

  /** Выполнить свою запись: её событие до ответа считается своим эхом. */
  async function withOwnWrite<T>(commentId: string, run: () => Promise<T>): Promise<T> {
    pendingOwnWrites.add(commentId);
    try {
      return await run();
    } finally {
      pendingOwnWrites.delete(commentId);
    }
  }

  /** Применить новые ревизии источников после операции. */
  function applyRevisions(revisions: readonly Comment[] | undefined): void {
    for (const revision of revisions ?? []) {
      rememberVersion(revision.id, revision.version);
      rememberOwnOp(revision.id, revision.version);
    }
  }

  /**
   * Ревизия источника строки — для `expected_revision` операций. Сначала
   * известная ревизия комментария: правка одной строки поднимает ревизию всей
   * записи, и снапшот соседней строки уже отстал.
   */
  function revisionOf(row: TaskPanelRow): number {
    const known = commentVersions.get(row.commentId);
    if (known !== undefined) return known;
    const ref = allRows().find(
      (item) => item.comment_id === row.commentId && item.line_no === row.lineNo,
    );
    return ref?.revision ?? 1;
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
   * Это КОМАНДА, а не правка текста, поэтому серая строка тоже переключается,
   * а серой становится ТОЛЬКО эта строка (ошибка d318a647). Своя команда
   * снапшот текста не устаревает (маркер `[ ]`/`[x]` в показываемый текст не
   * входит), поэтому строка остаётся в списке свежей и повторный клик снимает
   * отметку (замечание 3 вердикта `e984a2db`).
   *
   * **Маркер (0.16.1, задача `cfb8cb72`, пункт 4 — пересмотр решения 45480290).**
   * Отметка выполнения меняет состав секций (строка уходит из открытых),
   * поэтому она зажигает «Обновить»: списки пересобираются только по кнопке.
   */
  async function toggleTask(row: TaskPanelRow, done: boolean): Promise<void> {
    const networkId = requireNetworkId();
    const address = row.key;
    try {
      const result = await withOwnWrite(row.commentId, () =>
        etn.tasks.patch(networkId, {
          ops: [
            {
              comment_id: row.commentId,
              line_no: row.lineNo,
              action: 'toggle',
              done,
              expected_revision: revisionOf(row),
            },
          ],
        }),
      );
      const first = result.results[0];
      if (first !== undefined && !first.ok) {
        notice(taskErrorText(first.error), 'error');
        return;
      }
      applyRevisions(result.revisions);
      toggledDone.set(address, done);
      ownRebuildPending = true;
      renderView();
    } catch (err) {
      staleRows.add(address);
      renderView();
      notice(t('tasks.errorToggle', [errText(err)]), 'error');
    }
  }

  /**
   * Чекбокс ПУНКТА ЧЕК-ЛИСТА под задачей (замечание 4 ТЗ 2026-11-18). Пункт не
   * является задачей проекции, поэтому `PATCH /tasks` для него возвращает
   * `not_a_task` — отметка ставится правкой текста источника и точечным
   * перечитыванием записи.
   */
  async function toggleChild(
    row: TaskPanelRow,
    child: TaskPanelChildRow,
    done: boolean,
  ): Promise<void> {
    const networkId = requireNetworkId();
    try {
      const comment = await etn.comments.get(networkId, row.commentId);
      const line = comment.body_md.split('\n')[child.lineNo];
      if (line === undefined) {
        notice(taskErrorText('line_not_found'), 'error');
        return;
      }
      const next = setChecklistLineDone(line, done);
      if (next === null) {
        notice(taskErrorText('not_a_task'), 'error');
        return;
      }
      if (next === line) return;
      const updated = await withOwnWrite(row.commentId, () =>
        etn.comments.update(
          networkId,
          row.commentId,
          { body_md: replaceTaskLine(comment.body_md, child.lineNo, next) ?? comment.body_md },
          comment.version,
        ),
      );
      rememberVersion(row.commentId, updated.version);
      rememberOwnOp(row.commentId, updated.version);
      await refreshAfterOwnOp(row.commentId, updated.version);
      renderView();
    } catch (err) {
      notice(t('tasks.errorEdit', [errText(err)]), 'error');
    }
  }

  /**
   * Сырая строка `body_md` для инлайн-правки. Компонент показывает снапшот без
   * маркера (`TaskDTO.text`), поэтому править его нельзя — читаем источник.
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

  /**
   * Сырой блок источника для БЛОЧНОЙ правки: строка задачи и все её вложенные
   * строки (замечание 3 ТЗ 2026-11-18, образец — блочная правка трансклюзии).
   */
  async function loadRawBlock(
    row: TaskPanelRow,
  ): Promise<{ start: number; end: number; text: string } | null> {
    const networkId = requireNetworkId();
    const end = row.children.reduce((max, child) => Math.max(max, child.lineNo), row.lineNo);
    try {
      const comment = await etn.comments.get(networkId, row.commentId);
      const lines = comment.body_md.split('\n');
      if (row.lineNo < 0 || end >= lines.length) {
        notice(taskErrorText('line_not_found'), 'error');
        return null;
      }
      return { start: row.lineNo, end, text: lines.slice(row.lineNo, end + 1).join('\n') };
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
      const beforeRows = rowsOfComment(row.commentId);
      const updated = await withOwnWrite(row.commentId, () =>
        etn.comments.update(networkId, row.commentId, { body_md: next }, comment.version),
      );
      rememberVersion(row.commentId, updated.version);
      rememberOwnOp(row.commentId, updated.version);
      // Сохранённая строка перечитывается ТОЧЕЧНО: панель показывает новый
      // текст сразу и не сереет (ошибка 45480290). Порядок строк при этом
      // ДЕРЖИТСЯ: после Ctrl+Enter строка не прыгает вниз списка (пункт 2).
      const fresh = await refreshAfterOwnOp(row.commentId, updated.version);
      holdTaskOrder = true;
      if (fresh === null || ownEditStructureChanged(beforeRows, fresh, row.commentId)) {
        ownRebuildPending = true;
      }
      renderView();
      return true;
    } catch (err) {
      notice(t('tasks.errorEdit', [errText(err)]), 'error');
      return false;
    }
  }

  /** Блочная правка диапазона строк источника (замечание 3 ТЗ 2026-11-18). */
  async function editBlock(
    row: TaskPanelRow,
    range: { start: number; end: number },
    text: string,
  ): Promise<boolean> {
    const networkId = requireNetworkId();
    try {
      const comment = await etn.comments.get(networkId, row.commentId);
      const next = replaceTaskLineRange(comment.body_md, range.start, range.end, text);
      if (next === null) {
        notice(taskErrorText('line_not_found'), 'error');
        return false;
      }
      if (next === comment.body_md) return true;
      const beforeRows = rowsOfComment(row.commentId);
      const updated = await withOwnWrite(row.commentId, () =>
        etn.comments.update(networkId, row.commentId, { body_md: next }, comment.version),
      );
      rememberVersion(row.commentId, updated.version);
      rememberOwnOp(row.commentId, updated.version);
      // Блочная правка тоже держит порядок (пункт 2): пересборка — по «Обновить»,
      // маркер зажигается, если изменились сроки/состав строк записи.
      const fresh = await refreshAfterOwnOp(row.commentId, updated.version);
      holdTaskOrder = true;
      if (fresh === null || ownEditStructureChanged(beforeRows, fresh, row.commentId)) {
        ownRebuildPending = true;
      }
      renderView();
      return true;
    } catch (err) {
      notice(t('tasks.errorEdit', [errText(err)]), 'error');
      return false;
    }
  }

  /**
   * Перечитать строки ОДНОГО комментария-источника после инлайн-правки (ошибка
   * 45480290): новый текст виден сразу, «Обновить» для этого не нужна. Вместе
   * со строками обновляются вложенные строки записи (пункт F) — правка блока
   * могла изменить пункты чек-листа.
   */
  async function refreshCommentRows(commentId: string, version?: number): Promise<TaskDTO[]> {
    const networkId = requireNetworkId();
    if (version !== undefined) rememberVersion(commentId, version);
    const fresh: TaskDTO[] = [];
    const freshNested: TaskNestedLine[] = [];
    let cursor: string | undefined;
    let complete = true;
    do {
      const page = await etn.tasks.list(networkId, {
        comment_id: commentId,
        today: todayLocal(),
        limit: TASKS_PAGE_LIMIT,
        include_nested: true,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      fresh.push(...page.items);
      freshNested.push(...(page.nested ?? []));
      cursor = page.cursor ?? undefined;
      if (cursor !== undefined) complete = false;
    } while (cursor !== undefined);

    if (source.kind === 'period') {
      const buckets: Array<{
        key: 'period' | 'overdue' | 'undated' | 'done';
        filter: TaskMassFilter;
      }> = [
        { key: 'period', filter: baseFilter('open') },
        { key: 'overdue', filter: baseFilter('overdue') },
        { key: 'undated', filter: baseFilter('undated') },
        { key: 'done', filter: baseFilter('done') },
      ];
      if (!complete) {
        // Неполная выборка: заменяем только прочитанные строки, место строки в
        // секции сохраняем (пересборка по неполным данным потеряла бы строки).
        const byKey = new Map(fresh.map((item) => [taskRowKey(item), item]));
        state = {
          ...state,
          period: state.period.map((item) => byKey.get(taskRowKey(item)) ?? item),
          overdue: state.overdue.map((item) => byKey.get(taskRowKey(item)) ?? item),
          undated: state.undated.map((item) => byKey.get(taskRowKey(item)) ?? item),
          done: state.done.map((item) => byKey.get(taskRowKey(item)) ?? item),
        };
      } else {
        // Полная выборка записи: строки записи уходят из всех секций и встают в
        // те, которым отвечают сейчас (правка могла сменить срок и отметку).
        const next: TaskListState = {
          ...state,
          period: state.period.filter((item) => item.comment_id !== commentId),
          overdue: state.overdue.filter((item) => item.comment_id !== commentId),
          undated: state.undated.filter((item) => item.comment_id !== commentId),
          done: state.done.filter((item) => item.comment_id !== commentId),
        };
        for (const item of fresh) {
          for (const bucket of buckets) {
            if (taskRowsForFilter([item], bucket.filter).length > 0) next[bucket.key].push(item);
          }
        }
        state = next;
      }
    } else {
      // Карточка мысли: строки записи заменяются целиком, в выборке остаются
      // только строки этой мысли (зеркало серверного отбора `thought_id`).
      const member = taskRowsForFilter(fresh, baseFilter('open'));
      state = {
        ...state,
        rows: [...state.rows.filter((item) => item.comment_id !== commentId), ...member],
      };
    }

    // Вложенные строки записи: полная выборка — заменяются целиком, неполная —
    // обновляются по адресу пары «родитель + строка».
    const others = state.nested.filter((line) => line.comment_id !== commentId);
    if (complete) {
      state = { ...state, nested: [...others, ...freshNested] };
    } else {
      const freshKeys = new Set(freshNested.map((line) => `${line.comment_id}:${line.line_no}`));
      state = {
        ...state,
        nested: [
          ...others,
          ...state.nested.filter(
            (line) =>
              line.comment_id === commentId && !freshKeys.has(`${line.comment_id}:${line.line_no}`),
          ),
          ...freshNested,
        ],
      };
    }
    for (const item of fresh) rememberVersion(item.comment_id, item.revision);
    return fresh;
  }

  /**
   * Перечитать строки после СВОЕЙ операции. Сбой перечитывания запись не
   * отменяет, но снапшот тогда честно устарел: запись помечается серой, и
   * «Обновить» поднимется (маркер — следствие реальной потери актуальности, а не
   * собственной правки).
   */
  async function refreshAfterOwnOp(commentId: string, version?: number): Promise<TaskDTO[] | null> {
    try {
      return await refreshCommentRows(commentId, version);
    } catch {
      staleComments.add(commentId);
      return null;
    }
  }

  /** Абсолютная дата «перенести на…» → серверный сдвиг в днях. */
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

  /**
   * Команда строки: открыть источник / перенести даты / сделать бессрочной /
   * отменить задачу. «Перенести на дату» — операция `set_due`.
   */
  async function runRowCommand(
    row: TaskPanelRow,
    command: TaskRowCommand,
    shift?: TaskShift,
  ): Promise<void> {
    if (command === 'open-source') {
      if (actions.openRowSource !== undefined) {
        actions.openRowSource(row);
        return;
      }
      const day = row.due ?? row.periodFrom;
      if (day !== null) actions.openDay?.(day);
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
        action = 'set_due';
        payload = { date: shift.date };
      } else {
        action = 'move';
        payload = shift ?? {};
      }
    } else if (command === 'undate') {
      action = 'undate';
    }
    try {
      const result = await withOwnWrite(row.commentId, () =>
        etn.tasks.patch(networkId, {
          ops: [
            {
              comment_id: row.commentId,
              line_no: row.lineNo,
              action,
              ...payload,
              expected_revision: revisionOf(row),
            },
          ],
        }),
      );
      const first = result.results[0];
      if (first !== undefined && !first.ok) {
        notice(taskErrorText(first.error), 'error');
        return;
      }
      applyRevisions(result.revisions);
      // Команда переписала даты строки: сами строки перечитываются сразу (без
      // серости — ошибка 45480290), но СЕКЦИИ пересобираются только по
      // «Обновить» (0.16.1, задача cfb8cb72, пункт 2): смена срока зажигает
      // маркер, строка остаётся на месте.
      const beforeRows = rowsOfComment(row.commentId);
      const revision = result.revisions.find((item) => item.id === row.commentId)?.version;
      const fresh = await refreshAfterOwnOp(row.commentId, revision);
      if (fresh === null || ownEditStructureChanged(beforeRows, fresh, row.commentId)) {
        ownRebuildPending = true;
      }
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

  /** Строки, по которым считается и исполняется массовая команда. */
  function bulkRows(): TaskDTO[] {
    if (source.kind === 'period') {
      return [...state.period, ...state.overdue, ...state.undated];
    }
    return visibleRows(state.rows);
  }

  /** «Перенести… на дату» для массовой команды: произвольная дата. */
  async function pickBulkDate(filter: TaskMassFilter): Promise<void> {
    const date = await pickDate(todayLocal());
    if (date !== null) await runBulk(filter, 'move-all', { date });
  }

  /** Массовая команда группы: подтверждение со сводкой → команда → undo. */
  async function runBulk(
    filter: TaskMassFilter,
    command: TaskMassAction,
    shift?: TaskShift,
  ): Promise<void> {
    const networkId = requireNetworkId();
    const plan = planTaskBulk(bulkRows(), filter);
    if (plan.rows.length === 0) {
      notice(t('tasks.bulkEmpty'), 'info');
      return;
    }
    let effectiveShift = shift;
    if (command === 'move-all' && shift?.date !== undefined) {
      const resolved = shiftToDate(todayLocal(), shift.date);
      if (resolved === null) {
        notice(t('tasks.moveNotNeeded'), 'info');
        return;
      }
      effectiveShift = resolved;
    }
    const confirmed = await confirmDialog(
      t('tasks.bulkTitle'),
      t(bulkQuestionKey(command), [plan.rows.length]),
      // Красная кнопка — только у снятия задач: снятие дат отменяется «Отменить».
      command === 'cancel-all',
    );
    if (!confirmed || disposed) return;
    // Массовая команда — тоже СВОЯ запись: пока она в полёте, её события не
    // считаются внешним изменением (сервер публикует их раньше ответа).
    for (const id of plan.commentIds) pendingOwnWrites.add(id);
    try {
      // Прежние тексты — для отмены команды (undo): правки идут в записях-
      // источниках, поэтому откат — восстановление `body_md` с новой ревизией.
      if (withUndo) {
        const snapshot = await Promise.all(
          plan.commentIds.map((id) => etn.comments.get(networkId, id)),
        );
        undoSnapshot = snapshot.map((comment) => ({
          id: comment.id,
          body_md: comment.body_md,
          version: comment.version,
        }));
      }
      const result = await etn.tasks.patch(networkId, {
        action: command,
        filter,
        ...(effectiveShift !== undefined ? effectiveShift : {}),
      });
      applyRevisions(result.revisions);
      const failed = result.results.filter((item) => !item.ok);
      if (failed.length > 0) {
        notice(t('tasks.bulkPartial', [failed.length]), 'warning');
      }
      await loadPanel();
      actions.onRecordsChanged?.();
    } catch (err) {
      undoSnapshot = null;
      notice(t('tasks.bulkFailed', [errText(err)]), 'error');
    } finally {
      for (const id of plan.commentIds) pendingOwnWrites.delete(id);
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
      actions.onRecordsChanged?.();
    } catch (err) {
      notice(t('tasks.undoFailed', [errText(err)]), 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Напоминания и субъекты
  // -------------------------------------------------------------------------

  /** Действие над вхождением напоминания. */
  async function runReminderAction(
    row: ReminderPanelRow,
    action: ReminderRowAction,
    until?: string,
  ): Promise<void> {
    const networkId = requireNetworkId();
    try {
      if (action === 'open-subject') {
        openSubjectInternal({ kind: row.subjectType, id: row.subjectId, title: row.title });
        return;
      }
      if (action === 'edit-schedule') {
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
          onRemoved: () => {
            void loadPanel();
          },
        });
        return;
      }
      if (action === 'dismiss') {
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
   * Чекбокс вхождения напоминания (0.16.1, задача `cfb8cb72`, пункт 7): отметка
   * «выполнено» = отработал вхождение, то есть dismiss по `occurrence_at`.
   * Серия напоминания НЕ удаляется. «Обновить» светится, а вхождение уходит из
   * списка только после полного перечитывания (списки пересобираются по кнопке).
   */
  async function markReminderDone(row: ReminderPanelRow): Promise<void> {
    const networkId = requireNetworkId();
    try {
      await etn.reminders.dismiss(networkId, row.reminderId, row.occurrenceAt);
      reminderDoneKeys.add(row.key);
      ownRebuildPending = true;
      renderView();
    } catch (err) {
      notice(t('tasks.reminderActionFailed', [errText(err)]), 'error');
    }
  }

  /**
   * Групповая команда «Отменить все напоминания по группе»: убрать каждое
   * вхождение строк группы. Ошибка одной строки не отменяет остальные.
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
        // Строка могла исчезнуть/смениться между загрузкой и командой.
      }
    }
    notice(t('reminder.groupDismissDone', [removed]));
    await loadPanel();
  }

  /**
   * «Создать задачу на сегодня»: строка в СЕГОДНЯШНЕЙ хроно-записи; записи дня
   * нет — она создаётся (требование `7fcdf583`). Расписание напоминания
   * продолжается.
   *
   * **Строго дневная запись (0.16.1, пачка 4, пункт 5).** Цель — запись, ЧЬИ
   * сутки и есть сегодня: интервал `valid_from`..`valid_to` целиком внутри
   * локальных суток (`dailyRecordsOf`). Раньше бралась первая запись,
   * НАКРЫВАЮЩАЯ сегодня, — задача попадала в период («Задачник на неделю»).
   * Дневной нет — создаётся запись дня по правилам «Записи дня»: владелец HOME,
   * сутки от начала до конца дня.
   *
   * **Идемпотентность (пункт 4).** Повторный клик не плодит дубли: если в
   * сегодняшней дневной записи уже есть задача этого субъекта на сегодня
   * (`findTaskLineForDay`), строка не добавляется. Отменённая строка этого же
   * субъекта за день НЕ дублируется второй строкой — ей возвращается маркер
   * (`addTaskLineMarker`), иначе связка «Создать → Отменить → Создать» копила
   * бы пункты-обрезки. Пока создание в полёте, второй клик игнорируется: два
   * чтения до записи дали бы две строки.
   *
   * **Переход и тост (пункт 3).** После создания — переход к строке записи
   * штатным входом «Открыть источник» (`openCreatedTask`) и тост «Создана
   * задача на <дата>».
   */
  async function createTaskForToday(row: ReminderPanelRow): Promise<void> {
    const networkId = requireNetworkId();
    const today = todayLocal();
    const subjectId = row.subjectType === 'thought' ? row.subjectId : null;
    const text =
      subjectId === null ? `${row.title} [[${today}]]` : `[[#${subjectId}]] [[${today}]]`;
    const line = `- [ ] ${text}`;
    const inFlightKey = `${row.subjectType}:${row.subjectId}:${row.occurrenceAt}`;
    if (creatingForToday.has(inFlightKey)) return;
    creatingForToday.add(inFlightKey);
    try {
      const home = await import('../home.js').then((mod) => mod.getHomeId(networkId));
      const comments = await etn.comments.list(networkId, 'thought', home);
      const daily = dailyRecordsOf(comments, today);
      // Строка субъекта за сегодня уже есть: дубль не создаём, пользователь
      // попадает на существующую (повторный клик или второе окно).
      for (const record of daily) {
        const found = findTaskLineForDay(record.body_md, { day: today, subjectId, text });
        if (found === null) continue;
        if (!found.task) {
          // Отменённая строка того же субъекта: возвращаем ей маркер, а не
          // плодим рядом вторую (пункт 4). Сбой возврата — обычное создание.
          const lines = record.body_md.split('\n');
          const restored = addTaskLineMarker(lines[found.lineNo] ?? '');
          if (restored !== null) {
            lines[found.lineNo] = restored;
            await etn.comments.update(
              networkId,
              record.id,
              { body_md: lines.join('\n') },
              record.version,
            );
            actions.onRecordsChanged?.();
            notifyTaskCreated(today, { commentId: record.id, lineNo: found.lineNo });
            await loadPanel();
            return;
          }
        }
        notifyTaskCreated(today, { commentId: record.id, lineNo: found.lineNo });
        return;
      }
      const target = daily[0];
      let commentId: string;
      let lineNo: number;
      if (target !== undefined) {
        // Строка дописывается в конец: остальное тело записи не трогаем.
        const base =
          target.body_md === ''
            ? ''
            : target.body_md.endsWith('\n')
              ? target.body_md
              : `${target.body_md}\n`;
        lineNo = base === '' ? 0 : base.split('\n').length - 1;
        await etn.comments.update(
          networkId,
          target.id,
          { body_md: `${base}${line}` },
          target.version,
        );
        commentId = target.id;
      } else {
        const created = await etn.comments.createMulti(
          networkId,
          [{ owner_type: 'thought', owner_id: home }],
          {
            kind: 'chronological',
            title: null,
            body_md: line,
            valid_from: localDayStart(today),
            valid_to: localDayEnd(today),
            use_time: false,
          },
        );
        commentId = created.id;
        lineNo = 0;
      }
      actions.onRecordsChanged?.();
      notifyTaskCreated(today, { commentId, lineNo });
      await loadPanel();
    } finally {
      creatingForToday.delete(inFlightKey);
    }
  }

  /**
   * Тост «Создана задача на <дата>» и переход к строке (пункт 3). Порядок
   * один для создания и для найденного дубля: пользователь видит, где строка.
   */
  function notifyTaskCreated(day: string, ref: { commentId: string; lineNo: number }): void {
    notice(t('tasks.createdForToday', [formatDate(new Date(`${day}T00:00:00`))]), 'success');
    actions.openCreatedTask?.(ref);
  }

  /** Открыть субъект панели: экран решает, иначе — обычный переход клиента. */
  function openSubjectInternal(subject: TaskPanelSubject): void {
    if (actions.openSubject !== undefined) {
      actions.openSubject(subject);
      return;
    }
    void openSubjectDefault(subject);
  }

  /** Переход по умолчанию: мысль — в редактор, публикация — в рабочую область. */
  async function openSubjectDefault(subject: TaskPanelSubject): Promise<void> {
    try {
      if (subject.kind === 'thought') {
        const { openThoughtInEditor } = await import('../../editor/editor.js');
        openThoughtInEditor(subject.id);
        return;
      }
      const { openPublicationInWorkspace } = await import('../../screens/active-view.js');
      await openPublicationInWorkspace(subject.id);
    } catch {
      // Переход — побочный эффект: сбой навигации не ломает панель.
    }
  }

  /**
   * Облачко субъекта (пункты C/E ТЗ 2026-11-17, замечание 5 ТЗ 2026-11-18):
   * эталонное облачко мысли/публикации с ДЕЙСТВИЯМИ — клик открывает субъект,
   * правый клик открывает общее меню мысли вне холста.
   */
  function renderSubject(hostEl: HTMLElement, subject: TaskPanelSubject): void {
    if (subject.kind === 'publication') {
      const cloud = createPublicationCloud(
        { id: subject.id, title: subject.title },
        { width: 'container' },
      );
      cloud.addEventListener('click', () => openSubjectInternal(subject));
      hostEl.append(cloud);
      return;
    }
    const data = subjectData.get(`thought:${subject.id}`);
    const input: ThoughtCloudInput = data ?? { id: subject.id, title: subject.title };
    const cloud = createThoughtCloud(input, {
      profile: 'chip',
      width: 'container',
      actions: {
        onClick: (id) =>
          openSubjectInternal({ kind: 'thought', id, title: subjectTitle('thought', id) }),
        onContextMenu: (event, id) => {
          event.stopPropagation();
          void openThoughtMenu(event, id);
        },
      },
    });
    hostEl.append(cloud);
  }

  /** Общее меню мысли вне холста (единственный вход `showOutOfCanvasThoughtMenu`). */
  async function openThoughtMenu(event: MouseEvent, id: string): Promise<void> {
    try {
      const { showOutOfCanvasThoughtMenu } = await import('../../canvas/context-menu.js');
      await showOutOfCanvasThoughtMenu(
        { event },
        { id, title: subjectTitle('thought', id), dir: 'siblings' },
      );
    } catch {
      // Меню — побочный эффект: сбой навигации не ломает панель.
    }
  }

  /**
   * Клик по заголовку группы-мысли ведёт к субъекту: облачко заголовка — то же
   * эталонное облачко с действиями (замечание 5 ТЗ 2026-11-18), отдельного
   * обработчика подписи не нужно.
   */

  // -------------------------------------------------------------------------
  // Realtime: маркер «Обновить» поднимается ЛЮБЫМ изменением сети
  // -------------------------------------------------------------------------

  /** Комментарии-источники, загруженные в панель. */
  function loadedCommentIds(): Set<string> {
    return new Set(allRows().map((row) => row.comment_id));
  }

  /**
   * Есть ли в тексте хоть одна строка задачи `- [ ]` (0.16.1, пачка 3,
   * пункт 5): по ней решается, может ли правка НЕзагруженного постоянного
   * комментария изменить секцию «Без срока».
   */
  function bodyHasTaskLine(md: unknown): boolean {
    // Грамматика маркера — только в @etn/markdown (сторож единого рендерера).
    return typeof md === 'string' && md.split('\n').some(isTaskLineMarker);
  }

  /**
   * Релевантность `comment.updated` строкам задач (0.16.1, пачка 3, пункт 5):
   * строки живут в `body_md` источника, поэтому событие с непустым `changes`
   * без `body_md` (title, targets, период комментария) панель не трогает.
   * Пустой/отсутствующий `changes` — неизвестно, считаем релевантным.
   */
  function taskChangesRelevant(changes: unknown): boolean {
    if (changes === null || typeof changes !== 'object') return true;
    const keys = Object.keys(changes as Record<string, unknown>);
    return keys.length === 0 || keys.includes('body_md');
  }

  /**
   * Постоянный комментарий, которого нет среди загруженных строк, меняет
   * панель «Дневника» только если в новом тексте появились строки задач: у
   * постоянного комментария задачи живут в сквозной секции «Без срока».
   * Иначе его правка (например, обычный текст комментария мысли) — не повод
   * перерисовывать список (живой дефект пачки 3, пункт 5).
   */
  function permanentTaskRelevant(id: string | undefined, changes: unknown): boolean {
    if (source.kind !== 'period') return true;
    if (id !== undefined && loadedCommentIds().has(id)) return true;
    const md =
      changes !== null && typeof changes === 'object'
        ? (changes as { body_md?: unknown }).body_md
        : undefined;
    return bodyHasTaskLine(md);
  }

  /**
   * Таймер автоперечитывания панели на событие комментария (0.16.1, уточнение
   * 2026-11-19, пункт 4). Зона «Задачи» редактора мысли обязана показать новую
   * задачу сразу после сохранения записи, не дожидаясь смены мысли: сохранение —
   * это `comment.updated`/`comment.created`, панель перечитывается сама.
   */
  let autoRefreshTimer: number | null = null;

  /**
   * Запланировать автоперечитывание панели. Включается только опцией
   * {@link TaskListViewOptions.autoRefreshOnCommentChange} (зона редактора):
   * панель «Дневника» работает штатным маркером «Обновить», где перечитывание
   * решает пользователь. Дебаунс склеивает пачку событий одной записи.
   */
  function scheduleAutoRefresh(): void {
    if (view.autoRefreshOnCommentChange !== true) return;
    if (autoRefreshTimer !== null) window.clearTimeout(autoRefreshTimer);
    autoRefreshTimer = window.setTimeout(() => {
      autoRefreshTimer = null;
      if (!disposed) void loadPanel();
    }, AUTO_REFRESH_DEBOUNCE_MS);
  }

  const unsubscribe = onRoutedRealtimeEvent((event) => {
    if (disposed) return;
    if (event.network_id !== store.state.networkId) return;
    if (event.type === 'reminders.changed') {
      if (withReminders) {
        remindersChanged = true;
        renderView();
      }
      return;
    }
    if (event.type === 'comment.updated') {
      const data = event.data as {
        id?: string;
        version?: unknown;
        kind?: unknown;
        changes?: unknown;
      };
      const version = typeof data.version === 'number' ? data.version : null;
      const id = data.id;
      if (id !== undefined && version !== null) {
        // Сервер публикует событие ДО ответа на запись: пока своя запись в
        // полёте, её эхо узнаётся по признаку записи, а не по токену версии.
        if (pendingOwnWrites.has(id)) {
          echoedOwnVersions.add(`${id}:${version}`);
          return;
        }
        // Эхо СВОЕЙ операции гасится только по её токену: запись целиком
        // красить нельзя — соседние строки остаются рабочими (ошибка d318a647).
        // Сравнение с сохранённой версией глушило чужие события (замечание 2).
        if (ownOpTokens.delete(`${id}:${version}`)) return;
        // Ревизия не новее загруженной: изменение уже отражено снапшотом
        // (позднее эхо своей операции после перечитывания).
        if (version <= (commentVersions.get(id) ?? 0)) return;
      }
      // Релевантность (0.16.1, пачка 3, пункт 5): правка постоянного
      // комментария без строк задач и правка не-текстовых полей строк панели
      // не меняют — ни маркера, ни перерисовки.
      if (!taskChangesRelevant(data.changes)) return;
      if (data.kind === 'permanent' && !permanentTaskRelevant(id, data.changes)) return;
      // Панель на автоперечитывании (зона «Задачи» редактора мысли) серости и
      // маркера не показывает: перечитывание придёт по дебаунсу и точечно
      // патчит изменившиеся строки (пачка 4, пункт 2). Иначе строка мигала
      // серым, а «Обновить» зажигалась и гасла сама, без действия человека.
      if (view.autoRefreshOnCommentChange === true) {
        scheduleAutoRefresh();
        return;
      }
      // Чужое изменение записи поднимает маркер панели — в том числе у
      // комментария, которого панель не загружала (новая задача в периоде).
      foreignChange = true;
      if (id !== undefined && loadedCommentIds().has(id)) staleComments.add(id);
      renderView();
      scheduleAutoRefresh();
      return;
    }
    if (event.type === 'comment.created' || event.type === 'comment.deleted') {
      const data = event.data as {
        comment?: { id?: string; kind?: string; body_md?: string };
        id?: string;
      };
      const id = data.comment?.id ?? data.id;
      // Релевантность (0.16.1, пачка 3, пункт 5): удаление записи, которой в
      // панели «Дневника» нет, состава строк не меняет; создание постоянного
      // комментария без строк задач — тоже.
      if (
        event.type === 'comment.deleted' &&
        source.kind === 'period' &&
        (id === undefined || !loadedCommentIds().has(id))
      ) {
        return;
      }
      if (
        event.type === 'comment.created' &&
        source.kind === 'period' &&
        data.comment?.kind === 'permanent' &&
        !bodyHasTaskLine(data.comment.body_md)
      ) {
        return;
      }
      // Автоперечитывание — без серости и маркера (пункт 2, см. выше).
      if (view.autoRefreshOnCommentChange === true) {
        scheduleAutoRefresh();
        return;
      }
      foreignChange = true;
      if (id !== undefined && loadedCommentIds().has(id)) staleComments.add(id);
      renderView();
      scheduleAutoRefresh();
    }
  });

  // -------------------------------------------------------------------------
  // Жизненный цикл
  // -------------------------------------------------------------------------

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
      if (autoRefreshTimer !== null) {
        window.clearTimeout(autoRefreshTimer);
        autoRefreshTimer = null;
      }
      retryStop?.();
      retryStop = null;
      unsubscribe();
      panel.destroy();
    },
    headActions(): HTMLElement[] {
      return panel.headActions();
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
