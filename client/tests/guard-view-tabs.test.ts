/**
 * Сторож закладок-переключателей экранов (ошибка 3e57ee11, 0.9.1).
 *
 * Закладки в строке меню мыслесети («Карта мыслей / Структуры мыслей / Хроника /
 * События», задача a0cdd731) имеют форму «закладки в блокноте»:
 *  1. рамка скруглена только в ВЕРХНИХ углах, нижняя сторона открыта;
 *  2. между группой закладок и меню слоя («Основа») — разделительная граница;
 *  3. активная закладка: рамка цвета выделения слева-сверху-справа, НИЖНЕЙ
 *     границы нет (сливается с экраном), фон не меняется, символ крупнее на 5%
 *     (токен `--view-tab-active-scale` = 1.05);
 *  4. иконка «Хроника» — календарик месяца (`calendar-month`), не часы.
 *
 * Вид закладок — только CSS (`styles/layout.css`), размеры — токенами
 * (`styles/tokens.css`), поэтому проверяются текстом модулей в порядке
 * манифеста (как `dialog-size-tabs`/`guard-list-dialogs`). Сторож входит в
 * обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readRendererCss } from './renderer-css.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER_ROOT = path.join(CLIENT_ROOT, 'src', 'renderer');

/** Исходник модуля рендерера. */
function source(rel: string): string {
  return readFileSync(path.join(RENDERER_ROOT, ...rel.split('/')), 'utf8');
}

/** Тело первого правила с селектором `selector` (+ завершающая `{`). */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `в собранном CSS нет правила ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

const CSS = readRendererCss();

describe('guard: закладки-переключатели экранов (3e57ee11, 0.9.1)', () => {
  it('токен масштаба активной закладки — 1.05 (+5% к обычной)', () => {
    const tokens = source('styles/tokens.css');
    assert.match(
      tokens,
      /--view-tab-active-scale:\s*1\.05\s*;/,
      'масштаб символа активной закладки обязан быть 1.05 (ошибка 3e57ee11)',
    );
  });

  it('рамка закладки скруглена только в верхних углах, нижняя сторона открыта', () => {
    const body = ruleBody(CSS, '.toolbar .view-tab');
    assert.match(
      body,
      /border-radius:\s*var\(--radius-sm\)\s+var\(--radius-sm\)\s+0\s+0/,
      'у закладки должны скругляться только верхние углы, нижние — прямые',
    );
    assert.match(body, /border-bottom:\s*0/, 'нижняя сторона закладки обязана быть открыта');
  });

  it('группа закладок отделена от меню слоя разделительной границей', () => {
    const body = ruleBody(CSS, '.view-switch');
    assert.match(
      body,
      /border-right:\s*1px solid var\(--border\)/,
      'нет разделительной границы между закладками экранов и меню слоя («Основа»)',
    );
  });

  it('активная закладка: рамка акцентом, без нижней границы и без фона', () => {
    const body = ruleBody(CSS, '.toolbar .view-tab.ui-btn--active');
    assert.match(
      body,
      /border-color:\s*var\(--accent\)/,
      'рамка активной закладки обязана быть цвета выделения (--accent)',
    );
    assert.ok(
      !/border-bottom\s*:/.test(body),
      'активная закладка не рисует нижнюю границу — она сливается с экраном',
    );
    assert.ok(
      !/background\s*:/.test(body),
      'фон активной закладки не меняется — подсветка только рамкой и размером символа',
    );
    assert.match(
      body,
      /font-size:\s*var\(--view-tab-icon-active\)/,
      'символ активной закладки крупнее за счёт токена масштаба',
    );
  });

  it('закладки делят одну вертикальную границу, а не удваивают её', () => {
    const body = ruleBody(CSS, '.view-tab + .view-tab');
    assert.match(
      body,
      /margin-left:\s*-\d+px/,
      'соседние закладки обязаны делить одну вертикальную границу (перекрытие рамок)',
    );
  });

  it('иконка «Хроника» — календарик месяца, а не часы', () => {
    assert.ok(
      source('lib/icons.ts').includes("'calendar-month':"),
      'в наборе иконок нет calendar-month',
    );
    assert.ok(
      !source('lib/icons.ts').includes('\n  history:'),
      'устаревшая иконка history не удалена из набора',
    );
    const workspace = source('screens/workspace.ts');
    const start = workspace.indexOf('const chronicleViewButton = iconButton({');
    assert.ok(start >= 0, 'не найдена кнопка экрана «Хроника»');
    const block = workspace.slice(start, workspace.indexOf('});', start));
    assert.ok(
      block.includes("svgIcon('calendar-month')"),
      'кнопка «Хроника» обязана нести иконку календарика месяца',
    );
  });

  it('закладка «Публикации»: иконка-книга (не дубликат слоёв), между «Дневником» и «Событиями» (af076f53)', () => {
    const workspace = source('screens/workspace.ts');
    const start = workspace.indexOf('const publicationsViewButton = iconButton({');
    assert.ok(start >= 0, 'не найдена кнопка экрана «Публикации»');
    const block = workspace.slice(start, workspace.indexOf('});', start));
    assert.ok(
      block.includes("svgIcon('value-publication')"),
      'иконка «Публикации» — раскрытая книга (`value-publication`)',
    );
    assert.ok(
      !block.includes("svgIcon('layers')"),
      'иконка «Публикации» не должна дублировать иконку меню слоёв (`layers`)',
    );
    const appendAt = workspace.indexOf('viewSwitch.append(');
    assert.ok(appendAt >= 0, 'не найден порядок закладок экранов');
    const orderLine = workspace.slice(appendAt, workspace.indexOf(');', appendAt));
    const order = [...orderLine.matchAll(/(\w+ViewButton)/g)].map((m) => m[1]);
    assert.deepEqual(
      order,
      [
        'mapViewButton',
        'structuresViewButton',
        'chronicleViewButton',
        'publicationsViewButton',
        'activityViewButton',
      ],
      '«Публикации» обязаны стоять между «Дневником» и «Событиями»',
    );
  });
});
