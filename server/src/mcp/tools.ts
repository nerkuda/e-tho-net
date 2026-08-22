/**
 * MCP tools (task F4, docs/05-mcp-server.md §4).
 *
 * Twenty-six tools in three groups:
 *   * read (§4.1) — networks list, search, query, get, neighbours, subgraph,
 *     path, links get, mentions, usage, comments get, export, types list;
 *   * mutate (§4.2) — thought/link CRUD, comments.upsert/update/delete,
 *     attachments.add, properties.set, set_active, thoughts.upsert_bundle;
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
 * Tool names and result shapes reuse `@etn/shared` MCP contracts
 * ({@link MCP_TOOL_NAMES}, {@link McpMutationResult}).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { NetworkDb } from '../db/network-db.js';

import {
  ATTACHMENT_KINDS,
  COMMENT_KINDS,
  COMMENT_OWNER_TYPES,
  COMMENT_TARGETS_MAX,
  EtnError,
  EXPORT_FORMATS,
  FOCUS_DIRS,
  ICON_KINDS,
  PROPERTY_OWNER_TYPES,
  SEARCH_SCOPES,
  TRAVERSAL_DEFAULTS,
  type CommentTarget,
  type ExportFormat,
  type McpMutationResult,
  type McpPropertiesSetResult,
  type McpTypesListResult,
  type McpUpsertBundleResult,
} from '@etn/shared';

import {
  createThought,
  deleteThought,
  getNeighbors,
  getThoughtOrThrow,
  updateThought,
} from '../domain/thought-service.js';
import { createLink, deleteLink, findLinksBetween, getLink } from '../domain/link-service.js';
import {
  createCommentWithTargets,
  deleteComment,
  getComment,
  getCommentsPreview,
  listComments,
  updateComment,
} from '../domain/comment-service.js';
import { createAttachment } from '../domain/attachment-service.js';
import {
  findThoughtUsage,
  getPropertyValuesResolved,
  listEffectiveTypeProperties,
  setPropertyValue,
  setPropertyValues,
} from '../domain/property-service.js';
import { findDuplicates, findMentions, resolveThoughts, search } from '../domain/search-service.js';
import { upsertThoughtBundle } from '../domain/thought-bundle-service.js';
import { queryThoughts } from '../domain/query-service.js';
import { getThoughtMeta } from '../domain/thought-meta.js';
import { linkTypeCatalog, thoughtTypeCatalog } from './catalogs.js';
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
 * Register all twenty-six `etn.*` tools on a freshly built {@link McpServer}.
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
        "List every network the API key's user belongs to, with role and member counts. " +
        'The agent may only operate on networks returned here.',
    },
    () =>
      runTool(async () => {
        return rt.deps.systemDb.listNetworksForUser(rt.deps.auth.userId);
      }),
  );

  const SearchSchema = z.object({
    network_id: NetworkId,
    query: z.string().min(1),
    scope: z.enum(SEARCH_SCOPES).optional(),
    in_subtree_of: ThoughtId.optional(),
    type_id: ThoughtId.nullable().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  });
  mcp.registerTool(
    'etn.thoughts.search',
    {
      title: 'Полнотекстовый поиск',
      description:
        'Full-text search across thought names, comment texts, link texts and chronology ' +
        '(docs/05-mcp-server.md §4.1). `scope` selects result groups (`names`/`texts`/`links`/`chronology`/`all`). ' +
        '`in_subtree_of` restricts to the subtree of a thought; `type_id` filters by thought type.',
      inputSchema: SearchSchema,
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return search(ndb, {
          q: args.query,
          scope: args.scope,
          in: args.in_subtree_of === undefined ? undefined : 'subtree',
          from_thought_id: args.in_subtree_of,
          type_id: args.type_id === undefined || args.type_id === null ? undefined : [args.type_id],
          limit: args.limit,
          offset: 0,
        });
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
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const result = queryThoughts(ndb, args, { maxNodes: rt.limits.maxNodesPerSubgraph });
        return {
          ...result,
          thought_types: thoughtTypeCatalog(ndb, result.hits.map((h) => h.type_id)),
        };
      }),
  );

  const GetSchema = z.object({ network_id: NetworkId, thought_id: ThoughtId });
  mcp.registerTool(
    'etn.thoughts.get',
    {
      title: 'Мысль (полная)',
      description:
        'Fetch one thought with synonyms, type (with AI-facing description), styles and ' +
        'property values (`thought_ref` values resolved to {id, title}). `meta` carries ' +
        'counters and `meta.permanent` — a preview of the single permanent comment (body ' +
        'truncated to 2000 chars; `truncated` flag + comment `id`). When `truncated: true` ' +
        'fetch the full text via `etn.comments.get` (by that `id` or by this thought_id).',
      inputSchema: GetSchema,
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const thought = getThoughtOrThrow(ndb, args.thought_id);
        const type = thought.type_id === null ? null : getThoughtType(ndb, thought.type_id);
        const properties = getPropertyValuesResolved(ndb, 'thought', args.thought_id);
        return { ...thought, type, properties, meta: getThoughtMeta(ndb, args.thought_id) };
      }),
  );

  const NeighborsSchema = z.object({
    network_id: NetworkId,
    thought_id: ThoughtId,
    dir: z.enum(FOCUS_DIRS),
    depth: z.number().int().min(1).max(TRAVERSAL_DEFAULTS.MAX_DEPTH).optional(),
  });
  mcp.registerTool(
    'etn.thoughts.neighbors',
    {
      title: 'Соседи мысли',
      description:
        'Direct neighbours of a thought by direction (`parents`/`children`/`siblings`). ' +
        'With `depth > 1` performs a bounded breadth-first walk returning resolved thoughts. ' +
        'Responses carry `link_types`/`thought_types` reference tables (name + AI-facing ' +
        'description) for the types actually used.',
      inputSchema: NeighborsSchema,
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const depth = args.depth ?? 1;
        if (depth === 1) {
          const thought = getThoughtOrThrow(ndb, args.thought_id);
          const neighbors = getNeighbors(ndb, args.thought_id, args.dir, {
            userId: rt.deps.auth.userId,
          });
          return {
            thought: { id: thought.id, title: thought.title },
            dir: args.dir,
            depth: 1,
            neighbors,
            link_types: linkTypeCatalog(ndb, neighbors.map((n) => n.link_type_id)),
            thought_types: thoughtTypeCatalog(ndb, neighbors.map((n) => n.type_id)),
          };
        }
        const direction = args.dir === 'siblings' ? 'both' : args.dir;
        const walk = traverse(ndb, [args.thought_id], direction, {
          maxDepth: depth,
          maxNodes: rt.limits.maxNodesPerSubgraph,
        });
        const thoughts = resolveThoughts(ndb, walk.ids);
        return {
          thought_id: args.thought_id,
          dir: args.dir,
          depth,
          ids: walk.ids,
          thoughts,
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
    include_comments: z.boolean().optional(),
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
        '`max_nodes` is capped by the server setting max_nodes_per_subgraph.',
      inputSchema: SubgraphSchema,
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
        return {
          nodes,
          edges: result.edges,
          truncated: result.truncated,
          max_nodes: effectiveMax,
          thought_types: thoughtTypeCatalog(ndb, nodes.map((n) => n.type_id)),
          link_types: linkTypeCatalog(ndb, result.edges.map((e) => e.type_id)),
          ...(comments === undefined ? {} : { comments }),
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
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return findMentions(ndb, args.thought_id);
      }),
  );

  const UsageSchema = z.object({ network_id: NetworkId, thought_id: ThoughtId });
  mcp.registerTool(
    'etn.thoughts.usage',
    {
      title: 'Где используется мысль',
      description:
        'Thoughts referencing this thought as a `thought_ref` property value (formal links, ' +
        '«Использование» in the editor), grouped by property. Returns ' +
        '{ total, groups: [{property_id, key, thoughts[]}], thought_types } — the latter is ' +
        'a reference table (name + AI-facing description) for every type used in the result.',
      inputSchema: UsageSchema,
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const usage = findThoughtUsage(ndb, args.thought_id);
        return {
          ...usage,
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
        'HTML document. PDF is not supported on the MVP.',
      inputSchema: ExportSchema,
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const format: ExportFormat = args.format ?? 'markdown';
        const result = subgraph(ndb, args.seed_ids, args.radius, {
          maxNodes: rt.limits.maxNodesPerSubgraph,
        });
        let content: string;
        if (format === 'markdown') {
          content = exportToMarkdown(ndb, result.nodes);
        } else {
          const job = startExportJob(ndb, result.nodes, format);
          const downloaded = getExportJobContent(job.job_id, format);
          if (downloaded === null) {
            throw new Error('ETN error [INTERNAL]: export content unavailable');
          }
          content = downloaded.body;
        }
        return { format, truncated: result.truncated, content };
      }),
  );

  const TypesListSchema = z.object({ network_id: NetworkId });
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
        'type name in `etn.thoughts.create`, `etn.links.create` and `etn.thoughts.upsert_bundle`.',
      inputSchema: TypesListSchema,
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const thoughtTypes = listThoughtTypes(ndb).map((t) => ({
          id: t.id,
          name: t.name,
          parent_id: t.parent_id,
          is_root: t.is_root,
          description: t.description,
          icon: t.icon,
          properties: listEffectiveTypeProperties(ndb, 'thought_type', t.id),
        }));
        const linkTypes = listLinkTypes(ndb).map((t) => ({
          id: t.id,
          name_forward: t.name_forward,
          name_reverse: t.name_reverse,
          parent_id: t.parent_id,
          is_root: t.is_root,
          description: t.description,
          color: t.color,
          style: t.style,
          properties: listEffectiveTypeProperties(ndb, 'link_type', t.id),
        }));
        return { thought_types: thoughtTypes, link_types: linkTypes } satisfies McpTypesListResult;
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
        'Returns { id, version }.',
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
        const thought = createThought(
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
        'concurrency — on mismatch the call fails with VERSION_CONFLICT. Returns { id, version }.',
      inputSchema: UpdateThoughtSchema,
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const thought = updateThought(
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
        'Returns { id, version, thought_action, matched_on, comment?, properties?, links?, attachments? }.',
      inputSchema: UpsertBundleSchema,
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
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return findDuplicates(ndb, args.title, args.synonyms ?? []);
      }),
  );
}
