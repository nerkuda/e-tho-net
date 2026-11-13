/**
 * Подложка холста карты из пользовательской картинки (0.16.1, задача 80324150;
 * элемент ef8112b0, требование e6d586d3, сценарий 3fe62610).
 *
 * Слои канвы снизу вверх:
 *   1. картинка пользователя — `cover`, привязана к окну (`background-attachment:
 *      fixed`): панорамирование и зум карты её не двигают;
 *   2. тинт — полупрозрачный слой цвета фона темы (в основе) либо цвета фона
 *      слоя с повышенной прозрачностью (в слое); плотность тинта растёт с
 *      расхождением светлоты картинки и фона (метаданные `avg_luminance`);
 *   3. контент (облачка, связи, полоса фокуса) — поверх.
 *
 * Сетка: в состоянии «картинка есть» её в фоне НЕТ (radial-gradient входит в
 * базовый `.canvas`, поэтому включается отдельным правилом по атрибуту корня
 * {@link WALLPAPER_ATTR}). Без картинки — действующее поведение: `--layer-bg`
 * (или `--bg`) и точечная сетка.
 *
 * Тинт на другие экраны НЕ размножается: правило привязано только к `.canvas`
 * (этап 1; размножение — этап 2 после визуального среза заказчика).
 */

import type { WallpaperState } from '../../main/ipc/contract.js';
import {
  parseCssColor,
  relativeLuminance,
  wallpaperTintAlpha,
  wallpaperTintColor,
} from '../lib/wallpaper-image.js';
import {
  getWallpaperState,
  refreshWallpaper,
  subscribeWallpaper,
  syncWallpaperNetwork,
} from '../lib/wallpaper-state.js';
import { store } from '../state.js';

/** Атрибут корня документа, включающий подложку на холсте карты. */
export const WALLPAPER_ATTR = 'data-canvas-wallpaper';

/** CSS-переменная с `url(...)` картинки. */
export const WALLPAPER_IMAGE_VAR = '--canvas-wallpaper-image';

/** CSS-переменная с `rgba(...)` тинта. */
export const WALLPAPER_TINT_VAR = '--canvas-wallpaper-tint';

/**
 * Минимальная поверхность корня, которой пользуется применение подложки. В
 * браузере это `document.documentElement`; в тестах — простая заглушка (в
 * проекте нет jsdom).
 */
export interface WallpaperRootTarget {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Эффективный цвет фона холста: слой («повышенная прозрачность») или тема. */
export interface WallpaperBase {
  /** Цвет фона в `#rrggbb`/`rgb()` или `null`, если токен не прочитан. */
  color: string | null;
  /** Активен слой с собственными цветами — тинт прозрачнее. */
  in_layer: boolean;
}

/**
 * Применить состояние картинки к корню документа: переменные подложки и
 * атрибут сетки. `none` — снять всё, холст вернётся к цвету и сетке.
 */
export function applyWallpaperState(
  root: WallpaperRootTarget,
  state: WallpaperState,
  base: WallpaperBase,
): void {
  if (state.status !== 'ok') {
    root.style.removeProperty(WALLPAPER_IMAGE_VAR);
    root.style.removeProperty(WALLPAPER_TINT_VAR);
    root.removeAttribute(WALLPAPER_ATTR);
    return;
  }
  root.style.setProperty(WALLPAPER_IMAGE_VAR, `url("${state.data_url}")`);
  const rgb = base.color === null ? null : parseCssColor(base.color);
  if (rgb === null) {
    // Цвет токена не распознан — показываем картинку без вуали, но сетку всё
    // равно скрываем: картинка есть.
    root.style.removeProperty(WALLPAPER_TINT_VAR);
  } else {
    const imageLuminance = state.meta.avg_luminance;
    const baseLuminance = relativeLuminance(rgb[0], rgb[1], rgb[2]);
    root.style.setProperty(
      WALLPAPER_TINT_VAR,
      wallpaperTintColor(rgb, wallpaperTintAlpha(imageLuminance, baseLuminance, base.in_layer)),
    );
  }
  root.setAttribute(WALLPAPER_ATTR, 'on');
}

/**
 * Прочитать эффективный фон холста из CSS-переменных корня: `--layer-bg`
 * (слой с собственными цветами, 0.6.4 §2.2a) либо `--bg` темы. `read` —
 * чтение кастом-свойства (`getComputedStyle(root).getPropertyValue`).
 */
export function readWallpaperBase(read: (name: string) => string): WallpaperBase {
  const layerBg = read('--layer-bg').trim();
  if (layerBg !== '') return { color: layerBg, in_layer: true };
  const themeBg = read('--bg').trim();
  return { color: themeBg === '' ? null : themeBg, in_layer: false };
}

/** Подписки модуля — снимаются только полным сбросом состояния приложения. */
let wired = false;

/** Подпись последнего применённого состояния — пропуск пустых записей CSS. */
let lastAppliedKey = '';

/**
 * Пересчитать подложку по текущему состоянию картинки, теме и слою. Дешёвая
 * проверка подписи: store меняется на каждое действие пользователя, а
 * переменные подложки зависят только от картинки (её хеша) и фона темы/слоя.
 */
export function refreshWallpaperBackdrop(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const styles = typeof getComputedStyle === 'function' ? getComputedStyle(root) : null;
  const base = readWallpaperBase((name) => (styles === null ? '' : styles.getPropertyValue(name)));
  const state = getWallpaperState();
  const key =
    state.status === 'ok'
      ? `ok|${state.content_hash}|${base.color ?? ''}|${String(base.in_layer)}`
      : 'none';
  if (key === lastAppliedKey) return;
  lastAppliedKey = key;
  applyWallpaperState(root, state, base);
}

/**
 * Подключить подложку к жизни приложения: состояние картинки меняется при
 * загрузке/удалении/перечитывании, тема и слой — через store. Первый вызов
 * сразу читает картинку у главного процесса: офлайн-старт получает кэш
 * (сценарий 0ec86f0b).
 *
 * Смена активной сети — смена картинки (задача 5db41abf): store-подписка
 * сбрасывает состояние прежней сети и читает картинку новой (в том числе
 * после восстановления сессии на старте), затем пересчитывает подложку.
 */
export function initWallpaperBackdrop(): void {
  if (wired) return;
  wired = true;
  subscribeWallpaper(() => refreshWallpaperBackdrop());
  store.subscribe(() => {
    syncWallpaperNetwork();
    refreshWallpaperBackdrop();
  });
  refreshWallpaperBackdrop();
  void refreshWallpaper();
}

/** Сбросить признак подключения (тесты и повторная инициализация). */
export function resetWallpaperBackdrop(): void {
  wired = false;
  lastAppliedKey = '';
}
