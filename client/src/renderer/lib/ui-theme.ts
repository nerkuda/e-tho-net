/**
 * Серверный слой выбора темы и режима интерфейса (L3s; требование 219d030c,
 * задача 0e4a52cd).
 *
 * **Модель.** Выбор живёт в `user_settings` уровня «пользователь × сервер»:
 * ключи `ui_theme` (имя темы) и `ui_mode` (`dark | light`). Действует на всех
 * клиентах пользователя на этом сервере; локальный `client_meta` — только кэш
 * для офлайн-старта (образец — «язык приложения», `lib/app-language.ts`).
 *
 * **Старт.** Кэш применяет `lib/theme.ts::initTheme` ДО первого экрана. После
 * успешного входа `restoreSession` зовёт {@link initUiTheme}: если кэш
 * принадлежит ДРУГОМУ пользователю, до ответа сервера действует дефолт
 * `current` + тёмный (ревизия требования, итерация 2); серверные значения
 * побеждают и перезаписывают кэш вместе с id пользователя.
 *
 * **Деградации.**
 * - Сервер не знает контракта настроек (`NOT_FOUND`/`METHOD_NOT_ALLOWED`):
 *   `support = 'unsupported'`, выбор применяется локально, в настройках —
 *   пояснение; повтор синхронизации не выполняется.
 * - Сервер недоступен или отверг запись (`422` на неизвестное значение):
 *   выбор уже применён локально, ставится маркер `ui_theme_pending`,
 *   синхронизация повторяется при следующем входе.
 * - Значение темы на сервере неизвестно ЭТОЙ сборке (сервер новее): применение
 *   деградирует к `current`, серверное значение НЕ затирается, настройки
 *   показывают фактическое применение (`state.unknownTheme`).
 *
 * **Миграция.** Старый `client_meta.theme` хранил РЕЖИМ (`light`/`dark`), а не
 * имя темы: при первом входе после обновления (маркер `theme_migrated` не
 * стоит) значение один раз переносится на сервер как `ui_mode` — при успехе
 * ставится маркер, при сбое перенос повторится. `ui_theme` старый клиент не
 * знал, поэтому миграция его не пишет: тема остаётся серверной/дефолтной.
 */

import { CLIENT_META_KEY, USER_SETTING_KEY } from '@etn/shared';

import { store } from '../state.js';
import { etn } from './etn.js';
import {
  applyUiTheme,
  DEFAULT_UI_MODE,
  DEFAULT_UI_THEME,
  FOREIGN_UI_DEFAULT,
  isUiTheme,
  parseUiMode,
  parseUiTheme,
  persistUiThemeCache,
  readUiThemeCache,
  type UiTheme,
  type UiThemeCache,
  type UiThemeChoice,
} from './theme.js';

/** Доступность серверного хранения выбора темы/режима. */
export type UiThemeApiSupport = 'unknown' | 'supported' | 'unsupported';

/** Снимок серверного слоя темы для UI настроек. */
export interface UiThemeState {
  /** Есть ли на сервере контракт настроек (`unsupported` — старый сервер). */
  support: UiThemeApiSupport;
  /** Сырое значение `ui_theme` с сервера (может быть неизвестным сборке). */
  serverTheme: string | null;
  /** Сырое значение `ui_mode` с сервера. */
  serverMode: string | null;
  /** Значение темы сервера, неизвестное этой сборке (применён `current`). */
  unknownTheme: string | null;
  /** Локальный выбор ещё не дошёл до сервера (маркер `ui_theme_pending`). */
  syncDeferred: boolean;
}

const INITIAL_STATE: UiThemeState = {
  support: 'unknown',
  serverTheme: null,
  serverMode: null,
  unknownTheme: null,
  syncDeferred: false,
};

let state: UiThemeState = { ...INITIAL_STATE };

/** Текущий снимок (для настроек). */
export function getUiThemeState(): UiThemeState {
  return state;
}

/** Флаг «сервер хранит выбор темы/режима в профиле». */
export function isUiThemeApiSupported(): boolean {
  return state.support === 'supported';
}

/** Код канонической ошибки (`EtnError.code`) или `null`. */
function errorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** Старый сервер не знает маршрута настроек: отсутствие функциональности. */
export function isUiThemeApiUnsupported(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'NOT_FOUND' || code === 'METHOD_NOT_ALLOWED';
}

/** Строковое значение настройки сервера (пустая строка/не строка — `null`). */
function settingString(settings: Record<string, unknown>, key: string): string | null {
  const value = settings[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Записать серверную настройку; `true` — сервер принял значение. */
async function writeSetting(key: string, value: string): Promise<boolean> {
  try {
    await etn.me.setSetting(key, value);
    return true;
  } catch (err) {
    if (isUiThemeApiUnsupported(err)) state = { ...state, support: 'unsupported' };
    return false;
  }
}

/** Выставить/снять флаг кэша (`theme_migrated`). */
async function setMetaFlag(key: string, value: boolean): Promise<void> {
  try {
    await etn.meta.set(key, value ? 'true' : '');
  } catch {
    // Локальная книга учёта: сбой записи повторит проверку.
  }
}

/** Прочитать флаг кэша (`'true'` — выставлен). */
async function readMetaFlag(key: string): Promise<boolean> {
  try {
    return (await etn.meta.get(key)) === 'true';
  } catch {
    return false;
  }
}

/**
 * Часть выбора, ожидающая записи на сервер. Маркер
 * `client_meta.ui_theme_pending` хранит ИМЕННО состав («theme», «mode» или
 * оба), а не общий флаг: иначе повтор после сбоя миграции режима записал бы на
 * сервер дефолтную тему, которую пользователь не выбирал.
 */
type PendingPart = 'theme' | 'mode';

/** Части выбора, ещё не дошедшие до сервера (зеркало маркера в памяти). */
let pendingParts = new Set<PendingPart>();

/** Прочитать маркер отложенной синхронизации. */
async function readPendingParts(): Promise<Set<PendingPart>> {
  try {
    const raw = await etn.meta.get(CLIENT_META_KEY.UI_THEME_PENDING);
    const parts = typeof raw === 'string' ? raw.split(',') : [];
    const result = new Set<PendingPart>();
    for (const part of parts) {
      const name = part.trim();
      if (name === 'theme' || name === 'mode') result.add(name);
    }
    return result;
  } catch {
    return new Set();
  }
}

/** Записать маркер отложенной синхронизации (пустой состав — снять маркер). */
async function writePendingParts(): Promise<void> {
  const value = [...pendingParts].sort().join(',');
  try {
    await etn.meta.set(CLIENT_META_KEY.UI_THEME_PENDING, value);
  } catch {
    // Локальная книга учёта: сбой записи повторит проверку при входе.
  }
  state = { ...state, syncDeferred: pendingParts.size > 0 };
}

/** Запомнить выбор установки (значения + владелец) без ожидания записи. */
function cacheChoice(choice: UiThemeChoice, owner: string | null): void {
  const cache: UiThemeCache = { theme: choice.theme, mode: choice.mode, owner };
  void persistUiThemeCache(cache);
}

/**
 * Синхронизация при входе: владелец кэша, серверные значения, миграция старого
 * режима и отложенная запись. Офлайн/старый сервер не ошибка — интерфейс
 * остаётся на кэше, состояние помечается для настроек.
 */
export async function initUiTheme(userId: string | null): Promise<void> {
  const cache = await readUiThemeCache();
  // Кэш чужого пользователя не применяется: до ответа сервера — дефолт.
  const ownerChanged =
    cache !== null && userId !== null && cache.owner !== null && cache.owner !== userId;
  if (ownerChanged) applyUiTheme(FOREIGN_UI_DEFAULT);

  let settings: Record<string, unknown>;
  try {
    settings = await etn.me.getSettings();
  } catch (err) {
    if (isUiThemeApiUnsupported(err)) {
      state = { ...state, support: 'unsupported' };
    }
    return;
  }

  const serverThemeRaw = settingString(settings, USER_SETTING_KEY.UI_THEME);
  const serverModeRaw = settingString(settings, USER_SETTING_KEY.UI_MODE);
  pendingParts = await readPendingParts();
  const migrated = await readMetaFlag(CLIENT_META_KEY.UI_THEME_MIGRATED);
  let serverTheme = serverThemeRaw;
  let serverMode = serverModeRaw;

  // Разовая миграция старого режима и повтор отложенной записи. Оба случая —
  // «локальный выбор ещё не на сервере», поэтому пишем только ОТСУТСТВУЮЩИЕ
  // ключи: осознанный серверный выбор пользователя не перезаписываем.
  if (!ownerChanged && cache !== null) {
    // Режим переносится один раз (`!migrated`) либо повторяется после сбоя;
    // тема — only если её запись действительно не удалась ранее.
    const wantsMode = serverMode === null && (pendingParts.has('mode') || !migrated);
    const wantsTheme = serverTheme === null && pendingParts.has('theme');
    if (wantsMode) {
      if (await writeSetting(USER_SETTING_KEY.UI_MODE, cache.mode)) {
        serverMode = cache.mode;
        pendingParts.delete('mode');
      } else {
        pendingParts.add('mode');
      }
    }
    if (wantsTheme) {
      if (await writeSetting(USER_SETTING_KEY.UI_THEME, cache.theme)) {
        serverTheme = cache.theme;
        pendingParts.delete('theme');
      } else {
        pendingParts.add('theme');
      }
    }
  }
  // Старый режим перенесён (или сервер уже знал значение) — повтор не нужен.
  if (!ownerChanged && !migrated && serverMode !== null) {
    await setMetaFlag(CLIENT_META_KEY.UI_THEME_MIGRATED, true);
  }
  // Части, чьё значение сервер уже знает, повторять не нужно (сервер новее
  // локального выбора): маркер сужается, а не переносится вечно.
  if (!ownerChanged && serverTheme !== null) pendingParts.delete('theme');
  if (!ownerChanged && serverMode !== null) pendingParts.delete('mode');
  // Локальный выбор, не дошедший до сервера, повторяется при следующем входе.
  if (!ownerChanged) await writePendingParts();

  state = {
    support: 'supported',
    serverTheme,
    serverMode,
    unknownTheme: serverTheme !== null && !isUiTheme(serverTheme) ? serverTheme : null,
    syncDeferred: pendingParts.size > 0,
  };

  // Серверные значения побеждают; неизвестная сборке тема → `current` без
  // затирания серверного значения.
  const appliedTheme: UiTheme =
    serverTheme === null
      ? ownerChanged
        ? FOREIGN_UI_DEFAULT.theme
        : (cache?.theme ?? DEFAULT_UI_THEME)
      : parseUiTheme(serverTheme);
  const appliedMode =
    serverMode === null
      ? ownerChanged
        ? FOREIGN_UI_DEFAULT.mode
        : (cache?.mode ?? DEFAULT_UI_MODE)
      : parseUiMode(serverMode);

  applyUiTheme({ theme: appliedTheme, mode: appliedMode });
  await persistUiThemeCache({ theme: appliedTheme, mode: appliedMode, owner: userId });
}

/**
 * Сменить тему интерфейса (сценарий 580f8d10): применить СРАЗУ, записать кэш,
 * затем сохранить в профиль. Возвращает `false`, когда синхронизация отложена
 * (офлайн, старый сервер, 422) — UI показывает строку ошибки.
 */
export async function changeUiTheme(theme: UiTheme): Promise<boolean> {
  const choice: UiThemeChoice = { theme, mode: store.state.theme };
  applyUiTheme(choice);
  const owner = store.state.me?.id ?? null;
  cacheChoice(choice, owner);
  if (state.support === 'unsupported') {
    pendingParts.add('theme');
    await writePendingParts();
    return false;
  }
  if (await writeSetting(USER_SETTING_KEY.UI_THEME, theme)) {
    state = { ...state, serverTheme: theme, unknownTheme: null };
    pendingParts.delete('theme');
    await writePendingParts();
    return true;
  }
  pendingParts.add('theme');
  await writePendingParts();
  return false;
}

/**
 * Сменить режим интерфейса (сценарий b1131d65): живое применение и сохранение
 * в профиль по тому же контракту, что и тема.
 */
export async function changeUiMode(mode: 'light' | 'dark'): Promise<boolean> {
  const choice: UiThemeChoice = { theme: store.state.uiTheme, mode };
  applyUiTheme(choice);
  const owner = store.state.me?.id ?? null;
  cacheChoice(choice, owner);
  if (state.support === 'unsupported') {
    pendingParts.add('mode');
    await writePendingParts();
    return false;
  }
  if (await writeSetting(USER_SETTING_KEY.UI_MODE, mode)) {
    state = { ...state, serverMode: mode };
    pendingParts.delete('mode');
    await writePendingParts();
    return true;
  }
  pendingParts.add('mode');
  await writePendingParts();
  return false;
}

/** Сброс серверного слоя при отключении (кэш остаётся установочным). */
export function resetUiThemeState(): void {
  state = { ...INITIAL_STATE };
  pendingParts = new Set();
}

/** Внутренности для юнит-тестов. */
export const uiThemeInternals = {
  reset(): void {
    resetUiThemeState();
  },
  /** Подменить снимок серверного слоя (тесты UI без REST). */
  setState(next: Partial<UiThemeState>): void {
    state = { ...state, ...next };
  },
};
