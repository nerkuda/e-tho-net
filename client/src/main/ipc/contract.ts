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
  ActivityRow,
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
  LinkDeletionCheckResult,
  LinkType,
  LinkTypeInput,
  LinkTypeUpdateInput,
  LinkUpdateInput,
  LockRow,
  MentionHit,
  MentionsScanRequest,
  MentionsScanResponse,
  Network,
  NetworkListItem,
  NetworkMember,
  NetworkProperty,
  NetworkPropertyInput,
  NetworkPropertyUpdateInput,
  UpdateNetworkInput,
  EffectiveTypeProperty,
  AttachPropertyInput,
  PropertyDefinition,
  PropertyDefinitionInput,
  PropertyDefinitionUpdateInput,
  PropertyValue,
  PropertyValueType,
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
  ThoughtCopyInput,
  ThoughtCopyResult,
  ThoughtCreateInput,
  ThoughtDeletionCheckResult,
  ThoughtLinksGrouped,
  ThoughtRef,
  ThoughtType,
  ThoughtTypeInput,
  ThoughtTypeUpdateInput,
  ThoughtUpdateInput,
  ThoughtUsage,
  TrashListResult,
  TrashPurgeResult,
  TypeOwnerType,
  User,
  UserFocusPreferences,
  UserPreferenceEntry,
  UsageClearResult,
  VersionResponse,
  Layer,
  LayerColors,
  LayerDeleteResult,
  LayerDiffDoc,
  LayerDiffResult,
  LayerEcho,
  LayerMergeReport,
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

/** Visit-history entry shape returned to the renderer (L4, docs §2.3). */
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

/**
 * Client application info for the «О программе» dialog (08-ui-spec.md §8.2).
 * All fields are read in the main process (`app.getVersion()` /
 * `process.versions`) — no server connection is involved.
 */
export interface AppInfo {
  /** ETN client version (`client/package.json`). */
  version: string;
  /** Electron runtime version. */
  electron: string;
  /** Chromium runtime version. */
  chrome: string;
  /** Node.js runtime version. */
  node: string;
}

/**
 * State of the client file journal (task f051bf95, 07-client-electron.md §7):
 * the flag, the current daily file and the journal directory.
 */
export interface ClientLogState {
  /** Whether WARN/INFO/DEBUG entries are currently written (ERROR — always). */
  enabled: boolean;
  /** Absolute path of the current daily `client-YYYY-MM-DD.log` file. */
  logFile: string;
  /** Absolute journal directory (`<userData>/logs`). */
  logDir: string;
}

/** Result of `system.deleteClientLogs` / counts of `system.deleteServerLogs`. */
export interface DeleteLogsResult {
  /** Files physically unlinked. */
  deleted: number;
  /** The current daily file — truncated in place, not deleted. */
  truncated: number;
}

/** Workspace view modes (08-ui-spec.md §15.1, задача f27809d0 «События»). */
export type TabViewMode = 'map' | 'structures' | 'chronicle' | 'activity';

/**
 * Public DTO of an open tab (07-client-electron.md §3.6, workplan Q2).
 * `focus_id`/`view_mode`/etc. may be `null` while the tab is freshly created.
 */
export interface TabDto {
  tab_id: string;
  slot_idx: number;
  network_id: string;
  focus_id: string | null;
  view_mode: TabViewMode | null;
  structures_state: string | null;
  chronicle_state: string | null;
  /** Per-tab persisted filter for the «События» view (задача f27809d0). */
  activity_state: string | null;
  /** Change-layer of the tab (S11, 13-layers.md §10.3); `null` — the base. */
  layer_id: string | null;
  last_active_at: string;
}

/**
 * Patch for {@link TabDto} updates (focus/view/filter_state/slot). A `null`
 * value clears the corresponding field (e.g. `focus_id: null` сбрасывает фокус).
 */
export interface TabStatePatch {
  slot_idx?: number;
  focus_id?: string | null;
  view_mode?: TabViewMode | null;
  structures_state?: string | null;
  chronicle_state?: string | null;
  /** Per-tab persisted filter for the «События» view (задача f27809d0). */
  activity_state?: string | null;
  /** Change-layer of the tab (S11); `null` — back to the base. */
  layer_id?: string | null;
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
    /**
     * Removes a saved server profile from the local DB (defect e28df893).
     * Disconnects first if `profileId` is the active profile so the realtime
     * pool never references a row that is about to disappear. Silently no-ops
     * on unknown ids.
     */
    removeProfile(profileId: string): Promise<void>;
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
    /** `atLayerId` (опционально) — открыть мысль в конкретном слое, не переключая сессию. */
    get(networkId: string, id: string, atLayerId?: string): Promise<Thought>;
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
    /**
     * `POST /thoughts/copy-batch` — paste a clipboard snapshot under
     * `parent_thought_id` (workplan L26, task bb8277f6). Atomic on the
     * server; emits `thought.created`/`link.created` for the realtime bus.
     */
    copyBatch(networkId: string, input: ThoughtCopyInput): Promise<ThoughtCopyResult>;
    resolve(networkId: string, ids: string[]): Promise<ThoughtRef[]>;
    search(networkId: string, request: SearchRequest): Promise<SearchResponse>;
    mentions(networkId: string, id: string): Promise<MentionHit[]>;
    /** `GET /thoughts/{id}/backlinks` — comments with explicit `[[#<id>]]` references (R3). */
    backlinks(networkId: string, id: string): Promise<MentionHit[]>;
    /** `POST /mentions/scan` — thought mentions in caller-supplied text (§21, L24). */
    mentionsScan(networkId: string, request: MentionsScanRequest): Promise<MentionsScanResponse>;
    /** `GET /thoughts/{id}/usage` — thoughts referencing this one via thought_ref (L7). */
    usage(networkId: string, id: string): Promise<ThoughtUsage>;
    /**
     * `POST /thoughts/deletion-check-batch` — blocking check before physical
     * deletion (S13, 03-server-api.md §6.5a). One call covers single + group.
     */
    deletionCheck(
      networkId: string,
      ids: string[],
    ): Promise<Record<string, ThoughtDeletionCheckResult>>;
    /** `POST /thoughts/{id}/usage/clear` — null every thought_ref referencing this (S13). */
    usageClear(networkId: string, id: string): Promise<UsageClearResult>;
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
    /** `atLayerId` (опционально) — открыть связь в конкретном слое, не переключая сессию. */
    get(networkId: string, id: string, atLayerId?: string): Promise<Link>;
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
    /** `POST /links/deletion-check-batch` (S13, 03-server-api.md §6.5a). */
    deletionCheck(
      networkId: string,
      ids: string[],
    ): Promise<Record<string, LinkDeletionCheckResult>>;
  };
  trash: {
    /** `GET /trash` — marked-for-deletion thoughts/links with precomputed blocking (S13). */
    list(networkId: string): Promise<TrashListResult>;
    /** `POST /trash/purge` — delete every unblocked marked row (S13). */
    purge(networkId: string): Promise<TrashPurgeResult>;
  };
  /**
   * Activity-log REST bridge (задачи f2eca5a4, 6bcccd2b;
   * docs/03-server-api.md §13d). Клиентский мост к `GET /activity` и
   * обслуживающим `POST /activity/rollup`/`/activity/truncate` —
   * паритет с MCP `etn.activity.*` (стандарт 9e5cff3f). Деструктивные
   * операции (`rollup`, `truncate`) в UI обязаны запрашивать подтверждение
   * (требование 9ac48831 «равноправие»).
   */
  activity: {
    /**
     * `GET /networks/{nid}/activity` — лента журнала с фильтрами
     * `from_ms`/`to_ms`/`user_id`/`entity_type`/`entity_id` и пагинацией.
     */
    list(
      networkId: string,
      filters?: {
        from_ms?: number;
        to_ms?: number;
        user_id?: string;
        entity_type?: string;
        entity_id?: string;
        limit?: number;
        offset?: number;
      },
    ): Promise<{ rows: ActivityRow[]; total: number }>;
    /** `POST /networks/{nid}/activity/rollup` — свёртка до `untilMs`. */
    rollup(networkId: string, untilMs: number): Promise<{ removed: number; kept: number }>;
    /** `POST /networks/{nid}/activity/truncate` — обрезка до `untilMs`. */
    truncate(networkId: string, untilMs: number): Promise<{ removed: number }>;
  };
  types: {
    listThoughtTypes(networkId: string): Promise<ThoughtType[]>;
    /** `GET /thought-types/counts` — own record count per type id (task
     *  «Улучшить диалог редактирования типов мыслей и связей»). */
    getThoughtTypeCounts(networkId: string): Promise<Record<string, number>>;
    /** `GET /thought-types/{id}` — один тип мысли (для резолва кликов по activity). */
    getThoughtType(networkId: string, id: string): Promise<ThoughtType>;
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
    /** `GET /link-types/counts` — the link-type analogue of `getThoughtTypeCounts`. */
    getLinkTypeCounts(networkId: string): Promise<Record<string, number>>;
    /** `GET /link-types/{id}` — один тип связи (для резолва кликов по activity). */
    getLinkType(networkId: string, id: string): Promise<LinkType>;
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
      /** Discriminated by `mode`: `attach` (existing registry id) or
       *  `create` (new registry property + binding in one call). */
      input: AttachPropertyInput,
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
    /** Set (`description`) or clear (`null`) a type's description override of
     *  a property inherited from an ancestor type. */
    setPropertyDescriptionOverride(
      networkId: string,
      ownerType: TypeOwnerType,
      typeId: string,
      propertyId: string,
      description: string | null,
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
  /**
   * Property registry (0.6.5). The registry is the single source of a
   * property's nature; the structures filter panel reads it in one call to
   * populate the property picker (task 171a438e) and the property manager
   * dialog (task d4e23670) drives create/update/delete through here.
   */
  propertyRegistry: {
    /** `GET /networks/{nid}/properties` — registry list with usage counters. */
    list(
      networkId: string,
    ): Promise<
      Array<NetworkProperty & { types_count: number; values_count: number }>
    >;
    /** `GET /networks/{nid}/properties/{id}` — one property with counters. */
    get(
      networkId: string,
      id: string,
    ): Promise<NetworkProperty & { types_count: number; values_count: number }>;
    /** `POST /networks/{nid}/properties` — create. */
    create(networkId: string, input: NetworkPropertyInput): Promise<NetworkProperty>;
    /**
     * `PATCH /networks/{nid}/properties/{id}` — patch. Returns the new
     * property alongside the conversion footprint (rewritten / dropped stored
     * values when `value_type` changed; both zero otherwise).
     */
    update(
      networkId: string,
      id: string,
      input: NetworkPropertyUpdateInput,
    ): Promise<{ property: NetworkProperty; converted: number; dropped: number }>;
    /** `DELETE /networks/{nid}/properties/{id}` — refused with 409 when bound. */
    remove(networkId: string, id: string): Promise<void>;
    /**
     * `GET /networks/{nid}/properties/{id}/usage` — type bindings, in-type
     * values per binding and out-of-type values count (the two numbers the
     * delete dialog surfaces).
     */
    usage(
      networkId: string,
      id: string,
    ): Promise<{
      property_id: string;
      name: string;
      value_type: PropertyValueType;
      bindings: Array<{
        owner_type: 'thought_type' | 'link_type';
        owner_id: string;
        owner_name: string;
        required: boolean;
        values_in_type_count: number;
      }>;
      values_in_type_count: number;
      values_outside_type_count: number;
    }>;
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
    /** `GET /attachments/{id}` — одна запись с владельцем (для резолва кликов по activity). */
    get(networkId: string, id: string): Promise<Attachment>;
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
  /**
   * Object-locks REST bridge (task 4f141756, операция 8919b057 «/locks»,
   * docs/03-server-api.md §13c). All endpoints are available to any network
   * member (`requireNetworkMember`). 409 LOCKED from `acquire` is surfaced
   * through the canonical error envelope with `details.holder` carrying the
   * current owner's coordinates.
   */
  locks: {
    /** `POST /networks/{nid}/locks` — acquire (idempotent for self). */
    acquire(
      networkId: string,
      entityType: string,
      entityId: string,
    ): Promise<LockRow>;
    /** `DELETE /networks/{nid}/locks/:lockId` — release (owner only). */
    release(networkId: string, lockId: string): Promise<void>;
    /**
     * `GET /networks/{nid}/locks` — list active locks, filterable by
     * `userId`/`clientId`. Cold-start resync and the «Участники мыслесети»
     * panel both consume this.
     */
    list(
      networkId: string,
      filters?: { userId?: string; clientId?: string },
    ): Promise<LockRow[]>;
    /** `POST /networks/{nid}/locks/clear` — manual reset for a participant. */
    clear(networkId: string, userId: string): Promise<{ cleared: number }>;
  };
  realtime: {
    onEvent(cb: (event: unknown) => void): () => void;
    /**
     * Per-network status change (Q2). Payload: `{networkId, status}` where
     * `status` is one of `'idle'|'connecting'|'connected'|'reconnecting'|'offline'`.
     */
    onStatusChange(cb: (payload: { networkId: string; status: string }) => void): () => void;
    /**
     * `resume.stale` per network (Q2). Payload: `{networkId, lastSeq}` — the
     * UI must fully re-focus the network whose event-log window was exceeded.
     */
    onStale(cb: (payload: { networkId: string; lastSeq: number }) => void): () => void;
    /** Per-network terminal close (Q5) — `network.deleted` or membership lost. */
    onNetworkLost(cb: (payload: { networkId: string; reason: 'unauthorized' | 'not-found' }) => void): () => void;
    /**
     * Layer control frames (S11, 13-layers.md §12, §2.4): the server switched
     * this session's layer (`switched`) or deleted the layer the session was
     * sitting on (`deleted` — the session is re-pointed to the parent). Both
     * require a full resync of the visible state.
     */
    onLayerControl(
      cb: (payload: {
        kind: 'switched' | 'deleted';
        networkId: string;
        layer: { id: string; title: string };
      }) => void,
    ): () => void;
    /**
     * Own-mutation flag (S11, 08-ui-spec.md §2.2): main suppressed the event
     * as this client's echo, but the write may have created a layer shadow
     * row — the renderer refreshes the canvas override marking. Payload:
     * `{networkId}`.
     */
    onSelfMutated(cb: (payload: { networkId: string }) => void): () => void;
    /**
     * Notifies main that the network came back (renderer `window.online` DOM
     * event, defect 7f4cef31). One-way, fire-and-forget: main force-reconnects
     * every pooled realtime socket instead of waiting for the idle watchdog.
     */
    notifyOnline(): void;
  };
  /**
   * Deep-link subscription (task R11, docs/12-wiki-id-refs.md §7.4). The main
   * process pushes `etn://open?net=<id>&thought=<id>` payloads here — cold
   * start (Win/Linux), `second-instance`, or `open-url` (macOS).
   */
  deepLink: {
    onDeepLink(cb: (payload: { networkId: string; thoughtId: string }) => void): () => void;
  };
  ui: {
    getState(networkId: string, key: string, tabId?: string | null): Promise<string | null>;
    setState(networkId: string, key: string, value: string, tabId?: string | null): Promise<void>;
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
  /**
   * Unified visit history (0.5.5, task «Переделать историю посещения
   * мыслей»): ONE list per tab of thoughts opened in the thought editor —
   * common to every screen (map/structures/chronicle). Replaces the old
   * per-view scoping (focus/structures) and the chronicle's own thought+link
   * history.
   */
  history: {
    list(
      profileId: string,
      networkId: string,
      tabId?: string | null,
      limit?: number,
    ): Promise<FocusHistoryEntry[]>;
    push(profileId: string, networkId: string, tabId: string | null, thoughtId: string): Promise<void>;
    /**
     * Rotates the visit history on an editor-thought change `oldId → newId`
     * in one local transaction (11-settings-and-state.md §2.3, H7, Q4). Uses
     * the active profile and the currently open network. `tabId` keys the
     * per-tab history (07-client-electron.md §3.5).
     */
    rotate(oldId: string | null, newId: string, tabId?: string | null): Promise<void>;
    /**
     * Drops a thought from the visit history of the active profile/network —
     * the actor-side companion of the applier's prune on `thought.deleted`
     * (the server sends no realtime echo to the deleting client, L4). `tabId`
     * scopes the removal to one tab; `null` clears across all tabs of the
     * network (server-side deletion cleanup).
     */
    remove(thoughtId: string, tabId?: string | null): Promise<void>;
    /** Clears the whole visit history of the active profile/network. `tabId`
     *  scopes; `null` clears all tabs. */
    clear(tabId?: string | null): Promise<void>;
  };
  tabs: {
    /** List all open tabs of the active profile, ordered by `slot_idx` (Q1/Q2). */
    list(): Promise<TabDto[]>;
    /**
     * Open a NEW tab for `networkId`; acquires the realtime socket.
     *
     * Duplicates of the same network are explicitly allowed — each tab keeps
     * its own focus / view / filter snapshot and history. The picker uses
     * this to give the user an independent workspace even when picking an
     * already-open network.
     */
    open(networkId: string): Promise<TabDto>;
    /** Activate a tab (returns snapshot for renderer store hydration). Returns
     *  `null` if the network is no longer accessible (Q5). */
    activate(tabId: string): Promise<TabDto | null>;
    /** Close a tab; releases the realtime socket when no tabs reference it. */
    close(tabId: string): Promise<void>;
    /** Reorder tabs to the given id order (single transaction). */
    reorder(orderedIds: string[]): Promise<void>;
    /** Update a tab's state (focus_id, view_mode, filter_state, slot_idx). */
    updateState(tabId: string, partial: TabStatePatch): Promise<void>;
  };
  /** Change layers (S11, 13-layers.md §10.3): the same surface as REST §5a. */
  layers: {
    /** All layers with hierarchy metadata; `current` marks the session's one. */
    list(networkId: string): Promise<Layer[]>;
    /** Create a layer (default parent — the session's current layer). The
     *  client passes creation-default colours so a fresh layer is visually
     *  distinct from the base right away (0.6.4 §2.2a). */
    create(
      networkId: string,
      input: {
        title: string;
        parent_id?: string;
        comment?: string | null;
        git_branch?: string | null;
        colors?: LayerColors | null;
      },
    ): Promise<Layer>;
    /** Rename a layer / edit its comment / replace its colours (full object
     *  or null; the base layer rejects colours — server-side 422). */
    update(
      networkId: string,
      layerId: string,
      changes: { title?: string; comment?: string | null; colors?: LayerColors | null },
      expectedVersion?: number,
    ): Promise<Layer>;
    /** Delete a layer + its subtree (cascade confirmation, §2.4). */
    remove(networkId: string, layerId: string, cascade?: number): Promise<LayerDeleteResult>;
    /** Switch the session's current layer (§7.1). */
    select(networkId: string, layerId: string): Promise<LayerEcho>;
    /** Merge the layer into its parent, fully or a closed partial subset. */
    merge(
      networkId: string,
      layerId: string,
      tables?: Record<string, string[]>,
    ): Promise<LayerMergeReport>;
    /** Structural diff + overridden ids (§10.3). */
    diff(networkId: string, layerId: string): Promise<LayerDiffResult>;
    /** Textual diff: two deterministic markdown documents (§10.3). */
    diffDoc(networkId: string, layerId: string): Promise<LayerDiffDoc>;
  };
  system: {
    /**
     * Client application info for the «О программе» dialog: the client version
     * (`app.getVersion()`) plus the Electron/Chromium/Node runtime versions.
     * Unlike {@link version} this never touches the server — it works without
     * a connection.
     */
    appInfo(): Promise<AppInfo>;
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
      targetPath?: string,
    ): Promise<{ saved_path: string | null; cancelled: boolean; error?: string }>;
    /**
     * Open the OS save dialog and return the chosen file path. Used by the
     * export dialog so the user can pick a destination up-front — when
     * «Экспортировать» is pressed, the file is written directly to that path
     * without a second save step.
     */
    pickSavePath(
      suggestedFilename: string,
      defaultExt: string,
    ): Promise<{ filePath: string | null; cancelled: boolean }>;
    /**
     * Open the OS file picker for a `.etnx` archive and return the chosen
     * path. Used by the import dialog (P6) to fill the «Файл архива» field —
     * the user picks a file once, then the dialog shows the slice toggles.
     */
    pickArchiveFile(): Promise<{
      filePath: string | null;
      cancelled: boolean;
      error?: string;
    }>;
    /**
     * Apply a `.etnx` archive to the network under `parentThoughtId`. The
     * main process reads the file (size-capped at `ETNX_MAX_BYTES`), base64-
     * encodes it and POSTs `/import/commit` with the optional slice toggles.
     * The route fires realtime events for every created thought/link so the
     * canvas/panels refresh without a manual reload.
     */
    importEtnx(
      networkId: string,
      parentThoughtId: string,
      filePath: string,
      slices?: {
        include_types?: boolean;
        include_attachments?: boolean;
        include_chronology?: boolean;
      },
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
     * Opens an attachment file in the OS default application. When the file is
     * missing locally (its `file_path` lives on a remote server), the stored
     * copy is downloaded to a temp file first and that copy is opened.
     * Resolves an error message string (empty on success).
     */
    openAttachmentFile(filePath: string): Promise<string>;
    /**
     * Opens an external target with the OS default application: http/https and
     * other registered protocols (e.g. `obsidian://`) via `shell.openExternal`,
     * `file://` URLs and bare local paths via `shell.openPath`. Resolves an
     * error message string when the target cannot be opened (empty on success)
     * so the renderer can show feedback.
     */
    openExternal(url: string): Promise<string>;
    // --- client/server file journals (task f051bf95, 07-client-electron.md §7) ---
    /**
     * State of the CLIENT file journal: the `log_enabled` flag, the current
     * daily file path and the journal directory. Works without a connection.
     */
    getClientLogState(): Promise<ClientLogState>;
    /**
     * Toggle the client file journal flag and persist it to
     * `client_meta.log_enabled` — the next start restores it. Returns the new
     * state.
     */
    setClientLogging(enabled: boolean): Promise<ClientLogState>;
    /**
     * Open the current client journal file in the OS default application
     * (creating an empty file first when none exists). Resolves an error
     * message string (empty on success).
     */
    openClientLog(): Promise<string>;
    /**
     * Delete every client journal file; the current daily file is truncated in
     * place (the writer keeps appending to it).
     */
    deleteClientLogs(): Promise<DeleteLogsResult>;
    /** `GET /system/logging` — server journal flag + retention + file list. */
    getServerLogging(): Promise<import('@etn/shared').SystemLoggingStatus>;
    /** `PUT /system/logging` — toggle the server in-memory journal flag. */
    setServerLogging(enabled: boolean): Promise<import('@etn/shared').SystemLoggingStatus>;
    /**
     * Download a server journal file through the main process. Without
     * `filename` the current (latest) server file is fetched; without
     * `savePath` the OS save dialog is shown (the `system.downloadExport`
     * pattern). Resolves `{ saved_path }`, `{ cancelled: true }` or an error.
     */
    downloadServerLog(
      filename?: string,
      savePath?: string,
    ): Promise<{ saved_path: string | null; cancelled: boolean; error?: string }>;
    /**
     * Open the current server journal file: when its `logDir` path exists
     * locally (client and server on one machine) — directly; otherwise the
     * file is downloaded to a temp file and that copy is opened. Resolves an
     * error message string (empty on success).
     */
    openServerLog(): Promise<string>;
    /** `DELETE /system/logs` — remove every server journal file (admin, 204). */
    deleteServerLogs(): Promise<void>;
  };

  /**
   * Milestone event bridge from the renderer into the client file journal
   * (task f051bf95 §3): fire-and-forget, no invoke contract — the main
   * process writes it as one INFO line `renderer <name> data=<…>` (only while
   * the journal flag is on; `data` is truncated to ~200 chars).
   */
  logEvent(name: string, data?: unknown): void;
}
