/**
 * Каркас локализации клиента (задача 57f09136, требование 0e5ff1c6
 * «Локализация: все строки интерфейса — из словаря, с подстановками
 * параметров»).
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
 * **Fallback.** Ключа нет ни в выбранном языке, ни в исходном — возвращается
 * сам ключ: интерфейс не падает и видно, что именно не переведено.
 *
 * Модуль чистый (без DOM и без обращений к серверу) — его можно проверять
 * юнит-тестами; персист выбора языка живёт в `lib/lang.ts`.
 */

import { ru } from './locales/ru.js';

/** Ключ строки словаря — только ключи исходного языка (`ru`). */
export type MessageKey = keyof typeof ru;

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
 * Регистрирует (или заменяет) каталог языка. Исходный `ru` зарегистрирован
 * при загрузке модуля.
 */
export function registerLocale(code: string, catalog: MessageCatalog): void {
  catalogs.set(code, catalog);
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

/**
 * Переключает язык интерфейса. Незарегистрированный код игнорируется
 * (возвращает `false`) — рабочий язык остаётся прежним.
 */
export function setLang(lang: string): boolean {
  if (!catalogs.has(lang)) return false;
  if (lang === current) return true;
  current = lang;
  for (const listener of listeners) listener(lang);
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

registerLocale(DEFAULT_LANG, ru);
