/**
 * Чистые помощники контекстного меню date-чипа (0.16.1, задача 9ec9d72a;
 * элемент интерфейса c85ca40d, сценарий P5).
 *
 * Без DOM проверяется вся арифметика адресации и переноса, на которой держится
 * меню: адрес ссылки по смещению/порядковому номеру в `body_md`, сдвиг цели
 * (время сохраняется, алиас автора не теряется), единый сдвиг всех ссылок
 * строки и нормализация 31-го числа (та же, что у серверной операции `move`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chipSourceOffset,
  dateSpanByOffset,
  dateSpanByOrdinal,
  dayDelta,
  replaceSpanTarget,
  shiftLineDates,
  shiftSpanTarget,
  taskLineAt,
} from '../src/renderer/editor/date-chip-menu.js';
import { ShimElement } from './dom-shim.js';

// ---------------------------------------------------------------------------
// Порядковый номер чипа (HTML ленты без source-map)
// ---------------------------------------------------------------------------

test('dateSpanByOrdinal: чипы адресуются в порядке body_md, с номером строки', () => {
  const body = 'запись\n- [ ] задача [[2026-11-02]]..[[2026-11-05]]\nещё [[2026-11-06]]';
  const first = dateSpanByOrdinal(body, 0);
  assert.ok(first);
  assert.equal(first.lineNo, 1);
  assert.equal(first.span.parts.date, '2026-11-02');
  assert.equal(first.lineText, '- [ ] задача [[2026-11-02]]..[[2026-11-05]]');

  assert.equal(dateSpanByOrdinal(body, 1)?.span.parts.date, '2026-11-05');
  assert.equal(dateSpanByOrdinal(body, 2)?.span.parts.date, '2026-11-06');
  assert.equal(dateSpanByOrdinal(body, 3), null);
  assert.equal(dateSpanByOrdinal(body, -1), null);
});

test('dateSpanByOrdinal: ссылка с временем и алиасом разбирается как date-ссылка', () => {
  const body = '[[2026-11-02 14:30]] и [[2026-11-03|третье]]';
  assert.deepEqual(dateSpanByOrdinal(body, 0)?.span.parts, { date: '2026-11-02', time: '14:30' });
  assert.equal(dateSpanByOrdinal(body, 1)?.span.parts.date, '2026-11-03');
  // Не-date ссылка не считается чипом: `[[#uuid]]` и `[[Имя]]` в ordinal не входят.
  assert.equal(dateSpanByOrdinal('[[#8e0d670e-de61-4da7-b13e-9232cd1c6ca5]]', 0), null);
  assert.equal(dateSpanByOrdinal('[[Имя мысли]]', 0), null);
});

test('dateSpanByOrdinal: `[[…]]` внутри ограды кода не считается чипом', () => {
  const body = ['```', '[[2026-11-01]]', '```', 'настоящая [[2026-11-02]]'].join('\n');
  const found = dateSpanByOrdinal(body, 0);
  assert.ok(found);
  assert.equal(found.span.parts.date, '2026-11-02', 'первый чип — после ограды');
  assert.equal(found.lineNo, 3);
  assert.equal(dateSpanByOrdinal(body, 1), null);
});

// ---------------------------------------------------------------------------
// Абсолютное смещение (source-map просмотра)
// ---------------------------------------------------------------------------

test('dateSpanByOffset: смещение внутри цели даёт правильную строку и ссылку', () => {
  const body = 'текст\n[[2026-11-02]]';
  const at = body.indexOf('2026-11-02');
  const found = dateSpanByOffset(body, at);
  assert.ok(found);
  assert.equal(found.lineNo, 1);
  assert.equal(found.span.parts.date, '2026-11-02');
  assert.equal(dateSpanByOffset(body, body.indexOf('текст')), null);
});

test('dateSpanByOffset: смещение в алиасе тоже находит ссылку (алиас = source-map)', () => {
  const body = 'см. [[2026-11-02|второе ноября]]';
  const found = dateSpanByOffset(body, body.indexOf('второе'));
  assert.ok(found, 'алиас лежит внутри диапазона ссылки');
  assert.equal(found.span.parts.date, '2026-11-02');
});

test('dateSpanByOffset: отрицательное смещение и смещение за концом — null', () => {
  const body = '[[2026-11-02]]';
  assert.equal(dateSpanByOffset(body, -1), null);
  assert.equal(dateSpanByOffset(body, body.length + 10), null);
});

// ---------------------------------------------------------------------------
// Сдвиг дат
// ---------------------------------------------------------------------------

/** Реальная date-ссылка строки — источник span'ов для проверок сдвига. */
function spanOf(line: string, ordinal = 0) {
  const found = dateSpanByOrdinal(line, ordinal);
  assert.ok(found, `в строке нет date-ссылки: ${line}`);
  return found.span;
}

test('shiftSpanTarget: дни и месяцы, время HH:MM сохраняется', () => {
  const bare = spanOf('[[2026-11-02]]');
  assert.equal(shiftSpanTarget(bare, { days: 1 }), '2026-11-03');
  assert.equal(shiftSpanTarget(bare, { days: 7 }), '2026-11-09');
  assert.equal(shiftSpanTarget(bare, { months: 1 }), '2026-12-02');

  const timed = spanOf('[[2026-11-02 14:30]]');
  assert.equal(shiftSpanTarget(timed, { days: 1 }), '2026-11-03 14:30');
});

test('shiftSpanTarget: 31-е → последний день месяца (как у серверной move)', () => {
  assert.equal(shiftSpanTarget(spanOf('[[2026-01-31]]'), { months: 1 }), '2026-02-28');
  assert.equal(shiftSpanTarget(spanOf('[[2026-03-31]]'), { months: 1 }), '2026-04-30');
});

test('shiftLineDates: единый сдвиг всех ссылок строки; алиас автора сохраняется', () => {
  const next = shiftLineDates('- [ ] [[2026-11-02]]..[[2026-11-05|конец]]', { days: 1 });
  assert.equal(next, '- [ ] [[2026-11-03]]..[[2026-11-06|конец]]');
  assert.equal(shiftLineDates('строка без дат', { days: 1 }), null);
});

test('replaceSpanTarget: меняется только цель, скобки и алиас остаются', () => {
  const line = 'см. [[2026-11-02|второе ноября]] дальше';
  const span = dateSpanByOrdinal(line, 0)!;
  const next = replaceSpanTarget(line, span.span, '2026-12-01');
  assert.equal(next, 'см. [[2026-12-01|второе ноября]] дальше');
});

test('dayDelta: разница календарных дат и безопасный ноль на мусоре', () => {
  assert.equal(dayDelta('2026-11-02', '2026-11-05'), 3);
  assert.equal(dayDelta('2026-11-05', '2026-11-02'), -3);
  assert.equal(dayDelta('не дата', '2026-11-02'), 0);
});

// ---------------------------------------------------------------------------
// Строка задачи: режим «все ссылки строки»
// ---------------------------------------------------------------------------

test('taskLineAt: задача находится по номеру строки body_md (1-based парсер ↔ 0-based адрес)', () => {
  const body = 'текст\n- [ ] задача [[2026-11-02]]\n- [ ] вторая';
  const task = taskLineAt(body, 1);
  assert.ok(task);
  assert.equal(task.isTask, true);
  assert.equal(task.periodFrom, '2026-11-02');
  assert.equal(taskLineAt(body, 0), null, 'обычный текст — не задача');
  assert.equal(taskLineAt(body, 9), null, 'строки нет');
});

test('taskLineAt: вложенный пункт чек-листа — не задача (перенос одной ссылкой)', () => {
  const body = '- [ ] задача [[2026-11-02]]\n  - [ ] подпункт';
  assert.equal(taskLineAt(body, 0)?.isTask, true);
  assert.equal(taskLineAt(body, 1), null, 'subtask не считается строкой-задачей');
});

// ---------------------------------------------------------------------------
// Смещение чипа из DOM
// ---------------------------------------------------------------------------

test('chipSourceOffset: data-md-start из source-map, мусор — null', () => {
  const chip = new ShimElement('span');
  chip.setAttribute('data-md-start', '12');
  assert.equal(chipSourceOffset(chip), 12);

  const empty = new ShimElement('span');
  assert.equal(chipSourceOffset(empty), null);

  const broken = new ShimElement('span');
  broken.setAttribute('data-md-start', 'x');
  assert.equal(chipSourceOffset(broken), null);

  const negative = new ShimElement('span');
  negative.setAttribute('data-md-start', '-3');
  assert.equal(chipSourceOffset(negative), null);
});
