/**
 * Футер редактора комментария прижат к низу зоны, а не стоит в потоке под
 * текстом (ошибка 051ff84b, 0.16.1).
 *
 * Симптом: на вкладке «Основное» у мысли с панелью «Задачи» (двухзонная
 * раскладка `.main-tab`) кнопки «Отмена»/«Сохранить» рендерились сразу под
 * последней строкой текста, а ниже оставалось пустое место до низа зоны.
 *
 * Причина: тело зоны (`.group-body`) — блок, поэтому fill-цепочка оболочки
 * комментария (`--fill` → `__body` → `.md-field` → `.md-field-area`) не
 * растягивалась на высоту зоны: поле брало минимальные пять строк, а футер шёл
 * следом за ним. Фикс — зона-комментария как flex-колонка; прокрутка остаётся
 * ВНУТРИ поля (`.md-field-scroll`), поэтому футер вне скролла и не уезжает.
 *
 * jsdom в проекте нет: CSS-правила проверяются разбором собранного файла
 * стилей, порядок узлов — по исходнику сборки поля. Мутационная проба: убрать
 * `display: flex` из правила зоны — первый тест краснеет.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { RENDERER_ROOT } from './renderer-css.js';
import { stripCssComments } from './theme-css.js';

/** Тело правила по ТОЧНОМУ селектору (`null`, если правила нет). */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return match === null ? null : (match[1] ?? '');
}

function readRenderer(file: string): string {
  return stripCssComments(readFileSync(resolve(RENDERER_ROOT, file), 'utf8'));
}

/** CSS элемента-оболочки комментария — цепочка `--fill`. */
function commentShellCss(): string {
  return readRenderer('lib/ui/comment.css');
}

describe('футер редактора комментария прижат к низу зоны (ошибка 051ff84b)', () => {
  it('CSS: тело зоны с комментарием — flex-колонка и не второй скроллпорт', () => {
    const body = ruleBody(
      readRenderer('styles/editor.css'),
      '.main-tab > .group > .group-body:has(> .ui-comment)',
    );
    assert.ok(body !== null, 'нет правила зоны комментария во вкладке «Основное»');
    assert.match(
      body,
      /display:\s*flex/,
      'зона осталась блоком — fill-цепочка оболочки не растянется, футер встанет под текстом',
    );
    assert.match(
      body,
      /flex-direction:\s*column/,
      'зона не колонка — шапка/тело/футер не выстраиваются по вертикали',
    );
    assert.match(
      body,
      /overflow:\s*hidden/,
      'зона прокручивается сама — получится второй скроллпорт и футер уедет в поток',
    );
  });

  it('правило зоны не задевает панель «Задачи» (селектор по оболочке комментария)', () => {
    const css = readRenderer('styles/editor.css');
    // Общее правило тела группы (флекс-элемент зоны) остаётся блочным: панель
    // «Задачи» прокручивается именно телом группы, и колонка без своего скролла
    // её сломает. Переопределение живёт только на зоне с оболочкой комментария.
    const general = ruleBody(css, '.main-tab > .group > .group-body');
    assert.ok(general !== null, 'пропало общее правило тела группы вкладки «Основное»');
    assert.doesNotMatch(
      general,
      /display:\s*flex/,
      'общее тело группы стало flex-колонкой — задевает зону «Задачи»',
    );
    const tasks = ruleBody(css, '.main-tab .ui-task-panel.is-headless');
    assert.ok(tasks !== null, 'пропало правило панели «Задачи».');
    assert.match(tasks, /overflow:\s*visible/, 'панель «Задачи» потеряла свою прокрутку');
  });

  it('оболочка комментария растягивается по зоне (модификатор --fill)', () => {
    const comments = readFileSync(resolve(RENDERER_ROOT, 'editor', 'comments.ts'), 'utf8').replace(
      /\s+/g,
      ' ',
    );
    assert.match(
      comments,
      /commentShell\(\{ variant: 'fill', scroll: true/,
      'постоянный комментарий собирается без `--fill` — корень не заполнит зону',
    );

    const shell = commentShellCss();
    const root = ruleBody(shell, '.ui-comment--fill');
    assert.ok(root !== null, 'нет правила `.ui-comment--fill`');
    assert.match(root, /flex:\s*1 1 auto/, 'корень --fill не растягивается флексом');
    assert.match(root, /min-height:\s*0/, 'корень --fill без min-height: 0 не ужмётся в зоне');

    const body = ruleBody(shell, '.ui-comment--fill > .ui-comment__body');
    assert.ok(body !== null, 'нет правила тела --fill');
    assert.match(body, /flex:\s*1 1 auto/, 'тело --fill не заполняет остаток высоты');
    assert.match(body, /flex-direction:\s*column/, 'тело --fill не колонка — поле не растянется');

    const field = ruleBody(shell, '.ui-comment--fill > .ui-comment__body > .md-field');
    assert.ok(field !== null, 'нет правила поля --fill');
    assert.match(field, /flex:\s*1 1 auto/, 'поле --fill не заполняет тело комментария');
    assert.match(field, /flex-direction:\s*column/, 'поле --fill не колонка — футер не прижмётся');
  });

  it('вкладка без панели («связь») сохраняет прижатие футера через main-full', () => {
    // Одиночная секция вкладки «Основное» (связь, панели «Задачи» нет) живёт в
    // `.main-full` — там корень комментария уже флекс-элемент, и fill-цепочка
    // растягивает поле. Проверяем, что обёртка не потеряла флекс.
    const legacy = readRenderer('styles/legacy.css');
    const wrap = ruleBody(legacy, '.main-full');
    assert.ok(wrap !== null, 'пропало правило `.main-full` (одиночная секция вкладки)');
    assert.match(
      wrap,
      /display:\s*flex/,
      '`.main-full` перестала быть флексом — футер уедет в поток',
    );
    assert.match(wrap, /flex-direction:\s*column/, '`.main-full` не колонка');
    assert.match(wrap, /flex:\s*1 1 auto/, '`.main-full` не растягивается на высоту вкладки');
  });

  it('футер правки — вне контейнера прокрутки текста и в потоке', () => {
    const field = readFileSync(
      resolve(RENDERER_ROOT, 'editor', 'markdown-field.ts'),
      'utf8',
    ).replace(/\s+/g, ' ');
    // Порядок узлов поля: панель режима (`.md-field-actions`) — сиблинг области
    // правки, а не часть скроллящегося документа.
    assert.match(
      field,
      /root\.append\(search\.element, view, area, modeActions\.root\)/,
      'панель кнопок режима больше не отдельный узел поля — футер может попасть в скролл',
    );
    // Скроллится только документ редактора внутри области правки.
    assert.match(
      field,
      /const scroller = div\('md-field-scroll'\);[\s\S]{0,200}area\.replaceChildren\(buildCommentToolbar\(commandHost\), scroller\)/,
      'текст перестал прокручиваться в `.md-field-scroll` внутри `.md-field-area`',
    );

    const css = readRenderer('styles/editor.css');
    const actions = ruleBody(css, '.md-field--editing > .md-field-actions');
    assert.ok(actions !== null, 'нет правила футера в режиме правки');
    assert.match(
      actions,
      /position:\s*static/,
      'футер правки снова позиционирован — он должен стоять в потоке под областью текста',
    );
    assert.match(actions, /flex:\s*0 0 auto/, 'футер правки ужимается флексом');
    assert.match(actions, /justify-content:\s*flex-end/, 'кнопки футера не прижаты к правому краю');
  });
});
