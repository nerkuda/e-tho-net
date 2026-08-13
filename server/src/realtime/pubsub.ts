/**
 * In-memory, per-network pub/sub broker (task B10, docs/01-architecture.md §5,
 * 04-realtime.md §3, §5).
 *
 * The domain layer publishes a fully-formed {@link RealtimeEvent} (seq already
 * assigned, see task E2) to this broker right after committing its transaction.
 * Subscribers are attached by the WebSocket gateway (phase E) and by internal
 * listeners (e.g. the membership cache invalidator in task B9 wired in B13).
 *
 * MVP scope: a single process — events never leave memory. The contract is
 * intentionally small (`publish` / `subscribe` / `unsubscribe`) so a future
 * Redis Pub/Sub backend can drop in without touching callers.
 */

import { EventEmitter } from 'node:events';

import type {
  AnyRealtimeEvent,
  RealtimeAudience,
  RealtimeEvent,
  RealtimeEventType,
} from '@etn/shared';

declare module 'fastify' {
  interface FastifyInstance {
    /** Shared real-time broker (task B10). */
    pubsub: PubSub;
  }
}

/** Listener invoked synchronously when an event is published to a channel. */
export type RealtimeListener<E extends RealtimeEventType = RealtimeEventType> = (
  event: RealtimeEvent<E>,
) => void;

/** Build the internal channel name for a network id. */
function channelOf(networkId: string): string {
  return `network:${networkId}`;
}

/**
 * Typed in-memory broker routing {@link RealtimeEvent}s by `network_id`.
 *
 * Construct once per server process. `publish` is synchronous and delivers to
 * all current subscribers before returning; listeners must not block (delegate
 * heavy work to a queue). Listener errors are caught and logged so one bad
 * subscriber cannot break delivery to others.
 */
export class PubSub {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many WebSocket connections may subscribe to the same network.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Publish `event` to every subscriber of `event.network_id`.
   *
   * The `networkId` argument is accepted explicitly for clarity but must match
   * `event.network_id`; a mismatch is rejected to prevent routing mistakes.
   */
  publish(networkId: string, event: AnyRealtimeEvent): void {
    if (event.network_id !== networkId) {
      throw new Error(
        `pubsub: network_id mismatch (channel=${networkId}, event.network_id=${event.network_id})`,
      );
    }
    this.emitter.emit(channelOf(networkId), event);
  }

  /**
   * Subscribe to every event of `networkId`. Returns an `unsubscribe` function.
   *
   * The optional `type`/`audience` filters narrow delivery without requiring the
   * listener to branch.
   */
  subscribe<E extends RealtimeEventType>(
    networkId: string,
    listener: RealtimeListener<E>,
    filter?: { type?: E; audience?: RealtimeAudience },
  ): () => void {
    const channel = channelOf(networkId);
    const wrapped = (event: AnyRealtimeEvent): void => {
      if (filter?.type !== undefined && event.type !== filter.type) {
        return;
      }
      if (filter?.audience !== undefined && event.audience !== filter.audience) {
        return;
      }
      try {
        listener(event as RealtimeEvent<E>);
      } catch (err) {
        // A faulty listener must not interrupt delivery to others.
        console.error('pubsub: listener threw', err);
      }
    };
    this.emitter.on(channel, wrapped);
    return () => {
      this.emitter.off(channel, wrapped);
    };
  }

  /** Remove a previously returned subscription handle (alias for clarity). */
  unsubscribe(handle: () => void): void {
    handle();
  }

  /** Number of listeners currently attached to `networkId` (introspection/tests). */
  listenerCount(networkId: string): number {
    return this.emitter.listenerCount(channelOf(networkId));
  }

  /** Drop every subscription. Mainly for tests; the server keeps one broker. */
  clear(): void {
    this.emitter.removeAllListeners();
  }
}
