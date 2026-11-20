/**
 * Модель панели «Задачи и напоминания» — чистая логика без DOM и сети
 * (0.16.1, задача 64f7976a; элементы f76ed829/15f8ea2f/498f23e0, требования
 * 6762adb0/0e85b66e/e6af8b9e/3616cfec/db1d9548).
 *
 * Зачем отдельный модуль. Состав секций, счётчики, признак «строка устарела»,
 * порядок строк и раскладка напоминаний — правила, которые обязаны проверяться
 * тестами без DOM и сети. Компонент `task-panel.ts` только рисует то, что здесь
 * посчитано; экран `screens/chronicle/tasks-panel.ts` только загружает данные и
 * зовёт действия.
 *
 * **Порогов группировки больше нет (уточнение 2026-11-18, задача `cfb8cb72`,
 * пункт 6).** Прежние подгруппы «по мыслям / датам / неделям / месяцам»
 * (требование 6762adb0) отменены: списки панели — СПЛОШНЫЕ, одинаковые при
 * любом периоде. «Задачи» — секции «Без срока» и «Срочные» (вторая несёт и
 * просроченные строки — они красные), «Напоминания» — один хронологический
 * список. Заголовки подгрупп, их фильтры массовых команд и ключи групп из
 * модели удалены; способность компоненты рисовать подгруппы осталась
 * опциональной формой её API.
 *
 * **Секции.** Секции приходят готовыми: сервер отдаёт их РАЗНЫМИ запросами
 * (`scope=open` в периоде, `overdue` и `undated` — сквозные), модель лишь
 * раскладывает строки каждой секции, не смешивая их.
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

import { parseTaskLines } from '@etn/markdown';
import type {
  CommentKind,
  Reminder,
  ReminderListResult,
  TaskDTO,
  TaskMassFilter,
  TaskNestedLine,
} from '@etn/shared';

import { localDayEnd, localDayStart } from '../dates.js';

/**
 * Что модель знает о строке для адресации и порядка: стабильный ключ, календарный
 * день и субъект (мысль). Прежние пороги группировки (6762adb0) отменены
 * уточнением 2026-11-18 (задача `cfb8cb72`, пункт 6): поля остались адресом
 * строки и признаком «срок есть», а не режимом групп.
 */
export interface PanelGroupable {
  /** Стабильный ключ строки (переживает перерисовку). */
  key: string;
  /** Календарный день строки (`YYYY-MM-DD`), `null` — даты нет. */
  day: string | null;
  /** Субъект строки (мысль/публикация), `null` — субъекта нет. */
  subjectId: string | null;
}

/** Разобрать `YYYY-MM-DD` в UTC-дату (только календарная арифметика). */
function parseDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date));
}

/** Отформатировать UTC-дату в `YYYY-MM-DD`. */
function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Сдвиг календарного дня на `delta` дней (невалидный день возвращается как
 * есть). Общий помощник панели: окно раскрытия напоминаний и календарная
 * арифметика переноса дат — без DOM и без часового пояса.
 */
export function shiftDay(day: string, delta: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const base = parseDay(day);
  base.setUTCDate(base.getUTCDate() + delta);
  return formatDay(base);
}

/** Строка задачи в панели (view-модель): данные для отрисовки и действий. */
export interface TaskPanelRow extends PanelGroupable {
  commentId: string;
  /** Владелец комментария-источника — адрес «Открыть источник» (0.16.1). */
  ownerType: TaskDTO['owner_type'];
  ownerId: string;
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
  /** Вид комментария-источника: у хроно-записи «Сделать бессрочной» нет. */
  kind: CommentKind;
  /** Мысли из ID-ссылок строки (облачка субъектов рядом с датой, п.6 ТЗ 2026-11-18). */
  subjectThoughts: string[];
  /**
   * Срок строки в прошлом (`due` раньше `today`): строка показывается красным
   * (уточнение ТЗ 2026-11-17, пункт D). У выполненной строки признак снят —
   * просроченного дела нет.
   */
  overdue: boolean;
  /**
   * Вложенные не-задачные строки под задачей (уточнение ТЗ 2026-11-17, пункт F):
   * пункты чек-листа и обычные вложенные строки источника. Пустой список —
   * строка не сворачивается.
   */
  children: TaskPanelChildRow[];
  /**
   * Под строкой есть подчинённый БЛОК (0.16.1, пачка 7): не-задачные строки
   * проекции ЛИБО подзадачи страницы (`parent_task` указывает на эту строку).
   * Блок не хранится в проекции — панель читает его срез из тела комментария
   * (`loadRawBlock`), поэтому подзадача с собственной датой (она в `children`
   * не попадает) тоже делает строку сворачиваемой. Не задано — признак берётся
   * из `children` (совместимость с прежними снимками).
   */
  hasChildren?: boolean;
}

/**
 * Вложенная не-задачная строка под задачей (пункт F): пункт чек-листа родителя
 * либо обычная вложенная строка списка. Правки/команды у неё нет — только текст
 * с отступом по уровню вложенности.
 */
export interface TaskPanelChildRow {
  /** Стабильный ключ строки (`comment_id:line_no`). */
  key: string;
  lineNo: number;
  text: string;
  /** Уровень вложенности списка: 1 — первый отступ под задачей. */
  depth: number;
  /** Пункт чек-листа (`- [ ]`), а не обычная строка текста. */
  checkbox: boolean;
  /**
   * Отметка пункта чек-листа (0.16.1, задача 7446eb25): панель показывает
   * пункт настоящим чекбоксом, а не маркированной строкой.
   */
  done?: boolean;
}

/**
 * Вложенные строки источника, разложенные по адресу родителя-задачи
 * (`comment_id:line_no`). Порядок строк — как в источнике (сервер уже отдал
 * их по `line_no`).
 */
export function nestedLinesByParent(
  nested: readonly TaskNestedLine[] | undefined,
): Map<string, TaskPanelChildRow[]> {
  const byParent = new Map<string, TaskPanelChildRow[]>();
  for (const line of nested ?? []) {
    const key = `${line.parent.comment_id}:${line.parent.line_no}`;
    const list = byParent.get(key) ?? [];
    list.push({
      key: `${line.comment_id}:${line.line_no}`,
      lineNo: line.line_no,
      text: line.text,
      depth: line.depth,
      checkbox: line.checkbox,
      done: line.done === true,
    });
    byParent.set(key, list);
  }
  return byParent;
}

/** Ключ строки задачи: адрес проекции (`comment_id` + `line_no`). */
export function taskRowKey(ref: { comment_id: string; line_no: number }): string {
  return `${ref.comment_id}:${ref.line_no}`;
}

/**
 * Класс ЖИВОГО чекбокса задачи в просмотре (0.16.1, пачка 7). Один словарь для
 * панели (подчинённый блок) и просмотра комментария (`editor/task-checkbox-toggle`)
 * — вид/курсор контрола не зависит от поверхности, а `editor/` не нужен
 * `lib/ui` для этого имени.
 */
export const LIVE_TASK_CHECKBOX_CLASS = 'ui-task-checkbox-live';

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
 *
 * `today` — граница просрочки (локальный день клиента): срок раньше неё и
 * незакрытая строка показываются красным (пункт D ТЗ 2026-11-17).
 * `children` — вложенные не-задачные строки под задачей (пункт F).
 * `hasChildren` — есть подчинённый блок (не-задачные строки ИЛИ подзадачи
 * страницы, 0.16.1 пачка 7); не задано — считается по `children`.
 */
export function taskRowView(
  row: TaskDTO,
  stale: TaskPanelStaleness = {},
  done?: boolean,
  options: {
    today?: string | null;
    children?: readonly TaskPanelChildRow[];
    hasChildren?: boolean;
  } = {},
): TaskPanelRow {
  const isDone = done ?? row.done;
  const today = options.today ?? null;
  const children = [...(options.children ?? [])];
  return {
    key: taskRowKey(row),
    commentId: row.comment_id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    lineNo: row.line_no,
    text: row.text,
    done: isDone,
    stale: taskRowIsStale(row, stale),
    subtask: row.subtask,
    periodFrom: row.period_from,
    due: row.due,
    kind: row.kind,
    day: row.due ?? row.period_from,
    subjectThoughts: row.subject_thoughts,
    subjectId: row.subject_thoughts[0] ?? null,
    overdue: !isDone && row.due !== null && today !== null && row.due < today,
    children,
    hasChildren: options.hasChildren ?? children.length > 0,
  };
}

/** Число ведущих пробелов/табов строки (отступ markdown-списка). */
function leadingIndent(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Конец поддерева строки `start` в `body_md` (0.16.1, пачка 7): строка задачи и
 * все её подчинённые строки — до первой непустой строки с отступом НЕ больше
 * отступа родителя. Пустые строки внутри поддерева не обрывают его (они часть
 * пункта/разделитель абзацев), хвостовые пустые в диапазон не входят.
 *
 * Границы ЕДИНЫ для блочной правки и для показа подчинённого блока: панель
 * читает один и тот же срез (`loadRawBlock`) — записанное вернётся в источник
 * один в один.
 */
export function blockRangeEnd(lines: readonly string[], start: number): number {
  const parent = lines[start];
  if (parent === undefined) return start;
  const base = leadingIndent(parent);
  let end = start;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    if (leadingIndent(line) <= base) break;
    end = index;
  }
  return end;
}

/**
 * Текст ПОДЧИНЁННОГО БЛОКА из сырого среза `loadRawBlock` (0.16.1, пачка 7).
 *
 * Первая строка среза — сама строка задачи, в блок она не входит. При показе
 * снимается ТОЛЬКО базовый отступ предков (отступ первой непустой строки
 * блока): иначе у задачи глубины ≥1 блок начинался бы с кода (4+ пробела).
 * Относительные отступы внутри блока не меняются — вложенные списки, код и
 * цитаты остаются собой, а рендерятся тем же единым рендерером, что просмотр
 * комментария. Запись при этом идёт СЫРЫМИ строками среза (не этого текста).
 */
export function childBlockText(blockText: string): string {
  const body = blockText.split('\n').slice(1);
  const first = body.find((line) => line.trim() !== '');
  if (first === undefined) return '';
  const base = leadingIndent(first);
  if (base === 0) return body.join('\n');
  return body
    .map((line) => {
      const cut = Math.min(base, leadingIndent(line));
      return line.slice(cut);
    })
    .join('\n');
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
 * Доступная отмена массовой команды держит зону видимой тоже: строки ушли, но
 * «Отменить» живёт в шапке группы — скрытая группа делает её недоступной
 * (вердикт репроверки `7448ac21`).
 */
export function taskZoneVisible(state: {
  rowCount: number;
  loading: boolean;
  hasError: boolean;
  canUndo: boolean;
}): boolean {
  return state.rowCount > 0 || state.loading || state.hasError || state.canUndo;
}

/**
 * Строки задач, попадающие под фильтр массовой команды (требование e6af8b9e):
 * зеркало серверного отбора `GET /tasks` — тот же фильтр уходит в
 * `PATCH /tasks`, поэтому подтверждение и undo считают те же строки.
 *
 * Сквозные секции `overdue`/`undated` границы периода НЕ применяют — так же,
 * как серверный `buildFilter`: иначе строка без дат не попадала ни в одну
 * секцию при точечном перечитывании записи и молча исчезала из панели
 * (вердикт репроверки `7448ac21`).
 */
export function taskRowsForFilter(rows: readonly TaskDTO[], filter: TaskMassFilter): TaskDTO[] {
  // `overdue`/`undated` — сквозные выборки: `from`/`to` для них игнорируются.
  const skipsPeriodBounds = filter.scope === 'overdue' || filter.scope === 'undated';
  return rows.filter((row) => {
    if (filter.comment_id !== undefined && row.comment_id !== filter.comment_id) return false;
    if (filter.thought_id !== undefined && !row.subject_thoughts.includes(filter.thought_id)) {
      return false;
    }
    if (!skipsPeriodBounds) {
      if (filter.from !== undefined && (row.period_to === null || row.period_to < filter.from)) {
        return false;
      }
      if (filter.to !== undefined && (row.period_from === null || row.period_from > filter.to)) {
        return false;
      }
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

/**
 * Заменить ДИАПАЗОН строк `body_md` (блочная правка «как трансклюзия», 0.16.1,
 * задача 7446eb25): строка задачи и все её вложенные строки правятся одним
 * куском, как блок трансклюзии. `start`/`end` — включительно, `text` — новые
 * строки блока (разделитель `\n`; пустая строка удаляет диапазон).
 * `null` — диапазон выходит за границы источника.
 */
export function replaceTaskLineRange(
  bodyMd: string,
  start: number,
  end: number,
  text: string,
): string | null {
  const lines = bodyMd.split('\n');
  if (start < 0 || end < start || end >= lines.length) return null;
  const block = text === '' ? [] : text.split('\n');
  if (block.length === end - start + 1 && block.every((line, i) => line === lines[start + i])) {
    return bodyMd;
  }
  lines.splice(start, end - start + 1, ...block);
  return lines.join('\n');
}

/** Строка пункта чек-листа (`- [ ]` / `- [x]`) с отступом. */
const CHECKLIST_LINE_RE = /^(\s*[-*+]\s+\[)([ xX])(\])/;

/**
 * Поставить/снять отметку пункта чек-листа в СЫРОЙ строке `body_md`
 * (0.16.1, задача 7446eb25). Пункт чек-листа под задачей — не задача проекции:
 * `PATCH /tasks` отвечает на него `not_a_task`, поэтому отметка ставится
 * правкой текста источника. `null` — строка не пункт чек-листа.
 */
export function setChecklistLineDone(line: string, done: boolean): string | null {
  const match = CHECKLIST_LINE_RE.exec(line);
  if (match === null) return null;
  const head = match[1] ?? '';
  const tail = match[3] ?? '';
  return `${head}${done ? 'x' : ' '}${tail}${line.slice(match[0].length)}`;
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
  /**
   * Вхождение просрочено (момент показа раньше начала местных суток клиента):
   * строка и дата показываются красным (пункт D ТЗ 2026-11-17).
   */
  overdue?: boolean;
  /**
   * Вхождение отработано: чекбокс строки стоит (0.16.1, задача `cfb8cb72`,
   * пункт 7). Отметка = dismiss вхождения по `occurrence_at`; до «Обновить»
   * строка остаётся в списке отмеченной, после — уходит из выдачи.
   */
  done?: boolean;
}

/** Ключ строки вхождения: напоминание + момент вхождения по расписанию. */
export function reminderRowKey(reminderId: string, occurrenceAt: string): string {
  return `${reminderId}:${occurrenceAt}`;
}

/**
 * Вхождение напоминания просрочено (уточнение ТЗ 2026-11-17, пункт D): момент
 * показа раньше НАЧАЛА местных суток клиента. Границу передаёт экран — часовой
 * пояс считает клиент (требование fcdcd75f), модель его не угадывает.
 */
export function reminderRowOverdue(row: ReminderPanelRow, todayStartMs: number): boolean {
  const moment = Date.parse(row.moment);
  return Number.isFinite(moment) && moment < todayStartMs;
}

/**
 * Хронологический список вхождений (0.16.1, задача `cfb8cb72`, пункт 6):
 * «Напоминания» — ОДИН список без подгрупп при любом периоде, порядок по
 * моменту показа, ближайшее сверху. Просроченные строки остаются в нём и
 * красятся красным (их признак — {@link ReminderPanelRow.overdue}).
 */
export function flatReminderRows(rows: readonly ReminderPanelRow[]): ReminderPanelRow[] {
  return [...rows].sort((left, right) => Date.parse(left.moment) - Date.parse(right.moment));
}

/** Сколько дней назад смотреть сработавшие напоминания (секция «Просрочено»
 *  панели и бейдж «сегодня» считают один горизонт). */
export const REMINDERS_OVERDUE_DAYS = 30;

/**
 * Сколько вхождений «на сегодня или просрочено» в выдаче списка: момент показа
 * раньше конца местных суток — сегодняшнее либо просроченное. Счётчик бейджа
 * «сегодня» на закладке «Дневник» (элемент 23887005) считает ТЕ ЖЕ вхождения,
 * что показывал прежний список напоминаний панели, — второй формулы счёта нет.
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
 *
 * `todayStartMs` — начало местных суток клиента: помечает просроченные вхождения
 * (пункт D ТЗ 2026-11-17). `doneKeys` — ключи ({@link reminderRowKey}) вхождений,
 * отмеченных из панели: их чекбокс стоит до «Обновить» (уточнение 2026-11-18,
 * задача `cfb8cb72`, пункт 7). Оба параметра необязательны.
 */
export function reminderPanelRows(
  result: ReminderListResult,
  titles: ReadonlyMap<string, string>,
  repeatLabel: (reminder: Reminder) => string,
  todayStartMs?: number,
  doneKeys?: ReadonlySet<string>,
): ReminderPanelRow[] {
  const rows: ReminderPanelRow[] = [];
  for (const reminder of result.reminders) {
    for (const occurrence of reminder.occurrences ?? []) {
      const moment = occurrence.until ?? occurrence.occurrence_at;
      const key = reminderRowKey(reminder.id, occurrence.occurrence_at);
      const row: ReminderPanelRow = {
        key,
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
      };
      if (todayStartMs !== undefined) row.overdue = reminderRowOverdue(row, todayStartMs);
      if (doneKeys?.has(key) === true) row.done = true;
      rows.push(row);
    }
  }
  return rows;
}

/**
 * ДНЕВНЫЕ хроно-записи указанного дня (0.16.1, пачка 4, пункт 5).
 *
 * «Строго дневная» — запись, ЧЬИ СУТКИ и есть этот день: весь интервал
 * `valid_from`..`valid_to` лежит внутри локальных суток. Запись-период
 * («Задачник на неделю») сегодня накрывает, но за сутки выходит, поэтому
 * дневной не считается: «Создать задачу на сегодня» пишет в запись ДНЯ
 * (требование 7fcdf583), а не в период.
 *
 * Записей дня на дату может быть несколько (элемент «Запись дня»), поэтому
 * возвращается список в порядке начала — вызывающий решает, куда дописать.
 */
export function dailyRecordsOf<
  T extends { kind: CommentKind; valid_from: string; valid_to: string | null },
>(comments: readonly T[], day: string): T[] {
  const start = Date.parse(localDayStart(day));
  const end = Date.parse(localDayEnd(day));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  return comments
    .filter((comment) => {
      if (comment.kind !== 'chronological') return false;
      const from = Date.parse(comment.valid_from);
      const to = Date.parse(comment.valid_to ?? comment.valid_from);
      return (
        Number.isFinite(from) && Number.isFinite(to) && from <= to && from >= start && to <= end
      );
    })
    .sort((left, right) => Date.parse(left.valid_from) - Date.parse(right.valid_from));
}

/**
 * Уже созданная задача субъекта на указанный день — номер строки `body_md`
 * С НУЛЯ (адрес `PATCH /tasks`), иначе `null`. Идемпотентность «Создать
 * задачу на сегодня» (0.16.1, пачка 4, пункт 4): повторный клик не плодит
 * дубли строк.
 *
 * Строка узнаётся по проекции, а не по точному тексту: задача (`isTask`), срок
 * (`due`) — этот день, субъект — ID-ссылка `[[#id]]` строки. У публикации
 * ID-ссылки нет, поэтому для неё сверяется снапшот текста строки.
 *
 * Возвращается и ОТМЕНЁННАЯ строка (`task: false`), но только при точном
 * совпадении текста с каноническим: пользовательский пункт «обсудить [[#id]]» с
 * той же датой задачей не считается и маркер ему не возвращают (пункт 4).
 */
export function findTaskLineForDay(
  bodyMd: string,
  query: { day: string; subjectId?: string | null; text?: string },
): { lineNo: number; task: boolean } | null {
  const subject = query.subjectId?.toLowerCase() ?? null;
  for (const row of parseTaskLines(bodyMd)) {
    if (row.due !== query.day) continue;
    if (row.isTask) {
      if (subject !== null && !row.subjects.includes(subject)) continue;
      if (subject === null && query.text !== undefined && row.text !== query.text) continue;
    } else {
      // Отменённая строка переиспользуется только как есть: у неё тот же текст,
      // что у создаваемой (ссылка на субъект/название + дата), без добавок.
      if (query.text === undefined || row.text !== query.text) continue;
    }
    return { lineNo: row.lineNo - 1, task: row.isTask };
  }
  return null;
}
