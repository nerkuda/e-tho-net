/**
 * Рамки трёх состояний мысли на карте (задача c6d74fd4): ОТКРЫТАЯ (гало —
 * мысль открыта в редакторе), ТЕКУЩАЯ (пунктир клавиатурного курсора) и
 * ВЫДЕЛЕННАЯ (Ctrl+клик, панель выделения).
 *
 * **Зачем модуль.** До 0.16.1 цвета рамок задавались в CSS литералами темы:
 * `--focus-ring-contrast` (кант 4px, в светлых темах почти чёрный — «траурная
 * рамка»), `--cursor` (пунктир) и `--selection` (выделение). От цвета полосы
 * активного слоя зависел только внутренний 1px гало, перекрытый кантом темы,
 * поэтому при слое с собственной полосой рамки не менялись вовсе (вопрос
 * заказчика 2026-11-13). Здесь три цвета считаются ОДНИМ расчётом:
 *
 *   • базовый слой/без своей полосы — от токенов темы: текущая = `--cursor`,
 *     выделенная = `--selection` (они уже тематизированы, задача 7a652ce8),
 *     открытая = тот же тон курсора, поднятый по светлоте («в тон, но ярче»);
 *   • активный слой со своей полосой — ВСЕ ТРИ производны от
 *     `--layer-focus-stripe`: открытая — полоса, сдвинутая по светлоте
 *     (в сторону, где она контрастнее фона холста), текущая и выделенная —
 *     поворот тона ±{@link CLOUD_FRAME_HUE_STEP} от полосы. Ахроматичная
 *     полоса (серый, чёрный, белый) тона не имеет — её три состояния
 *     разводятся лестницей по светлоте.
 *
 * Результат пишется в `--frame-open` / `--frame-current` / `--frame-selected`
 * на корне документа (lib/layer-colors.ts, тот же тик store, что и `--layer-*`)
 * — поэтому смена темы или цвета полосы перекрашивает все три рамки синхронно,
 * без перезагрузки и без stale-класса (ошибка f245c5ac).
 *
 * Модуль чистый (без DOM) — его инварианты проверяет сторож
 * `client/tests/guard-cloud-state-frames.test.ts`.
 */

import { hslToRgb, parseCssColor, relativeLuminance, rgbToHsl } from './css-color.js';

/** Минимальный контраст рамки к фону холста (WCAG 2.1; как в сторожах). */
export const CLOUD_FRAME_CONTRAST_MIN = 3;

/**
 * Минимальное попарное расстояние трёх состояний — евклидово расстояние по
 * каналам sRGB 0..255 (та же метрика, что в `guard-canvas-overlay-layers` и
 * `guard-wallpaper-tint`; порог 40 там же).
 */
export const CLOUD_FRAME_DISTANCE_MIN = 40;

/**
 * Минимальное расстояние оттенков открытой рамки МЕЖДУ темами: темы обязаны
 * различаться цветом рамки, а не переиспользовать один и тот же. Фактический
 * минимум по 12 блокам — 37.4 (catppuccin dark ↔ current dark), порог взят с
 * запасом.
 */
export const CLOUD_FRAME_THEME_DISTANCE_MIN = 25;

/**
 * Цветное кольцо открытой рамки, px: одно кольцо `box-shadow` ПОВЕРХ 1px
 * `border` того же цвета — видимая цветная полоса 2px.
 */
export const CLOUD_FRAME_RING_PX = 1;

/**
 * Контрастный кант открытой рамки, px. Был 4px почти чёрного цвета темы
 * («траурная рамка» в светлых темах, замечание заказчика): кант оставлен
 * 1px — он несёт читаемость, но не давит. Именованный параметр, чтобы
 * мутация «вернуть 4px» краснила сторож.
 */
export const CLOUD_FRAME_HAIRLINE_PX = 1;

/**
 * Суммарный отступ канта от края облачка (spread внешнего кольца box-shadow):
 * цветное кольцо + кант, px.
 */
export const CLOUD_FRAME_HAIRLINE_OFFSET_PX = CLOUD_FRAME_RING_PX + CLOUD_FRAME_HAIRLINE_PX;

/** Подъём светлоты открытой рамки в теме (доля HSL L): «в тон, но ярче». */
export const CLOUD_FRAME_OPEN_LIFT = 0.12;

/** Подъём насыщенности открытой рамки в теме (доля HSL S). */
export const CLOUD_FRAME_OPEN_SAT_LIFT = 0.1;

/** Поворот тона текущего/выделенного от полосы активного слоя, градусы. */
export const CLOUD_FRAME_HUE_STEP = 42;

/** Сдвиг светлоты открытой рамки от полосы слоя (доля HSL L). */
export const CLOUD_FRAME_LAYER_OPEN_LIFT = 0.18;

/** Выше этой светлоты полосу «ярче» уже не поднять — открытая темнеет. */
export const CLOUD_FRAME_LAYER_OPEN_DARKEN_ABOVE = 0.7;

/**
 * Рабочая светлота повёрнутых рамок слоя. У полос крайней светлоты (почти
 * белая, почти чёрная) поворот тона при собственной светлоте не виден в
 * sRGB — цвета схлопываются; поэтому повёрнутые рамки считаются в безопасной
 * полосе [0.25, 0.75] (разброс хромы там максимален).
 */
export const CLOUD_FRAME_ROTATED_LIGHT_MIN = 0.25;
export const CLOUD_FRAME_ROTATED_LIGHT_MAX = 0.75;

/** Шаг лестницы светлоты для ахроматичной полосы (серая, чёрная, белая). */
export const CLOUD_FRAME_ACHROMATIC_STEP = 0.3;

/** Ниже этой насыщенности полоса считается ахроматичной: тон не крутится. */
export const CLOUD_FRAME_ACHROMATIC_SAT = 0.08;

/** Цвета трёх состояний, `#rrggbb`. */
export interface CloudFrameColors {
  open: string;
  current: string;
  selected: string;
}

/**
 * Источники цвета рамок: полоса активного слоя (`null` — базовый слой) и
 * токены темы. Значения — как их отдаёт `getComputedStyle` (hex/rgb/hsl).
 */
export interface CloudFrameSources {
  /** `--layer-focus-stripe` активного слоя; `null` — полосы нет (базовый). */
  stripe: string | null;
  /** `--cursor` темы — цвет пунктирной рамки текущего элемента. */
  cursor: string;
  /** `--selection` темы — цвет рамки выделенных мыслей. */
  selection: string;
  /** Фон холста: `--layer-bg` слоя, иначе `--bg` темы (инвариант контраста). */
  background: string;
}

/** Минимальный интерфейс объявлений стиля (CSSStyleDeclaration в рендерере). */
export interface CloudFrameStyleTarget {
  setProperty(name: string, value: string): void;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Контраст двух цветов по WCAG 2.1 (1..21). */
export function frameContrast(a: readonly number[], b: readonly number[]): number {
  const la = relativeLuminance(a[0]!, a[1]!, a[2]!);
  const lb = relativeLuminance(b[0]!, b[1]!, b[2]!);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Расстояние цветов в sRGB (евклидово по каналам 0..255). */
export function frameDistance(a: readonly number[], b: readonly number[]): number {
  return Math.sqrt((a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2);
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

/**
 * Открытая рамка от токена темы: тот же тон, что у пунктира (`--cursor`), но
 * светлее и насыщеннее. Подъём ограничен сверху контрастом к фону холста:
 * если выбранный подъём уводит рамку ниже {@link CLOUD_FRAME_CONTRAST_MIN},
 * он уменьшается шагом 0.01 — так рамка остаётся читаемой на светлых темах
 * (catppuccin light — 3.02 : 1 при подъёме 0.12).
 */
function themeOpen(cursor: readonly number[], background: readonly number[]): number[] {
  const [hue, sat, light] = rgbToHsl(cursor);
  const sat2 = Math.min(1, sat + CLOUD_FRAME_OPEN_SAT_LIFT);
  for (let lift = CLOUD_FRAME_OPEN_LIFT; lift > 0; lift -= 0.01) {
    const candidate = hslToRgb(hue, sat2, clamp01(light + lift));
    if (frameContrast(candidate, background) >= CLOUD_FRAME_CONTRAST_MIN) return candidate;
  }
  return hslToRgb(hue, sat2, light);
}

/**
 * Гарантия читаемости: если контраст цвета к фону холста ниже
 * {@link CLOUD_FRAME_CONTRAST_MIN}, светлота сдвигается шагом 0.02 в сторону
 * от фона (на светлом фоне — темнее, на тёмном — светлее), пока рамка не
 * станет читаемой. Тон и насыщенность сохраняются — цвет остаётся в семействе
 * полосы слоя. Нужно крайним полосам: жёлтая на светлом холсте давала кольцо
 * 2.49 : 1, белая на белом — 2.14 : 1.
 */
function ensureContrast(
  rgb: readonly number[],
  background: readonly number[],
): number[] {
  if (frameContrast(rgb, background) >= CLOUD_FRAME_CONTRAST_MIN) return [...rgb];
  const [hue, sat, light] = rgbToHsl([rgb[0]!, rgb[1]!, rgb[2]!]);
  const dir = rgbToHsl([background[0]!, background[1]!, background[2]!])[2] > 0.5 ? -1 : 1;
  let best: number[] = [...rgb];
  let bestContrast = frameContrast(rgb, background);
  for (let step = 1; step <= 45; step += 1) {
    const candidate = hslToRgb(hue, sat, clamp01(light + dir * 0.02 * step));
    const contrast = frameContrast(candidate, background);
    if (contrast > bestContrast) {
      best = candidate;
      bestContrast = contrast;
    }
    if (contrast >= CLOUD_FRAME_CONTRAST_MIN) return candidate;
  }
  return best;
}

/**
 * Направление сдвига светлоты открытой рамки: из двух допустимых (упирающиеся
 * в границу шкалы отброшены) берётся то, где кольцо контрастнее фона холста.
 * Одно допустимое — оно и берётся.
 */
function pickDirection(
  up: readonly number[] | null,
  down: readonly number[] | null,
  background: readonly number[],
): 1 | -1 {
  if (up === null) return -1;
  if (down === null) return 1;
  return frameContrast(up, background) >= frameContrast(down, background) ? 1 : -1;
}

/**
 * Три состояния от ЦВЕТНОЙ полосы слоя: открытая — полоса со сдвигом
 * светлоты, текущая и выделенная — поворот тона от полосы. Сдвиг светлоты идёт
 * в сторону, где кольцо КОНТРАСТНЕЕ фона холста (на светлом фоне — темнее, на
 * тёмном — светлее): читаемость важнее направления, цвет остаётся в семействе
 * полосы. У почти белой полосы вверх уже некуда — только вниз. Повёрнутые
 * считаются в безопасной полосе светлоты, иначе у крайних полос поворот тона
 * не даёт различия.
 */
function chromaticFrames(
  hue: number,
  sat: number,
  light: number,
  background: readonly number[],
): { open: number[]; current: number[]; selected: number[] } {
  const lift = CLOUD_FRAME_LAYER_OPEN_LIFT;
  const candidate = (dir: 1 | -1): number[] =>
    hslToRgb(hue, Math.min(1, sat + 0.05), clamp01(light + lift * dir));
  const dir = pickDirection(
    light > CLOUD_FRAME_LAYER_OPEN_DARKEN_ABOVE ? null : candidate(1),
    light >= lift ? candidate(-1) : null,
    background,
  );
  const base = Math.min(
    CLOUD_FRAME_ROTATED_LIGHT_MAX,
    Math.max(CLOUD_FRAME_ROTATED_LIGHT_MIN, light),
  );
  return {
    open: ensureContrast(candidate(dir), background),
    current: hslToRgb(hue + CLOUD_FRAME_HUE_STEP, sat, base),
    selected: hslToRgb(hue - CLOUD_FRAME_HUE_STEP, sat, base),
  };
}

/**
 * Две следующие ступени серой лестницы (доли HSL L). Идём от светлоты
 * открытой шагом {@link CLOUD_FRAME_ACHROMATIC_STEP} в выбранную сторону;
 * ступень, упёршаяся в границу шкалы, совпавшая со светлотой полосы фокуса
 * (рамка растворилась бы в ней) или с уже занятой ступенью, перебирается на
 * другую сторону. Шаг 0.3 ≈ 77 sRGB — выше порога различимости.
 */
function spreadAchromatic(
  openLight: number,
  stripeLight: number,
  dir: 1 | -1,
  step: number,
): [number, number] {
  const taken = [openLight, stripeLight];
  const levels: number[] = [];
  const minGap = step * 0.6;
  for (let round = 0; round < 2; round += 1) {
    let picked: number | null = null;
    for (let distance = 1; distance <= 4 && picked === null; distance += 1) {
      for (const sign of [dir, -dir]) {
        const value = clamp01(openLight + sign * step * distance);
        if (taken.every((other) => Math.abs(value - other) >= minGap)) {
          picked = value;
          break;
        }
      }
    }
    // Обе стороны шкалы заняты (нереальный случай) — берём край, он точно
    // отличим от середины лестницы.
    const level = picked ?? (levels[0] !== undefined && levels[0] < 0.5 ? 1 : 0);
    levels.push(level);
    taken.push(level);
  }
  return [levels[0]!, levels[1]!];
}

/**
 * Три состояния от АХРОМАТИЧНОЙ полосы: тона нет, поэтому единственный канал
 * различия — светлота. Открытая — шаг в сторону, где серый контрастнее фона
 * холста (плюс гарантия контраста), две остальные ступени разводит
 * {@link spreadAchromatic}.
 */
function achromaticFrames(
  hue: number,
  sat: number,
  light: number,
  background: readonly number[],
): { open: number[]; current: number[]; selected: number[] } {
  const step = CLOUD_FRAME_ACHROMATIC_STEP;
  const candidate = (dir: 1 | -1): number[] => hslToRgb(hue, sat, clamp01(light + step * dir));
  const dir = pickDirection(
    light <= 1 - step ? candidate(1) : null,
    light >= step ? candidate(-1) : null,
    background,
  );
  const open = ensureContrast(candidate(dir), background);
  const openLight = rgbToHsl([open[0]!, open[1]!, open[2]!])[2];
  const [current, selected] = spreadAchromatic(openLight, light, dir, step);
  return {
    open,
    current: hslToRgb(hue, sat, current),
    selected: hslToRgb(hue, sat, selected),
  };
}

/**
 * Рамки трёх состояний. `null` — входные цвета не разобраны (CSS-фолбэки
 * остаются в силе): молча подставлять чужие литералы нельзя, рамка потеряла бы
 * тему.
 */
export function cloudFrameColors(sources: CloudFrameSources): CloudFrameColors | null {
  const cursor = parseCssColor(sources.cursor);
  const selection = parseCssColor(sources.selection);
  const background = parseCssColor(sources.background);
  if (cursor === null || selection === null || background === null) return null;

  const stripe = sources.stripe === null ? null : parseCssColor(sources.stripe);
  if (stripe === null) {
    return {
      open: hexOf(themeOpen(cursor, background)),
      current: hexOf(cursor),
      selected: hexOf(selection),
    };
  }

  const [hue, sat, light] = rgbToHsl(stripe);
  const frames =
    sat < CLOUD_FRAME_ACHROMATIC_SAT
      ? achromaticFrames(hue, sat, light, background)
      : chromaticFrames(hue, sat, light, background);
  return {
    open: hexOf(frames.open),
    current: hexOf(frames.current),
    selected: hexOf(frames.selected),
  };
}

/** Записать цвета трёх рамок на корень документа (`--frame-*`). */
export function applyCloudFrameStyle(style: CloudFrameStyleTarget, colors: CloudFrameColors): void {
  style.setProperty('--frame-open', colors.open);
  style.setProperty('--frame-current', colors.current);
  style.setProperty('--frame-selected', colors.selected);
}
