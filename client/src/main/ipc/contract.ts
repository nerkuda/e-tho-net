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
  AttachmentOwnerType,
  AttachmentSearchQuery,
  AttachmentUpdateInput,
  AttachmentUsage,
  ChronicleFilterDefinition,
  ChronicleQueryRequest,
  ChronicleQueryResponse,
  ChronicleSavedFilter,
  Comment,
  CommentInput,
  CommentTarget,
  CurrentUser,
  CrossNetworkDuplicateResponse,
  CrossNetworkStructureQueryResponse,
  PropertyCrossResolveResult,
  DuplicateHit,
  DuplicateMatchKind,
  EtnErrorCode,
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
  LinkPropertyValues,
  LinkDeletionCheckResult,
  LinkType,
  LinkTypeFilterInput,
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
  NetworkStats,
  NetworkProperty,
  NetworkPropertyInput,
  NetworkPropertyUpdateInput,
  UpdateNetworkInput,
  EffectiveTypeProperty,
  AttachPropertyInput,
  PropertyDefinition,
  PropertyDefinitionUpdateInput,
  PropertyValue,
  SavedFilter,
  SavedFilterDefinition,
  PinnedThoughtEntry,
  Publication,
  PublicationActiveFilter,
  PublicationAssembly,
  PublicationCandidatesResult,
  PublicationCreateInput,
  PublicationDeletionCheckResult,
  PublicationExportRequest,
  PublicationListResult,
  PublicationOrderItem,
  PublicationSort,
  PublicationUpdateInput,
  PublicationUsageResult,
  Shelf,
  ShelfDeletionCheckResult,
  ShelfInput,
  SearchRequest,
  SearchResponse,
  StructureQueryRequest,
  StructureQueryResponse,
  StructureIdsQueryResult,
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
  ThoughtTypeView,
  ThoughtTypeViewInput,
  ThoughtTypeViewUpdateInput,
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
  LayerDiffPage,
  LayerDiffResult,
  LayerThoughtDiff,
  LayerEcho,
  LayerDiscardReport,
  LayerMergeReport,
  ActivityListResult,
  ActivityRollupResult,
  ActivityTruncateResult,
  ExportJobStartResult,
  LocksClearResult,
  NetworkPropertyDeleteResult,
  NetworkPropertyUpdateResult,
  NetworkPropertyUsage,
  NetworkPropertyWithCounters,
  RunThoughtTypeViewResult,
  ThoughtTypeViewsResult,
} from '@etn/shared';

/** Payload of the single `etn:invoke` channel used by the preload bridge. */
export interface IpcInvokePayload {
  /** Domain-qualified method name, e.g. `thoughts.get`. */
  method: string;
  /** Positional arguments forwarded to the matching handler. */
  args: unknown[];
  /**
   * Необязательный идентификатор вызова для отмены (требование ebed4980):
   * renderer шлёт его вместе с запросом, а при отмене — `etn:cancel { id }`.
   * Без него вызов неотменяем (обычные вызовы сигнала не несут).
   */
  requestId?: string;
}

/**
 * Контекст исполнения IPC-вызова, который видит обработчик: сигнал отмены,
 * зажигаемый сообщением `etn:cancel` по `requestId` (требование ebed4980).
 * Обработчики, которым отмена не нужна, контекст игнорируют.
 */
export interface IpcCallContext {
  signal: AbortSignal;
}

/**
 * Ошибка IPC-вызова, переданная из main в renderer ПЛОСКИМ объектом
 * (ошибка f14962ca).
 *
 * `ipcMain.handle` сериализует брошенную ошибку только как `name`/`message`/
 * `stack`, а `contextBridge` дополнительно теряет кастомные свойства —
 * `code` и `details` до renderer не доезжают (Electron issue #24427). Без
 * этого протокол-уровневые ветки UI (диалог подтверждения смены родителя,
 * обработка `LOCKED`/`VERSION_CONFLICT`) никогда не срабатывают. Поэтому main
 * резолвит вызов конвертом-объектом, а renderer восстанавливает из него
 * `EtnError` в своём контексте — там `instanceof` и `details` работают.
 */
export interface IpcErrorEnvelope {
  /** Маркер-дискриминатор: обычный результат им не бывает. */
  __etnError: true;
  error: {
    name: string;
    message: string;
    code?: EtnErrorCode;
    details?: unknown;
    request_id?: string;
  };
}

/**
 * Упаковать брошенную main-обработчиком ошибку в {@link IpcErrorEnvelope}.
 * Поля `code`/`details`/`requestId` берутся у `EtnError`; для прочих ошибок
 * остаются только `name` и `message`.
 */
export function toIpcErrorEnvelope(err: unknown): IpcErrorEnvelope {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error && err.name !== '' ? err.name : 'Error';
  const source = err as { code?: unknown; details?: unknown; requestId?: unknown };
  const error: IpcErrorEnvelope['error'] = { name, message };
  if (typeof source.code === 'string') error.code = source.code as EtnErrorCode;
  if (source.details !== undefined) error.details = source.details;
  if (typeof source.requestId === 'string') error.request_id = source.requestId;
  return { __etnError: true, error };
}

/** Проверка формы {@link IpcErrorEnvelope} на стороне renderer (type guard). */
export function isIpcErrorEnvelope(value: unknown): value is IpcErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { __etnError?: unknown; error?: unknown };
  if (v.__etnError !== true) return false;
  const e = v.error as { message?: unknown } | null | undefined;
  return typeof e === 'object' && e !== null && typeof e.message === 'string';
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
export type TabViewMode = 'map' | 'structures' | 'chronicle' | 'activity' | 'publications';

/**
 * Разобранная цель `etn://open`-deep-link (task R11; публикации — 0.11.1,
 * задача 3275fd8d, требование 7f583ef9): мысль (`thoughtId`) или публикация
 * (`publicationId`). Формы взаимоисключающи.
 */
export type DeepLinkPayload =
  | { networkId: string; thoughtId: string }
  | { networkId: string; publicationId: string };

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

// `DuplicateHit`/`DuplicateMatchKind` приходят из общего модуля (задача
// 120385ba): форма кандидата дубля объявлена один раз — и для REST-ответа, и
// для IPC-контракта. Реэкспорт сохранён для потребителей `window.etn`.
export type { DuplicateHit, DuplicateMatchKind };

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
    /** `GET /networks/{id}/statistics` — сводка по мыслесети (сумма по слоям). */
    statistics(id: string): Promise<NetworkStats>;
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
    /**
     * `linkFilter` (ошибка e5cee08e) ограничивает список теми же типами
     * связей, что и фильтр карты (`{ type_ids?, include_structural? }` —
     * сервер принимает его query-параметрами `link_type_id` +
     * `include_structural`). Без него превью показывает все связи.
     */
    neighbors(
      networkId: string,
      id: string,
      dir: FocusDir,
      limit?: number,
      offset?: number,
      linkFilter?: LinkTypeFilterInput,
    ): Promise<FocusNeighbor[]>;
    /**
     * `GET /thoughts/{id}/neighbors` с метаданными пагинации — источник
     * порционной подгрузки секторов карты мыслей (задача c8fa74ba). В
     * отличие от {@link neighbors} возвращает ещё и `total`, по которому
     * строится плавающий индикатор количества мыслей сектора.
     */
    neighborsPage(
      networkId: string,
      id: string,
      dir: FocusDir,
      limit: number,
      offset: number,
      sort?: import('@etn/shared').SortKind,
      order?: import('@etn/shared').SortOrder,
      linkFilter?: LinkTypeFilterInput,
    ): Promise<import('@etn/shared').NeighborPage>;
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
    /** `GET /thoughts/{id}/usage` — thoughts referencing this one through link-property edges (L7). */
    usage(networkId: string, id: string): Promise<ThoughtUsage>;
    /**
     * `POST /thoughts/deletion-check-batch` — blocking check before physical
     * deletion (S13, 03-server-api.md §6.5a). One call covers single + group.
     */
    deletionCheck(
      networkId: string,
      ids: string[],
    ): Promise<Record<string, ThoughtDeletionCheckResult>>;
    /** `POST /thoughts/{id}/usage/clear` — trash every blocking link-property edge to this thought (S13). */
    usageClear(networkId: string, id: string): Promise<UsageClearResult>;
    /** `GET /thoughts/duplicates` — live duplicate candidates for the add dialog (H14). */
    findDuplicates(
      networkId: string,
      title: string,
      synonyms?: string[],
      /** Optional thought-type filter (link-property pickers). */
      typeIds?: string[],
    ): Promise<DuplicateHit[]>;
    /**
     * Кросс-сетевой поиск дублей (задача eb1a3f43): веером по списку сетей
     * с простановкой `network_id` на каждом кандидате + справочник сетей.
     * Используется диалогом выбора сущностей при включённом переключателе
     * «по всем сетям». `networkId` — текущая открытая сеть; роут добавляет
     * её в веер, если её нет в `networkIds`.
     */
    findDuplicatesAcrossNetworks(
      networkId: string,
      networkIds: string[],
      title: string,
      synonyms?: string[],
      typeIds?: string[],
    ): Promise<CrossNetworkDuplicateResponse>;
    /**
     * Кросс-сетевой поиск (задача eb1a3f43, требование c98d5d19). Возвращает
     * обычный `SearchResponse` с дополнительным `networks` (справочник сетей)
     * и `network_id` на каждом хите. `networkId` — текущая открытая сеть;
     * роут добавляет её в веер, если её нет в `networkIds`.
     */
    searchAcrossNetworks(
      networkId: string,
      networkIds: string[],
      request: SearchRequest,
    ): Promise<SearchResponse>;
    /**
     * Кросс-сетевая структурная выборка (задача eb1a3f43). Возвращает
     * `StructureQueryResponse`, где каждый item несёт `network_id`, а
     * `networks` — справочник сетей в дополнительном поле meta. `networkId`
     * — текущая открытая сеть.
     */
    queryStructureAcrossNetworks(
      networkId: string,
      networkIds: string[],
      request: StructureQueryRequest,
    ): Promise<CrossNetworkStructureQueryResponse>;
    setFocusPreferences(
      networkId: string,
      focusId: string,
      input: FocusPreferencesInput,
    ): Promise<UserFocusPreferences>;
    setFocusOrder(networkId: string, focusId: string, input: FocusOrderInput): Promise<void>;
  };
  structures: {
    /**
     * `POST /thoughts/query` — filter thoughts of the structures view (L15).
     * `options.signal` отменяет устаревший запрос (требование ebed4980).
     */
    query(
      networkId: string,
      request: StructureQueryRequest,
      options?: { signal?: AbortSignal },
    ): Promise<StructureQueryResponse>;
    /**
     * `POST /thoughts/query` with `ids_only: true` — bare ids of the whole
     * filter result, for the bulk filter commands (L22).
     * `options.signal` отменяет устаревший запрос (требование ebed4980).
     */
    queryIds(
      networkId: string,
      request: StructureQueryRequest,
      options?: { signal?: AbortSignal },
    ): Promise<StructureIdsQueryResult>;
    /**
     * `GET /thoughts/{id}/hierarchy` — one-level parents/children with
     * per-branch dedup via `excludeIds`. `linkFilter` — фильтр обхода по
     * связям отбора (ошибка db504c1a): раскрытие ветви идёт по тем же рёбрам,
     * что и спуск.
     */
    hierarchy(
      networkId: string,
      thoughtId: string,
      query: {
        dir: 'parents' | 'children';
        showInactive?: boolean;
        excludeIds?: string[];
        offset?: number;
        linkFilter?: LinkTypeFilterInput;
      },
    ): Promise<HierarchyResponse>;
    /**
     * `POST /thoughts/edges` — every active link between the given visible
     * thoughts (03-server-api.md §6.12), for drawing the tree links.
     *
     * `linkFilter` (ошибка a617b4c6) — активный фильтр типов связей: снимок
     * рёбер обязан уважать его так же, как фокус и страницы секторов.
     */
    edges(
      networkId: string,
      ids: string[],
      showInactive: boolean,
      linkFilter?: LinkTypeFilterInput,
    ): Promise<FocusEdge[]>;
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
    update(
      networkId: string,
      id: string,
      input: LinkUpdateInput,
      expectedVersion: number,
    ): Promise<Link>;
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
    /**
     * `POST /trash/purge` — physically delete unblocked marked rows. `ids`
     * narrows the sweep to the listed rows (ошибка 8b4b7a7e: per-item
     * «Удалить совсем» of a link — `DELETE /links/{id}` снят 0.8.1).
     */
    purge(networkId: string, ids?: string[]): Promise<TrashPurgeResult>;
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
    ): Promise<ActivityListResult>;
    /** `POST /networks/{nid}/activity/rollup` — свёртка до `untilMs`. */
    rollup(networkId: string, untilMs: number): Promise<ActivityRollupResult>;
    /** `POST /networks/{nid}/activity/truncate` — обрезка до `untilMs`. */
    truncate(networkId: string, untilMs: number): Promise<ActivityTruncateResult>;
  };
  /**
   * Клиентский мост подсистемы «Публикации» (0.11.1, задача a3cfc018;
   * REST-маршруты c59ce742). Паритет с REST: библиотека, полки, карточка,
   * жизненный цикл, пересборка, кандидаты, использование, экспорт.
   */
  publications: {
    list(
      networkId: string,
      query?: {
        q?: string;
        shelf?: string;
        active?: PublicationActiveFilter;
        sort?: PublicationSort;
        include_trashed?: boolean;
        limit?: number;
        offset?: number;
      },
    ): Promise<PublicationListResult>;
    create(networkId: string, input: PublicationCreateInput): Promise<Publication>;
    get(networkId: string, id: string): Promise<Publication>;
    /**
     * `GET …/publications/{id}/deletion-check` — блокировки физического
     * удаления (аналог `deletion-check` мысли). Диалог удаления решает по нему,
     * доступна ли кнопка «Удалить совсем» (задача 00160da1).
     */
    deletionCheck(networkId: string, id: string): Promise<PublicationDeletionCheckResult>;
    update(
      networkId: string,
      id: string,
      input: PublicationUpdateInput,
      expectedVersion?: number,
    ): Promise<Publication>;
    trash(networkId: string, id: string): Promise<Publication>;
    restore(networkId: string, id: string): Promise<Publication>;
    purge(networkId: string, id: string): Promise<void>;
    rebuild(networkId: string, id: string): Promise<Publication>;
    /** `PUT …/publications/{id}/order` — батч локального порядка узлов. */
    setOrder(
      networkId: string,
      id: string,
      items: readonly PublicationOrderItem[],
    ): Promise<PublicationOrderItem[]>;
    /** `POST …/publications/{id}/exclusions` — исключить мысль. */
    addExclusion(networkId: string, id: string, thoughtId: string): Promise<void>;
    /** `DELETE …/publications/{id}/exclusions?thought_id=` — вернуть мысль. */
    removeExclusion(networkId: string, id: string, thoughtId: string): Promise<void>;
    assembly(
      networkId: string,
      id: string,
      query?: { page?: number; include_excluded?: boolean },
    ): Promise<PublicationAssembly>;
    candidates(
      networkId: string,
      id: string,
      query?: { limit?: number; offset?: number; include_excluded?: boolean },
    ): Promise<PublicationCandidatesResult>;
    /** `POST …/publications/{id}/candidates/accept` — «расставить» кандидата. */
    acceptCandidate(networkId: string, id: string, thoughtId: string): Promise<void>;
    usage(
      networkId: string,
      thoughtId: string,
      query?: { limit?: number; offset?: number; publication_limit?: number },
    ): Promise<PublicationUsageResult>;
    export(
      networkId: string,
      id: string,
      request: PublicationExportRequest,
    ): Promise<ExportJobStartResult>;
    /** `GET /networks/{nid}/shelves` — полки библиотеки с составом. */
    listShelves(networkId: string): Promise<Shelf[]>;
    createShelf(networkId: string, input: ShelfInput): Promise<Shelf>;
    updateShelf(networkId: string, id: string, input: ShelfInput): Promise<Shelf>;
    trashShelf(networkId: string, id: string): Promise<Shelf>;
    restoreShelf(networkId: string, id: string): Promise<Shelf>;
    purgeShelf(networkId: string, id: string): Promise<void>;
    /**
     * `GET …/shelves/{id}/deletion-check` — блокировки физического удаления
     * полки (только контекст слоя; состав сносится каскадом). Диалог удаления
     * решает по нему, доступна ли кнопка «Удалить совсем» (задача 00160da1).
     */
    shelfDeletionCheck(networkId: string, id: string): Promise<ShelfDeletionCheckResult>;
    addShelfItem(
      networkId: string,
      shelfId: string,
      publicationId: string,
      position?: number,
    ): Promise<Shelf>;
    removeShelfItem(networkId: string, shelfId: string, publicationId: string): Promise<Shelf>;
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
     *  of a property inherited from an ancestor type. A link property's
     *  default is a target-set — `string[]` of thought ids (bb67e546). */
    setPropertyDefaultOverride(
      networkId: string,
      ownerType: TypeOwnerType,
      typeId: string,
      propertyId: string,
      value: string | number | boolean | string[] | null,
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
  thoughtTypeViews: {
    /** `GET /thought-types/{id}/views` — list views of a single thought type
     *  (task c1fa71d4, 0.7.3). `includeEffective: true` (default) attaches
     *  the effective chain (`meta.effective`) on top of the type's own
     *  views; the strip renders the effective chain. */
    list(
      networkId: string,
      thoughtTypeId: string,
      opts?: { includeEffective?: boolean },
    ): Promise<ThoughtTypeViewsResult>;
    /** `POST /thought-types/{id}/views` — create a new view. The dialog
     *  (stage 8) lives at the editor; here we only provide the IPC. */
    create(
      networkId: string,
      thoughtTypeId: string,
      input: ThoughtTypeViewInput,
    ): Promise<ThoughtTypeView>;
    /** `PATCH /thought-types/{id}/views/{viewId}` — partial update with
     *  optimistic concurrency (`expectedVersion` → `If-Match`). */
    update(
      networkId: string,
      thoughtTypeId: string,
      viewId: string,
      input: ThoughtTypeViewUpdateInput,
      expectedVersion: number,
    ): Promise<ThoughtTypeView>;
    /** `DELETE /thought-types/{id}/views/{viewId}` — optimistic
     *  concurrency required; the strip context menu calls this on «Удалить
     *  отбор». */
    remove(
      networkId: string,
      thoughtTypeId: string,
      viewId: string,
      expectedVersion: number,
    ): Promise<void>;
    /** `POST /thoughts/{thoughtId}/views/{view}/run` — run a view
     *  relative to a context thought. `view` is the view's `name_key`
     *  (case-insensitive); the server matches it in the effective chain
     *  and substitutes `$thought.*` tokens before executing the filter.
     *  When the resolver cannot bind a token, `meta.unresolved` explains
     *  why and the lower zone reads from there (spec `9984aa98`). */
    run(
      networkId: string,
      thoughtId: string,
      viewName: string,
      opts?: { sort?: import('@etn/shared').StructureSort; order?: import('@etn/shared').SortOrder; limit?: number; offset?: number },
    ): Promise<RunThoughtTypeViewResult>;
  };
  properties: {
    /**
     * `GET /networks/{nid}/thoughts|links/{id}/properties`. Для скалярных
     * свойств — `PropertyValue`; свойства-связи (0.8.1) приходят формой
     * `LinkPropertyValues` (счётчик + рёбра `values[]` с `target_id`/
     * `target_title`) — поля `.value` у них нет.
     */
    get(
      networkId: string,
      ownerType: 'thought' | 'link',
      ownerId: string,
    ): Promise<(PropertyValue | LinkPropertyValues)[]>;
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
    /**
     * Кросс-сетевой резолв значений `cross_network_ref` (задача 7849008a).
     * REST `POST …/thoughts|links/{id}/properties/{key}/cross-resolve`.
     * Возвращает обновлённые снапшоты имён целей и пометки нерезолвленности.
     * Сейчас реализован для `owner_type === 'thought'` — link-вариант
     * добавляется отдельной задачей.
     */
    crossResolve(
      networkId: string,
      ownerId: string,
      key: string,
    ): Promise<PropertyCrossResolveResult>;
  };
  /**
   * Property registry (0.6.5). The registry is the single source of a
   * property's nature; the structures filter panel reads it in one call to
   * populate the property picker (task 171a438e) and the property manager
   * dialog (task d4e23670) drives create/update/delete through here.
   */
  propertyRegistry: {
    /** `GET /networks/{nid}/properties` — registry list with usage counters. */
    list(networkId: string): Promise<NetworkPropertyWithCounters[]>;
    /** `GET /networks/{nid}/properties/{id}` — one property with counters. */
    get(networkId: string, id: string): Promise<NetworkPropertyWithCounters>;
    /** `POST /networks/{nid}/properties` — create. */
    create(networkId: string, input: NetworkPropertyInput): Promise<NetworkProperty>;
    /**
     * `PATCH /networks/{nid}/properties/{id}` — patch. Returns the NEW
     * property FLATTENED together with the conversion footprint (rewritten /
     * dropped stored values when `value_type` changed; both zero otherwise):
     * the server sends `{ ...property, converted, dropped }` as the response
     * `data`, not a `{ property, … }` envelope (ошибка c83f0215 — клиент
     * читал `result.property` и терял `id` свойства).
     */
    update(
      networkId: string,
      id: string,
      input: NetworkPropertyUpdateInput,
    ): Promise<NetworkPropertyUpdateResult>;
    /**
     * `DELETE /networks/{nid}/properties/{id}` — refused with 409 when bound.
     * For link-properties the server returns the number of edges that lose
     * `type_id` and become structural («Родители»/«Потомки») so the confirm
     * dialog can quote it directly (0.8.1, требование 09f692ff); for
     * scalar properties the field is `null`.
     */
    remove(
      networkId: string,
      id: string,
    ): Promise<NetworkPropertyDeleteResult>;
    /**
     * `GET /networks/{nid}/properties/{id}/usage` — type bindings, in-type
     * values per binding and out-of-type values count (the two numbers the
     * delete dialog surfaces).
     */
    usage(networkId: string, id: string): Promise<NetworkPropertyUsage>;
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
    list(networkId: string, ownerType: AttachmentOwnerType, ownerId: string): Promise<Attachment[]>;
    /** `GET /attachments/{id}` — одна запись с владельцем (для резолва кликов по activity). */
    get(networkId: string, id: string): Promise<Attachment>;
    add(
      networkId: string,
      ownerType: AttachmentOwnerType,
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
      ownerType: AttachmentOwnerType,
      ownerId: string,
      input: AttachmentFileInput,
    ): Promise<Attachment>;
    update(networkId: string, id: string, input: AttachmentUpdateInput): Promise<Attachment>;
    remove(networkId: string, id: string): Promise<void>;
    /**
     * `GET /attachments/{id}/usage` — владельцы (мысли, публикации, связи),
     * держащие тот же физический носитель; «облачка» в диалоге выбора обложки
     * (0.11.1, задача 46cf4bcb).
     */
    getUsage(networkId: string, id: string): Promise<AttachmentUsage>;
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
    clear(networkId: string, userId: string): Promise<LocksClearResult>;
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
     * Own-mutation flag (S11, 08-ui-spec.md §2.2): the write may have created
     * a layer shadow row — the renderer refreshes the canvas override marking
     * right away (B1: the realtime event also arrives, but asynchronously).
     * Payload: `{networkId}`.
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
   * start (Win/Linux), `second-instance`, or `open-url` (macOS). Публикации
   * (0.11.1, задача 3275fd8d, требование 7f583ef9) несут `publicationId`
   * вместо `thoughtId` — формы взаимоисключающи.
   */
  deepLink: {
    onDeepLink(cb: (payload: DeepLinkPayload) => void): () => void;
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
     * (L4). `tabId` scopes the removal to one tab; `null` clears across all
     * tabs of the network (server-side deletion cleanup).
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
    /**
     * Задача f5c363a3: слить ОДНУ мысль из слоя в основу с разрешением
     * конфликта. `mode`: `overwrite` — «Полностью переписать мысль в основе»
     * (версия слоя побеждает), `combine` — «Объединить изменения» (постоянный
     * комментарий объединяется с основой, маркеры конфликтов; связи, свойства и
     * синонимы переносятся версией слоя).
     */
    mergeThought(
      networkId: string,
      layerId: string,
      thoughtId: string,
      mode: 'overwrite' | 'combine',
    ): Promise<LayerMergeReport>;
    /**
     * Задача f5c363a3: «Отказаться от изменений» — убрать из слоя все строки
     * мысли (она вернётся к состоянию основы; созданная только в слое —
     * исчезнет). Основа не затрагивается.
     */
    discardThought(networkId: string, layerId: string, thoughtId: string): Promise<LayerDiscardReport>;
    /** Structural diff + overridden ids (§10.3). */
    diff(networkId: string, layerId: string): Promise<LayerDiffResult>;
    /**
     * One page of the structural diff (§10.3; задача ddb67ddc) — the diff
     * dialog walks pages by `next_cursor` instead of pulling the full report.
     */
    diffPage(
      networkId: string,
      layerId: string,
      options?: { limit?: number; cursor?: string | null },
    ): Promise<LayerDiffPage>;
    /**
     * Display-ready field pairs of ONE thought in both contexts (задача
     * 52c776f1) — the source of the per-thought line diff dialog.
     */
    thoughtDiff(networkId: string, layerId: string, thoughtId: string): Promise<LayerThoughtDiff>;
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
    export(networkId: string, request: ExportRequest): Promise<ExportJobStartResult>;
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

/**
 * Мост-форма отменяемых выборок «Структур» (требование ebed4980, ошибка
 * b7cbd0e0). Отличается от публичной {@link EtnApi['structures']} только
 * парой `query`/`queryIds`.
 *
 * Почему отдельный тип: `AbortSignal` — host-объект, он НЕ переживает
 * `contextBridge`-сериализацию аргументов и приезжает в preload пустым
 * объектом. Поэтому за мост уходит только примитив `requestId`, а слушатель
 * `abort` живёт в renderer-контексте. Публичную форму (с `{ signal }`)
 * renderer получает из фасада `renderer/lib/etn.ts`, который приводит её к
 * этой мост-форме.
 */
export type EtnBridgeStructures = Omit<EtnApi['structures'], 'query' | 'queryIds'> & {
  /**
   * `POST /thoughts/query` с отменяемым `requestId`: main регистрирует по нему
   * `AbortController`; сообщение `etn:cancel { requestId }` гасит fetch.
   * Без `requestId` вызов неотменяем.
   */
  query(
    networkId: string,
    request: StructureQueryRequest,
    requestId?: string,
  ): Promise<StructureQueryResponse>;
  /** `queryIds` — тот же отменяемый путь, что и {@link EtnBridgeStructures.query}. */
  queryIds(
    networkId: string,
    request: StructureQueryRequest,
    requestId?: string,
  ): Promise<StructureIdsQueryResult>;
};

/**
 * Сырая поверхность, которую preload выставляет в renderer через
 * `contextBridge.exposeInMainWorld('etn', …)` — то, чем реально является
 * `window.etn`. Renderer-код работает с ней через фасад `renderer/lib/etn.ts`,
 * типизированный публичной {@link EtnApi} (сигнатура с `AbortSignal`).
 */
export type EtnBridgeApi = Omit<EtnApi, 'structures'> & {
  structures: EtnBridgeStructures;
  /**
   * Fire-and-forget отмена вызова по `requestId` (требование ebed4980): шлёт
   * `etn:cancel` в main, ответа не ждёт. Вызывается renderer-фасадом из
   * слушателя `abort` — сигнал за мост не уходит (ошибка b7cbd0e0).
   */
  cancelRequest(requestId: string): void;
};
