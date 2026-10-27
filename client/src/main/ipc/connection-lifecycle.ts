/**
 * Connection lifecycle and the «late openNetwork» guard (defect 50fe8807).
 *
 * Owns the main-process connection state (active REST client, realtime pool,
 * profile, current user), `currentNetworkId` and the `openNetwork` epoch.
 *
 * Split out of `register.ts` on purpose: that module imports `electron`
 * (`ipcMain`) transitively through `safe-storage.js`, which cannot be loaded
 * outside an Electron runtime — so the lifecycle could not be unit tested if it
 * stayed there. This file has no Electron dependency and runs under the plain
 * `node --test` harness (same precedent as `connect-active-profile.ts`).
 *
 * ## Why an epoch at all
 *
 * `openNetwork` awaits a network round-trip (`GET /networks/:id`). Whatever
 * happened in main while the request was in flight decides whether the answer
 * may still be applied:
 *
 *   - another `openNetwork` started  → the LAST click wins (defect 58c55bb9);
 *   - `disconnect()` happened       → the answer belongs to a dead session and
 *     must not resurrect `currentNetworkId` / poke the pool (50fe8807);
 *   - `connectProfile()` to another server happened → the answer came from the
 *     OLD server; applying it would write the old network id into the NEW
 *     profile's UI state and open a pool socket under a foreign network id
 *     (50fe8807).
 *
 * A resume of the same connection (`forceReconnectRealtime`, defect 7f4cef31)
 * is NOT such an event: the session is the same, so the epoch stays put —
 * otherwise a legitimate post-resume open would be discarded.
 */
import { UI_STATE_KEY, type Network } from '@etn/shared';

/** Minimal REST-client shape used by {@link ConnectionLifecycle.openNetwork}. */
export interface NetworkReader {
  getNetwork(networkId: string): Promise<Network>;
}

/** Minimal realtime-pool shape used by the lifecycle. */
export interface PoolHandle {
  acquire(networkId: string): void;
  shutdown(): void;
  forceReconnectAll(): void;
}

/** Profile row shape: only the identity is load-bearing here. */
export interface ProfileRef {
  id: string;
}

/** Injected persistence hook (`LocalDb.setUiState`). */
export interface ConnectionLifecycleOptions {
  setUiState(profileId: string, networkId: string, key: string, value: string): void;
}

/** Snapshot passed to {@link ConnectionLifecycle.activate}. */
export interface ActivatedConnection<TRest, TPool, TProfile, TUser> {
  rest: TRest;
  pool: TPool;
  profile: TProfile;
  currentUser: TUser;
}

/**
 * Main-process connection state: one active server profile at a time, plus the
 * epoch that decides whether an in-flight `openNetwork` may still publish.
 */
export class ConnectionLifecycle<
  TRest extends NetworkReader = NetworkReader,
  TPool extends PoolHandle = PoolHandle,
  TProfile extends ProfileRef = ProfileRef,
  TUser = unknown,
> {
  private rest: TRest | null = null;
  private pool: TPool | null = null;
  private profile: TProfile | null = null;
  private currentUser: TUser | null = null;
  private currentNetworkId: string | null = null;
  private openNetworkSeq = 0;

  constructor(private readonly opts: ConnectionLifecycleOptions) {}

  getRest(): TRest | null {
    return this.rest;
  }

  getPool(): TPool | null {
    return this.pool;
  }

  getProfile(): TProfile | null {
    return this.profile;
  }

  getCurrentUser(): TUser | null {
    return this.currentUser;
  }

  /** Network the renderer currently works in, or `null` when none is applied. */
  getCurrentNetworkId(): string | null {
    return this.currentNetworkId;
  }

  /**
   * Publishes a successfully established connection (called by
   * `connectProfile` only AFTER the profile key-check resolved: a failed
   * connect attempt must leave the live session untouched).
   *
   * Bumps the epoch first: an in-flight `openNetwork` of the PREVIOUS server
   * must not land in the new profile. The previous realtime pool is torn down —
   * otherwise its sockets outlive the profile switch (the old lifecycle left
   * them running until the next disconnect).
   */
  activate(next: ActivatedConnection<TRest, TPool, TProfile, TUser>): void {
    this.openNetworkSeq += 1;
    this.currentNetworkId = null;
    if (this.pool !== null && this.pool !== next.pool) {
      try {
        this.pool.shutdown();
      } catch {
        // best-effort: dropping the reference below is the real teardown
      }
    }
    this.rest = next.rest;
    this.pool = next.pool;
    this.profile = next.profile;
    this.currentUser = next.currentUser;
  }

  /**
   * Drops the connection (H18 / profile removal / app shutdown).
   *
   * `openNetworkSeq` is bumped as the FIRST action, synchronously: the epoch
   * must move before any continuation of an awaiting `openNetwork` can run,
   * exactly like a network switch does (58c55bb9). Without it a late
   * `GET /networks/:id` answer passes the staleness check, writes
   * `currentNetworkId`, persists UI state and opens a pool socket for a
   * disconnected server (50fe8807).
   */
  disconnect(): void {
    this.openNetworkSeq += 1;
    this.currentNetworkId = null;
    try {
      this.pool?.shutdown();
    } catch {
      // best-effort: dropping the reference below is the real teardown
    }
    this.pool = null;
    this.rest = null;
    this.profile = null;
    this.currentUser = null;
  }

  /**
   * Force-reconnect every pooled realtime socket (defect 7f4cef31: system
   * resume / network-online). This is a RESUME of the same connection, so the
   * `openNetwork` epoch is deliberately NOT bumped: an open that was in flight
   * across a sleep is still legitimate.
   */
  forceReconnectRealtime(): void {
    try {
      this.pool?.forceReconnectAll();
    } catch {
      // best-effort — individual clients also swallow their own errors
    }
  }

  /**
   * Opens a network: fetches its metadata and, if this run is still current,
   * publishes `currentNetworkId`, persists the UI state and acquires the pool
   * socket.
   *
   * A stale run still RETURNS the fetched network (the renderer already has
   * the request in flight and needs a value to settle), but applies NOTHING —
   * no `currentNetworkId`, no `ui_state` row, no socket. Stale means: a newer
   * open started, the connection was disconnected, or the profile changed
   * while the request was in flight. The identity check on `rest` is defence
   * in depth: a future lifecycle branch that forgets to bump the epoch still
   * cannot publish an answer fetched by another server's client.
   */
  async openNetwork(networkId: string): Promise<Network> {
    const restAtCall = this.rest;
    if (restAtCall === null) throw new Error('Not connected: call etn.server.connect first');
    const seq = ++this.openNetworkSeq;
    const network = await restAtCall.getNetwork(networkId);
    if (seq !== this.openNetworkSeq || restAtCall !== this.rest) return network;
    this.currentNetworkId = networkId;
    const profile = this.profile;
    if (profile !== null) {
      this.opts.setUiState(
        profile.id,
        networkId,
        UI_STATE_KEY.CURRENT_NETWORK_ID,
        networkId,
      );
    }
    // Сеть — единица владения сокетом: `tabs.open` (на каждый таб) и этот
    // acquire делят ОДНУ ссылку, повторный вызов её не копит (ошибка
    // 3cd3f995). Сокет закрывается на `tabs.close` последнего таба сети.
    this.pool?.acquire(networkId);
    return network;
  }
}
