/**
 * Periodic `event_log` retention job (task E2, docs/04-realtime.md §6).
 *
 * The event log buffers the last {@link REALTIME_DEFAULTS.EVENT_LOG_MAX_ROWS}
 * events (or {@link REALTIME_DEFAULTS.EVENT_LOG_TTL_HOURS} hours) per network
 * for resume/replay. Rows outside the window are dropped by {@link
 * SystemDb.pruneOldEvents}; a gap in the retained window is exactly what makes
 * a client's `resume { last_seq }` answer with `resume.stale`.
 *
 * Started once per server process (see `http/server.ts`) and stopped on
 * `onClose`. The sweep timer is unref'ed so it never keeps the process alive.
 */

import { REALTIME_DEFAULTS } from '@etn/shared';

import type { SystemDb } from '../db/system-db.js';
import type { Logger } from '../logger.js';

/** Default sweep interval (1 hour). */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

/** Tunables for {@link startEventLogCleanup} (tests use shortened intervals). */
export interface EventLogCleanupOptions {
  /** Sweep interval in milliseconds. */
  intervalMs?: number;
  /** Retention window in hours (04-realtime.md §6). */
  ttlHours?: number;
  /** Number of newest rows per network that are always kept. */
  maxRows?: number;
}

/**
 * Start the retention sweep: run once immediately, then every `intervalMs`.
 *
 * @returns a stop function that cancels the interval timer.
 */
export function startEventLogCleanup(
  systemDb: SystemDb,
  log?: Logger,
  options?: EventLogCleanupOptions,
): () => void {
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const ttlHours = options?.ttlHours ?? REALTIME_DEFAULTS.EVENT_LOG_TTL_HOURS;
  const maxRows = options?.maxRows ?? REALTIME_DEFAULTS.EVENT_LOG_MAX_ROWS;

  const sweep = (): void => {
    for (const networkId of systemDb.listEventLogNetworkIds()) {
      try {
        const removed = systemDb.pruneOldEvents(networkId, maxRows, ttlHours);
        if (removed > 0) {
          log?.info({ networkId, removed }, 'event_log pruned');
        }
      } catch (err) {
        // A failing sweep must not stop the job (or the server) from retrying.
        log?.warn({ err, networkId }, 'event_log prune failed');
      }
    }
  };

  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
