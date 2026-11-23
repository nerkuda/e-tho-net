/**
 * Классификатор «изменилась видимость субъекта напоминания» (ошибка 71cb791e).
 *
 * `listReminders` (`server/src/domain/reminder-service.ts`) фильтрует строки
 * владельца по видимости субъекта: корзина (`marked_for_deletion`),
 * неактуальность (`active` при выключенном `show_inactive`) и физическое
 * удаление убирают напоминание из выдачи. `reminders.changed` на это не
 * публикуется, поэтому потребители счётчиков опознают сигнал здесь — тест
 * фиксирует матрицу событий и границу с 39d78d2a (визуал и комментарии набор
 * строк не меняют, лишних пересчётов быть не должно).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent } from '@etn/shared';

import { isReminderSubjectVisibilityEvent } from '../src/renderer/lib/live/reminder-events.js';

const NET = '00000000-0000-4000-8000-0000000000aa';

/** Синтетическое событие с заданным типом и телом. */
function event(type: string, data: Record<string, unknown>): AnyRealtimeEvent {
  return {
    type,
    seq: 1,
    ts: new Date().toISOString(),
    actor: { user_id: 'u1', client_id: 'c1' },
    network_id: NET,
    audience: 'network',
    data,
    layer_id: '00000000-0000-0000-0000-000000000000',
  } as unknown as AnyRealtimeEvent;
}

describe('видимость субъекта напоминания (71cb791e)', () => {
  it('корзина, неактуальность и удаление мысли/публикации — сигнал напоминаний', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['thought.updated', { id: 't1', version: 2, changes: { marked_for_deletion: true } }],
      ['thought.updated', { id: 't1', version: 3, changes: { marked_for_deletion: false } }],
      ['thought.updated', { id: 't1', version: 4, changes: { active: false } }],
      ['publication.updated', { id: 'p1', version: 2, changes: { active: false } }],
      ['publication.updated', { id: 'p1', version: 3, changes: { active: true } }],
      ['publication.trashed', { id: 'p1' }],
      ['publication.restored', { id: 'p1' }],
      ['publication.purged', { id: 'p1' }],
      ['thought.deleted', { id: 't1' }],
    ];
    for (const [type, data] of cases) {
      assert.equal(
        isReminderSubjectVisibilityEvent(event(type, data)),
        true,
        `${type} ${JSON.stringify(data)} меняет видимость субъекта`,
      );
    }
  });

  it('«показывать неактуальные» — сигнал, прочие настройки — нет', () => {
    assert.equal(
      isReminderSubjectVisibilityEvent(
        event('user-preference.updated', { key: 'show_inactive', value: true }),
      ),
      true,
      'show_inactive решает, отдаёт ли сервер неактуальные строки',
    );
    assert.equal(
      isReminderSubjectVisibilityEvent(
        event('user-preference.updated', { key: 'show_trash', value: true }),
      ),
      false,
      'show_trash — корзина проекции задач, напоминания не трогает',
    );
    assert.equal(
      isReminderSubjectVisibilityEvent(
        event('user-preference.updated', { key: 'canvas_link_filter', value: {} }),
      ),
      false,
    );
  });

  it('визуал, комментарии и чужие события набор строк не меняют (граница 39d78d2a)', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['thought.updated', { id: 't1', version: 2, changes: { title: 'Имя', synonyms: ['x'] } }],
      ['thought.updated', { id: 't1', version: 3, changes: { icon: 'star' } }],
      ['publication.updated', { id: 'p1', version: 4, changes: { title: 'Публикация' } }],
      [
        'comment.updated',
        { id: 'c1', owner_id: 't1', owner_type: 'thought', changes: { body_md: 'x' }, version: 2 },
      ],
      ['link.deleted', { id: 'l1' }],
      ['layer.merged', { layer_id: 'l1' }],
      // `reminders.changed` потребители обрабатывают отдельным условием: сам
      // классификатор про видимость субъекта, а не про CRUD напоминаний.
      ['reminders.changed', { action: 'updated', reminder_id: 'r1' }],
    ];
    for (const [type, data] of cases) {
      assert.equal(
        isReminderSubjectVisibilityEvent(event(type, data)),
        false,
        `${type} ${JSON.stringify(data)} видимость субъекта не меняет`,
      );
    }
  });
});
