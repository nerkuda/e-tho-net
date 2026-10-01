/**
 * Чистые проверки модели публикации (0.11.1, задача 8178e007).
 *
 * Единый источник правил, которые обязаны совпадать у zod-контракта входа
 * (`contracts.ts`) и домена (`publication-service.ts`): резюме без заголовков,
 * ровно один источник обложки, непересечение рецептов, корректный диапазон
 * нумерации. Здесь нет ни БД, ни ошибок — только предикаты; обёртки-исключения
 * и схема остаются на своих слоях.
 */

/** Заголовок markdown ATX (`# …`) или setext (подчёркивание `===`/`---`). */
const MARKDOWN_ATX_HEADING = /^\s{0,3}#{1,6}\s+\S/m;
const MARKDOWN_SETEXT_HEADING = /^[^\n]+\n\s{0,3}(=+|-+)\s*$/m;

/** Содержит ли markdown-резюме заголовок (запрещены — титул без структуры). */
export function summaryHasMarkdownHeadings(text: string): boolean {
  return MARKDOWN_ATX_HEADING.test(text) || MARKDOWN_SETEXT_HEADING.test(text);
}

/** Пересечение рецептов текстов и «дополнительных материалов». */
export function recipeOverlap(textSources: string[], extraProperties: string[]): string[] {
  const extra = new Set(extraProperties);
  return textSources.filter((id) => extra.has(id));
}

/** Диапазон нумерации некорректен (`numbering_from > numbering_to`). */
export function numberingRangeInvalid(from: number | null, to: number | null): boolean {
  return from !== null && to !== null && from > to;
}
