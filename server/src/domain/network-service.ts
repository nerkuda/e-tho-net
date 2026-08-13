/**
 * Network lifecycle service interface (task B13, real impl in task C10).
 *
 * Creating a network is more than a `_system.db` insert: it must allocate the
 * `networks/<id>/` directory, run the per-network `data.db` migrations and seed
 * the protected HOME thought (`is_root=1, is_protected=1`). That machinery
 * arrives in task C10 (NetworkDb + data migrations). Until then the REST routes
 * depend only on this interface, so C10 can drop the real implementation in
 * without touching the routes.
 *
 * Registry membership reads/writes that live entirely in `_system.db`
 * (`networks`, `network_members`, `user_preferences`) are handled directly by
 * {@link SystemDb} and are NOT part of this interface.
 */

import type { Network } from '@etn/shared';

/** Network lifecycle operations that require filesystem + per-DB work. */
export interface NetworkService {
  /**
   * Create a network: allocate `networks/<id>/`, build `data.db` (with
   * migrations), seed HOME, and insert the registry + owner membership rows.
   *
   * @returns the new {@link Network} registry row.
   */
  createNetwork(
    ownerId: string,
    displayName: string,
    description?: string | null,
  ): Promise<Network>;

  /**
   * Delete a network: WAL checkpoint the network DB, remove the
   * `networks/<id>/` directory, and delete the registry row (cascades to
   * `network_members`). Admin-only.
   */
  deleteNetwork(networkId: string): Promise<void>;
}

/**
 * Placeholder {@link NetworkService} used until task C10 lands. Every mutating
 * method throws a clear "not implemented" error so routes fail loudly rather
 * than silently producing half-created networks.
 */
export class StubNetworkService implements NetworkService {
  async createNetwork(
    _ownerId: string,
    _displayName: string,
    _description?: string | null,
  ): Promise<Network> {
    throw new Error('Not implemented: NetworkService.createNetwork — see task C10');
  }

  async deleteNetwork(_networkId: string): Promise<void> {
    throw new Error('Not implemented: NetworkService.deleteNetwork — see task C10');
  }
}
