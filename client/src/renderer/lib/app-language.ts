/**
 * «Язык приложения» из профиля пользователя на сервере (ADR daab6ac4 §2–3,
 * задачи f99f0542 «серверная часть», faba9ff4 «синхронизация и миграция»,
 * 222666db «UI наследования»).
 *
 * **Модель.** Эффективный язык пары «пользователь × сеть» резолвит сервер:
 * `пользователь → сеть → сервер` (ADR §2). Клиент цепочку не собирает — он
 * получает готовую пару `{ language, source }` из REST
 * (`GET /users/me/language-settings`) и из кадров сокета (`ready`,
 * `settings.language`). `client_meta.lang` — только кэш последнего известного
 * эффективного языка для офлайн-старта; при доступном сервере серверное
 * значение побеждает и перезаписывает кэш (ADR §5).
 *
 * **Старт.** `lib/lang.ts::initLang` применяет кэш → язык ОС → `ru`. После
 * успешного входа `restoreSession` зовёт {@link initAppLanguage}: серверное
 * значение (профиль или эффективный язык активной сети) применяется и
 * кэшируется. Офлайн остаётся кэш.
 *
 * **Миграция.** При первом входе после обновления (маркер
 * `client_meta.lang_migrated` не стоит) значение кэша один раз переносится в
 * профиль, если там ещё не задано; после этого `null` в профиле — осознанное
 * наследование и не перезаписывается. Сбой записи не ставит маркер: попытка
 * повторится при следующем входе.
 *
 * **Старый сервер (0.15.1).** Маршрута `/users/me/language-settings` нет —
 * `NOT_FOUND` означает «серверной настройки нет»: `support = 'unsupported'`,
 * клиент живёт по кэшу/ОС, настройки показывают локальный выбор с пояснением
 * (решение задачи faba9ff4 п. 5).
 *
 * Модуль не знает про DOM диалога; UI читает снимок
 * {@link getAppLanguageState} и зовёт {@link changeAppLanguage}.
 */

import {
  CLIENT_META_KEY,
  USER_SETTING_KEY,
  type EffectiveLanguage,
  type LanguageSource,
  type NetworkLanguageSettings,
  type UserLanguageSettings,
} from '@etn/shared';

import { store } from '../state.js';
import { etn } from './etn.js';
import { applyLang, persistLang } from './lang.js';

/** Доступность серверной настройки языка. */
export type LanguageApiSupport = 'unknown' | 'supported' | 'unsupported';

/** Снимок серверного слоя языка для UI. */
export interface AppLanguageState {
  /** Есть ли на сервере контракт языка (старый сервер — `unsupported`). */
  support: LanguageApiSupport;
  /** Хранимое значение профиля: `null` — «использовать язык сетей». */
  language: string | null;
  /** Эффективный язык активной сети из последнего ответа сервера/кадра WS. */
  effective: EffectiveLanguage | null;
}

/** Текущий снимок (объект пересоздаётся при изменении — для чтения UI). */
let state: AppLanguageState = { support: 'unknown', language: null, effective: null };

/** Последний применённый к интерфейсу эффективный язык (для кэша). */
let cachedLanguage: string | null | undefined;

/** Кэш серверных настроек по сетям — нужен для переключения активной сети. */
let networks: NetworkLanguageSettings[] = [];

/** Текущий снимок серверного слоя языка. */
export function getAppLanguageState(): AppLanguageState {
  return state;
}

/** Флаг «серверная настройка языка доступна» — для UI админских/сетевых полей. */
export function isLanguageApiSupported(): boolean {
  return state.support === 'supported';
}

/**
 * Код канонической ошибки (`EtnError.code`) или `null`. Renderer получает
 * восстановленный `EtnError` из `lib/etn.ts`, поэтому `code` доступен.
 */
function errorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Старый сервер не знает маршрута языка: `NOT_FOUND` (и эквивалентный
 * `METHOD_NOT_ALLOWED` на прокси) — это отсутствие функциональности, а не
 * сбой. Остальные ошибки (сеть, 500) оставляют состояние неизвестным.
 */
export function isLanguageApiUnsupported(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'NOT_FOUND' || code === 'METHOD_NOT_ALLOWED';
}

/** Прочитать кэш `client_meta.lang` (`null` — кэша нет). */
async function readCache(): Promise<string | null> {
  try {
    const raw = await etn.meta.get(CLIENT_META_KEY.LANG);
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  } catch {
    return null;
  }
}

/** Записать кэш эффективного языка (только при изменении). */
async function cacheLanguage(language: string): Promise<void> {
  if (cachedLanguage === undefined) cachedLanguage = await readCache();
  if (cachedLanguage === language) return;
  cachedLanguage = language;
  persistLang(language);
}

/** Применить эффективный язык и обновить кэш (ADR §5). */
function applyEffective(language: EffectiveLanguage): void {
  state = { ...state, effective: language };
  applyLang(language.language);
  void cacheLanguage(language.language);
}

/** Найти сеть в последнем серверном ответе. */
function networkEntry(networkId: string | null): NetworkLanguageSettings | null {
  if (networkId === null) return null;
  return networks.find((entry) => entry.network_id === networkId) ?? null;
}

/** Записать маркер выполненной миграции. */
async function markMigrated(): Promise<void> {
  try {
    await etn.meta.set(CLIENT_META_KEY.LANG_MIGRATED, 'true');
  } catch {
    // Кэш миграции — локальная книга учёта: сбой записи повторит проверку.
  }
}

/**
 * Разовая миграция «кэш → профиль» (ADR §5, задача faba9ff4 п. 4).
 * Профиль уже задан — осознанный выбор пользователя побеждает, кэш будет
 * перезаписан серверным значением. Профиль `null` и кэш есть — переносим
 * значение; `null` после миграции больше не трогаем.
 */
async function migrateCacheToProfile(): Promise<void> {
  let migrated = false;
  try {
    migrated = (await etn.meta.get(CLIENT_META_KEY.LANG_MIGRATED)) === 'true';
  } catch {
    migrated = false;
  }
  if (migrated) return;

  const cache = await readCache();
  if (state.language === null && cache !== null) {
    try {
      await etn.me.setSetting(USER_SETTING_KEY.APP_LANGUAGE, cache);
    } catch {
      // Сервер недоступен/отказал — маркер не ставим: перенос повторится.
      return;
    }
    state = { ...state, language: cache };
    // Явный язык пользователя перекрывает все сети — эффективный язык = кэш.
    networks = networks.map((entry) => ({
      ...entry,
      language: cache,
      source: 'user' as LanguageSource,
    }));
    if (cachedLanguage === undefined) cachedLanguage = cache;
  }
  await markMigrated();
}

/**
 * Прочитать настройки языка с сервера и применить их. `targetNetworkId` —
 * сеть, для которой нужен эффективный язык (`null` — сети ещё нет: применяется
 * только явный язык профиля). Возвращает `false`, когда сервер недоступен или
 * контракт отсутствует.
 */
async function refreshFromServer(targetNetworkId: string | null): Promise<boolean> {
  let settings: UserLanguageSettings;
  try {
    settings = await etn.me.getLanguageSettings();
  } catch (err) {
    if (isLanguageApiUnsupported(err)) {
      state = { ...state, support: 'unsupported' };
    }
    return false;
  }
  state = {
    support: 'supported',
    language: settings.language ?? null,
    effective: state.effective,
  };
  networks = Array.isArray(settings.networks) ? settings.networks : [];
  await migrateCacheToProfile();

  const activeNetworkId = targetNetworkId ?? store.state.networkId;
  // Ответ мог устареть, пока шла миграция/применение: сеть уже другая.
  if (targetNetworkId !== null && activeNetworkId !== store.state.networkId) {
    return true;
  }
  if (state.language !== null) {
    applyEffective({ language: state.language, source: 'user' });
  } else {
    const entry = networkEntry(activeNetworkId);
    if (entry !== null) applyEffective({ language: entry.language, source: entry.source });
  }
  return true;
}

/**
 * Синхронизация при входе (`restoreSession`): получить серверное значение,
 * выполнить миграцию кэша и применить язык. Офлайн/старый сервер — не ошибка:
 * интерфейс остаётся на кэше/ОС, состояние помечается для UI.
 */
export async function initAppLanguage(): Promise<void> {
  cachedLanguage = await readCache();
  await refreshFromServer(null);
}

/**
 * Пересчёт эффективного языка при смене активной сети (задача 222666db п. 4):
 * у сети свой `language`, поэтому при переходе язык может измениться без
 * перезапуска. Сеть, переставшая быть активной, ответ не применяет.
 */
export async function syncLanguageForNetwork(networkId: string): Promise<void> {
  await refreshFromServer(networkId);
}

/**
 * Перечитать настройки и применить эффективный язык активной сети — после
 * смены языка сети владельцем (PATCH ответил успехом), чтобы не зависеть от
 * порядка WS-кадра.
 */
export async function refreshEffectiveLanguage(): Promise<void> {
  await refreshFromServer(store.state.networkId);
}

/**
 * Применить кадр языка сокета (`ready`/`settings.language`, задача faba9ff4
 * п. 3). Кадр чужой сети (не активной) только обновляет кэш настроек — UI
 * переключится при переходе на неё.
 */
export function applyServerLanguageFrame(payload: {
  networkId: string;
  language: string;
  source: LanguageSource;
}): void {
  const { networkId, language, source } = payload;
  if (typeof language !== 'string' || language.trim() === '') return;
  if (source !== 'user' && source !== 'network' && source !== 'server') return;
  networks = networks.map((entry) =>
    entry.network_id === networkId
      ? { ...entry, language, source }
      : entry,
  );
  if (networkId !== store.state.networkId) return;
  applyEffective({ language, source });
}

/**
 * Сменить «язык приложения» пользователя (задача 222666db п. 1):
 * `null` — «использовать язык сетей», иначе конкретный тег. Сохранение в
 * профиль и живое применение; офлайн — локальное применение кэша и
 * возвращение `false` (UI сообщает «синхронизация отложена»).
 */
export async function changeAppLanguage(language: string | null): Promise<boolean> {
  const next = typeof language === 'string' && language.trim() !== '' ? language.trim() : null;
  if (state.support === 'unsupported') {
    // Старый сервер: настройка локальная, как до 0.15.2.
    if (next !== null) {
      applyLang(next);
      void cacheLanguage(next);
    }
    return false;
  }
  try {
    await etn.me.setSetting(USER_SETTING_KEY.APP_LANGUAGE, next);
    state = { ...state, language: next };
    // Для «наследовать» нужен серверный резолвинг активной сети; для явного
    // языка он всё равно подтвердит канонический тег и обновит сети.
    const synced = await refreshFromServer(store.state.networkId);
    if (!synced && next !== null) {
      applyLang(next);
      void cacheLanguage(next);
    }
    return synced;
  } catch (err) {
    if (isLanguageApiUnsupported(err)) {
      state = { ...state, support: 'unsupported' };
    }
    if (next !== null) {
      // Сценарий faba9ff4/«Смена языка»: сервер недоступен при сохранении —
      // выбор применяется локально как кэш, синхронизация отложена.
      applyLang(next);
      void cacheLanguage(next);
    }
    return false;
  }
}

/** Сброс серверного слоя при отключении от сервера (кэш остаётся). */
export function resetAppLanguageState(): void {
  state = { support: 'unknown', language: null, effective: null };
  networks = [];
  cachedLanguage = undefined;
}

/** Внутренности для юнит-тестов. */
export const appLanguageInternals = {
  reset(): void {
    resetAppLanguageState();
  },
  /** Подменить снимок серверного слоя (тесты UI без REST). */
  setState(next: Partial<AppLanguageState>): void {
    state = { ...state, ...next };
  },
  /** Подменить кэш настроек по сетям (тесты переключения сети без REST). */
  setNetworkSettings(entries: NetworkLanguageSettings[]): void {
    networks = entries;
  },
};
