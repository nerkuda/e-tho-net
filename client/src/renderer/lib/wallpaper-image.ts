/**
 * Чистые функции подготовки фоновой картинки карты (0.16.1, задача 80324150;
 * требование e6d586d3, сценарии d9e8dba7 и 3fe62610, ADR a5888535).
 *
 * Здесь нет DOM: план даунскейла, сведение прозрачности на подложку, метаданные
 * светлоты/тона и параметры тинта — арифметика над пикселями. DOM-адаптер
 * (`wallpaper-prepare.ts`) только декодирует картинку, отдаёт буфер сюда и
 * кодирует результат обратно. Такое разделение позволяет доказывать пороги
 * (3840 px, 5 МиБ, подложка по светлоте, тинт) юнит-тестами без браузера.
 *
 * Пайплайн загрузки (сценарий d9e8dba7, ревизия и2):
 *   1. длинная сторона > {@link WALLPAPER_MAX_EDGE} px ИЛИ файл >
 *      {@link WALLPAPER_MAX_BYTES} → JPEG q={@link WALLPAPER_JPEG_QUALITY} до
 *      3840 px;
 *   2. прозрачный PNG сводится на подложку, выбранную по средней светлоте
 *      (≥ {@link WALLPAPER_ALPHA_LUMINANCE_THRESHOLD} → белая, иначе чёрная) —
 *      детерминизм результата не зависит от темы пользователя;
 *   3. результат обязан быть ≤ {@link WALLPAPER_MAX_BYTES}, иначе отказ с
 *      понятным сообщением.
 */

import type { WallpaperMeta } from '@etn/shared';

import { parseCssColor, relativeLuminance } from './css-color.js';

/**
 * Разбор CSS-цвета и относительная яркость живут в общем хелпере
 * `lib/css-color.ts` (там же их использует `contrastText`/цвет счётчика зоны).
 * Реэкспорт сохранён ради существующих импортов (`canvas/wallpaper.ts`, тесты,
 * сторожа), чтобы не плодить вторую копию разбора.
 */
export { parseCssColor, relativeLuminance };

/** Порог длинной стороны: крупнее — даунскейл до этого значения. */
export const WALLPAPER_MAX_EDGE = 3840;

/** Качество JPEG при даунскейле (порог закреплён задачей 80324150). */
export const WALLPAPER_JPEG_QUALITY = 0.85;

/** Лимит серверного контракта (ADR a5888535): 5 МиБ на файл. */
export const WALLPAPER_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Потолок ИСХОДНОГО файла, который клиент готов принять и обработать. Файл
 * крупнее — отказ до декодирования: фото-исходники редко больше, а 40 МБ
 * держит декодирование предсказуемым.
 */
export const WALLPAPER_SOURCE_MAX_BYTES = 40 * 1024 * 1024;

/** Порог выбора подложки для прозрачного PNG (ревизия и2: ≥0.5 → белая). */
export const WALLPAPER_ALPHA_LUMINANCE_THRESHOLD = 0.5;

/**
 * Границы тинта (этап 2 и доработка по срезу заказчика 2026-11-13, круг 2):
 * вуаль ЛЁГКАЯ — картинка остаётся различимой, а читаемость контента держат
 * НЕПРОЗРАЧНЫЕ поверхности (облачка, панели, модалки) и плашки подписей, а не
 * плотность тинта.
 *
 * Тинт — доля цвета фона темы поверх картинки, поэтому до глаза доходит
 * (1 − α) исходного диапазона яркости. `0.12` сохраняет 88 % диапазона:
 * контраст «светлая часть картинки / тёмная» после тинта ≈ 16.6 : 1 на светлой
 * теме (liquid/current) и ≈ 16.1 : 1 на тёмной. Прежние границы хуже: 0.25
 * оставляла 75 % (≈ 10.5 : 1), 0.45 — 55 % (≈ 4.9 : 1), 0.8 — 20 % (≈ 1.6 : 1:
 * картинка превращалась в ровный фон — косяк среза).
 *
 * Верхняя граница 0.30 — худший случай, когда картинка противоположна теме:
 * 70 % диапазона и ≈ 8.7 : 1 на светлой теме (≈ 10.3 : 1 на тёмной); при
 * прежней 0.55 было 45 % и 3.4 : 1 — заказчик и на этом видел «картинка не
 * читается». Плотнее не нужно: подписи прямо на холсте (например,
 * «Подчинённых мыслей нет…», `--text-faint` поверх подложки) ни при каком
 * глобальном тинте не гарантируются — сценарий 3fe62610 прямо снимает
 * зональное усиление и возлагает читаемость на непрозрачные поверхности и
 * плашки (адаптация производных — задача 26d53c26).
 */
export const WALLPAPER_TINT_ALPHA_MIN = 0.12;
export const WALLPAPER_TINT_ALPHA_MAX = 0.3;

/**
 * В слое тинт прозрачнее: цвет слоя пользователя — «лёгкая вуаль» (§ef8112b0).
 * Коэффициент пересчитан под новый диапазон: в слое 0.096–0.24.
 */
export const WALLPAPER_TINT_LAYER_FACTOR = 0.8;

/**
 * Доля плотности тинта на ПРОЧИХ экранах (этап 2): фон «Дневника», «Событий»,
 * «Структур» и «Публикаций» получает ту же вуаль цвета фона темы, но слабее
 * карты — там фон виден по краям, а контент лежит на непрозрачных поверхностях.
 * 0.6 от плотности карты даёт 0.072–0.18.
 */
export const WALLPAPER_SCREEN_TINT_FACTOR = 0.6;

/** Разница светлот, при которой тинт достигает {@link WALLPAPER_TINT_ALPHA_MAX}. */
export const WALLPAPER_TINT_DELTA_FULL = 0.7;

/**
 * Ниже этой насыщенности картинка считается серой: доминирующий тон не
 * записывается (`dominant_hue`/`dominant_sat` = `null`).
 */
export const WALLPAPER_DOMINANT_SAT_THRESHOLD = 0.08;

/**
 * Сколько пикселей участвует в расчёте метаданных. Полный буфер 4K — 8.3 Мп;
 * равномерная выборка не меняет средние на глаз, но держит загрузку быстрой.
 */
export const WALLPAPER_SAMPLE_PIXELS = 200_000;

/** Размеры в пикселях. */
export interface PixelSize {
  width: number;
  height: number;
}

/** План подготовки файла: что сделать с картинкой до отправки. */
export interface WallpaperPlan extends PixelSize {
  /** Уменьшать ли до {@link WALLPAPER_MAX_EDGE} по длинной стороне. */
  downscaled: boolean;
  /** Сводить ли прозрачность на подложку (картинка содержит альфу). */
  flatten: boolean;
  /**
   * MIME результата. `null` — исходный тип сохраняется как есть (файл в
   * порядке: не крупный, поддерживается сервером и не требует перекодирования).
   */
  encode_mime: 'image/jpeg' | 'image/png' | 'image/webp' | null;
}

/** Форматы, которые принимает сервер (ADR a5888535). */
const SERVER_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Ограничить значение диапазоном. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Размер после уменьшения по длинной стороне. Картинка в пределах порога не
 * масштабируется; пропорции сохраняются, минимум — 1 px.
 */
export function wallpaperTargetSize(
  width: number,
  height: number,
  maxEdge: number = WALLPAPER_MAX_EDGE,
): PixelSize {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest <= 0) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Решение по картинке: уменьшать/перекодировать/сводить альфу. `byteLength` —
 * размер ИСХОДНОГО файла, `hasAlpha` — найдена ли прозрачность в пикселях
 * (надёжнее, чем MIME: PNG может быть полностью непрозрачным).
 */
export function planWallpaper(input: {
  width: number;
  height: number;
  byteLength: number;
  hasAlpha: boolean;
  mime?: string;
}): WallpaperPlan {
  const downscaled = Math.max(input.width, input.height) > WALLPAPER_MAX_EDGE;
  const overBytes = input.byteLength > WALLPAPER_MAX_BYTES;
  const target = downscaled
    ? wallpaperTargetSize(input.width, input.height)
    : { width: input.width, height: input.height };
  // Даунскейл и перебор по размеру — JPEG q0.85 (сценарий d9e8dba7).
  const jpeg = downscaled || overBytes;
  const encode_mime: WallpaperPlan['encode_mime'] = jpeg
    ? 'image/jpeg'
    : input.mime !== undefined && SERVER_MIMES.has(input.mime)
      ? (input.mime as 'image/jpeg' | 'image/png' | 'image/webp')
      : 'image/png';
  return {
    width: target.width,
    height: target.height,
    downscaled,
    flatten: input.hasAlpha,
    encode_mime,
  };
}

/**
 * Подложка для прозрачного PNG по средней светлоте: светлая картинка сводится
 * на белую, тёмная — на чёрную (ревизия и2 сценария 813198ac). Возвращает
 * значения каналов 0..255.
 */
export function alphaBackdropColor(avgLuminance: number): [number, number, number] {
  return avgLuminance >= WALLPAPER_ALPHA_LUMINANCE_THRESHOLD ? [255, 255, 255] : [0, 0, 0];
}

/** Шаг прореживания выборки пикселей — стабилен для одинакового буфера. */
function sampleStep(pixelCount: number): number {
  return Math.max(1, Math.floor(pixelCount / WALLPAPER_SAMPLE_PIXELS));
}

/** Есть ли в буфере полупрозрачные/прозрачные пиксели. */
export function hasTransparency(pixels: Uint8ClampedArray): boolean {
  const step = sampleStep(pixels.length / 4);
  for (let i = 0; i < pixels.length; i += 4 * step) {
    if (pixels[i + 3]! < 255) return true;
  }
  return false;
}

/**
 * Свести альфу на непрозрачную подложку (обычное альфа-смешивание):
 * `c' = c·a + backdrop·(1−a)`. Возвращает НОВЫЙ буфер с `a' = 255`; исходный не
 * меняется (его же использует расчёт светлоты до сведения).
 */
export function flattenPixels(
  pixels: Uint8ClampedArray,
  backdrop: [number, number, number],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3]! / 255;
    const inv = 1 - a;
    out[i] = pixels[i]! * a + backdrop[0] * inv;
    out[i + 1] = pixels[i + 1]! * a + backdrop[1] * inv;
    out[i + 2] = pixels[i + 2]! * a + backdrop[2] * inv;
    out[i + 3] = 255;
  }
  return out;
}

/** HSL-представление пикселя: тон в градусах, насыщенность и светлота 0..1. */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = 60 * (((gn - bn) / d) % 6);
  else if (max === gn) h = 60 * ((bn - rn) / d + 2);
  else h = 60 * ((rn - gn) / d + 4);
  if (h < 0) h += 360;
  return { h, s, l };
}

/** Метаданные картинки, которые сервер хранит рядом с файлом. */
export interface MeasuredWallpaper {
  avg_luminance: number;
  dominant_hue: number | null;
  dominant_sat: number | null;
}

/**
 * Средняя светлота и доминирующий тон по пикселям.
 *
 * * светлота — среднее относительной яркости WCAG, взвешенное альфой (у
 *   прозрачной картинки «видимые» пиксели важнее прозрачных);
 * * тон — circular mean по насыщенности (тон нельзя усреднять линейно: 350° и
 *   10° — соседи); серые картинки доминирующего тона не имеют → `null`.
 */
export function measurePixels(pixels: Uint8ClampedArray): MeasuredWallpaper {
  const pixelCount = Math.floor(pixels.length / 4);
  const step = sampleStep(pixelCount);
  let lumSum = 0;
  let weightSum = 0;
  let hueX = 0;
  let hueY = 0;
  let satSum = 0;
  let satWeight = 0;
  for (let px = 0; px < pixelCount; px += step) {
    const i = px * 4;
    const a = pixels[i + 3]! / 255;
    if (a === 0) continue;
    const { h, s } = rgbToHsl(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
    lumSum += relativeLuminance(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) * a;
    weightSum += a;
    const rad = (h * Math.PI) / 180;
    hueX += Math.cos(rad) * s * a;
    hueY += Math.sin(rad) * s * a;
    satSum += s * a;
    satWeight += a;
  }
  if (weightSum === 0) {
    return { avg_luminance: 0, dominant_hue: null, dominant_sat: null };
  }
  const avgLuminance = clamp(lumSum / weightSum, 0, 1);
  const dominantSat = clamp(satSum / satWeight, 0, 1);
  if (dominantSat < WALLPAPER_DOMINANT_SAT_THRESHOLD) {
    return { avg_luminance: avgLuminance, dominant_hue: null, dominant_sat: null };
  }
  let hue = (Math.atan2(hueY, hueX) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return {
    avg_luminance: avgLuminance,
    dominant_hue: Math.round(hue * 10) / 10,
    dominant_sat: Math.round(dominantSat * 1000) / 1000,
  };
}

/** Метаданные итогового (после даунскейла и сведения) файла. */
export function wallpaperMeta(
  width: number,
  height: number,
  pixels: Uint8ClampedArray,
): WallpaperMeta {
  const measured = measurePixels(pixels);
  const meta: WallpaperMeta = {
    width,
    height,
    avg_luminance: measured.avg_luminance,
  };
  if (measured.dominant_hue !== null) meta.dominant_hue = measured.dominant_hue;
  if (measured.dominant_sat !== null) meta.dominant_sat = measured.dominant_sat;
  return meta;
}

/**
 * Плотность тинта: чем сильнее светлота картинки расходится со светлотой фона
 * темы (или слоя), тем плотнее вуаль — карточки и полоса фокуса остаются
 * читаемыми поверх любой картинки (сценарий 3fe62610; тонкая адаптация
 * производных — отдельная задача 26d53c26).
 */
export function wallpaperTintAlpha(
  imageLuminance: number,
  baseLuminance: number,
  inLayer: boolean,
): number {
  const delta = clamp(Math.abs(imageLuminance - baseLuminance) / WALLPAPER_TINT_DELTA_FULL, 0, 1);
  const alpha =
    WALLPAPER_TINT_ALPHA_MIN + (WALLPAPER_TINT_ALPHA_MAX - WALLPAPER_TINT_ALPHA_MIN) * delta;
  return clamp(inLayer ? alpha * WALLPAPER_TINT_LAYER_FACTOR : alpha, 0, 1);
}

/**
 * Плотность тинта прочих экранов: та же логика, что у карты, умноженная на
 * {@link WALLPAPER_SCREEN_TINT_FACTOR}. Вуаль слабее карты — инвариант,
 * который проверяет сторож `guard-wallpaper-tint.test.ts`.
 */
export function wallpaperScreenTintAlpha(
  imageLuminance: number,
  baseLuminance: number,
  inLayer: boolean,
): number {
  return clamp(
    wallpaperTintAlpha(imageLuminance, baseLuminance, inLayer) * WALLPAPER_SCREEN_TINT_FACTOR,
    0,
    1,
  );
}

/** `rgba(...)`-строка тинта для CSS-переменной подложки. */
export function wallpaperTintColor(base: [number, number, number], alpha: number): string {
  const a = Math.round(clamp(alpha, 0, 1) * 100) / 100;
  return `rgba(${base[0]}, ${base[1]}, ${base[2]}, ${a})`;
}

/** Человекочитаемый размер файла для сообщений об ошибке («5 МБ»). */
export function formatMegabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
