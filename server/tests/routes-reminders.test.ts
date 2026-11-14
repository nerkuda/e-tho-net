/**
 * REST-маршруты напоминаний (0.16.1, задача b47f1fd2; операции ae19b1bf,
 * 500d1b3d; сущность 62e6787b, ADR 03e429ed).
 *
 *   POST   /networks/:networkId/reminders
 *   GET    /networks/:networkId/reminders
 *   PATCH  /networks/:networkId/reminders/:id
 *   DELETE /networks/:networkId/reminders/:id
 *   POST   /networks/:networkId/reminders/:id/snooze
 *   POST   /networks/:networkId/reminders/:id/dismiss
 *
 * Проверяет провод: коды ответов (201/200/400/403/404/409/422), нормализацию
 * `next_at`, права владельца, видимость субъекта и настройку сети
 * «Показывать неактуальные».
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PREF_KEY } from '@etn/shared';

import {
  apiCreateThought,
  authHeaders,
  buildRestContext,
  closeRestContext,
  createSecondAdminUser,
  nativeAvailable,
  type RestTestContext,
} from './rest-helpers.js';

/** Ответ в форме `{ data }`; ошибка — как есть. */
interface JsonReply<T> {
  statusCode: number;
  json: () => { data: T; error?: { code: string; message: string; details?: unknown } };
}

/** Напоминание в выдаче REST. */
interface ReminderJson {
  id: string;
  subject_type: string;
  subject_id: string;
  subject_state: string;
  kind: string;
  schedule: Record<string, unknown>;
  anchor_at: string;
  next_at: string | null;
  exceptions: Record<string, unknown>;
  state: string;
  occurrences?: Array<{ occurrence_at: string; status: string; until: string | null }>;
}

/** Моменты — только будущие относительно часов теста, чтобы `next_at` был стабилен. */
const ANCHOR = '2030-01-15T09:00:00.000Z';

/** Создать напоминание через REST и вернуть ответ. */
async function postReminder(
  ctx: RestTestContext,
  payload: Record<string, unknown>,
  headers: Record<string, string> = authHeaders(ctx),
): Promise<JsonReply<ReminderJson>> {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/networks/${ctx.networkId}/reminders`,
    headers,
    payload,
  });
}

/** Свежая мысль-субъект. */
async function createSubject(ctx: RestTestContext, title = 'Субъект'): Promise<string> {
  const created = await apiCreateThought(ctx, { title });
  assert.equal(created.statusCode, 201);
  return created.data['id'] as string;
}

describe('routes /reminders (b47f1fd2)', { skip: !nativeAvailable() }, () => {
  it('POST создаёт напоминание каждого вида (kind=one|period|rule) и нормализует anchor_at', async () => {
    const ctx = await buildRestContext();
    try {
      const subjectId = await createSubject(ctx);

      const one = await postReminder(ctx, {
        subject_type: 'thought',
        subject_id: subjectId,
        kind: 'one',
        schedule: { type: 'once' },
        anchor_at: ANCHOR,
      });
      assert.equal(one.statusCode, 201, JSON.stringify(one.json()));
      const oneData = one.json().data;
      assert.equal(oneData.kind, 'one');
      assert.equal(oneData.anchor_at, ANCHOR);
      assert.equal(oneData.next_at, ANCHOR);
      assert.equal(oneData.state, 'active');
      assert.equal(oneData.subject_state, 'active');

      const period = await postReminder(ctx, {
        subject_type: 'thought',
        subject_id: subjectId,
        kind: 'period',
        schedule: { type: 'day_of_month', day: 31, every_months: 1 },
        // 10 января → сервер сдвигает anchor к 31-му (последний день месяца).
        anchor_at: '2030-01-10T09:00:00.000Z',
      });
      assert.equal(period.statusCode, 201, JSON.stringify(period.json()));
      assert.equal(period.json().data.kind, 'period');
      assert.equal(period.json().data.anchor_at, '2030-01-31T09:00:00.000Z');

      const rule = await postReminder(ctx, {
        subject_type: 'thought',
        subject_id: subjectId,
        kind: 'rule',
        schedule: { type: 'weekdays', days: [1] },
        // 2030-01-02 — среда; первый понедельник не раньше неё — 7 января.
        anchor_at: '2030-01-02T09:00:00.000Z',
      });
      assert.equal(rule.statusCode, 201, JSON.stringify(rule.json()));
      assert.equal(rule.json().data.kind, 'rule');
      assert.equal(rule.json().data.anchor_at, '2030-01-07T09:00:00.000Z');
      assert.equal(rule.json().data.next_at, '2030-01-07T09:00:00.000Z');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('POST: ошибка грамматики — 400, расхождение kind — 400, битый инстанс — 422, чужой субъект — 404', async () => {
    const ctx = await buildRestContext();
    try {
      const subjectId = await createSubject(ctx);
      const base = {
        subject_type: 'thought',
        subject_id: subjectId,
        kind: 'one',
        anchor_at: ANCHOR,
      };

      const unknownType = await postReminder(ctx, { ...base, schedule: { type: 'hourly' } });
      assert.equal(unknownType.statusCode, 400, JSON.stringify(unknownType.json()));
      assert.equal(unknownType.json().error?.code, 'VALIDATION_ERROR');

      const extraKey = await postReminder(ctx, {
        ...base,
        schedule: { type: 'once', days: [1] },
      });
      assert.equal(extraKey.statusCode, 400, JSON.stringify(extraKey.json()));

      const outOfRange = await postReminder(ctx, {
        ...base,
        kind: 'period',
        schedule: { type: 'every_days', every: 0 },
      });
      assert.equal(outOfRange.statusCode, 400, JSON.stringify(outOfRange.json()));

      const mismatch = await postReminder(ctx, {
        ...base,
        schedule: { type: 'weekdays', days: [1] },
      });
      assert.equal(mismatch.statusCode, 400, JSON.stringify(mismatch.json()));
      assert.equal(mismatch.json().error?.code, 'VALIDATION_ERROR');

      const badInstant = await postReminder(ctx, {
        ...base,
        anchor_at: 'завтра в девять',
        schedule: { type: 'once' },
      });
      assert.equal(badInstant.statusCode, 422, JSON.stringify(badInstant.json()));
      assert.equal(badInstant.json().error?.code, 'VALIDATION_ERROR');

      const missingSubject = await postReminder(ctx, {
        ...base,
        subject_id: 'нет-такой-мысли',
        schedule: { type: 'once' },
      });
      assert.equal(missingSubject.statusCode, 404, JSON.stringify(missingSubject.json()));
      assert.equal(missingSubject.json().error?.code, 'NOT_FOUND');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('GET отдаёт только свои напоминания, раскрывает период и проверяет его границы', async () => {
    const ctx = await buildRestContext();
    try {
      const subjectId = await createSubject(ctx);
      const created = await postReminder(ctx, {
        subject_type: 'thought',
        subject_id: subjectId,
        kind: 'period',
        schedule: { type: 'every_days', every: 1 },
        anchor_at: '2030-01-01T09:00:00.000Z',
      });
      assert.equal(created.statusCode, 201, JSON.stringify(created.json()));

      const expanded = await ctx.app.inject({
        method: 'GET',
        url:
          `/api/v1/networks/${ctx.networkId}/reminders` +
          `?from=2030-01-01T00:00:00.000Z&to=2030-01-03T23:59:59.000Z`,
        headers: authHeaders(ctx),
      });
      assert.equal(expanded.statusCode, 200, JSON.stringify(expanded.json()));
      const list = expanded.json().data as {
        reminders: ReminderJson[];
        from: string | null;
        to: string | null;
      };
      assert.equal(list.reminders.length, 1);
      assert.equal(list.from, '2030-01-01T00:00:00.000Z');
      assert.equal(list.to, '2030-01-03T23:59:59.000Z');
      assert.deepEqual(
        list.reminders[0]?.occurrences?.map((o) => o.occurrence_at),
        ['2030-01-01T09:00:00.000Z', '2030-01-02T09:00:00.000Z', '2030-01-03T09:00:00.000Z'],
      );

      const plain = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/reminders`,
        headers: authHeaders(ctx),
      });
      assert.equal(plain.statusCode, 200);
      assert.equal((plain.json().data as { from: string | null }).from, null);

      const stranger = createSecondAdminUser(ctx);
      const foreignList = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/reminders`,
        headers: { authorization: `Bearer ${stranger.key}` },
      });
      assert.equal(foreignList.statusCode, 200);
      assert.deepEqual(
        (foreignList.json().data as { reminders: ReminderJson[] }).reminders,
        [],
        'чужое напоминание в список не попадает',
      );

      const badHorizon = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/reminders?horizon_days=0`,
        headers: authHeaders(ctx),
      });
      assert.equal(badHorizon.statusCode, 422, JSON.stringify(badHorizon.json()));

      const inverted = await ctx.app.inject({
        method: 'GET',
        url:
          `/api/v1/networks/${ctx.networkId}/reminders` +
          `?from=2030-01-03T00:00:00.000Z&to=2030-01-01T00:00:00.000Z`,
        headers: authHeaders(ctx),
      });
      assert.equal(inverted.statusCode, 400, JSON.stringify(inverted.json()));
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('PATCH заменяет серию (kind=one|period|rule), сбрасывает исключения и пересчитывает next_at', async () => {
    const ctx = await buildRestContext();
    try {
      const subjectId = await createSubject(ctx);
      const created = await postReminder(ctx, {
        subject_type: 'thought',
        subject_id: subjectId,
        kind: 'period',
        schedule: { type: 'every_days', every: 1 },
        anchor_at: ANCHOR,
      });
      assert.equal(created.statusCode, 201);
      const id = created.json().data.id;

      const snoozed = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/reminders/${id}/snooze`,
        headers: authHeaders(ctx),
        payload: { until: '2030-01-15T20:00:00.000Z' },
      });
      assert.equal(snoozed.statusCode, 200, JSON.stringify(snoozed.json()));

      const patched = (kind: string, schedule: Record<string, unknown>, anchor_at: string) =>
        ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/networks/${ctx.networkId}/reminders/${id}`,
          headers: authHeaders(ctx),
          payload: { kind, schedule, anchor_at },
        });

      const toPeriod = await patched('period', { type: 'every_days', every: 2 }, ANCHOR);
      assert.equal(toPeriod.statusCode, 200, JSON.stringify(toPeriod.json()));
      assert.equal(toPeriod.json().data.kind, 'period');
      assert.deepEqual(toPeriod.json().data.exceptions, {}, 'исключения сброшены');

      const toRule = await patched(
        'rule',
        { type: 'weekdays', days: [1, 4] },
        '2030-01-02T09:00:00.000Z',
      );
      assert.equal(toRule.statusCode, 200, JSON.stringify(toRule.json()));
      assert.equal(toRule.json().data.kind, 'rule');
      assert.equal(toRule.json().data.anchor_at, '2030-01-03T09:00:00.000Z');

      const toOne = await patched('one', { type: 'once' }, '2030-02-01T09:00:00.000Z');
      assert.equal(toOne.statusCode, 200, JSON.stringify(toOne.json()));
      assert.equal(toOne.json().data.kind, 'one');
      assert.equal(toOne.json().data.next_at, '2030-02-01T09:00:00.000Z');

      const nothing = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/networks/${ctx.networkId}/reminders/${id}`,
        headers: authHeaders(ctx),
        payload: {},
      });
      assert.equal(nothing.statusCode, 400, JSON.stringify(nothing.json()));

      const stranger = createSecondAdminUser(ctx);
      const foreign = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/networks/${ctx.networkId}/reminders/${id}`,
        headers: { authorization: `Bearer ${stranger.key}` },
        payload: { kind: 'one', schedule: { type: 'once' } },
      });
      assert.equal(foreign.statusCode, 403, JSON.stringify(foreign.json()));
      assert.equal(foreign.json().error?.code, 'FORBIDDEN');

      const missing = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/networks/${ctx.networkId}/reminders/нет-такого`,
        headers: authHeaders(ctx),
        payload: { kind: 'one', schedule: { type: 'once' } },
      });
      assert.equal(missing.statusCode, 404, JSON.stringify(missing.json()));
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('snooze и dismiss управляют только текущим вхождением; без вхождения — 409', async () => {
    const ctx = await buildRestContext();
    try {
      const subjectId = await createSubject(ctx);
      const created = await postReminder(ctx, {
        subject_type: 'thought',
        subject_id: subjectId,
        kind: 'period',
        schedule: { type: 'every_days', every: 1 },
        anchor_at: ANCHOR,
      });
      assert.equal(created.statusCode, 201);
      const id = created.json().data.id;

      const snooze = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/reminders/${id}/snooze`,
        headers: authHeaders(ctx),
        payload: { until: '2030-01-15T20:00:00.000Z' },
      });
      assert.equal(snooze.statusCode, 200, JSON.stringify(snooze.json()));
      const snoozed = snooze.json().data as { reminder: ReminderJson; occurrence_at: string };
      assert.equal(snoozed.occurrence_at, ANCHOR);
      assert.equal(snoozed.reminder.next_at, '2030-01-15T20:00:00.000Z');
      assert.deepEqual(snoozed.reminder.schedule, { type: 'every_days', every: 1 });

      const pastUntil = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/reminders/${id}/snooze`,
        headers: authHeaders(ctx),
        payload: { until: '2020-01-01T00:00:00.000Z' },
      });
      assert.equal(pastUntil.statusCode, 400, JSON.stringify(pastUntil.json()));

      const dismiss = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/reminders/${id}/dismiss`,
        headers: authHeaders(ctx),
        payload: {},
      });
      assert.equal(dismiss.statusCode, 200, JSON.stringify(dismiss.json()));
      const dismissed = dismiss.json().data as { reminder: ReminderJson; occurrence_at: string };
      assert.equal(dismissed.occurrence_at, ANCHOR);
      assert.equal(
        dismissed.reminder.next_at,
        '2030-01-16T09:00:00.000Z',
        'следующее вхождение серии',
      );

      // Единственное вхождение уже в прошлом — обрабатывать нечего.
      const spent = await postReminder(ctx, {
        subject_type: 'thought',
        subject_id: subjectId,
        kind: 'one',
        schedule: { type: 'once' },
        anchor_at: '2020-01-01T09:00:00.000Z',
      });
      assert.equal(spent.statusCode, 201, JSON.stringify(spent.json()));
      const spentId = spent.json().data.id;
      assert.equal(spent.json().data.next_at, null);
      const noOccurrence = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/networks/${ctx.networkId}/reminders/${spentId}/dismiss`,
        headers: authHeaders(ctx),
        payload: {},
      });
      assert.equal(noOccurrence.statusCode, 409, JSON.stringify(noOccurrence.json()));
      assert.equal(noOccurrence.json().error?.code, 'VALIDATION_ERROR');
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('DELETE удаляет мягко: списка и повторного удаления напоминание не видит', async () => {
    const ctx = await buildRestContext();
    try {
      const subjectId = await createSubject(ctx);
      const created = await postReminder(ctx, {
        subject_type: 'thought',
        subject_id: subjectId,
        kind: 'one',
        schedule: { type: 'once' },
        anchor_at: ANCHOR,
      });
      const id = created.json().data.id;

      const deleted = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/networks/${ctx.networkId}/reminders/${id}`,
        headers: authHeaders(ctx),
      });
      assert.equal(deleted.statusCode, 200, JSON.stringify(deleted.json()));
      assert.deepEqual(deleted.json().data, { id });

      const row = ctx.ndb.prepare('SELECT state FROM reminders WHERE id = ?').get(id) as {
        state: string;
      };
      assert.equal(row.state, 'removed', 'строка осталась, но помечена removed');

      const list = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/networks/${ctx.networkId}/reminders`,
        headers: authHeaders(ctx),
      });
      assert.deepEqual((list.json().data as { reminders: ReminderJson[] }).reminders, []);

      const again = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/networks/${ctx.networkId}/reminders/${id}`,
        headers: authHeaders(ctx),
      });
      assert.equal(again.statusCode, 404, JSON.stringify(again.json()));
    } finally {
      await closeRestContext(ctx);
    }
  });

  it('неактуальный субъект скрыт без настройки сети и виден с ней; помеченный — скрыт всегда', async () => {
    const ctx = await buildRestContext();
    try {
      const inactiveId = await createSubject(ctx, 'Неактуальная тема');
      const markedId = await createSubject(ctx, 'Удаляемая тема');
      for (const subjectId of [inactiveId, markedId]) {
        const created = await postReminder(ctx, {
          subject_type: 'thought',
          subject_id: subjectId,
          kind: 'one',
          schedule: { type: 'once' },
          anchor_at: ANCHOR,
        });
        assert.equal(created.statusCode, 201, JSON.stringify(created.json()));
      }

      const deactivate = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/networks/${ctx.networkId}/thoughts/${inactiveId}`,
        headers: { ...authHeaders(ctx), 'if-match': '1' },
        payload: { active: false },
      });
      assert.equal(deactivate.statusCode, 200, JSON.stringify(deactivate.json()));

      const remove = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/networks/${ctx.networkId}/thoughts/${markedId}`,
        headers: { ...authHeaders(ctx), 'if-match': '1' },
      });
      assert.equal(remove.statusCode, 204);

      const list = async (): Promise<ReminderJson[]> => {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/networks/${ctx.networkId}/reminders`,
          headers: authHeaders(ctx),
        });
        assert.equal(res.statusCode, 200);
        return (res.json().data as { reminders: ReminderJson[] }).reminders;
      };

      assert.deepEqual(await list(), [], 'по умолчанию и неактуальный, и помеченный скрыты');

      ctx.sys.setNetworkPreference(ctx.adminId, ctx.networkId, PREF_KEY.SHOW_INACTIVE, true);
      const shown = await list();
      assert.deepEqual(
        shown.map((r) => r.subject_id),
        [inactiveId],
      );
      assert.equal(shown[0]?.subject_state, 'inactive');

      const markedAgain = await postReminder(ctx, {
        subject_type: 'thought',
        subject_id: markedId,
        kind: 'one',
        schedule: { type: 'once' },
        anchor_at: ANCHOR,
      });
      assert.equal(markedAgain.statusCode, 404, JSON.stringify(markedAgain.json()));
    } finally {
      await closeRestContext(ctx);
    }
  });
});
