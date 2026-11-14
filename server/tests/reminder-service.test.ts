/**
 * Домен напоминаний (0.16.1, задача b47f1fd2; сущность 62e6787b, ADR 03e429ed,
 * операции ae19b1bf / 500d1b3d).
 *
 * Проверяет то, что принадлежит сервису, а не грамматике повтора
 * (`reminder-repeat.test.ts`): права владельца, видимость субъекта, ленивый
 * `next_at` без записи на чтении, snooze/dismiss на моменте вхождения, сброс
 * исключений при правке серии и НЕветвимость таблицы по слоям.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { BASE_LAYER_ID, EtnError, MS_PER_DAY } from '@etn/shared';

import { createInMemoryNetworkDb, type NetworkDb } from '../src/db/network-db.js';
import { createLayer } from '../src/domain/layer-service.js';
import {
  createReminder,
  dismissReminder,
  listReminders,
  removeReminder,
  snoozeReminder,
  updateReminder,
} from '../src/domain/reminder-service.js';

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';

/** «Сейчас» для детерминированного ленивого продвижения. */
const NOW = Date.parse('2025-01-04T10:00:00.000Z');

/** Ошибка домена с ожидаемым кодом и (необязательно) HTTP-статусом. */
function expectError(fn: () => unknown, code: string, status?: number): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof EtnError, 'ожидалась EtnError');
    assert.equal(err.code, code);
    if (status !== undefined) {
      assert.equal((err.details as { status?: number } | undefined)?.status, status);
    }
    return true;
  });
}

/** Живая мысль для субъекта напоминания. */
function seedThought(
  ndb: NetworkDb,
  title: string,
  opts: { active?: number; marked?: number } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO thoughts (id, title, title_norm, type_id, active, is_protected, is_root,
                             marked_for_deletion, version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, NULL, ?, 0, 0, ?, 1, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, title, title.toLowerCase(), opts.active ?? 1, opts.marked ?? 0);
  return id;
}

/** Живая публикация для субъекта напоминания. */
function seedPublication(
  ndb: NetworkDb,
  title: string,
  opts: { active?: number; marked?: number } = {},
): string {
  const id = randomUUID();
  ndb
    .prepare(
      `INSERT INTO publications (id, layer_id, title, active, deleted, marked_for_deletion,
         base_version, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 0, ?, 0, '2024-01-01T00:00:00Z', 'u', '2024-01-01T00:00:00Z', 'u')`,
    )
    .run(id, BASE_LAYER_ID, title, opts.active ?? 1, opts.marked ?? 0);
  return id;
}

/** Ежедневное напоминание о мысли — базовая серия для сценариев вхождения. */
function dailyReminder(
  ndb: NetworkDb,
  subjectId: string,
  anchorAt = '2020-01-01T09:00:00.000Z',
): string {
  return createReminder(
    ndb,
    OWNER,
    {
      subject_type: 'thought',
      subject_id: subjectId,
      kind: 'period',
      schedule: { type: 'every_days', every: 1 },
      anchor_at: anchorAt,
    },
    NOW,
  ).id;
}

describe('reminder-service: создание и видимость субъекта', () => {
  it('создаёт напоминание, нормализует anchor и считает next_at', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    const reminder = createReminder(
      ndb,
      OWNER,
      {
        subject_type: 'thought',
        subject_id: thoughtId,
        kind: 'rule',
        schedule: { type: 'weekdays', days: [1] },
        // 2025-01-01 — среда: сервер сдвигает anchor к первому понедельнику.
        anchor_at: '2025-01-01T09:00:00.000Z',
      },
      NOW,
    );
    assert.equal(reminder.anchor_at, '2025-01-06T09:00:00.000Z');
    assert.equal(reminder.next_at, '2025-01-06T09:00:00.000Z');
    assert.equal(reminder.kind, 'rule');
    assert.equal(reminder.state, 'active');
    assert.deepEqual(reminder.exceptions, {});
    assert.equal(reminder.user_id, OWNER);
    assert.equal(reminder.subject_state, 'active');
  });

  it('расхождение kind и schedule.type — 400 без записи строки', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    expectError(
      () =>
        createReminder(
          ndb,
          OWNER,
          {
            subject_type: 'thought',
            subject_id: thoughtId,
            kind: 'period',
            schedule: { type: 'once' },
            anchor_at: '2025-01-01T09:00:00.000Z',
          },
          NOW,
        ),
      'VALIDATION_ERROR',
      400,
    );
    assert.equal((ndb.prepare('SELECT COUNT(*) AS c FROM reminders').get() as { c: number }).c, 0);
  });

  it('субъект отсутствует или помечен на удаление — 404', () => {
    const ndb = createInMemoryNetworkDb();
    const marked = seedThought(ndb, 'Удаляемая', { marked: 1 });
    expectError(
      () =>
        createReminder(
          ndb,
          OWNER,
          {
            subject_type: 'thought',
            subject_id: 'нет-такой',
            kind: 'one',
            schedule: { type: 'once' },
            anchor_at: '2025-01-06T09:00:00.000Z',
          },
          NOW,
        ),
      'NOT_FOUND',
    );
    expectError(
      () =>
        createReminder(
          ndb,
          OWNER,
          {
            subject_type: 'thought',
            subject_id: marked,
            kind: 'one',
            schedule: { type: 'once' },
            anchor_at: '2025-01-06T09:00:00.000Z',
          },
          NOW,
        ),
      'NOT_FOUND',
    );
  });

  it('публикация — такой же субъект, как мысль', () => {
    const ndb = createInMemoryNetworkDb();
    const publicationId = seedPublication(ndb, 'Документ');
    const reminder = createReminder(
      ndb,
      OWNER,
      {
        subject_type: 'publication',
        subject_id: publicationId,
        kind: 'one',
        schedule: { type: 'once' },
        anchor_at: '2025-01-06T09:00:00.000Z',
      },
      NOW,
    );
    assert.equal(reminder.subject_type, 'publication');
    assert.equal(reminder.subject_id, publicationId);
    assert.equal(
      listReminders(ndb, OWNER, { show_inactive: false, nowMs: NOW }).reminders.length,
      1,
    );
  });
});

describe('reminder-service: список, ленивый next_at и порядок', () => {
  it('чтение не пишет в БД, а next_at продвигается в памяти', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    const id = dailyReminder(ndb, thoughtId);
    const stored = ndb.prepare('SELECT next_at FROM reminders WHERE id = ?').get(id) as {
      next_at: string;
    };
    const changes = (): number =>
      (ndb.prepare('SELECT total_changes() AS c').get() as { c: number }).c;

    const before = changes();
    const list = listReminders(ndb, OWNER, { show_inactive: false, nowMs: NOW });
    assert.equal(changes(), before, 'GET-путь напоминаний не пишет в БД');
    assert.equal(
      list.reminders[0]?.next_at,
      '2025-01-05T09:00:00.000Z',
      'next_at считается от «сейчас»',
    );
    const after = ndb.prepare('SELECT next_at FROM reminders WHERE id = ?').get(id) as {
      next_at: string;
    };
    assert.equal(after.next_at, stored.next_at, 'колонка next_at обновляется только записями');
  });

  it('отбор по субъекту и порядок по близости срабатывания', () => {
    const ndb = createInMemoryNetworkDb();
    const first = seedThought(ndb, 'Первая');
    const second = seedThought(ndb, 'Вторая');
    dailyReminder(ndb, first, '2020-01-01T09:00:00.000Z');
    dailyReminder(ndb, second, '2020-01-01T21:00:00.000Z');
    const once = createReminder(
      ndb,
      OWNER,
      {
        subject_type: 'thought',
        subject_id: second,
        kind: 'one',
        schedule: { type: 'once' },
        anchor_at: '2025-03-01T09:00:00.000Z',
      },
      NOW,
    ).id;

    const all = listReminders(ndb, OWNER, { show_inactive: false, nowMs: NOW });
    assert.deepEqual(
      all.reminders.map((r) => r.next_at),
      ['2025-01-04T21:00:00.000Z', '2025-01-05T09:00:00.000Z', '2025-03-01T09:00:00.000Z'],
      'порядок — по next_at (сегодняшний показ раньше завтрашнего)',
    );
    assert.deepEqual(
      all.reminders.map((r) => r.subject_id),
      [second, first, second],
    );
    const onlySecond = listReminders(ndb, OWNER, {
      show_inactive: false,
      nowMs: NOW,
      subject_id: second,
    });
    assert.deepEqual(
      onlySecond.reminders.map((r) => r.id),
      all.reminders.filter((r) => r.subject_id === second).map((r) => r.id),
    );
    assert.ok(
      onlySecond.reminders.every((r) => r.id !== once || r.next_at === '2025-03-01T09:00:00.000Z'),
    );
  });

  it('неактуальный субъект виден по настройке сети, помеченный на удаление — никогда', () => {
    const ndb = createInMemoryNetworkDb();
    const inactive = seedThought(ndb, 'Неактуальная', { active: 0 });
    const marked = seedThought(ndb, 'Удаляемая');
    const inactiveId = createReminder(
      ndb,
      OWNER,
      {
        subject_type: 'thought',
        subject_id: inactive,
        kind: 'one',
        schedule: { type: 'once' },
        anchor_at: '2025-01-06T09:00:00.000Z',
      },
      NOW,
    ).id;
    const markedId = createReminder(
      ndb,
      OWNER,
      {
        subject_type: 'thought',
        subject_id: marked,
        kind: 'one',
        schedule: { type: 'once' },
        anchor_at: '2025-01-06T09:00:00.000Z',
      },
      NOW,
    ).id;
    ndb.prepare('UPDATE thoughts SET marked_for_deletion = 1 WHERE id = ?').run(marked);

    const hidden = listReminders(ndb, OWNER, { show_inactive: false, nowMs: NOW });
    assert.deepEqual(
      hidden.reminders.map((r) => r.id),
      [],
      'скрыты и неактуальный, и помеченный',
    );

    const shown = listReminders(ndb, OWNER, { show_inactive: true, nowMs: NOW });
    assert.deepEqual(
      shown.reminders.map((r) => r.id),
      [inactiveId],
    );
    assert.equal(shown.reminders[0]?.subject_state, 'inactive');
    assert.ok(!shown.reminders.some((r) => r.id === markedId));
  });

  it('список отдаёт только напоминания владельца', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    dailyReminder(ndb, thoughtId);
    assert.deepEqual(
      listReminders(ndb, STRANGER, { show_inactive: false, nowMs: NOW }).reminders,
      [],
    );
  });

  it('раскрытие на период отдаёт вхождения и эхо фактического окна', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    dailyReminder(ndb, thoughtId);
    const result = listReminders(ndb, OWNER, {
      show_inactive: false,
      nowMs: NOW,
      from: '2025-01-05T00:00:00.000Z',
      to: '2025-01-07T23:59:59.000Z',
    });
    assert.equal(result.from, '2025-01-05T00:00:00.000Z');
    assert.equal(result.to, '2025-01-07T23:59:59.000Z');
    assert.deepEqual(
      result.reminders[0]?.occurrences?.map((o) => o.occurrence_at),
      ['2025-01-05T09:00:00.000Z', '2025-01-06T09:00:00.000Z', '2025-01-07T09:00:00.000Z'],
    );
    const noPeriod = listReminders(ndb, OWNER, { show_inactive: false, nowMs: NOW });
    assert.equal(noPeriod.from, null);
    assert.equal(noPeriod.reminders[0]?.occurrences, undefined);
  });

  it('потолок дальности обрезает период, а не отвергает его', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    dailyReminder(ndb, thoughtId);
    const result = listReminders(ndb, OWNER, {
      show_inactive: false,
      nowMs: NOW,
      from: '2025-01-05T00:00:00.000Z',
      to: '2030-01-01T00:00:00.000Z',
      horizon_days: 2,
    });
    assert.equal(result.to, '2025-01-07T00:00:00.000Z');
    expectError(
      () =>
        listReminders(ndb, OWNER, {
          show_inactive: false,
          nowMs: NOW,
          from: '2025-01-05T00:00:00.000Z',
          horizon_days: 0,
        }),
      'VALIDATION_ERROR',
      400,
    );
  });

  it('таблица reminders не ветвится по слоям: строка видна в любом контексте', () => {
    const ndb = createInMemoryNetworkDb();
    const columns = (
      ndb.prepare('PRAGMA table_info(reminders)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    assert.ok(!columns.includes('layer_id'), 'у reminders нет layer_id');
    assert.ok(!columns.includes('deleted'), 'у reminders нет deleted');

    const thoughtId = seedThought(ndb, 'Субъект');
    const id = dailyReminder(ndb, thoughtId);
    const layer = createLayer(ndb, {
      parentId: BASE_LAYER_ID,
      title: 'Рабочий слой',
      createdBy: OWNER,
    });
    ndb.useLayer(layer.id);
    assert.deepEqual(
      listReminders(ndb, OWNER, { show_inactive: false, nowMs: NOW }).reminders.map((r) => r.id),
      [id],
      'рабочий слой видит то же напоминание',
    );
    ndb.useLayer(BASE_LAYER_ID);
  });
});

describe('reminder-service: snooze и dismiss (500d1b3d, 86cb7451)', () => {
  it('snooze пишет исключение на момент вхождения и делает until ближайшим показом', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    const id = dailyReminder(ndb, thoughtId);
    const until = '2025-01-05T20:00:00.000Z';
    const change = snoozeReminder(ndb, OWNER, id, until, NOW);
    // Вхождение 09:00 сегодня уже наступило (сейчас 10:00), но оно ещё не
    // обработано и остаётся активным до конца UTC-суток — панель показывает его
    // в секции «Сегодня» (хвост приёмки 0.16.1).
    assert.equal(change.occurrence_at, '2025-01-04T09:00:00.000Z');
    assert.deepEqual(change.reminder.exceptions, {
      '2025-01-04T09:00:00.000Z': { kind: 'snooze', until },
    });
    // Следующее вхождение серии (09:00) наступает раньше переноса (20:00) —
    // ближайший показ именно оно.
    assert.equal(change.reminder.next_at, '2025-01-05T09:00:00.000Z');
    assert.deepEqual(
      change.reminder.schedule,
      { type: 'every_days', every: 1 },
      'серия не меняется',
    );
  });

  it('snooze в прошлое, не позже вхождения и без активного вхождения — 400/409', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    const id = dailyReminder(ndb, thoughtId);
    expectError(
      () => snoozeReminder(ndb, OWNER, id, '2025-01-04T09:00:00.000Z', NOW),
      'VALIDATION_ERROR',
      400,
    );

    // until в будущем, но НЕ ПОЗЖЕ момента вхождения: вхождение по строгому
    // сравнению не скрывается, запись в exceptions была бы мёртвой.
    const future = createReminder(
      ndb,
      OWNER,
      {
        subject_type: 'thought',
        subject_id: thoughtId,
        kind: 'one',
        schedule: { type: 'once' },
        anchor_at: '2025-01-10T09:00:00.000Z',
      },
      NOW,
    ).id;
    expectError(
      () => snoozeReminder(ndb, OWNER, future, '2025-01-10T08:00:00.000Z', NOW),
      'VALIDATION_ERROR',
      400,
    );

    const once = createReminder(
      ndb,
      OWNER,
      {
        subject_type: 'thought',
        subject_id: thoughtId,
        kind: 'one',
        schedule: { type: 'once' },
        anchor_at: '2020-01-01T09:00:00.000Z',
      },
      NOW,
    ).id;
    expectError(
      () => snoozeReminder(ndb, OWNER, once, '2025-01-05T09:00:00.000Z', NOW),
      'VALIDATION_ERROR',
      409,
    );
  });

  it('наступившее сегодня вхождение kind=one активно для snooze и dismiss', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    const today = createReminder(
      ndb,
      OWNER,
      {
        subject_type: 'thought',
        subject_id: thoughtId,
        kind: 'one',
        schedule: { type: 'once' },
        // 09:00 сегодня, «сейчас» — 10:00: вхождение наступило, но не обработано.
        anchor_at: '2025-01-04T09:00:00.000Z',
      },
      NOW,
    );
    assert.equal(today.next_at, null, 'next_at смотрит только вперёд');

    const snoozed = snoozeReminder(ndb, OWNER, today.id, '2025-01-04T12:00:00.000Z', NOW);
    assert.equal(snoozed.occurrence_at, '2025-01-04T09:00:00.000Z');
    assert.equal(snoozed.reminder.next_at, '2025-01-04T12:00:00.000Z');

    const another = createReminder(
      ndb,
      OWNER,
      {
        subject_type: 'thought',
        subject_id: thoughtId,
        kind: 'one',
        schedule: { type: 'once' },
        anchor_at: '2025-01-04T08:00:00.000Z',
      },
      NOW,
    );
    const dismissed = dismissReminder(ndb, OWNER, another.id, NOW);
    assert.equal(dismissed.occurrence_at, '2025-01-04T08:00:00.000Z');
    assert.equal(dismissed.reminder.next_at, null, 'единственное вхождение убрано');
  });

  it('явный occurrence_at адресует показанное вхождение, чужой момент — 409', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    // Ежедневная серия с 2024-12-20: в окне панели есть просроченные вхождения.
    const id = dailyReminder(ndb, thoughtId, '2024-12-20T09:00:00.000Z');

    const dismissed = dismissReminder(ndb, OWNER, id, NOW, '2024-12-30T09:00:00.000Z');
    assert.equal(dismissed.occurrence_at, '2024-12-30T09:00:00.000Z');
    assert.deepEqual(Object.keys(dismissed.reminder.exceptions), ['2024-12-30T09:00:00.000Z']);
    assert.equal(
      dismissed.reminder.next_at,
      '2025-01-05T09:00:00.000Z',
      'next_at смотрит только вперёд: убранное вхождение в прошлом его не меняет',
    );

    expectError(
      () => dismissReminder(ndb, OWNER, id, NOW, '2024-12-30T10:00:00.000Z'),
      'VALIDATION_ERROR',
      409,
    );
    expectError(
      () => dismissReminder(ndb, OWNER, id, NOW, '2024-12-30T09:00:00.000Z'),
      'VALIDATION_ERROR',
      409,
    );
    expectError(
      () =>
        snoozeReminder(ndb, OWNER, id, '2025-01-05T09:00:00.000Z', NOW, '2024-12-30T09:00:00.000Z'),
      'VALIDATION_ERROR',
      409,
    );
  });

  it('повторное snooze адресует то же вхождение', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    const id = dailyReminder(ndb, thoughtId);
    snoozeReminder(ndb, OWNER, id, '2025-01-05T20:00:00.000Z', NOW);
    // Панель передаёт момент показанного вхождения: перенос переписывает его же
    // запись, а не уезжает на следующее вхождение серии.
    const second = snoozeReminder(
      ndb,
      OWNER,
      id,
      '2025-01-05T22:00:00.000Z',
      NOW,
      '2025-01-04T09:00:00.000Z',
    );
    assert.deepEqual(Object.keys(second.reminder.exceptions), ['2025-01-04T09:00:00.000Z']);
    assert.deepEqual(second.reminder.exceptions['2025-01-04T09:00:00.000Z'], {
      kind: 'snooze',
      until: '2025-01-05T22:00:00.000Z',
    });
    assert.equal(second.occurrence_at, '2025-01-04T09:00:00.000Z');
  });

  it('цепочка панели: snooze → dismiss → snooze по вхождениям раскрытия — без 409', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    // Ежедневная серия; вхождение сегодняшнего утра уже прошло (NOW = 10:00).
    const id = dailyReminder(ndb, thoughtId, '2025-01-04T09:00:00.000Z');
    const listWindow = {
      from: new Date(NOW - MS_PER_DAY).toISOString(),
      to: new Date(NOW + MS_PER_DAY).toISOString(),
      show_inactive: false,
      nowMs: NOW,
    };
    /** Вхождение, которое панель показывает строкой: `occurrence_at` — адрес исключения. */
    const occurrenceAt = (at: string): string => {
      const row = listReminders(ndb, OWNER, listWindow).reminders[0]?.occurrences?.find(
        (item) => item.occurrence_at === at,
      );
      assert.ok(row !== undefined, `вхождение ${at} есть в раскрытии`);
      return row.occurrence_at;
    };

    // 1. «Отложить» на сутки от момента показа строки (09:00 → 09:00 следующего дня).
    const first = snoozeReminder(
      ndb,
      OWNER,
      id,
      '2025-01-05T09:00:00.000Z',
      NOW,
      occurrenceAt('2025-01-04T09:00:00.000Z'),
    );
    assert.equal(first.occurrence_at, '2025-01-04T09:00:00.000Z');

    // 2. «Убрать» отложенную строку: раскрытие отдаёт её с моментом ВХОЖДЕНИЯ.
    const dismissed = dismissReminder(
      ndb,
      OWNER,
      id,
      NOW,
      occurrenceAt('2025-01-04T09:00:00.000Z'),
    );
    assert.equal(dismissed.occurrence_at, '2025-01-04T09:00:00.000Z');
    assert.deepEqual(dismissed.reminder.exceptions['2025-01-04T09:00:00.000Z'], {
      kind: 'dismiss',
    });

    // 3. Повторный «Отложить» уже следующее вхождение серии.
    const next = snoozeReminder(
      ndb,
      OWNER,
      id,
      '2025-01-06T09:00:00.000Z',
      NOW,
      occurrenceAt('2025-01-05T09:00:00.000Z'),
    );
    assert.equal(next.occurrence_at, '2025-01-05T09:00:00.000Z');
    assert.deepEqual(Object.keys(next.reminder.exceptions), [
      '2025-01-04T09:00:00.000Z',
      '2025-01-05T09:00:00.000Z',
    ]);
    assert.equal(next.reminder.next_at, '2025-01-06T09:00:00.000Z');
  });

  it('dismiss серии скрывает вхождение, но следующее остаётся', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    const id = dailyReminder(ndb, thoughtId);
    const change = dismissReminder(ndb, OWNER, id, NOW);
    assert.equal(change.occurrence_at, '2025-01-04T09:00:00.000Z');
    assert.equal(change.reminder.next_at, '2025-01-05T09:00:00.000Z');
    assert.deepEqual(change.reminder.exceptions, {
      '2025-01-04T09:00:00.000Z': { kind: 'dismiss' },
    });
  });

  it('dismiss единственного вхождения завершает показы, строка остаётся active', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    const id = createReminder(
      ndb,
      OWNER,
      {
        subject_type: 'thought',
        subject_id: thoughtId,
        kind: 'one',
        schedule: { type: 'once' },
        anchor_at: '2025-01-06T09:00:00.000Z',
      },
      NOW,
    ).id;
    const change = dismissReminder(ndb, OWNER, id, NOW);
    assert.equal(change.reminder.next_at, null);
    assert.equal(change.reminder.state, 'active');
    assert.deepEqual(
      listReminders(ndb, OWNER, { show_inactive: false, nowMs: NOW }).reminders.map((r) => r.id),
      [id],
    );
  });
});

describe('reminder-service: правка, удаление и права', () => {
  it('update заменяет серию, сбрасывает исключения и пересчитывает next_at', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    const id = dailyReminder(ndb, thoughtId);
    snoozeReminder(ndb, OWNER, id, '2025-01-05T20:00:00.000Z', NOW);
    const updated = updateReminder(
      ndb,
      OWNER,
      id,
      {
        kind: 'rule',
        schedule: { type: 'weekdays', days: [1] },
        anchor_at: '2025-01-04T10:00:00.000Z',
      },
      NOW,
    );
    assert.deepEqual(updated.exceptions, {}, 'исключения сброшены');
    assert.equal(updated.kind, 'rule');
    // Время суток наследуется от НОВОГО anchor (10:00), день — ближайший понедельник.
    assert.equal(updated.anchor_at, '2025-01-06T10:00:00.000Z');
    assert.equal(updated.next_at, '2025-01-06T10:00:00.000Z');
  });

  it('update без полей — 400, чужое напоминание — 403, удалённое — 404', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    const id = dailyReminder(ndb, thoughtId);
    expectError(() => updateReminder(ndb, OWNER, id, {}, NOW), 'VALIDATION_ERROR', 400);
    expectError(
      () =>
        updateReminder(
          ndb,
          STRANGER,
          id,
          { kind: 'period', schedule: { type: 'every_days', every: 2 } },
          NOW,
        ),
      'FORBIDDEN',
    );
    expectError(
      () => snoozeReminder(ndb, STRANGER, id, '2025-01-05T20:00:00.000Z', NOW),
      'FORBIDDEN',
    );
    expectError(() => dismissReminder(ndb, STRANGER, id, NOW), 'FORBIDDEN');
    expectError(() => removeReminder(ndb, STRANGER, id, NOW), 'FORBIDDEN');

    removeReminder(ndb, OWNER, id, NOW);
    expectError(() => removeReminder(ndb, OWNER, id, NOW), 'NOT_FOUND');
  });

  it('remove — мягкое удаление: строка остаётся, выдачи её не видят', () => {
    const ndb = createInMemoryNetworkDb();
    const thoughtId = seedThought(ndb, 'Субъект');
    const id = dailyReminder(ndb, thoughtId);
    const removed = removeReminder(ndb, OWNER, id, NOW);
    assert.equal(removed.state, 'removed');
    const row = ndb.prepare('SELECT state FROM reminders WHERE id = ?').get(id) as {
      state: string;
    };
    assert.equal(row.state, 'removed');
    assert.deepEqual(listReminders(ndb, OWNER, { show_inactive: false, nowMs: NOW }).reminders, []);
  });
});
