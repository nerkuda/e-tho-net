/**
 * IPC registration (task G7): the `etn:invoke` channel and realtime bridges.
 *
 * Owns the main-process connection state (active `RestClient`, `RealtimeClient`,
 * profile and current network) and binds it into the handler map from
 * `handlers.ts`. All state lives here — `handlers.ts` stays pure.
 */

import { randomUUID } from 'node:crypto';
import { ipcMain, type BrowserWindow } from 'electron';
import { UI_STATE_KEY, type CurrentUser, type Network } from '@etn/shared';

import type { LocalDb, ServerProfileRow } from '../db/local-db.js';
import { decryptApiKey, encryptApiKey } from '../safe-storage.js';
import { RestClient } from '../net/rest-client.js';
import { RealtimeClient, normaliseWsUrl } from '../net/ws-client.js';
import { RealtimeState, applyRealtimeEvent } from '../realtime/applier.js';
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
  let rt: RealtimeClient | null = null;
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

    const rtClient = new RealtimeClient({
      baseUrl: normaliseWsUrl(p.base_url),
      getApiKey: keyResolver(p),
      getClientId: () => opts.clientId,
      getNetworkId: () => currentNetworkId,
      localDb: opts.localDb,
    });
    rtClient.onTyped('event', (event) => {
      // G8: apply the event to the local cache, drop own-client echoes, maintain
      // focus history; only accepted events reach the renderer.
      const result = applyRealtimeEvent(
        rtState,
        {
          getClientId: () => opts.clientId,
          getCurrentUserId: () => currentUser?.id ?? p.user_id ?? null,
          removeFromFocusHistoryEverywhere: (thoughtId: string) => {
            const nid = currentNetworkId;
            if (!nid) return;
            // Both per-view histories (focus + structures, 11 §2.3.1).
            const scopes = ['focus', 'structures'] as const;
            for (const saved of opts.localDb.listProfiles()) {
              for (const scope of scopes) {
                opts.localDb.removeFocusHistory(saved.id, nid, thoughtId, scope);
              }
            }
          },
          getCurrentFocusId: (nid: string) => {
            if (!profile) return null;
            return opts.localDb.getUiState(profile.id, nid, UI_STATE_KEY.CURRENT_FOCUS_THOUGHT_ID);
          },
        },
        event,
      );
      if (result.applied) broadcast('realtime:event', event);
    });
    rtClient.onTyped('status', (status) => broadcast('realtime:status', status));
    rtClient.onTyped('stale', (lastSeq) => broadcast('realtime:stale', lastSeq));

    rest = restClient;
    rt = rtClient;
    profile = p;
    currentUser = me;
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
      rt?.disconnect();
    } catch {
      // best-effort: dropping the reference below is the real teardown
    }
    rt = null;
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
    rt?.connect();
    return network;
  };

  const handlers = createHandlers({
    localDb: opts.localDb,
    getRest: () => rest,
    getRealtime: () => rt,
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
