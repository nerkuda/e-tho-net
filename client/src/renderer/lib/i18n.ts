/**
 * Каркас локализации клиента (задача 57f09136, требование 0e5ff1c6
 * «Локализация: все строки интерфейса — из словаря, с подстановками
 * параметров»; плюрализация и Intl-форматы — задача e6374cd1).
 *
 * **Зачем.** Пользовательские строки жили литералами в разметке и разошлись
 * по формулировкам; без единого словаря каждый следующий компонент приносил
 * бы свои. Здесь — единственная точка доступа к текстам: `t(key, params?)`,
 * подстановки позиционных параметров `%1`/`%2`, реестр каталогов языков и
 * выбор языка. Строки новых компонентов (`lib/ui/*`, `lib/dialog.ts`) и
 * переведённых мест берутся только отсюда — сторож
 * `tests/guard-ui-i18n.test.ts`.
 *
 * **Формат каталога — TS-объект** (`lib/locales/ru.ts`), а не JSON, хотя
 * «Технические принципы UI» называют JSON-каталоги. Причина: тип ключей
 * выводится из исходного каталога (`MessageKey = keyof typeof ru`), поэтому
 * `t('actions.cansel')` — ошибка компиляции `typecheck`, а не пустая подпись
 * в интерфейсе; JSON такой проверки не даёт (в Node ESM его пришлось бы ещё
 * импортировать с import attributes). Каталог остаётся отдельным файлом
 * языка, добавление языка не меняет API: новый файл + `registerLocale`.
 *
 * **Подстановки.** Текст формулируется обобщённо, с позиционными параметрами:
 * `t('errors.writeFailed', name, reason)` для «Не удалось записать %1 по
 * причине %2». Отсутствующий параметр не подставляется — в строке остаётся
 * `%n` (заметная ошибка вызова), исключения не бросаются.
 *
 * **Плюрализация.** `tp(key, n, params?)` берёт формы ключа `*Plurals` файла
 * языка и выбирает категорию через `Intl.PluralRules` (`lib/plural.ts`):
 * ru `one/few/many/other`, en `one/other`, zh `other`. `%1` — само число,
 * дополнительные параметры идут с `%2`. Язык без своего каталога форм (пока
 * каталог не зарегистрирован) добирает формы исходного `ru`.
 *
 * **Intl-форматы.** `formatDate`/`formatDateTime`/`formatNumber` форматируют
 * по текущему языку; готовые `Intl.*Format` кешируются по `(язык, options)`,
 * потому что создание форматтера на каждую строку таблицы дорого. Даты и
 * числа вне этого API не форматируются: иначе формат расходится с языком
 * (`toLocaleDateString('ru-RU')` в переведённом экране).
 *
 * **Fallback.** Ключа нет ни в выбранном языке, ни в исходном — возвращается
 * сам ключ: интерфейс не падает и видно, что именно не переведено.
 *
 * Модуль чистый (без DOM и без обращений к серверу) — его можно проверять
 * юнит-тестами; персист выбора языка живёт в `lib/lang.ts`.
 */

import {
  pluralCategory,
  type PluralCatalog,
  type PluralCategory,
  type PluralForms,
} from './plural.js';
import { ru, ruPlurals } from './locales/ru.js';

/** Ключ строки словаря — только ключи исходного языка (`ru`). */
export type MessageKey = keyof typeof ru;

/** Ключ плюрализации — только ключи форм исходного языка (`ruPlurals`). */
export type PluralKey = keyof typeof ruPlurals;

/** Параметр подстановки: строка или число. */
export type MessageParam = string | number;

/** Каталог языка: частичный перевод исходных ключей. */
export type MessageCatalog = Partial<Record<MessageKey, string>>;

/** Сведения о зарегистрированном языке. */
export interface LocaleInfo {
  /** Код языка (`ru`). */
  code: string;
  /** Имя языка для выбора в настройках (ключ `lang.<код>` каталога). */
  name: string;
}

/** Исходный язык — он всегда полон и служит опорой fallback. */
export const DEFAULT_LANG = 'ru';

/** Зарегистрированные каталоги: код языка → словарь. */
const catalogs = new Map<string, MessageCatalog>();

/** Зарегистрированные каталоги форм плюрализации: код языка → формы. */
const pluralCatalogs = new Map<string, PluralCatalog>();

/** Текущий язык интерфейса. */
let current = DEFAULT_LANG;

/** Подписчики смены языка (перерисовка экранов после `setLang`). */
const listeners = new Set<(lang: string) => void>();

/**
 * Текст по ключу из каталога: сначала текущего языка, затем исходного.
 * `undefined` — ключа нет вовсе (см. fallback в {@link t}).
 */
function lookup(lang: string, key: MessageKey): string | undefined {
  const value = catalogs.get(lang)?.[key];
  if (typeof value === 'string' && value !== '') return value;
  if (lang !== DEFAULT_LANG) {
    const fallback = catalogs.get(DEFAULT_LANG)?.[key];
    if (typeof fallback === 'string' && fallback !== '') return fallback;
  }
  return undefined;
}

/** Подставляет позиционные параметры `%1`, `%2`, … в шаблон. */
function interpolate(template: string, params?: MessageParam | readonly MessageParam[]): string {
  if (params === undefined) return template;
  const list: readonly MessageParam[] = Array.isArray(params) ? params : [params as MessageParam];
  return template.replace(/%(\d+)/g, (placeholder, index: string) => {
    const value = list[Number(index) - 1];
    return value === undefined ? placeholder : String(value);
  });
}

/**
 * Текст интерфейса по ключу. Параметры — либо одним значением, либо списком:
 * `t('actions.closeShortcut', 'Esc')`, `t('errors.writeFailed', [name, reason])`.
 * Ключа нет — возвращается сам ключ ({@link MessageKey} закрывает и эту
 * возможность на уровне типов, fallback — защита для рантайма).
 */
export function t(key: MessageKey, params?: MessageParam | readonly MessageParam[]): string {
  const template = lookup(current, key);
  if (template === undefined) return key;
  return interpolate(template, params);
}

/**
 * Текст с согласованием числа по правилам текущего языка: `tp('plurals.child',
 * 3)` → «3 потомка». `n` подставляется в `%1`, `params` — дальше с `%2`.
 *
 * Категорию выбирает `Intl.PluralRules` (не арифметика по модулю 10): дробные
 * числа в русском — `other`, а правила других языков задаёт ICU. У языка нет
 * своего каталога форм — берутся формы исходного `ru`, чтобы интерфейс не
 * остался без текста.
 */
export function tp(
  key: PluralKey,
  n: number,
  params?: MessageParam | readonly MessageParam[],
): string {
  const forms: PluralForms | undefined =
    pluralCatalogs.get(current)?.[key] ?? (ruPlurals[key] as PluralForms | undefined);
  const category: PluralCategory = pluralCategory(current, n);
  const template =
    forms?.[category] ?? forms?.other ?? forms?.many ?? forms?.few ?? forms?.one ?? key;
  const extra: readonly MessageParam[] =
    params === undefined ? [] : Array.isArray(params) ? params : [params as MessageParam];
  return interpolate(template, [n, ...extra]);
}

/** Кеш форматтеров даты/времени по `(язык, options)`. */
const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** Кеш числовых форматтеров по `(язык, options)`. */
const numberFormats = new Map<string, Intl.NumberFormat>();

/** Ключ кеша форматтера: язык + сериализованные опции. */
function formatKey(lang: string, options?: Intl.DateTimeFormatOptions | Intl.NumberFormatOptions): string {
  return `${lang}|${options === undefined ? '' : JSON.stringify(options)}`;
}

/** `Date` из значения форматтера; `null` — значение не является датой. */
function toDate(value: Date | number | string): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Форматтер даты/времени текущего языка — один на пару `(язык, options)`. */
function dateFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = formatKey(current, options);
  let formatter = dateFormats.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(current, options);
    dateFormats.set(key, formatter);
  }
  return formatter;
}

/**
 * Дата по текущему языку. По умолчанию — короткая форма (`24.09.2026` в ru,
 * `9/24/26` в en, `2026/9/24` в zh). Невалидная дата — пустая строка:
 * вызывающий сам решает, показать прочерк или исходное значение.
 */
export function formatDate(
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = toDate(value);
  if (date === null) return '';
  return dateFormatter(options ?? { dateStyle: 'short' }).format(date);
}

/** Дата и время по текущему языку (по умолчанию короткая дата + среднее время). */
export function formatDateTime(
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = toDate(value);
  if (date === null) return '';
  return dateFormatter(options ?? { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

/**
 * Части отформатированной даты — для заголовков, которым год нужен без
 * языкового суффикса (ru «г.»): вызывающий собирает текст из частей сам
 * (образец — `formatDayLabel` в `screens/chronicle/diary.ts`).
 */
export function formatDateParts(
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormatPart[] {
  const date = toDate(value);
  if (date === null) return [];
  return dateFormatter(options ?? { dateStyle: 'short' }).formatToParts(date);
}

/**
 * Число по текущему языку: группировка разрядов и разделитель дробной части
 * берутся из локали (`1 234,5` в ru, `1,234.5` в en/zh).
 */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  const key = formatKey(current, options);
  let formatter = numberFormats.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(current, options);
    numberFormats.set(key, formatter);
  }
  return formatter.format(value);
}

/**
 * Регистрирует (или заменяет) каталог языка. Исходный `ru` зарегистрирован
 * при загрузке модуля. `plurals` — формы плюрализации языка; без них `tp`
 * добирает формы `ru` (перевод плюралов появится вместе с каталогом языка).
 */
export function registerLocale(
  code: string,
  catalog: MessageCatalog,
  plurals?: PluralCatalog,
): void {
  catalogs.set(code, catalog);
  if (plurals !== undefined) pluralCatalogs.set(code, plurals);
  else pluralCatalogs.delete(code);
}

/** Языки, доступные для выбора, в порядке регистрации. */
export function availableLocales(): LocaleInfo[] {
  return [...catalogs.keys()].map((code) => {
    const name = catalogs.get(code)?.[`lang.${code}` as MessageKey];
    return { code, name: typeof name === 'string' && name !== '' ? name : code };
  });
}

/** Текущий язык интерфейса. */
export function getLang(): string {
  return current;
}

/** Зарегистрирован ли каталог языка (выбор возможен только для него). */
export function hasLocale(code: string): boolean {
  return catalogs.has(code);
}

/**
 * Переключает язык интерфейса. Незарегистрированный код игнорируется
 * (возвращает `false`) — рабочий язык остаётся прежним.
 *
 * Ошибка одного подписчика не отменяет остальных и не меняет результат:
 * перерисовка экранов — независимые обработчики, падение одного не должно
 * оставить интерфейс на смеси языков (задача e6374cd1).
 */
export function setLang(lang: string): boolean {
  if (!catalogs.has(lang)) return false;
  if (lang === current) return true;
  current = lang;
  for (const listener of [...listeners]) {
    try {
      listener(lang);
    } catch (err) {
      console.error('[i18n] onLangChange listener failed', err);
    }
  }
  return true;
}

/** Подписка на смену языка; возвращает функцию отписки. */
export function onLangChange(listener: (lang: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Есть ли ключ в каталоге языка (для тестов и диагностики). */
export function hasMessage(lang: string, key: MessageKey): boolean {
  return lookup(lang, key) !== undefined;
}

registerLocale(DEFAULT_LANG, ru, ruPlurals);
