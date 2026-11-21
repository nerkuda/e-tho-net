/**
 * Адаптация пользовательских цветов под подложку темы (0.16.1, требование
 * 26d53c26, задача 6e171b39).
 *
 * Проверяется ЧИСЛАМИ и на РЕАЛЬНЫХ темах проекта (12 блоков тема × режим из
 * `lib/ui/themes/*.css`), а не на синтетических цветах:
 *
 *   • текст пользователя на подложке темы — ≥ 4.5 : 1 (WCAG AA);
 *   • фон слоя как поверхность — текст темы на нём ≥ 4.5 : 1 (этот же цвет
 *     уходит на экраны «Структуры»/«Дневник», где другого текста нет);
 *   • полоса фокуса — ≥ 3 : 1 у ВИДИМОЙ полосы (композит с
 *     `--focus-band-opacity`), в том числе поверх композита «тинт × картинка»
 *     при максимальной плотности тинта;
 *   • пара «цвет мысли × её фон» — ≥ 4.5 : 1;
 *   • граничные цвета (чёрный, белый, насыщенные жёлтый/красный/синий, пастель)
 *     не разгоняются в чистые #000/#fff: светлота производной ограничена;
 *     у полосы фокуса диапазон двухступенчатый — полный включается только при
 *     недостижимости порога в узком, поэтому пастель сохраняет цвет и тон;
 *   • исходные значения не меняются — модуль ничего не персистит и не мутирует
 *     входные данные;
 *   • повторный вызов с теми же входами не пересчитывает (кэш).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beforeEach, describe, it } from 'node:test';

import {
  ADAPT_LIGHT_MAX,
  ADAPT_LIGHT_MIN,
  FRAME_CONTRAST_MIN,
  FOCUS_BAND_OPACITY,
  TEXT_CONTRAST_MIN,
  adaptiveBandColor,
  adaptiveCacheStats,
  adaptiveColor,
  bandColor,
  bandContrast,
  cachedAdaptiveBandColor,
  cachedAdaptiveColor,
  canvasBackdrop,
  clearAdaptiveColorCache,
  contrastRatio,
  parseAlpha,
  wallpaperBackdrop,
} from '../src/renderer/lib/adaptive-color.js';
import {
  hslToRgb,
  parseCssColor,
  relativeLuminance,
  rgbToHsl,
} from '../src/renderer/lib/css-color.js';
import {
  WALLPAPER_TINT_ALPHA_MAX,
  WALLPAPER_TINT_ALPHA_MIN,
  wallpaperTintAlpha,
  wallpaperTintColor,
} from '../src/renderer/lib/wallpaper-image.js';
import {
  THEMES_DIR,
  THEME_MODES,
  declaredTokens,
  readTheme,
  themeBlockBody,
  type ThemeMode,
} from './theme-css.js';

const THEMES = fs
  .readdirSync(THEMES_DIR)
  .filter((file) => file.endsWith('.css'))
  .map((file) => file.replace(/\.css$/, ''))
  .sort();

/** Граничные пользовательские цвета: крайние и насыщенные. */
const USER_COLORS = ['#000000', '#ffffff', '#ff0000', '#ffff00', '#0000ff', '#ffd1dc'] as const;

/**
 * Цвета полосы для скана: граничные пользовательские и ДЕФОЛТНЫЕ цвета слоя
 * (`defaultLayerColors`, 0.6.4 — их получает каждый новый слой). Дефолты
 * сверяются сторожем `guard-adaptive-colors`, чтобы набор не разъехался.
 */
const BAND_COLORS = [
  '#000000',
  '#ffffff',
  '#ff0000',
  '#ffff00',
  '#0000ff',
  '#ffd1dc',
  '#7e57c2',
  '#191327',
  '#d1c2a2',
  '#e6d8f2',
] as const;

/** Реалистичные пары «текст мысли × фон мысли» (пользователь задаёт обе). */
const CLOUD_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['#000000', '#ffffff'],
  ['#ffffff', '#000000'],
  ['#ff0000', '#ffff00'],
  ['#ffff00', '#0000ff'],
  ['#0000ff', '#ffd1dc'],
  ['#ffd1dc', '#ff0000'],
];

interface ThemeBlock {
  theme: string;
  mode: ThemeMode;
  tokens: Map<string, string>;
}

function themeBlocks(): ThemeBlock[] {
  const blocks: ThemeBlock[] = [];
  for (const theme of THEMES) {
    const css = readTheme(theme);
    for (const mode of THEME_MODES) {
      const body = themeBlockBody(css, theme, mode);
      assert.ok(body !== null, `${theme} (${mode}): нет блока режима`);
      blocks.push({ theme, mode, tokens: declaredTokens(body) });
    }
  }
  return blocks;
}

function rgb(value: string): [number, number, number] {
  const parsed = parseCssColor(value);
  assert.ok(parsed !== null, `не цвет: ${value}`);
  return parsed;
}

function ratio(a: string, b: string): number {
  return contrastRatio(rgb(a), rgb(b));
}

/** Светлоты картинок, на которых проверяется полоса: от чёрной до белой. */
const IMAGE_LUMINANCES = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.95, 1] as const;

/**
 * Средняя точка картинки — локальная копия формулы яркость→канал. Считается в
 * ТЕСТЕ, а не берётся из модуля: иначе инвариант мерил бы ту же модель, что и
 * код, и не поймал бы её ошибку (круг 2 — обратный ход из α).
 */
function averageColor(luminance: number): [number, number, number] {
  const v = Math.min(1, Math.max(0, luminance));
  const channel = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  const gray = Math.round(Math.min(1, Math.max(0, channel)) * 255);
  return [gray, gray, gray];
}

/**
 * ФАКТИЧЕСКАЯ подложка карты: тинт цвета фона поверх средней точки картинки.
 * Плотность вуали — из той же CSS-переменной, что выставит продукт (с
 * множителем слоя `WALLPAPER_TINT_LAYER_FACTOR`), композит — обычная
 * альфа-смесь каналов, посчитанная здесь независимо от `wallpaperBackdrop`.
 */
function actualBackdrop(baseColor: string, imageLuminance: number, inLayer: boolean): string {
  const base = rgb(baseColor);
  const baseLuminance = relativeLuminance(base[0], base[1], base[2]);
  const tint = wallpaperTintColor(base, wallpaperTintAlpha(imageLuminance, baseLuminance, inLayer));
  const alpha = parseAlpha(tint);
  assert.ok(alpha !== null, `тинт не разобран: ${tint}`);
  const under = averageColor(imageLuminance);
  const composite = base.map((channel, i) => Math.round(alpha * channel + (1 - alpha) * under[i]!));
  return `rgb(${composite.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Арифметика и модель подложки
// ---------------------------------------------------------------------------

describe('адаптация цветов: арифметика и модель подложки', () => {
  it('контраст по WCAG: чёрный на белом — 21 : 1', () => {
    assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), 21);
    assert.equal(contrastRatio([255, 255, 255], [255, 255, 255]), 1);
  });

  it('альфа разбирается из rgba/hsla/#rrggbbaa, из непрозрачного — null', () => {
    assert.equal(parseAlpha('rgba(20, 30, 40, 0.3)'), 0.3);
    assert.equal(parseAlpha('rgba(20, 30, 40, 30%)'), 0.3);
    assert.ok(Math.abs((parseAlpha('#11223380') ?? 0) - 0x80 / 255) < 1e-9);
    assert.equal(parseAlpha('#ffffff'), null);
    assert.equal(parseAlpha(''), null);
  });

  it('тинт не складывается с фоном: с картинкой подложка — композит, без неё — фон', () => {
    // Без тинта подложка равна фону.
    assert.equal(canvasBackdrop('#eef0f4', null, null), '#eef0f4');
    // С тинтом — композит между фоном и средней светлотой картинки.
    const backdrop = wallpaperBackdrop('#eef0f4', 'rgba(238, 240, 244, 0.3)', 0.08);
    assert.ok(backdrop !== null);
    const pictureLuminance = relativeLuminance(...rgb(backdrop));
    const baseLuminance = relativeLuminance(...rgb('#eef0f4'));
    assert.ok(
      pictureLuminance < baseLuminance,
      'светлая подложка под плотной вуалью обязана темнеть',
    );
    // Вуаль отсутствует (тинт не разобран) — подложка остаётся фоном.
    assert.equal(wallpaperBackdrop('#eef0f4', 'transparent', 0.5), null);
    // Без средней светлоты картинки композит не выдумывается.
    assert.equal(wallpaperBackdrop('#eef0f4', 'rgba(238, 240, 244, 0.3)', null), null);
  });

  it('репро круга 2: белый фон слоя + чёрная картинка дают подложку rgb(61, 61, 61)', () => {
    // Плотность вуали слоя: 0.30 × WALLPAPER_TINT_LAYER_FACTOR = 0.24.
    const tint = wallpaperTintColor(rgb('#ffffff'), 0.24);
    assert.equal(wallpaperBackdrop('#ffffff', tint, 0), '#3d3d3d');
    // Обратный ход из α (прежняя модель) давал 0.5 светлоты картинки и светлую
    // подложку — на ней чёрная полоса «читалась» и не адаптировалась (1.72 : 1).
    assert.notEqual(wallpaperBackdrop('#ffffff', tint, 0), actualBackdrop('#ffffff', 0.5, true));
  });

  it('полоса полупрозрачна: видимый цвет — композит с подложкой, контраст ниже «в цвете»', () => {
    const backdrop = rgb('#eef0f4');
    const stripe = rgb('#643da8');
    const raw = contrastRatio(stripe, backdrop);
    const visible = bandContrast(stripe, backdrop);
    assert.ok(visible < raw, `видимая полоса контрастнее цвета (${visible} vs ${raw})`);
    assert.equal(
      visible,
      contrastRatio(bandColor(stripe, backdrop, FOCUS_BAND_OPACITY), backdrop),
      'видимая полоса считается как альфа-композит',
    );
  });
});

// ---------------------------------------------------------------------------
// DoD: 12 комбинаций тема × режим
// ---------------------------------------------------------------------------

describe('адаптация цветов: контраст во всех 12 комбинациях тема × режим', () => {
  it('текст пользователя на подложке темы ≥ 4.5 : 1', () => {
    const failures: string[] = [];
    let worst = { value: Number.POSITIVE_INFINITY, key: '' };
    for (const block of themeBlocks()) {
      const bg = block.tokens.get('--bg') ?? '';
      for (const color of USER_COLORS) {
        const adapted = adaptiveColor(color, [bg], TEXT_CONTRAST_MIN);
        const value = ratio(adapted, bg);
        if (value < worst.value) worst = { value, key: `${block.theme} ${block.mode} ${color}` };
        if (value < TEXT_CONTRAST_MIN) {
          failures.push(`${block.theme} ${block.mode} ${color} → ${adapted} ${value.toFixed(2)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `провалы контраста текста:\n  ${failures.join('\n  ')}`);
    assert.ok(worst.value >= TEXT_CONTRAST_MIN, `худший ${worst.value.toFixed(2)} (${worst.key})`);
  });

  it('фон слоя как поверхность: текст темы на нём ≥ 4.5 : 1', () => {
    const failures: string[] = [];
    for (const block of themeBlocks()) {
      const text = block.tokens.get('--text') ?? '';
      for (const color of USER_COLORS) {
        const adapted = adaptiveColor(color, [text], TEXT_CONTRAST_MIN);
        const value = ratio(adapted, text);
        if (value < TEXT_CONTRAST_MIN) {
          failures.push(`${block.theme} ${block.mode} ${color} → ${adapted} ${value.toFixed(2)}`);
        }
      }
    }
    assert.deepEqual(failures, [], `провалы контраста поверхности:\n  ${failures.join('\n  ')}`);
  });

  it('полоса фокуса ≥ 3 : 1 у видимой полосы на ФАКТИЧЕСКОМ композите (картинки 0…1)', () => {
    const failures: string[] = [];
    let worst = { value: Number.POSITIVE_INFINITY, key: '' };
    let checks = 0;
    for (const block of themeBlocks()) {
      const bg = block.tokens.get('--bg') ?? '';
      for (const inLayer of [false, true]) {
        for (const imageLuminance of IMAGE_LUMINANCES) {
          const backdrop = actualBackdrop(bg, imageLuminance, inLayer);
          for (const color of BAND_COLORS) {
            const stripe = adaptiveBandColor(color, backdrop);
            const value = bandContrast(rgb(stripe), rgb(backdrop));
            checks += 1;
            const key =
              `${block.theme} ${block.mode} ${color} ${inLayer ? 'слой' : 'основа'} ` +
              `картинка ${imageLuminance}`;
            if (value < worst.value) worst = { value, key };
            if (value < FRAME_CONTRAST_MIN) {
              failures.push(`${key} → ${stripe} ${value.toFixed(2)}`);
            }
          }
        }
      }
    }
    assert.ok(checks >= 12 * 2 * IMAGE_LUMINANCES.length * BAND_COLORS.length);
    assert.deepEqual(failures, [], `провалы контраста полосы:\n  ${failures.join('\n  ')}`);
    assert.ok(
      worst.value >= FRAME_CONTRAST_MIN,
      `худшая полоса ${worst.value.toFixed(2)} : 1 (${worst.key})`,
    );
  });

  it('пара «цвет мысли × её фон» ≥ 4.5 : 1', () => {
    const failures: string[] = [];
    for (const block of themeBlocks()) {
      for (const [fg, bg] of CLOUD_PAIRS) {
        const adapted = adaptiveColor(fg, [bg], TEXT_CONTRAST_MIN);
        const value = ratio(adapted, bg);
        if (value < TEXT_CONTRAST_MIN) {
          failures.push(
            `${block.theme} ${block.mode} ${fg}/${bg} → ${adapted} ${value.toFixed(2)}`,
          );
        }
      }
    }
    assert.deepEqual(failures, [], `провалы контраста мысли:\n  ${failures.join('\n  ')}`);
  });

  it('тинт доходит до максимальной плотности, а не «где-то рядом»', () => {
    for (const block of themeBlocks()) {
      const bg = rgb(block.tokens.get('--bg') ?? '');
      const baseLuminance = relativeLuminance(bg[0], bg[1], bg[2]);
      const picture = baseLuminance > 0.5 ? 0 : 1;
      assert.equal(
        wallpaperTintAlpha(picture, baseLuminance, false),
        WALLPAPER_TINT_ALPHA_MAX,
        `${block.theme} (${block.mode}): худший тинт обязан быть максимальным`,
      );
      assert.ok(WALLPAPER_TINT_ALPHA_MIN > 0, 'вуаль не может исчезать совсем');
    }
  });
});

// ---------------------------------------------------------------------------
// Граничные цвета и диапазон производных
// ---------------------------------------------------------------------------

describe('адаптация цветов: граничные цвета и диапазон производных', () => {
  it('цвет, уже читаемый на подложке, возвращается без изменений', () => {
    for (const block of themeBlocks()) {
      const bg = block.tokens.get('--bg') ?? '';
      const text = block.tokens.get('--text') ?? '';
      assert.equal(
        adaptiveColor(text, [bg], TEXT_CONTRAST_MIN),
        text,
        `${block.theme} (${block.mode}): читаемый текст перекрашен`,
      );
    }
  });

  it('производная не уходит в чистые #000/#fff: светлота в допустимом диапазоне', () => {
    let adaptedCount = 0;
    for (const color of USER_COLORS) {
      for (const backdrop of ['#ffffff', '#000000', '#808080']) {
        for (const target of [TEXT_CONTRAST_MIN, FRAME_CONTRAST_MIN]) {
          const adapted = adaptiveColor(color, [backdrop], target);
          // Уже читаемый цвет не перекрашивается — диапазон проверяем только у
          // тех цветов, которые алгоритм действительно сдвинул.
          if (adapted === color) continue;
          adaptedCount += 1;
          const lightness = rgbToHsl(rgb(adapted))[2];
          assert.ok(
            lightness >= ADAPT_LIGHT_MIN - 1e-9 && lightness <= ADAPT_LIGHT_MAX + 1e-9,
            `${color} на ${backdrop}: светлота ${lightness.toFixed(3)} вне диапазона`,
          );
        }
      }
    }
    assert.ok(adaptedCount >= 10, `диапазон проверен на ${adaptedCount} производных`);
  });

  it('насыщенность сохраняется, пока читаемость достижима без обесцвечивания', () => {
    // Насыщенный жёлтый на светлой подложке: светлота спускается, тон остаётся.
    const adapted = adaptiveColor('#ffff00', ['#eef0f4'], TEXT_CONTRAST_MIN);
    const [hue, sat] = rgbToHsl(rgb(adapted));
    assert.ok(Math.abs(hue - 60) < 1, `тон уехал: ${hue.toFixed(1)}°`);
    assert.ok(sat > 0.9, `насыщенность потеряна: ${sat.toFixed(2)}`);
  });

  it('нечитаемый вход (не цвет) возвращается как есть — без выдуманных подстановок', () => {
    assert.equal(adaptiveColor('не цвет', ['#ffffff'], TEXT_CONTRAST_MIN), 'не цвет');
    assert.equal(adaptiveColor('#ff0000', [], TEXT_CONTRAST_MIN), '#ff0000');
    assert.equal(adaptiveBandColor('#ff0000', 'не цвет'), '#ff0000');
  });

  it('граничная подложка: чёрная полоса и #e0e0e0 вытягиваются до 3 : 1 (блокер 2)', () => {
    // Прежний фиксированный бюджет шагов упирался в L=0.88 и давал 2.97 : 1.
    for (const [stripe, backdrop] of [
      ['#000000', 'rgb(104, 105, 107)'],
      ['#e0e0e0', 'rgb(104, 103, 107)'],
    ] as const) {
      const adapted = adaptiveBandColor(stripe, backdrop);
      const value = bandContrast(rgb(adapted), rgb(backdrop));
      assert.ok(
        value >= FRAME_CONTRAST_MIN,
        `${stripe} на ${backdrop} → ${adapted} ${value.toFixed(3)} : 1`,
      );
    }
  });

  it('полоса: на подложке без запаса контраста цвет уводится от неё, а не «в цвет»', () => {
    const adapted = adaptiveBandColor('#000000', '#101010');
    assert.ok(
      bandContrast(rgb(adapted), rgb('#101010')) >= FRAME_CONTRAST_MIN,
      `чёрная полоса на тёмном холсте осталась нечитаемой (${adapted})`,
    );
  });
});

// ---------------------------------------------------------------------------
// Кэш и неизменность исходников
// ---------------------------------------------------------------------------

describe('адаптация цветов: кэш производных и неизменность исходников', () => {
  beforeEach(() => {
    clearAdaptiveColorCache();
  });

  it('повторный вызов с теми же входами не пересчитывает', () => {
    const backdrops = ['#eef0f4'];
    const first = cachedAdaptiveColor('#ff0000', backdrops, TEXT_CONTRAST_MIN, 'current|light');
    const second = cachedAdaptiveColor('#ff0000', backdrops, TEXT_CONTRAST_MIN, 'current|light');
    assert.equal(second, first);
    assert.deepEqual(
      { computes: adaptiveCacheStats.computes, hits: adaptiveCacheStats.hits },
      { computes: 1, hits: 1 },
    );
  });

  it('другая тема/режим — другой ключ: производная считается заново', () => {
    const backdrops = ['#1a1d23'];
    cachedAdaptiveColor('#ff0000', backdrops, TEXT_CONTRAST_MIN, 'current|dark');
    assert.equal(adaptiveCacheStats.computes, 1);
    cachedAdaptiveColor('#ff0000', backdrops, TEXT_CONTRAST_MIN, 'nordic|dark');
    assert.equal(adaptiveCacheStats.computes, 2);
    assert.equal(adaptiveCacheStats.hits, 0);
  });

  it('кэш полосы отделён от кэша текста: разные пороги — разные ключи', () => {
    const band = cachedAdaptiveBandColor('#ffffff', '#eef0f4', 'current|light');
    const text = cachedAdaptiveColor('#ffffff', ['#eef0f4'], TEXT_CONTRAST_MIN, 'current|light');
    assert.ok(
      bandContrast(rgb(band), rgb('#eef0f4')) >= FRAME_CONTRAST_MIN,
      `видимая полоса не читается (${band})`,
    );
    assert.ok(ratio(text, '#eef0f4') >= TEXT_CONTRAST_MIN, `текст не читается (${text})`);
    // Общий ключ дал бы попадание на втором вызове — здесь его быть не может.
    assert.equal(adaptiveCacheStats.computes, 2);
    assert.equal(adaptiveCacheStats.hits, 0);
  });

  it('исходные данные не мутируются: ни строки, ни массив подложек', () => {
    const backdrops = ['#eef0f4', '#101010'];
    const snapshot = [...backdrops];
    const source = '#ff0000';
    const adapted = adaptiveColor(source, backdrops, TEXT_CONTRAST_MIN);
    assert.equal(source, '#ff0000');
    assert.deepEqual(backdrops, snapshot);
    assert.notEqual(adapted, source, 'адаптация обязана вернуть производную, а не вход');
  });

  it('очистка кэша сбрасывает счётчики и пересчитывает', () => {
    const backdrops = ['#eef0f4'];
    cachedAdaptiveColor('#00ff00', backdrops, TEXT_CONTRAST_MIN, 'current|light');
    clearAdaptiveColorCache();
    assert.deepEqual(
      { computes: adaptiveCacheStats.computes, hits: adaptiveCacheStats.hits },
      { computes: 0, hits: 0 },
    );
    cachedAdaptiveColor('#00ff00', backdrops, TEXT_CONTRAST_MIN, 'current|light');
    assert.equal(adaptiveCacheStats.computes, 1);
  });
});

// ---------------------------------------------------------------------------
// Круг 3: диапазон полосы — узкий первым, полный только при недостижимости
// ---------------------------------------------------------------------------

/**
 * Независимый перебор УЗКОГО диапазона: тон и насыщенность полосы
 * сохраняются, светлота — абсолютная 0.06…0.94. Возвращает максимальный
 * видимый контраст. Считается в тесте, а не модулем: иначе инвариант мерил бы
 * тот же алгоритм, что и код.
 */
function narrowReach(stripe: string, backdrop: string): number {
  const source = rgb(stripe);
  const back = rgb(backdrop);
  const [hue, sat] = rgbToHsl(source);
  let best = bandContrast(source, back);
  for (const scale of [1, 0.75, 0.5, 0.25, 0]) {
    for (let i = 6; i <= 94; i += 1) {
      const candidate = hslToRgb(hue, sat * scale, i / 100).map(Math.round) as [
        number,
        number,
        number,
      ];
      const value = bandContrast(candidate, back);
      if (value > best) best = value;
    }
  }
  return best;
}

describe('диапазон полосы: узкий первым, полный — только при недостижимости', () => {
  it('пастель сохраняет цвет и тон на средней подложке (не уезжает в #fff)', () => {
    const backdrop = 'rgb(116, 116, 116)';
    const adapted = adaptiveBandColor('#ffd1dc', backdrop);
    assert.notEqual(adapted, '#ffffff', `пастель уехала в чистый белый: ${adapted}`);
    assert.ok(narrowReach('#ffd1dc', backdrop) >= FRAME_CONTRAST_MIN, 'проба выбрана неверно: узкий диапазон недостижим');
    const [hue, sat, light] = rgbToHsl(rgb(adapted));
    assert.ok(
      light >= ADAPT_LIGHT_MIN - 1e-9 && light <= ADAPT_LIGHT_MAX + 1e-9,
      `светлота производной ${light.toFixed(3)} вне узкого диапазона`,
    );
    assert.ok(sat > 0.5, `тон полосы обесцвечен (s=${sat.toFixed(2)}, h=${hue})`);
    assert.ok(bandContrast(rgb(adapted), rgb(backdrop)) >= FRAME_CONTRAST_MIN);
    // Значение продукта на этой паре (тон сохранён, полоса тёмно-вишнёвая).
    assert.equal(adapted, '#29000a');
  });

  it('полный диапазон включается, когда в узком порог недостижим', () => {
    const backdrop = 'rgb(116, 116, 116)';
    assert.ok(narrowReach('#808080', backdrop) < FRAME_CONTRAST_MIN, 'проба выбрана неверно');
    const adapted = adaptiveBandColor('#808080', backdrop);
    assert.ok(
      bandContrast(rgb(adapted), rgb(backdrop)) >= FRAME_CONTRAST_MIN,
      `полоса не дотянула порог: ${adapted}`,
    );
    assert.ok(
      rgbToHsl(rgb(adapted))[2] < ADAPT_LIGHT_MIN - 1e-9,
      `полоса осталась в узком диапазоне: ${adapted}`,
    );
  });

  it('проводка сторожа: чёрная полоса на rgb(61, 61, 61) → #a6a6a6', () => {
    // Ровно значение живой проводки (светлый слой + чёрная картинка).
    assert.equal(adaptiveBandColor('#000000', 'rgb(61, 61, 61)'), '#a6a6a6');
  });

  it('поправка формулировки: «предел 2.95» — про НЕЙТРАЛЬНЫЕ полосы', () => {
    // Нейтральная серая упирается в 2.95 — расширение диапазона обязательно.
    assert.ok(narrowReach('#808080', 'rgb(116, 116, 116)') < FRAME_CONTRAST_MIN);
    // Цветная #00001f на той же подложке проходит порог уже как есть (3.277).
    assert.ok(bandContrast(rgb('#00001f'), rgb('rgb(116, 116, 116)')) >= FRAME_CONTRAST_MIN);
  });
});
