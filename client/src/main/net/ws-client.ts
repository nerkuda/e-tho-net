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
 *  - any other close/error triggers a fast reconnect: frequent attempts
 *    (0.5–1 s) for the first ~10 s, then the 2 → 4 → 8 → 15 s ladder with
 *    jitter; the attempt limit is gone — after ~60 s the status turns
 *    `offline`, but attempts keep going (defect de34b35b);
 *  - liveness (defect de34b35b): every inbound frame (event, WS ping, WS pong)
 *    stamps `lastFrameAt`. After 37 s of silence the client raises `suspect`
 *    and sends exactly one application `{type:'ping'}`; any frame within 3 s
 *    returns to `connected`, otherwise the socket is force-reconnected. The
 *    same probe runs when a user action hangs for 3 s (IPC layer). No periodic
 *    polling — the probe is on demand only;
 *  - receive-idle watchdog (defect 7f4cef31) stays as the last safety net:
 *    ~100 s without frames means half-open (OS sleep / network switch) and the
 *    socket is terminated;
 *  - close `1001` + reason `server shutdown` raises status detail
 *    `server-restart` («Сервер перезапускается…») and reconnects immediately;
 *    `1001` + `pong timeout` reconnects normally (the server is alive);
 *  - `resume.stale` (event-log window exceeded) is re-emitted as `stale` so the UI
 *    can trigger a full re-focus (04-realtime.md §6).
 *
 * `last_seq` is persisted per `(client_id, network_id)` in `client_meta.last_seq`
 * as a JSON map `{ [network_id]: seq }`. It is advanced synchronously on every
 * received event — the event "passed" on the wire even if the applier later
 * drops it as stale (11-settings-and-state.md §1.4).
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

/**
 * Fast reconnect window and ladder (defect de34b35b). The first ~10 s after a
 * drop use frequent 0.5–1 s attempts (a restarted server comes back quickly);
 * afterwards the delay grows 2 → 4 → 8 → 15 s with jitter.
 */
const FAST_RECONNECT_WINDOW_MS = 10_000;
/** Lower bound of a fast-window reconnect delay, ms. */
const FAST_RECONNECT_MIN_DELAY_MS = 500;
/** Upper bound of a fast-window reconnect delay, ms. */
const FAST_RECONNECT_MAX_DELAY_MS = 1_000;
/** Slow reconnect ladder, ms (applied with 50–100 % jitter). */
const RECONNECT_LADDER_MS = [2_000, 4_000, 8_000, 15_000] as const;
/** After this much unsuccessful outage the status becomes `offline` (red). */
const OFFLINE_AFTER_MS = 60_000;
/**
 * Silence threshold, ms (defect de34b35b). The server pings every 30 s, so
 * 37 s of silence means the ping was lost — raise `suspect` and probe.
 */
const SILENCE_THRESHOLD_MS = 37_000;
/** How long the liveness probe waits for any inbound frame, ms. */
const PROBE_DEADLINE_MS = 3_000;
/**
 * WebSocket handshake deadline, ms (defect de34b35b). `ws` has no handshake
 * timeout by default, so a hung TCP/upgrade would sit forever.
 */
const HANDSHAKE_TIMEOUT_MS = 5_000;
/**
 * Receive-idle watchdog, in milliseconds (defect 7f4cef31). The server pings
 * every 30 s (04-realtime.md §2.1), so a healthy connection is never silent
 * longer than one ping interval. When no frame of any kind arrives for 3
 * intervals + slack, the socket is presumed half-open (typical after OS sleep
 * or a network switch: the server already closed its side after the pong
 * timeout, but the FIN/RST never reached the client) and gets hard-terminated
 * so the regular close → reconnect → `resume` path takes over.
 */
const RECV_IDLE_TIMEOUT_MS = 100_000;

/** Connection status surfaced to the UI (07-client-electron.md §5.1; de34b35b). */
export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'suspect';

/**
 * Extra status qualifier shown to the user next to the status text (de34b35b).
 * A detail is not a separate status: `reconnecting` + `server-restart` renders
 * as «Сервер перезапускается…».
 */
export type RealtimeStatusDetail = 'server-restart';

/** Trigger of a liveness probe (de34b35b). */
export type LivenessProbeTrigger = 'silence' | 'action';

/** Typed event catalogue emitted by {@link RealtimeClient}. */
export interface RealtimeClientEvents extends EventMap {
  /** A real-time event received from the server (after parsing + last_seq update). */
  event: [event: AnyRealtimeEvent];
  /** Connection status changed (with an optional visual qualifier). */
  status: [status: RealtimeStatus, detail?: RealtimeStatusDetail];
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
  /** Optional timer-cancel override paired with {@link setTimeout}. */
  clearTimeout?: typeof clearTimeout;
  /** Optional clock override (for deterministic tests of the reconnect window). */
  now?: () => number;
  /**
   * Receive-idle watchdog timeout override, in milliseconds (defect 7f4cef31).
   * Defaults to {@link RECV_IDLE_TIMEOUT_MS}; tests use short values.
   */
  idleTimeoutMs?: number;
  /** Silence threshold before the liveness probe, ms (de34b35b). */
  silenceThresholdMs?: number;
  /** Liveness-probe deadline waiting for any frame, ms (de34b35b). */
  probeDeadlineMs?: number;
  /** WebSocket handshake deadline, ms (de34b35b). */
  handshakeTimeoutMs?: number;
  /** Time after which the status becomes `offline`, ms (de34b35b). */
  offlineAfterMs?: number;
  /** Duration of the fast 0.5–1 s reconnect window, ms (de34b35b). */
  fastReconnectWindowMs?: number;
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
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly silenceThresholdMs: number;
  private readonly probeDeadlineMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly offlineAfterMs: number;
  private readonly fastReconnectWindowMs: number;

  /** Active socket, or `null` when closed. */
  private socket: WebSocket | null = null;
  /** Current connection status. */
  private status: RealtimeStatus = 'idle';
  /** Visual qualifier of the current status (e.g. `server-restart`). */
  private statusDetail: RealtimeStatusDetail | null = null;
  /** Reconnect attempt counter (reset on a clean open). */
  private reconnectAttempts = 0;
  /** Attempts made after the fast window — index into the slow ladder. */
  private slowReconnectAttempts = 0;
  /** Start of the current outage, used for the fast window and `offline`. */
  private reconnectStartedAt: number | null = null;
  /** `true` once the current connection reached `open` (status naming). */
  private everOpened = false;
  /** Pending reconnect timer handle, or `null`. */
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** `true` while a user-initiated `disconnect()` is in progress (suppress reconnect). */
  private manualClose = false;
  /** Pending receive-idle watchdog timer, or `null` (defect 7f4cef31). */
  private idleTimer: NodeJS.Timeout | null = null;
  /** Pending silence-probe timer, or `null` (defect de34b35b). */
  private silenceTimer: NodeJS.Timeout | null = null;
  /** Pending probe-deadline timer, or `null` (defect de34b35b). */
  private probeTimer: NodeJS.Timeout | null = null;
  /** `true` after a terminal close (4401/4404) — suppresses forceReconnect. */
  private terminalClosed = false;
  /** Wall-clock time of the last inbound frame of any kind (de34b35b). */
  private lastFrameAt = 0;

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
    this.clearTimeoutFn = opts.clearTimeout ?? clearTimeout;
    this.now = opts.now ?? Date.now;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? RECV_IDLE_TIMEOUT_MS;
    this.silenceThresholdMs = opts.silenceThresholdMs ?? SILENCE_THRESHOLD_MS;
    this.probeDeadlineMs = opts.probeDeadlineMs ?? PROBE_DEADLINE_MS;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.offlineAfterMs = opts.offlineAfterMs ?? OFFLINE_AFTER_MS;
    this.fastReconnectWindowMs = opts.fastReconnectWindowMs ?? FAST_RECONNECT_WINDOW_MS;
    this.lastFrameAt = this.now();
  }

  /** Returns the current connection status. */
  public getStatus(): RealtimeStatus {
    return this.status;
  }

  /** Returns the current status qualifier, or `null` (de34b35b). */
  public getStatusDetail(): RealtimeStatusDetail | null {
    return this.statusDetail;
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
    this.everOpened = false;
    this.reconnectStartedAt = null;
    this.reconnectAttempts = 0;
    this.slowReconnectAttempts = 0;
    this.statusDetail = null;
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
    this.clearSilenceTimer();
    this.clearProbeTimer();
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
    this.everOpened = false;
    this.reconnectAttempts = 0;
    this.slowReconnectAttempts = 0;
    this.reconnectStartedAt = null;
    this.statusDetail = null;
    this.setStatus('idle');
  }

  /**
   * Forces an immediate reconnect: drops the current socket (even one that
   * still looks healthy) and reconnects without the backoff delay (defects
   * 7f4cef31, de34b35b). Called on system resume / network-online because a
   * socket that lived through a sleep is often half-open — no `close`/`error`
   * will ever arrive. Also called when a liveness probe gets no frame within
   * its deadline. Resets the outage window (each explicit trigger grants a
   * fresh fast-reconnect budget). No-op when the client was torn down by the
   * user (`disconnect`) or terminally rejected (4401/4404).
   */
  public forceReconnect(): void {
    if (this.manualClose || this.terminalClosed) return;
    const networkId = this.getNetworkId();
    if (networkId === null) return;
    this.clearReconnectTimer();
    this.clearIdleWatchdog();
    this.clearSilenceTimer();
    this.clearProbeTimer();
    this.reconnectAttempts = 0;
    this.slowReconnectAttempts = 0;
    this.reconnectStartedAt = this.now();
    this.statusDetail = null;
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
    // Immediate attempt, still announced as `reconnecting` (never a second
    // `connecting` after the first successful open).
    this.scheduleReconnect(0);
  }

  /**
   * Liveness probe (defect de34b35b). Sends exactly one application-level
   * `{type:'ping'}` and waits up to the probe deadline for ANY inbound frame;
   * a frame returns the status to `connected`, silence forces a reconnect.
   * No-op when the socket is not OPEN or the client is torn down; only one
   * probe runs at a time.
   */
  public probeLiveness(trigger: LivenessProbeTrigger): void {
    if (this.manualClose || this.terminalClosed) return;
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    if (this.probeTimer !== null) return; // one probe at a time

    getClientLog()?.info('ws', 'liveness probe', {
      network: this.getNetworkId() ?? '',
      trigger,
      silent_ms: this.now() - this.lastFrameAt,
    });
    this.setStatus('suspect');
    this.sendRaw(JSON.stringify({ type: 'ping' }));
    this.probeTimer = this.setTimeoutFn(() => {
      this.probeTimer = null;
      this.onProbeTimeout();
    }, this.probeDeadlineMs);
    this.probeTimer.unref?.();
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
    // `connecting` is reserved for the very first attempt of a session; after
    // a drop, a probe failure or a system trigger the user sees
    // «Переподключение…» (defect de34b35b).
    this.setStatus(this.everOpened ? 'reconnecting' : 'connecting', this.statusDetail ?? undefined);
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
      // `ws` has no handshake deadline by default: a hung TCP/upgrade would
      // sit until the OS timeout (defect de34b35b).
      handshakeTimeout: this.handshakeTimeoutMs,
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
    this.everOpened = true;
    this.reconnectAttempts = 0;
    this.slowReconnectAttempts = 0;
    this.reconnectStartedAt = null;
    this.setStatus('connected');
    // Start the liveness clock: the first server ping is expected within 30 s.
    this.noteFrame();
    const lastSeq = this.getLastSeq(networkId);
    this.sendRaw(JSON.stringify({ type: 'resume', last_seq: lastSeq }));
  }

  /**
   * Parses an incoming text frame. Application-level `ping` is answered with
   * `pong`; `resume.stale` is re-emitted; everything else is treated as a
   * real-time event: parsed, re-emitted, and `last_seq` advanced.
   */
  private onMessage(data: WebSocket.RawData): void {
    // Any inbound frame proves liveness — stamp the clock and close a pending
    // probe before even trying to parse (malformed frames count too).
    this.noteFrame();
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
    this.noteFrame();
  }

  /** WS-level `pong` from the server — proves liveness (7f4cef31, de34b35b). */
  private onWsPong(): void {
    this.noteFrame();
  }

  /**
   * Stamps the liveness clock on ANY inbound frame and re-arms the silence /
   * idle timers. A frame that lands while a probe is awaiting a pong proves
   * the connection is alive: the probe is cancelled and `suspect` returns to
   * `connected` without a reconnect (defect de34b35b).
   */
  private noteFrame(): void {
    this.lastFrameAt = this.now();
    if (this.probeTimer !== null) {
      this.clearProbeTimer();
      if (this.status === 'suspect' && this.socket !== null) this.setStatus('connected');
    }
    this.armSilenceTimer();
    this.armIdleWatchdog();
  }

  /** Handles a socket close — terminal codes vs reconnectable. */
  private onClose(code: number, reason: Buffer): void {
    this.socket = null;
    this.clearIdleWatchdog();
    this.clearSilenceTimer();
    this.clearProbeTimer();
    if (this.manualClose) return; // user asked to leave; do not reconnect.

    if (code === REALTIME_CLOSE_CODES.UNAUTHORIZED) {
      this.terminalClosed = true;
      this.statusDetail = null;
      this.setStatus('offline');
      this.emitTyped('unauthorized');
      return;
    }
    if (code === REALTIME_CLOSE_CODES.NOT_FOUND) {
      this.terminalClosed = true;
      this.statusDetail = null;
      this.setStatus('offline');
      this.emitTyped('not-found');
      return;
    }
    const reasonText = reason.toString();
    if (code === 1001 && reasonText === 'server shutdown') {
      // Planned server restart: tell the UI «Сервер перезапускается…» and
      // reconnect immediately instead of waiting for the silence threshold
      // (defect de34b35b).
      this.statusDetail = 'server-restart';
      this.reconnectStartedAt = this.now();
      this.reconnectAttempts = 0;
      this.slowReconnectAttempts = 0;
      this.scheduleReconnect(0);
      return;
    }
    // 1001 + `pong timeout` (the server is alive) and every unexpected close
    // take the normal reconnect path — no `server-restart` detail.
    this.scheduleReconnect();
  }

  /**
   * Schedules the next reconnect attempt (defect de34b35b): 0.5–1 s during the
   * first ~10 s of outage, then the 2 → 4 → 8 → 15 s ladder with jitter.
   * Attempts are unlimited; after {@link offlineAfterMs} the status is
   * `offline`, but the loop keeps retrying. `delayOverride` (0 from
   * `forceReconnect` / a planned server restart) skips the wait.
   */
  private scheduleReconnect(delayOverride?: number): void {
    const nowMs = this.now();
    if (this.reconnectStartedAt === null) this.reconnectStartedAt = nowMs;
    const since = nowMs - this.reconnectStartedAt;
    const offline = since >= this.offlineAfterMs;
    this.setStatus(
      offline ? 'offline' : 'reconnecting',
      offline ? undefined : (this.statusDetail ?? undefined),
    );
    this.reconnectAttempts++;

    let delay: number;
    if (delayOverride !== undefined) {
      delay = delayOverride;
    } else if (since < this.fastReconnectWindowMs) {
      delay =
        FAST_RECONNECT_MIN_DELAY_MS +
        Math.floor(this.random() * (FAST_RECONNECT_MAX_DELAY_MS - FAST_RECONNECT_MIN_DELAY_MS + 1));
    } else {
      this.slowReconnectAttempts++;
      const ceiling =
        RECONNECT_LADDER_MS[Math.min(this.slowReconnectAttempts - 1, RECONNECT_LADDER_MS.length - 1)]!;
      // Jitter 50–100 % of the step so clients do not stampede after a restart.
      delay = Math.floor(ceiling * (0.5 + this.random() * 0.5));
    }

    // Journal: reconnect with backoff (task f051bf95 §3) — INFO, flag-gated.
    getClientLog()?.info('ws', 'reconnect scheduled', {
      network: this.getNetworkId() ?? '',
      attempt: this.reconnectAttempts,
      since_outage_ms: since,
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
    // Never hold the process (or the test runner) alive on its own.
    this.reconnectTimer.unref?.();
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
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * (Re-)arms the silence probe (defect de34b35b): 37 s without any frame
   * raises `suspect` and sends a single application ping. Re-armed by every
   * inbound frame via {@link noteFrame}.
   */
  private armSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = this.setTimeoutFn(() => {
      this.silenceTimer = null;
      this.probeLiveness('silence');
    }, this.silenceThresholdMs);
    this.silenceTimer.unref?.();
  }

  /** Cancels the silence probe timer, if armed. */
  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      this.clearTimeoutFn(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /** Cancels the probe-deadline timer, if armed. */
  private clearProbeTimer(): void {
    if (this.probeTimer !== null) {
      this.clearTimeoutFn(this.probeTimer);
      this.probeTimer = null;
    }
  }

  /** No frame within the probe deadline — the socket is dead; reconnect. */
  private onProbeTimeout(): void {
    if (this.manualClose || this.terminalClosed) return;
    if (this.socket === null) return;
    getClientLog()?.warn('ws', 'liveness probe timeout', {
      network: this.getNetworkId() ?? '',
      silent_ms: this.now() - this.lastFrameAt,
    });
    this.forceReconnect();
  }

  /**
   * (Re-)arms the receive-idle watchdog (defect 7f4cef31). Every inbound frame
   * — app-level or protocol-level — calls this; a single deadline timer then
   * covers the gap until the next frame. When it fires, the socket is presumed
   * half-open (OS sleep / network switch swallowed the server's close) and is
   * hard-terminated, routing into the standard close → reconnect → `resume`
   * path. It stays the last safety net behind the 37 s probe.
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
      this.clearTimeoutFn(this.idleTimer);
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

  /** Updates status (and its visual detail) and re-emits when either changed. */
  private setStatus(status: RealtimeStatus, detail?: RealtimeStatusDetail): void {
    const nextDetail = detail ?? null;
    if (this.status === status && this.statusDetail === nextDetail) return;
    this.status = status;
    this.statusDetail = nextDetail;
    // Journal: every status transition (task f051bf95 §3) — INFO, flag-gated.
    getClientLog()?.info('ws', 'status changed', {
      network: this.getNetworkId() ?? '',
      status,
      ...(nextDetail === null ? {} : { detail: nextDetail }),
    });
    this.emitTyped('status', status, nextDetail ?? undefined);
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
