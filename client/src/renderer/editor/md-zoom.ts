/**
 * Масштаб markdown-полей (M9): Ctrl+колесо масштабирует ВСЕ редакторы и
 * просмотрщики markdown через глобальную CSS-переменную `--md-font-size`,
 * независимо от масштаба холста и структур. Значение хранится в L4
 * `md_zoom` на сеть (11-settings-and-state.md §2.1).
 */

import { UI_STATE_KEY } from '@etn/shared';

/** Базовый размер шрифта полей (px). */
export const MD_BASE_FONT_PX = 13;
export const MD_ZOOM_MIN = 0.5;
export const MD_ZOOM_MAX = 2.5;
/** Шаг изменения на одно «щёлк-значение» колеса (≈10%). */
export const MD_ZOOM_STEP = 1.1;

/** Парсит сохранённое значение масштаба; невалидное → 1. */
export function parseMdZoom(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return clampMdZoom(value);
}

/** Ограничивает масштаб диапазоном {@link MD_ZOOM_MIN}…{@link MD_ZOOM_MAX}. */
export function clampMdZoom(zoom: number): number {
  return Math.min(MD_ZOOM_MAX, Math.max(MD_ZOOM_MIN, zoom));
}

/** Новый масштаб по направлению колеса (deltaY < 0 — увеличение). */
export function zoomByWheel(zoom: number, deltaY: number): number {
  return clampMdZoom(deltaY < 0 ? zoom * MD_ZOOM_STEP : zoom / MD_ZOOM_STEP);
}

/** Применяет масштаб к глобальной переменной (все поля сразу). */
export function applyMdZoom(zoom: number): void {
  const clamped = clampMdZoom(zoom);
  document.documentElement.style.setProperty(
    '--md-font-size',
    `${Math.round(MD_BASE_FONT_PX * clamped)}px`,
  );
}

/** Таймер debounce-сохранения. */
let persistTimer: number | null = null;

/**
 * Отложенное сохранение масштаба в L4-состояние сети. Импорт `etn` ленивый,
 * чтобы чистые функции модуля работали в node-тестах без DOM-шима.
 */
export function persistMdZoom(networkId: string, zoom: number): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void import('../lib/etn.js')
      .then(({ etn }) =>
        etn.ui.setState(networkId, UI_STATE_KEY.MD_ZOOM, String(clampMdZoom(zoom))),
      )
      .catch(() => undefined);
  }, 400);
}

/** Флаг однократной загрузки сохранённого масштаба при старте. */
let loaded = false;

/** Загружает сохранённый масштаб сети и применяет его (один раз за сессию). */
export async function loadMdZoom(networkId: string): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const { etn } = await import('../lib/etn.js');
    const raw = await etn.ui.getState(networkId, UI_STATE_KEY.MD_ZOOM);
    applyMdZoom(parseMdZoom(raw));
  } catch {
    applyMdZoom(1);
  }
}

/** Текущий масштаб (переменная живёт на documentElement; парсим обратно). */
export function currentMdZoom(): number {
  const raw = document.documentElement.style.getPropertyValue('--md-font-size');
  const m = /^(\d+(?:\.\d+)?)px$/.exec(raw.trim());
  if (m === null) return 1;
  return clampMdZoom(Number(m[1]) / MD_BASE_FONT_PX);
}
