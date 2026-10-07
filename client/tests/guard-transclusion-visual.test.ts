/**
 * Сторож визуальных слоёв блока трансклюзии (0.12.1, ТП2, задача `a2b68d72`;
 * ADR `c425202a`, требования `29a3c17a`, `fc60d763`).
 *
 * Правила, которые обязан удерживать код:
 *   1. оттенок фона блока трансклюзии ВЫЧИСЛЯЕТСЯ от токенов темы
 *      (`color-mix(var(--text) …, var(--surface))`), а не задаётся списком
 *      захардкоженных цветов — ADR `c425202a` прямо запрещает пять цветов и
 *      отдельную палитру на тему;
 *   2. уровней ровно пять (глубина ADR 1..5) — селекторы
 *      `[data-transclusion-depth="1".."5"]`;
 *   3. анимация блока/ссылки идёт через токен `--md-transclusion-anim`, а сам
 *      токен обнуляется при `prefers-reduced-motion: reduce`.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readRendererCss } from './renderer-css.js';

const CSS = readRendererCss();

/** Тело CSS-правила по селектору (от `{` до первой `}`). */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  if (at === -1) return '';
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

describe('guard: визуальные слои блока трансклюзии (a2b68d72, ADR c425202a)', () => {
  it('фон блока вычисляется из токенов темы, без hex-литералов', () => {
    const body = ruleBody('.md-transclusion');
    assert.ok(body !== '', 'не найдено правило .md-transclusion');
    assert.match(body, /color-mix\(/, 'фон блока обязан вычисляться через color-mix от токенов');
    assert.match(body, /var\(--text\)/, 'оттенок смешивается с цветом текста темы');
    assert.match(body, /var\(--surface\)/, 'база оттенка — фон контейнера темы');
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(body),
      'в .md-transclusion есть hex-цвет — ADR c425202a запрещает захардкоженные цвета',
    );
  });

  it('заданы уровни глубины 1..5 (глубина ADR — пять)', () => {
    for (let level = 1; level <= 5; level += 1) {
      assert.match(
        CSS,
        new RegExp(`\\.md-transclusion\\[data-transclusion-depth='${level}'\\]`),
        `нет правила оттенка для уровня ${level}`,
      );
    }
    assert.ok(
      !/data-transclusion-depth='6'/.test(CSS),
      'шестого уровня быть не должно — глубина ограничена пятью',
    );
  });

  it('анимация идёт токеном, обнуляемым при prefers-reduced-motion', () => {
    assert.match(
      CSS,
      /animation:\s*md-transclusion-in\s+var\(--md-transclusion-anim/,
      'анимация блока/ссылки обязана ссылаться на токен --md-transclusion-anim',
    );
    const rootEnd = CSS.indexOf("[data-theme='dark'] {");
    const root = CSS.slice(0, rootEnd === -1 ? CSS.length : rootEnd);
    assert.match(root, /--md-transclusion-anim\s*:/, 'токен не объявлен в :root');
    const reduced = CSS.slice(CSS.indexOf('prefers-reduced-motion: reduce'));
    assert.match(
      reduced,
      /--md-transclusion-anim\s*:\s*0ms/,
      'токен не обнулён при prefers-reduced-motion — анимация не учла бы reduce-motion',
    );
  });

  it('вложенное поле правки блока — сплошная рамка по строкам (ошибка 9c2e077a)', () => {
    // Рамка вложенного поля строится ЛИНЕЙНЫМИ декорациями: боковые границы на
    // каждой строке, верх/низ — на первой/последней. Одна inline-рамка с
    // box-shadow обводила каждую строку отдельно («обведённые строки»).
    const base = ruleBody('.cm-editor .cm-transclusion-edit-range');
    assert.ok(base !== '', 'не найдено правило .cm-transclusion-edit-range');
    assert.match(base, /border-left:/, 'боковая граница поля слева');
    assert.match(base, /border-right:/, 'боковая граница поля справа');
    assert.doesNotMatch(base, /box-shadow/, 'per-line inline-рамка недопустима');
    const first = ruleBody('.cm-editor .cm-transclusion-edit-range--first');
    assert.match(first, /border-top:/, 'верхняя граница — на первой строке поля');
    const last = ruleBody('.cm-editor .cm-transclusion-edit-range--last');
    assert.match(last, /border-bottom:/, 'нижняя граница — на последней строке поля');
  });
});
