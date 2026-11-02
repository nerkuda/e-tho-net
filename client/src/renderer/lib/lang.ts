/**
 * Выбор языка интерфейса (задача 57f09136, требование 0e5ff1c6; автодетект и
 * деградация — задача e6374cd1).
 *
 * Язык — L5-значение `client_meta.lang` (11-settings-and-state.md §2.1):
 * установочное, не синхронизируется между клиентами и восстанавливается на
 * старте ДО монтажа первого экрана (как тема — `lib/theme.ts`). Сам каркас
 * локализации (`lib/i18n.ts`) остаётся чистым: здесь только персист, чтение
 * на старте, атрибут `lang` документа и деградация недоступного каталога.
 *
 * **Старт без сохранённого языка** (первый запуск, сценарий b259ab45): язык
 * берётся из системного окружения — main отдаёт `en`/`zh`/`ru` по локали ОС
 * (`system.preferredLanguage`, образец `system.appInfo`). Детект НЕ
 * персистится: это стартовое отображение, пока серверная резолюция не
 * получена; в профиль пользователя язык не записывается (ADR daab6ac4).
 *
 * **Недоступный каталог** (`en`/`zh` ещё не собраны): эффективный язык —
 * исходный `ru` целиком, без построчной смеси. Факт пишется в журнал
 * (`ui.i18n.locale_unavailable`), настройки показывают объяснение, а
 * `document.lang` не выставляется в недоступный код.
 */

import { CLIENT_META_KEY } from '@etn/shared';
import { etn } from './etn.js';
import { DEFAULT_LANG, hasLocale, setLang } from './i18n.js';
import { logUiEvent } from './ui-log.js';

/**
 * Последний запрошенный, но недоступный в сборке язык (`null` — деградации
 * нет). Настройки показывают по нему видимое сообщение; язык интерфейса при
 * этом — `ru`.
 */
let unavailable: string | null = null;

/** Язык, каталог которого недоступен в сборке (для сообщения в настройках). */
export function unavailableLang(): string | null {
  return unavailable;
}

/**
 * Применяет язык к интерфейсу и документу. Недоступный каталог деградирует на
 * исходный `ru` (возвращает `false`): интерфейс не остаётся на смеси языков,
 * `document.lang` указывает на реально показанный язык.
 */
export function applyLang(lang: string): boolean {
  if (!hasLocale(lang)) {
    unavailable = lang;
    logUiEvent('ui.i18n.locale_unavailable', { lang });
    setLang(DEFAULT_LANG);
    document.documentElement.lang = DEFAULT_LANG;
    return false;
  }
  unavailable = null;
  if (!setLang(lang)) return false;
  document.documentElement.lang = lang;
  return true;
}

/**
 * Восстанавливает сохранённый язык на старте. Кэша нет (первый запуск) —
 * берётся язык системного окружения (main отдаёт уже сведённый код каталога).
 * Сбой чтения, пустое значение или неизвестный код (язык убрали из сборки) —
 * исходный русский: клиент не должен остаться без текстов из-за одной строки
 * настроек.
 */
export async function initLang(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await etn.meta.get(CLIENT_META_KEY.LANG);
  } catch {
    raw = null;
  }
  const stored = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  if (stored !== null) {
    applyLang(stored);
    return;
  }
  // Кэша нет — первый запуск: язык ОС как стартовое отображение. Детект не
  // персистится (ADR daab6ac4, §5 «Семантика client_meta.lang»).
  let detected: string | null = null;
  try {
    detected = await etn.system.preferredLanguage();
  } catch {
    detected = null;
  }
  applyLang(detected ?? DEFAULT_LANG);
}

/**
 * Сохраняет выбор языка в L5 `client_meta.lang` (fire-and-forget): интерфейс
 * переключается сразу, сбой записи означает лишь, что выбор не запомнится.
 */
export function persistLang(lang: string): void {
  void etn.meta.set(CLIENT_META_KEY.LANG, lang).catch(() => undefined);
}
