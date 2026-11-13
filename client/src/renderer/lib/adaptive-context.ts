/**
 * Контекст адаптации пользовательских цветов (0.16.1, требование 26d53c26,
 * задача 6e171b39).
 *
 * **Зачем модуль.** `lib/adaptive-color.ts` — чистый алгоритм: он ничего не
 * знает про DOM и тему. Здесь — единственное место, где из живого интерфейса
 * читается КОНТЕКСТ (тема и режим, `--text`, `--surface`, подложка холста с
 * учётом картинки) и где производные цвета раздаются потребителям
 * (`lib/layer-colors.ts` — полоса и фон слоя, `lib/thought-cloud.ts` — цвета
 * типов и мыслей). Так второй экземпляр «чтения темы» в репозитории не
 * появляется, а алгоритм остаётся тестируемым без браузера.
 *
 * **Ключ кэша.** `scope` = `<тема>|<режим>`: один и тот же пользовательский
 * цвет на разных подложках даёт разные производные, поэтому тема и режим входят
 * в ключ (требование 26d53c26), а сами производные не персистятся.
 *
 * **Исходники не меняются.** Модуль нигде не пишет в стор/БД: он возвращает
 * производные значения, а исходные остаются в `layers.colors` и полях мысли.
 */

import type { WallpaperState } from '../../main/ipc/contract.js';
import type { Theme } from '../state.js';
import {
  FRAME_CONTRAST_MIN,
  TEXT_CONTRAST_MIN,
  adaptiveColor,
  cachedAdaptiveBandColor,
  cachedAdaptiveColor,
  canvasBackdrop,
  clearAdaptiveColorCache,
  contrastRatio,
} from './adaptive-color.js';
import { parseCssColor, relativeLuminance } from './css-color.js';
import { contrastText } from './pure.js';
import { wallpaperTintAlpha, wallpaperTintColor } from './wallpaper-image.js';
import { getWallpaperState } from './wallpaper-state.js';

/** Прочитанные из интерфейса опоры адаптации. */
export interface AdaptiveContext {
  /** `<тема>|<режим>` — ключ кэша производных. */
  scope: string;
  /** `--text` темы: текст, который обязан читаться на поверхностях. */
  text: string;
  /** `--surface`: непрозрачная поверхность облачков, панелей и модалок. */
  surface: string;
  /** Итоговая подложка холста (с картинкой — композит с тинтом). */
  backdrop: string | null;
}

/** Пара цветов слоя в форме `LayerThemeVars` (структурно, без импорта). */
export interface LayerColorInputs {
  focusStripe: string | null;
  background: string | null;
}

/** Производные цвета слоя и контекст, в котором они посчитаны. */
export interface AdaptedLayer {
  colors: LayerColorInputs;
  context: AdaptiveContext | null;
}

let current: AdaptiveContext | null = null;

/** Действующий контекст адаптации; `null` — интерфейс ещё не применён. */
export function adaptiveContext(): AdaptiveContext | null {
  return current;
}

/** Сбросить контекст и кэш производных (смена сети, тесты). */
export function resetAdaptiveContext(): void {
  current = null;
  clearAdaptiveColorCache();
}

/**
 * Подпись состояния картинки для ключа пересчёта: производные цвета слоя
 * зависят от композита «тинт × картинка», поэтому смена картинки обязана
 * пересчитать и их.
 */
export function wallpaperSignature(): string {
  const state = getWallpaperState();
  if (state.status !== 'ok') return 'none';
  return `ok|${state.content_hash}`;
}

/**
 * Плотность тинта карты — та же, что выставит `canvas/wallpaper.ts`
 * (`applyWallpaperState`): те же хелперы `wallpaperTintAlpha` и
 * `wallpaperTintColor`, поэтому формулы здесь не дублируются. `null` — картинки
 * нет либо цвет фона не разобран.
 */
function canvasTint(state: WallpaperState, base: string, inLayer: boolean): string | null {
  if (state.status !== 'ok') return null;
  const rgb = parseCssColor(base);
  if (rgb === null) return null;
  const baseLuminance = relativeLuminance(rgb[0], rgb[1], rgb[2]);
  return wallpaperTintColor(
    rgb,
    wallpaperTintAlpha(state.meta.avg_luminance, baseLuminance, inLayer),
  );
}

/**
 * Производные цвета активного слоя под текущую подложку.
 *
 *   • фон — поверхность, на которой читается текст темы (`--text`, 4.5 : 1):
 *     `--layer-bg` используется и на экранах (структуры, дневник), где другого
 *     текста нет;
 *   • полоса — акцент, различимый на итоговой подложке холста (3 : 1 у ВИДИМОЙ
 *     полосы, `lib/adaptive-color.ts`).
 *
 * Порядок важен: подложка холста считается от УЖЕ адаптированного фона — ровно
 * того, что попадёт в `--layer-bg`, поэтому тинт совпадает с тем, который
 * выставит `canvas/wallpaper.ts`.
 */
export function adaptLayerColors(colors: LayerColorInputs, scope: string): AdaptedLayer {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return { colors, context: null };
  }
  const styles = getComputedStyle(document.documentElement);
  const text = styles.getPropertyValue('--text').trim();
  const surface = styles.getPropertyValue('--surface').trim();
  const themeBg = styles.getPropertyValue('--bg').trim();
  if (text === '' || themeBg === '') {
    // Тема ещё не применена — производные не считаем, действуют фолбэки CSS.
    return { colors, context: null };
  }

  const background =
    colors.background === null
      ? null
      : cachedAdaptiveColor(colors.background, [text], TEXT_CONTRAST_MIN, scope);
  const base = background ?? themeBg;
  const state = getWallpaperState();
  const backdrop = canvasBackdrop(base, canvasTint(state, base, background !== null));
  const focusStripe =
    colors.focusStripe === null || backdrop === null
      ? colors.focusStripe
      : cachedAdaptiveBandColor(colors.focusStripe, backdrop, scope);

  current = { scope, text, surface, backdrop };
  return { colors: { focusStripe, background }, context: current };
}

/** Цвета мысли/типа в форме, которую применяет `applyCloudStyle`. */
export interface ThoughtColorInputs {
  fg: string | null;
  bg: string | null;
}

/**
 * Производные цвета мысли (и унаследованного типа) на фактической поверхности:
 *
 *   • своего фона нет — текст рисуется на непрозрачном `--surface` облачка,
 *     поэтому адаптируется к нему;
 *   • свой фон есть, текст задан — текст адаптируется к своему фону (сам фон
 *     остаётся данными пользователя: перекрашивать его незачем, читаемость
 *     обеспечивает текст);
 *   • свой фон есть, текст не задан — цвет текста выбирает `contrastText`; если
 *     выбранный им чёрный/белый не дотягивает до 4.5 : 1, фон сдвигается по
 *     светлоте/насыщенности, пока пара не станет читаемой.
 *
 * Шрифтовые флаги сюда не входят: жирный/наклонный — данные пользователя
 * (сценарий 5797c15c), различимость в светлых темах держат вес и начертание.
 */
export function adaptThoughtColors(colors: ThoughtColorInputs): ThoughtColorInputs {
  const context = current;
  if (context === null) return colors;
  if (colors.bg === null) {
    const surface = context.surface !== '' ? context.surface : context.backdrop;
    if (colors.fg === null || surface === null) return colors;
    return {
      fg: cachedAdaptiveColor(colors.fg, [surface], TEXT_CONTRAST_MIN, context.scope),
      bg: null,
    };
  }
  if (colors.fg !== null) {
    return {
      fg: cachedAdaptiveColor(colors.fg, [colors.bg], TEXT_CONTRAST_MIN, context.scope),
      bg: colors.bg,
    };
  }
  let bg = colors.bg;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const auto = contrastText(bg);
    const autoRgb = parseCssColor(auto);
    const bgRgb = parseCssColor(bg);
    if (autoRgb === null || bgRgb === null) break;
    if (contrastRatio(autoRgb, bgRgb) >= TEXT_CONTRAST_MIN) break;
    bg = cachedAdaptiveColor(bg, [auto], TEXT_CONTRAST_MIN, context.scope);
  }
  return { fg: null, bg };
}

/**
 * Производная акцента, который рисуется НА ХОЛСТЕ (идентификационный цвет
 * линии связи, L14): порог — 3 : 1 к итоговой подложке, как у полосы фокуса,
 * но без плотности слоя полосы — линия непрозрачна. Исходный цвет мысли/типа
 * остаётся в данных, адаптируется только отрисовка.
 */
export function adaptCanvasAccent(color: string): string {
  const context = current;
  if (context === null || context.backdrop === null) return color;
  return cachedAdaptiveColor(color, [context.backdrop], FRAME_CONTRAST_MIN, context.scope);
}

/** Токены режима темы, прочитанные из действующей таблицы стилей. */
interface ModeTokens {
  bg: string;
  text: string;
}

const modeTokens = new Map<string, ModeTokens | null>();

/**
 * Токены `--bg`/`--text` ПРОТИВОПОЛОЖНОГО режима — для слота пары, который
 * диалог «Свойства слоя» вычисляет при сохранении. Блоки тем адресуются
 * атрибутами (`[data-theme='<тема>'][data-mode='<режим>']`), поэтому нужное
 * значение читается временной подстановкой атрибута: пересчёт стиля происходит
 * сразу, отрисовки (и мигания) между подстановкой и возвратом нет.
 */
export function readModeTokens(mode: Theme): ModeTokens | null {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null;
  const root = document.documentElement;
  const key = `${root.getAttribute('data-theme') ?? ''}|${mode}`;
  const cached = modeTokens.get(key);
  if (cached !== undefined) return cached;

  const previous = root.getAttribute('data-mode');
  root.setAttribute('data-mode', mode);
  const styles = getComputedStyle(root);
  const bg = styles.getPropertyValue('--bg').trim();
  const text = styles.getPropertyValue('--text').trim();
  if (previous === null) root.removeAttribute('data-mode');
  else root.setAttribute('data-mode', previous);

  const tokens = bg === '' || text === '' ? null : { bg, text };
  modeTokens.set(key, tokens);
  return tokens;
}

/**
 * Слот пары `layers.colors` для ПРОТИВОПОЛОЖНОГО режима (замена прямой инверсии
 * светлоты в диалоге «Свойства слоя»): тот же модуль подгонки, но под подложку
 * второго режима. Фон подгоняется под текст темы (это поверхность), полоса — под
 * фон холста (это акцент). Неразборчивый режим — значение остаётся как задано:
 * при отрисовке его всё равно адаптирует {@link adaptLayerColors}.
 */
export function deriveOppositeSlot(
  value: string,
  kind: 'focus_stripe' | 'background',
  mode: Theme,
): string {
  const other: Theme = mode === 'dark' ? 'light' : 'dark';
  const tokens = readModeTokens(other);
  if (tokens === null) return value;
  return kind === 'background'
    ? adaptiveColor(value, [tokens.text], TEXT_CONTRAST_MIN)
    : adaptiveColor(value, [tokens.bg], FRAME_CONTRAST_MIN);
}
