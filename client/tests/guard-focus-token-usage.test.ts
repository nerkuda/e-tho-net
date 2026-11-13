/**
 * Сторож «роли токена фокуса не смешиваются» (0.16.1, требование c19cbb81,
 * задачи 136575c9 и 2bf4b53e; ТП «Темы интерфейса клиента» 2122be30).
 *
 * Правило. У токена фокуса три роли, и каждая живёт на своём месте:
 *   1. **карта** — полоса фокуса слоя `--layer-focus-stripe` (и её рамки
 *      состояний `--frame-*`); на карте экранное кольцо не используется;
 *   2. **экраны** (отбор, дневник, события, публикации, модалки, списки
 *      `lib/ui`) — кольцо поверхностей `--layer-focus-ring-screen` (inset-полоски
 *      2–3 px, `outline`, `border-color`, жёсткое кольцо `box-shadow`); полосы
 *      карты здесь быть не должно — она адаптирована к холсту, а не к
 *      поверхности, и на светлых строках списка не дотягивает 3 : 1;
 *   3. **мягкая подсветка** — заливка/ореол `color-mix(… 18 %, transparent)`
 *      от полосы слоя. Это НЕ кольцо фокуса: 18 % заведомо ниже 3 : 1, но и
 *      требование контраста к ней не относится. Такие значения разрешены на
 *      экранах и не считаются нарушением (решение заказчика по приёмке 6e171b39:
 *      мягкие 18 %-фоны не трогаем).
 *
 * Обратное направление — тоже правило: ни одно объявление-кольцо в
 * `styles/canvas.css` не берёт экранное кольцо (иначе на карте появится второй
 * язык выделения вместо полосы слоя).
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { listSourceFiles } from './guard-helpers.js';
import { RENDERER_ROOT } from './renderer-css.js';
import { stripCssComments, topLevelBlocks } from './theme-css.js';

/** Токен полосы фокуса КАРТЫ (полоса слоя). */
const MAP_TOKEN = '--layer-focus-stripe';

/** Токен кольца поверхностей ЭКРАНОВ. */
const SCREEN_TOKEN = '--layer-focus-ring-screen';

/**
 * Минимум жёстких колец на экранном токене. Значение-снимок (на момент
 * введения — 17 объявлений): массовая потеря колец краснит, новые кольца
 * порог не нарушают.
 */
const MIN_SCREEN_RINGS = 12;

/**
 * Объявления роли «кольцо»: `outline*`, `border-color`, `border` и `box-shadow`
 * (последний — с inset или `0 0 0 Npx`, но разбор проще: если в значении есть
 * токен вне мягкой заливки, это кольцо).
 */
const RING_PROPERTIES = /^(?:outline|outline-color|border-color|border|box-shadow)$/i;

/** Объявление CSS: свойство и значение. */
interface Declaration {
  selector: string;
  property: string;
  value: string;
}

/** Объявления верхнего уровня файла (свойство: значение внутри правил). */
export function ringDeclarations(css: string): Declaration[] {
  const out: Declaration[] = [];
  for (const block of topLevelBlocks(css)) {
    for (const raw of stripCssComments(block.body).split(';')) {
      const index = raw.indexOf(':');
      if (index < 0) continue;
      const property = raw.slice(0, index).trim();
      if (!RING_PROPERTIES.test(property)) continue;
      out.push({ selector: block.prelude, property, value: raw.slice(index + 1).trim() });
    }
  }
  return out;
}

/**
 * Значение без мягких заливок `color-mix(...)`: 18 %-ореол — подсветка, а не
 * кольцо фокуса (решение приёмки 6e171b39). Скобки считаются вложенными:
 * внутри `color-mix` живут `var(--x, var(--y))`.
 */
export function dropColorMix(value: string): string {
  let text = value;
  for (;;) {
    const start = text.search(/color-mix\s*\(/i);
    if (start < 0) return text;
    let depth = 0;
    let end = -1;
    for (let i = text.indexOf('(', start); i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) return text;
    text = text.slice(0, start) + text.slice(end);
  }
}

/** Есть ли в объявлении жёсткая ссылка на токен (вне мягкой заливки). */
function usesToken(declaration: Declaration, token: string): boolean {
  return new RegExp(`var\\(\\s*${token}\\s*[,)]`).test(dropColorMix(declaration.value));
}

/**
 * Нарушения на ЭКРАНАХ: кольцо (жёсткая ссылка) на полосу карты. `files` —
 * CSS экранов: относительный путь (`styles/...`, `lib/ui/...`) → содержимое.
 */
export function screenFocusProblems(files: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, css] of files) {
    for (const declaration of ringDeclarations(css)) {
      if (!usesToken(declaration, MAP_TOKEN)) continue;
      problems.push(
        `${file} ${declaration.selector}: ${declaration.property} берёт полосу карты ` +
          `(${MAP_TOKEN}) — на экранах кольцо фокуса только ${SCREEN_TOKEN}`,
      );
    }
  }
  return problems;
}

/** Нарушения на КАРТЕ: объявление-кольцо на экранный токен. */
export function mapFocusProblems(canvasCss: string): string[] {
  const problems: string[] = [];
  for (const declaration of ringDeclarations(canvasCss)) {
    if (!usesToken(declaration, SCREEN_TOKEN)) continue;
    problems.push(
      `styles/canvas.css ${declaration.selector}: ${declaration.property} берёт экранное ` +
        `кольцо (${SCREEN_TOKEN}) — на карте фокус только полоса слоя (${MAP_TOKEN})`,
    );
  }
  return problems;
}

/** Сколько на экранах жёстких колец на экранном токене (не мягких заливок). */
export function screenRingCount(files: ReadonlyMap<string, string>): number {
  let count = 0;
  for (const css of files.values()) {
    for (const declaration of ringDeclarations(css)) {
      if (usesToken(declaration, SCREEN_TOKEN)) count += 1;
    }
  }
  return count;
}

/** CSS рендерера: относительный путь с `/` → содержимое. */
function rendererCss(): Map<string, string> {
  const files = new Map<string, string>();
  for (const abs of listSourceFiles(RENDERER_ROOT, { extensions: ['.css'] })) {
    const rel = path.relative(RENDERER_ROOT, abs).split(path.sep).join('/');
    files.set(rel, fs.readFileSync(abs, 'utf8'));
  }
  return files;
}

/** CSS экранов: всё, кроме карты и файлов тем (там только значения). */
function screenCssFiles(files: ReadonlyMap<string, string>): Map<string, string> {
  return new Map(
    [...files].filter(([rel]) => rel !== 'styles/canvas.css' && !rel.startsWith('lib/ui/themes/')),
  );
}

describe('guard: роли токена фокуса — карта и экраны не смешиваются (c19cbb81)', () => {
  const all = rendererCss();
  const screens = screenCssFiles(all);

  it('ни одно кольцо экрана не вернулось на полосу карты', () => {
    const problems = screenFocusProblems(screens);
    assert.deepEqual(problems, [], `кольца экранов:\n${problems.join('\n')}`);
  });

  it('на карте нет экранного кольца — только полоса слоя', () => {
    const problems = mapFocusProblems(all.get('styles/canvas.css') ?? '');
    assert.deepEqual(problems, [], `кольца карты:\n${problems.join('\n')}`);
  });

  it('жёсткие кольца экранов не потеряны массово', () => {
    const count = screenRingCount(screens);
    assert.ok(
      count >= MIN_SCREEN_RINGS,
      `жёстких колец на ${SCREEN_TOKEN} найдено ${count}, ожидалось не меньше ` +
        `${MIN_SCREEN_RINGS}: экранное выделение не должно схлопнуться в мягкие заливки`,
    );
  });

  it('сторож краснеет на возврате полосы карты в кольцо реального экрана', () => {
    // Негативная проба на РЕАЛЬНОМ файле: полоска хроники снова берёт полосу.
    const chronicle = all.get('styles/screens/chronicle.css') ?? '';
    const mutated = chronicle.replace(
      'inset 3px 0 0 var(--layer-focus-ring-screen',
      'inset 3px 0 0 var(--layer-focus-stripe',
    );
    assert.notEqual(mutated, chronicle, 'мутация кольца хроники не применилась');
    const problems = screenFocusProblems(
      new Map([
        ['styles/screens/chronicle.css', mutated],
        ...[...screens].filter(([rel]) => rel !== 'styles/screens/chronicle.css'),
      ]),
    );
    assert.ok(
      problems.some((p) => p.includes(MAP_TOKEN)),
      `возврат на полосу карты обязан краснить: ${problems.join(' | ')}`,
    );

    // Негативная проба на РЕАЛЬНОМ файле карты: полоса фокуса переведена на
    // экранное кольцо.
    const canvas = all.get('styles/canvas.css') ?? '';
    const canvasMutated = canvas.replace(
      'outline: 2px solid var(--frame-selected, var(--selection));',
      'outline: 2px solid var(--layer-focus-ring-screen, var(--focus-accent, var(--accent)));',
    );
    assert.notEqual(canvasMutated, canvas, 'мутация кольца карты не применилась');
    assert.ok(
      mapFocusProblems(canvasMutated).length > 0,
      'экранное кольцо на карте обязано краснить',
    );
  });

  it('мягкие 18 %-заливки и ореолы полосы не считаются кольцом', () => {
    const soft = `background: color-mix(in srgb, var(--layer-focus-stripe, var(--focus-accent, var(--accent))) 18%, transparent);`;
    const halo = `box-shadow: 0 0 0 2px color-mix(in srgb, var(--layer-focus-stripe, var(--focus-accent, var(--accent))) 18%, transparent);`;
    assert.deepEqual(
      screenFocusProblems(
        new Map([
          ['styles/screens/demo.css', `.demo-selected { ${soft} }\n.demo-current { ${halo} }`],
        ]),
      ),
      [],
      'мягкая подсветка 18 % — разрешённая форма (решение приёмки 6e171b39)',
    );
    // Жёсткое кольцо на том же токене — красное.
    assert.ok(
      screenFocusProblems(
        new Map([
          [
            'styles/screens/demo.css',
            '.demo { outline: 2px solid var(--layer-focus-stripe, var(--focus-accent, var(--accent))); }',
          ],
        ]),
      ).length > 0,
      'жёсткий outline на полосе карты обязан краснить',
    );
    // Кольцо на экранном токене — чистая форма.
    assert.deepEqual(
      screenFocusProblems(
        new Map([
          [
            'styles/screens/demo.css',
            '.demo { outline: 2px solid var(--layer-focus-ring-screen, var(--focus-accent, var(--accent))); }',
          ],
        ]),
      ),
      [],
    );
  });
});
