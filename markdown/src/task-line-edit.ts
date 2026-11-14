/**
 * Построчные правки пункта задачи (0.16.1, задача «0.16.1: сервер задач»;
 * ADR «Задачи — материализованная проекция текста комментариев» d0c07f33).
 *
 * Грамматика `- [ ]` / `- [x]` живёт ТОЛЬКО в `@etn/markdown` (сторож
 * `guard-markdown-single-renderer`: маркер вне пакета запрещён). Серверу при
 * правке строки задачи (PATCH /tasks: toggle/cancel) нужно поменять маркер в
 * готовой строке `body_md`, не разбирая текст заново, — эти примитивы дают
 * ровно такую операцию. Символьный класс маркера берётся из правила списка
 * задач (`task-list.ts`), здесь — только его место в строке.
 *
 * Строка адресуется номером из {@link TaskLine.lineNo}: парсер отдаёт номер
 * строки СОДЕРЖИМОГО пункта (именно там стоит маркер: `- [ ] текст` либо
 * `-\n  [ ] текст`). Поэтому функции принимают одну строку текста и либо
 * возвращают её новую редакцию, либо `null`, если маркера в строке нет.
 */

import { TASK_MARKER_PATTERN } from './task-list.js';

/**
 * Маркер пункта списка с чекбоксом: необязательный маркер списка (`-`, `*`,
 * `+`, `1.`, `1)`), пробелы и маркер чекбокса из `task-list.ts`. После маркера
 * обязан быть конец строки или пробельный символ — так же его видит рендерер.
 */
const TASK_LINE_MARKER_RE = new RegExp(
  String.raw`^([ \t]*(?:[-*+]|\d{1,9}[.)])?[ \t]*)${TASK_MARKER_PATTERN}(?=\s|$)`,
);

/** Есть ли в строке маркер пункта задачи. */
export function isTaskLineMarker(line: string): boolean {
  return TASK_LINE_MARKER_RE.test(line);
}

/**
 * Поставить/снять состояние пункта: `- [ ] текст` ↔ `- [x] текст`.
 * Возвращает новую строку или `null`, если маркера в ней нет (строка — не
 * пункт задачи).
 */
export function setTaskLineDone(line: string, done: boolean): string | null {
  const match = TASK_LINE_MARKER_RE.exec(line);
  if (match === null) return null;
  const prefix = match[1] ?? '';
  return `${prefix}[${done ? 'x' : ' '}]${line.slice(match[0].length)}`;
}

/**
 * Отменить задачу: убрать маркер, оставив пункт списка (`- [ ] текст` →
 * `- текст`). Одиночный маркер без текста превращается в пустой пункт (`-`).
 * `null` — в строке нет маркера.
 */
export function removeTaskLineMarker(line: string): string | null {
  const match = TASK_LINE_MARKER_RE.exec(line);
  if (match === null) return null;
  const prefix = match[1] ?? '';
  // Отделяющий пробел после маркера убирается ровно один; отступ строки перед
  // маркером (`  [ ] текст` — маркер на строке содержимого) сохраняется.
  const rest = line.slice(match[0].length).replace(/^[ \t]/, '');
  return `${prefix}${rest}`.replace(/[ \t]+$/, '');
}
