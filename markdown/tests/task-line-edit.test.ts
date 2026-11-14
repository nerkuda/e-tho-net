/**
 * Построчные правки пункта задачи (0.16.1, задача «0.16.1: сервер задач»):
 * `isTaskLineMarker` / `setTaskLineDone` / `removeTaskLineMarker`.
 *
 * Проверяет ровно те формы строк, которые адресует `lineNo` парсера
 * (`TaskLine.lineNo` — строка СОДЕРЖИМОГО пункта): обычный пункт `- [ ] текст`
 * и пункт, у которого маркер стоит на отдельной строке содержимого
 * (`-\n  [ ] текст`). Маркер списка (`*`, `+`, `1.`, `1)`) не теряется.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isTaskLineMarker,
  parseTaskLines,
  removeTaskLineMarker,
  setTaskLineDone,
} from '../src/index.js';

describe('markdown: построчные правки пункта задачи', () => {
  it('toggle ставит и снимает чекбокс, сохраняя маркер списка', () => {
    assert.equal(setTaskLineDone('- [ ] текст', true), '- [x] текст');
    assert.equal(setTaskLineDone('- [x] текст', false), '- [ ] текст');
    assert.equal(setTaskLineDone('* [X] текст', false), '* [ ] текст');
    assert.equal(setTaskLineDone('1. [ ] пункт', true), '1. [x] пункт');
    assert.equal(setTaskLineDone('  [ ] текст', true), '  [x] текст');
  });

  it('toggle на строке без маркера — null (строка не пункт задачи)', () => {
    assert.equal(setTaskLineDone('- обычный пункт', true), null);
    assert.equal(setTaskLineDone('текст [ ] в середине строки', true), null);
    assert.equal(setTaskLineDone('', true), null);
  });

  it('cancel убирает маркер, оставляя пункт списка и отступ', () => {
    assert.equal(removeTaskLineMarker('- [ ] текст'), '- текст');
    assert.equal(removeTaskLineMarker('1. [x] пункт'), '1. пункт');
    assert.equal(removeTaskLineMarker('  [ ] текст'), '  текст');
    assert.equal(removeTaskLineMarker('- [ ]'), '-');
    assert.equal(removeTaskLineMarker('- обычный пункт'), null);
  });

  it('адресация по lineNo парсера: маркер на отдельной строке содержимого', () => {
    const body = '-\n  [ ] купить хлеб [[2026-01-05]]\n';
    const [row] = parseTaskLines(body);
    assert.ok(row !== undefined && row.isTask, 'пункт с маркером на строке содержимого — задача');
    // Парсер нумерует с 1: строка 2 — это строка содержимого с маркером.
    assert.equal(row.lineNo, 2);
    const lines = body.split('\n');
    const target = lines[row.lineNo - 1]!;
    assert.equal(target, '  [ ] купить хлеб [[2026-01-05]]');
    const toggled = setTaskLineDone(target, true);
    assert.equal(toggled, '  [x] купить хлеб [[2026-01-05]]');
    assert.equal(isTaskLineMarker(toggled!), true);
  });

  it('строки с датами и таблицы не считаются маркером', () => {
    assert.equal(isTaskLineMarker('| [[2026-01-01]] | [[2026-01-02]] |'), false);
    assert.equal(isTaskLineMarker('- [[2026-01-01]] встреча'), false);
  });
});
