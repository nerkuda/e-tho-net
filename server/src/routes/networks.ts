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
 * setting one's own preferences requires any membership. Real network creation
 * (directory + data.db + HOME) is delegated to {@link NetworkService} (task C10).
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

import { EtnError, PREF_KEY } from '@etn/shared';

import type { NetworkService } from '../domain/network-service.js';
import { sendEtnError } from '../http/errors.js';
import { sendCreated, sendList, sendSuccess } from '../http/responses.js';

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
const SUPPORTED_PREFERENCE_KEYS = new Set<string>([PREF_KEY.SHOW_INACTIVE]);

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
    created_at: n.created_at,
    updated_at: n.updated_at,
  };
}

/**
 * Guard: the caller must be the network owner OR a system admin. Assumes
 * `requireNetworkMember` has already run (so the caller is at least a member).
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
        const body = (req.body ?? {}) as CreateNetworkInput;
        const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
        if (displayName.length === 0) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'display_name обязательно и не может быть пустым.',
            { field: 'display_name' },
            req.id,
          );
        }
        const description = typeof body.description === 'string' ? body.description || null : null;

        // Real creation (directory + data.db + HOME) is delegated to NetworkService.
        // The stub throws "Not implemented: see task C10" until C10 lands.
        let network: Network;
        try {
          network = await networkService.createNetwork(req.auth!.user.id, displayName, description);
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
          details: { display_name: displayName },
        });
        sendCreated(reply, networkDto(network));
      },
    );

    app.get(
      '/networks/:networkId',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const network = app.systemDb.getNetworkById(networkId);
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
        const { networkId } = req.params as NetworkIdParams;
        if (!(await requireOwnerOrAdmin(app, req, reply, networkId))) {
          return;
        }
        const network = app.systemDb.getNetworkById(networkId);
        if (network === null) {
          throw new EtnError('NOT_FOUND', 'Сеть не найдена.', undefined, req.id);
        }
        const body = (req.body ?? {}) as UpdateNetworkInput;
        const displayName =
          typeof body.display_name === 'string'
            ? body.display_name.trim() || network.display_name
            : network.display_name;
        const description =
          body.description === undefined
            ? network.description
            : typeof body.description === 'string'
              ? body.description || null
              : null;
        app.systemDb.updateNetwork(network.id, { displayName, description });
        app.systemDb.insertAuditLog({
          actorUserId: req.auth!.user.id,
          networkId: network.id,
          category: 'network',
          action: 'network.update',
          targetType: 'network',
          targetId: network.id,
          details: { display_name: displayName, description },
        });
        const updated = app.systemDb.getNetworkById(network.id);
        sendSuccess(reply, networkDto(updated!));
      },
    );

    app.get(
      '/networks/:networkId/members',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const members = app.systemDb.listNetworkMembers(networkId);
        sendList(reply, members.map(memberDto), members.length, 0, members.length);
      },
    );

    app.post(
      '/networks/:networkId/members',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        if (!(await requireOwnerOrAdmin(app, req, reply, networkId))) {
          return;
        }
        const body = (req.body ?? {}) as AddMemberInput;
        const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
        if (userId.length === 0) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'user_id обязательно.',
            { field: 'user_id' },
            req.id,
          );
        }
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
        sendCreated(reply, { network_id: networkId, user_id: userId, role: 'member' });
      },
    );

    app.delete(
      '/networks/:networkId/members/:uid',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, uid } = req.params as MemberParams;
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
        reply.code(204).send();
      },
    );

    app.patch(
      '/networks/:networkId/members/:uid',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, uid } = req.params as MemberParams;
        if (!(await requireOwnerOrAdmin(app, req, reply, networkId))) {
          return;
        }
        const body = (req.body ?? {}) as UpdateMemberInput;
        if (body.role !== 'owner') {
          throw new EtnError(
            'VALIDATION_ERROR',
            'Поддерживается только передача владения (role: "owner").',
            { field: 'role' },
            req.id,
          );
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
        reply.code(204).send();
      },
    );

    app.get(
      '/networks/:networkId/preferences',
      { preHandler: [app.authPreHandler, requireNetworkMember()] },
      async (req: FastifyRequest, reply) => {
        const { networkId } = req.params as NetworkIdParams;
        const prefs = app.systemDb.listNetworkPreferences(req.auth!.user.id, networkId);
        sendSuccess(reply, prefs);
      },
    );

    app.put(
      '/networks/:networkId/preferences/:key',
      { preHandler: [app.authPreHandler, requireNetworkMember(), app.idempotency.preHandler] },
      async (req: FastifyRequest, reply) => {
        const { networkId, key } = req.params as PreferenceKeyParams;
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
        sendSuccess(reply, { key, value: body.value });
      },
    );
  };
}
