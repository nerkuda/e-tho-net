/**
 * Access-control guards for Fastify routes (task B9, docs/06-auth.md §4–5).
 *
 * Three composable preHandlers mirror the spec:
 *   * {@link requireAuth} — any valid API-key;
 *   * {@link requireAdmin} — `user.is_admin`;
 *   * {@link requireNetworkMember}(role?) — membership in the network named by
 *     the route's `:networkId` param (or `:id`), optionally requiring `owner`.
 *
 * Membership is resolved through the cached {@link NetworkMembersService}.
 * A global system administrator (`user.is_admin`) is granted the *effective*
 * access of an owner on every network, with or without an explicit
 * `network_members` row (06-auth.md §4.1/§4.3, task 0.4.2 bug-fix): this
 * covers both reading network data and every mutating operation. Each guard
 * re-checks `auth` defensively, so a route that wires only `requireAdmin`
 * (without the auth preHandler) still rejects anonymous requests with 401
 * rather than crashing.
 */

import type { FastifyRequest } from 'fastify';

import type { NetworkRole } from '@etn/shared';

import type { AuthPreHandlerFn } from './auth-middleware.js';
import { sendEtnError } from '../http/errors.js';
import type { NetworkMembersService } from '../domain/network-members-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Cached network-membership lookup (06-auth.md §5). */
    members: NetworkMembersService;
    /** Access-control guard bundle bound to {@link FastifyInstance.members}. */
    accessControl: AccessControl;
  }
}

/** PreHandler signature shared by all guards. */
export type Guard = AuthPreHandlerFn;

/** Extract the network id from the matched route's params. */
function networkIdFromRequest(req: FastifyRequest): string | null {
  const params = req.params as { networkId?: string; id?: string };
  const nid = params.networkId ?? params.id;
  return typeof nid === 'string' && nid.length > 0 ? nid : null;
}

/** Bundle of guards bound to a single {@link NetworkMembersService}. */
export interface AccessControl {
  /** Any authenticated user. */
  requireAuth: Guard;
  /** Authenticated system administrator (`user.is_admin`). */
  requireAdmin: Guard;
  /**
   * Member of the network in `:networkId`. Pass `'owner'` to require the owner
   * role. A global admin passes this guard for *any* network — with or
   * without an explicit membership row, and regardless of the requested role
   * — since admins hold owner-equivalent rights everywhere (06-auth.md §4.1).
   */
  requireNetworkMember: (role?: NetworkRole) => Guard;
}

/**
 * Build the access-control guard bundle against the membership cache.
 */
export function createAccessControl(members: NetworkMembersService): AccessControl {
  const requireAuth: Guard = async (req, reply): Promise<void> => {
    if (req.auth === null) {
      sendEtnError(reply, 'UNAUTHORIZED', 'Требуется аутентификация.', undefined, req.id);
      return;
    }
  };

  const requireAdmin: Guard = async (req, reply): Promise<void> => {
    await requireAuth(req, reply);
    if (reply.sent) {
      return;
    }
    // `auth` is non-null after requireAuth passed.
    const auth = req.auth!;
    if (!auth.user.is_admin) {
      sendEtnError(reply, 'FORBIDDEN', 'Требуются права администратора.', undefined, req.id);
    }
  };

  const requireNetworkMember =
    (requiredRole?: NetworkRole): Guard =>
    async (req, reply): Promise<void> => {
      await requireAuth(req, reply);
      if (reply.sent) {
        return;
      }
      const auth = req.auth!;
      const networkId = networkIdFromRequest(req);
      if (networkId === null) {
        sendEtnError(
          reply,
          'BAD_REQUEST',
          'Не удалось определить сеть из пути запроса.',
          undefined,
          req.id,
        );
        return;
      }
      const role = members.getMemberRole(auth.user.id, networkId);
      // A global admin has owner-equivalent access to every network, whether
      // or not they hold an explicit membership row (06-auth.md §4.1).
      if (auth.user.is_admin) {
        return;
      }
      if (role === null) {
        sendEtnError(
          reply,
          'FORBIDDEN',
          'Вы не являетесь участником этой сети.',
          undefined,
          req.id,
        );
        return;
      }
      if (requiredRole === 'owner' && role !== 'owner') {
        sendEtnError(reply, 'FORBIDDEN', 'Требуются права владельца сети.', undefined, req.id);
      }
    };

  return { requireAuth, requireAdmin, requireNetworkMember };
}
