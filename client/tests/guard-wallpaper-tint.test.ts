/**
 * Сторож: лёгкий тинт подложки и его распространение на экраны (0.16.1, задача
 * 80324150, этап 2; требование e6d586d3, сценарий 3fe62610).
 *
 * Зачем. Срез заказчика 2026-11-13: тинт 0.45–0.8 забивал картинку — она
 * «почти не видна». Этап 2 снизил плотность до 0.25–0.55, второй круг среза —
 * до 0.12–0.30 (картинка не читалась и на 0.25), и размножил лёгкую
 * вуаль цвета фона темы на фон прочих экранов, чтобы клиент был тонально связан
 * с картой. Правило, которое можно нарушить незаметно для глаза разработчика:
 *
 *  1. вернуть плотный диапазон (константы в `lib/wallpaper-image.ts`);
 *  2. потерять тинт-слой у одного из экранов — он выпадет из общей тональности;
 *  3. затащить тинт на НЕПРОЗРАЧНЫЕ контентные поверхности (облачка, панели,
 *     модалки) — там картинки нет, а требование «карточки остаются
 *     тематическими» нарушится.
 *
 * Проверки:
 *  • числовые инварианты диапазона и факторов (мутация константы краснит);
 *  • фон каждого из 5 экранов содержит `var(--wallpaper-screen-tint, transparent)`
 *    первым слоем и сохраняет `var(--layer-bg, var(--bg))` последним;
 *  • тинт-переменная встречается РОВНО в этих правилах (whitelist селекторов) —
 *    новая поверхность обязана попасть в список осознанно;
 *  • негативная проба: правило без тинт-слоя проверкой не проходит.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  WALLPAPER_SCREEN_TINT_FACTOR,
  WALLPAPER_TINT_ALPHA_MAX,
  WALLPAPER_TINT_ALPHA_MIN,
  WALLPAPER_TINT_LAYER_FACTOR,
  wallpaperScreenTintAlpha,
  wallpaperTintAlpha,
} from '../src/renderer/lib/wallpaper-image.js';
import { RENDERER_ROOT, readRendererCss } from './renderer-css.js';
import { stripCssComments, topLevelBlocks } from './theme-css.js';

/** Ссылка на тинт экранов: пустая переменная = прозрачный слой. */
const SCREEN_TINT_REF = 'var(--wallpaper-screen-tint, transparent)';

/** Экраны, чей фон обязан тонироваться активной картинкой карты. */
const SCREEN_RULES: Array<{ file: string; selector: string }> = [
  { file: 'styles/screens/chronicle.css', selector: '.chronicle' },
  { file: 'styles/screens/events.css', selector: '.activity' },
  { file: 'styles/screens/publications.css', selector: '.publications' },
  { file: 'styles/screens/publications.css', selector: '.pub-ws-host' },
  { file: 'styles/filter-panel.css', selector: '.st-results' },
];

/** Нормализованный селектор: убрать пробелы (в т.ч. переводы строк в списках). */
function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, '');
}

/** Тело правила по селектору или `null`, если правила нет. */
function ruleBody(file: string, selector: string): string | null {
  const css = fs.readFileSync(path.join(RENDERER_ROOT, file), 'utf8');
  const wanted = normalizeSelector(selector);
  const block = topLevelBlocks(css).find((item) =>
    item.prelude.split(',').some((part) => normalizeSelector(part) === wanted),
  );
  return block?.body ?? null;
}

/** Значение объявления `background` (до `;`, комментарии убраны). */
function backgroundOf(body: string): string | null {
  const match = /(?:^|[;{\s])background\s*:\s*([\s\S]*?);/.exec(stripCssComments(body));
  return match ? match[1]!.replace(/\s+/g, ' ').trim() : null;
}

/** Блоки собранного CSS рендерера, в фоне которых есть тинт экранов. */
function tintedPreludes(css: string): string[] {
  return topLevelBlocks(css)
    .filter((block) => block.body.includes('--wallpaper-screen-tint'))
    .map((block) => block.prelude)
    .sort();
}

describe('сторож: плотность тинта — лёгкая, экраны слабее карты (этап 2)', () => {
  it('диапазон карты удерживает различимость картинки', () => {
    // Ориентир заказчика после второго среза ~0.12–0.30: α — доля цвета темы
    // поверх картинки, поэтому до глаза доходит (1 − α) её диапазона яркости.
    assert.ok(
      WALLPAPER_TINT_ALPHA_MIN >= 0.1 && WALLPAPER_TINT_ALPHA_MIN <= 0.2,
      `нижняя граница вне ориентира 0.1–0.2: ${WALLPAPER_TINT_ALPHA_MIN}`,
    );
    assert.ok(
      WALLPAPER_TINT_ALPHA_MAX <= 0.32,
      `верхняя граница выше 0.32 — картинка снова забита: ${WALLPAPER_TINT_ALPHA_MAX}`,
    );
    assert.ok(WALLPAPER_TINT_ALPHA_MAX > WALLPAPER_TINT_ALPHA_MIN, 'диапазон не вырожден');
    assert.ok(1 - WALLPAPER_TINT_ALPHA_MIN >= 0.8, 'минимум сохраняет ≥ 80 % диапазона');
    assert.ok(1 - WALLPAPER_TINT_ALPHA_MAX >= 0.65, 'максимум сохраняет ≥ 65 % диапазона');
  });

  it('слой и экраны слабее основы карты', () => {
    assert.ok(WALLPAPER_TINT_LAYER_FACTOR < 1, 'тинт слоя прозрачнее основы');
    assert.ok(WALLPAPER_SCREEN_TINT_FACTOR < 1, 'тинт экранов слабее карты');
    for (const baseLuminance of [0, 0.15, 0.5, 0.9]) {
      for (let imageLuminance = 0; imageLuminance <= 1; imageLuminance += 0.1) {
        const map = wallpaperTintAlpha(imageLuminance, baseLuminance, false);
        const screen = wallpaperScreenTintAlpha(imageLuminance, baseLuminance, false);
        assert.ok(
          screen < map,
          `экран (${screen.toFixed(3)}) не слабее карты (${map.toFixed(3)}) ` +
            `при светлоте картинки ${imageLuminance.toFixed(1)}`,
        );
      }
    }
  });
});

describe('сторож: тинт картинки доходит до фона остальных экранов', () => {
  it('фон каждого экрана подмешивает тинт первым слоем', () => {
    for (const { file, selector } of SCREEN_RULES) {
      const body = ruleBody(file, selector);
      assert.ok(body !== null, `${file}: нет правила ${selector}`);
      const background = backgroundOf(body);
      assert.ok(background !== null, `${file} ${selector}: нет объявления background`);
      assert.ok(
        background!.includes(SCREEN_TINT_REF),
        `${file} ${selector}: фон не тонируется картинкой (${background})`,
      );
      assert.ok(
        background!
          .replace(/\s+/g, '')
          .startsWith(`linear-gradient(${SCREEN_TINT_REF}`.replace(/\s+/g, '')),
        `${file} ${selector}: тинт должен быть ПЕРВЫМ слоем фона (${background})`,
      );
      assert.ok(
        background!.replace(/\s+/g, '').endsWith('var(--layer-bg,var(--bg))'),
        `${file} ${selector}: фон слоя/темы потерян (${background})`,
      );
    }
  });

  it('тинт встречается только в правилах экранов — не на контентных поверхностях', () => {
    const expected = SCREEN_RULES.map((rule) => rule.selector).sort();
    const actual = tintedPreludes(readRendererCss());
    assert.deepEqual(
      actual,
      expected,
      'тинт экранов обязан жить только на фонах экранов; облачка, панели и ' +
        'модалки остаются непрозрачными тематическими (требование e6d586d3).\n' +
        `Найдено: ${actual.join(', ')}`,
    );
  });

  it('негативная проба: правило без тинт-слоя сторож замечает', () => {
    const css = `.chronicle {
  background: var(--layer-bg, var(--bg));
}`;
    const body = topLevelBlocks(css)[0]?.body;
    assert.ok(body !== undefined);
    const background = backgroundOf(body);
    assert.equal(
      background?.includes(SCREEN_TINT_REF),
      false,
      'именно такое правило сторож и обязан отбраковывать',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Сетка холста — только без картинки (требование b8719e86, задача 2bf4b53e)
// ---------------------------------------------------------------------------

/** Тело правила по селектору в переданном CSS (без чтения с диска). */
function ruleBodyInCss(css: string, selector: string): string | null {
  const wanted = normalizeSelector(selector);
  const block = topLevelBlocks(css).find((item) =>
    item.prelude.split(',').some((part) => normalizeSelector(part) === wanted),
  );
  return block?.body ?? null;
}

/**
 * Нарушения правила «сетка только без картинки»:
 *   • базовое правило `.canvas` обязано рисовать точечную сетку
 *     (`radial-gradient` с `--canvas-dot`): без неё пропадает ориентир масштаба;
 *   • фон с активной картинкой (`:root[data-canvas-wallpaper='on'] .canvas`)
 *     обязан её показывать (`--canvas-wallpaper-image`) и НЕ рисовать сетку —
 *     картинка и точки вместе дают грязный фон.
 */
export function gridProblems(css: string): string[] {
  const problems: string[] = [];
  const base = ruleBodyInCss(css, '.canvas');
  if (base === null) {
    problems.push('нет правила .canvas');
  } else {
    const background = backgroundOf(base);
    if (background === null) {
      problems.push('.canvas: нет объявления background');
    } else {
      if (!background.includes('radial-gradient')) {
        problems.push('.canvas: потеряна точечная сетка (radial-gradient)');
      }
      if (!background.includes('var(--canvas-dot)')) {
        problems.push('.canvas: цвет сетки не из токена --canvas-dot');
      }
    }
  }
  const wallpaper = ruleBodyInCss(css, ":root[data-canvas-wallpaper='on'] .canvas");
  if (wallpaper === null) {
    problems.push("нет правила :root[data-canvas-wallpaper='on'] .canvas");
  } else {
    const background = backgroundOf(wallpaper);
    if (background === null) {
      problems.push('фон с картинкой: нет объявления background');
    } else {
      if (!background.includes('var(--canvas-wallpaper-image)')) {
        problems.push('фон с картинкой не показывает --canvas-wallpaper-image');
      }
      if (background.includes('--canvas-dot') || /radial-gradient/i.test(background)) {
        problems.push('сетка холста показана поверх картинки (сетка — только без картинки)');
      }
      if (!background.replace(/\s+/g, '').includes('var(--layer-bg')) {
        problems.push('фон с картинкой потерял подложку слоя/темы (--layer-bg)');
      }
    }
  }
  return problems;
}

describe('сторож: сетка холста — только при отсутствии картинки', () => {
  const canvasCss = fs.readFileSync(path.join(RENDERER_ROOT, 'styles', 'canvas.css'), 'utf8');

  it('базовый холст рисует сетку, фон с картинкой — нет', () => {
    const problems = gridProblems(canvasCss);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('сторож краснеет на сетке поверх картинки и на пропавшей сетке', () => {
    const wallpaperSelector = ":root[data-canvas-wallpaper='on'] .canvas";
    // Негативная проба на РЕАЛЬНОМ файле: сетка вернулась в правило картинки.
    const dotOnWallpaper = canvasCss.replace(
      'var(--canvas-wallpaper-image) center / cover no-repeat fixed,',
      'radial-gradient(circle, var(--canvas-dot) 1px, transparent 1.4px) 0 0 / 24px 24px,\n    var(--canvas-wallpaper-image) center / cover no-repeat fixed,',
    );
    assert.notEqual(dotOnWallpaper, canvasCss, 'мутация «сетка поверх картинки» не применилась');
    assert.ok(
      ruleBodyInCss(dotOnWallpaper, wallpaperSelector) !== null,
      'правило фона с картинкой обязано читаться после мутации',
    );
    assert.ok(
      gridProblems(dotOnWallpaper).some((p) => p.includes('поверх картинки')),
      'сетка поверх картинки обязана краснить',
    );

    // Негативная проба: базовая сетка пропала (слой сетки снят из фона).
    const noGrid = canvasCss.replace(/radial-gradient\(circle,[^;]*?24px 24px,\s*/, '');
    assert.notEqual(noGrid, canvasCss, 'мутация «сетка пропала» не применилась');
    assert.ok(
      gridProblems(noGrid).some((p) => p.includes('потеряна точечная сетка')),
      'пропавшая сетка обязана краснить',
    );
  });
});
