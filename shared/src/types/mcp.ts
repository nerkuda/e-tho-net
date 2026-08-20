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
import type { PropertyValueValue } from './thought-type.js';

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
  // mutate (§4.2)
  'etn.thoughts.create',
  'etn.thoughts.update',
  'etn.thoughts.delete',
  'etn.thoughts.set_active',
  'etn.links.create',
  'etn.links.delete',
  'etn.comments.upsert',
  'etn.attachments.add',
  'etn.properties.set',
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

/** Parameters of `etn.properties.set` (05-mcp-server.md §4.2). */
export interface McpPropertiesSetParams {
  network_id: string;
  owner_type: PropertyOwnerType;
  owner_id: string;
  key: string;
  value: PropertyValueValue;
}

/** `dir` parameter shared by read tools that accept a direction. */
export type McpNeighborDir = FocusDir;
