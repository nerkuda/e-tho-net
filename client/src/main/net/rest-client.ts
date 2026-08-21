/**
 * REST client for the ETN server (docs/03-server-api.md, 07-client-electron.md §4.1,
 * workplan G5).
 *
 * Thin, fully-typed wrapper over the global `fetch` (stable on Node 20+ / Electron
 * main process). Responsibilities:
 *
 *  - attaches `Authorization: Bearer <apiKey>` and `Client-Id: <clientId>` to every
 *    request (the API-key is resolved lazily from `safeStorage` via `getApiKey()`,
 *    so it never sits in a long-lived field);
 *  - attaches `Client-Request-Id` on mutating requests when the caller provides a
 *    `clientRequestId` (idempotency, 01-architecture.md §6);
 *  - attaches `If-Match: <version>` for optimistic concurrency (03-server-api.md §1);
 *  - retries 5xx responses and network errors with exponential backoff, up to 3
 *    attempts total (never on 4xx);
 *  - enforces a 30 s response timeout via `AbortSignal`;
 *  - throws an {@link EtnError} carrying the server's `code`/`details`/`request_id`
 *    for every non-2xx response shaped as `{ error: EtnErrorBody }`.
 *
 * The class holds **no** network state (no cookie jar) and is safe to share across
 * IPC handlers. All methods return the parsed `data` of the success envelope
 * (`{ data, meta }`); `meta` is exposed via {@link lastMeta} when a caller needs the
 * version/request_id of the most recent call.
 */
import {
  EtnError,
  type ApiList,
  type ApiSuccess,
  type EtnErrorBody,
  type EtnErrorCode,
  type TypeOwnerType,
} from '@etn/shared';

/** Maximum total attempts (initial + retries) for a transient failure. */
const MAX_ATTEMPTS = 3;

/** Base delay for exponential backoff, in milliseconds. */
const RETRY_BASE_DELAY_MS = 500;

/** Hard cap on a single backoff sleep, in milliseconds. */
const RETRY_MAX_DELAY_MS = 5_000;

/** Response timeout applied to every request, in milliseconds (03-server-api.md §4.1). */
const RESPONSE_TIMEOUT_MS = 30_000;

/** Constructor options for {@link RestClient}. */
export interface RestClientOptions {
  /** Server base URL, e.g. `http://localhost:3000`. Trailing slash is stripped. */
  baseUrl: string;
  /** Resolves the plaintext API-key just-in-time (decryption in main process). */
  getApiKey: () => Promise<string>;
  /** Returns the installation Client-Id (sync; already materialised in `client_meta`). */
  getClientId: () => string;
  /**
   * Optional override of the global `fetch` — primarily for unit tests. Defaults to
   * the ambient `fetch` (Node 20+ / Electron main).
   */
  fetchImpl?: typeof fetch;
  /** Optional override of a random jitter function (for deterministic tests). */
  random?: () => number;
}

/** Extra per-call options accepted by mutating endpoints. */
export interface RequestOptions {
  /** Sent as `Client-Request-Id` (idempotency, 01-architecture.md §6). */
  clientRequestId?: string;
  /** Entity version; sent as `If-Match` for optimistic concurrency (§1). */
  expectedVersion?: number;
  /** Optional abort signal; combined with the internal response timeout. */
  signal?: AbortSignal;
}

/** Query string value — primitives are stringified, arrays repeated. */
type QueryValue = string | number | boolean | undefined | null;
type QueryRecord = Record<string, QueryValue | QueryValue[]>;

/**
 * Duplicate candidate returned by `GET /thoughts/duplicates`
 * (08-ui-spec.md §4.4). Mirrors the server-side `DuplicateHit` shape.
 */
export interface DuplicateCandidate {
  id: string;
  title: string;
  synonyms: string[];
  matched_on: 'title' | 'synonym' | 'partial';
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
  parent_title: string | null;
}

/**
 * Strongly-typed ETN REST client. Construct one per active server profile and reuse
 * it for the lifetime of the connection (see `NetContext`, task G7).
 *
 * Example:
 * ```ts
 * const client = new RestClient({
 *   baseUrl: 'http://localhost:3000',
 *   getApiKey: () => decryptApiKey(profile.api_key_encrypted),
 *   getClientId: () => clientId,
 * });
 * const me = await client.getMe();
 * ```
 */
export class RestClient {
  private readonly baseUrl: string;
  private readonly getApiKey: () => Promise<string>;
  private readonly getClientId: () => string;
  private readonly fetchImpl: typeof fetch;
  private readonly random: () => number;

  /** Metadata of the most recent successful response (version/request_id). */
  public lastMeta: ApiSuccess<unknown>['meta'] | undefined;

  public constructor(opts: RestClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getApiKey = opts.getApiKey;
    this.getClientId = opts.getClientId;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.random = opts.random ?? Math.random;
  }

  // -------------------------------------------------------------------------
  // Core request engine
  // -------------------------------------------------------------------------

  /**
   * Performs an HTTP request with auth, retry and error normalisation. Returns the
   * parsed `data` of the success envelope. Throws {@link EtnError} on any non-2xx
   * response or unrecoverable network failure.
   *
   * Generic `T` is the `data` payload type. List endpoints use
   * `T = SomeDto[]` together with {@link lastMeta}.
   *
   * @param method HTTP verb.
   * @param path Path under `/api/v1` (without the prefix), e.g. `/me`.
   * @param opts Body, query, request options.
   */
  private async request<T>(
    method: string,
    path: string,
    opts: {
      query?: QueryRecord;
      body?: unknown;
      requestOptions?: RequestOptions;
    } = {},
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const ro = opts.requestOptions ?? {};
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Compose headers per attempt: the API-key is resolved lazily so a key
      // rotation mid-session is picked up without rebuilding the client.
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await this.getApiKey()}`,
        'Client-Id': this.getClientId(),
        Accept: 'application/json',
      };
      if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      if (ro.clientRequestId !== undefined) {
        headers['Client-Request-Id'] = ro.clientRequestId;
      }
      if (ro.expectedVersion !== undefined) {
        headers['If-Match'] = String(ro.expectedVersion);
      }

      // Compose the abort signal: internal response timeout, merged with any
      // caller-supplied signal. AbortController that triggers on whichever fires.
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error('ETN response timeout')),
        RESPONSE_TIMEOUT_MS,
      );
      if (ro.signal !== undefined) {
        // Forward caller-initiated aborts.
        if (ro.signal.aborted) controller.abort(ro.signal.reason);
        else
          ro.signal.addEventListener('abort', () => controller.abort(ro.signal!.reason), {
            once: true,
          });
      }

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
        });
      } catch (err: unknown) {
        clearTimeout(timeout);
        // Network-level failure (DNS, connection refused, timeout abort, etc.).
        // Retryable unless the caller aborted the request themselves.
        if (ro.signal?.aborted) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_ATTEMPTS) {
          await this.backoff(attempt);
          continue;
        }
        throw new EtnError('INTERNAL', `Сетевая ошибка: ${lastError.message}`);
      }
      clearTimeout(timeout);

      // Retry transient server errors (5xx) once more.
      if (res.status >= 500 && res.status < 600 && attempt < MAX_ATTEMPTS) {
        lastError = new Error(`HTTP ${res.status}`);
        await this.backoff(attempt);
        continue;
      }

      return (await this.parseResponse<T>(res)) as T;
    }

    // Loop exited without returning — exhausted retries.
    throw new EtnError(
      'INTERNAL',
      lastError ? `Превышен лимит повторов: ${lastError.message}` : 'Неизвестная ошибка запроса',
    );
  }

  /**
   * Parses a fetch `Response` into typed `data`, capturing `meta` and converting
   * error envelopes into {@link EtnError}.
   */
  private async parseResponse<T>(res: Response): Promise<T> {
    const text = await res.text();
    const empty = text.length === 0;
    let payload: unknown = undefined;
    if (!empty) {
      try {
        payload = JSON.parse(text);
      } catch {
        // Non-JSON body — fall through to generic error below.
        payload = undefined;
      }
    }

    if (res.status === 204 || empty) {
      // 204 No Content (e.g. DELETE) — no body to return.
      this.lastMeta = undefined;
      return undefined as T;
    }

    if (!res.ok) {
      const body = payload as Partial<{ error: EtnErrorBody }> | undefined;
      const err = body?.error;
      if (err) {
        throw new EtnError(err.code, err.message, err.details, err.request_id);
      }
      // Server returned an error in a non-canonical shape.
      throw new EtnError(
        mapHttpStatus(res.status),
        `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      );
    }

    // Success envelope: either `{ data, meta }` (single) or `{ data: [...], meta }`
    // (list). Both expose `data`; `meta` is captured on the instance.
    const env = payload as ApiSuccess<T> | ApiList<unknown> | undefined;
    if (env && typeof env === 'object' && 'data' in env) {
      this.lastMeta = (env as ApiSuccess<T>).meta;
      return (env as ApiSuccess<T>).data;
    }

    // Unexpected success shape (e.g. plain primitive) — return as-is.
    this.lastMeta = undefined;
    return payload as T;
  }

  /** Builds the final URL with query string. Array values are repeated. */
  private buildUrl(path: string, query?: QueryRecord): string {
    const url = `${this.baseUrl}/api/v1${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, raw] of Object.entries(query)) {
      if (raw === undefined || raw === null) continue;
      if (Array.isArray(raw)) {
        for (const v of raw) {
          if (v !== undefined && v !== null) params.append(key, String(v));
        }
      } else {
        params.append(key, String(raw));
      }
    }
    const qs = params.toString();
    return qs.length > 0 ? `${url}?${qs}` : url;
  }

  /** Exponential backoff with full jitter (0 .. base*2^(attempt-1)), capped. */
  private async backoff(attempt: number): Promise<void> {
    const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    const delay = Math.floor(this.random() * ceiling);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  // -------------------------------------------------------------------------
  // §3 Authentication & current user
  // -------------------------------------------------------------------------

  /** `GET /me` — verify the key, fetch the current user. */
  public async getMe(): Promise<import('@etn/shared').CurrentUser> {
    return this.request('GET', '/me');
  }

  /** `GET /me/keys` — list own API-keys (prefix only). */
  public async listMyKeys(): Promise<import('@etn/shared').ApiKey[]> {
    return this.request('GET', '/me/keys');
  }

  /** `POST /me/keys` — create a key; the full secret is returned exactly once. */
  public async createMyKey(
    input: import('@etn/shared').CreateApiKeyInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').ApiKeyWithSecret> {
    return this.request('POST', '/me/keys', { body: input, requestOptions: opts });
  }

  /** `DELETE /me/keys/{id}` — revoke an own key. */
  public async deleteMyKey(id: string, opts?: RequestOptions): Promise<void> {
    await this.request('DELETE', `/me/keys/${encodeURIComponent(id)}`, { requestOptions: opts });
  }

  // -------------------------------------------------------------------------
  // §4 Admin: users
  // -------------------------------------------------------------------------

  /** `GET /admin/users`. */
  public async adminListUsers(): Promise<import('@etn/shared').User[]> {
    return this.request('GET', '/admin/users');
  }

  /** `POST /admin/users` — create a user (admin); a key is generated for hand-off. */
  public async adminCreateUser(
    input: import('@etn/shared').CreateUserInput,
    opts?: RequestOptions,
  ): Promise<{ user: import('@etn/shared').User; key: import('@etn/shared').ApiKeyWithSecret }> {
    return this.request('POST', '/admin/users', { body: input, requestOptions: opts });
  }

  /** `GET /admin/users/{id}`. */
  public async adminGetUser(id: string): Promise<import('@etn/shared').User> {
    return this.request('GET', `/admin/users/${encodeURIComponent(id)}`);
  }

  /** `PATCH /admin/users/{id}`. */
  public async adminUpdateUser(
    id: string,
    input: import('@etn/shared').UpdateUserInput,
    expectedVersion: number,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').User> {
    return this.request('PATCH', `/admin/users/${encodeURIComponent(id)}`, {
      body: input,
      requestOptions: { ...opts, expectedVersion },
    });
  }

  /** `DELETE /admin/users/{id}` — protected for the first user (422). */
  public async adminDeleteUser(
    id: string,
    expectedVersion: number,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request('DELETE', `/admin/users/${encodeURIComponent(id)}`, {
      requestOptions: { ...opts, expectedVersion },
    });
  }

  /** `POST /admin/users/{id}/keys` — generate a transferable key for a user. */
  public async adminCreateUserKey(
    id: string,
    input: import('@etn/shared').CreateApiKeyInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').ApiKeyWithSecret> {
    return this.request('POST', `/admin/users/${encodeURIComponent(id)}/keys`, {
      body: input,
      requestOptions: opts,
    });
  }

  /** `DELETE /admin/users/{id}/keys/{keyId}`. */
  public async adminDeleteUserKey(id: string, keyId: string, opts?: RequestOptions): Promise<void> {
    await this.request(
      'DELETE',
      `/admin/users/${encodeURIComponent(id)}/keys/${encodeURIComponent(keyId)}`,
      { requestOptions: opts },
    );
  }

  // -------------------------------------------------------------------------
  // §4.2 Admin: networks & audit
  // -------------------------------------------------------------------------

  /** `GET /admin/networks` — all networks (admin). */
  public async adminListNetworks(): Promise<import('@etn/shared').Network[]> {
    return this.request('GET', '/admin/networks');
  }

  /** `DELETE /admin/networks/{id}` — force-delete a network. */
  public async adminDeleteNetwork(id: string, opts?: RequestOptions): Promise<void> {
    await this.request('DELETE', `/admin/networks/${encodeURIComponent(id)}`, {
      requestOptions: opts,
    });
  }

  /** `GET /admin/audit` — query the audit log (admin). */
  public async adminListAudit(
    query?: import('@etn/shared').AuditQuery,
  ): Promise<{ entries: import('@etn/shared').AuditLogEntry[]; total: number }> {
    const q: QueryRecord = {};
    if (query) {
      if (query.actor !== undefined) q['actor'] = query.actor;
      if (query.network !== undefined) q['network'] = query.network;
      if (query.category !== undefined) q['category'] = query.category;
      if (query.from !== undefined) q['from'] = query.from;
      if (query.to !== undefined) q['to'] = query.to;
      if (query.limit !== undefined) q['limit'] = query.limit;
      if (query.offset !== undefined) q['offset'] = query.offset;
    }
    return this.request('GET', '/admin/audit', { query: Object.keys(q).length ? q : undefined });
  }

  // -------------------------------------------------------------------------
  // §5 Networks
  // -------------------------------------------------------------------------

  /** `GET /networks` — networks the user can see. */
  public async listNetworks(): Promise<import('@etn/shared').NetworkListItem[]> {
    return this.request('GET', '/networks');
  }

  /** `POST /networks` — create a network; caller becomes owner, HOME created. */
  public async createNetwork(
    input: import('@etn/shared').CreateNetworkInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Network> {
    return this.request('POST', '/networks', { body: input, requestOptions: opts });
  }

  /** `GET /networks/{id}`. */
  public async getNetwork(id: string): Promise<import('@etn/shared').Network> {
    return this.request('GET', `/networks/${encodeURIComponent(id)}`);
  }

  /** `PATCH /networks/{id}` — owner-only metadata change. */
  public async updateNetwork(
    id: string,
    input: import('@etn/shared').UpdateNetworkInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Network> {
    return this.request('PATCH', `/networks/${encodeURIComponent(id)}`, {
      body: input,
      requestOptions: opts,
    });
  }

  /** `GET /networks/{id}/members`. */
  public async listMembers(id: string): Promise<import('@etn/shared').NetworkMember[]> {
    return this.request('GET', `/networks/${encodeURIComponent(id)}/members`);
  }

  /** `POST /networks/{id}/members` — add a member. */
  public async addMember(
    id: string,
    input: import('@etn/shared').AddMemberInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').NetworkMember> {
    return this.request('POST', `/networks/${encodeURIComponent(id)}/members`, {
      body: input,
      requestOptions: opts,
    });
  }

  /** `PATCH /networks/{id}/members/{uid}` — role change / ownership transfer. */
  public async updateMember(
    id: string,
    userId: string,
    input: import('@etn/shared').UpdateMemberInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').NetworkMember> {
    return this.request(
      'PATCH',
      `/networks/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      { body: input, requestOptions: opts },
    );
  }

  /** `DELETE /networks/{id}/members/{uid}` — remove a member. */
  public async removeMember(id: string, userId: string, opts?: RequestOptions): Promise<void> {
    await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
      { requestOptions: opts },
    );
  }

  /** `GET /networks/{id}/preferences` — all user preference keys for the network. */
  public async getPreferences(id: string): Promise<import('@etn/shared').UserPreferenceEntry[]> {
    return this.request('GET', `/networks/${encodeURIComponent(id)}/preferences`);
  }

  /** `PUT /networks/{id}/preferences/{key}`. */
  public async setPreference(
    id: string,
    key: string,
    value: unknown,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').UserPreferenceEntry> {
    return this.request(
      'PUT',
      `/networks/${encodeURIComponent(id)}/preferences/${encodeURIComponent(key)}`,
      {
        body: { value },
        requestOptions: opts,
      },
    );
  }

  // -------------------------------------------------------------------------
  // §6 Thoughts
  // -------------------------------------------------------------------------

  /** `GET /networks/{nid}/thoughts/{id}`. */
  public async getThought(networkId: string, id: string): Promise<import('@etn/shared').Thought> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(id)}`,
    );
  }

  /** `POST /networks/{nid}/thoughts/{id}/focus` — record view + fetch neighbours. */
  public async focusThought(
    networkId: string,
    id: string,
  ): Promise<import('@etn/shared').FocusResponse> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(id)}/focus`,
    );
  }

  /** `POST /networks/{nid}/thoughts` — create a thought (optionally with a link). */
  public async createThought(
    networkId: string,
    input: import('@etn/shared').ThoughtCreateInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Thought> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/thoughts`, {
      body: input,
      requestOptions: opts,
    });
  }

  /** `PATCH /networks/{nid}/thoughts/{id}` — `If-Match` is required. */
  public async updateThought(
    networkId: string,
    id: string,
    input: import('@etn/shared').ThoughtUpdateInput,
    expectedVersion: number,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Thought> {
    return this.request(
      'PATCH',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(id)}`,
      { body: input, requestOptions: { ...opts, expectedVersion } },
    );
  }

  /** `DELETE /networks/{nid}/thoughts/{id}` — `If-Match` is required; HOME → 422. */
  public async deleteThought(
    networkId: string,
    id: string,
    expectedVersion: number,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(id)}`,
      { requestOptions: { ...opts, expectedVersion } },
    );
  }

  /** `GET /networks/{nid}/thoughts/{id}/neighbors`. */
  public async getNeighbors(
    networkId: string,
    id: string,
    query?: {
      dir?: import('@etn/shared').FocusDir;
      sort?: import('@etn/shared').SortKind;
      order?: import('@etn/shared').SortOrder;
      limit?: number;
      offset?: number;
      type_id?: string[];
    },
  ): Promise<import('@etn/shared').FocusNeighbor[]> {
    const q: QueryRecord = {};
    if (query) {
      if (query.dir !== undefined) q['dir'] = query.dir;
      if (query.sort !== undefined) q['sort'] = query.sort;
      if (query.order !== undefined) q['order'] = query.order;
      if (query.limit !== undefined) q['limit'] = query.limit;
      if (query.offset !== undefined) q['offset'] = query.offset;
      if (query.type_id !== undefined) q['type_id'] = query.type_id;
    }
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(id)}/neighbors`,
      { query: Object.keys(q).length ? q : undefined },
    );
  }

  /** `POST /networks/{nid}/thoughts/batch`. */
  public async batchThoughts(
    networkId: string,
    input: import('@etn/shared').ThoughtBatchInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').ThoughtBatchResult> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/thoughts/batch`, {
      body: input,
      requestOptions: opts,
    });
  }

  /** `POST /networks/{nid}/thoughts/resolve` — lightweight metadata for ≤100 ids. */
  public async resolveThoughts(
    networkId: string,
    ids: string[],
  ): Promise<import('@etn/shared').ThoughtRef[]> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/thoughts/resolve`, {
      body: { ids },
    });
  }

  /** `PUT /networks/{nid}/thoughts/{fid}/focus-preferences`. */
  public async setFocusPreferences(
    networkId: string,
    focusId: string,
    input: import('@etn/shared').FocusPreferencesInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').UserFocusPreferences> {
    return this.request(
      'PUT',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(focusId)}/focus-preferences`,
      { body: input, requestOptions: opts },
    );
  }

  /** `POST /networks/{nid}/thoughts/{fid}/focus-order`. */
  public async setFocusOrder(
    networkId: string,
    focusId: string,
    input: import('@etn/shared').FocusOrderInput,
    opts?: RequestOptions,
  ): Promise<{ focus_thought_id: string; dir: string; ordered_ids: string[] }> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(focusId)}/focus-order`,
      { body: input, requestOptions: opts },
    );
  }

  // -------------------------------------------------------------------------
  // §7 Links
  // -------------------------------------------------------------------------

  /** `POST /networks/{nid}/links`. */
  public async createLink(
    networkId: string,
    input: import('@etn/shared').LinkCreateInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Link> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/links`, {
      body: input,
      requestOptions: opts,
    });
  }

  /** `GET /networks/{nid}/links/{id}`. */
  public async getLink(networkId: string, id: string): Promise<import('@etn/shared').Link> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/links/${encodeURIComponent(id)}`,
    );
  }

  /** `PATCH /networks/{nid}/links/{id}` — `If-Match` required. */
  public async updateLink(
    networkId: string,
    id: string,
    input: import('@etn/shared').LinkUpdateInput,
    expectedVersion: number,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Link> {
    return this.request(
      'PATCH',
      `/networks/${encodeURIComponent(networkId)}/links/${encodeURIComponent(id)}`,
      { body: input, requestOptions: { ...opts, expectedVersion } },
    );
  }

  /** `DELETE /networks/{nid}/links/{id}` — `If-Match` required. */
  public async deleteLink(
    networkId: string,
    id: string,
    expectedVersion: number,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/links/${encodeURIComponent(id)}`,
      { requestOptions: { ...opts, expectedVersion } },
    );
  }

  /** `GET /networks/{nid}/thoughts/{id}/links?group=type` — grouped editor view. */
  public async listLinksByThought(
    networkId: string,
    thoughtId: string,
    showInactive?: boolean,
  ): Promise<import('@etn/shared').ThoughtLinksGrouped> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/links`,
      {
        query: {
          group: 'type',
          ...(showInactive === undefined ? {} : { show_inactive: showInactive }),
        },
      },
    );
  }

  // -------------------------------------------------------------------------
  // §8 Types (thought / link) + property definitions
  // -------------------------------------------------------------------------

  /** `GET /networks/{nid}/thought-types`. */
  public async listThoughtTypes(networkId: string): Promise<import('@etn/shared').ThoughtType[]> {
    return this.request('GET', `/networks/${encodeURIComponent(networkId)}/thought-types`);
  }

  /** `POST /networks/{nid}/thought-types`. */
  public async createThoughtType(
    networkId: string,
    input: import('@etn/shared').ThoughtTypeInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').ThoughtType> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/thought-types`, {
      body: input,
      requestOptions: opts,
    });
  }

  /** `PATCH /networks/{nid}/thought-types/{id}` — `If-Match` required. */
  public async updateThoughtType(
    networkId: string,
    id: string,
    input: import('@etn/shared').ThoughtTypeUpdateInput,
    expectedVersion: number,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').ThoughtType> {
    return this.request(
      'PATCH',
      `/networks/${encodeURIComponent(networkId)}/thought-types/${encodeURIComponent(id)}`,
      { body: input, requestOptions: { ...opts, expectedVersion } },
    );
  }

  /** `DELETE /networks/{nid}/thought-types/{id}` — `If-Match` required, `?force=1`. */
  public async deleteThoughtType(
    networkId: string,
    id: string,
    expectedVersion: number,
    opts?: { force?: boolean } & RequestOptions,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/thought-types/${encodeURIComponent(id)}`,
      { query: opts?.force ? { force: '1' } : undefined, requestOptions: opts },
    );
  }

  /** `GET /networks/{nid}/link-types`. */
  public async listLinkTypes(networkId: string): Promise<import('@etn/shared').LinkType[]> {
    return this.request('GET', `/networks/${encodeURIComponent(networkId)}/link-types`);
  }

  /** `POST /networks/{nid}/link-types`. */
  public async createLinkType(
    networkId: string,
    input: import('@etn/shared').LinkTypeInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').LinkType> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/link-types`, {
      body: input,
      requestOptions: opts,
    });
  }

  /** `PATCH /networks/{nid}/link-types/{id}` — `If-Match` required. */
  public async updateLinkType(
    networkId: string,
    id: string,
    input: import('@etn/shared').LinkTypeUpdateInput,
    expectedVersion: number,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').LinkType> {
    return this.request(
      'PATCH',
      `/networks/${encodeURIComponent(networkId)}/link-types/${encodeURIComponent(id)}`,
      { body: input, requestOptions: { ...opts, expectedVersion } },
    );
  }

  /** `DELETE /networks/{nid}/link-types/{id}` — `If-Match` required, `?force=1`. */
  public async deleteLinkType(
    networkId: string,
    id: string,
    expectedVersion: number,
    opts?: { force?: boolean } & RequestOptions,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/link-types/${encodeURIComponent(id)}`,
      { query: opts?.force ? { force: '1' } : undefined, requestOptions: opts },
    );
  }

  /** URL path of a type-kind collection (`thought-types` / `link-types`). */
  private static typeCollectionPath(networkId: string, ownerType: TypeOwnerType): string {
    const kind = ownerType === 'thought_type' ? 'thought-types' : 'link-types';
    return `/networks/${encodeURIComponent(networkId)}/${kind}`;
  }

  /** `GET /networks/{nid}/{kind}-types/{id}/properties` — effective (L21)
   *  definitions: the type's own plus inherited from ancestors. */
  public async listTypeProperties(
    networkId: string,
    ownerType: TypeOwnerType,
    typeId: string,
  ): Promise<import('@etn/shared').EffectiveTypeProperty[]> {
    return this.request(
      'GET',
      `${RestClient.typeCollectionPath(networkId, ownerType)}/${encodeURIComponent(typeId)}/properties`,
    );
  }

  /** `POST /networks/{nid}/{kind}-types/{id}/properties` — create a definition. */
  public async createTypeProperty(
    networkId: string,
    ownerType: TypeOwnerType,
    typeId: string,
    input: import('@etn/shared').PropertyDefinitionInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').PropertyDefinition> {
    return this.request(
      'POST',
      `${RestClient.typeCollectionPath(networkId, ownerType)}/${encodeURIComponent(typeId)}/properties`,
      { body: input, requestOptions: opts },
    );
  }

  /** `PATCH …/types/{id}/properties/{propId}` — update a definition. */
  public async updateTypeProperty(
    networkId: string,
    ownerType: TypeOwnerType,
    typeId: string,
    propertyId: string,
    input: import('@etn/shared').PropertyDefinitionUpdateInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').PropertyDefinition> {
    return this.request(
      'PATCH',
      `${RestClient.typeCollectionPath(networkId, ownerType)}/${encodeURIComponent(typeId)}/properties/${encodeURIComponent(propertyId)}`,
      { body: input, requestOptions: opts },
    );
  }

  /** `DELETE …/types/{id}/properties/{propId}` — delete a definition (+values). */
  public async deleteTypeProperty(
    networkId: string,
    ownerType: TypeOwnerType,
    typeId: string,
    propertyId: string,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `${RestClient.typeCollectionPath(networkId, ownerType)}/${encodeURIComponent(typeId)}/properties/${encodeURIComponent(propertyId)}`,
      { requestOptions: opts },
    );
  }

  /** `PUT …/types/{id}/properties/reorder` — assign positions by id order. */
  public async reorderTypeProperties(
    networkId: string,
    ownerType: TypeOwnerType,
    typeId: string,
    orderedIds: string[],
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').PropertyDefinition[]> {
    return this.request(
      'PUT',
      `${RestClient.typeCollectionPath(networkId, ownerType)}/${encodeURIComponent(typeId)}/properties/reorder`,
      { body: { ordered_ids: orderedIds }, requestOptions: opts },
    );
  }

  /** `PUT …/types/{id}/properties/{propId}/default` — L21: set (`value`) or
   *  clear (`null`) a type's default-value override of an inherited property. */
  public async setTypePropertyDefaultOverride(
    networkId: string,
    ownerType: TypeOwnerType,
    typeId: string,
    propertyId: string,
    value: string | number | boolean | null,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      'PUT',
      `${RestClient.typeCollectionPath(networkId, ownerType)}/${encodeURIComponent(typeId)}/properties/${encodeURIComponent(propertyId)}/default`,
      { body: { value }, requestOptions: opts },
    );
  }

  // -------------------------------------------------------------------------
  // §9 Properties (values)
  // -------------------------------------------------------------------------

  /** `GET /networks/{nid}/thoughts/{id}/properties`. */
  public async listThoughtProperties(
    networkId: string,
    thoughtId: string,
  ): Promise<import('@etn/shared').PropertyValue[]> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/properties`,
    );
  }

  /** `PUT /networks/{nid}/thoughts/{id}/properties/{key}`. */
  public async setThoughtProperty(
    networkId: string,
    thoughtId: string,
    key: string,
    value: import('@etn/shared').PropertyValueValue,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').PropertyValue> {
    return this.request(
      'PUT',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/properties/${encodeURIComponent(key)}`,
      { body: { value }, requestOptions: opts },
    );
  }

  /** `DELETE /networks/{nid}/thoughts/{id}/properties/{key}`. */
  public async deleteThoughtProperty(
    networkId: string,
    thoughtId: string,
    key: string,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/properties/${encodeURIComponent(key)}`,
      { requestOptions: opts },
    );
  }

  /** `GET /networks/{nid}/links/{id}/properties`. */
  public async listLinkProperties(
    networkId: string,
    linkId: string,
  ): Promise<import('@etn/shared').PropertyValue[]> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/links/${encodeURIComponent(linkId)}/properties`,
    );
  }

  /** `PUT /networks/{nid}/links/{id}/properties/{key}`. */
  public async setLinkProperty(
    networkId: string,
    linkId: string,
    key: string,
    value: import('@etn/shared').PropertyValueValue,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').PropertyValue> {
    return this.request(
      'PUT',
      `/networks/${encodeURIComponent(networkId)}/links/${encodeURIComponent(linkId)}/properties/${encodeURIComponent(key)}`,
      { body: { value }, requestOptions: opts },
    );
  }

  /** `DELETE /networks/{nid}/links/{id}/properties/{key}`. */
  public async deleteLinkProperty(
    networkId: string,
    linkId: string,
    key: string,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/links/${encodeURIComponent(linkId)}/properties/${encodeURIComponent(key)}`,
      { requestOptions: opts },
    );
  }

  // -------------------------------------------------------------------------
  // §10 Comments
  // -------------------------------------------------------------------------

  /** `GET /networks/{nid}/thoughts/{id}/comments`. */
  public async listThoughtComments(
    networkId: string,
    thoughtId: string,
  ): Promise<import('@etn/shared').Comment[]> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/comments`,
    );
  }

  /** `POST /networks/{nid}/thoughts/{id}/comments`. */
  public async createThoughtComment(
    networkId: string,
    thoughtId: string,
    input: import('@etn/shared').CommentInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Comment> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/comments`,
      { body: input, requestOptions: opts },
    );
  }

  /** `GET /networks/{nid}/links/{id}/comments`. */
  public async listLinkComments(
    networkId: string,
    linkId: string,
  ): Promise<import('@etn/shared').Comment[]> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/links/${encodeURIComponent(linkId)}/comments`,
    );
  }

  /** `POST /networks/{nid}/links/{id}/comments`. */
  public async createLinkComment(
    networkId: string,
    linkId: string,
    input: import('@etn/shared').CommentInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Comment> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/links/${encodeURIComponent(linkId)}/comments`,
      { body: input, requestOptions: opts },
    );
  }

  /** `PATCH /networks/{nid}/comments/{id}` — `If-Match` required. */
  public async updateComment(
    networkId: string,
    id: string,
    input: import('@etn/shared').CommentUpdateInput,
    expectedVersion: number,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Comment> {
    return this.request(
      'PATCH',
      `/networks/${encodeURIComponent(networkId)}/comments/${encodeURIComponent(id)}`,
      {
        body: input,
        requestOptions: { ...opts, expectedVersion },
      },
    );
  }

  /** `DELETE /networks/{nid}/comments/{id}` — `If-Match` required. */
  public async deleteComment(
    networkId: string,
    id: string,
    expectedVersion: number,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/comments/${encodeURIComponent(id)}`,
      { requestOptions: { ...opts, expectedVersion } },
    );
  }

  /** `GET /networks/{nid}/comments/{id}` — one comment with all its targets (L20). */
  public async getComment(
    networkId: string,
    id: string,
  ): Promise<import('@etn/shared').Comment> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/comments/${encodeURIComponent(id)}`,
    );
  }

  /** `POST /networks/{nid}/comments` — create attached to 1..N targets (L20). */
  public async createCommentWithTargets(
    networkId: string,
    input: import('@etn/shared').CommentInputWithTargets,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Comment> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/comments`,
      { body: input, requestOptions: opts },
    );
  }

  /** `POST /networks/{nid}/comments/{id}/targets` — attach one more owner (L20). */
  public async addCommentTarget(
    networkId: string,
    id: string,
    ownerType: 'thought' | 'link',
    ownerId: string,
    expectedVersion?: number,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Comment> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/comments/${encodeURIComponent(id)}/targets`,
      {
        body: { owner_type: ownerType, owner_id: ownerId },
        requestOptions: { ...opts, expectedVersion },
      },
    );
  }

  /** `DELETE /networks/{nid}/comments/{id}/targets/{ownerType}/{ownerId}` (L20). */
  public async removeCommentTarget(
    networkId: string,
    id: string,
    ownerType: 'thought' | 'link',
    ownerId: string,
    expectedVersion?: number,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Comment> {
    return this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/comments/${encodeURIComponent(id)}/targets/${ownerType}/${encodeURIComponent(ownerId)}`,
      { requestOptions: { ...opts, expectedVersion } },
    );
  }

  // -------------------------------------------------------------------------
  // §11 Attachments
  // -------------------------------------------------------------------------

  /** `GET /networks/{nid}/thoughts/{id}/attachments`. */
  public async listThoughtAttachments(
    networkId: string,
    thoughtId: string,
  ): Promise<import('@etn/shared').Attachment[]> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/attachments`,
    );
  }

  /** `POST /networks/{nid}/thoughts/{id}/attachments`. */
  public async createThoughtAttachment(
    networkId: string,
    thoughtId: string,
    input: import('@etn/shared').AttachmentInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Attachment> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/attachments`,
      { body: input, requestOptions: opts },
    );
  }

  /** `GET /networks/{nid}/links/{id}/attachments`. */
  public async listLinkAttachments(
    networkId: string,
    linkId: string,
  ): Promise<import('@etn/shared').Attachment[]> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/links/${encodeURIComponent(linkId)}/attachments`,
    );
  }

  /** `POST /networks/{nid}/thoughts/{id}/attachments/file`. */
  public async uploadThoughtAttachmentFile(
    networkId: string,
    thoughtId: string,
    input: import('@etn/shared').AttachmentFileInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Attachment> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/attachments/file`,
      { body: input, requestOptions: opts },
    );
  }

  /** `POST /networks/{nid}/links/{id}/attachments/file`. */
  public async uploadLinkAttachmentFile(
    networkId: string,
    linkId: string,
    input: import('@etn/shared').AttachmentFileInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Attachment> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/links/${encodeURIComponent(linkId)}/attachments/file`,
      { body: input, requestOptions: opts },
    );
  }

  /** `POST /networks/{nid}/links/{id}/attachments`. */
  public async createLinkAttachment(
    networkId: string,
    linkId: string,
    input: import('@etn/shared').AttachmentInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Attachment> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/links/${encodeURIComponent(linkId)}/attachments`,
      { body: input, requestOptions: opts },
    );
  }

  /** `PATCH /networks/{nid}/attachments/{id}`. */
  public async updateAttachment(
    networkId: string,
    id: string,
    input: import('@etn/shared').AttachmentUpdateInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Attachment> {
    return this.request(
      'PATCH',
      `/networks/${encodeURIComponent(networkId)}/attachments/${encodeURIComponent(id)}`,
      {
        body: input,
        requestOptions: opts,
      },
    );
  }

  /** `DELETE /networks/{nid}/attachments/{id}`. */
  public async deleteAttachment(
    networkId: string,
    id: string,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/attachments/${encodeURIComponent(id)}`,
      { requestOptions: opts },
    );
  }

  /** `GET /networks/{nid}/attachments/{id}/content` — text content (L7). */
  public async getAttachmentContent(
    networkId: string,
    id: string,
  ): Promise<import('@etn/shared').AttachmentContent> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/attachments/${encodeURIComponent(id)}/content`,
    );
  }

  /** `PUT /networks/{nid}/attachments/{id}/content` — overwrite a text file (L7). */
  public async updateAttachmentContent(
    networkId: string,
    id: string,
    input: import('@etn/shared').AttachmentContentUpdateInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').AttachmentContentUpdateResult> {
    return this.request(
      'PUT',
      `/networks/${encodeURIComponent(networkId)}/attachments/${encodeURIComponent(id)}/content`,
      { body: input, requestOptions: opts },
    );
  }

  /**
   * `POST /networks/{nid}/attachments/{id}/copy` — copy the attachment to one
   * or more target owners (workplan L25). Each target receives a new row with
   * the same visible fields; targets that already own the same attachment
   * (`same kind + same url/file_path`) are skipped silently and reported via
   * `skipped`.
   */
  public async copyAttachment(
    networkId: string,
    attachmentId: string,
    input: import('@etn/shared').AttachmentCopyInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').AttachmentCopyResult> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/attachments/${encodeURIComponent(attachmentId)}/copy`,
      { body: input, requestOptions: opts },
    );
  }

  /**
   * `GET /networks/{nid}/attachments?q=…&exclude_owner_*=…&kind=…&limit=&offset=`
   * — network-wide attachment search (workplan L25). Used by the editor's
   * "Найти существующее" tab to suggest rows the user can reuse instead of
   * uploading a fresh copy.
   */
  public async searchAttachments(
    networkId: string,
    query: import('@etn/shared').AttachmentSearchQuery,
  ): Promise<import('@etn/shared').Attachment[]> {
    const q: QueryRecord = { q: query.q };
    if (query.kind !== undefined) q['kind'] = query.kind;
    if (query.exclude_owner_type !== undefined) q['exclude_owner_type'] = query.exclude_owner_type;
    if (query.exclude_owner_id !== undefined) q['exclude_owner_id'] = query.exclude_owner_id;
    if (query.limit !== undefined) q['limit'] = query.limit;
    if (query.offset !== undefined) q['offset'] = query.offset;
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/attachments`,
      { query: q },
    );
  }

  // -------------------------------------------------------------------------
  // §12–13 Search & mentions
  // -------------------------------------------------------------------------

  /** `GET /networks/{nid}/search`. */
  public async searchThoughts(
    networkId: string,
    request: import('@etn/shared').SearchRequest,
  ): Promise<import('@etn/shared').SearchResponse> {
    const q: QueryRecord = { q: request.q };
    if (request.in !== undefined) q['in'] = request.in;
    if (request.from_thought_id !== undefined) q['from_thought_id'] = request.from_thought_id;
    if (request.scope !== undefined) q['scope'] = request.scope;
    if (request.type_id !== undefined) q['type_id'] = request.type_id;
    if (request.link_type_id !== undefined) q['link_type_id'] = request.link_type_id;
    if (request.show_inactive !== undefined) q['show_inactive'] = request.show_inactive;
    if (request.limit !== undefined) q['limit'] = request.limit;
    if (request.offset !== undefined) q['offset'] = request.offset;
    return this.request('GET', `/networks/${encodeURIComponent(networkId)}/search`, { query: q });
  }

  /** `GET /networks/{nid}/thoughts/{id}/mentions`. */
  public async listMentions(
    networkId: string,
    thoughtId: string,
  ): Promise<import('@etn/shared').MentionHit[]> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/mentions`,
    );
  }

  /** `POST /networks/{nid}/mentions/scan` — thought mentions in text (§21, L24). */
  public async mentionsScan(
    networkId: string,
    request: import('@etn/shared').MentionsScanRequest,
  ): Promise<import('@etn/shared').MentionsScanResponse> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/mentions/scan`, {
      body: request,
    });
  }

  /** `GET /networks/{nid}/thoughts/{id}/usage` — reverse thought_ref lookup (L7). */
  public async getThoughtUsage(
    networkId: string,
    thoughtId: string,
  ): Promise<import('@etn/shared').ThoughtUsage> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/usage`,
    );
  }

  /**
   * `GET /networks/{nid}/thoughts/duplicates` — live duplicate lookup powering
   * the add-thought dialog (H14, docs/03-server-api.md §6.3, 08-ui-spec.md §4.4)
   * and the thought_ref property pickers (`type_ids` filter).
   */
  public async findDuplicates(
    networkId: string,
    title: string,
    synonyms: string[] = [],
    typeIds: string[] = [],
  ): Promise<DuplicateCandidate[]> {
    const q: QueryRecord = { title };
    if (synonyms.length > 0) q['synonyms'] = synonyms;
    if (typeIds.length > 0) q['type_ids'] = typeIds;
    return this.request('GET', `/networks/${encodeURIComponent(networkId)}/thoughts/duplicates`, {
      query: q,
    });
  }

  // -------------------------------------------------------------------------
  // §6.10/§6.11/§18 Structures view (L15)
  // -------------------------------------------------------------------------

  /**
   * `POST /networks/{nid}/thoughts/query` — filter thoughts for the structures
   * view. Returns the page items, the unrestricted `total` and the direction
   * flags of the page from the list envelope meta (read via {@link lastMeta},
   * same call).
   */
  public async queryStructureThoughts(
    networkId: string,
    request: import('@etn/shared').StructureQueryRequest,
  ): Promise<import('@etn/shared').StructureQueryResponse> {
    const items = await this.request<import('@etn/shared').ThoughtRef[]>(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/thoughts/query`,
      { body: request },
    );
    const meta = this.lastMeta as
      | { total?: number; directions?: import('@etn/shared').StructureDirectionFlags }
      | undefined;
    const total = typeof meta?.total === 'number' ? meta.total : items.length;
    return { items, total, directions: meta?.directions ?? {} };
  }

  /**
   * `POST /networks/{nid}/thoughts/query` with `ids_only: true` — bare ids of
   * the whole filter result for the bulk structures commands (L22,
   * 03-server-api.md §6.10). The limit ceiling is higher than the paged tree.
   */
  public async queryStructureThoughtIds(
    networkId: string,
    request: import('@etn/shared').StructureQueryRequest,
  ): Promise<import('@etn/shared').StructureIdsQueryResponse> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/thoughts/query`,
      { body: { ...request, ids_only: true } },
    );
  }

  /**
   * `GET /networks/{nid}/thoughts/{id}/hierarchy` — one-level parents/children
   * for the structures tree. `excludeIds` implements the per-branch dedup
   * (03-server-api.md §6.11), sent comma-separated.
   */
  public async getHierarchy(
    networkId: string,
    thoughtId: string,
    query: {
      dir: 'parents' | 'children';
      showInactive?: boolean;
      excludeIds?: string[];
      offset?: number;
    },
  ): Promise<import('@etn/shared').HierarchyResponse> {
    const q: QueryRecord = { dir: query.dir };
    if (query.showInactive !== undefined) q['show_inactive'] = query.showInactive;
    if (query.excludeIds !== undefined && query.excludeIds.length > 0) {
      q['exclude_ids'] = query.excludeIds.join(',');
    }
    if (query.offset !== undefined && query.offset > 0) q['offset'] = query.offset;
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/hierarchy`,
      { query: q },
    );
  }

  /**
   * `POST /networks/{nid}/thoughts/edges` — every active link between the
   * given visible thoughts (03-server-api.md §6.12), for drawing the
   * structures tree links from ellipse to ellipse.
   */
  public async postStructureEdges(
    networkId: string,
    ids: string[],
    showInactive: boolean,
  ): Promise<import('@etn/shared').FocusEdge[]> {
    const data = await this.request<{ edges: import('@etn/shared').FocusEdge[] }>(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/thoughts/edges`,
      { body: { ids, show_inactive: showInactive } },
    );
    return data.edges;
  }

  /** `GET /networks/{nid}/saved-filters` — the user's own saved filters. */
  public async listSavedFilters(
    networkId: string,
  ): Promise<import('@etn/shared').SavedFilter[]> {
    return this.request('GET', `/networks/${encodeURIComponent(networkId)}/saved-filters`);
  }

  /** `POST /networks/{nid}/saved-filters` — create (idempotent). */
  public async createSavedFilter(
    networkId: string,
    input: { name: string; definition: import('@etn/shared').SavedFilterDefinition },
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').SavedFilter> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/saved-filters`, {
      body: input,
      requestOptions: opts,
    });
  }

  /** `PATCH /networks/{nid}/saved-filters/{fid}` — rename / redefine (idempotent). */
  public async updateSavedFilter(
    networkId: string,
    filterId: string,
    input: {
      name?: string;
      definition?: import('@etn/shared').SavedFilterDefinition;
    },
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').SavedFilter> {
    return this.request(
      'PATCH',
      `/networks/${encodeURIComponent(networkId)}/saved-filters/${encodeURIComponent(filterId)}`,
      { body: input, requestOptions: opts },
    );
  }

  /** `DELETE /networks/{nid}/saved-filters/{fid}` — delete (idempotent). */
  public async deleteSavedFilter(
    networkId: string,
    filterId: string,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/saved-filters/${encodeURIComponent(filterId)}`,
      { requestOptions: opts },
    );
  }

  // -------------------------------------------------------------------------
  // §20 Chronicle view (L20)
  // -------------------------------------------------------------------------

  /** `POST /networks/{nid}/chronicle/query` — two-phase chronological query. */
  public async queryChronicle(
    networkId: string,
    request: import('@etn/shared').ChronicleQueryRequest,
  ): Promise<import('@etn/shared').ChronicleQueryResponse> {
    const rows = await this.request<import('@etn/shared').ChronicleRow[]>(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/chronicle/query`,
      { body: request },
    );
    const meta = this.lastMeta as { total?: number } | undefined;
    const total = typeof meta?.total === 'number' ? meta.total : rows.length;
    return { rows, total };
  }

  /** `GET /networks/{nid}/saved-filters?view=chronicle` — the user's chronicle filters. */
  public async listChronicleFilters(
    networkId: string,
  ): Promise<import('@etn/shared').ChronicleSavedFilter[]> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/saved-filters`,
      { query: { view: 'chronicle' } },
    );
  }

  /** `POST /networks/{nid}/saved-filters` — create a chronicle filter (idempotent). */
  public async createChronicleFilter(
    networkId: string,
    input: { name: string; definition: import('@etn/shared').ChronicleFilterDefinition },
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').ChronicleSavedFilter> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/saved-filters`, {
      body: { view: 'chronicle', ...input },
      requestOptions: opts,
    });
  }

  /** `PATCH /networks/{nid}/saved-filters/{fid}` — rename/redefine (idempotent). */
  public async updateChronicleFilter(
    networkId: string,
    filterId: string,
    input: {
      name?: string;
      definition?: import('@etn/shared').ChronicleFilterDefinition;
    },
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').ChronicleSavedFilter> {
    return this.request(
      'PATCH',
      `/networks/${encodeURIComponent(networkId)}/saved-filters/${encodeURIComponent(filterId)}`,
      { body: { view: 'chronicle', ...input }, requestOptions: opts },
    );
  }

  /** `DELETE /networks/{nid}/saved-filters/{fid}` — delete (idempotent). */
  public async deleteChronicleFilter(
    networkId: string,
    filterId: string,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/saved-filters/${encodeURIComponent(filterId)}`,
      { requestOptions: opts },
    );
  }

  // -------------------------------------------------------------------------
  // §19 Pinned thoughts (L18)
  // -------------------------------------------------------------------------

  /** `GET /networks/{nid}/pins` — the user's pinned thoughts in position order. */
  public async listPinnedThoughts(
    networkId: string,
  ): Promise<import('@etn/shared').PinnedThoughtEntry[]> {
    return this.request('GET', `/networks/${encodeURIComponent(networkId)}/pins`);
  }

  /** `PUT /networks/{nid}/pins` — replace the pinned list (idempotent, ≤20). */
  public async setPinnedThoughts(
    networkId: string,
    orderedIds: string[],
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').PinnedThoughtEntry[]> {
    return this.request('PUT', `/networks/${encodeURIComponent(networkId)}/pins`, {
      body: { ordered_ids: orderedIds },
      requestOptions: opts,
    });
  }

  // -------------------------------------------------------------------------
  // §14 Export & jobs
  // -------------------------------------------------------------------------

  /** `POST /networks/{nid}/export` — async job (202). */
  public async exportThoughts(
    networkId: string,
    input: import('@etn/shared').ExportRequest,
    opts?: RequestOptions,
  ): Promise<{ job_id: string }> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/export`, {
      body: input,
      requestOptions: opts,
    });
  }

  /** `GET /jobs/{jobId}` — poll an export job. */
  public async getJob(jobId: string): Promise<import('@etn/shared').ExportJob> {
    return this.request('GET', `/jobs/${encodeURIComponent(jobId)}`);
  }

  // -------------------------------------------------------------------------
  // §16 System endpoints
  // -------------------------------------------------------------------------

  /** `GET /health` — not under `/api/v1` prefix. */
  public async getHealth(): Promise<import('@etn/shared').HealthResponse> {
    // Health bypasses /api/v1; hit the root path directly with the same engine but
    // without the prefix.
    return this.requestRaw('GET', '/health');
  }

  /** `GET /version` — not under `/api/v1` prefix; used for compatibility check. */
  public async getVersion(): Promise<import('@etn/shared').VersionResponse> {
    return this.requestRaw('GET', '/version');
  }

  /**
   * Variant of {@link request} that targets the server root (no `/api/v1` prefix
   * and no auth header — health/version are public). Used by {@link getHealth} and
   * {@link getVersion}.
   */
  private async requestRaw<T>(method: string, path: string): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: { Accept: 'application/json', 'Client-Id': this.getClientId() },
    });
    return (await this.parseResponse<T>(res)) as T;
  }
}

/**
 * Maps an unexpected HTTP status to the closest canonical {@link EtnErrorCode}.
 * Used only when the server response is not shaped as `{ error: EtnErrorBody }`.
 */
function mapHttpStatus(status: number): EtnErrorCode {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'DUPLICATE';
  if (status === 422) return 'VALIDATION_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  return 'INTERNAL';
}
