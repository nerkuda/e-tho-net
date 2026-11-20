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
import { getRenderer } from './renderer.js';
import { TASK_MARKER_PATTERN, TASK_MARKER_UNCHECKED } from './task-list.js';
import type { WikiLinkMeta } from './wiki-link.js';

/**
 * Маркер пункта списка с чекбоксом: необязательный маркер списка (`-`, `*`,
 * `+`, `1.`, `1)`), пробелы и маркер чекбокса из `task-list.ts`. После маркера
 * обязан быть конец строки или пробельный символ — так же его видит рендерер.
 */
const TASK_LINE_MARKER_RE = new RegExp(
  String.raw`^([ \t]*(?:[-*+]|\d{1,9}[.)])?[ \t]*)${TASK_MARKER_PATTERN}(?=\s|$)`,
);

/** Маркер списка с обязательным отделяющим пробелом (`- `, `1. `). */
const TASK_LIST_PREFIX_RE = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)/;

/** Есть ли в строке маркер пункта задачи. */
export function isTaskLineMarker(line: string): boolean {
  return TASK_LINE_MARKER_RE.test(line);
}

/**
 * Канонический текст строки задачи: содержимое пункта — ровно одна ID-ссылка
 * `[[#id]]` и одна/несколько date-ссылок, больше ничего.
 *
 * Так выглядит сниппет ОТКРЫТОЙ задачи в проекции (`task_rows.text`: маркер
 * чек-бокса рендерер из содержимого убирает) и точно так же — ОТМЕНЁННАЯ
 * задача: `removeTaskLineMarker` оставляет `- [[#id]] [[дата]]`. Отмена снимает
 * в проекции признак задачи, поэтому остаток отличим от обычной строки только
 * по форме — по ней «Связи дня» его и исключают (ошибка 009bda81, решение
 * пользователя «исключить строки задач»).
 *
 * Посторонний текст, ссылка по имени `[[Имя]]`, алиас и любой другой markdown
 * каноном не считаются: такая строка — обычное упоминание и показывается.
 * Грамматику ссылок разбирает единый рендерер — своего регэкспа здесь нет.
 */
export function isCanonicalTaskText(text: string): boolean {
  if (typeof text !== 'string') return false;
  const inline = getRenderer()
    .parseInline(text.trim(), {})
    .find((token) => token.type === 'inline');
  if (inline === undefined) return false;
  let subject = false;
  let dates = 0;
  for (const child of inline.children ?? []) {
    if (child.type === 'text') {
      if (child.content.trim() !== '') return false;
      continue;
    }
    if (child.type !== 'wiki_link') return false;
    const meta = child.meta as WikiLinkMeta | null;
    if (meta === null) return false;
    if (!subject) {
      if (meta.kind !== 'id' || meta.targetId === null) return false;
      subject = true;
      continue;
    }
    if (meta.kind !== 'date' || meta.date === null) return false;
    dates += 1;
  }
  return subject && dates > 0;
}

/**
 * Смещение НАЧАЛА ТЕКСТА пункта задачи в строке — сразу после маркера и
 * разделяющих пробелов (`- [ ] текст` → индекс `т`). `null` — маркера задачи в
 * строке нет.
 *
 * Нужен переходам «Открыть источник» (0.16.1, живая приёмка, пачка 3): каретка
 * ставится в текст задачи, а не в начало строки с маркером. Грамматика маркера
 * остаётся здесь — вне пакета своих регулярных выражений задачи нет.
 */
export function taskLineBodyStart(line: string): number | null {
  const match = TASK_LINE_MARKER_RE.exec(line);
  if (match === null) return null;
  const rest = line.slice(match[0].length);
  return match[0].length + (/^[ \t]*/.exec(rest)?.[0].length ?? 0);
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
 * `- текст`). Одиночный маркер без текста превращается в ПУСТОЙ ПУНКТ списка
 * (`- `) — как у «Сделать бессрочной» (`removeTaskLineDates`, решение
 * 2026-11-16): пустая задача без текста существовать не должна, а голый `-`
 * читался бы как обрезок. `null` — в строке нет маркера.
 */
export function removeTaskLineMarker(line: string): string | null {
  const match = TASK_LINE_MARKER_RE.exec(line);
  if (match === null) return null;
  const prefix = match[1] ?? '';
  // Отделяющий пробел после маркера убирается ровно один; отступ строки перед
  // маркером (`  [ ] текст` — маркер на строке содержимого) сохраняется.
  const rest = line.slice(match[0].length).replace(/^[ \t]/, '');
  if (rest.trim() !== '') return `${prefix}${rest}`.replace(/[ \t]+$/, '');
  // Текста нет: остаётся пустой пункт списка `- ` (у строки содержимого
  // `  [ ]` маркер списка добавляется, отступ сохраняется).
  if (prefix.trim() === '') return `${prefix}- `;
  return `${prefix.trimEnd()} `;
}

/**
 * Вернуть строке маркер задачи: `- текст` → `- [ ] текст` (обратная операция
 * к {@link removeTaskLineMarker}). Нужна «Создать задачу на сегодня» (0.16.1,
 * пачка 4, пункт 4): отменённую строку этого же субъекта за день не дублируют
 * второй строкой, а возвращают ей чекбокс — иначе повторные «Создать» и
 * «Отменить» копили бы мусорные пункты.
 *
 * `null` — строка не пункт списка (маркера списка нет); уже задача возвращается
 * как есть, поэтому повторный вызов безопасен.
 */
export function addTaskLineMarker(line: string): string | null {
  if (isTaskLineMarker(line)) return line;
  const match = TASK_LIST_PREFIX_RE.exec(line);
  if (match === null) return null;
  return `${match[0]}${TASK_MARKER_UNCHECKED}${line.slice(match[0].length)}`;
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
 * Строка, у которой дата была единственным содержимым пункта (`- [ ] [[дата]]`),
 * становится ПУСТЫМ ПУНКТОМ списка (`- `), а не пунктом задачи без текста
 * (уточнение ТЗ 2026-11-16): задачи без текста не существует, а `- [ ]` без
 * содержимого остался бы пустой задачей в проекции.
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
  const cleaned = next.replace(/[ \t]+$/, '');
  const match = TASK_LINE_MARKER_RE.exec(cleaned);
  if (match === null) return cleaned;
  if (cleaned.slice(match[0].length).trim() !== '') return cleaned;
  // Дата была единственным содержимым пункта: маркер задачи уходит вместе с ней,
  // остаётся пустой пункт маркированного списка (`- `). Отступ строки
  // сохраняется; если маркера списка в префиксе не было (маркер чекбокса стоял
  // на строке содержимого `  [ ]`), пустой пункт получает `-`.
  const prefix = match[1] ?? '';
  return prefix.trim() === '' ? `${prefix}- ` : prefix.replace(/[ \t]+$/, ' ');
}
