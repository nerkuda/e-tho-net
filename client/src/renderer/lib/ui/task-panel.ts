/**
 * Панель «Задачи и напоминания» — библиотечная компонента `lib/ui` (0.16.1,
 * задача 64f7976a; элементы f76ed829 «Группа «Задачи периода»», 15f8ea2f
 * «Группа «Напоминания периода»», 498f23e0 «Строка задачи в группе»;
 * требования 6762adb0/0e85b66e/e6af8b9e/3616cfec/db1d9548).
 *
 * **Роль.** Панель стоит НАД лентой «Дневника», вне блоков дней, и при любом
 * периоде одна: каждый список показан один раз. Компонент не знает сети —
 * данные и действия приходят колбэками от экрана
 * (`screens/chronicle/tasks-panel.ts`), а правила группировки/секций/счётчиков
 * живут в чистой модели `task-panel-model.ts`.
 *
 * **Списки инкрементальны.** Группы и строки обновляются keyed-сверкой
 * (`keyed-list.ts`): неизменные узлы не пересоздаются, поэтому hover, фокус и
 * открытая инлайн-правка переживают перечитывание панели (стандарт
 * «Списки рендерятся инкрементально», сторож `guard-keyed-lists`).
 * Клавиатурная навигация — общим ядром `list.ts`/`nav-core.ts`: своего
 * обработчика стрелок у панели нет (сторож `guard-list-nav`).
 *
 * **Команды — только при hover.** У строки — команды строки (открыть источник,
 * перенести даты, отменить), у заголовка группы — подменю «⋮»; подвалов с
 * кнопками нет (спека f76ed829). Единственная постоянная кнопка — «Обновить»
 * вверху ПАНЕЛИ: она подсвечивается, когда данные устарели (требование
 * 0e85b66e), и полностью перерисовывает список из записей.
 *
 * **Строка задачи и правка.** Чекбокс — одиночный клик без режима правки;
 * двойной клик по тексту — инлайн-правка сырого markdown строки (Esc — отмена,
 * Enter — сохранение). Серая строка (внешнее изменение) не редактируется до
 * «Обновить». Клавиши правки (Enter/Escape) идут через общеклиентский диспетчер
 * контекстов `lib/keymap.ts`: пока поле в фокусе, его контекст на вершине стека
 * (ADR `b420b08c`, сторож `guard-keymap-single-point`).
 */

import type { TaskMassFilter } from '@etn/shared';

import { div, el, span } from '../dom.js';
import { t } from '../i18n.js';
import { defineKeyContext, pushKeyContext } from '../keymap.js';
import {
  MENU_SEPARATOR,
  menuAction,
  menuChoice,
  menuSubmenu,
  showMenuAt,
  type MenuItem,
} from '../menu.js';
import { badge } from './badge.js';
import { iconButton, uiButton } from './button.js';
import { choiceControl } from './choice-row.js';
import { loadingState } from './empty-state.js';
import { fieldInput } from './field.js';
import { svgIcon } from './icon.js';
import { reconcileKeyed } from './keyed-list.js';
import { createListNav, type ListNavHandle } from './list.js';
import { TABLE_ROW_KEY_ATTR } from './table.js';
import type {
  ReminderPanelRow,
  ReminderSectionKind,
  TaskGroupingMode,
  TaskPanelRow,
} from './task-panel-model.js';

export type {
  ReminderPanelRow,
  ReminderSectionKind,
  TaskGroupingMode,
  TaskPanelRow,
} from './task-panel-model.js';

/** Корневой класс панели (адрес CSS и тестов). */
export const TASK_PANEL_CLASS = 'ui-task-panel';

/** Класс группы («Задачи периода» / «Напоминания периода»). */
export const TASK_PANEL_GROUP_CLASS = 'ui-task-group';

/** Класс секции («Основная»/«Просрочено»/«Без срока», «Просрочено»/«Сегодня»). */
export const TASK_PANEL_SECTION_CLASS = 'ui-task-section';

/** Класс подгруппы порогов (по мыслям/датам/неделям/месяцам). */
export const TASK_PANEL_SUBGROUP_CLASS = 'ui-task-subgroup';

/** Класс строки задачи. */
export const TASK_PANEL_ROW_CLASS = 'ui-task-row';

/** Класс строки вхождения напоминания. */
export const REMINDER_PANEL_ROW_CLASS = 'ui-task-row ui-reminder-row';

/** Состояние «строка устарела» (серая, не редактируется). */
export const TASK_PANEL_ROW_STALE_CLASS = 'is-stale';

/** Подгруппа списка: заголовок + фильтр массовой команды + строки. */
export interface TaskPanelSubgroupView<T> {
  key: string;
  title: string;
  kind: TaskGroupingMode;
  /** Фильтр адресации массовой команды группы (требование e6af8b9e). */
  filter: TaskMassFilter;
  rows: T[];
}

/** Секция списка задач. */
export interface TaskPanelSectionView {
  key: string;
  title: string;
  subgroups: TaskPanelSubgroupView<TaskPanelRow>[];
}

/** Секция списка напоминаний. */
export interface ReminderPanelSectionView {
  key: ReminderSectionKind;
  title: string;
  subgroups: TaskPanelSubgroupView<ReminderPanelRow>[];
}

/** Что видит компонент при отрисовке (готовит экран). */
export interface TaskPanelView {
  /** Данные устарели: «Обновить» подсвечена (требование 0e85b66e). */
  stale: boolean;
  /**
   * Фильтр массовых команд «за период» — тот же период, что показан лентой
   * (from/to), иначе команда адресовала бы всю сеть (требование e6af8b9e).
   */
  periodFilter: TaskMassFilter;
  /** Есть что отменить после массовой команды. */
  canUndo: boolean;
  /** Переключатель показа выполненных (требование 6762adb0). */
  showDone: boolean;
  /** Счётчики «Задач периода»: открытые/выполненные. */
  counters: { open: number; done: number };
  /** Счётчик вхождений напоминаний. */
  reminderCount: number;
  /** Секции задач в порядке «Основная / Просрочено / Без срока». */
  taskSections: TaskPanelSectionView[];
  /** Секции напоминаний в порядке «Просрочено / Сегодня / Период». */
  reminderSections: ReminderPanelSectionView[];
  /** Идёт загрузка (первый показ/перечитывание). */
  loading: boolean;
  /** Текст ошибки загрузки, `null` — ошибки нет. */
  error: string | null;
}

/** Команда строки задачи. */
export type TaskRowCommand = 'open-source' | 'move' | 'cancel';

/**
 * Сдвиг дат строки (ровно один вид). `date` — абсолютная дата `YYYY-MM-DD`:
 * экран переводит её в серверный сдвиг (`days`) от срока строки (для строки)
 * или от «сегодня» (для массовой команды), период каждой строки сохраняется
 * (требования 236d4472/e6af8b9e).
 */
export interface TaskShift {
  days?: number;
  months?: number;
  date?: string;
}

/** Действие над вхождением напоминания. */
export type ReminderRowAction =
  'open-subject' | 'edit-schedule' | 'dismiss' | 'snooze' | 'create-task';

/** Реакции панели: всё, что требует сети/состояния экрана. */
export interface TaskPanelActions {
  /** «Обновить» — полное перечитывание панели из записей. */
  refresh(): void;
  /** «Отменить» последнюю массовую команду. */
  undo(): void;
  /** Переключатель «показывать выполненные». */
  setShowDone(show: boolean): void;
  /** Чекбокс строки: одиночный клик без режима правки. */
  toggle(row: TaskPanelRow, done: boolean): void;
  /**
   * Сырая строка `body_md` для инлайн-правки (с маркером и чекбоксом).
   * `null` — строку прочитать не удалось (экран уже показал ошибку).
   */
  loadRawLine(row: TaskPanelRow): Promise<string | null>;
  /**
   * Сохранить инлайн-правку СЫРОЙ строки. `true` — сохранено (компонент
   * выходит из правки), `false` — отказ экрана (правка остаётся открытой).
   */
  editLine(row: TaskPanelRow, rawLine: string): Promise<boolean>;
  /** Команда строки: открыть источник/перенести/отменить. */
  rowCommand(row: TaskPanelRow, command: TaskRowCommand, shift?: TaskShift): void;
  /** Массовая команда группы: отменить всё или перенести всё на сдвиг. */
  bulk(filter: TaskMassFilter, command: 'cancel-all' | 'move-all', shift?: TaskShift): void;
  /** Действие над вхождением напоминания. */
  reminderAction(row: ReminderPanelRow, action: ReminderRowAction, until?: string): void;
  /**
   * Групповая команда «Отменить все напоминания по группе»: убрать КАЖДОЕ
   * вхождение строк группы (одна операция dismiss на вхождение, требование
   * 500d1b3d). `title` — заголовок группы для вопроса подтверждения.
   */
  reminderGroupDismiss(title: string, rows: readonly ReminderPanelRow[]): void;
  /** Диалог даты (`YYYY-MM-DD`); `null` — отмена. */
  pickDate(initial: string): Promise<string | null>;
  /** Диалог даты/времени; `initialIso` — текущий момент, результат — UTC-инстанс. */
  pickDateTime(initialIso: string): Promise<string | null>;
  /** Переход к дню источника строки (клик по чипу даты/команда «Открыть источник»). */
  openDay(day: string): void;
  /** Отрисовка снапшота текста строки (markdown + кликабельные ссылки). */
  renderText(host: HTMLElement, row: TaskPanelRow): void;
}

/** Публичный дескриптор панели. */
export interface TaskPanelHandle {
  /** Отрисовать снимок (keyed-сверка; правка в процессе не сбрасывается). */
  render(view: TaskPanelView): void;
  /** Снять слушателей и навигацию. */
  destroy(): void;
}

/** Сдвиги, предлагаемые командой «Перенести на…». */
const TASK_SHIFTS: ReadonlyArray<{
  labelKey: 'tasks.shiftDay' | 'tasks.shiftWeek' | 'tasks.shiftMonth';
  shift: TaskShift;
}> = [
  { labelKey: 'tasks.shiftDay', shift: { days: 1 } },
  { labelKey: 'tasks.shiftWeek', shift: { days: 7 } },
  { labelKey: 'tasks.shiftMonth', shift: { months: 1 } },
];

/** Один лист навигации списка — строка задачи или вхождения. */
interface PanelEntry {
  key: string;
  kind: 'task' | 'reminder';
}

/** Контекст диспетчера клавиш для инлайн-правки строки. */
const INLINE_EDIT_CONTEXT_ID = 'task-panel-inline-edit';

/** Команды открытой правки: сохранить или отменить. */
interface InlineEditCommand {
  commit(): void;
  cancel(): void;
}

/** Открытые правки по полю ввода: событие адресуется цели нажатия. */
const inlineEditCommands = new WeakMap<HTMLInputElement, InlineEditCommand>();

/**
 * Объявить контекст клавиш инлайн-правки (Enter/Escape) в диспетчере.
 * Объявление идемпотентно (`defineKeyContext` перезаписывает тот же id),
 * поэтому состояние «уже объявлен» не хранится: после сброса реестра (тесты,
 * переустановка клавиатуры) контекст объявится снова.
 */
function ensureInlineEditContext(): void {
  defineKeyContext({
    id: INLINE_EDIT_CONTEXT_ID,
    bindings: [
      { command: 'taskRow.commit', chord: 'Enter', run: handleInlineEditKey },
      { command: 'taskRow.cancel', chord: 'Escape', run: handleInlineEditKey },
    ],
  });
}

/** Enter — сохранить строку, Escape — отменить; остальные клавиши не наши. */
function handleInlineEditKey(event: KeyboardEvent): boolean {
  const source = event.target as unknown;
  if (source === null || typeof source !== 'object') return false;
  const command = inlineEditCommands.get(source as HTMLInputElement);
  if (command === undefined) return false;
  if (event.key === 'Escape') {
    command.cancel();
    return true;
  }
  command.commit();
  return true;
}

/**
 * Смонтировать панель в `host`. Панель монтируется один раз при сборке экрана;
 * дальнейшие состояния приходят через {@link TaskPanelHandle.render}.
 */
export function mountTaskPanel(host: HTMLElement, actions: TaskPanelActions): TaskPanelHandle {
  host.replaceChildren();
  let view: TaskPanelView | null = null;
  /** Ключ строки, открытой в инлайн-правке (`null` — правки нет). */
  let editingKey: string | null = null;
  /** Сырая строка `body_md` открытой правки (маркер и чекбокс на месте). */
  let editingRaw: string | null = null;

  const root = div(TASK_PANEL_CLASS);
  const head = div('ui-task-panel-head');
  const title = el('h3', 'ui-task-panel-title', t('tasks.panelTitle'));
  const undoBtn = uiButton({
    label: t('tasks.undo'),
    role: 'ghost',
    size: 's',
    class: 'ui-task-panel-undo',
    onClick: () => actions.undo(),
  });
  undoBtn.hidden = true;
  const refreshBtn = uiButton({
    label: t('tasks.refresh'),
    role: 'secondary',
    size: 's',
    class: 'ui-task-panel-refresh',
    onClick: () => actions.refresh(),
  });
  head.append(title, undoBtn, refreshBtn);

  const body = div('ui-task-panel-body');
  const statusHost = div('ui-task-panel-status');
  statusHost.hidden = true;
  const taskGroup = buildGroup('tasks');
  const reminderGroup = buildGroup('reminders');
  body.append(statusHost, taskGroup.root, reminderGroup.root);
  root.append(head, body);
  host.append(root);

  /**
   * Текущий фильтр подгруппы. Кнопка «⋮» подгруппы создаётся один раз
   * (keyed-сверка), поэтому адрес массовой команды читается из реестра в момент
   * открытия меню: замыкание держало бы фильтр первого построения.
   */
  const subgroupFilters = new WeakMap<HTMLElement, TaskMassFilter>();
  /** Строки напоминаний подгруппы — адрес групповой команды «Отменить все…». */
  const subgroupReminderRows = new WeakMap<HTMLElement, readonly ReminderPanelRow[]>();
  /** Заголовок подгруппы — для вопроса подтверждения групповой команды. */
  const subgroupTitles = new WeakMap<HTMLElement, string>();

  /** «Перенести… на дату» для массовой команды: произвольная дата. */
  async function pickBulkDate(filter: TaskMassFilter): Promise<void> {
    const date = await actions.pickDate('');
    if (date !== null) actions.bulk(filter, 'move-all', { date });
  }

  /** «Перенести… на дату» строки: якорь — её срок (или начало периода). */
  async function pickRowDate(row: TaskPanelRow): Promise<void> {
    const anchor = row.due ?? row.periodFrom;
    if (anchor === null) return;
    const date = await actions.pickDate(anchor);
    if (date !== null) actions.rowCommand(row, 'move', { date });
  }

  /** «Отложить…» вхождения: произвольные дата и время. */
  async function pickSnooze(row: ReminderPanelRow): Promise<void> {
    const until = await actions.pickDateTime(row.moment);
    if (until !== null) actions.reminderAction(row, 'snooze', until);
  }

  /** Меню «⋮»: показать выполненные, массовые команды по секциям/всему периоду. */
  function tasksGroupMenu(): MenuItem[] {
    const items: MenuItem[] = [];
    if (view !== null) {
      items.push(
        menuChoice(t('tasks.showDone'), view.showDone, () => actions.setShowDone(!view!.showDone)),
        MENU_SEPARATOR,
      );
      // Массовые команды «по всему периоду» и по сквозным секциям — адресация
      // проекцией (требование e6af8b9e): фильтр перечисляет основу выборки.
      // Период — from/to текущей ленты; `{ scope: 'open' }` без границ сервер
      // применил бы ко всей сети (блокер приёмки).
      const periodFilter: TaskMassFilter = view.periodFilter;
      items.push(
        menuAction(t('tasks.cancelAllPeriod'), () => actions.bulk(periodFilter, 'cancel-all')),
        menuSubmenu(t('tasks.moveAllPeriod'), [
          ...TASK_SHIFTS.map((item) =>
            menuAction(t(item.labelKey), () => actions.bulk(periodFilter, 'move-all', item.shift)),
          ),
          menuAction(t('tasks.moveDate'), () => void pickBulkDate(periodFilter)),
        ]),
        MENU_SEPARATOR,
        menuAction(t('tasks.cancelAllOverdue'), () =>
          actions.bulk({ scope: 'overdue' }, 'cancel-all'),
        ),
        menuAction(t('tasks.cancelAllUndated'), () =>
          actions.bulk({ scope: 'undated' }, 'cancel-all'),
        ),
      );
    }
    return items;
  }

  /** Подгруппа «⋮»: массовые команды по одной группе (по дате/неделе/месяцу/мысли). */
  function subgroupMenu(kind: 'task' | 'reminder', filter: TaskMassFilter): MenuItem[] {
    if (kind === 'reminder') return [];
    return [
      menuAction(t('tasks.cancelAllGroup'), () => actions.bulk(filter, 'cancel-all')),
      menuSubmenu(t('tasks.moveAllGroup'), [
        ...TASK_SHIFTS.map((item) =>
          menuAction(t(item.labelKey), () => actions.bulk(filter, 'move-all', item.shift)),
        ),
        menuAction(t('tasks.moveDate'), () => void pickBulkDate(filter)),
      ]),
    ];
  }

  /**
   * Меню «⋮» подгруппы НАПОМИНАНИЙ: одна групповая команда — убрать все
   * вхождения строк группы. Задач у вхождения нет, поэтому меню задач сюда не
   * подходит.
   */
  function reminderSubgroupMenu(title: string, rows: readonly ReminderPanelRow[]): MenuItem[] {
    if (rows.length === 0) return [];
    return [
      menuAction(t('reminder.groupDismiss'), () => actions.reminderGroupDismiss(title, rows)),
    ];
  }

  /** Строка меню команд строки задачи. */
  function taskRowMenu(row: TaskPanelRow): MenuItem[] {
    const items: MenuItem[] = [];
    const day = row.due ?? row.periodFrom;
    if (day !== null) {
      items.push(menuAction(t('tasks.openSource'), () => actions.openDay(day)));
      items.push(MENU_SEPARATOR);
    }
    items.push(
      menuSubmenu(
        t('tasks.moveRow'),
        [
          ...TASK_SHIFTS.map((item) =>
            menuAction(t(item.labelKey), () => actions.rowCommand(row, 'move', item.shift)),
          ),
          menuAction(t('tasks.moveDate'), () => void pickRowDate(row), {
            disabled: day === null,
          }),
        ],
        { disabled: row.stale },
      ),
      menuAction(t('tasks.cancelRow'), () => actions.rowCommand(row, 'cancel'), {
        disabled: row.stale,
      }),
    );
    return items;
  }

  /** Строка меню команд вхождения напоминания. */
  function reminderRowMenu(row: ReminderPanelRow): MenuItem[] {
    return [
      menuAction(t('tasks.openSubject'), () => actions.reminderAction(row, 'open-subject')),
      menuAction(t('reminder.editSchedule'), () => actions.reminderAction(row, 'edit-schedule')),
      menuAction(t('tasks.dismissReminder'), () => actions.reminderAction(row, 'dismiss')),
      menuSubmenu(t('tasks.snoozeReminder'), [
        ...TASK_SHIFTS.map((item) =>
          menuAction(t(item.labelKey), () =>
            actions.reminderAction(row, 'snooze', shiftIso(row.moment, item.shift)),
          ),
        ),
        menuAction(t('tasks.snoozeDateTime'), () => void pickSnooze(row)),
      ]),
      MENU_SEPARATOR,
      menuAction(t('tasks.createTask'), () => actions.reminderAction(row, 'create-task')),
    ];
  }

  /** Строка задачи: чекбокс, текст (или правка), чипы дат, команды при hover. */
  function buildTaskRow(row: TaskPanelRow): HTMLElement {
    const node = div(TASK_PANEL_ROW_CLASS);
    node.classList.toggle('is-subtask', row.subtask);
    fillTaskRow(node, row);
    return node;
  }

  /** Собрать/обновить содержимое строки задачи под `row`. */
  function fillTaskRow(node: HTMLElement, row: TaskPanelRow): void {
    node.classList.toggle(TASK_PANEL_ROW_STALE_CLASS, row.stale);
    node.classList.toggle('is-done', row.done);
    const check = choiceControl('checkbox', {
      checked: row.done,
      disabled: row.stale,
      onChange: (checked) => actions.toggle(row, checked),
    });
    check.classList.add('ui-task-row-check');
    const textHost = div('ui-task-row-text');
    textHost.tabIndex = 0;
    /** Снятие контекста клавиш правки (пока поле в фокусе). */
    let releaseContext: (() => void) | null = null;
    /** Вернуть строку к виду снапшота (локально, без полной сверки списка). */
    const closeEdit = (): void => {
      editingKey = null;
      editingRaw = null;
      releaseContext?.();
      releaseContext = null;
      if (node.isConnected) fillTaskRow(node, row);
    };
    if (editingKey === row.key && editingRaw !== null) {
      // Правится СЫРАЯ строка `body_md` (маркер и чекбокс на месте): снапшот
      // `row.text` маркера не содержит, и запись его как всей строки уничтожила
      // бы задачу (блокер приёмки 64f7976a).
      const field = fieldInput({
        value: editingRaw,
        extraClass: 'ui-task-row-edit',
        ariaLabel: t('tasks.editLineAria'),
      });
      ensureInlineEditContext();
      inlineEditCommands.set(field, {
        commit: () => {
          void actions.editLine(row, field.value).then((saved) => {
            if (saved) closeEdit();
          });
        },
        cancel: closeEdit,
      });
      field.addEventListener('focus', () => {
        releaseContext ??= pushKeyContext(INLINE_EDIT_CONTEXT_ID);
      });
      field.addEventListener('blur', () => {
        if (editingKey === row.key) closeEdit();
      });
      textHost.append(field);
    } else {
      actions.renderText(textHost, row);
      textHost.addEventListener('dblclick', () => {
        if (row.stale || editingKey === row.key) return;
        editingKey = row.key;
        editingRaw = null;
        // Сырую строку читает экран: компонент не знает сети. Пока ответа нет,
        // строка остаётся снапшотом; ответ пришёл — перерисовываем поле.
        void actions.loadRawLine(row).then((raw) => {
          if (editingKey !== row.key) return;
          if (raw === null) {
            closeEdit();
            return;
          }
          editingRaw = raw;
          // Правка — состояние КОМПОНЕНТЫ, а не данных строки: сверка по ключу
          // его не увидит, поэтому строку перерисовываем напрямую.
          fillTaskRow(node, row);
          const field = node.querySelector<HTMLInputElement>('.ui-task-row-edit');
          field?.focus();
          field?.select();
        });
      });
    }
    const dates = div('ui-task-row-dates');
    for (const day of [row.periodFrom, row.due]) {
      if (day === null) continue;
      if (dates.querySelector(`[data-day="${day}"]`) !== null) continue;
      const chip = span(day, 'ui-task-row-date');
      chip.dataset['day'] = day;
      chip.addEventListener('click', () => actions.openDay(day));
      dates.append(chip);
    }
    const rowActions = div('ui-task-row-actions');
    rowActions.append(
      iconButton({
        icon: svgIcon('ellipsis', 14),
        title: t('tasks.rowCommands'),
        role: 'ghost',
        size: 's',
        class: 'ui-task-row-menu',
        onClick: (event) => {
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          showMenuAt(rect.left, rect.bottom, taskRowMenu(row), { keyboard: true });
        },
      }),
    );
    node.replaceChildren(check, textHost, dates, rowActions);
  }

  /** Строка вхождения напоминания: субъект, момент, повтор, метка, команды. */
  function buildReminderRow(row: ReminderPanelRow): HTMLElement {
    const node = div(REMINDER_PANEL_ROW_CLASS);
    fillReminderRow(node, row);
    return node;
  }

  function fillReminderRow(node: HTMLElement, row: ReminderPanelRow): void {
    const subject = span(row.title, 'ui-task-row-text');
    subject.addEventListener('click', () => actions.reminderAction(row, 'open-subject'));
    const moment = span(formatMoment(row.moment), 'ui-task-row-date');
    const repeat = span(row.repeat, 'ui-task-row-repeat');
    const flags = div('ui-task-row-flags');
    if (row.status === 'snoozed') flags.append(badge(t('tasks.badgeSnoozed'), { tone: 'neutral' }));
    const actionsBox = div('ui-task-row-actions');
    actionsBox.append(
      iconButton({
        icon: svgIcon('check-check', 14),
        title: t('tasks.createTask'),
        role: 'ghost',
        size: 's',
        class: 'ui-reminder-create-task',
        onClick: () => actions.reminderAction(row, 'create-task'),
      }),
      iconButton({
        icon: svgIcon('ellipsis', 14),
        title: t('tasks.rowCommands'),
        role: 'ghost',
        size: 's',
        class: 'ui-reminder-row-menu',
        onClick: (event) => {
          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
          showMenuAt(rect.left, rect.bottom, reminderRowMenu(row), { keyboard: true });
        },
      }),
    );
    node.replaceChildren(subject, moment, repeat, flags, actionsBox);
  }

  /** Заголовок группы: название, счётчики, меню «⋮» (только при hover). */
  function buildGroup(kind: 'tasks' | 'reminders'): {
    root: HTMLElement;
    head: HTMLElement;
    title: HTMLElement;
    counters: HTMLElement;
    sections: HTMLElement;
  } {
    const groupRoot = div(TASK_PANEL_GROUP_CLASS);
    groupRoot.classList.add(kind === 'tasks' ? 'ui-task-group-tasks' : 'ui-task-group-reminders');
    const groupHead = div('ui-task-group-head');
    const groupTitle = span(
      kind === 'tasks' ? t('tasks.groupTitle') : t('tasks.remindersGroupTitle'),
      'ui-task-group-title',
    );
    const counters = span('', 'ui-task-group-counters');
    const menuBtn = iconButton({
      icon: svgIcon('ellipsis', 14),
      title: t('tasks.groupCommands'),
      role: 'ghost',
      size: 's',
      class: 'ui-task-group-menu',
      onClick: (event) => {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const items = kind === 'tasks' ? tasksGroupMenu() : [];
        if (items.length === 0) return;
        showMenuAt(rect.left, rect.bottom, items, { keyboard: true });
      },
    });
    groupHead.append(groupTitle, counters, menuBtn);
    const sections = div('ui-task-group-sections');
    groupRoot.append(groupHead, sections);
    return { root: groupRoot, head: groupHead, title: groupTitle, counters, sections };
  }

  /** Секция списка: заголовок + подгруппы (сразу с содержимым — см. сверку). */
  function buildSection(
    section: TaskPanelSectionView | ReminderPanelSectionView,
    kind: 'task' | 'reminder',
  ): HTMLElement {
    const node = div(TASK_PANEL_SECTION_CLASS);
    node.dataset['section'] = section.key;
    const title = span(section.title, 'ui-task-section-title');
    const list = div('ui-task-subgroup-list');
    node.append(title, list);
    renderSubgroups(list, section.subgroups, kind);
    return node;
  }

  /** Подгруппа: заголовок с количеством и меню «⋮» + список строк. */
  function buildSubgroupBucket(): HTMLElement {
    const subgroup = div(TASK_PANEL_SUBGROUP_CLASS);
    const head = div('ui-task-subgroup-head');
    head.append(span('', 'ui-task-subgroup-title'), span('', 'ui-task-subgroup-count'));
    subgroup.append(head, div('ui-task-subgroup-rows'));
    return subgroup;
  }

  /** Отрисовка навигации по видимым строкам (серая строка тоже достижима). */
  let nav: ListNavHandle<PanelEntry> | null = null;

  function entries(): PanelEntry[] {
    if (view === null) return [];
    const list: PanelEntry[] = [];
    for (const section of view.taskSections) {
      for (const subgroup of section.subgroups) {
        for (const row of subgroup.rows) list.push({ key: row.key, kind: 'task' });
      }
    }
    for (const section of view.reminderSections) {
      for (const subgroup of section.subgroups) {
        for (const row of subgroup.rows) list.push({ key: row.key, kind: 'reminder' });
      }
    }
    return list;
  }

  function elementOf(entry: PanelEntry): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[${TABLE_ROW_KEY_ATTR}="${cssEscape(entry.key)}"]`);
  }

  nav = createListNav<PanelEntry>(root, {
    entries,
    tokenOf: (entry) => `${entry.kind}:${entry.key}`,
    elementOf,
    applyHighlight: (entry) => {
      for (const node of Array.from(root.querySelectorAll<HTMLElement>('.is-current'))) {
        node.classList.remove('is-current');
      }
      if (entry === null) return;
      elementOf(entry)?.classList.add('is-current');
    },
    onClick: (target) => {
      const row = target.closest?.(`[${TABLE_ROW_KEY_ATTR}]`) as HTMLElement | null;
      if (row === null) return;
      const key = row.getAttribute(TABLE_ROW_KEY_ATTR) ?? '';
      const entry = entries().find((item) => item.key === key);
      if (entry !== undefined) nav?.setCurrent(entry);
    },
    onActivate: (entry) => {
      if (entry.kind !== 'task' || view === null) return;
      for (const section of view.taskSections) {
        for (const subgroup of section.subgroups) {
          const row = subgroup.rows.find((item) => item.key === entry.key);
          if (row === undefined) continue;
          const day = row.due ?? row.periodFrom;
          if (day !== null) actions.openDay(day);
          return;
        }
      }
    },
  });

  /** Отрисовать снимок панели (keyed-сверка групп, подгрупп и строк). */
  function render(next: TaskPanelView): void {
    view = next;
    // Строка, открытая в правке, могла уйти из выборки — правку закрываем.
    if (editingKey !== null && !entries().some((entry) => entry.key === editingKey)) {
      editingKey = null;
      editingRaw = null;
    }
    root.dataset['stale'] = next.stale ? '1' : '0';
    undoBtn.hidden = !next.canUndo;
    refreshBtn.classList.toggle('is-stale', next.stale);

    if (next.loading) {
      statusHost.hidden = false;
      statusHost.replaceChildren(loadingState());
    } else if (next.error !== null) {
      statusHost.hidden = false;
      statusHost.replaceChildren(span(next.error, 'ui-task-panel-error'));
    } else {
      statusHost.hidden = true;
      statusHost.replaceChildren();
    }

    taskGroup.counters.textContent = t('tasks.counters', [next.counters.open, next.counters.done]);
    reminderGroup.root.hidden = next.reminderSections.length === 0 && next.reminderCount === 0;
    reminderGroup.counters.textContent = t('tasks.reminderCount', [next.reminderCount]);

    renderSections(taskGroup.sections, next.taskSections, 'task');
    renderSections(reminderGroup.sections, next.reminderSections, 'reminder');
    nav?.refresh();
  }

  /** Отрисовать секции одного списка (задачи или напоминания). */
  function renderSections(
    hostEl: HTMLElement,
    sections: ReadonlyArray<TaskPanelSectionView | ReminderPanelSectionView>,
    kind: 'task' | 'reminder',
  ): void {
    reconcileKeyed(
      hostEl,
      sections.filter((section) => section.subgroups.length > 0),
      {
        keyAttr: 'data-section',
        key: (section) => section.key,
        // `build` обязан собрать узел ПОЛНОСТЬЮ: сверка не зовёт `update` для
        // новых элементов (контракт `keyed-list.ts`).
        build: (section) => buildSection(section, kind),
        update: (node, section) => {
          const titleNode = node.querySelector('.ui-task-section-title');
          if (titleNode !== null) titleNode.textContent = section.title;
          const list = node.querySelector('.ui-task-subgroup-list');
          if (list !== null) renderSubgroups(list as HTMLElement, section.subgroups, kind);
        },
      },
    );
  }

  /** Отрисовать подгруппы одной секции. */
  function renderSubgroups(
    list: HTMLElement,
    subgroups: ReadonlyArray<
      TaskPanelSubgroupView<TaskPanelRow> | TaskPanelSubgroupView<ReminderPanelRow>
    >,
    kind: 'task' | 'reminder',
  ): void {
    reconcileKeyed(list, subgroups, {
      keyAttr: 'data-subgroup',
      key: (subgroup) => subgroup.key,
      build: (subgroup) => {
        const node = buildSubgroupBucket();
        node.dataset['subgroup'] = subgroup.key;
        fillSubgroup(node, subgroup, kind);
        return node;
      },
      update: (node, subgroup) => fillSubgroup(node, subgroup, kind),
    });
  }

  /** Заполнить подгруппу: заголовок, количество, меню «⋮» и строки. */
  function fillSubgroup(
    node: HTMLElement,
    subgroup: TaskPanelSubgroupView<TaskPanelRow> | TaskPanelSubgroupView<ReminderPanelRow>,
    kind: 'task' | 'reminder',
  ): void {
    const titleNode = node.querySelector('.ui-task-subgroup-title');
    if (titleNode !== null) titleNode.textContent = subgroup.title;
    const countNode = node.querySelector('.ui-task-subgroup-count');
    if (countNode !== null) countNode.textContent = String(subgroup.rows.length);
    subgroupFilters.set(node, subgroup.filter);
    subgroupTitles.set(node, subgroup.title);
    if (kind === 'reminder') subgroupReminderRows.set(node, subgroup.rows as ReminderPanelRow[]);
    const head = node.querySelector('.ui-task-subgroup-head') as HTMLElement;
    if (head.querySelector('.ui-task-subgroup-menu') === null) {
      head.append(
        iconButton({
          icon: svgIcon('ellipsis', 14),
          title: t('tasks.groupCommands'),
          role: 'ghost',
          size: 's',
          class: 'ui-task-subgroup-menu',
          onClick: (event) => {
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            const items =
              kind === 'task'
                ? subgroupMenu('task', subgroupFilters.get(node) ?? {})
                : reminderSubgroupMenu(
                    subgroupTitles.get(node) ?? '',
                    subgroupReminderRows.get(node) ?? [],
                  );
            if (items.length === 0) return;
            showMenuAt(rect.left, rect.bottom, items, { keyboard: true });
          },
        }),
      );
    }
    const rowsHost = node.querySelector('.ui-task-subgroup-rows') as HTMLElement;
    if (kind === 'task') {
      const rows = subgroup.rows as TaskPanelRow[];
      reconcileKeyed(rowsHost, rows, {
        keyAttr: TABLE_ROW_KEY_ATTR,
        key: (row) => row.key,
        build: (row) => buildTaskRow(row),
        update: (rowNode, row) => {
          if (editingKey === row.key) return;
          fillTaskRow(rowNode, row);
        },
      });
    } else {
      const rows = subgroup.rows as ReminderPanelRow[];
      reconcileKeyed(rowsHost, rows, {
        keyAttr: TABLE_ROW_KEY_ATTR,
        key: (row) => row.key,
        build: (row) => buildReminderRow(row),
        update: (rowNode, row) => fillReminderRow(rowNode, row),
      });
    }
  }

  return {
    render,
    destroy(): void {
      nav?.destroy();
      nav = null;
      host.replaceChildren();
    },
  };
}

/** `CSS.escape` без зависимости от среды тестов: экранирование адреса ключа. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** Локальный календарный день из UTC-инстанса (`YYYY-MM-DD`, локальные сутки). */
function formatMoment(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Сдвиг UTC-инстанса на календарный сдвиг (`days`/`months`) — для «Отложить». */
export function shiftIso(iso: string, shift: TaskShift): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (shift.months !== undefined) {
    const target = new Date(date.getTime());
    target.setMonth(target.getMonth() + shift.months);
    return target.toISOString();
  }
  const target = new Date(date.getTime() + (shift.days ?? 0) * 24 * 60 * 60 * 1000);
  return target.toISOString();
}
