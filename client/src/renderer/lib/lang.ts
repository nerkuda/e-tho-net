/**
 * Выбор языка интерфейса (задача 57f09136, требование 0e5ff1c6).
 *
 * Язык — L5-значение `client_meta.lang` (11-settings-and-state.md §2.1):
 * установочное, не синхронизируется между клиентами и восстанавливается на
 * старте ДО монтажа первого экрана (как тема — `lib/theme.ts`). Сам каркас
 * локализации (`lib/i18n.ts`) остаётся чистым: здесь только персист, чтение
 * на старте и запись атрибута `lang` документа.
 */

import { CLIENT_META_KEY } from '@etn/shared';
import { etn } from './etn.js';
import { DEFAULT_LANG, availableLocales, setLang } from './i18n.js';

/**
 * Применяет язык к интерфейсу и документу. Незарегистрированный язык
 * отклоняется (возвращает `false`) — рабочий язык не меняется.
 */
export function applyLang(lang: string): boolean {
  if (!setLang(lang)) return false;
  document.documentElement.lang = lang;
  return true;
}

/**
 * Восстанавливает сохранённый язык на старте. Сбой чтения или неизвестный код
 * (язык убрали из сборки) — исходный русский: клиент не должен остаться без
 * текстов из-за одной строки настроек.
 */
export async function initLang(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await etn.meta.get(CLIENT_META_KEY.LANG);
  } catch {
    raw = null;
  }
  const known = raw !== null && availableLocales().some((locale) => locale.code === raw);
  applyLang(known && raw !== null ? raw : DEFAULT_LANG);
}

/**
 * Сохраняет выбор языка в L5 `client_meta.lang` (fire-and-forget): интерфейс
 * переключается сразу, сбой записи означает лишь, что выбор не запомнится.
 */
export function persistLang(lang: string): void {
  void etn.meta.set(CLIENT_META_KEY.LANG, lang).catch(() => undefined);
}
