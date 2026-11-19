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
  UI_THEME_NAMES,
} from '@etn/shared';

import {
  calendarDayCounts,
  groupCalendarMarkers,
} from '../src/renderer/screens/chronicle/calendar-markers.js';
import { ShimElement } from './dom-shim.js';
import {
  declaredTokens,
  parseThemeColor,
  readTheme,
  THEME_MODES,
  themeBlockBody,
  type RgbColor,
} from './theme-css.js';

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
    // Записи — СВОЙ семантический токен, не акцент (требование ab9d627b:
    // «записи НЕ из --accent-семейства»; в retronotes dark латунный --accent
    // неразличим с оранжевым --warn).
    assert.match(rule('.cal-marker--records'), /background:\s*var\(--cal-marker-records\)/);
    assert.doesNotMatch(
      rule('.cal-marker--records'),
      /var\(--accent[a-z-]*\)/,
      'маркер записей не использует акцент',
    );
    assert.match(rule('.cal-marker--plans'), /background:\s*var\(--warn\)/);
    assert.match(rule('.cal-marker--facts'), /background:\s*var\(--ok\)/);
    // Просрочка — КОЛЬЦО: красный токен остаётся, но контуром (пункт 6
    // уточнения 2026-11-19): в тёмных темах оранжевый --warn и красный --danger
    // сближаются по цвету, и различимость держит ФОРМА маркера.
    assert.match(rule('.cal-marker--overdue'), /background:\s*transparent/);
    assert.match(rule('.cal-marker--overdue'), /border:\s*1px solid var\(--danger\)/);
    // Четыре разные формы одного размера: круг / квадрат / ромб / кольцо.
    assert.match(rule('.cal-marker--records'), /border-radius:\s*50%/);
    assert.match(rule('.cal-marker--plans'), /border-radius:\s*0/);
    assert.match(rule('.cal-marker--facts'), /clip-path:\s*polygon\(50% 0/);
    assert.match(rule('.cal-marker'), /width:\s*4px/);
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
// Токен маркера записей в темах
// ---------------------------------------------------------------------------

/** Тон цвета в градусах (0–360). */
function hueOf(color: RgbColor): number {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

/** Расстояние в sRGB — грубая, но строгая мера «это не тот же цвет». */
function rgbDistance(a: RgbColor, b: RgbColor): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/** Цвет токена темы; отсутствие или неразборчивое значение — падение теста. */
function themeColor(tokens: Map<string, string>, token: string, where: string): RgbColor {
  const value = tokens.get(token);
  assert.ok(value !== undefined, `${where}: токен ${token} объявлен`);
  const color = parseThemeColor(value!);
  assert.ok(color !== null, `${where}: ${token} = ${value} — цвет`);
  return color!;
}

describe('маркер записей — семантический токен темы (0.16.1, ab9d627b)', () => {
  it('все темы и режимы: свой токен, синий тон, отличимость от статусных маркеров', () => {
    for (const name of UI_THEME_NAMES) {
      const css = readTheme(name);
      for (const mode of THEME_MODES) {
        const where = `${name}/${mode}`;
        const body = themeBlockBody(css, name, mode);
        assert.ok(body !== null, `${where}: блок режима объявлен`);
        const tokens = declaredTokens(body!);

        const recordsValue = tokens.get('--cal-marker-records');
        const records = themeColor(tokens, '--cal-marker-records', where);
        // Синий тон — семантика записей (требование ab9d627b). В темах с
        // латунным/янтарным акцентом иначе маркер записей сливается с
        // оранжевым маркером задач (--warn): дефект приёмки retronotes dark.
        const hue = hueOf(records);
        assert.ok(
          hue >= 180 && hue <= 250,
          `${where}: маркер записей синий, тон ${hue.toFixed(1)}°`,
        );
        // Отдельный токен, а не акцент: значение не повторяет ни один --accent*
        // той же темы (в т.ч. --accent и --accent-fg).
        for (const [token, value] of tokens) {
          if (!token.startsWith('--accent')) continue;
          assert.notEqual(
            value,
            recordsValue,
            `${where}: значение ${token} не равно маркеру записей`,
          );
        }
        // Статусные маркеры остаются на своих токенах, но клетка может нести
        // несколько маркеров сразу — цвета обязаны различаться.
        for (const status of ['--warn', '--ok', '--danger'] as const) {
          const color = themeColor(tokens, status, where);
          const distance = rgbDistance(records, color);
          assert.ok(
            distance >= 60,
            `${where}: маркер записей отличим от ${status} (расстояние ${distance.toFixed(1)})`,
          );
        }
      }
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
    task_day_counts: {},
    overdue_days: [],
    overdue_day_counts: {},
    fact_days: [],
    fact_day_counts: {},
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

// ---------------------------------------------------------------------------
// Счётчики дня для попапа (пункт 7 уточнения 2026-11-19)
// ---------------------------------------------------------------------------

describe('calendarDayCounts: количества дня для попапа (пункт 7 уточнения 2026-11-19)', () => {
  it('задачи/факты/просрочка — из серверного агрегата; записи и напоминания считает клиент', () => {
    const result = emptyResult();
    result.record_spans = [
      { from: localInstant(2026, 10, 5), to: localInstant(2026, 10, 6) },
      { from: localInstant(2026, 10, 5, 9), to: null },
    ];
    result.reminder_instants = [localInstant(2026, 10, 5, 8), localInstant(2026, 10, 5, 20)];
    result.task_day_counts = { '2026-10-05': 3 };
    result.fact_day_counts = { '2026-10-05': 2 };
    result.overdue_day_counts = { '2026-10-05': 1 };
    assert.deepEqual(calendarDayCounts(result, '2026-10-05'), {
      records: 2,
      tasks: 3,
      reminders: 2,
      facts: 2,
      overdue: 1,
    });
  });

  it('день без данных и пустой ключ — нули по всем видам', () => {
    const zero = { records: 0, tasks: 0, reminders: 0, facts: 0, overdue: 0 };
    assert.deepEqual(calendarDayCounts(emptyResult(), '2026-10-07'), zero);
    assert.deepEqual(calendarDayCounts(emptyResult(), ''), zero);
  });

  it('запись учитывается, только если её интервал покрывает запрошенный день', () => {
    const result = emptyResult();
    result.record_spans = [{ from: localInstant(2026, 10, 4), to: localInstant(2026, 10, 6) }];
    assert.equal(calendarDayCounts(result, '2026-10-04').records, 1);
    assert.equal(calendarDayCounts(result, '2026-10-05').records, 1);
    assert.equal(calendarDayCounts(result, '2026-10-07').records, 0);
  });

  it('напоминание считается по ЛОКАЛЬНОМУ дню инстанса', () => {
    const result = emptyResult();
    result.reminder_instants = [localInstant(2026, 10, 5, 23, 30)];
    assert.equal(calendarDayCounts(result, '2026-10-05').reminders, 1);
    assert.equal(calendarDayCounts(result, '2026-10-06').reminders, 0);
  });
});
