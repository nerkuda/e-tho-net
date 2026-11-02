/**
 * Плюрализация: категории и формы по правилам языка (задача e6374cd1).
 *
 * Единственная точка выбора категории — `Intl.PluralRules`: правила языка
 * (ru `one/few/many/other`, en `one/other`, zh `other`) не дублируются в коде,
 * а берутся из ICU. Модуль чистый (без DOM и сети) и служит общим типом для
 * каталогов языков: файл языка экспортирует типизированный `*Plurals`
 * (`PluralCatalog`), а `tp(key, n)` в `lib/i18n.ts` выбирает форму категории.
 *
 * Почему не `n === 1 ? …` в местах вызова: копии такого условия уже давали
 * рассогласование на 1 и 11 (задача d23279f6), а дробные числа (1,5) по
 * русским правилам — категория `other`, которую точечные проверки не знали.
 *
 * Категории `zero`/`two` зарезервированы ICU (нужны арабскому и др.); каталог
 * языка заполняет только те, что реально выбирает `Intl.PluralRules` этого
 * языка. Сторож — `tests/guard-plural-categories.test.ts`.
 */

/** Категория плюрализации ICU (`one`, `few`, `many`, `other`, …). */
export type PluralCategory = Intl.LDMLPluralRule;

/** Формы одного ключа: категория → текст с подстановкой `%1`. */
export type PluralForms = Partial<Record<PluralCategory, string>>;

/** Каталог плюрализации языка: ключ → формы. */
export type PluralCatalog = Record<string, PluralForms>;

/** Кеш правил: `Intl.PluralRules` одного языка создаётся один раз. */
const rules = new Map<string, Intl.PluralRules>();

/**
 * Категория числа по правилам языка. Дробные и отрицательные числа
 * обрабатывает ICU: для `ru` 1,5 → `other`, −3 → `few`.
 */
export function pluralCategory(lang: string, n: number): PluralCategory {
  let instance = rules.get(lang);
  if (instance === undefined) {
    instance = new Intl.PluralRules(lang);
    rules.set(lang, instance);
  }
  return instance.select(n);
}
