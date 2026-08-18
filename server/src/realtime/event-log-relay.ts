/**
 * Event-log relay — live delivery of events written by foreign processes
 * (docs/04-realtime.md §5).
 *
 * The {@link PubSub} broker is in-memory: only events emitted in this process
 * reach the WebSocket gateway. Events written by an external writer (the stdio
 * MCP CLI `etn mcp` runs as a separate process over the same `_system.db`) land
 * in `event_log` but never reach the live channel. The relay closes the gap by
 * polling the log periodically and publishing every event this process has not
 * delivered yet:
 *
 *   * `start()` seeds the scan position at the current log head per network, so
 *     the pre-start history is never broadcast (clients replay it via
 *     `resume`);
 *   * a broker subscription marks every event published in-process (REST/MCP
 *     HTTP) as delivered, so the poll never re-broadcasts own writes — while a
 *     foreign event sitting *between* two in-process events is still caught
 *     (the scan advances by the last polled seq, not the last seen one);
 *   * delivery latency for foreign writes is bounded by `pollIntervalMs`.
 */

import type { AnyRealtimeEvent } from '@etn/shared';

import type { Logger } from '../logger.js';
import type { PubSub } from './pubsub.js';

/** Minimal SystemDb surface the relay needs (kept narrow for tests). */
export interface EventLogReader {
  listAllNetworkIds(): string[];
  getMaxEventSeq(networkId: string): number | null;
  readEventsAfter(networkId: string, afterSeq: number, limit: number): AnyRealtimeEvent[];
}

/** Tunables (shortened intervals make tests fast). */
export interface EventLogRelayOptions {
  /** How often the relay scans the event log for foreign writes, ms. */
  pollIntervalMs: number;
  /** Max events read per network per scan (bounded replay). */
  batchLimit: number;
}

/** Production defaults. */
export const DEFAULT_EVENT_LOG_RELAY_OPTIONS: EventLogRelayOptions = {
  pollIntervalMs: 300,
  batchLimit: 500,
};

/** Dependencies injected into {@link EventLogRelay}. */
export interface EventLogRelayDeps {
  systemDb: EventLogReader;
  /** The same in-process broker the WebSocket gateway subscribes to. */
  pubsub: PubSub;
  /** Optional application logger. */
  logger?: Logger;
  /** Partial option overrides (tests). */
  options?: Partial<EventLogRelayOptions>;
}

/** Composite key of one delivered event. */
function eventKey(networkId: string, seq: number): string {
  return `${networkId}:${seq}`;
}

/**
 * Polls the per-network event log and publishes foreign events to the broker.
 * Construct once per server process; {@link start} it on boot and {@link stop}
 * it on shutdown (the timer is unref'd so it never keeps the process alive).
 */
export class EventLogRelay {
  private readonly systemDb: EventLogReader;
  private readonly pubsub: PubSub;
  private readonly logger?: Logger;
  private readonly options: EventLogRelayOptions;

  /** `networkId:seq` of every event already delivered by this process. */
  private readonly published = new Set<string>();
  /** Per-network seq up to which the last scan has read the log. */
  private readonly lastPolled = new Map<string, number>();
  /** Broker subscriptions per known network (unsubscribe on stop). */
  private readonly unsubscribers = new Map<string, () => void>();
  private timer: NodeJS.Timeout | null = null;
  private pollCountValue = 0;

  constructor(deps: EventLogRelayDeps) {
    this.systemDb = deps.systemDb;
    this.pubsub = deps.pubsub;
    this.logger = deps.logger;
    this.options = { ...DEFAULT_EVENT_LOG_RELAY_OPTIONS, ...deps.options };
  }

  /** Number of completed scans (tests). */
  pollCount(): number {
    return this.pollCountValue;
  }

  /** Subscribe to known networks and start the periodic scan. */
  start(): void {
    this.syncNetworks();
    // Seed the scan position at the log head: pre-start history must not be
    // broadcast live — clients replay it through `resume` on connect.
    for (const networkId of this.systemDb.listAllNetworkIds()) {
      this.lastPolled.set(networkId, this.systemDb.getMaxEventSeq(networkId) ?? 0);
    }
    this.timer = setInterval(() => this.poll(), this.options.pollIntervalMs);
    this.timer.unref?.();
  }

  /** Stop the timer and drop every broker subscription. */
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.published.clear();
    this.lastPolled.clear();
  }

  /** Attach a broker subscription to every known network (new networks too). */
  private syncNetworks(): void {
    for (const networkId of this.systemDb.listAllNetworkIds()) {
      if (this.unsubscribers.has(networkId)) continue;
      const unsubscribe = this.pubsub.subscribe(networkId, (event) => {
        this.published.add(eventKey(networkId, event.seq));
      });
      this.unsubscribers.set(networkId, unsubscribe);
    }
  }

  /** Scan every network's log once and publish events not yet delivered. */
  private poll(): void {
    this.pollCountValue += 1;
    this.syncNetworks();
    for (const networkId of this.systemDb.listAllNetworkIds()) {
      // Networks discovered after start() scan from 0: their events were all
      // written after this relay was alive, so none of them is pre-start
      // history — everything not yet delivered gets broadcast.
      const after = this.lastPolled.get(networkId) ?? 0;
      let events: AnyRealtimeEvent[];
      try {
        events = this.systemDb.readEventsAfter(networkId, after, this.options.batchLimit);
      } catch (err) {
        this.logger?.error({ err, networkId }, 'event-log relay: scan failed');
        continue;
      }
      let last = after;
      for (const event of events) {
        last = event.seq;
        const key = eventKey(networkId, event.seq);
        // Own writes reached the broker already (marked by the subscription);
        // foreign writes are broadcast exactly once, in seq order.
        if (this.published.has(key)) continue;
        this.published.add(key);
        try {
          this.pubsub.publish(networkId, event);
        } catch (err) {
          this.logger?.warn({ err, networkId, seq: event.seq }, 'event-log relay: publish failed');
        }
      }
      if (last > after) this.lastPolled.set(networkId, last);
    }
  }
}
