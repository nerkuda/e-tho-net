/**
 * Модель панели «Задачи и напоминания» — чистая логика без DOM и сети
 * (0.16.1, задача 64f7976a; элементы f76ed829/15f8ea2f/498f23e0, требования
 * 6762adb0/0e85b66e/e6af8b9e/3616cfec/db1d9548).
 *
 * Зачем отдельный модуль. Пороги группировки, состав секций, счётчики,
 * признак «строка устарела» и раскладка напоминаний по «сегодня/просрочено» —
 * правила, которые обязаны проверяться тестами без DOM и сети. Компонент
 * `task-panel.ts` только рисует то, что здесь посчитано; экран
 * `screens/chronicle/tasks-panel.ts` только загружает данные и зовёт действия.
 *
 * **Пороги (требование 6762adb0).** 1 элемент — по мыслям (субъектным
 * строкам), 2–14 — по датам, 15–50 — по неделям, больше 50 — по месяцам.
 * Неделя начинается с первого дня недели сети (требование 1b77decd: его
 * учитывают ВСЕ календарные виджеты), поэтому режим принимает номер ISO-дня
 * явно. Строки без даты собираются в хвостовую группу «Без даты», строки без
 * субъекта — в группу «Без мысли»; эта группа всегда последняя.
 *
 * **Секции.** Секции приходят готовыми: сервер отдаёт их РАЗНЫМИ запросами
 * (`scope=open` в периоде, `overdue` и `undated` — сквозные), модель лишь
 * раскладывает строки каждой секции по группам, не смешивая их.
 *
 * **«Устарела» (требование 0e85b66e, уточнение ошибки d318a647).** Серая
 * строка — снапшот этой СТРОКИ, а не всей записи: правка из панели адресуется
 * `comment_id`+`line_no` и красит только правленую строку, остальные строки
 * записи остаются рабочими. Внешнее изменение записи (событие слоя) не знает
 * номера строки — до «Обновить» устаревшей считается вся запись. Третья
 * причина — проекция построена из прежней ревизии комментария
 * (`revision !== parsed_revision`). Глобальная «Обновить» подсвечивается, если
 * устарела хоть одна строка либо пришло событие напоминаний `reminders.changed`.
 */

import type { Reminder, ReminderListResult, TaskDTO, TaskMassFilter } from '@etn/shared';

/** Пороги группировки по количеству элементов (требование 6762adb0). */
export const TASK_GROUP_THRESHOLDS = {
  /** 1 элемент — по мыслям. */
  thoughts: 1,
  /** 2–14 — по датам (верхняя граница). */
  dates: 14,
  /** 15–50 — по неделям (верхняя граница). */
  weeks: 50,
} as const;

/** Режим группировки списка. */
export type TaskGroupingMode = 'thoughts' | 'dates' | 'weeks' | 'months';

/**
 * Режим группировки по количеству элементов: 1 — по мыслям, 2–14 — по датам,
 * 15–50 — по неделям, больше 50 — по месяцам (требование 6762adb0).
 */
export function taskGroupingMode(count: number): TaskGroupingMode {
  if (count <= TASK_GROUP_THRESHOLDS.thoughts) return 'thoughts';
  if (count <= TASK_GROUP_THRESHOLDS.dates) return 'dates';
  if (count <= TASK_GROUP_THRESHOLDS.weeks) return 'weeks';
  return 'months';
}

/** Что модель знает о строке для группировки. */
export interface PanelGroupable {
  /** Стабильный ключ строки (переживает перерисовку). */
  key: string;
  /** Календарный день строки (`YYYY-MM-DD`), `null` — даты нет. */
  day: string | null;
  /** Субъект строки (мысль/публикация), `null` — субъекта нет. */
  subjectId: string | null;
}

/** Группа строк одного списка: режим, диапазон и строки в исходном порядке. */
export interface PanelGroup<T extends PanelGroupable> {
  /** Стабильный ключ группы (строится из режима и значения). */
  key: string;
  kind: TaskGroupingMode;
  /** Начало диапазона группы по датам (`YYYY-MM-DD`), `null` — без даты. */
  from: string | null;
  /** Конец диапазона группы по датам (`YYYY-MM-DD`), `null` — без даты. */
  to: string | null;
  /** Субъект группы режима «по мыслям». */
  subjectId: string | null;
  rows: T[];
}

/** Ключ группы «строки без субъекта». */
export const TASK_GROUP_NO_SUBJECT = 'no-subject';

/** Ключ группы «строки без даты». */
export const TASK_GROUP_NO_DATE = 'no-date';

/** Разобрать `YYYY-MM-DD` в UTC-дату (только календарная арифметика). */
function parseDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date));
}

/** Отформатировать UTC-дату в `YYYY-MM-DD`. */
function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Сдвиг календарного дня на `delta` дней (невалидный день возвращается как есть). */
export function shiftDay(day: string, delta: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const base = parseDay(day);
  base.setUTCDate(base.getUTCDate() + delta);
  return formatDay(base);
}

/**
 * Начало недели, содержащей `day`, при первом дне недели `firstDayOfWeek`
 * (ISO: 1 = понедельник … 7 = воскресенье). Возвращает `YYYY-MM-DD`.
 */
export function weekStartOf(day: string, firstDayOfWeek: number): string {
  const first = firstDayOfWeek >= 1 && firstDayOfWeek <= 7 ? firstDayOfWeek : 1;
  const iso = parseDay(day).getUTCDay();
  const weekday = iso === 0 ? 7 : iso;
  return shiftDay(day, -((weekday - first + 7) % 7));
}

/** Ключ месяца (`YYYY-MM`) календарного дня. */
export function monthKeyOf(day: string): string {
  return day.slice(0, 7);
}

/** Последний день месяца `YYYY-MM` (`YYYY-MM-DD`). */
export function lastDayOfMonth(month: string): string {
  const [year, monthNo] = month.split('-').map(Number) as [number, number];
  return formatDay(new Date(Date.UTC(year, monthNo, 0)));
}

/** Группа без даты — хвостовая, всегда последняя. */
function noDateGroup<T extends PanelGroupable>(mode: TaskGroupingMode): PanelGroup<T> {
  return { key: TASK_GROUP_NO_DATE, kind: mode, from: null, to: null, subjectId: null, rows: [] };
}

/**
 * Разложить строки списка по группам согласно режиму (пороги 6762adb0).
 *
 * Порядок строк внутри группы — исходный (сервер уже отсортировал по сроку);
 * группы идут в порядке первого появления, хвостовая группа «Без даты» —
 * последней. Каждая группа несёт диапазон `from`/`to`, по которому экран
 * строит фильтр массовой команды: «отменить/перенести всё по этой группе»
 * адресуется проекцией, а не перечнем строк (требование e6af8b9e).
 */
export function groupPanelRows<T extends PanelGroupable>(
  rows: readonly T[],
  mode: TaskGroupingMode,
  options: { firstDayOfWeek: number },
): PanelGroup<T>[] {
  const groups = new Map<string, PanelGroup<T>>();
  let tail: PanelGroup<T> | null = null;

  /** Взять (или создать) группу по ключу. */
  const take = (group: PanelGroup<T>): PanelGroup<T> => {
    const existing = groups.get(group.key);
    if (existing !== undefined) return existing;
    if (group.from === null && group.key === TASK_GROUP_NO_DATE) tail = group;
    groups.set(group.key, group);
    return group;
  };

  for (const row of rows) {
    let group: PanelGroup<T>;
    if (mode === 'thoughts') {
      const subject = row.subjectId;
      group = take({
        key: subject === null ? TASK_GROUP_NO_SUBJECT : `thought:${subject}`,
        kind: mode,
        from: row.day,
        to: row.day,
        subjectId: subject,
        rows: [],
      });
      // Диапазон группы-мысли — объединение дней её строк (для фильтра
      // массовой команды он не нужен: там адресация по `thought_id`).
      if (row.day !== null) {
        if (group.from === null || row.day < group.from) group.from = row.day;
        if (group.to === null || row.day > group.to) group.to = row.day;
      }
    } else if (row.day === null) {
      group = take(noDateGroup<T>(mode));
    } else if (mode === 'dates') {
      group = take({
        key: `date:${row.day}`,
        kind: mode,
        from: row.day,
        to: row.day,
        subjectId: null,
        rows: [],
      });
    } else if (mode === 'weeks') {
      const start = weekStartOf(row.day, options.firstDayOfWeek);
      group = take({
        key: `week:${start}`,
        kind: mode,
        from: start,
        to: shiftDay(start, 6),
        subjectId: null,
        rows: [],
      });
    } else {
      const month = monthKeyOf(row.day);
      group = take({
        key: `month:${month}`,
        kind: mode,
        from: `${month}-01`,
        to: lastDayOfMonth(month),
        subjectId: null,
        rows: [],
      });
    }
    group.rows.push(row);
  }

  const ordered: PanelGroup<T>[] = [];
  for (const group of groups.values()) {
    if (group === tail) continue;
    ordered.push(group);
  }
  if (tail !== null) ordered.push(tail);
  return ordered;
}

/** Строка задачи в панели (view-модель): данные для отрисовки и действий. */
export interface TaskPanelRow extends PanelGroupable {
  commentId: string;
  /** Номер строки `body_md` с нуля (адрес `PATCH /tasks`). */
  lineNo: number;
  /**
   * Снапшот текста строки БЕЗ маркера задачи (для показа). Для инлайн-правки
   * компонента запрашивает СЫРУЮ строку `body_md` (`loadRawLine`), иначе
   * сохранение потеряло бы маркер и чекбокс.
   */
  text: string;
  done: boolean;
  /** Серая строка: устарела до «Обновить» и не редактируется. */
  stale: boolean;
  /** Пункт чек-листа под родительской задачей (показывается с отступом). */
  subtask: boolean;
  /** Первая date-ссылка строки (`YYYY-MM-DD`), `null` — строка без дат. */
  periodFrom: string | null;
  /** Последняя date-ссылка строки — срок (`YYYY-MM-DD`), `null` — без дат. */
  due: string | null;
  /** Мысли из ID-ссылок строки (для группировки по мыслям и перехода). */
  subjectThoughts: string[];
}

/** Ключ строки задачи: адрес проекции (`comment_id` + `line_no`). */
export function taskRowKey(ref: { comment_id: string; line_no: number }): string {
  return `${ref.comment_id}:${ref.line_no}`;
}

/**
 * Признаки устаревания строк панели (требование 0e85b66e, ошибка d318a647).
 *
 * Серость строки — про её СНАПШОТ, а не про всю запись: правка одной строки
 * записи (чекбокс, перенос, отмена) не блокирует остальные строки той же
 * записи. Поэтому адресация двух видов:
 *  • `rows` — строки, изменённые ИЗ САМОЙ панели: адрес `comment_id:line_no`
 *    ровно тот, что правили (вторая строка записи остаётся свежей);
 *  • `comments` — записи, изменённые ВНЕ панели: событие слоя не несёт номера
 *    строки, поэтому до «Обновить» устаревшей считается вся запись.
 */
export interface TaskPanelStaleness {
  /** Адреса строк (`comment_id:line_no`), изменённых из панели. */
  rows?: ReadonlySet<string>;
  /** Комментарии-источники, изменённые вне панели. */
  comments?: ReadonlySet<string>;
}

/**
 * Строка задачи устарела? Три причины (требование 0e85b66e, ошибка d318a647):
 *  • строка изменена из панели (адрес `comment_id:line_no` в {@link TaskPanelStaleness.rows});
 *  • комментарий-источник изменён вне панели (id в {@link TaskPanelStaleness.comments});
 *  • проекция построена из прежней ревизии комментария.
 */
export function taskRowIsStale(row: TaskDTO, stale: TaskPanelStaleness = {}): boolean {
  return (
    stale.rows?.has(taskRowKey(row)) === true ||
    stale.comments?.has(row.comment_id) === true ||
    row.revision !== row.parsed_revision
  );
}

/**
 * Строка проекции → строка панели. `done` — показанное состояние чекбокса для
 * строки, переключённой из панели: снапшот `state` не перечитывается до
 * «Обновить», но чекбокс обязан показывать новое состояние (повторный клик
 * снимает отметку, ошибка d318a647).
 */
export function taskRowView(
  row: TaskDTO,
  stale: TaskPanelStaleness = {},
  done?: boolean,
): TaskPanelRow {
  return {
    key: taskRowKey(row),
    commentId: row.comment_id,
    lineNo: row.line_no,
    text: row.text,
    done: done ?? row.done,
    stale: taskRowIsStale(row, stale),
    subtask: row.subtask,
    periodFrom: row.period_from,
    due: row.due,
    day: row.due ?? row.period_from,
    subjectThoughts: row.subject_thoughts,
    subjectId: row.subject_thoughts[0] ?? null,
  };
}

/** Счётчики заголовка группы: открытых и выполненных. */
export function taskCounters(rows: readonly TaskDTO[]): { open: number; done: number } {
  let open = 0;
  let done = 0;
  for (const row of rows) {
    if (row.done) done += 1;
    else open += 1;
  }
  return { open, done };
}

/**
 * Порядок строк панели «Задачи» редактора мысли (элемент `f3893859`): строки
 * без даты — ВСЕГДА вверху, дальше по возрастанию срока. Сортировка устойчива:
 * строки с одинаковым сроком сохраняют серверный порядок.
 */
export function orderTaskRowsUndatedFirst<T extends { due: string | null }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((left, right) => {
    if (left.due === right.due) return 0;
    if (left.due === null) return -1;
    if (right.due === null) return 1;
    return left.due < right.due ? -1 : 1;
  });
}

/**
 * Нужен ли перезапрос панели (требование 0e85b66e): пришло событие
 * напоминаний `reminders.changed`, устарела хоть одна строка либо глобальный
 * маркер проекции ушёл вперёд относительно загруженного.
 */
export function panelNeedsRefresh(input: {
  rows: readonly TaskDTO[];
  stale?: TaskPanelStaleness;
  remindersChanged?: boolean;
  markerAdvanced?: boolean;
}): boolean {
  if (input.remindersChanged === true || input.markerAdvanced === true) return true;
  return input.rows.some((row) => taskRowIsStale(row, input.stale));
}

/**
 * Глобальный маркер проекции (`max_revision` из GET /tasks) ушёл вперёд?
 * Ревизия события больше загруженного маркера — в сети изменилась запись,
 * которую панель ещё не перечитывала (уточнение e6d65f51 0.16.1).
 */
export function panelMarkerAdvanced(
  eventRevision: number | null,
  loadedMaxRevision: number,
): boolean {
  return eventRevision !== null && eventRevision > loadedMaxRevision;
}

/**
 * Видимость зоны «Задачи» вкладки «Основное» (элемент `f3893859`, 0.16.1):
 * пустая панель не показывается — комментарий занимает вкладку целиком.
 * Пока идёт загрузка или панель не прочиталась (ошибка), зона видима: иначе
 * пользователь не увидит ни строк, ни сообщения и не дотянется до «Обновить».
 */
export function taskZoneVisible(state: {
  rowCount: number;
  loading: boolean;
  hasError: boolean;
}): boolean {
  return state.rowCount > 0 || state.loading || state.hasError;
}

/**
 * Строки задач, попадающие под фильтр массовой команды (требование e6af8b9e):
 * зеркало серверного отбора `GET /tasks` — тот же фильтр уходит в
 * `PATCH /tasks`, поэтому подтверждение и undo считают те же строки.
 */
export function taskRowsForFilter(rows: readonly TaskDTO[], filter: TaskMassFilter): TaskDTO[] {
  return rows.filter((row) => {
    if (filter.comment_id !== undefined && row.comment_id !== filter.comment_id) return false;
    if (filter.thought_id !== undefined && !row.subject_thoughts.includes(filter.thought_id)) {
      return false;
    }
    if (filter.from !== undefined && (row.period_to === null || row.period_to < filter.from)) {
      return false;
    }
    if (filter.to !== undefined && (row.period_from === null || row.period_from > filter.to)) {
      return false;
    }
    if (filter.scope === 'open' && row.done) return false;
    if (filter.scope === 'done' && !row.done) return false;
    if (filter.scope === 'undated' && row.period_from !== null) return false;
    if (filter.scope === 'overdue') {
      if (row.due === null || row.done) return false;
      if (filter.today !== undefined && row.due >= filter.today) return false;
    }
    return true;
  });
}

/**
 * План массовой команды: затронутые СТРОКИ (их считает подтверждение —
 * e6af8b9e «сколько строк») и записи-источники (одна правка `body_md` на запись).
 * Строк может быть больше записей: в одной записи несколько задач.
 */
export function planTaskBulk(
  rows: readonly TaskDTO[],
  filter: TaskMassFilter,
): { rows: TaskDTO[]; commentIds: string[] } {
  const selected = taskRowsForFilter(rows, filter);
  return { rows: selected, commentIds: [...new Set(selected.map((row) => row.comment_id))] };
}

/**
 * Заменить одну строку `body_md` целиком (правка сохраняет маркер и чекбокс:
 * вызывающий передаёт СЫРУЮ строку). `null` — номера строки нет.
 */
export function replaceTaskLine(bodyMd: string, lineNo: number, line: string): string | null {
  const lines = bodyMd.split('\n');
  if (lineNo < 0 || lineNo >= lines.length) return null;
  if (lines[lineNo] === line) return bodyMd;
  lines[lineNo] = line;
  return lines.join('\n');
}

/** Календарных дней от `from` до `to` (обе даты `YYYY-MM-DD`). */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86_400_000);
}

/** Строка вхождения напоминания в панели (view-модель). */
export interface ReminderPanelRow extends PanelGroupable {
  reminderId: string;
  subjectType: 'thought' | 'publication';
  subjectId: string;
  /** Название субъекта (мысль/публикация) или его id до доразрешения. */
  title: string;
  /** Момент ПОКАЗА вхождения (UTC-инстанс): `until` для отложенного. */
  moment: string;
  /**
   * Момент вхождения ПО РАСПИСАНИЮ — адрес исключения для snooze/dismiss
   * (требование 86cb7451, операция 500d1b3d). У отложенного вхождения `moment`
   * — его `until`, а исключение всё равно адресуется исходным моментом.
   */
  occurrenceAt: string;
  status: 'active' | 'snoozed';
  /** Человекочитаемое описание повтора. */
  repeat: string;
}

/** Ключ строки вхождения: напоминание + момент вхождения по расписанию. */
export function reminderRowKey(reminderId: string, occurrenceAt: string): string {
  return `${reminderId}:${occurrenceAt}`;
}

/** Секция напоминания по локальным суткам клиента (требование 6762adb0). */
export type ReminderSectionKind = 'overdue' | 'today' | 'period';

/**
 * Секция вхождения по моменту показа: границы МЕСТНЫХ суток передаёт экран —
 * часовой пояс считает клиент, модель его не угадывает.
 */
export function reminderSectionOf(
  row: ReminderPanelRow,
  todayStartMs: number,
  todayEndMs: number,
): ReminderSectionKind {
  const moment = Date.parse(row.moment);
  if (!Number.isFinite(moment)) return 'period';
  if (moment < todayStartMs) return 'overdue';
  if (moment < todayEndMs) return 'today';
  return 'period';
}

/** Сколько дней назад смотреть сработавшие напоминания (секция «Просрочено»
 *  панели и бейдж «сегодня» считают один горизонт). */
export const REMINDERS_OVERDUE_DAYS = 30;

/**
 * Сколько вхождений «на сегодня или просрочено» в выдаче списка: момент показа
 * раньше конца местных суток (тот же предел, что у секции «Сегодня» в
 * {@link reminderSectionOf}) — сегодняшнее либо просроченное. Счётчик бейджа
 * «сегодня» на закладке «Дневник» (элемент 23887005) считает ТЕ ЖЕ вхождения,
 * что секции «Просрочено»/«Сегодня» панели, — второй формулы счёта нет.
 * Вхождения с неразборчивым моментом не считаются.
 */
export function dueReminderCount(result: ReminderListResult, todayEndMs: number): number {
  let count = 0;
  for (const reminder of result.reminders) {
    for (const occurrence of reminder.occurrences ?? []) {
      const moment = Date.parse(occurrence.until ?? occurrence.occurrence_at);
      if (Number.isFinite(moment) && moment < todayEndMs) count += 1;
    }
  }
  return count;
}

/**
 * Разложить вхождения напоминаний на строки панели: одно вхождение — одна
 * строка, момент показа отложенного вхождения — `until`. Названия субъектов
 * приходят готовыми (`titles`), описание повтора даёт экран словарём.
 */
export function reminderPanelRows(
  result: ReminderListResult,
  titles: ReadonlyMap<string, string>,
  repeatLabel: (reminder: Reminder) => string,
): ReminderPanelRow[] {
  const rows: ReminderPanelRow[] = [];
  for (const reminder of result.reminders) {
    for (const occurrence of reminder.occurrences ?? []) {
      const moment = occurrence.until ?? occurrence.occurrence_at;
      rows.push({
        key: reminderRowKey(reminder.id, occurrence.occurrence_at),
        reminderId: reminder.id,
        subjectType: reminder.subject_type,
        subjectId: reminder.subject_id,
        // Экран кладёт названия под ключами `<вид>:<id>`: одна карта хранит и
        // мысли, и публикации (раньше ключ терялся и показывался GUID).
        title: titles.get(`${reminder.subject_type}:${reminder.subject_id}`) ?? reminder.subject_id,
        moment,
        occurrenceAt: occurrence.occurrence_at,
        status: occurrence.status,
        repeat: repeatLabel(reminder),
        day: moment.slice(0, 10),
      });
    }
  }
  return rows;
}
