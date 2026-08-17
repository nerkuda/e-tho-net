/**
 * MCP tools (task F4, docs/05-mcp-server.md §4).
 *
 * Twenty tools in three groups:
 *   * read (§4.1) — networks list, search, query, get, neighbours, subgraph,
 *     path, links get, mentions, export;
 *   * mutate (§4.2) — thought/link CRUD, comments.upsert, attachments.add,
 *     properties.set, set_active;
 *   * dedupe (§4.3) — find_duplicates.
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

import {
  ATTACHMENT_KINDS,
  COMMENT_KINDS,
  COMMENT_OWNER_TYPES,
  EXPORT_FORMATS,
  FOCUS_DIRS,
  ICON_KINDS,
  PROPERTY_OWNER_TYPES,
  SEARCH_SCOPES,
  TRAVERSAL_DEFAULTS,
  type ExportFormat,
  type McpMutationResult,
} from '@etn/shared';

import {
  createThought,
  deleteThought,
  getNeighbors,
  getThoughtOrThrow,
  updateThought,
} from '../domain/thought-service.js';
import { createLink, deleteLink, findLinksBetween, getLink } from '../domain/link-service.js';
import { createComment, listComments, updateComment } from '../domain/comment-service.js';
import { createAttachment } from '../domain/attachment-service.js';
import { getPropertyValues, setPropertyValue } from '../domain/property-service.js';
import { findDuplicates, findMentions, resolveThoughts, search } from '../domain/search-service.js';
import { queryThoughts } from '../domain/query-service.js';
import { exportToMarkdown, getExportJobContent, startExportJob } from '../domain/export-service.js';
import { findPath, subgraph, traverse } from '../domain/graph-traversal.js';
import { getThoughtType } from '../domain/thought-type-service.js';
import { getLinkType } from '../domain/link-type-service.js';
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

/** Optional link attached to a freshly created thought (§4.2). */
const CreateLink = z
  .object({
    direction: z.enum(['parent', 'child']),
    target_thought_id: ThoughtId,
    type_id: z.string().min(1).nullable().optional(),
  })
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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all twenty `etn.*` tools on a freshly built {@link McpServer}.
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
        'ISO-8601 date ranges. Use instead of search when there is no text to query.',
      inputSchema: QuerySchema,
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return queryThoughts(ndb, args, { maxNodes: rt.limits.maxNodesPerSubgraph });
      }),
  );

  const GetSchema = z.object({ network_id: NetworkId, thought_id: ThoughtId });
  mcp.registerTool(
    'etn.thoughts.get',
    {
      title: 'Мысль (полная)',
      description:
        'Fetch one thought with synonyms, type (with AI-facing description), styles and property values.',
      inputSchema: GetSchema,
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const thought = getThoughtOrThrow(ndb, args.thought_id);
        const type = thought.type_id === null ? null : getThoughtType(ndb, thought.type_id);
        const properties = getPropertyValues(ndb, 'thought', args.thought_id);
        return { ...thought, type, properties };
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
        'With `depth > 1` performs a bounded breadth-first walk returning resolved thoughts.',
      inputSchema: NeighborsSchema,
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const depth = args.depth ?? 1;
        if (depth === 1) {
          const thought = getThoughtOrThrow(ndb, args.thought_id);
          return {
            thought: { id: thought.id, title: thought.title },
            dir: args.dir,
            depth: 1,
            neighbors: getNeighbors(ndb, args.thought_id, args.dir, {
              userId: rt.deps.auth.userId,
            }),
          };
        }
        const direction = args.dir === 'siblings' ? 'both' : args.dir;
        const walk = traverse(ndb, [args.thought_id], direction, {
          maxDepth: depth,
          maxNodes: rt.limits.maxNodesPerSubgraph,
        });
        return {
          thought_id: args.thought_id,
          dir: args.dir,
          depth,
          ids: walk.ids,
          thoughts: resolveThoughts(ndb, walk.ids),
          truncated: walk.truncated,
          reason: walk.reason ?? null,
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
        'active edges, and optionally comments per node. The key RAG tool — returns ready-to-use ' +
        'context. `max_nodes` is capped by the server setting max_nodes_per_subgraph.',
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
                comments: listComments(ndb, 'thought', id),
              }))
            : undefined;
        return {
          nodes,
          edges: result.edges,
          truncated: result.truncated,
          max_nodes: effectiveMax,
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
        return {
          from_id: args.from_id,
          to_id: args.to_id,
          path,
          ...(path === null ? {} : { thoughts: resolveThoughts(ndb, path) }),
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

  // =========================================================================
  // Mutating tools (§4.2) — domain services + real-time events + audit log
  // =========================================================================

  const CreateThoughtSchema = z.object({
    network_id: NetworkId,
    title: z.string().min(1),
    synonyms: z.array(z.string().min(1)).optional(),
    type_id: ThoughtId.nullable().optional(),
    active: z.boolean().optional(),
    link: CreateLink,
  });
  mcp.registerTool(
    'etn.thoughts.create',
    {
      title: 'Создать мысль',
      description:
        'Create a thought, optionally attaching a parent/child link in the same transaction. ' +
        'Call `etn.thoughts.find_duplicates` first to avoid duplicates. Returns { id, version }.',
      inputSchema: CreateThoughtSchema,
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const thought = createThought(
          ndb,
          {
            title: args.title,
            ...(args.synonyms === undefined ? {} : { synonyms: args.synonyms }),
            ...(args.type_id === undefined ? {} : { type_id: args.type_id }),
            ...(args.active === undefined ? {} : { active: args.active }),
            ...(args.link === undefined
              ? {}
              : {
                  create_link: {
                    direction: args.link.direction,
                    target_thought_id: args.link.target_thought_id,
                    type_id: args.link.type_id ?? null,
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
          const link = findLinksBetween(ndb, sourceId, targetId, args.link.type_id ?? null)[0];
          if (link !== undefined) {
            emitAgentEvent(rt, args.network_id, 'link.created', { link }, extra.requestId);
          }
        }
        auditAgentCall(rt, 'etn.thoughts.create', args.network_id, 'thought', thought.id, {
          title: args.title,
          synonyms: args.synonyms,
          type_id: args.type_id,
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

  const CreateLinkSchema = z.object({
    network_id: NetworkId,
    source_id: ThoughtId,
    target_id: ThoughtId,
    type_id: z.string().min(1).nullable().optional(),
  });
  mcp.registerTool(
    'etn.links.create',
    {
      title: 'Создать связь',
      description:
        'Create a directed link source → target, optionally typed. Duplicate pairs and ' +
        'self-loops are rejected. Returns { id, version }.',
      inputSchema: CreateLinkSchema,
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const link = createLink(
          ndb,
          { source_id: args.source_id, target_id: args.target_id, type_id: args.type_id ?? null },
          rt.deps.auth.userId,
        );
        emitAgentEvent(rt, args.network_id, 'link.created', { link }, extra.requestId);
        auditAgentCall(rt, 'etn.links.create', args.network_id, 'link', link.id, {
          source_id: args.source_id,
          target_id: args.target_id,
          type_id: args.type_id,
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

  const UpsertCommentSchema = z.object({
    network_id: NetworkId,
    owner_type: z.enum(COMMENT_OWNER_TYPES),
    owner_id: z.string().min(1),
    kind: z.enum(COMMENT_KINDS),
    title: z.string().nullable().optional(),
    body_md: z.string().min(1),
    valid_from: z.string().min(1).optional(),
    valid_to: z.string().nullable().optional(),
  });
  mcp.registerTool(
    'etn.comments.upsert',
    {
      title: 'Создать/обновить комментарий',
      description:
        'For `permanent`: creates the single permanent comment of the owner, or updates it when ' +
        'it already exists. For `chronological`: always appends a new dated entry ' +
        '(`valid_from`/`valid_to`). Returns { id, version }.',
      inputSchema: UpsertCommentSchema,
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        if (args.kind === 'permanent') {
          const existing = listComments(ndb, args.owner_type, args.owner_id).find(
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
        const comment = createComment(
          ndb,
          args.owner_type,
          args.owner_id,
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

  const SetPropertySchema = z.object({
    network_id: NetworkId,
    owner_type: z.enum(PROPERTY_OWNER_TYPES),
    owner_id: z.string().min(1),
    key: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  });
  mcp.registerTool(
    'etn.properties.set',
    {
      title: 'Установить свойство',
      description:
        'Set (or clear with `value: null`) a property value on a thought/link, addressed by key; ' +
        "the value must match the property definition's value_type. Returns { id, version: 0 }.",
      inputSchema: SetPropertySchema,
    },
    (args, extra) =>
      runTool(async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const stored = setPropertyValue(ndb, args.owner_type, args.owner_id, args.key, args.value);
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
          key: args.key,
          value: args.value,
        });
        return {
          id: stored.id,
          version: 0,
          request_id: String(extra.requestId),
        } satisfies McpMutationResult;
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
        'partial). Always call before `etn.thoughts.create` to avoid duplicates.',
      inputSchema: FindDuplicatesSchema,
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return findDuplicates(ndb, args.title, args.synonyms ?? []);
      }),
  );
}
