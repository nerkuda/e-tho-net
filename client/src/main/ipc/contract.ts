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
  AttachmentInput,
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
  LinkUpdateInput,
  MentionHit,
  Network,
  NetworkListItem,
  NetworkMember,
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
    getPreferences(id: string): Promise<Record<string, unknown>>;
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
  };
  properties: {
    get(networkId: string, ownerType: 'thought' | 'link', ownerId: string): Promise<unknown>;
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
    update(networkId: string, id: string, input: Partial<AttachmentInput>): Promise<Attachment>;
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
  };
  ui: {
    getState(networkId: string, key: string): Promise<string | null>;
    setState(networkId: string, key: string, value: string): Promise<void>;
  };
  history: {
    list(profileId: string, networkId: string, limit?: number): Promise<FocusHistoryEntry[]>;
    push(profileId: string, networkId: string, thoughtId: string): Promise<void>;
  };
  system: {
    health(): Promise<HealthResponse>;
    version(): Promise<VersionResponse>;
    export(networkId: string, request: ExportRequest): Promise<{ job_id: string }>;
    getJob(jobId: string): Promise<ExportJob>;
  };
}
