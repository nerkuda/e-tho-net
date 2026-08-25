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

import { EtnError, PREF_KEY } from '@etn/shared';

import type { NetworkService } from '../domain/network-service.js';
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
    when_to_use: n.when_to_use,
    conventions: n.conventions,
    examples: n.examples,
    node_section_type_id: n.node_section_type_id,
    has_structure: n.node_section_type_id !== null,
    created_at: n.created_at,
    updated_at: n.updated_at,
  };
}

/**
 * Resolve a PATCH body field that is `undefined` (keep existing), `null` or
 * empty string (clear), or a non-empty string (set) into the value to persist
 * (task O5, markdown self-description fields).
 */
function normalizeOptionalText(
  incoming: string | null | undefined,
  current: string | null,
): string | null {
  if (incoming === undefined) {
    return current;
  }
  if (incoming === null) {
    return null;
  }
  if (typeof incoming !== 'string') {
    return current;
  }
  return incoming.length === 0 ? null : incoming;
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
        // Markdown self-description fields (task O5). Treat empty strings and
        // explicit null as "clear", omit as "keep existing value".
        const description = normalizeOptionalText(body.description, network.description);
        const whenToUse = normalizeOptionalText(body.when_to_use, network.when_to_use);
        const conventions = normalizeOptionalText(body.conventions, network.conventions);
        const examples = normalizeOptionalText(body.examples, network.examples);
        // node_section_type_id is special: when present it must point at a
        // real thought type in this network's data.db (no cross-DB FK), or be
        // null. A stale id would silently break `etn.networks.structure`, so we
        // refuse to persist unknown ids up front.
        const nodeSectionTypeId = networkService.validateNodeSectionType(
          network.id,
          body.node_section_type_id === undefined
            ? network.node_section_type_id
            : body.node_section_type_id,
        );
        app.systemDb.updateNetwork(network.id, {
          displayName,
          description,
          when_to_use: whenToUse,
          conventions,
          examples,
          node_section_type_id: nodeSectionTypeId,
        });
        app.systemDb.insertAuditLog({
          actorUserId: req.auth!.user.id,
          networkId: network.id,
          category: 'network',
          action: 'network.update',
          targetType: 'network',
          targetId: network.id,
          details: {
            display_name: displayName,
            description,
            when_to_use: whenToUse,
            conventions,
            examples,
            node_section_type_id: nodeSectionTypeId,
          },
        });
        // Real-time (E3, 04-realtime.md §4.6, task O5): broadcast only changed
        // fields so clients can merge in place.
        const changes: Record<string, unknown> = {};
        if (displayName !== network.display_name) changes['display_name'] = displayName;
        if (description !== network.description) changes['description'] = description;
        if (whenToUse !== network.when_to_use) changes['when_to_use'] = whenToUse;
        if (conventions !== network.conventions) changes['conventions'] = conventions;
        if (examples !== network.examples) changes['examples'] = examples;
        if (nodeSectionTypeId !== network.node_section_type_id) {
          changes['node_section_type_id'] = nodeSectionTypeId;
        }
        if (Object.keys(changes).length > 0) {
          emitDomainEvent(
            { systemDb: app.systemDb, pubsub: app.pubsub },
            network.id,
            'network.updated',
            changes,
            { user_id: req.auth!.user.id, client_id: req.auth!.clientId },
            { meta: { request_id: req.id } },
          );
        }
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
