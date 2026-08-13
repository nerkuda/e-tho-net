/**
 * Admin network routes (task D7, 03-server-api.md §4.2).
 *
 *   GET   /admin/networks                       — every network on the server
 *   DELETE /admin/networks/:id                  — remove a network (admin)
 *   PATCH  /admin/networks/:id/members/:uid     — force membership changes
 *
 * All routes require `requireAdmin`. Deletion emits `network.deleted` **before**
 * the registry row is removed: `network_seq`/`event_log` rows reference the
 * network, so the event must be persisted while the row still exists
 * (04-realtime.md §4.6, task E3 handoff).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';

import { EtnError, type NetworkRole } from '@etn/shared';

import { sendList, sendSuccess } from '../http/responses.js';
import { fieldString, requestBody } from './helpers.js';
import { emitDomainEvent } from '../realtime/emit.js';
import type { NetworkService } from '../domain/network-service.js';

interface NetworkIdParams {
  id: string;
}

interface MemberParams {
  id: string;
  uid: string;
}

/** Admin network routes factory. */
export function createAdminNetworksRoutes(networkService: NetworkService): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireAdmin } = app.accessControl;

    app.get(
      '/admin/networks',
      { preHandler: [app.authPreHandler, requireAdmin] },
      async (_req, reply) => {
        const data = app.systemDb.listAllNetworks();
        sendList(reply, data, data.length, 0, data.length);
      },
    );

    app.delete(
      '/admin/networks/:id',
      { preHandler: [app.authPreHandler, requireAdmin, app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { id } = req.params as NetworkIdParams;
        const existing = app.systemDb.getNetworkById(id);
        if (!existing) {
          throw new EtnError('NOT_FOUND', 'Сеть не найдена.', { id }, req.id);
        }

        // Emit before the registry row is gone (network_seq/event_log FK).
        emitDomainEvent(
          { systemDb: app.systemDb, pubsub: app.pubsub },
          id,
          'network.deleted',
          { id },
          { user_id: req.auth!.user.id, client_id: req.auth?.clientId ?? null },
          { meta: { request_id: req.id } },
        );

        await networkService.deleteNetwork(id);

        app.systemDb.insertAuditLog({
          actorUserId: req.auth!.user.id,
          networkId: id,
          category: 'network',
          action: 'delete',
          targetType: 'network',
          targetId: id,
          details: { by_admin: true },
        });
        reply.code(204).send();
      },
    );

    app.patch(
      '/admin/networks/:id/members/:uid',
      { preHandler: [app.authPreHandler, requireAdmin, app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { id, uid } = req.params as MemberParams;
        const role = fieldString(requestBody(req) as Record<string, unknown>, 'role', req.id);
        if (role !== 'owner' && role !== 'member') {
          throw new EtnError(
            'VALIDATION_ERROR',
            'role должен быть owner или member.',
            { field: 'role' },
            req.id,
          );
        }
        const current = app.systemDb.getMemberRole(uid, id);
        if (current === null) {
          throw new EtnError(
            'NOT_FOUND',
            'Пользователь не является участником сети.',
            { id, uid },
            req.id,
          );
        }
        const target = role as NetworkRole;
        if (target === 'owner') {
          if (current === 'owner') {
            // Already the owner — nothing to change.
            sendSuccess(reply, { network_id: id, user_id: uid, role: target });
            return;
          }
          const network = app.systemDb.getNetworkById(id);
          if (!network) {
            throw new EtnError('NOT_FOUND', 'Сеть не найдена.', { id }, req.id);
          }
          // Old owner drops to member, new owner promoted — one transaction.
          app.systemDb.transferNetworkOwnership(id, network.owner_id, uid);
        } else {
          // role = member; an owner cannot be demoted without a transfer first.
          if (current === 'owner') {
            throw new EtnError(
              'VALIDATION_ERROR',
              'Нельзя понизить владельца; сначала передайте владение.',
              { id, uid },
              req.id,
            );
          }
          // member→member is a no-op.
        }

        app.systemDb.insertAuditLog({
          actorUserId: req.auth!.user.id,
          networkId: id,
          category: 'membership',
          action: 'grant',
          targetType: 'user',
          targetId: uid,
          details: { role: target, by_admin: true },
        });
        sendSuccess(reply, { network_id: id, user_id: uid, role: target });
      },
    );
  };
}
