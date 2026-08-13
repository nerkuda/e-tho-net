/**
 * Minimal strictly-typed wrapper over Node {@link EventEmitter} (workplan G6).
 *
 * Node's `EventEmitter` is intentionally stringly-typed; this helper gives the
 * real-time client a checked `emitTyped`/`onTyped` surface so that event names and
 * listener argument tuples cannot drift apart at compile time, without pulling in a
 * third-party typed-emitter dependency.
 */
import { EventEmitter } from 'node:events';

/**
 * Maps event names to their listener argument tuples, e.g.
 * `{ event: [AnyRealtimeEvent]; status: [RealtimeStatus] }`.
 */
export type EventMap = Record<string, unknown[]>;

/**
 * Strictly-typed EventEmitter. The underlying {@link EventEmitter} is untouched;
 * the typed methods simply narrow the accepted names/args. Existing
 * `EventEmitter` API (`removeListener`, `once`, `off`, …) remains available but
 * stringly-typed — callers should prefer the `*Typed` variants.
 */
export class TypedEmitter<E extends EventMap> extends EventEmitter {
  /** Typed variant of {@link EventEmitter.emit}. */
  public emitTyped<K extends keyof E & string>(event: K, ...args: E[K]): boolean {
    return this.emit(event, ...(args as unknown[]));
  }

  /** Typed variant of {@link EventEmitter.on}. */
  public onTyped<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void): this {
    return this.on(event, listener as (...args: unknown[]) => void);
  }

  /** Typed variant of {@link EventEmitter.off}. */
  public offTyped<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void): this {
    return this.off(event, listener as (...args: unknown[]) => void);
  }

  /** Typed variant of {@link EventEmitter.once}. */
  public onceTyped<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void): this {
    return this.once(event, listener as (...args: unknown[]) => void);
  }
}
