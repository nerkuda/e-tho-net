/**
 * Pool of {@link RealtimeClient}s, one per open network
 * (07-client-electron.md §2/§4.2, 04-realtime.md §2.0, workplan Q2).
 *
 * Each tab that opens a network calls {@link acquire} — the pool bumps a
 * reference count and lazily creates a socket on first acquire. Closing the
 * last tab of a network calls {@link release}; the socket is torn down when
 * the count returns to zero. This lets a single Electron window hold several
 * open networks at once (with their own `last_seq`, reconnect, applier state)
 * while reusing one shared `RealtimeState` cache.
 *
 * Events/status updates are forwarded to the renderer with the originating
 * `networkId` so the UI can route per-tab dirty markers and status icons
 * (08-ui-spec.md §1.1).
 */
import {
  type AnyRealtimeEvent,
  type CurrentUser,
  REALTIME_CLOSE_CODES,
} from '@etn/shared';
import type { ServerProfileRow } from '../db/local-db.js';
import {
  RealtimeClient,
  normaliseWsUrl,
  type LivenessProbeTrigger,
  type RealtimeStatus,
  type RealtimeStatusDetail,
} from '../net/ws-client.js';
import { RealtimeState, applyRealtimeEvent } from './applier.js';

const NO_USER: string | null = null;

/** Payload of the per-network `realtime:status` broadcast (Q2, de34b35b). */
export interface RealtimeStatusPayload {
  networkId: string;
  status: RealtimeStatus;
  /** Visual qualifier (e.g. `server-restart`), absent for a plain status. */
  detail?: RealtimeStatusDetail;
}

/** One entry of the per-network status snapshot (`realtime.getStatuses`). */
export interface RealtimeStatusSnapshot {
  networkId: string;
  status: RealtimeStatus;
  detail?: RealtimeStatusDetail;
}

/** Payload of the per-network `realtime:networkLost` broadcast (Q5). */
export interface RealtimeNetworkLostPayload {
  networkId: string;
  reason: 'unauthorized' | 'not-found';
}

/** Payload of `realtime:stale` (per-network). */
export interface RealtimeStalePayload {
  networkId: string;
  lastSeq: number;
}

/** Dependencies for {@link TabRealtimePool}. */
export interface TabRealtimePoolOptions {
  /** Active server profile (baseUrl, API-key material). */
  profile: ServerProfileRow;
  /** Returns the installation Client-Id. */
  getClientId: () => string;
  /** Resolves the API-key plaintext just-in-time (main-process safeStorage). */
  getApiKey: () => Promise<string>;
  /** Local store (L5 client_meta for `last_seq`). */
  localDb: import('../db/local-db.js').LocalDb;
  /** Shared in-memory realtime cache (G8, 11-settings-and-state.md §1.4). */
  rtState: RealtimeState;
  /** Resolves the current user id (used by the applier for `member.removed`). */
  getCurrentUserId: () => string | null;
  /** Removes a thought from per-view focus histories across all profiles. */
  removeFromFocusHistoryEverywhere: (thoughtId: string) => void;
  /** Resolves the current focus id for a network — used by the applier. */
  getCurrentFocusId: (networkId: string) => string | null;
  /** Broadcasts an IPC event to the renderer (window may be null/destroyed). */
  broadcast: (channel: string, payload: unknown) => void;
  /**
   * Optional main-process side-channel for status transitions (defect
   * de34b35b): the REST client raises `setLinkDown` per network. Broadcast to
   * the renderer still happens on the same tick.
   */
  onStatus?: (networkId: string, status: RealtimeStatus, detail?: RealtimeStatusDetail) => void;
}

/** One pooled network entry. */
interface PoolEntry {
  client: RealtimeClient;
  /**
   * Число владельцев сети. Сеть — единица владения сокетом: табы одной сети
   * делят ОДИН сокет, повторное `acquire` (открытие сети, второй таб,
   * восстановление профиля) не добавляет ссылку. Поле остаётся для
   * диагностики и инварианта «0 или 1» (ошибка 3cd3f995).
   */
  refCount: number;
}

/**
 * Pool of `RealtimeClient`s, ONE socket per network. Construct on profile
 * connect (one pool per active server profile) and call {@link shutdown} when
 * the profile disconnects.
 *
 * Владение — сетью, не табом (ошибка 3cd3f995): `acquire` идемпотентен, потому
 * что `tabs.open` (ровно один вызов на таб) и `networks.open` (ровно один на
 * открытие сети) описывают ОДНО соединение. `release` зовётся, когда закрыт
 * последний таб сети, и закрывает сокет.
 */
export class TabRealtimePool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly opts: TabRealtimePoolOptions;

  public constructor(opts: TabRealtimePoolOptions) {
    this.opts = opts;
  }

  /**
   * Ensures a socket for `networkId`, opening it lazily on first call.
   * Idempotent: repeated calls for the same network (another tab, network
   * re-open, profile restore) return the same client and keep ONE reference.
   * Safe to call when the socket is already connecting.
   */
  public acquire(networkId: string): RealtimeClient {
    const existing = this.entries.get(networkId);
    if (existing !== undefined) {
      // Инвариант «сеть = одна ссылка»: повторное открытие не копит владельцев,
      // иначе `tabs.close` последнего таба не опускает счётчик до нуля.
      existing.refCount = 1;
      // Re-acquire (tab restored/activated) pushes the CURRENT status to the
      // renderer: without it the indicator keeps the status of whichever
      // network reported last (defect de34b35b, «зелёный не там»).
      this.broadcastStatus(networkId, existing.client);
      return existing.client;
    }
    const client = new RealtimeClient({
      baseUrl: normaliseWsUrl(this.opts.profile.base_url),
      getApiKey: this.opts.getApiKey,
      getClientId: this.opts.getClientId,
      // Capture the network id in the closure so `RealtimeClient` doesn't need
      // to know about the pool (single-responsibility).
      getNetworkId: () => networkId,
      localDb: this.opts.localDb,
    });
    this.wireClient(client, networkId);
    this.entries.set(networkId, { client, refCount: 1 });
    client.connect();
    return client;
  }

  /**
   * Releases the network's single reference (last tab closed): drops the count
   * to zero, closes the socket and removes it from the pool. No-op if
   * `networkId` is not tracked.
   */
  public release(networkId: string): void {
    const entry = this.entries.get(networkId);
    if (entry === undefined) return;
    entry.refCount = 0;
    entry.client.disconnect();
    this.entries.delete(networkId);
  }

  /** Reference count of `networkId` (0 или 1) — диагностика и регресс-тесты. */
  public refCount(networkId: string): number {
    return this.entries.get(networkId)?.refCount ?? 0;
  }

  /** Returns `true` when the pool currently holds a socket for `networkId`. */
  public has(networkId: string): boolean {
    return this.entries.has(networkId);
  }

  /** Snapshot of currently open network ids (for diagnostics / status UI). */
  public activeNetworkIds(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Returns the realtime status for `networkId`, or `'idle'` when no socket
   * is currently held (e.g. all tabs of the network are closed).
   */
  public getStatus(networkId: string): RealtimeStatus {
    const entry = this.entries.get(networkId);
    if (entry === undefined) return 'idle';
    return entry.client.getStatus();
  }

  /**
   * Snapshot of every pooled network's status (defect de34b35b): the renderer
   * pulls it once at boot so per-tab indicators start from the real state
   * instead of waiting for the next transition.
   */
  public statusSnapshot(): RealtimeStatusSnapshot[] {
    const out: RealtimeStatusSnapshot[] = [];
    for (const [networkId, entry] of this.entries) {
      const detail = entry.client.getStatusDetail();
      out.push({
        networkId,
        status: entry.client.getStatus(),
        ...(detail === null ? {} : { detail }),
      });
    }
    return out;
  }

  /**
   * Runs the on-demand liveness probe of `networkId` (defect de34b35b). Used
   * by the IPC layer when a user action hangs: a live connection returns to
   * `connected` on the first frame, a dead one reconnects without waiting for
   * the 37 s silence threshold. No-op for an unknown network.
   */
  public probeLiveness(networkId: string, trigger: LivenessProbeTrigger = 'action'): void {
    this.entries.get(networkId)?.client.probeLiveness(trigger);
  }

  /** Broadcasts one client's current status to the renderer and `onStatus`. */
  private broadcastStatus(networkId: string, client: RealtimeClient): void {
    const detail = client.getStatusDetail();
    const payload: RealtimeStatusPayload = {
      networkId,
      status: client.getStatus(),
      ...(detail === null ? {} : { detail }),
    };
    this.opts.broadcast('realtime:status', payload);
    this.opts.onStatus?.(networkId, payload.status, payload.detail);
  }

  /** Tear down every socket — called on profile disconnect / app shutdown. */
  public shutdown(): void {
    for (const [, entry] of this.entries) {
      try {
        entry.client.disconnect();
      } catch {
        // best-effort teardown
      }
    }
    this.entries.clear();
  }

  /**
   * Force-reconnect every pooled socket right now (defect 7f4cef31): called on
   * system resume (`powerMonitor` 'resume') and on the renderer `online`
   * event, because a socket that lived through a sleep/network switch is often
   * half-open — it still reports `connected` but never delivers frames, and no
   * `close`/`error` will arrive. Pool entries keep their refcounts; each client
   * drops its socket, reconnects immediately (no backoff) and catches up via
   * its per-network `last_seq` with a fresh `resume` (04-realtime.md §6).
   * Entries closed by the user or terminally rejected (4401/4404) are skipped
   * by `RealtimeClient.forceReconnect` itself.
   */
  public forceReconnectAll(): void {
    for (const [, entry] of this.entries) {
      try {
        entry.client.forceReconnect();
      } catch {
        // best-effort: one broken network must not block the others
      }
    }
  }

  /**
   * Re-emits a socket event into the renderer with `networkId` annotation.
   * Status changes are forwarded as `{networkId, status}`; per-network
   * terminal events (`unauthorized`/`not-found`) become `realtime:networkLost`
   * so the renderer can mark the corresponding tab as inaccessible (Q5).
   */
  private wireClient(client: RealtimeClient, networkId: string): void {
    const currentUserId = (): string | null => this.opts.getCurrentUserId();

    client.onTyped('event', (event: AnyRealtimeEvent) => {
      const result = applyRealtimeEvent(
        this.opts.rtState,
        {
          getCurrentUserId: currentUserId,
          removeFromFocusHistoryEverywhere: (thoughtId: string) => {
            this.opts.removeFromFocusHistoryEverywhere(thoughtId);
          },
          getCurrentFocusId: (nid: string) => this.opts.getCurrentFocusId(nid),
        },
        event,
      );
      if (result.applied) this.opts.broadcast('realtime:event', event);
    });
    client.onTyped('status', (status: RealtimeStatus, detail?: RealtimeStatusDetail) => {
      const payload: RealtimeStatusPayload = {
        networkId,
        status,
        ...(detail === undefined ? {} : { detail }),
      };
      this.opts.broadcast('realtime:status', payload);
      this.opts.onStatus?.(networkId, status, detail);
    });
    client.onTyped('stale', (lastSeq: number) => {
      const payload: RealtimeStalePayload = { networkId, lastSeq };
      this.opts.broadcast('realtime:stale', payload);
    });
    client.onTyped('layer-control', (control) => {
      this.opts.broadcast('realtime:layer', { ...control, networkId });
    });
    client.onTyped('unauthorized', () => {
      const payload: RealtimeNetworkLostPayload = {
        networkId,
        reason: 'unauthorized',
      };
      this.opts.broadcast('realtime:networkLost', payload);
    });
    client.onTyped('not-found', () => {
      const payload: RealtimeNetworkLostPayload = { networkId, reason: 'not-found' };
      this.opts.broadcast('realtime:networkLost', payload);
    });
    // Low-level socket errors stay in main for logging; pool consumers do not
    // need them today.
  }
}

/**
 * Helper: resolve the current user id from a `CurrentUser` snapshot or `null`
 * when no profile is active. Reserved for the dependency signature above.
 */
export function resolveCurrentUserId(user: CurrentUser | null): string | null {
  return user?.id ?? NO_USER;
}

/** Shared close-code re-export for callers that need to inspect terminals. */
export { REALTIME_CLOSE_CODES };
