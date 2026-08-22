/**
 * IPC handler factory (task G7, docs/07-client-electron.md §6).
 *
 * Translates `etn:invoke` calls from the renderer into typed calls on the main
 * process singletons: {@link RestClient}, {@link RealtimeClient} and
 * {@link LocalDb}. The renderer passes positional `args: unknown[]`; each bound
 * handler re-asserts them onto its declared signature via {@link bind} — a
 * single, well-documented unsoundness point at the IPC boundary (untrusted
 * renderer input is ultimately validated by the server, the local handlers only
 * forward it).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import path from 'node:path';

import type { CurrentUser, FocusDir, Network, TypeOwnerType } from '@etn/shared';

import type { RestClient } from '../net/rest-client.js';
import type { RealtimeClient } from '../net/ws-client.js';
import type { DraftRow, LocalDb, ServerProfileRow } from '../db/local-db.js';
import type { PickFileResult, PickImageResult } from './contract.js';
import { classifyOpenTarget } from './open-target.js';
import { errText } from '../../renderer/lib/dom.js';

/** Shared state owned by the main process, injected into handlers. */
export interface HandlerDeps {
  localDb: LocalDb;
  /** Active REST client, or `null` when disconnected. */
  getRest: () => RestClient | null;
  /** Active realtime client, or `null` when disconnected. */
  getRealtime: () => RealtimeClient | null;
  /** Active server profile, or `null` when disconnected. */
  getProfile: () => ServerProfileRow | null;
  /** Connects a profile: builds clients, verifies the key, stores state. */
  connectProfile: (profileId: string) => Promise<CurrentUser>;
  /**
   * Creates a server profile (key encrypted via `safeStorage`), activates it and
   * connects (H2). Implemented in `register.ts`, which owns safeStorage access.
   */
  addProfile: (input: { label: string; baseUrl: string; apiKey: string }) => Promise<CurrentUser>;
  /** Drops clients and clears the active network. */
  disconnect: () => void;
  /** Returns the currently open network id (realtime `getNetworkId` source). */
  getCurrentNetworkId: () => string | null;
  /** Opens a network: persists L4 state, connects realtime, returns meta. */
  openNetwork: (networkId: string) => Promise<Network>;
  /** Bridge: forwards a realtime event to the renderer window. */
  broadcastRealtimeEvent: (event: unknown) => void;
  /** Bridge: forwards a realtime status change to the renderer window. */
  broadcastRealtimeStatus: (status: string) => void;
}

/** IPC handler signature: positional args in, promise out. */
export type IpcHandler = (args: unknown[]) => Promise<unknown> | unknown;

/**
 * Re-assert `unknown[]` IPC arguments onto a typed function. The ONLY place in
 * the client where the renderer argument list is trusted: the renderer is our
 * own code, and every mutation it triggers is re-validated server-side.
 *
 * The wrapper is async so synchronous throws (e.g. "not connected") surface as
 * rejected promises, matching `ipcRenderer.invoke` semantics.
 */
function bind<const A extends unknown[]>(fn: (...args: A) => unknown): IpcHandler {
  return async (args) => fn(...(args as A));
}

/** Throws a canonical error when a handler runs before `server.connect`. */
function requireRest(deps: HandlerDeps): RestClient {
  const rest = deps.getRest();
  if (!rest) {
    throw new Error('Not connected: call etn.server.connect first');
  }
  return rest;
}

/**
 * Build the `method -> handler` map exposed over the `etn:invoke` channel.
 * Method names mirror the `window.etn` domain structure, e.g. `thoughts.get`.
 */
export function createHandlers(deps: HandlerDeps): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();

  // --- server ---------------------------------------------------------------
  handlers.set(
    'server.listProfiles',
    bind(() => {
      return deps.localDb.listProfiles().map((p) => ({
        id: p.id,
        label: p.label,
        baseUrl: p.base_url,
        userId: p.user_id,
        isActive: p.is_active === 1,
      }));
    }),
  );
  handlers.set(
    'server.connect',
    bind((profileId: string) => deps.connectProfile(profileId)),
  );
  handlers.set(
    'server.addProfile',
    bind((input: { label: string; baseUrl: string; apiKey: string }) => deps.addProfile(input)),
  );
  handlers.set(
    'server.disconnect',
    bind(() => {
      deps.disconnect();
    }),
  );
  handlers.set(
    'server.getStatus',
    bind(() => {
      const rt = deps.getRealtime();
      if (!deps.getProfile()) return 'disconnected';
      return rt ? rt.getStatus() : 'connecting';
    }),
  );

  // --- networks -------------------------------------------------------------
  handlers.set(
    'networks.list',
    bind(() => requireRest(deps).listNetworks()),
  );
  handlers.set(
    'networks.open',
    bind((networkId: string) => deps.openNetwork(networkId)),
  );
  handlers.set(
    'networks.create',
    bind((displayName: string, description?: string) =>
      requireRest(deps).createNetwork({ display_name: displayName, description }),
    ),
  );
  handlers.set(
    'networks.update',
    bind((id: string, fields: { display_name?: string; description?: string }) =>
      requireRest(deps).updateNetwork(id, fields),
    ),
  );
  handlers.set(
    'networks.listMembers',
    bind((id: string) => requireRest(deps).listMembers(id)),
  );
  handlers.set(
    'networks.addMember',
    bind((id: string, userId: string) => requireRest(deps).addMember(id, { user_id: userId })),
  );
  handlers.set(
    'networks.removeMember',
    bind((id: string, userId: string) => requireRest(deps).removeMember(id, userId)),
  );
  handlers.set(
    'networks.transferOwnership',
    bind((id: string, userId: string) =>
      requireRest(deps).updateMember(id, userId, { role: 'owner' }),
    ),
  );
  handlers.set(
    'networks.getPreferences',
    bind((id: string) => requireRest(deps).getPreferences(id)),
  );
  handlers.set(
    'networks.setPreference',
    bind((id: string, key: string, value: unknown) =>
      requireRest(deps).setPreference(id, key, value as never),
    ),
  );

  // --- thoughts -------------------------------------------------------------
  handlers.set(
    'thoughts.get',
    bind((networkId: string, id: string) => requireRest(deps).getThought(networkId, id)),
  );
  handlers.set(
    'thoughts.focus',
    bind((networkId: string, id: string) => requireRest(deps).focusThought(networkId, id)),
  );
  handlers.set(
    'thoughts.create',
    bind((networkId: string, input: Parameters<RestClient['createThought']>[1]) =>
      requireRest(deps).createThought(networkId, input),
    ),
  );
  handlers.set(
    'thoughts.update',
    bind(
      (
        networkId: string,
        id: string,
        input: Parameters<RestClient['updateThought']>[2],
        expectedVersion: number,
      ) => requireRest(deps).updateThought(networkId, id, input, expectedVersion),
    ),
  );
  handlers.set(
    'thoughts.remove',
    bind((networkId: string, id: string, expectedVersion: number) =>
      requireRest(deps).deleteThought(networkId, id, expectedVersion),
    ),
  );
  handlers.set(
    'thoughts.neighbors',
    bind((networkId: string, id: string, dir: FocusDir, limit?: number, offset?: number) =>
      requireRest(deps).getNeighbors(networkId, id, { dir, limit, offset }),
    ),
  );
  handlers.set(
    'thoughts.batch',
    bind((networkId: string, input: Parameters<RestClient['batchThoughts']>[1]) => {
      // Idempotency: a fresh Client-Request-Id per user action; the server
      // caches the response for retries of the same logical call — the bulk
      // filter commands (L22) can be large, an HTTP retry must not re-run them.
      return requireRest(deps).batchThoughts(networkId, input, {
        clientRequestId: randomUUID(),
      });
    }),
  );
  handlers.set(
    'thoughts.resolve',
    bind((networkId: string, ids: string[]) => requireRest(deps).resolveThoughts(networkId, ids)),
  );
  handlers.set(
    'thoughts.search',
    bind((networkId: string, request: Parameters<RestClient['searchThoughts']>[1]) =>
      requireRest(deps).searchThoughts(networkId, request),
    ),
  );
  handlers.set(
    'thoughts.mentions',
    bind((networkId: string, id: string) => requireRest(deps).listMentions(networkId, id)),
  );
  handlers.set(
    'thoughts.mentionsScan',
    bind((networkId: string, request: Parameters<RestClient['mentionsScan']>[1]) =>
      requireRest(deps).mentionsScan(networkId, request),
    ),
  );
  handlers.set(
    'thoughts.usage',
    bind((networkId: string, id: string) => requireRest(deps).getThoughtUsage(networkId, id)),
  );
  handlers.set(
    'thoughts.findDuplicates',
    bind((networkId: string, title: string, synonyms?: string[], typeIds?: string[]) =>
      requireRest(deps).findDuplicates(networkId, title, synonyms ?? [], typeIds ?? []),
    ),
  );
  handlers.set(
    'thoughts.setFocusPreferences',
    bind(
      (
        networkId: string,
        focusId: string,
        input: Parameters<RestClient['setFocusPreferences']>[2],
      ) => requireRest(deps).setFocusPreferences(networkId, focusId, input),
    ),
  );
  handlers.set(
    'thoughts.setFocusOrder',
    bind((networkId: string, focusId: string, input: Parameters<RestClient['setFocusOrder']>[2]) =>
      requireRest(deps).setFocusOrder(networkId, focusId, input),
    ),
  );

  // --- structures & saved filters (L15) --------------------------------------
  handlers.set(
    'structures.query',
    bind(
      (networkId: string, request: Parameters<RestClient['queryStructureThoughts']>[1]) =>
        requireRest(deps).queryStructureThoughts(networkId, request),
    ),
  );
  handlers.set(
    'structures.queryIds',
    bind(
      (networkId: string, request: Parameters<RestClient['queryStructureThoughtIds']>[1]) =>
        requireRest(deps).queryStructureThoughtIds(networkId, request),
    ),
  );
  handlers.set(
    'structures.hierarchy',
    bind(
      (
        networkId: string,
        thoughtId: string,
        query: Parameters<RestClient['getHierarchy']>[2],
      ) => requireRest(deps).getHierarchy(networkId, thoughtId, query),
    ),
  );
  handlers.set(
    'structures.edges',
    bind(
      (networkId: string, ids: string[], showInactive: boolean) =>
        requireRest(deps).postStructureEdges(networkId, ids, showInactive),
    ),
  );
  handlers.set(
    'savedFilters.list',
    bind((networkId: string) => requireRest(deps).listSavedFilters(networkId)),
  );
  handlers.set(
    'savedFilters.create',
    bind((networkId: string, input: Parameters<RestClient['createSavedFilter']>[1]) => {
      // Idempotency: a fresh Client-Request-Id per user action; the server
      // caches the response for retries of the same logical call.
      return requireRest(deps).createSavedFilter(networkId, input, {
        clientRequestId: randomUUID(),
      });
    }),
  );
  handlers.set(
    'savedFilters.update',
    bind(
      (
        networkId: string,
        filterId: string,
        input: Parameters<RestClient['updateSavedFilter']>[2],
      ) =>
        requireRest(deps).updateSavedFilter(networkId, filterId, input, {
          clientRequestId: randomUUID(),
        }),
    ),
  );
  handlers.set(
    'savedFilters.remove',
    bind((networkId: string, filterId: string) =>
      requireRest(deps).deleteSavedFilter(networkId, filterId, {
        clientRequestId: randomUUID(),
      }),
    ),
  );

  // --- chronicle view & its saved filters (L20) -----------------------------
  handlers.set(
    'chronicle.query',
    bind((networkId: string, request: Parameters<RestClient['queryChronicle']>[1]) =>
      requireRest(deps).queryChronicle(networkId, request),
    ),
  );
  handlers.set(
    'chronicleFilters.list',
    bind((networkId: string) => requireRest(deps).listChronicleFilters(networkId)),
  );
  handlers.set(
    'chronicleFilters.create',
    bind((networkId: string, input: Parameters<RestClient['createChronicleFilter']>[1]) =>
      requireRest(deps).createChronicleFilter(networkId, input, {
        clientRequestId: randomUUID(),
      }),
    ),
  );
  handlers.set(
    'chronicleFilters.update',
    bind(
      (
        networkId: string,
        filterId: string,
        input: Parameters<RestClient['updateChronicleFilter']>[2],
      ) =>
        requireRest(deps).updateChronicleFilter(networkId, filterId, input, {
          clientRequestId: randomUUID(),
        }),
    ),
  );
  handlers.set(
    'chronicleFilters.remove',
    bind((networkId: string, filterId: string) =>
      requireRest(deps).deleteChronicleFilter(networkId, filterId, {
        clientRequestId: randomUUID(),
      }),
    ),
  );

  // --- pinned thoughts (L18) ------------------------------------------------
  handlers.set(
    'pins.list',
    bind((networkId: string) => requireRest(deps).listPinnedThoughts(networkId)),
  );
  handlers.set(
    'pins.set',
    bind((networkId: string, orderedIds: string[]) =>
      requireRest(deps).setPinnedThoughts(networkId, orderedIds, {
        clientRequestId: randomUUID(),
      }),
    ),
  );

  // --- links ----------------------------------------------------------------
  handlers.set(
    'links.get',
    bind((networkId: string, id: string) => requireRest(deps).getLink(networkId, id)),
  );
  handlers.set(
    'links.create',
    bind((networkId: string, input: Parameters<RestClient['createLink']>[1]) =>
      requireRest(deps).createLink(networkId, input),
    ),
  );
  handlers.set(
    'links.update',
    bind(
      (
        networkId: string,
        id: string,
        input: Parameters<RestClient['updateLink']>[2],
        expectedVersion: number,
      ) => requireRest(deps).updateLink(networkId, id, input, expectedVersion),
    ),
  );
  handlers.set(
    'links.remove',
    bind((networkId: string, id: string, expectedVersion: number) =>
      requireRest(deps).deleteLink(networkId, id, expectedVersion),
    ),
  );
  handlers.set(
    'links.listByThought',
    bind((networkId: string, thoughtId: string, showInactive?: boolean) =>
      requireRest(deps).listLinksByThought(networkId, thoughtId, showInactive),
    ),
  );

  // --- types ----------------------------------------------------------------
  handlers.set(
    'types.listThoughtTypes',
    bind((networkId: string) => requireRest(deps).listThoughtTypes(networkId)),
  );
  handlers.set(
    'types.createThoughtType',
    bind((networkId: string, input: Parameters<RestClient['createThoughtType']>[1]) =>
      requireRest(deps).createThoughtType(networkId, input),
    ),
  );
  handlers.set(
    'types.updateThoughtType',
    bind(
      (
        networkId: string,
        id: string,
        input: Parameters<RestClient['updateThoughtType']>[2],
        expectedVersion: number,
      ) => requireRest(deps).updateThoughtType(networkId, id, input, expectedVersion),
    ),
  );
  handlers.set(
    'types.removeThoughtType',
    bind((networkId: string, id: string, expectedVersion: number, force?: boolean) =>
      requireRest(deps).deleteThoughtType(
        networkId,
        id,
        expectedVersion,
        force ? { force } : undefined,
      ),
    ),
  );
  handlers.set(
    'types.listLinkTypes',
    bind((networkId: string) => requireRest(deps).listLinkTypes(networkId)),
  );
  handlers.set(
    'types.createLinkType',
    bind((networkId: string, input: Parameters<RestClient['createLinkType']>[1]) =>
      requireRest(deps).createLinkType(networkId, input),
    ),
  );
  handlers.set(
    'types.updateLinkType',
    bind(
      (
        networkId: string,
        id: string,
        input: Parameters<RestClient['updateLinkType']>[2],
        expectedVersion: number,
      ) => requireRest(deps).updateLinkType(networkId, id, input, expectedVersion),
    ),
  );
  handlers.set(
    'types.removeLinkType',
    bind((networkId: string, id: string, expectedVersion: number, force?: boolean) =>
      requireRest(deps).deleteLinkType(
        networkId,
        id,
        expectedVersion,
        force ? { force } : undefined,
      ),
    ),
  );
  handlers.set(
    'types.listTypeProperties',
    bind(
      (networkId: string, ownerType: TypeOwnerType, typeId: string) =>
        requireRest(deps).listTypeProperties(networkId, ownerType, typeId),
    ),
  );
  handlers.set(
    'types.createTypeProperty',
    bind(
      (
        networkId: string,
        ownerType: TypeOwnerType,
        typeId: string,
        input: Parameters<RestClient['createTypeProperty']>[3],
      ) => requireRest(deps).createTypeProperty(networkId, ownerType, typeId, input),
    ),
  );
  handlers.set(
    'types.updateTypeProperty',
    bind(
      (
        networkId: string,
        ownerType: TypeOwnerType,
        typeId: string,
        propertyId: string,
        input: Parameters<RestClient['updateTypeProperty']>[4],
      ) =>
        requireRest(deps).updateTypeProperty(networkId, ownerType, typeId, propertyId, input),
    ),
  );
  handlers.set(
    'types.removeTypeProperty',
    bind((networkId: string, ownerType: TypeOwnerType, typeId: string, propertyId: string) =>
      requireRest(deps).deleteTypeProperty(networkId, ownerType, typeId, propertyId),
    ),
  );
  handlers.set(
    'types.reorderTypeProperties',
    bind((networkId: string, ownerType: TypeOwnerType, typeId: string, orderedIds: string[]) =>
      requireRest(deps).reorderTypeProperties(networkId, ownerType, typeId, orderedIds),
    ),
  );
  handlers.set(
    'types.setPropertyDefaultOverride',
    bind(
      (
        networkId: string,
        ownerType: TypeOwnerType,
        typeId: string,
        propertyId: string,
        value: string | number | boolean | null,
      ) =>
        requireRest(deps).setTypePropertyDefaultOverride(
          networkId,
          ownerType,
          typeId,
          propertyId,
          value,
        ),
    ),
  );

  // --- properties -----------------------------------------------------------
  handlers.set(
    'properties.get',
    bind((networkId: string, ownerType: 'thought' | 'link', ownerId: string) => {
      const rest = requireRest(deps);
      return ownerType === 'thought'
        ? rest.listThoughtProperties(networkId, ownerId)
        : rest.listLinkProperties(networkId, ownerId);
    }),
  );
  handlers.set(
    'properties.set',
    bind(
      (
        networkId: string,
        ownerType: 'thought' | 'link',
        ownerId: string,
        key: string,
        value: unknown,
      ) => {
        const rest = requireRest(deps);
        return ownerType === 'thought'
          ? rest.setThoughtProperty(networkId, ownerId, key, value as never)
          : rest.setLinkProperty(networkId, ownerId, key, value as never);
      },
    ),
  );
  handlers.set(
    'properties.remove',
    bind((networkId: string, ownerType: 'thought' | 'link', ownerId: string, key: string) => {
      const rest = requireRest(deps);
      return ownerType === 'thought'
        ? rest.deleteThoughtProperty(networkId, ownerId, key)
        : rest.deleteLinkProperty(networkId, ownerId, key);
    }),
  );

  // --- comments -------------------------------------------------------------
  handlers.set(
    'comments.list',
    bind((networkId: string, ownerType: 'thought' | 'link', ownerId: string) => {
      const rest = requireRest(deps);
      return ownerType === 'thought'
        ? rest.listThoughtComments(networkId, ownerId)
        : rest.listLinkComments(networkId, ownerId);
    }),
  );
  handlers.set(
    'comments.create',
    bind(
      (
        networkId: string,
        ownerType: 'thought' | 'link',
        ownerId: string,
        input: Parameters<RestClient['createThoughtComment']>[2],
      ) => {
        const rest = requireRest(deps);
        return ownerType === 'thought'
          ? rest.createThoughtComment(networkId, ownerId, input)
          : rest.createLinkComment(networkId, ownerId, input);
      },
    ),
  );
  handlers.set(
    'comments.update',
    bind(
      (
        networkId: string,
        id: string,
        input: Parameters<RestClient['updateComment']>[2],
        expectedVersion: number,
      ) => requireRest(deps).updateComment(networkId, id, input, expectedVersion),
    ),
  );
  handlers.set(
    'comments.remove',
    bind((networkId: string, id: string, expectedVersion: number) =>
      requireRest(deps).deleteComment(networkId, id, expectedVersion),
    ),
  );
  handlers.set(
    'comments.createMulti',
    bind(
      (
        networkId: string,
        targets: Parameters<RestClient['createCommentWithTargets']>[1]['targets'],
        input: Parameters<RestClient['createCommentWithTargets']>[1],
      ) =>
        requireRest(deps).createCommentWithTargets(
          networkId,
          { ...input, targets },
          { clientRequestId: randomUUID() },
        ),
    ),
  );
  handlers.set(
    'comments.get',
    bind((networkId: string, id: string) => requireRest(deps).getComment(networkId, id)),
  );
  handlers.set(
    'comments.addTarget',
    bind(
      (
        networkId: string,
        id: string,
        ownerType: 'thought' | 'link',
        ownerId: string,
        expectedVersion?: number,
      ) =>
        requireRest(deps).addCommentTarget(
          networkId,
          id,
          ownerType,
          ownerId,
          expectedVersion,
          { clientRequestId: randomUUID() },
        ),
    ),
  );
  handlers.set(
    'comments.removeTarget',
    bind(
      (
        networkId: string,
        id: string,
        ownerType: 'thought' | 'link',
        ownerId: string,
        expectedVersion?: number,
      ) =>
        requireRest(deps).removeCommentTarget(
          networkId,
          id,
          ownerType,
          ownerId,
          expectedVersion,
          { clientRequestId: randomUUID() },
        ),
    ),
  );

  // --- attachments ----------------------------------------------------------
  handlers.set(
    'attachments.list',
    bind((networkId: string, ownerType: 'thought' | 'link', ownerId: string) => {
      const rest = requireRest(deps);
      return ownerType === 'thought'
        ? rest.listThoughtAttachments(networkId, ownerId)
        : rest.listLinkAttachments(networkId, ownerId);
    }),
  );
  handlers.set(
    'attachments.add',
    bind(
      (
        networkId: string,
        ownerType: 'thought' | 'link',
        ownerId: string,
        input: Parameters<RestClient['createThoughtAttachment']>[2],
      ) => {
        const rest = requireRest(deps);
        return ownerType === 'thought'
          ? rest.createThoughtAttachment(networkId, ownerId, input)
          : rest.createLinkAttachment(networkId, ownerId, input);
      },
    ),
  );
  handlers.set(
    'attachments.uploadFile',
    bind(
      (
        networkId: string,
        ownerType: 'thought' | 'link',
        ownerId: string,
        input: Parameters<RestClient['uploadThoughtAttachmentFile']>[2],
      ) => {
        const rest = requireRest(deps);
        return ownerType === 'thought'
          ? rest.uploadThoughtAttachmentFile(networkId, ownerId, input)
          : rest.uploadLinkAttachmentFile(networkId, ownerId, input);
      },
    ),
  );
  handlers.set(
    'attachments.update',
    bind((networkId: string, id: string, input: Parameters<RestClient['updateAttachment']>[2]) =>
      requireRest(deps).updateAttachment(networkId, id, input),
    ),
  );
  handlers.set(
    'attachments.remove',
    bind((networkId: string, id: string) => requireRest(deps).deleteAttachment(networkId, id)),
  );
  handlers.set(
    'attachments.getContent',
    bind((networkId: string, id: string) =>
      requireRest(deps).getAttachmentContent(networkId, id),
    ),
  );
  handlers.set(
    'attachments.updateContent',
    bind(
      (
        networkId: string,
        id: string,
        input: Parameters<RestClient['updateAttachmentContent']>[2],
      ) => requireRest(deps).updateAttachmentContent(networkId, id, input),
    ),
  );
  handlers.set(
    'attachments.copy',
    bind(
      (
        networkId: string,
        attachmentId: string,
        input: Parameters<RestClient['copyAttachment']>[2],
      ) => requireRest(deps).copyAttachment(networkId, attachmentId, input),
    ),
  );
  handlers.set(
    'attachments.search',
    bind((networkId: string, query: Parameters<RestClient['searchAttachments']>[1]) =>
      requireRest(deps).searchAttachments(networkId, query),
    ),
  );

  // --- admin -----------------------------------------------------------------
  handlers.set(
    'admin.listUsers',
    bind(() => requireRest(deps).adminListUsers()),
  );
  handlers.set(
    'admin.createUser',
    bind(async (input: { username: string; displayName?: string; isAdmin?: boolean }) => {
      const { user, key } = await requireRest(deps).adminCreateUser({
        username: input.username,
        display_name: input.displayName ?? null,
        is_admin: input.isAdmin ?? false,
      });
      return { user, apiKey: key.key };
    }),
  );
  handlers.set(
    'admin.getUser',
    bind((id: string) => requireRest(deps).adminGetUser(id)),
  );
  handlers.set(
    'admin.updateUser',
    bind(
      (
        id: string,
        fields: { display_name?: string | null; is_admin?: boolean; disabled?: boolean },
        expectedVersion: number,
      ) => requireRest(deps).adminUpdateUser(id, fields, expectedVersion),
    ),
  );
  handlers.set(
    'admin.removeUser',
    bind((id: string, expectedVersion: number) =>
      requireRest(deps).adminDeleteUser(id, expectedVersion),
    ),
  );
  handlers.set(
    'admin.createUserKey',
    bind(async (id: string, label?: string, maxWritesPerMinute?: number | null) => {
      const key = await requireRest(deps).adminCreateUserKey(id, {
        label: label ?? null,
        max_writes_per_minute: maxWritesPerMinute ?? null,
      });
      return { id: key.id, apiKey: key.key };
    }),
  );
  handlers.set(
    'admin.removeUserKey',
    bind((id: string, keyId: string) => requireRest(deps).adminDeleteUserKey(id, keyId)),
  );
  handlers.set(
    'admin.listNetworks',
    bind(() => requireRest(deps).adminListNetworks()),
  );
  handlers.set(
    'admin.removeNetwork',
    bind((id: string) => requireRest(deps).adminDeleteNetwork(id)),
  );
  handlers.set(
    'admin.listAudit',
    bind((filters?: Record<string, unknown>) => requireRest(deps).adminListAudit(filters ?? {})),
  );

  // --- me ---------------------------------------------------------------------
  handlers.set(
    'me.get',
    bind(() => requireRest(deps).getMe()),
  );
  handlers.set(
    'me.update',
    bind((displayName: string | null) => requireRest(deps).updateMe(displayName)),
  );
  handlers.set(
    'me.listKeys',
    bind(() => requireRest(deps).listMyKeys()),
  );
  handlers.set(
    'me.createKey',
    bind(async (label?: string, maxWritesPerMinute?: number | null) => {
      const key = await requireRest(deps).createMyKey({
        label: label ?? null,
        max_writes_per_minute: maxWritesPerMinute ?? null,
      });
      return { id: key.id, apiKey: key.key };
    }),
  );
  handlers.set(
    'me.removeKey',
    bind((id: string) => requireRest(deps).deleteMyKey(id)),
  );

  // --- meta (L5 client_meta: installation-scoped state, e.g. the UI theme) ---
  handlers.set(
    'meta.get',
    bind((key: string) => deps.localDb.getMeta(key)),
  );
  handlers.set(
    'meta.set',
    bind((key: string, value: string) => {
      deps.localDb.setMeta(key, value);
    }),
  );

  // --- ui / history / system ---------------------------------------------------
  handlers.set(
    'ui.getState',
    bind((networkId: string, key: string) => {
      const profile = deps.getProfile();
      if (!profile) return null;
      return deps.localDb.getUiState(profile.id, networkId, key);
    }),
  );
  handlers.set(
    'ui.setState',
    bind((networkId: string, key: string, value: string) => {
      const profile = deps.getProfile();
      if (!profile) return;
      deps.localDb.setUiState(profile.id, networkId, key, value);
    }),
  );
  handlers.set(
    'ui.draftSave',
    bind(
      (input: {
        networkId: string;
        entityType: string;
        entityId: string;
        field: string;
        value: string;
        baseVersion: number | null;
      }) => {
        const profile = deps.getProfile();
        if (!profile) throw new Error('Not connected: call etn.server.connect first');
        const id = randomUUID();
        deps.localDb.upsertDraft({
          id,
          profile_id: profile.id,
          network_id: input.networkId,
          entity_type: input.entityType,
          entity_id: input.entityId,
          field: input.field,
          value: input.value,
          base_version: input.baseVersion ?? null,
          status: 'pending',
        });
        // Upsert keeps the row's original id on conflict — return the real id
        // so the caller can delete the draft after a successful save.
        return (
          deps.localDb.getDraftId(
            profile.id,
            input.networkId,
            input.entityType,
            input.entityId,
            input.field,
          ) ?? id
        );
      },
    ),
  );
  handlers.set(
    'ui.draftList',
    bind((networkId: string) => {
      const profile = deps.getProfile();
      if (!profile) return [] as DraftRow[];
      return deps.localDb
        .listDrafts(profile.id, networkId)
        .map((row) => ({
          id: row.id,
          networkId: row.network_id,
          entityType: row.entity_type,
          entityId: row.entity_id,
          field: row.field,
          value: row.value,
          baseVersion: row.base_version,
          status: row.status,
          createdAt: row.created_at,
        }))
        .filter((row) => row.status === 'pending');
    }),
  );
  handlers.set(
    'ui.draftDelete',
    bind((id: string) => {
      deps.localDb.deleteDraft(id);
    }),
  );
  handlers.set(
    'history.list',
    bind(
      (
        profileId: string,
        networkId: string,
        limit?: number,
        scope?: Parameters<LocalDb['listFocusHistory']>[3],
      ) =>
        deps.localDb
          .listFocusHistory(profileId, networkId, limit, scope)
          .map((thoughtId) => ({ thoughtId, visitedAt: '' })),
    ),
  );
  handlers.set(
    'history.push',
    bind(
      (
        profileId: string,
        networkId: string,
        thoughtId: string,
        scope?: Parameters<LocalDb['pushFocusHistory']>[3],
      ) => {
        deps.localDb.pushFocusHistory(profileId, networkId, thoughtId, scope);
      },
    ),
  );
  handlers.set(
    'history.rotate',
    bind((oldId: string | null, newId: string, scope?: Parameters<LocalDb['rotateFocusHistory']>[4]) => {
      const profile = deps.getProfile();
      const networkId = deps.getCurrentNetworkId();
      if (!profile || !networkId) {
        throw new Error('Not connected: call etn.server.connect and open a network first');
      }
      deps.localDb.rotateFocusHistory(profile.id, networkId, oldId, newId, scope);
    }),
  );
  handlers.set(
    'history.remove',
    bind((thoughtId: string, scope?: Parameters<LocalDb['removeFocusHistory']>[3]) => {
      const profile = deps.getProfile();
      const networkId = deps.getCurrentNetworkId();
      if (!profile || !networkId) {
        throw new Error('Not connected: call etn.server.connect and open a network first');
      }
      deps.localDb.removeFocusHistory(profile.id, networkId, thoughtId, scope);
    }),
  );
  handlers.set(
    'history.clear',
    bind((scope?: Parameters<LocalDb['clearFocusHistory']>[2]) => {
      const profile = deps.getProfile();
      const networkId = deps.getCurrentNetworkId();
      if (!profile || !networkId) {
        throw new Error('Not connected: call etn.server.connect and open a network first');
      }
      deps.localDb.clearFocusHistory(profile.id, networkId, scope);
    }),
  );
  // Chronicle history (L20): entries carry a kind (thought | link).
  handlers.set(
    'history.chronicleList',
    bind(
      (
        profileId: string,
        networkId: string,
        limit?: Parameters<LocalDb['listChronicleHistory']>[2],
      ) =>
        deps.localDb
          .listChronicleHistory(profileId, networkId, limit)
          .map((row) => ({ kind: row.entry_kind, id: row.entry_id })),
    ),
  );
  handlers.set(
    'history.chroniclePush',
    bind(
      (
        profileId: string,
        networkId: string,
        kind: Parameters<LocalDb['pushChronicleEntry']>[2],
        id: string,
      ) => {
        deps.localDb.pushChronicleEntry(profileId, networkId, kind, id);
      },
    ),
  );
  handlers.set(
    'history.chronicleRemove',
    bind(
      (
        profileId: string,
        networkId: string,
        kind: Parameters<LocalDb['removeChronicleEntry']>[2],
        id: string,
      ) => {
        deps.localDb.removeChronicleEntry(profileId, networkId, kind, id);
      },
    ),
  );
  handlers.set(
    'history.chronicleClear',
    bind((profileId: string, networkId: string) => {
      deps.localDb.clearChronicleHistory(profileId, networkId);
    }),
  );
  handlers.set(
    'system.health',
    bind(() => requireRest(deps).getHealth()),
  );
  handlers.set(
    'system.version',
    bind(() => requireRest(deps).getVersion()),
  );
  handlers.set(
    'system.export',
    bind((networkId: string, request: Parameters<RestClient['exportThoughts']>[1]) =>
      requireRest(deps).exportThoughts(networkId, request),
    ),
  );
  handlers.set(
    'system.getJob',
    bind((jobId: string) => requireRest(deps).getJob(jobId)),
  );
  handlers.set('system.pickImage', bind(() => pickImageFile()));
  handlers.set('system.pickFile', bind(() => pickAnyFile()));
  handlers.set('system.openPath', bind((filePath: string) => openPathShell(filePath)));
  handlers.set('system.openExternal', bind((url: string) => openExternalShell(url)));
  handlers.set(
    'system.downloadExport',
    bind(async (jobId: string, suggestedFilename: string) => {
      const rest = requireRest(deps);
      const { contentType, body } = await rest.downloadJob(jobId);
      const ext = extensionForContentType(contentType);
      const filename = suggestedFilename.endsWith(`.${ext}`)
        ? suggestedFilename
        : `${suggestedFilename}.${ext}`;
      const { dialog, BrowserWindow } = await import('electron');
      const win = BrowserWindow.getFocusedWindow();
      const save = win
        ? await dialog.showSaveDialog(win, {
            title: 'Сохранить экспорт',
            defaultPath: filename,
          })
        : await dialog.showSaveDialog({ title: 'Сохранить экспорт', defaultPath: filename });
      if (save.canceled || save.filePath === undefined || save.filePath === '') {
        return { saved_path: null, cancelled: true };
      }
      try {
        writeFileSync(save.filePath, body);
      } catch (err) {
        return { saved_path: null, cancelled: false, error: errText(err) };
      }
      return { saved_path: save.filePath, cancelled: false };
    }),
  );
  handlers.set(
    'system.importEtnx',
    bind(async (networkId: string, parentThoughtId: string) => {
      const rest = requireRest(deps);
      const picked = await pickEtnxArchive();
      if (picked.kind === 'cancelled') return { cancelled: true };
      if (picked.kind === 'error') return { cancelled: false, error: picked.error };
      try {
        const summary = await rest.importEtnx(
          networkId,
          parentThoughtId,
          picked.archive_b64,
        );
        return { cancelled: false, summary, filename: picked.filename };
      } catch (err) {
        return { cancelled: false, error: errText(err) };
      }
    }),
  );

  return handlers;
}

/** Maximum picked `.etnx` archive size — mirrors `ETNX_MAX_BYTES` on the server. */
const PICK_ETNX_MAX_BYTES = 50 * 1024 * 1024;

type PickedArchive =
  | { kind: 'cancelled' }
  | { kind: 'error'; error: string }
  | { kind: 'ok'; archive_b64: string; filename: string };

/**
 * Open the OS file picker for a `.etnx` archive and read it back as base64
 * (the REST contract requires base64 inside the JSON envelope). Filters the
 * dialog by `.etnx` / `.zip` extension so the user is nudged towards the
 * right format.
 */
async function pickEtnxArchive(): Promise<PickedArchive> {
  const { BrowserWindow, dialog } = await import('electron');
  const win = BrowserWindow.getFocusedWindow();
  const opts = {
    title: 'Выбрать .etnx архив',
    properties: ['openFile'] as Array<'openFile'>,
    filters: [{ name: 'Экспорт ETN (.etnx, .zip)', extensions: ['etnx', 'zip'] }],
  };
  const result =
    win !== null
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) {
    return { kind: 'cancelled' };
  }
  const filePath = result.filePaths[0];
  if (filePath === undefined) return { kind: 'cancelled' };
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch (err) {
    return { kind: 'error', error: errText(err) };
  }
  if (buf.length > PICK_ETNX_MAX_BYTES) {
    return {
      kind: 'error',
      error: `Файл больше ${PICK_ETNX_MAX_BYTES} байт.`,
    };
  }
  const filename = filePath.split(/[\\/]/).pop() ?? 'archive.etnx';
  return { kind: 'ok', archive_b64: buf.toString('base64'), filename };
}

/** Maximum picked image size — mirrors the server's attachment upload limit. */
const PICK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Pick a save-dialog extension from the server's Content-Type. */
function extensionForContentType(contentType: string): string {
  if (contentType.includes('zip')) return 'etnx';
  if (contentType.includes('html')) return 'html';
  if (contentType.includes('markdown')) return 'md';
  if (contentType.includes('pdf')) return 'pdf';
  return 'bin';
}

/** Maps a file extension to its MIME type (for `data:` URLs). */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
};

/**
 * Opens the OS file picker for an image and returns the ORIGINAL file as a
 * `data:` URL with its name/mime/size (08-ui-spec.md §6.8, workplan L16). The
 * icon-sized preview is the renderer's job — files up to the attachment limit
 * are accepted; bigger/unreadable ones resolve an error message.
 */
async function pickImageFile(): Promise<PickImageResult> {
  // electron is imported lazily so this module stays loadable in the Node test
  // runner (which resolves `electron` to a stub without the named exports).
  const { BrowserWindow, dialog } = await import('electron');
  const win = BrowserWindow.getFocusedWindow();
  // Inline options in each branch so the showOpenDialog overload resolves.
  const result =
    win !== null
      ? await dialog.showOpenDialog(win, {
          title: 'Выбрать изображение',
          properties: ['openFile'],
          filters: [{ name: 'Изображения', extensions: Object.keys(IMAGE_MIME) }],
        })
      : await dialog.showOpenDialog({
          title: 'Выбрать изображение',
          properties: ['openFile'],
          filters: [{ name: 'Изображения', extensions: Object.keys(IMAGE_MIME) }],
        });
  if (result.canceled || result.filePaths.length === 0) return { status: 'cancel' };
  const filePath = result.filePaths[0];
  if (filePath === undefined) return { status: 'cancel' };
  try {
    const size = statSync(filePath).size;
    if (size > PICK_IMAGE_MAX_BYTES) {
      return {
        status: 'error',
        message: `Файл больше ${PICK_IMAGE_MAX_BYTES / (1024 * 1024)} МБ — лимит вложения.`,
      };
    }
    const buf = readFileSync(filePath);
    const ext = filePath.toLowerCase().split('.').pop() ?? '';
    const mime = IMAGE_MIME[ext] ?? 'application/octet-stream';
    const name = filePath.split(/[\\/]/).pop() ?? 'file';
    return {
      status: 'ok',
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      name,
      mime,
      size,
    };
  } catch {
    return { status: 'error', message: 'Не удалось прочитать файл.' };
  }
}

/**
 * Opens the OS file picker for a file of any type and returns its absolute
 * path (08-ui-spec.md §6.5). No bytes are read here — the caller only fills
 * its path field; the file reaches the server when «Добавить» is pressed.
 */
async function pickAnyFile(): Promise<PickFileResult> {
  const { BrowserWindow, dialog } = await import('electron');
  const win = BrowserWindow.getFocusedWindow();
  // Inline options in each branch so the showOpenDialog overload resolves.
  const result =
    win !== null
      ? await dialog.showOpenDialog(win, { title: 'Выбрать файл', properties: ['openFile'] })
      : await dialog.showOpenDialog({ title: 'Выбрать файл', properties: ['openFile'] });
  if (result.canceled || result.filePaths.length === 0) return { status: 'cancel' };
  const filePath = result.filePaths[0];
  if (filePath === undefined) return { status: 'cancel' };
  return { status: 'ok', path: filePath, name: filePath.split(/[\\/]/).pop() ?? 'file' };
}

// Re-export for the registration module's convenience.
export type { HandlerDeps as IpcHandlerDeps };

/** Opens a local file with the OS default application; returns the OS error. */
async function openPathShell(filePath: string): Promise<string> {
  const { shell } = await import('electron');
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    return 'Пустой путь к файлу.';
  }
  return shell.openPath(filePath);
}

/**
 * Opens an external target with the OS default application: local paths and
 * `file://` URLs via `shell.openPath`, http/https and any other registered
 * protocol (e.g. `obsidian://`) via `shell.openExternal`. Returns '' on
 * success or a human-readable error (mirrors {@link openPathShell}), so the
 * renderer can surface «cannot open» feedback instead of failing silently.
 */
async function openExternalShell(target: string): Promise<string> {
  const { shell } = await import('electron');
  if (typeof target !== 'string') return 'Некорректный адрес.';
  const classified = classifyOpenTarget(target);
  if (classified.kind === 'refused') return classified.reason;
  if (classified.kind === 'path') return shell.openPath(classified.path);
  try {
    await shell.openExternal(classified.url);
    return '';
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // For non-web schemes an unregistered protocol handler is the common cause.
    const hint = /^https?:/i.test(classified.url)
      ? ''
      : ' (возможно, протокол не зарегистрирован в системе)';
    return `Не удалось открыть «${classified.url}»${hint}: ${detail}`;
  }
}
