/**
 * Markdown-секции для частичной правки комментариев (задача d28abe04, версия
 * 0.7.2, спека 154df95d «etn.comments.edit — правка комментария частями»).
 *
 * «Секция» — заголовок любого уровня `#`…`######` и всё до следующего
 * заголовка того же или более высокого уровня (вложенные подразделы входят
 * в секцию). Тексты без единого `#` трактуются как одна виртуальная секция,
 * заголовком которой становится первая непустая строка, обрезанная до
 * 255 символов — это адресация, а не правка форматирования, поэтому сам
 * текст при этом не меняется и `#` в тело не вставляется.
 *
 * Файл держит только парсер секций и применение ops к строкам; запись в БД
 * делает `comment-service.ts::editComment` поверх `updateComment` — так
 * версионирование, теневые строки и журнал активности остаются единой
 * точкой прохода.
 */

import { EtnError } from '@etn/shared';

/** Максимальная длина виртуального заголовка для текстов без `#`. */
const VIRTUAL_HEADING_MAX_CHARS = 255;

/** Регулярка заголовка уровня 1–6: `#` … `######`, потом пробел и текст. */
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

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

/** Пара (уровень, заголовок) одной строки `#`-заголовка в теле. */
interface HeadingHit {
  level: number;
  heading: string;
  line: number;
}

/**
 * Пройтись по строкам и собрать все `#`-заголовки в порядке появления.
 * Используется и {@link parseSections}, и {@link validateSections}.
 */
function collectHeadings(body: string): HeadingHit[] {
  const lines = body.split('\n');
  const out: HeadingHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = HEADING_RE.exec(line);
    if (!m) continue;
    const hashes = m[1] ?? '';
    const text = m[2] ?? '';
    out.push({ level: hashes.length, heading: text.trim(), line: i });
  }
  return out;
}

/**
 * Разобрать тело комментария на секции. Если в тексте есть хотя бы один
 * `#` заголовок — возвращаются они; иначе возвращается одна виртуальная
 * секция с первой непустой строкой в роли заголовка и полным телом в роли
 * содержимого (дословно — без вставки `#`). Пустое тело — пустой массив
 * секций: адресовать нечего, и `sections[]` в ответе будет пустым.
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
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i]!;
    const endLine = i + 1 < headings.length ? headings[i + 1]!.line : lines.length;
    const contentLines = lines.slice(start.line + 1, endLine);
    sections.push({
      level: start.level,
      heading: start.heading,
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
  for (const { level, heading } of collectHeadings(body)) {
    const key = `${level}\u0000${heading}`;
    const prev = counts.get(key);
    if (prev === undefined) {
      counts.set(key, { level, heading, n: 1 });
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
 * Развернуть переданный текст замены в полное тело секции. Если секция
 * реальная — заголовок уровня `level` добавляется автоматически, когда
 * `text` его не несёт; для виртуальной секции заголовок не вставляется,
 * текст замены остаётся дословным содержимым.
 */
function buildReplacement(
  level: number,
  heading: string,
  text: string,
  virtual: boolean,
): string {
  if (virtual) {
    // Виртуальная секция: исходного `#`-заголовка не было — вставлять его
    // ради замены нельзя, иначе сломается «Сам текст при этом НЕ меняется»
    // (спека 154df95d, раздел «Страховка для текстов без заголовков»).
    return text;
  }
  const headLine = '#'.repeat(level) + ' ' + heading;
  const firstLine = text.split('\n', 1)[0] ?? '';
  const m = HEADING_RE.exec(firstLine);
  if (m !== null) {
    const hashes = m[1] ?? '';
    const headingText = (m[2] ?? '').trim();
    if (hashes.length === level && headingText === heading.trim()) {
      // Дублирующийся заголовок убираем — иначе после замены окажется, что
      // одна и та же строка повторяется, и validateSections зарубит правку.
      const rest = text.slice(firstLine.length).replace(/^\n/, '');
      if (rest === '') return headLine;
      return headLine + '\n' + rest;
    }
  }
  if (text === '') return headLine;
  return headLine + '\n' + text;
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
    // (спека 154df95d). Заменяем содержимое тела как есть; если `text` сам
    // содержит `#`-заголовки — последующие ops адресуются уже по ним.
    return collapseBlankRuns(text);
  }
  const replacement = buildReplacement(found.level, found.heading, text, false);
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
