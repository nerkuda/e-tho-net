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
 * «тинт над средней точкой картинки» считается ОТ ФАКТА: средняя светлота
 * берётся из метаданных картинки (`meta.avg_luminance`), плотность вуали — из
 * фактической CSS-переменной (с множителем слоя `WALLPAPER_TINT_LAYER_FACTOR`) —
 * {@link wallpaperBackdrop}. Обратный ход «восстановить светлоту из α» убран:
 * он ошибался до 0.51 по светлоте и не знал про множитель слоя (круг 2).
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
 * У ПОЛОСЫ фокуса диапазон двухступенчатый: сначала узкий (цвет и тон
 * сохраняются), а полный [{@link BAND_LIGHT_MIN}…{@link BAND_LIGHT_MAX}]
 * включается только когда в узком 3 : 1 недостижимы — так полупрозрачная
 * полоса (α = 0.7) на средней подложке всё равно читается.
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

/**
 * ВТОРАЯ ступень диапазона светлоты ПОЛОСЫ фокуса — полный [0, 1]. Порог
 * 3 : 1 ищется сначала в узком диапазоне ({@link ADAPT_LIGHT_MIN}…{@link
 * ADAPT_LIGHT_MAX}): там полоса сохраняет цвет и тон. Полный диапазон
 * включается ТОЛЬКО когда в узком порог недостижим — иначе пастельная полоса
 * без нужды уезжала бы в чистый #fff.
 *
 * Недостижимость — свойство НЕЙТРАЛЬНЫХ полос: при α = 0.7 и средней
 * подложке rgb(116, 116, 116) предел в узком диапазоне 2.95, а светлота 0
 * даёт 3.36. Это НЕ «при любой насыщенности»: цветная полоса #00001f на той
 * же подложке проходит порог уже в узком диапазоне (3.277). Полоса — акцент
 * под подписями и облачками, сетку холста и свечение выделения она не
 * закрывает, поэтому её ограничение — ровно порог контраста, а не «не
 * уходить в #000/#fff».
 */
export const BAND_LIGHT_MIN = 0;
export const BAND_LIGHT_MAX = 1;

/** Шаг подгонки светлоты (доля HSL L): 0.01 ≈ 2.6 канала sRGB. */
export const ADAPT_STEP = 0.01;

/**
 * Шаги подгонки от исходной светлоты ДО ГРАНИЦЫ диапазона (в каждом
 * направлении своё число). Поиск обязан дойти до самого края [{@link
 * ADAPT_LIGHT_MIN}, {@link ADAPT_LIGHT_MAX}]: из L=0 чёрный цвет иначе
 * упирается в 0.88 и не добирает контраст (дефект круга 2 — полоса 2.97 : 1).
 * Границы передаются параметрами: у текста и поверхностей они свои
 * ({@link ADAPT_LIGHT_MIN}…{@link ADAPT_LIGHT_MAX}), у полосы — полные
 * ({@link BAND_LIGHT_MIN}…{@link BAND_LIGHT_MAX}).
 */
function stepBudget(light: number, min: number, max: number): { up: number; down: number } {
  return {
    up: Math.max(0, Math.ceil((max - light) / ADAPT_STEP)),
    down: Math.max(0, Math.ceil((light - min) / ADAPT_STEP)),
  };
}

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

/**
 * Средняя точка картинки заданной светлоты: нейтральный серый (0..255). Для
 * контраста по WCAG важна только относительная яркость (она считается по
 * каналам), поэтому хрома средней точки на результат не влияет.
 */
export function averageWallpaperColor(luminance: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, luminance));
  const channel =
    clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  const gray = Math.round(Math.min(1, Math.max(0, channel)) * 255);
  return [gray, gray, gray];
}

/**
 * Композит «тинт над картинкой» в СРЕДНЕЙ светлоте изображения — фактическая
 * подложка карты при активной картинке.
 *
 * Считается ОТ ФАКТА, а не обратным ходом из плотности тинта: `imageLuminance` —
 * средняя светлота картинки из её метаданных (`meta.avg_luminance`, считается по
 * пикселям в `lib/wallpaper-image.ts`), `tint` — та самая CSS-переменная вуали,
 * которую рисует браузер (плотность уже включает множитель слоя
 * `WALLPAPER_TINT_LAYER_FACTOR` и округление до сотых). Обратный ход из α ошибался
 * до 0.51 по светлоте в упоре α и не знал про множитель слоя — отсюда провал
 * гарантии 3 : 1 у видимой полосы (дефект круга 2: чёрная картинка под светлым
 * слоем давала фактическую подложку rgb(61, 61, 61) и полосу 1.72 : 1).
 *
 * `null` — фон или вуаль не разобраны либо средней светлоты нет (адаптация под
 * картинку невозможна, действует подложка без неё).
 */
export function wallpaperBackdrop(
  base: string,
  tint: string | null,
  imageLuminance: number | null,
): string | null {
  const rgb = parseCssColor(base);
  const alpha = tint === null ? null : parseAlpha(tint);
  if (rgb === null || alpha === null || imageLuminance === null) return null;
  if (!Number.isFinite(imageLuminance)) return null;
  return hexOf(mixColors(rgb, averageWallpaperColor(imageLuminance), alpha));
}
/**
 * Итоговая подложка холста: с картинкой — композит «тинт над картинкой»
 * ({@link wallpaperBackdrop}), без картинки — цвет фона. `imageLuminance` —
 * средняя светлота картинки из метаданных (`null` без картинки). `null` в
 * результате — цвет фона не разобран (адаптация не выполняется, действуют
 * фолбэки CSS).
 */
export function canvasBackdrop(
  base: string,
  tint: string | null,
  imageLuminance: number | null,
): string | null {
  const rgb = parseCssColor(base);
  if (rgb === null) return null;
  return wallpaperBackdrop(base, tint, imageLuminance) ?? hexOf(rgb);
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
 * Подбор производной: шаг светлоты {@link ADAPT_STEP} по ВСЕМУ диапазону
 * [{@link ADAPT_LIGHT_MIN}, {@link ADAPT_LIGHT_MAX}] — от исходной светлоты до
 * каждой из границ (число шагов считает {@link stepBudget}), первым — направление
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
  lightMin: number = ADAPT_LIGHT_MIN,
  lightMax: number = ADAPT_LIGHT_MAX,
): number[] {
  const [hue, sat, light] = rgbToHsl([rgb[0]!, rgb[1]!, rgb[2]!]);
  const preferred: 1 | -1 = backdropLuminance > 0.5 ? -1 : 1;
  const order: Array<1 | -1> = [preferred, preferred === 1 ? -1 : 1];
  const budget = stepBudget(light, lightMin, lightMax);
  const maxSteps = Math.max(budget.up, budget.down);

  let best: number[] = [rgb[0]!, rgb[1]!, rgb[2]!];
  let bestContrast = measure([rgb[0]!, rgb[1]!, rgb[2]!]);
  for (const scale of SAT_SCALES) {
    const candidateSat = sat * scale;
    for (let step = 1; step <= maxSteps; step += 1) {
      for (const direction of order) {
        if (step > (direction === 1 ? budget.up : budget.down)) continue;
        const candidateLight = light + direction * step * ADAPT_STEP;
        if (candidateLight < lightMin || candidateLight > lightMax) continue;
        const candidate = rounded(hslToRgb(hue, candidateSat, candidateLight));
        const contrast = measure(candidate);
        if (contrast > bestContrast) {
          best = candidate;
          bestContrast = contrast;
        }
        if (contrast >= target) return candidate;
      }
    }
    // Сама ГРАНИЦА диапазона: сетка шагов привязана к исходной светлоте и
    // может не попасть ровно в край (из L = 0.727 шаг 0.01 даёт 0.937, а
    // 0.94 — нет). Без этого узкий поиск «недобирает» до 0.01 и полоса зря
    // уезжает в полный диапазон, теряя цвет (круг 3).
    for (const edge of [lightMax, lightMin]) {
      if (edge < lightMin || edge > lightMax) continue;
      const candidate = rounded(hslToRgb(hue, candidateSat, edge));
      const contrast = measure(candidate);
      if (contrast > bestContrast) {
        best = candidate;
        bestContrast = contrast;
      }
      if (contrast >= target) return candidate;
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
  const measure = (value: [number, number, number]): number =>
    bandContrast(value, parsed, opacity);
  if (measure([rgb[0]!, rgb[1]!, rgb[2]!]) >= FRAME_CONTRAST_MIN) return source;
  const backdropLuminance = relativeLuminance(parsed[0], parsed[1], parsed[2]);
  // Ступень 1 — узкий диапазон: полоса сохраняет цвет и тон.
  const narrow = searchAdaptation(
    rgb,
    backdropLuminance,
    measure,
    FRAME_CONTRAST_MIN,
    ADAPT_LIGHT_MIN,
    ADAPT_LIGHT_MAX,
  );
  if (measure([narrow[0]!, narrow[1]!, narrow[2]!]) >= FRAME_CONTRAST_MIN) {
    return hexOf(narrow);
  }
  // Ступень 2 — полный диапазон: только если в узком порог недостижим (см.
  // докблок {@link BAND_LIGHT_MIN}).
  const wide = searchAdaptation(
    rgb,
    backdropLuminance,
    measure,
    FRAME_CONTRAST_MIN,
    BAND_LIGHT_MIN,
    BAND_LIGHT_MAX,
  );
  return hexOf(wide);
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
