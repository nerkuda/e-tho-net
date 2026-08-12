/**
 * Real-time (WebSocket) event types.
 *
 * Covers the event envelope, the full catalogue of event names with their
 * `data` payloads, the `audience` routing map, and client/server control
 * frames. Mirrors docs/04-realtime.md §3–§6 and §4.8, and the L3 additions in
 * docs/11-settings-and-state.md §4.4.
 */

import type {
  CommentOwnerType,
  FocusDir,
  NetworkRole,
  PropertyOwnerType,
  RealtimeAudience,
  SortKind,
  SortOrder,
} from '../enums.js';

import type { Link, LinkUpdateInput } from './link.js';
import type { LinkType } from './link-type.js';
import type { Comment } from './comment.js';
import type { Attachment } from './attachment.js';
import type { Thought, ThoughtUpdateInput } from './thought.js';
import type { PropertyDefinition, PropertyValueValue, ThoughtType } from './thought-type.js';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** Actor of a real-time event; used for echo suppression (04-realtime.md §3). */
export interface RealtimeActor {
  user_id: string;
  client_id: string;
}

/** Optional metadata of an event (04-realtime.md §3). */
export interface RealtimeMeta {
  version?: number;
  /** Matches the `Client-Request-Id` of the originating request. */
  request_id?: string;
}

// ---------------------------------------------------------------------------
// Event-name catalogue
// ---------------------------------------------------------------------------

/** All real-time event type names (04-realtime.md §4.1–4.8). */
export const REALTIME_EVENT_TYPES = [
  // thoughts (§4.1)
  'thought.created',
  'thought.updated',
  'thought.deleted',
  'thought.reordered',
  // links (§4.2)
  'link.created',
  'link.updated',
  'link.deleted',
  // types & property definitions (§4.3)
  'thought-type.created',
  'thought-type.updated',
  'thought-type.deleted',
  'link-type.created',
  'link-type.updated',
  'link-type.deleted',
  'property-definition.created',
  'property-definition.updated',
  'property-definition.deleted',
  // comments & attachments (§4.4)
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'attachment.created',
  'attachment.updated',
  'attachment.deleted',
  // property values (§4.5)
  'property-value.set',
  'property-value.deleted',
  // membership & network (§4.6)
  'network.updated',
  'network.deleted',
  'member.added',
  'member.removed',
  'member.role_changed',
  // presence — optional for MVP (§4.7)
  'presence.joined',
  'presence.left',
  'presence.focus_changed',
  // L3 user-scoped, audience=user (§4.8)
  'user-preference.updated',
  'user-focus-preferences.updated',
  'user-focus-order.updated',
  'thought-view.updated',
] as const;
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Event data payloads
// ---------------------------------------------------------------------------

// thoughts
export interface ThoughtCreatedData {
  thought: Thought;
  /** Present when the thought was created together with a link. */
  link?: Link;
}
export interface ThoughtUpdatedData {
  id: string;
  changes: ThoughtUpdateInput;
  version: number;
}
export interface ThoughtDeletedData {
  id: string;
}
export interface ThoughtReorderedData {
  owner_thought_id: string;
  dir: FocusDir;
  ordered_ids: string[];
}

// links
export interface LinkCreatedData {
  link: Link;
}
export interface LinkUpdatedData {
  id: string;
  changes: LinkUpdateInput;
  version: number;
}
export interface LinkDeletedData {
  id: string;
}

// types
export interface ThoughtTypeCreatedData {
  type: ThoughtType;
}
export interface ThoughtTypeUpdatedData {
  id: string;
  changes: Partial<ThoughtType>;
  version: number;
}
export interface ThoughtTypeDeletedData {
  id: string;
}
export interface LinkTypeCreatedData {
  type: LinkType;
}
export interface LinkTypeUpdatedData {
  id: string;
  changes: Partial<LinkType>;
  version: number;
}
export interface LinkTypeDeletedData {
  id: string;
}

// property definitions
export interface PropertyDefinitionCreatedData {
  definition: PropertyDefinition;
}
export interface PropertyDefinitionUpdatedData {
  id: string;
  changes: Partial<PropertyDefinition>;
}
export interface PropertyDefinitionDeletedData {
  id: string;
}

// comments & attachments
export interface CommentCreatedData {
  comment: Comment;
}
export interface CommentUpdatedData {
  id: string;
  changes: Partial<Comment>;
  version: number;
}
export interface CommentDeletedData {
  owner_type: CommentOwnerType;
  owner_id: string;
  id: string;
}
export interface AttachmentCreatedData {
  attachment: Attachment;
}
export interface AttachmentUpdatedData {
  id: string;
  changes: Partial<Attachment>;
}
export interface AttachmentDeletedData {
  id: string;
}

// property values
export interface PropertyValueSetData {
  owner_type: PropertyOwnerType;
  owner_id: string;
  property_id: string;
  value: PropertyValueValue;
}
export interface PropertyValueDeletedData {
  owner_type: PropertyOwnerType;
  owner_id: string;
  property_id: string;
}

// network & membership
export interface NetworkUpdatedData {
  display_name?: string;
  description?: string | null;
}
export interface NetworkDeletedData {
  id: string;
}
export interface MemberAddedData {
  user_id: string;
  role: NetworkRole;
  added_by: string;
}
export interface MemberRemovedData {
  user_id: string;
}
export interface MemberRoleChangedData {
  user_id: string;
  role: NetworkRole;
}

// presence (optional for MVP)
export interface PresenceJoinedData {
  user_id: string;
  display_name: string | null;
  focus_thought_id: string | null;
}
export interface PresenceLeftData {
  user_id: string;
}
export interface PresenceFocusChangedData {
  user_id: string;
  focus_thought_id: string | null;
}

// L3 user-scoped (audience = user)
export interface UserPreferenceUpdatedData {
  key: string;
  value: unknown;
}
export interface UserFocusPreferencesUpdatedData {
  focus_thought_id: string;
  dir: FocusDir;
  sort: SortKind;
  sort_order: SortOrder;
}
export interface UserFocusOrderUpdatedData {
  focus_thought_id: string;
  dir: FocusDir;
  ordered_ids: string[];
}
export interface ThoughtViewUpdatedData {
  thought_id: string;
  last_viewed_at: string;
}

/**
 * Maps each {@link RealtimeEventType} to its `data` payload type.
 * Used by {@link RealtimeEvent} and {@link AnyRealtimeEvent}.
 */
export interface RealtimeEventMap {
  'thought.created': ThoughtCreatedData;
  'thought.updated': ThoughtUpdatedData;
  'thought.deleted': ThoughtDeletedData;
  'thought.reordered': ThoughtReorderedData;
  'link.created': LinkCreatedData;
  'link.updated': LinkUpdatedData;
  'link.deleted': LinkDeletedData;
  'thought-type.created': ThoughtTypeCreatedData;
  'thought-type.updated': ThoughtTypeUpdatedData;
  'thought-type.deleted': ThoughtTypeDeletedData;
  'link-type.created': LinkTypeCreatedData;
  'link-type.updated': LinkTypeUpdatedData;
  'link-type.deleted': LinkTypeDeletedData;
  'property-definition.created': PropertyDefinitionCreatedData;
  'property-definition.updated': PropertyDefinitionUpdatedData;
  'property-definition.deleted': PropertyDefinitionDeletedData;
  'comment.created': CommentCreatedData;
  'comment.updated': CommentUpdatedData;
  'comment.deleted': CommentDeletedData;
  'attachment.created': AttachmentCreatedData;
  'attachment.updated': AttachmentUpdatedData;
  'attachment.deleted': AttachmentDeletedData;
  'property-value.set': PropertyValueSetData;
  'property-value.deleted': PropertyValueDeletedData;
  'network.updated': NetworkUpdatedData;
  'network.deleted': NetworkDeletedData;
  'member.added': MemberAddedData;
  'member.removed': MemberRemovedData;
  'member.role_changed': MemberRoleChangedData;
  'presence.joined': PresenceJoinedData;
  'presence.left': PresenceLeftData;
  'presence.focus_changed': PresenceFocusChangedData;
  'user-preference.updated': UserPreferenceUpdatedData;
  'user-focus-preferences.updated': UserFocusPreferencesUpdatedData;
  'user-focus-order.updated': UserFocusOrderUpdatedData;
  'thought-view.updated': ThoughtViewUpdatedData;
}

/** Strongly-typed event envelope for a specific event name. */
export interface RealtimeEvent<E extends RealtimeEventType = RealtimeEventType> {
  type: E;
  /** Monotonic per-network sequence number. */
  seq: number;
  /** ISO-8601 UTC. */
  ts: string;
  actor: RealtimeActor;
  network_id: string;
  audience: RealtimeAudience;
  data: RealtimeEventMap[E];
  meta?: RealtimeMeta;
}

/**
 * Discriminated union of all event envelopes, for `switch (event.type)` style
 * handling on the client.
 */
export type AnyRealtimeEvent = {
  [E in RealtimeEventType]: RealtimeEvent<E>;
}[RealtimeEventType];

/**
 * Audience each event type is delivered to (04-realtime.md §4, §4.8;
 * 11-settings-and-state.md §4.2). Used by the WebSocket gateway (E4) to route
 * events without per-call branching.
 */
export const REALTIME_EVENT_AUDIENCE = {
  'thought.created': 'network',
  'thought.updated': 'network',
  'thought.deleted': 'network',
  'thought.reordered': 'user',
  'link.created': 'network',
  'link.updated': 'network',
  'link.deleted': 'network',
  'thought-type.created': 'network',
  'thought-type.updated': 'network',
  'thought-type.deleted': 'network',
  'link-type.created': 'network',
  'link-type.updated': 'network',
  'link-type.deleted': 'network',
  'property-definition.created': 'network',
  'property-definition.updated': 'network',
  'property-definition.deleted': 'network',
  'comment.created': 'network',
  'comment.updated': 'network',
  'comment.deleted': 'network',
  'attachment.created': 'network',
  'attachment.updated': 'network',
  'attachment.deleted': 'network',
  'property-value.set': 'network',
  'property-value.deleted': 'network',
  'network.updated': 'network',
  'network.deleted': 'network',
  'member.added': 'network',
  'member.removed': 'network',
  'member.role_changed': 'network',
  'presence.joined': 'network',
  'presence.left': 'network',
  'presence.focus_changed': 'network',
  'user-preference.updated': 'user',
  'user-focus-preferences.updated': 'user',
  'user-focus-order.updated': 'user',
  'thought-view.updated': 'user',
} as const satisfies Record<RealtimeEventType, RealtimeAudience>;

// ---------------------------------------------------------------------------
// Control frames (client → server, server → client)
// ---------------------------------------------------------------------------

/** Messages a client may send over the WebSocket connection. */
export type RealtimeClientMessage =
  { type: 'hello'; client_id: string } | { type: 'resume'; last_seq: number } | { type: 'ping' };

/** Non-event frames the server may send to a client. */
export type RealtimeServerControlMessage =
  { type: 'pong' } | { type: 'resume.stale'; last_seq: number };

/** WebSocket close codes used by the gateway (04-realtime.md §2). */
export const REALTIME_CLOSE_CODES = {
  UNAUTHORIZED: 4401,
  NOT_FOUND: 4404,
} as const satisfies Record<string, number>;
export type RealtimeCloseCode = (typeof REALTIME_CLOSE_CODES)[keyof typeof REALTIME_CLOSE_CODES];
