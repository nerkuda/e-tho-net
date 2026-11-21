/**
 * Сторож рамок трёх состояний мысли (0.16.1, задача c6d74fd4).
 *
 * Правило. На карте одновременно живут три состояния мысли, и каждое имеет
 * свою рамку: ОТКРЫТАЯ в редакторе (`.cloud.halo`), ТЕКУЩАЯ под клавиатурным
 * курсором (`.cloud.kbd-cursor`, пунктир) и ВЫДЕЛЕННАЯ (`.cloud.selected`).
 * Цвета считает один чистый модуль `lib/cloud-frames.ts` и пишет их в
 * `--frame-open` / `--frame-current` / `--frame-selected`:
 *
 *   • на базовом слое — от токенов темы: текущая = `--cursor`, выделенная =
 *     `--selection`, открытая = тон курсора, поднятый по светлоте («в тон, но
 *     ярче»; раньше кант был 4px почти чёрного `--focus-ring-contrast` —
 *     «траурная рамка» в светлых темах);
 *   • на слое со своей полосой фокуса — ВСЕ ТРИ производны от
 *     `--layer-focus-stripe` (раньше от слоя зависел только внутренний 1px,
 *     перекрытый кантом темы, — замечание заказчика).
 *
 * Инварианты (числами, не «на глаз»):
 *   • каждая рамка контрастна фону холста ≥ 3 : 1 во всех 12 блоках тем;
 *   • три состояния попарно различимы: Δ sRGB ≥ 40 (метрика существующих
 *     сторожей `guard-canvas-overlay-layers` / `guard-wallpaper-tint`);
 *   • открытая рамка различается МЕЖДУ темами: Δ ≥ 25 (факт — 37.4,
 *     catppuccin dark ↔ current dark);
 *   • на слое для набора полос: открытая рамка контрастна фону холста ≥ 3 : 1
 *     (её светлота при необходимости дотягивается до читаемости — жёлтая полоса
 *     на светлом холсте давала 2.49 : 1), попарные Δ ≥ 40 и Δ(открытая, полоса)
 *     ≥ 40 — кольцо видно на полосе того же цвета;
 *   • кант открытой — именованный параметр (`CLOUD_FRAME_HAIRLINE_PX`), 1px:
 *     мутация «вернуть 4px» краснит.
 *
 * Негативные пробы гоняются на РЕАЛЬНОМ `canvas.css` и на подменённом расчёте
 * (прежнее поведение), а не на синтетических строках. Живая часть проверяет
 * проводку: `refreshLayerTheme()` перекрашивает все три рамки тем же тиком
 * store, что и `--layer-*`, — без перезагрузки и без stale-класса (ошибка
 * f245c5ac).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  CLOUD_FRAME_CONTRAST_MIN,
  CLOUD_FRAME_DISTANCE_MIN,
  CLOUD_FRAME_HAIRLINE_OFFSET_PX,
  CLOUD_FRAME_HAIRLINE_PX,
  CLOUD_FRAME_RING_PX,
  CLOUD_FRAME_THEME_DISTANCE_MIN,
  type CloudFrameColors,
  type CloudFrameSources,
  cloudFrameColors,
  frameContrast,
  frameDistance,
} from '../src/renderer/lib/cloud-frames.js';
import { parseCssColor, rgbToHsl } from '../src/renderer/lib/css-color.js';
import { WALLPAPER_TINT_ALPHA_MAX } from '../src/renderer/lib/wallpaper-image.js';
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

const CANVAS = path.join(RENDERER_ROOT, 'styles', 'canvas.css');
const PUBLICATIONS = path.join(RENDERER_ROOT, 'styles', 'screens', 'publications.css');

const THEMES = fs
  .readdirSync(THEMES_DIR)
  .filter((file) => file.endsWith('.css'))
  .map((file) => file.replace(/\.css$/, ''))
  .sort();

const canvasCss = fs.readFileSync(CANVAS, 'utf8');

/** Нормализованный селектор правила: пробелы убраны. */
function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, '');
}

/** Тело правила по селектору; `null` — правила нет. */
function ruleBody(css: string, selector: string): string | null {
  const text = stripCssComments(css);
  const wanted = normalizeSelector(selector);
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
    if (prelude.split(',').some((part) => normalizeSelector(part) === wanted)) {
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

/** Подменить объявление в теле правила реального файла (мутационная проба). */
function mutateFirstDeclaration(
  css: string,
  selector: string,
  property: string,
  next: string,
): string {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `мутация: в canvas.css нет правила ${selector}`);
  const end = css.indexOf('}', at);
  const body = css.slice(at, end);
  const re = new RegExp(`(${property}\\s*:\\s*)([^;]+);`);
  assert.ok(re.test(body), `мутация: в правиле ${selector} нет свойства ${property}`);
  return css.slice(0, at) + body.replace(re, `$1${next};`) + css.slice(end);
}

/** Нейтральный серый (0..255) с заданной относительной яркостью WCAG. */
function grayForLuminance(luminance: number): number[] {
  const channel =
    luminance <= 0.0031308 ? luminance * 12.92 : 1.055 * luminance ** (1 / 2.4) - 0.055;
  const value = Math.round(Math.max(0, Math.min(1, channel)) * 255);
  return [value, value, value];
}

/** Токены блока темы; ассерт, если блока режима нет. */
function themeTokens(theme: string, mode: ThemeMode): Map<string, string> {
  const body = themeBlockBody(readTheme(theme), theme, mode);
  assert.ok(body !== null, `тема ${theme} (${mode}): нет блока режима`);
  return declaredTokens(body);
}

/** Источники рамок базового слоя из токенов блока темы. */
function themeSources(theme: string, mode: ThemeMode): CloudFrameSources {
  const tokens = themeTokens(theme, mode);
  return {
    stripe: null,
    cursor: tokens.get('--cursor') ?? '',
    selection: tokens.get('--selection') ?? '',
    background: tokens.get('--bg') ?? '',
  };
}

// ---------------------------------------------------------------------------
// 1. Статические инварианты реального canvas.css
// ---------------------------------------------------------------------------

/** Толщина цветного кольца и канта в объявлении `box-shadow` (spread). */
function shadowSpreads(body: string | null, token: string): number[] {
  const value = declaration(body, 'box-shadow') ?? '';
  const spreads: number[] = [];
  for (const layer of value.split(',')) {
    if (!layer.includes(token)) continue;
    const match = /0 0 0 (\d+)px/.exec(layer);
    assert.ok(match !== null, `слой тени «${layer.trim()}» без spread 0 0 0 <n>px`);
    spreads.push(Number(match[1]));
  }
  return spreads;
}

/**
 * Нарушения оформления рамок в переданном CSS. Вынесено функцией, чтобы ТА ЖЕ
 * проверка гонялась по мутированной копии реального файла.
 */
function frameCssProblems(css: string): string[] {
  const problems: string[] = [];
  for (const selector of ['.cloud.halo', '.cloud.focus-cloud.halo']) {
    const body = ruleBody(css, selector);
    if (body === null) {
      problems.push(`${selector}: правила нет`);
      continue;
    }
    const border = declaration(body, 'border-color') ?? '';
    if (!border.startsWith('var(--frame-open')) {
      problems.push(`${selector}: цвет рамки не --frame-open (${border || '(нет)'})`);
    }
    // Производность от слоя считается в JS (lib/cloud-frames.ts) — если полоса
    // вернётся в CSS, три состояния перестанут быть производными все вместе.
    if (border.includes('--layer-focus-stripe')) {
      problems.push(`${selector}: цвет рамки снова зависит от полосы слоя в CSS`);
    }
    const rings = shadowSpreads(body, 'var(--frame-open');
    if (rings.length !== 1 || rings[0] !== CLOUD_FRAME_RING_PX) {
      problems.push(
        `${selector}: цветное кольцо ${rings.join('/') || '(нет)'}px ≠ ${CLOUD_FRAME_RING_PX}px`,
      );
    }
    const hairlines = shadowSpreads(body, 'var(--focus-ring-contrast)');
    if (hairlines.length !== 1 || hairlines[0] !== CLOUD_FRAME_HAIRLINE_OFFSET_PX) {
      problems.push(
        `${selector}: кант ${hairlines.join('/') || '(нет)'}px ≠ ${CLOUD_FRAME_HAIRLINE_OFFSET_PX}px ` +
          `(кольцо ${CLOUD_FRAME_RING_PX}px + кант ${CLOUD_FRAME_HAIRLINE_PX}px)`,
      );
    }
  }
  if (CLOUD_FRAME_HAIRLINE_PX > CLOUD_FRAME_RING_PX) {
    problems.push(
      `кант ${CLOUD_FRAME_HAIRLINE_PX}px толще кольца ${CLOUD_FRAME_RING_PX}px — рамка давит`,
    );
  }
  const selected = declaration(ruleBody(css, '.cloud.selected'), 'outline') ?? '';
  if (!selected.includes('var(--frame-selected')) {
    problems.push(`.cloud.selected: рамка не --frame-selected (${selected || '(нет)'})`);
  }
  const cursorBody = ruleBody(css, '.cloud.kbd-cursor');
  const cursor = declaration(cursorBody, 'outline') ?? '';
  if (!cursor.includes('var(--frame-current')) {
    problems.push(`.cloud.kbd-cursor: пунктир не --frame-current (${cursor || '(нет)'})`);
  }
  if (!cursor.startsWith('2px dashed')) {
    problems.push(`.cloud.kbd-cursor: пунктир перестал быть пунктиром (${cursor || '(нет)'})`);
  }
  if (declaration(cursorBody, 'box-shadow') !== null) {
    problems.push('.cloud.kbd-cursor: у пунктира появился кант (ADR e6d48e09)');
  }
  return problems;
}

describe('сторож: рамки трёх состояний — оформление реального canvas.css', () => {
  it('все три состояния — свои токены --frame-*, кант открытой 1px', () => {
    assert.deepEqual(frameCssProblems(canvasCss), []);
  });

  it('контрастный кант остаётся общим токеном тем (не удалён)', () => {
    // Токен нужен текстовым ролям (оглавление публикаций, дневник хроники) и
    // рамке открытого в «Публикациях»: удалять его нельзя (требование 3af98e31).
    const publications = fs.readFileSync(PUBLICATIONS, 'utf8');
    assert.match(
      publications,
      /color:\s*var\(--focus-ring-contrast\)/,
      'текстовые роли публикаций потеряли контрастный кант',
    );
    assert.match(
      publications,
      /var\(--focus-ring-contrast\)/,
      'рамка открытого блока публикации потеряла кант',
    );
    for (const theme of THEMES) {
      for (const mode of THEME_MODES) {
        assert.match(
          themeBlockBody(readTheme(theme), theme, mode) ?? '',
          /--focus-ring-contrast:\s*#[0-9a-f]{6};/i,
          `${theme}.css [${mode}]: кант объявлен`,
        );
      }
    }
  });

  it('мутации реального canvas.css ловятся: 4px, полоса слоя в CSS, старые токены', () => {
    assert.deepEqual(frameCssProblems(canvasCss), [], 'рабочий файл обязан быть чистым');
    // 1. Возврат прежнего 4px канта (замечание заказчика «траурная рамка»).
    const thick = canvasCss.replaceAll(
      `0 0 0 ${CLOUD_FRAME_HAIRLINE_OFFSET_PX}px var(--focus-ring-contrast)`,
      '0 0 0 4px var(--focus-ring-contrast)',
    );
    assert.notEqual(thick, canvasCss, 'мутация канта не применилась');
    assert.ok(frameCssProblems(thick).length > 0, 'кант 4px обязан ловиться');
    // 2. Возврат полосы слоя в CSS вместо расчёта трёх состояний.
    const stripeStyle = mutateFirstDeclaration(
      canvasCss,
      '.cloud.halo {',
      'border-color',
      'var(--layer-focus-stripe, var(--focus-accent, var(--accent)))',
    );
    assert.ok(frameCssProblems(stripeStyle).length > 0, 'полоса слоя в CSS обязана ловиться');
    // 3. Прежняя рамка выделенных — напрямую `--selection`.
    const selected = mutateFirstDeclaration(
      canvasCss,
      '.cloud.selected {',
      'outline',
      '2px solid var(--selection)',
    );
    assert.ok(frameCssProblems(selected).length > 0, 'прежний --selection обязан ловиться');
    // 4. Прежний пунктир — напрямую `--cursor`.
    const cursor = mutateFirstDeclaration(
      canvasCss,
      '.cloud.kbd-cursor {',
      'outline',
      '2px dashed var(--cursor)',
    );
    assert.ok(frameCssProblems(cursor).length > 0, 'прежний --cursor обязан ловиться');
    // 5. Инвариант самой константы: кант не толще кольца (4px давали «траурную»
    //    рамку — мутация константы обязана краснить).
    assert.ok(
      CLOUD_FRAME_HAIRLINE_PX <= CLOUD_FRAME_RING_PX,
      `кант ${CLOUD_FRAME_HAIRLINE_PX}px обязан быть не толще кольца ${CLOUD_FRAME_RING_PX}px`,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Цвета трёх состояний от токенов темы (12 блоков)
// ---------------------------------------------------------------------------

interface FrameBlock {
  theme: string;
  mode: ThemeMode;
  sources: CloudFrameSources;
  frames: CloudFrameColors;
}

/** Рамки всех 12 блоков тем, посчитанные тем же модулем, что и в продукте. */
function themeFrameBlocks(): FrameBlock[] {
  const blocks: FrameBlock[] = [];
  for (const theme of THEMES) {
    for (const mode of THEME_MODES) {
      const sources = themeSources(theme, mode);
      const frames = cloudFrameColors(sources);
      assert.ok(frames !== null, `${theme} (${mode}): цвета рамок не посчитаны`);
      blocks.push({ theme, mode, sources, frames });
    }
  }
  return blocks;
}

/**
 * Нарушения инвариантов цвета рамок в темах. Расчёт передаётся функцией —
 * негативная проба гоняет ТУ ЖЕ проверку на подменённом (прежнем) расчёте.
 */
function themeFrameProblems(
  blocks: readonly FrameBlock[],
  derived: (sources: CloudFrameSources) => CloudFrameColors | null = cloudFrameColors,
): string[] {
  const problems: string[] = [];
  const opens: Array<{ key: string; rgb: number[] }> = [];
  for (const block of blocks) {
    const label = `${block.theme} (${block.mode})`;
    const frames = derived(block.sources);
    if (frames === null) {
      problems.push(`${label}: цвета не посчитаны`);
      continue;
    }
    const background = parseCssColor(block.sources.background);
    assert.ok(background !== null, `${label}: --bg не цвет`);
    const rgb: Record<keyof CloudFrameColors, number[] | null> = {
      open: parseCssColor(frames.open),
      current: parseCssColor(frames.current),
      selected: parseCssColor(frames.selected),
    };
    for (const state of ['open', 'current', 'selected'] as const) {
      const value = rgb[state];
      assert.ok(value !== null, `${label}: цвет ${state} не разобран (${frames[state]})`);
      const contrast = frameContrast(value, background);
      if (contrast < CLOUD_FRAME_CONTRAST_MIN) {
        problems.push(
          `${label}: ${state} ${contrast.toFixed(2)} : 1 < ${CLOUD_FRAME_CONTRAST_MIN}`,
        );
      }
    }
    opens.push({ key: label, rgb: rgb.open! });
    const pairs: Array<[string, number[], number[]]> = [
      ['открытая ↔ текущая', rgb.open!, rgb.current!],
      ['открытая ↔ выделенная', rgb.open!, rgb.selected!],
      ['текущая ↔ выделенная', rgb.current!, rgb.selected!],
    ];
    for (const [pair, left, right] of pairs) {
      const distance = frameDistance(left, right);
      if (distance < CLOUD_FRAME_DISTANCE_MIN) {
        problems.push(`${label}: ${pair} Δ ${distance.toFixed(0)} < ${CLOUD_FRAME_DISTANCE_MIN}`);
      }
    }
  }
  // Между темами: один и тот же цвет на все темы — дефект («цвета рамок
  // кажутся одинаковыми во всех темах»).
  let nearest = { distance: Number.POSITIVE_INFINITY, left: '', right: '' };
  for (let i = 0; i < opens.length; i += 1) {
    for (let j = i + 1; j < opens.length; j += 1) {
      const distance = frameDistance(opens[i]!.rgb, opens[j]!.rgb);
      if (distance < nearest.distance) {
        nearest = { distance, left: opens[i]!.key, right: opens[j]!.key };
      }
    }
  }
  if (nearest.distance < CLOUD_FRAME_THEME_DISTANCE_MIN) {
    problems.push(
      `открытая рамка не различается между темами: ${nearest.left} ↔ ${nearest.right} ` +
        `Δ ${nearest.distance.toFixed(1)} < ${CLOUD_FRAME_THEME_DISTANCE_MIN}`,
    );
  }
  return problems;
}

describe('сторож: цвета трёх состояний в 12 блоках тем', () => {
  it('контраст ≥ 3 : 1, попарная различимость ≥ 40, различие тем ≥ 25', () => {
    const problems = themeFrameProblems(themeFrameBlocks());
    assert.deepEqual(problems, [], `цвета рамок нарушают инварианты:\n  ${problems.join('\n  ')}`);
  });

  it('открытая — «в тон, но ярче» курсора, а не кант темы', () => {
    // Прежний вид: рамку красил кант `--focus-ring-contrast` (в current light
    // #1b2436 — почти чёрный, «траурная рамка»). Теперь открытая — тот же тон,
    // что у пунктира, но светлее; кант темы остался только 1px-обводкой.
    for (const block of themeFrameBlocks()) {
      const tokens = themeTokens(block.theme, block.mode);
      const cursorHex = tokens.get('--cursor') ?? '';
      const ringHex = tokens.get('--focus-ring-contrast') ?? '';
      const open = parseCssColor(block.frames.open)!;
      const cursor = parseCssColor(cursorHex)!;
      assert.ok(
        rgbToHsl(open)[2] > rgbToHsl(cursor)[2],
        `${block.theme} (${block.mode}): открытая не светлее курсора (${block.frames.open} vs ${cursorHex})`,
      );
      assert.notEqual(
        block.frames.open.toLowerCase(),
        ringHex.toLowerCase(),
        `${block.theme} (${block.mode}): открытая совпала с кантом темы ${ringHex}`,
      );
    }
  });

  it('с картинкой любой светлоты: хотя бы одно кольцо читается ≥ 3 : 1', () => {
    // Обои красятся тинтом цвета фона темы (доля ≤ WALLPAPER_TINT_ALPHA_MAX),
    // поэтому подложка — композит «фон темы + картинка» (как в
    // guard-canvas-overlay-layers для плашек). Сама по себе картинка бывает
    // любой светлоты: инвариант — цветное кольцо (2px) ИЛИ кант (1px) даёт
    // ≥ 3 : 1 на ЛЮБОМ тоне. Факт: худший случай 4.26 : 1 (nordic dark на
    // белой картинке).
    const problems: string[] = [];
    let worst = { ratio: Number.POSITIVE_INFINITY, key: '' };
    for (const block of themeFrameBlocks()) {
      const tokens = themeTokens(block.theme, block.mode);
      const background = parseCssColor(block.sources.background)!;
      const open = parseCssColor(block.frames.open)!;
      const ring = parseCssColor(tokens.get('--focus-ring-contrast') ?? '')!;
      for (let step = 0; step <= 20; step += 1) {
        const luminance = step / 20;
        const picture = grayForLuminance(luminance);
        const backdrop = picture.map(
          (channel, index) =>
            WALLPAPER_TINT_ALPHA_MAX * channel + (1 - WALLPAPER_TINT_ALPHA_MAX) * background[index]!,
        );
        const best = Math.max(frameContrast(open, backdrop), frameContrast(ring, backdrop));
        if (best < worst.ratio) {
          worst = { ratio: best, key: `${block.theme} ${block.mode}, светлота ${luminance}` };
        }
        if (best < CLOUD_FRAME_CONTRAST_MIN) {
          problems.push(
            `${block.theme} (${block.mode}), картинка ${luminance}: ${best.toFixed(2)} : 1`,
          );
        }
      }
    }
    assert.deepEqual(
      problems,
      [],
      `хотя бы одно кольцо открытой обязано читаться на картинке:\n  ${problems
        .slice(0, 10)
        .join('\n  ')}`,
    );
    assert.ok(worst.ratio >= CLOUD_FRAME_CONTRAST_MIN, `худшее ${worst.key}`);
  });

  it('мутации расчёта ловятся: без подъёма светлоты и один цвет на все темы', () => {
    const blocks = themeFrameBlocks();
    assert.deepEqual(themeFrameProblems(blocks), [], 'рабочий расчёт обязан быть чистым');
    // 1. Открытая = курсор (нет подъёма светлоты): открытая и текущая совпали.
    const noLift = (sources: CloudFrameSources): CloudFrameColors | null => {
      const base = cloudFrameColors(sources);
      return base === null ? null : { ...base, open: base.current };
    };
    assert.ok(
      themeFrameProblems(blocks, noLift).length > 0,
      'совпадение открытой и текущей ловится',
    );
    // 2. Прежний кант темы на все темы и состояния («одинаковые во всех темах»).
    const ring = themeTokens('current', 'light').get('--focus-ring-contrast') ?? '#1b2436';
    const ringEverywhere = (): CloudFrameColors => ({ open: ring, current: ring, selected: ring });
    assert.ok(
      themeFrameProblems(blocks, ringEverywhere).length > 0,
      'один цвет на все темы и состояния обязан ловиться',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Производность от полосы активного слоя
// ---------------------------------------------------------------------------

/** Полосы, на которых проверяется деривация: цвета слоёв и крайние случаи. */
const STRIPES = [
  '#7e57c2',
  '#643da8',
  '#ffd400',
  '#ff5fa2',
  '#22c55e',
  '#0ea5e9',
  '#c02f77',
  '#2fbfae',
  '#111111',
  '#ffffff',
  '#808080',
  '#f5f5f5',
  '#ffe9f0',
  '#f5d0ff',
  '#001a0a',
] as const;

/** Фоны холста слоя, на которых проверяется деривация. */
const LAYER_BACKGROUNDS = ['#ffffff', '#101010', '#ded8ec', '#191327'] as const;

/** Источники рамок слоя: полоса своя, токены темы — как в продукте. */
function layerSources(stripe: string, background: string): CloudFrameSources {
  const tokens = themeTokens('current', 'light');
  return {
    stripe,
    cursor: tokens.get('--cursor') ?? '',
    selection: tokens.get('--selection') ?? '',
    background,
  };
}

/**
 * Нарушения деривации от полосы слоя. `derived` подменяется негативной пробой.
 */
function layerFrameProblems(
  derived: (sources: CloudFrameSources) => CloudFrameColors | null = cloudFrameColors,
  stripes: readonly string[] = STRIPES,
): string[] {
  const problems: string[] = [];
  for (const background of LAYER_BACKGROUNDS) {
    const seen = new Map<string, string>();
    for (const stripe of stripes) {
      const frames = derived(layerSources(stripe, background));
      if (frames === null) {
        problems.push(`фон ${background}, полоса ${stripe}: цвета не посчитаны`);
        continue;
      }
      const rgb = {
        open: parseCssColor(frames.open)!,
        current: parseCssColor(frames.current)!,
        selected: parseCssColor(frames.selected)!,
      };
      const backgroundRgb = parseCssColor(background)!;
      const openContrast = frameContrast(rgb.open, backgroundRgb);
      if (openContrast < CLOUD_FRAME_CONTRAST_MIN) {
        problems.push(
          `фон ${background}, полоса ${stripe}: открытая ${openContrast.toFixed(2)} : 1 < ${CLOUD_FRAME_CONTRAST_MIN}`,
        );
      }
      const band = frameDistance(rgb.open, parseCssColor(stripe)!);
      if (band < CLOUD_FRAME_DISTANCE_MIN) {
        problems.push(
          `фон ${background}, полоса ${stripe}: открытая слилась с полосой Δ ${band.toFixed(0)}`,
        );
      }
      const pairs: Array<[string, number[], number[]]> = [
        ['открытая ↔ текущая', rgb.open, rgb.current],
        ['открытая ↔ выделенная', rgb.open, rgb.selected],
        ['текущая ↔ выделенная', rgb.current, rgb.selected],
      ];
      for (const [pair, left, right] of pairs) {
        const distance = frameDistance(left, right);
        if (distance < CLOUD_FRAME_DISTANCE_MIN) {
          problems.push(
            `фон ${background}, полоса ${stripe}: ${pair} Δ ${distance.toFixed(0)} < ${CLOUD_FRAME_DISTANCE_MIN}`,
          );
        }
      }
      // Производность: другая полоса — другой набор цвета.
      const signature = `${frames.open}/${frames.current}/${frames.selected}`;
      const previous = seen.get(signature);
      if (previous !== undefined) {
        problems.push(
          `фон ${background}: полосы ${previous} и ${stripe} дают одинаковые рамки — рамки не производны`,
        );
      }
      seen.set(signature, stripe);
    }
  }
  return problems;
}

describe('сторож: рамки трёх состояний производны от полосы активного слоя', () => {
  it('набор полос и фонов: открытая ≥ 3 : 1, попарные Δ ≥ 40, открытая ≠ полоса', () => {
    const problems = layerFrameProblems();
    assert.deepEqual(problems, [], `деривация от слоя нарушена:\n  ${problems.join('\n  ')}`);
  });

  it('полоса слоя перекрашивает ВСЕ три состояния, а не только открытую', () => {
    const theme = layerSources('#7e57c2', '#eef0f4');
    const base = cloudFrameColors({ ...theme, stripe: null })!;
    const layer = cloudFrameColors(theme)!;
    for (const state of ['open', 'current', 'selected'] as const) {
      assert.notEqual(layer[state], base[state], `состояние ${state} не перекрасилось от слоя`);
    }
  });

  it('мутации деривации ловятся: слой игнорируется, все три состояния одного цвета', () => {
    assert.deepEqual(layerFrameProblems(), [], 'рабочая деривация обязана быть чистой');
    // 1. Полоса игнорируется (прежнее поведение: от слоя зависел только 1px).
    const ignoreStripe = (sources: CloudFrameSources): CloudFrameColors | null =>
      cloudFrameColors({ ...sources, stripe: null });
    assert.ok(
      layerFrameProblems(ignoreStripe).length > 0,
      'игнорирование полосы слоя обязано ловиться',
    );
    // 2. Все три состояния одного цвета (например, только осветлённая полоса).
    const oneColor = (sources: CloudFrameSources): CloudFrameColors | null => {
      const base = cloudFrameColors(sources);
      return base === null ? null : { open: base.open, current: base.open, selected: base.open };
    };
    assert.ok(
      layerFrameProblems(oneColor).length > 0,
      'совпадение трёх состояний обязано ловиться',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Живая проводка: смена темы и полосы перекрашивает рамки тем же тиком
// ---------------------------------------------------------------------------

describe('сторож: --frame-* перекрашиваются тем же тиком store (без stale-класса)', () => {
  type LayerColorsModule = typeof import('../src/renderer/lib/layer-colors.js');

  const LAYER_ID = '00000000-0000-4000-8000-0000000000aa';

  let layerColors: LayerColorsModule;
  let root: ShimElement;

  /** Записать токены блока темы в корень документа — как это делает CSS. */
  function setThemeTokens(theme: string, mode: ThemeMode): void {
    const tokens = themeTokens(theme, mode);
    for (const name of ['--bg', '--cursor', '--selection', '--focus-ring-contrast']) {
      root.style.setProperty(name, tokens.get(name) ?? '');
    }
    root.style.removeProperty('--layer-bg');
    root.style.removeProperty('--layer-focus-stripe');
  }

  /** Текущие `--frame-*` корня документа. */
  function frames(): CloudFrameColors {
    return {
      open: root.style.getPropertyValue('--frame-open'),
      current: root.style.getPropertyValue('--frame-current'),
      selected: root.style.getPropertyValue('--frame-selected'),
    };
  }

  /** Слой с парой цветов на режим (как его отдаёт сервер). */
  function layer(stripe: { dark: string; light: string }): Record<string, unknown> {
    return {
      id: LAYER_ID,
      title: 'Проба рамок',
      is_base: false,
      colors: {
        focus_stripe: stripe,
        background: { dark: '#191327', light: '#ded8ec' },
      },
    };
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

  it('без слоя рамки идут от токенов темы и перекрашиваются сменой темы', () => {
    setThemeTokens('current', 'light');
    store.update({ uiTheme: 'current', theme: 'light', layers: [], currentLayer: null });
    layerColors.refreshLayerTheme();

    assert.deepEqual(
      frames(),
      cloudFrameColors(themeSources('current', 'light')),
      'базовый слой: рамки от токенов темы',
    );
    const lightFrames = frames();

    // Смена темы без перезагрузки: атрибуты темы уже применены (как в
    // applyUiTheme), тик store пересчитывает рамки тем же проходом.
    setThemeTokens('catppuccin', 'dark');
    store.update({ uiTheme: 'catppuccin', theme: 'dark' });
    layerColors.refreshLayerTheme();

    assert.deepEqual(
      frames(),
      cloudFrameColors(themeSources('catppuccin', 'dark')),
      'смена темы: рамки пересчитаны',
    );
    assert.notEqual(frames().open, lightFrames.open, 'рамка открытой перекрасилась вместе с темой');
  });

  it('слой с полосой: все три рамки производны от неё, смена полосы перекрашивает', () => {
    setThemeTokens('current', 'light');
    const violet = { dark: '#7e57c2', light: '#643da8' };
    store.update({
      uiTheme: 'current',
      theme: 'light',
      layers: [layer(violet) as never],
      currentLayer: { id: LAYER_ID, title: 'Проба рамок' } as never,
    });
    layerColors.refreshLayerTheme();

    assert.deepEqual(
      frames(),
      cloudFrameColors(layerSources(violet.light, '#ded8ec')),
      'на слое рамки считаются от его полосы',
    );
    assert.equal(root.style.getPropertyValue('--layer-focus-stripe'), violet.light);
    const violetFrames = frames();

    // Тот же слой (тот же id) — правка цвета полосы: ключ обязан её увидеть.
    const yellow = { dark: '#ffd400', light: '#ffd400' };
    store.update({
      layers: [layer(yellow) as never],
      currentLayer: { id: LAYER_ID, title: 'Проба рамок' } as never,
    });
    layerColors.refreshLayerTheme();

    assert.deepEqual(
      frames(),
      cloudFrameColors(layerSources('#ffd400', '#ded8ec')),
      'смена цвета полосы: рамки пересчитаны',
    );
    for (const state of ['open', 'current', 'selected'] as const) {
      assert.notEqual(
        frames()[state],
        violetFrames[state],
        `состояние ${state} не перекрасилось при смене полосы слоя`,
      );
    }
  });
});
