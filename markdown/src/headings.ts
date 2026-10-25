/**
 * Заголовки markdown-документа по block-токенам markdown-it — единый источник
 * истины для адресации секций (`etn.comments.edit`). Разбор markdown-блоков
 * живёт только в `@etn/markdown` (ADR `01ec1467`, сторож
 * `guard-selection-single-parser.test.ts`): контейнеры (списки, цитаты),
 * fenced-блоки, setext-заголовки и закрывающие решётки (`## X ##` → `X`)
 * трактуются ровно так, как их видит рендерер. Строчная регулярка этого не
 * даёт: fence внутри элемента списка или цитаты она принимает за границу
 * секции и рвёт документ при пересборке (ошибка f15f389e, круг 2).
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
