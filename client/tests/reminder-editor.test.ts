/**
 * Редактор напоминания (0.16.1, задача 173f1540; элемент 58cca4f7): чистые
 * части без диалога — грамматика из черновика, черновик из карточки,
 * автодефолты повторяемых параметров и опорная дата из свойства субъекта.
 *
 * Preview проверяется ТЕМ ЖЕ вычислителем, что сервер (`expandOccurrences` из
 * `@etn/shared`): для каждого типа повтора из черновика обязано найтись
 * вхождение на год вперёд — иначе редактор показал бы «Вхождений пока нет».
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  expandOccurrences,
  kindOfSchedule,
  normalizeAnchor,
  type Reminder,
  type ReminderKind,
  type ReminderSchedule,
} from '@etn/shared';

import { reminderEditorInternals } from '../src/renderer/lib/reminder-editor.js';
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

describe('редактор напоминания: грамматика из черновика', () => {
  it('каждый тип повтора относится к своему крупному виду (kind ↔ schedule.type)', () => {
    for (const kind of Object.keys(reminderEditorInternals.typesByKind) as ReminderKind[]) {
      for (const type of reminderEditorInternals.typesByKind[kind]) {
        const draft = { ...reminderEditorInternals.emptyDraft(kind), type };
        assert.equal(
          kindOfSchedule(reminderEditorInternals.scheduleOf(draft)),
          kind,
          `${type} обязан относиться к виду ${kind}`,
        );
      }
    }
  });

  it('preview находит вхождения для КАЖДОГО типа повтора', () => {
    const now = Date.now();
    for (const kind of Object.keys(reminderEditorInternals.typesByKind) as ReminderKind[]) {
      for (const type of reminderEditorInternals.typesByKind[kind]) {
        const draft = { ...reminderEditorInternals.emptyDraft(kind), type };
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
        assert.ok(occurrences.length > 0, `preview пуст для типа ${type}`);
      }
    }
  });

  it('правка существующего расписания даёт тот же план (черновик ↔ карточка)', () => {
    // Опорный момент — РЕАЛЬНОЕ вхождение своего расписания (сервер хранит
    // нормализованный `anchor_at`), полдень местного времени.
    const at = (month: number, day: number): string =>
      new Date(2026, month - 1, day, 12, 0, 0, 0).toISOString();
    const cases: Array<[ReminderSchedule, string]> = [
      [{ type: 'once' }, at(5, 18)],
      [{ type: 'weekdays', days: [1, 3, 5] }, at(5, 18)],
      [{ type: 'every_days', every: 3 }, at(5, 18)],
      [{ type: 'weekday_of_month', weekday: 4, nth: 2 }, at(5, 14)],
      [{ type: 'day_of_month', day: 18, every_months: 1 }, at(5, 18)],
      [{ type: 'yearly', month: 3, day: 8 }, at(3, 8)],
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
