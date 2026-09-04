/**
 * Real-time (WebSocket) client for the ETN server (docs/04-realtime.md §2,
 * docs/07-client-electron.md §4.2, docs/11-settings-and-state.md §1, workplan G6).
 *
 * One {@link RealtimeClient} owns a single connection to
 * `ws(s)://<host>/api/v1/realtime?network_id=<nid>` for the currently selected
 * network. After `open` it sends `resume { last_seq }` so the server replays the
 * events the client missed during an outage (04-realtime.md §6). Incoming events
 * are parsed and re-emitted on a typed {@link TypedEmitter} for the applier (G8)
 * and the IPC bridge (G7) to consume.
 *
 * Connection lifecycle:
 *  - `connect()` opens the socket with `Authorization`/`Client-Id` headers;
 *  - the server closes with `4401` (unauthorized) or `4404` (network not found) —
 *    these are terminal and re-emitted as `unauthorized`/`not-found`;
 *  - any other close/error triggers exponential backoff reconnect with full jitter
 *    (1 s → 30 s), capped, and a fresh `resume` on the next `open`;
 *  - receive-idle watchdog (defect 7f4cef31): when no frame of any kind arrives
 *    for ~100 s (3 server ping intervals + slack, 04-realtime.md §2.1) the
 *    socket is presumed half-open (OS sleep / network switch) and terminated,
 *    routing into the same backoff + `resume` path; `forceReconnect()` does the
 *    same immediately for system resume/online events;
 *  - `resume.stale` (event-log window exceeded) is re-emitted as `stale` so the UI
 *    can trigger a full re-focus (04-realtime.md §6).
 *
 * `last_seq` is persisted per `(client_id, network_id)` in `client_meta.last_seq`
 * as a JSON map `{ [network_id]: seq }`. It is advanced synchronously on every
 * received event — the event "passed" on the wire even if the applier later
 * suppresses its echo (11-settings-and-state.md §1.4).
 */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  CLIENT_META_KEY,
  REALTIME_CLOSE_CODES,
  type AnyRealtimeEvent,
  type RealtimeServerControlMessage,
} from '@etn/shared';
import type { LocalDb } from '../db/local-db.js';
import { getClientLog } from '../log/client-log.js';
import { TypedEmitter, type EventMap } from './typed-emitter.js';

/** Reconnect backoff base, in milliseconds (04-realtime.md §2.2). */
const RECONNECT_BASE_DELAY_MS = 1_000;
/** Reconnect backoff cap, in milliseconds (04-realtime.md §2.2). */
const RECONNECT_MAX_DELAY_MS = 30_000;
/** Maximum reconnect attempts before giving up (safety valve). */
const RECONNECT_MAX_ATTEMPTS = 50;
/**
 * Receive-idle watchdog, in milliseconds (defect 7f4cef31). The server pings
 * every 30 s (04-realtime.md §2.1), so a healthy connection is never silent
 * longer than one ping interval. When no frame of any kind arrives for 3
 * intervals + slack, the socket is presumed half-open (typical after OS sleep
 * or a network switch: the server already closed its side after the pong
 * timeout, but the FIN/RST never reached the client) and gets hard-terminated
 * so the regular close → backoff-reconnect → `resume` path takes over.
 */
const RECV_IDLE_TIMEOUT_MS = 100_000;

/** Connection status surfaced to the UI (07-client-electron.md §5.1). */
export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

/** Typed event catalogue emitted by {@link RealtimeClient}. */
export interface RealtimeClientEvents extends EventMap {
  /** A real-time event received from the server (after parsing + last_seq update). */
  event: [event: AnyRealtimeEvent];
  /** Connection status changed. */
  status: [status: RealtimeStatus];
  /** `resume.stale` — event-log window exceeded; caller must do a full re-focus. */
  stale: [lastSeq: number];
  /**
   * A layer control frame (S11, 13-layers.md §12, §2.4): the server switched
   * this session's layer or deleted the layer it was sitting on. Both require
   * a full resync of the visible state.
   */
  'layer-control': [
    payload: { kind: 'switched' | 'deleted'; layer: { id: string; title: string } },
  ];
  /** Server closed with `4401` — API-key rejected or membership lost. */
  unauthorized: [];
  /** Server closed with `4404` — network does not exist. */
  'not-found': [];
  /** Low-level socket error (already handled for reconnect; surfaced for logging). */
  error: [err: Error];
}

/** Constructor options for {@link RealtimeClient}. */
export interface RealtimeClientOptions {
  /**
   * WebSocket base URL, e.g. `ws://localhost:3000` or `wss://etn.example.com`. An
   * `http(s)://` URL is rewritten to `ws(s)://` for convenience.
   */
  baseUrl: string;
  /** Resolves the plaintext API-key just-in-time (decryption in main process). */
  getApiKey: () => Promise<string>;
  /** Returns the installation Client-Id. */
  getClientId: () => string;
  /** Returns the currently selected network id, or `null` when none is active. */
  getNetworkId: () => string | null;
  /** Local store holding `last_seq` per network (level L5). */
  localDb: LocalDb;
  /**
   * Optional WebSocket constructor override — primarily for unit tests. Defaults
   * to the bundled `ws` client.
   */
  WebSocketCtor?: typeof WebSocket;
  /** Optional jitter override (for deterministic tests). */
  random?: () => number;
  /** Optional scheduler override (for deterministic tests). */
  setTimeout?: typeof setTimeout;
  /**
   * Receive-idle watchdog timeout override, in milliseconds (defect 7f4cef31).
   * Defaults to {@link RECV_IDLE_TIMEOUT_MS}; tests use short values.
   */
  idleTimeoutMs?: number;
}

/**
 * Strongly-typed real-time WebSocket client. Construct one and call
 * {@link connect} when the user opens a network; call {@link disconnect} when
 * leaving the network or quitting the app.
 *
 * Subscribers (applier, IPC bridge) listen via the typed `*Typed` helpers:
 * ```ts
 * client.onTyped('event', (e) => applier.apply(e));
 * client.onTyped('status', (s) => renderer.send('realtime:status', s));
 * ```
 */
export class RealtimeClient extends TypedEmitter<RealtimeClientEvents> {
  private readonly baseUrl: string;
  private readonly getApiKey: () => Promise<string>;
  private readonly getClientId: () => string;
  private readonly getNetworkId: () => string | null;
  private readonly localDb: LocalDb;
  private readonly WebSocketCtor: typeof WebSocket;
  private readonly random: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly idleTimeoutMs: number;

  /** Active socket, or `null` when closed. */
  private socket: WebSocket | null = null;
  /** Current connection status. */
  private status: RealtimeStatus = 'idle';
  /** Reconnect attempt counter (reset on a clean open). */
  private reconnectAttempts = 0;
  /** Pending reconnect timer handle, or `null`. */
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** `true` while a user-initiated `disconnect()` is in progress (suppress reconnect). */
  private manualClose = false;
  /** Pending receive-idle watchdog timer, or `null` (defect 7f4cef31). */
  private idleTimer: NodeJS.Timeout | null = null;
  /** `true` after a terminal close (4401/4404) — suppresses forceReconnect. */
  private terminalClosed = false;

  public constructor(opts: RealtimeClientOptions) {
    super();
    this.baseUrl = normaliseWsUrl(opts.baseUrl);
    this.getApiKey = opts.getApiKey;
    this.getClientId = opts.getClientId;
    this.getNetworkId = opts.getNetworkId;
    this.localDb = opts.localDb;
    this.WebSocketCtor = opts.WebSocketCtor ?? WebSocket;
    this.random = opts.random ?? Math.random;
    this.setTimeoutFn = opts.setTimeout ?? setTimeout;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? RECV_IDLE_TIMEOUT_MS;
  }

  /** Returns the current connection status. */
  public getStatus(): RealtimeStatus {
    return this.status;
  }

  /**
   * Opens the WebSocket connection to the current network. If a connection is
   * already live or connecting, this is a no-op. Throws synchronously when no
   * network is selected.
   */
  public connect(): void {
    const networkId = this.getNetworkId();
    if (networkId === null) {
      throw new Error('RealtimeClient.connect: сеть не выбрана (networkId is null).');
    }
    if (this.socket !== null) {
      return; // already connected or connecting
    }
    this.manualClose = false;
    this.terminalClosed = false;
    this.openSocket(networkId);
  }

  /**
   * Cleanly closes the connection and suppresses any reconnect. Safe to call when
   * already closed or still handshaking (falls back to a hard `terminate`). Use
   * when switching networks or quitting.
   */
  public disconnect(code = 1000, reason = 'client disconnect'): void {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.clearIdleWatchdog();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      // Only a socket that is OPEN can close cleanly; CONNECTING sockets throw on
      // `close` (the handshake never completed), so we terminate those instead.
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(code, reason);
        } else if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
      } catch {
        try {
          socket.terminate();
        } catch {
          // Best effort — the 'close' event (or none) will fire regardless.
        }
      }
    }
    this.setStatus('idle');
  }

  /**
   * Forces an immediate reconnect: drops the current socket (even one that
   * still looks healthy) and reconnects without the backoff delay (defect
   * 7f4cef31). Called on system resume / network-online because a socket that
   * lived through a sleep is often half-open — no `close`/`error` will ever
   * arrive, so passive detection alone is too slow. Resets the attempt counter
   * (each system event grants a fresh reconnect budget). No-op when the client
   * was torn down by the user (`disconnect`) or terminally rejected
   * (4401/4404 — membership/auth lost, reconnecting is pointless until the
   * user re-opens the network).
   */
  public forceReconnect(): void {
    if (this.manualClose || this.terminalClosed) return;
    const networkId = this.getNetworkId();
    if (networkId === null) return;
    this.clearReconnectTimer();
    this.clearIdleWatchdog();
    this.reconnectAttempts = 0;
    const stale = this.socket;
    this.socket = null;
    if (stale !== null) {
      try {
        // Works for OPEN and CONNECTING sockets alike; the late 'close' of the
        // abandoned socket is ignored by the stale-socket guard in openSocket.
        stale.terminate();
      } catch {
        // best effort — the guard makes the outcome irrelevant
      }
    }
    void this.openSocket(networkId);
  }

  // -------------------------------------------------------------------------
  // last_seq persistence (client_meta.last_seq as JSON map, 11 §1.3)
  // -------------------------------------------------------------------------

  /** Returns the stored `last_seq` for the given network (0 when fresh). */
  public getLastSeq(networkId: string): number {
    const map = this.readSeqMap();
    const stored = map[networkId];
    return typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
  }

  /**
   * Persists `last_seq` for the network. Called synchronously on every received
   * event so the position is never lost across crashes.
   */
  public setLastSeq(networkId: string, seq: number): void {
    const map = this.readSeqMap();
    const prev = map[networkId];
    // Monotonic guard: never rewind (avoids re-replay races).
    if (typeof prev === 'number' && seq < prev) return;
    map[networkId] = seq;
    this.localDb.setMeta(CLIENT_META_KEY.LAST_SEQ, JSON.stringify(map));
  }

  /** Reads and parses the `client_meta.last_seq` JSON map (empty when absent). */
  private readSeqMap(): Record<string, number> {
    const raw = this.localDb.getMeta(CLIENT_META_KEY.LAST_SEQ);
    if (raw === null) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, number>;
      }
    } catch {
      // Corrupt JSON — start fresh.
    }
    return {};
  }

  // -------------------------------------------------------------------------
  // socket lifecycle
  // -------------------------------------------------------------------------

  /** Creates and wires a new WebSocket for `networkId`. */
  private async openSocket(networkId: string): Promise<void> {
    this.setStatus(this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting');
    const url = `${this.baseUrl}/api/v1/realtime?network_id=${encodeURIComponent(networkId)}`;
    const clientId = this.getClientId();
    // Client-Id is sent both as a header (04-realtime.md §2) and as a query param
    // (11-settings-and-state.md §1.1) for compatibility with either server path.
    const urlWithClient = `${url}&client_id=${encodeURIComponent(clientId)}`;
    const apiKey = await this.getApiKey();

    // The key resolution above is awaited; a concurrent `disconnect()` may have
    // flipped `manualClose` in the meantime. Bail out and tear down the socket we
    // are about to create so it never lingers as `this.socket`.
    if (this.manualClose) return;

    const socket = new this.WebSocketCtor(urlWithClient, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Client-Id': clientId,
      },
    });
    // Re-check after construction: another disconnect could have raced.
    if (this.manualClose) {
      try {
        socket.close();
      } catch {
        // ignore — best effort teardown
      }
      return;
    }
    this.socket = socket;

    socket.once('open', () => this.onOpen(networkId));
    socket.on('message', (data) => this.onMessage(data));
    socket.on('ping', (data) => this.onWsPing(data));
    socket.on('pong', () => this.onWsPong());
    // Stale-socket guard: `forceReconnect()` may have replaced `this.socket`
    // already; a late `close`/`error` from the abandoned socket must not null
    // the successor or trigger a spurious reconnect (defect 7f4cef31).
    socket.once('close', (code, reason) => {
      if (this.socket === socket) this.onClose(code, reason);
    });
    socket.on('error', (err) => {
      if (this.socket === socket) this.guardedEmitError(err);
    });
  }

  /** Called when the socket completes the handshake. Sends `resume`. */
  private onOpen(networkId: string): void {
    this.reconnectAttempts = 0;
    this.setStatus('connected');
    // Arm the receive-idle watchdog: a healthy server pings every 30 s, so
    // prolonged silence after `open` means the socket is half-open.
    this.armIdleWatchdog();
    const lastSeq = this.getLastSeq(networkId);
    this.sendRaw(JSON.stringify({ type: 'resume', last_seq: lastSeq }));
  }

  /**
   * Parses an incoming text frame. Application-level `ping` is answered with
   * `pong`; `resume.stale` is re-emitted; everything else is treated as a
   * real-time event: parsed, re-emitted, and `last_seq` advanced.
   */
  private onMessage(data: WebSocket.RawData): void {
    // Any inbound frame proves liveness — re-arm the idle watchdog before
    // even trying to parse (malformed frames count too, defect 7f4cef31).
    this.armIdleWatchdog();
    let payload: unknown;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      // Ignore malformed frames — the server guarantees JSON.
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    // Application-level control frames. We deliberately compare `type` as a
    // string rather than narrowing via `RealtimeServerControlMessage`: the spec
    // (04-realtime.md §2.1) has the *client* send `{type:'ping'}` and the server
    // answer with `{type:'pong'}`, but task G6 additionally requires the client
    // to answer an incoming `{type:'ping'}` from the server for robustness. The
    // shared union does not model that direction, so we treat `type` loosely.
    const obj = payload as { type?: string };
    if (obj.type === 'ping') {
      this.sendRaw(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (obj.type === 'pong') return;
    if (obj.type === 'resume.stale') {
      const ctrl = payload as Partial<RealtimeServerControlMessage> & { last_seq?: unknown };
      const lastSeq = ctrl.last_seq;
      if (typeof lastSeq === 'number') {
        // Advance last_seq to the server's head so the next resume doesn't loop.
        const networkId = this.getNetworkId();
        if (networkId) this.setLastSeq(networkId, lastSeq);
        this.emitTyped('stale', lastSeq);
      }
      return;
    }
    if (obj.type === 'layer.switched' || obj.type === 'layer.deleted') {
      const ctrl = payload as { layer?: { id?: unknown; title?: unknown } };
      if (ctrl.layer !== undefined && typeof ctrl.layer.id === 'string') {
        // A layer switch/deletion invalidates the entire visible state
        // (13-layers.md §12) — the session's own writes from now on resolve
        // in a different layer, so subscribers must resync fully.
        this.emitTyped('layer-control', {
          kind: obj.type === 'layer.switched' ? 'switched' : 'deleted',
          layer: { id: ctrl.layer.id, title: String(ctrl.layer.title ?? '') },
        });
      }
      return;
    }

    // Real-time event envelope (RealtimeEvent<E>). Validate the minimum shape.
    const evt = payload as AnyRealtimeEvent;
    if (
      typeof evt.type !== 'string' ||
      typeof evt.seq !== 'number' ||
      typeof evt.network_id !== 'string'
    ) {
      return;
    }
    const networkId = this.getNetworkId();
    if (networkId) this.setLastSeq(networkId, evt.seq);
    this.emitTyped('event', evt);
  }

  /**
   * Handles a WS-level protocol `ping` frame. `ws` already answers with a `pong`
   * automatically; the hook only re-arms the idle watchdog (any inbound frame
   * proves liveness — defect 7f4cef31).
   */
  private onWsPing(_data: Buffer): void {
    this.armIdleWatchdog();
  }

  /** WS-level `pong` from the server — re-arms the idle watchdog (7f4cef31). */
  private onWsPong(): void {
    this.armIdleWatchdog();
  }

  /** Handles a socket close — terminal codes vs reconnectable. */
  private onClose(code: number, _reason: Buffer): void {
    this.socket = null;
    this.clearIdleWatchdog();
    if (this.manualClose) return; // user asked to leave; do not reconnect.

    if (code === REALTIME_CLOSE_CODES.UNAUTHORIZED) {
      this.terminalClosed = true;
      this.setStatus('offline');
      this.emitTyped('unauthorized');
      return;
    }
    if (code === REALTIME_CLOSE_CODES.NOT_FOUND) {
      this.terminalClosed = true;
      this.setStatus('offline');
      this.emitTyped('not-found');
      return;
    }
    // Reconnectable close.
    this.scheduleReconnect();
  }

  /** Schedules the next reconnect attempt with capped exponential full-jitter. */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.setStatus('offline');
      getClientLog()?.error('ws', 'reconnect budget exhausted', {
        network: this.getNetworkId() ?? '',
      });
      this.emitTyped('error', new Error('Превышен лимит попыток реконнекта real-time.'));
      return;
    }
    this.setStatus('reconnecting');
    this.reconnectAttempts++;
    const ceiling = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
    );
    const delay = Math.floor(this.random() * ceiling);
    // Journal: reconnect with backoff (task f051bf95 §3) — INFO, flag-gated.
    getClientLog()?.info('ws', 'reconnect scheduled', {
      network: this.getNetworkId() ?? '',
      attempt: this.reconnectAttempts,
      backoff_ms: delay,
    });
    this.clearReconnectTimer();
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      const networkId = this.getNetworkId();
      if (networkId === null || this.manualClose) {
        this.setStatus('idle');
        return;
      }
      if (this.socket === null) {
        void this.openSocket(networkId);
      }
    }, delay);
  }

  /** Sends a raw string frame, guarded against a dead socket. */
  private sendRaw(payload: string): void {
    if (this.socket === null) return;
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(payload, (err) => {
      if (err) this.guardedEmitError(err);
    });
  }

  /** Cancels any pending reconnect timer. */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * (Re-)arms the receive-idle watchdog (defect 7f4cef31). Every inbound frame
   * — app-level or protocol-level — calls this; a single deadline timer then
   * covers the gap until the next frame. When it fires, the socket is presumed
   * half-open (OS sleep / network switch swallowed the server's close) and is
   * hard-terminated, routing into the standard close → backoff-reconnect →
   * `resume` path.
   */
  private armIdleWatchdog(): void {
    this.clearIdleWatchdog();
    this.idleTimer = this.setTimeoutFn(() => {
      this.idleTimer = null;
      this.onIdleTimeout();
    }, this.idleTimeoutMs);
    // Never hold the process (or the test runner) alive on its own.
    this.idleTimer.unref?.();
  }

  /** Cancels the receive-idle watchdog, if armed. */
  private clearIdleWatchdog(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** No frame for `idleTimeoutMs` — the socket is half-open; terminate it. */
  private onIdleTimeout(): void {
    if (this.manualClose) return;
    const socket = this.socket;
    if (socket === null) return;
    // Journal: watchdog fired (task f051bf95 §3) — WARN, flag-gated.
    getClientLog()?.warn('ws', 'receive-idle watchdog fired', {
      network: this.getNetworkId() ?? '',
      idle_ms: this.idleTimeoutMs,
    });
    this.guardedEmitError(
      new Error(
        `Realtime: нет данных от сервера ${Math.round(this.idleTimeoutMs / 1000)} с ` +
          '(half-open после сна/смены сети?) — соединение переустанавливается.',
      ),
    );
    try {
      // Hard drop: emits 'close' (1006) → scheduleReconnect → fresh resume.
      socket.terminate();
    } catch {
      // The socket died between the check and the call; its own 'close' takes
      // care of the reconnect.
    }
  }

  /** Updates status and re-emits when it actually changes. */
  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    // Journal: every status transition (task f051bf95 §3) — INFO, flag-gated.
    getClientLog()?.info('ws', 'status changed', {
      network: this.getNetworkId() ?? '',
      status,
    });
    this.emitTyped('status', status);
  }

  /**
   * Re-emits a low-level socket error only when a listener is attached. Node's
   * {@link EventEmitter} throws an uncaught exception on an `'error'` event with
   * no listeners; the socket error is already consumed by the reconnect/close
   * logic, so we never want to crash the process when nobody is logging.
   */
  private guardedEmitError(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emitTyped('error', err);
    }
  }
}

/**
 * Normalises a base URL to a `ws://`/`wss://` scheme. Existing WebSocket schemes
 * are kept; `http` → `ws`, `https` → `wss`. Trailing slash stripped.
 */
export function normaliseWsUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '');
  if (url.startsWith('http://')) url = `ws://${url.slice('http://'.length)}`;
  else if (url.startsWith('https://')) url = `wss://${url.slice('https://'.length)}`;
  return url;
}

/**
 * Generates a fresh `Client-Request-Id` UUIDv4. Re-exported from the net layer so
 * IPC handlers (G7) do not need to reach into `node:crypto` directly.
 */
export function newClientRequestId(): string {
  return randomUUID();
}
