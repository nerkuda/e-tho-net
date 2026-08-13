/**
 * Preload script (docs/07-client-electron.md §2.1, §6) — task G7.
 *
 * Exposes the full `window.etn` surface to the renderer via `contextBridge`.
 * Every data call crosses the single `etn:invoke` IPC channel implemented in
 * `src/main/ipc/register.ts`; realtime events and status arrive through the
 * `realtime:event` / `realtime:status` broadcasts from the main process.
 *
 * Security: the API-key, network clients and local DB live only in the main
 * process; the renderer never receives the raw key.
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { EtnApi, IpcInvokePayload } from '../main/ipc/contract.js';

/** Invoke a main-process handler over the single IPC channel. */
function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  const payload: IpcInvokePayload = { method, args };
  return ipcRenderer.invoke('etn:invoke', payload) as Promise<T>;
}

/** Build the typed `window.etn` object from the `EtnApi` contract. */
function buildApi(): EtnApi {
  return {
    server: {
      listProfiles: () => invoke('server.listProfiles'),
      connect: (profileId) => invoke('server.connect', profileId),
      disconnect: () => invoke('server.disconnect'),
      getStatus: () => invoke('server.getStatus'),
    },
    networks: {
      list: () => invoke('networks.list'),
      open: (networkId) => invoke('networks.open', networkId),
      create: (displayName, description) => invoke('networks.create', displayName, description),
      update: (id, fields) => invoke('networks.update', id, fields),
      listMembers: (id) => invoke('networks.listMembers', id),
      addMember: (id, userId) => invoke('networks.addMember', id, userId),
      removeMember: (id, userId) => invoke('networks.removeMember', id, userId),
      transferOwnership: (id, userId) => invoke('networks.transferOwnership', id, userId),
      getPreferences: (id) => invoke('networks.getPreferences', id),
      setPreference: (id, key, value) => invoke('networks.setPreference', id, key, value),
    },
    thoughts: {
      get: (networkId, id) => invoke('thoughts.get', networkId, id),
      focus: (networkId, id) => invoke('thoughts.focus', networkId, id),
      create: (networkId, input) => invoke('thoughts.create', networkId, input),
      update: (networkId, id, input, expectedVersion) =>
        invoke('thoughts.update', networkId, id, input, expectedVersion),
      remove: (networkId, id, expectedVersion) =>
        invoke('thoughts.remove', networkId, id, expectedVersion),
      neighbors: (networkId, id, dir, limit, offset) =>
        invoke('thoughts.neighbors', networkId, id, dir, limit, offset),
      batch: (networkId, input) => invoke('thoughts.batch', networkId, input),
      resolve: (networkId, ids) => invoke('thoughts.resolve', networkId, ids),
      search: (networkId, request) => invoke('thoughts.search', networkId, request),
      mentions: (networkId, id) => invoke('thoughts.mentions', networkId, id),
      setFocusPreferences: (networkId, focusId, input) =>
        invoke('thoughts.setFocusPreferences', networkId, focusId, input),
      setFocusOrder: (networkId, focusId, input) =>
        invoke('thoughts.setFocusOrder', networkId, focusId, input),
    },
    links: {
      get: (networkId, id) => invoke('links.get', networkId, id),
      create: (networkId, input) => invoke('links.create', networkId, input),
      update: (networkId, id, input, expectedVersion) =>
        invoke('links.update', networkId, id, input, expectedVersion),
      remove: (networkId, id, expectedVersion) =>
        invoke('links.remove', networkId, id, expectedVersion),
      listByThought: (networkId, thoughtId) => invoke('links.listByThought', networkId, thoughtId),
    },
    types: {
      listThoughtTypes: (networkId) => invoke('types.listThoughtTypes', networkId),
      createThoughtType: (networkId, input) => invoke('types.createThoughtType', networkId, input),
      updateThoughtType: (networkId, id, input, expectedVersion) =>
        invoke('types.updateThoughtType', networkId, id, input, expectedVersion),
      removeThoughtType: (networkId, id, expectedVersion, force) =>
        invoke('types.removeThoughtType', networkId, id, expectedVersion, force),
    },
    properties: {
      get: (networkId, ownerType, ownerId) =>
        invoke('properties.get', networkId, ownerType, ownerId),
      set: (networkId, ownerType, ownerId, key, value) =>
        invoke('properties.set', networkId, ownerType, ownerId, key, value),
      remove: (networkId, ownerType, ownerId, key) =>
        invoke('properties.remove', networkId, ownerType, ownerId, key),
    },
    comments: {
      list: (networkId, ownerType, ownerId) =>
        invoke('comments.list', networkId, ownerType, ownerId),
      create: (networkId, ownerType, ownerId, input) =>
        invoke('comments.create', networkId, ownerType, ownerId, input),
      update: (networkId, id, input, expectedVersion) =>
        invoke('comments.update', networkId, id, input, expectedVersion),
      remove: (networkId, id, expectedVersion) =>
        invoke('comments.remove', networkId, id, expectedVersion),
    },
    attachments: {
      list: (networkId, ownerType, ownerId) =>
        invoke('attachments.list', networkId, ownerType, ownerId),
      add: (networkId, ownerType, ownerId, input) =>
        invoke('attachments.add', networkId, ownerType, ownerId, input),
      update: (networkId, id, input) => invoke('attachments.update', networkId, id, input),
      remove: (networkId, id) => invoke('attachments.remove', networkId, id),
    },
    admin: {
      listUsers: () => invoke('admin.listUsers'),
      createUser: (input) => invoke('admin.createUser', input),
      getUser: (id) => invoke('admin.getUser', id),
      updateUser: (id, fields, expectedVersion) =>
        invoke('admin.updateUser', id, fields, expectedVersion),
      removeUser: (id, expectedVersion) => invoke('admin.removeUser', id, expectedVersion),
      createUserKey: (id, label) => invoke('admin.createUserKey', id, label),
      removeUserKey: (id, keyId) => invoke('admin.removeUserKey', id, keyId),
      listNetworks: () => invoke('admin.listNetworks'),
      removeNetwork: (id) => invoke('admin.removeNetwork', id),
      listAudit: (filters) => invoke('admin.listAudit', filters),
    },
    me: {
      get: () => invoke('me.get'),
      listKeys: () => invoke('me.listKeys'),
      createKey: (label) => invoke('me.createKey', label),
      removeKey: (id) => invoke('me.removeKey', id),
    },
    realtime: {
      onEvent(cb) {
        const listener = (_event: unknown, payload: unknown): void => cb(payload);
        ipcRenderer.on('realtime:event', listener);
        return () => ipcRenderer.removeListener('realtime:event', listener);
      },
      onStatusChange(cb) {
        const listener = (_event: unknown, status: string): void => cb(status);
        ipcRenderer.on('realtime:status', listener);
        return () => ipcRenderer.removeListener('realtime:status', listener);
      },
    },
    ui: {
      getState: (networkId, key) => invoke('ui.getState', networkId, key),
      setState: (networkId, key, value) => invoke('ui.setState', networkId, key, value),
    },
    history: {
      list: (profileId, networkId, limit) => invoke('history.list', profileId, networkId, limit),
      push: (profileId, networkId, thoughtId) =>
        invoke('history.push', profileId, networkId, thoughtId),
    },
    system: {
      health: () => invoke('system.health'),
      version: () => invoke('system.version'),
      export: (networkId, request) => invoke('system.export', networkId, request),
      getJob: (jobId) => invoke('system.getJob', jobId),
    },
  };
}

contextBridge.exposeInMainWorld('etn', buildApi());
