/**
 * Structured logging entry point (pino).
 *
 * The default {@link logger} reads `ETN_LOG_LEVEL` once at module load so any
 * code path can import it without explicit initialisation. Callers that need a
 * child logger with a different level (e.g. verbose CLI output) use
 * {@link createLogger}.
 *
 * See docs/01-architecture.md §4 and task B1.
 */

import pino, { type Logger } from 'pino';

export type { Logger };

/** Fallback level when `ETN_LOG_LEVEL` is unset/empty. */
const DEFAULT_LEVEL = 'info';

/** Level resolved from the environment at module load (never throws). */
const ENV_LEVEL = process.env.ETN_LOG_LEVEL?.trim() || DEFAULT_LEVEL;

/**
 * Process-wide logger. Uses pino's JSON output to stdout — suitable for
 * production log aggregation and local inspection with `pino-pretty`.
 */
export const logger: Logger = pino({ level: ENV_LEVEL });

/**
 * Build a fresh logger with an explicit level. Use for scoped contexts where the
 * ambient {@link logger} level is inappropriate.
 *
 * @param level - pino level: trace | debug | info | warn | error | fatal | silent.
 */
export function createLogger(level: string): Logger {
  return pino({ level });
}
