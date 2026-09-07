/**
 * MCP tools (task F4, docs/05-mcp-server.md §4).
 *
 * Forty-five tools in four groups (see {@link MCP_TOOL_NAMES} for the exact
 * roster — counts drift with every phase, this is a map, not a tally):
 *   * read (§4.1) — networks list, search, query, get, neighbours, subgraph,
 *     path, links get, mentions, usage, comments get, export, types list,
 *     changes list (O9), metrics.reads (O10), metrics.tools (940a499d),
 *     layers.list (S10);
 *   * mutate (§4.2) — thought/link CRUD, comments.upsert/update/delete,
 *     attachments.add, properties.set, set_active, thoughts.upsert_bundle,
 *     attachments.search, layers.create/update/delete/select/merge (S10);
 *   * dedupe (§4.3) — find_duplicates.
 *
 * **Layer awareness is sequential, not a separate concern (S10, 13-layers.md
 * §10.2):** every read/write tool above resolves the calling API key's own
 * session layer through `openMemberNetwork` (`mcp/context.ts`) — there is no
 * parallel "layer-aware" variant of `etn.thoughts.get` etc. The six
 * `etn.layers.*` tools manage the layers themselves (list/create/rename/
 * delete/select/merge) and, like the REST layer routes, run on the base-layer
 * connection because `layers`/`session_layers` are not branchable (§3).
 *
 * `etn.thoughts.create`, `etn.links.create` and `etn.thoughts.upsert_bundle`
 * additionally accept a type **by name** (`type`, task O4) as an alternative
 * to `type_id` — resolved case-insensitively against `etn.types.list`'s
 * catalogues before the domain call.
 *
 * Задача d5ab1630 — то же именование распространяется на фильтры
 * `etn.thoughts.query` (`type[]` для типов мыслей, `property` для
 * свойств) и `etn.thoughts.search` (`type` для типов мыслей). Каждая
 * именованная форма XOR-исключает id-формой (`type_id`/`property_id`),
 * резолвится тем же хелпером, что и пишущие инструменты, и возвращается в
 * ответе полем `resolved_types`/`resolved_type`/`resolved_properties` для
 * подтверждения разрезолва.
 *
 * Задача 3ea09a54 — `etn.thoughts.get` возвращает `meta.permanent` полным
 * текстом (без `chars_*`/`truncated`); все остальные выборки сущностей
 * (subgraph, structure, списки) продолжают получать preview-форму.
 *
 * Mutating tools are facades over the **same domain services as REST**
 * (05 §7): membership is re-checked per call, the read-only flag and the
 * per-minute write budget are enforced, each successful write emits its
 * catalogue real-time event via {@link emitAgentEvent} /
 * {@link emitAgentActivityEvent}, appends an `activity_log` row (требование
 * b0c7a57c — same `record*Activity` helpers and snapshots as the REST routes;
 * `edit.*` captures and per-user events are never journaled) and adds an
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
import { closeNetworkDb, openNetworkDb } from '../db/network-db.js';
import {
  createLayer,
  deleteLayerWithEvents,
  layerSubtreeIds,
  listLayers,
  resolveSessionLayer,
  resolveSessionSwitchSeq,
  setSessionLayer,
  updateLayer,
} from '../domain/layer-service.js';
import { layerDiffDoc, resolveDiffTarget, structuralLayerDiff } from '../domain/layer-diff-service.js';
import { mergeLayer, type MergeSelection } from '../domain/merge-service.js';
import { BRANCHABLE_TABLES } from '../db/layer-chain.js';
import type { BranchableTable } from '../db/layer-write.js';
import { isEventVisibleInLayer } from '../realtime/layer-visibility.js';

import {
  ATTACHMENT_KINDS,
  BASE_LAYER_ID,
  COMMENT_KINDS,
  COMMENT_OWNER_TYPES,
  COMMENT_TARGETS_MAX,
  EtnError,
  EXPORT_FORMATS,
  FOCUS_DIRS,
  ICON_KINDS,
  MCP_MAX_THOUGHTS_PER_WRITE,
  MCP_TOOL_ANNOTATIONS,
  MCP_VIEW_MODES,
  PROPERTY_OWNER_TYPES,
  PROPERTY_VALUE_TYPES,
  REALTIME_DEFAULTS,
  SEARCH_SCOPES,
  TYPE_OWNER_TYPES,
  TYPES_LIST_SCOPES,
  TRAVERSAL_DEFAULTS,
  buildLikePattern,
  parseFilterKeywords,
  validateTypeRoles,
  type CommentTarget,
  type EditAcquiredData,
  type EditClearedData,
  type EditReleasedData,
  type ExportFormat,
  type Layer,
  type LayerMergeReport,
  type McpChangeEntry,
  type McpChangesListResult,
  type McpMetricsReadsResult,
  type McpMetricsToolsResult,
  type McpMutationResult,
  type McpPropertiesSetResult,
  type OntologyDeleteParams,
  type OntologyDeleteResult,
  type OntologyWriteParams,
  type OntologyWriteResult,
  type McpThoughtWriteItemResult,
  type McpThoughtWriteParams,
  type McpThoughtWriteResult,
  type McpToolAnnotations,
  type McpTypesListResult,
  type McpUpsertBundleResult,
  type McpViewMode,
  type Network,
  type PropertyDefinition,
  type PropertyValueValue,
} from '@etn/shared';

import {
  createThoughtWithWarnings,
  checkThoughtDeletion,
  countNeighbors,
  deleteThought,
  getNeighbors,
  getThoughtsByIdsResolved,
  getThoughtOrThrow,
  updateThought,
  updateThoughtWithWarnings,
} from '../domain/thought-service.js';
import {
  checkLinkDeletion,
  createLink,
  deleteLink,
  findLinksBetween,
  getLink,
  getLinkFillingFlags,
  updateLink,
} from '../domain/link-service.js';
import {
  createCommentWithTargets,
  deleteComment,
  editComment,
  getComment,
  getCommentsPreview,
  getPermanentFull,
  getPermanentPreview,
  listComments,
  updateComment,
} from '../domain/comment-service.js';
import { createAttachment, getAttachment, listAttachments } from '../domain/attachment-service.js';
import {
  copyAttachment,
  deleteAttachment,
  searchAttachments,
  updateAttachment,
} from '../domain/attachment-service.js';
import {
  clearThoughtRefUsages,
  findThoughtUsage,
  getNetworkProperty,
  getPropertyValuesResolved,
  listEffectiveTypeProperties,
  resolveDefinition,
  resolvePropertyIdByName,
  setPropertyValue,
  setPropertyValues,
} from '../domain/property-service.js';
import { findBacklinks } from '../domain/backlinks-service.js';
import { normalizeOptionalText } from '../routes/networks.js';
import { emitDomainEvent } from '../realtime/emit.js';
import { listTrash, purgeTrash } from '../domain/trash-service.js';
import {
  collectSubtreeTypes,
  findDuplicates,
  findMentions,
  resolveThoughts,
  search,
} from '../domain/search-service.js';
import {
  acquireLock,
  clearLocksForUser,
  listLocks,
  releaseLock,
  type LockRow,
} from '../domain/lock-service.js';
import {
  ACTIVITY_LIMIT_MAX,
  listActivity,
  recordAttachmentActivity,
  recordCommentActivity,
  recordLayerActivity,
  recordLinkActivity,
  recordThoughtActivity,
  rollupActivity,
  truncateActivity,
} from '../domain/activity-service.js';
import { shrinkSubgraphToBudget } from './subgraph-budget.js';
import { upsertThoughtBundle } from '../domain/thought-bundle-service.js';
import { writeThoughts } from '../domain/thought-write-service.js';
import { queryThoughts } from '../domain/query-service.js';
import { queryChronicle, parseChronicleQueryBody } from '../domain/chronicle-service.js';
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
  sanitizeIcon,
  thoughtTypeCatalog,
  toCompactThought,
  toCompactThoughtRef,
  withSanitizedIcon,
} from './catalogs.js';
import { exportToMarkdown, getExportJobContent, startExportJob } from '../domain/export-service.js';
import { findPath, subgraph, traverse } from '../domain/graph-traversal.js';
import {
  getThoughtType,
  listThoughtTypes,
  resolveThoughtTypeIdByName,
} from '../domain/thought-type-service.js';
import { expandTypeIdsToSubtree } from '../domain/type-hierarchy.js';
import {
  getLinkType,
  listLinkTypes,
  resolveLinkTypeIdByName,
} from '../domain/link-type-service.js';
import { writeOntology } from '../domain/ontology-write-service.js';
import { deleteOntologyEntity } from '../domain/ontology-delete-service.js';
import {
  assertNetworkAccess,
  auditAgentCall,
  emitAgentActivityEvent,
  emitAgentEvent,
  mcpLayerClientId,
  openMemberNetwork,
  openMemberNetworkBase,
  requireWriteBudget,
  requireWritable,
  resolveRuntimeLayer,
  runTool,
  runWriteTool,
  type McpRuntime,
} from './context.js';

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const NetworkId = z.string().min(1);
const ThoughtId = z.string().min(1);
const LinkId = z.string().min(1);
const LayerId = z.string().min(1);
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

/** Error text shared by every `property_id`/`property` pair (задача d5ab1630). */
const PROPERTY_ID_PROPERTY_CONFLICT = 'provide at most one of property_id or property';

/**
 * `direction` of an MCP inline link (`etn.thoughts.create` `link`,
 * `etn.thoughts.upsert_bundle` `links[]`): the value names the role of
 * `target_thought_id` relative to the NEW thought. `parent` — attach the new
 * thought UNDER the target (target becomes its parent); `child` — the NEW
 * thought becomes the parent of the target. Unified with the domain/REST
 * `create_link` direction (docs/03-server-api.md §6.3) — both layers share
 * the same semantics, no translation at the MCP boundary.
 */
const LinkDirection = z
  .enum(['parent', 'child'])
  .describe(
    'Role of target_thought_id for the NEW thought: "parent" — attach the new thought ' +
      'UNDER target_thought_id (target becomes its parent); "child" — the NEW thought ' +
      'becomes the parent of target_thought_id.',
  );

/** Optional link attached to a freshly created thought (§4.2). `type` (task
 *  O4) resolves a link type by `name_forward`/`name_reverse`, mutually
 *  exclusive with `type_id`. */
const CreateLink = z
  .object({
    direction: LinkDirection,
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
        "List every network the API key's user belongs to, with role and member counts, plus the network's " +
        '`description` and `when_to_use` fields. `has_structure: true` — the network exposes its machine-readable ' +
        'structure via `etn.networks.structure`. The agent may only operate on networks returned here.',
      annotations: MCP_TOOL_ANNOTATIONS['etn.networks.list'],
    },
    () =>
      runTool(async () => {
        return rt.deps.systemDb.listNetworksForUser(rt.deps.auth.userId);
      }),
  );

  // etn.networks.structure — O5 read tool. Returns the active thoughts of the
  // network's `table_of_contents` role (task ba024a45 / 0.7.2, ADR 46d17a91 —
  // the legacy `node_section_type_id` column was replaced by `type_roles`).
  // Each section is enriched with a permanent-comment preview, property
  // values, neighbour counts and a usage_count (N3) — the same shape agents
  // already know from `etn.thoughts.get` / `etn.thoughts.usage`, so an agent
  // can dive from a structure node straight into a full read.
  //
  // Bug fix (self-description reachability): §3/§4 of docs/05-mcp-server.md
  // describe FOUR markdown self-description fields (`description`,
  // `when_to_use`, `conventions`, `examples`), read via `GET /networks/{id}`
  // or the `etn://networks/{id}` resource. Neither exists as an MCP tool
  // (there is no `etn.networks.get`, and the ZCode MCP client does not expose
  // resources to the agent at all), so `conventions`/`examples` were
  // write-only from the agent's point of view. `etn.networks.structure` is
  // already the tool an agent calls first when orienting in a network, so we
  // piggy-back `conventions` on its response — no extra round trip. `examples`
  // stays out of the default payload (worked examples tend to be long, and
  // most orientation flows don't need them): it is returned only when the
  // caller opts in via `include_examples`, mirroring the "explicit request"
  // resolution the bug report itself proposed for that field.
  //
  // The response also carries the full `type_roles` dictionary and a
  // conditional `instructions_ref` hint when the network has set the
  // `instructions` role (ADR 717f04df «инструкции-витриной» — agents are
  // told to call `etn.instructions` to read the network's prompt instructions).
  const NetworksStructureSchema = z.object({
    network_id: NetworkId,
    include_examples: z.boolean().optional(),
  });
  mcp.registerTool(
    'etn.networks.structure',
    {
      title: 'Структура сети',
      description:
        'Read the structure declared via `type_roles.table_of_contents`: active thoughts of that type ' +
        'with permanent-comment previews (2000 chars, `truncated`+`comment_id` → `etn.comments.get`), ' +
        'property values, neighbour counters, `thought_types`. Carries `conventions`, `type_roles` and ' +
        '`instructions_ref` when the `instructions` role is set. `include_examples: true` adds `examples`. ' +
        '`has_structure: false` → empty `sections`, fall back to search/query.',
      inputSchema: NetworksStructureSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.networks.structure'],
    },
    (args) =>
      runTool(async () => {
        const network = rt.deps.systemDb.getNetworkById(args.network_id);
        if (network === null) {
          throw new EtnError('NOT_FOUND', `Network ${args.network_id} not found.`);
        }
        // Access re-check mirrors `openMemberNetwork` (here we only need a
        // single read, so we do not need the ndb unless the network has a
        // structure marker); member or global admin (06-auth.md §4.1).
        assertNetworkAccess(rt, args.network_id);
        const examplesField =
          args.include_examples === true ? { examples: network.examples } : {};
        const sectionTypeId =
          typeof network.type_roles.table_of_contents === 'string'
            ? network.type_roles.table_of_contents
            : null;
        // Convention tail: tell the agent where to read the network's instructions.
        // Only present when the network actually set the role — empty `type_roles`
        // must NOT advertise `etn.instructions` (would just return an empty list).
        const instructionsField =
          typeof network.type_roles.instructions === 'string'
            ? {
                instructions_ref:
                  'Эта сеть публикует инструкции для агентов. Прочитайте их через ' +
                  '`etn.instructions { network_id: ' +
                  args.network_id +
                  ' }` перед первым изменением.',
              }
            : {};
        if (sectionTypeId === null) {
          return {
            network_id: args.network_id,
            has_structure: false as const,
            type_roles: network.type_roles,
            conventions: network.conventions,
            ...instructionsField,
            ...examplesField,
            sections: [],
            thought_types: [],
          };
        }
        const ndb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger);
        const rows = ndb
          .prepare(
            `SELECT id, title, type_id, active, version, created_at, updated_at
               FROM thoughts_v
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
        // network's structure. `table_of_contents` rows are typically a
        // handful, so this is a tiny batch — kept here for completeness so
        // the owner can see "the agent loaded these sections N times".
        recordReads(ndb, sections.map((s) => s.id), { now: new Date().toISOString() });

        // Reference table: the network's section type plus every other type
        // referenced by the section nodes (caller can dive further without an
        // extra `etn.types.list` round trip).
        // Bug fix (§5.1e): sanitize the section type's own icon — the
        // `thought_types` catalogue below is already sanitized via
        // `thoughtTypeCatalog`, but `node_section_type` is the raw type record.
        const rawSectionType = getThoughtType(ndb, sectionTypeId);
        const sectionType = rawSectionType === null ? null : withSanitizedIcon(rawSectionType);
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
          type_roles: network.type_roles,
          node_section_type: sectionType,
          conventions: network.conventions,
          ...instructionsField,
          ...examplesField,
          sections,
          thought_types: thoughtTypes,
        };
      }),
  );

  const SearchSchema = z
    .object({
      network_id: NetworkId,
      query: z.string().min(1),
      scope: z.enum(SEARCH_SCOPES).optional(),
      in_subtree_of: ThoughtId.optional(),
      type_id: ThoughtId.nullable().optional(),
      // Задача d5ab1630 — фильтр по типу через имя (case-insensitive, `name_key`).
      // Резолвится в `type_id` через `resolveThoughtTypeIdByName`; NOT_FOUND
      // если такого имени нет, VALIDATION_ERROR + candidates при неоднозначности.
      // Взаимоисключающе с `type_id`.
      type: z.string().min(1).optional(),
      // Задача 59119797 «Фильтры Автор/Редактор»: id пользователя,
      // создавшего (`author_id`) или последним изменившего (`editor_id`)
      // мысль. Применяется к by_names, by_texts и by_chrono (для thoughts);
      // для by_links пропускается. Пустая строка трактуется как отсутствие.
      author_id: z.string().optional(),
      editor_id: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .refine((v) => v.type_id === undefined || v.type === undefined, { message: TYPE_ID_TYPE_CONFLICT });
  mcp.registerTool(
    'etn.thoughts.search',
    {
      title: 'Полнотекстовый поиск',
      description:
        'Full-text search across thought names, comment texts, link texts and chronology. `scope` selects ' +
        'result groups (`names`/`texts`/`links`/`chronology`/`all`); `in_subtree_of`, `type_id` (or its ' +
        'name-form `type`, resolved case-insensitively via `etn.types.list`; `NOT_FOUND` if no such type, ' +
        '`VALIDATION_ERROR` with `details.candidates` on ambiguity), `author_id`/`editor_id` narrow it. ' +
        '`limit` (1–200, default 50) + `offset` walk the tail; `meta.total_in_group` gives unfiltered totals ' +
        'per group.',
      inputSchema: SearchSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.search'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        // Резолв имени типа в id (задача d5ab1630). Сбор эха для ответа —
        // `resolved_type` приходит, только если агент передал `type`.
        let resolvedType: { input: string; id: string; name: string } | undefined;
        let typeIdForDomain: string[] | undefined;
        if (args.type !== undefined) {
          const id = resolveThoughtTypeIdByName(ndb, args.type);
          const name = ndb
            .prepare('SELECT name FROM thought_types_v WHERE id = ?')
            .get(id) as { name: string } | undefined;
          resolvedType = { input: args.type, id, name: name?.name ?? args.type };
          typeIdForDomain = [id];
        } else if (args.type_id !== undefined && args.type_id !== null) {
          typeIdForDomain = [args.type_id];
        }
        const result = search(ndb, {
          q: args.query,
          scope: args.scope,
          in: args.in_subtree_of === undefined ? undefined : 'subtree',
          from_thought_id: args.in_subtree_of,
          type_id: typeIdForDomain,
          author_id: args.author_id,
          editor_id: args.editor_id,
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
        // Bug fix (§5.1e): `search` is shared with the REST `/search` route
        // (which needs the real icon to render results), so sanitize only at
        // this MCP-facing call site. `by_names`/`by_texts` carry the thought's
        // `icon`; `by_links`/`by_chrono` do not.
        return {
          ...result,
          by_names: result.by_names.map((h) => withSanitizedIcon(h)),
          by_texts: result.by_texts.map((h) => withSanitizedIcon(h)),
          ...(resolvedType !== undefined ? { resolved_type: resolvedType } : {}),
        };
      }),
  );

  const QueryPropertySchema = z
    .object({
      // Задача d5ab1630: `property_id` (registry id) или `property` (имя из
      // реестра). Взаимоисключающе — XOR, иначе 422.
      property_id: z.string().min(1).optional(),
      property: z.string().min(1).optional(),
      operator: z.enum(['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte']),
      value: z.union([z.string(), z.number(), z.boolean()]),
    })
    .refine(
      (v) => v.property_id === undefined || v.property === undefined,
      { message: PROPERTY_ID_PROPERTY_CONFLICT },
    );
  const QuerySchema = z
    .object({
      network_id: NetworkId,
      in_subtree_of: ThoughtId.optional(),
      max_depth: z.number().int().min(1).max(TRAVERSAL_DEFAULTS.MAX_DEPTH).optional(),
      type_id: z.array(z.string().min(1)).optional(),
      // Задача d5ab1630: фильтр по типам через имена (case-insensitive,
      // `name_key`); резолвится в `type_id[]` через `etn.types.list`.
      // NOT_FOUND если имени нет, VALIDATION_ERROR + candidates при
      // неоднозначности. Взаимоисключающе с `type_id`.
      type: z.array(z.string().min(1)).optional(),
      active: z.enum(['true', 'false', 'any']).optional(),
      trashed: z.enum(['true', 'false', 'any']).optional(),
      keywords: z.string().min(1).optional(),
      properties: z.array(QueryPropertySchema).optional(),
      created_after: z.string().min(1).optional(),
      created_before: z.string().min(1).optional(),
      updated_after: z.string().min(1).optional(),
      updated_before: z.string().min(1).optional(),
      // Задача 59119797 «Фильтры Автор/Редактор»: id пользователя,
      // создавшего мысль (`author_id`) или последним изменившего (`editor_id`).
      author_id: z.string().optional(),
      editor_id: z.string().optional(),
      sort: z.enum(['title', 'created_at', 'updated_at']).optional(),
      order: z.enum(['asc', 'desc']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .refine(
      (v) => v.type_id === undefined || v.type === undefined,
      { message: TYPE_ID_TYPE_CONFLICT },
    );
  mcp.registerTool(
    'etn.thoughts.query',
    {
      title: 'Структурная выборка мыслей',
      description:
        'List thoughts by criteria — no text query required; filters combine with AND. `in_subtree_of` ' +
        '(+`max_depth`) — directed descendants (hits carry `depth`); `type_id[]` (or its name-form `type[]`, ' +
        'resolved case-insensitively via `etn.types.list`; `NOT_FOUND` if no such type, `VALIDATION_ERROR` ' +
        'with `details.candidates` on ambiguity); `active` and `trashed` (`true`/`false`/`any`; `trashed` ' +
        'defaults to `false`); `keywords` — mini-syntax over title and synonyms (words all required, ' +
        '`*` infix wildcard, `-word` exclusion); `properties` — registry `property_id` (or its name-form ' +
        '`property`, same resolve semantics) + operator eq/ne/contains/gt/gte/lt/lte + value (unknown ' +
        '`property_id` matches nothing; the `value_type` picks the column: number → value_number, bool → ' +
        'value_bool, others on their text columns); `created_*`/`updated_*` — ISO-8601 ranges; ' +
        '`author_id`/`editor_id` — id пользователя, создавшего/последним изменившего мысль. Response carries ' +
        'a `thought_types` reference table plus the optional `resolved_types` / `resolved_properties` echoes ' +
        'for inputs that came in by name.',
      inputSchema: QuerySchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.query'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        // Резолв имён типов в id (задача d5ab1630). Сбор эха для ответа —
        // `resolved_types` приходит, только если агент передал `type`.
        let resolvedTypes: Array<{ input: string; id: string; name: string }> | undefined;
        if (args.type !== undefined) {
          resolvedTypes = [];
          for (const name of args.type) {
            const id = resolveThoughtTypeIdByName(ndb, name);
            const row = ndb
              .prepare('SELECT name FROM thought_types_v WHERE id = ?')
              .get(id) as { name: string } | undefined;
            resolvedTypes.push({ input: name, id, name: row?.name ?? name });
          }
        }
        // Резолв имён свойств в id. Сбор эха `resolved_properties` —
        // аналогично, только при наличии условий с `property`.
        let resolvedProperties:
          | Array<{ input: string; id: string; name: string }>
          | undefined;
        let domainProperties = args.properties;
        if (args.properties !== undefined) {
          const out: NonNullable<typeof args.properties> = [];
          let resolved: Array<{ input: string; id: string; name: string }> | null = null;
          for (const cond of args.properties) {
            if (cond.property !== undefined) {
              const id = resolvePropertyIdByName(ndb, cond.property);
              const row = ndb
                .prepare('SELECT name FROM properties_v WHERE id = ?')
                .get(id) as { name: string } | undefined;
              out.push({ ...cond, property_id: id });
              if (resolved === null) resolved = [];
              resolved.push({ input: cond.property, id, name: row?.name ?? cond.property });
              continue;
            }
            out.push(cond);
          }
          domainProperties = out;
          if (resolved !== null) resolvedProperties = resolved;
        }
        const result = queryThoughts(
          ndb,
          {
            ...args,
            // Передаём уже резолвнутые id (MCP-фасад гарантирует, что
            // XOR-схема соблюдена и обе формы не приходят одновременно);
            // domain-сервис делает второй проход для REST-вызовов.
            type_id:
              args.type_id ??
              (resolvedTypes !== undefined ? resolvedTypes.map((r) => r.id) : undefined),
            type: undefined,
            properties: domainProperties,
          },
          { maxNodes: rt.limits.maxNodesPerSubgraph },
        );
        // O10: count every hit in the structured query.
        recordReads(ndb, result.hits.map((h) => h.id), { now: new Date().toISOString() });
        return {
          ...result,
          thought_types: thoughtTypeCatalog(ndb, result.hits.map((h) => h.type_id)),
          ...(resolvedTypes !== undefined ? { resolved_types: resolvedTypes } : {}),
          ...(resolvedProperties !== undefined ? { resolved_properties: resolvedProperties } : {}),
        };
      }),
  );

  const GetSchema = z.object({ network_id: NetworkId, thought_id: ThoughtId, view: View });
  mcp.registerTool(
    'etn.thoughts.get',
    {
      title: 'Мысль (полная)',
      description:
        'Fetch one thought with synonyms, type (AI-facing description included) and property values ' +
        '(`thought_ref` resolved to {id, title}; values whose property is not on the owner\'s type chain ' +
        'are flagged `outside_type: true` — do not treat such a card as empty). `meta.permanent` — the ' +
        'full text of the permanent comment (задача 3ea09a54: в `etn.thoughts.get` обрезка отключена; в ' +
        'остальных выборках — preview 2000 chars, `etn.comments.get` для полного). `meta.link_stats` ' +
        '(0.7.2) — счётчики активных связей по `(link_type_id, direction)` + `link_types`. ' +
        '`view: "compact"` (default) drops visual fields.',
      inputSchema: GetSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.get'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const rawThought = getThoughtOrThrow(ndb, args.thought_id);
        const rawType = rawThought.type_id === null ? null : getThoughtType(ndb, rawThought.type_id);
        const properties = getPropertyValuesResolved(ndb, 'thought', args.thought_id);
        // O10: count this single read for `etn.metrics.reads` analytics.
        recordReads(ndb, [rawThought.id], { now: new Date().toISOString() });
        // Задача 3ea09a54: для `etn.thoughts.get` `meta.permanent` отдаётся
        // полным текстом (без `chars_*`/`truncated`). Все остальные выборки
        // сущностей (subgraph, structure, списки) продолжают получать
        // preview-форму — требование «выборка сущностей → превью».
        const meta = getThoughtMeta(ndb, args.thought_id, { fullPermanent: true });
        const view: McpViewMode = args.view ?? 'compact';
        // Bug fix (docs/05-mcp-server.md §5.1e): a `data:` icon URL is dropped
        // in every view — see `sanitizeIcon`/`withSanitizedIcon` in
        // ./catalogs.ts for the rationale. Applied before the O12 branch so
        // both `full` and `compact` get the same treatment.
        const thought = withSanitizedIcon(rawThought);
        const type = rawType === null ? null : withSanitizedIcon(rawType);
        // Keep the response envelope identical between views — only the
        // thought-level fields differ. `type`, `properties` and `meta` were
        // never affected by the O12 projection change.
        const projected = view === 'full' ? thought : toCompactThought(thought);
        return { ...projected, type, properties, meta };
      }),
  );

  // etn.thoughts.resolve — пакетное чтение по списку id (задача 6d45ab37,
  // спека 85b94925, P1-паритет MCP↔REST `POST /thoughts/resolve`).
  // Возвращает карточки в порядке первого появления id в запросе плюс
  // `missing[]` для отсутствующих. Лимит по размеру пачки —
  // `rt.limits.maxNodesPerSubgraph` (тот же, что у `etn.thoughts.subgraph`).
  const ResolveSchema = z.object({
    network_id: NetworkId,
    thought_ids: z.array(ThoughtId).min(1).max(rt.limits.maxNodesPerSubgraph),
    view: View,
  });
  mcp.registerTool(
    'etn.thoughts.resolve',
    {
      title: 'Пакетное чтение мыслей',
      description:
        'Батч-чтение по списку id: `items[]` (карточки в порядке первого появления, дубли ' +
        'схлопываются) + `missing[]`. Карточка несёт мысль, тип, свойства, `meta.link_stats` и ' +
        'полнотекстовый `comment_preview`. Лимит — `maxNodesPerSubgraph`.',
      inputSchema: ResolveSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.resolve'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const view: McpViewMode = args.view ?? 'compact';
        const result = getThoughtsByIdsResolved(ndb, args.thought_ids);
        // O10: count reads for `etn.metrics.reads` analytics.
        recordReads(
          ndb,
          result.items.map((c) => c.id),
          { now: new Date().toISOString() },
        );
        const items =
          view === 'full'
            ? result.items
            : result.items.map((card) => ({
                ...card,
                // Проекция касается только полей самой мысли (id/title/...);
                // `type`, `properties`, `meta` и `comment_preview` остаются в
                // полной форме — тот же контракт, что и у `etn.thoughts.get`.
                id: card.id,
                title: card.title,
                type_id: card.type_id,
                icon: card.icon,
                icon_kind: card.icon_kind,
                icon_attachment_id: card.icon_attachment_id,
                active: card.active,
                marked_for_deletion: card.marked_for_deletion,
                fg_color: null,
                bg_color: null,
                font_bold: null,
                font_italic: null,
                font_underline: null,
                font_strike: null,
                synonyms: card.synonyms,
                version: card.version,
                created_at: card.created_at,
                updated_at: card.updated_at,
              }));
        // Reference table: только типы, реально использованные в items.
        const thoughtTypes = thoughtTypeCatalog(
          ndb,
          result.items.map((c) => c.type_id),
        );
        return { items, missing: result.missing, thought_types: thoughtTypes };
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
        'Direct neighbours of a thought by direction (`parents`/`children`/`siblings`) or `both` (0.7.2); ' +
        '`depth > 1` does a bounded BFS walk. `dir: "both"` (0.7.2) — оба направления одним вызовом, ' +
        'записи несут `direction: "in"|"out"`. Рёбра (0.7.2) несут `has_properties`/`has_comment` — ' +
        'два агрегирующих запроса на весь набор рёбер, не на ребро. На `depth: 1` страница 50 — ' +
        '`total`/`truncated` показывают остаток; дальше — `etn.thoughts.query { in_subtree_of, max_depth: 1 }`. ' +
        'Справочники `link_types`/`thought_types`.',
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
          const neighborOpts = { userId: rt.deps.auth.userId };
          // `dir: "both"` (0.7.2) — both directions in one call. The domain
          // `getNeighbors` is built for parents/children/siblings (REST trio)
          // and would map `both` to siblings; we call it twice and glue the
          // results here. Each entry carries its own `direction: "in"|"out"`.
          if (args.dir === 'both') {
            const parents = getNeighbors(ndb, args.thought_id, 'parents', neighborOpts).map((n) => ({
              ...n,
              direction: 'in' as const,
            }));
            const children = getNeighbors(ndb, args.thought_id, 'children', neighborOpts).map((n) => ({
              ...n,
              direction: 'out' as const,
            }));
            // Concatenate in arrival order (parents first, then children) — a
            // single thought can appear in both lists when it has both an
            // incoming and an outgoing edge to the focus, in which case BOTH
            // entries surface (separate `link_id`s).
            const rawNeighbors = [...parents, ...children];
            const neighbors = rawNeighbors.map((n) => withSanitizedIcon(n));
            // Edge flags: aggregating on the whole returned set.
            const fillingFlags = getLinkFillingFlags(
              ndb,
              neighbors.map((n) => n.link_id),
            );
            const annotated = neighbors.map((n) => {
              const flags = fillingFlags.get(n.link_id);
              return {
                ...n,
                has_properties: flags?.has_properties ?? false,
                has_comment: flags?.has_comment ?? false,
              };
            });
            const linkTypes =
              view === 'full'
                ? linkTypeCatalog(ndb, annotated.map((n) => n.link_type_id))
                : linkTypeCatalogCompact(ndb, annotated.map((n) => n.link_type_id));
            // Bug fix (0.6.3): honest counts come from the domain `countNeighbors`
            // (one SQL per direction — same shape, no LIMIT). Sum them and
            // compare to the trimmed page; `truncated` is per the page size.
            const parentsTotal = countNeighbors(ndb, args.thought_id, 'parents', neighborOpts);
            const childrenTotal = countNeighbors(ndb, args.thought_id, 'children', neighborOpts);
            const total = parentsTotal + childrenTotal;
            return {
              thought: { id: thought.id, title: thought.title },
              dir: args.dir,
              depth: 1,
              neighbors: annotated,
              total,
              truncated: total > annotated.length,
              link_types: linkTypes,
              thought_types: thoughtTypeCatalog(ndb, annotated.map((n) => n.type_id)),
            };
          }
          const rawNeighbors = getNeighbors(ndb, args.thought_id, args.dir, neighborOpts);
          // `FocusNeighbor` carries no visual fields of its own (only `icon`,
          // which is semantic), so the only O12 effect at depth=1 is on the
          // link-type catalogue. Bug fix (§5.1e): sanitize the `icon` itself —
          // it is not gated by `view`, a `data:` URL leaks at depth=1 either way.
          const neighbors = rawNeighbors.map((n) => withSanitizedIcon(n));
          // Edge flags: aggregating on the whole returned set.
          const fillingFlags = getLinkFillingFlags(
            ndb,
            neighbors.map((n) => n.link_id),
          );
          const annotated = neighbors.map((n) => {
            const flags = fillingFlags.get(n.link_id);
            return {
              ...n,
              has_properties: flags?.has_properties ?? false,
              has_comment: flags?.has_comment ?? false,
            };
          });
          const linkTypes =
            view === 'full'
              ? linkTypeCatalog(ndb, annotated.map((n) => n.link_type_id))
              : linkTypeCatalogCompact(ndb, annotated.map((n) => n.link_type_id));
          // Bug fix (0.6.3, thought f2c7c7d3): this tool has no limit/offset
          // of its own and silently applied the domain default page size
          // (50) — a thought with more neighbours than that looked complete,
          // with nothing telling the agent otherwise. `total`/`truncated`
          // give the same honesty `etn.thoughts.query` already has; use
          // `etn.thoughts.query { in_subtree_of, max_depth: 1 }` to page
          // through the rest when `truncated` is true.
          const total = countNeighbors(ndb, args.thought_id, args.dir, neighborOpts);
          return {
            thought: { id: thought.id, title: thought.title },
            dir: args.dir,
            depth: 1,
            neighbors: annotated,
            total,
            truncated: total > annotated.length,
            link_types: linkTypes,
            thought_types: thoughtTypeCatalog(ndb, annotated.map((n) => n.type_id)),
          };
        }
        // `traverse` already supports `direction: "both"` (graph-traversal.ts)
        // — same BFS in both directions, used here for both `dir: "both"`
        // (explicit) and `dir: "siblings"` (legacy remap). For `parents`/
        // `children` we pass the dir as-is.
        const direction = args.dir === 'siblings' ? 'both' : args.dir;
        const walk = traverse(ndb, [args.thought_id], direction, {
          maxDepth: depth,
          maxNodes: rt.limits.maxNodesPerSubgraph,
        });
        // Bug fix (§5.1e): sanitize before the O12 branch so both `view`s drop
        // any inline `data:` icon URL, not just the compact projection.
        const thoughts = resolveThoughts(ndb, walk.ids).map((t) => withSanitizedIcon(t));
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
        'The key RAG tool: the radius-bounded subgraph around seeds — nodes, active edges, `thought_types`/' +
        '`link_types` reference tables, and with `include_comments` per-node comment previews (permanent ' +
        'truncated to 2000 chars, last 10 chronological; fetch full texts via `etn.comments.get` when ' +
        '`truncated`). `max_nodes` is capped by the server setting max_nodes_per_subgraph; `max_chars` ' +
        'caps the JSON size — the server first shrinks comment previews, then drops the farthest nodes ' +
        '(BFS level), reporting `truncated: true` + `reason`. Edges (0.7.2) несут `has_properties`/`has_comment`. ' +
        '`view: "compact"` (default) drops visual fields.',
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
        // Bug fix (§5.1e): sanitize before the O12 branch so `view: 'full'`
        // subgraphs cannot leak inline `data:` icon URLs either.
        const nodes = result.nodes.map((id) => withSanitizedIcon(getThoughtOrThrow(ndb, id)));
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
        // 0.7.2 (requirement 8ab42ea8) — annotate every edge with two presence
        // flags (`has_properties`, `has_comment`) so the agent sees, in one
        // read, which links hold knowledge worth following up. Two aggregating
        // queries on the whole edge set, not one per edge.
        const fillingFlags = getLinkFillingFlags(
          ndb,
          result.edges.map((e) => e.id),
        );
        const edges = result.edges.map((edge) => {
          const flags = fillingFlags.get(edge.id);
          return {
            ...edge,
            has_properties: flags?.has_properties ?? false,
            has_comment: flags?.has_comment ?? false,
          };
        });
        // When the hard `max_nodes` bound fires during traversal, the response is
        // already structurally incomplete — running the budget shrinker on top
        // would only hide that fact behind a softer reason. Surface the
        // `max_nodes` reason verbatim in that case and skip budget trimming.
        const thoughtTypes = thoughtTypeCatalog(ndb, nodes.map((n) => n.type_id));
        const payload: {
          nodes: typeof projectedNodes;
          edges: typeof edges;
          thought_types: typeof thoughtTypes;
          link_types: typeof linkTypes;
          comments?: typeof comments;
        } = {
          nodes: projectedNodes,
          edges,
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

  const LinkGetSchema = z.object({
    network_id: NetworkId,
    link_id: LinkId,
    /**
     * Response projection (task O12, docs/05-mcp-server.md §4.1) — `compact`
     * (default) returns the base link DTO plus its type; `full` (0.7.2) adds
     * the link's property values, the permanent comment (full text, no
     * truncation), a chronological-comment preview (last 10 entries with
     * 2000-char bodies, mirroring `etn.thoughts.subgraph`) and the link's
     * attachments. Use `compact` when only the relationship itself matters;
     * use `full` once an edge's `has_properties`/`has_comment` flag in a
     * `subgraph`/`neighbors` response has flagged it as worth reading.
     */
    view: z.enum(MCP_VIEW_MODES).default('compact'),
  });
  mcp.registerTool(
    'etn.links.get',
    {
      title: 'Связь (с метаданными)',
      description:
        'Fetch one link with its link type (AI-facing description included). `view: "full"` (0.7.2) — ' +
        'дополнительно возвращает `properties`, `permanent` (полный текст), `chrono` (превью, 10 записей), ' +
        '`attachments`. Использовать после `subgraph`/`neighbors` по флагам `has_properties`/`has_comment`.',
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
        const compact = { ...link, type };
        if (args.view === 'compact') {
          return compact;
        }
        // `view: "full"` (0.7.2) — дополняем базовый DTO четырьмя блоками:
        // свойства (резолвнутые `thought_ref`, как в `etn.thoughts.get`),
        // полный постоянный комментарий, превью хронологии по образцу
        // `etn.thoughts.subgraph` (последние 10, обрезка 2000 символов) и
        // вложения. Все четыре функции уже полиморфны по `owner_type` и
        // работают для `'link'` без обёрток.
        const properties = getPropertyValuesResolved(ndb, 'link', link.id);
        const permanent = getPermanentFull(ndb, 'link', link.id);
        const chrono = getCommentsPreview(ndb, 'link', link.id);
        const attachments = listAttachments(ndb, 'link', link.id);
        return { ...compact, properties, permanent, chrono, attachments };
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
        'Comments whose `body_md` carries an explicit ID-based wiki reference `[[#<id>]]` or ' +
        '`[[n:<net>#<id>]]` to this thought. Distinct from `etn.thoughts.mentions` — that one finds implicit ' +
        'text matches by title/synonym via FTS5, this one explicit UUID references. Returns the same ' +
        '`MentionHit[]` shape; the thought\'s own comments are excluded.',
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
        'Thoughts referencing this thought as a `thought_ref` property value (formal links), grouped by the ' +
        'registry property: { total, groups: [{property_id, key, thoughts[]}], thought_types } — one group ' +
        'per network property. `view: "compact"` (default) drops visual fields from each referencing thought.',
      inputSchema: UsageSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.usage'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const rawUsage = findThoughtUsage(ndb, args.thought_id);
        const view: McpViewMode = args.view ?? 'compact';
        // Bug fix (§5.1e): sanitize before the O12 branch so `view: 'full'`
        // cannot leak an inline `data:` icon URL either.
        const usage = {
          total: rawUsage.total,
          groups: rawUsage.groups.map((g) => ({
            property_id: g.property_id,
            key: g.key,
            thoughts: g.thoughts.map((t) => withSanitizedIcon(t)),
          })),
        };
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
          holding_layers: rawUsage.holding_layers,
          thought_types: thoughtTypeCatalog(
            ndb,
            usage.groups.flatMap((g) => g.thoughts.map((t) => t.type_id)),
          ),
        };
      }),
  );

  const DeletionCheckThoughtsSchema = z.object({
    network_id: NetworkId,
    thought_ids: z.array(ThoughtId).min(1).max(200),
  });
  mcp.registerTool(
    'etn.thoughts.deletion_check',
    {
      title: 'Проверка блокировки удаления мысли',
      description:
        'Check what blocks a thought from being physically deleted: use in thought_ref properties, holding ' +
        'layers, and future orphans among its children. Accepts an array; returns a map id → ' +
        '{ blocked, blocking, orphaned_children }. See prompt etn.how_to_purge for the two-phase deletion flow.',
      inputSchema: DeletionCheckThoughtsSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.deletion_check'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const result: Record<string, unknown> = {};
        for (const id of [...new Set(args.thought_ids)]) {
          result[id] = checkThoughtDeletion(ndb, id);
        }
        return result;
      }),
  );

  const DeletionCheckLinksSchema = z.object({
    network_id: NetworkId,
    link_ids: z.array(LinkId).min(1).max(200),
  });
  mcp.registerTool(
    'etn.links.deletion_check',
    {
      title: 'Проверка блокировки удаления связи',
      description:
        'Check what blocks a link from being physically deleted: only holding layers (no thought_ref usage ' +
        'and no children for links). Accepts an array; returns a map id → { blocked, blocking }. ' +
        'See prompt etn.how_to_purge.',
      inputSchema: DeletionCheckLinksSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.links.deletion_check'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const result: Record<string, unknown> = {};
        for (const id of [...new Set(args.link_ids)]) {
          result[id] = checkLinkDeletion(ndb, id);
        }
        return result;
      }),
  );

  const TrashListSchema = z.object({ network_id: NetworkId });
  mcp.registerTool(
    'etn.trash.list',
    {
      title: 'Корзина сети',
      description:
        'The trash of the network: every thought and link with `marked_for_deletion=true`, each with its ' +
        'precomputed blocking check — what is purgeable is visible at once. See prompt etn.how_to_purge.',
      inputSchema: TrashListSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.trash.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        return listTrash(ndb);
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
        'Fetch one comment in full: by `comment_id` — any comment (permanent or chronological) with its ' +
        'complete `body_md`; by `thought_id` — the thought\'s permanent comment, or `{thought_id, permanent: ' +
        'null}` when absent. Use when a preview (`meta.permanent`, `subgraph` comments) reports `truncated: ' +
        'true`.',
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
        'Render the radius-bounded subgraph around seeds as a Markdown (`markdown`, default) or HTML ' +
        'document. `format: "etnx"` is rejected until phase O17.',
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
    /**
     * Which catalogue(s) to return: `"thoughts"` / `"links"` for a single
     * catalogue, `"all"` (default) for both. On large networks the full
     * response (thought types with effective property lists first) can
     * exceed a client response limit and the `link_types` tail never
     * arrives — fetch the link catalogue separately with
     * `scope: "links"`.
     */
    scope: z.enum(TYPES_LIST_SCOPES).optional(),
  });
  mcp.registerTool(
    'etn.types.list',
    {
      title: 'Каталог типов',
      description:
        'Both type catalogues in full — thought and link types with hierarchy (`parent_id`/`is_root`), ' +
        'AI-facing `description` and effective property definitions (own + inherited along the type ' +
        'chain): `key`, `value_type`, `required`, `config` (incl. `options`/`allowed_type_ids`), ' +
        '`default_value`, `inherited`, `defined_on`, `property_id` (the registry id). Call before creating ' +
        'a typed thought/link; also lets `type_id` be replaced by a type name in `etn.thoughts.create`, ' +
        '`etn.links.create` and `etn.thoughts.upsert_bundle`. `in_subtree_of` (+`max_depth`) scopes to the ' +
        'types actually used inside that subtree, each with a `usage_count`. When the response risks being ' +
        'cut off, fetch a single catalogue via `scope: "links"` / `"thoughts"`.',
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
            // Bug fix (§5.1e): `etn.types.list` has no `view` param — always
            // sanitize the inline `data:` icon URL.
            icon: sanitizeIcon(t.icon),
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
        const scope = args.scope ?? 'all';
        return {
          ...(scope === 'thoughts' || scope === 'all' ? { thought_types: thoughtTypes } : {}),
          ...(scope === 'links' || scope === 'all' ? { link_types: linkTypes } : {}),
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
        'Delta feed over the real-time `event_log` for long-lived agents with their own cache: events ' +
        'with `seq > since_seq`, ascending, capped at `limit` (default 1000); `cursor` echoes the retained ' +
        'window. `audience: "user"` events are filtered to the caller\'s own; the delta respects the ' +
        'caller\'s session layer. `truncated: true` — `since_seq` predates the retained window or the ' +
        'session\'s last layer switch: do a full resync (`etn.thoughts.search` + `etn.thoughts.get`) ' +
        'before resuming. Each entry carries `layer_id`.',
      inputSchema: ChangesListSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.changes.list'],
    },
    (args) =>
      runTool(async () => {
        const network = rt.deps.systemDb.getNetworkById(args.network_id);
        if (network === null) {
          throw new EtnError('NOT_FOUND', `Network ${args.network_id} not found.`);
        }
        assertNetworkAccess(rt, args.network_id);

        const limit = args.limit ?? DEFAULT_CHANGES_LIMIT;
        const minSeq = rt.deps.systemDb.getMinEventSeq(args.network_id);
        const maxSeq = rt.deps.systemDb.getMaxEventSeq(args.network_id);
        const events = rt.deps.systemDb.readEventsAfter(
          args.network_id,
          args.since_seq,
          limit,
        );
        const authUserId = rt.deps.auth.userId;

        // Task S10 (13-layers.md §12): the delta must respect the caller's
        // session layer, same as the WebSocket gateway — keyed by the calling
        // API key ({@link mcpLayerClientId}), the same coordinate every other
        // read/write tool now resolves through `openMemberNetwork`.
        const baseNdb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger);
        const clientId = mcpLayerClientId(rt);
        const sessionLayer = resolveSessionLayer(baseNdb, authUserId, clientId);
        const switchedAtSeq = resolveSessionSwitchSeq(baseNdb, authUserId, clientId);
        const layerNdb =
          sessionLayer.id === baseNdb.layerId
            ? baseNdb
            : openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger, sessionLayer.id);

        const filtered: McpChangeEntry[] = events
          .filter((e) => e.audience === 'network' || e.actor.user_id === authUserId)
          .filter((e) => e.audience === 'user' || isEventVisibleInLayer(layerNdb, e, sessionLayer.id))
          .map((e) => ({
            type: e.type,
            seq: e.seq,
            ts: e.ts,
            data: e.data,
            audience: e.audience,
            layer_id: e.layer_id,
          }));
        // `truncated` fires when an explicit (non-zero) `since_seq` is either
        // older than the first retained row, or older than this session's
        // last layer switch (`switched_at_seq`, migration 028 — a delta
        // spanning a switch mixes two different layers' visibility filters,
        // 13-layers.md §12). A zero `since_seq` ("from the start") is never
        // truncated by either check; an empty buffer is not truncated by the
        // window check — nothing was lost.
        const truncated =
          args.since_seq !== 0 &&
          ((minSeq !== null && args.since_seq < minSeq - 1) ||
            (switchedAtSeq > 0 && args.since_seq < switchedAtSeq));

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
        'Per-thought read counters collected by the MCP read tools. `kind: "top"` (default) — most-read ' +
        'thoughts (`reads_count DESC, last_read_at DESC`); `kind: "cold"` — never read, or (with `since`) ' +
        'not read since the cutoff, ordered `updated_at DESC` so the freshest un-touched nodes come first. ' +
        'Counted by `etn.thoughts.get`, `subgraph`, `query`, `search` and `etn.networks.structure`.',
      inputSchema: MetricsReadsSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.metrics.reads'],
    },
    (args) =>
      runTool(async () => {
        const network = rt.deps.systemDb.getNetworkById(args.network_id);
        if (network === null) {
          throw new EtnError('NOT_FOUND', `Network ${args.network_id} not found.`);
        }
        assertNetworkAccess(rt, args.network_id);
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

  // etn.metrics.tools — 940a499d read tool (операция 254ba4db). Aggregate over
  // the `_system.db` table `mcp_tool_call_metrics` written by the shared
  // registration wrapper (`mcp/server.ts`): how often each tool is called and
  // how often it errors. The evidence base for roster decisions — a tool with
  // `calls_count = 0` over a period is a removal candidate, one with
  // `errors_count / calls_count > 0.5` has an unclear contract/description.
  // Admin sees every row; a regular member sees only the rows of their own
  // networks plus their own network-less calls.
  const MetricsToolsSchema = z.object({
    network_id: NetworkId.optional(),
    from_ms: z.number().int().nonnegative().optional(),
    to_ms: z.number().int().nonnegative().optional(),
    group_by: z.enum(['tool', 'tool+network', 'tool+key']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  });
  mcp.registerTool(
    'etn.metrics.tools',
    {
      title: 'Телеметрия вызовов инструментов',
      description:
        'Aggregate call counters per MCP tool (successes and errors) from `mcp_tool_call_metrics`. ' +
        '`group_by`: "tool" (default) | "tool+network" | "tool+key"; `from_ms`/`to_ms` bound `last_call_at` ' +
        '(the table is an aggregate — the window bounds the observed interval). Ordered by `calls_count ' +
        'DESC`; `limit` default 50, max 200. The owner (admin) sees everything; a regular member sees ' +
        'only the rows of their own networks plus their own network-less calls. Verdicts: `calls_count = 0` ' +
        'over a period — removal candidate; `errors_count / calls_count > 0.5` — unclear tool, revise its ' +
        'contract/description.',
      inputSchema: MetricsToolsSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.metrics.tools'],
    },
    (args) =>
      runTool(async () => {
        if (args.network_id !== undefined) {
          assertNetworkAccess(rt, args.network_id);
        }
        const groupBy = args.group_by ?? 'tool';
        const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
        const isAdmin = rt.deps.auth.isAdmin;
        const items = rt.deps.systemDb.aggregateToolCallMetrics({
          groupBy,
          networkId: args.network_id,
          fromMs: args.from_ms,
          toMs: args.to_ms,
          limit,
          visibleNetworks: isAdmin ? null : rt.deps.systemDb.listMemberNetworkIds(rt.deps.auth.userId),
          visibleKeyIds: isAdmin ? [] : rt.deps.systemDb.listApiKeyIdsByUser(rt.deps.auth.userId),
        });
        return { group_by: groupBy, limit, items } satisfies McpMetricsToolsResult;
      }),
  );

  // etn.layers.list — S10 read tool, paritet with REST `GET .../layers`
  // (03-server-api.md §5a, 13-layers.md §10.1). Runs on the base-layer
  // connection: `layers`/`session_layers` are not branchable (§3), and the
  // session's own current layer id must be resolved independently of which
  // layer the list itself is read from.
  const LayersListSchema = z.object({
    network_id: NetworkId,
    include_service: z.boolean().optional(),
  });
  mcp.registerTool(
    'etn.layers.list',
    {
      title: 'Список слоёв',
      description:
        'All layers of the network with hierarchy metadata: id, parent_id, title, comment, git_branch, ' +
        'depth, children_count (the DELETE cascade confirmation) and `current` — true on the calling key\'s ' +
        'own session layer. Service (reserve) layers are hidden unless `include_service: true`.',
      inputSchema: LayersListSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const current = resolveRuntimeLayer(rt, args.network_id);
        return listLayers(ndb, { includeService: args.include_service, currentLayerId: current.id });
      }),
  );

  // etn.layers.diff / etn.layers.diff_doc — S11 read tools, the two views of
  // «чем слой отличается» (13-layers.md §10.3, §15): the structural link
  // diff and the deterministic textual documents. Both read on two
  // connections — the layer's own context and its parent's.
  const LayersDiffSchema = z.object({
    network_id: NetworkId,
    layer_id: LayerId,
  });
  mcp.registerTool(
    'etn.layers.diff',
    {
      title: 'Структурное отличие слоя',
      description:
        'Structural diff of a layer against its parent: `links` — added/removed/type_changed/reparented ' +
        '(1:1 swaps of the parent link)/reorder_collapsed (position-only batches); `overridden` — the ids ' +
        'physically present in the layer (shadow rows, inserts and tombstones). The textual diff ' +
        '(`etn.layers.diff_doc`) is blind to all of these — use both.',
      inputSchema: LayersDiffSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.diff'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const { layer, target } = resolveDiffTarget(ndb, args.layer_id);
        const layerNdb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger, layer.id);
        const targetNdb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger, target.id);
        return structuralLayerDiff(layerNdb, targetNdb, layer, target);
      }),
  );
  mcp.registerTool(
    'etn.layers.diff_doc',
    {
      title: 'Содержательное отличие слоя (документы)',
      description:
        'Textual diff payload of a layer against its parent: two deterministically assembled markdown ' +
        'documents (`layer_doc`/`target_doc`) for a plain line-by-line comparison (all visible thoughts ' +
        'ordered by id).',
      inputSchema: LayersDiffSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.diff_doc'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const { layer, target } = resolveDiffTarget(ndb, args.layer_id);
        const layerNdb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger, layer.id);
        const targetNdb = openNetworkDb(rt.deps.dataDir, args.network_id, rt.deps.logger, target.id);
        return layerDiffDoc(layerNdb, targetNdb, layer, target);
      }),
  );

  // =========================================================================
  // `etn.chronicle.query` (задача 6d45ab37, спека 52767bdf, P1-паритет
  // MCP↔REST `POST /chronicle/query`). Прокси над domain
  // `parseChronicleQueryBody` + `queryChronicle` с резолвом имён типов.
  // =========================================================================

  // Объединённая схема — повторяет ключи REST `POST /chronicle/query`
  // (docs/03-server-api.md §20). Имена типов и имён свойств резолвятся
  // хелперами ниже, как в `etn.thoughts.query`/`search` (задача d5ab1630).
  const ChronicleQuerySchema = z.object({
    network_id: NetworkId,
    keywords: z.string().optional(),
    thought_ids: z.array(ThoughtId).optional(),
    include_subtree: z.boolean().optional(),
    // `type`/`type_id` XOR (задача 77351f03).
    type: z.string().min(1).optional(),
    type_id: z.array(ThoughtId).optional(),
    // `link_type`/`link_type_id` XOR.
    link_type: z.string().min(1).optional(),
    link_type_id: z.array(ThoughtId).optional(),
    link_scope: z.enum(['sources', 'targets', 'both']).optional(),
    date_from: z.string().min(1).optional(),
    date_to: z.string().min(1).optional(),
    order: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional(),
  });
  mcp.registerTool(
    'etn.chronicle.query',
    {
      title: 'Запрос хроники',
      description:
        'Двухфазный запрос хроники (паритет `POST /chronicle/query`): фаза 1 — мысли по ' +
        '`keywords`/`thought_ids`/`include_subtree`/`type[]`; фаза 2 — хроно-комментарии к ним ' +
        'или их связям с фильтрами `link_type[]`/`link_scope`/`date_from/to`. `{ rows[], meta }`.',
      inputSchema: ChronicleQuerySchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.chronicle.query'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        // Резолв имён типов в id (задача d5ab1630 + 77351f03).
        const typeIds = args.type === undefined
          ? args.type_id
          : (Array.isArray(args.type_id) ? args.type_id : []).concat([
              resolveThoughtTypeIdByName(ndb, args.type),
            ]);
        const linkTypeIds = args.link_type === undefined
          ? args.link_type_id
          : (Array.isArray(args.link_type_id) ? args.link_type_id : []).concat([
              resolveLinkTypeIdByName(ndb, args.link_type),
            ]);
        // Сборка тела запроса под domain `parseChronicleQueryBody` —
        // повторяет ключи REST с минимальной правкой имён.
        const body: Record<string, unknown> = {};
        if (args.keywords !== undefined) body.keywords = args.keywords;
        if (args.thought_ids !== undefined) body.thought_ids = args.thought_ids;
        if (args.include_subtree !== undefined) body.include_subtree = args.include_subtree;
        if (typeIds !== undefined) body.type_ids = typeIds;
        if (linkTypeIds !== undefined) body.link_type_ids = linkTypeIds;
        if (args.link_scope !== undefined) body.link_scope = args.link_scope;
        if (args.date_from !== undefined) body.date_from = args.date_from;
        if (args.date_to !== undefined) body.date_to = args.date_to;
        if (args.order !== undefined) body.order = args.order;
        if (args.limit !== undefined) body.limit = args.limit;
        if (args.offset !== undefined) body.offset = args.offset;
        const request = parseChronicleQueryBody(body, '');
        const result = queryChronicle(ndb, request);
        return {
          rows: result.rows,
          meta: { total: result.total, offset: request.offset, limit: request.limit },
        };
      }),
  );

  // =========================================================================
  // `etn.members.list` (задача 6d45ab37, спека 6cccac39, P1-паритет MCP↔REST
  // `GET /networks/{id}/members`). Доступ — участники сети или глобальный
  // админ (проверка уже в `openMemberNetwork`).
  // =========================================================================
  const MembersListSchema = z.object({ network_id: NetworkId });
  mcp.registerTool(
    'etn.members.list',
    {
      title: 'Участники сети',
      description:
        'Список участников сети (user_id, display_name, role, joined_at). Паритет ' +
        'с `GET /networks/{id}/members`. Доступ — участники или глобальный админ.',
      inputSchema: MembersListSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.members.list'],
    },
    (args) =>
      runTool(async () => {
        // openMemberNetwork сам бросает FORBIDDEN, если ключ не привязан к сети.
        openMemberNetwork(rt, args.network_id);
        const rows = rt.deps.systemDb.listNetworkMembers(args.network_id);
        return {
          members: rows.map((r) => ({
            user_id: r.user_id,
            display_name: r.display_name,
            role: r.role,
            joined_at: r.added_at,
          })),
        };
      }),
  );

  // =========================================================================
  // Mutating tools (§4.2) — domain services + real-time events + audit log
  // =========================================================================

  // ---- Layers (task S10, 13-layers.md §10.2) — paritet with REST §5a -------
  // All five run on the base-layer connection (`layers`/`session_layers` are
  // not branchable, §3), mirroring `routes/layers.ts` line for line.

  const LayersCreateSchema = z.object({
    network_id: NetworkId,
    title: z.string().min(1),
    /** Defaults to the calling key's current session layer (§2.3). */
    parent_id: LayerId.optional(),
    comment: z.string().nullable().optional(),
    git_branch: z.string().nullable().optional(),
  });
  mcp.registerTool(
    'etn.layers.create',
    {
      title: 'Создать слой',
      description:
        'Create a layer under the given parent — defaults to the calling key\'s current session layer. ' +
        '`comment` is strongly encouraged: it is how the next agent understands the layer\'s purpose. ' +
        'Depth is capped at 4 ordinary layers above the base. Does not switch the session — call ' +
        '`etn.layers.select` for that.',
      inputSchema: LayersCreateSchema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetworkBase(rt, args.network_id);
        // Resolve the session layer once and reuse it both as the implicit
        // parent (§2.3) and as the `current` reference for the response:
        // creating a layer is not the same as switching to it (fix for
        // error 9b159e7a — created.current was always `true`).
        const sessionLayer = resolveRuntimeLayer(rt, args.network_id);
        const parent = args.parent_id ?? sessionLayer.id;
        const layer = createLayer(ndb, {
          parentId: parent,
          title: args.title,
          comment: args.comment ?? null,
          gitBranch: args.git_branch ?? null,
          createdBy: rt.deps.auth.userId,
        });
        // Journal row, mirroring the REST POST /layers route: the snapshot
        // layer is the calling key's session layer (creating does not switch).
        recordLayerActivity(ndb, {
          networkId: args.network_id,
          userId: rt.deps.auth.userId,
          action: 'created',
          layer,
          layerId: sessionLayer.id,
        });
        auditAgentCall(rt, 'etn.layers.create', args.network_id, 'layer', layer.id, {
          title: args.title,
          parent_id: parent,
        });
        return { ...layer, current: layer.id === sessionLayer.id, request_id: String(extra.requestId) };
      }),
  );

  const LayersUpdateSchema = z.object({
    network_id: NetworkId,
    layer_id: LayerId,
    title: z.string().min(1).optional(),
    comment: z.string().nullable().optional(),
    expected_version: ExpectedVersion,
  });
  mcp.registerTool(
    'etn.layers.update',
    {
      title: 'Переименовать слой / изменить комментарий',
      description:
        'Rename a layer and/or edit its comment. The base layer\'s title is fixed («Основа») — renaming it ' +
        'is a VALIDATION_ERROR; editing its comment is allowed. `expected_version` — the usual optimistic ' +
        'lock (409 VERSION_CONFLICT on mismatch).',
      inputSchema: LayersUpdateSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.update'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        if (args.title === undefined && args.comment === undefined) {
          throw new EtnError(
            'VALIDATION_ERROR',
            'нечего менять: передайте title и/или comment.',
            { fields: ['title', 'comment'] },
          );
        }
        const ndb = openMemberNetworkBase(rt, args.network_id);
        // Renaming/editing a layer does not switch the session: `current`
        // reflects the calling key's real session layer, not the edited
        // layer (same pattern as the createLayer fix 9b159e7a).
        const sessionLayer = resolveRuntimeLayer(rt, args.network_id);
        const layer = updateLayer(
          ndb,
          args.layer_id,
          {
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.comment !== undefined ? { comment: args.comment } : {}),
          },
          args.expected_version,
          rt.deps.auth.userId,
        );
        // Journal row, mirroring the REST PATCH /layers/:id route: the
        // snapshot layer is the session layer (renaming does not switch).
        recordLayerActivity(ndb, {
          networkId: args.network_id,
          userId: rt.deps.auth.userId,
          action: 'updated',
          layer,
          layerId: sessionLayer.id,
        });
        auditAgentCall(rt, 'etn.layers.update', args.network_id, 'layer', layer.id, {
          title: args.title,
          comment: args.comment,
        });
        return { ...layer, current: layer.id === sessionLayer.id, request_id: String(extra.requestId) };
      }),
  );

  const LayersDeleteSchema = z.object({
    network_id: NetworkId,
    layer_id: LayerId,
    /** Required confirmation once the layer has descendants (§2.4) — the
     * `children_count` the agent just read from `etn.layers.list`. */
    cascade: z.number().int().min(0).optional(),
  });
  mcp.registerTool(
    'etn.layers.delete',
    {
      title: 'Удалить слой',
      description:
        'Delete a layer together with its whole descendant subtree. A layer with descendants requires ' +
        '`cascade` to echo `children_count` from `etn.layers.list` (mismatch → 409, missing with living ' +
        'descendants → 422 with the actual count). Physically removes every shadow row and tombstone of ' +
        'the subtree (nothing is transferred to the parent) and auto-purges the trash. The base layer ' +
        'cannot be deleted.',
      inputSchema: LayersDeleteSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.delete'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        // Close the doomed layers' pooled connections first (mirrors the REST
        // route): their temp `layer_chain` would otherwise keep referencing
        // deleted layers.
        const ndb = openMemberNetworkBase(rt, args.network_id);
        // Snapshot of the doomed layer BEFORE the cascade deletes its row —
        // it goes to the journal (mirrors the REST DELETE /layers/:id route),
        // and the parent id says where the subtree sessions were re-pointed.
        const parentRow = ndb
          .prepare('SELECT parent_id, title FROM layers WHERE id = ?')
          .get(args.layer_id) as { parent_id: string | null; title: string } | undefined;
        const subtreeIds = layerSubtreeIds(ndb, args.layer_id);
        for (const id of subtreeIds) {
          if (id !== BASE_LAYER_ID) {
            closeNetworkDb(args.network_id, id);
          }
        }
        const switchedAtSeq = rt.deps.systemDb.getMaxEventSeq(args.network_id) ?? 0;
        const result = deleteLayerWithEvents(ndb, args.layer_id, args.cascade, switchedAtSeq);
        // Per-row realtime events of the trash auto-purge — journaled rows
        // are intentionally absent for them: the REST DELETE /layers/:id
        // route records only the layer's own row (parity).
        for (const id of result.deleted_thought_ids) {
          emitAgentEvent(rt, args.network_id, 'thought.deleted', { id }, extra.requestId);
        }
        for (const id of result.deleted_link_ids) {
          emitAgentEvent(rt, args.network_id, 'link.deleted', { id }, extra.requestId);
        }
        if (parentRow) {
          // Journal snapshot layer — where the deleted subtree's sessions were
          // re-pointed (same choice as the REST route, 13-layers.md §2.4).
          recordLayerActivity(ndb, {
            networkId: args.network_id,
            userId: rt.deps.auth.userId,
            action: 'deleted',
            layer: { id: args.layer_id, title: parentRow.title },
            layerId: parentRow.parent_id ?? BASE_LAYER_ID,
          });
        }
        auditAgentCall(rt, 'etn.layers.delete', args.network_id, 'layer', args.layer_id, {
          cascade: args.cascade,
          deleted: result.deleted,
        });
        return {
          deleted: result.deleted,
          purged: result.purged,
          skipped: result.skipped,
          request_id: String(extra.requestId),
        };
      }),
  );

  const LayersSelectSchema = z.object({
    network_id: NetworkId,
    layer_id: LayerId,
  });
  mcp.registerTool(
    'etn.layers.select',
    {
      title: 'Переключить текущий слой',
      description:
        'Switch the calling API key\'s current session layer: every later call of this key — reads and ' +
        'writes alike — runs in the new layer\'s context. A service (reserve) layer cannot be selected; ' +
        'selecting the current layer again is a no-op. `etn.changes.list` forces a full resync once ' +
        '`since_seq` predates this switch.',
      inputSchema: LayersSelectSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.select'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const switchedAtSeq = rt.deps.systemDb.getMaxEventSeq(args.network_id) ?? 0;
        const layer = setSessionLayer(
          ndb,
          rt.deps.auth.userId,
          mcpLayerClientId(rt),
          args.layer_id,
          switchedAtSeq,
        );
        // No activity_log row: switching the session does not change the
        // layer entity itself — the REST `/select` route does not journal it
        // either (требование b0c7a57c covers entity mutations only).
        auditAgentCall(rt, 'etn.layers.select', args.network_id, 'layer', layer.id, {});
        return { ...layer, request_id: String(extra.requestId) };
      }),
  );

  const LayersMergeSchema = z.object({
    network_id: NetworkId,
    layer_id: LayerId,
    /** Closed subset `{ table: [logical row ids…] }` — omit for a full merge. */
    tables: z.record(z.string(), z.array(z.string().min(1))).optional(),
  });
  mcp.registerTool(
    'etn.layers.merge',
    {
      title: 'Слить слой в родителя',
      description:
        'Merge a layer into its parent — full (default) or a closed partial subset `tables: { <branchable ' +
        'table>: [row ids…] }`. A replay conflict or an unclosed partial selection rejects the WHOLE ' +
        'operation with VALIDATION_ERROR (`conflicts`/`missing_closure`) — no partial application. Returns ' +
        '{ applied, skipped, reorder_collapsed, reserve_layer_id (auto-created pre-merge state for manual ' +
        'rollback), purged }. See prompt etn.how_to_merge_partial.',
      inputSchema: LayersMergeSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.layers.merge'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        let selection: MergeSelection | undefined;
        if (args.tables !== undefined) {
          selection = {};
          for (const [table, ids] of Object.entries(args.tables)) {
            if (!(BRANCHABLE_TABLES as readonly string[]).includes(table)) {
              throw new EtnError(
                'VALIDATION_ERROR',
                `неизвестная ветвимая таблица «${table}».`,
                { field: 'tables', table, allowed: BRANCHABLE_TABLES },
              );
            }
            selection[table as BranchableTable] = ids;
          }
        }
        const ndb = openMemberNetworkBase(rt, args.network_id);
        const result = mergeLayer(ndb, args.layer_id, selection, rt.deps.auth.userId);

        // No own activity_log row for the merge — parity with the REST merge
        // route: mergeLayer already rolled the layer's journal rows up into
        // the base (autoRollupLayerActivity, задача 6bcccd2b), and REST does
        // not record a separate `layer` row for the merge operation itself.

        // Exactly one `layer.merged` event per merge (04-realtime.md §11.4),
        // attributed to the merge target — not the agent's session layer.
        const report: LayerMergeReport = {
          applied: result.applied,
          skipped: result.skipped,
          reorder_collapsed: result.reorder_collapsed,
          reserve_layer_id: result.reserve_layer_id,
          purged: result.purged,
          activity_rollup: result.activity_rollup,
        };
        emitAgentEvent(
          rt,
          args.network_id,
          'layer.merged',
          { ...report, layer: result.merged_layer, target_layer: result.target_layer },
          extra.requestId,
          result.target_layer.id,
        );
        // The trash auto-purge victims are ordinary deletions outside the
        // merge row set — realtime only, no journal rows (as the REST merge
        // route; the journal side of the merge is the auto-rollup above).
        for (const id of result.deleted_thought_ids) {
          emitAgentEvent(rt, args.network_id, 'thought.deleted', { id }, extra.requestId);
        }
        for (const id of result.deleted_link_ids) {
          emitAgentEvent(rt, args.network_id, 'link.deleted', { id }, extra.requestId);
        }
        auditAgentCall(rt, 'etn.layers.merge', args.network_id, 'layer', args.layer_id, {
          tables: args.tables,
          applied: report.applied,
        });
        return { ...report, request_id: String(extra.requestId) };
      }),
  );

  // =========================================================================
  // `etn.thoughts.bulk_update` (задача 6d45ab37, спека 77502d93, P1-паритет
  // MCP↔REST `POST /thoughts/batch`). Групповые операции над мыслями —
  // одна запись бюджета на ВЕСЬ вызов; `failures[]` для отдельных id.
  // Не включает `purge`/`delete` — это отдельный цикл работ (S13).
  // =========================================================================

  // Типы операций — в точности подмножество REST `ThoughtBatchOp`
  // (shared/src/types/thought.ts), без `delete`/`purge`/`link_to_focus`/
  // `unlink_from_focus` (последние два не нужны MCP-агенту: для единичной
  // связи есть `etn.links.create`/`etn.links.delete`).
  const BULK_UPDATE_OPS = [
    'set_type',
    'clear_type',
    'set_active',
    'set_inactive',
    'trash',
    'link_parents',
    'link_children',
    'set_only_parents',
    'unlink_parents',
    'unlink_children',
  ] as const;

  /**
   * Разбор `args` для `etn.thoughts.bulk_update`. Возвращает нормализованный
   * объект подмножества `ThoughtBatchArgs`, пригодный для вызова
   * доменного/роутного кода. Используется в фасаде и тестах.
   *
   * XOR-пары (`type`/`type_id`, `link_type`/`link_type_id`) уже отсечены
   * схемой Zod — здесь только нормализация резолва имён в id.
   */
  function normalizeBulkUpdateArgs(
    ndb: NetworkDb,
    op: (typeof BULK_UPDATE_OPS)[number],
    args: {
      type?: string;
      type_id?: string | null;
      parent_ids?: string[];
      child_ids?: string[];
      link_type?: string;
      link_type_id?: string | null;
    },
  ): {
    type_id: string | null | undefined;
    parent_ids: string[] | undefined;
    child_ids: string[] | undefined;
    link_type_id: string | null | undefined;
  } {
    const out: {
      type_id: string | null | undefined;
      parent_ids: string[] | undefined;
      child_ids: string[] | undefined;
      link_type_id: string | null | undefined;
    } = {
      type_id: undefined,
      parent_ids: undefined,
      child_ids: undefined,
      link_type_id: undefined,
    };
    if (op === 'set_type') {
      out.type_id = args.type === undefined ? args.type_id : resolveThoughtTypeIdByName(ndb, args.type);
    }
    if (op === 'link_parents' || op === 'set_only_parents' || op === 'unlink_parents') {
      out.parent_ids = args.parent_ids;
    }
    if (op === 'link_children' || op === 'unlink_children') {
      out.child_ids = args.child_ids;
    }
    if (op === 'link_parents' || op === 'link_children' || op === 'set_only_parents') {
      out.link_type_id = args.link_type === undefined ? args.link_type_id : resolveLinkTypeIdByName(ndb, args.link_type);
    }
    return out;
  }

  // Аргументы массовых операций: минимальный, жёсткий контракт.
  // Запрещаем смешение `type`/`type_id`, `link_type`/`link_type_id` —
  // схемой `.refine()` (задача 77351f03).
  const BulkUpdateArgs = z
    .object({
      // set_type
      type: z.string().min(1).optional(),
      type_id: z.string().min(1).nullable().optional(),
      // link_parents / set_only_parents / unlink_parents
      parent_ids: z.array(ThoughtId).min(1).optional(),
      // link_children / unlink_children
      child_ids: z.array(ThoughtId).min(1).optional(),
      // link_parents / link_children / set_only_parents
      link_type: z.string().min(1).optional(),
      link_type_id: z.string().min(1).nullable().optional(),
    })
    .refine((v) => v.type === undefined || v.type_id === undefined, {
      message: TYPE_ID_TYPE_CONFLICT,
    })
    .refine((v) => v.link_type === undefined || v.link_type_id === undefined, {
      message: 'provide at most one of link_type_id or link_type',
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'args must not be empty when provided' })
    .optional();

  const BulkUpdateSchema = z.object({
    network_id: NetworkId,
    ids: z.array(ThoughtId).min(1),
    op: z.enum(BULK_UPDATE_OPS),
    args: BulkUpdateArgs,
  });
  mcp.registerTool(
    'etn.thoughts.bulk_update',
    {
      title: 'Групповые операции над мыслями',
      description:
        'Групповые операции (одна запись бюджета на ВЕСЬ вызов): `op` ∈ {`set_type`,`clear_type`,' +
        '`set_active`,`set_inactive`,`trash`,`link_parents`,`link_children`,`set_only_parents`,' +
        '`unlink_parents`,`unlink_children`}. Возвращает `{ affected, failures[] }`. Без `purge`/`delete`.',
      inputSchema: BulkUpdateSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.bulk_update'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const userId = rt.deps.auth.userId;
        const layerId = resolveRuntimeLayer(rt, args.network_id).id;
        const normalized = normalizeBulkUpdateArgs(
          ndb,
          args.op,
          args.args ?? {},
        );
        const ids = [...new Set(args.ids)];
        const failures: Array<{ id: string; code: string; message: string }> = [];
        let affected = 0;
        for (const id of ids) {
          try {
            switch (args.op) {
              case 'set_type': {
                const updated = updateThought(
                  ndb,
                  id,
                  { type_id: normalized.type_id ?? null },
                  undefined,
                  userId,
                );
                emitAgentEvent(rt, args.network_id, 'thought.updated', {
                  id,
                  changes: { type_id: normalized.type_id ?? null },
                  version: updated.version,
                }, extra.requestId, layerId);
                recordThoughtActivity(ndb, {
                  networkId: args.network_id,
                  userId,
                  action: 'updated',
                  thought: updated,
                  layerId,
                });
                break;
              }
              case 'clear_type': {
                const updated = updateThought(ndb, id, { type_id: null }, undefined, userId);
                emitAgentEvent(rt, args.network_id, 'thought.updated', {
                  id,
                  changes: { type_id: null },
                  version: updated.version,
                }, extra.requestId, layerId);
                recordThoughtActivity(ndb, {
                  networkId: args.network_id,
                  userId,
                  action: 'updated',
                  thought: updated,
                  layerId,
                });
                break;
              }
              case 'set_active': {
                const updated = updateThought(ndb, id, { active: true }, undefined, userId);
                emitAgentEvent(rt, args.network_id, 'thought.updated', {
                  id,
                  changes: { active: true },
                  version: updated.version,
                }, extra.requestId, layerId);
                recordThoughtActivity(ndb, {
                  networkId: args.network_id,
                  userId,
                  action: 'updated',
                  thought: updated,
                  layerId,
                });
                break;
              }
              case 'set_inactive': {
                const updated = updateThought(ndb, id, { active: false }, undefined, userId);
                emitAgentEvent(rt, args.network_id, 'thought.updated', {
                  id,
                  changes: { active: false },
                  version: updated.version,
                }, extra.requestId, layerId);
                recordThoughtActivity(ndb, {
                  networkId: args.network_id,
                  userId,
                  action: 'updated',
                  thought: updated,
                  layerId,
                });
                break;
              }
              case 'trash': {
                const updated = updateThought(
                  ndb,
                  id,
                  { marked_for_deletion: true },
                  undefined,
                  userId,
                );
                emitAgentEvent(rt, args.network_id, 'thought.updated', {
                  id,
                  changes: { marked_for_deletion: true },
                  version: updated.version,
                }, extra.requestId, layerId);
                recordThoughtActivity(ndb, {
                  networkId: args.network_id,
                  userId,
                  action: 'trashed',
                  thought: updated,
                  layerId,
                });
                break;
              }
              case 'link_parents': {
                for (const parentId of normalized.parent_ids ?? []) {
                  if (parentId === id) continue;
                  if (findLinksBetween(ndb, parentId, id).length > 0) continue;
                  const link = createLink(
                    ndb,
                    {
                      source_id: parentId,
                      target_id: id,
                      type_id: normalized.link_type_id ?? null,
                    },
                    userId,
                  );
                  emitAgentEvent(rt, args.network_id, 'link.created', { link }, extra.requestId, layerId);
                  recordLinkActivity(ndb, {
                    networkId: args.network_id,
                    userId,
                    action: 'created',
                    link,
                    layerId,
                  });
                }
                break;
              }
              case 'link_children': {
                for (const childId of normalized.child_ids ?? []) {
                  if (childId === id) continue;
                  if (findLinksBetween(ndb, id, childId).length > 0) continue;
                  const link = createLink(
                    ndb,
                    {
                      source_id: id,
                      target_id: childId,
                      type_id: normalized.link_type_id ?? null,
                    },
                    userId,
                  );
                  emitAgentEvent(rt, args.network_id, 'link.created', { link }, extra.requestId, layerId);
                  recordLinkActivity(ndb, {
                    networkId: args.network_id,
                    userId,
                    action: 'created',
                    link,
                    layerId,
                  });
                }
                break;
              }
              case 'set_only_parents': {
                const wanted = new Set(normalized.parent_ids ?? []);
                const existing = ndb
                  .prepare(
                    'SELECT id, type_id FROM links_v WHERE target_id = ? AND active = 1',
                  )
                  .all(id) as Array<{ id: string; type_id: string | null }>;
                for (const link of existing) {
                  if (!wanted.has(link.id)) continue;
                  // Тут сравнение id'ов линков, а не пары (source,target) —
                  // оставляем существующую линку на месте.
                  void link;
                }
                // Drop parents not in the wanted set.
                for (const link of existing) {
                  const sourceRow = ndb
                    .prepare('SELECT source_id FROM links_v WHERE id = ?')
                    .get(link.id) as { source_id: string } | undefined;
                  if (sourceRow === undefined) continue;
                  if (!wanted.has(sourceRow.source_id)) {
                    deleteLink(ndb, link.id, undefined);
                    emitAgentEvent(rt, args.network_id, 'link.deleted', { id: link.id }, extra.requestId, layerId);
                  }
                }
                // Add missing parents.
                for (const parentId of normalized.parent_ids ?? []) {
                  if (parentId === id) continue;
                  if (findLinksBetween(ndb, parentId, id).length > 0) continue;
                  const link = createLink(
                    ndb,
                    {
                      source_id: parentId,
                      target_id: id,
                      type_id: normalized.link_type_id ?? null,
                    },
                    userId,
                  );
                  emitAgentEvent(rt, args.network_id, 'link.created', { link }, extra.requestId, layerId);
                  recordLinkActivity(ndb, {
                    networkId: args.network_id,
                    userId,
                    action: 'created',
                    link,
                    layerId,
                  });
                }
                break;
              }
              case 'unlink_parents': {
                const wanted = new Set(normalized.parent_ids ?? []);
                const existing = ndb
                  .prepare(
                    'SELECT l.id, l.source_id FROM links_v l WHERE l.target_id = ? AND l.active = 1',
                  )
                  .all(id) as Array<{ id: string; source_id: string }>;
                for (const link of existing) {
                  if (!wanted.has(link.source_id)) continue;
                  deleteLink(ndb, link.id, undefined);
                  emitAgentEvent(rt, args.network_id, 'link.deleted', { id: link.id }, extra.requestId, layerId);
                  recordLinkActivity(ndb, {
                    networkId: args.network_id,
                    userId,
                    action: 'deleted',
                    link: { id: link.id, source_id: link.source_id, target_id: id, type_id: null },
                    layerId,
                  });
                }
                break;
              }
              case 'unlink_children': {
                const wanted = new Set(normalized.child_ids ?? []);
                const existing = ndb
                  .prepare(
                    'SELECT l.id, l.target_id FROM links_v l WHERE l.source_id = ? AND l.active = 1',
                  )
                  .all(id) as Array<{ id: string; target_id: string }>;
                for (const link of existing) {
                  if (!wanted.has(link.target_id)) continue;
                  deleteLink(ndb, link.id, undefined);
                  emitAgentEvent(rt, args.network_id, 'link.deleted', { id: link.id }, extra.requestId, layerId);
                  recordLinkActivity(ndb, {
                    networkId: args.network_id,
                    userId,
                    action: 'deleted',
                    link: { id: link.id, source_id: id, target_id: link.target_id, type_id: null },
                    layerId,
                  });
                }
                break;
              }
            }
            affected += 1;
          } catch (err) {
            const code = err instanceof EtnError ? err.code : 'INTERNAL';
            const message =
              err instanceof Error ? err.message : 'bulk update failed';
            failures.push({ id, code, message });
          }
        }
        // Per-id real-time event + activity row уже отправлены внутри цикла;
        // здесь оставляем только аудит вызова (одна запись на КАЖДЫЙ вызов,
        // независимо от числа id — контракт бюджета 0ff98632).
        auditAgentCall(
          rt,
          'etn.thoughts.bulk_update',
          args.network_id,
          'thought',
          ids[0] ?? '',
          { op: args.op, ids: ids.length, affected, failures: failures.length },
        );
        return { affected, failures };
      }),
  );

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
        'Create a thought, optionally attaching a link in the same transaction. `link.direction` names ' +
        'the role of `link.target_thought_id` for the NEW thought: "parent" — attach the new thought ' +
        'UNDER the target (use this to create inside a section), "child" — the NEW thought becomes the ' +
        'parent of the target. Call `etn.thoughts.find_duplicates` first. `type`/`link.type` resolve a ' +
        'type by name (see `etn.types.list`). `warnings` lists the type\'s `required` properties left ' +
        'unset — follow up with `etn.properties.set`.',
      inputSchema: CreateThoughtSchema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
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
                  // Domain/REST direction now matches the MCP one directly
                  // (docs/03-server-api.md §6.3, docs/05-mcp-server.md §5.2).
                  create_link: {
                    direction: args.link.direction,
                    target_thought_id: args.link.target_thought_id,
                    type_id: linkTypeId ?? null,
                  },
                }),
          },
          rt.deps.auth.userId,
        );
        emitAgentActivityEvent(rt, args.network_id, 'thought.created', { thought }, ndb, extra.requestId);
        if (args.link !== undefined) {
          // "parent" — the TARGET is the link source (the new thought hangs
          // under it); "child" — the new thought is the source.
          const [sourceId, targetId] =
            args.link.direction === 'parent'
              ? [args.link.target_thought_id, thought.id]
              : [thought.id, args.link.target_thought_id];
          const link = findLinksBetween(ndb, sourceId, targetId, linkTypeId ?? null)[0];
          if (link !== undefined) {
            emitAgentActivityEvent(rt, args.network_id, 'link.created', { link }, ndb, extra.requestId);
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
        'Patch a thought (last-write-wins per field). `expected_version` enables optimistic concurrency — ' +
        'on mismatch the call fails with VERSION_CONFLICT. Returns { id, version }; `warnings` lists the ' +
        'new type\'s `required` properties left unset when `changes.type_id` is present.',
      inputSchema: UpdateThoughtSchema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
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
        emitAgentActivityEvent(
          rt,
          args.network_id,
          'thought.updated',
          { id: thought.id, changes: args.changes, version: thought.version },
          ndb,
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
        'Delete a thought (cascades to links, comments, attachments, property values). The same blocking ' +
        'check as `etn.thoughts.deletion_check` runs first: a `blocking` error means the thought is used in ' +
        'a thought_ref property or held by a layer — it is not deleted. Protected thoughts (HOME) are ' +
        'rejected. Returns { id, version: 0 }. See prompt etn.how_to_purge.',
      inputSchema: DeleteThoughtSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.delete'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        // Снимок мысли до удаления — он уйдёт в журнал (как `getThought`
        // в REST DELETE /thoughts/:id); getThoughtOrThrow даёт тот же
        // NOT_FOUND, что и сам deleteThought.
        const existing = getThoughtOrThrow(ndb, args.thought_id);
        // actorUserId — для object-lock enforcement (задача 2031df5e).
        deleteThought(ndb, args.thought_id, args.expected_version, rt.deps.auth.userId);
        emitAgentEvent(
          rt,
          args.network_id,
          'thought.deleted',
          { id: args.thought_id },
          extra.requestId,
        );
        recordThoughtActivity(ndb, {
          networkId: args.network_id,
          userId: rt.deps.auth.userId,
          action: 'deleted',
          thought: existing,
          layerId: ndb.layerId,
        });
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

  const TrashThoughtSchema = z.object({
    network_id: NetworkId,
    thought_id: ThoughtId,
    trashed: z.boolean(),
  });
  mcp.registerTool(
    'etn.thoughts.trash',
    {
      title: 'Поместить мысль в корзину / вернуть',
      description:
        'Mark a thought for deletion (`trashed: true`) or restore it from the trash (`trashed: false`). ' +
        'Does NOT run the blocking check — that only applies to the physical `etn.thoughts.delete`. ' +
        'Returns { id, version }. See prompt etn.how_to_purge.',
      inputSchema: TrashThoughtSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.trash'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const thought = updateThought(
          ndb,
          args.thought_id,
          { marked_for_deletion: args.trashed },
          undefined,
          rt.deps.auth.userId,
        );
        emitAgentActivityEvent(
          rt,
          args.network_id,
          'thought.updated',
          { id: thought.id, changes: { marked_for_deletion: args.trashed }, version: thought.version },
          ndb,
          extra.requestId,
        );
        auditAgentCall(rt, 'etn.thoughts.trash', args.network_id, 'thought', thought.id, {
          trashed: args.trashed,
        });
        return {
          id: thought.id,
          version: thought.version,
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
      runWriteTool(rt, args.network_id, async () => {
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
        emitAgentActivityEvent(
          rt,
          args.network_id,
          'thought.updated',
          { id: thought.id, changes: { active: args.active }, version: thought.version },
          ndb,
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
        'Create a directed link source → target, optionally typed: source_id is the PARENT, target_id is ' +
        'the CHILD. Duplicate pairs and self-loops are rejected. `type` resolves a link type by ' +
        '`name_forward`/`name_reverse` instead of `type_id` (see `etn.types.list`). Returns { id, version }.',
      inputSchema: CreateLinkSchema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const typeId = effectiveLinkTypeId(ndb, args.type_id, args.type);
        const link = createLink(
          ndb,
          { source_id: args.source_id, target_id: args.target_id, type_id: typeId ?? null },
          rt.deps.auth.userId,
        );
        emitAgentActivityEvent(rt, args.network_id, 'link.created', { link }, ndb, extra.requestId);
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
      description:
        'Delete a link. The same blocking check as `etn.links.deletion_check` runs first. ' +
        'Returns { id, version: 0 }. See prompt etn.how_to_purge.',
      inputSchema: DeleteLinkSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.links.delete'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        // Снимок связи до удаления — он уйдёт в журнал (как `getLink`
        // в REST DELETE /links/:id).
        const existing = getLink(ndb, args.link_id);
        deleteLink(ndb, args.link_id, args.expected_version);
        emitAgentEvent(rt, args.network_id, 'link.deleted', { id: args.link_id }, extra.requestId);
        if (existing !== null) {
          recordLinkActivity(ndb, {
            networkId: args.network_id,
            userId: rt.deps.auth.userId,
            action: 'deleted',
            link: existing,
            layerId: ndb.layerId,
          });
        }
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

  const TrashLinkSchema = z.object({
    network_id: NetworkId,
    link_id: LinkId,
    trashed: z.boolean(),
  });
  mcp.registerTool(
    'etn.links.trash',
    {
      title: 'Поместить связь в корзину / вернуть',
      description:
        'Mark a link for deletion (`trashed: true`) or restore it from the trash (`trashed: false`). ' +
        'Does NOT run the blocking check. Returns { id, version }. See prompt etn.how_to_purge.',
      inputSchema: TrashLinkSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.links.trash'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const link = updateLink(
          ndb,
          args.link_id,
          { marked_for_deletion: args.trashed },
          undefined,
          rt.deps.auth.userId,
        );
        emitAgentActivityEvent(
          rt,
          args.network_id,
          'link.updated',
          { id: link.id, changes: { marked_for_deletion: args.trashed }, version: link.version },
          ndb,
          extra.requestId,
        );
        auditAgentCall(rt, 'etn.links.trash', args.network_id, 'link', link.id, {
          trashed: args.trashed,
        });
        return {
          id: link.id,
          version: link.version,
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
        'For `permanent`: creates the single permanent comment of the owner, or updates it when it already ' +
        'exists. For `chronological`: always appends a new dated entry (`valid_from`/`valid_to`); pass ' +
        '`targets: [{owner_type, owner_id}]` (1..100, first is the primary owner) instead of ' +
        '`owner_type`+`owner_id` to attach the same entry to several thoughts/links at once. ' +
        'Returns { id, version }.',
      inputSchema: UpsertCommentSchema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
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
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'comment.updated',
              { id: comment.id, changes, version: comment.version },
              ndb,
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
        emitAgentActivityEvent(rt, args.network_id, 'comment.created', { comment }, ndb, extra.requestId);
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
        'Patch an existing comment (chronological or permanent) by `comment_id` — last-write-wins per ' +
        'field. `valid_from`/`valid_to` apply to chronological entries only and are ignored for permanent ' +
        'ones. `expected_version` enables optimistic concurrency — on mismatch the call fails with ' +
        'VERSION_CONFLICT. Returns { id, version }.',
      inputSchema: UpdateCommentSchema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
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
        emitAgentActivityEvent(
          rt,
          args.network_id,
          'comment.updated',
          { id: comment.id, changes: args.changes, version: comment.version },
          ndb,
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

  // Задача d28abe04 (0.7.2): секционная правка комментария ops-ами одной
  // транзакцией. Поддерживает append / prepend / replace_section /
  // delete_section; адресация секций — по тексту markdown-заголовка
  // (виртуальная первая строка для текстов без `#`).
  const EditAppendOp = z.object({ op: z.literal('append'), text: z.string().min(1) });
  const EditPrependOp = z.object({ op: z.literal('prepend'), text: z.string().min(1) });
  const EditReplaceSectionOp = z.object({
    op: z.literal('replace_section'),
    section: z.string().min(1),
    text: z.string().min(1),
  });
  const EditDeleteSectionOp = z.object({
    op: z.literal('delete_section'),
    section: z.string().min(1),
  });
  const EditOpSchema = z.discriminatedUnion('op', [
    EditAppendOp,
    EditPrependOp,
    EditReplaceSectionOp,
    EditDeleteSectionOp,
  ]);
  const EditCommentSchema = z
    .object({
      network_id: NetworkId,
      comment_id: z.string().min(1).optional(),
      thought_id: ThoughtId.optional(),
      expected_version: ExpectedVersion,
      ops: z.array(EditOpSchema).min(1),
    })
    .refine((a) => (a.comment_id === undefined) !== (a.thought_id === undefined), {
      message: 'provide exactly one of comment_id or thought_id',
    });
  mcp.registerTool(
    'etn.comments.edit',
    {
      title: 'Частичная правка комментария',
      description:
        'Edit a comment by parts: `append`/`prepend`/`replace_section`/' +
        '`delete_section` ops applied sequentially in one transaction ' +
        '(failure rolls back the call). Addressing by markdown heading ' +
        'text; for heading-less text the first non-empty line is a virtual ' +
        'heading. `comment_id` XOR `thought_id`. Returns ' +
        '`{ id, version, sections[], chars_total }`.',
      inputSchema: EditCommentSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.comments.edit'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        let targetId: string;
        if (args.thought_id !== undefined) {
          // Постоянный комментарий мысли: проверяем, что мысль существует,
          // и достаём единственный постоянный комментарий через listComments.
          getThoughtOrThrow(ndb, args.thought_id);
          const permanent =
            listComments(ndb, 'thought', args.thought_id).find((c) => c.kind === 'permanent') ??
            null;
          if (permanent === null) {
            throw new Error(
              `ETN error [NOT_FOUND]: thought ${args.thought_id} has no permanent comment`,
            );
          }
          targetId = permanent.id;
        } else if (args.comment_id !== undefined) {
          targetId = args.comment_id;
        } else {
          // refine гарантирует одну из двух; здесь — для TS.
          throw new Error('ETN error [VALIDATION_ERROR]: comment_id or thought_id required');
        }
        const result = editComment(
          ndb,
          targetId,
          args.ops,
          args.expected_version,
          rt.deps.auth.userId,
        );
        emitAgentActivityEvent(
          rt,
          args.network_id,
          'comment.updated',
          {
            id: result.id,
            changes: { body_md: result.body_md },
            version: result.version,
          },
          ndb,
          extra.requestId,
        );
        auditAgentCall(rt, 'etn.comments.edit', args.network_id, 'comment', result.id, {
          expected_version: args.expected_version,
          ops_count: args.ops.length,
        });
        return {
          id: result.id,
          version: result.version,
          sections: result.sections,
          chars_total: result.chars_total,
          request_id: String(extra.requestId),
        };
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
      runWriteTool(rt, args.network_id, async () => {
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
        recordCommentActivity(ndb, {
          networkId: args.network_id,
          userId: rt.deps.auth.userId,
          action: 'deleted',
          comment: existing,
          layerId: ndb.layerId,
        });
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
      runWriteTool(rt, args.network_id, async () => {
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
        emitAgentActivityEvent(rt, args.network_id, 'attachment.created', { attachment }, ndb, extra.requestId);
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
        'Copy an existing attachment to one or more target thoughts: each target receives a new row ' +
        'carrying the same visible fields as the source; the underlying file is not duplicated. Targets ' +
        'that already own the same attachment (same kind + same url/file_path) are skipped silently. ' +
        'Returns one `{id, version: 0, request_id}` per created row.',
      inputSchema: CopyAttachmentSchema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
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
          emitAgentActivityEvent(
            rt,
            args.network_id,
            'attachment.created',
            { attachment },
            ndb,
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
        'Search attachments across the network by keywords over title, description, url and file_path ' +
        '(case-insensitive LIKE, no FTS index). `q` uses the `etn.thoughts.search` mini-syntax: AND of ' +
        'include-words, `-word` exclusion, `*` infix wildcard. Pass `exclude_owner_type`/' +
        '`exclude_owner_id` to hide rows already attached to a specific owner.',
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

  // =========================================================================
  // `etn.attachments.update` (задача 6d45ab37, спека 0b23a32a, P1-паритет
  // MCP↔REST `PATCH /attachments/{id}`). Last-write-wins по метаданным
  // (title/description/url/file_path); kind неизменяем после создания.
  // =========================================================================
  const UpdateAttachmentSchema = z.object({
    network_id: NetworkId,
    attachment_id: z.string().min(1),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    file_path: z.string().nullable().optional(),
  });
  mcp.registerTool(
    'etn.attachments.update',
    {
      title: 'Изменить вложение',
      description:
        'Правка метаданных (title/description/url/file_path). Last-write-wins (у `attachments` нет ' +
        '`version`). `kind` неизменяем. Возвращает `{ id, version }`.',
      inputSchema: UpdateAttachmentSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.attachments.update'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const changes: {
          title?: string | null;
          description?: string | null;
          url?: string | null;
          file_path?: string | null;
        } = {};
        if (args.title !== undefined) changes.title = args.title;
        if (args.description !== undefined) changes.description = args.description;
        if (args.url !== undefined) changes.url = args.url;
        if (args.file_path !== undefined) changes.file_path = args.file_path;
        const attachment = updateAttachment(
          ndb,
          args.attachment_id,
          changes,
          rt.deps.auth.userId,
        );
        emitAgentActivityEvent(
          rt,
          args.network_id,
          'attachment.updated',
          { id: attachment.id, changes },
          ndb,
          extra.requestId,
        );
        auditAgentCall(
          rt,
          'etn.attachments.update',
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

  // =========================================================================
  // `etn.attachments.delete` (задача 6d45ab37, спека 0b23a32a, P1-паритет
  // MCP↔REST `DELETE /attachments/{id}`). Отвязывает вложение от владельца;
  // физический файл НЕ удаляется — server-side cleanup в domain
  // `deleteAttachment` (S4, 13-layers.md §5.3) решает судьбу файла по
  // оставшимся ссылкам.
  // =========================================================================
  const DeleteAttachmentSchema = z.object({
    network_id: NetworkId,
    attachment_id: z.string().min(1),
  });
  mcp.registerTool(
    'etn.attachments.delete',
    {
      title: 'Удалить вложение',
      description:
        'Отвязка вложения от владельца. Физический файл НЕ удаляется — судьбу решает domain ' +
        'по оставшимся ссылкам. Возвращает `{ deleted: true }`.',
      inputSchema: DeleteAttachmentSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.attachments.delete'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        // Берём снимок ДО удаления — это требование `recordAttachmentActivity`
        // (deleted-ветка emitAgentActivityEvent не пишет журнал, как и REST-роут).
        const existing = getAttachment(ndb, args.attachment_id);
        deleteAttachment(ndb, args.attachment_id);
        emitAgentEvent(
          rt,
          args.network_id,
          'attachment.deleted',
          { id: args.attachment_id },
          extra.requestId,
        );
        if (existing !== null) {
          recordAttachmentActivity(ndb, {
            networkId: args.network_id,
            userId: rt.deps.auth.userId,
            action: 'deleted',
            attachment: existing,
            layerId: resolveRuntimeLayer(rt, args.network_id).id,
          });
        }
        auditAgentCall(
          rt,
          'etn.attachments.delete',
          args.network_id,
          'attachment',
          args.attachment_id,
          args,
        );
        return { deleted: true, request_id: String(extra.requestId) };
      }),
  );

  const PropertyValueSchema = z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string().min(1)),
    z.null(),
  ]);
  /**
   * Coerce stringified scalars back to their JSON types at the MCP boundary
   * (0.5.3 bugfix, docs/05-mcp-server.md §5.2). Some MCP hosts (ZCode among
   * them) stringify the scalar `value` parameter of a union-typed tool input,
   * so `value: true` arrives as `"true"`; nested objects (`values`,
   * `properties`) pass through untouched, which is why only the single form of
   * `etn.properties.set` needs this. The rules stay strict on purpose:
   *   * `bool` — only the exact strings "true"/"false" (case-insensitive);
   *   * `number` — only strings `Number()` parses into a finite number
   *     (so "42", "3.5", "1e3" pass; "", "abc", "Infinity" fall through and
   *     are rejected by the domain validation, which itself stays untouched).
   * Text-like properties (`text`, `url`, `date`) never coerce: "true" stays a
   * string there.
   */
  const coerceStringifiedScalar = (
    def: Pick<PropertyDefinition, 'value_type'>,
    value: PropertyValueValue,
  ): PropertyValueValue => {
    if (typeof value !== 'string') {
      return value;
    }
    if (def.value_type === 'bool' && /^(true|false)$/i.test(value)) {
      return value.toLowerCase() === 'true';
    }
    if (def.value_type === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
    return value;
  };
  const SetPropertySchema = z
    .object({
      network_id: NetworkId,
      owner_type: z.enum(PROPERTY_OWNER_TYPES),
      owner_id: z.string().min(1),
      key: z.string().min(1).optional(),
      value: PropertyValueSchema.optional(),
      values: z.record(z.string(), PropertyValueSchema).optional(),
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
        'Set (or clear with `value: null`) a property value on a thought/link by key; the value must ' +
        "match the definition's value_type. `config.multiple = true` properties accept an array: " +
        '`thought_ref` — thought ids; `url` — URL/file-path strings (JSON array, not comma-join); an empty ' +
        'array clears. Stringified scalars are tolerated in the single form: "true"/"false" for `bool`, ' +
        'finite numeric strings for `number` — coerced back to JSON types. Either one `key`+`value`, or ' +
        '`values: {key: value|null}` for several properties in one transaction (an invalid key rolls back ' +
        'the whole set). Missing key → NOT_FOUND; a property not attached to the owner\'s type chain → ' +
        'VALIDATION_ERROR with `details.property_id` (call `etn.types.list` against it).',
      inputSchema: SetPropertySchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.properties.set'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);

        if (args.values !== undefined) {
          const stored = setPropertyValues(
            ndb,
            args.owner_type,
            args.owner_id,
            args.values,
            rt.deps.auth.userId,
          );
          for (const value of Object.values(stored)) {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'property-value.set',
              {
                owner_type: args.owner_type,
                owner_id: args.owner_id,
                property_id: value.property_id,
                value: value.value,
              },
              ndb,
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
        // Some MCP hosts stringify scalar union parameters ("true" instead of
        // true) — coerce the string back per the resolved definition's
        // value_type before the domain call (docs/05-mcp-server.md §5.2).
        // A missing definition is left to setPropertyValue to report (NOT_FOUND).
        const def = resolveDefinition(ndb, args.owner_type, args.owner_id, key);
        const coerced = def === null ? value : coerceStringifiedScalar(def, value);
        const stored = setPropertyValue(
          ndb,
          args.owner_type,
          args.owner_id,
          key,
          coerced,
          rt.deps.auth.userId,
        );
        emitAgentActivityEvent(
          rt,
          args.network_id,
          'property-value.set',
          {
            owner_type: args.owner_type,
            owner_id: args.owner_id,
            property_id: stored.property_id,
            value: stored.value,
          },
          ndb,
          extra.requestId,
        );
        auditAgentCall(rt, 'etn.properties.set', args.network_id, args.owner_type, args.owner_id, {
          key,
          value: coerced,
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
      direction: LinkDirection,
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
      properties: z.record(z.string(), PropertyValueSchema).optional(),
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
        'Create (or, via `thought_id`/`on_duplicate`, augment) a thought together with its permanent ' +
        'comment, property values, links and attachments — one atomic transaction, one write-budget ' +
        'slot. `thought_id` addresses an existing thought to augment in place; otherwise `thought.title`/' +
        '`synonyms` are matched as in `etn.thoughts.find_duplicates` and `on_duplicate` decides the match ' +
        'outcome: `fail` (default, errors with `candidates`), `reuse` (attach the other parts to the ' +
        'match unchanged), `update` (also patch its fields). `thought.type`/`links[].type` resolve a type ' +
        'by name (see `etn.types.list`). `links[].direction`: "parent" — attach the bundle thought UNDER ' +
        'the target; "child" — the bundle thought becomes the parent of the target. `warnings` lists the ' +
        'type\'s `required` properties left unset (empty when complete).',
      inputSchema: UpsertBundleSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.upsert_bundle'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
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
                  // Domain/REST direction now matches the MCP one directly
                  // (docs/03-server-api.md §6.3, docs/05-mcp-server.md §5.2).
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
          emitAgentActivityEvent(rt, args.network_id, 'thought.created', { thought: result.thought }, ndb, extra.requestId);
        } else if (result.thought_action === 'updated') {
          emitAgentActivityEvent(
            rt,
            args.network_id,
            'thought.updated',
            { id: result.thought.id, changes: resolvedThought ?? {}, version: result.thought.version },
            ndb,
            extra.requestId,
          );
        }
        if (result.comment !== undefined) {
          if (result.comment_action === 'created') {
            emitAgentActivityEvent(rt, args.network_id, 'comment.created', { comment: result.comment }, ndb, extra.requestId);
          } else {
            emitAgentActivityEvent(
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
              ndb,
              extra.requestId,
            );
          }
        }
        if (result.properties !== undefined) {
          for (const stored of Object.values(result.properties)) {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'property-value.set',
              {
                owner_type: 'thought',
                owner_id: result.thought.id,
                property_id: stored.property_id,
                value: stored.value,
              },
              ndb,
              extra.requestId,
            );
          }
        }
        if (result.links !== undefined) {
          for (const lr of result.links) {
            emitAgentActivityEvent(rt, args.network_id, 'link.created', { link: lr.link }, ndb, extra.requestId);
          }
        }
        if (result.attachments !== undefined) {
          for (const attachment of result.attachments) {
            emitAgentActivityEvent(rt, args.network_id, 'attachment.created', { attachment }, ndb, extra.requestId);
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
            : { links: result.links.map((lr) => ({ id: lr.link.id, version: lr.link.version })) }),
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
  // `etn.thoughts.write` — задача 053751b5, 0.7.2: батч-запись связанных
  // единиц знания одной транзакцией. Поглощает `etn.thoughts.create`/`update`/
  // `set_active`/`upsert_bundle`, `etn.links.create`, `etn.properties.set`,
  // `etn.comments.upsert` (помечены `deprecated_since: '0.7.2'` — см.
  // `MCP_TOOL_ANNOTATIONS` и механизм пропуска в начале `registerTools`).
  // =========================================================================

  const WriteChronicleItemSchema = z.object({
    title: z.string().nullable().optional(),
    body_md: z.string().min(1),
    valid_from: z.string().min(1).optional(),
    valid_to: z.string().nullable().optional(),
  });
  const WriteLinkSpecSchema = z
    .object({
      direction: LinkDirection,
      target_id: z.string().min(1).optional(),
      target_ref: z.string().min(1).optional(),
      type_id: z.string().min(1).nullable().optional(),
      type: z.string().min(1).optional(),
      properties: z.record(z.string(), PropertyValueSchema).optional(),
      comment: z
        .object({
          title: z.string().nullable().optional(),
          body_md: z.string().min(1),
        })
        .optional(),
    })
    .refine((v) => v.type_id === undefined || v.type === undefined, { message: TYPE_ID_TYPE_CONFLICT })
    .refine(
      (v) => (v.target_id !== undefined) !== (v.target_ref !== undefined),
      { message: 'each links[] entry must set exactly one of target_id or target_ref' },
    );
  const WriteAttachmentSpecSchema = z.object({
    kind: z.enum(ATTACHMENT_KINDS),
    url: z.string().min(1).nullable().optional(),
    file_path: z.string().min(1).nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
  });
  const WriteItemSchema = z
    .object({
      ref: z.string().min(1).optional(),
      thought_id: z.string().min(1).optional(),
      thought: BundleThoughtSchema.optional(),
      on_duplicate: z.enum(['fail', 'reuse', 'update']).optional(),
      comment: BundleCommentSchema.optional(),
      chronicle: z.array(WriteChronicleItemSchema).optional(),
      properties: z.record(z.string(), PropertyValueSchema).optional(),
      links: z.array(WriteLinkSpecSchema).optional(),
      attachments: z.array(WriteAttachmentSpecSchema).optional(),
    })
    // Каждый элемент должен иметь ХОТЯ БЫ ОДНО из `thought_id` (адресация
    // существующей мысли) или `thought` (новая/совпадающая мысль). Оба
    // вместе — норм: `thought_id` адресует мысль, `thought` патчит её поля.
    .refine(
      (v) => v.thought_id !== undefined || v.thought !== undefined,
      { message: 'each batch item must set thought_id or thought (at least one)' },
    )
    // Если задано `thought` И это новая мысль (нет `thought_id`), нужен
    // `ref` для возможных `target_ref` в других элементах батча. Случай
    // `thought + thought_id` (патч существующей) ref не требует.
    .refine(
      (v) => v.thought_id !== undefined || v.thought === undefined || v.ref !== undefined,
      {
        message:
          'a batch item with `thought` (new thought) must also declare a local `ref`',
      },
    );
  const WriteSchema = z.object({
    network_id: NetworkId,
    thoughts: z.array(WriteItemSchema).min(1).max(MCP_MAX_THOUGHTS_PER_WRITE),
  });
  mcp.registerTool(
    'etn.thoughts.write',
    {
      title: 'Батч-запись мыслей',
      description:
        'Пишет от 1 до ' + MCP_MAX_THOUGHTS_PER_WRITE + ' связанных единиц знания одной транзакцией: ' +
        'мысли + постоянные/хронологические комментарии + свойства + связи + вложения. ' +
        '`thought_id` XOR `thought` (с `ref`); `links[].target_id` XOR `target_ref`; `on_duplicate`: ' +
        '`fail`/`reuse`/`update`. Циклы `ref`/`target_ref` разрешены (фаза 2 — мысли, фаза 3 — связи). ' +
        'Поглощает `etn.thoughts.create`/`update`/`set_active`/`upsert_bundle`, `links.create`, ' +
        '`properties.set`, `comments.upsert` (`deprecated_since: \'0.7.2\'`). Один write-бюджет + одна ' +
        'строка `audit_log` на вызов. `warnings` агрегированы по батчу. Подробности — ' +
        '`etn.how_to_write_batch`.',
      inputSchema: WriteSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.write'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const writeInput: McpThoughtWriteParams = {
          network_id: args.network_id,
          thoughts: args.thoughts.map((item) => ({
            ...(item.ref === undefined ? {} : { ref: item.ref }),
            ...(item.thought_id === undefined ? {} : { thought_id: item.thought_id }),
            ...(item.thought === undefined ? {} : { thought: item.thought }),
            ...(item.on_duplicate === undefined ? {} : { on_duplicate: item.on_duplicate }),
            ...(item.comment === undefined ? {} : { comment: item.comment }),
            ...(item.chronicle === undefined ? {} : { chronicle: item.chronicle }),
            ...(item.properties === undefined ? {} : { properties: item.properties }),
            ...(item.links === undefined ? {} : { links: item.links }),
            ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
          })),
        };
        const result = writeThoughts(ndb, writeInput, rt.deps.auth.userId);

        // Real-time events — one per actually-affected entity (per task spec).
        // Done via the existing helpers so the WS gateway / activity log see
        // the same shape they do for `etn.thoughts.upsert_bundle` etc.
        for (const item of result.items) {
          if (item.thought_action === 'reused') continue;
          if (item.thought_action === 'created') {
            const thought = getThoughtOrThrow(ndb, item.id);
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'thought.created',
              { thought },
              ndb,
              extra.requestId,
            );
          } else {
            // 'updated' — also covers the 'set_active' scenario: a batch item
            // that only sets `active: false` (HOME is rejected, see domain
            // service) lands here as a normal `thought.updated`. Empty
            // `changes` is the contract for batched updates: the granular
            // changes live across `comment`/`chronicle`/`properties`/`links`/
            // `attachments` blocks of the same item, and the audit_log row
            // carries the full story.
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'thought.updated',
              { id: item.id, version: item.version, changes: {} },
              ndb,
              extra.requestId,
            );
          }
          if (item.comment !== undefined) {
            if (item.comment.action === 'created') {
              const c = getComment(ndb, item.comment.id);
              if (c !== null) {
                emitAgentActivityEvent(
                  rt,
                  args.network_id,
                  'comment.created',
                  { comment: c },
                  ndb,
                  extra.requestId,
                );
              }
            } else {
              emitAgentActivityEvent(
                rt,
                args.network_id,
                'comment.updated',
                {
                  id: item.comment.id,
                  version: item.comment.version,
                  changes: { body_md: '' },
                },
                ndb,
                extra.requestId,
              );
            }
          }
          if (item.chronicle !== undefined) {
            for (const entry of item.chronicle) {
              const c = getComment(ndb, entry.id);
              if (c !== null) {
                emitAgentActivityEvent(
                  rt,
                  args.network_id,
                  'comment.created',
                  { comment: c },
                  ndb,
                  extra.requestId,
                );
              }
            }
          }
          if (item.links !== undefined) {
            for (const link of item.links) {
              const l = getLink(ndb, link.id);
              if (l !== null) {
                emitAgentActivityEvent(
                  rt,
                  args.network_id,
                  'link.created',
                  { link: l },
                  ndb,
                  extra.requestId,
                );
              }
            }
          }
          if (item.attachments !== undefined) {
            for (const att of item.attachments) {
              const a = getAttachment(ndb, att.id);
              if (a !== null) {
                emitAgentActivityEvent(
                  rt,
                  args.network_id,
                  'attachment.created',
                  { attachment: a },
                  ndb,
                  extra.requestId,
                );
              }
            }
          }
        }

        // ONE audit row for the whole batch (per task spec).
        auditAgentCall(
          rt,
          'etn.thoughts.write',
          args.network_id,
          'network',
          args.network_id,
          {
            thought_count: result.thought_count,
            link_count: result.link_count,
            item_count: result.items.length,
          },
        );

        const layer = resolveRuntimeLayer(rt, args.network_id);
        const items: McpThoughtWriteItemResult[] = result.items;
        return {
          items,
          warnings: result.warnings,
          layer: { id: layer.id, title: layer.title },
          request_id: String(extra.requestId),
        } satisfies McpThoughtWriteResult;
      }),
  );

  // =========================================================================
  // Trash + usage-clear (S13)
  // =========================================================================

  const TrashPurgeSchema = z.object({ network_id: NetworkId });
  mcp.registerTool(
    'etn.trash.purge',
    {
      title: 'Очистить корзину',
      description:
        '«Удалить всё, что возможно»: physically delete every marked thought/link for which the blocking ' +
        'check reports nothing; blocked ones are skipped silently. Returns { purged, skipped } — a ' +
        'non-empty `skipped` also carries `how_to`. See prompt etn.how_to_purge.',
      inputSchema: TrashPurgeSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.trash.purge'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        // Снимки помеченных на удаление строк ДО физического удаления —
        // после purgeTrash их уже нет, а журналу нужен снимок на момент
        // операции (тот же ход, что в REST POST /trash/purge).
        const trash = listTrash(ndb);
        const thoughtSnapshots = new Map(trash.thoughts.map((t) => [t.id, t]));
        const linkSnapshots = new Map(trash.links.map((l) => [l.id, l]));
        const { purged, skipped, deleted_thought_ids, deleted_link_ids } = purgeTrash(ndb);
        for (const id of deleted_thought_ids) {
          const snapshot = thoughtSnapshots.get(id);
          emitAgentEvent(rt, args.network_id, 'thought.deleted', { id }, extra.requestId);
          if (snapshot !== undefined) {
            recordThoughtActivity(ndb, {
              networkId: args.network_id,
              userId: rt.deps.auth.userId,
              action: 'deleted',
              thought: snapshot,
              layerId: ndb.layerId,
            });
          }
        }
        for (const id of deleted_link_ids) {
          const snapshot = linkSnapshots.get(id);
          emitAgentEvent(rt, args.network_id, 'link.deleted', { id }, extra.requestId);
          if (snapshot !== undefined) {
            recordLinkActivity(ndb, {
              networkId: args.network_id,
              userId: rt.deps.auth.userId,
              action: 'deleted',
              link: snapshot,
              layerId: ndb.layerId,
            });
          }
        }
        auditAgentCall(rt, 'etn.trash.purge', args.network_id, 'network', args.network_id, {
          purged,
          skipped,
        });
        return {
          purged,
          skipped,
          // Hint-навигатор уровня 2 (ADR b2eebf8b): непустой skipped значит,
          // что часть корзины заблокирована — промпт объясняет, что делать.
          ...(skipped > 0 ? { how_to: 'etn.how_to_purge' } : {}),
        };
      }),
  );

  const UsageClearSchema = z.object({
    network_id: NetworkId,
    thought_id: ThoughtId,
  });
  mcp.registerTool(
    'etn.thoughts.usage_clear',
    {
      title: 'Очистить использование мысли',
      description:
        'Null out every thought_ref property value of other thoughts that references this one — clears ' +
        'the «использование в свойствах» blocking arm in one call instead of editing each property. ' +
        'Returns { cleared }.',
      inputSchema: UsageClearSchema,
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        getThoughtOrThrow(ndb, args.thought_id);
        const cleared = clearThoughtRefUsages(ndb, args.thought_id);
        auditAgentCall(rt, 'etn.thoughts.usage_clear', args.network_id, 'thought', args.thought_id, {
          cleared,
        });
        return { cleared, request_id: String(extra.requestId) };
      }),
  );

  // =========================================================================
  // Object-locks (task a88acf20, операция b6b776ff «etn.locks.*»)
  // -------------------------------------------------------------------------
  // Паритет с REST `/locks` (задача 2031df5e). Семантика ошибок единая:
  //   * `LOCKED` (409)        — acquire чужого захвата, `details.holder`
  //     содержит `{ user_id, client_id, acquired_at_ms }`.
  //   * `LOCK_NOT_FOUND` (404) — release несуществующего lock_id.
  //   * `FORBIDDEN` (403)     — release чужого захвата.
  //   * `VALIDATION_ERROR` (422) — обязательные поля.
  //
  // События real-time `edit.acquired` / `edit.released` / `edit.cleared`
  // эмитятся через `emitAgentEvent` — они доходят до подписчиков через тот же
  // поток, что и REST-события (`emitDomainEvent` использует
  // `REALTIME_EVENT_AUDIENCE[type]`, для `edit.*` это `network`).
  // В журнал активности захваты НЕ пишутся — требование b0c7a57c — поэтому
  // здесь именно `emitAgentEvent`, а не `emitAgentActivityEvent`.
  // =========================================================================

  const LocksAcquireSchema = z.object({
    network_id: NetworkId,
    entity_type: z.string().min(1),
    entity_id: z.string().min(1),
  });
  mcp.registerTool(
    'etn.locks.acquire',
    {
      title: 'Захватить объект',
      description:
        'Acquire (or refresh) the lock on `(entity_type, entity_id)` for the calling user. Idempotent for ' +
        'the same user — a repeated acquire updates `client_id` / `acquired_at_ms` and returns the existing ' +
        'row. A different holder is rejected with `LOCKED` carrying the holder coordinates in ' +
        '`details.holder`. Returns the canonical `LockRow`.',
      inputSchema: LocksAcquireSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.locks.acquire'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const lock = acquireLock(ndb, {
          entityType: args.entity_type,
          entityId: args.entity_id,
          userId: rt.deps.auth.userId,
          clientId: null, // MCP-сессия не несёт Client-Id — соответствует REST-вызову без заголовка.
        });
        const data: EditAcquiredData = {
          entity_type: lock.entity_type,
          entity_id: lock.entity_id,
          lock_id: lock.id,
          user_id: lock.user_id,
          client_id: lock.client_id,
          acquired_at_ms: lock.acquired_at_ms,
        };
        emitAgentEvent(rt, args.network_id, 'edit.acquired', data, extra.requestId);
        auditAgentCall(rt, 'etn.locks.acquire', args.network_id, lock.entity_type, lock.entity_id, {
          lock_id: lock.id,
        });
        return {
          ...lock,
          request_id: String(extra.requestId),
        } satisfies LockRow & { request_id: string };
      }),
  );

  const LocksReleaseSchema = z.object({
    network_id: NetworkId,
    lock_id: z.string().min(1),
  });
  mcp.registerTool(
    'etn.locks.release',
    {
      title: 'Снять свой захват',
      description:
        'Release the lock with id `lock_id` for the calling user. Only the holder may release — anyone ' +
        'else gets `FORBIDDEN`; an unknown lock id is `LOCK_NOT_FOUND`. Returns `{ released: true }`.',
      inputSchema: LocksReleaseSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.locks.release'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const released = releaseLock(ndb, args.lock_id, rt.deps.auth.userId);
        const data: EditReleasedData = {
          entity_type: released.entity_type,
          entity_id: released.entity_id,
          lock_id: released.id,
          user_id: released.user_id,
          client_id: released.client_id,
        };
        emitAgentEvent(rt, args.network_id, 'edit.released', data, extra.requestId);
        auditAgentCall(rt, 'etn.locks.release', args.network_id, released.entity_type, released.entity_id, {
          lock_id: released.id,
        });
        return {
          released: true as const,
          lock_id: released.id,
          request_id: String(extra.requestId),
        };
      }),
  );

  const LocksClearSchema = z.object({
    network_id: NetworkId,
    user_id: z.string().min(1),
  });
  mcp.registerTool(
    'etn.locks.clear',
    {
      title: 'Снять все захваты участника',
      description:
        'Remove every lock held by `user_id` in the network — any network member may invoke this for any ' +
        'other member (равноправие). Returns `{ cleared: number }`.',
      inputSchema: LocksClearSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.locks.clear'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const removed = clearLocksForUser(ndb, args.user_id);
        for (const lock of removed) {
          const data: EditClearedData = {
            entity_type: lock.entity_type,
            entity_id: lock.entity_id,
            lock_id: lock.id,
            user_id: lock.user_id,
            client_id: lock.client_id,
            reason: 'manual',
          };
          emitAgentEvent(rt, args.network_id, 'edit.cleared', data, extra.requestId);
        }
        auditAgentCall(rt, 'etn.locks.clear', args.network_id, 'network', args.network_id, {
          user_id: args.user_id,
          cleared: removed.length,
        });
        return {
          cleared: removed.length,
          request_id: String(extra.requestId),
        };
      }),
  );

  const LocksListSchema = z.object({
    network_id: NetworkId,
    user_id: z.string().min(1).nullable().optional(),
    client_id: z.string().min(1).nullable().optional(),
  });
  mcp.registerTool(
    'etn.locks.list',
    {
      title: 'Активные захваты сети',
      description:
        'List active locks in the network, optionally filtered by `user_id` and/or `client_id` (a single ' +
        'value each; `null` or omitted removes the constraint). Returns the same ' +
        '`{ data: LockRow[], meta: { total, offset, limit } }` envelope as `GET /locks`.',
      inputSchema: LocksListSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.locks.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const locks = listLocks(ndb, {
          userId: args.user_id === undefined ? undefined : args.user_id,
          clientId: args.client_id === undefined ? undefined : args.client_id,
        });
        return {
          data: locks,
          meta: {
            total: locks.length,
            offset: 0,
            limit: locks.length,
          },
        };
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
        'Find existing thoughts matching a proposed title/synonyms (exact title, exact synonym, partial). ' +
        'A partial match requires the typed fragments to occur inside CONSECUTIVE words of the title or of ' +
        'one synonym, in the typed order («исправ ошиб» finds «Исправленные ошибки», but not «исправить ' +
        'старую ошибку»); `-word` excludes. Always call before `etn.thoughts.create`.',
      inputSchema: FindDuplicatesSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.thoughts.find_duplicates'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        // Bug fix (§5.1e): `findDuplicates` is shared with the REST add-thought
        // dialog (which needs the real icon to render candidates), so sanitize
        // only at this MCP-facing call site.
        return findDuplicates(ndb, args.title, args.synonyms ?? []).map((hit) =>
          withSanitizedIcon(hit),
        );
      }),
  );

  // =========================================================================
  // Activity log (§4.1) — паритет с REST GET /activity
  // (задача f2eca5a4, операция 70dfe81d).
  // =========================================================================

  const ActivityListSchema = z.object({
    network_id: NetworkId,
    from_ms: z.number().int().nonnegative().optional(),
    to_ms: z.number().int().nonnegative().optional(),
    user_id: z.string().min(1).optional(),
    entity_type: z.string().min(1).optional(),
    entity_id: z.string().min(1).optional(),
    limit: z.number().int().positive().max(ACTIVITY_LIMIT_MAX).optional(),
    offset: z.number().int().nonnegative().optional(),
  });
  mcp.registerTool(
    'etn.activity.list',
    {
      title: 'Лента журнала активности',
      description:
        'Read the activity log of a network: one row per mutating operation by a network member — ' +
        'creation, update, delete, trash/restore of a thought, link, type, property, comment, attachment ' +
        'or layer; `entity_title` is a snapshot at the moment of the event. Captures (`edit.*`) are not ' +
        'recorded. Filters combine with AND; sorted by `occurred_at_ms DESC`; paginated (`limit` default ' +
        '50, max 200, + `offset`).',
      inputSchema: ActivityListSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.activity.list'],
    },
    (args) =>
      runTool(async () => {
        const ndb = openMemberNetwork(rt, args.network_id);
        const result = listActivity(ndb, {
          networkId: args.network_id,
          from_ms: args.from_ms,
          to_ms: args.to_ms,
          user_id: args.user_id,
          entity_type: args.entity_type,
          entity_id: args.entity_id,
          limit: args.limit,
          offset: args.offset,
        });
        return {
          data: result.data,
          meta: {
            total: result.total,
            offset: result.offset,
            limit: result.limit,
          },
        };
      }),
  );

  // ---- activity.rollup / activity.truncate (задача 6bcccd2b, требование
  // 76443b7e «свёртка» и 9921a32b «обрезка», стандарт 9e5cff3f — паритет
  // с REST `POST /activity/rollup` и `POST /activity/truncate`).

  const ActivityRollupSchema = z.object({
    network_id: NetworkId,
    until_ms: z.number().int().nonnegative(),
  });
  mcp.registerTool(
    'etn.activity.rollup',
    {
      title: 'Свёртка журнала активности',
      description:
        'Roll up the activity log of a network up to `until_ms`: for each live `(entity_type, entity_id)` ' +
        'only the earliest creation/update and the latest update stay; a `deleted`/`trashed` event up to ' +
        '`until_ms` alone remains. IRREVERSIBLE; runs in one SQLite transaction. Returns `{ removed, kept }`.',
      inputSchema: ActivityRollupSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.activity.rollup'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const result = rollupActivity(ndb, args.network_id, args.until_ms);
        auditAgentCall(rt, 'etn.activity.rollup', args.network_id, 'network', args.network_id, {
          until_ms: args.until_ms,
          removed: result.removed,
          kept: result.kept,
        });
        return { ...result, request_id: String(extra.requestId) };
      }),
  );

  const ActivityTruncateSchema = z.object({
    network_id: NetworkId,
    until_ms: z.number().int().nonnegative(),
  });
  mcp.registerTool(
    'etn.activity.truncate',
    {
      title: 'Обрезка журнала активности',
      description:
        'Hard-truncate the activity log of a network up to `until_ms`: every row with ' +
        '`occurred_at_ms <= until_ms` is deleted, including creation and deletion records. ' +
        'IRREVERSIBLE; runs in one SQLite transaction. Returns `{ removed }`.',
      inputSchema: ActivityTruncateSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.activity.truncate'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const result = truncateActivity(ndb, args.network_id, args.until_ms);
        auditAgentCall(rt, 'etn.activity.truncate', args.network_id, 'network', args.network_id, {
          until_ms: args.until_ms,
          removed: result.removed,
        });
        return { ...result, request_id: String(extra.requestId) };
      }),
  );

  // =========================================================================
  // 0.7.2 — task ba024a45: networks.write / networks.delete / instructions.
  // =========================================================================

  // ---------------------------------------------------------------------------
  // этон.networks.write — upsert: создаёт сеть, если `network_id` не передан;
  // иначе патчит существующую (права владельца/админа).
  //
  // Контракт повторяет REST `POST /networks` + `PATCH /networks/{id}` в одном
  // фасаде — тело частично перекрывается, но `type_roles` принимает явный
  // `null` для снятия роли. Невалидные ключи `type_roles` →
  // `VALIDATION_ERROR` на этапе `validateTypeRoles`; несуществующий id типа
  // → `VALIDATION_ERROR` через `networkService.validateTypeRoles`.
  // ---------------------------------------------------------------------------
  const NetworksWriteSchema = z
    .object({
      network_id: NetworkId.optional(),
      display_name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      when_to_use: z.string().nullable().optional(),
      conventions: z.string().nullable().optional(),
      examples: z.string().nullable().optional(),
      type_roles: z.record(z.string(), z.string().nullable()).optional(),
    })
    .strict();
  mcp.registerTool(
    'etn.networks.write',
    {
      title: 'Создать или обновить сеть',
      description:
        'Upsert: omit `network_id` to create (caller → owner); pass `network_id` to patch (owner/admin). ' +
        'Editable: `display_name`, `description`, `when_to_use`, `conventions`, `examples`, `type_roles`. ' +
        'Unknown role keys / stale `type_id` → `VALIDATION_ERROR`. Returns the network card.',
      inputSchema: NetworksWriteSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.networks.write'],
    },
    (args, extra) => {
      // `runWriteTool` resolves the session layer through `openNetworkDb`,
      // which would fail on a brand-new network (the directory exists but
      // no row in `_system.db`'s `networks` yet — the layer walker would
      // succeed only after `createNetwork` returns). The clean split is:
      //  * create path → `runTool` (read wrapper, no layer echo);
      //  * patch path  → `runWriteTool` (echoes the existing layer).
      const op = async () => {
        requireWritable(rt);
        requireWriteBudget(rt);

        // 1. Validate `type_roles` shape (unknown role keys) before any I/O.
        const requestedRoles =
          args.type_roles !== undefined ? validateTypeRoles(args.type_roles) : undefined;

        let network: Network;
        if (args.network_id === undefined) {
          // ---- CREATE ---------------------------------------------------
          // Every authenticated principal may create a network (no admin
          // gate); the caller becomes the owner of the new network.
          const displayName = (args.display_name ?? '').trim();
          if (displayName.length === 0) {
            throw new EtnError(
              'VALIDATION_ERROR',
              'display_name обязательно при создании сети.',
              { field: 'display_name' },
            );
          }
          const description =
            args.description === undefined
              ? null
              : typeof args.description === 'string' && args.description === ''
                ? null
                : (args.description ?? null);
          // The service validates that every non-null type id exists in the
          // freshly created data.db. At create time the new network has no
          // thought types yet, so any non-null id here is doomed — we
          // surface that as `VALIDATION_ERROR` instead of letting the
          // service reject it with a less informative message.
          for (const [role, value] of Object.entries(requestedRoles ?? {}) as Array<
            [string, string | null]
          >) {
            if (value !== null) {
              throw new EtnError(
                'VALIDATION_ERROR',
                `На создании сети нельзя указывать непустую роль type_roles.${role}: в новой сети ещё нет типов.`,
                { field: `type_roles.${role}`, value },
              );
            }
          }
          network = await rt.deps.networkService.createNetwork(
            rt.deps.auth.userId,
            displayName,
            description,
            requestedRoles ?? {},
          );
          rt.deps.systemDb.insertAuditLog({
            actorUserId: rt.deps.auth.userId,
            networkId: network.id,
            category: 'network',
            action: 'network.create',
            targetType: 'network',
            targetId: network.id,
            details: {
              display_name: displayName,
              type_roles: requestedRoles ?? {},
              via: 'mcp.etn.networks.write',
            },
          });
        } else {
          // ---- PATCH ----------------------------------------------------
          const networkId = args.network_id;
          const existing = rt.deps.systemDb.getNetworkById(networkId);
          if (existing === null) {
            throw new EtnError('NOT_FOUND', `Сеть ${networkId} не найдена.`, {
              network_id: networkId,
            });
          }
          // Authz: network owner OR global admin (06-auth.md §4.1).
          const role = rt.deps.systemDb.getMemberRole(rt.deps.auth.userId, networkId);
          if (!rt.deps.auth.isAdmin && role !== 'owner') {
            throw new EtnError(
              'FORBIDDEN',
              'Требуются права владельца сети или администратора.',
              { network_id: networkId },
            );
          }
          // Merge roles: absent keys preserve the existing value, present
          // keys (including explicit `null`) override it.
          const mergedRoles =
            requestedRoles === undefined
              ? existing.type_roles
              : { ...existing.type_roles, ...requestedRoles };
          const validatedRoles = rt.deps.networkService.validateTypeRoles(
            networkId,
            mergedRoles,
          );
          const displayName =
            typeof args.display_name === 'string'
              ? args.display_name.trim() || existing.display_name
              : existing.display_name;
          // Markdown fields: null/empty clears, undefined preserves.
          const description = normalizeOptionalText(args.description, existing.description);
          const whenToUse = normalizeOptionalText(args.when_to_use, existing.when_to_use);
          const conventions = normalizeOptionalText(args.conventions, existing.conventions);
          const examples = normalizeOptionalText(args.examples, existing.examples);
          rt.deps.systemDb.updateNetwork(networkId, {
            displayName,
            description,
            when_to_use: whenToUse,
            conventions,
            examples,
            type_roles: validatedRoles,
          });
          rt.deps.systemDb.insertAuditLog({
            actorUserId: rt.deps.auth.userId,
            networkId,
            category: 'network',
            action: 'network.update',
            targetType: 'network',
            targetId: networkId,
            details: {
              display_name: displayName,
              description,
              when_to_use: whenToUse,
              conventions,
              examples,
              type_roles: validatedRoles,
              via: 'mcp.etn.networks.write',
            },
          });
          // Real-time: broadcast only the changed fields so subscribers
          // can merge in place (matches REST PATCH /networks/{id}).
          const changes: Record<string, unknown> = {};
          if (displayName !== existing.display_name) changes['display_name'] = displayName;
          if (description !== existing.description) changes['description'] = description;
          if (whenToUse !== existing.when_to_use) changes['when_to_use'] = whenToUse;
          if (conventions !== existing.conventions) changes['conventions'] = conventions;
          if (examples !== existing.examples) changes['examples'] = examples;
          if (JSON.stringify(validatedRoles) !== JSON.stringify(existing.type_roles)) {
            changes['type_roles'] = validatedRoles;
          }
          if (Object.keys(changes).length > 0) {
            emitDomainEvent(
              { systemDb: rt.deps.systemDb, pubsub: rt.deps.pubsub },
              networkId,
              'network.updated',
              changes,
              {
                user_id: rt.deps.auth.userId,
                client_id: rt.deps.auth.keyId,
              },
              { meta: { request_id: String(extra.requestId) } },
            );
          }
          network = rt.deps.systemDb.getNetworkById(networkId)!;
        }
        auditAgentCall(
          rt,
          'etn.networks.write',
          network.id,
          'network',
          network.id,
          {
            created: args.network_id === undefined,
            type_roles_keys: Object.keys(requestedRoles ?? {}),
          },
        );
        return {
          id: network.id,
          display_name: network.display_name,
          owner_id: network.owner_id,
          description: network.description,
          when_to_use: network.when_to_use,
          conventions: network.conventions,
          examples: network.examples,
          type_roles: network.type_roles,
          has_structure: typeof network.type_roles.table_of_contents === 'string',
          created_at: network.created_at,
          updated_at: network.updated_at,
          request_id: String(extra.requestId),
        };
      };
      return args.network_id === undefined
        ? runTool(op)
        : runWriteTool(rt, args.network_id, op);
    },
  );

  // ---------------------------------------------------------------------------
  // этон.networks.delete — destructive; admin only; дополнительно требует
  // `confirm: true` (как для человека).
  // ---------------------------------------------------------------------------
  const NetworksDeleteSchema = z
    .object({
      network_id: NetworkId,
      confirm: z.literal(true),
    })
    .strict();
  mcp.registerTool(
    'etn.networks.delete',
    {
      title: 'Удалить сеть',
      description:
        'Destructive: remove a network and its `data.db`. Admin only. Requires `confirm: true`. ' +
        'Returns `{ deleted, network_id, request_id }`.',
      inputSchema: NetworksDeleteSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.networks.delete'],
    },
    (args, extra) =>
      runTool(async () => {
        // The doomed network's `data.db` is about to vanish, so we bypass
        // `runWriteTool` (which would re-open the base layer for the layer
        // echo and resurrect the directory through `mkdirSync`). Mutating
        // tools still must observe the read-only + write-budget gates —
        // apply them by hand.
        requireWritable(rt);
        requireWriteBudget(rt);
        if (!rt.deps.auth.isAdmin) {
          throw new EtnError(
            'FORBIDDEN',
            'Удаление сети доступно только администратору сервера.',
            { network_id: args.network_id },
          );
        }
        const existing = rt.deps.systemDb.getNetworkById(args.network_id);
        if (existing === null) {
          throw new EtnError('NOT_FOUND', `Сеть ${args.network_id} не найдена.`, {
            network_id: args.network_id,
          });
        }
        // Emit before the registry row is gone (network_seq/event_log FK).
        emitDomainEvent(
          { systemDb: rt.deps.systemDb, pubsub: rt.deps.pubsub },
          args.network_id,
          'network.deleted',
          { id: args.network_id },
          { user_id: rt.deps.auth.userId, client_id: rt.deps.auth.keyId },
          { meta: { request_id: String(extra.requestId) } },
        );
        await rt.deps.networkService.deleteNetwork(args.network_id);
        rt.deps.systemDb.insertAuditLog({
          actorUserId: rt.deps.auth.userId,
          networkId: args.network_id,
          category: 'network',
          action: 'delete',
          targetType: 'network',
          targetId: args.network_id,
          details: { by_admin: true, via: 'mcp.etn.networks.delete' },
        });
        auditAgentCall(rt, 'etn.networks.delete', args.network_id, 'network', args.network_id, {
          confirm: args.confirm,
        });
        return {
          deleted: true,
          network_id: args.network_id,
          request_id: String(extra.requestId),
        };
      }),
  );

  // ---------------------------------------------------------------------------
  // этон.instructions — витрина инструкций сети (ADR 717f04df, спека 14b0cc4f).
  //
  // Три режима через дискриминированное объединение:
  //   * `{ network_id, instruction_id }` — полный текст одной инструкции
  //     (постоянный комментарий мысли целиком, без обрезки);
  //   * `{ network_id, keywords }` — фильтр по title+synonyms мини-синтаксом;
  //   * `{ network_id }` — все актуальные инструкции сети.
  //
  // Если роль `instructions` не задана, ответ — `{ has_instructions: false, instructions: [] }`
  // (без ошибки). Только актуальные мысли; помеченные на удаление исключаются;
  // учитываются подтипы роли (L21-иерархия типов); читается текущий слой сессии.
  // ---------------------------------------------------------------------------
  const InstructionsByIdSchema = z
    .object({
      network_id: NetworkId,
      instruction_id: z.string().min(1),
    })
    .strict();
  const InstructionsByKeywordsSchema = z
    .object({
      network_id: NetworkId,
      keywords: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .strict();
  const InstructionsAllSchema = z
    .object({
      network_id: NetworkId,
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .strict();
  function buildInstructionsPreview(ndb: NetworkDb, thoughtId: string) {
    // The permanent comment is read in full by spec 14b0cc4f ("БЕЗ обрезки").
    // We still surface a `preview` for list responses — a short substring of
    // the permanent body (200 chars), to keep the list payload compact while
    // leaving `etn.comments.get` as the canonical full-text accessor.
    const preview = getPermanentPreview(ndb, 'thought', thoughtId);
    return preview;
  }
  function fetchInstructionsList(
    ndb: NetworkDb,
    instructionsTypeIds: string[],
    keywords: string | undefined,
    limit: number,
    offset: number,
  ): Array<{
    id: string;
    title: string;
    synonyms: string[];
    preview: ReturnType<typeof getPermanentPreview>;
    type_id: string | null;
  }> {
    if (instructionsTypeIds.length === 0) return [];
    const placeholders = instructionsTypeIds.map(() => '?').join(',');
    const params: unknown[] = [...instructionsTypeIds];

    const keywordClause: string[] = [];
    const keywordParams: unknown[] = [];
    if (keywords !== undefined && keywords.trim() !== '') {
      const parsed = parseFilterKeywords(keywords);
      // AND of all include words; `-word` exclusions negate.
      for (const word of parsed.include) {
        const pattern = buildLikePattern(word.toLowerCase());
        keywordClause.push(
          '(t.title_norm LIKE ? ESCAPE \'\\\' OR EXISTS (SELECT 1 FROM thought_synonyms_v ts' +
            ' WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE \'\\\'))',
        );
        keywordParams.push(pattern, pattern);
      }
      for (const word of parsed.exclude) {
        const pattern = buildLikePattern(word.toLowerCase());
        keywordClause.push(
          'NOT (t.title_norm LIKE ? ESCAPE \'\\\' OR EXISTS (SELECT 1 FROM thought_synonyms_v ts' +
            ' WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE \'\\\'))',
        );
        keywordParams.push(pattern, pattern);
      }
    }
    const whereKeyword = keywordClause.length > 0 ? ` AND ${keywordClause.join(' AND ')}` : '';

    // First: the candidates that match the type + keyword filter. Apply
    // title/synonyms inclusion order via a stable secondary sort.
    const rows = ndb
      .prepare(
        `SELECT t.id AS id, t.title AS title, t.type_id AS type_id
           FROM thoughts_v t
          WHERE t.type_id IN (${placeholders})
            AND t.active = 1
            AND t.marked_for_deletion = 0${whereKeyword}
          ORDER BY t.title COLLATE NOCASE ASC, t.created_at ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, ...keywordParams, limit, offset) as Array<{
      id: string;
      title: string;
      type_id: string | null;
    }>;
    if (rows.length === 0) return [];

    // Bulk-fetch synonyms for the page (one extra query).
    const ids = rows.map((r) => r.id);
    const idPlaceholders = ids.map(() => '?').join(',');
    const synRows = ndb
      .prepare(
        `SELECT thought_id, synonym FROM thought_synonyms_v
          WHERE thought_id IN (${idPlaceholders})
          ORDER BY thought_id, synonym`,
      )
      .all(...ids) as Array<{ thought_id: string; synonym: string }>;
    const synonymsById = new Map<string, string[]>();
    for (const row of synRows) {
      const list = synonymsById.get(row.thought_id);
      if (list === undefined) {
        synonymsById.set(row.thought_id, [row.synonym]);
      } else {
        list.push(row.synonym);
      }
    }

    return rows.map((row) => {
      const preview = buildInstructionsPreview(ndb, row.id);
      return {
        id: row.id,
        title: row.title,
        synonyms: synonymsById.get(row.id) ?? [],
        preview,
        type_id: row.type_id,
      };
    });
  }

  mcp.registerTool(
    'etn.instructions',
    {
      title: 'Витрина инструкций сети',
      description:
        'Read the network\'s instructions. Three modes: `{ network_id, instruction_id }` returns the FULL ' +
        'permanent comment (no truncation); `{ network_id, keywords }` filters by title+synonyms (mini-syntax: ' +
        'whitespace-AND, `-word` exclusion); `{ network_id }` returns every active instruction. When the network ' +
        'has not declared the `instructions` role → `{ has_instructions: false, instructions: [] }`.',
      inputSchema: z.union([
        InstructionsByIdSchema,
        InstructionsByKeywordsSchema,
        InstructionsAllSchema,
      ]),
      annotations: MCP_TOOL_ANNOTATIONS['etn.instructions'],
    },
    (args) => {
      // Discriminate by the optional fields the caller provided. The schema is
      // a union so TS keeps the args type wide; narrow it manually.
      if ('instruction_id' in args) {
        const idArgs = args as z.infer<typeof InstructionsByIdSchema>;
        return runTool(async () => {
          const network = rt.deps.systemDb.getNetworkById(idArgs.network_id);
          if (network === null) {
            throw new EtnError('NOT_FOUND', `Сеть ${idArgs.network_id} не найдена.`, {
              network_id: idArgs.network_id,
            });
          }
          assertNetworkAccess(rt, idArgs.network_id);
          const roleTypeId = network.type_roles.instructions;
          if (typeof roleTypeId !== 'string') {
            return {
              network_id: idArgs.network_id,
              has_instructions: false as const,
              instructions: [],
            };
          }
          const ndb = openNetworkDb(rt.deps.dataDir, idArgs.network_id, rt.deps.logger);
          const instructionsTypeIds = expandTypeIdsToSubtree(ndb, 'thought_types', [roleTypeId]);
          if (instructionsTypeIds.length === 0) {
            throw new EtnError(
              'NOT_FOUND',
              `Инструкция ${idArgs.instruction_id} не найдена — роль «instructions» не покрывает ни одного типа.`,
              { instruction_id: idArgs.instruction_id, network_id: idArgs.network_id },
            );
          }
          const placeholders = instructionsTypeIds.map(() => '?').join(',');
          const row = ndb
            .prepare(
              `SELECT t.id AS id, t.title AS title, t.type_id AS type_id, t.active AS active,
                      t.marked_for_deletion AS marked_for_deletion
                 FROM thoughts_v t
                WHERE t.id = ? AND t.type_id IN (${placeholders})
                LIMIT 1`,
            )
            .get(idArgs.instruction_id, ...instructionsTypeIds) as
            | {
                id: string;
                title: string;
                type_id: string | null;
                active: number;
                marked_for_deletion: number;
              }
            | undefined;
          if (row === undefined) {
            throw new EtnError(
              'NOT_FOUND',
              `Инструкция ${idArgs.instruction_id} не найдена среди активных мыслей роли «instructions».`,
              { instruction_id: idArgs.instruction_id, network_id: idArgs.network_id },
            );
          }
          if (row.active !== 1 || row.marked_for_deletion !== 0) {
            throw new EtnError(
              'NOT_FOUND',
              `Инструкция ${idArgs.instruction_id} неактуальна или помечена на удаление.`,
              { instruction_id: idArgs.instruction_id, network_id: idArgs.network_id },
            );
          }
          // Full body (no truncation) per spec 14b0cc4f.
          const permanent = getPermanentFull(ndb, 'thought', row.id);
          return {
            network_id: idArgs.network_id,
            has_instructions: true as const,
            instruction_id: row.id,
            title: row.title,
            type_id: row.type_id,
            body_md: permanent === null ? null : permanent.body_md,
          };
        });
      }
      const listArgs = args as z.infer<typeof InstructionsByKeywordsSchema | typeof InstructionsAllSchema>;
      const keywords =
        'keywords' in listArgs && typeof listArgs.keywords === 'string'
          ? listArgs.keywords
          : undefined;
      return runTool(async () => {
        const network = rt.deps.systemDb.getNetworkById(listArgs.network_id);
        if (network === null) {
          throw new EtnError('NOT_FOUND', `Сеть ${listArgs.network_id} не найдена.`, {
            network_id: listArgs.network_id,
          });
        }
        assertNetworkAccess(rt, listArgs.network_id);
        const roleTypeId = network.type_roles.instructions;
        if (typeof roleTypeId !== 'string') {
          return {
            network_id: listArgs.network_id,
            has_instructions: false as const,
            instructions: [],
          };
        }
        const ndb = openNetworkDb(rt.deps.dataDir, listArgs.network_id, rt.deps.logger);
        const instructionsTypeIds = expandTypeIdsToSubtree(ndb, 'thought_types', [roleTypeId]);
        if (instructionsTypeIds.length === 0) {
          return {
            network_id: listArgs.network_id,
            has_instructions: true as const,
            instructions: [],
            meta: { total: 0 },
          };
        }
        const limit = Math.min(Math.max(listArgs.limit ?? 50, 1), 200);
        const offset = Math.max(listArgs.offset ?? 0, 0);
        const placeholders = instructionsTypeIds.map(() => '?').join(',');
        const keywordClause: string[] = [];
        const keywordParams: unknown[] = [];
        if (keywords !== undefined && keywords.trim() !== '') {
          const parsed = parseFilterKeywords(keywords);
          for (const word of parsed.include) {
            const pattern = buildLikePattern(word.toLowerCase());
            keywordClause.push(
              '(t.title_norm LIKE ? ESCAPE \'\\\' OR EXISTS (SELECT 1 FROM thought_synonyms_v ts' +
                ' WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE \'\\\'))',
            );
            keywordParams.push(pattern, pattern);
          }
          for (const word of parsed.exclude) {
            const pattern = buildLikePattern(word.toLowerCase());
            keywordClause.push(
              'NOT (t.title_norm LIKE ? ESCAPE \'\\\' OR EXISTS (SELECT 1 FROM thought_synonyms_v ts' +
                ' WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE \'\\\'))',
            );
            keywordParams.push(pattern, pattern);
          }
        }
        const whereKeyword = keywordClause.length > 0 ? ` AND ${keywordClause.join(' AND ')}` : '';
        const totalRow = ndb
          .prepare(
            `SELECT COUNT(*) AS c
               FROM thoughts_v t
              WHERE t.type_id IN (${placeholders})
                AND t.active = 1
                AND t.marked_for_deletion = 0${whereKeyword}`,
          )
          .get(...instructionsTypeIds, ...keywordParams) as { c: number };
        const instructions = fetchInstructionsList(
          ndb,
          instructionsTypeIds,
          keywords,
          limit,
          offset,
        );
        return {
          network_id: listArgs.network_id,
          has_instructions: true as const,
          instructions,
          meta: { total: totalRow.c, matched: keywords !== undefined ? totalRow.c : undefined },
        };
      });
    },
  );

  // =========================================================================
  // `etn.ontology.write` / `etn.ontology.delete` — задача cc9ca65e, 0.7.2.
  //
  // Управление онтологией сети (типы мыслей/связей, реестр свойств,
  // привязки свойств к типам) одной транзакцией.
  //
  // * `etn.ontology.write` — идемпотентный upsert пакетами `thought_types[]` /
  //   `link_types[]` / `properties[]` / `type_properties[]`. Локальные `ref`/
  //   `parent_ref`/`type_ref`/`property_ref` действуют только внутри батча.
  //   Повторный вызов с теми же аргументами не меняет состояние (action =
  //   `unchanged` на каждом элементе).
  // * `etn.ontology.delete` — деструктивное удаление одной сущности; без
  //   `force` отвергается на используемых элементах со счётчиками в
  //   `details`. Элемент, занятый в `type_roles` сети, отвергается даже
  //   с `force`.
  //
  // На каждый вызов — одна запись бюджета и одна строка `audit_log`. Real-time
  // события — по одному на изменённую сущность (`thought-type.*`,
  // `link-type.*`, `property-registry.*`, `property-definition.*`).
  // =========================================================================

  const OntologyWriteThoughtTypeSchema = z
    .object({
      ref: z.string().min(1).optional(),
      id: z.string().min(1).nullable().optional(),
      name: z.string().min(1).optional(),
      parent: z.string().min(1).nullable().optional(),
      parent_ref: z.string().min(1).nullable().optional(),
      description: z.string().nullable().optional(),
      icon: z.string().nullable().optional(),
      icon_kind: z.enum(ICON_KINDS).optional(),
      fg_color: z.string().nullable().optional(),
      bg_color: z.string().nullable().optional(),
      font_bold: z.boolean().nullable().optional(),
      font_italic: z.boolean().nullable().optional(),
      font_underline: z.boolean().nullable().optional(),
      font_strike: z.boolean().nullable().optional(),
      comment_template_md: z.string().nullable().optional(),
    })
    .strict();
  const OntologyWriteLinkTypeSchema = z
    .object({
      ref: z.string().min(1).optional(),
      id: z.string().min(1).nullable().optional(),
      name_forward: z.string().min(1).optional(),
      name_reverse: z.string().min(1).optional(),
      parent: z.string().min(1).nullable().optional(),
      parent_ref: z.string().min(1).nullable().optional(),
      color: z.string().nullable().optional(),
      style: z.enum(['solid', 'dashed', 'dotted']).nullable().optional(),
      width: z.number().int().min(1).max(20).nullable().optional(),
      description: z.string().nullable().optional(),
    })
    .strict();
  const OntologyWritePropertySchema = z
    .object({
      ref: z.string().min(1).optional(),
      id: z.string().min(1).nullable().optional(),
      name: z.string().min(1).optional(),
      value_type: z.enum(PROPERTY_VALUE_TYPES).optional(),
      config: z.record(z.string(), z.unknown()).nullable().optional(),
      description: z.string().nullable().optional(),
    })
    .strict();
  const OntologyWriteTypePropertySchema = z
    .object({
      owner: z.enum(TYPE_OWNER_TYPES),
      type: z.string().min(1).optional(),
      type_ref: z.string().min(1).optional(),
      property: z.string().min(1).optional(),
      property_ref: z.string().min(1).optional(),
      required: z.boolean().optional(),
      position: z.number().int().min(0).optional(),
    })
    .strict();
  const OntologyWriteSchema = z.object({
    network_id: NetworkId,
    thought_types: z.array(OntologyWriteThoughtTypeSchema).optional(),
    link_types: z.array(OntologyWriteLinkTypeSchema).optional(),
    properties: z.array(OntologyWritePropertySchema).optional(),
    type_properties: z.array(OntologyWriteTypePropertySchema).optional(),
  });
  mcp.registerTool(
    'etn.ontology.write',
    {
      title: 'Батч-запись онтологии',
      description:
        'Идемпотентный upsert онтологии сети одной транзакцией: `thought_types[]` / `link_types[]` / ' +
        '`properties[]` / `type_properties[]`. Upsert по `id` XOR имени — повторный вызов с теми же ' +
        'аргументами не меняет состояние (`action: unchanged` для каждого элемента). Локальные `ref` ' +
        '(`parent_ref` для типов, `type_ref`/`property_ref` для привязок) действуют только внутри батча. ' +
        'Цикл `parent_ref` → VALIDATION_ERROR. Смена `value_type` свойства использует ту же доменную ' +
        'функцию конверсии, что `PATCH /properties/{id}`; ответ несёт `converted_values`/`dropped_values`. ' +
        'Один write-бюджет + одна строка `audit_log` на ВЕСЬ вызов; real-time события — по одному на ' +
        'изменённую сущность (`thought-type.*`, `link-type.*`, `property-registry.*`, ' +
        '`property-definition.*`).',
      inputSchema: OntologyWriteSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.ontology.write'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const writeInput: OntologyWriteParams = {
          network_id: args.network_id,
          ...(args.thought_types !== undefined ? { thought_types: args.thought_types } : {}),
          ...(args.link_types !== undefined ? { link_types: args.link_types } : {}),
          ...(args.properties !== undefined ? { properties: args.properties } : {}),
          ...(args.type_properties !== undefined ? { type_properties: args.type_properties } : {}),
        };
        const result = writeOntology(ndb, writeInput, rt.deps.auth.userId);

        // Real-time + activity log: по одной записи на изменённую сущность.
        // Снимок для удалённого берётся ДО мутации (тут мутация уже
        // произошла — но мы используем `unchanged` как маркер для пропуска).
        for (const item of result.thought_types) {
          if (item.action === 'unchanged') continue;
          // After create/update — read back the type for the snapshot.
          const thoughtType = getThoughtType(ndb, item.id);
          if (thoughtType === null) continue;
          if (item.action === 'created') {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'thought-type.created',
              { type: thoughtType },
              ndb,
              extra.requestId,
            );
          } else {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'thought-type.updated',
              { id: item.id, version: item.version, changes: {} },
              ndb,
              extra.requestId,
            );
          }
        }
        for (const item of result.link_types) {
          if (item.action === 'unchanged') continue;
          const linkType = getLinkType(ndb, item.id);
          if (linkType === null) continue;
          if (item.action === 'created') {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'link-type.created',
              { type: linkType },
              ndb,
              extra.requestId,
            );
          } else {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'link-type.updated',
              { id: item.id, version: item.version, changes: {} },
              ndb,
              extra.requestId,
            );
          }
        }
        for (const item of result.properties) {
          if (item.action === 'unchanged') continue;
          const prop = getNetworkProperty(ndb, item.id);
          if (prop === null) continue;
          if (item.action === 'created') {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'property-registry.created',
              { property: prop },
              ndb,
              extra.requestId,
            );
          } else {
            emitAgentActivityEvent(
              rt,
              args.network_id,
              'property-registry.updated',
              {
                id: item.id,
                converted: item.converted_values,
                dropped: item.dropped_values,
                changes: {},
              },
              ndb,
              extra.requestId,
            );
          }
        }
        for (const item of result.type_properties) {
          if (item.action === 'unchanged') continue;
          // Подключение свойства — это правка типа-владельца; в журнале
          // фиксируем как обновление самого типа (требование b0c7a57c).
          // Перечитываем привязку после её создания/обновления, чтобы
          // передать полный snapshot в payload `property-definition.*`.
          const defRow = ndb
            .prepare(
              `SELECT id, owner_type, owner_id, property_id, required, position
                 FROM type_properties_v WHERE id = ?`,
            )
            .get(item.id) as
            | {
                id: string;
                owner_type: 'thought_type' | 'link_type';
                owner_id: string;
                property_id: string;
                required: number;
                position: number;
              }
            | undefined;
          if (defRow === undefined) continue;
          const propertyRow = getNetworkProperty(ndb, defRow.property_id);
          if (propertyRow === null) continue;
          const definitionPayload = {
            id: defRow.id,
            property_id: defRow.property_id,
            owner_type: defRow.owner_type,
            owner_id: defRow.owner_id,
            key: propertyRow.name,
            value_type: propertyRow.value_type,
            config: propertyRow.config,
            required: defRow.required === 1,
            position: defRow.position,
            description: propertyRow.description,
          };
          emitAgentActivityEvent(
            rt,
              args.network_id,
              'property-definition.created',
              {
                definition: definitionPayload,
              },
              ndb,
              extra.requestId,
            );
          }

        // ONE audit row for the whole batch.
        auditAgentCall(
          rt,
          'etn.ontology.write',
          args.network_id,
          'network',
          args.network_id,
          {
            thought_types_count: result.thought_types.length,
            link_types_count: result.link_types.length,
            properties_count: result.properties.length,
            type_properties_count: result.type_properties.length,
          },
        );

        const layer = resolveRuntimeLayer(rt, args.network_id);
        return {
          ...result,
          layer: { id: layer.id, title: layer.title },
          request_id: String(extra.requestId),
        } satisfies OntologyWriteResult & { layer: { id: string; title: string }; request_id: string };
      }),
  );

  const OntologyDeleteSchema = z.object({
    network_id: NetworkId,
    kind: z.enum(['thought_type', 'link_type', 'property', 'type_property']),
    id: z.string().min(1),
    force: z.boolean().optional(),
  });
  mcp.registerTool(
    'etn.ontology.delete',
    {
      title: 'Удалить элемент онтологии',
      description:
        'Удалить одну сущность онтологии (`thought_type` / `link_type` / `property` / `type_property`). ' +
        'Без `force` отвергается на используемых элементах со счётчиками в `details` ' +
        '(`thoughts_count` / `links_count` / `property_values_count` / `type_properties_count`). ' +
        'С `force` — каскад по правилам: `thought_type` обнуляет `type_id` связанных мыслей + ' +
        '`type_properties`; `link_type` удаляет связи этого типа (со свойствами и комментариями) + ' +
        '`type_properties`; `property` удаляет `property_values` + `type_properties`; `type_property` ' +
        'удаляет строку привязки. Элемент, занятый в `type_roles` сети, отвергается даже с `force`. ' +
        'HOME-мысль не имеет типа и не задевается. Один write-бюджет + одна строка `audit_log`.',
      inputSchema: OntologyDeleteSchema,
      annotations: MCP_TOOL_ANNOTATIONS['etn.ontology.delete'],
    },
    (args, extra) =>
      runWriteTool(rt, args.network_id, async () => {
        requireWritable(rt);
        requireWriteBudget(rt);
        const ndb = openMemberNetwork(rt, args.network_id);
        const network = rt.deps.systemDb.getNetworkById(args.network_id);
        const networkRoles = network?.type_roles ?? {};
        // Pre-fetch snapshots BEFORE the mutation, to record accurate activity rows.
        let snapshot: unknown = null;
        try {
          if (args.kind === 'thought_type') {
            snapshot = getThoughtType(ndb, args.id);
          } else if (args.kind === 'link_type') {
            snapshot = getLinkType(ndb, args.id);
          } else if (args.kind === 'property') {
            snapshot = getNetworkProperty(ndb, args.id);
          }
        } catch {
          snapshot = null;
        }
        const deleteInput: OntologyDeleteParams = {
          network_id: args.network_id,
          kind: args.kind,
          id: args.id,
          ...(args.force !== undefined ? { force: args.force } : {}),
        };
        const result: OntologyDeleteResult = deleteOntologyEntity(
          ndb,
          deleteInput,
          rt.deps.auth.userId,
          networkRoles,
        );

        // Real-time + activity log (mirror REST).
        if (snapshot !== null && snapshot !== undefined) {
          if (args.kind === 'thought_type') {
            emitAgentEvent(
              rt,
              args.network_id,
              'thought-type.deleted',
              { id: args.id },
              extra.requestId,
            );
          } else if (args.kind === 'link_type') {
            emitAgentEvent(
              rt,
              args.network_id,
              'link-type.deleted',
              { id: args.id },
              extra.requestId,
            );
          } else if (args.kind === 'property') {
            emitAgentEvent(
              rt,
              args.network_id,
              'property-registry.deleted',
              { id: args.id },
              extra.requestId,
            );
          }
        }

        // ONE audit row for the whole call.
        auditAgentCall(
          rt,
          'etn.ontology.delete',
          args.network_id,
          args.kind,
          args.id,
          {
            force: args.force === true,
            affected_counts: result.affected_counts,
          },
        );

        return {
          ...result,
          request_id: String(extra.requestId),
        } satisfies OntologyDeleteResult & { request_id: string };
      }),
  );
}
