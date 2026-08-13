/**
 * Network lifecycle service (task B13 interface, real impl in task C10).
 *
 * Creating a network is more than a `_system.db` insert: it must allocate the
 * `networks/<id>/` directory, run the per-network `data.db` migrations and seed
 * the protected HOME thought (`is_root=1, is_protected=1`). Deleting a network
 * checkpoints its WAL, removes the directory and the registry row.
 *
 * Registry membership reads/writes that live entirely in `_system.db`
 * (`networks`, `network_members`, `user_preferences`) are handled by
 * {@link SystemDb} and are NOT part of this interface; this service orchestrates
 * the filesystem + per-DB lifecycle and calls SystemDb for the registry rows.
 */

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import type { Network } from '@etn/shared';

import type { SystemDb } from '../db/system-db.js';
import { closeNetworkDb, openNetworkDb } from '../db/network-db.js';
import { networkDir } from '../paths.js';
import type { Logger } from '../logger.js';

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
 * Real {@link NetworkService} over the filesystem + `_system.db`
 * (docs/02-data-model.md §4 init, §6 delete).
 *
 * Construct with the resolved data directory and the open {@link SystemDb}, then
 * hand the instance to the networks route. Every create/delete is logged through
 * the injected logger (audit-log rows are written by the caller, which knows the
 * acting user — this service's interface deliberately carries no actor).
 */
export class NetworkServiceImpl implements NetworkService {
  /**
   * @param systemDb - open `_system.db` accessor (registry + membership rows).
   * @param dataDir - absolute ETN data directory.
   * @param log - optional logger for lifecycle progress.
   */
  constructor(
    private readonly systemDb: SystemDb,
    private readonly dataDir: string,
    private readonly log?: Logger,
  ) {}

  async createNetwork(
    ownerId: string,
    displayName: string,
    description?: string | null,
  ): Promise<Network> {
    const networkId = randomUUID();
    this.log?.debug({ networkId, ownerId, displayName }, 'creating network');

    // 1. Allocate directory tree + open data.db with migrations applied.
    const ndb = openNetworkDb(this.dataDir, networkId, this.log);

    // 2. Seed the protected HOME thought in a single transaction.
    const homeId = randomUUID();
    const now = new Date().toISOString();
    ndb.transaction(() => {
      ndb
        .prepare(
          `INSERT INTO thoughts (id, title, title_norm, is_protected, is_root, active,
                                 version, created_at, created_by, updated_at, updated_by)
           VALUES (?, 'HOME', 'home', 1, 1, 1, 1, ?, ?, ?, ?)`,
        )
        .run(homeId, now, ownerId, now, ownerId);
    });

    // 3. Record registry + owner membership in _system.db (atomic). Both rows
    //    succeed or roll back together; if this throws, the caller should still
    //    end up with no half-registered network because the directory is inert
    //    without a registry row.
    const network = this.systemDb.transaction(() => {
      const created = this.systemDb.createNetworkRow(
        networkId,
        ownerId,
        displayName,
        description ?? null,
      );
      this.systemDb.addNetworkMember(networkId, ownerId, 'owner', ownerId);
      return created;
    });

    // 4. Release the per-DB connection; it reopens on demand on first access.
    closeNetworkDb(networkId);
    this.log?.info({ networkId, homeId }, 'network created');
    return network;
  }

  async deleteNetwork(networkId: string): Promise<void> {
    this.log?.debug({ networkId }, 'deleting network');

    // 1. Open (if not already) so we can checkpoint, then close.
    const ndb = openNetworkDb(this.dataDir, networkId, this.log);
    ndb.pragma('wal_checkpoint(TRUNCATE)');
    closeNetworkDb(networkId);

    // 2. Remove the per-network directory tree (data.db, -wal, -shm, attachments/).
    const dir = networkDir(this.dataDir, networkId);
    rmSync(dir, { recursive: true, force: true });

    // 3. Delete the registry row (cascades to network_members, user_preferences).
    this.systemDb.deleteNetworkRow(networkId);
    this.log?.info({ networkId }, 'network deleted');
  }
}
