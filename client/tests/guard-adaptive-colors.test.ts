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
 *   7) `applyCloudStyle` вернулся к исходным цветам без адаптации.
 *
 * Плюс живая проводка: `refreshLayerTheme()` пишет адаптированные `--layer-*`,
 * а цвета в сторе остаются ровно теми, что задал пользователь.
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
} from '../src/renderer/lib/adaptive-color.js';
import { parseCssColor, relativeLuminance, rgbToHsl } from '../src/renderer/lib/css-color.js';
import { wallpaperTintAlpha, wallpaperTintColor } from '../src/renderer/lib/wallpaper-image.js';
import { store } from '../src/renderer/state.js';
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

/** Подложка холста при картинке, противоположной фону (тинт максимальной плотности). */
function worstBackdrop(themeBg: string, inLayer: boolean): string {
  const base = rgb(themeBg);
  const baseLuminance = relativeLuminance(base[0], base[1], base[2]);
  const picture = baseLuminance > 0.5 ? 0.03 : 0.97;
  const tint = wallpaperTintColor(base, wallpaperTintAlpha(picture, baseLuminance, inLayer));
  const backdrop = canvasBackdrop(themeBg, tint);
  assert.ok(backdrop !== null, `подложка не посчитана (${themeBg})`);
  return backdrop;
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

/** Нарушения контраста полосы. `opacity` подменяется негативной пробой. */
function bandProblems(
  blocks: readonly ThemeBlock[],
  adapt: (color: string, backdrop: string) => string = (color, backdrop) =>
    adaptiveBandColor(color, backdrop),
  opacity = FOCUS_BAND_OPACITY,
): string[] {
  const problems: string[] = [];
  for (const block of blocks) {
    const label = `${block.theme} (${block.mode})`;
    const bg = block.tokens.get('--bg') ?? '';
    for (const inLayer of [false, true]) {
      const backdrop = worstBackdrop(bg, inLayer);
      for (const color of USER_COLORS) {
        const stripe = adapt(color, backdrop);
        const value = bandContrast(rgb(stripe), rgb(backdrop), opacity);
        if (value < FRAME_CONTRAST_MIN) {
          problems.push(
            `${label} ${inLayer ? 'слой' : 'основа'}: полоса ${color} → ${stripe} ` +
              `${value.toFixed(2)} : 1`,
          );
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
  if (!wallpaperBackground.includes('var(--layer-bg, var(--bg))')) {
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

  function setThemeTokens(theme: string, mode: ThemeMode): void {
    const body = themeBlockBody(readTheme(theme), theme, mode);
    assert.ok(body !== null);
    const tokens = declaredTokens(body);
    for (const name of ['--bg', '--text', '--surface', '--cursor', '--selection']) {
      root.style.setProperty(name, tokens.get(name) ?? '');
    }
    root.style.removeProperty('--layer-bg');
    root.style.removeProperty('--layer-focus-stripe');
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
    const backdrop = canvasBackdrop(appliedBg, null);
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
