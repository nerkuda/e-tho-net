/**
 * Сторож единого источника типографики markdown-контента (ошибка 45989471
 * «Комментарии: стили просмотра и живого редактирования различаются»; отступы
 * блоков кода и цитат — ошибка 333aa879; отступ горизонтальной линейки —
 * ошибка 47bce601; единая шкала вертикальных отступов абзацев/списков/линейки/
 * виджетов/трансклюзий — ошибка ad6e62ef).
 *
 * Просмотр рендерит HTML единым `@etn/markdown` внутрь `.comment-view`; живое
 * редактирование показывает текст исходником и размечает его строками/марками
 * CodeMirror (`.cm-md-*`), а целые блоки (fenced-код, таблица, картинка) —
 * DOM-виджетами live preview (`.md-widget.comment-view`). Раньше
 * размеры/отступы заголовков, цитаты и inline-кода были ПРОДУБЛИРОВАНЫ в теме
 * CodeMirror (`editor/md-editor.ts`) и расходились со стилями просмотра. Теперь
 * значение объявлено один раз в `styles/tokens.css` (`--md-*`) парным
 * селектором, и оба режима берут его оттуда.
 *
 * Отдельно сторожатся ВЕРТИКАЛЬНЫЕ отступы блоков, у которых режимы устроены
 * по-разному: fenced-код в правке обёрнут виджетом (обёртка не должна
 * добавлять вертикальных полей — иначе паддинг блока удвоится), а цитата в
 * правке — это строки с паддингом первой/последней (внешний margin просмотра
 * дал бы расхождение). Значение зазора цитаты — из одного токена
 * `--md-quote-gap`; у горизонтальной линейки виджет-обёртка даёт тот же зазор,
 * что `margin: 6px 0` просмотра, но padding-ом (высотная карта), а линию рисует
 * внутренний `hr`.
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
  {
    view: '.comment-view hr',
    editor: '.cm-editor .md-widget.md-hr .md-hr-line',
    what: 'горизонтальная линейка',
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

/** Общее правило вертикального паддинга виджетов live preview (`.md-widget`). */
function genericWidgetPadRule(css: string): CssRule | undefined {
  return parseRules(css).find(
    (r) =>
      r.selectors.some((s) => /\.cm-editor \.md-widget\b/.test(s)) &&
      /padding:\s*var\(--md-widget-gap\) 0/.test(r.body),
  );
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
    const generic = genericWidgetPadRule(css);
    assert.ok(generic !== undefined, 'есть общее правило паддинга виджетов живого просмотра');
    assert.match(
      generic.prelude,
      /:not\(\.comment-view\)/,
      `паддинг обёртки .md-widget не должен применяться к блочным ` +
        `.comment-view-виджетам (fenced-код, таблица, картинка): ${generic.prelude.trim()}`,
    );
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

  it('горизонтальная линейка: вертикальный отступ — токен --md-hr-gap в обоих режимах', () => {
    const css = readRendererCss();

    // Просмотр: зазор вокруг линии — внешние поля `margin: var(--md-hr-gap) 0`.
    const viewBody = bodiesFor(css, '.comment-view hr').find((b) => /margin/.test(b));
    assert.ok(viewBody !== undefined, 'просмотр: `.comment-view hr` задаёт внешние поля');
    const viewVertical = /margin:\s*([^;]+)/.exec(viewBody)![1]!.trim().split(/\s+/)[0];
    assert.equal(
      viewVertical,
      'var(--md-hr-gap)',
      'просмотр: вертикальный зазор линейки — из токена --md-hr-gap',
    );

    // Правка: зазор — padding обёртки-виджета, margin нет (высотная карта
    // CodeMirror не учитывает margin у виджета). Значение — тот же токен.
    const widgetBody = bodiesFor(css, '.cm-editor .md-widget.md-hr')[0];
    assert.ok(widgetBody !== undefined, 'есть правило `.cm-editor .md-widget.md-hr`');
    const margins = [...widgetBody.matchAll(/margin[^:]*:\s*([^;]+)/g)].map((m) => m[1]!.trim());
    for (const v of margins) {
      assert.match(
        v,
        /^0(?:px)?$/,
        'правка: у виджета линейки нет вертикального margin — только padding',
      );
    }
    const editVertical = /padding-block:\s*([^;]+)/.exec(widgetBody)?.[1]?.trim();
    assert.equal(
      editVertical,
      viewVertical,
      'вертикальный padding виджета линейки — тот же токен, что зазор просмотра',
    );

    // Общий паддинг виджетов к линейке не применяется — иначе к зазору линейки
    // добавился бы ещё и паддинг виджета, и отступ разошёлся бы с просмотром.
    const generic = genericWidgetPadRule(css);
    assert.ok(generic !== undefined, 'есть общее правило паддинга виджетов');
    assert.match(
      generic.prelude,
      /:not\(\.md-hr\)/,
      `общий паддинг виджетов не должен применяться к линейке: ${generic.prelude.trim()}`,
    );
  });
});

describe('единая шкала вертикальных отступов блоков (ad6e62ef)', () => {
  it('базовый межблочный зазор — токен из строкового ритма правки', () => {
    const tokens = readFileSync(
      resolve(CLIENT_ROOT, 'src', 'renderer', 'styles', 'tokens.css'),
      'utf8',
    );
    assert.match(
      tokens,
      /--md-block-gap:\s*calc\(var\(--md-line-height\)\s*\*\s*1em\)/,
      '--md-block-gap обязан выводиться из --md-line-height: в правке разделитель ' +
        'блоков — одна пустая строка этого ритма, зазор просмотра должен ей равняться',
    );
    for (const [name, re] of [
      ['--md-hr-gap', /--md-hr-gap:\s*6px/],
      ['--md-widget-gap', /--md-widget-gap:\s*2px/],
      ['--md-transclusion-pad', /--md-transclusion-pad:\s*4px 6px 4px 8px/],
    ] as const) {
      assert.match(tokens, re, `токен ${name} объявлен в tokens.css`);
    }
  });

  it('абзацы и списки: просмотр берёт зазор из --md-block-gap', () => {
    const css = readRendererCss();
    // Проза Web Awesome задавала зазор сама (24px) — теперь источник один:
    // переменная WA внутри .comment-view переопределена нашим токеном.
    assert.ok(
      bodiesFor(css, '.comment-view').some((b) =>
        /--wa-content-spacing:\s*var\(--md-block-gap\)/.test(b),
      ),
      'в .comment-view --wa-content-spacing переопределён на --md-block-gap',
    );
    assert.ok(
      parseRules(css).some(
        (r) =>
          r.prelude.includes(':is(p, ul, ol):has(+ *)') &&
          /margin-block-end:\s*var\(--md-block-gap\)/.test(r.body),
      ),
      'абзацы/списки: внешнее поле просмотра — из --md-block-gap',
    );
    assert.ok(
      parseRules(css).some(
        (r) =>
          r.selectors.includes('.comment-view p') &&
          r.selectors.includes('.comment-view ul') &&
          r.selectors.includes('.comment-view ol') &&
          r.selectors.includes('.comment-view li') &&
          /margin-block:\s*0/.test(r.body),
      ),
      'внешние поля абзацев/списков/пунктов в просмотре обнулены (зазор задаёт :has(+ *))',
    );
  });

  it('горизонтальная линейка и виджеты: значения — из токенов', () => {
    const css = readRendererCss();
    const tokens = readFileSync(
      resolve(CLIENT_ROOT, 'src', 'renderer', 'styles', 'tokens.css'),
      'utf8',
    );
    assert.match(tokens, /--md-hr-gap:\s*6px/);
    assert.ok(
      bodiesFor(css, '.comment-view hr').some((b) => /margin:\s*var\(--md-hr-gap\) 0/.test(b)),
      'просмотр: зазор линейки — var(--md-hr-gap)',
    );
    assert.ok(
      bodiesFor(css, '.cm-editor .md-widget.md-hr').some((b) =>
        /padding-block:\s*var\(--md-hr-gap\)/.test(b),
      ),
      'правка: зазор линейки — var(--md-hr-gap)',
    );
    const generic = genericWidgetPadRule(css);
    assert.ok(
      generic !== undefined,
      'общий паддинг виджетов задан токеном --md-widget-gap (а не литералом 2px)',
    );
  });

  it('паддинг блока трансклюзии — один токен на все режимы и уровни (ad6e62ef)', () => {
    const css = readRendererCss();
    // Просмотр (.md-transclusion) и правка (.cm-transclusion-block) обязаны
    // брать паддинг из ОДНОГО токена: иначе уровни вложенности накапливали бы
    // расхождение между режимами.
    for (const selector of ['.md-transclusion', '.cm-editor .cm-transclusion-block']) {
      assert.ok(
        bodiesFor(css, selector).some((b) => /padding:\s*var\(--md-transclusion-pad\)/.test(b)),
        `${selector}: паддинг — из токена --md-transclusion-pad`,
      );
    }
  });
});

describe('отступы картинки: просмотр совпадает с редактором (4e93119e)', () => {
  it('вертикальный зазор картинки — токен --md-widget-gap в ОБОИХ режимах', () => {
    const css = readRendererCss();
    // Единое правило `.comment-view img` обслуживает и просмотр (картинка в
    // абзаце единого рендерера), и правку (тот же `<img>` внутри блок-виджета
    // `.md-widget.comment-view`): зазор задаёт сам блок, как у блочных виджетов.
    assert.ok(
      bodiesFor(css, '.comment-view img').some((b) =>
        /margin-block:\s*var\(--md-widget-gap\)/.test(b),
      ),
      'картинка берёт вертикальный зазор из --md-widget-gap (а не абзацный --md-block-gap)',
    );
  });

  it('абзац-обёртка картинки в просмотре не добавляет второго зазора', () => {
    const css = readRendererCss();
    assert.ok(
      parseRules(css).some(
        (r) =>
          r.selectors.some((s) => /\.comment-view p:has\(> img:only-child\)/.test(s)) &&
          /margin-block:\s*0/.test(r.body),
      ),
      'абзац с одинокой картинкой обнуляет margin-block (иначе зазор дублируется)',
    );
    assert.ok(
      parseRules(css).some(
        (r) =>
          r.selectors.some((s) => /\.comment-view p:has\(\+ p > img:only-child\)/.test(s)) &&
          /margin-block-end:\s*0/.test(r.body),
      ),
      'абзац перед картинкой не добавляет зазор перед ней',
    );
  });
});
