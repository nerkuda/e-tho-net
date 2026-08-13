/**
 * In-memory brute-force protection for API-key authentication
 * (task B8, docs/06-auth.md §9).
 *
 * Counts failed (401) authentication attempts per `(ip, key_prefix)` bucket over
 * a rolling 1-minute window. Once the configured threshold
 * (`AUTH_DEFAULTS.BAD_ATTEMPTS_PER_MINUTE`, default 10) is exceeded, the bucket
 * is banned for `AUTH_DEFAULTS.BAN_MINUTES` (default 5) minutes; further
 * requests from a banned bucket get HTTP 429 without touching the key store.
 *
 * Single-process MVP only — the map lives in memory and is not shared. The
 * state is best-effort: losing it (restart) merely resets the counters.
 */

import { AUTH_DEFAULTS } from '@etn/shared';

/** Composite key for a failure bucket: client IP plus the key prefix (or sentinel). */
export type RateBucketKey = string;

/** Sentinel used when the supplied token is malformed (no prefix derivable). */
export const NO_PREFIX = '__noprefix__';

/** Window length over which failures are tallied, in milliseconds. */
const WINDOW_MS = 60_000;

/** Internal failure-counter entry. */
interface CounterEntry {
  /** First failure timestamp of the current window (epoch ms). */
  windowStart: number;
  /** Number of failures since {@link CounterEntry.windowStart}. */
  count: number;
}

/** Internal ban entry. */
interface BanEntry {
  /** Epoch ms until which the bucket is banned. */
  until: number;
}

/** Build the composite bucket key. Empty values collapse to the sentinels. */
export function bucketKey(ip: string, keyPrefix: string | null): RateBucketKey {
  const ipPart = ip.length > 0 ? ip : '0.0.0.0';
  const prefixPart = keyPrefix !== null && keyPrefix.length > 0 ? keyPrefix : NO_PREFIX;
  return `${ipPart}:${prefixPart}`;
}

/** Result returned by {@link AuthRateLimiter.recordFailure} on ban-trigger. */
export interface RateLimitResult {
  /** True when this failure crossed the threshold and the bucket is now banned. */
  banned: boolean;
  /** Seconds until the ban expires (0 when not banned). */
  retryAfterSeconds: number;
}

/**
 * Sliding-window failure counter + ban store for authentication attempts.
 *
 * Construct once per server process; {@link AuthRateLimiter.cleanup} can be
 * called periodically to evict expired entries (optional, entries self-expire
 * on read).
 */
export class AuthRateLimiter {
  private readonly threshold: number;
  private readonly banMs: number;
  private readonly counters = new Map<RateBucketKey, CounterEntry>();
  private readonly bans = new Map<RateBucketKey, BanEntry>();

  constructor(
    threshold: number = AUTH_DEFAULTS.BAD_ATTEMPTS_PER_MINUTE,
    banMinutes: number = AUTH_DEFAULTS.BAN_MINUTES,
  ) {
    this.threshold = threshold;
    this.banMs = banMinutes * 60_000;
  }

  /** Current threshold (tests / introspection). */
  getThreshold(): number {
    return this.threshold;
  }

  /**
   * Whether the bucket is currently banned.
   *
   * @param now - epoch ms; defaults to `Date.now()`.
   */
  isBanned(key: RateBucketKey, now: number = Date.now()): boolean {
    const ban = this.bans.get(key);
    if (ban === undefined) {
      return false;
    }
    if (ban.until <= now) {
      this.bans.delete(key);
      return false;
    }
    return true;
  }

  /** Seconds until the ban on `key` expires (0 when not banned). */
  retryAfterSeconds(key: RateBucketKey, now: number = Date.now()): number {
    const ban = this.bans.get(key);
    if (ban === undefined || ban.until <= now) {
      return 0;
    }
    return Math.ceil((ban.until - now) / 1000);
  }

  /**
   * Record a failed authentication for the bucket. When the window's failure
   * count crosses the threshold, the bucket is banned for the ban duration.
   */
  recordFailure(key: RateBucketKey, now: number = Date.now()): RateLimitResult {
    const entry = this.counters.get(key);
    let count: number;
    if (entry === undefined || now - entry.windowStart >= WINDOW_MS) {
      // New window.
      this.counters.set(key, { windowStart: now, count: 1 });
      count = 1;
    } else {
      entry.count += 1;
      count = entry.count;
    }

    if (count > this.threshold) {
      const until = now + this.banMs;
      this.bans.set(key, { until });
      // Reset the counter so a fresh window starts after the ban.
      this.counters.delete(key);
      return { banned: true, retryAfterSeconds: Math.ceil(this.banMs / 1000) };
    }
    return { banned: false, retryAfterSeconds: 0 };
  }

  /** Clear any failure state for the bucket after a successful authentication. */
  clear(key: RateBucketKey): void {
    this.counters.delete(key);
    this.bans.delete(key);
  }

  /** Evict expired counters/bans. Safe to call from a periodic timer. */
  cleanup(now: number = Date.now()): void {
    for (const [key, entry] of this.counters) {
      if (now - entry.windowStart >= WINDOW_MS) {
        this.counters.delete(key);
      }
    }
    for (const [key, ban] of this.bans) {
      if (ban.until <= now) {
        this.bans.delete(key);
      }
    }
  }
}
