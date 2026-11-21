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
  addTaskLineMarker,
  isTaskLineMarker,
  parseTaskLines,
  removeTaskLineDates,
  removeTaskLineMarker,
  setTaskLineDone,
  taskLineBodyStart,
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
    // Пустая после отмены строка — пустой пункт списка (`- `), а не голый дефис:
    // решение 2026-11-16, как у `removeTaskLineDates` (пачка 4, пункт 4).
    assert.equal(removeTaskLineMarker('- [ ]'), '- ');
    assert.equal(removeTaskLineMarker('  [ ]'), '  - ');
    assert.equal(removeTaskLineMarker('- обычный пункт'), null);
  });

  it('cancel строки, созданной «на сегодня», не оставляет обрезков (пачка 4, пункт 4)', () => {
    // Именно эта форма пишется «Создать задачу на сегодня»: ID-ссылка субъекта и
    // date-ссылка дня. Отмена снимает ТОЛЬКО маркер: ссылки остаются целыми, без
    // обрывков вида `[ ]`, `-`, двойных пробелов.
    assert.equal(
      removeTaskLineMarker('- [ ] [[#11111111-1111-4111-8111-111111111111]] [[2026-11-19]]'),
      '- [[#11111111-1111-4111-8111-111111111111]] [[2026-11-19]]',
    );
    assert.equal(
      removeTaskLineMarker('1. [x] Публикация [[2026-11-19]]'),
      '1. Публикация [[2026-11-19]]',
    );
  });

  it('addTaskLineMarker возвращает маркер отменённой строке (обратная операция)', () => {
    assert.equal(
      addTaskLineMarker('- [[#11111111-1111-4111-8111-111111111111]] [[2026-11-19]]'),
      '- [ ] [[#11111111-1111-4111-8111-111111111111]] [[2026-11-19]]',
    );
    assert.equal(addTaskLineMarker('1. пункт'), '1. [ ] пункт');
    assert.equal(addTaskLineMarker('  - пункт'), '  - [ ] пункт');
    // Уже задача — возвращается как есть (идемпотентно), не пункт списка — null.
    assert.equal(addTaskLineMarker('- [x] задача'), '- [x] задача');
    assert.equal(addTaskLineMarker('просто текст [[2026-11-19]]'), null);
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

  it('начало текста пункта — сразу после маркера и пробелов', () => {
    assert.equal(taskLineBodyStart('- [ ] текст'), '- [ ] '.length);
    assert.equal(taskLineBodyStart('* [x]   текст'), '* [x]   '.length);
    assert.equal(taskLineBodyStart('  [ ] текст'), '  [ ] '.length);
    assert.equal(taskLineBodyStart('- [ ]'), '- [ ]'.length, 'пустой пункт — конец строки');
    assert.equal(taskLineBodyStart('- обычный пункт'), null);
    assert.equal(taskLineBodyStart('текст [ ] в середине'), null);
  });

  it('строки с датами и таблицы не считаются маркером', () => {
    assert.equal(isTaskLineMarker('| [[2026-01-01]] | [[2026-01-02]] |'), false);
    assert.equal(isTaskLineMarker('- [[2026-01-01]] встреча'), false);
  });

  it('удаление дат: пустой остаток становится пустым пунктом списка, а не задачей', () => {
    // Уточнение ТЗ 2026-11-16: `- [ ] [[дата]]` → `- ` (пустой пункт списка):
    // задачи без текста не существует, маркер уходит вместе с датой.
    assert.equal(removeTaskLineDates('- [ ] [[2026-11-16]]'), '- ');
    assert.equal(removeTaskLineDates('- [ ] [[2026-11-16]] [[2026-11-17]]'), '- ');
    assert.equal(removeTaskLineDates('* [x] [[2026-11-16 10:00]]'), '* ');
    assert.equal(removeTaskLineDates('1. [ ] [[2026-11-16]]'), '1. ');
    // Текст остался — маркер сохраняется, уходит только ссылка.
    assert.equal(removeTaskLineDates('- [ ] Задача [[2026-11-16]]'), '- [ ] Задача');
    assert.equal(removeTaskLineDates('- [ ] [[2026-11-16]] хвост'), '- [ ] хвост');
  });
});
