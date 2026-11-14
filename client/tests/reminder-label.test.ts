/**
 * Подписи напоминаний (0.16.1, задача 173f1540, вердикт приёмки п.6).
 *
 * Один словарь на все поверхности: флаг шапки (`remindersFlagText`), строка
 * меню/панели (`reminderLabel`), Ctrl-подсказка облачка (`reminderPreviewLines`)
 * и грамматика повтора (`scheduleLabel`). Тесты фиксируют ФОРМУЛИРОВКИ, чтобы
 * правка одного места не разъехалась с остальными, и отбор непустых строк
 * (неактуальные напоминания в подписи не участвуют).
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { Reminder, ReminderSchedule } from '@etn/shared';

import { formatDateTime, setLang } from '../src/renderer/lib/i18n.js';
import {
  reminderLabel,
  reminderPreviewLines,
  remindersFlagText,
  scheduleLabel,
} from '../src/renderer/lib/reminder-label.js';

/** Карточка напоминания с заданным расписанием. */
function reminder(overrides: Partial<Reminder> = {}): Reminder {
  const anchor = '2026-03-08T06:00:00.000Z';
  return {
    id: 'r1',
    user_id: 'u1',
    subject_type: 'thought',
    subject_id: 't1',
    subject_state: 'active',
    kind: 'rule',
    schedule: { type: 'yearly', month: 3, day: 8 },
    anchor_at: anchor,
    next_at: anchor,
    exceptions: {},
    state: 'active',
    created_at: anchor,
    updated_at: anchor,
    ...overrides,
  } as unknown as Reminder;
}

before(() => {
  setLang('ru');
});

describe('scheduleLabel — грамматика повтора по-русски', () => {
  const cases: Array<[ReminderSchedule, string]> = [
    [{ type: 'once' }, 'однократно'],
    [{ type: 'weekdays', days: [1, 3, 5] }, 'по пн, ср, пт'],
    [{ type: 'every_days', every: 1 }, 'каждый день'],
    [{ type: 'every_days', every: 3 }, 'каждые 3 дн.'],
    [{ type: 'weekday_of_month', weekday: 4, nth: 2 }, 'четверг — 2-е вхождение в месяце'],
    [
      { type: 'weekday_of_month', weekday: 4, nth: 'last' },
      'четверг — последнее вхождение в месяце',
    ],
    [{ type: 'day_of_month', day: 18, every_months: 1 }, 'каждое 18-е'],
    [{ type: 'day_of_month', day: 18, every_months: 2 }, '18-е число каждые 2 мес.'],
    [{ type: 'yearly', month: 3, day: 8 }, 'ежегодно 8 марта'],
    [{ type: 'last_day_of_month', every_months: 1 }, 'последний день месяца'],
    [{ type: 'last_day_of_month', every_months: 3 }, 'последний день месяца каждые 3 мес.'],
  ];

  for (const [schedule, expected] of cases) {
    it(`${schedule.type} → «${expected}»`, () => {
      assert.equal(scheduleLabel(schedule), expected);
    });
  }
});

describe('reminderLabel — подпись напоминания целиком', () => {
  it('однократное — момент показа', () => {
    const at = '2026-11-14T21:30:00.000Z';
    const entry = reminder({ kind: 'one', schedule: { type: 'once' }, anchor_at: at });
    assert.equal(
      reminderLabel(entry),
      `однократно ${formatDateTime(at, { dateStyle: 'short', timeStyle: 'short' })}`,
    );
  });

  it('повторяющееся — подпись грамматики', () => {
    assert.equal(reminderLabel(reminder()), 'ежегодно 8 марта');
  });
});

describe('remindersFlagText — текст флага шапки', () => {
  it('пусто → пустая строка (поверхность показывает команду создания)', () => {
    assert.equal(remindersFlagText([]), '');
  });

  it('несколько активных — через «·»', () => {
    const entries = [
      reminder({ id: 'r1' }),
      reminder({ id: 'r2', schedule: { type: 'day_of_month', day: 18, every_months: 1 } }),
    ];
    assert.equal(remindersFlagText(entries), 'ежегодно 8 марта · каждое 18-е');
  });

  it('неактуальные напоминания в подпись не попадают', () => {
    const entries = [reminder({ id: 'r1' }), reminder({ id: 'r2', state: 'removed' })];
    assert.equal(remindersFlagText(entries), 'ежегодно 8 марта');
  });
});

describe('reminderPreviewLines — строки Ctrl-подсказки облачка', () => {
  it('подпись повтора и ближайшее вхождение', () => {
    const next = '2026-03-08T06:00:00.000Z';
    const lines = reminderPreviewLines([reminder({ next_at: next })]);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.startsWith('ежегодно 8 марта'), 'строка начинается с повтора');
    assert.ok(
      lines[0]!.includes(formatDateTime(next, { dateStyle: 'short', timeStyle: 'short' })),
      'в строке есть ближайший показ',
    );
  });

  it('вхождений больше нет — только повтор', () => {
    assert.deepEqual(reminderPreviewLines([reminder({ next_at: null })]), ['ежегодно 8 марта']);
  });

  it('неактуальные напоминания в подсказку не попадают', () => {
    assert.deepEqual(reminderPreviewLines([reminder({ state: 'removed' })]), []);
  });
});
