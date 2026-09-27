/**
 * Дефект приёмки задачи 8012a9b0: переход к дневниковой записи («Открыть в
 * дневнике» в контекстном меню строки вкладки «Дневник» редактора) не
 * устанавливал в календаре дату записи (ошибка ecd91c1d). `jumpToRecord`
 * вызывал только `syncCalendar()` — выделение дня без смены ОТОБРАЖАЕМОГО
 * месяца, — поэтому календарь оставался на месяце из состояния вкладки, дня
 * записи в его сетке не было (ни отметки, ни выделения), и переход выглядел как
 * «отметок нет».
 *
 * Спецификация (элемент 7310d077, ревизия 2026-09-27): «„Открыть в дневнике“ —
 * открывает экран „Дневник“, ставит в календаре дату записи и делает запись
 * текущей в ленте». Проверка структурная по исходнику — в стиле
 * `chronicle-calendar.test.ts`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

/** Тело функции `name` из исходника — до закрывающей скобки на её отступе. */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `функция ${name} найдена`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `тело ${name} найдено`);
  return src.slice(start, end);
}

describe('переход к записи ставит календарь на её дату (ошибка ecd91c1d)', () => {
  it('в переходе месяц календаря меняется на месяц записи', () => {
    const src = read('screens/chronicle/chronicle.ts');
    assert.match(
      src,
      /function showRecordDayInCalendar\(day: string\): void/,
      'есть помощник установки даты записи в календаре',
    );
    const helper = bodyOf(src, 'showRecordDayInCalendar');
    assert.match(helper, /calendar\.showDate\(day\)/, 'смена отображаемого месяца');
    assert.match(helper, /syncCalendar\(\)/, 'выделение согласуется с полями периода');
  });

  it('jumpToRecord показывает день записи, а не только выделение', () => {
    const src = read('screens/chronicle/chronicle.ts');
    const jump = bodyOf(src, 'jumpToRecord');
    assert.match(
      jump,
      /showRecordDayInCalendar\(startDay\)/,
      'день записи (дата начала) показывается в календаре',
    );
    assert.ok(
      !/\n\s*syncCalendar\(\);/.test(jump),
      'выделение без смены месяца в переходе не остаётся',
    );
  });

  it('сброс отбора в переходе тоже показывает день записи', () => {
    const src = read('screens/chronicle/chronicle.ts');
    const jump = bodyOf(src, 'jumpToRecord');
    // Оба пути (запись прошла отбор / отбор сброшен) ставят календарь на дату
    // начала: иначе после сброса отбор переехал бы на месяц из состояния.
    const calls = jump.match(/showRecordDayInCalendar\(startDay\)/g) ?? [];
    assert.equal(calls.length, 2, 'календарь ставится на дату записи на обоих путях');
  });

  it('обычная синхронизация календаря месяц не двигает (навигация пользователя цела)', () => {
    const src = read('screens/chronicle/chronicle.ts');
    const sync = bodyOf(src, 'syncCalendar');
    assert.ok(!sync.includes('showDate('), 'syncCalendar не переезжает на другой месяц');
  });
});
