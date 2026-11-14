/**
 * actions `reminders.*` исполнителя `etn.ops` (0.16.1, задача b47f1fd2,
 * операция 22f1ea95; сущность 62e6787b, ADR 03e429ed).
 *
 * Паритет MCP-контура с REST без роста ростера инструментов: новых
 * MCP-инструментов не появляется, реестр действий — `tools/ops-catalog.ts`,
 * темы справочника — там же (`reminders` и `<действие>`). Обработчики — ТЕ ЖЕ
 * доменные функции, что REST (`routes/reminders.ts`): валидация, коды ошибок и
 * события совпадают, потому что контракты общие (`contracts.ts`).
 *
 * Чтение — без записи и без write-бюджета (действие `readOnly`);
 * `reminders.list` ничего не пишет, ленивое продвижение `next_at` считается в
 * домене на чтении. Мутации идут через `runWrite` (ADR 162d8e7a): события
 * `reminders.changed` (audience=user), журнал и аудит собирает обёртка.
 */

import { z } from 'zod';

import type { ReminderSubjectType } from '@etn/shared';

import {
  mcpWriteFx,
  openMemberNetwork,
  requireWritable,
  requireWriteBudget,
  runTool,
  runWrite,
  runWriteTool,
  showInactiveFor,
} from '../context.js';
import {
  createReminder,
  dismissReminder,
  listReminders,
  removeReminder,
  snoozeReminder,
  updateReminder,
} from '../../domain/reminder-service.js';
import {
  McpReminderCreate,
  McpReminderDismiss,
  McpReminderList,
  McpReminderRemove,
  McpReminderSnooze,
  McpReminderUpdate,
} from '../../contracts.js';
import type { OpHandler } from './ops.js';

/** Все шесть действий семейства `reminders.*`. */
export const REMINDER_OPS_HANDLERS: Record<string, OpHandler> = {
  'reminders.list': (rt, p) => {
    const a = p as unknown as z.infer<typeof McpReminderList.schema>;
    return runTool(() => {
      const ndb = openMemberNetwork(rt, a.network_id);
      return listReminders(ndb, rt.deps.auth.userId, {
        ...(a.from !== undefined ? { from: a.from } : {}),
        ...(a.to !== undefined ? { to: a.to } : {}),
        ...(a.horizon_days !== undefined ? { horizon_days: a.horizon_days } : {}),
        ...(a.subject_type !== undefined
          ? { subject_type: a.subject_type as ReminderSubjectType }
          : {}),
        ...(a.subject_id !== undefined ? { subject_id: a.subject_id } : {}),
        show_inactive: showInactiveFor(rt, a.network_id),
      });
    });
  },

  'reminders.create': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpReminderCreate.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const created = runWrite(ndb, fx, () => {
        const reminder = createReminder(ndb, rt.deps.auth.userId, {
          subject_type: a.subject_type as ReminderSubjectType,
          subject_id: a.subject_id,
          kind: a.kind,
          schedule: a.schedule,
          anchor_at: a.anchor_at,
        });
        return {
          result: reminder,
          events: [
            {
              type: 'reminders.changed' as const,
              data: {
                action: 'created' as const,
                reminder_id: reminder.id,
                reminder,
              },
              options: { audience: 'user' as const },
            },
          ],
          audit: {
            action: 'etn.reminders.create',
            targetType: 'reminder',
            targetId: reminder.id,
            details: {
              subject_type: reminder.subject_type,
              subject_id: reminder.subject_id,
              kind: reminder.kind,
            },
          },
        };
      });
      return { ...created, request_id: String(extra.requestId) };
    });
  },

  'reminders.update': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpReminderUpdate.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const updated = runWrite(ndb, fx, () => {
        const reminder = updateReminder(ndb, rt.deps.auth.userId, a.reminder_id, {
          ...(a.kind !== undefined ? { kind: a.kind } : {}),
          ...(a.schedule !== undefined ? { schedule: a.schedule } : {}),
          ...(a.anchor_at !== undefined ? { anchor_at: a.anchor_at } : {}),
        });
        return {
          result: reminder,
          events: [
            {
              type: 'reminders.changed' as const,
              data: {
                action: 'updated' as const,
                reminder_id: reminder.id,
                reminder,
              },
              options: { audience: 'user' as const },
            },
          ],
          audit: {
            action: 'etn.reminders.update',
            targetType: 'reminder',
            targetId: reminder.id,
            details: { kind: reminder.kind, schedule: reminder.schedule },
          },
        };
      });
      return { ...updated, request_id: String(extra.requestId) };
    });
  },

  'reminders.remove': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpReminderRemove.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const removed = runWrite(ndb, fx, () => {
        const reminder = removeReminder(ndb, rt.deps.auth.userId, a.reminder_id);
        return {
          result: reminder,
          events: [
            {
              type: 'reminders.changed' as const,
              data: { action: 'removed' as const, reminder_id: reminder.id },
              options: { audience: 'user' as const },
            },
          ],
          audit: {
            action: 'etn.reminders.remove',
            targetType: 'reminder',
            targetId: reminder.id,
            details: {
              subject_type: reminder.subject_type,
              subject_id: reminder.subject_id,
            },
          },
        };
      });
      return { id: removed.id, request_id: String(extra.requestId) };
    });
  },

  'reminders.snooze': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpReminderSnooze.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const reminder = runWrite(ndb, fx, () => {
        const change = snoozeReminder(
          ndb,
          rt.deps.auth.userId,
          a.reminder_id,
          a.until,
          Date.now(),
          a.occurrence_at,
        );
        return {
          result: change.reminder,
          events: [
            {
              type: 'reminders.changed' as const,
              data: {
                action: 'snoozed' as const,
                reminder_id: change.reminder.id,
                reminder: change.reminder,
                occurrence_at: change.occurrence_at,
              },
              options: { audience: 'user' as const },
            },
          ],
          audit: {
            action: 'etn.reminders.snooze',
            targetType: 'reminder',
            targetId: change.reminder.id,
            details: { occurrence_at: change.occurrence_at, until: a.until },
          },
        };
      });
      return { ...reminder, request_id: String(extra.requestId) };
    });
  },

  'reminders.dismiss': (rt, p, extra) => {
    const a = p as unknown as z.infer<typeof McpReminderDismiss.schema>;
    return runWriteTool(rt, a.network_id, () => {
      requireWritable(rt);
      requireWriteBudget(rt);
      const ndb = openMemberNetwork(rt, a.network_id);
      const fx = mcpWriteFx(rt, a.network_id, extra.requestId);
      const reminder = runWrite(ndb, fx, () => {
        const change = dismissReminder(
          ndb,
          rt.deps.auth.userId,
          a.reminder_id,
          Date.now(),
          a.occurrence_at,
        );
        return {
          result: change.reminder,
          events: [
            {
              type: 'reminders.changed' as const,
              data: {
                action: 'dismissed' as const,
                reminder_id: change.reminder.id,
                reminder: change.reminder,
                occurrence_at: change.occurrence_at,
              },
              options: { audience: 'user' as const },
            },
          ],
          audit: {
            action: 'etn.reminders.dismiss',
            targetType: 'reminder',
            targetId: change.reminder.id,
            details: { occurrence_at: change.occurrence_at },
          },
        };
      });
      return { ...reminder, request_id: String(extra.requestId) };
    });
  },
};
