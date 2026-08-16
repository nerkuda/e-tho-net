/**
 * ETN shared constants and limits.
 *
 * Only primitive values and frozen key maps — no runtime logic. Values mirror
 * the defaults listed in docs/11-settings-and-state.md (§2.1 L1 defaults and
 * §2.4 cloud sizing) and the limits in docs/02-data-model.md,
 * docs/04-realtime.md, docs/06-auth.md.
 */

// ---------------------------------------------------------------------------
// Cloud sizing (11-settings-and-state.md §2.4)
// ---------------------------------------------------------------------------

/**
 * Custom MIME type carried by an internal canvas cloud drag (HTML5 DnD). Used to
 * distinguish a dragged thought cloud from an external file/URL drop on the same
 * zone, so the external-drop handler does not spawn a junk thought.
 */
export const CLOUD_DRAG_MIME = 'application/x-etn-cloud';

/** Minimum cloud width in pixels. */
export const CLOUD_WIDTH_MIN = 120;
/** Maximum cloud width in pixels. */
export const CLOUD_WIDTH_MAX = 400;
/** Default cloud width for a fresh client installation. */
export const CLOUD_WIDTH_DEFAULT = 200;

/** Minimum gap between clouds in pixels. */
export const CLOUD_GAP_MIN = 4;
/** Maximum gap between clouds in pixels. */
export const CLOUD_GAP_MAX = 40;
/** Default gap between clouds for a fresh client installation. */
export const CLOUD_GAP_DEFAULT = 12;

/** Minimum editor width (left/right dock) in pixels. */
export const EDITOR_W_MIN = 240;
/** Maximum editor width (left/right dock) in pixels. */
export const EDITOR_W_MAX = 720;
/** Default editor width for a fresh client installation. */
export const EDITOR_W_DEFAULT = 340;

/** Minimum editor height (top/bottom dock) in pixels. */
export const EDITOR_H_MIN = 120;
/** Maximum editor height (top/bottom dock) in pixels. */
export const EDITOR_H_MAX = 700;
/** Default editor height for a fresh client installation. */
export const EDITOR_H_DEFAULT = 300;

/** Font-size multiplier applied to the focused cloud title. */
export const FOCUS_FONT_SCALE = 1.3;
/** Maximum number of lines rendered inside the focused cloud. */
export const FOCUS_TITLE_MAX_LINES = 4;

/** Default share of the top strip width given to the parents zone (08-ui-spec §2.1). */
export const CANVAS_TOP_SPLIT_DEFAULT = 0.5;
/** Default share of the canvas height given to the children zone (08-ui-spec §2.1). */
export const CANVAS_CHILDREN_SHARE_DEFAULT = 0.34;
/** Clip range for the zone layout shares stored in the L4 `canvas_layout` key. */
export const CANVAS_SHARE_MIN = 0.1;
export const CANVAS_SHARE_MAX = 0.9;

/** Minimum canvas zoom multiplier (clouds, focus cloud and link labels). */
export const CANVAS_ZOOM_MIN = 0.5;
/** Maximum canvas zoom multiplier. */
export const CANVAS_ZOOM_MAX = 2.0;
/** Canvas zoom keyboard step; zoom values are kept on a grid multiple of it. */
export const CANVAS_ZOOM_STEP = 0.05;
/** Default canvas zoom multiplier. */
export const CANVAS_ZOOM_DEFAULT = 1.0;

// ---------------------------------------------------------------------------
// Thought limits
// ---------------------------------------------------------------------------

/** Hard maximum length of `thought.title` in characters (02-data-model.md §3.1). */
export const THOUGHT_TITLE_MAX = 400;
/** Number of characters used for a truncated title preview. */
export const THOUGHT_TITLE_PREVIEW = 120;

/** Maximum number of entries kept in client `focus_history` per network (11-settings-and-state.md §2.3). */
export const FOCUS_HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// API-key format (06-auth.md §2)
// ---------------------------------------------------------------------------

/** Prefix shared by every API-key, e.g. `etn_a1b2c3d4…`. */
export const API_KEY_PREFIX = 'etn_';
/** Length of the random hex part of an API-key (128 bits of entropy). */
export const API_KEY_RANDOM_LENGTH = 32;
/** Number of leading characters after the prefix stored for display (`etn_a1b2c3d4…`). */
export const API_KEY_PREFIX_LENGTH = 8;

// ---------------------------------------------------------------------------
// Idempotency (01-architecture.md §6, 02-data-model.md §2.7)
// ---------------------------------------------------------------------------

/** TTL of rows in `client_request_cache`, in minutes. */
export const IDEMPOTENCY_TTL_MINUTES = 10;

// ---------------------------------------------------------------------------
// WebSocket keep-alive (04-realtime.md §2.1)
// ---------------------------------------------------------------------------

/** Interval at which the server sends a WebSocket ping, in milliseconds. */
export const WS_PING_INTERVAL_MS = 30_000;
/** Grace period without a pong before the server closes the connection, in milliseconds. */
export const WS_PONG_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Settings-key namespaces
// ---------------------------------------------------------------------------

/**
 * L3 server-side per-user preferences stored in `user_preferences`
 * (11-settings-and-state.md §2.1 L3). These influence server-side data
 * selection, hence live on the server and sync via `audience=user` events.
 */
export const PREF_KEY = {
  SHOW_INACTIVE: 'show_inactive',
} as const satisfies Record<string, string>;
export type PrefKey = (typeof PREF_KEY)[keyof typeof PREF_KEY];

/**
 * L4 client-side UI-state keys stored in the local `ui_state` table
 * (11-settings-and-state.md §2.1 L4). Per (client × user × network), never
 * synced between clients.
 */
export const UI_STATE_KEY = {
  CURRENT_FOCUS_THOUGHT_ID: 'current_focus_thought_id',
  CURRENT_NETWORK_ID: 'current_network_id',
  FOCUS_HISTORY: 'focus_history',
  CLOUD_WIDTH: 'cloud_width',
  CLOUD_GAP: 'cloud_gap',
  SEARCH_STATE: 'search_state',
  EDITOR_POSITION: 'editor_position',
  EDITOR_COLLAPSED_GROUPS: 'editor_collapsed_groups',
  WINDOW_LAYOUT: 'window_layout',
  CANVAS_LAYOUT: 'canvas_layout',
  CANVAS_ZOOM: 'canvas_zoom',
  LAST_USED_LINK_TYPE_ID: 'last_used_link_type_id',
  ACTIVE_VIEW: 'active_view',
  STRUCTURES_STATE: 'structures_state',
} as const satisfies Record<string, string>;
export type UiStateKey = (typeof UI_STATE_KEY)[keyof typeof UI_STATE_KEY];

/**
 * L5 client-installation keys stored in the local `client_meta` table
 * (11-settings-and-state.md §2.1 L5). Per installation, never synced.
 */
export const CLIENT_META_KEY = {
  CLIENT_ID: 'client_id',
  LAST_SEQ: 'last_seq',
  THEME: 'theme',
  ZOOM: 'zoom',
  ACTIVE_PROFILE_ID: 'active_profile_id',
} as const satisfies Record<string, string>;
export type ClientMetaKey = (typeof CLIENT_META_KEY)[keyof typeof CLIENT_META_KEY];

/**
 * L1 system-wide settings stored in `_system.db.settings`
 * (11-settings-and-state.md §2.1 L1). Admin-only, affect the whole server.
 */
export const SETTING_KEY = {
  MCP_MAX_NODES_PER_SUBGRAPH: 'mcp.max_nodes_per_subgraph',
  MCP_MAX_WRITES_PER_MINUTE: 'mcp.max_writes_per_minute',
  REALTIME_EVENT_LOG_TTL_HOURS: 'realtime.event_log_ttl_hours',
  REALTIME_EVENT_LOG_MAX_ROWS: 'realtime.event_log_max_rows',
  AUTH_BAD_ATTEMPTS_PER_MINUTE: 'auth.bad_attempts_per_minute',
} as const satisfies Record<string, string>;
export type SettingKey = (typeof SETTING_KEY)[keyof typeof SETTING_KEY];

// ---------------------------------------------------------------------------
// Subsystem defaults (mirror L1 defaults from 11-settings-and-state.md §2.1)
// ---------------------------------------------------------------------------

/** Defaults for MCP limits (05-mcp-server.md §6.2). */
export const MCP_DEFAULTS = {
  MAX_NODES_PER_SUBGRAPH: 500,
  MAX_WRITES_PER_MINUTE: 60,
} as const satisfies Record<string, number>;

/** Defaults for the real-time event-log retention window (04-realtime.md §6). */
export const REALTIME_DEFAULTS = {
  EVENT_LOG_TTL_HOURS: 24,
  EVENT_LOG_MAX_ROWS: 10_000,
} as const satisfies Record<string, number>;

/** Defaults for authentication brute-force protection (06-auth.md §9). */
export const AUTH_DEFAULTS = {
  BAD_ATTEMPTS_PER_MINUTE: 10,
  /** Ban duration applied once the per-minute threshold is exceeded. */
  BAN_MINUTES: 5,
} as const satisfies Record<string, number>;

/** Defaults for graph traversal safety (11-settings-and-state.md §5.3). */
export const TRAVERSAL_DEFAULTS = {
  MAX_DEPTH: 20,
  QUERY_TIMEOUT_MS: 5_000,
} as const satisfies Record<string, number>;

/** Maximum number of ids accepted by `POST /thoughts/resolve` (03-server-api.md §6.9). */
export const THOUGHT_RESOLVE_MAX_IDS = 100;

// ---------------------------------------------------------------------------
// «Структуры мыслей» view (L15)
// ---------------------------------------------------------------------------

/** Page size of the structures result list and the «Показать ещё» step (08-ui-spec.md §15.4). */
export const STRUCTURES_PAGE_SIZE = 100;

/** Hard maximum of `limit` in `POST /thoughts/query` (03-server-api.md §6.10). */
export const STRUCTURES_QUERY_MAX_LIMIT = 100;

/** Max neighbors returned per hierarchy expansion node (03-server-api.md §6.11). */
export const STRUCTURES_NODE_NEIGHBORS_LIMIT = 100;

/** Max ids accepted in hierarchy `exclude_ids` (03-server-api.md §6.11). */
export const HIERARCHY_EXCLUDE_MAX_IDS = 1000;

/** Maximum length of a saved filter name (03-server-api.md §18). */
export const SAVED_FILTER_NAME_MAX = 200;
