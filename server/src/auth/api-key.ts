/**
 * API-key generation, hashing and validation helpers (task B5,
 * docs/06-auth.md §2–3, §6).
 *
 * Key format: `etn_<32 hex>` (128 bits of entropy). The server stores only
 * `SHA-256(key)` in `api_keys.key_hash`; the full key is returned to the user
 * exactly once at creation. `key_prefix` (first 8 hex chars after `etn_`) is
 * stored for display (`etn_a1b2c3d4…`) without revealing the key.
 *
 * The actual lookup, disabled-key/owner enforcement and `last_used_at` update
 * live in {@link SystemDb.findApiKeyByHash} / {@link SystemDb.touchApiKeyUsed}
 * (task B4); this module provides the cryptographic primitives.
 */

import crypto from 'node:crypto';

import { API_KEY_PREFIX, API_KEY_PREFIX_LENGTH, API_KEY_RANDOM_LENGTH } from '@etn/shared';

/** Total length of a full API-key string: prefix + random hex. */
export const API_KEY_TOTAL_LENGTH = API_KEY_PREFIX.length + API_KEY_RANDOM_LENGTH;

/** Full key plus the derived material that must be persisted together. */
export interface GeneratedApiKey {
  /** Full key `etn_<32hex>` — returned to the caller exactly once. */
  key: string;
  /** SHA-256 hex digest of {@link GeneratedApiKey.key} (stored as `key_hash`). */
  keyHash: string;
  /** First {@link API_KEY_PREFIX_LENGTH} hex chars after `etn_` (stored as `key_prefix`). */
  keyPrefix: string;
}

/** Escape a literal string for safe interpolation into a `RegExp`. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compiled format check: `etn_` followed by exactly 32 lowercase hex chars. */
const FORMAT_REGEX = new RegExp(
  `^${escapeRegex(API_KEY_PREFIX)}[0-9a-f]{${API_KEY_RANDOM_LENGTH}}$`,
);

/**
 * Generate a fresh API-key with 128 bits of entropy and its SHA-256 hash.
 *
 * @returns the full key, the hash to persist, and the display prefix.
 */
export function generateApiKey(): GeneratedApiKey {
  // 16 random bytes → 32 lowercase hex characters.
  const hex = crypto.randomBytes(API_KEY_RANDOM_LENGTH / 2).toString('hex');
  const key = API_KEY_PREFIX + hex;
  return {
    key,
    keyHash: hashApiKey(key),
    keyPrefix: hex.slice(0, API_KEY_PREFIX_LENGTH),
  };
}

/**
 * Compute the SHA-256 hex digest of a full API-key (stored in `key_hash`).
 *
 * @param key - full key, including the `etn_` prefix.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Derive the display prefix from a full key: the first
 * {@link API_KEY_PREFIX_LENGTH} hex characters after `etn_`.
 *
 * @param key - full key.
 */
export function deriveApiKeyPrefix(key: string): string {
  return key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + API_KEY_PREFIX_LENGTH);
}

/** True when `key` matches the `etn_<32 hex>` format. */
export function isValidApiKeyFormat(key: string): boolean {
  return FORMAT_REGEX.test(key);
}

/**
 * Parse a bearer token into its random hex part, or `null` if malformed.
 * Use before any lookup to avoid hashing arbitrary input.
 */
export function parseApiKey(key: string): { hex: string } | null {
  if (!isValidApiKeyFormat(key)) {
    return null;
  }
  return { hex: key.slice(API_KEY_PREFIX.length) };
}
