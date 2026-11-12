/**
 * Цвет фона главного окна до первого кадра (L5 `client_meta`; задача 0e4a52cd,
 * замечание проверки 2026-11-12).
 *
 * Тема и режим применяются в renderer, а окно красится в main ещё ДО загрузки
 * страницы — иначе первый кадр мигает чужим цветом (требование b8719e86).
 * Renderer пишет `--bg` применённой темы в `client_meta.ui_window_bg` при каждом
 * применении, и это значение переживает перезапуск.
 *
 * Модуль намеренно не тянет Electron: правило выбора цвета — чистая функция от
 * метаданных установки, поэтому покрыто юнит-тестом (`window-background.test.ts`)
 * по образцу `window-bounds.ts`.
 */

import { CLIENT_META_KEY } from '@etn/shared';

/** `--bg` светлого режима темы `current` (`themes/current.css`). */
export const CURRENT_LIGHT_BG = '#eef0f4';

/** `--bg` тёмного режима темы `current`. */
export const CURRENT_DARK_BG = '#0e1116';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Цвет фона окна по метаданным установки.
 *
 * 1. `client_meta.ui_window_bg` — точный `--bg` последней применённой темы.
 * 2. Кэша нет (первый запуск после обновления) — исторический
 *    `client_meta.theme` хранил РЕЖИМ (`dark`/`light`) и мигрирует в `ui_mode`:
 *    `dark` → фон тёмного `current`, иначе — фон светлого `current`.
 *
 * Константы палитры дублируют `--bg` темы `current` осознанно: main не может
 * прочитать CSS до загрузки renderer, а белая вспышка у тёмного пользователя
 * заметнее двух значений (ADR de24adef).
 */
export function resolveWindowBackground(getMeta: (key: string) => string | null): string {
  const cached = getMeta(CLIENT_META_KEY.UI_WINDOW_BG);
  if (typeof cached === 'string' && HEX_COLOR.test(cached)) return cached;
  const legacyMode = getMeta(CLIENT_META_KEY.THEME);
  return legacyMode === 'dark' ? CURRENT_DARK_BG : CURRENT_LIGHT_BG;
}
