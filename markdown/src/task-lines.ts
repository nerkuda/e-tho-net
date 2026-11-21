/**
 * Парсер строк задач (0.16.1, ТП «Даты, задачи и напоминания: ось времени в
 * ETN»; требование d957a49d, ADR «парсер строк задач — библиотечный модуль»
 * 20a62354, ADR материализованной проекции d0c07f33).
 *
 * На входе — `body_md` комментария любой сущности (хроно-запись или постоянный
 * комментарий мысли, публикации, СВЯЗИ), на выходе — массив {@link TaskLine} в
 * порядке документа. `comment_id`, `layer_id` и `parsed_revision` — вне зоны
 * ответственности модуля: их задаёт вызывающий (хук записи комментария, REST,
 * live-превью).
 *
 * **Одна грамматика.** Разбор СТРОИТСЯ на едином рендерере: тело разбирается
 * тем же `markdown-it` (`getRenderer`), что и просмотр, а признак задачи и
 * состояние чек-бокса читаются из результата правила `task_list`
 * ({@link taskListCheckbox}), принадлежность inline-токена пункту списка — из
 * {@link ownerListItemIndex}. Собственного разбора `- [ ]` / `- [x]` здесь нет,
 * поэтому парсер и просмотр не могут разойтись: code fence, отступ в четыре
 * пробела (блок кода), HTML-комментарий, `- [ ]` в середине строки, `*`/`+` и
 * нумерованные списки понимаются ровно так же, как в HTML.
 *
 * **Модель строки.**
 * - Строка списка (пункт любого списка) — одна {@link TaskLine}: `text` —
 *   снапшот содержимого пункта без маркера списка и без `- [ ] `
 *   (`inline.content` после правила `task_list`), `lineNo` — номер её первой
 *   строки в `body_md` (1-based), `depth` — уровень вложенности (0 — верхний
 *   список; это и есть «отступ/подзадача»).
 * - Текстовая строка вне списка (абзац, заголовок, ячейка таблицы) попадает в
 *   выход ТОЛЬКО если несёт date-ссылки: это вход `task_row_dates` для «Связей
 *   дня» и календаря (ADR d0c07f33), задач из неё не бывает.
 * - Задача — пункт с чек-боксом (единственное состояние). `closed`/`reopened` в
 *   тексте — обычный текст и на состояние не влияет.
 * - Отмена — `- текст` без чек-бокса: строка остаётся в выходе, но
 *   `hasCheckbox`/`isTask` = false.
 * - Подзадача без собственной date-ссылки при наличии выше по списку пункта с
 *   чек-боксом — пункт чек-листа родителя (`subtask` = true, `isTask` = false),
 *   а не задача: цепочка вложенных пунктов-чек-листов остаётся чек-листом.
 * - Период = первая..последняя date-ссылка строки, срок (`due`) = последняя;
 *   без date-ссылок строка `undated`.
 * - Субъекты строки — ТОЛЬКО резолвы ID-ссылок `[[#uuid]]` (`subjects`,
 *   порядок документа, без повторов). Legacy-ссылки по имени `[[Имя]]` и
 *   межсетевые `[[n:…]]` субъектами не считаются (решение 2026-11-14).
 *
 * Модуль чистый (без DOM, БД и сети) и не бросает на произвольном markdown;
 * идентичный результат на сервере и в клиенте — следствие единого пакета.
 */

import type Token from 'markdown-it/lib/token.mjs';

import { getRenderer } from './renderer.js';
import { ownerListItemIndex, taskListCheckbox } from './task-list.js';
import type { WikiLinkMeta } from './wiki-link.js';

/** Date-ссылка строки: ISO-дата и необязательное время (`HH:MM`). */
export interface TaskLineDate {
  /** ISO-дата `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM` для формы `[[YYYY-MM-DD HH:MM]]`, иначе null. */
  time: string | null;
}

/**
 * Описание строки `body_md` для материализованной проекции задач
 * (`task_rows` / `task_row_dates` / `task_row_subjects`, ADR d0c07f33).
 */
export interface TaskLine {
  /** Номер первой строки пункта в `body_md` (1-based) — адрес строки вместе с `comment_id`. */
  lineNo: number;
  /**
   * Снапшот текста без маркера списка и без `- [ ] ` (`inline.content` после
   * правила `task_list`), с сохранением markdown-разметки. Многострочный пункт
   * сохраняет переводы строк.
   */
  text: string;
  /** В пункте есть чек-бокс (`- [ ]` / `- [x]` / `- [X]`). */
  hasCheckbox: boolean;
  /** Состояние чек-бокса (`[x]`/`[X]`); для строк без чек-бокса — false. */
  done: boolean;
  /**
   * Строка считается задачей проекции: есть чек-бокс и это НЕ пункт чек-листа
   * родителя (см. `subtask`).
   */
  isTask: boolean;
  /** Уровень вложенности списка: 0 — верхний список (отступ = подзадача). */
  depth: number;
  /** Чек-бокс без собственной date-ссылки при наличии выше по списку пункта с чек-боксом (пункт чек-листа). */
  subtask: boolean;
  /**
   * `lineNo` ближайшего пункта-предка с чек-боксом выше по списку, иначе null.
   * Предок в цепочке вложенности может сам быть пунктом чек-листа.
   */
  parentLineNo: number | null;
  /** ВСЕ date-ссылки строки в порядке документа (повторы сохраняются). */
  dates: TaskLineDate[];
  /** Дата первой date-ссылки строки (ISO `YYYY-MM-DD`), иначе null. */
  periodFrom: string | null;
  /** Дата последней date-ссылки строки (ISO `YYYY-MM-DD`), иначе null. */
  periodTo: string | null;
  /** Срок = последняя date-ссылка строки (ISO `YYYY-MM-DD`), иначе null. */
  due: string | null;
  /** В строке нет date-ссылок. */
  undated: boolean;
  /** Резолвы ID-ссылок `[[#uuid]]` строки: id мыслей в нижнем регистре, без повторов. */
  subjects: string[];
}

/** Вид списка по токену открытия/закрытия. */
function isListOpen(type: string): boolean {
  return type === 'bullet_list_open' || type === 'ordered_list_open';
}

/** Вид списка по токену закрытия. */
function isListClose(type: string): boolean {
  return type === 'bullet_list_close' || type === 'ordered_list_close';
}

/**
 * Уровень списков на каждом токене: сколько списков открыто к моменту токена
 * (0 — вне списка). Для `list_item_open` значение на единицу больше глубины
 * пункта, потому что его собственный список уже открыт.
 */
function listDepths(tokens: readonly Token[]): number[] {
  const depths = new Array<number>(tokens.length).fill(0);
  let open = 0;
  for (let i = 0; i < tokens.length; i++) {
    const type = tokens[i]!.type;
    if (isListClose(type)) open = Math.max(0, open - 1);
    depths[i] = open;
    if (isListOpen(type)) open++;
  }
  return depths;
}

/** Содержимое inline-токена без маркера списка и чек-бокса (снапшот строки). */
function inlineText(token: Token): string {
  return token.content.trim();
}

/** Date-ссылки inline-токена в порядке документа. */
function dateLinks(token: Token): TaskLineDate[] {
  const dates: TaskLineDate[] = [];
  for (const child of token.children ?? []) {
    if (child.type !== 'wiki_link') continue;
    const meta = child.meta as WikiLinkMeta | null;
    if (meta === null || meta.kind !== 'date' || meta.date === null) continue;
    dates.push({ date: meta.date, time: meta.time });
  }
  return dates;
}

/** Резолвы ID-ссылок `[[#uuid]]` inline-токена (без повторов, порядок документа). */
function subjectLinks(token: Token): string[] {
  const ids: string[] = [];
  for (const child of token.children ?? []) {
    if (child.type !== 'wiki_link') continue;
    const meta = child.meta as WikiLinkMeta | null;
    if (meta === null || meta.kind !== 'id' || meta.targetId === null) continue;
    if (!ids.includes(meta.targetId)) ids.push(meta.targetId);
  }
  return ids;
}

/** Собирает строку выхода с пустыми производными полями (досчитываются в конце). */
function createRow(
  lineNo: number,
  text: string,
  hasCheckbox: boolean,
  done: boolean,
  depth: number,
): TaskLine {
  return {
    lineNo,
    text,
    hasCheckbox,
    done,
    isTask: false,
    depth,
    subtask: false,
    parentLineNo: null,
    dates: [],
    periodFrom: null,
    periodTo: null,
    due: null,
    undated: false,
    subjects: [],
  };
}

/** Дописывает date-ссылки и субъектов строки (субъекты — без повторов). */
function addLinks(row: TaskLine, dates: TaskLineDate[], subjects: string[]): void {
  row.dates.push(...dates);
  for (const id of subjects) {
    if (!row.subjects.includes(id)) row.subjects.push(id);
  }
}

/**
 * Досчитывает производные поля строки: период/срок из date-ссылок и признак
 * подзадачи. `ancestor` — ближайший пункт списка-предок (не обязательно
 * задача).
 */
function finalizeRow(row: TaskLine, ancestor: TaskLine | null): void {
  row.undated = row.dates.length === 0;
  const first = row.dates[0];
  const last = row.dates[row.dates.length - 1];
  row.periodFrom = first?.date ?? null;
  row.periodTo = last?.date ?? null;
  row.due = last?.date ?? null;

  row.parentLineNo =
    row.hasCheckbox && ancestor !== null && ancestor.hasCheckbox ? ancestor.lineNo : null;
  row.subtask = row.hasCheckbox && row.undated && row.parentLineNo !== null;
  row.isTask = row.hasCheckbox && !row.subtask;
}

/**
 * Разбирает `body_md` комментария на строки задач/списка и текстовые строки с
 * date-ссылками (см. описание модуля).
 *
 * @throws когда `bodyMd` не строка.
 */
export function parseTaskLines(bodyMd: string): TaskLine[] {
  if (typeof bodyMd !== 'string') {
    throw new Error('parseTaskLines: bodyMd must be a string');
  }
  const tokens = getRenderer().parse(bodyMd, {});
  const depths = listDepths(tokens);

  const rows: TaskLine[] = [];
  /** Ближайший пункт-предок строки (для `parentLineNo`/`subtask`). */
  const ancestors = new Map<TaskLine, TaskLine | null>();
  /** Строка пункта списка по индексу его `list_item_open`. */
  const itemRows = new Map<number, TaskLine>();
  /** Текущие открытые пункты списка по глубине — для поиска предка. */
  const stack: TaskLine[] = [];
  /** Последняя размеченная строка — подстраховка для ячеек таблицы (у них нет `map`). */
  let mappedLine = 1;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const map = token.map;
    if (map !== null && map !== undefined && map[0] !== undefined) mappedLine = map[0] + 1;
    if (token.type !== 'inline') continue;

    const lineNo =
      map !== null && map !== undefined && map[0] !== undefined ? map[0] + 1 : mappedLine;
    const owner = ownerListItemIndex(tokens, i);

    if (owner === -1) {
      // Текстовая строка вне списка: в проекцию попадает только носитель
      // date-ссылок («Связи дня», календарь). Задач вне списка не бывает.
      const dates = dateLinks(token);
      if (dates.length === 0) continue;
      const row = createRow(lineNo, inlineText(token), false, false, 0);
      addLinks(row, dates, subjectLinks(token));
      rows.push(row);
      continue;
    }

    const checked = taskListCheckbox(token);
    const depth = Math.max(0, (depths[owner] ?? 1) - 1);
    let row = itemRows.get(owner);

    if (row === undefined) {
      row = createRow(lineNo, inlineText(token), checked !== null, checked === true, depth);
      addLinks(row, dateLinks(token), subjectLinks(token));
      itemRows.set(owner, row);
      rows.push(row);

      // Предок — ближайший пункт меньшей глубины; всё, что глубже или равно,
      // уже закрыто документом (пункты идут в порядке открытия).
      while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
      ancestors.set(row, stack[stack.length - 1] ?? null);
      stack.push(row);
      continue;
    }

    // Следующий inline того же пункта (второй абзац, «хвост»): текст строки —
    // первый inline, но date-ссылки и субъекты принадлежат строке целиком.
    addLinks(row, dateLinks(token), subjectLinks(token));
    // Правило `task_list` смотрит каждый inline пункта: чек-бокс во втором
    // абзаце делает пункт задачей и в рендере — повторяем это состояние.
    if (checked !== null && !row.hasCheckbox) {
      row.hasCheckbox = true;
      row.done = checked;
    }
  }

  for (const row of rows) finalizeRow(row, ancestors.get(row) ?? null);
  return rows;
}
