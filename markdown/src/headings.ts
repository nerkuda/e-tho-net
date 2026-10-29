/**
 * Заголовки markdown-документа по block-токенам markdown-it — единый источник
 * истины для адресации секций (`etn.comments.edit`). Разбор markdown-блоков
 * живёт только в `@etn/markdown` (ADR `01ec1467`, сторож
 * `guard-selection-single-parser.test.ts`): контейнеры (списки, цитаты),
 * fenced-блоки, setext-заголовки и закрывающие решётки (`## X ##` → `X`)
 * трактуются ровно так, как их видит рендерер. Строчная регулярка этого не
 * даёт: fence внутри элемента списка или цитаты она принимает за границу
 * секции и рвёт документ при пересборке (ошибка f15f389e, круг 2).
 *
 * {@link formatHeading} — обратная операция: записать заголовок так, чтобы
 * повторный разбор дал тот же уровень и текст. Многострочный setext-заголовок
 * остаётся setext-блоком: в ATX его текст невыразим (ошибка f15f389e, круг 3).
 */

import { getRenderer } from './renderer.js';

/** Один заголовок документа, найденный block-токенами markdown-it. */
export interface MarkdownHeading {
  /** Уровень заголовка 1–6. */
  level: number;
  /** Inline-текст заголовка как в исходнике: без решёток и закрывающей последовательности. */
  text: string;
  /** Первая строка заголовочного блока (0-based; у setext — строка текста). */
  line: number;
  /** Первая строка ПОСЛЕ заголовочного блока (0-based): ATX — `line + 1`, setext — через строку подчёркивания. */
  contentLine: number;
  /**
   * Уровень вложенности block-токена markdown-it: 0 — заголовок верхнего
   * уровня документа, больше — внутри списка/цитаты (такой заголовок
   * принадлежит контейнеру и секцией документа не является).
   */
  tokenLevel: number;
}

/**
 * Извлечь все заголовки источника в порядке появления. Разбор идёт тем же
 * экземпляром markdown-it, что и рендер, поэтому результат совпадает с
 * фактическими `<h1>`…`<h6>` (включая контейнеры и код-блоки).
 */
export function extractHeadings(source: string): MarkdownHeading[] {
  const tokens = getRenderer().parse(source, {});
  const out: MarkdownHeading[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open === undefined || open.type !== 'heading_open' || open.map === null) continue;
    const inline = tokens[i + 1];
    if (inline === undefined || inline.type !== 'inline') continue;
    const level = Number(open.tag.slice(1));
    if (!Number.isInteger(level) || level < 1 || level > 6) continue;
    const start = open.map[0] ?? 0;
    out.push({
      level,
      text: inline.content.trim(),
      line: start,
      contentLine: open.map[1] ?? start + 1,
      tokenLevel: open.level,
    });
  }
  return out;
}

/**
 * Записать заголовок (`level`, `text`) в markdown — обратная операция к
 * {@link extractHeadings}: повторный разбор даёт тот же уровень и текст.
 *
 * Форма зависит от текста:
 *   * без переводов строки (включая пустой) — ATX: `#`×level, пробел и текст.
 *     Закрывающие решётки и лишние пробелы снимаются — `## X ##` печатается
 *     как `## X`, как и в рендере;
 *   * с переводами строки — только setext: строки текста и подчёркивание
 *     (`=` для `<h1>`, `-` для `<h2>`). ATX такую строку выразить не может:
 *     `## Внимание\nЭто важно` — это заголовок «Внимание» и отдельный абзац,
 *     то есть потеря текста заголовка (ошибка f15f389e, круг 3).
 *
 * Setext даёт только `<h1>`/`<h2>`, поэтому многострочный текст с другим
 * уровнем — ошибка вызывающего кода (из {@link extractHeadings} такой уровень
 * прийти не может).
 */
export function formatHeading(level: number, text: string): string {
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new Error(`formatHeading: level must be 1..6, got ${String(level)}`);
  }
  if (!text.includes('\n')) {
    return text === '' ? '#'.repeat(level) : '#'.repeat(level) + ' ' + text;
  }
  if (level > 2) {
    throw new Error(
      `formatHeading: multi-line heading requires setext (level 1-2), got ${String(level)}`,
    );
  }
  const underline = (level === 1 ? '=' : '-').repeat(
    Math.max(3, ...text.split('\n').map((line) => line.length)),
  );
  return text + '\n' + underline;
}
