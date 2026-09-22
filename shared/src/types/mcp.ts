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
  LinkStyle,
  RealtimeAudience,
} from '../enums.js';
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
  'etn.thoughts.delete',
  'etn.thoughts.trash',
  'etn.links.restore',
  'etn.comments.update',
  'etn.comments.edit',
  'etn.comments.delete',
  'etn.attachments.add',
  'etn.attachments.copy',
  'etn.attachments.search',
  'etn.attachments.update',
  'etn.attachments.delete',
  'etn.properties.add',
  'etn.properties.remove',
  // `etn.thoughts.write` (task 053751b5, 0.7.2) — батч-запись: одна транзакция
  // для многих связанных единиц знания (мысли + постоянные/хронологические
  // комментарии + свойства + связи с их свойствами и комментариями + вложения).
  // Поглощённые инструменты (`thoughts.create`/`update`/`set_active`/
  // `upsert_bundle`, `links.create`, `properties.set`, `comments.upsert`)
  // удалены в 0.8.2 (задача 937480ca).
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
 *   arguments produces the same final state: `thoughts.trash`,
 *   `properties.add`/`remove`, and `thoughts.write` (upsert semantics, O1).
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
  'etn.thoughts.trash': { idempotentHint: true },
  'etn.links.restore': { idempotentHint: true },
  'etn.properties.add': { idempotentHint: true },
  'etn.properties.remove': { idempotentHint: true },
  'etn.layers.update': { idempotentHint: true },
  'etn.layers.select': { idempotentHint: true },
  // Object-lock acquire — идемпотентно продлевает свой захват (задача 2031df5e).
  'etn.locks.acquire': { idempotentHint: true },
  // `attachments.update` — last-write-wins по метаданным, повторный вызов с теми же аргументами даёт тот же результат.
  'etn.attachments.update': { idempotentHint: true },
  // `etn.comments.edit` (задача d28abe04) — секционная правка ops-ами;
  // повторный вызов с теми же ops поверх нового состояния меняет результат.
  'etn.comments.edit': { readOnlyHint: false, destructiveHint: false, idempotentHint: false },

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
   * by `etn.thoughts.write` batch items (via the bundle domain) — the call
   * succeeded, but the card is not fully compliant with its type's
   * required-property contract. Absent when no warnings apply.
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

// ---------------------------------------------------------------------------
// `etn.thoughts.write` (task 053751b5, версия 0.7.2) — батч-запись связанных
// единиц знания одной транзакцией. Поглощённые инструменты
// (`etn.thoughts.create`/`update`/`set_active`/`upsert_bundle`,
// `etn.links.create`, `etn.properties.set`, `etn.comments.upsert`)
// удалены в 0.8.2 (задача 937480ca).
// ---------------------------------------------------------------------------

/** Один элемент хронологической записи в `etn.thoughts.write`. */
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
  /**
   * Apply `active` to the existing thought addressed by `thought_id`,
   * without supplying a nested `thought` block. Absorbs
   * `etn.thoughts.set_active` (bug faf56a02-e884-488b-9b7b-39dfd5d5b275):
   * before the fix the field was silently dropped by Zod (item-level
   * `active` was unknown). Wins over `thought.active` when both are set.
   */
  active?: boolean;
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


/** Result of `etn.activity.list` — те же данные, что отдаёт REST `GET /activity`. */


// ---------------------------------------------------------------------------
// `etn.metrics.reads` (task O10, 05-mcp-server.md §5.1) — usage analytics
// for the knowledge base. Returns either the top-read thoughts or the cold
// ones (never read, or not read since `since`), so the network owner can
// surface dead zones and over-heated nodes driven by AI-agent traffic.
// ---------------------------------------------------------------------------

/** Selection for `etn.metrics.reads`. */
export type McpMetricsReadsKind = 'top' | 'cold';

/** Parameters of `etn.metrics.reads` (05-mcp-server.md §5.1). */


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

// ---------------------------------------------------------------------------
// `etn.thoughts.mentions_scan` (задача e488f4c1, версия 0.7.2) — поиск
// упоминаний мыслей в тексте: FTS по названиям и синонимам + опциональное
// создание связей по результату.
// ---------------------------------------------------------------------------

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

/** Политика коллизий импорта. */
export type McpImportPolicy = 'fail' | 'rename' | 'skip' | 'overwrite';
