/**
 * Сторож единого источника типографики markdown-контента (ошибка 45989471
 * «Комментарии: стили просмотра и живого редактирования различаются»; отступы
 * блоков кода и цитат — ошибка 333aa879).
 *
 * Просмотр рендерит HTML единым `@etn/markdown` внутрь `.comment-view`; живое
 * редактирование показывает текст исходником и размечает его строками/марками
 * CodeMirror (`.cm-md-*`), а целые блоки (fenced-код, таблица, картинка) —
 * DOM-виджетами live preview (`.md-widget.comment-view`). Раньше
 * размеры/отступы заголовков, цитаты и inline-кода были ПРОДУБЛИРОВАНЫ в теме
 * CodeMirror (`editor/md-editor.ts`) и расходились со стилями просмотра. Теперь
 * значение объявлено один раз в `styles/editor.css` парным селектором, и оба
 * режима берут его оттуда.
 *
 * Отдельно сторожатся ВЕРТИКАЛЬНЫЕ отступы блоков, у которых режимы устроены
 * по-разному: fenced-код в правке обёрнут виджетом (обёртка не должна
 * добавлять вертикальных полей — иначе паддинг блока удвоится), а цитата в
 * правке — это строки с паддингом первой/последней (внешний margin просмотра
 * дал бы расхождение). Значение зазора — из одного токена `--md-quote-gap`.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { readRendererCss } from './renderer-css.js';

const CLIENT_ROOT = resolve(import.meta.dirname, '..');

/** Пары «селектор просмотра» ↔ «селектор живого редактирования». */
const PAIRS: Array<{ view: string; editor: string; what: string }> = [
  { view: '.comment-view h1', editor: '.cm-editor .cm-line.cm-md-h1', what: 'заголовок h1' },
  { view: '.comment-view h6', editor: '.cm-editor .cm-line.cm-md-h6', what: 'заголовок h6' },
  {
    view: '.comment-view blockquote',
    editor: '.cm-editor .cm-line.cm-md-quote-line',
    what: 'цитата',
  },
  { view: '.comment-view code', editor: '.cm-editor .cm-line .cm-md-inline-code', what: 'inline-код' },
];

/** Список селекторов каждого правила верхнего уровня собранного CSS. */
function topLevelRules(css: string): string[] {
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

interface CssRule {
  prelude: string;
  body: string;
  selectors: string[];
}

/** Правила верхнего уровня с телом и разобранными селекторами. */
function parseRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) break;
    const open = text.indexOf('{', i);
    if (open === -1) break;
    const prelude = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    rules.push({
      prelude,
      body: text.slice(open + 1, j - 1),
      selectors: prelude
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    });
    i = j;
  }
  return rules;
}

/** Тела всех правил верхнего уровня, где есть селектор `selector` целиком. */
function bodiesFor(css: string, selector: string): string[] {
  return parseRules(css)
    .filter((r) => r.selectors.includes(selector))
    .map((r) => r.body);
}

describe('единый источник стилей markdown: просмотр и редактор (45989471)', () => {
  it('у каждой пары «элемент просмотра ↔ класс редактора» правило общее', () => {
    const rules = topLevelRules(readRendererCss());
    for (const pair of PAIRS) {
      const shared = rules.find(
        (prelude) => prelude.includes(pair.view) && prelude.includes(pair.editor),
      );
      assert.ok(
        shared !== undefined,
        `${pair.what}: селекторы «${pair.view}» и «${pair.editor}» должны стоять в ОДНОМ правиле ` +
          '(единый источник), а не дублироваться по разным файлам',
      );
    }
  });

  it('тема CodeMirror не дублирует типографику .cm-md-* (она живёт в editor.css)', () => {
    // Комментарии не считаем: имена классов в пояснениях допустимы — важно,
    // что в САМОЙ теме нет объявлений стилей.
    const theme = readFileSync(
      resolve(CLIENT_ROOT, 'src', 'renderer', 'editor', 'md-editor.ts'),
      'utf8',
    )
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const cls of ['cm-md-h', 'cm-md-quote', 'cm-md-inline-code']) {
      assert.equal(
        theme.includes(`.${cls}`),
        false,
        `editor/md-editor.ts снова объявляет стиль .${cls} — это копия стилей просмотра; ` +
          'правь общее правило в styles/editor.css',
      );
    }
  });
});

describe('вертикальные отступы блоков кода и цитат совпадают (333aa879)', () => {
  it('fenced-код: обёртка-виджет не добавляет вертикальных полей блоку', () => {
    const css = readRendererCss();
    // Блок кода берёт вертикальный отступ из ОДНОГО правила `.comment-view pre`
    // в обоих режимах: в правке pre лежит внутри виджета, несущего класс
    // `comment-view`, — то же правило просмотра и применяется.
    const prePad = bodiesFor(css, '.comment-view pre')
      .map((b) => /padding:\s*([^;]+)/.exec(b)?.[1]?.trim())
      .find((v) => v !== undefined);
    assert.equal(
      prePad,
      '8px',
      'общий отступ блока кода задаёт `.comment-view pre { padding: 8px }` — он должен существовать',
    );

    // Обёртка блочного HTML-виджета (`.md-widget.comment-view`) вертикальных
    // полей добавлять не должна: иначе к паддингу pre прибавился бы паддинг
    // обёртки, и отступ блока кода в правке разошёлся бы с просмотром.
    const wrapperPadRules = parseRules(css).filter(
      (r) =>
        r.selectors.some((s) => /\.cm-editor \.md-widget\b/.test(s)) &&
        /padding/.test(r.body),
    );
    assert.ok(wrapperPadRules.length > 0, 'есть правило паддинга виджетов живого просмотра');
    for (const r of wrapperPadRules) {
      assert.ok(
        /:not\(\.comment-view\)/.test(r.prelude),
        `паддинг обёртки .md-widget не должен применяться к блочным ` +
          `.comment-view-виджетам (fenced-код, таблица, картинка): ${r.prelude.trim()}`,
      );
    }
  });

  it('цитата: вертикальный зазор задан padding-ом в обоих режимах, без внешнего margin', () => {
    const css = readRendererCss();

    const viewBodies = bodiesFor(css, '.comment-view blockquote');
    assert.ok(
      viewBodies.some((b) => /padding-block:\s*var\(--md-quote-gap\)/.test(b)),
      'просмотр: вертикальный зазор цитаты — padding-block из --md-quote-gap',
    );
    for (const b of viewBodies) {
      const m = /margin-block\s*:\s*([^;]+)/.exec(b);
      assert.ok(
        m === null || /^0(?:px)?$/.test(m[1]!.trim()),
        'просмотр: внешний margin-block цитаты должен быть обнулён — иначе зазор ' +
          'расходится с padding-только правкой',
      );
    }

    assert.ok(
      bodiesFor(css, '.cm-editor .cm-line.cm-md-quote-first').some((b) =>
        /padding-top:\s*var\(--md-quote-gap\)/.test(b),
      ),
      'правка: верхний зазор цитаты — padding-top первой строки из того же токена',
    );
    assert.ok(
      bodiesFor(css, '.cm-editor .cm-line.cm-md-quote-last').some((b) =>
        /padding-bottom:\s*var\(--md-quote-gap\)/.test(b),
      ),
      'правка: нижний зазор цитаты — padding-bottom последней строки из того же токена',
    );
  });
});
