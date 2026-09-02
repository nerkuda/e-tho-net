/**
 * IPC registration (task G7): the `etn:invoke` channel and realtime bridges.
 *
 * Owns the main-process connection state (active `RestClient`,
 * `TabRealtimePool`, profile and current user) and binds it into the handler
 * map from `handlers.ts`. All state lives here — `handlers.ts` stays pure.
 *
 * С фазой Q один `RealtimeClient` заменён пулом (`TabRealtimePool`) — по сокету
 * на каждую открытую сеть; refcount растёт при `etn.tabs.open`/снижается при
 * `etn.tabs.close`.
 */

import { randomUUID } from 'node:crypto';
import { ipcMain, type BrowserWindow } from 'electron';
import { UI_STATE_KEY, type CurrentUser, type Network } from '@etn/shared';

import type { LocalDb, ServerProfileRow } from '../db/local-db.js';
import { decryptApiKey, encryptApiKey } from '../safe-storage.js';
import { RestClient } from '../net/rest-client.js';
import { RealtimeState } from '../realtime/applier.js';
import { TabRealtimePool } from '../realtime/tab-rt-pool.js';
import { createHandlers, selfMutationNetwork } from './handlers.js';
import { connectAndActivate } from './connect-active-profile.js';
import type { IpcInvokePayload } from './contract.js';

/** Options for {@link registerIpc}. */
export interface RegisterIpcOptions {
  localDb: LocalDb;
  /** Stable installation Client-Id (G4). */
  clientId: string;
  /** Resolves the current main window (for realtime broadcast). */
  getWindow: () => BrowserWindow | null;
}

/** Handle returned by {@link registerIpc} (see its docs). */
export interface IpcHandle {
  /** Orderly teardown of the IPC channel and the active connection. */
  shutdown(): void;
  /** Force-reconnect every pooled realtime socket (resume/online, 7f4cef31). */
  forceReconnectRealtime(): void;
  /** Active `RestClient`, or `null` when disconnected. */
  getRest(): RestClient | null;
  /** Network the renderer currently works in, or `null`. */
  getCurrentNetworkId(): string | null;
}

/**
 * Wire the single `etn:invoke` channel plus realtime event/status forwarding.
 * Returns a handle with `shutdown()` for orderly teardown,
 * `forceReconnectRealtime()` for system resume / network-online events
 * (defect 7f4cef31), and accessors for the active connection — used by the
 * `etnimg` protocol fallback that downloads server-stored attachment files.
 */
export function registerIpc(opts: RegisterIpcOptions): IpcHandle {
  let rest: RestClient | null = null;
  let pool: TabRealtimePool | null = null;
  let profile: ServerProfileRow | null = null;
  let currentNetworkId: string | null = null;
  let currentUser: CurrentUser | null = null;
  /** G8 applier state: in-memory thought/link cache + echo suppression. */
  const rtState = new RealtimeState();

  const broadcast = (channel: string, payload: unknown): void => {
    const win = opts.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  const keyResolver = (p: ServerProfileRow): (() => Promise<string>) => {
    return async () => decryptApiKey(p.api_key_encrypted ?? Buffer.alloc(0));
  };

  const connectProfile = async (profileId: string): Promise<CurrentUser> => {
    const p = opts.localDb.getProfile(profileId);
    if (!p) throw new Error(`Unknown server profile: ${profileId}`);

    const restClient = new RestClient({
      baseUrl: p.base_url,
      getApiKey: keyResolver(p),
      getClientId: () => opts.clientId,
    });
    // key check before anything else; only a successful check persists the
    // profile as active (defect «клиент не запоминает сервер»: previously
    // only `addProfile` called `setActiveProfile`, so re-selecting an
    // already-saved profile via `server.connect` left the DB flag on
    // whichever profile was added last, and the next launch reconnected to
    // the wrong server).
    const me = await connectAndActivate(opts.localDb, profileId, () => restClient.getMe());

    const rtPool = new TabRealtimePool({
      profile: p,
      getClientId: () => opts.clientId,
      getApiKey: keyResolver(p),
      localDb: opts.localDb,
      rtState,
      getCurrentUserId: () => currentUser?.id ?? p.user_id ?? null,
      removeFromFocusHistoryEverywhere: (thoughtId: string) => {
        // The unified visit history (11 §2.3.1, 0.5.5). Pool only carries one
        // active network at a time per applier invocation; we sweep every
        // known network via the saved tabs (Q2/Q3).
        for (const saved of opts.localDb.listProfiles()) {
          for (const tab of opts.localDb.listTabs(saved.id)) {
            opts.localDb.removeVisitHistory(saved.id, tab.network_id, tab.tab_id, thoughtId);
          }
        }
      },
      getCurrentFocusId: (nid: string) => {
        if (!profile) return null;
        // Walk active tabs to find the focus for the requested network — this
        // is a per-network query, used by the applier when echoing back.
        for (const tab of opts.localDb.listTabs(profile.id)) {
          if (tab.network_id !== nid) continue;
          const focusId = opts.localDb.getUiState(profile.id, nid, UI_STATE_KEY.CURRENT_FOCUS_THOUGHT_ID, tab.tab_id);
          if (focusId !== null) return focusId;
        }
        // Legacy fallback: tab-less rows (migration 001–004).
        return opts.localDb.getUiState(profile.id, nid, UI_STATE_KEY.CURRENT_FOCUS_THOUGHT_ID, null);
      },
      broadcast,
    });

    rest = restClient;
    pool = rtPool;
    profile = p;
    currentUser = me;

    // Q2: re-acquire realtime sockets for every previously open tab so non-
    // active tabs still receive events (dirty-marker «*» requirement).
    const restoredNetworks = new Set<string>();
    for (const tab of opts.localDb.listTabs(p.id)) {
      if (restoredNetworks.has(tab.network_id)) continue;
      restoredNetworks.add(tab.network_id);
      rtPool.acquire(tab.network_id);
    }
    return me;
  };

  /** H2: save a new profile (key encrypted via safeStorage) and connect it. */
  const addProfile = async (input: {
    label: string;
    baseUrl: string;
    apiKey: string;
  }): Promise<CurrentUser> => {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error('Адрес сервера должен начинаться с http:// или https://');
    }
    if (input.apiKey.trim() === '') {
      throw new Error('API-key не может быть пустым.');
    }
    const id = randomUUID();
    const encrypted = encryptApiKey(input.apiKey);
    opts.localDb.insertProfile({
      id,
      label: input.label.trim() || baseUrl,
      base_url: baseUrl,
      api_key_encrypted: encrypted,
      is_active: true,
    });
    opts.localDb.setActiveProfile(id);
    return connectProfile(id);
  };

  const disconnect = (): void => {
    try {
      pool?.shutdown();
    } catch {
      // best-effort: dropping the reference below is the real teardown
    }
    pool = null;
    rest = null;
    profile = null;
    currentNetworkId = null;
    currentUser = null;
  };

  /**
   * Force-reconnect every pooled realtime socket (defect 7f4cef31). Called on
   * system resume (powerMonitor, index.ts) and on the renderer `online` event
   * (forwarded here as `etn:realtime:online` from the preload bridge): a socket
   * that lived through a sleep or a network switch is often half-open, so we
   * proactively re-establish instead of waiting for the idle watchdog.
   */
  const forceReconnectRealtime = (): void => {
    try {
      pool?.forceReconnectAll();
    } catch {
      // best-effort — individual clients also swallow their own errors
    }
  };

  const openNetwork = async (networkId: string): Promise<Network> => {
    if (!rest) throw new Error('Not connected: call etn.server.connect first');
    const network = await rest.getNetwork(networkId);
    currentNetworkId = networkId;
    if (profile) {
      opts.localDb.setUiState(profile.id, networkId, UI_STATE_KEY.CURRENT_NETWORK_ID, networkId);
    }
    // Q2: explicit acquire via pool. The picker creates its own tab via
    // `etn.tabs.open` (which also acquires, refcount-style); the legacy
    // `etn.networks.open` path stays idempotent for tab state.
    pool?.acquire(networkId);
    return network;
  };

  const handlers = createHandlers({
    localDb: opts.localDb,
    getRest: () => rest,
    getRealtimePool: () => pool,
    getProfile: () => profile,
    connectProfile,
    addProfile,
    disconnect,
    getCurrentNetworkId: () => currentNetworkId,
    openNetwork,
    broadcastRealtimeEvent: (event) => broadcast('realtime:event', event),
    broadcastRealtimeStatus: (status) => broadcast('realtime:status', status),
  });

  ipcMain.handle('etn:invoke', async (_event, payload: IpcInvokePayload) => {
    const handler = handlers.get(payload.method);
    if (!handler) {
      throw new Error(`Unknown IPC method: ${payload.method}`);
    }
    const result = await handler(payload.args ?? []);
    // Own network mutation (08-ui-spec.md §2.2): the server suppresses own
    // echoes (04-realtime.md §5), so the renderer never hears about the write
    // over the realtime socket — flag it so the canvas layer-override marking
    // refreshes right away instead of on the next layer/tab switch.
    const mutatedNetwork = selfMutationNetwork(payload.method, payload.args ?? []);
    if (mutatedNetwork !== null) {
      broadcast('realtime:selfmut', { networkId: mutatedNetwork });
    }
    return result;
  });

  // One-way channel from the renderer's `window.online` DOM event (defect
  // 7f4cef31): main owns the sockets, so network-restored notifications must
  // cross the bridge even though they carry no request/response payload.
  const onRendererOnline = (): void => forceReconnectRealtime();
  ipcMain.on('etn:realtime:online', onRendererOnline);

  return {
    shutdown() {
      ipcMain.removeListener('etn:realtime:online', onRendererOnline);
      disconnect();
    },
    /** Force-reconnect every pooled realtime socket (resume/online, 7f4cef31). */
    forceReconnectRealtime,
    getRest: () => rest,
    getCurrentNetworkId: () => currentNetworkId,
  };
}
