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
 * **Сворачивание (ошибка d0801eea).** Панель, каждая группа и каждая секция —
 * штатная сворачиваемая группа `lib/ui/collapsible` с кареткой; счётчик блока
 * остаётся в шапке и в свёрнутом виде. Состояние — не память компоненты, а
 * `ui_state` экрана: `collapsedOf(key)`/`setCollapsed(key, collapsed)`. Шапка
 * панели приклеена к её верху (`sticky`, ошибка 58c470a3) и не прокручивается
 * со списком.
 *
 * **Списки инкрементальны.** Группы и строки обновляются keyed-сверкой
 * (`keyed-list.ts`): неизменные узлы не пересоздаются, поэтому hover, фокус и
 * открытая инлайн-правка переживают перечитывание панели (стандарт
 * «Списки рендерятся инкрементально», сторож `guard-keyed-lists`).
 * Клавиатурная навигация — общим ядром `list.ts`/`nav-core.ts`: своего
 * обработчика стрелок у панели нет (сторож `guard-list-nav`).
 *
 * **Команды — только при hover.** У строки — команды строки (открыть источник,
 * перенести даты, сделать бессрочной, отменить), у заголовка группы — подменю
 * «⋮»; подвалов с кнопками нет (спека f76ed829). Единственная постоянная
 * кнопка — «Обновить» вверху ПАНЕЛИ: она подсвечивается, когда данные устарели
 * (требование 0e85b66e), и полностью перерисовывает список из записей.
 *
 * **Строка задачи и правка.** Чекбокс — одиночный клик без режима правки; это
 * КОМАНДА, а не правка текста, поэтому он работает и на серой строке
 * (повторный клик снимает отметку, ошибка d318a647). Двойной клик по тексту —
 * инлайн-правка сырого markdown строки КОМПОНЕНТОЙ РЕДАКТИРОВАНИЯ КОММЕНТАРИЯ
 * (0.16.1, задача `cfb8cb72`, пункт 1): фабрику правки даёт экран
 * ({@link TaskPanelOptions.createRowEditor}), потому что CodeMirror живёт в слое
 * `editor/`, а `lib/ui` его не тянет. Сохранение у строки одно — `Ctrl+Enter`;
 * `Tab`/`Shift+Tab` — отступ/сдвиг, а не выход из правки. Серая строка (правка
 * из панели или внешнее изменение) не редактируется до «Обновить».
 */

import type { TaskMassFilter } from '@etn/shared';

import { div, el, span } from '../dom.js';
import { shiftInstant, todayAtTimeOf, todayLocal } from '../dates.js';
import { t, tp } from '../i18n.js';
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
import { collapsibleSection, type CollapsibleSection } from './collapsible.js';
import { loadingState } from './empty-state.js';
import { svgIcon } from './icon.js';
import { reconcileKeyed } from './keyed-list.js';
import { createListNav, type ListNavHandle } from './list.js';
import { deepEqual } from './state.js';
import { TABLE_ROW_KEY_ATTR } from './table.js';
import type { ReminderPanelRow, TaskPanelChildRow, TaskPanelRow } from './task-panel-model.js';

export type { ReminderPanelRow, TaskPanelChildRow, TaskPanelRow } from './task-panel-model.js';

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

/**
 * Класс свёрнутой ПАНЕЛИ (0.16.1, уточнение 2026-11-19, пункт 1): свёрнутая
 * панель показывает только шапку, а сохранённая высота (`--task-panel-height`,
 * выставленная слайдером) обязана перестать держать пустое место. Оформление —
 * `task-panel.css`; класс ставит сама панель при переключении и при построении.
 */
export const TASK_PANEL_COLLAPSED_CLASS = 'is-collapsed';

/** Класс поля БЛОЧНОЙ правки строки (многострочный режим, 0.16.1). */
export const TASK_ROW_BLOCK_EDIT_CLASS = 'ui-task-row-block-edit';

/**
 * Устаревшая строка задачи, внутри которой лежит `node` (`null` — строка
 * свежая). Серая строка адресует ПРЕЖНЮЮ ревизию источника, поэтому команды,
 * меняющие запись (`row.stale` в меню строки), запрещены до «Обновить»
 * (требование 0e85b66e). Знание о маркерах строки живёт здесь, чтобы другие
 * поверхности (меню date-чипа) не дублировали имена классов.
 */
export function staleTaskRowOf(node: HTMLElement): HTMLElement | null {
  const row = node.closest(`.${TASK_PANEL_ROW_CLASS}`);
  if (!(row instanceof HTMLElement)) return null;
  return row.classList.contains(TASK_PANEL_ROW_STALE_CLASS) ? row : null;
}

/**
 * Субъект группы/строки для показа облачком мысли (уточнение ТЗ 2026-11-17,
 * пункты C и E): панель не знает фабрику облачка — элемент рисует экран через
 * {@link TaskPanelActions.renderSubject}, а сюда кладутся данные для него.
 */
export interface TaskPanelSubject {
  /** Вид субъекта: мысль или публикация. */
  kind: 'thought' | 'publication';
  id: string;
  /** Название — подпись облачка. */
  title: string;
}

/** Подгруппа списка: заголовок + фильтр массовой команды + строки. */
export interface TaskPanelSubgroupView<T> {
  key: string;
  title: string;
  /**
   * Вид группы прежних порогов (мысль/дата/неделя/месяц). Списки панели теперь
   * сплошные (уточнение 2026-11-18, задача `cfb8cb72`, пункт 6), поэтому вид —
   * необязательная подсказка оформления для тех, кто ещё передаёт подгруппы.
   */
  kind?: string;
  /** Фильтр адресации массовой команды группы (требование e6af8b9e). */
  filter: TaskMassFilter;
  rows: T[];
  /**
   * Группа-мысль: заголовок показывается её облачком с иконкой (пункт E ТЗ
   * 2026-11-17), формат — как у чипов полей ввода свойств.
   */
  subject?: TaskPanelSubject | null;
  /** Значок перед заголовком группы-даты: календарик (пункт E). */
  icon?: 'calendar';
}

/** Секция списка задач. */
export interface TaskPanelSectionView {
  key: string;
  title: string;
  subgroups: TaskPanelSubgroupView<TaskPanelRow>[];
  /**
   * Плоская секция: строки рисуются сразу, без подгрупп и их меню массовых
   * команд. Так панель «Задачи» редактора мысли (0.16.1, элемент `f3893859`)
   * показывает активные строки, а вложенная секция — выполненные.
   */
  flat?: boolean;
  /** Секция-переключатель внутри плоского списка («Выполненные задачи (n)»). */
  collapsible?: boolean;
  /** Секция свёрнута при первом показе (только при `collapsible`). */
  collapsed?: boolean;
  /** Строки плоской секции (заполняется при `flat`). */
  rows?: TaskPanelRow[];
}

/** Секция списка напоминаний. */
export interface ReminderPanelSectionView {
  /** Ключ секции (для свёрнутости/тестов); подгрупп у напоминаний больше нет. */
  key: string;
  title: string;
  subgroups: TaskPanelSubgroupView<ReminderPanelRow>[];
  /**
   * Плоская секция (0.16.1, задача `cfb8cb72`, пункт 6): «Напоминания» — ОДИН
   * хронологический список без подгрупп при любом периоде.
   */
  flat?: boolean;
  /** Строки плоской секции (заполняется при `flat`). */
  rows?: ReminderPanelRow[];
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
export type TaskRowCommand = 'open-source' | 'move' | 'undate' | 'cancel';

/**
 * Настройка правки строки задачи: панель отдаёт данные и колбэки, а поле
 * СОЗДАЁТ ЭКРАН. Контракт объявлен здесь (а не в `editor/`), потому что
 * `lib/ui` — фасады визуальных компонент и не тянет CodeMirror; реализацию
 * (компоненту редактирования комментария) даёт `editor/task-row-editor.ts`.
 * 0.16.1, задача `cfb8cb72`, пункт 1.
 */
export interface TaskRowEditorOptions {
  /** Начальный markdown: СЫРАЯ строка/блок `body_md` (маркер и чекбокс на месте). */
  md: string;
  /**
   * Классы поля СПИСКОМ: `ui-task-row-edit` и, у блочной правки, ещё
   * `ui-task-row-block-edit`. Не строка через пробел: `DOMTokenList.add` с
   * пробелом бросает `InvalidCharacterError` и правка не открывалась (блокер
   * 84c71c37).
   */
  classes: readonly string[];
  /** Подпись для скринридера. */
  ariaLabel: string;
  /** Сохранить правку; `false` — отказ (поле остаётся в правке). */
  save(md: string): Promise<boolean>;
  /** Правка закрыта (сохранена, отменена, клик вне) — панель перерисует строку. */
  closed(): void;
}

/** Поле правки строки задачи (дескриптор, который держит панель). */
export interface TaskRowEditor {
  root: HTMLElement;
  focus(): void;
  dispose(): void;
}

/** Фабрика правки строки: даёт экран (компонента комментария). */
export type TaskRowEditorFactory = (options: TaskRowEditorOptions) => TaskRowEditor;

/**
 * Ключи состояния свёрнутости блоков панели (`ui_state` экрана, ошибка
 * d0801eea). Экран хранит их как есть — карта «ключ → свёрнут», поэтому
 * добавление нового блока не требует правок персиста.
 */
export const TASK_PANEL_COLLAPSE_KEYS = {
  /** Вся панель: свёрнутая показывает только шапку. */
  panel: 'panel',
  /** Группа «Задачи периода». */
  tasksGroup: 'group:tasks',
  /** Группа «Напоминания периода». */
  remindersGroup: 'group:reminders',
  /** Секция списка: `section:task:period`, `section:reminder:today`. */
  section: (kind: 'task' | 'reminder', key: string): string => `section:${kind}:${key}`,
} as const;

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
  /**
   * Свёрнут ли блок панели (`panel`, `group:tasks`, `section:task:period`) —
   * состояние экрана из `ui_state` (ошибка d0801eea). `undefined` — записи нет:
   * блок показывается в состоянии по умолчанию (развёрнут; у секции редактора
   * мысли — её собственный `collapsed`). Различие важно при загрузке настроек:
   * пустая карта не должна раскрывать секцию «Выполненные задачи».
   */
  collapsedOf?(key: string): boolean | undefined;
  /** Запомнить свёрнутость блока панели. */
  setCollapsed?(key: string, collapsed: boolean): void;
  /**
   * Чекбокс строки: одиночный клик без режима правки. Команда, а не правка
   * текста, — доступна и на серой строке (ошибка d318a647).
   */
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
  /** Команда строки: открыть источник/перенести/сделать бессрочной/отменить. */
  rowCommand(row: TaskPanelRow, command: TaskRowCommand, shift?: TaskShift): void;
  /**
   * Массовая команда группы: отменить всё, перенести всё на сдвиг или сделать
   * бессрочными (все date-ссылки строк удаляются).
   */
  bulk(
    filter: TaskMassFilter,
    command: 'cancel-all' | 'move-all' | 'undate-all',
    shift?: TaskShift,
  ): void;
  /** Действие над вхождением напоминания. */
  reminderAction(row: ReminderPanelRow, action: ReminderRowAction, until?: string): void;
  /**
   * Чекбокс вхождения напоминания (0.16.1, задача `cfb8cb72`, пункт 7): отметка
   * «выполнено» = dismiss вхождения по `occurrence_at`. Панель показывает
   * отметку сразу, а «Обновить» зажигается — после перечитывания вхождение
   * уходит из выдачи, серия напоминания остаётся.
   */
  reminderDone?(row: ReminderPanelRow): void;
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
  /**
   * Переход к записи-источнику строки (панель редактора мысли: «Дневник» ленты
   * здесь не при чём — открывается сама запись). Не задано — клик по чипу даты
   * идёт в {@link openDay}, как в панели «Дневника».
   */
  openRowSource?(row: TaskPanelRow): void;
  /**
   * Пункты меню «⋮» шапки панели. Не задано — встроенное меню «Дневника»
   * (показ выполненных, массовые команды «за период»/сквозных секций).
   * Панель редактора мысли передаёт здесь команды по своей мысли.
   */
  headMenu?(): MenuItem[];
  /** Отрисовка снапшота текста строки (markdown + кликабельные ссылки). */
  renderText(host: HTMLElement, row: TaskPanelRow): void;
  /**
   * Отрисовка субъекта облачком мысли (пункты C и E ТЗ 2026-11-17): строки
   * напоминаний и заголовки групп-мыслей. Панель не знает фабрику облачка —
   * элемент собирает экран (эталонный компонент из коллекции), поэтому здесь
   * только данные. Не задано — рисуется название строкой.
   */
  renderSubject?(host: HTMLElement, subject: TaskPanelSubject): void;
  /**
   * Высота панели «Дневника» из `ui_state` (пункт B ТЗ 2026-11-17), `null` — не
   * задана: панель живёт на собственной высоте по умолчанию (`lib/ui/task-panel.css`).
   */
  panelHeight?(): number | null;
  /** Запомнить высоту панели (пишет экран, по образцу `editor_list_heights`). */
  setPanelHeight?(height: number): void;
  /**
   * Чекбокс пункта чек-листа под задачей (0.16.1, задача 7446eb25). Пункт
   * чек-листа — не задача проекции: команды `PATCH /tasks` на него нет, отметка
   * ставится правкой текста источника (экран решает, как именно).
   */
  toggleChild?(row: TaskPanelRow, child: TaskPanelChildRow, done: boolean): void;
  /**
   * Сырой блок источника для БЛОЧНОЙ правки «как трансклюзия» (0.16.1, задача
   * 7446eb25): строка задачи и все её вложенные строки одним куском.
   * `null` — блок прочитать не удалось (экран уже показал ошибку).
   */
  loadRawBlock?(row: TaskPanelRow): Promise<{ start: number; end: number; text: string } | null>;
  /** Сохранить блочную правку диапазона строк (включительно); `false` — отказ. */
  editBlock?(
    row: TaskPanelRow,
    range: { start: number; end: number },
    text: string,
  ): Promise<boolean>;
}

/** Настройка монтирования панели. */
export interface TaskPanelOptions {
  /**
   * Панель встраивается в чужую шапку (группа `main.tasks` редактора): своей
   * шапки нет, счётчики публикуются событием `etn:set-count`, а кнопки шапки
   * компонента отдаёт через {@link TaskPanelHandle.headActions}.
   */
  headless?: boolean;
  /**
   * Фабрика правки строки задачи — КОМПОНЕНТА РЕДАКТИРОВАНИЯ КОММЕНТАРИЯ
   * (0.16.1, задача `cfb8cb72`, пункт 1). Даёт экран: `lib/ui` не тянет
   * CodeMirror. Не задана — двойной клик по строке правку не открывает.
   */
  createRowEditor?: TaskRowEditorFactory;
  /**
   * Облачка субъектов у строк задач (0.16.1, пачка 4, пункт 1). По умолчанию
   * рисуются — в «Дневнике» субъекты строк разные, облачко информативно. Зона
   * «Задачи» редактора мысли выключает их: все её строки принадлежат самой
   * редактируемой мысли, облачко у каждой строки избыточно.
   */
  rowSubjectClouds?: boolean;
}

/** Публичный дескриптор панели. */
export interface TaskPanelHandle {
  /** Отрисовать снимок (keyed-сверка; правка в процессе не сбрасывается). */
  render(view: TaskPanelView): void;
  /**
   * Кнопки шапки для встраивания (только режим {@link TaskPanelOptions.headless}):
   * «Обновить» и «⋮». Узлы постоянные — потребитель кладёт их в свою шапку.
   */
  headActions(): HTMLElement[];
  /** Снять слушателей и навигацию. */
  destroy(): void;
  /** Свёрнута ли вся панель (пункт B: слайдер высоты доступен только развёрнутой). */
  panelCollapsed(): boolean;
  /** Высота панели по умолчанию (запись `ui_state`), `null` — не задана. */
  panelHeight(): number | null;
  /** Запомнить высоту панели (пишет `ui_state` и CSS-переменную). */
  setPanelHeight(height: number): void;
}

/** Подпись пункта сдвига в меню «Перенести»/«Отложить». */
type TaskShiftLabelKey =
  'tasks.shiftToday' | 'tasks.shiftDay' | 'tasks.shiftWeek' | 'tasks.shiftMonth';

/** Относительные сдвиги, предлагаемые меню «Перенести». */
const TASK_SHIFTS: ReadonlyArray<{
  labelKey: Exclude<TaskShiftLabelKey, 'tasks.shiftToday'>;
  shift: TaskShift;
}> = [
  { labelKey: 'tasks.shiftDay', shift: { days: 1 } },
  { labelKey: 'tasks.shiftWeek', shift: { days: 7 } },
  { labelKey: 'tasks.shiftMonth', shift: { months: 1 } },
];

/**
 * Сдвиги меню «Перенести» строки задачи (0.16.1, уточнение 2026-11-19, пункт 2):
 * абсолютный пункт «на сегодня» плюс относительные. Дата берётся в момент
 * открытия меню (локальные сутки наблюдателя), поэтому константой не хранится;
 * относительные сдвиги остаются общими для меню строки и «Отложить» напоминаний.
 */
function taskMoveShifts(): ReadonlyArray<{ labelKey: TaskShiftLabelKey; shift: TaskShift }> {
  return [{ labelKey: 'tasks.shiftToday', shift: { date: todayLocal() } }, ...TASK_SHIFTS];
}

/**
 * «Сегодня» в подменю «Отложить…» вхождения напоминания (0.16.1, план
 * тестирования `7e12f589`, пп. 1.4/5.6): вхождение показывается в ТЕКУЩИХ
 * локальных сутках в тот же час, что и `row.moment` (момент показа строки —
 * `until` у уже отложенного, иначе момент по расписанию).
 *
 * Сервер принимает `until` только строго в будущем и строго позже
 * откладываемого вхождения (`snoozeReminder`, требование 4401beb8), поэтому
 * команду, которую он заведомо отклонит, меню НЕ предлагает: пункт недоступен
 * (`null`), когда сегодняшний час уже прошёл, вхождение и так сегодня, или
 * вхождение запланировано на будущие сутки — «отложить» переносит только
 * ВПЕРЁД. Произвольный будущий момент остаётся у пункта «дата и время…».
 */
function todaySnoozeUntil(row: ReminderPanelRow, nowMs: number = Date.now()): string | null {
  const until = todayAtTimeOf(row.moment);
  const untilMs = Date.parse(until);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return null;
  const occurrenceMs = Date.parse(row.occurrenceAt);
  // Вхождение по расписанию — адрес исключения: сервер требует `until` позже
  // него. Неразборчивый адрес не блокирует команду — его отклонит сам сервер.
  if (Number.isFinite(occurrenceMs) && untilMs <= occurrenceMs) return null;
  return until;
}

/** Один лист навигации списка — строка задачи или вхождения. */
interface PanelEntry {
  key: string;
  kind: 'task' | 'reminder';
}

/**
 * Клавиши правки строки принадлежат КОМПОНЕНТЕ РЕДАКТИРОВАНИЯ КОММЕНТАРИЯ
 * (0.16.1, задача `cfb8cb72`, пункт 1): `Ctrl+Enter` — сохранение, `Enter` —
 * перевод строки, `Tab`/`Shift+Tab` — отступ/сдвиг, `Escape` — отмена. Панель
 * своих хорд не объявляет: контекст поля и его keymap живут в поле, а
 * глобальный шорткат «применить отбор» молчит по `defaultPrevented`/`.md-field`
 * (`filter-panel.ts`).

/**
 * Смонтировать панель в `host`. Панель монтируется один раз при сборке экрана;
 * дальнейшие состояния приходят через {@link TaskPanelHandle.render}.
 */
export function mountTaskPanel(
  host: HTMLElement,
  actions: TaskPanelActions,
  options: TaskPanelOptions = {},
): TaskPanelHandle {
  host.replaceChildren();
  const headless = options.headless === true;
  /** Облачка субъектов у строк (пункт 1 пачки 4): редактор мысли их выключает. */
  const rowSubjectClouds = options.rowSubjectClouds !== false;
  let view: TaskPanelView | null = null;
  /** Ключ строки, открытой в инлайн-правке (`null` — правки нет). */
  let editingKey: string | null = null;
  /** Сырая строка `body_md` открытой правки (маркер и чекбокс на месте). */
  let editingRaw: string | null = null;
  /**
   * Диапазон строк открытой БЛОЧНОЙ правки (0.16.1, задача 7446eb25): строка
   * задачи и все вложенные строки правятся одним куском «как трансклюзия».
   * `null` — правится одна строка.
   */
  let editingRange: { start: number; end: number } | null = null;
  /**
   * Ключи строк с раскрытыми вложенными строками (пункт F ТЗ 2026-11-17).
   * По умолчанию строка СВЁРНУТА: пользователь раскрывает её сам, состояние
   * живёт в компоненте и переживает перерисовку панели (в `ui_state` не пишется).
   */
  const expandedChildren = new Set<string>();

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
  const tasksMenuBtn = makeMenuButton('tasks');

  const body = div('ui-task-panel-body');
  const statusHost = div('ui-task-panel-status');
  statusHost.hidden = true;
  // Панель редактора мысли (headless): группы-обёртки нет — секции лежат прямо
  // в теле, шапку и счётчики даёт группа `main.tasks` редактора.
  const flatHost = div('ui-task-flat-sections');
  /**
   * Корень панели. У «Дневника» это корень сворачиваемой группы: шапка с
   * кареткой и «Обновить»/«Отменить» приклеена к верху, тело — список
   * (ошибки d0801eea/58c470a3); свёрнутая панель показывает только шапку.
   */
  const panelSection = headless
    ? null
    : collapsibleSection({
        title: t('tasks.panelTitle'),
        getCollapsed: () => collapseState(TASK_PANEL_COLLAPSE_KEYS.panel),
        onToggle: (collapsed) => {
          actions.setCollapsed?.(TASK_PANEL_COLLAPSE_KEYS.panel, collapsed);
          syncPanelCollapsed(collapsed);
          nav?.refresh();
        },
        classes: {
          root: TASK_PANEL_CLASS,
          header: 'ui-task-panel-head',
          title: 'ui-task-panel-title',
          caret: 'ui-task-panel-caret',
          body: 'ui-task-panel-body',
          actions: 'ui-task-panel-actions',
        },
        actions: [undoBtn, refreshBtn],
        body,
      });
  const root = panelSection === null ? div(TASK_PANEL_CLASS) : panelSection.root;

  /**
   * Отразить свёрнутость панели классом на корне (0.16.1, уточнение 2026-11-19,
   * пункт 1): сохранённая слайдером высота (`--task-panel-height`) не должна
   * держать пустое место под шапкой свёрнутой панели — CSS снимает высоту по
   * {@link TASK_PANEL_COLLAPSED_CLASS}. Класс ставит и первичное состояние:
   * панель, свёрнутая из `ui_state`, открывается сразу без пустоты.
   */
  function syncPanelCollapsed(collapsed: boolean): void {
    root.classList.toggle(TASK_PANEL_COLLAPSED_CLASS, collapsed);
  }

  if (panelSection !== null) syncPanelCollapsed(panelSection.collapsed());
  if (headless) {
    root.classList.add('is-headless');
    root.append(body);
  }
  const taskGroup = headless ? null : buildGroup('tasks', tasksMenuBtn);
  const reminderGroup = headless ? null : buildGroup('reminders', makeMenuButton('reminders'));
  body.append(statusHost);
  if (taskGroup !== null) body.append(taskGroup.root);
  else body.append(flatHost);
  if (reminderGroup !== null) body.append(reminderGroup.root);
  host.append(root);

  /**
   * Применить сохранённую высоту панели (пункт B ТЗ 2026-11-17): экран держит
   * её в `ui_state` (`diary_tasks_panel`), панель только выставляет переменную.
   * Высота не задана — работает высота по умолчанию из `lib/ui/task-panel.css`.
   */
  function applyPanelHeight(): void {
    const height = actions.panelHeight?.() ?? null;
    if (height !== null && Number.isFinite(height) && height > 0) {
      root.style.setProperty('--task-panel-height', `${height}px`);
    } else {
      root.style.removeProperty('--task-panel-height');
    }
  }

  /**
   * Текущий фильтр подгруппы. Кнопка «⋮» подгруппы создаётся один раз
   * (keyed-сверка), поэтому адрес массовой команды читается из реестра в момент
   * открытия меню: замыкание держало бы фильтр первого построения.
   */
  const subgroupFilters = new WeakMap<HTMLElement, TaskMassFilter>();
  /** Строки напоминаний подгруппы — адрес групповой команды «Отменить все…». */
  const subgroupReminderRows = new WeakMap<HTMLElement, readonly ReminderPanelRow[]>();
  /** Строки задач подгруппы — от их вида зависит «Сделать бессрочными». */
  const subgroupTaskRows = new WeakMap<HTMLElement, readonly TaskPanelRow[]>();
  /** Заголовок подгруппы — для вопроса подтверждения групповой команды. */
  const subgroupTitles = new WeakMap<HTMLElement, string>();
  /**
   * Тело плоской секции по узлу секции: свёрнутая секция снимает тело с экрана
   * (`lib/ui/collapsible`), и поиск `.ui-task-flat-rows` в DOM в этот момент
   * ничего не находит — ссылка держится здесь (блокер приёмки 710b68aa: после
   * «Обновить» строки свёрнутой секции оставались старыми).
   */
  const flatRowsHosts = new WeakMap<HTMLElement, HTMLElement>();
  /** Тело секции с подгруппами по узлу секции — по той же причине (свёрнутая). */
  const sectionLists = new WeakMap<HTMLElement, HTMLElement>();
  /**
   * Дескрипторы сворачиваемых секций по их узлу: по ним применяется состояние
   * `ui_state` при каждой отрисовке. Настройки читаются АСИНХРОННО, уже после
   * монтирования панели, поэтому начальное состояние узла (аргумент `collapsed`)
   * не может быть единственным источником — иначе сохранённая свёрнутость не
   * восстанавливалась бы до перезапуска (ошибка d0801eea).
   */
  const sectionHandles = new WeakMap<HTMLElement, CollapsibleSection>();
  /** Состояние секции при отсутствии записи в `ui_state` (у «Выполненных» — свёрнута). */
  const sectionDefaults = new WeakMap<HTMLElement, boolean>();

  /**
   * Состояние блока панели: запись экрана (`ui_state`), иначе — состояние по
   * умолчанию. Различие «нет записи» и «развёрнут» нужно секциям редактора
   * мысли: у «Выполненных задач» умолчание — свёрнуто.
   */
  function collapseState(key: string, fallback = false): boolean {
    return actions.collapsedOf?.(key) ?? fallback;
  }

  /**
   * Строки плоской секции (`null` — секция с подгруппами). Плоскость есть у
   * обеих форм: у секции задач панели редактора и у секции напоминаний при одной
   * выбранной дате (пункт D ТЗ 2026-11-17) — счётчик и навигация считают их
   * одинаково.
   */
  function flatRowsOf(
    section: TaskPanelSectionView | ReminderPanelSectionView,
  ): readonly { key: string }[] | null {
    if (section.flat !== true) return null;
    return section.rows ?? [];
  }

  /** Сколько строк в секции (счётчик в шапке — и у свёрнутой секции). */
  function sectionRowCount(section: TaskPanelSectionView | ReminderPanelSectionView): number {
    const flat = flatRowsOf(section);
    if (flat !== null) return flat.length;
    return section.subgroups.reduce((sum, subgroup) => sum + subgroup.rows.length, 0);
  }

  /** «Перенести… на дату» для массовой команды: произвольная дата. */
  async function pickBulkDate(filter: TaskMassFilter): Promise<void> {
    const date = await actions.pickDate('');
    if (date !== null) actions.bulk(filter, 'move-all', { date });
  }

  /**
   * «Перенести… на дату» строки: у строки с датами диалог открывается на её
   * сроке (начало периода), у бессрочной — на «сегодня»: команда ЗАДАЁТ срок
   * (`set_due`, ошибка 3f9ea2ee).
   */
  async function pickRowDate(row: TaskPanelRow): Promise<void> {
    const anchor = row.due ?? row.periodFrom;
    const date = await actions.pickDate(anchor ?? '');
    if (date !== null) actions.rowCommand(row, 'move', { date });
  }

  /** «Отложить…» вхождения: произвольные дата и время. */
  async function pickSnooze(row: ReminderPanelRow): Promise<void> {
    const until = await actions.pickDateTime(row.moment);
    if (until !== null) actions.reminderAction(row, 'snooze', until);
  }

  /**
   * Кнопка «⋮» шапки группы: содержимое меню задаёт экран через `headMenu`
   * (панель редактора мысли), иначе — встроенное меню «Дневника».
   */
  function makeMenuButton(kind: 'tasks' | 'reminders'): HTMLElement {
    return iconButton({
      icon: svgIcon('ellipsis', 14),
      title: t('tasks.groupCommands'),
      role: 'ghost',
      size: 's',
      class: 'ui-task-group-menu',
      onClick: (event) => {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const items = kind === 'tasks' ? (actions.headMenu?.() ?? tasksGroupMenu()) : [];
        if (items.length === 0) return;
        showMenuAt(rect.left, rect.bottom, items, { keyboard: true });
      },
    });
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
        // «Сделать бессрочными» — массовая форма команды строки (3cef7466).
        menuAction(t('tasks.undateAllPeriod'), () => actions.bulk(periodFilter, 'undate-all')),
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
  function subgroupMenu(
    kind: 'task' | 'reminder',
    filter: TaskMassFilter,
    rows: readonly TaskPanelRow[] = [],
  ): MenuItem[] {
    if (kind === 'reminder') return [];
    // Массовая «Сделать бессрочными» в группе из одних строк хроно-записей
    // ничего не делает (период строк вернёт пере-парс) — команды нет.
    const undateAllowed = rows.length === 0 || rows.some((row) => row.kind !== 'chronological');
    const items: MenuItem[] = [
      menuAction(t('tasks.cancelAllGroup'), () => actions.bulk(filter, 'cancel-all')),
      menuSubmenu(t('tasks.moveAllGroup'), [
        ...TASK_SHIFTS.map((item) =>
          menuAction(t(item.labelKey), () => actions.bulk(filter, 'move-all', item.shift)),
        ),
        menuAction(t('tasks.moveDate'), () => void pickBulkDate(filter)),
      ]),
    ];
    if (undateAllowed) {
      items.push(menuAction(t('tasks.undateAllGroup'), () => actions.bulk(filter, 'undate-all')));
    }
    return items;
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
    // «Открыть источник» есть и у хроно-строки БЕЗ дат (0.16.1, задача
    // `cfb8cb72`, пункт 3): раньше команда появлялась только при дате, и строку
    // из дневниковой записи без дат было не открыть. Адрес перехода знает
    // экран (`openRowSource`); чип даты — прежний путь по дню.
    if (actions.openRowSource !== undefined) {
      items.push(menuAction(t('tasks.openSource'), () => actions.openRowSource?.(row)));
      items.push(MENU_SEPARATOR);
    } else if (day !== null) {
      items.push(menuAction(t('tasks.openSource'), () => actions.openDay(day)));
      items.push(MENU_SEPARATOR);
    }
    items.push(
      menuSubmenu(
        t('tasks.moveRow'),
        [
          ...taskMoveShifts().map((item) =>
            menuAction(t(item.labelKey), () => actions.rowCommand(row, 'move', item.shift)),
          ),
          // Для бессрочной строки дата ЗАДАЁТ срок (ошибка 3f9ea2ee) — пункт
          // доступен, диалог открывается на «сегодня».
          menuAction(t('tasks.moveDate'), () => void pickRowDate(row)),
        ],
        { disabled: row.stale },
      ),
    );
    // «Сделать бессрочной» — только у строки с датами ПОСТОЯННОГО комментария:
    // у строки хроно-записи период вернётся из записи при пере-парсинге, сервер
    // отвечает 400 — команды в меню нет (уточнение ТЗ 2026-11-16).
    if (row.kind !== 'chronological') {
      items.push(
        menuAction(t('tasks.undateRow'), () => actions.rowCommand(row, 'undate'), {
          disabled: row.stale || day === null,
        }),
      );
    }
    items.push(
      menuAction(t('tasks.cancelRow'), () => actions.rowCommand(row, 'cancel'), {
        disabled: row.stale,
      }),
    );
    return items;
  }

  /** Строка меню команд вхождения напоминания. */
  function reminderRowMenu(row: ReminderPanelRow): MenuItem[] {
    const todayUntil = todaySnoozeUntil(row);
    return [
      menuAction(t('tasks.openSubject'), () => actions.reminderAction(row, 'open-subject')),
      menuAction(t('reminder.editSchedule'), () => actions.reminderAction(row, 'edit-schedule')),
      menuAction(t('tasks.dismissReminder'), () => actions.reminderAction(row, 'dismiss')),
      menuSubmenu(t('tasks.snoozeReminder'), [
        // «Сегодня» идёт первым — по плану 7e12f589. Пункт недоступен, если
        // сегодняшний час вхождения уже прошёл: сервер такую команду отклонит.
        menuAction(
          t('tasks.snoozeToday'),
          () => {
            if (todayUntil !== null) actions.reminderAction(row, 'snooze', todayUntil);
          },
          { disabled: todayUntil === null },
        ),
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
      // Чекбокс — КОМАНДА, а не правка текста: доступен и на серой строке,
      // повторный клик снимает отметку (ошибка d318a647).
      onChange: (checked) => actions.toggle(row, checked),
    });
    check.classList.add('ui-task-row-check');
    const textHost = div('ui-task-row-text');
    textHost.tabIndex = 0;
    /** Поле открытой правки строки (создаёт экран фабрикой компоненты). */
    let rowEditor: TaskRowEditor | null = null;
    /** Вернуть строку к виду снапшота (локально, без полной сверки списка). */
    const closeEdit = (): void => {
      editingKey = null;
      editingRaw = null;
      editingRange = null;
      rowEditor?.dispose();
      rowEditor = null;
      if (node.isConnected) fillTaskRow(node, currentTaskRow(row.key) ?? row);
    };
    /**
     * Собрать поле правки для загруженного текста. Поле даёт фабрика экрана
     * (компонента редактирования комментария), панель только отдаёт данные и
     * колбэки (0.16.1, задача `cfb8cb72`, пункт 1). `null` — фабрики нет:
     * правка недоступна, строка остаётся текстом.
     */
    const createEditor = (
      raw: string,
      range: { start: number; end: number } | null,
    ): TaskRowEditor | null => {
      const factory = options.createRowEditor;
      if (factory === undefined) return null;
      const blockEdit = range !== null;
      return factory({
        md: raw,
        classes: blockEdit ? ['ui-task-row-edit', TASK_ROW_BLOCK_EDIT_CLASS] : ['ui-task-row-edit'],
        ariaLabel: t(blockEdit ? 'tasks.editBlockAria' : 'tasks.editLineAria'),
        save: async (md) => {
          if (range !== null) {
            const saved = await actions.editBlock?.(row, range, md);
            return saved === true;
          }
          return actions.editLine(row, md);
        },
        closed: () => {
          if (editingKey === row.key) closeEdit();
        },
      });
    };
    /**
     * Открыть БЛОЧНУЮ правку строки (0.16.1, задача 7446eb25): вложенные строки
     * правятся вместе со строкой задачи, как блок трансклюзии. Источник читает
     * экран (`loadRawBlock`), компонент рисует поле.
     */
    const beginBlockEdit = (): void => {
      if (row.stale || editingKey === row.key || actions.loadRawBlock === undefined) return;
      editingKey = row.key;
      editingRaw = null;
      editingRange = null;
      void actions.loadRawBlock(row).then((block) => {
        if (editingKey !== row.key) return;
        if (block === null) {
          closeEdit();
          return;
        }
        editingRaw = block.text;
        editingRange = { start: block.start, end: block.end };
        // Правка — состояние КОМПОНЕНТЫ, а не данных строки: сверка по ключу его
        // не увидит, поэтому строку перерисовываем напрямую.
        if (node.isConnected) fillTaskRow(node, row);
      });
    };
    if (editingKey === row.key && editingRaw !== null) {
      // Правится СЫРАЯ строка `body_md` (маркер и чекбокс на месте): снапшот
      // `row.text` маркера не содержит, и запись его как всей строки уничтожила
      // бы задачу (блокер приёмки 64f7976a).
      const editor = createEditor(editingRaw, editingRange);
      if (editor === null) {
        actions.renderText(textHost, row);
      } else {
        rowEditor = editor;
        textHost.append(editor.root);
      }
    } else {
      actions.renderText(textHost, row);
      textHost.addEventListener('dblclick', () => {
        // Строка с вложенными строками правится БЛОКОМ: правка одной строки
        // оставила бы детей висеть на прежнем тексте (замечание 3 ТЗ 2026-11-18).
        if (row.children.length > 0) {
          beginBlockEdit();
          return;
        }
        if (row.stale || editingKey === row.key) return;
        editingKey = row.key;
        editingRaw = null;
        editingRange = null;
        // Сырую строку читает экран: компонент не знает сети. Пока ответа нет,
        // строка остаётся снапшотом; ответ пришёл — перерисовываем поле.
        void actions.loadRawLine(row).then((raw) => {
          if (editingKey !== row.key) return;
          if (raw === null) {
            closeEdit();
            return;
          }
          editingRaw = raw;
          if (node.isConnected) fillTaskRow(node, row);
        });
      });
    }
    const dates = div('ui-task-row-dates');
    for (const day of [row.periodFrom, row.due]) {
      if (day === null) continue;
      if (dates.querySelector(`[data-day="${day}"]`) !== null) continue;
      const chip = span(day, 'ui-task-row-date');
      chip.dataset['day'] = day;
      chip.addEventListener('click', () => {
        if (actions.openRowSource !== undefined) actions.openRowSource(row);
        else actions.openDay(day);
      });
      dates.append(chip);
    }
    // Облачка связанных мыслей рядом с датой задачи (0.16.1, задача
    // `cfb8cb72`, пункт 6): строка показывает свои субъектные ссылки облачками
    // (эталонный компонент, фабрику даёт экран `renderSubject`), а не только
    // текстом. Нет фабрики — облачков не рисуем.
    // В зоне «Задачи» редактора мысли облачка не рисуются вовсе (пункт 1
    // пачки 4): субъект у всех строк один — сама мысль. Слота в DOM тоже нет,
    // иначе пустой блок занимал бы место в строке.
    const subjects = rowSubjectClouds ? div('ui-task-row-subjects') : null;
    if (subjects !== null && actions.renderSubject !== undefined) {
      for (const id of row.subjectThoughts) {
        const cloud = span('', 'ui-task-row-subject-cloud');
        actions.renderSubject(cloud, { kind: 'thought', id, title: id });
        if (cloud.childNodes.length > 0) subjects.append(cloud);
      }
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
    // Строка с вложенными строками сворачиваемая и по умолчанию СВЁРНУТА:
    // каретка слева от чекбокса, дети — отдельным блоком ниже (пункт F ТЗ).
    const hasChildren = row.children.length > 0;
    const expanded = hasChildren && expandedChildren.has(row.key);
    node.classList.toggle('is-overdue', row.overdue);
    node.classList.toggle('has-children', hasChildren);
    // Строка в правке (0.16.1, уточнение 2026-11-19, пункт 3): многострочное
    // поле растягивает строку, и чекбокс обязан оставаться у ПЕРВОЙ строки
    // текста, а не уезжать в её середину (CSS `is-editing`).
    node.classList.toggle('is-editing', editingKey === row.key && editingRaw !== null);
    const leading: HTMLElement[] = [];
    if (hasChildren) {
      const caret = el('button', 'ui-task-row-caret');
      caret.setAttribute('type', 'button');
      caret.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      caret.setAttribute('aria-label', t('tasks.rowChildren'));
      caret.append(svgIcon('chevron-down', 11));
      caret.classList.toggle('collapsed', !expanded);
      caret.addEventListener('click', (event) => {
        event.stopPropagation();
        if (expandedChildren.has(row.key)) expandedChildren.delete(row.key);
        else expandedChildren.add(row.key);
        fillTaskRow(node, currentTaskRow(row.key) ?? row);
      });
      leading.push(caret);
    }
    node.replaceChildren(
      check,
      textHost,
      dates,
      ...(subjects === null ? [] : [subjects]),
      rowActions,
    );
    if (leading.length > 0) node.prepend(...leading);
    // Дети не дублируются под открытой блочной правкой: они уже в поле.
    if (hasChildren && expanded && !(editingKey === row.key && editingRange !== null)) {
      node.append(buildChildRows(row, beginBlockEdit));
    }
    // Фокус правки — ПОСЛЕ сборки строки (блокер 84c71c37): пока поле не в
    // документе, `.focus()` — no-op, и правка открывалась без каретки (Enter и
    // Ctrl+Enter до клика в поле не работали).
    if (rowEditor !== null) rowEditor.focus();
  }

  /**
   * Вложенные не-задачные строки под задачей (пункт F ТЗ 2026-11-17): пункт
   * чек-листа — настоящий чекбокс с отметкой источника (замечание 4 ТЗ
   * 2026-11-18), обычная строка — текст с отступом по уровню списка.
   *
   * Двойной клик по любому пункту открывает БЛОЧНУЮ правку родителя «как
   * трансклюзия» (замечание 3): блок правится одним куском.
   */
  function buildChildRows(row: TaskPanelRow, onEditBlock: () => void): HTMLElement {
    const box = div('ui-task-row-children');
    for (const child of row.children) {
      const line = div('ui-task-child-row');
      line.dataset['depth'] = String(child.depth);
      line.classList.toggle('is-checkbox', child.checkbox);
      line.classList.toggle('is-done', child.done === true);
      if (child.checkbox) {
        // Пункт чек-листа — ЧЕКБОКС, а не маркированная строка: отметка
        // приходит из проекции, клик — команда экрана (0.16.1, 7446eb25).
        const check = choiceControl('checkbox', {
          checked: child.done === true,
          onChange: (checked) => actions.toggleChild?.(row, child, checked),
        });
        check.classList.add('ui-task-child-check');
        line.append(check);
      } else {
        // Обычная вложенная строка списка — с маркером (0.16.1, уточнение
        // 2026-11-19, пункт 5): проекция хранит строку без маркера, поэтому
        // панель рисует маркер сама, паритетом с просмотром markdown, где
        // `<ul>` показывает точку. Строка чек-листа маркер не получает — у неё
        // контрол отметки.
        const marker = span('•', 'ui-task-child-marker');
        marker.setAttribute('aria-hidden', 'true');
        line.append(marker);
      }
      const text = div('ui-task-child-text');
      text.textContent = child.text;
      text.addEventListener('dblclick', () => onEditBlock());
      line.append(text);
      box.append(line);
    }
    return box;
  }

  /** Строка вхождения напоминания: субъект, момент, повтор, метка, команды. */
  function buildReminderRow(row: ReminderPanelRow): HTMLElement {
    const node = div(REMINDER_PANEL_ROW_CLASS);
    fillReminderRow(node, row);
    return node;
  }

  function fillReminderRow(node: HTMLElement, row: ReminderPanelRow): void {
    // Чекбокс вхождения (0.16.1, задача `cfb8cb72`, пункт 7): отметка =
    // отработал (dismiss вхождения), серия напоминания остаётся. Контрол
    // ОДНОСТОРОННИЙ — снятие отметки вернуло бы вхождение, которого сервер уже
    // не отдаёт; поэтому после отметки чекбокс только показывает состояние.
    const done = choiceControl('checkbox', {
      checked: row.done === true,
      onChange: (checked) => {
        if (checked && row.done !== true) actions.reminderDone?.(row);
        else if (!checked) check.checked = row.done === true;
      },
    });
    done.classList.add('ui-reminder-row-check');
    const check = done;
    // Строка напоминания — уже мысль: субъект показывается облачком мысли
    // (пункт C ТЗ 2026-11-17), формат — как у чипов полей ввода свойств.
    // Фабрику облачка знает экран (`renderSubject`); без неё — название строкой.
    const subject = div('ui-task-row-subject');
    if (actions.renderSubject !== undefined) {
      actions.renderSubject(subject, {
        kind: row.subjectType,
        id: row.subjectId,
        title: row.title,
      });
    } else {
      subject.append(span(row.title, 'ui-task-row-text'));
    }
    subject.addEventListener('click', () => actions.reminderAction(row, 'open-subject'));
    // Просроченное вхождение (дата напоминания в прошлом) — красным (пункт D).
    node.classList.toggle('is-overdue', row.overdue === true);
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
    node.replaceChildren(check, subject, moment, repeat, flags, actionsBox);
  }

  /**
   * Заголовок группы: название, счётчики, меню «⋮» (только при hover).
   * Группа сворачиваемая: каретка в заголовке, счётчики видны и в свёрнутом
   * виде (ошибка d0801eea).
   */
  function buildGroup(
    kind: 'tasks' | 'reminders',
    menuBtn: HTMLElement,
  ): {
    root: HTMLElement;
    counters: HTMLElement;
    sections: HTMLElement;
    section: CollapsibleSection;
  } {
    const counters = span('', 'ui-task-group-counters');
    const sections = div('ui-task-group-sections');
    const key =
      kind === 'tasks'
        ? TASK_PANEL_COLLAPSE_KEYS.tasksGroup
        : TASK_PANEL_COLLAPSE_KEYS.remindersGroup;
    const group = collapsibleSection({
      title: kind === 'tasks' ? t('tasks.groupTitle') : t('tasks.remindersGroupTitle'),
      getCollapsed: () => collapseState(key),
      onToggle: (collapsed) => {
        actions.setCollapsed?.(key, collapsed);
        nav?.refresh();
      },
      headerExtra: [counters],
      actions: [menuBtn],
      classes: {
        root: `${TASK_PANEL_GROUP_CLASS} ${
          kind === 'tasks' ? 'ui-task-group-tasks' : 'ui-task-group-reminders'
        }`,
        header: 'ui-task-group-head',
        title: 'ui-task-group-title',
        caret: 'ui-task-caret',
        body: 'ui-task-group-sections',
        actions: 'ui-task-group-actions',
      },
      body: sections,
    });
    return { root: group.root, counters, sections, section: group };
  }

  /**
   * Секция списка: сворачиваемый заголовок с кареткой и счётчиком строк +
   * подгруппы (ошибка d0801eea). Тело секции живёт постоянно и прячется
   * штатной сворачиваемой группой `lib/ui/collapsible`, поэтому свёрнутость
   * переживает перерисовку панели, а счётчик обновляется событием
   * `etn:set-count` (тело может быть снято с экрана).
   */
  function buildSection(
    section: TaskPanelSectionView | ReminderPanelSectionView,
    kind: 'task' | 'reminder',
  ): HTMLElement {
    if (section.flat === true) return buildFlatSection(section, kind);
    const list = div('ui-task-subgroup-list');
    const key = TASK_PANEL_COLLAPSE_KEYS.section(kind, section.key);
    const collapsible = collapsibleSection({
      title: section.title,
      count: `(${sectionRowCount(section)})`,
      getCollapsed: () => collapseState(key),
      onToggle: (collapsed) => {
        actions.setCollapsed?.(key, collapsed);
        nav?.refresh();
      },
      classes: {
        root: TASK_PANEL_SECTION_CLASS,
        header: 'ui-task-section-head',
        title: 'ui-task-section-title',
        count: 'ui-task-section-count',
        caret: 'ui-task-caret',
        body: 'ui-task-subgroup-list',
      },
      body: list,
    });
    const node = collapsible.root;
    node.dataset['section'] = section.key;
    sectionLists.set(node, list);
    sectionHandles.set(node, collapsible);
    sectionDefaults.set(node, false);
    renderSubgroups(list, section.subgroups, kind);
    return node;
  }

  /**
   * Плоская секция: строки без подгрупп — панель редактора мысли (секция задач
   * без подгрупп) и «Напоминания периода» при ОДНОЙ выбранной дате (пункт D ТЗ
   * 2026-11-17: облачка одним хронологическим списком). Секция с заголовком
   * сворачиваемая (счётчик в шапке, в том числе у свёрнутой); секция без
   * заголовка (активные строки панели редактора) — просто строки.
   */
  function buildFlatSection(
    section: TaskPanelSectionView | ReminderPanelSectionView,
    kind: 'task' | 'reminder',
  ): HTMLElement {
    const rows = section.rows ?? [];
    const rowsHost = div('ui-task-flat-rows');
    const taskSection = section as TaskPanelSectionView;
    /** Секция с заголовком сворачивается; без заголовка — плоский список. */
    const withHeader = section.title !== '' && taskSection.collapsible !== false;
    const key = TASK_PANEL_COLLAPSE_KEYS.section(kind, section.key);
    let node: HTMLElement;
    if (withHeader) {
      const fallbackCollapsed = taskSection.collapsed === true;
      const collapsible = collapsibleSection({
        title: section.title,
        count: `(${rows.length})`,
        getCollapsed: () => collapseState(key, fallbackCollapsed),
        onToggle: (collapsed) => {
          actions.setCollapsed?.(key, collapsed);
          nav?.refresh();
        },
        classes: {
          root: `${TASK_PANEL_SECTION_CLASS} ui-task-flat ui-task-flat-collapsible`,
          header: 'ui-task-flat-head',
          title: 'ui-task-section-title',
          count: 'ui-task-section-count',
          caret: 'ui-task-flat-caret',
          body: 'ui-task-flat-rows',
        },
        body: rowsHost,
      });
      node = collapsible.root;
      sectionHandles.set(node, collapsible);
      sectionDefaults.set(node, fallbackCollapsed);
    } else {
      node = div(`${TASK_PANEL_SECTION_CLASS} ui-task-flat`);
      node.append(rowsHost);
    }
    node.dataset['section'] = section.key;
    flatRowsHosts.set(node, rowsHost);
    paintFlatRows(rowsHost, rows, kind);
    return node;
  }

  /** Отрисовать строки плоской секции в форме своего списка. */
  function paintFlatRows(
    hostEl: HTMLElement,
    rows: readonly unknown[],
    kind: 'task' | 'reminder',
  ): void {
    if (kind === 'task') renderFlatRows(hostEl, rows as readonly TaskPanelRow[]);
    else renderFlatReminderRows(hostEl, rows as readonly ReminderPanelRow[]);
  }

  /**
   * Изменилось ТОЛЬКО состояние чекбокса/серости/просрочки (0.16.1, пачка 3,
   * пункт 4): текст, даты, вложенные строки и облачка те же. Такую строку
   * патчим по месту — полная пересборка содержимого дёргала панель на каждом
   * клике чекбокса и на каждом чужом событии.
   */
  function onlyCheckStateChanged(prev: TaskPanelRow, next: TaskPanelRow): boolean {
    if (prev.done === next.done && prev.stale === next.stale && prev.overdue === next.overdue) {
      return false;
    }
    const { done: _d1, stale: _s1, overdue: _o1, ...restPrev } = prev;
    const { done: _d2, stale: _s2, overdue: _o2, ...restNext } = next;
    return deepEqual(restPrev, restNext);
  }

  /** Точечно переставить признаки состояния строки, не трогая её содержимое. */
  function patchTaskRowState(node: HTMLElement, row: TaskPanelRow): void {
    node.classList.toggle(TASK_PANEL_ROW_STALE_CLASS, row.stale);
    node.classList.toggle('is-done', row.done);
    node.classList.toggle('is-overdue', row.overdue);
    const check = node.querySelector<HTMLInputElement>('.ui-task-row-check');
    if (check !== null && check.checked !== row.done) check.checked = row.done;
  }

  /** Обновить строку задачи: точечный патч состояния или полная пересборка. */
  function updateTaskRow(rowNode: HTMLElement, row: TaskPanelRow, prev: TaskPanelRow): void {
    if (editingKey === row.key) return;
    if (onlyCheckStateChanged(prev, row)) {
      patchTaskRowState(rowNode, row);
      return;
    }
    fillTaskRow(rowNode, row);
  }

  /** Отрисовать строки плоской секции (keyed-сверка по адресу проекции). */
  function renderFlatRows(hostEl: HTMLElement, rows: readonly TaskPanelRow[]): void {
    reconcileKeyed(hostEl, rows, {
      keyAttr: TABLE_ROW_KEY_ATTR,
      key: (row) => row.key,
      build: (row) => buildTaskRow(row),
      update: (rowNode, row, prev) => updateTaskRow(rowNode, row, prev),
    });
  }

  /** Отрисовать строки плоской секции напоминаний (пункт D ТЗ 2026-11-17). */
  function renderFlatReminderRows(hostEl: HTMLElement, rows: readonly ReminderPanelRow[]): void {
    reconcileKeyed(hostEl, rows, {
      keyAttr: TABLE_ROW_KEY_ATTR,
      key: (row) => row.key,
      build: (row) => buildReminderRow(row),
      update: (rowNode, row) => fillReminderRow(rowNode, row),
    });
  }

  /**
   * Обновить плоскую секцию при повторной отрисовке: строки и счётчик
   * сворачиваемой секции (заголовок и свёрнутость узла не пересоздаются).
   */
  function updateFlatSection(
    node: HTMLElement,
    section: TaskPanelSectionView | ReminderPanelSectionView,
    kind: 'task' | 'reminder',
  ): void {
    const rows = section.rows ?? [];
    // Свёрнутая секция держит тело вне DOM — берём ссылку, сохранённую сборкой.
    const rowsHost =
      flatRowsHosts.get(node) ?? node.querySelector<HTMLElement>('.ui-task-flat-rows');
    if (rowsHost !== null) paintFlatRows(rowsHost, rows, kind);
    node.dispatchEvent(new CustomEvent('etn:set-count', { detail: `(${rows.length})` }));
  }

  /** Подгруппа: заголовок с количеством и меню «⋮» + список строк. */
  function buildSubgroupBucket(): HTMLElement {
    const subgroup = div(TASK_PANEL_SUBGROUP_CLASS);
    const head = div('ui-task-subgroup-head');
    // Значок группы-даты (календарик) и слот облачка группы-мысли (пункт E ТЗ
    // 2026-11-17): оба места постоянные, поэтому сверка только показывает/
    // скрывает их и перерисовывает содержимое.
    const icon = span('', 'ui-task-subgroup-icon');
    icon.hidden = true;
    const subject = span('', 'ui-task-subgroup-subject');
    subject.hidden = true;
    head.append(
      icon,
      subject,
      span('', 'ui-task-subgroup-title'),
      span('', 'ui-task-subgroup-count'),
    );
    subgroup.append(head, div('ui-task-subgroup-rows'));
    return subgroup;
  }

  /** Отрисовка навигации по видимым строкам (серая строка тоже достижима). */
  let nav: ListNavHandle<PanelEntry> | null = null;

  /** Строки секции задач независимо от её формы (плоская/с подгруппами). */
  function sectionRows(section: TaskPanelSectionView): TaskPanelRow[] {
    if (section.flat === true) return section.rows ?? [];
    return section.subgroups.flatMap((subgroup) => subgroup.rows);
  }

  /**
   * Текущий снапшот строки из ПОСЛЕДНЕЙ отрисовки. Замыкание строки хранит
   * снапшот момента её построения: после инлайн-правки экран уже отрисовал
   * новый текст (ошибка 45480290), и возврат строки из правки обязан взять
   * свежий снапшот, иначе на экране остался бы прежний текст.
   */
  function currentTaskRow(key: string): TaskPanelRow | null {
    if (view === null) return null;
    for (const section of view.taskSections) {
      const found = sectionRows(section).find((item) => item.key === key);
      if (found !== undefined) return found;
    }
    return null;
  }

  /** Секция попадает в отрисовку, только когда в ней есть строки. */
  function sectionVisible(section: TaskPanelSectionView | ReminderPanelSectionView): boolean {
    const flat = flatRowsOf(section);
    if (flat !== null) return flat.length > 0;
    return section.subgroups.length > 0;
  }

  /**
   * Секция скрыта свёрнутым блоком? Навигация списка ходит только по ВИДИМЫМ
   * строкам: клавиши не должны «проваливаться» в строки свёрнутой панели,
   * группы или секции (ошибка d0801eea).
   */
  function sectionCollapsed(kind: 'task' | 'reminder', key: string): boolean {
    if (headless) return false;
    if (collapseState(TASK_PANEL_COLLAPSE_KEYS.panel)) return true;
    const group =
      kind === 'task'
        ? TASK_PANEL_COLLAPSE_KEYS.tasksGroup
        : TASK_PANEL_COLLAPSE_KEYS.remindersGroup;
    return collapseState(group) || collapseState(TASK_PANEL_COLLAPSE_KEYS.section(kind, key));
  }

  function entries(): PanelEntry[] {
    if (view === null) return [];
    const list: PanelEntry[] = [];
    for (const section of view.taskSections) {
      if (sectionCollapsed('task', section.key)) continue;
      for (const row of sectionRows(section)) list.push({ key: row.key, kind: 'task' });
    }
    for (const section of view.reminderSections) {
      if (sectionCollapsed('reminder', section.key)) continue;
      const flat = flatRowsOf(section);
      if (flat !== null) {
        for (const row of flat) list.push({ key: row.key, kind: 'reminder' });
        continue;
      }
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
        const row = sectionRows(section).find((item) => item.key === entry.key);
        if (row === undefined) continue;
        if (actions.openRowSource !== undefined) {
          actions.openRowSource(row);
          return;
        }
        const day = row.due ?? row.periodFrom;
        if (day !== null) actions.openDay(day);
        return;
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
      editingRange = null;
    }
    root.dataset['stale'] = next.stale ? '1' : '0';
    undoBtn.hidden = !next.canUndo;
    refreshBtn.classList.toggle('is-stale', next.stale);
    // Сохранённая свёрнутость применяется к уже построенным узлам: настройки
    // экрана читаются асинхронно, после монтирования панели (ошибка d0801eea).
    // Переключение пользователя успевает записать состояние ДО `apply()`, так
    // что повторное применение не спорит с кликом.
    const panelCollapsedNow = collapseState(TASK_PANEL_COLLAPSE_KEYS.panel);
    panelSection?.setCollapsed(panelCollapsedNow);
    // Класс свёрнутой панели (пункт 1 уточнения 2026-11-19) держим в согласии с
    // применённым состоянием — в том числе когда `ui_state` пришёл асинхронно и
    // свёрнутость сменилась не кликом по шапке.
    syncPanelCollapsed(panelCollapsedNow);
    applyPanelHeight();
    taskGroup?.section.setCollapsed(collapseState(TASK_PANEL_COLLAPSE_KEYS.tasksGroup));
    reminderGroup?.section.setCollapsed(collapseState(TASK_PANEL_COLLAPSE_KEYS.remindersGroup));

    // Перечитывание УЖЕ показанного списка не двигает его (0.16.1, пачка 4,
    // пункт 2): строка загрузки стоит в потоке ПЕРЕД списком, и её появление
    // сдвигало весь список на каждом «Обновить» и автообновлении. Признак
    // загрузки нужен только там, где показывать ещё нечего (первая загрузка).
    const hasContent =
      next.taskSections.some((section) => sectionRowCount(section) > 0) ||
      next.reminderSections.some((section) => sectionRowCount(section) > 0);
    if (next.loading && !hasContent) {
      statusHost.hidden = false;
      statusHost.replaceChildren(loadingState());
    } else if (next.error !== null) {
      statusHost.hidden = false;
      statusHost.replaceChildren(span(next.error, 'ui-task-panel-error'));
    } else {
      statusHost.hidden = true;
      statusHost.replaceChildren();
    }

    if (taskGroup !== null) {
      taskGroup.counters.textContent = t('tasks.counters', [
        next.counters.open,
        next.counters.done,
      ]);
    }
    if (headless) {
      // Счётчики панели редактора живут в бейдже группы `main.tasks`: тело
      // публикует их тем же событием, что и группы «Упоминаний».
      root.dispatchEvent(
        new CustomEvent('etn:set-count', {
          bubbles: true,
          detail: t('tasks.counters', [next.counters.open, next.counters.done]),
        }),
      );
    }
    if (reminderGroup !== null) {
      reminderGroup.root.hidden = next.reminderSections.length === 0 && next.reminderCount === 0;
      // Счётчик вхождений склоняется: «1 вхождение / 3 вхождения / 5 вхождений».
      reminderGroup.counters.textContent = tp('plurals.reminderOccurrence', next.reminderCount);
    }

    renderSections(taskGroup?.sections ?? flatHost, next.taskSections, 'task');
    if (reminderGroup !== null) {
      renderSections(reminderGroup.sections, next.reminderSections, 'reminder');
    }
    nav?.refresh();
  }

  /**
   * Отрисовать секции одного списка (задачи или напоминания).
   *
   * Форма секции — часть identity её узла: плоский список и список с
   * подгруппами несовместимы по внутренней структуре (заголовок-счётчик,
   * реестры строк, обработчики). `reconcileKeyed` обновляет узел по ключу и
   * форму не меняет, поэтому узел другой формы снимается перед сверкой — она
   * строит его заново. Без этого при смене периода «одна дата ⇄ несколько»
   * секции «Просрочено»/«Сегодня» оставались плоскими до перезагрузки
   * (блокер проверки 2026-11-17).
   */
  function renderSections(
    hostEl: HTMLElement,
    sections: ReadonlyArray<TaskPanelSectionView | ReminderPanelSectionView>,
    kind: 'task' | 'reminder',
  ): void {
    const wanted = new Map(sections.map((section) => [section.key, section]));
    for (const node of Array.from(hostEl.children) as HTMLElement[]) {
      const section = wanted.get(node.getAttribute('data-section') ?? '');
      // Секции, которых нет в снимке, удалит сама сверка (у них другой путь).
      if (section === undefined) continue;
      if (node.classList.contains('ui-task-flat') !== (section.flat === true)) {
        hostEl.removeChild(node);
      }
    }
    reconcileKeyed(
      hostEl,
      sections.filter((section) => sectionVisible(section)),
      {
        keyAttr: 'data-section',
        key: (section) => section.key,
        // `build` обязан собрать узел ПОЛНОСТЬЮ: сверка не зовёт `update` для
        // новых элементов (контракт `keyed-list.ts`).
        build: (section) => buildSection(section, kind),
        update: (node, section) => {
          // Свёрнутость из `ui_state` применяется и к уже построенному узлу:
          // настройки приходят после первой отрисовки (ошибка d0801eea).
          sectionHandles
            .get(node)
            ?.setCollapsed(
              collapseState(
                TASK_PANEL_COLLAPSE_KEYS.section(kind, section.key),
                sectionDefaults.get(node) ?? false,
              ),
            );
          if (section.flat === true) {
            updateFlatSection(node, section, kind);
            return;
          }
          const titleNode = node.querySelector('.ui-task-section-title');
          if (titleNode !== null) titleNode.textContent = section.title;
          // Тело свёрнутой секции снято с экрана — ссылку держит реестр.
          const list =
            sectionLists.get(node) ?? node.querySelector<HTMLElement>('.ui-task-subgroup-list');
          if (list !== null) renderSubgroups(list, section.subgroups, kind);
          node.dispatchEvent(
            new CustomEvent('etn:set-count', { detail: `(${sectionRowCount(section)})` }),
          );
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
    const countNode = node.querySelector('.ui-task-subgroup-count');
    const iconNode = node.querySelector<HTMLElement>('.ui-task-subgroup-icon');
    const subjectNode = node.querySelector<HTMLElement>('.ui-task-subgroup-subject');
    // Группа-мысль показывает название облачком с иконкой (пункт E ТЗ
    // 2026-11-17) — формат как у чипов полей ввода свойств; рисовать облачко
    // умеет экран (`renderSubject`), панель только освобождает место.
    const subject = subgroup.subject ?? null;
    const cloud = subject !== null && actions.renderSubject !== undefined;
    if (iconNode !== null) {
      const calendar = subgroup.icon === 'calendar';
      iconNode.hidden = !calendar;
      if (calendar && iconNode.childElementCount === 0) {
        iconNode.append(svgIcon('calendar-month', 12));
      }
    }
    if (subjectNode !== null) {
      subjectNode.hidden = !cloud;
      if (cloud && subject !== null) {
        subjectNode.replaceChildren();
        actions.renderSubject?.(subjectNode, subject);
      } else if (!cloud) {
        subjectNode.replaceChildren();
      }
    }
    if (titleNode !== null) {
      titleNode.textContent = cloud ? '' : subgroup.title;
      if (titleNode instanceof HTMLElement) titleNode.hidden = cloud;
    }
    if (countNode !== null) countNode.textContent = String(subgroup.rows.length);
    subgroupFilters.set(node, subgroup.filter);
    subgroupTitles.set(node, subgroup.title);
    if (kind === 'reminder') subgroupReminderRows.set(node, subgroup.rows as ReminderPanelRow[]);
    else subgroupTaskRows.set(node, subgroup.rows as TaskPanelRow[]);
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
                ? subgroupMenu(
                    'task',
                    subgroupFilters.get(node) ?? {},
                    subgroupTaskRows.get(node) ?? [],
                  )
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
        update: (rowNode, row, prev) => updateTaskRow(rowNode, row, prev),
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
    headActions(): HTMLElement[] {
      // Шапка headless-панели (карточка мысли): «Отменить» живёт здесь же —
      // иначе массовая команда в зоне остаётся без отмены (вердикт e984a2db).
      return headless ? [undoBtn, refreshBtn, tasksMenuBtn] : [];
    },
    destroy(): void {
      nav?.destroy();
      nav = null;
      host.replaceChildren();
    },
    panelCollapsed(): boolean {
      return collapseState(TASK_PANEL_COLLAPSE_KEYS.panel);
    },
    panelHeight(): number | null {
      return actions.panelHeight?.() ?? null;
    },
    setPanelHeight(height: number): void {
      actions.setPanelHeight?.(height);
      applyPanelHeight();
      nav?.refresh();
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

/**
 * Сдвиг UTC-инстанса на календарный сдвиг (`days`/`months`) — для «Отложить».
 * Счёт один: `shiftInstant` из `lib/dates.ts` (тот же сдвиг у меню флага напоминаний).
 */
export function shiftIso(iso: string, shift: TaskShift): string {
  return shiftInstant(iso, shift);
}
