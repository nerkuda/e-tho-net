/**
 * Русское согласование числа (задача d23279f6, замечание верификатора:
 * «1 потомков» вместо «1 потомок»).
 *
 * Чистая функция без зависимостей: категория выбирается по правилам русского
 * языка — `one` (1, 21, 31…, но не 11), `few` (2–4, 22–24…, но не 12–14),
 * `many` (0, 5–20, 25–30…). Вызывающий берёт из словаря форму для категории,
 * поэтому строки остаются в `lib/locales`, а не склеиваются в коде.
 *
 * Единая точка вместо копий `n === 1 ? '' : 'ов'` (trash.ts, usage-panel.ts):
 * копии уже давали рассогласование на числе 1.
 */

/** Категория согласования для русского числа. */
export type PluralCategory = 'one' | 'few' | 'many';

/** Категория русского согласования для целого числа. */
export function pluralCategory(n: number): PluralCategory {
  const abs = Math.abs(Math.trunc(n));
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'many';
  const mod10 = abs % 10;
  if (mod10 === 1) return 'one';
  if (mod10 >= 2 && mod10 <= 4) return 'few';
  return 'many';
}

/** Готовая форма слова: `pluralRu(1, 'потомок', 'потомка', 'потомков')`. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const category = pluralCategory(n);
  if (category === 'one') return one;
  if (category === 'few') return few;
  return many;
}
