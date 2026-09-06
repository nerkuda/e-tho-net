/**
 * Auto-acquire / auto-release helper for the editor / dialog surfaces (task
 * 4f141756 «Захваты в клиенте: авто-захват, индикация, ручной сброс»,
 * операция 8919b057 «/locks», docs/03-server-api.md §13c).
 *
 * The editor and every edit dialog call {@link acquireOrShowBlocked} on open
 * and {@link releaseHeld} on close / save / cancel / switch. The helper:
 *
 *  1. Reads the cache first — if someone else already holds the object, we
 *     never make the network call (the server would 409 anyway).
 *  2. On success, stashes the lock_id so {@link releaseHeld} knows what to
 *     release.
 *  3. On 409 `LOCKED`, surfaces the holder's name through `notice(…)` and
 *     returns a `Blocked` outcome the caller can use to disable its inputs.
 *  4. On any other error, swallows it — locking is a soft best-effort feature
 *     and a failed acquire must not block the user from working.
 *
 * The lock table is **not branchable** — the server only carries locks for
 * the current session — so the cache stays flat per renderer; clearing it on
 * network switch is enough (the {@link acquireOrShowBlocked} helpers do not
 * need to know which network they belong to because the cache drops with the
 * store's `resetNetwork`).
 */

import type { LockEntityType, LockRow } from '@etn/shared';

import { EtnError } from '@etn/shared';

import { etn } from './etn.js';
import {
  otherHolder,
  getLock,
  subscribeLockCache,
  holderName,
  holderNameByUserId,
  __setForTests as seedCache,
} from './lock-cache.js';
import { notice } from './notice.js';
import { requireNetworkId } from '../app.js';
import { store } from '../state.js';

/**
 * Outcome of {@link acquireOrShowBlocked}.
 *
 * - `Acquired` — we own the lock; release on close.
 * - `SelfAlreadyHolds` — the user's *own* previous session holds it
 *   (idempotent re-acquire is server-side; we treat it the same as Acquired).
 * - `BlockedByOther` — another user holds it; UI must disable writes.
 * - `Failed` — non-LOCKED error; treat as no lock, surface a soft notice.
 */
export type AcquireOutcome =
  | { kind: 'acquired'; lock: LockRow }
  | { kind: 'self'; lock: LockRow }
  | { kind: 'blocked'; holder: LockRow }
  | { kind: 'failed'; error: unknown };

/** Token returned to the editor so it can release the held lock on close. */
export interface LockHandle {
  entityType: LockEntityType | string;
  entityId: string;
  /** Lock id; `null` when we never acquired one (blocked or failed). */
  lockId: string | null;
  /** Owner user id — set when we own the lock or someone else does. */
  ownerUserId: string | null;
}

/**
 * Attempt to acquire the lock on `(entityType, entityId)`. If the cache says
 * another user holds it, we return `Blocked` without an extra round-trip;
 * the editor renders the warning state immediately.
 */
export async function acquireOrShowBlocked(
  entityType: LockEntityType | string,
  entityId: string,
): Promise<AcquireOutcome> {
  const networkId = requireNetworkId();
  const existing = getLock(entityType, entityId);
  if (existing !== undefined) {
    const me = store.state.me;
    if (me !== null && existing.user_id === me.id) {
      return { kind: 'self', lock: existing };
    }
    notice(
      `${entityLabel(entityType)} редактирует ${holderName(existing)} — поля заблокированы.`,
      'info',
    );
    return { kind: 'blocked', holder: existing };
  }

  try {
    const lock = await etn.locks.acquire(networkId, entityType, entityId);
    return { kind: 'acquired', lock };
  } catch (err) {
    if (err instanceof EtnError && err.code === 'LOCKED') {
      const details = (err.details ?? {}) as {
        holder?: { user_id: string; client_id: string | null };
      };
      const holderUserId = details.holder?.user_id ?? '?';
      // The realtime bus will populate the cache with the canonical row in a
      // moment; for the synchronous editor state we synthesise a row from
      // the error envelope so the overlay has something to render.
      seedCache([
        {
          id: `pending-${entityType}:${entityId}`,
          entity_type: entityType,
          entity_id: entityId,
          user_id: holderUserId,
          client_id: details.holder?.client_id ?? null,
          acquired_at_ms: Date.now(),
        },
      ]);
      const holder = otherHolder(entityType, entityId) ?? {
        id: `pending-${entityType}:${entityId}`,
        entity_type: entityType,
        entity_id: entityId,
        user_id: holderUserId,
        client_id: details.holder?.client_id ?? null,
        acquired_at_ms: Date.now(),
      };
      notice(
        `${entityLabel(entityType)} редактирует ${holderName(holder)} — поля заблокированы.`,
        'info',
      );
      return { kind: 'blocked', holder };
    }
    notice(`Не удалось поставить захват: ${stringifyError(err)}`, 'info');
    return { kind: 'failed', error: err };
  }
}

/**
 * Build a {@link LockHandle} from an {@link AcquireOutcome}. When the
 * outcome is `Blocked` or `Failed` the `lockId` is `null` (nothing to
 * release); the editor still renders the foreign-holder overlay when the
 * handle reports `ownerUserId !== currentUser.id`.
 */
export function lockHandleFromOutcome(
  entityType: LockEntityType | string,
  entityId: string,
  outcome: AcquireOutcome,
): LockHandle {
  switch (outcome.kind) {
    case 'acquired':
    case 'self':
      return { entityType, entityId, lockId: outcome.lock.id, ownerUserId: outcome.lock.user_id };
    case 'blocked':
      return { entityType, entityId, lockId: null, ownerUserId: outcome.holder.user_id };
    case 'failed':
      return { entityType, entityId, lockId: null, ownerUserId: null };
  }
}

/**
 * Release the lock referenced by `handle`. Safe to call when the handle has
 * no `lockId` (no-op). Swallows errors — a release that 404s (already cleared
 * by `ws_disconnect`) is fine.
 */
export async function releaseHeld(handle: LockHandle | null | undefined): Promise<void> {
  if (handle === null || handle === undefined) return;
  if (handle.lockId === null) return;
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    await etn.locks.release(networkId, handle.lockId);
  } catch {
    // The server may have already cleared it (ws_disconnect on the other end,
    // or a manual reset). Nothing to do.
  }
}

/**
 * Visualise a foreign lock on `handle`: returns the holder's name when the
 * lock belongs to someone else, `null` otherwise. The editor uses this to
 * decide whether to render the «редактирует <имя>» warning.
 */
export function foreignHolderName(handle: LockHandle | null | undefined): string | null {
  if (handle === null || handle === undefined) return null;
  if (handle.ownerUserId === null) return null;
  const me = store.state.me;
  if (me !== null && handle.ownerUserId === me.id) return null;
  return holderNameByUserId(handle.ownerUserId);
}

/**
 * Subscribe to lock-cache transitions so an editor re-renders its overlay
 * when a foreign client grabs or drops the same object mid-session (the
 * store already gets a `lockCacheTick` bump on every transition — this is
 * here for symmetry with the rest of the helpers and to make the intent
 * explicit at the call sites).
 */
export { subscribeLockCache };

/** Human label for the entity type, used in the warning toast. */
function entityLabel(entityType: string): string {
  switch (entityType) {
    case 'thought':
      return 'Эту мысль';
    case 'link':
      return 'Эту связь';
    case 'thought_type':
      return 'Этот тип мысли';
    case 'link_type':
      return 'Этот тип связи';
    case 'property':
      return 'Это свойство';
    default:
      return 'Объект';
  }
}

/** Compact `Error.message` rendering for notices. */
function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
