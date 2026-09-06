/**
 * Object-lock cache for the renderer (task 4f141756 «Захваты в клиенте»,
 * операция 8919b057 «/locks», элементы UI 8e3703ee и ae74b044).
 *
 * Holds the projection of `object_locks` rows the renderer cares about — keyed
 * by `entity_type:entity_id` (one row per entity, last-write-wins) — and
 * exposes pure helpers that drive:
 *
 *  - the editor/dialog overlay (a foreign lock blocks writes, the user's own
 *    lock gets a soft «вы редактируете» frame),
 *  - the canvas 🔒 icon (tooltip: «редактирует <имя>»),
 *  - the «Участники мыслесети» panel (badge + «Снять все блокировки» button),
 *  - auto-acquire (`acquire()` no-ops when another user already holds the
 *    object — the editor renders the warning instead of attempting a write
 *    that would 409).
 *
 * The cache is updated by the realtime subscriber in `initLockCache()` and by
 * the explicit `refresh()` call after a manual `clear`. It never reaches
 * into the network itself; callers route through `etn.locks.*` (preload IPC).
 *
 * Designed to be cheap to import: no module-level side effects, no DOM
 * touches. The single subscription is wired by `initLockCache()` from
 * `app.ts` on boot.
 */

import type {
  EditAcquiredData,
  EditClearedData,
  EditReleasedData,
  LockClearedReason,
  LockRow,
} from '@etn/shared';

import { etn } from './etn.js';
import { requireNetworkId } from '../app.js';
import { onRealtimeEvent } from '../realtime.js';
import { store } from '../state.js';
import { resolve as resolveCachedUserName } from './users.js';

/** Stable key for the cache map and `state.lockCache`. */
export type LockKey = string;

/** Build a stable cache key from an entity pair. */
export function lockKey(entityType: string, entityId: string): LockKey {
  return `${entityType}:${entityId}`;
}

/** Parse a key back into its parts. Returns `null` if the shape is wrong. */
export function parseLockKey(key: LockKey): { entityType: string; entityId: string } | null {
  const sep = key.indexOf(':');
  if (sep < 1 || sep >= key.length - 1) return null;
  return { entityType: key.slice(0, sep), entityId: key.slice(sep + 1) };
}

/**
 * Single source of truth for active locks in the renderer. Keyed by
 * `${entity_type}:${entity_id}`; the value is the most recently seen `LockRow`
 * (the realtime event order matches server insertion order — see
 * `domain/lock-service.ts`).
 */
const cache = new Map<LockKey, LockRow>();

const listeners = new Set<() => void>();

let realtimeWired = false;
let lastBroadcastSeq = 0;

/** Subscribes to cache transitions; returns an unsubscribe function. */
export function subscribeLockCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Snapshot of the cache as an array (insertion order — matches realtime
 * arrival order, which mirrors server acquisition order).
 */
export function listLocks(): LockRow[] {
  return Array.from(cache.values());
}

/** Lookup by key. Returns `undefined` when nothing is locked on that entity. */
export function getLock(entityType: string, entityId: string): LockRow | undefined {
  return cache.get(lockKey(entityType, entityId));
}

/** Lookup by pre-built key. */
export function getLockByKey(key: LockKey): LockRow | undefined {
  return cache.get(key);
}

/**
 * Convenience: lock for `entityType`/`entityId` only when the holder is NOT
 * the current user. Used by the editor overlay (`otherHolder`) and the
 * canvas 🔒 icon (`isLockedByOther`).
 */
export function otherHolder(entityType: string, entityId: string): LockRow | null {
  const row = getLock(entityType, entityId);
  if (row === undefined) return null;
  const me = store.state.me;
  if (me !== null && row.user_id === me.id) return null;
  return row;
}

/** True iff the current user holds the lock on this entity. */
export function isOwnLock(entityType: string, entityId: string): boolean {
  const row = getLock(entityType, entityId);
  if (row === undefined) return false;
  const me = store.state.me;
  return me !== null && row.user_id === me.id;
}

/**
 * Best-effort display name of the holder. Resolves through `lib/users.ts`;
 * falls back to `<id>` when the cache is empty AND the holder is not the
 * current user (the typical case for `otherHolder` callers — the admin
 * roster is only fetched when the panel is open).
 */
export function holderName(row: LockRow): string {
  return resolveCachedUserName(row.user_id) ?? row.user_id;
}

/**
 * Same as {@link holderName} but takes a raw `user_id`. Used by callers that
 * already extracted the id (e.g. the canvas link overlay where the lock row
 * is fetched inside a tight SVG-draw loop).
 */
export function holderNameByUserId(userId: string): string {
  return resolveCachedUserName(userId) ?? userId;
}

/**
 * Best-effort display name for the lock owner — convenience over
 * {@link holderName} for callers that already have `(entityType, entityId)`.
 */
export function holderNameFor(entityType: string, entityId: string): string | null {
  const row = getLock(entityType, entityId);
  if (row === undefined) return null;
  return holderName(row);
}

/** Internal: insert / replace a row and notify. */
function upsert(row: LockRow): void {
  cache.set(lockKey(row.entity_type, row.entity_id), row);
  notify();
}

/** Internal: drop a row by key and notify. */
function dropByKey(key: LockKey): void {
  if (cache.delete(key)) notify();
}

/** Notify listeners (canvas re-render, editor overlay refresh). */
function notify(): void {
  lastBroadcastSeq += 1;
  for (const listener of listeners) listener();
}

/**
 * Push a snapshot of the cache into the shared store so canvas / editor
 * components that read `store.state.lockCache` re-render automatically.
 * Called from {@link notify} through `initLockCache()`.
 */
function syncToStore(): void {
  const snapshot: Record<string, LockRow> = {};
  for (const [key, row] of cache.entries()) snapshot[key] = row;
  store.update({ lockCache: snapshot, lockCacheTick: lastBroadcastSeq });
}

/** Internal: drop every row, used on network switch. */
function clearAll(): void {
  if (cache.size === 0) return;
  cache.clear();
  notify();
}

/**
 * Drop everything belonging to a single network (currently the only one — the
 * API keeps the key set global on purpose, so on a network switch we wipe).
 */
function dropNetwork(networkId: string): void {
  const prefix = `${networkId}|`;
  let changed = false;
  for (const key of cache.keys()) {
    // LockRow itself does NOT carry network_id; the key is `type:id`, so a
    // global wipe on network switch is the only safe option. (The renderer
    // is single-network anyway.)
    void prefix;
    void networkId;
    cache.delete(key);
    changed = true;
  }
  if (changed) notify();
}

/** Handle `edit.acquired` — insert or refresh the row. */
function handleAcquired(data: EditAcquiredData): void {
  upsert({
    id: data.lock_id,
    entity_type: data.entity_type,
    entity_id: data.entity_id,
    user_id: data.user_id,
    client_id: data.client_id,
    acquired_at_ms: data.acquired_at_ms,
  });
}

/** Handle `edit.released` — drop the row by its lock_id (if still present). */
function handleReleased(data: EditReleasedData): void {
  for (const [key, row] of cache.entries()) {
    if (row.id === data.lock_id) {
      dropByKey(key);
      return;
    }
  }
}

/** Handle `edit.cleared` — drop the row; expose the reason for the editor toast. */
export interface ClearedEvent extends EditClearedData {
  /** Surfaced for any subscriber that wants to render a toast. */
}
function handleCleared(data: EditClearedData): LockClearedReason {
  for (const [key, row] of cache.entries()) {
    if (row.id === data.lock_id) {
      dropByKey(key);
      return data.reason;
    }
  }
  return data.reason;
}

/**
 * Initialize the realtime subscriber — wires `edit.acquired` / `edit.released`
 * / `edit.cleared` into the cache and tears down on network switch. Idempotent.
 */
export function initLockCache(): void {
  if (realtimeWired) return;
  realtimeWired = true;

  // Mirror every transition into the shared store so renderer components
  // pick it up through their normal `store.subscribe` wiring.
  listeners.add(syncToStore);
  syncToStore();

  onRealtimeEvent((evt) => {
    if (evt.type === 'edit.acquired') handleAcquired(evt.data);
    else if (evt.type === 'edit.released') handleReleased(evt.data);
    else if (evt.type === 'edit.cleared') handleCleared(evt.data);
    else if (evt.type === 'network.deleted') clearAll();
    else if (evt.type === 'member.removed' && store.state.me?.id === evt.data.user_id) clearAll();
  });

  // Network switch — drop everything; the new network's locks arrive through
  // the cold-start `refresh()` triggered by the editor / canvas.
  store.subscribe(() => {
    const next = store.state.networkId;
    if (next === null && cache.size > 0) clearAll();
  });
}

/**
 * Cold-start fetch: pulls `GET /locks` once for the open network and seeds the
 * cache. Best-effort — silently ignores errors (network down, no rights). The
 * realtime stream will fill in whatever arrives after this call.
 */
export async function refresh(): Promise<void> {
  const networkId = requireNetworkId();
  try {
    const rows = await etn.locks.list(networkId);
    // Replace the cache wholesale — the server is the source of truth.
    cache.clear();
    for (const row of rows) cache.set(lockKey(row.entity_type, row.entity_id), row);
    notify();
  } catch {
    // Non-fatal: live events will fill the cache as they arrive.
  }
}

/**
 * Replace the cache with `rows` directly (used by the «Снять все блокировки»
 * path — after a successful `clear` the server fan-outs `edit.cleared` events
 * that already drove the cache empty; this helper is for tests and for the
 * manual reset optimistic path).
 */
export function __setForTests(rows: LockRow[]): void {
  cache.clear();
  for (const row of rows) cache.set(lockKey(row.entity_type, row.entity_id), row);
  notify();
}

/** Test hook — clears the cache between unit tests. */
export function __resetForTests(): void {
  cache.clear();
  realtimeWired = false;
  lastBroadcastSeq = 0;
  listeners.clear();
}

/** Monotonic sequence of broadcasts — useful for memoisation in tests. */
export function broadcastSeq(): number {
  return lastBroadcastSeq;
}

export { dropNetwork as __dropNetworkForTests };
