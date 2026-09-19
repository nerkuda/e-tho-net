/**
 * Networks, membership and server-side preferences routes (task B13,
 * 03-server-api.md §5, 06-auth.md §4).
 *
 *   GET    /networks                                  — networks the user belongs to
 *   POST   /networks                                  — create (owner = caller) [stub: C10]
 *   GET    /networks/:networkId                       — fetch one
 *   PATCH  /networks/:networkId                       — update name/description (owner|admin)
 *   GET    /networks/:networkId/members               — list members
 *   POST   /networks/:networkId/members               — add member (owner|admin)
 *   DELETE /networks/:networkId/members/:uid          — remove member (owner|admin)
 *   PATCH  /networks/:networkId/members/:uid          — transfer ownership (owner|admin)
 *   GET    /networks/:networkId/preferences           — list preferences
 *   PUT    /networks/:networkId/preferences/:key      — set a preference (show_inactive)
 *
 * Membership management is gated by "owner OR admin"; reading network data and
 * setting one's own preferences requires any membership — except a global
 * admin, who passes `requireNetworkMember` for every network regardless of an
 * explicit `network_members` row (06-auth.md §4.1, task 0.4.2 bug-fix). Real
 * network creation (directory + data.db + HOME) is delegated to
 * {@link NetworkService} (task C10).
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import type {
  AddMemberInput,
  CreateNetworkInput,
  Network,
  NetworkMember,
  UpdateMemberInput,
  UpdateNetworkInput,
} from '@etn/shared';

import { EtnError, PREF_KEY, validateTypeRoles } from '@etn/shared';

import type { NetworkService } from '../domain/network-service.js';
import {
  parseRest,
  RestNetworkById,
  RestNetworkCreate,
  RestNetworkMemberAdd,
  RestNetworkMemberById,
  RestNetworkMemberPatch,
  RestNetworkPreferenceKey,
} from '../contracts.js';
import { updateNetwork } from '../domain/network-write-service.js';
import { sendEtnError } from '../http/errors.js';
import { sendCreated, sendList, sendSuccess } from '../http/responses.js';
import { emitDomainEvent } from '../realtime/emit.js';

/** Route params carrying a network id. */
interface NetworkIdParams {
  networkId: string;
}

/** Route params for a network + target member. */
interface MemberParams {
  networkId: string;
  uid: string;
}

/** Route params for a preference key. */
interface PreferenceKeyParams {
  networkId: string;
  key: string;
}

/** Keys accepted by `PUT /networks/:id/preferences/:key` (11-settings-and-state.md §2.1 L3). */
const SUPPORTED_PREFERENCE_KEYS = new Set<string>([
  PREF_KEY.SHOW_INACTIVE,
  PREF_KEY.CANVAS_LINK_FILTER,
]);

/** Build the public member DTO from a joined row. */
function memberDto(m: NetworkMember & { username: string; display_name: string | null }) {
  return {
    network_id: m.network_id,
    user_id: m.user_id,
    role: m.role,
    added_at: m.added_at,
    added_by: m.added_by,
    username: m.username,
    display_name: m.display_name,
  };
}

/** Build the network DTO returned by GET / POST / PATCH. */
function networkDto(n: Network) {
  return {
    id: n.id,
    display_name: n.display_name,
    owner_id: n.owner_id,
    description: n.description,
    when_to_use: n.when_to_use,
    conventions: n.conventions,
    examples: n.examples,
    type_roles: n.type_roles,
    has_structure: typeof n.type_roles.table_of_contents === 'string',
    created_at: n.created_at,
    updated_at: n.updated_at,
  };
}

/**
 * Guard: the caller must be the network owner OR a system admin. Assumes
 * `requireNetworkMember` has already run (so the caller is at least a member,
 * or a global admin who bypasses membership entirely — 06-auth.md §4.1).
 * Replies 403 and returns `false` when unauthorised.
 */
async function requireOwnerOrAdmin(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  networkId: string,
): Promise<boolean> {
  const auth = req.auth!;
  if (auth.user.is_admin) {
    return true;
  }
  const role = app.members.getMemberRole(auth.user.id, networkId);
  if (role !== 'owner') {
    sendEtnError(
      reply,
      'FORBIDDEN',
      'Требуются права владельца сети или администратора.',
      undefined,
      req.id,
    );
    return false;
  }
  return true;
}

/** `/api/v1/networks*` route plugin factory (takes the NetworkService impl). */
export function createNetworksRoutes(networkService: NetworkService): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const { requireAuth, requireNetworkMember } = app.accessControl;

    app.get('/networks', { preHandler: [app.authPreHandler, requireAuth] }, async (req, reply) => {
      const data = app.systemDb.listNetworksForUser(req.auth!.user.id);
      sendList(reply, data, data.length, 0, data.length);
    });

    app.post(
      '/networks',
      { preHandler: [app.authPreHandler, requireAuth, app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestNetworkCreate, req);
        const displayName = (input.display_name as string).trim();
        const description = (input.description ?? null) as string | null;
        const typeRoles =
          input.type_roles !== undefined
            ? validateTypeRoles(input.type_roles as Record<string, unknown>)
            : {};

        // Real creation (directory + data.db + HOME) is delegated to NetworkService.
        // The stub throws "Not implemented: see task C10" until C10 lands.
        let network: Network;
        try {
          network = await networkService.createNetwork(
            req.auth!.user.id,
            displayName,
            description,
            typeRoles,
          );
        } catch (err) {
          throw new EtnError('INTERNAL', (err as Error).message, undefined, req.id);
        }
        app.systemDb.insertAuditLog({
          actorUserId: req.auth!.user.id,
          networkId: network.id,
          category: 'network',
          action: 'network.create',
          targetType: 'network',
          targetId: network.id,
          details: { display_name: displayName, type_roles: typeRoles },
        });
        sendCreated(reply, networkDto(network));
      },
    );

    app.get(
      '/networks/:networkId',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestNetworkById, req);
        const network = app.systemDb.getNetworkById(input.network_id);
        if (network === null) {
          throw new EtnError('NOT_FOUND', 'Сеть не найдена.', undefined, req.id);
        }
        sendSuccess(reply, networkDto(network));
      },
    );

    app.patch(
      '/networks/:networkId',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestNetworkById, req);
        const networkId = input.network_id;
        if (!(await requireOwnerOrAdmin(app, req, reply, networkId))) {
          return;
        }
        const network = app.systemDb.getNetworkById(networkId);
        if (network === null) {
          throw new EtnError('NOT_FOUND', 'Сеть не найдена.', undefined, req.id);
        }
        // Единая доменная реализация патча (ADR 8c93f03a): мерж полей,
        // валидация type_roles, запись, audit_log и список изменений.
        const { network: updated, changes } = updateNetwork(
          app.systemDb,
          networkService,
          network,
          (req.body ?? {}) as UpdateNetworkInput,
          { userId: req.auth!.user.id },
        );
        // Real-time (E3, 04-realtime.md §4.6): broadcast only changed fields.
        if (Object.keys(changes).length > 0) {
          emitDomainEvent(
            { systemDb: app.systemDb, pubsub: app.pubsub },
            networkId,
            'network.updated',
            changes,
            { user_id: req.auth!.user.id, client_id: req.auth!.clientId },
            { meta: { request_id: req.id } },
          );
        }
        sendSuccess(reply, networkDto(updated));
      },
    );

    app.get(
      '/networks/:networkId/members',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestNetworkById, req);
        const members = app.systemDb.listNetworkMembers(input.network_id);
        sendList(reply, members.map(memberDto), members.length, 0, members.length);
      },
    );

    app.post(
      '/networks/:networkId/members',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestNetworkMemberAdd, req);
        const networkId = input.network_id;
        if (!(await requireOwnerOrAdmin(app, req, reply, networkId))) {
          return;
        }
        const userId = input.user_id.trim();
        const target = app.systemDb.getUserById(userId);
        if (target === null) {
          throw new EtnError('NOT_FOUND', `Пользователь ${userId} не найден.`, undefined, req.id);
        }
        if (app.members.isMember(userId, networkId)) {
          throw new EtnError(
            'DUPLICATE',
            'Пользователь уже является участником сети.',
            undefined,
            req.id,
          );
        }
        const addedBy = req.auth!.user.id;
        app.systemDb.addNetworkMember(networkId, userId, 'member', addedBy);
        app.members.invalidate(userId, networkId);
        app.systemDb.insertAuditLog({
          actorUserId: addedBy,
          networkId,
          category: 'membership',
          action: 'member.add',
          targetType: 'user',
          targetId: userId,
        });
        // Real-time (E3, 04-realtime.md §4.6): existing members see the new one.
        emitDomainEvent(
          { systemDb: app.systemDb, pubsub: app.pubsub },
          networkId,
          'member.added',
          { user_id: userId, role: 'member', added_by: addedBy },
          { user_id: addedBy, client_id: req.auth!.clientId },
          { meta: { request_id: req.id } },
        );
        sendCreated(reply, { network_id: networkId, user_id: userId, role: 'member' });
      },
    );

    app.delete(
      '/networks/:networkId/members/:uid',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestNetworkMemberById, req);
        const { network_id: networkId, uid } = input;
        if (!(await requireOwnerOrAdmin(app, req, reply, networkId))) {
          return;
        }
        const role = app.members.getMemberRole(uid, networkId);
        if (role === null) {
          throw new EtnError('NOT_FOUND', 'Участник не найден.', undefined, req.id);
        }
        if (role === 'owner') {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Владелец не может покинуть сеть — сначала передайте владение.',
            undefined,
            req.id,
          );
        }
        const removed = app.systemDb.removeNetworkMember(networkId, uid);
        if (removed === 0) {
          throw new EtnError('NOT_FOUND', 'Участник не найден.', undefined, req.id);
        }
        app.members.invalidate(uid, networkId);
        app.systemDb.insertAuditLog({
          actorUserId: req.auth!.user.id,
          networkId,
          category: 'membership',
          action: 'member.remove',
          targetType: 'user',
          targetId: uid,
        });
        // Real-time (E3, 04-realtime.md §4.6): if the removed user is the
        // current one, clients close the network locally.
        emitDomainEvent(
          { systemDb: app.systemDb, pubsub: app.pubsub },
          networkId,
          'member.removed',
          { user_id: uid },
          { user_id: req.auth!.user.id, client_id: req.auth!.clientId },
          { meta: { request_id: req.id } },
        );
        reply.code(204).send();
      },
    );

    app.patch(
      '/networks/:networkId/members/:uid',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestNetworkMemberPatch, req);
        const { network_id: networkId, uid } = input;
        if (!(await requireOwnerOrAdmin(app, req, reply, networkId))) {
          return;
        }
        if (!app.members.isMember(uid, networkId)) {
          throw new EtnError(
            'NOT_FOUND',
            'Кандидат не является участником сети.',
            undefined,
            req.id,
          );
        }
        const network = app.systemDb.getNetworkById(networkId);
        if (network === null) {
          throw new EtnError('NOT_FOUND', 'Сеть не найдена.', undefined, req.id);
        }
        if (network.owner_id === uid) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Пользователь уже является владельцем.',
            undefined,
            req.id,
          );
        }
        app.systemDb.transferNetworkOwnership(networkId, network.owner_id, uid);
        app.members.invalidate(undefined);
        app.systemDb.insertAuditLog({
          actorUserId: req.auth!.user.id,
          networkId,
          category: 'membership',
          action: 'member.role_changed',
          targetType: 'user',
          targetId: uid,
          details: { role: 'owner' },
        });
        // Real-time (E3, 04-realtime.md §4.6): the transfer changes the roles
        // of two users, so two role_changed events go out — every client can
        // update both affected member rows without extra lookups.
        emitDomainEvent(
          { systemDb: app.systemDb, pubsub: app.pubsub },
          networkId,
          'member.role_changed',
          { user_id: uid, role: 'owner' },
          { user_id: req.auth!.user.id, client_id: req.auth!.clientId },
          { meta: { request_id: req.id } },
        );
        emitDomainEvent(
          { systemDb: app.systemDb, pubsub: app.pubsub },
          networkId,
          'member.role_changed',
          { user_id: network.owner_id, role: 'member' },
          { user_id: req.auth!.user.id, client_id: req.auth!.clientId },
          { meta: { request_id: req.id } },
        );
        reply.code(204).send();
      },
    );

    app.get(
      '/networks/:networkId/preferences',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestNetworkById, req);
        const prefs = app.systemDb.listNetworkPreferences(req.auth!.user.id, input.network_id);
        sendSuccess(reply, prefs);
      },
    );

    app.put(
      '/networks/:networkId/preferences/:key',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const input = parseRest(RestNetworkPreferenceKey, req);
        const { network_id: networkId, key } = input;
        if (!SUPPORTED_PREFERENCE_KEYS.has(key)) {
          throw new EtnError(
            'VALIDATION_ERROR',
            `Неподдерживаемый ключ предпочтения: ${key}`,
            { field: 'key' },
            req.id,
          );
        }
        const body = (req.body ?? {}) as { value?: unknown };
        app.systemDb.setNetworkPreference(req.auth!.user.id, networkId, key, body.value);
        // Real-time (E3, 11-settings-and-state.md §4.4): private per-user
        // settings — audience is derived as 'user' from the event catalogue.
        emitDomainEvent(
          { systemDb: app.systemDb, pubsub: app.pubsub },
          networkId,
          'user-preference.updated',
          { key, value: body.value },
          { user_id: req.auth!.user.id, client_id: req.auth!.clientId },
          { meta: { request_id: req.id } },
        );
        sendSuccess(reply, { key, value: body.value });
      },
    );
  };
}
