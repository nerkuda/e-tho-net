/**
 * Focus-zone preference and manual-order writer (task C12,
 * docs/02-data-model.md §3.10.3–3.10.4, docs/03-server-api.md §6.8).
 *
 * The read side (applying a stored sort to a focus zone) already lives in
 * `thought-service.focus` / `getNeighbors` (task C3). This module owns the
 * write side: upserting the per-(user, focus, dir) sort selection and replacing
 * the manual position list for a focus zone.
 *
 * Both tables are level-L3 user state (docs/11-settings-and-state.md §2) — the
 * REST routes later emit `audience: "user"` realtime events for them (phase E).
 */

import {
  EtnError,
  FOCUS_DIRS,
  SORT_KINDS,
  SORT_ORDERS,
  type FocusDir,
  type FocusOrderInput,
  type FocusPreferencesInput,
  type SortKind,
  type SortOrder,
  type UserFocusPreferences,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/** Manual order is only persisted for parents/children, never siblings. */
const MANUAL_DIRS = ['children', 'parents'] as const;
type ManualDir = (typeof MANUAL_DIRS)[number];

function isFocusDir(v: unknown): v is FocusDir {
  return typeof v === 'string' && (FOCUS_DIRS as readonly string[]).includes(v);
}

function isSortKind(v: unknown): v is SortKind {
  return typeof v === 'string' && (SORT_KINDS as readonly string[]).includes(v);
}

function isSortOrder(v: unknown): v is SortOrder {
  return typeof v === 'string' && (SORT_ORDERS as readonly string[]).includes(v);
}

/** Validate untrusted input (HTTP/MCP) before it touches the database. */
function validatePrefInput(input: FocusPreferencesInput): void {
  if (!isFocusDir(input.dir) || !isSortKind(input.sort) || !isSortOrder(input.order)) {
    throw new EtnError('VALIDATION_ERROR', 'invalid focus preference (dir/sort/order)');
  }
}

/**
 * Read the stored sort selection for `(userId, focusThoughtId, dir)`, or `null`
 * when the user never chose one (default is `created`/`asc`, applied by the
 * read side in `thought-service`).
 */
export function getFocusPreferences(
  ndb: NetworkDb,
  userId: string,
  focusThoughtId: string,
  dir: FocusDir,
): UserFocusPreferences | null {
  const row = ndb
    .prepare(
      `SELECT user_id, focus_thought_id, dir, sort, sort_order, updated_at
         FROM user_focus_preferences
        WHERE user_id = ? AND focus_thought_id = ? AND dir = ?`,
    )
    .get(userId, focusThoughtId, dir) as UserFocusPreferences | undefined;
  return row ?? null;
}

/**
 * Upsert the per-(user, focus, dir) sort selection. `siblings` may use any
 * sort except `manual`; the read side ignores manual for siblings anyway, but
 * the write side rejects it to keep stored state honest (03-server-api.md §6.8).
 */
export function setFocusPreferences(
  ndb: NetworkDb,
  userId: string,
  focusThoughtId: string,
  input: FocusPreferencesInput,
): UserFocusPreferences {
  validatePrefInput(input);
  if (input.dir === 'siblings' && input.sort === 'manual') {
    throw new EtnError('VALIDATION_ERROR', 'manual order is not available for siblings');
  }
  const now = new Date().toISOString();
  ndb
    .prepare(
      `INSERT INTO user_focus_preferences (user_id, focus_thought_id, dir, sort, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, focus_thought_id, dir)
       DO UPDATE SET sort = excluded.sort, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
    )
    .run(userId, focusThoughtId, input.dir, input.sort, input.order, now);
  return {
    user_id: userId,
    focus_thought_id: focusThoughtId,
    dir: input.dir,
    sort: input.sort,
    sort_order: input.order,
    updated_at: now,
  };
}

/**
 * Replace the manual position list for a focus zone with the given order.
 *
 * `ordered_ids` defines the full intended order: each id gets `position` equal
 * to its index, and any stored rows for `(user, focus, dir)` that are not in
 * the list are deleted (03-server-api.md §6.8). Positions are not checked
 * against actual neighbours — a reorder is a pure order assignment, and stale
 * ids simply never surface in the zone listing.
 */
export function setFocusOrder(
  ndb: NetworkDb,
  userId: string,
  focusThoughtId: string,
  input: FocusOrderInput,
): void {
  if (!isFocusDir(input.dir) || !MANUAL_DIRS.includes(input.dir as ManualDir)) {
    throw new EtnError('VALIDATION_ERROR', 'manual order is only available for parents/children');
  }
  if (
    !Array.isArray(input.ordered_ids) ||
    input.ordered_ids.some((id) => typeof id !== 'string' || id === '')
  ) {
    throw new EtnError('VALIDATION_ERROR', 'ordered_ids must be a non-empty-string array');
  }
  const now = new Date().toISOString();

  ndb.transaction(() => {
    ndb
      .prepare(
        'DELETE FROM user_focus_order WHERE user_id = ? AND focus_thought_id = ? AND dir = ?',
      )
      .run(userId, focusThoughtId, input.dir);

    const insert = ndb.prepare(
      `INSERT INTO user_focus_order (user_id, focus_thought_id, dir, thought_id, position, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    input.ordered_ids.forEach((thoughtId, position) => {
      insert.run(userId, focusThoughtId, input.dir, thoughtId, position, now);
    });
  });
}
