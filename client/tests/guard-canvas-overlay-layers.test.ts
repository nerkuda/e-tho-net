/**
 * Сторож слоёв канвы и полосы фокуса (0.16.1, задача 80324150, доработка среза
 * 2026-11-13, круг 2; замечания заказчика 1–3).
 *
 * Зачем. Фоновая картинка и её тинт красятся фоном `.canvas`, а счётчики зон и
 * подписи-пустые состояния лежат выше по DOM — но их ВИДИМОСТЬ держится на
 * подобранных под однотонный фон темы цветах: на фотографии счётчик с
 * полупрозрачной плашкой и faint-подпись без контура «тонут». Кроме того,
 * z-порядок канвы многослойный (полоса фокуса 0, сетка/облачка 1, верхние слои
 * связей 6/7, анимационные копии 8) — счётчик с прежним z=4 оказывался под
 * анимационным слоем. Нарушения незаметны в коде, поэтому закрыты здесь:
 *
 *  • счётчики зон — верхний слой канвы (z выше всех слоёв 0–8), при активной
 *    картинке плашка непрозрачная тематическая (`--surface`);
 *  • подписи канвы (`.zone-empty`, `.canvas-empty`) — выше сетки зоны (z ≥ 2),
 *    при активной картинке — с контуром цвета фона темы;
 *  • полоса фокуса — видимая высота вдвое меньше (fade 90px вместо 180px),
 *    плотность −30 % (`--focus-band-opacity: 0.7`), затухание сохранено;
 *  • полоса остаётся заметной: контраст к подложке при максимальном тинте
 *    картинки ≥ 1.25 : 1 в обеих темах обоих режимов.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseCssColor } from '../src/renderer/lib/wallpaper-image.js';
import { RENDERER_ROOT } from './renderer-css.js';
import {
  THEME_MODES,
  declaredTokens,
  readTheme,
  stripCssComments,
  themeBlockBody,
} from './theme-css.js';

const CANVAS_CSS = path.join(RENDERER_ROOT, 'styles', 'canvas.css');
const TOKENS_CSS = path.join(RENDERER_ROOT, 'styles', 'tokens.css');

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

const canvasCss = fs.readFileSync(CANVAS_CSS, 'utf8');
const tokensCss = fs.readFileSync(TOKENS_CSS, 'utf8');

describe('сторож: счётчики и подписи канвы поверх всех фонов (замечания 1, 3)', () => {
  it('счётчик зоны — верхний слой канвы (z=12), выше анимационных копий (8)', () => {
    const z = declaration(ruleBody(canvasCss, '.zone-count'), 'z-index');
    assert.equal(z, '12', 'счётчик обязан лежать выше всех слоёв канвы');
    assert.ok(Number(z) > 8, 'анимационные слои канвы живут на z=8');
  });

  it('при активной картинке счётчик получает непрозрачную тематическую плашку', () => {
    const body = ruleBody(canvasCss, ":root[data-canvas-wallpaper='on'] .zone-count");
    assert.ok(body !== null, 'нет правила плашки счётчика при картинке');
    assert.equal(
      declaration(body, 'background'),
      'var(--surface)',
      'плашка счётчика над картинкой обязана быть непрозрачной тематической',
    );
  });

  it('подписи канвы выше сетки зоны и читаемы на картинке', () => {
    const z = declaration(ruleBody(canvasCss, '.zone-empty'), 'z-index');
    assert.equal(z, '2', 'подпись обязана быть выше сетки зоны (z=1)');
    const body = ruleBody(canvasCss, ":root[data-canvas-wallpaper='on'] .zone-empty");
    assert.ok(body !== null, 'нет правила подписи при картинке');
    const shadow = declaration(body, 'text-shadow');
    assert.ok(shadow !== null && shadow.includes('var(--bg)'), 'контур подписи — цвет фона темы');
    // Пустое состояние всего холста закрыто тем же правилом (список селекторов).
    assert.ok(
      canvasCss.includes(":root[data-canvas-wallpaper='on'] .canvas-empty"),
      'пустое состояние холста обязано читаться на картинке так же',
    );
  });

  it('негативная проба: прежние значения сторож не принимает', () => {
    const stale = '.zone-count {\n  position: absolute;\n  z-index: 4;\n}';
    assert.notEqual(declaration(ruleBody(stale, '.zone-count'), 'z-index'), '12');
  });
});

describe('сторож: полоса фокуса — вдвое ниже и на 30 % прозрачнее (замечание 2)', () => {
  /** Значение токена из `tokens.css` (объявлен в `:root`). */
  function token(name: string): string | null {
    for (const block of [ruleBody(tokensCss, ':root')]) {
      const value = declaredTokens(block ?? '').get(name);
      if (value !== undefined) return value;
    }
    return null;
  }

  it('токены: fade 90px (было 180px) и плотность 0.7', () => {
    assert.equal(token('--focus-band-fade'), '90px', 'видимая высота полосы уменьшена вдвое');
    assert.equal(token('--focus-band-opacity'), '0.7', 'плотность снижена на 30 %');
  });

  it('полоса красится этими токенами, затухание сохранено', () => {
    const body = ruleBody(canvasCss, '.canvas::before');
    assert.ok(body !== null, 'нет слоя полосы фокуса');
    assert.equal(declaration(body, 'opacity'), 'var(--focus-band-opacity, 0.7)');
    const background = declaration(body, 'background') ?? '';
    assert.ok(background.includes('var(--focus-band-fade, 90px)'), 'fallback fade — 90px');
    assert.ok(background.includes('transparent'), 'затухание полосы к краям сохранено');
  });

  it('полоса остаётся заметной при максимальном тинте картинки', () => {
    // Подложка в худшем случае: фон темы × картинка (три тона серой шкалы) при
    // α=0.30 (WALLPAPER_TINT_ALPHA_MAX). Полоса — цвет акцента при opacity 0.7.
    // Метрика — расстояние в sRGB, а не контраст WCAG: полоса отличается прежде
    // всего тоном (синий акцент на серо-синей подложке даёт яркостный контраст
    // ≈1:1, но видна отчётливо); по расстоянию реальные темы дают ≥ 79.
    const themes = ['blue-topaz', 'current'] as const;
    const problems: string[] = [];
    for (const theme of themes) {
      const css = readTheme(theme);
      for (const mode of THEME_MODES) {
        const body = themeBlockBody(css, theme, mode);
        assert.ok(body !== null, `тема ${theme} (${mode}): нет блока режима`);
        const tokens = declaredTokens(body);
        const bg = parseCssColor(tokens.get('--bg') ?? '');
        const accent = parseCssColor(tokens.get('--focus-accent') ?? tokens.get('--accent') ?? '');
        assert.ok(
          bg !== null && accent !== null,
          `${theme} (${mode}): --bg/--focus-accent не цвет`,
        );
        const mix = (top: number[], bottom: number[], alpha: number): number[] =>
          top.map((channel, index) => alpha * channel + (1 - alpha) * bottom[index]!);
        const distance = (left: number[], right: number[]): number =>
          Math.sqrt(left.reduce((sum, channel, index) => sum + (channel - right[index]!) ** 2, 0));
        for (const picture of [64, 128, 192]) {
          const backdrop = mix(bg!, [picture, picture, picture], 0.3);
          const band = mix(accent!, backdrop, 0.7);
          const delta = distance(band, backdrop);
          if (delta < 40)
            problems.push(`${theme} (${mode}), картинка ${picture}: Δ=${delta.toFixed(1)}`);
        }
      }
    }
    assert.deepEqual(
      problems,
      [],
      `полоса фокуса должна оставаться заметной (Δ sRGB ≥ 40):\n  ${problems.join('\n  ')}`,
    );
  });
});
