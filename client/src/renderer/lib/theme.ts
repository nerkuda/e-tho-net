/**
 * Тема и режим интерфейса клиента (L10; ADR de24adef, требование 219d030c,
 * задача 0e4a52cd).
 *
 * **Модель.** «Тема» — набор значений токенов (`lib/ui/themes/<тема>.css`),
 * «режим» — `light | dark`. Активная тема живёт атрибутом `data-theme` на корне
 * документа, режим — `data-mode`; файлы тем объявлены в
 * `lib/ui/register.ts`, смена атрибутов меняет только блок переменных
 * (`color-scheme` следует из него).
 *
 * **Хранение.** Выбор — серверная настройка пользователя (L3s
 * `user_settings.ui_theme`/`ui_mode`, требование 219d030c); клиентский слой
 * синхронизации — `lib/ui-theme.ts`. Здесь — только реестр тем, живое
 * применение и установочный кэш `client_meta` (per installation, как
 * `client_meta.lang`): кэш даёт офлайн-старт без мигания чужими цветами.
 *
 * **Кэш с владельцем.** Вместе со значениями кэш хранит id пользователя
 * сервера (`ui_theme_owner`): кэш другого пользователя не применяется — при
 * входе иного пользователя до ответа сервера действует дефолт
 * `current` + тёмный (ревизия требования от 2026-11-12).
 *
 * **Boot.** {@link initTheme} вызывается в `app.ts` ДО монтажа первого экрана:
 * атрибуты стоят на корне раньше, чем рисуется интерфейс. Фон окна до кадра
 * берёт из кэша `ui_window_bg` главный процесс, а {@link applyUiTheme}
 * обновляет его при каждом применении — `THEME_BG`-константы в main удалены.
 *
 * Модуль не знает про диалог настроек: UI читает снимок стора
 * (`store.state.uiTheme`/`theme`) и зовёт `lib/ui-theme.ts`.
 */

import { CLIENT_META_KEY } from '@etn/shared';

import { store, type Theme, type UiTheme } from '../state.js';
import { etn } from './etn.js';
import { t, type MessageKey } from './i18n.js';

/** Реестр тем сборки — имена совпадают именами файлов `lib/ui/themes/*.css`. */
export type { UiTheme } from '../state.js';

export const THEME_NAMES: readonly UiTheme[] = [
  'current',
  'blue-topaz',
  'catppuccin',
  'nordic',
  'retronotes',
  'wasp',
];

/** Дефолтная тема и режим установки без выбора (как до 0.16.1). */
export const DEFAULT_UI_THEME: UiTheme = 'current';
export const DEFAULT_UI_MODE: Theme = 'light';

/** Выбор темы и режима (пара, применяемая одним действием). */
export interface UiThemeChoice {
  theme: UiTheme;
  mode: Theme;
}

/**
 * Дефолт установки при входе ДРУГОГО пользователя (ревизия требования
 * 219d030c, итерация 2): кэш прошлого владельца не применяется, пока сервер не
 * ответил; пара — `current` + тёмный.
 */
export const FOREIGN_UI_DEFAULT: UiThemeChoice = { theme: 'current', mode: 'dark' };

/** Кэш выбора на установке: значения + владелец (`null` — не записан). */
export interface UiThemeCache extends UiThemeChoice {
  owner: string | null;
}

/** Ключи словаря для подписей тем. */
const THEME_LABEL_KEYS: Record<UiTheme, MessageKey> = {
  current: 'settings.theme.current',
  'blue-topaz': 'settings.theme.blueTopaz',
  catppuccin: 'settings.theme.catppuccin',
  nordic: 'settings.theme.nordic',
  retronotes: 'settings.theme.retronotes',
  wasp: 'settings.theme.wasp',
};

/** Признак имени темы из реестра этой сборки. */
export function isUiTheme(value: unknown): value is UiTheme {
  return typeof value === 'string' && THEME_NAMES.includes(value as UiTheme);
}

/** Разбор имени темы: неизвестное значение (сервер новее сборки) → `current`. */
export function parseUiTheme(value: unknown): UiTheme {
  return isUiTheme(value) ? value : DEFAULT_UI_THEME;
}

/** Разбор режима: всё, кроме `'dark'`, — светлый (как прежний бинарный выбор). */
export function parseUiMode(value: unknown): Theme {
  return value === 'dark' ? 'dark' : 'light';
}

/** Подпись темы для интерфейса (строки — только из словаря). */
export function themeLabel(theme: UiTheme): string {
  return t(THEME_LABEL_KEYS[theme]);
}

/** Варианты «Тема интерфейса» для fieldSelect — порядок реестра. */
export function themeOptions(): Array<{ value: UiTheme; label: string }> {
  return THEME_NAMES.map((theme) => ({ value: theme, label: themeLabel(theme) }));
}

/**
 * Цвет фона применённой темы (`--bg` на `body`) в виде `#rrggbb` — его ставит
 * окну главный процесс. `null` — DOM недоступен (юнит-тесты без документа).
 */
function appliedBackground(): string | null {
  try {
    if (typeof document === 'undefined' || document.body === null) return null;
    const value = getComputedStyle(document.body).backgroundColor;
    const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
    if (match === null) return null;
    return `#${match
      .slice(1, 4)
      .map((channel) => Number(channel).toString(16).padStart(2, '0'))
      .join('')}`;
  } catch {
    return null;
  }
}

/**
 * Сообщить главному процессу фон применённой темы и запомнить его для
 * следующего запуска (ревизия 2026-11-12: `THEME_BG` в main удалены). Сбой
 * записи/канала — только отсутствие синхронизации фона, интерфейс не страдает.
 */
function reportWindowBackground(): void {
  const color = appliedBackground();
  if (color === null) return;
  void etn.meta.set(CLIENT_META_KEY.UI_WINDOW_BG, color).catch(() => undefined);
  try {
    void etn.system.setWindowBackground(color).catch(() => undefined);
  } catch {
    // Мост без метода (старый preload в dev-сборке) — фон обновится по кэшу.
  }
}

/**
 * Живое применение пары «тема + режим»: атрибуты корня, стор, фон окна.
 * Синхронно — вызывающий может применить выбор до монтирования экрана.
 */
export function applyUiTheme(choice: UiThemeChoice): void {
  const root = document.documentElement;
  root.dataset['theme'] = choice.theme;
  root.dataset['mode'] = choice.mode;
  store.update({ theme: choice.mode, uiTheme: choice.theme });
  reportWindowBackground();
}

/** Текущая применённая пара из стора. */
export function currentUiTheme(): UiThemeChoice {
  return { theme: store.state.uiTheme, mode: store.state.theme };
}

/** Прочитать кэш `client_meta` (нет кэша — `null`). */
export async function readUiThemeCache(): Promise<UiThemeCache | null> {
  try {
    const [themeRaw, modeRaw, ownerRaw, legacyRaw] = await Promise.all([
      etn.meta.get(CLIENT_META_KEY.UI_THEME),
      etn.meta.get(CLIENT_META_KEY.UI_MODE),
      etn.meta.get(CLIENT_META_KEY.UI_THEME_OWNER),
      etn.meta.get(CLIENT_META_KEY.THEME),
    ]);
    const hasAny =
      (typeof themeRaw === 'string' && themeRaw.trim() !== '') ||
      (typeof modeRaw === 'string' && modeRaw.trim() !== '') ||
      (typeof legacyRaw === 'string' && legacyRaw.trim() !== '');
    if (!hasAny) return null;
    return {
      theme: parseUiTheme(themeRaw),
      // Старый `client_meta.theme` хранил РЕЖИМ (`light`/`dark`) — до появления
      // пары он остаётся источником режима, пока кэш `ui_mode` не записан.
      mode:
        typeof modeRaw === 'string' && modeRaw.trim() !== ''
          ? parseUiMode(modeRaw.trim())
          : parseUiMode(typeof legacyRaw === 'string' ? legacyRaw.trim() : null),
      owner: typeof ownerRaw === 'string' && ownerRaw.trim() !== '' ? ownerRaw.trim() : null,
    };
  } catch {
    return null;
  }
}

/** Записать кэш выбора и его владельца (последовательно, без гонки значений). */
export async function persistUiThemeCache(cache: UiThemeCache): Promise<void> {
  try {
    await etn.meta.set(CLIENT_META_KEY.UI_THEME, cache.theme);
    await etn.meta.set(CLIENT_META_KEY.UI_MODE, cache.mode);
    await etn.meta.set(CLIENT_META_KEY.UI_THEME_OWNER, cache.owner ?? '');
  } catch {
    // Кэш — книга учёта офлайн-старта: сбой записи повторит следующее применение.
  }
}

/**
 * Восстанавливает выбор на старте ДО монтажа первого экрана: кэш, иначе
 * `current` + светлый. Испорченный/неизвестный кэш не ломает запуск — значение
 * деградирует к дефолту (как неизвестный код языка).
 */
export async function initTheme(): Promise<void> {
  const cached = await readUiThemeCache();
  if (cached === null) {
    applyUiTheme({ theme: DEFAULT_UI_THEME, mode: DEFAULT_UI_MODE });
    return;
  }
  applyUiTheme({ theme: cached.theme, mode: cached.mode });
}
