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

import type { DraftStatus } from '../db/local-db.js';

import type {
  ApiKey,
  Attachment,
  AttachmentContent,
  AttachmentContentUpdateInput,
  AttachmentContentUpdateResult,
  AttachmentCopyInput,
  AttachmentCopyResult,
  AttachmentFileInput,
  AttachmentInput,
  AttachmentSearchQuery,
  AttachmentUpdateInput,
  ChronicleFilterDefinition,
  ChronicleQueryRequest,
  ChronicleQueryResponse,
  ChronicleSavedFilter,
  Comment,
  CommentInput,
  CommentTarget,
  CurrentUser,
  ExportJob,
  ExportRequest,
  FocusDir,
  FocusEdge,
  FocusNeighbor,
  FocusOrderInput,
  FocusPreferencesInput,
  FocusResponse,
  HealthResponse,
  HierarchyResponse,
  Link,
  LinkCreateInput,
  LinkType,
  LinkTypeInput,
  LinkTypeUpdateInput,
  LinkUpdateInput,
  MentionHit,
  MentionsScanRequest,
  MentionsScanResponse,
  Network,
  NetworkListItem,
  NetworkMember,
  UpdateNetworkInput,
  EffectiveTypeProperty,
  PropertyDefinition,
  PropertyDefinitionInput,
  PropertyDefinitionUpdateInput,
  PropertyValue,
  SavedFilter,
  SavedFilterDefinition,
  PinnedThoughtEntry,
  SearchRequest,
  SearchResponse,
  StructureQueryRequest,
  StructureQueryResponse,
  StructureIdsQueryResponse,
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
  ThoughtUsage,
  TypeOwnerType,
  User,
  UserFocusPreferences,
  UserPreferenceEntry,
  VersionResponse,
} from '@etn/shared';

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

/**
 * Result of the system image picker (workplan L16): the ORIGINAL file as a
 * `data:` URL plus its meta, so the caller can upload it as an attachment and
 * derive an icon-sized preview from it.
 */
export type PickImageResult =
  | { status: 'ok'; dataUrl: string; name: string; mime: string; size: number }
  | { status: 'cancel' }
  | { status: 'error'; message: string };

/**
 * Result of the generic OS file picker: the chosen file's absolute path and
 * name. No bytes are read — the add-attachment dialog only fills its path
 * field with it; the server sees the file once «Добавить» is pressed.
 */
export type PickFileResult =
  | { status: 'ok'; path: string; name: string }
  | { status: 'cancel' };

/** Which view's visit history a `history.*` call addresses (L15, 11 §2.3.1). */
export type HistoryScope = 'focus' | 'structures';

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
  type_id: string | null;
  icon: string | null;
  icon_kind: 'emoji' | 'image';
  fg_color: string | null;
  bg_color: string | null;
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
  /** One parent's title (lexicographically first), to disambiguate equal titles. */
  parent_title: string | null;
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
    update(id: string, fields: UpdateNetworkInput): Promise<Network>;
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
    /** `POST /mentions/scan` — thought mentions in caller-supplied text (§21, L24). */
    mentionsScan(networkId: string, request: MentionsScanRequest): Promise<MentionsScanResponse>;
    /** `GET /thoughts/{id}/usage` — thoughts referencing this one via thought_ref (L7). */
    usage(networkId: string, id: string): Promise<ThoughtUsage>;
    /** `GET /thoughts/duplicates` — live duplicate candidates for the add dialog (H14). */
    findDuplicates(
      networkId: string,
      title: string,
      synonyms?: string[],
      /** Optional thought-type filter (thought_ref property pickers). */
      typeIds?: string[],
    ): Promise<DuplicateHit[]>;
    setFocusPreferences(
      networkId: string,
      focusId: string,
      input: FocusPreferencesInput,
    ): Promise<UserFocusPreferences>;
    setFocusOrder(networkId: string, focusId: string, input: FocusOrderInput): Promise<void>;
  };
  structures: {
    /** `POST /thoughts/query` — filter thoughts of the structures view (L15). */
    query(
      networkId: string,
      request: StructureQueryRequest,
    ): Promise<StructureQueryResponse>;
    /**
     * `POST /thoughts/query` with `ids_only: true` — bare ids of the whole
     * filter result, for the bulk filter commands (L22).
     */
    queryIds(
      networkId: string,
      request: StructureQueryRequest,
    ): Promise<StructureIdsQueryResponse>;
    /**
     * `GET /thoughts/{id}/hierarchy` — one-level parents/children with
     * per-branch dedup via `excludeIds`.
     */
    hierarchy(
      networkId: string,
      thoughtId: string,
      query: {
        dir: 'parents' | 'children';
        showInactive?: boolean;
        excludeIds?: string[];
        offset?: number;
      },
    ): Promise<HierarchyResponse>;
    /**
     * `POST /thoughts/edges` — every active link between the given visible
     * thoughts (03-server-api.md §6.12), for drawing the tree links.
     */
    edges(networkId: string, ids: string[], showInactive: boolean): Promise<FocusEdge[]>;
  };
  savedFilters: {
    list(networkId: string): Promise<SavedFilter[]>;
    create(
      networkId: string,
      input: { name: string; definition: SavedFilterDefinition },
    ): Promise<SavedFilter>;
    update(
      networkId: string,
      filterId: string,
      input: { name?: string; definition?: SavedFilterDefinition },
    ): Promise<SavedFilter>;
    remove(networkId: string, filterId: string): Promise<void>;
  };
  chronicle: {
    /** `POST /chronicle/query` — two-phase chronological-comment query (L20). */
    query(networkId: string, request: ChronicleQueryRequest): Promise<ChronicleQueryResponse>;
  };
  chronicleFilters: {
    /** `GET /saved-filters?view=chronicle` — the user's chronicle filters (L20). */
    list(networkId: string): Promise<ChronicleSavedFilter[]>;
    create(
      networkId: string,
      input: { name: string; definition: ChronicleFilterDefinition },
    ): Promise<ChronicleSavedFilter>;
    update(
      networkId: string,
      filterId: string,
      input: { name?: string; definition?: ChronicleFilterDefinition },
    ): Promise<ChronicleSavedFilter>;
    remove(networkId: string, filterId: string): Promise<void>;
  };
  pins: {
    /** `GET /networks/{nid}/pins` — the user's pinned thoughts in position order (L18). */
    list(networkId: string): Promise<PinnedThoughtEntry[]>;
    /** `PUT /networks/{nid}/pins` — replace the pinned list (idempotent, ≤20). */
    set(networkId: string, orderedIds: string[]): Promise<PinnedThoughtEntry[]>;
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
    /** `showInactive` — передать `preferences.show_inactive` (сервер иначе
     *  фильтрует неактуальные связи/мысли, 03-server-api.md §7.2). */
    listByThought(
      networkId: string,
      thoughtId: string,
      showInactive?: boolean,
    ): Promise<ThoughtLinksGrouped>;
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
    createLinkType(networkId: string, input: LinkTypeInput): Promise<LinkType>;
    updateLinkType(
      networkId: string,
      id: string,
      input: LinkTypeUpdateInput,
      expectedVersion: number,
    ): Promise<LinkType>;
    removeLinkType(
      networkId: string,
      id: string,
      expectedVersion: number,
      force?: boolean,
    ): Promise<void>;
    /**
     * Property definitions of a type (L6/L21); `ownerType` picks the type
     * kind. Since L21 the list is effective: the type's own definitions plus
     * everything inherited from ancestors (`inherited` flag on each).
     */
    listTypeProperties(
      networkId: string,
      ownerType: TypeOwnerType,
      typeId: string,
    ): Promise<EffectiveTypeProperty[]>;
    createTypeProperty(
      networkId: string,
      ownerType: TypeOwnerType,
      typeId: string,
      input: PropertyDefinitionInput,
    ): Promise<PropertyDefinition>;
    updateTypeProperty(
      networkId: string,
      ownerType: TypeOwnerType,
      typeId: string,
      propertyId: string,
      input: PropertyDefinitionUpdateInput,
    ): Promise<PropertyDefinition>;
    removeTypeProperty(
      networkId: string,
      ownerType: TypeOwnerType,
      typeId: string,
      propertyId: string,
    ): Promise<void>;
    reorderTypeProperties(
      networkId: string,
      ownerType: TypeOwnerType,
      typeId: string,
      orderedIds: string[],
    ): Promise<PropertyDefinition[]>;
    /** L21: set (`value`) or clear (`null`) a type's default-value override
     *  of a property inherited from an ancestor type. */
    setPropertyDefaultOverride(
      networkId: string,
      ownerType: TypeOwnerType,
      typeId: string,
      propertyId: string,
      value: string | number | boolean | null,
    ): Promise<void>;
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
    /** `POST /networks/{nid}/comments` — create attached to 1..N targets (L20). */
    createMulti(networkId: string, targets: CommentTarget[], input: CommentInput): Promise<Comment>;
    /** `GET /networks/{nid}/comments/{id}` — one comment with all targets (L20). */
    get(networkId: string, id: string): Promise<Comment>;
    update(
      networkId: string,
      id: string,
      input: Partial<CommentInput>,
      expectedVersion: number,
    ): Promise<Comment>;
    remove(networkId: string, id: string, expectedVersion: number): Promise<void>;
    /** `POST /networks/{nid}/comments/{id}/targets` — attach one more owner (L20). */
    addTarget(
      networkId: string,
      id: string,
      ownerType: 'thought' | 'link',
      ownerId: string,
      expectedVersion?: number,
    ): Promise<Comment>;
    /** `DELETE /networks/{nid}/comments/{id}/targets/{ownerType}/{ownerId}` (L20). */
    removeTarget(
      networkId: string,
      id: string,
      ownerType: 'thought' | 'link',
      ownerId: string,
      expectedVersion?: number,
    ): Promise<Comment>;
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
    /** `GET /attachments/{id}/content` — text (+ rendered html) of a text-like file (L7). */
    getContent(networkId: string, id: string): Promise<AttachmentContent>;
    /** `PUT /attachments/{id}/content` — overwrites a text-like file (L7). */
    updateContent(
      networkId: string,
      id: string,
      input: AttachmentContentUpdateInput,
    ): Promise<AttachmentContentUpdateResult>;
    /**
     * `POST /attachments/{id}/copy` — copy the attachment to one or more target
     * thoughts (workplan L25). Duplicates are skipped silently.
     */
    copy(
      networkId: string,
      attachmentId: string,
      input: AttachmentCopyInput,
    ): Promise<AttachmentCopyResult>;
    /**
     * `GET /attachments?q=…` — network-wide attachment search (workplan L25).
     * Used by the editor's "Найти существующее" dialog tab.
     */
    search(networkId: string, query: AttachmentSearchQuery): Promise<Attachment[]>;
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
    createUserKey(
      id: string,
      label?: string,
      maxWritesPerMinute?: number | null,
    ): Promise<{ id: string; apiKey: string }>;
    removeUserKey(id: string, keyId: string): Promise<void>;
    listNetworks(): Promise<Network[]>;
    removeNetwork(id: string): Promise<void>;
    listAudit(filters?: Record<string, unknown>): Promise<unknown>;
  };
  me: {
    get(): Promise<CurrentUser>;
    /**
     * `PATCH /me` — edit own profile (display_name only on the MVP).
     * Pass `null` to clear the display name; pass `''` (empty string) to
     * clear it after trimming. The store is updated by the caller.
     */
    update(displayName: string | null): Promise<CurrentUser>;
    listKeys(): Promise<ApiKey[]>;
    createKey(
      label?: string,
      maxWritesPerMinute?: number | null,
    ): Promise<{ id: string; apiKey: string }>;
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
  meta: {
    /**
     * Reads an L5 `client_meta` key — installation-scoped state such as the
     * UI theme (`CLIENT_META_KEY.THEME`, L10). Works without a connection.
     */
    get(key: string): Promise<string | null>;
    /** Upserts an L5 `client_meta` key. */
    set(key: string, value: string): Promise<void>;
  };
  history: {
    list(
      profileId: string,
      networkId: string,
      limit?: number,
      scope?: HistoryScope,
    ): Promise<FocusHistoryEntry[]>;
    push(
      profileId: string,
      networkId: string,
      thoughtId: string,
      scope?: HistoryScope,
    ): Promise<void>;
    /**
     * Rotates focus history on a focus change `oldId → newId` in one local
     * transaction (11-settings-and-state.md §2.3, H7). Uses the active profile
     * and the currently open network.
     */
    rotate(oldId: string | null, newId: string, scope?: HistoryScope): Promise<void>;
    /**
     * Drops a thought from a visit history of the active profile/network —
     * the actor-side companion of the applier's prune on `thought.deleted`
     * (the server sends no realtime echo to the deleting client, L4).
     */
    remove(thoughtId: string, scope?: HistoryScope): Promise<void>;
    /**
     * Clears the whole visit history of one view of the active
     * profile/network — the structures view clears its history when a new
     * filter is applied (§15.9).
     */
    clear(scope?: HistoryScope): Promise<void>;
    /** Chronicles (L20): lists the chronicle view's visit history, freshest first. */
    chronicleList(
      profileId: string,
      networkId: string,
      limit?: number,
    ): Promise<Array<{ kind: 'thought' | 'link'; id: string }>>;
    /** Chronicles (L20): (re)inserts a thought or link at the front of the history. */
    chroniclePush(
      profileId: string,
      networkId: string,
      kind: 'thought' | 'link',
      id: string,
    ): Promise<void>;
    /** Chronicles (L20): drops a single entry (thought deletion cleanup). */
    chronicleRemove(
      profileId: string,
      networkId: string,
      kind: 'thought' | 'link',
      id: string,
    ): Promise<void>;
    /** Chronicles (L20): clears the chronicle view's history (on «Применить»). */
    chronicleClear(profileId: string, networkId: string): Promise<void>;
  };
  system: {
    health(): Promise<HealthResponse>;
    version(): Promise<VersionResponse>;
    export(networkId: string, request: ExportRequest): Promise<{ job_id: string }>;
    getJob(jobId: string): Promise<ExportJob>;
    /**
     * Download a finished export job through the main process: it shows the
     * OS save dialog, fetches the binary with the current API key, writes
     * the bytes to the chosen path, and resolves with `{ saved_path }` (or
     * `{ cancelled: true }`). Going through main process is more reliable
     * than `<a download>` in Electron for binary content (`application/zip`,
     * `text/html`) — the bytes round-trip without the renderer's URL
     * navigation quirks.
     */
    downloadExport(
      jobId: string,
      suggestedFilename: string,
    ): Promise<{ saved_path: string | null; cancelled: boolean; error?: string }>;
    /**
     * Open the OS file picker for a `.etnx` archive and apply it to the
     * network under `parentThoughtId`. The main process handles the file
     * read + base64 encoding + REST roundtrip; the renderer only sees the
     * final summary (phase P, P6).
     */
    importEtnx(
      networkId: string,
      parentThoughtId: string,
    ): Promise<
      | { cancelled: true }
      | { cancelled: false; error: string; summary?: undefined; filename?: undefined }
      | {
          cancelled: false;
          error?: undefined;
          filename: string;
          summary: import('@etn/shared').ImportSummary;
        }
    >;
    /**
     * Opens the OS file picker for an image and returns the original file as a
     * `data:` URL with its name/mime/size (≤ the attachment upload limit). The
     * caller decides how to fit it into the icon limit (workplan L16).
     */
    pickImage(): Promise<PickImageResult>;
    /**
     * Opens the OS file picker for a file of ANY type and returns its absolute
     * path (no content is read). The add-attachment dialog's «Открыть с диска»
     * button fills its path field with the result.
     */
    pickFile(): Promise<PickFileResult>;
    /**
     * Opens a local file with the OS default application (`shell.openPath`).
     * Resolves an error message string when the OS refuses (empty on success).
     */
    openPath(path: string): Promise<string>;
    /**
     * Opens an external target with the OS default application: http/https and
     * other registered protocols (e.g. `obsidian://`) via `shell.openExternal`,
     * `file://` URLs and bare local paths via `shell.openPath`. Resolves an
     * error message string when the target cannot be opened (empty on success)
     * so the renderer can show feedback.
     */
    openExternal(url: string): Promise<string>;
  };
}
