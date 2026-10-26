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
import { errText } from './dom.js';
import {
  otherHolder,
  getLock,
  subscribeLockCache,
  holderName,
  holderNameByUserId,
  dropLockById,
  refresh as refreshLockCache,
  __setForTests as seedCache,
} from './lock-cache.js';
import { notice } from './notice.js';
import { requireNetworkId } from '../app.js';
import { getRtStatus, store, type RtStatus } from '../state.js';

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
  /** Network the lock belongs to; `null` when it was built with no open network. */
  networkId: string | null;
}

/**
 * Live handles — the locks the renderer believes it holds right now. Locks
 * live only as long as the realtime session: the server drops them on
 * `ws_disconnect`, so after a reconnect the ids in the handles are dead. The
 * registry lets {@link reacquireHeldLocks} restore the locks of the still-open
 * editors (ошибка 0702efb6).
 */
const heldLocks = new Set<LockHandle>();

/**
 * Attempt to acquire the lock on `(entityType, entityId)`. If the cache says
 * another user holds it, we return `Blocked` without an extra round-trip;
 * the editor renders the warning state immediately.
 */
export async function acquireOrShowBlocked(
  entityType: LockEntityType | string,
  entityId: string,
): Promise<AcquireOutcome> {
  const existing = getLock(entityType, entityId);
  if (existing !== undefined) {
    const me = store.state.me;
    if (me !== null && existing.user_id === me.id) {
      return { kind: 'self', lock: existing };
    }
    notice(blockedByLockMessage(entityType, existing), 'warning');
    return { kind: 'blocked', holder: existing };
  }

  try {
    // `requireNetworkId()` может бросить (сеть закрыта, ошибка 85edaad1): вызов
    // внутри try сохраняет контракт хелпера — неудачный захват не блокирует
    // работу, а оборачивается исходом `failed`.
    const networkId = requireNetworkId();
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
      notice(blockedByLockMessage(entityType, holder), 'warning');
      return { kind: 'blocked', holder };
    }
    notice(`Не удалось поставить захват: ${stringifyError(err)}`, 'warning');
    return { kind: 'failed', error: err };
  }
}

/**
 * Синхронная проверка чужого захвата перед входом в правку (ошибка
 * 132c80bd): если объект держит другой пользователь — сообщаем об этом тем же
 * тостом, что и {@link acquireOrShowBlocked}, и возвращаем `true` («правка
 * запрещена»). Сервер всё равно отклонит запись 409, поэтому редактор не
 * должен притворяться редактируемым; чтение при этом не блокируется
 * (ADR 705fb6d3 — «чтение не блокируется»).
 *
 * Кэш захватов может быть ещё холодным (тогда `false` — вход разрешён, а
 * `acquireOrShowBlocked` добьёт проверку запросом и отменит правку на 409).
 */
export function foreignLockBlocksEdit(entityType: LockEntityType | string, entityId: string): boolean {
  const existing = otherHolder(entityType, entityId);
  if (existing === null) return false;
  notice(blockedByLockMessage(entityType, existing), 'warning');
  return true;
}

/**
 * Чужой захват по кэшу без тоста — для синхронизации состояния полей
 * (ошибка 4f18d9f5): заголовок мысли и прочие поверхности должны выглядеть
 * заблокированными ровно так же, как ведёт себя запись.
 */
export function foreignLockHeld(entityType: LockEntityType | string, entityId: string): boolean {
  return otherHolder(entityType, entityId) !== null;
}

/** Единый текст «объект редактирует <имя> — поля заблокированы». */
export function blockedByLockMessage(entityType: LockEntityType | string, holder: LockRow): string {
  return `${entityLabel(entityType)} редактирует ${holderName(holder)} — поля заблокированы.`;
}

/**
 * Build a {@link LockHandle} from an {@link AcquireOutcome}. When the
 * outcome is `Blocked` or `Failed` the `lockId` is `null` (nothing to
 * release); the editor still renders the foreign-holder overlay when the
 * handle reports `ownerUserId !== currentUser.id`.
 *
 * Handles that actually own a lock are registered for post-reconnect
 * restoration ({@link reacquireHeldLocks}); {@link releaseHeld} unregisters
 * them.
 */
export function lockHandleFromOutcome(
  entityType: LockEntityType | string,
  entityId: string,
  outcome: AcquireOutcome,
): LockHandle {
  const networkId = store.state.networkId;
  switch (outcome.kind) {
    case 'acquired':
    case 'self': {
      const handle: LockHandle = {
        entityType,
        entityId,
        lockId: outcome.lock.id,
        ownerUserId: outcome.lock.user_id,
        networkId,
      };
      heldLocks.add(handle);
      return handle;
    }
    case 'blocked':
      return {
        entityType,
        entityId,
        lockId: null,
        ownerUserId: outcome.holder.user_id,
        networkId,
      };
    case 'failed':
      return { entityType, entityId, lockId: null, ownerUserId: null, networkId };
  }
}

/**
 * Release the lock referenced by `handle`. Safe to call when the handle has
 * no `lockId` (no-op). Swallows errors — a release that 404s (already cleared
 * by `ws_disconnect`) is fine.
 *
 * The handle is unregistered from the post-reconnect restoration and its cache
 * row is dropped as soon as the release is confirmed (or reported gone): a dead
 * lock id must not leave a phantom 🔒 behind (ошибка 0702efb6).
 */
export async function releaseHeld(handle: LockHandle | null | undefined): Promise<void> {
  if (handle === null || handle === undefined) return;
  heldLocks.delete(handle);
  const lockId = handle.lockId;
  handle.lockId = null;
  if (lockId === null) return;
  const networkId = handle.networkId ?? store.state.networkId;
  if (networkId === null) return;
  try {
    await etn.locks.release(networkId, lockId);
    dropLockById(lockId);
  } catch (err) {
    // The server may have already cleared it (ws_disconnect on the other end,
    // or a manual reset). The row is dead either way.
    if (err instanceof EtnError && err.code === 'NOT_FOUND') dropLockById(lockId);
  }
}

/**
 * Re-acquire the locks of the still-open editors after the realtime connection
 * is restored (ошибка 0702efb6).
 *
 * Locks live only as long as the session: the server drops them on
 * `ws_disconnect`, while the client cache keeps the old rows until the next
 * refresh. Call this strictly after a SUCCESSFUL cache refresh — against the
 * server truth; otherwise `acquireOrShowBlocked` answers `self` from a stale row
 * and no real lock is taken.
 */
export async function reacquireHeldLocks(
  networkId: string | null = store.state.networkId,
): Promise<void> {
  if (networkId === null) return;
  for (const handle of Array.from(heldLocks)) {
    if (handle.networkId !== networkId) continue;
    // The surface may have been closed while the walk was running.
    if (!heldLocks.has(handle)) continue;
    const outcome = await acquireOrShowBlocked(handle.entityType, handle.entityId);
    if (!heldLocks.has(handle)) continue;
    switch (outcome.kind) {
      case 'acquired':
      case 'self':
        handle.lockId = outcome.lock.id;
        handle.ownerUserId = outcome.lock.user_id;
        break;
      case 'blocked':
        // Another user took the object while we were away — nothing to
        // restore, and retrying on the next reconnect makes no sense.
        handle.lockId = null;
        handle.ownerUserId = outcome.holder.user_id;
        heldLocks.delete(handle);
        break;
      case 'failed':
        // The network is down again: the old id is dead, so the honest state
        // is «no lock»; the next reconnect will try again.
        handle.lockId = null;
        handle.ownerUserId = null;
        break;
    }
  }
}

let reconnectWired = false;

/**
 * Restore held locks after a reconnect (ошибка 0702efb6): when the active
 * network's realtime status transitions into `connected`, the lock cache is
 * re-read from the server and then every lock held by an open editor is taken
 * again. Idempotent; wired from `app.ts` on boot.
 */
export function initLockReconnect(): void {
  if (reconnectWired) return;
  reconnectWired = true;
  let lastStatus: RtStatus = getRtStatus(store.state);
  let lastNetworkId = store.state.networkId;
  store.subscribe(() => {
    const networkId = store.state.networkId;
    const status = getRtStatus(store.state);
    const restored =
      status === 'connected' && (lastStatus !== 'connected' || lastNetworkId !== networkId);
    lastStatus = status;
    lastNetworkId = networkId;
    if (!restored || networkId === null) return;
    void refreshLockCache().then((ok) => {
      // A failed refresh is no reason to act on a stale picture — the next
      // reconnect will retry.
      if (ok) void reacquireHeldLocks(networkId);
    });
  });
}

/** Test hook — forgets tracked handles and the reconnect wire between tests. */
export function __resetLockGuardForTests(): void {
  heldLocks.clear();
  reconnectWired = false;
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
 * Подписка на состояние чужого захвата объекта: `onChange` вызывается сразу
 * (по текущему кэшу) и на каждый переход кэша — `holder` равен строке захвата,
 * когда объект держит ДРУГОЙ пользователь, и `null`, когда захвата нет.
 *
 * Нужен поверхностям, которые уже открыты: диалог, переведённый в чтение,
 * обязан вернуться в редактирование, как только чужой захват снят (ошибка
 * 2301d73d), без переоткрытия. Возвращает функцию отписки — вызывать при
 * закрытии/демонтаже поверхности.
 */
export function subscribeForeignLockState(
  entityType: LockEntityType | string,
  entityId: string,
  onChange: (holder: LockRow | null) => void,
): () => void {
  const apply = (): void => onChange(otherHolder(entityType, entityId));
  const unsubscribe = subscribeLockCache(apply);
  apply();
  return unsubscribe;
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
  return errText(err);
}
