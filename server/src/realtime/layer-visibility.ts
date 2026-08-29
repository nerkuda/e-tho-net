/**
 * Per-subscriber layer visibility of real-time events (task S9,
 * docs/13-layers.md §12).
 *
 * The rule (13-layers.md §4.1, §12): a subscriber whose session sits in layer
 * `L` sees an event that materialised in layer `EL` only when `EL` is on `L`'s
 * ancestor chain (`L → parent(L) → … → base`) **and** `L` has not
 * materialised a nearer row (shadow or tombstone) for the same logical id —
 * otherwise the row is overridden and the base/ancestor event must not leak
 * through the override.
 *
 * Cheapest correct check (per the task text): resolve the *nearest* row for
 * the event's logical id along `L`'s own `layer_chain` — the same anti-join
 * idea the `*_v` views use (`db/layer-chain.ts`), but **without** the
 * `deleted = 0` filter, because a delete/tombstone event must still be
 * delivered when nothing closer overrides it (a subscriber who currently sees
 * the row needs to learn it just disappeared). If the nearest row's own
 * `layer_id` equals `EL`, the event's layer is the winner in `L`'s chain — no
 * override — deliver. A nearer row from a different layer means `L` overrode
 * it — do not deliver. A missing row means the chain never had it — with one
 * exception: a `*.deleted` event with no row on the chain describes a
 * physically purged row (see {@link isEventVisibleInLayer}) and is still
 * delivered.
 *
 * Only events about branchable rows (13-layers.md §3) need this; everything
 * else (network/membership/presence/user-scoped settings) is layer-independent
 * and always visible (subject to the existing `audience` routing).
 */

import type { AnyRealtimeEvent } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/** A row lookup: table + WHERE clause (against alias `t`) + bound params. */
interface RowRef {
  table: string;
  where: string;
  params: unknown[];
}

function byId(table: string, id: unknown): RowRef | null {
  return typeof id === 'string' ? { table, where: 't.id = ?', params: [id] } : null;
}

/**
 * Map a real-time event to the branchable row it describes, or `null` when
 * the event is about non-branchable data (always visible). Mirrors the
 * catalogue in 04-realtime.md §4 and the branchable-table list in
 * 13-layers.md §3.
 */
function extractRowRef(event: AnyRealtimeEvent): RowRef | null {
  const data = event.data as Record<string, unknown>;
  switch (event.type) {
    case 'thought.created':
      return byId('thoughts', (data.thought as { id?: unknown } | undefined)?.id);
    case 'thought.updated':
    case 'thought.deleted':
      return byId('thoughts', data.id);
    case 'link.created':
      return byId('links', (data.link as { id?: unknown } | undefined)?.id);
    case 'link.updated':
    case 'link.deleted':
      return byId('links', data.id);
    case 'thought-type.created':
      return byId('thought_types', (data.type as { id?: unknown } | undefined)?.id);
    case 'thought-type.updated':
    case 'thought-type.deleted':
      return byId('thought_types', data.id);
    case 'link-type.created':
      return byId('link_types', (data.type as { id?: unknown } | undefined)?.id);
    case 'link-type.updated':
    case 'link-type.deleted':
      return byId('link_types', data.id);
    case 'property-definition.created':
      return byId('type_properties', (data.definition as { id?: unknown } | undefined)?.id);
    case 'property-definition.updated':
    case 'property-definition.deleted':
      return byId('type_properties', data.id);
    case 'comment.created':
      return byId('comments', (data.comment as { id?: unknown } | undefined)?.id);
    case 'comment.updated':
    case 'comment.deleted':
      return byId('comments', data.id);
    case 'attachment.created':
      return byId('attachments', (data.attachment as { id?: unknown } | undefined)?.id);
    case 'attachment.updated':
    case 'attachment.deleted':
      return byId('attachments', data.id);
    case 'property-value.set':
    case 'property-value.deleted': {
      const d = data as { owner_type?: unknown; owner_id?: unknown; property_id?: unknown };
      if (
        typeof d.owner_type !== 'string' ||
        typeof d.owner_id !== 'string' ||
        typeof d.property_id !== 'string'
      ) {
        return null;
      }
      return {
        table: 'property_values',
        where: 't.owner_type = ? AND t.owner_id = ? AND t.property_id = ?',
        params: [d.owner_type, d.owner_id, d.property_id],
      };
    }
    default:
      // network.*, member.*, presence.*, user-scoped settings (§4.6–4.8):
      // non-branchable, layer-independent (13-layers.md §3).
      return null;
  }
}

/**
 * Whether `event` (already known to have passed `audience` routing) is
 * visible to a subscriber whose session sits in `subscriberLayerId`.
 *
 * `ndb` must be the connection pooled for `subscriberLayerId` — its temp
 * `layer_chain` (db/layer-chain.ts) drives the lookup.
 */
export function isEventVisibleInLayer(
  ndb: NetworkDb,
  event: AnyRealtimeEvent,
  subscriberLayerId: string,
): boolean {
  // Fast path: the write happened in the subscriber's own current layer —
  // it is always the nearest possible row for its id.
  if (event.layer_id === subscriberLayerId) {
    return true;
  }
  const ref = extractRowRef(event);
  if (ref === null) {
    return true;
  }
  const row = ndb
    .prepare(
      `SELECT t.layer_id AS layer_id
       FROM ${ref.table} t
       JOIN layer_chain lc ON lc.layer_id = t.layer_id
       WHERE ${ref.where}
       ORDER BY lc.depth ASC
       LIMIT 1`,
    )
    .get(...ref.params) as { layer_id: string } | undefined;
  if (row !== undefined) {
    return row.layer_id === event.layer_id;
  }
  // No row for the logical id anywhere on the subscriber's chain. For a
  // `*.deleted` event that means the row was **physically purged** (trash
  // auto-purge, S13 / 13-layers.md §2.4, §6.3) after the event was recorded:
  // before the purge the chain resolved it, so every subscriber that still
  // caches it must drop it. Appliers ignore unknown ids idempotently, so the
  // possible over-delivery (a row created and deleted within a non-ancestor
  // layer) is harmless. Any other event type about a row the chain never had
  // belongs to a non-ancestor layer — nothing to deliver.
  return event.type.endsWith('.deleted');
}
