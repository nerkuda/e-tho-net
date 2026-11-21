/**
 * Сторож тема-осведомлённой адаптации пользовательских цветов (0.16.1,
 * требование 26d53c26, задача 6e171b39).
 *
 * Правило. Пользовательские цвета слоя (`layers.colors`) и цвета типов/мыслей —
 * данные пользователя и не переписываются. На экран идут ПРОИЗВОДНЫЕ под
 * фактическую подложку активной темы и режима: один модуль
 * `lib/adaptive-color.ts` (алгоритм) + `lib/adaptive-context.ts` (контекст из
 * DOM). Прямая инверсия светлоты в диалоге «Свойства слоя» запрещена — второй
 * алгоритм рядом не заводим.
 *
 * Инварианты (числами, на РЕАЛЬНЫХ темах проекта):
 *   • текст пользователя на подложке темы ≥ 4.5 : 1, фон слоя как поверхность
 *     (текст темы) ≥ 4.5 : 1, пара «цвет мысли × фон» ≥ 4.5 : 1;
 *   • полоса фокуса ≥ 3 : 1 у ВИДИМОЙ полосы (композит с
 *     `--focus-band-opacity`), в том числе на композите «тинт × картинка»;
 *   • диапазон полосы двухступенчатый: узкий первым — пастель сохраняет цвет
 *     и тон там, где порог достижим, полный включается только при
 *     недостижимости;
 *   • кольца фокуса ЭКРАНОВ (`--layer-focus-ring-screen`) ≥ 3 : 1 к `--surface`
 *     и к фактической поверхности слоя; на карте остаётся полоса
 *     (`--layer-focus-stripe`);
 *   • светлота производной ограничена [`ADAPT_LIGHT_MIN`, `ADAPT_LIGHT_MAX`].
 *
 * Негативные пробы (минимум три краснят):
 *   1) адаптация отключена (исходный цвет как есть);
 *   2) порог контраста снижен;
 *   3) плотность слоя полосы проигнорирована (контраст «в цвете» вместо
 *      видимого);
 *   4) в диалог возвращена прямая инверсия светлоты;
 *   5) в `refreshLayerTheme` пишутся исходные цвета вместо производных;
 *   6) слой тинта в `canvas.css` опущен под картинку (модель подложки);
 *   7) `applyCloudStyle` вернулся к исходным цветам без адаптации;
 *   8) признак слоя потерян в проводке (`background !== null` → константа) —
 *      плотность тинта считается как для основы;
 *   9) экранное кольцо снова берёт полосу карты;
 *  10) полоса ограничена только узким диапазоном (пастель уезжает в #fff).
 *
 * Плюс живая проводка: `refreshLayerTheme()` читает настоящее состояние
 * картинки (подменённый `WallpaperState` идёт через `refreshWallpaper`), пишет
 * адаптированные `--layer-*`, а цвета в сторе остаются ровно теми, что задал
 * пользователь.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  ADAPT_LIGHT_MAX,
  ADAPT_LIGHT_MIN,
  FRAME_CONTRAST_MIN,
  FOCUS_BAND_OPACITY,
  TEXT_CONTRAST_MIN,
  adaptiveBandColor,
  adaptiveColor,
  bandContrast,
  canvasBackdrop,
  clearAdaptiveColorCache,
  contrastRatio,
  parseAlpha,
} from '../src/renderer/lib/adaptive-color.js';
import { defaultLayerColors } from '../src/renderer/lib/layer-colors.js';
import {
  hslToRgb,
  parseCssColor,
  relativeLuminance,
  rgbToHsl,
} from '../src/renderer/lib/css-color.js';
import {
  WALLPAPER_TINT_ALPHA_MAX,
  WALLPAPER_TINT_ALPHA_MIN,
  WALLPAPER_TINT_DELTA_FULL,
  wallpaperTintAlpha,
  wallpaperTintColor,
} from '../src/renderer/lib/wallpaper-image.js';
import type { WallpaperState } from '../src/main/ipc/contract.js';
import { store } from '../src/renderer/state.js';
import { refreshWallpaper, resetWallpaperState } from '../src/renderer/lib/wallpaper-state.js';
import { ShimElement } from './dom-shim.js';
import { RENDERER_ROOT } from './renderer-css.js';
import {
  THEMES_DIR,
  THEME_MODES,
  declaredTokens,
  readTheme,
  stripCssComments,
  themeBlockBody,
  type ThemeMode,
} from './theme-css.js';

const THEMES = fs
  .readdirSync(THEMES_DIR)
  .filter((file) => file.endsWith('.css'))
  .map((file) => file.replace(/\.css$/, ''))
  .sort();

const CANVAS_CSS = fs.readFileSync(path.join(RENDERER_ROOT, 'styles', 'canvas.css'), 'utf8');
const TOKENS_CSS = fs.readFileSync(path.join(RENDERER_ROOT, 'styles', 'tokens.css'), 'utf8');
const LAYER_COLORS_TS = fs.readFileSync(path.join(RENDERER_ROOT, 'lib', 'layer-colors.ts'), 'utf8');
const THOUGHT_CLOUD_TS = fs.readFileSync(
  path.join(RENDERER_ROOT, 'lib', 'thought-cloud.ts'),
  'utf8',
);
const SCREEN_LAYERS_TS = fs.readFileSync(path.join(RENDERER_ROOT, 'screens', 'layers.ts'), 'utf8');
const LINKS_TS = fs.readFileSync(path.join(RENDERER_ROOT, 'canvas', 'links.ts'), 'utf8');
const ADAPTIVE_COLOR_TS = fs.readFileSync(
  path.join(RENDERER_ROOT, 'lib', 'adaptive-color.ts'),
  'utf8',
);
const ADAPTIVE_CONTEXT_TS = fs.readFileSync(
  path.join(RENDERER_ROOT, 'lib', 'adaptive-context.ts'),
  'utf8',
);

/** CSS экранных колец фокуса: таблицы, редактор, списки, дневник, публикации. */
const SCREEN_RING_CSS = [
  path.join(RENDERER_ROOT, 'lib', 'ui', 'table.css'),
  path.join(RENDERER_ROOT, 'styles', 'editor.css'),
  path.join(RENDERER_ROOT, 'styles', 'filter-tree.css'),
  path.join(RENDERER_ROOT, 'styles', 'screens', 'chronicle.css'),
  path.join(RENDERER_ROOT, 'styles', 'screens', 'search.css'),
  path.join(RENDERER_ROOT, 'styles', 'screens', 'publications.css'),
  path.join(RENDERER_ROOT, 'styles', 'screens', 'onboarding-networks.css'),
]
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');

/** Граничные пользовательские цвета. */
const USER_COLORS = ['#000000', '#ffffff', '#ff0000', '#ffff00', '#0000ff', '#ffd1dc'] as const;

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

/** Светлоты картинок для скана: от чёрной до белой. */
const IMAGE_LUMINANCES = [0, 0.05, 0.2, 0.5, 0.8, 1] as const;

/** Средняя точка картинки — локальная формула (в тесте, не из модуля). */
function averageColor(luminance: number): [number, number, number] {
  const v = Math.min(1, Math.max(0, luminance));
  const channel = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  const gray = Math.round(Math.min(1, Math.max(0, channel)) * 255);
  return [gray, gray, gray];
}

/**
 * ФАКТИЧЕСКАЯ подложка карты: тинт над средней точкой картинки. Считается
 * ЗДЕСЬ, независимо от `wallpaperBackdrop`: иначе инвариант мерил бы ту же
 * модель, что и код, и не поймал бы её ошибку (круг 2 — обратный ход из α).
 */
function actualBackdrop(baseColor: string, imageLuminance: number, inLayer: boolean): string {
  const base = rgb(baseColor);
  const baseLuminance = relativeLuminance(base[0], base[1], base[2]);
  const tint = wallpaperTintColor(base, wallpaperTintAlpha(imageLuminance, baseLuminance, inLayer));
  const alpha = parseAlpha(tint);
  assert.ok(alpha !== null, `тинт не разобран: ${tint}`);
  const under = averageColor(imageLuminance);
  const composite = base.map((channel, i) => Math.round(alpha * channel + (1 - alpha) * under[i]!));
  return `rgb(${composite.join(', ')})`;
}

/**
 * ПРЕЖНЯЯ (дефектная) модель круга 1: средняя светлота картинки
 * восстанавливалась обратным ходом из плотности тинта. Живёт только как
 * негативная проба: она обязана краснеть.
 */
function reverseBackdrop(baseColor: string, imageLuminance: number, inLayer: boolean): string {
  const base = rgb(baseColor);
  const baseLuminance = relativeLuminance(base[0], base[1], base[2]);
  const tint = wallpaperTintColor(base, wallpaperTintAlpha(imageLuminance, baseLuminance, inLayer));
  const alpha = parseAlpha(tint);
  assert.ok(alpha !== null, `тинт не разобран: ${tint}`);
  const delta =
    Math.min(
      1,
      Math.max(
        0,
        (alpha - WALLPAPER_TINT_ALPHA_MIN) / (WALLPAPER_TINT_ALPHA_MAX - WALLPAPER_TINT_ALPHA_MIN),
      ),
    ) * WALLPAPER_TINT_DELTA_FULL;
  const derived =
    baseLuminance > 0.5 ? Math.max(0, baseLuminance - delta) : Math.min(1, baseLuminance + delta);
  const under = averageColor(derived);
  const composite = base.map((channel, i) => Math.round(alpha * channel + (1 - alpha) * under[i]!));
  return `rgb(${composite.join(', ')})`;
}

/**
 * Модель подложки для негативных проб: `reverse` — обратный ход из α,
 * `no-layer-factor` — множитель слоя `WALLPAPER_TINT_LAYER_FACTOR` забыт.
 */
type BackdropModel = 'actual' | 'reverse' | 'no-layer-factor';

function backdropByModel(
  model: BackdropModel,
  baseColor: string,
  imageLuminance: number,
  inLayer: boolean,
): string {
  if (model === 'reverse') return reverseBackdrop(baseColor, imageLuminance, inLayer);
  if (model === 'no-layer-factor') return actualBackdrop(baseColor, imageLuminance, false);
  return actualBackdrop(baseColor, imageLuminance, inLayer);
}

/** Дефолтные цвета слоя (0.6.4) — их получает каждый новый слой. */
const LAYER_DEFAULTS = defaultLayerColors();

/**
 * Независимый перебор УЗКОГО диапазона: тон и насыщенность полосы сохраняются,
 * светлота — абсолютная 0.06…0.94. Возвращает максимальный видимый контраст.
 * Считается В ТЕСТЕ: модель модуля здесь не участвует.
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

/** Пастельные полосы для проверки сохранения цвета. */
const RANGE_COLORS = ['#ffd1dc', '#d1c2a2', '#7e57c2'] as const;

/**
 * Допуск на округление sRGB: номинальная светлота 0.06 даёт канал 15, а его
 * HSL-светлота — 0.0588. Это не выход за диапазон, а шаг квантования.
 */
const LIGHT_ROUNDING = 1 / 255;

/** Цвета полосы для блока темы: граничные пользовательские + дефолтные слоя. */
function bandColors(mode: ThemeMode): readonly string[] {
  const slot = mode === 'dark' ? 'dark' : 'light';
  return [...USER_COLORS, LAYER_DEFAULTS.focus_stripe[slot], LAYER_DEFAULTS.background[slot]];
}

/**
 * ФОНЫ, которые становятся базой тинта: фон темы и пользовательские фоны слоя
 * (дефолтные цвета создания и граничные #ffffff/#000000/#808080). Продукт
 * сначала подгоняет фон под текст темы — ровно это и делает скан ниже.
 */
function backdropBases(block: ThemeBlock): readonly string[] {
  const themeBg = block.tokens.get('--bg') ?? '';
  return [
    themeBg,
    '#ffffff',
    '#000000',
    '#808080',
    LAYER_DEFAULTS.background.dark,
    LAYER_DEFAULTS.background.light,
  ];
}

/** Тело правила CSS по нормализованному селектору; `null` — правила нет. */
function ruleBody(css: string, selector: string): string | null {
  const text = stripCssComments(css);
  const wanted = selector.replace(/\s+/g, '');
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open < 0) return null;
    const preludeStart = text.lastIndexOf('}', open) + 1;
    const prelude = text.slice(preludeStart, open);
    let depth = 1;
    let cursor = open + 1;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === '{') depth += 1;
      else if (text[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    if (prelude.split(',').some((part) => part.replace(/\s+/g, '') === wanted)) {
      return text.slice(open + 1, cursor - 1);
    }
    index = cursor;
  }
  return null;
}

/** Значение объявления свойства в теле правила. */
function declaration(body: string | null, property: string): string | null {
  if (body === null) return null;
  const match = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;{}]+);`).exec(body);
  return match ? match[1]!.replace(/\s+/g, ' ').trim() : null;
}

// ---------------------------------------------------------------------------
// 1. Числовые инварианты на 12 блоках тем
// ---------------------------------------------------------------------------

/** Нарушения контраста текста и поверхностей. `adapt` подменяется негативной пробой. */
function textProblems(
  blocks: readonly ThemeBlock[],
  adapt: (color: string, backdrop: string, target: number) => string = (color, backdrop, target) =>
    adaptiveColor(color, [backdrop], target),
): string[] {
  const problems: string[] = [];
  for (const block of blocks) {
    const label = `${block.theme} (${block.mode})`;
    const bg = block.tokens.get('--bg') ?? '';
    const text = block.tokens.get('--text') ?? '';
    for (const color of USER_COLORS) {
      const onTheme = adapt(color, bg, TEXT_CONTRAST_MIN);
      const onThemeRatio =
        (Math.max(relativeLuminance(...rgb(onTheme)), relativeLuminance(...rgb(bg))) + 0.05) /
        (Math.min(relativeLuminance(...rgb(onTheme)), relativeLuminance(...rgb(bg))) + 0.05);
      if (onThemeRatio < TEXT_CONTRAST_MIN) {
        problems.push(`${label}: текст ${color} → ${onTheme} ${onThemeRatio.toFixed(2)} : 1`);
      }
      const surface = adapt(color, text, TEXT_CONTRAST_MIN);
      const surfaceRatio =
        (Math.max(relativeLuminance(...rgb(surface)), relativeLuminance(...rgb(text))) + 0.05) /
        (Math.min(relativeLuminance(...rgb(surface)), relativeLuminance(...rgb(text))) + 0.05);
      if (surfaceRatio < TEXT_CONTRAST_MIN) {
        problems.push(`${label}: поверхность ${color} → ${surface} ${surfaceRatio.toFixed(2)} : 1`);
      }
      // Диапазон производной проверяется только там, где алгоритм её сдвинул:
      // уже читаемый пользовательский цвет возвращается без изменений.
      if (onTheme !== color) {
        const lightness = rgbToHsl(rgb(onTheme))[2];
        if (lightness < ADAPT_LIGHT_MIN - 1e-9 || lightness > ADAPT_LIGHT_MAX + 1e-9) {
          problems.push(`${label}: светлота производной ${lightness.toFixed(3)} вне диапазона`);
        }
      }
    }
  }
  return problems;
}

/**
 * Нарушения контраста полосы на ФАКТИЧЕСКОМ композите. `adapt` и `opacity`
 * подменяются негативными пробами, `model` — моделью подложки: инвариант
 * обязан краснеть и от обратного хода из α, и от забытого множителя слоя.
 */
function bandProblems(
  blocks: readonly ThemeBlock[],
  adapt: (color: string, backdrop: string) => string = (color, backdrop) =>
    adaptiveBandColor(color, backdrop),
  opacity = FOCUS_BAND_OPACITY,
  model: BackdropModel = 'actual',
): string[] {
  const problems: string[] = [];
  for (const block of blocks) {
    const label = `${block.theme} (${block.mode})`;
    const text = block.tokens.get('--text') ?? '';
    for (const rawBase of backdropBases(block)) {
      // Фон — поверхность: продукт подгоняет его под текст темы, и уже он
      // становится базой тинта (`--layer-bg`).
      const base = adaptiveColor(rawBase, [text], TEXT_CONTRAST_MIN);
      for (const inLayer of [false, true]) {
        for (const imageLuminance of IMAGE_LUMINANCES) {
          const actual = actualBackdrop(base, imageLuminance, inLayer);
          // Адаптация верит модели, а проверка идёт по ФАКТИЧЕСКОМУ композиту:
          // так мутация модели (обратный ход, забытый множитель слоя) краснеет.
          const backdrop = backdropByModel(model, base, imageLuminance, inLayer);
          for (const color of bandColors(block.mode)) {
            const stripe = adapt(color, backdrop);
            const value = bandContrast(rgb(stripe), rgb(actual), opacity);
            if (value < FRAME_CONTRAST_MIN) {
              problems.push(
                `${label} фон ${rawBase} ${inLayer ? 'слой' : 'основа'} ` +
                  `картинка ${imageLuminance}: полоса ${color} → ${stripe} ` +
                  `${value.toFixed(2)} : 1`,
              );
            }
          }
        }
      }
    }
  }
  return problems;
}

/**
 * Нарушения «пастель сохраняет цвет»: если в узком диапазоне порог ДОСТИЖИМ,
 * адаптированная полоса обязана остаться в нём (не уехать в чистый #000/#fff).
 * Независимая достижимость — {@link narrowReach}.
 */
function bandRangeProblems(blocks: readonly ThemeBlock[]): string[] {
  const problems: string[] = [];
  const images = [0, 0.2, 0.5, 0.8, 1] as const;
  for (const block of blocks) {
    const label = `${block.theme} (${block.mode})`;
    const text = block.tokens.get('--text') ?? '';
    for (const rawBase of backdropBases(block)) {
      const base = adaptiveColor(rawBase, [text], TEXT_CONTRAST_MIN);
      for (const inLayer of [false, true]) {
        for (const image of images) {
          const backdrop = actualBackdrop(base, image, inLayer);
          const place = `${label} фон ${rawBase} ${inLayer ? 'слой' : 'основа'} img ${image}`;
          for (const color of RANGE_COLORS) {
            const adapted = adaptiveBandColor(color, backdrop);
            if (adapted === color) continue;
            if (narrowReach(color, backdrop) < FRAME_CONTRAST_MIN) continue;
            const light = rgbToHsl(rgb(adapted))[2];
            if (
              light < ADAPT_LIGHT_MIN - LIGHT_ROUNDING ||
              light > ADAPT_LIGHT_MAX + LIGHT_ROUNDING
            ) {
              problems.push(`${place}: полоса ${color} → ${adapted} вне узкого диапазона`);
            }
            if (adapted === '#000000' || adapted === '#ffffff') {
              problems.push(`${place}: пастель ${color} → ${adapted} (цвет потерян)`);
            }
          }
        }
      }
    }
  }
  return problems;
}

/**
 * Нарушения контраста экранных колец: кольцо непрозрачно, поэтому меряется
 * прямо к `--surface` темы и к фактической поверхности слоя (адаптированный
 * фон). `adapt` подменяется негативными пробами.
 */
function ringProblems(
  blocks: readonly ThemeBlock[],
  adapt: (source: string, surfaces: readonly string[]) => string = (source, surfaces) =>
    adaptiveColor(source, surfaces, FRAME_CONTRAST_MIN),
  adaptWithoutSurface2 = false,
): string[] {
  const problems: string[] = [];
  for (const block of blocks) {
    const label = `${block.theme} (${block.mode})`;
    const surface = block.tokens.get('--surface') ?? '';
    const surface2 = block.tokens.get('--surface-2') ?? '';
    const text = block.tokens.get('--text') ?? '';
    const accent = block.tokens.get('--focus-accent') ?? block.tokens.get('--accent') ?? '';
    // Источники кольца: пользовательские цвета полосы и фокус-акцент основы.
    const sources = [...USER_COLORS, accent];
    for (const rawBase of backdropBases(block)) {
      const base = adaptiveColor(rawBase, [text], TEXT_CONTRAST_MIN);
      const surfaces = [surface, surface2, base].filter((value) => value !== '');
      // Полоса-индикатор 2–3 px стоит на строках списков, закрашенных
      // `--surface-2`, поэтому кольцо обязано читаться и на ней. Мутация
      // `adaptWithoutSurface2` возвращает прежнюю подгонку — скан краснеет.
      const adaptSurfaces = adaptWithoutSurface2
        ? [surface, base].filter((value) => value !== '')
        : surfaces;
      for (const source of sources) {
        const ring = adapt(source, adaptSurfaces);
        for (const target of surfaces) {
          const value = contrastRatio(rgb(ring), rgb(target));
          if (value < FRAME_CONTRAST_MIN) {
            problems.push(
              `${label}: кольцо ${source} → ${ring} на ${target} ${value.toFixed(2)} : 1`,
            );
          }
        }
      }
    }
  }
  return problems;
}

describe('сторож: адаптация цветов — контраст на 12 блоках тем', () => {
  it('текст, поверхность и полоса проходят пороги WCAG', () => {
    const blocks = themeBlocks();
    assert.deepEqual(
      textProblems(blocks),
      [],
      `текст/поверхность:\n  ${textProblems(blocks).join('\n  ')}`,
    );
    assert.deepEqual(bandProblems(blocks), [], `полоса:\n  ${bandProblems(blocks).join('\n  ')}`);
  });

  it('диапазон полосы: пастель сохраняет цвет, полный — только при недостижимости', () => {
    const blocks = themeBlocks();
    const failures = bandRangeProblems(blocks);
    assert.deepEqual(failures, [], `пастель потеряла цвет:\n  ${failures.join('\n  ')}`);
    // Полный диапазон доступен: нейтральная полоса на средней подложке выходит
    // за узкий диапазон, иначе 3 : 1 недостижимы (2.95).
    const neutral = adaptiveBandColor('#808080', 'rgb(116, 116, 116)');
    assert.ok(
      rgbToHsl(rgb(neutral))[2] < ADAPT_LIGHT_MIN - 1e-9,
      `полоса осталась в узком диапазоне: ${neutral}`,
    );
    assert.ok(
      bandContrast(rgb(neutral), rgb('rgb(116, 116, 116)')) >= FRAME_CONTRAST_MIN,
      `нейтральная полоса не дотянула порог: ${neutral}`,
    );
  });

  it('кольца экранов: 3 : 1 к --surface и поверхности слоя, мутации краснеют', () => {
    const blocks = themeBlocks();
    const failures = ringProblems(blocks);
    assert.deepEqual(failures, [], `кольца экранов:\n  ${failures.join('\n  ')}`);
    // Кольцо, подогнанное без --surface-2 (прежняя модель), не дотягивает
    // 3 : 1 на строках списков — обязано краснить.
    assert.ok(
      ringProblems(blocks, undefined, true).length > 0,
      'кольцо без --surface-2 обязано ловиться',
    );
    // 1. Кольцо без адаптации (белая полоса на белой поверхности — 1 : 1).
    assert.ok(
      ringProblems(blocks, (source) => source).length > 0,
      'кольцо без адаптации обязано ловиться',
    );
    // 2. Кольцо адаптировано к ХОЛСТУ, а не к поверхности — прежний дефект
    //    (адаптированная к карте полоса давала 2.43 : 1 на --surface).
    assert.ok(
      ringProblems(blocks, (source) => adaptiveBandColor(source, 'rgb(61, 61, 61)')).length > 0,
      'кольцо, адаптированное к холсту, обязано ловиться',
    );
  });

  it('мутации расчёта ловятся: без адаптации, сниженный порог, полоса «в цвете»', () => {
    const blocks = themeBlocks();
    // 1. Адаптация отключена — исходный пользовательский цвет как есть.
    assert.ok(
      textProblems(blocks, (color) => color).length > 0,
      'отсутствие адаптации текста обязано ловиться',
    );
    // 2. Порог снижен до 3 : 1 — «читаемый» текст на светлой теме не проходит.
    assert.ok(
      textProblems(blocks, (color, backdrop) => adaptiveColor(color, [backdrop], 3)).length > 0,
      'сниженный порог текста обязан ловиться',
    );
    // 3. Полоса адаптирована «в цвете» (порог 3 : 1 у непрозрачного цвета), а
    //    рисуется полупрозрачной — видимый контраст ниже порога.
    assert.ok(
      bandProblems(
        blocks,
        (color, backdrop) => adaptiveColor(color, [backdrop], FRAME_CONTRAST_MIN),
        FOCUS_BAND_OPACITY,
      ).length > 0,
      'игнорирование полупрозрачности полосы обязано ловиться',
    );
    // 4. Полоса без адаптации.
    assert.ok(
      bandProblems(blocks, (color) => color).length > 0,
      'отсутствие адаптации полосы обязано ловиться',
    );
    // 5. Подложка посчитана обратным ходом из α (дефект круга 1).
    assert.ok(
      bandProblems(blocks, undefined, FOCUS_BAND_OPACITY, 'reverse').length > 0,
      'обратный ход из α обязан краснеть',
    );
    // 6. Множитель слоя WALLPAPER_TINT_LAYER_FACTOR забыт.
    assert.ok(
      bandProblems(blocks, undefined, FOCUS_BAND_OPACITY, 'no-layer-factor').length > 0,
      'игнорирование множителя слоя обязано краснеть',
    );
  });

  it('оба направления: светлый слой + чёрная картинка опасен, тёмный + светлая — нет', () => {
    // Направление 1 — ОПАСНОЕ: светлый слой, чёрная картинка. Обратный ход из α
    // «видит» среднюю светлоту 0.5 и светлую подложку, чёрная полоса на ней
    // читается и не адаптируется — на фактическом композите 1.72 : 1.
    const lightBase = actualBackdrop('#ffffff', 0, true);
    const lightWrong = reverseBackdrop('#ffffff', 0, true);
    assert.equal(lightBase, 'rgb(61, 61, 61)');
    assert.ok(
      rgb(lightWrong)[0] - rgb(lightBase)[0] >= 100,
      `обратный ход обязан "видеть" светлую подложку (${lightWrong} / ${lightBase})`,
    );
    assert.ok(
      bandContrast(rgb(adaptiveBandColor('#000000', lightWrong)), rgb(lightBase)) <
        FRAME_CONTRAST_MIN,
      'обратный ход на светлом слое обязан давать провал',
    );
    assert.ok(
      bandContrast(rgb(adaptiveBandColor('#000000', lightBase)), rgb(lightBase)) >=
        FRAME_CONTRAST_MIN,
      'фактическая модель обязана вылечить полосу на светлом слое',
    );

    // Направление 2: тёмный слой, светлая картинка. Обратный ход ошибается в
    // ДРУГУЮ сторону — его подложка темнее фактической (173 против 198), а для
    // тёмной полосы это «безопасно»: контраст на факте только растёт. Поэтому
    // проба фиксирует САМУ ошибку модели (≥ 15 каналов) и то, что модуль считает
    // факт, а не подложку-обманку.
    const darkBase = actualBackdrop('#101010', 1, true);
    const darkWrong = reverseBackdrop('#101010', 1, true);
    assert.ok(
      Math.abs(rgb(darkBase)[0] - rgb(darkWrong)[0]) >= 15,
      `обратный ход на тёмном слое обязан расходиться с фактом (${darkWrong} / ${darkBase})`,
    );
    assert.ok(
      bandContrast(rgb(adaptiveBandColor('#000000', darkBase)), rgb(darkBase)) >=
        FRAME_CONTRAST_MIN,
      'тёмная полоса на светлой картинке обязана читаться',
    );
    // Репро проверяющего числом: подложка rgb(61, 61, 61), полоса 1.72 : 1 без
    // адаптации, а с фактической моделью — адаптируется и проходит порог.
    const repro = actualBackdrop('#ffffff', 0, true);
    assert.equal(repro, 'rgb(61, 61, 61)');
    assert.ok(bandContrast(rgb('#000000'), rgb(repro)) < FRAME_CONTRAST_MIN);
    assert.ok(
      bandContrast(rgb(adaptiveBandColor('#000000', repro)), rgb(repro)) >= FRAME_CONTRAST_MIN,
      `репро не вылечено: ${adaptiveBandColor('#000000', repro)} на ${repro}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Оформление реальных файлов: модель подложки и единый алгоритм
// ---------------------------------------------------------------------------

/**
 * Нарушения оформления в переданных исходниках. Вынесено функцией, чтобы ТА ЖЕ
 * проверка гонялась по мутированным копиям РЕАЛЬНЫХ файлов.
 */
function sourceProblems(files: {
  canvasCss: string;
  tokensCss: string;
  layerColors: string;
  thoughtCloud: string;
  layerDialog: string;
  links: string;
  adaptiveColor: string;
  adaptiveContext: string;
  screenCss: string;
}): string[] {
  const problems: string[] = [];

  // Плотность слоя полосы: константа алгоритма обязана совпадать с токеном CSS.
  const tokenOpacity = declaration(ruleBody(files.tokensCss, ':root'), '--focus-band-opacity');
  if (tokenOpacity !== String(FOCUS_BAND_OPACITY)) {
    problems.push(
      `tokens.css: --focus-band-opacity ${tokenOpacity ?? '(нет)'} ≠ ${FOCUS_BAND_OPACITY}`,
    );
  }
  const bandBody = ruleBody(files.canvasCss, '.canvas::before');
  const bandOpacity = declaration(bandBody, 'opacity') ?? '';
  if (!bandOpacity.startsWith('var(--focus-band-opacity')) {
    problems.push(`.canvas::before: плотность полосы не из токена (${bandOpacity || '(нет)'})`);
  }
  const bandBackground = declaration(bandBody, 'background') ?? '';
  if (!bandBackground.includes('var(--layer-focus-stripe')) {
    problems.push('.canvas::before: полоса рисуется не из --layer-focus-stripe');
  }

  // Модель подложки: тинт лежит ПОВЕРХ картинки (первым слоем фона).
  const wallpaperBody = ruleBody(files.canvasCss, ":root[data-canvas-wallpaper='on'] .canvas");
  const wallpaperBackground = declaration(wallpaperBody, 'background') ?? '';
  const tintAt = wallpaperBackground.indexOf('var(--canvas-wallpaper-tint');
  const imageAt = wallpaperBackground.indexOf('var(--canvas-wallpaper-image');
  if (tintAt < 0 || imageAt < 0) {
    problems.push('.canvas с картинкой: нет тинта или картинки в фоне');
  } else if (tintAt > imageAt) {
    problems.push('.canvas с картинкой: тинт оказался под картинкой — модель подложки неверна');
  }
  // Нижний слой — тема/слой; фон может идти через пользовательский токен
  // (--user-canvas-bg с фолбэком на --bg), но --layer-bg остаётся первым.
  const baseLayerChain = wallpaperBackground.replace(/var\(--user-canvas-bg,\s*/g, '');
  if (!baseLayerChain.includes('var(--layer-bg, var(--bg))')) {
    problems.push('.canvas с картинкой: потерян нижний слой --layer-bg');
  }

  // Единый алгоритм: на экране производные, а не исходники.
  if (!files.layerColors.includes('adaptLayerColors(')) {
    problems.push('layer-colors.ts: refreshLayerTheme не считает производные');
  }
  if (
    !files.layerColors.includes('applyLayerThemeStyle(document.documentElement.style, applied)')
  ) {
    problems.push('layer-colors.ts: на корень пишутся не производные цвета слоя');
  }
  if (!files.layerColors.includes('effectiveLayerStripe')) {
    problems.push('layer-colors.ts: нет доступа к действующей (адаптированной) полосе');
  }
  if (!files.thoughtCloud.includes('adaptThoughtColors(')) {
    problems.push('thought-cloud.ts: applyCloudStyle не адаптирует цвета мысли');
  }
  if (!files.links.includes('adaptCanvasAccent(')) {
    problems.push('links.ts: цвет линии считается без адаптации к подложке холста');
  }

  // Модель подложки — ОТ ФАКТА: средняя светлота картинки и фактическая α.
  if (files.adaptiveColor.includes('WALLPAPER_TINT_ALPHA_MIN')) {
    problems.push(
      'adaptive-color.ts: вернулся обратный ход из плотности тинта — подложка не фактическая',
    );
  }
  if (!files.adaptiveColor.includes('imageLuminance: number | null')) {
    problems.push('adaptive-color.ts: композит не принимает среднюю светлоту картинки');
  }
  const metaUses = files.adaptiveContext.split('state.meta.avg_luminance').length - 1;
  if (metaUses < 2) {
    problems.push(
      'adaptive-context.ts: подложка считается без метаданных картинки (avg_luminance)',
    );
  }
  // Признак слоя обязан ДОЙТИ до плотности тинта: константа вместо
  // `background !== null` тихо включает плотность основы (круг 3).
  if (!files.adaptiveContext.includes('canvasTint(state, base, background !== null)')) {
    problems.push(
      'adaptive-context.ts: признак слоя не доходит до плотности тинта (множитель слоя)',
    );
  }
  if (!files.adaptiveContext.includes('focusRing')) {
    problems.push('adaptive-context.ts: экранное кольцо не считается');
  }
  if (!files.layerColors.includes("style.setProperty('--layer-focus-ring-screen'")) {
    problems.push('layer-colors.ts: экранное кольцо не пишется на корень');
  }
  // Экранные кольца — отдельное производное от поверхности, на карте — полоса.
  const stripeRing = /(?:^|[;{\s])(?:outline|border-color)\s*:[^;{}]*var\(--layer-focus-stripe/;
  if (stripeRing.test(files.screenCss)) {
    problems.push(
      'экранное кольцо берёт полосу карты (--layer-focus-stripe) вместо кольца поверхностей',
    );
  }
  if (!files.screenCss.includes('--layer-focus-ring-screen')) {
    problems.push('экранные кольца не используют --layer-focus-ring-screen');
  }
  if (files.canvasCss.includes('--layer-focus-ring-screen')) {
    problems.push('полоса карты переведена на экранное кольцо — на карте нужна полоса');
  }
  // Inset-полоски 2–3 px (строки хроники, поиска, публикаций) — индикатор
  // активного элемента на поверхности: тот же экранный токен кольца, не полоса
  // карты. Мягкие 18 %-фоны по-прежнему на --layer-focus-stripe (их не трогаем).
  const stripeInset = /(?:^|[;{\s])box-shadow\s*:[^;{}]*inset[^;{}]*var\(--layer-focus-stripe/;
  if (stripeInset.test(files.screenCss)) {
    problems.push(
      'inset-полоска экрана берёт полосу карты (--layer-focus-stripe) вместо кольца поверхностей',
    );
  }
  const insetRules = [...files.screenCss.matchAll(/box-shadow\s*:[^;{}]*inset[^;{}]*/g)].map(
    (match) => match[0],
  );
  const ringInsets = insetRules.filter((rule) => rule.includes('var(--layer-focus-ring-screen'));
  if (ringInsets.length < 3) {
    problems.push(
      `inset-полосок на кольце поверхностей ${ringInsets.length}, ожидалось не меньше 3`,
    );
  }
  if (
    !files.adaptiveContext.includes("getPropertyValue('--surface-2')") ||
    !/ringSurfaces\s*=\s*\[surface,\s*surface2,\s*base\]/.test(files.adaptiveContext)
  ) {
    problems.push('adaptive-context.ts: экранное кольцо считается без --surface-2');
  }

  // Диалог «Свойства слоя»: пара слотов — общий модуль, прямая инверсия запрещена.
  if (!files.layerDialog.includes('layerColorPair(')) {
    problems.push('screens/layers.ts: пара слотов считается не общим модулем');
  }
  if (files.layerDialog.includes('invertThemeColor')) {
    problems.push('screens/layers.ts: вернулась прямая инверсия светлоты в диалоге');
  }

  // Ранее сделанное не сломано: рамки трёх состояний и --layer-bg на экранах.
  for (const selector of ['.cloud.halo', '.cloud.selected', '.cloud.kbd-cursor']) {
    const body = ruleBody(files.canvasCss, selector);
    const value = `${declaration(body, 'border-color') ?? ''} ${declaration(body, 'outline') ?? ''}`;
    if (!value.includes('var(--frame-')) {
      problems.push(`${selector}: рамка перестала брать цвет из --frame-* (задача c6d74fd4)`);
    }
  }
  return problems;
}

describe('сторож: адаптация цветов — оформление реальных файлов', () => {
  const files = {
    canvasCss: CANVAS_CSS,
    tokensCss: TOKENS_CSS,
    layerColors: LAYER_COLORS_TS,
    thoughtCloud: THOUGHT_CLOUD_TS,
    layerDialog: SCREEN_LAYERS_TS,
    links: LINKS_TS,
    adaptiveColor: ADAPTIVE_COLOR_TS,
    adaptiveContext: ADAPTIVE_CONTEXT_TS,
    screenCss: SCREEN_RING_CSS,
  };

  it('модель подложки и единый алгоритм на месте', () => {
    const problems = sourceProblems(files);
    assert.deepEqual(problems, [], `нарушения оформления:\n  ${problems.join('\n  ')}`);
  });

  it('мутации реальных файлов ловятся: инверсия в диалоге, исходники на корень, тинт под картинкой', () => {
    assert.deepEqual(sourceProblems(files), [], 'рабочие файлы обязаны быть чистыми');
    // 1. Возврат прямой инверсии светлоты в диалог свойств слоя.
    const withInversion = {
      ...files,
      layerDialog: files.layerDialog.replace(
        "focus_stripe: layerColorPair(stripeRow.get(), 'focus_stripe', theme),",
        'focus_stripe: invertThemeColor({ dark: stripeRow.get(), light: stripeRow.get() }, theme),',
      ),
    };
    assert.notEqual(withInversion.layerDialog, files.layerDialog, 'мутация диалога не применилась');
    assert.ok(sourceProblems(withInversion).length > 0, 'инверсия в диалоге обязана ловиться');
    // 2. На корень пишутся исходные цвета пользователя, а не производные.
    const withSources = {
      ...files,
      layerColors: files.layerColors.replace(
        'applyLayerThemeStyle(document.documentElement.style, applied)',
        'applyLayerThemeStyle(document.documentElement.style, vars)',
      ),
    };
    assert.ok(sourceProblems(withSources).length > 0, 'исходники на корень обязаны ловиться');
    // 3. Слой тинта опущен под картинку (тинт перестал быть вуалью над ней).
    const tintUnder = {
      ...files,
      canvasCss: files.canvasCss.replace(
        /(linear-gradient\(\s*var\(--canvas-wallpaper-tint, transparent\),\s*var\(--canvas-wallpaper-tint, transparent\)\s*\),\s*)(var\(--canvas-wallpaper-image\)[^,]*,\s*)/,
        '$2$1',
      ),
    };
    assert.notEqual(tintUnder.canvasCss, files.canvasCss, 'мутация тинта не применилась');
    assert.ok(sourceProblems(tintUnder).length > 0, 'тинт под картинкой обязан ловиться');
    // 4. Расхождение константы плотности полосы с CSS.
    const opacityDrift = {
      ...files,
      tokensCss: files.tokensCss.replace('--focus-band-opacity: 0.7;', '--focus-band-opacity: 1;'),
    };
    assert.ok(sourceProblems(opacityDrift).length > 0, 'расхождение плотности полосы обязательно');
    // 5. Мысль рисуется без адаптации.
    const noThoughtAdapt = {
      ...files,
      thoughtCloud: files.thoughtCloud.replace('adaptThoughtColors(', 'passthrough('),
    };
    assert.ok(sourceProblems(noThoughtAdapt).length > 0, 'мысль без адаптации обязана ловиться');
    // 6. Возврат обратного хода из плотности тинта.
    const reverse = {
      ...files,
      adaptiveColor: files.adaptiveColor.replace(
        'export function wallpaperBackdrop(',
        'const WALLPAPER_TINT_ALPHA_MIN = 0.12;\nexport function wallpaperBackdrop(',
      ),
    };
    assert.ok(sourceProblems(reverse).length > 0, 'обратный ход из α обязан ловиться');
    // 7. Подложка без метаданных картинки.
    const noMeta = {
      ...files,
      adaptiveContext: files.adaptiveContext.replace(
        "state.status === 'ok' ? state.meta.avg_luminance : null",
        'null',
      ),
    };
    assert.ok(sourceProblems(noMeta).length > 0, 'подложка без avg_luminance обязана ловиться');
    // 8. Признак слоя потерян: плотность тинта считается как для основы.
    const lostLayerFactor = {
      ...files,
      adaptiveContext: files.adaptiveContext.replace(
        'canvasTint(state, base, background !== null)',
        'canvasTint(state, base, false)',
      ),
    };
    assert.notEqual(
      lostLayerFactor.adaptiveContext,
      files.adaptiveContext,
      'мутация проводки не применилась',
    );
    assert.ok(sourceProblems(lostLayerFactor).length > 0, 'потеря признака слоя обязана ловиться');
    // 9. Экранное кольцо снова берёт полосу карты.
    const stripeRingBack = {
      ...files,
      screenCss: files.screenCss.replace(
        'outline: 2px solid var(--layer-focus-ring-screen, var(--focus-accent, var(--accent)));',
        'outline: 2px solid var(--layer-focus-stripe, var(--focus-accent, var(--accent)));',
      ),
    };
    assert.notEqual(stripeRingBack.screenCss, files.screenCss, 'мутация кольца не применилась');
    assert.ok(sourceProblems(stripeRingBack).length > 0, 'кольцо на полосе карты обязано ловиться');
    // 10. Экранное кольцо не пишется на корень.
    const noRingWrite = {
      ...files,
      layerColors: files.layerColors.replace(
        "style.setProperty('--layer-focus-ring-screen', vars.focusRing)",
        'void 0',
      ),
    };
    assert.notEqual(noRingWrite.layerColors, files.layerColors, 'мутация записи не применилась');
    assert.ok(sourceProblems(noRingWrite).length > 0, 'отсутствие записи кольца обязано ловиться');
    // 11. Inset-полоска снова берёт полосу карты — индикатор на поверхности
    //     должен краснеть (доработка по приёмке: chronicle/search/publications).
    const insetOnStripe = {
      ...files,
      screenCss: files.screenCss.replace(
        'box-shadow: inset 2px 0 0 var(--layer-focus-ring-screen, var(--focus-accent, var(--accent)));',
        'box-shadow: inset 2px 0 0 var(--layer-focus-stripe, var(--focus-accent, var(--accent)));',
      ),
    };
    assert.notEqual(
      insetOnStripe.screenCss,
      files.screenCss,
      'мутация inset-полоски не применилась',
    );
    assert.ok(
      sourceProblems(insetOnStripe).length > 0,
      'inset-полоска на полосе карты обязана ловиться',
    );
    // 12. Кольцо адаптировано к --surface и слою, но не к --surface-2 (прежнее
    //     поведение): строки списков дают < 3 : 1.
    const insetNoSurface2 = {
      ...files,
      adaptiveContext: files.adaptiveContext.replace(
        '[surface, surface2, base]',
        '[surface, base]',
      ),
    };
    assert.notEqual(insetNoSurface2.adaptiveContext, files.adaptiveContext);
    assert.ok(
      sourceProblems(insetNoSurface2).length > 0,
      'кольцо без --surface-2 обязано ловиться',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Живая проводка: производные на корне, исходники — в сторе
// ---------------------------------------------------------------------------

describe('сторож: refreshLayerTheme пишет производные, исходники не меняются', () => {
  type LayerColorsModule = typeof import('../src/renderer/lib/layer-colors.js');

  const LAYER_ID = '00000000-0000-4000-8000-0000000000bb';

  let layerColors: LayerColorsModule;
  let root: ShimElement;
  /** Подменённое состояние картинки: идёт через настоящий `refreshWallpaper`. */
  let wallpaperState: WallpaperState = { status: 'none' };

  function setThemeTokens(theme: string, mode: ThemeMode): void {
    const body = themeBlockBody(readTheme(theme), theme, mode);
    assert.ok(body !== null);
    const tokens = declaredTokens(body);
    for (const name of [
      '--bg',
      '--text',
      '--surface',
      '--surface-2',
      '--cursor',
      '--selection',
      '--focus-accent',
    ]) {
      root.style.setProperty(name, tokens.get(name) ?? '');
    }
    root.style.removeProperty('--layer-bg');
    root.style.removeProperty('--layer-focus-stripe');
    root.style.removeProperty('--layer-focus-ring-screen');
  }

  function layer(colors: Record<string, unknown>): Record<string, unknown> {
    return { id: LAYER_ID, title: 'Проба адаптации', is_base: false, colors };
  }

  before(async () => {
    root = new ShimElement('html');
    (globalThis as any).document = {
      documentElement: root,
      body: new ShimElement('body'),
      querySelector: () => null,
      querySelectorAll: () => [] as ShimElement[],
    };
    (globalThis as any).getComputedStyle = (element: { style: unknown }) => element.style;
    (globalThis as any).window = {
      getComputedStyle: (element: { style: unknown }) => element.style,
      // Мост главного процесса: `refreshWallpaper` читает картинку через него.
      etn: { me: { getWallpaper: async () => wallpaperState } },
    };
    layerColors = await import('../src/renderer/lib/layer-colors.js');
  });

  it('экстремальные цвета: на корне производные, в сторе — исходники', () => {
    clearAdaptiveColorCache();
    setThemeTokens('current', 'light');
    const colors = {
      focus_stripe: { dark: '#ffff00', light: '#ffffff' },
      background: { dark: '#000000', light: '#ffffff' },
    };
    const stored = structuredClone(colors);
    store.update({
      uiTheme: 'current',
      theme: 'light',
      layers: [layer(colors) as never],
      currentLayer: { id: LAYER_ID, title: 'Проба адаптации' } as never,
    });
    layerColors.refreshLayerTheme();

    const appliedStripe = root.style.getPropertyValue('--layer-focus-stripe');
    const appliedBg = root.style.getPropertyValue('--layer-bg');
    const text = root.style.getPropertyValue('--text');

    // Исходники пользователя в сторе не тронуты.
    assert.deepEqual(
      (store.state.layers[0] as { colors: unknown }).colors,
      stored,
      'исходные цвета слоя переписаны',
    );
    // Производные отличаются от исходников и проходят пороги.
    assert.notEqual(
      appliedStripe,
      colors.focus_stripe.light,
      'на корень ушёл исходный цвет полосы',
    );
    const backdrop = canvasBackdrop(appliedBg, null, null);
    assert.ok(backdrop !== null);
    assert.ok(
      bandContrast(rgb(appliedStripe), rgb(backdrop)) >= FRAME_CONTRAST_MIN,
      `полоса на холсте не читается (${appliedStripe} на ${backdrop})`,
    );
    assert.ok(
      (Math.max(relativeLuminance(...rgb(appliedBg)), relativeLuminance(...rgb(text))) + 0.05) /
        (Math.min(relativeLuminance(...rgb(appliedBg)), relativeLuminance(...rgb(text))) + 0.05) >=
        TEXT_CONTRAST_MIN,
      `текст темы на фоне слоя не читается (${appliedBg})`,
    );
    // Подпись слоя считает цвет по действующей полосе, а не по исходной.
    assert.equal(layerColors.effectiveLayerStripe(), appliedStripe);
  });

  it('живая проводка: слой с картинкой — признак слоя доходит до композита', async () => {
    clearAdaptiveColorCache();
    setThemeTokens('current', 'light');
    const colors = {
      focus_stripe: { dark: '#000000', light: '#000000' },
      background: { dark: '#ffffff', light: '#ffffff' },
    };
    store.update({
      uiTheme: 'current',
      theme: 'light',
      layers: [layer(colors) as never],
      currentLayer: { id: LAYER_ID, title: 'Проба адаптации' } as never,
    });
    // Сплошная чёрная картинка: `avg_luminance` = 0. Состояние идёт через
    // НАСТОЯЩИЙ `refreshWallpaper` (мост главного процесса подменён), а не через
    // тестовый сеттер модуля — проверяется вся проводка, включая признак слоя.
    wallpaperState = {
      status: 'ok',
      network_id: LAYER_ID,
      data_url: 'data:image/jpeg;base64,',
      mime_type: 'image/jpeg',
      file_size: 1,
      content_hash: 'probe-black-image',
      meta: { width: 320, height: 180, avg_luminance: 0, dominant_hue: null, dominant_sat: null },
      source: 'cache',
    };
    await refreshWallpaper();
    layerColors.refreshLayerTheme();

    const bg = root.style.getPropertyValue('--layer-bg');
    const stripe = root.style.getPropertyValue('--layer-focus-stripe');
    const ring = root.style.getPropertyValue('--layer-focus-ring-screen');
    const surface = root.style.getPropertyValue('--surface');
    // Фактический композит считается В ТЕСТЕ, независимо от модели модуля.
    const backdrop = actualBackdrop('#ffffff', 0, true);
    assert.equal(backdrop, 'rgb(61, 61, 61)');
    assert.equal(bg, '#ffffff');
    // Значение ЖИВОЙ проводки: чёрная полоса ушла ровно настолько, чтобы видимая
    // полоса читалась на rgb(61, 61, 61). Мутация «забытый множитель слоя»
    // (`background !== null` → `false`) даёт подложку плотности основы и другое
    // значение — проба краснеет.
    assert.equal(stripe, '#a6a6a6');
    assert.ok(
      bandContrast(rgb(stripe), rgb(backdrop)) >= FRAME_CONTRAST_MIN,
      `видимая полоса не читается: ${stripe} на ${backdrop}`,
    );
    // Экранное кольцо — от поверхности, а не от холста.
    assert.notEqual(ring, '', 'экранное кольцо не записано на корень');
    assert.ok(
      contrastRatio(rgb(ring), rgb(surface)) >= FRAME_CONTRAST_MIN,
      `кольцо не читается на --surface: ${ring} / ${surface}`,
    );
    assert.ok(
      contrastRatio(rgb(ring), rgb(bg)) >= FRAME_CONTRAST_MIN,
      `кольцо не читается на поверхности слоя: ${ring} / ${bg}`,
    );
    // Строки списков закрашены `--surface-2`: inset-полоска на них читается.
    assert.ok(
      contrastRatio(rgb(ring), rgb(root.style.getPropertyValue('--surface-2'))) >=
        FRAME_CONTRAST_MIN,
      `кольцо не читается на --surface-2: ${ring}`,
    );
    // Исходники пользователя в сторе не тронуты.
    assert.deepEqual(
      (store.state.layers[0] as { colors: unknown }).colors,
      colors,
      'исходные цвета слоя переписаны',
    );
    resetWallpaperState();
  });

  it('смена режима пересчитывает производные под новую подложку', () => {
    clearAdaptiveColorCache();
    const colors = {
      focus_stripe: { dark: '#0a0a0a', light: '#ffffff' },
      background: { dark: '#101010', light: '#fafafa' },
    };
    setThemeTokens('current', 'light');
    store.update({
      uiTheme: 'current',
      theme: 'light',
      layers: [layer(colors) as never],
      currentLayer: { id: LAYER_ID, title: 'Проба адаптации' } as never,
    });
    layerColors.refreshLayerTheme();
    const lightStripe = root.style.getPropertyValue('--layer-focus-stripe');

    setThemeTokens('current', 'dark');
    store.update({ theme: 'dark' });
    layerColors.refreshLayerTheme();
    const darkStripe = root.style.getPropertyValue('--layer-focus-stripe');

    assert.notEqual(lightStripe, darkStripe, 'смена режима не пересчитала производную полосы');
    assert.deepEqual(
      (store.state.layers[0] as { colors: unknown }).colors,
      colors,
      'исходные цвета слоя переписаны при смене режима',
    );
    // Производные обоих режимов читаются на своих подложках.
    setThemeTokens('current', 'light');
    assert.equal(
      layerColors.layerColorPair('#ffffff', 'focus_stripe', 'light').light,
      '#ffffff',
      'выбранный слот обязан сохраняться как задан',
    );
  });
});
