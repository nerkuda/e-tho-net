/**
 * Сторож паритета типографики комментария (0.11.1, волна 9 приёмки, задача
 * b5cfad70).
 *
 * Замечание пользователя: текст комментария в документе публикации выглядел
 * крупнее и просторнее, чем при правке в панели, — заметно для заголовков и
 * цитат. Причина: проза-стили Web Awesome (`@layer wa-native`,
 * `register.ts`) глобально задают `blockquote` (серифный `--wa-font-family-
 * longform`, кегль `--wa-font-size-larger` ≈16px, padding `--wa-space-xl` ≈26px),
 * `strong` (`--wa-font-weight-bold` = 600) и заголовки (`--wa-font-family-
 * heading`, `text-wrap: balance`). Луковый слой проигрывает только ЯВНО
 * объявленным свойствам, а общий `.comment-view` их не задавал — документ
 * (и просмотр комментария) расходились с редактором.
 *
 * Правило: внутриблочная типографика markdown-комментария имеет ЕДИНЫЙ
 * источник — токены `--md-*` (`styles/tokens.css`), которые используют и
 * парные правила `styles/editor.css` (`.comment-view <элемент>` +
 * `.cm-editor .cm-line.cm-md-*`), и тема `editor/md-editor.ts`. Документ
 * публикации НЕ переопределяет типографику прозы `.comment-view` — ему
 * оставлены только спец-стили титула и межблочные отступы.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(CLIENT_ROOT, 'src', 'renderer');

const read = (rel: string): string => fs.readFileSync(path.join(RENDERER, rel), 'utf8');

const TOKENS = read('styles/tokens.css');
const EDITOR_CSS = read('styles/editor.css');
const PUBCSS = read('styles/screens/publications.css');
const MD_EDITOR = read('editor/md-editor.ts');

/** Тело CSS-правила по заголовку селектора (первое совпадение). */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `в CSS нет селектора «${selector}»`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('паритет типографики: единый источник --md-*', () => {
  it('токены внутриблочной типографики объявлены', () => {
    for (const name of [
      '--md-line-height',
      '--md-strong-weight',
      '--md-quote-indent',
      '--md-quote-border-width',
      '--md-quote-gap',
    ]) {
      assert.match(TOKENS, new RegExp(`${name}\\s*:`), `токен ${name} объявлен`);
    }
  });

  it('.comment-view берёт line-height и метрики цитаты из токенов', () => {
    const base = ruleBody(EDITOR_CSS, '\n.comment-view {');
    assert.match(base, /line-height:\s*var\(--md-line-height\)/);
    const quotePair = ruleBody(
      EDITOR_CSS,
      '.comment-view blockquote,\n.cm-editor .cm-line.cm-md-quote-line {',
    );
    assert.match(quotePair, /padding-left:\s*var\(--md-quote-indent\)/);
    assert.match(quotePair, /border-left:\s*var\(--md-quote-border-width\)/);
    assert.match(EDITOR_CSS, /\.cm-editor \.cm-line\.cm-md-quote-first\s*\{[^}]*padding-top:\s*var\(--md-quote-gap\)/s);
    assert.match(EDITOR_CSS, /\.cm-editor \.cm-line\.cm-md-quote-last\s*\{[^}]*padding-bottom:\s*var\(--md-quote-gap\)/s);
  });

  it('.comment-view blockquote явно перебивает прозу Web Awesome', () => {
    // Правило-нейтрализатор — то, что объявляет `font-size: inherit`.
    const m = /\n\.comment-view blockquote \{([^}]*)\}/gs;
    const bodies = [...EDITOR_CSS.matchAll(m)].map((x) => x[1]!);
    const neutralizer = bodies.find((b) => /font-size:\s*inherit/.test(b));
    assert.ok(neutralizer !== undefined, 'есть правило-нейтрализатор цитаты');
    assert.match(neutralizer, /font-family:\s*inherit/, 'WA: --wa-font-family-longform');
    assert.match(neutralizer, /font-size:\s*inherit/, 'WA: --wa-font-size-larger');
    assert.match(neutralizer, /line-height:\s*var\(--md-line-height\)/);
    assert.match(neutralizer, /padding-block:\s*var\(--md-quote-gap\)/, 'WA: --wa-space-xl');
    assert.match(neutralizer, /padding-inline-end:\s*0/);
  });

  it('.comment-view strong и заголовки не наследуют прозу Web Awesome', () => {
    assert.match(
      EDITOR_CSS,
      /\.comment-view strong,\s*\.comment-view b\s*\{[^}]*font-weight:\s*var\(--md-strong-weight\)/s,
      'жирный — вес из токена, не --wa-font-weight-bold (600)',
    );
    // Общее правило заголовков (font-weight: 700 + font-family: inherit).
    const start = EDITOR_CSS.indexOf('.comment-view h1,\n.cm-editor .cm-line.cm-md-h1,');
    assert.notEqual(start, -1, 'общее правило заголовков на месте');
    const body = EDITOR_CSS.slice(start, EDITOR_CSS.indexOf('}', start));
    assert.match(body, /font-family:\s*inherit/, 'WA: --wa-font-family-heading');
    assert.match(body, /text-wrap:\s*initial/, 'WA: text-wrap: balance');
    assert.match(body, /line-height:\s*var\(--md-line-height\)/);
  });

  it('тема редактора CodeMirror использует те же токены', () => {
    assert.match(MD_EDITOR, /fontWeight:\s*'var\(--md-strong-weight\)'/, 'вес strong из токена');
    assert.match(MD_EDITOR, /lineHeight:\s*'var\(--md-line-height\)'/, 'line-height из токена');
  });
});

describe('документ публикации не переопределяет типографику .comment-view', () => {
  /** Селекторы publications.css, которые трогают markdown-прозу под .pub-doc. */
  const PROSE_TAGS = /(?:^|[\s,>~+])(?:h[1-6]|p|ul|ol|li|blockquote|strong|b|em|i|code|pre|table)(?=$|[\s,>~+.:#])/;

  function proseOverrides(css: string): string[] {
    const out: string[] = [];
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const body = m[2]!;
      if (!selector.includes('.pub-doc')) continue;
      // Заголовок/подзаголовок/автор титула — спец-стили, разрешены.
      if (/\.pub-doc-(?:title|subtitle|meta)\b/.test(selector)) continue;
      // Селекторы по markdown-тегам под .pub-doc задавать типографику не должны.
      if (PROSE_TAGS.test(' ' + selector) && /font-size|font-family|font-weight|line-height|margin|padding/.test(body)) {
        out.push(`${selector} { ${body.trim().slice(0, 80)} }`);
      }
    }
    return out;
  }

  it('нет правил прозы .pub-doc <тег> с типографикой', () => {
    const offenders = proseOverrides(PUBCSS);
    assert.deepEqual(offenders, [], `документ переопределяет прозу comment-view: ${offenders.join(' | ')}`);
  });

  it('.pub-doc.comment-view переопределяет только раскладку (max-height)', () => {
    const body = ruleBody(PUBCSS, '.pub-doc.comment-view {');
    assert.doesNotMatch(body, /font-size|font-family|font-weight|line-height|margin|padding/);
    assert.match(body, /max-height:\s*none/);
  });
});
