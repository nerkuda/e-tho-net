/**
 * ETN shared enumerations.
 *
 * All enums are declared as `as const` tuples together with a derived union
 * type, so the runtime values (used for validation on the server) and the
 * type-level unions can never drift apart. This file intentionally contains no
 * runtime logic — only value/type pairs.
 *
 * Source of truth: docs/02-data-model.md, docs/03-server-api.md,
 * docs/04-realtime.md, docs/11-settings-and-state.md.
 */

/** Roles a user may hold within a network (02-data-model.md §2.4). */
export const NETWORK_ROLES = ['owner', 'member'] as const;
export type NetworkRole = (typeof NETWORK_ROLES)[number];

/** Value types accepted by a {@link PropertyDefinition} (02-data-model.md §3.4). */
export const PROPERTY_VALUE_TYPES = ['text', 'date', 'number', 'bool', 'thought_ref'] as const;
export type PropertyValueType = (typeof PROPERTY_VALUE_TYPES)[number];

/** Kinds of comments an entity may own (02-data-model.md §3.8). */
export const COMMENT_KINDS = ['permanent', 'chronological'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

/** Kinds of attachments an entity may own (02-data-model.md §3.9). */
export const ATTACHMENT_KINDS = ['url', 'file'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** How a thought/type icon is represented (02-data-model.md §3.1). */
export const ICON_KINDS = ['emoji', 'image'] as const;
export type IconKind = (typeof ICON_KINDS)[number];

/** Visual style of a link line (02-data-model.md §3.7). */
export const LINK_STYLES = ['solid', 'dashed', 'dotted'] as const;
export type LinkStyle = (typeof LINK_STYLES)[number];

/** audit_log.category values (02-data-model.md §2.6, 06-auth.md §8). */
export const AUDIT_CATEGORIES = [
  'auth',
  'user',
  'network',
  'membership',
  'data',
  'system',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/**
 * Scopes for full-text search.
 *
 * NOTE: 03-server-api.md §12 lists `scope=thoughts|links|chronology|all` while
 * 05-mcp-server.md §4.1 and the A4 task spec use the more granular
 * `names|texts|links|chronology|all`. The granular form is used here as the
 * single shared contract; the REST layer maps the legacy `thoughts` value.
 */
export const SEARCH_SCOPES = ['names', 'texts', 'links', 'chronology', 'all'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** Concrete search result groups (`SearchScope` without the `all` aggregate). */
export const SEARCH_GROUPS = ['names', 'texts', 'links', 'chronology'] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

/** Direction of a focus zone on the canvas (02-data-model.md §3.10.3). */
export const FOCUS_DIRS = ['parents', 'children', 'siblings'] as const;
export type FocusDir = (typeof FOCUS_DIRS)[number];

/** Sort strategies for a focus zone (02-data-model.md §3.10.3). */
export const SORT_KINDS = ['manual', 'alpha', 'created', 'viewed'] as const;
export type SortKind = (typeof SORT_KINDS)[number];

/** Sort order (02-data-model.md §3.10.3). */
export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/** Who receives a real-time event (04-realtime.md §3, 11-settings-and-state.md §4). */
export const REALTIME_AUDIENCES = ['network', 'user'] as const;
export type RealtimeAudience = (typeof REALTIME_AUDIENCES)[number];

/** Polymorphic owner of a {@link PropertyValue} (02-data-model.md §3.5). */
export const PROPERTY_OWNER_TYPES = ['thought', 'link'] as const;
export type PropertyOwnerType = (typeof PROPERTY_OWNER_TYPES)[number];

/** Polymorphic owner of a {@link Comment} (02-data-model.md §3.8). */
export const COMMENT_OWNER_TYPES = ['thought', 'link'] as const;
export type CommentOwnerType = (typeof COMMENT_OWNER_TYPES)[number];

/** Polymorphic owner of an {@link Attachment} (02-data-model.md §3.9). */
export const ATTACHMENT_OWNER_TYPES = ['thought', 'link'] as const;
export type AttachmentOwnerType = (typeof ATTACHMENT_OWNER_TYPES)[number];

/** Polymorphic owner of a {@link PropertyDefinition} — always a type (02-data-model.md §3.4). */
export const TYPE_OWNER_TYPES = ['thought_type', 'link_type'] as const;
export type TypeOwnerType = (typeof TYPE_OWNER_TYPES)[number];

/** Polymorphic owner of an embedding row, reserved for future use (02-data-model.md §3.12). */
export const EMBEDDING_OWNER_TYPES = ['thought', 'link', 'comment'] as const;
export type EmbeddingOwnerType = (typeof EMBEDDING_OWNER_TYPES)[number];

/** Presence state reported over real-time. Optional for MVP (04-realtime.md §4.7). */
export const PRESENCE_STATES = ['joined', 'left', 'focus_changed'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

/** Lifecycle status of an asynchronous export job (03-server-api.md §14). */
export const JOB_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Output formats accepted by the export endpoint (03-server-api.md §14). */
export const EXPORT_FORMATS = ['markdown', 'pdf', 'html'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
