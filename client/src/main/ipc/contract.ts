/**
 * IPC contract between the renderer and the main process (task G7,
 * docs/07-client-electron.md §6).
 *
 * `EtnApi` is the single source of truth for the `window.etn` surface exposed
 * by the preload script. The main process implements it in `handlers.ts` via
 * the `RestClient`/`RealtimeClient`/`LocalDb` singletons; the renderer consumes
 * it through `src/env.d.ts`.
 *
 * Every method maps to exactly one REST/realtime/local call — the renderer never
 * sees the API-key and never touches the network itself.
 */

import type {
  ApiKey,
  Attachment,
  AttachmentFileInput,
  AttachmentInput,
  AttachmentUpdateInput,
  Comment,
  CommentInput,
  CurrentUser,
  ExportJob,
  ExportRequest,
  FocusDir,
  FocusNeighbor,
  FocusOrderInput,
  FocusPreferencesInput,
  FocusResponse,
  HealthResponse,
  Link,
  LinkCreateInput,
  LinkType,
  LinkUpdateInput,
  MentionHit,
  Network,
  NetworkListItem,
  NetworkMember,
  PropertyDefinition,
  PropertyValue,
  SearchRequest,
  SearchResponse,
  Thought,
  ThoughtBatchInput,
  ThoughtBatchResult,
  ThoughtCreateInput,
  ThoughtLinksGrouped,
  ThoughtRef,
  ThoughtType,
  ThoughtTypeInput,
  ThoughtTypeUpdateInput,
  ThoughtUpdateInput,
  User,
  UserFocusPreferences,
  UserPreferenceEntry,
  VersionResponse,
} from '@etn/shared';

import type { DraftStatus } from '../db/local-db.js';

/** Payload of the single `etn:invoke` channel used by the preload bridge. */
export interface IpcInvokePayload {
  /** Domain-qualified method name, e.g. `thoughts.get`. */
  method: string;
  /** Positional arguments forwarded to the matching handler. */
  args: unknown[];
}

/** Current connection state surfaced to the renderer (server domain). */
export type ServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Focus-history entry shape returned to the renderer (L4, docs §2.3). */
export interface FocusHistoryEntry {
  thoughtId: string;
  visitedAt: string;
}

/** How a duplicate candidate matched the proposed title (add-thought dialog). */
export type DuplicateMatchKind = 'title' | 'synonym' | 'partial';

/**
 * A duplicate candidate returned by `GET /thoughts/duplicates`
 * (03-server-api.md §6.3, 08-ui-spec.md §4.4). Mirrors the server-side
 * `DuplicateHit` from the search service.
 */
export interface DuplicateHit {
  id: string;
  title: string;
  synonyms: string[];
  matched_on: DuplicateMatchKind;
  /** Synonym text that matched, when `matched_on === 'synonym'`. */
  matched_synonym?: string;
}

/** Input accepted by {@link EtnApi.ui.draftSave} (H19, drafts). */
export interface DraftSaveInput {
  networkId: string;
  /** e.g. `comment`, `thought`, `link` — the entity being edited. */
  entityType: string;
  entityId: string;
  /** Field being edited, e.g. `body_md`, `title`. */
  field: string;
  /** JSON-encoded value being edited. */
  value: string;
  /** Server version the edit started from (`If-Match` on retry), or `null`. */
  baseVersion: number | null;
}

/** A stored draft row returned to the renderer (H19, offline safety net). */
export interface DraftRecord {
  id: string;
  networkId: string;
  entityType: string;
  entityId: string;
  field: string;
  value: string | null;
  baseVersion: number | null;
  status: DraftStatus;
  createdAt: string;
}

/** The full `window.etn` surface (docs/07-client-electron.md §6). */
export interface EtnApi {
  server: {
    listProfiles(): Promise<
      Array<{
        id: string;
        label: string;
        baseUrl: string;
        userId: string | null;
        isActive: boolean;
      }>
    >;
    /**
     * Creates a server profile, encrypts the API-key via `safeStorage`, activates
     * it and connects. Returns the current user on success (H2).
     */
    addProfile(input: { label: string; baseUrl: string; apiKey: string }): Promise<CurrentUser>;
    connect(profileId: string): Promise<CurrentUser>;
    disconnect(): Promise<void>;
    getStatus(): Promise<ServerStatus>;
  };
  networks: {
    list(): Promise<NetworkListItem[]>;
    open(networkId: string): Promise<Network>;
    create(displayName: string, description?: string): Promise<Network>;
    update(id: string, fields: { display_name?: string; description?: string }): Promise<Network>;
    listMembers(id: string): Promise<NetworkMember[]>;
    addMember(id: string, userId: string): Promise<NetworkMember>;
    removeMember(id: string, userId: string): Promise<void>;
    transferOwnership(id: string, userId: string): Promise<void>;
    getPreferences(id: string): Promise<UserPreferenceEntry[]>;
    setPreference(id: string, key: string, value: unknown): Promise<void>;
  };
  thoughts: {
    get(networkId: string, id: string): Promise<Thought>;
    focus(networkId: string, id: string): Promise<FocusResponse>;
    create(networkId: string, input: ThoughtCreateInput): Promise<Thought>;
    update(
      networkId: string,
      id: string,
      input: ThoughtUpdateInput,
      expectedVersion: number,
    ): Promise<Thought>;
    remove(networkId: string, id: string, expectedVersion: number): Promise<void>;
    neighbors(
      networkId: string,
      id: string,
      dir: FocusDir,
      limit?: number,
      offset?: number,
    ): Promise<FocusNeighbor[]>;
    batch(networkId: string, input: ThoughtBatchInput): Promise<ThoughtBatchResult>;
    resolve(networkId: string, ids: string[]): Promise<ThoughtRef[]>;
    search(networkId: string, request: SearchRequest): Promise<SearchResponse>;
    mentions(networkId: string, id: string): Promise<MentionHit[]>;
    /** `GET /thoughts/duplicates` — live duplicate candidates for the add dialog (H14). */
    findDuplicates(networkId: string, title: string, synonyms?: string[]): Promise<DuplicateHit[]>;
    setFocusPreferences(
      networkId: string,
      focusId: string,
      input: FocusPreferencesInput,
    ): Promise<UserFocusPreferences>;
    setFocusOrder(networkId: string, focusId: string, input: FocusOrderInput): Promise<void>;
  };
  links: {
    get(networkId: string, id: string): Promise<Link>;
    create(networkId: string, input: LinkCreateInput): Promise<Link>;
    update(
      networkId: string,
      id: string,
      input: LinkUpdateInput,
      expectedVersion: number,
    ): Promise<Link>;
    remove(networkId: string, id: string, expectedVersion: number): Promise<void>;
    listByThought(networkId: string, thoughtId: string): Promise<ThoughtLinksGrouped>;
  };
  types: {
    listThoughtTypes(networkId: string): Promise<ThoughtType[]>;
    createThoughtType(networkId: string, input: ThoughtTypeInput): Promise<ThoughtType>;
    updateThoughtType(
      networkId: string,
      id: string,
      input: ThoughtTypeUpdateInput,
      expectedVersion: number,
    ): Promise<ThoughtType>;
    removeThoughtType(
      networkId: string,
      id: string,
      expectedVersion: number,
      force?: boolean,
    ): Promise<void>;
    /** `GET /link-types` — link type catalogue (line labels on the canvas, H6). */
    listLinkTypes(networkId: string): Promise<LinkType[]>;
    /** `GET /thought-types/{id}/properties` — property definitions of a type (H11). */
    listThoughtTypeProperties(networkId: string, typeId: string): Promise<PropertyDefinition[]>;
  };
  properties: {
    get(
      networkId: string,
      ownerType: 'thought' | 'link',
      ownerId: string,
    ): Promise<PropertyValue[]>;
    set(
      networkId: string,
      ownerType: 'thought' | 'link',
      ownerId: string,
      key: string,
      value: unknown,
    ): Promise<void>;
    remove(
      networkId: string,
      ownerType: 'thought' | 'link',
      ownerId: string,
      key: string,
    ): Promise<void>;
  };
  comments: {
    list(networkId: string, ownerType: 'thought' | 'link', ownerId: string): Promise<Comment[]>;
    create(
      networkId: string,
      ownerType: 'thought' | 'link',
      ownerId: string,
      input: CommentInput,
    ): Promise<Comment>;
    update(
      networkId: string,
      id: string,
      input: Partial<CommentInput>,
      expectedVersion: number,
    ): Promise<Comment>;
    remove(networkId: string, id: string, expectedVersion: number): Promise<void>;
  };
  attachments: {
    list(networkId: string, ownerType: 'thought' | 'link', ownerId: string): Promise<Attachment[]>;
    add(
      networkId: string,
      ownerType: 'thought' | 'link',
      ownerId: string,
      input: AttachmentInput,
    ): Promise<Attachment>;
    /**
     * Uploads a base64 payload; the server stores it under the network's
     * `attachments/` directory and returns the created `kind='file'` attachment
     * whose `file_path` points at the stored copy.
     */
    uploadFile(
      networkId: string,
      ownerType: 'thought' | 'link',
      ownerId: string,
      input: AttachmentFileInput,
    ): Promise<Attachment>;
    update(networkId: string, id: string, input: AttachmentUpdateInput): Promise<Attachment>;
    remove(networkId: string, id: string): Promise<void>;
  };
  admin: {
    listUsers(): Promise<User[]>;
    createUser(input: {
      username: string;
      displayName?: string;
      isAdmin?: boolean;
    }): Promise<{ user: User; apiKey: string }>;
    getUser(id: string): Promise<User>;
    updateUser(
      id: string,
      fields: { display_name?: string | null; is_admin?: boolean; disabled?: boolean },
      expectedVersion: number,
    ): Promise<User>;
    removeUser(id: string, expectedVersion: number): Promise<void>;
    createUserKey(id: string, label?: string): Promise<{ id: string; apiKey: string }>;
    removeUserKey(id: string, keyId: string): Promise<void>;
    listNetworks(): Promise<Network[]>;
    removeNetwork(id: string): Promise<void>;
    listAudit(filters?: Record<string, unknown>): Promise<unknown>;
  };
  me: {
    get(): Promise<CurrentUser>;
    listKeys(): Promise<ApiKey[]>;
    createKey(label?: string): Promise<{ id: string; apiKey: string }>;
    removeKey(id: string): Promise<void>;
  };
  realtime: {
    onEvent(cb: (event: unknown) => void): () => void;
    onStatusChange(cb: (status: string) => void): () => void;
    /** `resume.stale` — event-log window exceeded; the UI must fully re-focus. */
    onStale(cb: (lastSeq: number) => void): () => void;
  };
  ui: {
    getState(networkId: string, key: string): Promise<string | null>;
    setState(networkId: string, key: string, value: string): Promise<void>;
    /** Saves an edit draft in the local DB; returns the draft id (H19). */
    draftSave(input: DraftSaveInput): Promise<string>;
    /** Lists drafts of the active profile for a network (H19 retry). */
    draftList(networkId: string): Promise<DraftRecord[]>;
    /** Deletes a draft (H19 — on successful send). */
    draftDelete(id: string): Promise<void>;
  };
  history: {
    list(profileId: string, networkId: string, limit?: number): Promise<FocusHistoryEntry[]>;
    push(profileId: string, networkId: string, thoughtId: string): Promise<void>;
    /**
     * Rotates focus history on a focus change `oldId → newId` in one local
     * transaction (11-settings-and-state.md §2.3, H7). Uses the active profile
     * and the currently open network.
     */
    rotate(oldId: string | null, newId: string): Promise<void>;
    /**
     * Drops a thought from the focus history of the active profile/network —
     * the actor-side companion of the applier's prune on `thought.deleted`
     * (the server sends no realtime echo to the deleting client, L4).
     */
    remove(thoughtId: string): Promise<void>;
  };
  system: {
    health(): Promise<HealthResponse>;
    version(): Promise<VersionResponse>;
    export(networkId: string, request: ExportRequest): Promise<{ job_id: string }>;
    getJob(jobId: string): Promise<ExportJob>;
    /**
     * Opens the OS file picker for an image and returns its contents as a
     * `data:` URL (≤256 KiB). Resolves `null` when the user cancels or the file
     * is too large / unreadable.
     */
    pickImage(): Promise<string | null>;
    /**
     * Opens a local file with the OS default application (`shell.openPath`).
     * Resolves an error message string when the OS refuses (empty on success).
     */
    openPath(path: string): Promise<string>;
    /** Opens an external URL in the default browser (`shell.openExternal`). */
    openExternal(url: string): Promise<void>;
  };
}
