/**
 * Просмотр строк задач как комментария (0.16.1, задача `c63e3652`, пачка 7).
 *
 * Здесь — то, что не покрывают тесты панели на шиме: пометка ПРОСРОЧЕННЫХ
 * задач в готовом DOM просмотра (`markOverdueTaskItems`). Признак берётся
 * оттуда же, откуда его взял бы глаз пользователя: чекбокс строки и её
 * date-чипы (`data-wiki-date`) — без второго парсера markdown.
 *
 * Проверяется:
 *  • просрочка ставится по ПОСЛЕДНЕЙ дате СВОЕЙ строки (чипы вложенных пунктов
 *    не в счёт — ближайший `li` другой);
 *  • отмеченная задача и строка без даты красной не становятся;
 *  • класс ставится на `li.task-list-item` (вид — CSS-правило на токене темы),
 *    а код-блок задачи не создаёт вовсе;
 *  • просмотр комментария и лента «Дневника» вызывают пометку после рендера.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { renderMarkdown, WIKI_LINK_DATE_ATTR } from '@etn/markdown';

import { markOverdueTaskItems } from '../src/renderer/editor/task-lines-view.js';
import { ShimElement } from './dom-shim.js';
import { RENDERER_ROOT } from './renderer-css.js';

const TODAY = '2026-11-20';

/** CSS просмотра markdown (файл рендерера, а не собранный манифест). */
const EDITOR_CSS = fs
  .readFileSync(path.join(RENDERER_ROOT, 'styles', 'editor.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Пункт списка задач: `li.task-list-item` с чекбоксом и date-чипами. */
function taskItem(
  host: ShimElement,
  dates: readonly string[],
  options: { checked?: boolean } = {},
): ShimElement {
  const item = new ShimElement('li', 'task-list-item');
  const box = new ShimElement('input');
  box.type = 'checkbox';
  box.checked = options.checked === true;
  item.append(box);
  for (const date of dates) {
    const chip = new ShimElement('span', 'wiki-link wiki-link-date');
    chip.setAttribute(WIKI_LINK_DATE_ATTR, date);
    item.append(chip);
  }
  host.append(item);
  return item;
}

/** Вложенный点数 списка внутри пункта. */
function nestedItem(parent: ShimElement, dates: readonly string[]): ShimElement {
  const list = new ShimElement('ul');
  parent.append(list);
  return taskItem(list, dates);
}

describe('просмотр: просроченные задачи красным (@152@, пачка 7)', () => {
  it('просрочка — по последней дате СВОЕЙ строки, не по дате вложенного пункта', () => {
    const host = new ShimElement('div');
    const overdue = taskItem(host, ['2026-11-18', '2026-11-19']);
    const future = taskItem(host, ['2026-11-21']);
    const nestedOnly = taskItem(host, ['2026-11-25']);
    const inner = nestedItem(nestedOnly, ['2026-11-01']);

    markOverdueTaskItems(host as unknown as HTMLElement, TODAY);

    assert.equal(overdue.classList.contains('is-overdue'), true, 'срок прошёл — красная');
    assert.equal(future.classList.contains('is-overdue'), false, 'срок впереди — обычная');
    assert.equal(
      nestedOnly.classList.contains('is-overdue'),
      false,
      'сроки вложенного пункта не делают просроченной родительскую строку',
    );
    assert.equal(
      inner.classList.contains('is-overdue'),
      true,
      'вложенный пункт со своим прошедшим сроком — сам просрочен (своя строка)',
    );
    assert.equal(host.querySelectorAll('.is-overdue').length, 2, 'помечены ровно две строки');
  });

  it('отмеченная задача и строка без даты красной не становятся', () => {
    const host = new ShimElement('div');
    const done = taskItem(host, ['2026-11-01'], { checked: true });
    const undated = taskItem(host, []);
    const today = taskItem(host, [TODAY]);

    markOverdueTaskItems(host as unknown as HTMLElement, TODAY);

    assert.equal(done.classList.contains('is-overdue'), false, 'выполненная не просрочена');
    assert.equal(undated.classList.contains('is-overdue'), false, 'без даты — не просрочена');
    assert.equal(today.classList.contains('is-overdue'), false, 'срок сегодня — ещё не просрочка');
  });

  it('пустой просмотр и код-блок: пометок нет (код задачей не является)', () => {
    const host = new ShimElement('div');
    markOverdueTaskItems(host as unknown as HTMLElement, TODAY);
    assert.equal(host.querySelectorAll('.is-overdue').length, 0, 'пустой DOM — нечего метить');

    // Реальный рендер кода: `<pre><code>` — ни `task-list-item`, ни чекбокса,
    // поэтому `markOverdueTaskItems` метить нечего даже при прошедшей дате.
    const html = renderMarkdown(['```', '- [ ] в коде [[2026-11-01]]', '```'].join('\n'));
    assert.doesNotMatch(html, /task-list-item/, 'код-строка не стала пунктом задачи');
  });

  it('вид просроченной строки — токен темы, без литералов цвета', () => {
    const rule = /li\.task-list-item\.is-overdue[^{]*\{([^}]*)\}/.exec(EDITOR_CSS);
    assert.ok(rule !== null, 'правило `li.task-list-item.is-overdue` живёт в стилях просмотра');
    assert.match(rule[1]!, /color:\s*var\(--danger\)/, 'красный — токен темы');
    assert.doesNotMatch(rule[1]!, /#[0-9a-f]{3,8}\b/i, 'литералов цвета нет');
  });

  it('просмотр комментария и запись «Дневника» зовут пометку после рендера', () => {
    const markdownField = fs.readFileSync(
      path.join(RENDERER_ROOT, 'editor', 'markdown-field.ts'),
      'utf8',
    );
    assert.match(
      markdownField,
      /markOverdueTaskItems\(view\)/,
      'поле комментария метит просрочку в отрисованном просмотре',
    );
    const chronicle = fs.readFileSync(
      path.join(RENDERER_ROOT, 'screens', 'chronicle', 'chronicle.ts'),
      'utf8',
    );
    assert.match(
      chronicle,
      /markOverdueTaskItems\(recordView\)/,
      'лента «Дневника» метит просрочку в тексте записи',
    );
  });
});
