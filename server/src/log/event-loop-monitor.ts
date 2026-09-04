/**
 * Event-loop lag monitor for the file journal (task 1dd33e23 §3).
 *
 * `better-sqlite3` is synchronous: a slow query blocks the loop and every
 * concurrent REST/WS/MCP call with it — the prime suspect behind the
 * intermittent 3–10 s client freezes this journal exists to diagnose. The
 * monitor samples the loop with a repeating timer: when a tick fires later
 * than {@link LAG_WARN_THRESHOLD_MS} past its deadline, a WARN entry lands in
 * the journal (only while logging is enabled — a lag spike alone is not an
 * error).
 *
 * Start it in `createServer`; the returned `stop()` is wired into `onClose`.
 */

import type { FileLog } from './file-log.js';

/** Warn when a timer tick is this late, milliseconds. */
export const LAG_WARN_THRESHOLD_MS = 100;

/** Sampling interval, milliseconds. */
const SAMPLE_INTERVAL_MS = 500;

/** Options (testability). */
export interface EventLoopMonitorOptions {
  /** Sampling interval override (tests shorten it). */
  intervalMs?: number;
  /** Threshold override (tests shorten it). */
  thresholdMs?: number;
  /** High-resolution clock override. */
  now?: () => number;
}

/**
 * Start sampling; returns the stop function (clears the timer).
 * The timer is `unref`-ed so it never holds the process open.
 */
export function startEventLoopMonitor(
  fileLog: FileLog,
  options?: EventLoopMonitorOptions,
): () => void {
  const interval = options?.intervalMs ?? SAMPLE_INTERVAL_MS;
  const threshold = options?.thresholdMs ?? LAG_WARN_THRESHOLD_MS;
  // Bind eagerly: a detached `performance.now` throws ERR_INVALID_THIS.
  const now = options?.now ?? (() => performance.now());

  let last = now();
  const timer = setInterval(() => {
    const current = now();
    const lag = current - last - interval;
    last = current;
    if (lag >= threshold) {
      fileLog.warn('eventloop', 'event loop lag detected', { lag_ms: Math.round(lag) });
    }
  }, interval);
  timer.unref?.();

  return () => clearInterval(timer);
}
