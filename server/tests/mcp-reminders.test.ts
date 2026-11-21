/**
 * MCP-фасад напоминаний (0.16.1, задача b47f1fd2, операция 22f1ea95): действия
 * `reminders.*` исполнителя `etn.ops` повторяют REST без роста ростра
 * инструментов.
 *
 * Проверяет: каждое значение `kind` (one/period/rule) на создании и правке,
 * управление вхождением, права ключа, события `reminders.changed` и темы
 * справочника (`reminders`, `reminders.<action>`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnyRealtimeEvent } from '@etn/shared';

import { OPS_ACTIONS_BY_NAME } from '../src/mcp/tools/ops-catalog.js';
import {
  buildMcpContext,
  callOp,
  closeMcpContext,
  connectMcpClient,
  createThoughtViaWrite,
  nativeAvailable,
  toolJson,
  toolText,
} from './mcp-helpers.js';

/** Напоминание в выдаче действия. */
interface ReminderJson {
  id: string;
  kind: string;
  schedule: Record<string, unknown>;
  anchor_at: string;
  next_at: string | null;
  exceptions: Record<string, unknown>;
  state: string;
  subject_state: string;
  occurrence_at?: string;
  occurrences?: Array<{ occurrence_at: string; status: string; until: string | null }>;
}

/** Моменты — в будущем относительно часов теста. */
const ANCHOR = '2030-01-15T09:00:00.000Z';

describe('MCP etn.reminders.* (22f1ea95)', { skip: !nativeAvailable() }, () => {
  it('etn.reminders.create: каждое значение kind (one/period/rule) создаёт серию своего вида', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const subject = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Субъект напоминания',
        });
        const events: AnyRealtimeEvent[] = [];
        ctx.pubsub.subscribe(ctx.networkId, (event) => {
          events.push(event as unknown as AnyRealtimeEvent);
        });

        const one = await callOp(handle.client, 'reminders.create', {
          network_id: ctx.networkId,
          subject_type: 'thought',
          subject_id: subject.id,
          kind: 'one',
          schedule: { type: 'once' },
          anchor_at: ANCHOR,
        });
        assert.equal(one.isError, undefined, toolText(one));
        const oneCard = toolJson<ReminderJson>(one);
        assert.equal(oneCard.kind, 'one');
        assert.equal(oneCard.next_at, ANCHOR);

        const period = await callOp(handle.client, 'reminders.create', {
          network_id: ctx.networkId,
          subject_type: 'thought',
          subject_id: subject.id,
          kind: 'period',
          schedule: { type: 'every_days', every: 2 },
          anchor_at: ANCHOR,
        });
        assert.equal(period.isError, undefined, toolText(period));
        assert.equal(toolJson<ReminderJson>(period).kind, 'period');

        const rule = await callOp(handle.client, 'reminders.create', {
          network_id: ctx.networkId,
          subject_type: 'thought',
          subject_id: subject.id,
          kind: 'rule',
          schedule: { type: 'weekdays', days: [1] },
          anchor_at: '2030-01-02T09:00:00.000Z',
        });
        assert.equal(rule.isError, undefined, toolText(rule));
        const ruleCard = toolJson<ReminderJson>(rule);
        assert.equal(ruleCard.kind, 'rule');
        assert.equal(ruleCard.anchor_at, '2030-01-07T09:00:00.000Z');

        const changed = events.filter((e) => e.type === 'reminders.changed');
        assert.equal(changed.length, 3, 'одно событие на создание');
        assert.deepEqual(
          changed.map((e) => (e.data as { action: string }).action),
          ['created', 'created', 'created'],
        );
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('etn.reminders.update: каждое значение kind (one/period/rule) заменяет серию', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const subject = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Субъект правки',
        });
        const created = await callOp(handle.client, 'reminders.create', {
          network_id: ctx.networkId,
          subject_type: 'thought',
          subject_id: subject.id,
          kind: 'one',
          schedule: { type: 'once' },
          anchor_at: ANCHOR,
        });
        assert.equal(created.isError, undefined, toolText(created));
        const id = toolJson<ReminderJson>(created).id;

        const patch = async (
          kind: string,
          schedule: Record<string, unknown>,
          anchor_at: string,
        ) => {
          const result = await callOp(handle.client, 'reminders.update', {
            network_id: ctx.networkId,
            reminder_id: id,
            kind,
            schedule,
            anchor_at,
          });
          assert.equal(result.isError, undefined, toolText(result));
          return toolJson<ReminderJson>(result);
        };

        const period = await patch(
          'period',
          { type: 'day_of_month', day: 31, every_months: 1 },
          ANCHOR,
        );
        assert.equal(period.kind, 'period');
        assert.equal(period.anchor_at, '2030-01-31T09:00:00.000Z');

        const rule = await patch('rule', { type: 'yearly', month: 2, day: 29 }, ANCHOR);
        assert.equal(rule.kind, 'rule');

        const one = await patch('one', { type: 'once' }, '2030-02-01T09:00:00.000Z');
        assert.equal(one.kind, 'one');
        assert.equal(one.next_at, '2030-02-01T09:00:00.000Z');
        assert.deepEqual(one.exceptions, {});
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('список раскрывает период, а snooze/dismiss/remove управляют вхождением и серией', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const subject = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Субъект вхождения',
        });
        const created = await callOp(handle.client, 'reminders.create', {
          network_id: ctx.networkId,
          subject_type: 'thought',
          subject_id: subject.id,
          kind: 'period',
          schedule: { type: 'every_days', every: 1 },
          anchor_at: '2030-01-01T09:00:00.000Z',
        });
        assert.equal(created.isError, undefined, toolText(created));
        const id = toolJson<ReminderJson>(created).id;

        const list = await callOp(handle.client, 'reminders.list', {
          network_id: ctx.networkId,
          from: '2030-01-01T00:00:00.000Z',
          to: '2030-01-02T23:59:59.000Z',
        });
        assert.equal(list.isError, undefined, toolText(list));
        const listed = toolJson<{ reminders: ReminderJson[]; from: string; to: string }>(list);
        assert.equal(listed.reminders.length, 1);
        assert.deepEqual(
          listed.reminders[0]?.occurrences?.map((o) => o.occurrence_at),
          ['2030-01-01T09:00:00.000Z', '2030-01-02T09:00:00.000Z'],
        );

        const snoozed = await callOp(handle.client, 'reminders.snooze', {
          network_id: ctx.networkId,
          reminder_id: id,
          until: '2030-01-01T20:00:00.000Z',
        });
        assert.equal(snoozed.isError, undefined, toolText(snoozed));
        const snoozedCard = toolJson<ReminderJson>(snoozed);
        assert.deepEqual(snoozedCard.exceptions, {
          '2030-01-01T09:00:00.000Z': { kind: 'snooze', until: '2030-01-01T20:00:00.000Z' },
        });
        assert.equal(snoozedCard.next_at, '2030-01-01T20:00:00.000Z');

        const dismissed = await callOp(handle.client, 'reminders.dismiss', {
          network_id: ctx.networkId,
          reminder_id: id,
        });
        assert.equal(dismissed.isError, undefined, toolText(dismissed));
        assert.equal(toolJson<ReminderJson>(dismissed).next_at, '2030-01-02T09:00:00.000Z');

        const removed = await callOp(
          handle.client,
          'reminders.remove',
          { network_id: ctx.networkId, reminder_id: id },
          true,
        );
        assert.equal(removed.isError, undefined, toolText(removed));
        assert.equal(toolJson<{ id: string }>(removed).id, id);

        const after = await callOp(handle.client, 'reminders.list', { network_id: ctx.networkId });
        assert.deepEqual(toolJson<{ reminders: ReminderJson[] }>(after).reminders, []);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('snooze/dismiss адресуют occurrence_at — паритет с REST, а не «ближайшее» вхождение', async () => {
    // Регресс приёмки 0.16.1: MCP-обработчики не пробрасывали `occurrence_at`,
    // хотя контракт действия (двойник REST) его объявляет. Клиент панели шлёт
    // адрес ПОКАЗАННОГО вхождения; без него сервер брал ближайшее — команда
    // строки «Отложить» в дальнем вхождении молча трогала не ту строку.
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const subject = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Адрес вхождения MCP',
        });
        const created = await callOp(handle.client, 'reminders.create', {
          network_id: ctx.networkId,
          subject_type: 'thought',
          subject_id: subject.id,
          kind: 'period',
          schedule: { type: 'every_days', every: 1 },
          anchor_at: '2030-01-01T09:00:00.000Z',
        });
        assert.equal(created.isError, undefined, toolText(created));
        const id = toolJson<ReminderJson>(created).id;

        const snoozed = await callOp(handle.client, 'reminders.snooze', {
          network_id: ctx.networkId,
          reminder_id: id,
          until: '2030-01-03T18:00:00.000Z',
          occurrence_at: '2030-01-03T09:00:00.000Z',
        });
        assert.equal(snoozed.isError, undefined, toolText(snoozed));
        const snoozedCard = toolJson<ReminderJson>(snoozed);
        assert.deepEqual(
          snoozedCard.exceptions,
          { '2030-01-03T09:00:00.000Z': { kind: 'snooze', until: '2030-01-03T18:00:00.000Z' } },
          'исключение легло на адресованное вхождение',
        );
        assert.equal(
          snoozedCard.next_at,
          '2030-01-01T09:00:00.000Z',
          'ближайшее вхождение не сдвинулось',
        );

        const dismissed = await callOp(handle.client, 'reminders.dismiss', {
          network_id: ctx.networkId,
          reminder_id: id,
          occurrence_at: '2030-01-02T09:00:00.000Z',
        });
        assert.equal(dismissed.isError, undefined, toolText(dismissed));
        assert.deepEqual(toolJson<ReminderJson>(dismissed).exceptions, {
          '2030-01-03T09:00:00.000Z': { kind: 'snooze', until: '2030-01-03T18:00:00.000Z' },
          '2030-01-02T09:00:00.000Z': { kind: 'dismiss' },
        });
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('ошибки: расхождение kind — VALIDATION_ERROR, чужой субъект — NOT_FOUND, read-only ключ — FORBIDDEN', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const subject = await createThoughtViaWrite(handle.client, ctx.networkId, {
          title: 'Субъект ошибок',
        });

        const mismatch = await callOp(handle.client, 'reminders.create', {
          network_id: ctx.networkId,
          subject_type: 'thought',
          subject_id: subject.id,
          kind: 'period',
          schedule: { type: 'once' },
          anchor_at: ANCHOR,
        });
        assert.equal(mismatch.isError, true);
        assert.match(toolText(mismatch), /does not match schedule\.type/);

        const missing = await callOp(handle.client, 'reminders.create', {
          network_id: ctx.networkId,
          subject_type: 'thought',
          subject_id: 'нет-такой',
          kind: 'one',
          schedule: { type: 'once' },
          anchor_at: ANCHOR,
        });
        assert.equal(missing.isError, true);
        assert.match(toolText(missing), /NOT_FOUND/);
      } finally {
        await handle.close();
      }

      // Ключ только для чтения: запись отвергается до домена.
      const readOnly = await connectMcpClient(ctx, ctx.readOnlyKey);
      try {
        const denied = await callOp(readOnly.client, 'reminders.create', {
          network_id: ctx.networkId,
          subject_type: 'thought',
          subject_id: ctx.homeId,
          kind: 'one',
          schedule: { type: 'once' },
          anchor_at: ANCHOR,
        });
        assert.equal(denied.isError, true);
        assert.match(toolText(denied), /FORBIDDEN/);
      } finally {
        await readOnly.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });

  it('справочник: темы reminders и reminders.<action> описывают те же контракты', async () => {
    const ctx = await buildMcpContext();
    try {
      const handle = await connectMcpClient(ctx, ctx.adminKey);
      try {
        const overview = await handle.client.callTool({
          name: 'etn.guide',
          arguments: { topic: 'reminders' },
        });
        assert.equal(overview.isError, undefined, toolText(overview));
        const text = toolText(overview);
        assert.match(text, /Repeat grammar \(closed\)/);
        assert.match(text, /next_at/);
        assert.match(text, /subject visibility/iu);

        for (const action of [
          'reminders.list',
          'reminders.create',
          'reminders.update',
          'reminders.snooze',
          'reminders.dismiss',
          'reminders.remove',
        ]) {
          const topic = await handle.client.callTool({
            name: 'etn.guide',
            arguments: { topic: action },
          });
          assert.equal(topic.isError, undefined, `${action}: ${toolText(topic)}`);
          assert.match(toolText(topic), /## params/);
        }

        // Классификация обслуживания: список читающий, удаление — разрушающее.
        assert.equal(OPS_ACTIONS_BY_NAME.get('reminders.list')?.readOnly, true);
        assert.equal(OPS_ACTIONS_BY_NAME.get('reminders.remove')?.destructive, true);
      } finally {
        await handle.close();
      }
    } finally {
      await closeMcpContext(ctx);
    }
  });
});
