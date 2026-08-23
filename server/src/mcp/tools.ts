/**
 * MCP tools (task F4, docs/05-mcp-server.md §4).
 *
 * Thirty-one tools in three groups:
 *   * read (§4.1) — networks list, search, query, get, neighbours, subgraph,
 *     path, links get, mentions, usage, comments get, export, types list,
 *     changes list (O9), metrics.reads (O10);
 *   * mutate (§4.2) — thought/link CRUD, comments.upsert/update/delete,
 *     attachments.add, properties.set, set_active, thoughts.upsert_bundle,
 *     attachments.search;
 *   * dedupe (§4.3) — find_duplicates.
 *
 * `etn.thoughts.create`, `etn.links.create` and `etn.thoughts.upsert_bundle`
 * additionally accept a type **by name** (`type`, task O4) as an alternative
 * to `type_id` — resolved case-insensitively against `etn.types.list`'s
 * catalogues before the domain call.
 *
 * Mutating tools are facades over the **same domain services as REST**
 * (05 §7): membership is re-checked per call, the read-only flag and the
 * per-minute write budget are enforced, each successful write emits its
 * catalogue real-time event via {@link emitAgentEvent} and appends an
 * `audit_log` row (category `data`) via {@link auditAgentCall} — so agent-made
 * changes fan out to network participants exactly like human ones.
 *
 * MCP annotations (task O7) — every registration references the canonical
 * registry {@link MCP_TOOL_ANNOTATIONS} for `readOnlyHint`/`destructiveHint`/
 * `idempotentHint` so client UIs can show meaningful permission prompts
 * without per-tool hand-tuning.
 *
 * Tool names and result shapes reuse `@etn/shared` MCP contracts
 * ({@link MCP_TOOL_NAMES}, {@link McpMutationResult}).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { NetworkDb } from '../db/network-db.js';
import { openNetworkDb } from '../db/network-db.js';

import {
  ATTACHMENT_KINDS,
  COMMENT_KINDS,
  COMMENT_OWNER_TYPES,
  COMMENT_TARGETS_MAX,
  EtnError,
  EXPORT_FORMATS,
  FOCUS_DIRS,
  ICON_KINDS,
  MCP_TOOL_ANNOTATIONS,
  MCP_VIEW_MODES,
  PROPERTY_OWNER_TYPES,
  REALTIME_DEFAULTS,
  SEARCH_SCOPES,
  TRAVERSAL_DEFAULTS,
  type CommentTarget,
  type ExportFormat,
  type McpChangeEntry,
  type McpChangesListParams,
  type McpChangesListResult,
  type McpMetricsReadsResult,
  type McpMutationResult,
  type McpPropertiesSetResult,
  type McpTypesListResult,
  type McpUpsertBundleResult,
  type McpViewMode,
} from '@etn/shared';

import {
  createThought,
  createThoughtWithWarnings,
  deleteThought,
  getNeighbors,
  getThoughtOrThrow,
  updateThought,
  updateThoughtWithWarnings,
} from '../domain/thought-service.js';
import { createLink, deleteLink, findLinksBetween, getLink } from '../domain/link-service.js';
import {
  createCommentWithTargets,
  deleteComment,
  getComment,
  getCommentsPreview,
  getPermanentPreview,
  listComments,
  updateComment,
} from '../domain/comment-service.js';
import { createAttachment } from '../domain/attachment-service.js';
import {
  copyAttachment,
  searchAttachments,
} from '../domain/attachment-service.js';
import {
  findThoughtUsage,
  getPropertyValuesResolved,
  listEffectiveTypeProperties,
  setPropertyValue,
  setPropertyValues,
} from '../domain/property-service.js';
import { findBacklinks } from '../domain/backlinks-service.js';
import {
  collectSubtreeTypes,
  findDuplicates,
  findMentions,
  resolveThoughts,
  search,
} from '../domain/search-service.js';
import { shrinkSubgraphToBudget } from './subgraph-budget.js';
import { upsertThoughtBundle } from '../domain/thought-bundle-service.js';
import { queryThoughts } from '../domain/query-service.js';
import { getThoughtMeta } from '../domain/thought-meta.js';
import {
  clampReadMetricsParams,
  getColdReads,
  getTopReads,
  recordReads,
} from '../domain/read-metrics-service.js';
import {
  linkTypeCatalog,
  linkTypeCatalogCompact,
  thoughtTypeCatalog,
  toCompactLink,
  toCompactThought,
  toCompactThoughtRef,
} from './catalogs.js';
import { exportToMarkdown, getExportJobContent, startExportJob } from '../domain/export-service.js';
import { findPath, subgraph, traverse } from '../domain/graph-traversal.js';
import {
  getThoughtType,
  listThoughtTypes,
  resolveThoughtTypeIdByName,
} from '../domain/thought-type-service.js';
import {
  getLinkType,
  listLinkTypes,
  resolveLinkTypeIdByName,
} from '../domain/link-type-service.js';
import {
  auditAgentCall,
  emitAgentEvent,
  openMemberNetwork,
  requireWriteBudget,
  requireWritable,
  runTool,
  type McpRuntime,
} from './context.js';

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const NetworkId = z.string().min(1);
const ThoughtId = z.string().min(1);
const LinkId = z.string().min(1);
const ExpectedVersion = z.number().int().min(1).optional();

/**
 * Response projection accepted by the read tools that support it (task O12,
 * docs/05-mcp-server.md §4.1): `etn.thoughts.get`, `…neighbors`,
 * `…subgraph`, `…usage`. `compact` (default) drops purely visual and
 * service fields the agent never consumes; `full` keeps the legacy shape.
 */
const View = z
  .enum(MCP_VIEW_MODES)
  .optional()
  .describe(
    "Response projection: 'compact' (default, drops visual/service fields) or 'full' (legacy shape).",
  );

/** Error text shared by every `type_id`/`type` pair (task O4). */
const TYPE_ID_TYPE_CONFLICT = 'provide at most one of type_id or type';

/** Optional link attached to a freshly created thought (§4.2). `type` (task
 *  O4) resolves a link type by `name_forward`/`name_reverse`, mutually
 *  exclusive with `type_id`. */
const CreateLink = z
  .object({
    direction: z.enum(['parent', 'child']),
    target_thought_id: ThoughtId,
    type_id: z.string().min(1).nullable().optional(),
    type: z.string().min(1).optional(),
  })
  .refine((v) => v.type_id === undefined || v.type === undefined, { message: TYPE_ID_TYPE_CONFLICT })
  .optional();

/** Field subset accepted by `etn.thoughts.update` (mirrors `ThoughtUpdateInput`). */
const ThoughtChanges = z
  .object({
    title: z.string().min(1).optional(),
    synonyms: z.array(z.string().min(1)).optional(),
    type_id: z.string().min(1).nullable().optional(),
    icon: z.string().nullable().optional(),
    icon_kind: z.enum(ICON_KINDS).optional(),
    active: z.boolean().optional(),
    fg_color: z.string().nullable().optional(),
    bg_color: z.string().nullable().optional(),
    font_bold: z.boolean().optional(),
    font_italic: z.boolean().optional(),
    font_underline: z.boolean().optional(),
    font_strike: z.boolean().optional(),
  })
  .refine((c) => Object.keys(c).length > 0, { message: 'changes must not be empty' });

/**
 * Resolve a thought's effective `type_id`: `type_id` as given, or the id
 * resolved from `type` (by name, task O4). Schema `.refine()`s guarantee the
 * two are never both present.
 */
function effectiveThoughtTypeId(
  ndb: NetworkDb,
  typeId: string | null | undefined,
  typeName: string | undefined,
): string | null | undefined {
  return typeName === undefined ? typeId : resolveThoughtTypeIdByName(ndb, typeName);
}

/**
 * Resolve a link's effective `type_id`: `type_id` as given, or the id
 * resolved from `type` (by `name_forward`/`name_reverse`, task O4). Schema
 * `.refine()`s guarantee the two are never both present.
 */
function effectiveLinkTypeId(
  ndb: NetworkDb,
  typeId: string | null | undefined,
  typeName: string | undefined,
): string | null | undefined {
  return typeName === undefined ? typeId : resolveLinkTypeIdByName(ndb, typeName);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all thirty `etn.*` tools on a freshly built {@link McpServer}.
 */
export function registerTools(mcp: McpServer, rt: McpRuntime): void {
  // =========================================================================
  // Read tools (§4.1)
  // =========================================================================

  mcp.registerTool(
    'etn.networks.list',
    {
      title: 'Список сетей',
      description:
        "List every network the API key's user belongs to, with role and member counts, plus " +
        "the network's `description` and `when_to_use` fields (task O5, docs/05-mcp-server.md §3). " +
        'Each item carries `has_structure: true|false` — when true, the network declares a node ' +
        'section type and exposes its machine-readable structure via `etn.networks.structure`. ' +
        'The agent may only operate on networks returned here.',
      annotations: MCP_TOOL_ANNOTATIONS['etn.networks.list'],
    },
    () =>
      runTool(async () => {
        return rt.deps.systemDb.listNetworksForUser(rt.deps.auth.userId);
      }),
  );

  // etn.networks.structure — O5 read tool. Returns the active thoughts of the
  // network's `node_section_type_id` (or an empty structure with `has_structure:
  // false`). Each section is enriched with a permanent-comment preview, property
  // values, neighbour counts and a usage_count (N3) — the same shape agents
  // already know from `etn.thoughts.get` / `etn.thoughts.usage`, so an agent can
  // dive from a structure node straight into a full read.
  const NetworksStructureSchema = z.object({ network_id: NetworkId });
  mcp.registerTool(
    'etn.networks.structure',
    {
      title: 'Структура сети',
      description:
        'Read the network structure declared via the `node_section_type_id` setting ' +
        '(task O5, docs/05-mcp-server.md §4.1). Returns the active thoughts of that type ' +
        'with permanent-comment previews (2000 chars, `truncated` + `comment_id` to fetch ' +
        'full text via `etn.comments.get`), resolved property values, neighbour counters ' +
        '(`parents_count`, `children_count`, `attachments_count`, `usage_count`) and the ' +
        'reference table of thought types actually used. When `has_structure: false`, the ' +
        '`sections` list is empty and the agent should fall back to search/query.',
      inputSchema: NetworksStructureSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.networks.structure'],
    },
    (args) =>
      runTool(async () => {
        const network = rt.deps.systemDb.getNetworkById(args.network_id);
        if (network === null) {
          throw new EtnError('NOT_FOUND', `Network ${args.network_id} not found.`);
        }
        // Membership re-check mirrors `openMemberNetwork` (here we only need a
        // single read, so we do not need the ndb unless the network has a
        // structure marker).
        const role = rt.deps.systemDb.getMemberRole(rt.deps.auth.userId, args.network_id);
        if (role === null) {
          throw new EtnError(
            'FORBIDDEN',
            `You are not a member of network ${args.network_id}; this API key cannot access it.`,
            { network_id: args.network_id },
          );
        }
        if (network.node_section_type_id === null) {
          return {
            network_id: args.network_id,
            has_structure: false as const,
            node_section_type_id: null,
            sections: [],
            thought_types: [],
          };
        }
        const ndb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger);
        const sectionTypeId = network.node_section_type_id;
        const rows = ndb
          .prepare(
            `SELECT id, title, type_id, active, version, created_at, updated_at
               FROM thoughts
              WHERE type_id = ? AND active = 1
              ORDER BY created_at ASC`,
          )
          .all(sectionTypeId) as Array<{
          id: string;
          title: string;
          type_id: string | null;
          active: number;
          version: number;
          created_at: string;
          updated_at: string;
        }>;

        const sections = rows.map((row) => {
          const meta = getThoughtMeta(ndb, row.id);
          const permanent = getPermanentPreview(ndb, 'thought', row.id);
          const properties = getPropertyValuesResolved(ndb, 'thought', row.id);
          const usage = findThoughtUsage(ndb, row.id);
          return {
            id: row.id,
            title: row.title,
            type_id: row.type_id,
            version: row.version,
            created_at: row.created_at,
            updated_at: row.updated_at,
            counters: {
              parents_count: meta.parents_count,
              children_count: meta.children_count,
              attachments_count: meta.attachments_count,
              usage_count: usage.total,
            },
            permanent,
            properties,
          };
        });

        // O10: count every section the agent looked at while reading the
        // network's structure. `nodes_section_type_id` rows are typically a
        // handful, so this is a tiny batch — kept here for completeness so
        // the owner can see "the agent loaded these sections N times".
        recordReads(ndb, sections.map((s) => s.id), { now: new Date().toISOString() });

        // Reference table: the network's section type plus every other type
        // referenced by the section nodes (caller can dive further without an
        // extra `etn.types.list` round trip).
        const sectionType = getThoughtType(ndb, sectionTypeId);
        const referencedTypeIds = Array.from(
          new Set(
            sections
              .map((s) => s.type_id)
              .filter((tid): tid is string => typeof tid === 'string'),
          ),
        );
        const thoughtTypes = thoughtTypeCatalog(ndb, [
          sectionTypeId,
          ...referencedTypeIds.filter((tid) => tid !== sectionTypeId),
        ]);

        return {
          network_id: args.network_id,
          has_structure: true as const,
          node_section_type_id: sectionTypeId,
          node_section_type: sectionType,
          sections,
          thought_types: thoughtTypes,
        };
      }),
  );

  const SearchSchema = z.object({
    network_id: NetworkId,
    query: z.string().min(1),
    scope: z.enum(SEARCH_SCOPES).optional(),
    in_subtree_of: ThoughtId.optional(),
    type_id: ThoughtId.nullable().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  });
  mcp.registerTool(
    'etn.thoughts.search',
    {
      title: 'Полнотекстовый поиск',
      description:
        'Full-text search across thought names, comment texts, link texts and chronology ' +
        '(docs/05-mcp-server.md §4.1, task O11). `scope` selects result groups ' +
        '(`names`/`texts`/`links`/`chronology`/`all`). `in_subtree_of` restricts to the subtree ' +
        'of a thought; `type_id` filters by thought type. Pagination: `limit` (1–200, default 50) ' +
        'and `offset` (≥ 0, default 0) — together they walk the result tail; `meta.total_in_group` ' +
        'reports the unfiltered totals per group so the agent can detect the end of the list.',
      inputSchema: SearchSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.search'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const result = search(ndb, {
          q: args.query,
          scope: args.scope,
          in: args.in_subtree_of === undefined ? undefined : 'subtree',
          from_thought_id: args.in_subtree_of,
          type_id: args.type_id === undefined || args.type_id === null ? undefined : [args.type_id],
          limit: args.limit,
          offset: args.offset,
        });
        // O10: count the thoughts referenced by name/text/chrono hits. Link hits
        // (`by_links`) carry only `link_id`, so they don't move a thought counter.
        const thoughtIds = [
          ...result.by_names.map((h) => h.thought_id),
          ...result.by_texts.map((h) => h.thought_id),
          ...result.by_chrono
            .filter((h) => h.owner === 'thought')
            .map((h) => h.owner_id),
        ];
        recordReads(ndb, thoughtIds, { now: new Date().toISOString() });
        return result;
      }),
  );

  const QueryPropertySchema = z.object({
    key: z.string().min(1),
    operator: z.enum(['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte']),
    value: z.union([z.string(), z.number(), z.boolean()]),
  });
  const QuerySchema = z.object({
    network_id: NetworkId,
    in_subtree_of: ThoughtId.optional(),
    max_depth: z.number().int().min(1).max(TRAVERSAL_DEFAULTS.MAX_DEPTH).optional(),
    type_id: z.array(z.string().min(1)).optional(),
    active: z.enum(['true', 'false', 'any']).optional(),
    keywords: z.string().min(1).optional(),
    properties: z.array(QueryPropertySchema).optional(),
    created_after: z.string().min(1).optional(),
    created_before: z.string().min(1).optional(),
    updated_after: z.string().min(1).optional(),
    updated_before: z.string().min(1).optional(),
    sort: z.enum(['title', 'created_at', 'updated_at']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  });
  mcp.registerTool(
    'etn.thoughts.query',
    {
      title: 'Структурная выборка мыслей',
      description:
        'List thoughts by criteria (docs/05-mcp-server.md §4.1) — no text query required. ' +
        'Filters combine with AND: `in_subtree_of` (+`max_depth`) restricts to the directed ' +
        'descendants of a thought (each hit carries its `depth`), `type_id[]` filters by type, ' +
        '`active` by актуальность (`true`/`false`/`any`), `keywords` by title/synonym LIKE, ' +
        '`properties` by property values (key + operator eq/ne/contains/gt/gte/lt/lte + value; ' +
        'the value type selects the column: number/boolean/string), `created_*`/`updated_*` by ' +
        'ISO-8601 date ranges. The response carries a `thought_types` reference table (name + ' +
        'AI-facing description) for every type used in `hits`. Use instead of search when ' +
        'there is no text to query.',
      inputSchema: QuerySchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.query'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const result = queryThoughts(ndb, args, { maxNodes: rt.limits.maxNodesPerSubgraph });
        // O10: count every hit in the structured query.
        recordReads(ndb, result.hits.map((h) => h.id), { now: new Date().toISOString() });
        return {
          ...result,
          thought_types: thoughtTypeCatalog(ndb, result.hits.map((h) => h.type_id)),
        };
      }),
  );

  const GetSchema = z.object({ network_id: NetworkId, thought_id: ThoughtId, view: View });
  mcp.registerTool(
    'etn.thoughts.get',
    {
      title: 'Мысль (полная)',
      description:
        'Fetch one thought with synonyms, type (with AI-facing description), styles and ' +
        'property values (`thought_ref` values resolved to {id, title}). `meta` carries ' +
        'counters and `meta.permanent` — a preview of the single permanent comment (body ' +
        'truncated to 2000 chars; `truncated` flag + comment `id`). When `truncated: true` ' +
        'fetch the full text via `etn.comments.get` (by that `id` or by this thought_id). ' +
        'Pass `view: "full"` to keep the legacy shape with every visual field (colours, font-style ' +
        'flags, icon attachment id); the default `view: "compact"` drops them (task O12).',
      inputSchema: GetSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.get'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const thought = getThoughtOrThrow(ndb, args.thought_id);
        const type = thought.type_id === null ? null : getThoughtType(ndb, thought.type_id);
        const properties = getPropertyValuesResolved(ndb, 'thought', args.thought_id);
        // O10: count this single read for `etn.metrics.reads` analytics.
        recordReads(ndb, [thought.id], { now: new Date().toISOString() });
        const meta = getThoughtMeta(ndb, args.thought_id);
        const view: McpViewMode = args.view ?? 'compact';
        // Keep the response envelope identical between views — only the
        // thought-level fields differ. `type`, `properties` and `meta` were
        // never affected by the O12 projection change.
        const projected = view === 'full' ? thought : toCompactThought(thought);
        return { ...projected, type, properties, meta };
      }),
  );

  const NeighborsSchema = z.object({
    network_id: NetworkId,
    thought_id: ThoughtId,
    dir: z.enum(FOCUS_DIRS),
    depth: z.number().int().min(1).max(TRAVERSAL_DEFAULTS.MAX_DEPTH).optional(),
    view: View,
  });
  mcp.registerTool(
    'etn.thoughts.neighbors',
    {
      title: 'Соседи мысли',
      description:
        'Direct neighbours of a thought by direction (`parents`/`children`/`siblings`). ' +
        'With `depth > 1` performs a bounded breadth-first walk returning resolved thoughts. ' +
        'Responses carry `link_types`/`thought_types` reference tables (name + AI-facing ' +
        'description) for the types actually used. `view: "compact"` (default, task O12) drops ' +
        'colours and line-style fields from the link-type catalogue and, for `depth > 1`, the ' +
        'visual fields from each resolved thought.',
      inputSchema: NeighborsSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.neighbors'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const depth = args.depth ?? 1;
        const view: McpViewMode = args.view ?? 'compact';
        if (depth === 1) {
          const thought = getThoughtOrThrow(ndb, args.thought_id);
          const neighbors = getNeighbors(ndb, args.thought_id, args.dir, {
            userId: rt.deps.auth.userId,
          });
          // `FocusNeighbor` carries no visual fields of its own (only `icon`,
          // which is semantic), so the only O12 effect at depth=1 is on the
          // link-type catalogue.
          const linkTypes =
            view === 'full'
              ? linkTypeCatalog(ndb, neighbors.map((n) => n.link_type_id))
              : linkTypeCatalogCompact(ndb, neighbors.map((n) => n.link_type_id));
          return {
            thought: { id: thought.id, title: thought.title },
            dir: args.dir,
            depth: 1,
            neighbors,
            link_types: linkTypes,
            thought_types: thoughtTypeCatalog(ndb, neighbors.map((n) => n.type_id)),
          };
        }
        const direction = args.dir === 'siblings' ? 'both' : args.dir;
        const walk = traverse(ndb, [args.thought_id], direction, {
          maxDepth: depth,
          maxNodes: rt.limits.maxNodesPerSubgraph,
        });
        const thoughts = resolveThoughts(ndb, walk.ids);
        // Depth>1 returns ThoughtRef rows (the lightweight identity slice);
        // project each entry to its compact shape under `view: 'compact'`.
        const projected =
          view === 'full' ? thoughts : thoughts.map((t) => toCompactThoughtRef(t));
        return {
          thought_id: args.thought_id,
          dir: args.dir,
          depth,
          ids: walk.ids,
          thoughts: projected,
          truncated: walk.truncated,
          reason: walk.reason ?? null,
          thought_types: thoughtTypeCatalog(ndb, thoughts.map((t) => t.type_id)),
        };
      }),
  );

  const SubgraphSchema = z.object({
    network_id: NetworkId,
    seed_ids: z.array(ThoughtId).min(1).max(50),
    radius: z.number().int().min(0).max(TRAVERSAL_DEFAULTS.MAX_DEPTH),
    max_nodes: z.number().int().min(1).optional(),
    /**
     * Task O13 — soft cap on the JSON-encoded response size (characters).
     * The server first shortens every comment preview body down to
     * {@link SUBGRAPH_BUDGET_PREVIEW_CHARS} and then drops the farthest
     * nodes (BFS level) until the response fits. Surfaces diagnostics via
     * `truncated` and `reason` (`"max_chars_preview"` /
     * `"max_chars_nodes"`). The hard `max_nodes` cap still wins — when it
     * fires, budget trimming is skipped and `reason` is `"max_nodes"`.
     */
    max_chars: z.number().int().min(1).optional(),
    include_comments: z.boolean().optional(),
    view: View,
  });
  mcp.registerTool(
    'etn.thoughts.subgraph',
    {
      title: 'Подграф в радиусе N рёбер',
      description:
        'Extract the radius-bounded subgraph around seed thoughts: nodes (full thoughts), ' +
        'active edges, and optionally comments per node (`include_comments` — previews: ' +
        'permanent truncated to 2000 chars, last 10 chronological entries with per-entry ' +
        'truncation; every preview entry carries the comment `id` — fetch the full text via ' +
        '`etn.comments.get` when `truncated`). Every response carries ' +
        '`thought_types`/`link_types` reference tables (id, name, description, icon/color) ' +
        'for the types actually used — the agent reads the AI-facing type descriptions once ' +
        'instead of re-fetching. The key RAG tool — returns ready-to-use context. ' +
        '`max_nodes` is capped by the server setting max_nodes_per_subgraph. ' +
        '`max_chars` (task O13) caps the JSON-encoded response size: the server first ' +
        'shrinks every comment preview body and then drops the farthest nodes (BFS level ' +
        'from the seeds) until the payload fits, reporting the truncation via `truncated: ' +
        'true` and `reason` in `{"max_chars_preview", "max_chars_nodes"}`. ' +
        '`view: "compact"` (default, task O12) drops colours and font-style flags from every ' +
        'node and the line-style fields from the link-type catalogue — the dominant token ' +
        'saving on large subgraphs. `view: "full"` keeps the legacy shape.',
      inputSchema: SubgraphSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.subgraph'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const effectiveMax = Math.min(
          args.max_nodes ?? rt.limits.maxNodesPerSubgraph,
          rt.limits.maxNodesPerSubgraph,
        );
        const result = subgraph(ndb, args.seed_ids, args.radius, { maxNodes: effectiveMax });
        const nodes = result.nodes.map((id) => getThoughtOrThrow(ndb, id));
        const comments =
          args.include_comments === true
            ? result.nodes.map((id) => ({
                thought_id: id,
                ...getCommentsPreview(ndb, 'thought', id),
              }))
            : undefined;
        // O10: one batched UPSERT covers every node returned by the subgraph.
        recordReads(ndb, result.nodes, { now: new Date().toISOString() });
        const view: McpViewMode = args.view ?? 'compact';
        // The traversal already returns edges with the minimal shape (no
        // colour/style/width — see graph-traversal/subgraph), so the only O12
        // effects here are the node projection and the link-type catalogue.
        const projectedNodes =
          view === 'full' ? nodes : nodes.map((t) => toCompactThought(t));
        const linkTypes =
          view === 'full'
            ? linkTypeCatalog(ndb, result.edges.map((e) => e.type_id))
            : linkTypeCatalogCompact(ndb, result.edges.map((e) => e.type_id));
        // When the hard `max_nodes` bound fires during traversal, the response is
        // already structurally incomplete — running the budget shrinker on top
        // would only hide that fact behind a softer reason. Surface the
        // `max_nodes` reason verbatim in that case and skip budget trimming.
        const thoughtTypes = thoughtTypeCatalog(ndb, nodes.map((n) => n.type_id));
        const payload: {
          nodes: typeof projectedNodes;
          edges: typeof result.edges;
          thought_types: typeof thoughtTypes;
          link_types: typeof linkTypes;
          comments?: typeof comments;
        } = {
          nodes: projectedNodes,
          edges: result.edges,
          thought_types: thoughtTypes,
          link_types: linkTypes,
          ...(comments === undefined ? {} : { comments }),
        };
        const traversalTruncated = result.truncated;
        const budget =
          args.max_chars !== undefined && !traversalTruncated
            ? shrinkSubgraphToBudget(payload, {
                seed_ids: args.seed_ids,
                max_chars: args.max_chars,
              })
            : null;
        return {
          nodes: payload.nodes,
          edges: payload.edges,
          truncated: traversalTruncated || (budget?.truncated ?? false),
          max_nodes: effectiveMax,
          // Reason: explicit `max_nodes` (from `traverse`) takes priority over
          // budget diagnostics — a traversal-level cap is the more informative
          // answer for the agent, because it means *not every reachable node
          // was even considered*. `null` when nothing was trimmed.
          reason: traversalTruncated
            ? 'max_nodes'
            : (budget?.reason ?? null),
          thought_types: payload.thought_types,
          link_types: payload.link_types,
          ...(payload.comments === undefined ? {} : { comments: payload.comments }),
          // Echo of the budget diagnostic so the agent can distinguish "we
          // shrank to 40k chars from 90k" from "we dropped 50 nodes". Absent
          // when the caller did not set `max_chars` or when traversal already
          // truncated.
          ...(budget === null
            ? {}
            : {
                budget: {
                  max_chars: args.max_chars as number,
                  original_chars: budget.original_chars,
                  final_chars: budget.final_chars,
                  steps: budget.reason,
                },
              }),
        };
      }),
  );

  const PathSchema = z.object({
    network_id: NetworkId,
    from_id: ThoughtId,
    to_id: ThoughtId,
    max_depth: z.number().int().min(1).max(100).optional(),
  });
  mcp.registerTool(
    'etn.thoughts.path',
    {
      title: 'Путь между мыслями',
      description:
        'Shortest path between two thoughts through undirected parent/child edges, bounded by ' +
        '`max_depth`. Returns the id sequence or `path: null` when unreachable.',
      inputSchema: PathSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.path'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const path = findPath(
          ndb,
          args.from_id,
          args.to_id,
          args.max_depth ?? TRAVERSAL_DEFAULTS.MAX_DEPTH,
        );
        const thoughts = path === null ? undefined : resolveThoughts(ndb, path);
        return {
          from_id: args.from_id,
          to_id: args.to_id,
          path,
          ...(thoughts === undefined
            ? {}
            : {
                thoughts,
                thought_types: thoughtTypeCatalog(ndb, thoughts.map((t) => t.type_id)),
              }),
        };
      }),
  );

  const LinkGetSchema = z.object({ network_id: NetworkId, link_id: LinkId });
  mcp.registerTool(
    'etn.links.get',
    {
      title: 'Связь (с метаданными)',
      description: 'Fetch one link with its link type (including the AI-facing description).',
      inputSchema: LinkGetSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.links.get'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const link = getLink(ndb, args.link_id);
        if (link === null) {
          throw new Error(`ETN error [NOT_FOUND]: link ${args.link_id} not found`);
        }
        const type = link.type_id === null ? null : getLinkType(ndb, link.type_id);
        return { ...link, type };
      }),
  );

  const MentionsSchema = z.object({ network_id: NetworkId, thought_id: ThoughtId });
  mcp.registerTool(
    'etn.thoughts.mentions',
    {
      title: 'Где упоминается мысль',
      description:
        'Comments (on thoughts and links) whose text mentions the thought by title or synonym.',
      inputSchema: MentionsSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.mentions'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return findMentions(ndb, args.thought_id);
      }),
  );

  const BacklinksSchema = z.object({ network_id: NetworkId, thought_id: ThoughtId });
  mcp.registerTool(
    'etn.thoughts.backlinks',
    {
      title: 'Ссылки на мысль',
      description:
        'Comments whose `body_md` carries an explicit ID-based wiki reference ' +
        '`[[#<id>]]` or `[[n:<net>#<id>]]` to this thought (task R3, ' +
        'docs/03-server-api.md §13a). Distinct from `etn.thoughts.mentions` — ' +
        'that one finds implicit text matches by title/synonyms via FTS5; ' +
        'this one finds explicit UUID-based references by runtime regex. ' +
        'Returns the same `MentionHit[]` shape as `etn.thoughts.mentions` ' +
        '(one hit per (owner_type, owner_id) owner; the target thought own ' +
        'comments are excluded; snippet is centred on the matched id).',
      inputSchema: BacklinksSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.backlinks'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return findBacklinks(ndb, args.thought_id);
      }),
  );

  const UsageSchema = z.object({ network_id: NetworkId, thought_id: ThoughtId, view: View });
  mcp.registerTool(
    'etn.thoughts.usage',
    {
      title: 'Где используется мысль',
      description:
        'Thoughts referencing this thought as a `thought_ref` property value (formal links, ' +
        '«Использование» in the editor), grouped by property. Returns ' +
        '{ total, groups: [{property_id, key, thoughts[]}], thought_types } — the latter is ' +
        'a reference table (name + AI-facing description) for every type used in the result. ' +
        '`view: "compact"` (default, task O12) drops colours, font-style flags and the icon ' +
        'attachment id from each referencing thought; `view: "full"` keeps them.',
      inputSchema: UsageSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.usage'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const usage = findThoughtUsage(ndb, args.thought_id);
        const view: McpViewMode = args.view ?? 'compact';
        // `groups[].thoughts[]` is a ThoughtRef[] — project each entry under
        // the compact view. The `total` and `groups` skeleton are preserved.
        const groups =
          view === 'full'
            ? usage.groups
            : usage.groups.map((g) => ({
                property_id: g.property_id,
                key: g.key,
                thoughts: g.thoughts.map((t) => toCompactThoughtRef(t)),
              }));
        return {
          total: usage.total,
          groups,
          thought_types: thoughtTypeCatalog(
            ndb,
            usage.groups.flatMap((g) => g.thoughts.map((t) => t.type_id)),
          ),
        };
      }),
  );

  const GetCommentSchema = z
    .object({
      network_id: NetworkId,
      comment_id: z.string().min(1).optional(),
      thought_id: ThoughtId.optional(),
    })
    .refine((a) => (a.comment_id === undefined) !== (a.thought_id === undefined), {
      message: 'provide exactly one of comment_id or thought_id',
    });
  mcp.registerTool(
    'etn.comments.get',
    {
      title: 'Комментарий (полный текст)',
      description:
        'Fetch one comment in full: by `comment_id` — any comment (permanent or ' +
        'chronological) with its complete `body_md`; by `thought_id` — the thought\'s ' +
        'permanent comment, or `{thought_id, permanent: null}` when absent. Use when a ' +
        'preview (`meta.permanent`, `subgraph` comments) reports `truncated: true` — every ' +
        'preview entry carries the comment `id`.',
      inputSchema: GetCommentSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.comments.get'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        if (args.comment_id !== undefined) {
          const comment = getComment(ndb, args.comment_id);
          if (comment === null) {
            throw new Error(`ETN error [NOT_FOUND]: comment ${args.comment_id} not found`);
          }
          return comment;
        }
        // The refine guarantees exactly one of the two; TS needs an explicit check.
        if (args.thought_id === undefined) {
          throw new Error('ETN error [VALIDATION_ERROR]: thought_id required');
        }
        getThoughtOrThrow(ndb, args.thought_id);
        const permanent =
          listComments(ndb, 'thought', args.thought_id).find((c) => c.kind === 'permanent') ??
          null;
        return { thought_id: args.thought_id, permanent };
      }),
  );

  const ExportSchema = z.object({
    network_id: NetworkId,
    seed_ids: z.array(ThoughtId).min(1).max(50),
    radius: z.number().int().min(0).max(TRAVERSAL_DEFAULTS.MAX_DEPTH),
    format: z.enum(EXPORT_FORMATS).optional(),
  });
  mcp.registerTool(
    'etn.export.subgraph',
    {
      title: 'Экспорт подграфа',
      description:
        'Render the radius-bounded subgraph around seeds as a Markdown (`markdown`, default) or ' +
        'HTML document. PDF is not supported on the MVP. `.etnx` export (full graph slice, phase P) ' +
        'is wired up in O17 — this tool accepts `format: "etnx"` but will surface it as unsupported ' +
        'until O17 lands.',
      inputSchema: ExportSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.export.subgraph'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const format: ExportFormat = args.format ?? 'markdown';
        if (format === 'etnx') {
          throw new EtnError(
            'VALIDATION_ERROR',
            '`.etnx` export через MCP будет доступен в O17 (после P9).',
            { tool: 'etn.export.subgraph', field: 'format' },
          );
        }
        const result = subgraph(ndb, args.seed_ids, args.radius, {
          maxNodes: rt.limits.maxNodesPerSubgraph,
        });
        let content: string;
        if (format === 'markdown') {
          content = exportToMarkdown(ndb, result.nodes);
        } else {
          const job = await startExportJob(ndb, result.nodes, format, {
            source: {
              network_id: args.network_id,
              network_name: args.network_id,
              user_id: rt.deps.auth.userId,
            },
          });
          const downloaded = getExportJobContent(job.job_id, format);
          if (downloaded === null) {
            throw new Error('ETN error [INTERNAL]: export content unavailable');
          }
          if (typeof downloaded.body !== 'string') {
            throw new Error(
              'ETN error [INTERNAL]: expected textual export content, got binary',
            );
          }
          content = downloaded.body;
        }
        return { format, truncated: result.truncated, content };
      }),
  );

  const TypesListSchema = z.object({
    network_id: NetworkId,
    /**
     * Task O16 — restrict the catalogue to the type ids that are actually
     * used inside a thought's subtree (active thoughts + active links whose
     * both endpoints lie in the subtree). Used together with
     * `etn.networks.structure` to drill from a section into a context-aware
     * type catalogue without paying for the whole network's worth of types.
     */
    in_subtree_of: ThoughtId.optional(),
    /** Override the default subtree depth cap (task O16). */
    max_depth: z.number().int().min(1).max(TRAVERSAL_DEFAULTS.MAX_DEPTH).optional(),
  });
  mcp.registerTool(
    'etn.types.list',
    {
      title: 'Каталог типов',
      description:
        'Both type catalogues in full (not just the types used elsewhere in a response, unlike ' +
        'the `thought_types`/`link_types` reference tables of other read tools): thought types ' +
        'and link types with their hierarchy (`parent_id`/`is_root`), `description` (AI-facing ' +
        'context) and effective property definitions — own plus everything inherited along the ' +
        'L21 type chain (`key`, `value_type`, `required`, `config` incl. `options`/' +
        '`allowed_type_ids`, effective `default_value`, `inherited`, `defined_on`). Call before ' +
        'creating a typed thought/link to see what to fill; also lets `type_id` be replaced by a ' +
        'type name in `etn.thoughts.create`, `etn.links.create` and `etn.thoughts.upsert_bundle`. ' +
        'Task O16: pass `in_subtree_of: <thought_id>` (optionally with `max_depth`) to scope ' +
        'the response to the distinct thought/link types actually used inside that subtree, ' +
        'each with a `usage_count` for ranking. Useful as the second step after ' +
        '`etn.networks.structure` — pick a section, then pick a type relevant to that section.',
      inputSchema: TypesListSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.types.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);

        // O16: subtree-scoped catalogue. If `in_subtree_of` references an
        // unknown thought, surface the same error a `thoughts.get` would.
        let thoughtTypeCounts: Map<string, number> | null = null;
        let linkTypeCounts: Map<string, number> | null = null;
        if (args.in_subtree_of !== undefined) {
          const seed = getThoughtOrThrow(ndb, args.in_subtree_of);
          if (seed === null) {
            throw new EtnError(
              'NOT_FOUND',
              `Thought ${args.in_subtree_of} not found.`,
              { thought_id: args.in_subtree_of },
            );
          }
          const subtree = collectSubtreeTypes(ndb, args.in_subtree_of, {
            maxDepth: args.max_depth,
          });
          thoughtTypeCounts = subtree.thought_type_counts;
          linkTypeCounts = subtree.link_type_counts;
        }

        const thoughtTypes = listThoughtTypes(ndb)
          .filter((t) => thoughtTypeCounts === null || thoughtTypeCounts.has(t.id))
          .map((t) => ({
            id: t.id,
            name: t.name,
            parent_id: t.parent_id,
            is_root: t.is_root,
            description: t.description,
            icon: t.icon,
            properties: listEffectiveTypeProperties(ndb, 'thought_type', t.id),
            ...(thoughtTypeCounts === null
              ? {}
              : { usage_count: thoughtTypeCounts.get(t.id) ?? 0 }),
          }));
        const linkTypes = listLinkTypes(ndb)
          .filter((t) => linkTypeCounts === null || linkTypeCounts.has(t.id))
          .map((t) => ({
            id: t.id,
            name_forward: t.name_forward,
            name_reverse: t.name_reverse,
            parent_id: t.parent_id,
            is_root: t.is_root,
            description: t.description,
            color: t.color,
            style: t.style,
            properties: listEffectiveTypeProperties(ndb, 'link_type', t.id),
            ...(linkTypeCounts === null
              ? {}
              : { usage_count: linkTypeCounts.get(t.id) ?? 0 }),
          }));
        return {
          thought_types: thoughtTypes,
          link_types: linkTypes,
          ...(args.in_subtree_of === undefined
            ? {}
            : {
                scope: {
                  in_subtree_of: args.in_subtree_of,
                  max_depth: args.max_depth ?? TRAVERSAL_DEFAULTS.MAX_DEPTH,
                  thought_types_total: thoughtTypes.length,
                  link_types_total: linkTypes.length,
                },
              }),
        } satisfies McpTypesListResult & {
          scope?: {
            in_subtree_of: string;
            max_depth: number;
            thought_types_total: number;
            link_types_total: number;
          };
        };
      }),
  );

  // etn.changes.list — O9 read tool. Delta feed over the real-time event_log
  // (04-realtime.md §3, §6) for long-lived agents that maintain their own
  // cache. Same retention window as the WebSocket gateway (24h / 10 000 rows,
  // `REALTIME_DEFAULTS.EVENT_LOG_*`) — when the agent's `since_seq` falls
  // outside the retained buffer, the response carries `truncated: true` so
  // the caller knows to do a full resync instead of resuming. No `data.db`
  // access: the event log lives in `_system.db` (see migration
  // `009_event_log.sql`), so we reuse the membership-only check pattern from
  // `etn.networks.structure`.
  const ChangesListSchema = z.object({
    network_id: NetworkId,
    since_seq: z.number().int().min(0),
    limit: z.number().int().min(1).max(REALTIME_DEFAULTS.EVENT_LOG_MAX_ROWS).optional(),
  });
  const DEFAULT_CHANGES_LIMIT = 1000;
  mcp.registerTool(
    'etn.changes.list',
    {
      title: 'Дельта событий',
      description:
        'Delta feed over the real-time `event_log` for long-lived agents with their own cache ' +
        '(task O9, docs/05-mcp-server.md §4.1). Returns events with `seq > since_seq` in ' +
        'ascending order, capped at `limit` (default 1000). The `cursor` echoes the current ' +
        'retained window (`min_seq`/`max_seq`, `null` when the log is empty). When `since_seq` ' +
        'falls outside that window the response carries `truncated: true` — the agent must do a ' +
        'full resync (`etn.thoughts.search` + `etn.thoughts.get`) before resuming. Events with ' +
        '`audience: "user"` are filtered: only events authored by the calling user are returned ' +
        '(mirrors WebSocket audience routing, 04-realtime.md §5).',
      inputSchema: ChangesListSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.changes.list'],
    },
    (args) =>
      runTool(async () => {
        const network = rt.deps.systemDb.getNetworkById(args.network_id);
        if (network === null) {
          throw new EtnError('NOT_FOUND', `Network ${args.network_id} not found.`);
        }
        const role = rt.deps.systemDb.getMemberRole(rt.deps.auth.userId, args.network_id);
        if (role === null) {
          throw new EtnError(
            'FORBIDDEN',
            `You are not a member of network ${args.network_id}; this API key cannot access it.`,
            { network_id: args.network_id },
          );
        }

        const limit = args.limit ?? DEFAULT_CHANGES_LIMIT;
        const minSeq = rt.deps.systemDb.getMinEventSeq(args.network_id);
        const maxSeq = rt.deps.systemDb.getMaxEventSeq(args.network_id);
        const events = rt.deps.systemDb.readEventsAfter(
          args.network_id,
          args.since_seq,
          limit,
        );
        const authUserId = rt.deps.auth.userId;
        const filtered: McpChangeEntry[] = events
          .filter((e) => e.audience === 'network' || e.actor.user_id === authUserId)
          .map((e) => ({
            type: e.type,
            seq: e.seq,
            ts: e.ts,
            data: e.data,
            audience: e.audience,
          }));
        // `truncated` fires only when an explicit (non-zero) `since_seq` is
        // older than the first retained row: a zero `since_seq` means
        // "from the start of the buffer" and is never truncated. An empty
        // buffer (`min_seq === null`) is also not truncated — there was
        // nothing to lose.
        const truncated =
          args.since_seq !== 0 && minSeq !== null && args.since_seq < minSeq - 1;

        return {
          network_id: args.network_id,
          cursor: { min_seq: minSeq, max_seq: maxSeq },
          events: filtered,
          truncated,
          limit,
        } satisfies McpChangesListResult;
      }),
  );

  // etn.metrics.reads — O10 read tool. Read-side analytics for the knowledge
  // base: aggregates per-thought counts from `thought_read_metrics` (network-
  // wide, written by every read tool via `recordReads`). The owner uses
  // `kind: 'top'` to surface hot spots and `kind: 'cold'` (optionally with
  // `since`) to find dead zones. Membership is checked through the system
  // DB the same way as `etn.networks.structure`; the actual reads go through
  // `openMemberNetwork` because the aggregate table lives in `data.db`.
  const MetricsReadsSchema = z.object({
    network_id: NetworkId,
    kind: z.enum(['top', 'cold']).optional(),
    since: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    include_inactive: z.boolean().optional(),
  });
  mcp.registerTool(
    'etn.metrics.reads',
    {
      title: 'Метрики чтений мыслей',
      description:
        'Per-thought read counters collected by the MCP read tools (task O10, ' +
        'docs/05-mcp-server.md §5.1). `kind: "top"` (default) returns the most-read ' +
        'thoughts ordered by `reads_count DESC, last_read_at DESC`. `kind: "cold"` ' +
        'returns thoughts that have never been read, or — when `since` is given — ' +
        'whose `last_read_at` is older than the cutoff, ordered by `updated_at DESC` ' +
        'so the freshest un-touched nodes come first. Use this to spot hot spots ' +
        'and dead zones; the counter is incremented by `etn.thoughts.get`, ' +
        '`etn.thoughts.subgraph`, `etn.thoughts.query`, `etn.thoughts.search` and ' +
        '`etn.networks.structure` after each successful read.',
      inputSchema: MetricsReadsSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.metrics.reads'],
    },
    (args) =>
      runTool(async () => {
        const network = rt.deps.systemDb.getNetworkById(args.network_id);
        if (network === null) {
          throw new EtnError('NOT_FOUND', `Network ${args.network_id} not found.`);
        }
        const role = rt.deps.systemDb.getMemberRole(rt.deps.auth.userId, args.network_id);
        if (role === null) {
          throw new EtnError(
            'FORBIDDEN',
            `You are not a member of network ${args.network_id}; this API key cannot access it.`,
            { network_id: args.network_id },
          );
        }
        const { kind, limit } = clampReadMetricsParams({
          kind: args.kind,
          limit: args.limit,
        });
        const includeInactive = args.include_inactive === true;
        const since = kind === 'cold' ? args.since : undefined;
        const ndb = openMemberNetwork(rt, args.network_id);
        const items =
          kind === 'cold'
            ? getColdReads(ndb, { limit, since, includeInactive })
            : getTopReads(ndb, { limit, includeInactive });
        return {
          network_id: args.network_id,
          kind,
          since: since ?? null,
          limit,
          items,
          thought_types: thoughtTypeCatalog(ndb, items.map((i) => i.type_id)),
        } satisfies McpMetricsReadsResult;
      }),
  );

  // =========================================================================
  // Mutating tools (§4.2) — domain services + real-time events + audit log
  // =========================================================================

  const CreateThoughtSchema = z
    .object({
      network_id: NetworkId,
      title: z.string().min(1),
      synonyms: z.array(z.string().min(1)).optional(),
      type_id: ThoughtId.nullable().optional(),
      type: z.string().min(1).optional(),
      active: z.boolean().optional(),
      link: CreateLink,
    })
    .refine((v) => v.type_id === undefined || v.type === undefined, { message: TYPE_ID_TYPE_CONFLICT });
  mcp.registerTool(
    'etn.thoughts.create',
    {
      title: 'Создать мысль',
      description:
        'Create a thought, optionally attaching a parent/child link in the same transaction. ' +
        'Call `etn.thoughts.find_duplicates` first to avoid duplicates. `type`/`link.type` ' +
        '(task O4) resolve a type by name instead of `type_id` (see `etn.types.list`). ' +
        'Returns { id, version }; when the assigned type declares `required` properties and ' +
        'the card leaves some of them unset, also returns `warnings: [{code: ' +
        '"REQUIRED_PROPERTY_MISSING", key, …}]` so the agent can follow up with ' +
        '`etn.properties.set` / another bundle (task O6).',
      inputSchema: CreateThoughtSchema,
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const typeId = effectiveThoughtTypeId(ndb, args.type_id, args.type);
        const linkTypeId =
          args.link === undefined ? undefined : effectiveLinkTypeId(ndb, args.link.type_id, args.link.type);
        const { thought, warnings } = createThoughtWithWarnings(
          ndb,
          {
            title: args.title,
            ...(args.synonyms === undefined ? {} : { synonyms: args.synonyms }),
            ...(typeId === undefined ? {} : { type_id: typeId }),
            ...(args.active === undefined ? {} : { active: args.active }),
            ...(args.link === undefined
              ? {}
              : {
                  create_link: {
                    direction: args.link.direction,
                    target_thought_id: args.link.target_thought_id,
                    type_id: linkTypeId ?? null,
                  },
                }),
          },
          rt.deps.auth.userId,
        );
        emitAgentEvent(rt, args.network_id, 'thought.created', { thought }, extra.requestId);
        if (args.link !== undefined) {
          const [sourceId, targetId] =
            args.link.direction === 'parent'
              ? [thought.id, args.link.target_thought_id]
              : [args.link.target_thought_id, thought.id];
          const link = findLinksBetween(ndb, sourceId, targetId, linkTypeId ?? null)[0];
          if (link !== undefined) {
            emitAgentEvent(rt, args.network_id, 'link.created', { link }, extra.requestId);
          }
        }
        auditAgentCall(rt, 'etn.thoughts.create', args.network_id, 'thought', thought.id, {
          title: args.title,
          synonyms: args.synonyms,
          type_id: typeId,
          active: args.active,
          link: args.link,
        });
        return {
          id: thought.id,
          version: thought.version,
          request_id: String(extra.requestId),
          ...(warnings.length === 0 ? {} : { warnings }),
        } satisfies McpMutationResult;
      }),
  );

  const UpdateThoughtSchema = z.object({
    network_id: NetworkId,
    thought_id: ThoughtId,
    changes: ThoughtChanges,
    expected_version: ExpectedVersion,
  });
  mcp.registerTool(
    'etn.thoughts.update',
    {
      title: 'Изменить мысль',
      description:
        'Patch a thought (last-write-wins per field). `expected_version` enables optimistic ' +
        'concurrency — on mismatch the call fails with VERSION_CONFLICT. Returns { id, version }; ' +
        'when `changes.type_id` is present and the new type declares `required` properties that ' +
        'the card leaves unset, also returns `warnings: [{code: ' +
        '"REQUIRED_PROPERTY_MISSING", key, …}]` (task O6).',
      inputSchema: UpdateThoughtSchema,
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const { thought, warnings } = updateThoughtWithWarnings(
          ndb,
          args.thought_id,
          args.changes,
          args.expected_version,
          rt.deps.auth.userId,
        );
        emitAgentEvent(
          rt,
          args.network_id,
          'thought.updated',
          { id: thought.id, changes: args.changes, version: thought.version },
          extra.requestId,
        );
        auditAgentCall(rt, 'etn.thoughts.update', args.network_id, 'thought', thought.id, args);
        return {
          id: thought.id,
          version: thought.version,
          request_id: String(extra.requestId),
          ...(warnings.length === 0 ? {} : { warnings }),
        } satisfies McpMutationResult;
      }),
  );

  const DeleteThoughtSchema = z.object({
    network_id: NetworkId,
    thought_id: ThoughtId,
    expected_version: ExpectedVersion,
  });
  mcp.registerTool(
    'etn.thoughts.delete',
    {
      title: 'Удалить мысль',
      description:
        'Delete a thought (cascades to links, comments, attachments, property values). ' +
        'Protected thoughts (HOME) are rejected. Returns { id, version: 0 }.',
      inputSchema: DeleteThoughtSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.delete'],
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        deleteThought(ndb, args.thought_id, args.expected_version);
        emitAgentEvent(
          rt,
          args.network_id,
          'thought.deleted',
          { id: args.thought_id },
          extra.requestId,
        );
        auditAgentCall(rt, 'etn.thoughts.delete', args.network_id, 'thought', args.thought_id, {
          expected_version: args.expected_version,
        });
        return {
          id: args.thought_id,
          version: 0,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  const SetActiveSchema = z.object({
    network_id: NetworkId,
    thought_id: ThoughtId,
    active: z.boolean(),
  });
  mcp.registerTool(
    'etn.thoughts.set_active',
    {
      title: 'Изменить актуальность мысли',
      description: 'Activate or deactivate a thought. The HOME thought cannot be deactivated.',
      inputSchema: SetActiveSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.set_active'],
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const thought = updateThought(
          ndb,
          args.thought_id,
          { active: args.active },
          undefined,
          rt.deps.auth.userId,
        );
        emitAgentEvent(
          rt,
          args.network_id,
          'thought.updated',
          { id: thought.id, changes: { active: args.active }, version: thought.version },
          extra.requestId,
        );
        auditAgentCall(rt, 'etn.thoughts.set_active', args.network_id, 'thought', thought.id, {
          active: args.active,
        });
        return {
          id: thought.id,
          version: thought.version,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  const CreateLinkSchema = z
    .object({
      network_id: NetworkId,
      source_id: ThoughtId,
      target_id: ThoughtId,
      type_id: z.string().min(1).nullable().optional(),
      type: z.string().min(1).optional(),
    })
    .refine((v) => v.type_id === undefined || v.type === undefined, { message: TYPE_ID_TYPE_CONFLICT });
  mcp.registerTool(
    'etn.links.create',
    {
      title: 'Создать связь',
      description:
        'Create a directed link source → target, optionally typed. Duplicate pairs and ' +
        'self-loops are rejected. `type` (task O4) resolves a link type by `name_forward`/' +
        '`name_reverse` instead of `type_id` (see `etn.types.list`). Returns { id, version }.',
      inputSchema: CreateLinkSchema,
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const typeId = effectiveLinkTypeId(ndb, args.type_id, args.type);
        const link = createLink(
          ndb,
          { source_id: args.source_id, target_id: args.target_id, type_id: typeId ?? null },
          rt.deps.auth.userId,
        );
        emitAgentEvent(rt, args.network_id, 'link.created', { link }, extra.requestId);
        auditAgentCall(rt, 'etn.links.create', args.network_id, 'link', link.id, {
          source_id: args.source_id,
          target_id: args.target_id,
          type_id: typeId,
        });
        return {
          id: link.id,
          version: link.version,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  const DeleteLinkSchema = z.object({
    network_id: NetworkId,
    link_id: LinkId,
    expected_version: ExpectedVersion,
  });
  mcp.registerTool(
    'etn.links.delete',
    {
      title: 'Удалить связь',
      description: 'Delete a link. Returns { id, version: 0 }.',
      inputSchema: DeleteLinkSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.links.delete'],
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        deleteLink(ndb, args.link_id, args.expected_version);
        emitAgentEvent(rt, args.network_id, 'link.deleted', { id: args.link_id }, extra.requestId);
        auditAgentCall(rt, 'etn.links.delete', args.network_id, 'link', args.link_id, {
          expected_version: args.expected_version,
        });
        return {
          id: args.link_id,
          version: 0,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  const CommentTargetSchema = z.object({
    owner_type: z.enum(COMMENT_OWNER_TYPES),
    owner_id: z.string().min(1),
  });
  const UpsertCommentSchema = z
    .object({
      network_id: NetworkId,
      owner_type: z.enum(COMMENT_OWNER_TYPES).optional(),
      owner_id: z.string().min(1).optional(),
      targets: z.array(CommentTargetSchema).min(1).max(COMMENT_TARGETS_MAX).optional(),
      kind: z.enum(COMMENT_KINDS),
      title: z.string().nullable().optional(),
      body_md: z.string().min(1),
      valid_from: z.string().min(1).optional(),
      valid_to: z.string().nullable().optional(),
    })
    .refine(
      (v) => (v.owner_type !== undefined && v.owner_id !== undefined) !== (v.targets !== undefined),
      { message: 'provide exactly one of { owner_type + owner_id } or { targets }' },
    )
    .refine((v) => v.targets === undefined || v.kind === 'chronological', {
      message: 'targets is only allowed for kind: "chronological" (a permanent comment has exactly one owner)',
    });
  mcp.registerTool(
    'etn.comments.upsert',
    {
      title: 'Создать/обновить комментарий',
      description:
        'For `permanent`: creates the single permanent comment of the owner, or updates it when ' +
        'it already exists. For `chronological`: always appends a new dated entry ' +
        '(`valid_from`/`valid_to`); pass `targets: [{owner_type, owner_id}]` (1..100, first is the ' +
        'primary owner) instead of `owner_type`+`owner_id` to attach the same entry to several ' +
        'thoughts/links at once. Returns { id, version }.',
      inputSchema: UpsertCommentSchema,
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const targets: CommentTarget[] =
          args.targets ?? [{ owner_type: args.owner_type!, owner_id: args.owner_id! }];
        const primary = targets[0]!;
        if (args.kind === 'permanent') {
          const existing = listComments(ndb, primary.owner_type, primary.owner_id).find(
            (c) => c.kind === 'permanent',
          );
          if (existing !== undefined) {
            const changes = {
              ...(args.title === undefined ? {} : { title: args.title }),
              body_md: args.body_md,
            };
            const comment = updateComment(
              ndb,
              existing.id,
              changes,
              undefined,
              rt.deps.auth.userId,
            );
            emitAgentEvent(
              rt,
              args.network_id,
              'comment.updated',
              { id: comment.id, changes, version: comment.version },
              extra.requestId,
            );
            auditAgentCall(rt, 'etn.comments.upsert', args.network_id, 'comment', comment.id, args);
            return {
              id: comment.id,
              version: comment.version,
              request_id: String(extra.requestId),
            } satisfies McpMutationResult;
          }
        }
        const comment = createCommentWithTargets(
          ndb,
          targets,
          {
            kind: args.kind,
            title: args.title ?? null,
            body_md: args.body_md,
            ...(args.valid_from === undefined ? {} : { valid_from: args.valid_from }),
            ...(args.valid_to === undefined ? {} : { valid_to: args.valid_to }),
          },
          rt.deps.auth.userId,
        );
        emitAgentEvent(rt, args.network_id, 'comment.created', { comment }, extra.requestId);
        auditAgentCall(rt, 'etn.comments.upsert', args.network_id, 'comment', comment.id, args);
        return {
          id: comment.id,
          version: comment.version,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  const CommentChanges = z
    .object({
      title: z.string().nullable().optional(),
      body_md: z.string().min(1).optional(),
      valid_from: z.string().min(1).optional(),
      valid_to: z.string().nullable().optional(),
    })
    .refine((c) => Object.keys(c).length > 0, { message: 'changes must not be empty' });
  const UpdateCommentSchema = z.object({
    network_id: NetworkId,
    comment_id: z.string().min(1),
    changes: CommentChanges,
    expected_version: ExpectedVersion,
  });
  mcp.registerTool(
    'etn.comments.update',
    {
      title: 'Изменить комментарий',
      description:
        'Patch an existing comment (chronological or permanent) addressed by `comment_id` — ' +
        'last-write-wins per field. `valid_from`/`valid_to` apply to chronological entries ' +
        'only and are ignored for permanent ones. `expected_version` enables optimistic ' +
        'concurrency — on mismatch the call fails with VERSION_CONFLICT. Returns { id, version }.',
      inputSchema: UpdateCommentSchema,
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const comment = updateComment(
          ndb,
          args.comment_id,
          args.changes,
          args.expected_version,
          rt.deps.auth.userId,
        );
        emitAgentEvent(
          rt,
          args.network_id,
          'comment.updated',
          { id: comment.id, changes: args.changes, version: comment.version },
          extra.requestId,
        );
        auditAgentCall(rt, 'etn.comments.update', args.network_id, 'comment', comment.id, args);
        return {
          id: comment.id,
          version: comment.version,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  const DeleteCommentSchema = z.object({
    network_id: NetworkId,
    comment_id: z.string().min(1),
    expected_version: ExpectedVersion,
  });
  mcp.registerTool(
    'etn.comments.delete',
    {
      title: 'Удалить комментарий',
      description:
        'Delete a comment (chronological or permanent) by `comment_id` together with all its ' +
        'attachments to owners. Returns { id, version: 0 }.',
      inputSchema: DeleteCommentSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.comments.delete'],
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const existing = getComment(ndb, args.comment_id);
        if (existing === null) {
          throw new Error(`ETN error [NOT_FOUND]: comment ${args.comment_id} not found`);
        }
        deleteComment(ndb, args.comment_id, args.expected_version);
        emitAgentEvent(
          rt,
          args.network_id,
          'comment.deleted',
          {
            owner_type: existing.owner_type,
            owner_id: existing.owner_id,
            id: args.comment_id,
          },
          extra.requestId,
        );
        auditAgentCall(rt, 'etn.comments.delete', args.network_id, 'comment', args.comment_id, {
          expected_version: args.expected_version,
        });
        return {
          id: args.comment_id,
          version: 0,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  const AddAttachmentSchema = z.object({
    network_id: NetworkId,
    owner_type: z.enum(['thought', 'link']),
    owner_id: z.string().min(1),
    kind: z.enum(ATTACHMENT_KINDS),
    url: z.string().min(1).nullable().optional(),
    file_path: z.string().min(1).nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  });
  mcp.registerTool(
    'etn.attachments.add',
    {
      title: 'Добавить вложение',
      description:
        'Attach a URL or a local file path to a thought/link (`kind` selects which; for `url` ' +
        'provide `url`, for `file` provide `file_path`). Returns { id, version: 0 }.',
      inputSchema: AddAttachmentSchema,
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const attachment = createAttachment(
          ndb,
          args.owner_type,
          args.owner_id,
          {
            kind: args.kind,
            url: args.url ?? null,
            file_path: args.file_path ?? null,
            title: args.title ?? null,
            description: args.description ?? null,
          },
          rt.deps.auth.userId,
        );
        emitAgentEvent(rt, args.network_id, 'attachment.created', { attachment }, extra.requestId);
        auditAgentCall(
          rt,
          'etn.attachments.add',
          args.network_id,
          'attachment',
          attachment.id,
          args,
        );
        return {
          id: attachment.id,
          version: 0,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  const CopyAttachmentSchema = z.object({
    network_id: NetworkId,
    attachment_id: z.string().min(1),
    target_owner_type: z.enum(['thought', 'link']),
    target_owner_ids: z.array(z.string().min(1)).min(1),
  });
  mcp.registerTool(
    'etn.attachments.copy',
    {
      title: 'Скопировать вложение',
      description:
        'Copy an existing attachment to one or more target thoughts (workplan L25). ' +
        'Each target receives a new row carrying the same visible fields as the source; ' +
        'the underlying file is not duplicated. Targets that already own the same ' +
        'attachment (same kind + same url/file_path) are skipped silently. ' +
        'Returns one `{id, version: 0, request_id}` per created row.',
      inputSchema: CopyAttachmentSchema,
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const result = copyAttachment(
          ndb,
          args.attachment_id,
          { target_owner_type: args.target_owner_type, target_owner_ids: args.target_owner_ids },
          rt.deps.auth.userId,
        );
        for (const attachment of result.created) {
          emitAgentEvent(
            rt,
            args.network_id,
            'attachment.created',
            { attachment },
            extra.requestId,
          );
        }
        auditAgentCall(
          rt,
          'etn.attachments.copy',
          args.network_id,
          'attachment',
          args.attachment_id,
          args,
        );
        return result.created.map((a) => ({
          id: a.id,
          version: 0,
          request_id: String(extra.requestId),
        })) satisfies McpMutationResult[];
      }),
  );

  const SearchAttachmentsSchema = z.object({
    network_id: NetworkId,
    q: z.string().min(1),
    kind: z.enum(ATTACHMENT_KINDS).optional(),
    exclude_owner_type: z.enum(['thought', 'link']).optional(),
    exclude_owner_id: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  });
  mcp.registerTool(
    'etn.attachments.search',
    {
      title: 'Поиск вложений',
      description:
        'Search attachments across the network by keywords (workplan L25). ' +
        '`q` uses the same mini-syntax as `etn.thoughts.search`: AND of include-words, ' +
        '`-word` exclusion, `*` infix wildcard. Searches title, description, url and ' +
        'file_path (case-insensitive LIKE). Pass `exclude_owner_type`/`exclude_owner_id` ' +
        'to hide rows that already belong to a specific owner (used by the editor\'s ' +
        '"Найти существующее" dialog tab). No FTS index — LIKE under the hood.',
      inputSchema: SearchAttachmentsSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.attachments.search'],
    },
    (args, _extra) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const { items } = searchAttachments(ndb, {
          q: args.q,
          kind: args.kind,
          exclude_owner_type: args.exclude_owner_type,
          exclude_owner_id: args.exclude_owner_id,
          limit: args.limit,
          offset: args.offset,
        });
        return items;
      }),
  );

  const SetPropertySchema = z
    .object({
      network_id: NetworkId,
      owner_type: z.enum(PROPERTY_OWNER_TYPES),
      owner_id: z.string().min(1),
      key: z.string().min(1).optional(),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
      values: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional(),
    })
    .refine(
      (v) => (v.key !== undefined && v.value !== undefined) !== (v.values !== undefined),
      { message: 'provide exactly one of { key + value } or { values }' },
    );
  mcp.registerTool(
    'etn.properties.set',
    {
      title: 'Установить свойство',
      description:
        'Set (or clear with `value: null`) a property value on a thought/link, addressed by key; ' +
        "the value must match the property definition's value_type. Either provide one " +
        '`key`+`value`, or a map `values: {key: value|null}` to write several properties in a ' +
        'single transaction (any invalid key rolls back the whole set). Single form returns ' +
        '{ id, version: 0 }; bulk form returns { values: {key: {id}}, version: 0 }.',
      inputSchema: SetPropertySchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.properties.set'],
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);

        if (args.values !== undefined) {
          const stored = setPropertyValues(ndb, args.owner_type, args.owner_id, args.values);
          for (const value of Object.values(stored)) {
            emitAgentEvent(
              rt,
              args.network_id,
              'property-value.set',
              {
                owner_type: args.owner_type,
                owner_id: args.owner_id,
                property_id: value.property_id,
                value: value.value,
              },
              extra.requestId,
            );
          }
          auditAgentCall(rt, 'etn.properties.set', args.network_id, args.owner_type, args.owner_id, {
            values: args.values,
          });
          return {
            values: Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, { id: v.id }])),
            version: 0,
            request_id: String(extra.requestId),
          } satisfies McpPropertiesSetResult;
        }

        // Single-property form (backward compatible). The refine guarantees both
        // are present whenever `values` is absent.
        const key = args.key;
        const value = args.value;
        if (key === undefined || value === undefined) {
          throw new Error('ETN error [VALIDATION_ERROR]: key and value are required');
        }
        const stored = setPropertyValue(ndb, args.owner_type, args.owner_id, key, value);
        emitAgentEvent(
          rt,
          args.network_id,
          'property-value.set',
          {
            owner_type: args.owner_type,
            owner_id: args.owner_id,
            property_id: stored.property_id,
            value: stored.value,
          },
          extra.requestId,
        );
        auditAgentCall(rt, 'etn.properties.set', args.network_id, args.owner_type, args.owner_id, {
          key,
          value,
        });
        return {
          id: stored.id,
          version: 0,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
      }),
  );

  const BundleThoughtSchema = z
    .object({
      title: z.string().min(1),
      synonyms: z.array(z.string().min(1)).optional(),
      type_id: z.string().min(1).nullable().optional(),
      type: z.string().min(1).optional(),
      active: z.boolean().optional(),
    })
    .refine((v) => v.type_id === undefined || v.type === undefined, { message: TYPE_ID_TYPE_CONFLICT });
  const BundleCommentSchema = z.object({
    title: z.string().nullable().optional(),
    body_md: z.string().min(1),
    valid_from: z.string().min(1).optional(),
    valid_to: z.string().nullable().optional(),
  });
  const BundleLinkSchema = z
    .object({
      direction: z.enum(['parent', 'child']),
      target_thought_id: ThoughtId,
      type_id: z.string().min(1).nullable().optional(),
      type: z.string().min(1).optional(),
    })
    .refine((v) => v.type_id === undefined || v.type === undefined, { message: TYPE_ID_TYPE_CONFLICT });
  const BundleAttachmentSchema = z.object({
    kind: z.enum(ATTACHMENT_KINDS),
    url: z.string().min(1).nullable().optional(),
    file_path: z.string().min(1).nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  });
  const UpsertBundleSchema = z
    .object({
      network_id: NetworkId,
      thought_id: ThoughtId.optional(),
      thought: BundleThoughtSchema.optional(),
      on_duplicate: z.enum(['fail', 'reuse', 'update']).optional(),
      comment: BundleCommentSchema.optional(),
      properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      links: z.array(BundleLinkSchema).optional(),
      attachments: z.array(BundleAttachmentSchema).optional(),
    })
    .refine((v) => v.thought_id !== undefined || v.thought !== undefined, {
      message: 'either thought_id or thought must be provided',
    });
  mcp.registerTool(
    'etn.thoughts.upsert_bundle',
    {
      title: 'Составная запись «единицы знания»',
      description:
        'Create (or, via `thought_id`/`on_duplicate`, augment) a thought together with its ' +
        'permanent comment, a map of property values, links and attachments — one atomic ' +
        'transaction, one write-budget slot. `thought_id` addresses an existing thought to ' +
        'augment in place; otherwise `thought.title`/`synonyms` are matched with the same ' +
        'logic as `etn.thoughts.find_duplicates`, and `on_duplicate` decides what happens on a ' +
        "match: `fail` (default) errors with `candidates`, `reuse` attaches the bundle's other " +
        "parts to the existing thought unchanged, `update` also patches the thought's fields. " +
        '`thought.type`/`links[].type` (task O4) resolve a type by name instead of `type_id` ' +
        '(see `etn.types.list`). ' +
        'Returns { id, version, thought_action, matched_on, comment?, properties?, links?, attachments?, ' +
        'warnings? }. `warnings` (task O6) lists the type\'s `required` properties that remain ' +
        'unset on the resulting card so the agent can follow up with `etn.properties.set` ' +
        '(empty array when the card is complete).',
      inputSchema: UpsertBundleSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.upsert_bundle'],
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const thoughtTypeId =
          args.thought === undefined
            ? undefined
            : effectiveThoughtTypeId(ndb, args.thought.type_id, args.thought.type);
        const resolvedThought =
          args.thought === undefined
            ? undefined
            : {
                title: args.thought.title,
                ...(args.thought.synonyms === undefined ? {} : { synonyms: args.thought.synonyms }),
                ...(thoughtTypeId === undefined ? {} : { type_id: thoughtTypeId }),
                ...(args.thought.active === undefined ? {} : { active: args.thought.active }),
              };
        const resolvedLinks =
          args.links === undefined
            ? undefined
            : args.links.map((l) => {
                const linkTypeId = effectiveLinkTypeId(ndb, l.type_id, l.type);
                return {
                  direction: l.direction,
                  target_thought_id: l.target_thought_id,
                  ...(linkTypeId === undefined ? {} : { type_id: linkTypeId }),
                };
              });
        const result = upsertThoughtBundle(
          ndb,
          {
            ...(args.thought_id === undefined ? {} : { thought_id: args.thought_id }),
            ...(resolvedThought === undefined ? {} : { thought: resolvedThought }),
            ...(args.on_duplicate === undefined ? {} : { on_duplicate: args.on_duplicate }),
            ...(args.comment === undefined ? {} : { comment: args.comment }),
            ...(args.properties === undefined ? {} : { properties: args.properties }),
            ...(resolvedLinks === undefined ? {} : { links: resolvedLinks }),
            ...(args.attachments === undefined
              ? {}
              : {
                  attachments: args.attachments.map((a) => ({
                    kind: a.kind,
                    url: a.url ?? null,
                    file_path: a.file_path ?? null,
                    title: a.title ?? null,
                    description: a.description ?? null,
                  })),
                }),
          },
          rt.deps.auth.userId,
        );

        if (result.thought_action === 'created') {
          emitAgentEvent(rt, args.network_id, 'thought.created', { thought: result.thought }, extra.requestId);
        } else if (result.thought_action === 'updated') {
          emitAgentEvent(
            rt,
            args.network_id,
            'thought.updated',
            { id: result.thought.id, changes: resolvedThought ?? {}, version: result.thought.version },
            extra.requestId,
          );
        }
        if (result.comment !== undefined) {
          if (result.comment_action === 'created') {
            emitAgentEvent(rt, args.network_id, 'comment.created', { comment: result.comment }, extra.requestId);
          } else {
            emitAgentEvent(
              rt,
              args.network_id,
              'comment.updated',
              {
                id: result.comment.id,
                changes: {
                  ...(args.comment?.title === undefined ? {} : { title: args.comment.title }),
                  body_md: args.comment?.body_md,
                },
                version: result.comment.version,
              },
              extra.requestId,
            );
          }
        }
        if (result.properties !== undefined) {
          for (const stored of Object.values(result.properties)) {
            emitAgentEvent(
              rt,
              args.network_id,
              'property-value.set',
              {
                owner_type: 'thought',
                owner_id: result.thought.id,
                property_id: stored.property_id,
                value: stored.value,
              },
              extra.requestId,
            );
          }
        }
        if (result.links !== undefined) {
          for (const link of result.links) {
            emitAgentEvent(rt, args.network_id, 'link.created', { link }, extra.requestId);
          }
        }
        if (result.attachments !== undefined) {
          for (const attachment of result.attachments) {
            emitAgentEvent(rt, args.network_id, 'attachment.created', { attachment }, extra.requestId);
          }
        }

        auditAgentCall(rt, 'etn.thoughts.upsert_bundle', args.network_id, 'thought', result.thought.id, args);

        return {
          id: result.thought.id,
          version: result.thought.version,
          thought_action: result.thought_action,
          matched_on: result.matched_on,
          ...(result.comment === undefined
            ? {}
            : { comment: { id: result.comment.id, version: result.comment.version } }),
          ...(result.properties === undefined
            ? {}
            : {
                properties: Object.fromEntries(
                  Object.entries(result.properties).map(([key, v]) => [key, { id: v.id }]),
                ),
              }),
          ...(result.links === undefined
            ? {}
            : { links: result.links.map((l) => ({ id: l.id, version: l.version })) }),
          ...(result.attachments === undefined
            ? {}
            : { attachments: result.attachments.map((a) => ({ id: a.id })) }),
          // Task O6: surface unfilled required properties (computed by the
          // bundle service against the freshly written card) so the agent
          // can follow up. `warnings` is always an array here — it is part of
          // the result even when empty — so callers can rely on the shape.
          warnings: result.warnings ?? [],
          request_id: String(extra.requestId),
        } satisfies McpUpsertBundleResult;
      }),
  );

  // =========================================================================
  // Deduplication (§4.3)
  // =========================================================================

  const FindDuplicatesSchema = z.object({
    network_id: NetworkId,
    title: z.string().min(1),
    synonyms: z.array(z.string().min(1)).optional(),
  });
  mcp.registerTool(
    'etn.thoughts.find_duplicates',
    {
      title: 'Поиск дубликатов',
      description:
        'Find existing thoughts matching a proposed title/synonyms (exact title, exact synonym, ' +
        'partial). Each candidate carries its icon/style and one `parent_title` for disambiguation. ' +
        'Always call before `etn.thoughts.create` to avoid duplicates.',
      inputSchema: FindDuplicatesSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.find_duplicates'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return findDuplicates(ndb, args.title, args.synonyms ?? []);
      }),
  );
}
