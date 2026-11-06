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
 * Применяет язык к интерфейсу и документу. Каталог выбирается по правилу ADR
 * daab6ac4 §2 («точный тег → основной подтег → исходный `ru`»): для `en-US`
 * берётся `en`, для `zh-Hans` — `zh`; недоступный целиком язык деградирует на
 * `ru`. Интерфейс не остаётся на смеси языков, `document.lang` указывает на
 * реально показанный язык.
 *
 * Возвращает `true`, когда каталог найден (точный или по основному подтегу);
 * `false` — запрошенный язык недоступен и показан исходный `ru`.
 */
export function applyLang(lang: string): boolean {
  const direct = hasLocale(lang);
  const primary = lang.split('-')[0] ?? '';
  const resolved = direct ? lang : hasLocale(primary) ? primary : DEFAULT_LANG;
  // Деградация — только когда не нашёлся ни точный каталог, ни основной подтег.
  const degraded = !direct && resolved === DEFAULT_LANG && lang !== DEFAULT_LANG;
  unavailable = degraded ? lang : null;
  if (degraded) logUiEvent('ui.i18n.locale_unavailable', { lang });
  if (!setLang(resolved)) return false;
  document.documentElement.lang = resolved;
  return !degraded;
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
