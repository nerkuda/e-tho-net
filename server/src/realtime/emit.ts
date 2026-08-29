/**
 * Domain-event emission helper (task E3, docs/04-realtime.md §4–5).
 *
 * Every mutating REST route (and later every mutating MCP tool) must call
 * {@link emitDomainEvent} right after its write succeeded:
 *
 *   1. `network_seq` is incremented and the event appended to `event_log`
 *      **atomically in one `_system.db` transaction** (04-realtime.md §5 —
 *      on MVP the domain write lives in `data.db`, a separate database, so the
 *      sequence + log write are kept internally atomic instead);
 *   2. the fully-formed envelope is published through the in-process
 *      {@link PubSub} broker so the WebSocket gateway delivers it live.
 *
 * `meta.request_id` should always carry the request's `Client-Request-Id`
 * (`req.id`) so clients can match REST responses to WebSocket echoes
 * (04-realtime.md §9).
 *
 * ## Where each event type must be emitted (phase-D handoff)
 *
 * The D-phase agent wires these calls into its routes **after the mutation
 * succeeded**. Types without a line below are produced by a service that no
 * route currently owns.
 *
 * | Event                     | Route (D-phase)                                    | data (04-realtime.md)                                   |
 * |---------------------------|----------------------------------------------------|---------------------------------------------------------|
 * | `thought.created`         | POST /thoughts (+ link variant)                    | `{ thought, link? }`                                    |
 * | `thought.updated`         | PATCH /thoughts/:id                                | `{ id, changes, version }`                              |
 * | `thought.deleted`         | DELETE /thoughts/:id                               | `{ id }`                                                |
 * | `thought.reordered`       | reorder endpoint (L3)                              | `{ owner_thought_id, dir, ordered_ids }`                |
 * | `link.created`            | POST /links                                        | `{ link }`                                              |
 * | `link.updated`            | PATCH /links/:id                                   | `{ id, changes, version }`                              |
 * | `link.deleted`            | DELETE /links/:id                                  | `{ id }`                                                |
 * | `thought-type.*`          | /thought-types CRUD                                | `{ type }` / `{ id, changes, version }` / `{ id }`      |
 * | `link-type.*`             | /link-types CRUD                                   | same shape                                              |
 * | `property-definition.*`   | /type-properties CRUD                              | `{ definition }` / `{ id, changes }` / `{ id }`         |
 * | `comment.*`               | /comments CRUD                                     | `{ comment }` / `{ id, changes, version }` / `{...}`    |
 * | `attachment.*`            | /attachments CRUD                                  | `{ attachment }` / `{ id, changes }` / `{ id }`         |
 * | `property-value.set`      | property value upsert                             | `{ owner_type, owner_id, property_id, value }`          |
 * | `property-value.deleted`  | property value delete                             | `{ owner_type, owner_id, property_id }`                 |
 * | `network.deleted`         | DELETE /admin/networks/:id (D7) — emit **before**  | `{ id }`                                                |
 * |                           | the registry row is removed (network_seq has an FK) |                                                       |
 * | L3 `user-*` / `thought-view.updated` | settings routes (me/preferences)     | 11-settings-and-state.md §4.4 — `audience: 'user'`     |
 *
 * Events already wired in this branch (see `routes/networks.ts`):
 * `network.updated`, `member.added`, `member.removed`,
 * `member.role_changed` (two events on ownership transfer), and
 * `user-preference.updated` (audience=user).
 *
 * Note: network *creation* has no event in the catalogue (04-realtime.md §4.6)
 * and its only participant is the creator, so POST /networks does not emit.
 */

import {
  BASE_LAYER_ID,
  REALTIME_EVENT_AUDIENCE,
  type AnyRealtimeEvent,
  type RealtimeActor,
  type RealtimeAudience,
  type RealtimeEvent,
  type RealtimeEventMap,
  type RealtimeEventType,
  type RealtimeMeta,
} from '@etn/shared';

import type { SystemDb } from '../db/system-db.js';
import type { PubSub } from './pubsub.js';

/** Dependencies needed to assign a `seq`, persist and broadcast an event. */
export interface EmitDomainEventDeps {
  /** `_system.db` accessor (`network_seq` + `event_log` live here). */
  systemDb: SystemDb;
  /** In-process broker delivering to WebSocket subscribers. */
  pubsub: PubSub;
}

/**
 * Acting party of a change. `client_id` may be `null` when the request carried
 * no `Client-Id`; the persisted {@link RealtimeActor.client_id} is normalised
 * to `''` in that case (the shared type requires a string) and the gateway
 * skips echo suppression for empty ids.
 */
export type DomainEventActor = { user_id: string; client_id: string | null };

/** Options overriding defaults derived from the event catalogue. */
export interface EmitDomainEventOptions {
  /**
   * Delivery audience. Defaults to {@link REALTIME_EVENT_AUDIENCE} for `type`
   * (`user` for private L3 settings, `network` otherwise).
   */
  audience?: RealtimeAudience;
  /** Extra metadata, e.g. `{ request_id: req.id }`. */
  meta?: RealtimeMeta;
  /**
   * The change-layer the underlying write materialised in (task S9,
   * docs/13-layers.md §12, §7.1). Defaults to {@link BASE_LAYER_ID} — correct
   * for every non-branchable event (network/membership/presence/user-scoped
   * settings) and for callers that do not yet resolve a session layer (MCP
   * tools until S10 lands). REST routes pass the request's resolved
   * `req.layerEcho.id` (see `routes/helpers.ts`).
   */
  layerId?: string;
}

/**
 * Assign the next per-network `seq`, persist the event to `event_log` and
 * publish it to live subscribers. Returns the event envelope (handy for tests
 * and for response payloads that need the new `seq`).
 *
 * @param networkId - network the change belongs to.
 * @param type - catalogue event type (04-realtime.md §4).
 * @param data - payload matching `type` (see {@link RealtimeEventMap}).
 * @param actor - `{ user_id, client_id }` of the acting client; `client_id`
 *   may be `null` when the request carried no `Client-Id` (echo suppression
 *   is then skipped).
 * @param options - audience override and/or event metadata.
 */
export function emitDomainEvent<E extends RealtimeEventType>(
  deps: EmitDomainEventDeps,
  networkId: string,
  type: E,
  data: RealtimeEventMap[E],
  actor: DomainEventActor,
  options?: EmitDomainEventOptions,
): RealtimeEvent<E> {
  const audience = options?.audience ?? REALTIME_EVENT_AUDIENCE[type];
  const layerId = options?.layerId ?? BASE_LAYER_ID;
  const ts = new Date().toISOString();
  const storedActor: RealtimeActor = {
    user_id: actor.user_id,
    client_id: actor.client_id ?? '',
  };

  // seq increment + log append are atomic: a reader can never observe an
  // incremented counter without the matching event_log row.
  const seq = deps.systemDb.transaction(() => {
    const assigned = deps.systemDb.nextNetworkSeq(networkId);
    const stored: unknown = {
      actor: storedActor,
      audience,
      data,
      meta: options?.meta,
      layer_id: layerId,
    };
    deps.systemDb.appendEvent(networkId, assigned, type, JSON.stringify(stored), ts);
    return assigned;
  });

  const event: RealtimeEvent<E> = {
    type,
    seq,
    ts,
    actor: storedActor,
    network_id: networkId,
    audience,
    data,
    layer_id: layerId,
    ...(options?.meta !== undefined ? { meta: options.meta } : {}),
  };
  // The broker accepts the AnyRealtimeEvent union; a generic `RealtimeEvent<E>`
  // is not provably assignable to one of its branches, so cast (the envelope
  // is built from the same catalogue here).
  deps.pubsub.publish(networkId, event as unknown as AnyRealtimeEvent);
  return event;
}
