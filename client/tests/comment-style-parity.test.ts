/**
 * Сторож единого источника типографики markdown-контента (ошибка 45989471
 * «Комментарии: стили просмотра и живого редактирования различаются»).
 *
 * Просмотр рендерит HTML единым `@etn/markdown` внутрь `.comment-view`; живое
 * редактирование показывает текст исходником и размечает его строками/марками
 * CodeMirror (`.cm-md-*`). Раньше размеры/отступы заголовков, цитаты и
 * inline-кода были ПРОДУБЛИРОВАНЫ в теме CodeMirror (`editor/md-editor.ts`) и
 * расходились со стилями просмотра. Теперь значение объявлено один раз в
 * `styles/editor.css` парным селектором, и оба режима берут его оттуда.
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
