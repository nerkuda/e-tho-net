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
  PropertyOwnerType,
  SearchScope,
} from '../enums.js';
import type { CommentUpdateInput } from './comment.js';
import type { EffectiveTypeProperty, PropertyValueValue } from './thought-type.js';
import type {
  ThoughtBundleMatchKind,
  ThoughtBundleOnDuplicate,
  ThoughtBundleThoughtAction,
} from './thought-bundle.js';

/** All tool names exposed by the ETN MCP server (05-mcp-server.md §4). */
export const MCP_TOOL_NAMES = [
  // read (§4.1)
  'etn.networks.list',
  'etn.thoughts.search',
  'etn.thoughts.query',
  'etn.thoughts.get',
  'etn.thoughts.neighbors',
  'etn.thoughts.subgraph',
  'etn.thoughts.path',
  'etn.links.get',
  'etn.thoughts.mentions',
  'etn.thoughts.usage',
  'etn.comments.get',
  'etn.export.subgraph',
  'etn.types.list',
  // mutate (§4.2)
  'etn.thoughts.create',
  'etn.thoughts.update',
  'etn.thoughts.delete',
  'etn.thoughts.set_active',
  'etn.links.create',
  'etn.links.delete',
  'etn.comments.upsert',
  'etn.comments.update',
  'etn.comments.delete',
  'etn.attachments.add',
  'etn.attachments.copy',
  'etn.attachments.search',
  'etn.properties.set',
  'etn.thoughts.upsert_bundle',
  // dedupe (§4.3)
  'etn.thoughts.find_duplicates',
] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

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

/** Result of `etn.types.list` — both catalogues in full (not just the types
 *  used in some other response, unlike {@link ThoughtTypeRef}/{@link LinkTypeRef}
 *  reference tables). */
export interface McpTypesListResult {
  thought_types: McpThoughtTypeEntry[];
  link_types: McpLinkTypeEntry[];
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
  include_comments?: boolean;
}

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
}

/** `dir` parameter shared by read tools that accept a direction. */
export type McpNeighborDir = FocusDir;
