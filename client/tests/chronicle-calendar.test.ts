/**
 * Календарь месяца «Дневника» (0.10.1, задача T6 64ca2b48; элемент 55b07702)
 * и переименование интерфейса «Хроника» → «Дневник» (требование 80b31f7a).
 *
 * Чистая сетка месяца проверяется без DOM; переименование — структурно по
 * исходникам (пользовательские подписи и лента вместо таблицы).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { buildMonthWeeks } from '../src/renderer/screens/chronicle/calendar.js';

const RENDERER = resolve(import.meta.dirname, '..', 'src', 'renderer');

function read(rel: string): string {
  return readFileSync(resolve(RENDERER, ...rel.split('/')), 'utf8');
}

describe('календарь месяца', () => {
  it('строит ровно шесть недель по понедельникам', () => {
    const weeks = buildMonthWeeks(2026, 9);
    assert.equal(weeks.length, 6, 'высота календаря стабильна — всегда 6 строк');
    assert.equal(weeks[0]!.days.length, 7);
    // 2026-09-01 — вторник, сетка начинается с понедельника 2026-08-31.
    assert.equal(weeks[0]!.days[0]!.day, '2026-08-31');
    assert.equal(weeks[0]!.days[0]!.inMonth, false);
    assert.equal(weeks[0]!.days[1]!.day, '2026-09-01');
    assert.equal(weeks[0]!.days[1]!.inMonth, true);
  });

  it('дни внутри месяца помечены, чужие — нет; всего 42 ячейки', () => {
    const weeks = buildMonthWeeks(2026, 9);
    const cells = weeks.flatMap((w) => w.days);
    assert.equal(cells.length, 42);
    const inMonth = cells.filter((c) => c.inMonth);
    assert.equal(inMonth.length, 30, 'в сентябре 30 дней');
    assert.equal(inMonth[0]!.day, '2026-09-01');
    assert.equal(inMonth[inMonth.length - 1]!.day, '2026-09-30');
  });

  it('номер недели согласован с днём строки', () => {
    const weeks = buildMonthWeeks(2026, 9);
    const week = weeks.find((w) => w.days.some((d) => d.day === '2026-09-26'))!;
    // 2026-09-26 — суббота, её ISO-неделя считается по четвергу 2026-09-24.
    assert.equal(week.week, 39);
  });
});

describe('переименование «Хроника» → «Дневник» (80b31f7a)', () => {
  it('закладка экрана подписана «Дневник», а не «Хроника»', () => {
    const workspace = read('screens/workspace.ts');
    const start = workspace.indexOf('const chronicleViewButton = iconButton({');
    assert.ok(start >= 0, 'кнопка экрана найдена');
    const block = workspace.slice(start, workspace.indexOf('});', start));
    assert.ok(block.includes("title: 'Дневник'"), 'кнопка вида подписана «Дневник»');
    assert.ok(!block.includes("title: 'Хроника'"), 'прежняя подпись «Хроника» убрана');
    assert.ok(block.includes("svgIcon('calendar-month')"), 'иконка календаря сохранена');
  });

  it('словарь несёт строки «Дневника» про дневниковые записи', () => {
    const ru = read('lib/locales/ru.ts');
    assert.match(ru, /'diary\.addRecord': 'Добавить хроно-запись'/);
    assert.match(ru, /'diary\.feedEmpty': 'Дневниковых записей нет/);
  });

  it('экран — лента с общим контролом периода, а не таблица', () => {
    const src = read('screens/chronicle/chronicle.ts');
    assert.match(src, /buildMonthCalendar\(/, 'календарь месяца встроен в экран');
    assert.match(src, /buildPeriodEditor\(/, 'даты записи идут через общий контрол периода');
    assert.ok(!src.includes('createTable<'), 'табличный фасад больше не собирается');
    assert.ok(!src.includes('rowSplitter('), 'сплиттер таблицы убран');
    assert.ok(!/\.type\s*=\s*['"]date['"]/.test(src), 'своих полей даты у экрана нет');
  });
});
