/**
 * Движок повторов напоминаний (0.16.1, задача b47f1fd2; требование bbca8f7d,
 * раскрытие на период 4401beb8, управление вхождением 86cb7451; расширение
 * грамматики — редактор по ТЗ 2026-11-15).
 *
 * Чистые функции `domain/reminder-repeat.ts`: закрытая грамматика повтора,
 * соответствие `kind` ↔ `schedule.type`, нормализация `anchor_at`, края серии
 * (29/30/31 в коротком месяце, 29.02, отсутствующий N-й день недели), интервалы
 * (`every_weeks`/`every_months`/`every_years`), пропуск выходных, раскрытие на
 * период и ленивый `next_at`. Время суток всех вхождений наследуется от
 * anchor — поэтому каждый кейс проверяет и дату, и момент.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EtnError, type ReminderSchedule } from '@etn/shared';

import {
  assertScheduleKind,
  computeNextAt,
  expandOccurrences,
  firstOccurrenceOnOrAfter,
  kindOfSchedule,
  normalizeAnchor,
  parseInstant,
  validateSchedule,
} from '../src/domain/reminder-repeat.js';

/** UTC-момент из ISO-строки. */
const at = (iso: string): number => Date.parse(iso);

/** ISO-строка из UTC-момента. */
const iso = (ms: number): string => new Date(ms).toISOString();

/** Ожидать ошибку грамматики: `VALIDATION_ERROR` с HTTP 400 в `details.status`. */
function expectGrammarError(fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof EtnError, 'ожидалась EtnError');
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal((err.details as { status?: number } | undefined)?.status, 400);
    return true;
  });
}

describe('reminder-repeat: закрытая грамматика (bbca8f7d)', () => {
  it('принимает каждый вид серии и канонизирует выбранные дни недели', () => {
    assert.deepEqual(validateSchedule({ type: 'once' }), { type: 'once' });
    assert.deepEqual(validateSchedule({ type: 'weekdays', days: [5, 1, 5] }), {
      type: 'weekdays',
      days: [1, 5],
      every_weeks: 1,
    });
    assert.deepEqual(validateSchedule({ type: 'every_days', every: 2 }), {
      type: 'every_days',
      every: 2,
      skip_weekends: false,
    });
    assert.deepEqual(validateSchedule({ type: 'weekday_of_month', weekday: 4, nth: 'last' }), {
      type: 'weekday_of_month',
      weekday: 4,
      nth: 'last',
      every_months: 1,
    });
    assert.deepEqual(validateSchedule({ type: 'day_of_month', day: 31, every_months: 1 }), {
      type: 'day_of_month',
      day: 31,
      every_months: 1,
    });
    assert.deepEqual(validateSchedule({ type: 'yearly', month: 2, day: 29 }), {
      type: 'yearly',
      month: 2,
      day: 29,
      every_years: 1,
    });
    assert.deepEqual(validateSchedule({ type: 'last_day_of_month', every_months: 3 }), {
      type: 'last_day_of_month',
      every_months: 3,
    });
  });

  it('интервалы и пропуск выходных канонизируются, отсутствие полей — 1/false', () => {
    assert.deepEqual(validateSchedule({ type: 'weekdays', days: [1], every_weeks: 3 }), {
      type: 'weekdays',
      days: [1],
      every_weeks: 3,
    });
    assert.deepEqual(validateSchedule({ type: 'every_days', every: 1, skip_weekends: true }), {
      type: 'every_days',
      every: 1,
      skip_weekends: true,
    });
    assert.deepEqual(
      validateSchedule({ type: 'weekday_of_month', weekday: 2, nth: 1, every_months: 2 }),
      { type: 'weekday_of_month', weekday: 2, nth: 1, every_months: 2 },
    );
    assert.deepEqual(validateSchedule({ type: 'yearly', month: 3, day: 8, every_years: 4 }), {
      type: 'yearly',
      month: 3,
      day: 8,
      every_years: 4,
    });
  });

  it('отвергает неизвестный тип, лишний ключ и значения вне диапазона — 400', () => {
    expectGrammarError(() => validateSchedule({ type: 'hourly' }));
    expectGrammarError(() => validateSchedule({ type: 'once', days: [1] }));
    expectGrammarError(() => validateSchedule({ type: 'weekdays', days: [] }));
    expectGrammarError(() => validateSchedule({ type: 'weekdays', days: [0] }));
    expectGrammarError(() => validateSchedule({ type: 'weekdays', days: [8] }));
    expectGrammarError(() => validateSchedule({ type: 'weekdays', days: [1], every_weeks: 0 }));
    expectGrammarError(() => validateSchedule({ type: 'weekdays', days: [1], every_weeks: 521 }));
    expectGrammarError(() => validateSchedule({ type: 'every_days', every: 0 }));
    expectGrammarError(() => validateSchedule({ type: 'every_days', every: 3651 }));
    expectGrammarError(() =>
      validateSchedule({ type: 'every_days', every: 1, skip_weekends: 'да' }),
    );
    expectGrammarError(() => validateSchedule({ type: 'weekday_of_month', weekday: 1, nth: 6 }));
    expectGrammarError(() =>
      validateSchedule({ type: 'weekday_of_month', weekday: 1, nth: 1, every_months: 0 }),
    );
    expectGrammarError(() => validateSchedule({ type: 'day_of_month', day: 32, every_months: 1 }));
    expectGrammarError(() => validateSchedule({ type: 'yearly', month: 13, day: 1 }));
    // Даты, которой в месяце не бывает даже в високосный год, грамматика не знает.
    expectGrammarError(() => validateSchedule({ type: 'yearly', month: 4, day: 31 }));
    expectGrammarError(() => validateSchedule({ type: 'yearly', month: 2, day: 30 }));
    expectGrammarError(() => validateSchedule('once'));
    expectGrammarError(() => validateSchedule([{ type: 'once' }]));
  });

  it('kind выводится из schedule.type и обязан с ним совпадать', () => {
    assert.equal(kindOfSchedule({ type: 'once' }), 'one');
    assert.equal(kindOfSchedule({ type: 'every_days', every: 1 }), 'period');
    assert.equal(kindOfSchedule({ type: 'day_of_month', day: 1, every_months: 1 }), 'period');
    assert.equal(kindOfSchedule({ type: 'last_day_of_month', every_months: 1 }), 'period');
    assert.equal(kindOfSchedule({ type: 'weekdays', days: [1] }), 'rule');
    assert.equal(kindOfSchedule({ type: 'weekday_of_month', weekday: 1, nth: 1 }), 'rule');
    assert.equal(kindOfSchedule({ type: 'yearly', month: 1, day: 1 }), 'rule');

    assertScheduleKind('one', { type: 'once' });
    assertScheduleKind('period', { type: 'every_days', every: 2 });
    assertScheduleKind('rule', { type: 'weekdays', days: [1, 3] });
    expectGrammarError(() => assertScheduleKind('period', { type: 'once' }));
    expectGrammarError(() => assertScheduleKind('one', { type: 'every_days', every: 1 }));
    expectGrammarError(() => assertScheduleKind('period', { type: 'weekdays', days: [1] }));
  });

  it('parseInstant отвергает не-инстанс, не подменяя момент локальной зоной', () => {
    assert.equal(parseInstant('2025-01-01T09:00:00.000Z'), at('2025-01-01T09:00:00.000Z'));
    assert.equal(
      parseInstant('2025-01-01T09:00:00.000Z'),
      parseInstant('2025-01-01T12:00:00.000+03:00'),
      'одинаковый момент в разных записях — одно число',
    );
    expectGrammarError(() => parseInstant('завтра в девять'));
    expectGrammarError(() => parseInstant('2025-13-45T00:00:00.000Z'));
  });
});

describe('reminder-repeat: нормализация anchor и края серии', () => {
  it('weekdays: опорный момент сдвигается к первому выбранному дню', () => {
    // 2025-01-01 — среда; первый понедельник не раньше неё — 6 января.
    const anchor = normalizeAnchor({ type: 'weekdays', days: [1] }, at('2025-01-01T09:00:00.000Z'));
    assert.equal(iso(anchor), '2025-01-06T09:00:00.000Z');
  });

  it('every_days: серия идёт шагом от anchor, а не от запрошенного момента', () => {
    const anchor = at('2025-01-01T09:00:00.000Z');
    const occurrence = firstOccurrenceOnOrAfter(
      { type: 'every_days', every: 3 },
      anchor,
      at('2025-01-05T00:00:00.000Z'),
    );
    assert.equal(iso(occurrence!), '2025-01-07T09:00:00.000Z');
  });

  it('числа нет в месяце — месяц пропускается (ТЗ 2026-11-15)', () => {
    const schedule = { type: 'day_of_month', day: 31, every_months: 1 } as const;
    // Февраль 31-го не имеет — первое вхождение сразу 31 марта.
    const anchor = normalizeAnchor(schedule, at('2025-02-10T09:00:00.000Z'));
    assert.equal(iso(anchor), '2025-03-31T09:00:00.000Z');
    assert.equal(
      iso(firstOccurrenceOnOrAfter(schedule, anchor, at('2025-04-01T00:00:00.000Z'))!),
      '2025-05-31T09:00:00.000Z',
      'апрель тоже пропущен — в нём 30 дней',
    );
  });

  it('29.02 в невисокосный год — год пропускается (ТЗ 2026-11-15)', () => {
    const schedule = { type: 'yearly', month: 2, day: 29 } as const;
    const anchor = normalizeAnchor(schedule, at('2025-02-10T09:00:00.000Z'));
    assert.equal(iso(anchor), '2028-02-29T09:00:00.000Z', '2025–2027 не високосные');
    assert.equal(
      iso(firstOccurrenceOnOrAfter(schedule, anchor, at('2028-03-01T00:00:00.000Z'))!),
      '2032-02-29T09:00:00.000Z',
    );
  });

  it('отсутствующий N-й день недели месяца пропускается, серия продолжается', () => {
    // Пятого четверга в феврале 2025 нет — первое вхождение в мае 2025.
    const anchor = normalizeAnchor(
      { type: 'weekday_of_month', weekday: 4, nth: 5 },
      at('2025-02-01T09:00:00.000Z'),
    );
    assert.equal(iso(anchor), '2025-05-29T09:00:00.000Z');
  });

  it('last_day_of_month идёт последним днём каждого N-го месяца', () => {
    const schedule = { type: 'last_day_of_month', every_months: 1 } as const;
    const anchor = normalizeAnchor(schedule, at('2025-01-15T09:00:00.000Z'));
    assert.equal(iso(anchor), '2025-01-31T09:00:00.000Z');
    assert.equal(
      iso(firstOccurrenceOnOrAfter(schedule, anchor, at('2025-02-01T00:00:00.000Z'))!),
      '2025-02-28T09:00:00.000Z',
    );
  });

  it('once: вхождение одно, после своего момента новых нет', () => {
    const schedule = { type: 'once' } as const;
    const anchor = normalizeAnchor(schedule, at('2025-01-01T09:00:00.000Z'));
    assert.equal(iso(anchor), '2025-01-01T09:00:00.000Z');
    assert.equal(firstOccurrenceOnOrAfter(schedule, anchor, anchor), anchor);
    assert.equal(firstOccurrenceOnOrAfter(schedule, anchor, anchor + 1), null);
  });
});

describe('reminder-repeat: интервалы и пропуск выходных (ТЗ 2026-11-15)', () => {
  it('every_weeks: недели идут шагом от недели опорного вхождения', () => {
    const schedule: ReminderSchedule = { type: 'weekdays', days: [1], every_weeks: 2 };
    const anchor = normalizeAnchor(schedule, at('2025-01-06T09:00:00.000Z')); // понедельник
    assert.equal(iso(anchor), '2025-01-06T09:00:00.000Z');
    assert.equal(
      iso(firstOccurrenceOnOrAfter(schedule, anchor, at('2025-01-07T00:00:00.000Z'))!),
      '2025-01-20T09:00:00.000Z',
      'неделя 13 января пропущена',
    );
  });

  it('every_weeks: вторая неделя берётся от недели опоры, а не от первого дня недели', () => {
    // Опора — среда 8 января; выбранные дни пн и ср; каждая 2-я неделя.
    const schedule: ReminderSchedule = { type: 'weekdays', days: [3, 1], every_weeks: 2 };
    const anchor = normalizeAnchor(schedule, at('2025-01-08T09:00:00.000Z'));
    assert.equal(iso(anchor), '2025-01-08T09:00:00.000Z');
    assert.equal(
      iso(firstOccurrenceOnOrAfter(schedule, anchor, at('2025-01-09T00:00:00.000Z'))!),
      '2025-01-20T09:00:00.000Z',
      'понедельник следующей разрешённой недели',
    );
  });

  it('every_months у N-го дня недели месяца: промежуточные месяцы пропускаются', () => {
    const schedule = { type: 'weekday_of_month', weekday: 4, nth: 2, every_months: 2 } as const;
    const anchor = normalizeAnchor(schedule, at('2025-01-01T09:00:00.000Z'));
    assert.equal(iso(anchor), '2025-01-09T09:00:00.000Z', '2-й четверг января');
    assert.equal(
      iso(firstOccurrenceOnOrAfter(schedule, anchor, at('2025-01-10T00:00:00.000Z'))!),
      '2025-03-13T09:00:00.000Z',
      'февраль пропущен — шаг 2 месяца',
    );
  });

  it('every_years: годы идут шагом от года опорного вхождения', () => {
    const schedule = { type: 'yearly', month: 3, day: 8, every_years: 2 } as const;
    const anchor = normalizeAnchor(schedule, at('2026-03-08T09:00:00.000Z'));
    assert.equal(iso(anchor), '2026-03-08T09:00:00.000Z');
    assert.equal(
      iso(firstOccurrenceOnOrAfter(schedule, anchor, at('2026-03-09T00:00:00.000Z'))!),
      '2028-03-08T09:00:00.000Z',
    );
  });

  it('skip_weekends: суббота и воскресенье не дают вхождений, понедельник даёт', () => {
    const schedule = { type: 'every_days', every: 1, skip_weekends: true } as const;
    const anchor = at('2025-01-03T09:00:00.000Z'); // пятница
    const occurrences = expandOccurrences(
      schedule,
      anchor,
      at('2025-01-03T09:00:00.000Z'),
      at('2025-01-08T00:00:00.000Z'),
      new Map(),
    );
    assert.deepEqual(
      occurrences.map((item) => item.occurrence_at),
      ['2025-01-03T09:00:00.000Z', '2025-01-06T09:00:00.000Z', '2025-01-07T09:00:00.000Z'],
    );
  });

  it('skip_weekends: опора в выходной переносится на понедельник, шаг серии сохраняется', () => {
    // Интервал, начинающийся в выходной: иначе шаг 7 дней не дал бы вхождений.
    const weekly = { type: 'every_days', every: 7, skip_weekends: true } as const;
    const anchor = normalizeAnchor(weekly, at('2025-01-04T09:00:00.000Z')); // суббота
    assert.equal(iso(anchor), '2025-01-06T09:00:00.000Z');
    assert.equal(
      iso(firstOccurrenceOnOrAfter(weekly, anchor, at('2025-01-07T00:00:00.000Z'))!),
      '2025-01-13T09:00:00.000Z',
    );
  });

  it('без skip_weekends выходные остаются вхождениями', () => {
    const schedule = { type: 'every_days', every: 1 } as const;
    const anchor = at('2025-01-03T09:00:00.000Z');
    assert.equal(
      iso(firstOccurrenceOnOrAfter(schedule, anchor, at('2025-01-04T00:00:00.000Z'))!),
      '2025-01-04T09:00:00.000Z',
    );
  });
});

describe('reminder-repeat: раскрытие периода и исключения (4401beb8, 86cb7451)', () => {
  const schedule: ReminderSchedule = { type: 'weekdays', days: [1, 4] };
  const anchor = at('2025-01-06T09:00:00.000Z'); // понедельник

  it('период раскрывается включительно по обоим краям', () => {
    const occurrences = expandOccurrences(
      schedule,
      anchor,
      at('2025-01-06T09:00:00.000Z'),
      at('2025-01-16T09:00:00.000Z'),
      new Map(),
    );
    assert.deepEqual(
      occurrences.map((o) => o.occurrence_at),
      [
        '2025-01-06T09:00:00.000Z',
        '2025-01-09T09:00:00.000Z',
        '2025-01-13T09:00:00.000Z',
        '2025-01-16T09:00:00.000Z',
      ],
    );
    assert.ok(occurrences.every((o) => o.status === 'active' && o.until === null));
  });

  it('dismiss скрывает вхождение, не трогая соседние', () => {
    const exceptions = new Map([[at('2025-01-09T09:00:00.000Z'), { kind: 'dismiss' as const }]]);
    const occurrences = expandOccurrences(
      schedule,
      anchor,
      at('2025-01-06T09:00:00.000Z'),
      at('2025-01-13T09:00:00.000Z'),
      exceptions,
    );
    assert.deepEqual(
      occurrences.map((o) => o.occurrence_at),
      ['2025-01-06T09:00:00.000Z', '2025-01-13T09:00:00.000Z'],
    );
  });

  it('snooze переносит показ: вхождение видно в периоде своего until', () => {
    const until = '2025-01-09T18:00:00.000Z';
    const exceptions = new Map([
      [at('2025-01-09T09:00:00.000Z'), { kind: 'snooze' as const, until }],
    ]);
    const occurrences = expandOccurrences(
      schedule,
      anchor,
      at('2025-01-09T00:00:00.000Z'),
      at('2025-01-09T23:59:59.000Z'),
      exceptions,
    );
    assert.deepEqual(occurrences, [
      {
        occurrence_at: '2025-01-09T09:00:00.000Z',
        status: 'snoozed',
        until,
      },
    ]);
  });

  it('сравнение строгое: вхождение ровно в until остаётся видимым в свой момент', () => {
    const moment = '2025-01-09T09:00:00.000Z';
    const exceptions = new Map([[at(moment), { kind: 'snooze' as const, until: moment }]]);
    const occurrences = expandOccurrences(schedule, anchor, at(moment), at(moment), exceptions);
    assert.deepEqual(occurrences, [{ occurrence_at: moment, status: 'active', until: null }]);
  });

  it('next_at — ближайший показ не раньше «сейчас» (ленивое продвижение)', () => {
    const daily = { type: 'every_days', every: 1 } as const;
    const first = at('2020-01-01T09:00:00.000Z');
    assert.equal(
      computeNextAt(daily, first, new Map(), at('2025-01-04T10:00:00.000Z')),
      '2025-01-05T09:00:00.000Z',
    );
    // Dismiss на ближайшее вхождение — показ уходит на следующее.
    const dismissed = new Map([[at('2025-01-05T09:00:00.000Z'), { kind: 'dismiss' as const }]]);
    assert.equal(
      computeNextAt(daily, first, dismissed, at('2025-01-04T10:00:00.000Z')),
      '2025-01-06T09:00:00.000Z',
    );
  });

  it('next_at отложенного вхождения — его until, а не момент вхождения', () => {
    const daily = { type: 'every_days', every: 1 } as const;
    const first = at('2020-01-01T09:00:00.000Z');
    const until = '2025-01-05T20:00:00.000Z';
    const exceptions = new Map([
      [at('2025-01-05T09:00:00.000Z'), { kind: 'snooze' as const, until }],
    ]);
    assert.equal(computeNextAt(daily, first, exceptions, at('2025-01-04T10:00:00.000Z')), until);
  });

  it('у once после своего момента вхождений нет — next_at отсутствует', () => {
    const once = { type: 'once' } as const;
    const moment = at('2025-01-01T09:00:00.000Z');
    assert.equal(computeNextAt(once, moment, new Map(), moment - 1), '2025-01-01T09:00:00.000Z');
    assert.equal(computeNextAt(once, moment, new Map(), moment + 1), null);
    // dismiss единственного вхождения завершает серию.
    const dismissed = new Map([[moment, { kind: 'dismiss' as const }]]);
    assert.equal(computeNextAt(once, moment, dismissed, moment - 1), null);
  });
});
