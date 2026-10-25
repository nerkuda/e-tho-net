/**
 * Markdown-секции для частичной правки комментариев (задача d28abe04, версия
 * 0.7.2, спека 154df95d «etn.comments.edit — правка комментария частями»).
 *
 * «Секция» — заголовок верхнего уровня (ATX `#`…`######` или setext) и всё до
 * следующего заголовка верхнего уровня; вложенные подразделы — отдельные
 * секции (модель плоская). Тексты без единого заголовка трактуются как одна
 * виртуальная секция, заголовком которой становится первая непустая строка,
 * обрезанная до 255 символов — это адресация, а не правка форматирования,
 * поэтому сам текст при этом не меняется и `#` в тело не вставляется.
 *
 * Вводный абзац перед первым `#`-заголовком тоже адресуем: он становится
 * первой виртуальной секцией (ошибка a39046d9). До правки такой текст не
 * попадал ни в одну секцию, был невидим в `sections[]` и недоступен
 * `replace_section`/`delete_section`.
 *
 * `replace_section` меняет только тело адресованной секции, её заголовок
 * сохраняется (ошибка f15f389e): заголовок в `text` допустим лишь как эхо
 * того же текста (уровень игнорируется) либо как подраздел более низкого
 * уровня; заголовок того же/более высокого уровня с другим текстом даёт
 * `VALIDATION_ERROR` — иначе в теле оставался пустой старый заголовок и
 * рядом появлялся второй.
 *
 * Файл держит только парсер секций и применение ops к строкам; запись в БД
 * делает `comment-service.ts::editComment` поверх `updateComment` — так
 * версионирование, теневые строки и журнал активности остаются единой
 * точкой прохода.
 *
 * Заголовки распознаёт {@link extractHeadings} из `@etn/markdown` (block-токены
 * markdown-it): разбор markdown-блоков живёт только в пакете рендерера
 * (ADR 01ec1467). Поэтому секциями считаются ровно те заголовки, что рендерер
 * показывает как `<h1>`…`<h6>` верхнего уровня: fence внутри списка/цитаты,
 * indented-код, закрывающие решётки `## X ##` и setext-подчёркивания трактуются
 * одинаково при разборе и рендере (ошибка f15f389e, круги 1–2).
 */

import { extractHeadings, type MarkdownHeading } from '@etn/markdown';
import { EtnError } from '@etn/shared';

/** Максимальная длина виртуального заголовка для текстов без `#`. */
const VIRTUAL_HEADING_MAX_CHARS = 255;

/** Регулярка пустой строки (любые пробельные символы). */
const BLANK_RE = /^\s*$/;

/** Тип одной операции секционной правки. */
export type EditOp =
  | { op: 'append'; text: string }
  | { op: 'prepend'; text: string }
  | { op: 'replace_section'; section: string; text: string }
  | { op: 'delete_section'; section: string };

/** Внутреннее представление секции после парсинга. */
interface Section {
  /** 1–6 для реальных заголовков; для текста без `#` — 1 (виртуальная). */
  level: number;
  /** Текст заголовка без решёток (для виртуальной — первая строка). */
  heading: string;
  /** Содержимое секции без заголовка (для текста без `#` — весь текст,
   *  чтобы сохранить содержимое дословно при обратной склейке). */
  content: string;
  /** Секция виртуальная: в исходном теле не было `#`-заголовка. Это
   *  адресация, а не правка форматирования — при `replace_section`/`delete`
   *  реальный `#` в тело не добавляется. */
  virtual: boolean;
}

/** Нормализовать блок переводов строки до максимум двух подряд `\n`. */
function collapseBlankRuns(input: string): string {
  return input.replace(/\n{3,}/g, '\n\n');
}

/**
 * Выделить первую непустую строку из тела. Виртуальный заголовок для текста
 * без `#`: обрезается до {@link VIRTUAL_HEADING_MAX_CHARS}.
 */
function virtualHeading(body: string): string {
  const trimmed = body.split('\n').find((line) => !BLANK_RE.test(line)) ?? '';
  return trimmed.trim().slice(0, VIRTUAL_HEADING_MAX_CHARS);
}

/**
 * Заголовки ВЕРХНЕГО уровня документа (они и есть секции). Заголовок внутри
 * списка или цитаты (`tokenLevel > 0`) принадлежит контейнеру: пересборка
 * тела по строкам вынесла бы его из контейнера, поэтому секцией он не
 * считается (ошибка f15f389e, круг 2).
 */
function collectHeadings(body: string): MarkdownHeading[] {
  return extractHeadings(body).filter((h) => h.tokenLevel === 0);
}

/**
 * Разобрать тело комментария на секции. Если в тексте есть хотя бы один
 * заголовок верхнего уровня — возвращаются они; иначе возвращается одна
 * виртуальная секция с первой непустой строкой в роли заголовка и полным
 * телом в роли содержимого (дословно — без вставки `#`). Непустой вводный
 * текст до первого заголовка тоже становится первой виртуальной секцией
 * (ошибка a39046d9) — иначе он не адресуем и молча пропадает из `sections[]`.
 * Пустое тело — пустой массив секций: адресовать нечего, и `sections[]`
 * в ответе будет пустым.
 */
function parseSections(body: string): Section[] {
  if (body === '') return [];
  const headings = collectHeadings(body);
  if (headings.length === 0) {
    return [
      { level: 1, heading: virtualHeading(body), content: body, virtual: true },
    ];
  }
  const lines = body.split('\n');
  const sections: Section[] = [];
  // Вводный абзац (всё до первого заголовка) — виртуальная секция, если
  // в нём есть хоть одна непустая строка. Пустой/пробельный префикс не
  // порождает секции.
  const firstHeadingLine = headings[0]!.line;
  const preamble = lines.slice(0, firstHeadingLine).join('\n');
  if (!BLANK_RE.test(preamble)) {
    sections.push({
      level: 1,
      heading: virtualHeading(preamble),
      content: preamble,
      virtual: true,
    });
  }
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i]!;
    const endLine = i + 1 < headings.length ? headings[i + 1]!.line : lines.length;
    const contentLines = lines.slice(start.contentLine, endLine);
    sections.push({
      level: start.level,
      heading: start.text,
      content: contentLines.join('\n'),
      virtual: false,
    });
  }
  return sections;
}

/**
 * Собрать секции обратно в тело. Реальные секции дают `## heading\ncontent`,
 * между секциями — `\n\n`. Виртуальная секция (нет `#`-заголовка) даёт
 * только `content` без префикса. Контент не трогаем (нормализацию выполнит
 * вызывающий), но схлопываем тройные `\n` в `\n\n` по всему телу.
 */
function joinSections(sections: Section[]): string {
  const blocks = sections.map((s) => {
    if (s.virtual) return s.content;
    const header = '#'.repeat(s.level) + ' ' + s.heading;
    if (s.content === '') return header;
    return header + '\n' + s.content;
  });
  return collapseBlankRuns(blocks.join('\n\n'));
}

/**
 * Список заголовков секций тела. Виртуальная первая строка возвращается для
 * текстов без `#`. Уровень не учитывается — агент адресуется только по
 * тексту заголовка.
 */
export function listSections(body: string): string[] {
  return parseSections(body).map((s) => s.heading);
}

/**
 * Проверить тело на наличие повторяющихся заголовков одного уровня —
 * молча править первый из двух одинаковых заголовков опасно, поэтому
 * бросаем `VALIDATION_ERROR`. Применяется к телу **до** ops, чтобы ошибочный
 * ввод был виден сразу, а не после первой успешной замены.
 */
export function validateSections(body: string): void {
  const counts = new Map<string, { level: number; heading: string; n: number }>();
  for (const { level, text } of collectHeadings(body)) {
    const key = `${level}\u0000${text}`;
    const prev = counts.get(key);
    if (prev === undefined) {
      counts.set(key, { level, heading: text, n: 1 });
    } else {
      prev.n += 1;
    }
  }
  for (const { level, heading, n } of counts.values()) {
    if (n > 1) {
      throw new EtnError(
        'VALIDATION_ERROR',
        `section with heading "${heading}" (level ${level}) repeats ${n} times`,
        { section: heading, level, count: n },
      );
    }
  }
}

/**
 * Развернуть переданный текст замены в полное тело реальной секции.
 *
 * `replace_section` заменяет только ТЕЛО адресованной секции — её заголовок
 * сохраняется. Поэтому заголовок в `text` необязателен и трактуется так
 * (ошибка f15f389e — задвоение заголовка):
 *   * эхо адресованного заголовка — тот же текст, уровень не важен (агент
 *     скопировал заголовок из другого места или сменил уровень) — строка
 *     отбрасывается, остаётся исходный заголовок;
 *   * заголовок более низкого уровня (подраздел) — это содержимое, он
 *     остаётся в теле;
 *   * заголовок того же или более высокого уровня с другим текстом — попытка
 *     переименовать/подменить секцию: `VALIDATION_ERROR`. Иначе в теле
 *     оставался пустой старый заголовок и появлялся второй (грабля 0.8.3).
 *
 * Ведущие пустые строки снимаются до проверки, чтобы `\n## Заголовок` не
 * прятал эхо от распознавания. Заголовком считается только блок ВЕРХНЕГО
 * уровня, начинающий `text`: `- ## X`, `> ## X` и код-блоки — это тело, а не
 * эхо (ошибка f15f389e, круг 2).
 */
function buildReplacement(level: number, heading: string, text: string): string {
  const headLine = '#'.repeat(level) + ' ' + heading;
  const body = text.replace(/^\n+/, '');
  if (body === '') return headLine;
  const lead = extractHeadings(body)[0];
  if (lead !== undefined && lead.line === 0 && lead.tokenLevel === 0) {
    const rest = body
      .split('\n')
      .slice(lead.contentLine)
      .join('\n')
      .replace(/^\n+/, '');
    if (lead.text === heading.trim()) {
      // Эхо адресованного заголовка: исходный заголовок уже будет в теле,
      // строку из `text` не дублируем. Уровень игнорируется — заголовок
      // секции остаётся прежним.
      return rest === '' ? headLine : headLine + '\n' + rest;
    }
    if (lead.level <= level) {
      throw new EtnError(
        'VALIDATION_ERROR',
        'replace_section text must not start with a heading of the same or higher level: ' +
          'the section heading is preserved automatically — pass only the section body',
        {
          section: heading,
          level,
          text_heading: lead.text,
          text_level: lead.level,
        },
      );
    }
    // Более низкий уровень — подраздел внутри тела; заголовок секции нужен.
  }
  return headLine + '\n' + body;
}

/**
 * Соединить два блока текста одной пустой строкой-разделителем — без тройных
 * `\n`, даже если один из блоков уже заканчивается или начинается на `\n`.
 * Используется для `append` / `prepend`.
 */
function joinWithBlank(left: string, right: string): string {
  if (left === '') return right;
  if (right === '') return left;
  const l = left.replace(/\n+$/, '');
  const r = right.replace(/^\n+/, '');
  return collapseBlankRuns(`${l}\n\n${r}`);
}

/**
 * Применить массив ops к телу комментария. Ops идут **последовательно** —
 * каждый видит результат предыдущего. Текст валидируется после каждой правки:
 * повторяющиеся заголовки одного уровня дают `VALIDATION_ERROR` (откат
 * транзакции делает вызывающий код). Виртуальная первая строка для текста
 * без `#` представляется как единственная секция с `level: 1`.
 *
 * Возвращает новое тело и список заголовков секций (для ответа агенту).
 */
export function applySectionOps(
  body: string,
  ops: EditOp[],
): { body: string; sections: string[] } {
  let current = body;
  for (const op of ops) {
    current = applyOneOp(current, op);
    validateSections(current);
  }
  return { body: current, sections: listSections(current) };
}

function applyOneOp(body: string, op: EditOp): string {
  switch (op.op) {
    case 'append':
      return joinWithBlank(body, op.text);
    case 'prepend':
      return joinWithBlank(op.text, body);
    case 'replace_section':
      return replaceSection(body, op.section, op.text);
    case 'delete_section':
      return deleteSection(body, op.section);
  }
}

function replaceSection(body: string, section: string, text: string): string {
  const sections = parseSections(body);
  const target = section.trim();
  const idx = sections.findIndex((s) => s.heading.trim() === target);
  if (idx === -1) {
    throw new EtnError('NOT_FOUND', `section "${section}" not found`, {
      sections: sections.map((s) => s.heading),
    });
  }
  const found = sections[idx]!;
  if (found.virtual) {
    // Виртуальная секция: в исходном теле не было `#`-заголовка. Не вставляем
    // `#` ради замены — иначе сломается «Сам текст при этом НЕ меняется»
    // (спека 154df95d). Заменяем ТОЛЬКО содержимое виртуальной секции,
    // сохраняя остальные: у вводного абзаца перед `#`-заголовками (ошибка
    // a39046d9) соседние реальные секции обязаны уцелеть. Пустой текст
    // удаляет вводный абзац целиком.
    if (text === '') return collapseBlankRuns(joinSections(sections.slice(0, idx).concat(sections.slice(idx + 1))));
    const replacement: Section = {
      level: 1,
      heading: virtualHeading(text),
      content: collapseBlankRuns(text),
      virtual: true,
    };
    const next = sections.slice(0, idx).concat([replacement], sections.slice(idx + 1));
    return collapseBlankRuns(joinSections(next));
  }
  const replacement = buildReplacement(found.level, found.heading, text);
  // Разбираем replacement обратно в секции, чтобы подтянуть вложенные
  // заголовки внутрь (если `text` сам содержит подразделы) — это сохраняет
  // иерархию и позволяет `replace_section` менять сразу несколько уровней.
  const replaced = parseSections(replacement);
  const next = sections.slice(0, idx).concat(replaced, sections.slice(idx + 1));
  return collapseBlankRuns(joinSections(next));
}

function deleteSection(body: string, section: string): string {
  const sections = parseSections(body);
  const target = section.trim();
  const idx = sections.findIndex((s) => s.heading.trim() === target);
  if (idx === -1) {
    throw new EtnError('NOT_FOUND', `section "${section}" not found`, {
      sections: sections.map((s) => s.heading),
    });
  }
  const next = sections.slice(0, idx).concat(sections.slice(idx + 1));
  if (next.length === 0) {
    // Удаление единственной секции: запись не удаляется, но тело становится
    // пустым. updateComment по умолчанию такое отвергает — вызывающий код
    // (editComment) знает, что здесь это допустимая граница операции.
    return '';
  }
  return collapseBlankRuns(joinSections(next));
}
