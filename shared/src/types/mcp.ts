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
import type { ActivityRow } from './activity.js';
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
  'etn.instructions',
  'etn.thoughts.search',
  'etn.thoughts.query',
  'etn.thoughts.get',
  'etn.thoughts.resolve',
  'etn.thoughts.bulk_update',
  'etn.thoughts.neighbors',
  'etn.thoughts.subgraph',
  'etn.thoughts.path',
  'etn.thoughts.mentions',
  'etn.thoughts.backlinks',
  'etn.thoughts.usage',
  'etn.thoughts.deletion_check',
  'etn.trash.list',
  'etn.comments.get',
  'etn.export.subgraph',
  'etn.types.list',
  // `etn.views.run` (задача c1fa71d4, 0.7.3, операция cb8d8e43) — исполнение
  // именованного отбора типа относительно конкретной мысли. Read-only:
  // бюджет записи не тратит, `audit_log` не пишет.
  'etn.views.run',
  'etn.changes.list',
  'etn.chronicle.query',
  'etn.members.list',
  'etn.metrics.reads',
  'etn.metrics.tools',
  'etn.layers.list',
  'etn.layers.diff',
  'etn.layers.diff_doc',
  // mutate (§4.2)
  'etn.networks.write',
  'etn.networks.delete',
  'etn.thoughts.create',
  'etn.thoughts.update',
  'etn.thoughts.delete',
  'etn.thoughts.trash',
  'etn.thoughts.set_active',
  'etn.links.restore',
  'etn.comments.upsert',
  'etn.comments.update',
  'etn.comments.edit',
  'etn.comments.delete',
  'etn.attachments.add',
  'etn.attachments.copy',
  'etn.attachments.search',
  'etn.attachments.update',
  'etn.attachments.delete',
  'etn.properties.set',
  'etn.properties.add',
  'etn.properties.remove',
  'etn.thoughts.upsert_bundle',
  // `etn.thoughts.write` (task 053751b5, 0.7.2) — батч-запись: одна транзакция
  // для многих связанных единиц знания (мысли + постоянные/хронологические
  // комментарии + свойства + связи с их свойствами и комментариями + вложения).
  // Поглощает `thoughts.create`/`update`/`set_active`/`upsert_bundle`,
  // `links.create`, `properties.set`, `comments.upsert` — они помечены
  // `deprecated_since: '0.7.2'` ниже, `registerTools` их пропускает.
  'etn.thoughts.write',
  'etn.trash.purge',
  'etn.thoughts.usage_clear',
  // layers (S10, §4.2)
  'etn.layers.create',
  'etn.layers.update',
  'etn.layers.delete',
  'etn.layers.select',
  'etn.layers.merge',
  // object-locks (task a88acf20, операция b6b776ff — паритет с REST /locks)
  'etn.locks.acquire',
  'etn.locks.release',
  'etn.locks.clear',
  'etn.locks.list',
  // activity log (task f2eca5a4, операция 70dfe81d — паритет с REST /activity)
  'etn.activity.list',
  // activity log maintenance (задача 6bcccd2b — паритет с REST /activity/rollup, /activity/truncate)
  'etn.activity.rollup',
  'etn.activity.truncate',
  // ontology batch ops (задача cc9ca65e / 0.7.2) — батч-запись онтологии сети
  // (типы мыслей/связей, свойства, привязки свойств к типам) и её удаление.
  'etn.ontology.write',
  'etn.ontology.delete',
  // P3 (задача e488f4c1 / 0.7.2): copy_subtree, mentions_scan, импорт/экспорт .etnx
  'etn.thoughts.copy_subtree',
  'etn.thoughts.mentions_scan',
  'etn.import.dry_run',
  'etn.import.subgraph',
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
 * - `deprecated_since` — задача 053751b5, 0.7.2: версия, на которой
 *   инструмент был поглощён `etn.thoughts.write` и снят с `tools/list`.
 *   При наличии поля `registerTools` (`server/src/mcp/tools.ts`) ПРОПУСКАЕТ
 *   регистрацию, поэтому инструмент не виден агентам; обработчик в коде
 *   остаётся на случай, если потребуется быстрый rollback (или пока старый
 *   клиент — например, эта сессия ZCode — не перешёл на `etn.thoughts.write`).
 *
 * All fields are optional on the wire; tools that carry no hints (the
 * remaining mutating tools — `create`/`update`/`links.create`/comments
 * `upsert`+`update`/`attachments.add`+`copy`) are not listed here at all.
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  /** Задача 053751b5 (0.7.2): версия, на которой инструмент поглощён
   *  `etn.thoughts.write`; `registerTools` пропускает регистрацию при
   *  наличии. */
  deprecated_since?: string;
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
  // `etn.instructions` (задача ba024a45 / 0.7.2, ADR 717f04df) — read-only
  // витрина инструкций сети; возвращает превью + список, без изменений.
  'etn.instructions': { readOnlyHint: true },
  'etn.thoughts.search': { readOnlyHint: true },
  'etn.thoughts.query': { readOnlyHint: true },
  'etn.thoughts.get': { readOnlyHint: true },
  'etn.thoughts.resolve': { readOnlyHint: true },
  'etn.thoughts.neighbors': { readOnlyHint: true },
  'etn.thoughts.subgraph': { readOnlyHint: true },
  'etn.thoughts.path': { readOnlyHint: true },
  'etn.thoughts.mentions': { readOnlyHint: true },
  'etn.thoughts.backlinks': { readOnlyHint: true },
  'etn.thoughts.usage': { readOnlyHint: true },
  'etn.thoughts.deletion_check': { readOnlyHint: true },
  'etn.trash.list': { readOnlyHint: true },
  'etn.comments.get': { readOnlyHint: true },
  'etn.export.subgraph': { readOnlyHint: true },
  'etn.types.list': { readOnlyHint: true },
  // `etn.views.run` (задача c1fa71d4, 0.7.3) — read-only исполнение отбора;
  // не пишет событий и audit_log, всегда идемпотентно для одного набора аргументов.
  'etn.views.run': { readOnlyHint: true },
  'etn.changes.list': { readOnlyHint: true },
  'etn.chronicle.query': { readOnlyHint: true },
  'etn.metrics.reads': { readOnlyHint: true },
  'etn.metrics.tools': { readOnlyHint: true },
  'etn.attachments.search': { readOnlyHint: true },
  'etn.thoughts.find_duplicates': { readOnlyHint: true },
  'etn.layers.list': { readOnlyHint: true },
  'etn.layers.diff': { readOnlyHint: true },
  'etn.layers.diff_doc': { readOnlyHint: true },
  'etn.locks.list': { readOnlyHint: true },
  'etn.activity.list': { readOnlyHint: true },
  'etn.members.list': { readOnlyHint: true },

  // ---- mutating tools — destructiveHint ---------------------------
  'etn.thoughts.delete': { destructiveHint: true },
  'etn.thoughts.bulk_update': { destructiveHint: false, idempotentHint: false },
  'etn.comments.delete': { destructiveHint: true },
  'etn.attachments.delete': { destructiveHint: true },
  'etn.trash.purge': { destructiveHint: true },
  'etn.layers.delete': { destructiveHint: true },
  'etn.layers.merge': { destructiveHint: true },
  'etn.locks.release': { destructiveHint: true },
  'etn.locks.clear': { destructiveHint: true },
  'etn.activity.rollup': { destructiveHint: true },
  'etn.activity.truncate': { destructiveHint: true },
  // `etn.networks.delete` (задача ba024a45 / 0.7.2) — деструктивный;
  // дополнительно требует `confirm: true` в аргументах.
  'etn.networks.delete': { destructiveHint: true },
  // `etn.networks.write` — upsert (create или patch); повторный вызов с теми
  // же аргументами даёт тот же результат.
  'etn.networks.write': { destructiveHint: false, idempotentHint: true },

  // ---- mutating tools — idempotentHint ----------------------------
  'etn.thoughts.set_active': { idempotentHint: true, deprecated_since: '0.7.2' },
  'etn.thoughts.trash': { idempotentHint: true },
  'etn.links.restore': { idempotentHint: true },
  'etn.properties.set': { idempotentHint: true, deprecated_since: '0.7.2' },
  'etn.properties.add': { idempotentHint: true },
  'etn.properties.remove': { idempotentHint: true },
  'etn.thoughts.upsert_bundle': { idempotentHint: true, deprecated_since: '0.7.2' },
  'etn.layers.update': { idempotentHint: true },
  'etn.layers.select': { idempotentHint: true },
  // Object-lock acquire — идемпотентно продлевает свой захват (задача 2031df5e).
  'etn.locks.acquire': { idempotentHint: true },
  // `attachments.update` — last-write-wins по метаданным, повторный вызов с теми же аргументами даёт тот же результат.
  'etn.attachments.update': { idempotentHint: true },
  // `etn.comments.edit` (задача d28abe04) — секционная правка ops-ами;
  // повторный вызов с теми же ops поверх нового состояния меняет результат.
  'etn.comments.edit': { readOnlyHint: false, destructiveHint: false, idempotentHint: false },

  // ---- задача 053751b5 / 0.7.2 — поглощённые `etn.thoughts.write` --------
  // Эти 7 инструментов остаются в `MCP_TOOL_NAMES` и в коде `registerTools`,
  // но `deprecated_since` заставляет `registerTools` пропустить их регистрацию.
  // Обработчики сохранены для отката и для старых клиентов в период миграции.
  'etn.thoughts.create': { deprecated_since: '0.7.2' },
  'etn.thoughts.update': { deprecated_since: '0.7.2' },
  'etn.comments.upsert': { deprecated_since: '0.7.2' },

  // ---- `etn.thoughts.write` (задача 053751b5 / 0.7.2) — главный пишущий ----
  // Батч 1..50 связанных единиц знания одной транзакцией: одна запись бюджета,
  // одна строка audit_log с `thought_count`/`link_count`. Upsert-семантика
  // (`on_duplicate: reuse`/`update`/`fail`) — повторный вызов с теми же
  // аргументами даёт тот же результат.
  'etn.thoughts.write': { destructiveHint: false, idempotentHint: true },

  // ---- `etn.ontology.write` / `etn.ontology.delete` (задача cc9ca65e / 0.7.2) -
  // Управление онтологией сети (типы мыслей/связей, реестр свойств, привязки
  // свойств к типам) одной транзакцией. Upsert по `id` XOR имени внутри
  // батча; локальные `ref`/`parent_ref`/`type_ref`/`property_ref`. Повторный
  // вызов с теми же аргументами не меняет состояние. Удаление деструктивно,
  // требует `force` для используемых сущностей.
  'etn.ontology.write': { destructiveHint: false, idempotentHint: true },
  'etn.ontology.delete': { destructiveHint: true },

  // ---- P3 (задача e488f4c1 / 0.7.2) -------------------------------------
  // `etn.thoughts.copy_subtree` — копирование подграфа между сетями. Семантика
  // зависит от `duplicate_policy`; в общем случае не идемпотентно (новые
  // id при повторе).
  'etn.thoughts.copy_subtree': { destructiveHint: false, idempotentHint: false },
  // `etn.thoughts.mentions_scan` — без `create_links` чисто read-only.
  // С `create_links: true` создаёт связи — мутация.
  'etn.thoughts.mentions_scan': { readOnlyHint: true },
  // `etn.import.dry_run` — read-only превью без побочных эффектов.
  'etn.import.dry_run': { readOnlyHint: true },
  // `etn.import.subgraph` — destructive: одна транзакция вносит мысли, связи,
  // комментарии и вложения в целевую сеть. `confirm: true` обязателен.
  'etn.import.subgraph': { destructiveHint: true },
};

/** All prompt names exposed by the ETN MCP server (05-mcp-server.md §5).
 *
 *  Two groups: workflow templates (`etn.summarize_thought` & co) and the
 *  procedural `etn.how_to_*` explainers of the progressive-disclosure ADR
 *  (task 940a499d, ADR b2eebf8b level 1) — detailed how-to knowledge for the
 *  rare complex operations, kept out of `tools/list` descriptions. */
export const MCP_PROMPT_NAMES = [
  'etn.summarize_thought',
  'etn.suggest_links',
  'etn.detect_duplicates',
  'etn.generate_report',
  'etn.how_to_merge_partial',
  'etn.how_to_purge',
  // `etn.how_to_write_batch` (задача 053751b5 / 0.7.2) — пошаговая инструкция
  // для `etn.thoughts.write`: локальные `ref`/`target_ref`, циклы, лимиты,
  // миграция с поглощённых инструментов.
  'etn.how_to_write_batch',
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
 *  effective property list (own + inherited along the L21 chain) +
 *  собственные отборы (задача c1fa71d4, 0.7.3): без наследования от предков
 *  (это контракт `etn.types.list` для типов; эффективный набор для конкретной
 *  мысли — через `etn.thoughts.get { meta.views }`). */
export interface McpThoughtTypeEntry extends ThoughtTypeRef {
  properties: EffectiveTypeProperty[];
  views: McpThoughtTypeViewEntry[];
}

/**
 * Один собственный отбор типа мысли в `etn.types.list` (задача c1fa71d4,
 * 0.7.3). `definition` намеренно не включается — для каталога типов
 * достаточно имени и описания, а полное исполнение даёт `etn.views.run`.
 */
export interface McpThoughtTypeViewEntry {
  id: string;
  name: string;
  name_key: string;
  description: string | null;
  position: number;
  is_default: boolean;
}

/** A link type entry of `etn.types.list`: {@link LinkTypeRef} + its effective
 *  property list (own + inherited along the L21 chain). */
export interface McpLinkTypeEntry extends LinkTypeRef {
  properties: EffectiveTypeProperty[];
}

/** Which catalogue(s) `etn.types.list` returns (05-mcp-server.md §5.1b). */
export const TYPES_LIST_SCOPES = ['thoughts', 'links', 'all'] as const;
export type TypesListScope = (typeof TYPES_LIST_SCOPES)[number];

/**
 * Reason `etn.types.list` had to shrink its payload (task f9c7dbc5, 0.7.4).
 *
 *  - `max_chars_preview` — the byte budget was met after shrinking every type
 *    `description` to {@link TYPES_LIST_BUDGET_PREVIEW_CHARS}.
 *  - `max_chars_items` — even with shortened descriptions the response did not
 *    fit, so the server additionally dropped whole type entries from the tail
 *    of each catalogue (`thought_types` before `link_types`).
 */
export type McpTypesListTruncationReason =
  | 'max_chars_preview'
  | 'max_chars_items';

/**
 * Soft-cap on each type's `description` body used by the first shrink step
 * of `etn.types.list`'s `max_chars` budgeter. Chosen to fit comfortably under
 * the default MCP-client `maxModelBytes=50000` when combined with 2–3
 * mid-sized catalogues — far below the per-comment preview used by
 * {@link SUBGRAPH_BUDGET_PREVIEW_CHARS} because type entries are densely
 * packed in the JSON envelope.
 */
export const TYPES_LIST_BUDGET_PREVIEW_CHARS = 200;

/**
 * Diagnostics block returned by `etn.types.list` whenever pagination or the
 * `max_chars` budget kicked in. Echo of the original payload size lets the
 * agent decide whether to retry with a tighter `limit`/`max_chars`.
 */
export interface McpTypesListMeta {
  /** True when the response had to be shrunk. */
  truncated?: boolean;
  /** Why the shrink ran; `null`/absent when nothing was trimmed. */
  reason?: McpTypesListTruncationReason | null;
  /** Total `thought_types` available before pagination/trim (excluding the
   *  `link_types` half). Absent when `scope` skips thought types. */
  thought_types_total?: number;
  /** Total `link_types` available before pagination/trim. Absent when `scope`
   *  skips link types. */
  link_types_total?: number;
  /** Echo of the requested `limit`; absent when not set. */
  limit?: number;
  /** Echo of the requested `offset`; absent when not set. */
  offset?: number;
  /** Echo of the `max_chars` budget that triggered shrinking; absent when the
   *  caller did not set `max_chars` and nothing was trimmed. */
  max_chars?: number;
  /** JSON-encoded size of the (untrimmed, fully paginated) payload — present
   *  whenever the shrinker ran, for diagnostics. */
  original_chars?: number;
  /** JSON-encoded size of the final payload after shrinking. */
  final_chars?: number;
}

/** Result of `etn.types.list` — both catalogues in full (not just the types
 *  used in some other response, unlike {@link ThoughtTypeRef}/{@link LinkTypeRef}
 *  reference tables). With `scope: "thoughts"` / `"links"` only the matching
 *  field is present. The optional `meta` block is present whenever pagination
 *  or `max_chars` trimming was applied. */
export interface McpTypesListResult {
  thought_types?: McpThoughtTypeEntry[];
  link_types?: McpLinkTypeEntry[];
  meta?: McpTypesListMeta;
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
     * Role of `target_thought_id` for the NEW thought:
     * `parent` — attach the new thought UNDER the target (target becomes its
     * parent); `child` — the NEW thought becomes the parent of the target.
     * Unified with the REST `create_link.direction` (03-server-api.md §6.3) —
     * both layers share the same semantics, no translation at any boundary.
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

/** Одна операция секционной правки в {@link McpCommentsEditParams.ops}. */
export type McpCommentsEditOp =
  | { op: 'append'; text: string }
  | { op: 'prepend'; text: string }
  | { op: 'replace_section'; section: string; text: string }
  | { op: 'delete_section'; section: string };

/**
 * Parameters of `etn.comments.edit` (05-mcp-server.md §4.2, задача d28abe04,
 * версия 0.7.2). Частичная правка комментария ops-ами одной транзакцией.
 * `comment_id` XOR `thought_id`: первый адресует любой комментарий, второй —
 * постоянный комментарий мысли. Ops применяются последовательно; ошибка
 * откатывает весь вызов.
 */
export interface McpCommentsEditParams {
  network_id: string;
  comment_id?: string;
  thought_id?: string;
  expected_version?: number;
  ops: McpCommentsEditOp[];
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
     * Role of `target_thought_id` for the bundle thought:
     * `parent` — attach the bundle thought UNDER the target (target becomes
     * its parent); `child` — the bundle thought becomes the parent of the
     * target. Unified with the domain/REST direction — no translation at any
     * boundary.
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

// ---------------------------------------------------------------------------
// `etn.thoughts.write` (task 053751b5, версия 0.7.2) — батч-запись связанных
// единиц знания одной транзакцией. Поглощает `etn.thoughts.create`/`update`/
// `set_active`/`upsert_bundle`, `etn.links.create`, `etn.properties.set`,
// `etn.comments.upsert` (помечены `deprecated_since: '0.7.2'`, регистрация
// в `tools/list` пропускается).
// ---------------------------------------------------------------------------

/** Один элемент хронологической записи в `etn.thoughts.write` (см. также
 *  `McpCommentsUpsertParams` с `kind: 'chronological'`). */
export interface McpThoughtWriteChronicleItem {
  title?: string | null;
  body_md: string;
  valid_from?: string;
  valid_to?: string | null;
}

/** Одна вложенная единица знания на связи внутри батча:
 *  свойства и (опционально) постоянный комментарий. */
export interface McpThoughtWriteLinkSpec {
  /**
   * Role of `target_*` for the NEW thought: "parent" — attach the batch
   * thought UNDER the target (target becomes its parent); "child" — the
   * batch thought becomes the parent of the target. Unified with the MCP
   * `etn.thoughts.create` link and `etn.thoughts.upsert_bundle` semantics.
   */
  direction: 'parent' | 'child';
  /** Exactly one of `target_id` (existing thought) or `target_ref` (a ref
   *  declared elsewhere in the same batch). */
  target_id?: string;
  /** Local name of a thought created earlier in this same batch. */
  target_ref?: string;
  type_id?: string | null;
  /** Type resolution by name (see `etn.types.list`); XOR with `type_id`. */
  type?: string;
  /** Map of property key → value applied to the new link. Keys are resolved
   *  against the network property registry by name. */
  properties?: Record<string, PropertyValueValue>;
  /** Permanent comment (create-or-update) attached to the new link. */
  comment?: { title?: string | null; body_md: string };
}

/** Один элемент вложения (mirror `etn.attachments.add`). */
export interface McpThoughtWriteAttachmentSpec {
  kind: AttachmentKind;
  url?: string | null;
  file_path?: string | null;
  title?: string | null;
  description?: string | null;
}

/** Один элемент `thoughts[]` батча `etn.thoughts.write`. */
export interface McpThoughtWriteItem {
  /** Local name within the batch — must be unique across `thoughts[]`.
   *  Used by `links[].target_ref` to address this thought from another
   *  batch item. Required iff `thought` is provided. */
  ref?: string;
  /** Exactly one of `thought_id` (existing thought to patch in-place) or
   *  `thought` (new-or-matched thought resolved via `find_duplicates` +
   *  `on_duplicate`) — same shape as `etn.thoughts.upsert_bundle`. */
  thought_id?: string;
  thought?: {
    title: string;
    synonyms?: string[];
    type_id?: string | null;
    /** Type resolution by name (XOR with `type_id`). */
    type?: string;
    active?: boolean;
  };
  /** How to handle a `find_duplicates` match against `thought.title`/`synonyms`
   *  when `thought_id` is absent. Mirrors `etn.thoughts.upsert_bundle`. */
  on_duplicate?: ThoughtBundleOnDuplicate;
  /** Owner's permanent comment (create-or-update). */
  comment?: { title?: string | null; body_md: string; valid_from?: string; valid_to?: string | null };
  /** Chronicle entries appended (never overwritten) to the owner's comment. */
  chronicle?: McpThoughtWriteChronicleItem[];
  /** Map of property key → value applied to the thought. */
  properties?: Record<string, PropertyValueValue>;
  /** Links attached to this thought, addressed by `target_id` (existing) or
   *  `target_ref` (a ref inside this batch). Cycles via `target_ref` are
   *  allowed: the batch creates all thoughts first, then attaches links. */
  links?: McpThoughtWriteLinkSpec[];
  /** Attachments added to the thought. */
  attachments?: McpThoughtWriteAttachmentSpec[];
}

/** Parameters of `etn.thoughts.write`. */
export interface McpThoughtWriteParams {
  network_id: string;
  /** Additional locally-declared refs that may be used as `links[].target_ref`
   *  in this batch but are not attached to any `thoughts[]` item — typically
   *  an alias for an existing thought (e.g. `{ home_ref: "<HOME uuid>" }`).
   *  Keys must not collide with `thoughts[].ref`. Values must be valid UUIDs
   *  of existing thoughts in the network. */
  local_refs?: Record<string, string>;
  /** The batch — 1..{@link MCP_MAX_THOUGHTS_PER_WRITE} items. */
  thoughts: McpThoughtWriteItem[];
}

/** Один результат per-item: id свежезаписанной/переиспользованной мысли
 *  и сводка по её частям. */
export interface McpThoughtWriteItemResult {
  /** Local `ref` of the batch item; `null` for items addressed by `thought_id`. */
  ref: string | null;
  /** Existing `thought_id` echoed back when the item addressed one. */
  thought_id: string | null;
  /** Resolved thought id — newly created or existing. */
  id: string;
  version: number;
  thought_action: ThoughtBundleThoughtAction;
  matched_on: ThoughtBundleMatchKind | null;
  /** Permanent comment (create-or-update), when the batch item included one. */
  comment?: { id: string; version: number; action: 'created' | 'updated' };
  /** Chronicle entries appended in this batch. */
  chronicle?: Array<{ id: string; version: number }>;
  /** Per-key property value ids set in this batch. */
  properties?: Record<string, { id: string }>;
  /** Link results: id + (if any) attached properties/comments. */
  links?: Array<{
    id: string;
    version: number;
    properties?: Record<string, { id: string }>;
    comment?: { id: string; version: number };
  }>;
  /** Attachment ids added in this batch. */
  attachments?: Array<{ id: string }>;
  /** Card-completeness warnings (task O6) for this item. */
  warnings: ThoughtCardWarning[];
}

/** Result of `etn.thoughts.write`. */
export interface McpThoughtWriteResult {
  /** Per-item results in the same order as `thoughts[]` in the request. */
  items: McpThoughtWriteItemResult[];
  /** Aggregated "card completeness" warnings across the batch — each entry
   *  carries `ref` or `thought_id` so the caller can locate the offender. */
  warnings: ThoughtCardWarning[];
  /** Echo of the network's session layer the batch materialised in. */
  layer: { id: string; title: string };
  request_id?: string;
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
// `etn.activity.list` (task f2eca5a4, 05-mcp-server.md §4.1) — read access
// to the activity log of one network: filters + pagination, sorted by
// `occurred_at_ms DESC`. Паритет с REST `GET /activity`.
// ---------------------------------------------------------------------------

/** Parameters of `etn.activity.list` (05-mcp-server.md §4.1). */
export interface McpActivityListParams {
  network_id: string;
  /** Lower bound on `occurred_at_ms` (inclusive). */
  from_ms?: number;
  /** Upper bound on `occurred_at_ms` (inclusive). */
  to_ms?: number;
  /** Оставить только записи конкретного исполнителя. */
  user_id?: string;
  /** Оставить только записи по сущностям указанного вида. */
  entity_type?: string;
  /** Оставить только записи по конкретной сущности (требует `entity_type`). */
  entity_id?: string;
  /** Размер страницы (default 50, max 200). */
  limit?: number;
  /** Смещение для пагинации. */
  offset?: number;
}

/** Result of `etn.activity.list` — те же данные, что отдаёт REST `GET /activity`. */
export interface McpActivityListResult {
  data: ActivityRow[];
  meta: {
    total: number;
    offset: number;
    limit: number;
  };
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
// `etn.metrics.tools` (task 940a499d, операция 254ba4db, 05-mcp-server.md
// §5.1) — aggregate over `mcp_tool_call_metrics`: how often each MCP tool is
// actually called (successes and errors). The evidence base for decisions
// about the tool roster ("remove / shorten / consolidate").
// ---------------------------------------------------------------------------

/** Grouping grain of `etn.metrics.tools`. */
export type McpMetricsToolsGroupBy = 'tool' | 'tool+network' | 'tool+key';

/** Parameters of `etn.metrics.tools` (05-mcp-server.md §5.1). */
export interface McpMetricsToolsParams {
  /** Restrict the aggregate to one network; omit for all networks. */
  network_id?: string;
  /** Lower bound on `last_call_at` (ms epoch, inclusive). The table is an
   *  aggregate, so the window can only bound the observed interval. */
  from_ms?: number;
  /** Upper bound on `last_call_at` (ms epoch, inclusive). */
  to_ms?: number;
  /** Grouping grain; default `'tool'`. */
  group_by?: McpMetricsToolsGroupBy;
  /** Maximum number of rows; default 50, hard cap 200. */
  limit?: number;
}

/** One row of `etn.metrics.tools`. `network_id` is `null` for network-less
 *  calls (`etn.networks.list` & co) and always `null` under `group_by: 'tool'`;
 *  `api_key_id` is only present under `group_by: 'tool+key'`. */
export interface McpMetricsToolsItem {
  tool_name: string;
  network_id: string | null;
  api_key_id?: string;
  calls_count: number;
  errors_count: number;
  /** `null` until the first call. */
  first_call_at: string | null;
  /** `null` until the first call. */
  last_call_at: string | null;
}

/** Result of `etn.metrics.tools`. */
export interface McpMetricsToolsResult {
  /** Echo of the effective `group_by`. */
  group_by: McpMetricsToolsGroupBy;
  /** Echo of the effective `limit`. */
  limit: number;
  /** Up to `limit` aggregated rows, `calls_count DESC, last_call_at DESC`. */
  items: McpMetricsToolsItem[];
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

// ---------------------------------------------------------------------------
// `etn.thoughts.copy_subtree` (задача e488f4c1, версия 0.7.2) — копирование
// подграфа между сетями. Сервер сам собирает снапшот (root_thought_ids +
// max_depth) и материализует его в `target_network_id` одной транзакцией.
// ---------------------------------------------------------------------------

/** Политика разрешения коллизий имён при копировании. */
export type McpCopySubtreePolicy = 'fail' | 'reuse' | 'skip' | 'create_always';

/** Подмножество включаемых в снапшот частей мысли. По умолчанию — все. */
export type McpCopySubtreeInclude =
  | 'thought'
  | 'links'
  | 'properties'
  | 'comments'
  | 'attachments';

/** Parameters of `etn.thoughts.copy_subtree`. */
export interface McpCopySubtreeParams {
  /** Исходная сеть (откуда читается подграф). */
  source_network_id: string;
  /** Целевая сеть (куда записывается). Может совпадать с `source_network_id`. */
  target_network_id: string;
  /** Корни подграфа — мысли, от которых начинается BFS по связям. */
  root_thought_ids: string[];
  /** Глубина обхода вниз по активным связям. По умолчанию 5, потолок 20. */
  max_depth?: number;
  /** Подмножество переносимых частей. Пусто / не задано — все. */
  include?: McpCopySubtreeInclude[];
  /** Политика коллизий по title+synonyms (см. {@link McpCopySubtreePolicy}). */
  duplicate_policy?: McpCopySubtreePolicy;
  /**
   * Если `true` (по умолчанию) — вернуть `thought_id_map`/`link_id_map`
   * для переписывания wiki-ссылок `[[#oldId]]` → `[[#newId]]` в комментариях.
   */
  id_remap?: boolean;
  /**
   * Куда подвесить вновь созданные корневые мысли (если хоть одна). Если не
   * задано — мысли без входящей копируемой связи остаются «висячими» в
   * целевой сети (подцепятся к HOME).
   */
  target_parent_thought_id?: string;
}

/** Сводка по результатам копирования. */
export interface McpCopySubtreeResult {
  /** Кол-во новых мыслей в целевой сети. */
  thoughts_created: number;
  /** Кол-во переиспользованных (по duplicate_policy=reuse). */
  thoughts_reused: number;
  /** Кол-во пропущенных (по duplicate_policy=skip). */
  thoughts_skipped: number;
  /** Кол-во созданных связей в целевой сети. */
  links_created: number;
  /** Карта `source_thought_id → target_thought_id` для переписывания ссылок. */
  thought_id_map?: Record<string, string>;
  /** Карта `source_link_id → target_link_id` (составной ключ source:target:type). */
  link_id_map?: Record<string, string>;
  /** Список конфликтов при `duplicate_policy=fail`. */
  conflicts?: Array<{ source_thought_id: string; target_thought_id: string; title: string }>;
  /** Идентификатор слоя (для эха). */
  layer: { id: string; title: string };
  /** Сквозной request_id (для трассировки). */
  request_id?: string;
}

// ---------------------------------------------------------------------------
// `etn.thoughts.mentions_scan` (задача e488f4c1, версия 0.7.2) — поиск
// упоминаний мыслей в тексте: FTS по названиям и синонимам + опциональное
// создание связей по результату.
// ---------------------------------------------------------------------------

/** Parameters of `etn.thoughts.mentions_scan`. */
export interface McpMentionsScanParams {
  network_id: string;
  /** Прямой текст для сканирования. Ровно одно из `text` / `source`. */
  text?: string;
  /** Адрес существующего комментария сети. Ровно одно из `text` / `source`. */
  source?: { comment_id?: string; thought_id?: string };
  /** Учитывать регистр. По умолчанию `false`. */
  case_sensitive?: boolean;
  /** Учитывать синонимы. По умолчанию `true`. */
  use_synonyms?: boolean;
  /** Разрешать `*`-инфикс в шаблонах названий/синонимов. По умолчанию `true`. */
  use_wildcards?: boolean;
  /** Порог уверенности 0.0–1.0; совпадения ниже отбрасываются. */
  min_confidence?: number;
  /** Если `true` — создать связи по результату. По умолчанию `false`. */
  create_links?: boolean;
  /** Тип создаваемой связи (по имени или id). */
  link_type?: string;
  /** Направление создаваемой связи: `out` = source = комментарий. */
  link_direction?: 'out' | 'in';
  /**
   * Мысль-источник для создаваемых связей (обязательна при
   * `create_links: true` и `source` отсутствует). Концы связей — от неё к
   * найденным. Если `source.comment_id`/`source.thought_id` заданы — id
   * владельца комментария используется автоматически.
   */
  source_thought_id?: string;
}

/** Один матч из отчёта `etn.thoughts.mentions_scan`. */
export interface McpMentionsScanMatch {
  thought_id: string;
  title: string;
  /** 0.0–1.0. */
  confidence: number;
  /** На чём сматчилось: `title` / `synonym` / `wildcard`. */
  matched_on: 'title' | 'synonym' | 'wildcard';
  /** Создана ли связь (`create_links=true` + дубли не было). */
  link_created?: boolean;
}

/** Result of `etn.thoughts.mentions_scan`. */
export interface McpMentionsScanResult {
  matches: McpMentionsScanMatch[];
  /** Число созданных связей. */
  links_created?: number;
  request_id?: string;
}

// ---------------------------------------------------------------------------
// `etn.import.dry_run` / `etn.import.subgraph` (задача e488f4c1, версия
// 0.7.2) — импорт `.etnx` через MCP. Источник — файл на диске либо base64.
// ---------------------------------------------------------------------------

/** Источник `.etnx`-архива для импорта. */
export type McpImportSource =
  | { kind: 'etnx_file'; path: string }
  | { kind: 'etnx_base64'; content_base64: string };

/** Политика коллизий импорта. */
export type McpImportPolicy = 'fail' | 'rename' | 'skip' | 'overwrite';

/** Parameters of `etn.import.dry_run` (read-only preview). */
export interface McpImportDryRunParams {
  network_id: string;
  source: McpImportSource;
  /** Политика разрешения коллизий для плана. */
  collision_policy?: McpImportPolicy;
}

/** Parameters of `etn.import.subgraph` (destructive). */
export interface McpImportSubgraphParams extends McpImportDryRunParams {
  /** Подтверждение деструктивной операции — обязательно `true`. */
  confirm: true;
  /** Куда подвесить корневые мысли (обязательно при наличии). */
  parent_thought_id?: string;
}

/** Превью импорта — содержимое `.etnx` без изменений целевой сети. */
export interface McpImportDryRunResult {
  ok: true;
  manifest_version: string;
  source_network_name?: string;
  /** Какие мысли создадутся / переиспользуются / пропустятся. */
  plan: {
    thoughts_to_create: number;
    thoughts_to_reuse: number;
    thoughts_to_skip: number;
    links_to_create: number;
    attachments_to_import: number;
    thought_types_to_create: number;
    thought_types_to_reuse: number;
    link_types_to_create: number;
    link_types_to_reuse: number;
  };
  /** Конфликты title/synonym при `collision_policy: fail`. */
  conflicts?: Array<{ kind: string; title?: string; id?: string; reason: string }>;
}

/** Result of `etn.import.subgraph`. */
export interface McpImportSubgraphResult {
  imported: {
    thoughts_created: number;
    thoughts_updated: number;
    thoughts_reused: number;
    links_created: number;
    permanent_comments_updated: number;
    chronological_comments_added: number;
    property_values_set: number;
    attachments_imported: number;
    thought_types_created: number;
    thought_types_reused: number;
    link_types_created: number;
    link_types_reused: number;
  };
  conflicts?: Array<{ kind: string; title?: string; id?: string; reason: string }>;
  manifest_version: string;
  layer: { id: string; title: string };
  request_id?: string;
}

