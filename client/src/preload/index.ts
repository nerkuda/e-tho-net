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
import { cleanIpcError } from './ipc-error.js';

/** Invoke a main-process handler over the single IPC channel. */
function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  const payload: IpcInvokePayload = { method, args };
  return ipcRenderer.invoke('etn:invoke', payload).catch((err: unknown) => {
    // Drop Electron's `Error invoking remote method …: EtnError: …` wrapper —
    // the UI shows the server's message verbatim.
    throw cleanIpcError(err);
  }) as Promise<T>;
}

/** Build the typed `window.etn` object from the `EtnApi` contract. */
function buildApi(): EtnApi {
  return {
    server: {
      listProfiles: () => invoke('server.listProfiles'),
      addProfile: (input) => invoke('server.addProfile', input),
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
      mentionsScan: (networkId, request) => invoke('thoughts.mentionsScan', networkId, request),
      usage: (networkId, id) => invoke('thoughts.usage', networkId, id),
      findDuplicates: (networkId, title, synonyms, typeIds) =>
        invoke('thoughts.findDuplicates', networkId, title, synonyms, typeIds),
      setFocusPreferences: (networkId, focusId, input) =>
        invoke('thoughts.setFocusPreferences', networkId, focusId, input),
      setFocusOrder: (networkId, focusId, input) =>
        invoke('thoughts.setFocusOrder', networkId, focusId, input),
    },
    structures: {
      query: (networkId, request) => invoke('structures.query', networkId, request),
      queryIds: (networkId, request) => invoke('structures.queryIds', networkId, request),
      hierarchy: (networkId, thoughtId, query) =>
        invoke('structures.hierarchy', networkId, thoughtId, query),
      edges: (networkId, ids, showInactive) =>
        invoke('structures.edges', networkId, ids, showInactive),
    },
    savedFilters: {
      list: (networkId) => invoke('savedFilters.list', networkId),
      create: (networkId, input) => invoke('savedFilters.create', networkId, input),
      update: (networkId, filterId, input) =>
        invoke('savedFilters.update', networkId, filterId, input),
      remove: (networkId, filterId) => invoke('savedFilters.remove', networkId, filterId),
    },
    chronicle: {
      query: (networkId, request) => invoke('chronicle.query', networkId, request),
    },
    chronicleFilters: {
      list: (networkId) => invoke('chronicleFilters.list', networkId),
      create: (networkId, input) => invoke('chronicleFilters.create', networkId, input),
      update: (networkId, filterId, input) =>
        invoke('chronicleFilters.update', networkId, filterId, input),
      remove: (networkId, filterId) => invoke('chronicleFilters.remove', networkId, filterId),
    },
    pins: {
      list: (networkId) => invoke('pins.list', networkId),
      set: (networkId, orderedIds) => invoke('pins.set', networkId, orderedIds),
    },
    links: {
      get: (networkId, id) => invoke('links.get', networkId, id),
      create: (networkId, input) => invoke('links.create', networkId, input),
      update: (networkId, id, input, expectedVersion) =>
        invoke('links.update', networkId, id, input, expectedVersion),
      remove: (networkId, id, expectedVersion) =>
        invoke('links.remove', networkId, id, expectedVersion),
      listByThought: (networkId, thoughtId, showInactive) =>
        invoke('links.listByThought', networkId, thoughtId, showInactive),
    },
    types: {
      listThoughtTypes: (networkId) => invoke('types.listThoughtTypes', networkId),
      createThoughtType: (networkId, input) => invoke('types.createThoughtType', networkId, input),
      updateThoughtType: (networkId, id, input, expectedVersion) =>
        invoke('types.updateThoughtType', networkId, id, input, expectedVersion),
      removeThoughtType: (networkId, id, expectedVersion, force) =>
        invoke('types.removeThoughtType', networkId, id, expectedVersion, force),
      listLinkTypes: (networkId) => invoke('types.listLinkTypes', networkId),
      createLinkType: (networkId, input) => invoke('types.createLinkType', networkId, input),
      updateLinkType: (networkId, id, input, expectedVersion) =>
        invoke('types.updateLinkType', networkId, id, input, expectedVersion),
      removeLinkType: (networkId, id, expectedVersion, force) =>
        invoke('types.removeLinkType', networkId, id, expectedVersion, force),
      listTypeProperties: (networkId, ownerType, typeId) =>
        invoke('types.listTypeProperties', networkId, ownerType, typeId),
      createTypeProperty: (networkId, ownerType, typeId, input) =>
        invoke('types.createTypeProperty', networkId, ownerType, typeId, input),
      updateTypeProperty: (networkId, ownerType, typeId, propertyId, input) =>
        invoke('types.updateTypeProperty', networkId, ownerType, typeId, propertyId, input),
      removeTypeProperty: (networkId, ownerType, typeId, propertyId) =>
        invoke('types.removeTypeProperty', networkId, ownerType, typeId, propertyId),
      reorderTypeProperties: (networkId, ownerType, typeId, orderedIds) =>
        invoke('types.reorderTypeProperties', networkId, ownerType, typeId, orderedIds),
      setPropertyDefaultOverride: (networkId, ownerType, typeId, propertyId, value) =>
        invoke('types.setPropertyDefaultOverride', networkId, ownerType, typeId, propertyId, value),
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
      createMulti: (networkId, targets, input) =>
        invoke('comments.createMulti', networkId, targets, input),
      get: (networkId, id) => invoke('comments.get', networkId, id),
      update: (networkId, id, input, expectedVersion) =>
        invoke('comments.update', networkId, id, input, expectedVersion),
      remove: (networkId, id, expectedVersion) =>
        invoke('comments.remove', networkId, id, expectedVersion),
      addTarget: (networkId, id, ownerType, ownerId, expectedVersion) =>
        invoke('comments.addTarget', networkId, id, ownerType, ownerId, expectedVersion),
      removeTarget: (networkId, id, ownerType, ownerId, expectedVersion) =>
        invoke('comments.removeTarget', networkId, id, ownerType, ownerId, expectedVersion),
    },
    attachments: {
      list: (networkId, ownerType, ownerId) =>
        invoke('attachments.list', networkId, ownerType, ownerId),
      add: (networkId, ownerType, ownerId, input) =>
        invoke('attachments.add', networkId, ownerType, ownerId, input),
      uploadFile: (networkId, ownerType, ownerId, input) =>
        invoke('attachments.uploadFile', networkId, ownerType, ownerId, input),
      update: (networkId, id, input) => invoke('attachments.update', networkId, id, input),
      remove: (networkId, id) => invoke('attachments.remove', networkId, id),
      getContent: (networkId, id) => invoke('attachments.getContent', networkId, id),
      updateContent: (networkId, id, input) =>
        invoke('attachments.updateContent', networkId, id, input),
      copy: (networkId, attachmentId, input) =>
        invoke('attachments.copy', networkId, attachmentId, input),
      search: (networkId, query) => invoke('attachments.search', networkId, query),
    },
    admin: {
      listUsers: () => invoke('admin.listUsers'),
      createUser: (input) => invoke('admin.createUser', input),
      getUser: (id) => invoke('admin.getUser', id),
      updateUser: (id, fields, expectedVersion) =>
        invoke('admin.updateUser', id, fields, expectedVersion),
      removeUser: (id, expectedVersion) => invoke('admin.removeUser', id, expectedVersion),
      createUserKey: (id, label, maxWritesPerMinute) =>
        invoke('admin.createUserKey', id, label, maxWritesPerMinute),
      removeUserKey: (id, keyId) => invoke('admin.removeUserKey', id, keyId),
      listNetworks: () => invoke('admin.listNetworks'),
      removeNetwork: (id) => invoke('admin.removeNetwork', id),
      listAudit: (filters) => invoke('admin.listAudit', filters),
    },
    me: {
      get: () => invoke('me.get'),
      update: (displayName) => invoke('me.update', displayName),
      listKeys: () => invoke('me.listKeys'),
      createKey: (label, maxWritesPerMinute) => invoke('me.createKey', label, maxWritesPerMinute),
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
      onStale(cb) {
        const listener = (_event: unknown, lastSeq: number): void => cb(lastSeq);
        ipcRenderer.on('realtime:stale', listener);
        return () => ipcRenderer.removeListener('realtime:stale', listener);
      },
    },
    ui: {
      getState: (networkId, key) => invoke('ui.getState', networkId, key),
      setState: (networkId, key, value) => invoke('ui.setState', networkId, key, value),
      draftSave: (input) => invoke('ui.draftSave', input),
      draftList: (networkId) => invoke('ui.draftList', networkId),
      draftDelete: (id) => invoke('ui.draftDelete', id),
    },
    meta: {
      get: (key) => invoke('meta.get', key),
      set: (key, value) => invoke('meta.set', key, value),
    },
    history: {
      list: (profileId, networkId, limit, scope) =>
        invoke('history.list', profileId, networkId, limit, scope),
      push: (profileId, networkId, thoughtId, scope) =>
        invoke('history.push', profileId, networkId, thoughtId, scope),
      rotate: (oldId, newId, scope) => invoke('history.rotate', oldId, newId, scope),
      remove: (thoughtId, scope) => invoke('history.remove', thoughtId, scope),
      clear: (scope) => invoke('history.clear', scope),
      chronicleList: (profileId, networkId, limit) =>
        invoke('history.chronicleList', profileId, networkId, limit),
      chroniclePush: (profileId, networkId, kind, id) =>
        invoke('history.chroniclePush', profileId, networkId, kind, id),
      chronicleRemove: (profileId, networkId, kind, id) =>
        invoke('history.chronicleRemove', profileId, networkId, kind, id),
      chronicleClear: (profileId, networkId) =>
        invoke('history.chronicleClear', profileId, networkId),
    },
    system: {
      health: () => invoke('system.health'),
      version: () => invoke('system.version'),
      export: (networkId, request) => invoke('system.export', networkId, request),
      getJob: (jobId) => invoke('system.getJob', jobId),
      downloadExport: (jobId: string, suggestedFilename: string, targetPath?: string) =>
        invoke('system.downloadExport', jobId, suggestedFilename, targetPath),
      pickSavePath: (suggestedFilename: string, defaultExt: string) =>
        invoke('system.pickSavePath', suggestedFilename, defaultExt),
      importEtnx: (networkId: string, parentThoughtId: string) =>
        invoke('system.importEtnx', networkId, parentThoughtId),
      pickImage: () => invoke('system.pickImage'),
      pickFile: () => invoke('system.pickFile'),
      openPath: (filePath: string) => invoke('system.openPath', filePath),
      openExternal: (url: string) => invoke('system.openExternal', url),
    },
  };
}

contextBridge.exposeInMainWorld('etn', buildApi());
