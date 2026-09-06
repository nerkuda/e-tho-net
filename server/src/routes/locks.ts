/**
 * Object-locks REST routes (task 2031df5e, операция 8919b057 «/locks»,
 * docs/03-server-api.md §13c).
 *
 *   POST   /api/v1/networks/:nid/locks        acquire (идемпотентно для своего)
 *   DELETE /api/v1/networks/:nid/locks/:lock_id  release (только владелец)
 *   GET    /api/v1/networks/:nid/locks        list (фильтры ?user_id&client_id)
 *   POST   /api/v1/networks/:nid/locks/clear  { user_id } — ручной сброс
 *
 * Все четыре маршрута доступны любому участнику сети (требование 9ac48831 —
 * «равноправие»; клиент «Участники мыслесети» использует это для команды
 * «Снять все блокировки»).
 *
 * События real-time (`edit.acquired` / `edit.released` / `edit.cleared`)
 * эмитятся в тот же момент, когда меняется состояние таблицы `object_locks`,
 * — после успешной мутации и до ответа клиенту, чтобы клиент и его соседи
 * увидели новое состояние согласованно с REST-ответом.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
  EtnError,
  type EditAcquiredData,
  type EditClearedData,
  type EditReleasedData,
} from '@etn/shared';

import { sendList, sendSuccess } from '../http/responses.js';
import {
  acquireLock,
  clearLocksForUser,
  listLocks,
  releaseLock,
  type LockRow,
} from '../domain/lock-service.js';
import {
  openRouteNetworkDb,
  queryStrings,
  requestBody,
  type RouteDeps,
} from './helpers.js';

/** Route params for `:networkId`. */
interface NetworkIdParams {
  networkId: string;
}

/** Route params for the DELETE-by-lock-id variant. */
interface LockIdParams extends NetworkIdParams {
  lockId: string;
}

/** `/api/v1/networks*` locks routes plugin factory. */
export function createLocksRoutes(deps: RouteDeps): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireNetworkMember } = app.accessControl;

    // -------------------------------------------------------------------------
    // POST /api/v1/networks/:nid/locks — acquire
    // -------------------------------------------------------------------------
    app.post(
      '/networks/:networkId/locks',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const auth = req.auth!;
        const body = requestBody(req);
        const entityType = stringField(body, 'entity_type', req.id);
        const entityId = stringField(body, 'entity_id', req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const lock = acquireLock(ndb, {
          entityType,
          entityId,
          userId: auth.user.id,
          clientId: auth.clientId,
        });
        emitEditAcquired(deps, req, networkId, auth.user.id, auth.clientId, lock);
        sendSuccess(reply, lock, { request_id: req.id });
      },
    );

    // -------------------------------------------------------------------------
    // DELETE /api/v1/networks/:nid/locks/:lockId — release
    // -------------------------------------------------------------------------
    app.delete(
      '/networks/:networkId/locks/:lockId',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId, lockId } = req.params as LockIdParams;
        const auth = req.auth!;
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const released = releaseLock(ndb, lockId, auth.user.id);
        emitEditReleased(deps, req, networkId, released);
        // 204 — успешный release без тела.
        void reply.code(204).send();
      },
    );

    // -------------------------------------------------------------------------
    // GET /api/v1/networks/:nid/locks — list (?user_id=…&client_id=…)
    // -------------------------------------------------------------------------
    app.get(
      '/networks/:networkId/locks',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const q = req.query as Record<string, unknown>;
        const userIds = queryStrings(q['user_id']);
        const clientIds = queryStrings(q['client_id']);
        if (userIds.length > 1 || clientIds.length > 1) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'user_id и client_id принимают ровно одно значение.',
            { field: 'user_id|client_id' },
            req.id,
          );
        }
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const locks = listLocks(ndb, {
          userId: userIds[0] ?? null,
          clientId: clientIds[0] ?? null,
        });
        sendList(reply, locks, locks.length, 0, locks.length);
      },
    );

    // -------------------------------------------------------------------------
    // POST /api/v1/networks/:nid/locks/clear — manual reset for a participant
    // -------------------------------------------------------------------------
    app.post(
      '/networks/:networkId/locks/clear',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const body = requestBody(req);
        const targetUserId = stringField(body, 'user_id', req.id);
        const ndb = openRouteNetworkDb(deps, req, networkId, app.appLogger);
        const removed = clearLocksForUser(ndb, targetUserId);
        for (const lock of removed) {
          emitEditCleared(deps, req, networkId, lock, 'manual');
        }
        sendSuccess(reply, { cleared: removed.length }, { request_id: req.id });
      },
    );
  };
}

// ---------------------------------------------------------------------------
// Event-emission helpers
// ---------------------------------------------------------------------------

/** Emit `edit.acquired` for `lock` (caller has already inserted the row). */
function emitEditAcquired(
  deps: RouteDeps,
  req: FastifyRequest,
  networkId: string,
  userId: string,
  clientId: string | null,
  lock: LockRow,
): void {
  const data: EditAcquiredData = {
    entity_type: lock.entity_type,
    entity_id: lock.entity_id,
    lock_id: lock.id,
    user_id: userId,
    client_id: clientId,
    acquired_at_ms: lock.acquired_at_ms,
  };
  // Аудитория — network: индикацию должны увидеть все участники сети.
  deps.emit(req, networkId, 'edit.acquired', data);
}

/** Emit `edit.released` for a lock the owner just dropped. */
function emitEditReleased(
  deps: RouteDeps,
  req: FastifyRequest,
  networkId: string,
  lock: LockRow,
): void {
  const data: EditReleasedData = {
    entity_type: lock.entity_type,
    entity_id: lock.entity_id,
    lock_id: lock.id,
    user_id: lock.user_id,
    client_id: lock.client_id,
  };
  deps.emit(req, networkId, 'edit.released', data);
}

/** Emit `edit.cleared` for a server-side reset (reason in `data.reason`). */
function emitEditCleared(
  deps: RouteDeps,
  req: FastifyRequest,
  networkId: string,
  lock: LockRow,
  reason: EditClearedData['reason'],
): void {
  const data: EditClearedData = {
    entity_type: lock.entity_type,
    entity_id: lock.entity_id,
    lock_id: lock.id,
    user_id: lock.user_id,
    client_id: lock.client_id,
    reason,
  };
  deps.emit(req, networkId, 'edit.cleared', data);
}

/** Read a required string field, throw `VALIDATION_ERROR` when absent. */
function stringField(obj: Record<string, unknown>, key: string, requestId: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `${key} обязателен и должен быть непустой строкой.`,
      { field: key },
      requestId,
    );
  }
  return v;
}
