/**
 * Маркеры календаря месяца «Дневника» (0.16.1, задача d793fd69; требование
 * ab9d627b, элемент интерфейса 55b07702).
 *
 * Что закрепляем:
 *  1. клетка дня несёт ЧЕТЫРЕ фиксированных места маркеров слева от номера,
 *     порядок — `CALENDAR_MARKER_ORDER`; отсутствующий маркер невидим, но место
 *     держит (появление соседа не сдвигает столбик);
 *  2. режим `markers: off` — опция не передана, столбика нет вовсе (календарь
 *     диалога «Дата/период» маркеров не показывает);
 *  3. счётчиков в клетке нет: ни `.cal-count`, ни точек-порогов 0.10.2;
 *  4. `refresh()` перерисовывает маркеры, не пересоздавая календарь и не меняя
 *     выделение/показанный месяц;
 *  5. `groupCalendarMarkers` раскладывает агрегатный ответ сервера по локальным
 *     дням: интервалы записей и моменты напоминаний — UTC-инстансы, день
 *     считает клиент (требование fcdcd75f), календарные дни задач/фактов/
 *     просрочки берутся как есть и обрезаются по месяцу;
 *  6. цвета маркеров — только токены темы из `chronicle.css` (без hex).
 *
 * jsdom в проекте нет — общий DOM-шим (`./dom-shim.js`), как в
 * `first-day-of-week-widgets.test.ts`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  CALENDAR_MARKER_ORDER,
  type CalendarMarkerKind,
  type CalendarMarkersResult,
} from '@etn/shared';

import { groupCalendarMarkers } from '../src/renderer/screens/chronicle/calendar-markers.js';
import { ShimElement } from './dom-shim.js';

function installShim(): void {
  (globalThis as any).document = {
    createElement: (tag: string) => new ShimElement(tag),
    createElementNS: (_ns: string, tag: string) => new ShimElement(tag),
    createTextNode: (text: string) => new ShimElement('#text', undefined, text),
    documentElement: new ShimElement('html'),
    body: new ShimElement('body'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    activeElement: null,
    querySelector: () => null,
  };
  const win = ((globalThis as any).window ??= {}) as Record<string, unknown>;
  win['innerWidth'] = 1200;
  win['innerHeight'] = 800;
  win['setTimeout'] = (fn: () => void) => {
    fn();
    return 1;
  };
  win['clearTimeout'] = () => undefined;
  win['addEventListener'] = () => undefined;
  win['removeEventListener'] = () => undefined;
  win['dispatchEvent'] = () => undefined;
  win['matchMedia'] = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  win['localStorage'] = {
    getItem: () => null,
    setItem: () => undefined,
  };
}

installShim();

const calendarMod = await import('../src/renderer/lib/month-calendar.js');

const CSS = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'renderer', 'styles', 'screens', 'chronicle.css'),
  'utf8',
);

// ---------------------------------------------------------------------------
// Компонент календаря: маркеры клетки
// ---------------------------------------------------------------------------

/** Кнопка дня `YYYY-MM-DD` (подсказка кнопки — сам день). */
function dayCell(root: ShimElement, day: string): ShimElement {
  const found = root
    .findAll((node) => node.classList.contains('cal-day'))
    .find((node) => node.title === day);
  assert.ok(found !== undefined, `клетка дня ${day} есть в сетке`);
  return found!;
}

/** Столбик маркеров клетки; `null` — столбика нет. */
function markerBox(root: ShimElement, day: string): ShimElement | null {
  return dayCell(root, day).querySelector('.cal-markers');
}

/** Классы маркеров клетки по порядку (`.cal-marker--<вид>` → `<вид>`). */
function markerKinds(box: ShimElement): string[] {
  return box.children.map((marker) =>
    marker.className
      .split(/\s+/)
      .find((token) => token.startsWith('cal-marker--'))!
      .slice('cal-marker--'.length),
  );
}

/** Собирает календарь октября 2026 с источником маркеров. */
function buildCalendar(markers?: (day: string) => readonly CalendarMarkerKind[]): ShimElement {
  const options: Record<string, unknown> = {
    today: '2026-10-15',
    month: { year: 2026, month: 10 },
    weekNumbers: false,
  };
  if (markers !== undefined) options['markers'] = markers;
  const calendar = calendarMod.buildMonthCalendar(options as any);
  return calendar.root as unknown as ShimElement;
}

describe('календарь месяца: маркеры дня (0.16.1, ab9d627b)', () => {
  it('четыре фиксированных места слева от номера, порядок — CALENDAR_MARKER_ORDER', () => {
    const root = buildCalendar((day) =>
      day === '2026-10-05' ? (['overdue', 'records'] as const) : [],
    );
    const box = markerBox(root, '2026-10-05');
    assert.ok(box !== null, 'столбик маркеров есть');

    // Порядок мест — одна точка правды с группировкой ответа сервера.
    assert.deepEqual(markerKinds(box!), [...CALENDAR_MARKER_ORDER]);
    assert.equal(box!.children.length, 4, 'ровно четыре места');

    const [records, plans, facts, overdue] = box!.children;
    // Присутствующие маркеры покрашены и подписаны, отсутствующие невидимы.
    assert.ok(!records!.classList.contains('is-off'), 'записи видны');
    assert.equal(records!.title, 'Записи', 'подсказка маркера записей');
    assert.ok(plans!.classList.contains('is-off'), 'задач нет');
    assert.equal(plans!.title, '', 'у отсутствующего маркера нет подсказки');
    assert.ok(facts!.classList.contains('is-off'), 'фактов нет');
    assert.ok(!overdue!.classList.contains('is-off'), 'просрочка видна');
    assert.equal(overdue!.title, 'Просроченные задачи');

    // Столбик стоит ПЕРЕД номером дня, счётчика в клетке нет.
    const cell = dayCell(root, '2026-10-05');
    assert.equal(cell.children[0], box, 'маркеры — первый узел клетки');
    assert.equal(cell.children[cell.children.length - 1]!.className, 'cal-day-num');
    assert.equal(cell.querySelector('.cal-day-num')!.textContent, '5');
    assert.equal(cell.querySelector('.cal-count'), null, 'число-счётчик упразднено');
  });

  it('пустой день — столбик из четырёх невидимых мест (места не сдвигаются)', () => {
    const root = buildCalendar(() => []);
    const box = markerBox(root, '2026-10-12');
    assert.ok(box !== null, 'столбик есть и у пустого дня');
    assert.equal(box!.children.length, 4);
    assert.ok(
      box!.children.every((marker) => marker.classList.contains('is-off')),
      'все маркеры невидимы',
    );
  });

  it('markers: off (опция не передана) — столбика нет вовсе: календарь диалога', () => {
    const root = buildCalendar();
    assert.equal(root.findAll((node) => node.classList.contains('cal-markers')).length, 0);
    assert.equal(root.findAll((node) => node.classList.contains('cal-marker')).length, 0);
    // Сетка и номера дней при этом на месте.
    assert.equal(dayCell(root, '2026-10-05').querySelector('.cal-day-num')!.textContent, '5');
  });

  it('refresh() перерисовывает маркеры без пересоздания календаря и смены месяца', () => {
    const byDay = new Map<string, readonly CalendarMarkerKind[]>();
    const calendar = calendarMod.buildMonthCalendar({
      today: '2026-10-15',
      month: { year: 2026, month: 10 },
      weekNumbers: false,
      markers: (day) => byDay.get(day) ?? [],
    });
    const root = calendar.root as unknown as ShimElement;
    assert.ok(markerBox(root, '2026-10-07')!.children.every((m) => m.classList.contains('is-off')));

    byDay.set('2026-10-07', ['plans']);
    calendar.refresh();

    assert.equal(calendar.root, root, 'календарь не пересоздаётся');
    assert.deepEqual(calendar.getMonth(), { year: 2026, month: 10 }, 'месяц не сдвинулся');
    const [records, plans, facts, overdue] = markerBox(root, '2026-10-07')!.children;
    assert.ok(!plans!.classList.contains('is-off'), 'новый маркер задач виден');
    assert.ok(records!.classList.contains('is-off'));
    assert.equal(facts!.classList.contains('is-off'), true);
    assert.equal(overdue!.classList.contains('is-off'), true);
  });

  it('цвета маркеров — токены темы, прямых цветов нет', () => {
    const rule = (selector: string): string =>
      new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1] ?? '';
    assert.match(rule('.cal-marker--records'), /background:\s*var\(--accent\)/);
    assert.match(rule('.cal-marker--plans'), /background:\s*var\(--warn\)/);
    assert.match(rule('.cal-marker--facts'), /background:\s*var\(--ok\)/);
    assert.match(rule('.cal-marker--overdue'), /background:\s*var\(--danger\)/);
    for (const selector of [
      '.cal-marker',
      '.cal-marker--records',
      '.cal-marker--plans',
      '.cal-marker--facts',
      '.cal-marker--overdue',
    ]) {
      assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(rule(selector)), `${selector}: без hex-цвета`);
      assert.ok(!/\brgba?\(/.test(rule(selector)), `${selector}: без rgb()/rgba()`);
    }
  });
});

// ---------------------------------------------------------------------------
// Раскладка агрегатного ответа по локальным дням
// ---------------------------------------------------------------------------

/** UTC-инстанс локального момента наблюдателя (день считается клиентом). */
function localInstant(year: number, month: number, day: number, hour = 0, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

function emptyResult(): CalendarMarkersResult {
  return {
    record_spans: [],
    task_days: [],
    overdue_days: [],
    fact_days: [],
    reminder_instants: [],
  };
}

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

describe('groupCalendarMarkers: ответ сервера по локальным дням (0.16.1)', () => {
  it('пустой ответ — пустая раскладка', () => {
    assert.equal(groupCalendarMarkers(emptyResult(), OCTOBER).size, 0);
  });

  it('интервал записи отмечает ВСЕ локальные дни своего интервала', () => {
    const result = emptyResult();
    // Запись «с 4 по 6 октября»: границы — локальные полуночи, поэтому день
    // интервала не зависит от часового пояса машины.
    result.record_spans = [{ from: localInstant(2026, 10, 4), to: localInstant(2026, 10, 6) }];
    const byDay = groupCalendarMarkers(result, OCTOBER);
    assert.deepEqual([...byDay.keys()].sort(), ['2026-10-04', '2026-10-05', '2026-10-06']);
    for (const kinds of byDay.values()) assert.deepEqual(kinds, ['records']);
  });

  it('запись одного момента (`to: null`) отмечает свой день', () => {
    const result = emptyResult();
    result.record_spans = [{ from: localInstant(2026, 10, 9, 8, 30), to: null }];
    assert.deepEqual([...groupCalendarMarkers(result, OCTOBER).keys()], ['2026-10-09']);
  });

  it('вхождение напоминания — его ЛОКАЛЬНЫЙ день (инстанс считает клиент)', () => {
    const result = emptyResult();
    result.reminder_instants = [
      localInstant(2026, 10, 5, 23, 30),
      localInstant(2026, 10, 8, 0, 15),
    ];
    const byDay = groupCalendarMarkers(result, OCTOBER);
    assert.deepEqual([...byDay.keys()].sort(), ['2026-10-05', '2026-10-08']);
    for (const kinds of byDay.values()) assert.deepEqual(kinds, ['plans']);
  });

  it('задача и напоминание в одном дне — один маркер «планы»', () => {
    const result = emptyResult();
    result.task_days = ['2026-10-05'];
    result.reminder_instants = [localInstant(2026, 10, 5, 9)];
    const byDay = groupCalendarMarkers(result, OCTOBER);
    assert.deepEqual([...byDay.keys()], ['2026-10-05']);
    assert.deepEqual(byDay.get('2026-10-05'), ['plans'], 'дубликата вида нет');
  });

  it('все четыре вида на одном дне — фиксированный порядок CALENDAR_MARKER_ORDER', () => {
    const result = emptyResult();
    result.record_spans = [{ from: localInstant(2026, 10, 7, 9), to: null }];
    result.task_days = ['2026-10-07'];
    result.fact_days = ['2026-10-07'];
    result.overdue_days = ['2026-10-07'];
    assert.deepEqual(groupCalendarMarkers(result, OCTOBER).get('2026-10-07'), [
      'records',
      'plans',
      'facts',
      'overdue',
    ]);
  });

  it('дни вне показанного месяца отбрасываются (поисковое окно сервера шире)', () => {
    const result = emptyResult();
    result.task_days = ['2026-09-30', '2026-10-01', '2026-11-01'];
    result.fact_days = ['2026-09-15', '2026-10-31'];
    result.overdue_days = ['2026-10-02'];
    // Интервал записи шире месяца — обрезается его границами.
    result.record_spans = [{ from: localInstant(2026, 9, 28), to: localInstant(2026, 10, 2) }];
    const byDay = groupCalendarMarkers(result, OCTOBER);
    assert.deepEqual([...byDay.keys()].sort(), ['2026-10-01', '2026-10-02', '2026-10-31']);
    assert.deepEqual(byDay.get('2026-10-01'), ['records', 'plans']);
    assert.deepEqual(byDay.get('2026-10-02'), ['records', 'overdue']);
    assert.deepEqual(byDay.get('2026-10-31'), ['facts']);
  });

  it('неразборчивый инстанс напоминания не создаёт дня', () => {
    const result = emptyResult();
    result.reminder_instants = ['', 'не инстанс'];
    assert.equal(groupCalendarMarkers(result, OCTOBER).size, 0);
  });
});
