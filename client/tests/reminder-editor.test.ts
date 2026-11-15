/**
 * Редактор напоминания (0.16.1, задача 173f1540; элемент 58cca4f7; концепция
 * переработана по ТЗ пользователя 2026-11-15, ошибка 3ff85ede): чистые части
 * без диалога — команды «Напомнить», грамматика из черновика, черновик из
 * карточки, дефолты и опорная дата из свойства субъекта.
 *
 * Preview проверяется ТЕМ ЖЕ вычислителем, что сервер (`expandOccurrences` из
 * `@etn/shared`): для каждой команды из черновика обязано найтись вхождение на
 * год вперёд — иначе редактор показал бы «Вхождений пока нет».
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  expandOccurrences,
  kindOfSchedule,
  normalizeAnchor,
  type Reminder,
  type ReminderSchedule,
} from '@etn/shared';

import {
  PREVIEW_LIMIT,
  REMINDER_COMMANDS,
  REMINDER_DAY_LIMIT,
  reminderEditorInternals,
} from '../src/renderer/lib/reminder-editor.js';
import { store } from '../src/renderer/state.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MS_PER_DAY = 86_400_000;

/** Простой `window.etn` c одним методом свойств. */
function stubEtn(propertiesGet: () => Promise<unknown>): void {
  (globalThis as any).window = {
    etn: { properties: { get: propertiesGet } },
  };
}

/** Карточка напоминания с расписанием (минимум полей для `draftOf`). */
function reminderWith(schedule: ReminderSchedule, anchorAt: string): Reminder {
  return {
    id: 'r1',
    subject_type: 'thought',
    subject_id: 't1',
    kind: kindOfSchedule(schedule),
    schedule,
    anchor_at: anchorAt,
    next_at: null,
    exceptions: {},
    state: 'active',
    created_at: anchorAt,
    updated_at: anchorAt,
  } as unknown as Reminder;
}

afterEach(() => {
  store.update({ networkId: null });
  delete (globalThis as any).window;
});

describe('редактор напоминания: команды «Напомнить» (ТЗ 2026-11-15)', () => {
  it('список команд — ровно шесть видов повтора в порядке ТЗ', () => {
    assert.deepEqual(
      [...REMINDER_COMMANDS],
      ['once', 'every_days', 'weekdays', 'day_of_month', 'weekday_of_month', 'yearly'],
      '«не напоминать» — не вид повтора: её добавляет сам редактор и только для существующего',
    );
    assert.equal(PREVIEW_LIMIT, 5, 'подпись обещает «Следующие 5 напоминаний»');
    assert.equal(REMINDER_DAY_LIMIT, 30, 'число месяца по ТЗ — 1..30 плюс «последний день»');
  });

  it('команда «не напоминать» расписания не имеет', () => {
    assert.throws(
      () =>
        reminderEditorInternals.scheduleOf({
          ...reminderEditorInternals.emptyDraft(),
          command: 'not_remind',
        }),
      /not_remind/,
    );
  });

  it('каждая команда даёт пару kind ↔ schedule.type из закрытой таблицы', () => {
    const expected: Record<string, string> = {
      once: 'one',
      every_days: 'period',
      weekdays: 'rule',
      day_of_month: 'period',
      weekday_of_month: 'rule',
      yearly: 'rule',
    };
    for (const command of REMINDER_COMMANDS) {
      const draft = { ...reminderEditorInternals.emptyDraft(), command };
      const schedule = reminderEditorInternals.scheduleOf(draft);
      assert.equal(
        kindOfSchedule(schedule),
        expected[command],
        `команда ${command} обязана давать вид ${expected[command]}`,
      );
    }
  });

  it('команда «каждое число месяца» умеет «последний день месяца»', () => {
    const draft = { ...reminderEditorInternals.emptyDraft(), command: 'day_of_month' as const };
    assert.equal(reminderEditorInternals.scheduleOf(draft).type, 'day_of_month');
    assert.equal(
      reminderEditorInternals.scheduleOf({ ...draft, dayLast: true }).type,
      'last_day_of_month',
    );
  });

  it('preview находит вхождения для КАЖДОЙ команды', () => {
    const now = Date.now();
    for (const command of REMINDER_COMMANDS) {
      const draft = { ...reminderEditorInternals.emptyDraft(), command };
      const schedule = reminderEditorInternals.scheduleOf(draft);
      const anchor = reminderEditorInternals.localInstant(draft.date, draft.time);
      const normalized = normalizeAnchor(schedule, anchor);
      const from = Math.min(now, normalized);
      const occurrences = expandOccurrences(
        schedule,
        normalized,
        from,
        from + 366 * MS_PER_DAY,
        new Map(),
      );
      assert.ok(occurrences.length > 0, `preview пуст для команды ${command}`);
    }
  });

  it('дефолты по ТЗ: сегодня, n = 1, текущий день недели, выходные не пропускаем, 09:00', () => {
    const draft = reminderEditorInternals.emptyDraft();
    assert.equal(draft.command, 'once', 'новая форма открывается на «однократно»');
    assert.equal(draft.interval, 1);
    assert.equal(draft.skipWeekends, false);
    assert.equal(draft.time, '09:00');
    assert.deepEqual(draft.days, [reminderEditorInternals.isoWeekdayOf(draft.date)]);
    assert.equal(draft.weekday, reminderEditorInternals.isoWeekdayOf(draft.date));
    assert.ok(draft.day >= 1 && draft.day <= REMINDER_DAY_LIMIT);
  });

  it('правка существующего расписания даёт тот же план (черновик ↔ карточка)', () => {
    // Опорный момент — РЕАЛЬНОЕ вхождение своего расписания (сервер хранит
    // нормализованный `anchor_at`), полдень местного времени.
    const at = (month: number, day: number): string =>
      new Date(2026, month - 1, day, 12, 0, 0, 0).toISOString();
    const cases: Array<[ReminderSchedule, string]> = [
      [{ type: 'once' }, at(5, 18)],
      [{ type: 'weekdays', days: [1, 3, 5], every_weeks: 1 }, at(5, 18)],
      [{ type: 'weekdays', days: [2], every_weeks: 3 }, at(5, 19)],
      [{ type: 'every_days', every: 3, skip_weekends: false }, at(5, 18)],
      [{ type: 'every_days', every: 1, skip_weekends: true }, at(5, 18)],
      [{ type: 'weekday_of_month', weekday: 4, nth: 2, every_months: 1 }, at(5, 14)],
      [{ type: 'weekday_of_month', weekday: 4, nth: 'last', every_months: 2 }, at(5, 28)],
      [{ type: 'day_of_month', day: 18, every_months: 1 }, at(5, 18)],
      [{ type: 'day_of_month', day: 30, every_months: 3 }, at(5, 30)],
      [{ type: 'yearly', month: 3, day: 8, every_years: 1 }, at(3, 8)],
      [{ type: 'yearly', month: 2, day: 29, every_years: 4 }, at(2, 28)],
      [{ type: 'last_day_of_month', every_months: 2 }, at(5, 31)],
    ];
    for (const [schedule, anchor] of cases) {
      const draft = reminderEditorInternals.draftOf(reminderWith(schedule, anchor));
      assert.deepEqual(
        reminderEditorInternals.scheduleOf(draft),
        schedule,
        `расписание ${schedule.type} изменилось при открытии редактора`,
      );
    }
  });

  it('интервалы и «пропускать выходные» попадают в расписание из формы', () => {
    const base = reminderEditorInternals.emptyDraft();
    assert.deepEqual(
      reminderEditorInternals.scheduleOf({
        ...base,
        command: 'weekdays',
        interval: 2,
        days: [5, 1],
      }),
      { type: 'weekdays', days: [1, 5], every_weeks: 2 },
    );
    assert.deepEqual(
      reminderEditorInternals.scheduleOf({ ...base, command: 'every_days', skipWeekends: true }),
      { type: 'every_days', every: 1, skip_weekends: true },
    );
    assert.deepEqual(
      reminderEditorInternals.scheduleOf({ ...base, command: 'yearly', interval: 5 }),
      { type: 'yearly', month: base.month, day: base.day, every_years: 5 },
    );
    assert.deepEqual(
      reminderEditorInternals.scheduleOf({ ...base, command: 'weekday_of_month', interval: 2 }),
      {
        type: 'weekday_of_month',
        weekday: base.weekday,
        nth: base.nth,
        every_months: 2,
      },
    );
  });

  it('опорное время наследуется локальными часами (UTC-инстанс)', () => {
    const ms = reminderEditorInternals.localInstant('2026-11-14', '09:45');
    const date = new Date(ms);
    assert.equal(date.getFullYear(), 2026);
    assert.equal(date.getMonth(), 10);
    assert.equal(date.getDate(), 14);
    assert.equal(date.getHours(), 9);
    assert.equal(date.getMinutes(), 45);
  });
});

describe('редактор напоминания: опорная дата из свойства субъекта', () => {
  beforeEach(() => {
    store.update({ networkId: 'n1' });
  });

  it('берётся первое датовое свойство мысли', async () => {
    stubEtn(async () => [
      { value_type: 'string', value: 'не дата' },
      { value_type: 'date', value: '2026-03-08' },
    ]);
    const date = await reminderEditorInternals.defaultDateFromSubject({
      subjectType: 'thought',
      subjectId: 't1',
    });
    assert.equal(date, '2026-03-08');
  });

  it('свойств нет или запрос упал — дефолта нет (остаётся «сегодня»)', async () => {
    stubEtn(async () => []);
    assert.equal(
      await reminderEditorInternals.defaultDateFromSubject({
        subjectType: 'thought',
        subjectId: 't1',
      }),
      null,
    );
    stubEtn(async () => {
      throw new Error('нет прав');
    });
    assert.equal(
      await reminderEditorInternals.defaultDateFromSubject({
        subjectType: 'thought',
        subjectId: 't1',
      }),
      null,
    );
  });

  it('публикация датовых свойств не несёт — дефолта нет', async () => {
    let called = false;
    stubEtn(async () => {
      called = true;
      return [];
    });
    const date = await reminderEditorInternals.defaultDateFromSubject({
      subjectType: 'publication',
      subjectId: '22222222-2222-4222-8222-222222222222',
    });
    assert.equal(date, null);
    assert.equal(called, false, 'для публикации свойства не читаются');
  });
});
