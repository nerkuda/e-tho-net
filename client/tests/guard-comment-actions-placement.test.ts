/**
 * Сторож расположения панели кнопок режима поля комментария (0.12.1, ошибка
 * `f65add20`).
 *
 * Правило: кнопки «Отмена»/«Сохранить» живут в ОТДЕЛЬНОЙ панели
 * (`.md-field-actions`) — сиблинге области правки под полем, ВНЕ прокручиваемого
 * документа редактора. Документ обёрнут в `.md-field-scroll`; прокручивается
 * только он.
 *
 * Почему правило нужно. В ограниченном по высоте поле (оболочка комментария
 * `--fill`, вкладка «Комментарий») `.md-field-area` как flex-элемент ужималась
 * до пятистрочного минимума, редактор переполнял её, а панель кнопок вставала
 * посреди текста и уезжала вместе с прокруткой. Живая проверка: редактор 879px
 * внутри области 263px, панель — на уровне середины текста.
 *
 * Сторож входит в обычный прогон `npm -w @etn/client test`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { readRendererCss } from './renderer-css.js';

const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKDOWN_FIELD = fs.readFileSync(
  path.join(CLIENT_ROOT, 'src', 'renderer', 'editor', 'markdown-field.ts'),
  'utf8',
);
const CSS = readRendererCss();

/** Тело CSS-правила по селектору (от `{` до первой `}`). */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  if (at === -1) return '';
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

describe('guard: панель кнопок поля комментария — вне прокрутки (f65add20)', () => {
  it('документ редактора обёрнут в отдельный контейнер прокрутки .md-field-scroll', () => {
    assert.match(
      MARKDOWN_FIELD,
      /div\(['"]md-field-scroll['"]\)/,
      'редактор обязан жить в контейнере прокрутки .md-field-scroll',
    );
    assert.match(
      MARKDOWN_FIELD,
      /scroller\.append\(editor\.dom\)/,
      'в .md-field-scroll кладётся только документ редактора (editor.dom)',
    );
    const areaLine = MARKDOWN_FIELD.match(/area\.replaceChildren\(([\s\S]*?)\);/);
    assert.ok(areaLine !== null, 'не найден вызов area.replaceChildren(...)');
    assert.match(
      areaLine[1]!,
      /scroller/,
      'тулбар и контейнер прокрутки собираются в области правки (area)',
    );
  });

  it('панель .md-field-actions добавлена под полем, а не внутри области правки', () => {
    const appendLine = MARKDOWN_FIELD.match(/root\.append\(([^)]*)\)/);
    assert.ok(appendLine !== null, 'не найден вызов root.append(...) поля');
    const args = appendLine[1]!;
    assert.match(args, /modeActions\.root/, 'панель кнопок обязана быть в корне поля');
    assert.match(args, /area/, 'область правки и панель — сиблинги в корне поля');
    assert.doesNotMatch(
      MARKDOWN_FIELD,
      /area\.(?:append|appendChild|replaceChildren)\([^)]*modeActions\.root/,
      'панель кнопок нельзя класть внутрь области правки (тогда она прокручивается с текстом)',
    );
  });

  it('контейнер прокрутки действительно прокручивается', () => {
    const body = ruleBody('.md-field-scroll');
    assert.ok(body !== '', 'не найдено правило .md-field-scroll');
    assert.match(body, /overflow:\s*auto/, '.md-field-scroll обязан прокручиваться (overflow: auto)');
  });

  it('в ограниченном поле редактор прокручивается внутри области, не переполняя её', () => {
    const area = ruleBody(
      '.ui-comment--fill > .ui-comment__body > .md-field > .md-field-area',
    );
    assert.ok(area !== '', 'нет правила области правки для ограниченного (--fill) поля');
    assert.match(area, /flex:\s*1 1 auto/, 'область правки занимает остаток высоты поля');
    assert.match(area, /min-height:\s*0/, 'область правки должна ужиматься (min-height: 0)');
    const scroll = ruleBody(
      '.ui-comment--fill > .ui-comment__body > .md-field > .md-field-area > .md-field-scroll',
    );
    assert.ok(scroll !== '', 'нет правила контейнера прокрутки для ограниченного поля');
    assert.match(scroll, /flex:\s*1 1 auto/, 'контейнер прокрутки занимает область правки');
    assert.match(scroll, /min-height:\s*0/, 'контейнер прокрутки должен ужиматься');
  });

  it('в правке панель кнопок — в потоке под полем и не ужимается', () => {
    const body = ruleBody('.md-field--editing > .md-field-actions');
    assert.ok(body !== '', 'нет правила кнопок режима в правке');
    assert.match(body, /position:\s*static/, 'в правке панель — в потоке под полем');
    assert.match(body, /flex:\s*0 0 auto/, 'панель кнопок не должна ужиматься флексом');
  });
});
