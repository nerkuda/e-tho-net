/**
 * WebSocket gateway for real-time delivery (tasks E1, E4, E5;
 * docs/04-realtime.md §2, §5–6; docs/11-settings-and-state.md §1, §4).
 *
 * Exposes `GET /api/v1/realtime?network_id=<nid>` through
 * `@fastify/websocket` and manages the connection registries described in
 * 11-settings-and-state.md §1.2:
 *
 *   * `connections` — every live connection;
 *   * `byNetwork`  — connections per `network_id`;
 *   * `byClient`   — connections per `(user_id, client_id)`.
 *
 * Delivery rules (E4, 11-settings-and-state.md §4.3):
 *   * `audience: 'network'` → every member of the network;
 *   * `audience: 'user'`    → only connections of the same `user_id`;
 *   * the socket whose `client_id` equals `actor.client_id` never receives the
 *     event (echo suppression — the client already has the state from its REST
 *     response; on reconnect the event still replays through `resume`).
 *
 * Replay (E5, 04-realtime.md §2.2, §6): a `resume { last_seq }` frame replays
 * retained events with `seq > last_seq` in batches; when the client's position
 * predates the retained window, the gateway answers `resume.stale`. Keep-alive:
 * the server pings every `pingIntervalMs` and drops connections that stay
 * silent for `pongTimeoutMs` (04-realtime.md §2.1).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket, type RawData } from 'ws';

import {
  BASE_LAYER_ID,
  REALTIME_CLOSE_CODES,
  type AnyRealtimeEvent,
  type RealtimeClientMessage,
  type RealtimeEvent,
  type RealtimeEventType,
  type RealtimeServerControlMessage,
} from '@etn/shared';

import { hashApiKey, isValidApiKeyFormat } from '../auth/api-key.js';
import { extractBearerToken, readClientId } from '../http/context.js';
import type { SystemDb } from '../db/system-db.js';
import type { Logger } from '../logger.js';
import { openNetworkDb } from '../db/network-db.js';
import { resolveSessionLayer, resolveSessionSwitchSeq } from '../domain/layer-service.js';
import { isEventVisibleInLayer } from './layer-visibility.js';
import type { PubSub } from './pubsub.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared WebSocket gateway (task S9: routes push forced-resync frames). */
    realtimeGateway: RealtimeGateway;
  }
}

/** Tunables for the gateway (shortened intervals make tests fast). */
export interface RealtimeGatewayOptions {
  /** Server ping period, ms (04-realtime.md §2.1). */
  pingIntervalMs: number;
  /** Close the socket when no frame arrives within this window, ms. */
  pongTimeoutMs: number;
  /** Max events per `resume` batch (04-realtime.md §6). */
  resumeBatchLimit: number;
}

/** Production defaults (04-realtime.md §2.1, §6). */
export const DEFAULT_REALTIME_GATEWAY_OPTIONS: RealtimeGatewayOptions = {
  pingIntervalMs: 30_000,
  pongTimeoutMs: 60_000,
  resumeBatchLimit: 500,
};

/** Close code for connections that stopped answering pings. */
const PONG_TIMEOUT_CLOSE_CODE = 1001;

/** A live WebSocket connection and its coordinates. */
interface Connection {
  socket: WebSocket;
  userId: string;
  /** May change once, via a `hello` frame, when no id was sent at connect. */
  clientId: string | null;
  networkId: string;
  /**
   * This connection's session layer (task S9, 13-layers.md §7.1, §12) —
   * resolved from `session_layers` at connect time (and refreshed on a late
   * `hello`), kept in sync by {@link RealtimeGateway.notifyLayerSwitch} /
   * {@link RealtimeGateway.notifyLayerDeleted} when the session's layer
   * changes server-side while the socket stays open.
   */
  layerId: string;
  /** True after a server ping that has not been answered yet. */
  awaitingPong: boolean;
  pingTimer: NodeJS.Timeout;
  unsubscribe: () => void;
}

/** Frame the client may send; `pong` answers the server ping (§2.1). */
type ClientFrame = RealtimeClientMessage | { type: 'pong' };

/**
 * Frames the server may send. NOTE: `RealtimeServerControlMessage` in
 * @etn/shared lacks the server `ping` frame (04-realtime.md §2.1); extended
 * locally so shared/ stays untouched. Client-side types should gain
 * `{ type: 'ping' }` when phase H lands.
 */
type ServerFrame = RealtimeServerControlMessage | { type: 'ping' };

/** Dependencies injected into {@link RealtimeGateway}. */
export interface RealtimeGatewayDeps {
  /** `_system.db` accessor (auth, membership, event replay). */
  systemDb: SystemDb;
  /** In-process broker carrying live events for the subscribed networks. */
  pubsub: PubSub;
  /**
   * Absolute ETN data directory (task S9, 13-layers.md §12): needed to open
   * per-layer `data.db` connections for visibility checks
   * ({@link isEventVisibleInLayer}) and to resolve a connecting session's
   * current layer.
   */
  dataDir: string;
  /** Optional application logger. */
  logger?: Logger;
  /** Partial option overrides (tests). */
  options?: Partial<RealtimeGatewayOptions>;
}

/** Registry key for {@link RealtimeGateway.byClient}. */
function clientKey(userId: string, clientId: string | null): string {
  return `${userId}\u0000${clientId ?? ''}`;
}

/** Validate an inbound JSON frame against the control-frame catalogue. */
function parseClientFrame(raw: unknown): ClientFrame | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const msg = raw as Record<string, unknown>;
  switch (msg.type) {
    case 'hello':
      return typeof msg.client_id === 'string' && msg.client_id.length > 0
        ? { type: 'hello', client_id: msg.client_id }
        : null;
    case 'resume':
      return typeof msg.last_seq === 'number' && Number.isFinite(msg.last_seq) && msg.last_seq >= 0
        ? { type: 'resume', last_seq: Math.floor(msg.last_seq) }
        : null;
    case 'ping':
      return { type: 'ping' };
    case 'pong':
      return { type: 'pong' };
    default:
      return null;
  }
}

/** Send a JSON frame when the socket is still open. */
function sendJson(socket: WebSocket, payload: unknown, log?: Logger): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload), (err) => {
    if (err !== undefined) {
      log?.warn({ err }, 'realtime: send failed');
    }
  });
}

/**
 * WebSocket gateway for `/api/v1/realtime`. Construct once per server process,
 * {@link register} it on the Fastify instance before `listen()`.
 */
export class RealtimeGateway {
  private readonly systemDb: SystemDb;
  private readonly pubsub: PubSub;
  private readonly dataDir: string;
  private readonly logger?: Logger;
  private readonly options: RealtimeGatewayOptions;

  /** Every live connection. */
  private readonly connections = new Set<Connection>();
  /** Connections per network id. */
  private readonly byNetwork = new Map<string, Set<Connection>>();
  /** Connections per `(user_id, client_id)` composite key. */
  private readonly byClient = new Map<string, Set<Connection>>();

  constructor(deps: RealtimeGatewayDeps) {
    this.systemDb = deps.systemDb;
    this.pubsub = deps.pubsub;
    this.dataDir = deps.dataDir;
    this.logger = deps.logger;
    this.options = { ...DEFAULT_REALTIME_GATEWAY_OPTIONS, ...deps.options };
  }

  /**
   * Attach the WebSocket route and a shutdown hook to the Fastify instance.
   * Safe to call once; the route path matches 04-realtime.md §2.
   */
  register(app: FastifyInstance): void {
    app.get('/api/v1/realtime', { websocket: true }, (socket, req) => {
      this.handleConnection(socket, req);
    });
    app.addHook('onClose', () => {
      this.closeAll();
    });
  }

  /** Number of live connections (introspection/tests). */
  connectionCount(): number {
    return this.connections.size;
  }

  /** Authenticate + authorise the upgrade, then track the connection. */
  private handleConnection(socket: WebSocket, req: FastifyRequest): void {
    const networkId = this.queryString(req, 'network_id');
    if (networkId === null) {
      this.closeSocket(socket, REALTIME_CLOSE_CODES.NOT_FOUND, 'network_id is required');
      return;
    }

    const auth = this.authenticate(req);
    if (auth === null) {
      // 04-realtime.md §2: no valid key (or disabled key/user) → 4401.
      this.closeSocket(socket, REALTIME_CLOSE_CODES.UNAUTHORIZED, 'invalid or missing API-key');
      return;
    }

    const network = this.systemDb.getNetworkById(networkId);
    if (network === null) {
      // 04-realtime.md §2: unknown network → 4404.
      this.closeSocket(socket, REALTIME_CLOSE_CODES.NOT_FOUND, 'network not found');
      return;
    }

    const role = this.systemDb.getMemberRole(auth.userId, networkId);
    if (role === null) {
      // 04-realtime.md §2: no rights on the network → 4401.
      this.closeSocket(socket, REALTIME_CLOSE_CODES.UNAUTHORIZED, 'not a network member');
      return;
    }

    const clientId = this.clientIdFromRequest(req);
    const conn: Connection = {
      socket,
      userId: auth.userId,
      clientId,
      networkId,
      layerId: this.resolveConnLayer(networkId, auth.userId, clientId),
      awaitingPong: false,
      pingTimer: setInterval(() => this.heartbeat(conn), this.options.pingIntervalMs),
      unsubscribe: () => {},
    };
    conn.pingTimer.unref?.();
    // One broker subscription per connection keeps delivery per-socket and
    // lets the filters in deliver() apply connection coordinates.
    conn.unsubscribe = this.pubsub.subscribe(networkId, (event) => this.deliver(conn, event));

    this.connections.add(conn);
    this.indexByNetwork(conn);
    this.indexByClient(conn);

    socket.on('message', (raw: RawData) => this.onMessage(conn, raw));
    socket.on('close', () => this.removeConnection(conn));
    socket.on('error', (err) => {
      this.logger?.debug({ err, networkId, userId: conn.userId }, 'realtime: socket error');
    });
  }

  /** Validate the bearer key the same way the REST preHandler does (B8). */
  private authenticate(req: FastifyRequest): { userId: string; keyId: string } | null {
    const token = extractBearerToken(req.headers);
    if (token === null || !isValidApiKeyFormat(token)) {
      this.logAuthFailure('malformed_token');
      return null;
    }
    const found = this.systemDb.findApiKeyByHash(hashApiKey(token));
    if (found === null) {
      this.logAuthFailure('unknown_key');
      return null;
    }
    // Update last_used_at off the hot path, mirroring the REST preHandler.
    setImmediate(() => {
      try {
        this.systemDb.touchApiKeyUsed(found.apiKey.id);
      } catch {
        // non-fatal, same policy as auth-middleware
      }
    });
    return { userId: found.user.id, keyId: found.apiKey.id };
  }

  /** Record a failed WebSocket authentication in the audit log. */
  private logAuthFailure(reason: 'malformed_token' | 'unknown_key'): void {
    this.systemDb.insertAuditLog({
      category: 'auth',
      action: 'login_failed',
      details: { reason, transport: 'websocket' },
    });
  }

  /** Live delivery with audience routing, layer visibility and echo suppression (E4, S9). */
  private deliver<E extends RealtimeEventType>(conn: Connection, event: RealtimeEvent<E>): void {
    // audience=user events reach only the same user's connections (§4.3).
    // These are non-branchable data (13-layers.md §3) — no layer check.
    if (event.audience === 'user') {
      if (event.actor.user_id !== conn.userId) {
        return;
      }
    } else if (!this.isVisible(conn, event as unknown as AnyRealtimeEvent)) {
      // audience=network content event the subscriber's layer overrides or
      // that never happened on its ancestor chain (task S9, 13-layers.md §12).
      return;
    }
    // Echo suppression: the originating client already has the state from its
    // REST response (04-realtime.md §5, §9). An empty actor client_id means
    // "no Client-Id on the request" — nothing to suppress.
    if (
      conn.clientId !== null &&
      event.actor.client_id !== '' &&
      event.actor.client_id === conn.clientId
    ) {
      return;
    }
    sendJson(conn.socket, event, this.logger);
  }

  /** {@link isEventVisibleInLayer} bound to `conn`'s own layer connection. */
  private isVisible(conn: Connection, event: AnyRealtimeEvent): boolean {
    if (event.layer_id === conn.layerId) {
      return true;
    }
    try {
      const ndb = openNetworkDb(this.dataDir, conn.networkId, this.logger, conn.layerId);
      return isEventVisibleInLayer(ndb, event, conn.layerId);
    } catch (err) {
      // A visibility-check failure must not silently over- or under-deliver;
      // fail closed (skip) and log — same policy as the onSend layer echo.
      this.logger?.warn({ err, networkId: conn.networkId, layerId: conn.layerId }, 'realtime: layer visibility check failed, skipping event');
      return false;
    }
  }

  /** Resolve a connecting session's current layer (task S9, 13-layers.md §7.1). */
  private resolveConnLayer(networkId: string, userId: string, clientId: string | null): string {
    try {
      const base = openNetworkDb(this.dataDir, networkId, this.logger);
      return resolveSessionLayer(base, userId, clientId).id;
    } catch (err) {
      this.logger?.warn({ err, networkId, userId }, 'realtime: session layer resolution failed, defaulting to base');
      return BASE_LAYER_ID;
    }
  }

  /** Handle an inbound control frame. */
  private onMessage(conn: Connection, raw: RawData): void {
    // Any inbound frame proves liveness — reset the pong expectation.
    conn.awaitingPong = false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      this.logger?.debug('realtime: unparseable frame ignored');
      return;
    }
    const frame = parseClientFrame(parsed);
    if (frame === null) {
      this.logger?.debug('realtime: unrecognised frame ignored');
      return;
    }
    switch (frame.type) {
      case 'hello':
        // Late client-id registration (11-settings-and-state.md §1.1).
        if (conn.clientId === null) {
          this.updateClientId(conn, frame.client_id);
        }
        break;
      case 'resume':
        this.replay(conn, frame.last_seq);
        break;
      case 'ping':
        sendJson(conn.socket, { type: 'pong' } satisfies RealtimeServerControlMessage, this.logger);
        break;
      case 'pong':
        break; // liveness already accounted for above
    }
  }

  /**
   * Replay retained events with `seq > lastSeq` (04-realtime.md §6). Only
   * network-wide events **visible in the session's current layer** (task S9,
   * 13-layers.md §12) and the caller's own private (`audience=user`) events
   * are sent — private settings of *other* users never replay. When the
   * position predates the retained window (a gap in `event_log`), or predates
   * this session's last layer switch (`switched_at_seq`, migration 028 — the
   * client's cache was built under a different layer and a delta cannot
   * bridge that), answer `resume.stale` so the client performs a full
   * re-sync. Both checks run before replay, because retained rows may exist
   * *after* either hole.
   */
  private replay(conn: Connection, lastSeq: number): void {
    const minSeq = this.systemDb.getMinEventSeq(conn.networkId);
    if (minSeq !== null && lastSeq < minSeq - 1) {
      sendJson(
        conn.socket,
        { type: 'resume.stale', last_seq: minSeq - 1 } satisfies RealtimeServerControlMessage,
        this.logger,
      );
      return;
    }
    const switchedAtSeq = this.resolveConnSwitchSeq(conn);
    if (switchedAtSeq > 0 && lastSeq < switchedAtSeq) {
      sendJson(
        conn.socket,
        { type: 'resume.stale', last_seq: switchedAtSeq } satisfies RealtimeServerControlMessage,
        this.logger,
      );
      return;
    }
    const events = this.systemDb
      .readEventsAfter(conn.networkId, lastSeq, this.options.resumeBatchLimit)
      .filter((e) => e.audience === 'network' || e.actor.user_id === conn.userId)
      .filter((e) => e.audience === 'user' || this.isVisible(conn, e));
    for (const event of events) {
      sendJson(conn.socket, event, this.logger);
    }
  }

  /** {@link resolveSessionSwitchSeq} for `conn`'s coordinates. */
  private resolveConnSwitchSeq(conn: Connection): number {
    try {
      const base = openNetworkDb(this.dataDir, conn.networkId, this.logger);
      return resolveSessionSwitchSeq(base, conn.userId, conn.clientId);
    } catch (err) {
      this.logger?.warn({ err, networkId: conn.networkId }, 'realtime: switch-seq resolution failed');
      return 0;
    }
  }

  /** Send the periodic ping; drop the socket after a missed pong (E5 §2.1). */
  private heartbeat(conn: Connection): void {
    if (conn.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (conn.awaitingPong) {
      this.logger?.warn(
        { userId: conn.userId, clientId: conn.clientId, networkId: conn.networkId },
        'realtime: pong timeout, closing connection',
      );
      this.closeSocket(conn.socket, PONG_TIMEOUT_CLOSE_CODE, 'pong timeout');
      return;
    }
    conn.awaitingPong = true;
    sendJson(conn.socket, { type: 'ping' } satisfies ServerFrame, this.logger);
  }

  private updateClientId(conn: Connection, clientId: string): void {
    const oldKey = clientKey(conn.userId, conn.clientId);
    const oldSet = this.byClient.get(oldKey);
    oldSet?.delete(conn);
    if (oldSet !== undefined && oldSet.size === 0) {
      this.byClient.delete(oldKey);
    }
    conn.clientId = clientId;
    this.indexByClient(conn);
    // The session_layers coordinate is (user_id, client_id) — a late `hello`
    // may move it from the "no Client-Id" bucket to the real one (task S9).
    conn.layerId = this.resolveConnLayer(conn.networkId, conn.userId, conn.clientId);
  }

  /**
   * Force-resync the live connections of one `(user_id, client_id)` session in
   * `networkId` after its layer changed server-side (task S9, 13-layers.md
   * §7.1, §12 — the REST `POST .../layers/:id/select` route calls this right
   * after `setSessionLayer` (domain/layer-service.ts) succeeds). Updates the
   * cached `layerId` so live delivery immediately uses
   * the new layer, and pushes `layer.switched` so the client knows its cache
   * predates the switch and must fully re-sync — a plain reconnect would
   * otherwise resume from `last_seq` under the *new* layer's filter while the
   * client's cache still reflects the old one (13-layers.md §12).
   */
  notifyLayerSwitch(
    networkId: string,
    userId: string,
    clientId: string | null,
    layer: { id: string; title: string },
  ): void {
    const set = this.byClient.get(clientKey(userId, clientId));
    if (set === undefined) {
      return;
    }
    for (const conn of set) {
      if (conn.networkId !== networkId) continue;
      conn.layerId = layer.id;
      sendJson(
        conn.socket,
        { type: 'layer.switched', layer } satisfies RealtimeServerControlMessage,
        this.logger,
      );
    }
  }

  /**
   * Force-resync every live connection of `networkId` currently sitting on
   * one of `affectedLayerIds` (the deleted layer + its whole subtree, task
   * S9, 13-layers.md §2.4) — the delete route re-points their
   * `session_layers` row to `newLayer` (the deleted layer's parent) in the
   * same transaction; this call mirrors that for already-connected sockets.
   */
  notifyLayerDeleted(
    networkId: string,
    affectedLayerIds: ReadonlySet<string>,
    newLayer: { id: string; title: string },
  ): void {
    const set = this.byNetwork.get(networkId);
    if (set === undefined) {
      return;
    }
    for (const conn of set) {
      if (!affectedLayerIds.has(conn.layerId)) continue;
      conn.layerId = newLayer.id;
      sendJson(
        conn.socket,
        { type: 'layer.deleted', layer: newLayer } satisfies RealtimeServerControlMessage,
        this.logger,
      );
    }
  }

  private indexByNetwork(conn: Connection): void {
    let set = this.byNetwork.get(conn.networkId);
    if (set === undefined) {
      set = new Set();
      this.byNetwork.set(conn.networkId, set);
    }
    set.add(conn);
  }

  private indexByClient(conn: Connection): void {
    const key = clientKey(conn.userId, conn.clientId);
    let set = this.byClient.get(key);
    if (set === undefined) {
      set = new Set();
      this.byClient.set(key, set);
    }
    set.add(conn);
  }

  /** Unregister a closed connection and release its broker subscription. */
  private removeConnection(conn: Connection): void {
    this.connections.delete(conn);
    this.byNetwork.get(conn.networkId)?.delete(conn);
    const key = clientKey(conn.userId, conn.clientId);
    const set = this.byClient.get(key);
    set?.delete(conn);
    if (set !== undefined && set.size === 0) {
      this.byClient.delete(key);
    }
    clearInterval(conn.pingTimer);
    conn.unsubscribe();
  }

  /** Close every connection (server shutdown). */
  private closeAll(): void {
    for (const conn of [...this.connections]) {
      this.closeSocket(conn.socket, 1001, 'server shutdown');
    }
  }

  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  }

  /** Read a single query parameter, or `null` when absent/empty. */
  private queryString(req: FastifyRequest, name: string): string | null {
    const q = req.query as Record<string, unknown>;
    const v = q[name];
    return typeof v === 'string' && v.length > 0 ? v : null;
  }

  /** `Client-Id` header first, then `?client_id=` (11-settings-and-state.md §1.1). */
  private clientIdFromRequest(req: FastifyRequest): string | null {
    return readClientId(req.headers) ?? this.queryString(req, 'client_id');
  }
}
