/**
 * Stable installation identifier (docs/11-settings-and-state.md §1.1,
 * docs/07-client-electron.md §3.4, workplan G4).
 *
 * `client_id` is a UUIDv4 generated once, on first launch, and persisted in
 * `client_meta.client_id` (level L5 — per installation, never synced). It is
 * unrelated to `user_id` and to the API-key, and is sent to the server on every
 * REST request (`Client-Id` header) and WebSocket connection purely as an
 * installation tag for echo suppression and per-client `last_seq` bookkeeping.
 */
import { randomUUID } from 'node:crypto';
import { CLIENT_META_KEY } from '@etn/shared';
import type { LocalDb } from './db/local-db.js';

/** Loose UUIDv4 pattern used to validate a value read from `client_meta`. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns the installation `client_id`, creating and persisting it on the first
 * call. If `client_meta` holds a malformed value, it is overwritten with a fresh
 * UUID to keep the header always valid.
 *
 * @param db the local store (level L5).
 * @returns the stable UUIDv4 for this installation.
 */
export function getOrCreateClientId(db: LocalDb): string {
  const stored = db.getMeta(CLIENT_META_KEY.CLIENT_ID);
  if (stored && UUID_V4_RE.test(stored)) {
    return stored;
  }
  const id = randomUUID();
  db.setMeta(CLIENT_META_KEY.CLIENT_ID, id);
  return id;
}

/**
 * Convenience alias matching the task wording: returns the existing
 * `client_id`, generating one when none is present yet.
 */
export const getClientId = getOrCreateClientId;
