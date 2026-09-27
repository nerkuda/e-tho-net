/**
 * Дефект приёмки задачи 8012a9b0: поле заголовка в шапке записи вкладки
 * «Дневник» редактора не занимало всю оставшуюся ширину панели (ошибка
 * 30c9deb2). Сама шапка (`.chrono-meta-row`) — элемент панели действий оболочки
 * комментария (`.ui-comment__tools`, flex-wrap) и по умолчанию сжималась по
 * содержимому (`flex: 0 1 auto`), поэтому `width: 100%` поля не растягивал её.
 *
 * Проверка структурная по исходникам (DOM-монтирование вкладки требует сети и
 * store) — в стиле `chronicle-calendar.test.ts`. Спецификация: элемент «Вкладка
 * „Дневник“ редактора» (7310d077) — «поле ввода заголовка на всю оставшуюся
 * ширину панели».
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

describe('шапка записи: заголовок во всю ширину (ошибка 30c9deb2)', () => {
  it('шапка записи занимает всю строку панели действий', () => {
    const css = read('styles/editor.css');
    const rule = css.slice(css.indexOf('.chrono-meta-row {'));
    const block = rule.slice(0, rule.indexOf('}'));
    assert.match(
      block,
      /flex:\s*1\s+1\s+100%/,
      'шапка записи растягивается на всю строку панели действий',
    );
  });

  it('поле заголовка внутри шапки тянется на оставшуюся ширину', () => {
    const css = read('styles/editor.css');
    const rule = css.slice(css.indexOf('.chrono-meta-row .chrono-meta-input'));
    const block = rule.slice(0, rule.indexOf('}'));
    assert.match(block, /flex:\s*1\s+1\s+auto/, 'поле заголовка растяжимо');
    assert.match(block, /min-width:\s*0/, 'поле заголовка может сжиматься');
  });

  it('шапка — это панель действий оболочки комментария (период + заголовок)', () => {
    const src = read('editor/chrono-tab.ts');
    const row = src.slice(src.indexOf("const metaRow = div('chrono-meta-row');"));
    const block = row.slice(0, row.indexOf(';', row.indexOf('metaRow.append(')));
    assert.ok(block.includes('dateBtn'), 'период записи — первый элемент шапки');
    assert.ok(block.includes('titleInput'), 'поле заголовка — второй элемент шапки');
    assert.match(
      src,
      /commentShell\(\{\s*variant:\s*'fill',\s*tools:\s*\[metaRow\]/,
      'шапка уходит в панель действий оболочки комментария',
    );
  });
});
