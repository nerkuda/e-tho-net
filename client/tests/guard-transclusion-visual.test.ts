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
 *      токен обнуляется при `prefers-reduced-motion: reduce`;
 *   4. индикатор-«замочек» (`cm-transclusion-lock`) — парное правило правки и
 *      просмотра в ОДНОМ правиле, а блок просмотра (`.md-transclusion`) —
 *      якорь (`position: relative`) для абсолютного индикатора (ошибка
 *      `f60f99e0`).
 *   5. выделенный целиком блок (`cm-transclusion-block--covered`) рисует рамку
 *      из токена темы ВНУТРИ поля (inset) и подавляет нативную подсветку
 *      текста внутри; правило подавления матчит блок БЕЗ `.cm-line` (блочный
 *      виджет лежит в `.cm-content` — ошибка `39553204`).
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

/** Прелюдии (селекторы) правил верхнего уровня собранного CSS. */
function topLevelPreludes(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const preludes: string[] = [];
  let depth = 0;
  let buffer = '';
  for (const ch of text) {
    if (ch === '{') {
      if (depth === 0) preludes.push(buffer);
      depth++;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) buffer = '';
    } else if (depth === 0) {
      buffer += ch;
    }
  }
  return preludes;
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

  it('«замочек» — парное правило правки и просмотра, блок просмотра якорный (f60f99e0)', () => {
    // Индикатор-«замочек» обязан быть ОДНИМ правилом на оба режима (паритет с
    // парными правилами `.cm-md-*` ↔ `.comment-view`, сторож
    // comment-style-parity): правка внутри `.cm-editor`, просмотр внутри
    // `.comment-view`. Разные правила разошлись бы видом.
    const shared = topLevelPreludes(CSS).find(
      (prelude) =>
        prelude.includes('.cm-editor .cm-transclusion-lock') &&
        prelude.includes('.comment-view .cm-transclusion-lock'),
    );
    assert.ok(
      shared !== undefined,
      'правило .cm-transclusion-lock обязано быть парным: .cm-editor и .comment-view в одном правиле',
    );
    // Индикатор позиционируется абсолютно внутри блока — у блока просмотра
    // обязан быть якорь (`position: relative`), иначе «замочек» уедет наружу.
    assert.match(
      ruleBody('.md-transclusion'),
      /position:\s*relative/,
      'блок просмотра .md-transclusion обязан быть якорем (position: relative) для «замочка»',
    );
  });

  it('содержимое блока не зависит от white-space редактора (4453f2e4)', () => {
    // Блок — прямой потомок `.cm-content` (базовая тема CodeMirror задаёт ему
    // `white-space: pre`/`break-spaces`). Без явного сброса свойство
    // НАСЛЕДОВАЛОСЬ в HTML блока, и переводы строк между блочными тегами
    // рисовались пустыми строками — отступы внутри блока раздувались, в отличие
    // от просмотра (ошибка 4453f2e4). Паритет требует `white-space: normal`.
    const body = ruleBody('.cm-editor .cm-transclusion-block');
    assert.ok(body !== '', 'не найдено правило .cm-editor .cm-transclusion-block');
    assert.match(
      body,
      /white-space:\s*normal/,
      'блок трансклюзии в правке обязан задавать white-space: normal — иначе содержимое наследует pre/break-spaces из .cm-content',
    );
  });

  it('выделенный целиком блок — рамка внутри поля и подавление нативной подсветки (39553204)', () => {
    // Пользователь видит блок трансклюзии единым целым: при полном покрытии
    // выделением вокруг блока рисуется РАМКА из токена темы, а нативная
    // подсветка текста/пробелов внутри подавлена.
    //
    // Диагноз (живая проверка 2026-10-07): блок — replace-виджет `block: true`,
    // в DOM он ПРЯМОЙ потомок `.cm-content`, а НЕ внутри `.cm-line`
    // (`addBlockWidget` в CodeMirror). Поэтому правило подавления обязано
    // матчить блок БЕЗ `.cm-line` в селекторе — иначе оно не применяется и
    // браузер рисует нативное выделение цветом `.comment-view ::selection`
    // (именно на этом ошибся коммит 477293fb). Рамка — inset box-shadow: внешний
    // outline с offset уходил за край поля и обрезался overflow.
    const frame = ruleBody('.cm-editor .cm-transclusion-block--covered');
    assert.ok(frame !== '', 'не найдено правило .cm-transclusion-block--covered');
    assert.match(
      frame,
      /box-shadow:\s*inset 0 0 0 2px var\(--selection/,
      'рамка обязана быть inset от токена темы --selection (видна со всех сторон, не обрезается overflow)',
    );
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(frame),
      'в рамке выделенного блока есть hex-цвет — ADR c425202a запрещает захардкоженные цвета',
    );
    assert.match(
      CSS,
      /\.cm-editor \.cm-transclusion-block--covered ::selection/,
      'нет правила подавления ::selection для покрытого блока',
    );
    assert.doesNotMatch(
      CSS,
      /\.cm-editor \.cm-line \.cm-transclusion-block--covered/,
      'селектор подавления привязан к `.cm-line`, но блочный виджет лежит в `.cm-content` — правило не матчит блок',
    );
    assert.match(
      CSS,
      /\.cm-editor \.cm-transclusion-block--covered ::selection[\s\S]{0,140}background-color:\s*transparent\s*!important/,
      'нативная подсветка текста/пробелов внутри выделенного блока обязана быть подавлена',
    );
  });

  it('строки списка разделов поповера не сжимаются — прокручивается контейнер (dc6f4121)', () => {
    // У flex-элемента с `overflow: hidden` (нужен ради ellipsis) автоматический
    // минимум размера равен нулю: без запрета сжатия колонка НЕ прокручивалась,
    // а сплющивала все строки в свой `max-height` (симптом ошибки dc6f4121).
    const row = ruleBody('.transclusion-popover-row');
    assert.ok(row !== '', 'не найдено правило .transclusion-popover-row');
    assert.match(
      row,
      /(?:flex:\s*0\s+0\s+auto|flex-shrink:\s*0)/,
      'строке обязателен запрет сжатия (flex: 0 0 auto) — иначе список не прокручивается',
    );
    assert.match(
      ruleBody('.transclusion-popover-sections'),
      /overflow:\s*auto/,
      'контейнер списка разделов обязан прокручиваться (overflow: auto)',
    );
  });
});
