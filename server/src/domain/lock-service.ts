/**
 * Object-locks domain service (task 2031df5e, requirements f8d55c19
 * «захват — границы и запрет записи» and 9ac48831 «сброс захватов»;
 * сущность e0a1ae3a «object_locks», операция 8919b057 «/locks»,
 * события 235477e0 «edit.*»).
 *
 * A lock is a soft server-side reservation on one entity of one network:
 * while the lock is held by a user, write operations against that entity
 * from anyone else (REST, MCP, other WebSocket clients) are rejected with
 * `409 LOCKED` carrying the holder's id. Reads are never blocked.
 *
 * State lives in the `object_locks` table (migration 034) and is intentionally
 * not branchable — locks are session-scoped, network-global and cleared on
 * server start. The lock service exposes four primitives the routes and the
 * real-time gateway call into:
 *
 *   * {@link acquireLock}   — REST/WS `POST /locks` (or its MCP equivalent);
 *   * {@link releaseLock}   — REST `DELETE /locks/:lock_id` (only by owner);
 *   * {@link listLocks}     — `GET /locks` (filterable by user/client);
 *   * {@link clearLocksForUser} — REST `POST /locks/clear { user_id }`;
 *
 * Two bulk resets sit next to those:
 *
 *   * {@link clearLocksForClient} — called by the WebSocket gateway on every
 *     socket 'close' (requirement 9ac48831);
 *   * {@link clearAllLocks}       — called by `openNetworkDb` on first open
 *     of a network in the current process (requirement 9ac48831 — «старт»).
 *
 * And one guard every mutating domain service calls before it touches a
 * locked entity:
 *
 *   * {@link enforceLock} — throws `LOCKED` when a foreign user holds the
 *     lock; own locks always pass.
 *
 * The lock service itself is **purely a table layer**: it does not emit
 * real-time events and does not consult `users` / `members`. Route and
 * gateway callers are responsible for those side effects (so the same
 * primitives can be reused by the MCP layer without doubling the wiring).
 */

import { randomUUID } from 'node:crypto';

import { EtnError } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/** Wire shape returned by {@link acquireLock} and reused by REST responses. */
export interface LockRow {
  id: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  client_id: string | null;
  acquired_at_ms: number;
}

/** Physical row read from `object_locks`. */
interface ObjectLockRow {
  id: string;
  entity_type: string;
  entity_id: string;
  network_id: string;
  user_id: string;
  client_id: string | null;
  acquired_at_ms: number;
}

/** Convert a physical row to the wire shape (drops `network_id`). */
function toLockRow(row: ObjectLockRow): LockRow {
  return {
    id: row.id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    user_id: row.user_id,
    client_id: row.client_id,
    acquired_at_ms: row.acquired_at_ms,
  };
}

/** Read one lock row by primary key, or `undefined`. */
function lockById(ndb: NetworkDb, lockId: string): ObjectLockRow | undefined {
  return ndb
    .prepare(
      `SELECT id, entity_type, entity_id, network_id, user_id, client_id, acquired_at_ms
       FROM object_locks WHERE id = ? LIMIT 1`,
    )
    .get(lockId) as ObjectLockRow | undefined;
}

/**
 * Acquire (or refresh) the lock on `(entity_type, entity_id)` for `userId`.
 *
 * Idempotent for the same user: a repeated acquire on an already-held object
 * updates `client_id`/`acquired_at_ms` and returns the existing lock — the
 * spec's «продление». A different holder is rejected with `LOCKED` carrying
 * the existing holder's coordinates (REST `409`, MCP equivalent).
 */
export function acquireLock(
  ndb: NetworkDb,
  params: {
    entityType: string;
    entityId: string;
    userId: string;
    clientId: string | null;
  },
): LockRow {
  const networkId = ndb.networkId;
  const nowMs = Date.now();

  return ndb.transaction(() => {
    const existing = ndb
      .prepare(
        `SELECT id, entity_type, entity_id, network_id, user_id, client_id, acquired_at_ms
         FROM object_locks
         WHERE network_id = ? AND entity_type = ? AND entity_id = ?
         LIMIT 1`,
      )
      .get(networkId, params.entityType, params.entityId) as ObjectLockRow | undefined;

    if (existing !== undefined) {
      if (existing.user_id === params.userId) {
        // Свой захват — продление (требование f8d55c19).
        ndb.prepare(
          `UPDATE object_locks
             SET client_id = ?, acquired_at_ms = ?
           WHERE id = ?`,
        ).run(params.clientId, nowMs, existing.id);
        return {
          ...existing,
          client_id: params.clientId,
          acquired_at_ms: nowMs,
        };
      }
      throw new EtnError(
        'LOCKED',
        'объект редактируется другим участником',
        {
          entity_type: params.entityType,
          entity_id: params.entityId,
          holder: {
            user_id: existing.user_id,
            client_id: existing.client_id,
          },
          lock_id: existing.id,
          acquired_at_ms: existing.acquired_at_ms,
        },
      );
    }

    const id = randomUUID();
    ndb.prepare(
      `INSERT INTO object_locks
         (id, entity_type, entity_id, network_id, user_id, client_id, acquired_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      params.entityType,
      params.entityId,
      networkId,
      params.userId,
      params.clientId,
      nowMs,
    );
    return {
      id,
      entity_type: params.entityType,
      entity_id: params.entityId,
      user_id: params.userId,
      client_id: params.clientId,
      acquired_at_ms: nowMs,
    };
  });
}

/**
 * Release the lock with id `lockId`. Only the holder may release —
 * anyone else gets `403 FORBIDDEN`. Releasing an unknown lock is
 * `404 LOCK_NOT_FOUND`.
 */
export function releaseLock(ndb: NetworkDb, lockId: string, userId: string): LockRow {
  return ndb.transaction(() => {
    const row = lockById(ndb, lockId);
    if (row === undefined) {
      throw new EtnError('LOCK_NOT_FOUND', `lock ${lockId} not found`, {
        lock_id: lockId,
      });
    }
    if (row.user_id !== userId) {
      // Чужой захват — снять его нельзя (только clear для всех или владельцу).
      throw new EtnError('FORBIDDEN', 'снять чужой захват может только его владелец', {
        lock_id: lockId,
        holder_user_id: row.user_id,
      });
    }
    ndb.prepare('DELETE FROM object_locks WHERE id = ?').run(lockId);
    return toLockRow(row);
  });
}

/**
 * List active locks for `networkId`, optionally filtered by `userId` and/or
 * `clientId`. Either filter may be `null` (= "no constraint on that column").
 * Used by `GET /locks` for the «Участники мыслесети» panel.
 */
export function listLocks(
  ndb: NetworkDb,
  filters: { userId?: string | null; clientId?: string | null } = {},
): LockRow[] {
  const clauses: string[] = ['network_id = ?'];
  const args: unknown[] = [ndb.networkId];
  if (filters.userId !== undefined && filters.userId !== null) {
    clauses.push('user_id = ?');
    args.push(filters.userId);
  }
  if (filters.clientId !== undefined && filters.clientId !== null) {
    clauses.push('client_id = ?');
    args.push(filters.clientId);
  }
  const rows = ndb
    .prepare(
      `SELECT id, entity_type, entity_id, network_id, user_id, client_id, acquired_at_ms
       FROM object_locks
       WHERE ${clauses.join(' AND ')}
       ORDER BY acquired_at_ms, id`,
    )
    .all(...args) as ObjectLockRow[];
  return rows.map(toLockRow);
}

/**
 * Remove every lock held by `userId` in the current network (manual reset
 * through `POST /locks/clear { user_id }`). Returns the rows that were
 * removed so the caller can fan out `edit.cleared` events with the same
 * `reason: 'manual'`. Self-only: `userId` is the only argument.
 */
export function clearLocksForUser(ndb: NetworkDb, userId: string): LockRow[] {
  return ndb.transaction(() => {
    const rows = ndb
      .prepare(
        `SELECT id, entity_type, entity_id, network_id, user_id, client_id, acquired_at_ms
         FROM object_locks WHERE network_id = ? AND user_id = ?`,
      )
      .all(ndb.networkId, userId) as ObjectLockRow[];
    if (rows.length > 0) {
      ndb.prepare('DELETE FROM object_locks WHERE network_id = ? AND user_id = ?').run(
        ndb.networkId,
        userId,
      );
    }
    return rows.map(toLockRow);
  });
}

/**
 * Remove every lock whose `client_id` matches — called by the WebSocket
 * gateway when a connection closes (requirement 9ac48831, «разрыв WS»).
 * Returns the rows that were removed for event fan-out with
 * `reason: 'ws_disconnect'`.
 */
export function clearLocksForClient(ndb: NetworkDb, clientId: string): LockRow[] {
  return ndb.transaction(() => {
    const rows = ndb
      .prepare(
        `SELECT id, entity_type, entity_id, network_id, user_id, client_id, acquired_at_ms
         FROM object_locks WHERE network_id = ? AND client_id = ?`,
      )
      .all(ndb.networkId, clientId) as ObjectLockRow[];
    if (rows.length > 0) {
      ndb.prepare('DELETE FROM object_locks WHERE network_id = ? AND client_id = ?').run(
        ndb.networkId,
        clientId,
      );
    }
    return rows.map(toLockRow);
  });
}

/**
 * Remove every lock in the network — called by `openNetworkDb` on first
 * open in the current process (requirement 9ac48831, «старт»). Used to
 * fan out `edit.cleared` with `reason: 'server_start'` after a restart.
 */
export function clearAllLocks(ndb: NetworkDb): LockRow[] {
  return ndb.transaction(() => {
    const rows = ndb
      .prepare(
        `SELECT id, entity_type, entity_id, network_id, user_id, client_id, acquired_at_ms
         FROM object_locks WHERE network_id = ?`,
      )
      .all(ndb.networkId) as ObjectLockRow[];
    if (rows.length > 0) {
      ndb.prepare('DELETE FROM object_locks WHERE network_id = ?').run(ndb.networkId);
    }
    return rows.map(toLockRow);
  });
}

/**
 * Throws `409 LOCKED` when a lock on `(entityType, entityId)` is currently
 * held by someone other than `actorUserId`. Own locks always pass (even when
 * held by the same user through another client/session). Unknown / unheld
 * objects also pass.
 *
 * Called at the head of every mutating domain service (thoughts, links,
 * types, comments, attachments, layers, property values, property registry).
 * Read services do NOT call it — reads are never blocked (requirement
 * f8d55c19, «Чтение никогда не блокируется»).
 *
 * Pass `actorUserId = null` to skip the check entirely — used by
 * system-initiated admin operations (trash purge, layer merge cascade)
 * where blocking on a stale lock would be wrong. User-driven writes must
 * always pass a real id.
 */
export function enforceLock(
  ndb: NetworkDb,
  entityType: string,
  entityId: string,
  actorUserId: string | null,
): void {
  if (actorUserId === null) {
    return;
  }
  const row = ndb
    .prepare(
      `SELECT user_id, client_id, acquired_at_ms
       FROM object_locks
       WHERE network_id = ? AND entity_type = ? AND entity_id = ?
       LIMIT 1`,
    )
    .get(ndb.networkId, entityType, entityId) as
    | { user_id: string; client_id: string | null; acquired_at_ms: number }
    | undefined;
  if (row === undefined) {
    return;
  }
  if (row.user_id === actorUserId) {
    return;
  }
  throw new EtnError(
    'LOCKED',
    'объект редактируется другим участником',
    {
      entity_type: entityType,
      entity_id: entityId,
      holder: { user_id: row.user_id, client_id: row.client_id },
      acquired_at_ms: row.acquired_at_ms,
    },
  );
}
