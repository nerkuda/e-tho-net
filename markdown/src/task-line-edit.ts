/**
 * Построчные правки пункта задачи (0.16.1, задача «0.16.1: сервер задач»;
 * ADR «Задачи — материализованная проекция текста комментариев» d0c07f33).
 *
 * Грамматика `- [ ]` / `- [x]` живёт ТОЛЬКО в `@etn/markdown` (сторож
 * `guard-markdown-single-renderer`: маркер вне пакета запрещён). Серверу при
 * правке строки задачи (PATCH /tasks: toggle/cancel/undate) нужно поменять
 * маркер или убрать date-ссылки в готовой строке `body_md`, не разбирая текст
 * заново, — эти примитивы дают ровно такую операцию. Символьный класс маркера
 * берётся из правила списка задач (`task-list.ts`), здесь — только его место в
 * строке.
 *
 * Строка адресуется номером из {@link TaskLine.lineNo}: парсер отдаёт номер
 * строки СОДЕРЖИМОГО пункта (именно там стоит маркер: `- [ ] текст` либо
 * `-\n  [ ] текст`). Поэтому функции принимают одну строку текста и либо
 * возвращают её новую редакцию, либо `null`, если маркера в строке нет.
 */

import { findDateLinkSpans } from './date-links.js';
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

/**
 * «Сделать бессрочной»: убрать из строки ВСЕ date-ссылки (`[[YYYY-MM-DD]]`,
 * `[[YYYY-MM-DD HH:MM]]`, с алиасом) — период и срок строки очищаются.
 * `null` — date-ссылок в строке нет.
 *
 * Позиции ссылок даёт {@link findDateLinkSpans} того же пакета, поэтому
 * inline-code и цели, которые date-ссылкой не являются, не трогаются. Вместе
 * со ссылкой уходит ОДИН пробел-разделитель перед ней (иначе в тексте остались
 * бы двойные пробелы); отступ строки и маркер списка сохраняются.
 *
 * Строка, у которой дата была единственным содержимым пункта, становится
 * пустым пунктом (`- [ ]`): задача без текста в проекцию не попадает —
 * это честное следствие команды, а не потеря данных (текст ссылки удалён
 * пользователем осознанно).
 */
export function removeTaskLineDates(line: string): string | null {
  const spans = findDateLinkSpans(line);
  if (spans.length === 0) return null;
  let next = line;
  // С конца: замены не сдвигают позиции ещё не обработанных ссылок.
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const span = spans[i]!;
    let start = span.start;
    if (start >= 2 && /\s/.test(next[start - 1] ?? '') && /\S/.test(next[start - 2] ?? '')) {
      start -= 1;
    }
    next = `${next.slice(0, start)}${next.slice(span.end)}`;
  }
  return next.replace(/[ \t]+$/, '');
}
