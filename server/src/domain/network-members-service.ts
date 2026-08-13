/**
 * Cached network-membership lookup (task B9, docs/06-auth.md §5).
 *
 * `network_members` is read on every protected network request (access-control
 * in task B9). To keep that off the hot path we cache the resolved role per
 * `(user_id, network_id)` in memory. The cache is invalidated explicitly via
 * {@link NetworkMembersService.invalidate} whenever membership changes
 * (member.added/removed/role_changed — emitted by routes in task B13 and, in
 * phase E, mirrored from the pub/sub stream).
 *
 * Single-process MVP: the cache is process-local. `null` is a valid cached
 * value ("known to be a non-member"), distinct from an absent entry ("not yet
 * looked up").
 */

import type { NetworkRole } from '@etn/shared';

import type { SystemDb } from '../db/system-db.js';

/** Cache-key shape. */
function roleKey(userId: string, networkId: string): string {
  return `${userId}:${networkId}`;
}

/** Cached role resolution: a {@link NetworkRole}, or `null` when known non-member. */
type CachedRole = NetworkRole | null;

/**
 * In-process membership cache over {@link SystemDb}.
 *
 * Construct once per server and share across requests. Thread-safe by virtue of
 * the JavaScript single-threaded execution model.
 */
export class NetworkMembersService {
  private readonly systemDb: SystemDb;
  private readonly roles = new Map<string, CachedRole>();

  constructor(systemDb: SystemDb) {
    this.systemDb = systemDb;
  }

  /**
   * Resolve the user's role in a network, reading from the cache when possible.
   *
   * @returns the {@link NetworkRole}, or `null` when the user is not a member.
   */
  getMemberRole(userId: string, networkId: string): NetworkRole | null {
    const key = roleKey(userId, networkId);
    const cached = this.roles.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const role = this.systemDb.getMemberRole(userId, networkId);
    this.roles.set(key, role);
    return role;
  }

  /** True when the user is any kind of member of the network. */
  isMember(userId: string, networkId: string): boolean {
    return this.getMemberRole(userId, networkId) !== null;
  }

  /**
   * Drop cached entries after a membership change.
   *
   * @param userId - when given, invalidate only that user's entries; otherwise
   *   clear the whole cache.
   * @param networkId - when given together with `userId`, drop just that pair.
   */
  invalidate(userId?: string, networkId?: string): void {
    if (userId === undefined) {
      this.roles.clear();
      return;
    }
    if (networkId !== undefined) {
      this.roles.delete(roleKey(userId, networkId));
      return;
    }
    const prefix = `${userId}:`;
    for (const key of this.roles.keys()) {
      if (key.startsWith(prefix)) {
        this.roles.delete(key);
      }
    }
  }
}
