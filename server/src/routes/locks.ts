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
 *
 * Веха 8 (задача c9d5f21e): вход — единые контракты из `contracts.ts`
 * (та же валидация, что у MCP `etn.locks.*`).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import {
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
import { openRouteNetworkDb, type RouteDeps } from './helpers.js';
import { LocksAcquire, LocksClear, LocksList, LocksRelease, parseRest } from '../contracts.js';

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
        const input = parseRest(LocksAcquire, req);
        const auth = req.auth!;
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const lock = acquireLock(ndb, {
          entityType: input.entity_type,
          entityId: input.entity_id,
          userId: auth.user.id,
          clientId: auth.clientId,
        });
        emitEditAcquired(deps, req, input.network_id, auth.user.id, auth.clientId, lock);
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
        const input = parseRest(LocksRelease, req);
        const auth = req.auth!;
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const released = releaseLock(ndb, input.lock_id, auth.user.id);
        emitEditReleased(deps, req, input.network_id, released);
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
        const input = parseRest(LocksList, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const locks = listLocks(ndb, {
          userId: input.user_id ?? null,
          clientId: input.client_id ?? null,
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
        const input = parseRest(LocksClear, req);
        const ndb = openRouteNetworkDb(deps, req, input.network_id, app.appLogger);
        const removed = clearLocksForUser(ndb, input.user_id);
        for (const lock of removed) {
          emitEditCleared(deps, req, input.network_id, lock, 'manual');
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
