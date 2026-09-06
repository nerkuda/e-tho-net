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
import { randomUUID } from 'node:crypto';

import {
  EtnError,
  type ActivityRow,
  type ApiList,
  type ApiSuccess,
  type EtnErrorBody,
  type EtnErrorCode,
  type SystemLoggingStatus,
  type TypeOwnerType,
} from '@etn/shared';

import { getClientLog } from '../log/client-log.js';

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

  /**
   * In-flight plain GETs by final URL (see {@link request}): identical GETs
   * racing each other share one fetch. Cleared in a `finally` — completed
   * responses are never cached, so sequential identical GETs fetch again and
   * realtime freshness is preserved.
   */
  private readonly inflightGets = new Map<string, Promise<unknown>>();

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
   * Performs an HTTP request with auth, retry and error normalisation, plus
   * in-flight dedup of identical parallel GETs. Returns the parsed `data` of
   * the success envelope. Throws {@link EtnError} on any non-2xx response or
   * unrecoverable network failure.
   *
   * Dedup (GET only, no per-call options): two identical GETs issued while
   * the first still flies share one fetch and its result — e.g. on opening a
   * thought the editor fires `GET …/thought-types/{id}/properties` twice
   * concurrently (the group's count badge and the properties table both ask
   * for the same definitions). GETs carrying `requestOptions` (signal /
   * Client-Request-Id / If-Match) bypass the dedup — those carry per-caller
   * state that must not leak between callers. The dedup shares the response
   * promise only, so `lastMeta` (which no current GET caller reads) reflects
   * the single underlying call.
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
    if (method === 'GET' && opts.requestOptions === undefined) {
      const url = this.buildUrl(path, opts.query);
      const inflight = this.inflightGets.get(url);
      if (inflight !== undefined) return inflight as Promise<T>;
      const promise = this.performRequest<T>(method, path, opts).finally(() => {
        this.inflightGets.delete(url);
      });
      this.inflightGets.set(url, promise);
      return promise;
    }
    return this.performRequest<T>(method, path, opts);
  }

  /**
   * The request engine behind {@link request}: auth, retry, error
   * normalisation. Returns the parsed `data` of the success envelope.
   */
  private async performRequest<T>(
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

      // Journal instrumentation (task f051bf95 §3): every attempt is written
      // as INFO (flag-gated), retry scheduling and final failures — always.
      const attemptStarted = Date.now();
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
        getClientLog()?.info('rest', 'request attempt failed', {
          method,
          path,
          attempt,
          duration_ms: Date.now() - attemptStarted,
          error: errTextShort(err),
        });
        // Network-level failure (DNS, connection refused, timeout abort, etc.).
        // Retryable unless the caller aborted the request themselves.
        if (ro.signal?.aborted) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_ATTEMPTS) {
          await this.backoff(method, path, attempt, classifyRetryReason(lastError));
          continue;
        }
        const message = `Сетевая ошибка: ${lastError.message}`;
        getClientLog()?.error('rest', 'request failed', {
          method,
          path,
          attempts: attempt,
          reason: classifyRetryReason(lastError),
          error: message,
        });
        throw new EtnError('INTERNAL', message);
      }
      clearTimeout(timeout);

      // Retry transient server errors (5xx) once more.
      if (res.status >= 500 && res.status < 600 && attempt < MAX_ATTEMPTS) {
        lastError = new Error(`HTTP ${res.status}`);
        await this.backoff(method, path, attempt, `http_${res.status}`);
        continue;
      }

      getClientLog()?.info('rest', 'request completed', {
        method,
        path,
        attempt,
        duration_ms: Date.now() - attemptStarted,
        status: res.status,
      });
      return (await this.parseResponse<T>(res)) as T;
    }

    // Loop exited without returning — exhausted retries.
    const message = lastError
      ? `Превышен лимит повторов: ${lastError.message}`
      : 'Неизвестная ошибка запроса';
    getClientLog()?.error('rest', 'request failed', {
      method,
      path,
      attempts: MAX_ATTEMPTS,
      ...(lastError === undefined ? {} : { error: lastError.message }),
    });
    throw new EtnError('INTERNAL', message);
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

  /**
   * Exponential backoff with full jitter (0 .. base*2^(attempt-1)), capped.
   * Journals the pause (INFO, flag-gated) so a trace explains every gap
   * between attempts (task f051bf95 §3).
   */
  private async backoff(
    method: string,
    path: string,
    attempt: number,
    reason: string,
  ): Promise<void> {
    const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    const delay = Math.floor(this.random() * ceiling);
    getClientLog()?.info('rest', 'retry scheduled', {
      method,
      path,
      attempt,
      reason,
      backoff_ms: delay,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  // -------------------------------------------------------------------------
  // §3 Authentication & current user
  // -------------------------------------------------------------------------

  /** `GET /me` — verify the key, fetch the current user. */
  public async getMe(): Promise<import('@etn/shared').CurrentUser> {
    return this.request('GET', '/me');
  }

  /** `PATCH /me` — edit own profile (display_name only on the MVP). */
  public async updateMe(
    displayName: string | null,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').CurrentUser> {
    return this.request('PATCH', '/me', { body: { display_name: displayName }, requestOptions: opts });
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

  /** `GET /networks/{nid}/thoughts/{id}` — `?at_layer_id=<id>` открывает мысль в конкретном слое. */
  public async getThought(
    networkId: string,
    id: string,
    atLayerId?: string,
  ): Promise<import('@etn/shared').Thought> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(id)}`,
      atLayerId !== undefined ? { query: { at_layer_id: atLayerId } } : undefined,
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

  /**
   * `POST /networks/{nid}/thoughts/copy-batch` — paste a clipboard snapshot
   * under `parent_thought_id` (workplan L26). The whole batch runs in one
   * server transaction; the response carries the id-map the client may want
   * to remap references to. A fresh `Client-Request-Id` is generated per
   * call so the server's idempotency layer does not collapse retries of
   * different pastes.
   */
  public async copyThoughtsBatch(
    networkId: string,
    input: import('@etn/shared').ThoughtCopyInput,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').ThoughtCopyResult> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/thoughts/copy-batch`, {
      body: input,
      requestOptions: { ...opts, clientRequestId: opts?.clientRequestId ?? randomUUID() },
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

  /** `GET /networks/{nid}/links/{id}` — `?at_layer_id=<id>` открывает связь в конкретном слое. */
  public async getLink(
    networkId: string,
    id: string,
    atLayerId?: string,
  ): Promise<import('@etn/shared').Link> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/links/${encodeURIComponent(id)}`,
      atLayerId !== undefined ? { query: { at_layer_id: atLayerId } } : undefined,
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

  /** `GET /networks/{nid}/thought-types/counts` — own record count per type
   *  id (task «Улучшить диалог редактирования типов мыслей и связей»); the
   *  type-manager list sums a group type's total over its subtree itself. */
  public async getThoughtTypeCounts(networkId: string): Promise<Record<string, number>> {
    return this.request('GET', `/networks/${encodeURIComponent(networkId)}/thought-types/counts`);
  }

  /** `GET /networks/{nid}/thought-types/{id}` — один тип мысли (задача 59119797). */
  public async getThoughtType(networkId: string, id: string): Promise<import('@etn/shared').ThoughtType> {
    return this.request('GET', `/networks/${encodeURIComponent(networkId)}/thought-types/${encodeURIComponent(id)}`);
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

  /** `GET /networks/{nid}/link-types/counts` — the link-type analogue of
   *  {@link getThoughtTypeCounts}. */
  public async getLinkTypeCounts(networkId: string): Promise<Record<string, number>> {
    return this.request('GET', `/networks/${encodeURIComponent(networkId)}/link-types/counts`);
  }

  /** `GET /networks/{nid}/link-types/{id}` — один тип связи (задача 59119797). */
  public async getLinkType(networkId: string, id: string): Promise<import('@etn/shared').LinkType> {
    return this.request('GET', `/networks/${encodeURIComponent(networkId)}/link-types/${encodeURIComponent(id)}`);
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
    input: import('@etn/shared').AttachPropertyInput,
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

  /** `PUT …/types/{id}/properties/{propId}/description` — set (`description`)
   *  or clear (`null`) a type's description override of an inherited property. */
  public async setTypePropertyDescriptionOverride(
    networkId: string,
    ownerType: TypeOwnerType,
    typeId: string,
    propertyId: string,
    description: string | null,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      'PUT',
      `${RestClient.typeCollectionPath(networkId, ownerType)}/${encodeURIComponent(typeId)}/properties/${encodeURIComponent(propertyId)}/description`,
      { body: { description }, requestOptions: opts },
    );
  }

  // -------------------------------------------------------------------------
  // §8a Property registry (0.6.5)
  // -------------------------------------------------------------------------

  /**
   * `GET /networks/{nid}/properties` — registry list (one row per network
   * property; counter columns `types_count` / `values_count` ride along).
   * Used by the structures filter panel to populate the property picker
   * without walking every type (task 171a438e) and by the property manager
   * dialog (task d4e23670) as the main list source.
   */
  public async listNetworkProperties(
    networkId: string,
  ): Promise<Array<import('@etn/shared').NetworkProperty & { types_count: number; values_count: number }>> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/properties`,
    );
  }

  /** `GET /networks/{nid}/properties/{id}` — one property + counters. */
  public async getNetworkProperty(
    networkId: string,
    id: string,
  ): Promise<import('@etn/shared').NetworkProperty & { types_count: number; values_count: number }> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/properties/${encodeURIComponent(id)}`,
    );
  }

  /** `POST /networks/{nid}/properties` — create. */
  public async createNetworkProperty(
    networkId: string,
    input: import('@etn/shared').NetworkPropertyInput,
  ): Promise<import('@etn/shared').NetworkProperty> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/properties`, {
      body: input,
    });
  }

  /**
   * `PATCH /networks/{nid}/properties/{id}` — patch. The server returns
   * `{ ...property, converted, dropped }` so the manager can show how many
   * stored values were rewritten/dropped after a value-type conversion. The
   * registry does not currently participate in optimistic locking — single
   * client owns the row for the duration of the staged editor.
   */
  public async updateNetworkProperty(
    networkId: string,
    id: string,
    input: import('@etn/shared').NetworkPropertyUpdateInput,
  ): Promise<{
    property: import('@etn/shared').NetworkProperty;
    converted: number;
    dropped: number;
  }> {
    return this.request(
      'PATCH',
      `/networks/${encodeURIComponent(networkId)}/properties/${encodeURIComponent(id)}`,
      { body: input },
    );
  }

  /** `DELETE /networks/{nid}/properties/{id}` — refused with 409 when bound. */
  public async deleteNetworkProperty(
    networkId: string,
    id: string,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/properties/${encodeURIComponent(id)}`,
    );
  }

  /** `GET /networks/{nid}/properties/{id}/usage` — bindings + value counts. */
  public async getNetworkPropertyUsage(
    networkId: string,
    id: string,
  ): Promise<{
    property_id: string;
    name: string;
    value_type: import('@etn/shared').PropertyValueType;
    bindings: Array<{
      owner_type: 'thought_type' | 'link_type';
      owner_id: string;
      owner_name: string;
      required: boolean;
      values_in_type_count: number;
    }>;
    values_in_type_count: number;
    values_outside_type_count: number;
  }> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/properties/${encodeURIComponent(id)}/usage`,
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

  /** `GET /networks/{nid}/attachments/{id}` — одно вложение с владельцем (задача 59119797). */
  public async getAttachment(
    networkId: string,
    id: string,
  ): Promise<import('@etn/shared').Attachment> {
    return this.request('GET', `/networks/${encodeURIComponent(networkId)}/attachments/${encodeURIComponent(id)}`);
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
   * `GET /networks/{nid}/attachments/raw?path=…` — raw bytes of a server-stored
   * attachment file. Bypasses the JSON envelope path used by {@link request}
   * (the body is binary), like {@link downloadJob}. Used when the client's own
   * filesystem has no copy of the attachment path (remote-server setups).
   */
  public async getAttachmentRaw(
    networkId: string,
    filePath: string,
  ): Promise<{ contentType: string; body: Buffer }> {
    const url =
      `${this.baseUrl}/api/v1/networks/${encodeURIComponent(networkId)}` +
      `/attachments/raw?path=${encodeURIComponent(filePath)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.getApiKey()}`,
      'Client-Id': this.getClientId(),
      Accept: '*/*',
    };
    const res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new EtnError(
        mapHttpStatus(res.status),
        `attachment download failed: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      );
    }
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    return { contentType, body: Buffer.from(await res.arrayBuffer()) };
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
    if (request.trashed !== undefined) q['trashed'] = request.trashed;
    // Задача 59119797 «Фильтры Автор/Редактор»: query-параметры
    // `author_id`/`editor_id`. Пустая строка трактуется как «не применять»
    // (сервер сам проверяет `!== ''`).
    if (request.author_id !== undefined && request.author_id !== '') {
      q['author_id'] = request.author_id;
    }
    if (request.editor_id !== undefined && request.editor_id !== '') {
      q['editor_id'] = request.editor_id;
    }
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

  /**
   * `GET /networks/{nid}/thoughts/{id}/backlinks` — explicit ID-based wiki
   * references in `body_md` (task R3, docs/03-server-api.md §13a). Returns
   * the same `MentionHit[]` shape as `listMentions`.
   */
  public async listBacklinks(
    networkId: string,
    thoughtId: string,
  ): Promise<import('@etn/shared').MentionHit[]> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/backlinks`,
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

  // -------------------------------------------------------------------------
  // §6.5a/§9.2/§14b — deletion check, usage clear, trash (S13)
  // -------------------------------------------------------------------------

  /** `POST /networks/{nid}/thoughts/deletion-check-batch` (03-server-api.md §6.5a). */
  public async checkThoughtDeletion(
    networkId: string,
    ids: string[],
  ): Promise<Record<string, import('@etn/shared').ThoughtDeletionCheckResult>> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/thoughts/deletion-check-batch`,
      { body: { ids } },
    );
  }

  /** `POST /networks/{nid}/links/deletion-check-batch` (03-server-api.md §6.5a). */
  public async checkLinkDeletion(
    networkId: string,
    ids: string[],
  ): Promise<Record<string, import('@etn/shared').LinkDeletionCheckResult>> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/links/deletion-check-batch`,
      { body: { ids } },
    );
  }

  /** `POST /networks/{nid}/thoughts/{id}/usage/clear` (03-server-api.md §9.2). */
  public async clearThoughtUsage(
    networkId: string,
    thoughtId: string,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').UsageClearResult> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/thoughts/${encodeURIComponent(thoughtId)}/usage/clear`,
      { requestOptions: opts },
    );
  }

  /** `GET /networks/{nid}/trash` (03-server-api.md §14b). */
  public async listTrash(
    networkId: string,
  ): Promise<import('@etn/shared').TrashListResult> {
    return this.request('GET', `/networks/${encodeURIComponent(networkId)}/trash`);
  }

  /** `POST /networks/{nid}/trash/purge` (03-server-api.md §14b). */
  public async purgeTrash(
    networkId: string,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').TrashPurgeResult> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/trash/purge`, {
      requestOptions: opts,
    });
  }

  // -------------------------------------------------------------------------
  // Change layers (S11, docs/03-server-api.md §5a)
  // -------------------------------------------------------------------------

  /** `GET /networks/{nid}/layers` — layer list with hierarchy metadata. */
  public async listLayers(networkId: string): Promise<import('@etn/shared').Layer[]> {
    return this.request('GET', `/networks/${encodeURIComponent(networkId)}/layers`);
  }

  /** `POST /networks/{nid}/layers` — create a layer under a parent. */
  public async createLayer(
    networkId: string,
    input: {
      title: string;
      parent_id?: string;
      comment?: string | null;
      git_branch?: string | null;
      colors?: import('@etn/shared').LayerColors | null;
    },
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Layer> {
    return this.request('POST', `/networks/${encodeURIComponent(networkId)}/layers`, {
      body: input,
      requestOptions: opts,
    });
  }

  /** `PATCH /networks/{nid}/layers/{id}` — rename / edit the comment /
   *  replace the colour indication (full object or null, 0.6.4 §2.2a). */
  public async updateLayer(
    networkId: string,
    layerId: string,
    changes: {
      title?: string;
      comment?: string | null;
      colors?: import('@etn/shared').LayerColors | null;
    },
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').Layer> {
    return this.request(
      'PATCH',
      `/networks/${encodeURIComponent(networkId)}/layers/${encodeURIComponent(layerId)}`,
      { body: changes, requestOptions: opts },
    );
  }

  /** `DELETE /networks/{nid}/layers/{id}?cascade=N` — subtree delete (§2.4). */
  public async deleteLayer(
    networkId: string,
    layerId: string,
    cascade?: number,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').LayerDeleteResult> {
    const query = cascade !== undefined ? { cascade: String(cascade) } : undefined;
    return this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/layers/${encodeURIComponent(layerId)}`,
      { query, requestOptions: opts },
    );
  }

  /** `POST /networks/{nid}/layers/{id}/select` — switch the session layer. */
  public async selectLayer(
    networkId: string,
    layerId: string,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').LayerEcho> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/layers/${encodeURIComponent(layerId)}/select`,
      { requestOptions: opts },
    );
  }

  /** `POST /networks/{nid}/layers/{id}/merge` — merge into the parent (S8). */
  public async mergeLayer(
    networkId: string,
    layerId: string,
    tables?: Record<string, string[]>,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').LayerMergeReport> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/layers/${encodeURIComponent(layerId)}/merge`,
      { body: tables === undefined ? {} : { tables }, requestOptions: opts },
    );
  }

  /** `GET /networks/{nid}/layers/{id}/diff` — structural diff (S11). */
  public async getLayerDiff(
    networkId: string,
    layerId: string,
  ): Promise<import('@etn/shared').LayerDiffResult> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/layers/${encodeURIComponent(layerId)}/diff`,
    );
  }

  /** `GET /networks/{nid}/layers/{id}/diff/doc` — textual diff docs (S11). */
  public async getLayerDiffDoc(
    networkId: string,
    layerId: string,
  ): Promise<import('@etn/shared').LayerDiffDoc> {
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/layers/${encodeURIComponent(layerId)}/diff/doc`,
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

  /** `POST /networks/{nid}/import/commit` — apply a `.etnx` archive (phase P). */
  public async importEtnx(
    networkId: string,
    parentThoughtId: string,
    archiveB64: string,
    slices?: {
      include_types?: boolean;
      include_attachments?: boolean;
      include_chronology?: boolean;
    },
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').ImportSummary> {
    const body: Record<string, unknown> = {
      archive_b64: archiveB64,
      parent_thought_id: parentThoughtId,
    };
    if (slices !== undefined) body['etnx'] = slices;
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/import/commit`,
      {
        body,
        requestOptions: opts,
      },
    );
  }

  /** `GET /jobs/{jobId}` — poll an export job. */
  public async getJob(jobId: string): Promise<import('@etn/shared').ExportJob> {
    return this.request('GET', `/jobs/${encodeURIComponent(jobId)}`);
  }

  /**
   * `GET /jobs/{jobId}/download` — fetch the rendered export bytes. Bypasses
   * the JSON envelope path used by {@link request}: the server returns binary
   * (`application/zip` or `text/markdown`/`text/html`) and we hand the raw
   * Buffer to the caller. Going through main process is more reliable than
   * `<a download>` in Electron for binary content — the bytes round-trip
   * without the renderer's URL navigation quirks.
   */
  public async downloadJob(jobId: string): Promise<{
    contentType: string;
    body: Buffer;
  }> {
    const url = `${this.baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/download`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.getApiKey()}`,
      Accept: '*/*',
    };
    const res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`download failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    return { contentType, body: Buffer.from(arrayBuffer) };
  }

  // -------------------------------------------------------------------------
  // §16 System endpoints
  // -------------------------------------------------------------------------

  /** `GET /api/v1/health` (03-server-api.md §16) — public, без авторизации. */
  public async getHealth(): Promise<import('@etn/shared').HealthResponse> {
    return this.requestRaw('GET', '/health');
  }

  /** `GET /api/v1/version` (03-server-api.md §16) — public, без авторизации;
   *  используется для проверки совместимости и в диалоге «О программе». */
  public async getVersion(): Promise<import('@etn/shared').VersionResponse> {
    return this.requestRaw('GET', '/version');
  }

  // §16a Server file journal (task f051bf95, 03-server-api.md §16):
  // admin-only management endpoints of the server diagnostic journal.

  /** `GET /system/logging` — server journal flag + retention + file list. */
  public async getServerLogging(): Promise<SystemLoggingStatus> {
    return this.request('GET', '/system/logging');
  }

  /** `PUT /system/logging` — toggle the server in-memory journal flag. */
  public async setServerLogging(enabled: boolean): Promise<SystemLoggingStatus> {
    return this.request('PUT', '/system/logging', { body: { enabled } });
  }

  /**
   * `GET /system/logs/:filename` — download one server journal file as text
   * (served as `text/plain` attachment, so this bypasses the JSON envelope
   * path like {@link downloadJob}). Returns the raw bytes; the caller decides
   * where to write them.
   */
  public async downloadServerLogFile(filename: string): Promise<{
    contentType: string;
    body: Buffer;
  }> {
    const url = `${this.baseUrl}/api/v1/system/logs/${encodeURIComponent(filename)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.getApiKey()}`,
      'Client-Id': this.getClientId(),
      Accept: '*/*',
    };
    const res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new EtnError(
        mapHttpStatus(res.status),
        `log download failed: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      );
    }
    const contentType = res.headers.get('content-type') ?? 'text/plain; charset=utf-8';
    return { contentType, body: Buffer.from(await res.arrayBuffer()) };
  }

  /**
   * `DELETE /system/logs/:filename` — remove one server journal file (the
   * current day is truncated server-side).
   */
  public async deleteServerLogFile(filename: string): Promise<void> {
    await this.request('DELETE', `/system/logs/${encodeURIComponent(filename)}`);
  }

  // -------------------------------------------------------------------------
  // §13c Object locks (task 4f141756 — авто-захват в клиенте)
  //
  // Серверная основа (миграция 034, REST `/locks`, события `edit.*`) уже
  // готова (коммит d0f41af, задача 2031df5e); эти методы — клиентский мост.
  // На 409 LOCKED сервер присылает канонический envelope, который
  // {@link parseResponse} раскрывает в EtnError с details.holder —
  // пользовательский код резолвит имя holder'а через `lib/users.ts`.
  // -------------------------------------------------------------------------

  /** `POST /networks/{nid}/locks` — acquire (идемпотентно для своего). */
  public async acquireLock(
    networkId: string,
    entityType: string,
    entityId: string,
    opts?: RequestOptions,
  ): Promise<import('@etn/shared').LockRow> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/locks`,
      { body: { entity_type: entityType, entity_id: entityId }, requestOptions: opts },
    );
  }

  /** `DELETE /networks/{nid}/locks/:lockId` — release (только владелец). */
  public async releaseLock(
    networkId: string,
    lockId: string,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.request(
      'DELETE',
      `/networks/${encodeURIComponent(networkId)}/locks/${encodeURIComponent(lockId)}`,
      { requestOptions: opts },
    );
  }

  /**
   * `GET /networks/{nid}/locks` — список активных захватов, опционально
   * фильтрованных по `userId`/`clientId`. Используется для подтягивания
   * чужого состояния на cold-start (после переподключения WS) и для диалога
   * «Участники мыслесети» (показать, у кого сколько блокировок).
   */
  public async listLocks(
    networkId: string,
    filters?: { userId?: string; clientId?: string },
  ): Promise<import('@etn/shared').LockRow[]> {
    const query: QueryRecord = {};
    if (filters?.userId !== undefined) query['user_id'] = filters.userId;
    if (filters?.clientId !== undefined) query['client_id'] = filters.clientId;
    return this.request(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/locks`,
      { query: Object.keys(query).length ? query : undefined },
    );
  }

  /** `POST /networks/{nid}/locks/clear` — ручной сброс всех захватов пользователя. */
  public async clearLocks(
    networkId: string,
    userId: string,
    opts?: RequestOptions,
  ): Promise<{ cleared: number }> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/locks/clear`,
      { body: { user_id: userId }, requestOptions: opts },
    );
  }

  /** `DELETE /system/logs` — remove every server journal file (current truncated). */
  public async deleteAllServerLogs(): Promise<void> {
    await this.request('DELETE', '/system/logs');
  }

  // ---------------------------------------------------------------------------
  // §13d Activity log (задачи f2eca5a4, 6bcccd2b)
  //
  // Клиентский мост к `GET /activity`, `POST /activity/rollup`,
  // `POST /activity/truncate` (03-server-api.md §13d). Серверная часть и MCP
  // `etn.activity.list`/`etn.activity.rollup`/`etn.activity.truncate` уже
  // готовы; клиент потребляет REST и не дублирует логику. Рендеринг ленты —
  // `client/src/renderer/screens/activity/`.
  // ---------------------------------------------------------------------------

  /** `GET /networks/{nid}/activity` — лента с фильтрами и пагинацией. */
  public async listActivity(
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
  ): Promise<{ rows: ActivityRow[]; total: number }> {
    const query: QueryRecord = {};
    if (filters?.from_ms !== undefined) query['from_ms'] = filters.from_ms;
    if (filters?.to_ms !== undefined) query['to_ms'] = filters.to_ms;
    if (filters?.user_id !== undefined) query['user_id'] = filters.user_id;
    if (filters?.entity_type !== undefined) query['entity_type'] = filters.entity_type;
    if (filters?.entity_id !== undefined) query['entity_id'] = filters.entity_id;
    if (filters?.limit !== undefined) query['limit'] = filters.limit;
    if (filters?.offset !== undefined) query['offset'] = filters.offset;
    const rows = await this.request<ActivityRow[]>(
      'GET',
      `/networks/${encodeURIComponent(networkId)}/activity`,
      { query: Object.keys(query).length ? query : undefined },
    );
    // The envelope's `meta.total` carries the unfiltered count; fall back to
    // the page size if the server omitted it (same defensive pattern as
    // `queryChronicle`).
    const meta = this.lastMeta as { total?: number } | undefined;
    const total = typeof meta?.total === 'number' ? meta.total : rows.length;
    return { rows, total };
  }

  /** `POST /networks/{nid}/activity/rollup` — свёртка журнала до `untilMs`. */
  public async rollupActivity(
    networkId: string,
    untilMs: number,
    opts?: RequestOptions,
  ): Promise<{ removed: number; kept: number }> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/activity/rollup`,
      { body: { until_ms: untilMs }, requestOptions: opts },
    );
  }

  /** `POST /networks/{nid}/activity/truncate` — обрезка журнала до `untilMs`. */
  public async truncateActivity(
    networkId: string,
    untilMs: number,
    opts?: RequestOptions,
  ): Promise<{ removed: number }> {
    return this.request(
      'POST',
      `/networks/${encodeURIComponent(networkId)}/activity/truncate`,
      { body: { until_ms: untilMs }, requestOptions: opts },
    );
  }

  /**
   * Variant of {@link request} without the auth header — health/version are
   * public (§16). The path still goes under `/api/v1` like every other
   * endpoint (the server serves no root-level routes).
   */
  private async requestRaw<T>(method: string, path: string): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path.startsWith('/') ? path : `/${path}`}`;
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

/** Compact one-line error rendering for journal fields. */
function errTextShort(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Retry reason classification for the journal (timeout / network / 5xx). */
function classifyRetryReason(err: Error): string {
  return /timeout/i.test(err.message) ? 'timeout' : 'network';
}
