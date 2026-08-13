/**
 * IPC registration (task G7): the `etn:invoke` channel and realtime bridges.
 *
 * Owns the main-process connection state (active `RestClient`, `RealtimeClient`,
 * profile and current network) and binds it into the handler map from
 * `handlers.ts`. All state lives here — `handlers.ts` stays pure.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { UI_STATE_KEY, type CurrentUser, type Network } from '@etn/shared';

import type { LocalDb, ServerProfileRow } from '../db/local-db.js';
import { decryptApiKey } from '../safe-storage.js';
import { RestClient } from '../net/rest-client.js';
import { RealtimeClient, normaliseWsUrl } from '../net/ws-client.js';
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
    rtClient.onTyped('event', (event) => broadcast('realtime:event', event));
    rtClient.onTyped('status', (status) => broadcast('realtime:status', status));

    rest = restClient;
    rt = rtClient;
    profile = p;
    return me;
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
