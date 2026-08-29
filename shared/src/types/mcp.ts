/**
 * Minimal MCP (Model Context Protocol) interface types shared between the MCP
 * facade and the rest of the codebase.
 *
 * The MCP server (docs/05-mcp-server.md) is a thin facade over the same domain
 * layer as REST, so most payloads reuse the DTOs declared next to it. This file
 * only pins the stable *names* of tools, prompts and resource URIs plus the
 * common mutation-result shape. Full per-tool parameter types are defined in
 * the MCP task (phase F).
 */

import type {
  AttachmentKind,
  AttachmentOwnerType,
  CommentKind,
  CommentOwnerType,
  ExportFormat,
  FocusDir,
  LinkStyle,
  McpViewMode,
  PropertyOwnerType,
  RealtimeAudience,
  SearchScope,
} from '../enums.js';
import type { CommentUpdateInput } from './comment.js';
import type { EffectiveTypeProperty, PropertyValueValue } from './thought-type.js';
import type { RealtimeEventType } from './realtime.js';
import type {
  ThoughtBundleMatchKind,
  ThoughtBundleOnDuplicate,
  ThoughtBundleThoughtAction,
} from './thought-bundle.js';
import type { ThoughtCardWarning } from './thought-card-warning.js';
import type { Link } from './link.js';
import type { Thought, ThoughtRef, ThoughtUsage } from './thought.js';

/** All tool names exposed by the ETN MCP server (05-mcp-server.md §4). */
export const MCP_TOOL_NAMES = [
  // read (§4.1)
  'etn.networks.list',
  'etn.networks.structure',
  'etn.thoughts.search',
  'etn.thoughts.query',
  'etn.thoughts.get',
  'etn.thoughts.neighbors',
  'etn.thoughts.subgraph',
  'etn.thoughts.path',
  'etn.links.get',
  'etn.thoughts.mentions',
  'etn.thoughts.backlinks',
  'etn.thoughts.usage',
  'etn.thoughts.deletion_check',
  'etn.links.deletion_check',
  'etn.trash.list',
  'etn.comments.get',
  'etn.export.subgraph',
  'etn.types.list',
  'etn.changes.list',
  'etn.metrics.reads',
  // mutate (§4.2)
  'etn.thoughts.create',
  'etn.thoughts.update',
  'etn.thoughts.delete',
  'etn.thoughts.trash',
  'etn.thoughts.set_active',
  'etn.links.create',
  'etn.links.delete',
  'etn.links.trash',
  'etn.comments.upsert',
  'etn.comments.update',
  'etn.comments.delete',
  'etn.attachments.add',
  'etn.attachments.copy',
  'etn.attachments.search',
  'etn.properties.set',
  'etn.thoughts.upsert_bundle',
  'etn.trash.purge',
  'etn.thoughts.usage_clear',
  // dedupe (§4.3)
  'etn.thoughts.find_duplicates',
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * Per-tool MCP annotations (workplan task O7, docs/05-mcp-server.md §4).
 *
 * Subset of the MCP `ToolAnnotations` schema:
 *
 * - `readOnlyHint` — `true` for every read-only tool (no DB writes, no
 *   events, no audit row). Lets clients grant automatic read access without
 *   manual permission prompts.
 * - `destructiveHint` — `true` for the three delete tools (`thoughts.delete`,
 *   `links.delete`, `comments.delete`). Combined with `readOnlyHint: false`
 *   it tells the agent host that the call needs explicit user approval.
 * - `idempotentHint` — `true` for tools whose repeated call with the same
 *   arguments produces the same final state: `thoughts.set_active`,
 *   `properties.set`, and `thoughts.upsert_bundle` (upsert semantics, O1).
 *
 * All fields are optional on the wire; tools that carry no hints (the
 * remaining mutating tools — `create`/`update`/`links.create`/comments
 * `upsert`+`update`/`attachments.add`+`copy`) are not listed here at all.
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

/**
 * Canonical per-tool annotation table (task O7). Indexed by every entry of
 * {@link MCP_TOOL_NAMES}; the {@link ReadonlyPartial} cast keeps the index
 * signature honest without forcing every tool to opt in (the spec only
 * defines three hint classes — read/destructive/idempotent — and an
 * absent hint is the documented default).
 */
export const MCP_TOOL_ANNOTATIONS: { readonly [K in McpToolName]?: McpToolAnnotations } = {
  // ---- read tools (§4.1) — readOnlyHint ---------------------------
  'etn.networks.list': { readOnlyHint: true },
  'etn.networks.structure': { readOnlyHint: true },
  'etn.thoughts.search': { readOnlyHint: true },
  'etn.thoughts.query': { readOnlyHint: true },
  'etn.thoughts.get': { readOnlyHint: true },
  'etn.thoughts.neighbors': { readOnlyHint: true },
  'etn.thoughts.subgraph': { readOnlyHint: true },
  'etn.thoughts.path': { readOnlyHint: true },
  'etn.links.get': { readOnlyHint: true },
  'etn.thoughts.mentions': { readOnlyHint: true },
  'etn.thoughts.backlinks': { readOnlyHint: true },
  'etn.thoughts.usage': { readOnlyHint: true },
  'etn.thoughts.deletion_check': { readOnlyHint: true },
  'etn.links.deletion_check': { readOnlyHint: true },
  'etn.trash.list': { readOnlyHint: true },
  'etn.comments.get': { readOnlyHint: true },
  'etn.export.subgraph': { readOnlyHint: true },
  'etn.types.list': { readOnlyHint: true },
  'etn.changes.list': { readOnlyHint: true },
  'etn.metrics.reads': { readOnlyHint: true },
  'etn.attachments.search': { readOnlyHint: true },
  'etn.thoughts.find_duplicates': { readOnlyHint: true },

  // ---- mutating tools — destructiveHint ---------------------------
  'etn.thoughts.delete': { destructiveHint: true },
  'etn.links.delete': { destructiveHint: true },
  'etn.comments.delete': { destructiveHint: true },
  'etn.trash.purge': { destructiveHint: true },

  // ---- mutating tools — idempotentHint ----------------------------
  'etn.thoughts.set_active': { idempotentHint: true },
  'etn.thoughts.trash': { idempotentHint: true },
  'etn.links.trash': { idempotentHint: true },
  'etn.properties.set': { idempotentHint: true },
  'etn.thoughts.upsert_bundle': { idempotentHint: true },
};

/** All prompt names exposed by the ETN MCP server (05-mcp-server.md §5). */
export const MCP_PROMPT_NAMES = [
  'etn.summarize_thought',
  'etn.suggest_links',
  'etn.detect_duplicates',
  'etn.generate_report',
] as const;
export type McpPromptName = (typeof MCP_PROMPT_NAMES)[number];

/** Common result of mutating MCP tools (05-mcp-server.md §4.2). */
export interface McpMutationResult {
  id: string;
  version: number;
  request_id?: string;
  /**
   * Non-fatal warnings about the resulting card (task O6). Currently emitted
   * by `etn.thoughts.create`, `etn.thoughts.update` (when `type_id` changes)
   * and `etn.thoughts.upsert_bundle` — the call succeeded, but the card is
   * not fully compliant with its type's required-property contract. Absent
   * when no warnings apply.
   */
  warnings?: ThoughtCardWarning[];
}

/** Base shape of an `etn://` resource URI (opaque string; templated by server). */
export type McpResourceUri = string;

// ---------------------------------------------------------------------------
// Type catalogues inside read responses (task N6)
// ---------------------------------------------------------------------------

/**
 * Запись каталога типов мыслей в MCP-ответах (task N6): только типы, реально
 * встретившиеся в результате, ключ — `type_id` из записей. `description` —
 * «комментарий для AI» (инструкция и требования по типу).
 */
export interface ThoughtTypeRef {
  id: string;
  name: string;
  /** L21: parent type id; `is_root` marks the hierarchy root «основной тип». */
  parent_id: string | null;
  is_root: boolean;
  description: string | null;
  icon: string | null;
}

/**
 * Запись каталога типов связей в MCP-ответах (task N6): только типы, реально
 * встретившиеся в результате, ключ — `link_type_id`/`type_id` рёбер. Оба имени
 * даны, чтобы агент выбрал по направлению ребра (source → target =
 * `name_forward`); `description` — роль и требования по типу связи.
 */
export interface LinkTypeRef {
  id: string;
  name_forward: string;
  name_reverse: string;
  /** L21: parent type id; `is_root` marks the hierarchy root «основной тип». */
  parent_id: string | null;
  is_root: boolean;
  description: string | null;
  color: string | null;
  style: LinkStyle | null;
}

// ---------------------------------------------------------------------------
// `etn.types.list` (task O4, 05-mcp-server.md §4.1) — full type catalogues
// with effective (L21 chain-resolved) property definitions.
// ---------------------------------------------------------------------------

/** A thought type entry of `etn.types.list`: {@link ThoughtTypeRef} + its
 *  effective property list (own + inherited along the L21 chain). */
export interface McpThoughtTypeEntry extends ThoughtTypeRef {
  properties: EffectiveTypeProperty[];
}

/** A link type entry of `etn.types.list`: {@link LinkTypeRef} + its effective
 *  property list (own + inherited along the L21 chain). */
export interface McpLinkTypeEntry extends LinkTypeRef {
  properties: EffectiveTypeProperty[];
}

/** Which catalogue(s) `etn.types.list` returns (05-mcp-server.md §5.1b). */
export const TYPES_LIST_SCOPES = ['thoughts', 'links', 'all'] as const;
export type TypesListScope = (typeof TYPES_LIST_SCOPES)[number];

/** Result of `etn.types.list` — both catalogues in full (not just the types
 *  used in some other response, unlike {@link ThoughtTypeRef}/{@link LinkTypeRef}
 *  reference tables). With `scope: "thoughts"` / `"links"` only the matching
 *  field is present. */
export interface McpTypesListResult {
  thought_types?: McpThoughtTypeEntry[];
  link_types?: McpLinkTypeEntry[];
}

// ---------------------------------------------------------------------------
// Reused tool parameter shapes (subset — the MCP task adds the rest)
// ---------------------------------------------------------------------------

/** Parameters of `etn.thoughts.create` (05-mcp-server.md §4.2). */
export interface McpCreateThoughtParams {
  network_id: string;
  title: string;
  synonyms?: string[];
  type_id?: string | null;
  active?: boolean;
  link?: {
    /**
     * Role of `target_thought_id` for the NEW thought (bug fix 045):
     * `parent` — attach the new thought UNDER the target (target becomes its
     * parent); `child` — the NEW thought becomes the parent of the target.
     * NOTE: opposite of the REST `create_link.direction` (03-server-api.md
     * §6.3) — the MCP layer translates at its boundary.
     */
    direction: 'parent' | 'child';
    target_thought_id: string;
    type_id?: string | null;
  };
}

/** Parameters of `etn.thoughts.search` (05-mcp-server.md §4.1). */
export interface McpSearchParams {
  network_id: string;
  query: string;
  scope?: SearchScope;
  in_subtree_of?: string;
  type_id?: string | null;
  limit?: number;
}

/** Parameters of `etn.thoughts.subgraph` (05-mcp-server.md §4.1). */
export interface McpSubgraphParams {
  network_id: string;
  seed_ids: string[];
  radius: number;
  max_nodes?: number;
  /**
   * Task O13 — soft cap on the JSON-encoded response size (in characters).
   * When the subgraph would exceed the budget, the server first shortens
   * comment previews (`SUBGRAPH_BUDGET_PREVIEW_CHARS`) and then drops the
   * farthest nodes (BFS level) until it fits, reporting the truncation via
   * `truncated: true` and a `reason` in
   * `{ "max_nodes" | "max_chars_preview" | "max_chars_nodes" }`.
   */
  max_chars?: number;
  include_comments?: boolean;
}

/**
 * Reason the server had to truncate an `etn.thoughts.subgraph` response
 * (task O13). `max_nodes` — the hard `max_nodes_per_subgraph` cap fired first.
 * `max_chars_preview` — the byte budget was met after shrinking every comment
 * preview body to `SUBGRAPH_BUDGET_PREVIEW_CHARS`. `max_chars_nodes` — even
 * with shrunk previews the budget was too tight, so the server additionally
 * dropped the farthest nodes (and their incident edges).
 */
export type McpSubgraphTruncationReason =
  | 'max_nodes'
  | 'max_chars_preview'
  | 'max_chars_nodes';

/** Parameters of `etn.export.subgraph` (05-mcp-server.md §4.1). */
export interface McpExportSubgraphParams {
  network_id: string;
  seed_ids: string[];
  radius: number;
  format?: ExportFormat;
}

/** Parameters of `etn.comments.upsert` (05-mcp-server.md §4.2). */
export interface McpCommentsUpsertParams {
  network_id: string;
  owner_type: CommentOwnerType;
  owner_id: string;
  kind: CommentKind;
  title?: string | null;
  body_md: string;
  valid_from?: string;
  valid_to?: string | null;
}

/** Parameters of `etn.comments.update` (05-mcp-server.md §4.2). */
export interface McpCommentsUpdateParams {
  network_id: string;
  comment_id: string;
  changes: CommentUpdateInput;
  expected_version?: number;
}

/** Parameters of `etn.comments.delete` (05-mcp-server.md §4.2). */
export interface McpCommentsDeleteParams {
  network_id: string;
  comment_id: string;
  expected_version?: number;
}

/** Parameters of `etn.attachments.add` (05-mcp-server.md §4.2). */
export interface McpAttachmentsAddParams {
  network_id: string;
  owner_type: AttachmentOwnerType;
  owner_id: string;
  kind: AttachmentKind;
  url?: string | null;
  file_path?: string | null;
  title?: string | null;
  description?: string | null;
}

/**
 * Parameters of `etn.attachments.copy` (05-mcp-server.md §4.2, workplan L25).
 * Each `target_owner_ids[i]` receives a new attachment row with the same
 * visible fields as the source; duplicates in a target thought are skipped
 * silently. Returns one `McpMutationResult` per created row.
 */
export interface McpAttachmentsCopyParams {
  network_id: string;
  attachment_id: string;
  target_owner_type: AttachmentOwnerType;
  target_owner_ids: string[];
}

/** Parameters of `etn.attachments.search` (05-mcp-server.md §4.2, workplan L25). */
export interface McpAttachmentsSearchParams {
  network_id: string;
  q: string;
  kind?: AttachmentKind;
  exclude_owner_type?: AttachmentOwnerType;
  exclude_owner_id?: string;
  limit?: number;
  offset?: number;
}

/** Parameters of `etn.properties.set` (05-mcp-server.md §4.2). */
export interface McpPropertiesSetParams {
  network_id: string;
  owner_type: PropertyOwnerType;
  owner_id: string;
  /** Single-property form (backward compatible): write/clear one key. */
  key?: string;
  value?: PropertyValueValue;
  /** Bulk form (task O2): write a set of keys in one transaction. */
  values?: Record<string, PropertyValueValue>;
}

/** Result of `etn.properties.set` (05-mcp-server.md §4.2). */
export interface McpPropertiesSetResult {
  /** Id of the single stored value (`key`/`value` form); absent for `values`. */
  id?: string;
  version: number;
  /** Per-key stored value ids, returned for the `values` form. */
  values?: Record<string, { id: string }>;
  request_id?: string;
}

/** Parameters of `etn.thoughts.upsert_bundle` (05-mcp-server.md §4.2a). */
export interface McpUpsertBundleParams {
  network_id: string;
  /** Existing thought to augment in-place; mutually exclusive with `thought`
   *  being the sole way to address a target (exactly one of the two required). */
  thought_id?: string;
  thought?: {
    title: string;
    synonyms?: string[];
    type_id?: string | null;
    active?: boolean;
  };
  /** Only consulted when `thought_id` is absent and `find_duplicates` matches. */
  on_duplicate?: ThoughtBundleOnDuplicate;
  /** Always the owner's permanent comment (create-or-update). */
  comment?: {
    title?: string | null;
    body_md: string;
    valid_from?: string;
    valid_to?: string | null;
  };
  properties?: Record<string, PropertyValueValue>;
  links?: Array<{
    /**
     * Role of `target_thought_id` for the bundle thought (bug fix 045):
     * `parent` — attach the bundle thought UNDER the target (target becomes
     * its parent); `child` — the bundle thought becomes the parent of the
     * target. NOTE: opposite of the domain/REST direction — the MCP layer
     * translates at its boundary.
     */
    direction: 'parent' | 'child';
    target_thought_id: string;
    type_id?: string | null;
  }>;
  attachments?: Array<{
    kind: AttachmentKind;
    url?: string | null;
    file_path?: string | null;
    title?: string | null;
    description?: string | null;
  }>;
}

/** Result of `etn.thoughts.upsert_bundle` (05-mcp-server.md §4.2a). */
export interface McpUpsertBundleResult extends McpMutationResult {
  thought_action: ThoughtBundleThoughtAction;
  matched_on: ThoughtBundleMatchKind | null;
  comment?: { id: string; version: number };
  properties?: Record<string, { id: string }>;
  links?: Array<{ id: string; version: number }>;
  attachments?: Array<{ id: string }>;
  /**
   * "Card completeness" warnings (task O6) — always an array, possibly empty.
   * Overrides the optional {@link McpMutationResult.warnings} for this tool so
   * callers can rely on the field being present.
   */
  warnings: ThoughtCardWarning[];
}

/** `dir` parameter shared by read tools that accept a direction. */
export type McpNeighborDir = FocusDir;

// ---------------------------------------------------------------------------
// `etn.changes.list` (task O9, 05-mcp-server.md §4.1) — delta feed over the
// real-time event_log for long-lived agents with their own cache. The agent
// passes the highest `seq` it has already consumed; the server replays events
// with `seq > since_seq` (ascending) and signals `truncated` when the requested
// position falls outside the retained buffer window.
// ---------------------------------------------------------------------------

/** Parameters of `etn.changes.list` (05-mcp-server.md §4.1). */
export interface McpChangesListParams {
  network_id: string;
  /**
   * Exclusive lower bound: return only events with `seq > since_seq`. `0`
   * means «from the start of the buffer».
   */
  since_seq: number;
  /**
   * Hard cap on returned events (ascending). Defaults to a safe value when
   * omitted; agents tailing the feed should keep `limit` reasonable to avoid
   * one huge response on the first call after a long offline period.
   */
  limit?: number;
}

/**
 * One row of the `etn.changes.list` response — the same event envelope the
 * WebSocket gateway delivers, but with `network_id` lifted to the response
 * level (every row belongs to the requested network) and `actor`/`meta`
 * stripped (they are not useful for the delta-feed use case and would inflate
 * the response).
 */
export interface McpChangeEntry {
  type: RealtimeEventType;
  seq: number;
  /** ISO-8601 UTC. */
  ts: string;
  /**
   * The event's payload (`RealtimeEvent.data`). The catalogue-driven type
   * union is preserved so agents can `switch` on `type` with full payload
   * shape, but the wrapping is loose at this layer because the runtime row
   * is rebuilt from JSON.
   */
  data: unknown;
  audience: RealtimeAudience;
  /**
   * The change-layer the underlying write materialised in (task S9,
   * docs/13-layers.md §12) — the same field the WebSocket envelope carries.
   * Informational for the agent (which layer produced the change): the server
   * has already applied the caller's session-layer visibility filter, so only
   * changes visible to the caller are listed.
   */
  layer_id: string;
}

/** Result of `etn.changes.list`. */
export interface McpChangesListResult {
  network_id: string;
  /**
   * Cursor describing the current retained window. `min_seq`/`max_seq` are
   * `null` when the log is empty for this network.
   */
  cursor: {
    min_seq: number | null;
    max_seq: number | null;
  };
  /** Replayed events with `seq > since_seq`, ascending. */
  events: McpChangeEntry[];
  /**
   * `true` when `since_seq` falls outside the retained buffer window (either
   * the requested position is older than `min_seq - 1`, or the buffer was
   * truncated by the cleanup job while the agent was offline), or when the
   * caller's session layer changed after `since_seq` (task S9, 13-layers.md
   * §12 — a delta spanning the switch would mix two layers' visibility
   * filters). The agent must do a full resync (e.g. `etn.thoughts.search` +
   * `etn.thoughts.get`) before it can resume delta tracking. Always `false`
   * for an empty buffer (nothing was lost — the agent just starts at the
   * beginning).
   */
  truncated: boolean;
  /** Effective cap actually applied (echoes `limit` or the default). */
  limit: number;
}

// ---------------------------------------------------------------------------
// `etn.metrics.reads` (task O10, 05-mcp-server.md §5.1) — usage analytics
// for the knowledge base. Returns either the top-read thoughts or the cold
// ones (never read, or not read since `since`), so the network owner can
// surface dead zones and over-heated nodes driven by AI-agent traffic.
// ---------------------------------------------------------------------------

/** Selection for `etn.metrics.reads`. */
export type McpMetricsReadsKind = 'top' | 'cold';

/** Parameters of `etn.metrics.reads` (05-mcp-server.md §5.1). */
export interface McpMetricsReadsParams {
  network_id: string;
  /**
   * Selection:
   *  - `'top'` (default) — thoughts with the highest `reads_count`, ordered
   *    by `(reads_count DESC, last_read_at DESC)`. Useful for «hot spots».
   *  - `'cold'` — thoughts that have not been read by MCP tools in the
   *    selected window. Without `since`: never read at all (zero
   *    `reads_count`). With `since`: `last_read_at < since` (or never
   *    read). Ordered by `updated_at DESC` so the freshest nodes surface
   *    first — the typical «dead zone» the owner cares about.
   */
  kind?: McpMetricsReadsKind;
  /**
   * ISO-8601 timestamp. Only consulted for `kind: 'cold'`: keeps thoughts
   * whose `last_read_at` is `null` or older than this value. Ignored for
   * `kind: 'top'`.
   */
  since?: string;
  /**
   * Maximum number of items returned. Default 20, hard cap 200.
   */
  limit?: number;
  /**
   * When `false` (default), only active thoughts (`active = 1`) are
   * considered. Pass `true` to include inactive nodes in the result.
   */
  include_inactive?: boolean;
}

/** One row of `etn.metrics.reads`. `title`/`type_id` come from `thoughts`
 *  joined to the aggregate row. `reads_count` is `0` for never-read rows
 *  produced by `kind: 'cold'` — there is no `thought_read_metrics` row in
 *  that case, the server synthesises the entry on the fly. */
export interface McpMetricsReadsItem {
  thought_id: string;
  title: string;
  type_id: string | null;
  /** Always present. `0` when the thought has never been read. */
  reads_count: number;
  /** `null` until the first read. */
  first_read_at: string | null;
  /** `null` until the first read. */
  last_read_at: string | null;
}

/** Result of `etn.metrics.reads`. */
export interface McpMetricsReadsResult {
  network_id: string;
  /** Echo of the effective `kind`. */
  kind: McpMetricsReadsKind;
  /** Echo of the effective `since` (or `null` for `kind: 'top'`). */
  since: string | null;
  /** Echo of the effective `limit`. */
  limit: number;
  /** Up to `limit` thoughts ordered per `kind`. */
  items: McpMetricsReadsItem[];
  /** Reference table of thought types referenced by `items[].type_id`
   *  (task N6). Same `Record<type_id, ThoughtTypeRef>` shape as the other
   *  read tools (`etn.thoughts.query`, `subgraph`, `neighbors`). */
  thought_types: Record<string, ThoughtTypeRef>;
}

// ---------------------------------------------------------------------------
// Compact response projection (task O12, docs/05-mcp-server.md §4.1)
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement of {@link Thought} for MCP read tools called with
 * `view: 'compact'`. Drops purely visual and service fields the agent never
 * consumes (text/background colours, font-style flags, icon attachment id,
 * `is_protected`/`is_root`); `icon` (the emoji / image reference itself) is
 * kept because it carries semantic information the agent uses to recognise a
 * node. Everything else — id, title, type, synonyms, lifecycle timestamps —
 * is identical to the full projection.
 */
export type CompactThought = Omit<
  Thought,
  | 'fg_color'
  | 'bg_color'
  | 'font_bold'
  | 'font_italic'
  | 'font_underline'
  | 'font_strike'
  | 'icon_kind'
  | 'icon_attachment_id'
  | 'is_protected'
  | 'is_root'
>;

/**
 * Drop-in replacement of {@link ThoughtRef} for the neighbours catalogue and
 * `etn.thoughts.usage`. The reference already only carries style fields
 * (`fg_color`, `bg_color`, `font_*`, `icon_attachment_id`), so the compact
 * projection strips those and keeps the identity / lifecycle subset.
 */
export type CompactThoughtRef = Omit<
  ThoughtRef,
  | 'fg_color'
  | 'bg_color'
  | 'font_bold'
  | 'font_italic'
  | 'font_underline'
  | 'font_strike'
  | 'icon_kind'
  | 'icon_attachment_id'
>;

/**
 * Drop-in replacement of {@link Link} for edges returned by MCP read tools
 * (`etn.thoughts.subgraph`, …) under `view: 'compact'`. Drops the
 * per-link style overrides (`color`, `style`, `width`) — agents do not
 * re-render the canvas, only reason over the topology.
 */
export type CompactLink = Omit<Link, 'color' | 'style' | 'width'>;

/**
 * Drop-in replacement of {@link LinkTypeRef} inside the read-tool reference
 * tables (`etn.thoughts.subgraph`, `neighbors`, `usage`) under
 * `view: 'compact'`. Drops the visual line-style fields — agents consume
 * `name_forward`/`name_reverse`/`description` to reason about the type, not
 * to render it.
 */
export type CompactLinkTypeRef = Omit<LinkTypeRef, 'color' | 'style'>;

/**
 * `etn.thoughts.usage` result with a {@link CompactThoughtRef} catalogue —
 * the wrapper preserves `total`/`groups`; the only change is the
 * `groups[].thoughts[]` element shape under `view: 'compact'`.
 */
export interface CompactThoughtUsage
  extends Omit<ThoughtUsage, 'groups'> {
  groups: Array<{
    property_id: string;
    key: string;
    thoughts: CompactThoughtRef[];
  }>;
}

// ---------------------------------------------------------------------------
// `etn.thoughts.get` / `neighbors` / `subgraph` / `usage` — view=compact
// ---------------------------------------------------------------------------

/**
 * Parameters shared by all MCP read tools that honour `view` (task O12):
 * `etn.thoughts.get`, `etn.thoughts.neighbors`, `etn.thoughts.subgraph`,
 * `etn.thoughts.usage`. `compact` is the default for MCP responses; `full`
 * preserves the pre-O12 shape for callers that still need the visual fields.
 *
 * The view only changes the *fields* returned on individual entities
 * (thoughts / links / link-type catalogue); the envelope shape (top-level
 * keys, types of `meta` / `properties` / `comments`) is preserved across the
 * two projections — callers can safely ignore `view` and only inspect the
 * fields they need.
 */
export interface McpReadViewParam {
  /**
   * Response projection. `compact` (default for MCP) drops visual/service
   * fields that the agent never consumes — saves a meaningful share of tokens
   * on large `etn.thoughts.subgraph` responses. `full` returns the legacy
   * shape unchanged.
   */
  view?: McpViewMode;
}

