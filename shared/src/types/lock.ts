/**
 * Object-lock DTO (task 4f141756 «Захваты в клиенте: авто-захват, индикация,
 * ручной сброс», сущность e0a1ae3a «object_locks», операция 8919b057
 * «/locks», docs/03-server-api.md §13c).
 *
 * The wire shape is identical on REST and in the real-time events
 * `edit.acquired` / `edit.released` / `edit.cleared` — see `realtime.ts`
 * for the per-event projections. The server-side `ObjectLockRow` also
 * carries a `network_id` which is dropped from the wire because the
 * network id is already implicit in the request URL.
 *
 * `client_id` may be `null` when the lock was acquired through REST/MCP
 * without an associated WebSocket session (requirement 9ac48831).
 */

/** Logical entity kinds the lock table can hold a row for. */
export type LockEntityType = 'thought' | 'link' | 'thought_type' | 'link_type' | 'property';

/** Wire shape of an active lock as returned by `/locks` and `edit.*` events. */
export interface LockRow {
  /** Lock id (UUID) — used as the path parameter on `DELETE /locks/:lockId`. */
  id: string;
  /** What kind of entity is being edited. */
  entity_type: LockEntityType | string;
  /** Id of the locked entity within `entity_type`. */
  entity_id: string;
  /** User that holds the lock. */
  user_id: string;
  /** Client id of the WS session that holds the lock, or null for REST/MCP. */
  client_id: string | null;
  /** Wall-clock acquisition time, ms since epoch. */
  acquired_at_ms: number;
}

/** Reason a lock was cleared server-side (`edit.cleared` event data). */
export type LockClearedReason = 'manual' | 'ws_disconnect' | 'server_start';
