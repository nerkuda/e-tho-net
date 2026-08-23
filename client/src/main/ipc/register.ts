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
import { createHandlers } from './handlers.js';
import type { IpcInvokePayload } from './contract.js';

/** Options for {@link registerIpc}. */
export interface RegisterIpcOptions {
  localDb: LocalDb;
  /** Stable installation Client-Id (G4). */
  clientId: string;
  /** Resolves the current main window (for realtime broadcast). */
  getWindow: () => BrowserWindow | null;
}

/**
 * Wire the single `etn:invoke` channel plus realtime event/status forwarding.
 * Returns a handle with `shutdown()` for orderly teardown.
 */
export function registerIpc(opts: RegisterIpcOptions): { shutdown(): void } {
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
    const me = await restClient.getMe(); // key check before anything else

    const rtPool = new TabRealtimePool({
      profile: p,
      getClientId: () => opts.clientId,
      getApiKey: keyResolver(p),
      localDb: opts.localDb,
      rtState,
      getCurrentUserId: () => currentUser?.id ?? p.user_id ?? null,
      removeFromFocusHistoryEverywhere: (thoughtId: string) => {
        // Both per-view histories (focus + structures, 11 §2.3.1). Pool only
        // carries one active network at a time per applier invocation; we
        // sweep every known network via the saved tabs (Q2/Q3).
        for (const saved of opts.localDb.listProfiles()) {
          for (const scope of ['focus', 'structures'] as const) {
            for (const tab of opts.localDb.listTabs(saved.id)) {
              opts.localDb.removeFocusHistory(saved.id, tab.network_id, tab.tab_id, thoughtId, scope);
            }
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
    return await handler(payload.args ?? []);
  });

  return {
    shutdown() {
      disconnect();
    },
  };
}
