/**
 * Тема-осведомлённая адаптация пользовательских цветов (0.16.1, требование
 * 26d53c26, задача 6e171b39).
 *
 * **Зачем модуль.** До 0.16.1 пользовательский цвет адаптировался к теме одной
 * жёсткой инверсией светлоты HSL (L → 1−L, `invertLightness`): при шести темах
 * × двух режимах и фоновой картинке этого мало — цвет, читаемый на подложке
 * `current`, сливался с подложкой `catppuccin`, а поверх тонированной картинки
 * не читался вовсе. Здесь ОДИН алгоритм подгонки светлоты (тон и насыщенность
 * сохраняются) под контраст с подложкой:
 *
 *   • текст на поверхности — {@link TEXT_CONTRAST_MIN} (WCAG AA, 4.5 : 1);
 *   • полоса фокуса и контур — {@link FRAME_CONTRAST_MIN} (WCAG 1.4.11, 3 : 1).
 *
 * **Итоговая подложка.** Холст карты — либо цвет фона темы/слоя, либо
 * `linear-gradient(тинт), картинка` (`styles/canvas.css`). Подложки не
 * складываются: картинка с тинтом перекрывает фон, поэтому цвет проверяется
 * против ТОЙ подложки, которая сейчас видна ({@link canvasBackdrop}). Композит
 * «тинт над картинкой» берётся в средней светлоте изображения; она
 * восстанавливается из плотности тинта, потому что плотность посчитана ровно от
 * расхождения светлоты картинки и фона (`wallpaperTintAlpha`) —
 * {@link wallpaperBackdrop}. Отдельные метаданные картинки модулю не нужны.
 *
 * **Полоса фокуса полупрозрачна.** `.canvas::before` рисуется с
 * `--focus-band-opacity` (0.7, `styles/tokens.css`), поэтому контраст
 * проверяется у ВИДИМОЙ полосы — композита «цвет полосы над подложкой»
 * ({@link bandContrast}), иначе тёмная полоса на тёмном холсте давала бы 9 : 1
 * «в цвете» и 2.5 : 1 на экране.
 *
 * **Диапазон производных.** Почти чёрный/белый/кричащий пользовательский цвет
 * не разгоняется в чистые #000/#fff: светлота производной ограничена
 * [{@link ADAPT_LIGHT_MIN}, {@link ADAPT_LIGHT_MAX}], иначе сетка холста,
 * подписи и свечение выделения перестают различаться (сценарий 2b86c983).
 *
 * **Исходники не меняются.** Модуль чистый: получает цвет строкой и возвращает
 * производную, ничего не персистя. Пара слотов `layers.colors` (тёмная/светлая)
 * остаётся данными пользователя; производные считаются на лету с кэшем по
 * ключу `тема|режим|цвет|подложка` ({@link cachedAdaptiveColor}).
 *
 * Разбор и арифметика цветов — общий `lib/css-color.ts` (второй копии разбора
 * в репозитории не заводим); опыт гарантии контраста взят из
 * `lib/cloud-frames.ts` (рамки трёх состояний, задача c6d74fd4).
 */

import { hslToRgb, mixColors, parseCssColor, relativeLuminance, rgbToHsl } from './css-color.js';
import {
  WALLPAPER_TINT_ALPHA_MAX,
  WALLPAPER_TINT_ALPHA_MIN,
  WALLPAPER_TINT_DELTA_FULL,
} from './wallpaper-image.js';

/** Минимальный контраст текста с подложкой (WCAG AA, обычный текст). */
export const TEXT_CONTRAST_MIN = 4.5;

/** Минимальный контраст полосы фокуса и контура (WCAG 1.4.11, non-text). */
export const FRAME_CONTRAST_MIN = 3;

/**
 * Плотность слоя полосы фокуса: `--focus-band-opacity` в `styles/tokens.css`
 * (значение снижено на 30 % доработкой среза 2026-11-13). Дублируется в CSS —
 * сверяется сторожем `guard-adaptive-colors`.
 */
export const FOCUS_BAND_OPACITY = 0.7;

/**
 * Границы светлоты производной (доля HSL L). Производная не уходит в чистые
 * чёрный/белый: на холсте остаются различимыми сетка, подписи и свечение
 * выделения (сценарий 2b86c983), а цвет сохраняет узнаваемость тона.
 */
export const ADAPT_LIGHT_MIN = 0.06;
export const ADAPT_LIGHT_MAX = 0.94;

/** Шаг подгонки светлоты (доля HSL L): 0.01 ≈ 2.6 канала sRGB. */
export const ADAPT_STEP = 0.01;

/** Сколько шагов подгонки допускается — покрывает весь диапазон. */
const ADAPT_MAX_STEPS = Math.ceil((ADAPT_LIGHT_MAX - ADAPT_LIGHT_MIN) / ADAPT_STEP);

/**
 * Округление каналов до целых. Подбор светлоты считает контраст уже
 * ОКРУГЛЁННОГО цвета: иначе кандидат с контрастом 3.0004 после перевода в
 * `#rrggbb` давал бы 2.9996 и порог нарушался бы на ровном месте.
 */
function rounded(rgb: readonly number[]): [number, number, number] {
  return [
    Math.min(255, Math.max(0, Math.round(rgb[0]!))),
    Math.min(255, Math.max(0, Math.round(rgb[1]!))),
    Math.min(255, Math.max(0, Math.round(rgb[2]!))),
  ];
}

/** sRGB-каналы 0..255 → `#rrggbb`. */
function hexOf(rgb: readonly number[]): string {
  return (
    '#' +
    rgb
      .map((channel) =>
        Math.round(Math.min(255, Math.max(0, channel)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** Контраст двух sRGB-цветов по WCAG 2.1 (1..21). */
export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const la = relativeLuminance(a[0]!, a[1]!, a[2]!);
  const lb = relativeLuminance(b[0]!, b[1]!, b[2]!);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Альфа из CSS-цвета (`rgba()`/`hsla()`/`#rrggbbaa`); `null` — не разобрана. */
export function parseAlpha(value: string): number | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return null;
  const functional = /^[a-z]+\(([^)]+)\)$/i.exec(trimmed);
  if (functional !== null) {
    const parts = functional[1]!
      .replace(/\//g, ' ')
      .split(/[\s,]+/)
      .filter((part) => part !== '');
    if (parts.length < 4) return null;
    const raw = parts[3]!;
    const alpha = Number.parseFloat(raw);
    if (!Number.isFinite(alpha)) return null;
    return Math.min(1, Math.max(0, raw.endsWith('%') ? alpha / 100 : alpha));
  }
  if (trimmed.startsWith('#') && trimmed.length === 9) {
    const alpha = Number.parseInt(trimmed.slice(7, 9), 16) / 255;
    return Number.isFinite(alpha) ? alpha : null;
  }
  return null;
}

/** Нейтральный серый (0..255) с заданной относительной яркостью WCAG. */
function grayForLuminance(luminance: number): [number, number, number] {
  const channel =
    luminance <= 0.0031308 ? luminance * 12.92 : 1.055 * luminance ** (1 / 2.4) - 0.055;
  const value = Math.round(Math.min(1, Math.max(0, channel)) * 255);
  return [value, value, value];
}

/**
 * Композит «тинт над картинкой» в СРЕДНЕЙ светлоте изображения — та подложка,
 * которую видит пользователь на карте при активной картинке.
 *
 * Средняя светлота картинки не передаётся: плотность тинта посчитана от
 * расхождения светлоты картинки и фона (`wallpaperTintAlpha`:
 * `|image − base| / WALLPAPER_TINT_DELTA_FULL` → α из
 * [{@link WALLPAPER_TINT_ALPHA_MIN}, {@link WALLPAPER_TINT_ALPHA_MAX}]), поэтому
 * она восстанавливается обратным ходом: светлая подложка темнеет, тёмная
 * светлеет ровно на столько, на сколько указывает плотность вуали. `null` —
 * фон не разобран или вуали нет.
 */
export function wallpaperBackdrop(base: string, tint: string | null): string | null {
  const rgb = parseCssColor(base);
  const alpha = tint === null ? null : parseAlpha(tint);
  if (rgb === null || alpha === null) return null;
  const baseLuminance = relativeLuminance(rgb[0], rgb[1], rgb[2]);
  const delta =
    Math.min(
      1,
      Math.max(
        0,
        (alpha - WALLPAPER_TINT_ALPHA_MIN) / (WALLPAPER_TINT_ALPHA_MAX - WALLPAPER_TINT_ALPHA_MIN),
      ),
    ) * WALLPAPER_TINT_DELTA_FULL;
  // Тинт плотнее, когда картинка противоположна подложке по светлоте: светлая
  // подложка → картинка темнее, тёмная → светлее.
  const imageLuminance =
    baseLuminance > 0.5 ? Math.max(0, baseLuminance - delta) : Math.min(1, baseLuminance + delta);
  return hexOf(mixColors(rgb, grayForLuminance(imageLuminance), alpha));
}

/**
 * Итоговая подложка холста: с картинкой — композит «тинт над картинкой»
 * ({@link wallpaperBackdrop}), без картинки — цвет фона. `null` — цвет фона не
 * разобран (адаптация не выполняется, действуют фолбэки CSS).
 */
export function canvasBackdrop(base: string, tint: string | null): string | null {
  const rgb = parseCssColor(base);
  if (rgb === null) return null;
  return wallpaperBackdrop(base, tint) ?? hexOf(rgb);
}

/**
 * Видимый цвет полосы фокуса: полупрозрачный слой полосы над подложкой
 * (обычная альфа-смесь в sRGB, как рисует браузер). `opacity` — плотность слоя
 * `--focus-band-opacity`.
 */
export function bandColor(
  stripe: readonly number[],
  backdrop: readonly number[],
  opacity = FOCUS_BAND_OPACITY,
): number[] {
  return mixColors(
    [stripe[0]!, stripe[1]!, stripe[2]!],
    [backdrop[0]!, backdrop[1]!, backdrop[2]!],
    opacity,
  );
}

/** Контраст ВИДИМОЙ полосы с подложкой (то, что различает глаз пользователя). */
export function bandContrast(
  stripe: readonly number[],
  backdrop: readonly number[],
  opacity = FOCUS_BAND_OPACITY,
): number {
  return contrastRatio(bandColor(stripe, backdrop, opacity), backdrop);
}

/** Худший (минимальный) контраст цвета к набору подложек. */
export function worstContrast(source: readonly number[], backdrops: readonly number[][]): number {
  if (backdrops.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...backdrops.map((backdrop) => contrastRatio(source, backdrop)));
}

/** Разобранные подложки (неразборчивые отброшены). */
function parseBackdrops(backdrops: readonly string[]): number[][] {
  return backdrops
    .map((backdrop) => parseCssColor(backdrop))
    .filter((backdrop): backdrop is [number, number, number] => backdrop !== null);
}

/**
 * Доли насыщенности, которые допускаются при подгонке, — от исходной к нулю.
 * Светлота подбирается с сохранением насыщенности; к следующей доле алгоритм
 * переходит только если порог светлотой не достижим (насыщенный жёлтый на
 * среднесветлой подложке упирается в 4 : 1 при любой светлоте). Цвет
 * обесцвечивается на столько, на сколько нужно для читаемости, — узнаваемость
 * тона сохраняется, пока она не мешает контрасту.
 */
const SAT_SCALES = [1, 0.75, 0.5, 0.25, 0] as const;

/**
 * Подбор производной: шаг светлоты {@link ADAPT_STEP} в диапазоне
 * [{@link ADAPT_LIGHT_MIN}, {@link ADAPT_LIGHT_MAX}], первым — направление
 * «прочь от подложки» (на светлой подложке темнее, на тёмной светлее), затем
 * обратное; насыщенность — по лестнице {@link SAT_SCALES}. `measure`
 * возвращает контраст кандидата; первое значение ≥ `target` побеждает. Если
 * порог принципиально недостижим — возвращается кандидат с максимальным
 * достижимым контрастом.
 */
function searchAdaptation(
  rgb: readonly number[],
  backdropLuminance: number,
  measure: (candidate: [number, number, number]) => number,
  target: number,
): number[] {
  const [hue, sat, light] = rgbToHsl([rgb[0]!, rgb[1]!, rgb[2]!]);
  const preferred: 1 | -1 = backdropLuminance > 0.5 ? -1 : 1;
  const order: Array<1 | -1> = [preferred, preferred === 1 ? -1 : 1];

  let best: number[] = [rgb[0]!, rgb[1]!, rgb[2]!];
  let bestContrast = measure([rgb[0]!, rgb[1]!, rgb[2]!]);
  for (const scale of SAT_SCALES) {
    const candidateSat = sat * scale;
    for (let step = 1; step <= ADAPT_MAX_STEPS; step += 1) {
      for (const direction of order) {
        const candidateLight = light + direction * step * ADAPT_STEP;
        if (candidateLight < ADAPT_LIGHT_MIN || candidateLight > ADAPT_LIGHT_MAX) continue;
        const candidate = rounded(hslToRgb(hue, candidateSat, candidateLight));
        const contrast = measure(candidate);
        if (contrast > bestContrast) {
          best = candidate;
          bestContrast = contrast;
        }
        if (contrast >= target) return candidate;
      }
    }
  }
  return best;
}

/** Средняя относительная яркость подложек — опора выбора направления сдвига. */
function meanLuminance(backdrops: readonly number[][]): number {
  if (backdrops.length === 0) return 0;
  const sum = backdrops.reduce(
    (acc, backdrop) => acc + relativeLuminance(backdrop[0]!, backdrop[1]!, backdrop[2]!),
    0,
  );
  return sum / backdrops.length;
}

/**
 * Производная цвета, читаемая на всех подложках с контрастом ≥ `target`.
 * Цвет, уже проходящий порог, возвращается без изменений — исходное значение
 * не «перекрашивается» ради перекраски.
 */
export function adaptiveColor(
  source: string,
  backdrops: readonly string[],
  target: number,
): string {
  const rgb = parseCssColor(source);
  const parsed = parseBackdrops(backdrops);
  if (rgb === null || parsed.length === 0) return source;
  if (worstContrast(rgb, parsed) >= target) return source;
  const candidate = searchAdaptation(
    rgb,
    meanLuminance(parsed),
    (value) => worstContrast(value, parsed),
    target,
  );
  return hexOf(candidate);
}

/**
 * Производная ПОЛОСЫ фокуса: контраст считается у видимой полосы — композита
 * «цвет над подложкой» с плотностью {@link FOCUS_BAND_OPACITY} ({@link
 * bandContrast}). Для контура и подписи полоса остаётся непрозрачным цветом, а
 * вот различимость самой полосы на холсте определяется именно этим композитом.
 */
export function adaptiveBandColor(
  source: string,
  backdrop: string,
  opacity = FOCUS_BAND_OPACITY,
): string {
  const rgb = parseCssColor(source);
  const parsed = parseCssColor(backdrop);
  if (rgb === null || parsed === null) return source;
  if (bandContrast(rgb, parsed, opacity) >= FRAME_CONTRAST_MIN) return source;
  const candidate = searchAdaptation(
    rgb,
    relativeLuminance(parsed[0], parsed[1], parsed[2]),
    (value) => bandContrast(value, parsed, opacity),
    FRAME_CONTRAST_MIN,
  );
  return hexOf(candidate);
}

// ---------------------------------------------------------------------------
// Кэш производных: ключ `тема|режим|цвет|подложка` (требование 26d53c26)
// ---------------------------------------------------------------------------

const cache = new Map<string, string>();

/**
 * Счётчики обращений к кэшу. Живут для диагностики и тестов («повторный вызов
 * не пересчитывает»): `computes` — промахи, `hits` — попадания.
 */
export const adaptiveCacheStats = { computes: 0, hits: 0 };

/** Ключ кэша: область (тема и режим), исходный цвет, подложки, порог. */
function cacheKey(
  scope: string,
  source: string,
  backdrops: readonly string[],
  target: number,
): string {
  return `${scope}|${source.trim().toLowerCase()}|${backdrops.join(',')}|${target}`;
}

/**
 * Производная с кэшем. `scope` — ключ темы и режима (`<тема>|<режим>`): один и
 * тот же пользовательский цвет на разных темах даёт разные производные, поэтому
 * тема обязательна в ключе.
 */
export function cachedAdaptiveColor(
  source: string,
  backdrops: readonly string[],
  target: number,
  scope: string,
): string {
  const key = cacheKey(scope, source, backdrops, target);
  const hit = cache.get(key);
  if (hit !== undefined) {
    adaptiveCacheStats.hits += 1;
    return hit;
  }
  adaptiveCacheStats.computes += 1;
  const value = adaptiveColor(source, backdrops, target);
  cache.set(key, value);
  return value;
}

/**
 * Производная ПОЛОСЫ с кэшем: контраст видимой полосы
 * ({@link adaptiveBandColor}); ключ тот же, что у {@link cachedAdaptiveColor},
 * плюс плотность слоя полосы.
 */
export function cachedAdaptiveBandColor(
  source: string,
  backdrop: string,
  scope: string,
  opacity = FOCUS_BAND_OPACITY,
): string {
  const key = `${cacheKey(scope, source, [backdrop], FRAME_CONTRAST_MIN)}|band${opacity}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    adaptiveCacheStats.hits += 1;
    return hit;
  }
  adaptiveCacheStats.computes += 1;
  const value = adaptiveBandColor(source, backdrop, opacity);
  cache.set(key, value);
  return value;
}

/** Очистить кэш производных (смена набора подложек, тесты). */
export function clearAdaptiveColorCache(): void {
  cache.clear();
  adaptiveCacheStats.computes = 0;
  adaptiveCacheStats.hits = 0;
}
