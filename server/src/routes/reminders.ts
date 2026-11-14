/**
 * Маршруты напоминаний (0.16.1, задача b47f1fd2; операции ae19b1bf, 500d1b3d;
 * сущность 62e6787b, ADR 03e429ed).
 *
 *   POST   /networks/:networkId/reminders               — создать
 *   GET    /networks/:networkId/reminders               — список владельца на период
 *   PATCH  /networks/:networkId/reminders/:id           — изменить расписание
 *   DELETE /networks/:networkId/reminders/:id           — удалить
 *   POST   /networks/:networkId/reminders/:id/snooze    — отложить вхождение
 *   POST   /networks/:networkId/reminders/:id/dismiss   — убрать вхождение
 *
 * Напоминание персонально: владелец — вызывающий пользователь, чужая строка
 * отвечает 403. `reminders` не ветвится по слоям, поэтому сессионный слой
 * влияет только на видимость субъекта (мысль/публикация ищется в контексте
 * слоя). Мутации идут через `runWrite` (ADR 162d8e7a): события
 * `reminders.changed` (audience=user), журнал и аудит собирает обёртка.
 *
 * `GET` читает настройку сети `show_inactive` («Показывать неактуальные мысли и
 * связи») и ничего не пишет: ленивое продвижение `next_at` считается в домене
 * на каждом чтении и сохраняется только записями (guard-maintenance-parity —
 * GET обязан быть читающим безусловно).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { PREF_KEY, type ReminderDeleteResult, type ReminderSubjectType } from '@etn/shared';

import { sendSuccess } from '../http/responses.js';
import { openRouteNetworkDb, restWriteFx, runWrite, type RouteDeps } from './helpers.js';
import {
  createReminder,
  dismissReminder,
  listReminders,
  removeReminder,
  snoozeReminder,
  updateReminder,
} from '../domain/reminder-service.js';
import {
  parseRest,
  RestReminderCreate,
  RestReminderDelete,
  RestReminderDismiss,
  RestReminderList,
  RestReminderSnooze,
  RestReminderUpdate,
} from '../contracts.js';

/**
 * Настройка сети «Показывать неактуальные мысли и связи в этой сети»
 * (PREF_KEY.SHOW_INACTIVE, по умолчанию выключена). Решение 2026-11-12:
 * неактуальный субъект показывается серым при включённой настройке и скрыт при
 * выключенной; на срабатывание это не влияет.
 */
function showInactiveFor(app: FastifyInstance, userId: string, networkId: string): boolean {
  const pref = app.systemDb.getNetworkPreference(userId, networkId, PREF_KEY.SHOW_INACTIVE);
  return pref?.value === true;
}

/** `/api/v1/networks*` reminders routes plugin factory. */
export function createRemindersRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    app.post(
      '/networks/:networkId/reminders',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestReminderCreate, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const reminder = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const created = createReminder(ndb, req.auth!.user.id, {
            subject_type: input.subject_type as ReminderSubjectType,
            subject_id: input.subject_id,
            kind: input.kind,
            schedule: input.schedule,
            anchor_at: input.anchor_at,
          });
          return {
            result: created,
            events: [
              {
                type: 'reminders.changed' as const,
                data: {
                  action: 'created' as const,
                  reminder_id: created.id,
                  reminder: created,
                },
                options: { audience: 'user' as const },
              },
            ],
          };
        });
        sendSuccess(reply, reminder, { request_id: req.id }, 201);
      },
    );

    app.get(
      '/networks/:networkId/reminders',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestReminderList, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const result = listReminders(ndb, req.auth!.user.id, {
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.to !== undefined ? { to: input.to } : {}),
          ...(input.horizon_days !== undefined ? { horizon_days: input.horizon_days } : {}),
          ...(input.subject_type !== undefined
            ? { subject_type: input.subject_type as ReminderSubjectType }
            : {}),
          ...(input.subject_id !== undefined ? { subject_id: input.subject_id } : {}),
          show_inactive: showInactiveFor(app, req.auth!.user.id, input.network_id),
        });
        sendSuccess(reply, result, { request_id: req.id });
      },
    );

    app.patch(
      '/networks/:networkId/reminders/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestReminderUpdate, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const reminder = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const updated = updateReminder(ndb, req.auth!.user.id, input.reminder_id, {
            ...(input.kind !== undefined ? { kind: input.kind } : {}),
            ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
            ...(input.anchor_at !== undefined ? { anchor_at: input.anchor_at } : {}),
          });
          return {
            result: updated,
            events: [
              {
                type: 'reminders.changed' as const,
                data: {
                  action: 'updated' as const,
                  reminder_id: updated.id,
                  reminder: updated,
                },
                options: { audience: 'user' as const },
              },
            ],
          };
        });
        sendSuccess(reply, reminder, { request_id: req.id });
      },
    );

    app.delete(
      '/networks/:networkId/reminders/:id',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestReminderDelete, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const removed = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const reminder = removeReminder(ndb, req.auth!.user.id, input.reminder_id);
          return {
            result: reminder,
            events: [
              {
                type: 'reminders.changed' as const,
                data: {
                  action: 'removed' as const,
                  reminder_id: reminder.id,
                },
                options: { audience: 'user' as const },
              },
            ],
          };
        });
        sendSuccess(reply, { id: removed.id } satisfies ReminderDeleteResult, {
          request_id: req.id,
        });
      },
    );

    app.post(
      '/networks/:networkId/reminders/:id/snooze',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestReminderSnooze, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const change = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const updated = snoozeReminder(ndb, req.auth!.user.id, input.reminder_id, input.until);
          return {
            result: updated,
            events: [
              {
                type: 'reminders.changed' as const,
                data: {
                  action: 'snoozed' as const,
                  reminder_id: updated.reminder.id,
                  reminder: updated.reminder,
                  occurrence_at: updated.occurrence_at,
                },
                options: { audience: 'user' as const },
              },
            ],
          };
        });
        sendSuccess(reply, change, { request_id: req.id });
      },
    );

    app.post(
      '/networks/:networkId/reminders/:id/dismiss',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestReminderDismiss, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const change = runWrite(ndb, restWriteFx(deps, req, input.network_id), () => {
          const updated = dismissReminder(ndb, req.auth!.user.id, input.reminder_id);
          return {
            result: updated,
            events: [
              {
                type: 'reminders.changed' as const,
                data: {
                  action: 'dismissed' as const,
                  reminder_id: updated.reminder.id,
                  reminder: updated.reminder,
                  occurrence_at: updated.occurrence_at,
                },
                options: { audience: 'user' as const },
              },
            ],
          };
        });
        sendSuccess(reply, change, { request_id: req.id });
      },
    );
  };
}
