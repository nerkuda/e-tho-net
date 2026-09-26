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
import type { McpEffectiveTypeProperty, PropertyValueValue } from './thought-type.js';
import type { RealtimeEventType } from './realtime.js';
import type {
  ThoughtBundleMatchKind,
  ThoughtBundleOnDuplicate,
  ThoughtBundleThoughtAction,
} from './thought-bundle.js';
import type { ThoughtCardWarning } from './thought-card-warning.js';
import type { Link } from './link.js';
import type { Thought, ThoughtRef, ThoughtUsage } from './thought.js';

/** All tool names exposed by the ETN MCP server (05-mcp-server.md §4).
 *
 *  0.8.3 (задачи 86ef2ff4, d379e091; ADR b2eebf8b/8358eea9): состав сокращён —
 *  редкие операции сняты из постоянного набора и доступны через `etn.guide` +
 *  `etn.ops` (реестр действий — в `server/src/mcp/tools/ops-catalog.ts`).
 *  Здесь — только инструменты, реально рекламируемые в `tools/list`. */
export const MCP_TOOL_NAMES = [
  // прогрессивное раскрытие (задача 86ef2ff4)
  'etn.guide',
  'etn.ops',
  // read (§4.1)
  'etn.networks.structure',
  'etn.instructions',
  'etn.thoughts.search',
  'etn.thoughts.query',
  'etn.thoughts.get',
  'etn.thoughts.resolve',
  'etn.thoughts.bulk_update',
  'etn.thoughts.neighbors',
  'etn.thoughts.subgraph',
  'etn.thoughts.usage',
  'etn.comments.get',
  'etn.types.list',
  'etn.views.run',
  'etn.chronicle.query',
  'etn.layers.list',
  'etn.activity.list',
  // mutate (§4.2)
  'etn.thoughts.write',
  'etn.comments.update',
  'etn.comments.edit',
  'etn.properties.add',
  'etn.layers.select',
  // ontology batch ops (задача cc9ca65e / 0.7.2)
  'etn.ontology.write',
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
 * - `destructiveHint` — `true` for tools whose call needs explicit user
 *   approval (irreversible writes). After 0.8.3 the storefront itself carries
 *   no such tool — every destructive operation is a `etn.ops` action gated by
 *   a top-level `confirm: true` (registry `ops-catalog.ts`), where the
 *   per-action `destructive` flag plays the same role.
 * - `idempotentHint` — `true` for tools whose repeated call with the same
 *   arguments produces the same final state: `properties.add`,
 *   `layers.select`, and `thoughts.write` (upsert semantics, O1).
 *
 * All fields are optional on the wire; tools that carry no hints (the
 * remaining mutating tools — `comments.update`/`edit`) are not listed here at
 * all. `etn.ops` carries no tool-level hints — per-action `readOnly`/
 * `destructive` live in the `ops-catalog` registry.
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
  // ---- прогрессивное раскрытие (задача 86ef2ff4, 0.8.3) -----------
  // `etn.guide` — read-only витрина редких операций.
  'etn.guide': { readOnlyHint: true },
  // `etn.ops` — диспетчер: набор действий и их `readOnly`/`destructive`
  // заданы в реестре (`tools/ops-catalog.ts`), а не тул-уровневой аннотацией.

  // ---- read tools (§4.1) — readOnlyHint ---------------------------
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
  'etn.thoughts.usage': { readOnlyHint: true },
  'etn.comments.get': { readOnlyHint: true },
  'etn.types.list': { readOnlyHint: true },
  // `etn.views.run` (задача c1fa71d4, 0.7.3) — read-only исполнение отбора;
  // не пишет событий и audit_log, всегда идемпотентно для одного набора аргументов.
  'etn.views.run': { readOnlyHint: true },
  'etn.chronicle.query': { readOnlyHint: true },
  'etn.thoughts.find_duplicates': { readOnlyHint: true },
  'etn.layers.list': { readOnlyHint: true },
  'etn.activity.list': { readOnlyHint: true },

  // ---- mutating tools — destructiveHint ---------------------------
  'etn.thoughts.bulk_update': { destructiveHint: false, idempotentHint: false },

  // ---- mutating tools — idempotentHint ----------------------------
  'etn.properties.add': { idempotentHint: true },
  'etn.layers.select': { idempotentHint: true },
  // `etn.comments.edit` (задача d28abe04) — секционная правка ops-ами;
  // повторный вызов с теми же ops поверх нового состояния меняет результат.
  'etn.comments.edit': { readOnlyHint: false, destructiveHint: false, idempotentHint: false },

  // ---- `etn.thoughts.write` (задача 053751b5 / 0.7.2) — главный пишущий ----
  // Батч 1..50 связанных единиц знания одной транзакцией: одна запись бюджета,
  // одна строка audit_log с `thought_count`/`link_count`. Upsert-семантика
  // (`on_duplicate: reuse`/`update`/`fail`) — повторный вызов с теми же
  // аргументами даёт тот же результат.
  'etn.thoughts.write': { destructiveHint: false, idempotentHint: true },

  // ---- `etn.ontology.write` (задача cc9ca65e / 0.7.2) ---------------------
  // Upsert онтологии сети одной транзакцией; повторный вызов с теми же
  // аргументами не меняет состояние.
  'etn.ontology.write': { destructiveHint: false, idempotentHint: true },
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

/**
 * Запись справочника типов мыслей в списочном ответе (0.8.3, требование
 * «Каталоги типов в ответах read-инструментов»). Только `id`+`name`+`icon`:
 * полные `description`/`parent_id`/`is_root` — в каталоге `etn.types.list`.
 * Так справочник не повторяет один и тот же текст на каждой записи ответа.
 */
export interface ListThoughtTypeRef {
  id: string;
  name: string;
  icon: string | null;
}

/**
 * Запись справочника типов связей в списочном ответе (0.8.3): только `id` и
 * оба имени — агент выбирает имя по направлению ребра (`source → target` =
 * `name_forward`). Описание типа — в `etn.types.list`.
 */
export interface ListLinkTypeRef {
  id: string;
  name_forward: string;
  name_reverse: string;
}

/**
 * Вложенный тип мысли в карточке (`etn.thoughts.get`/`resolve`, 0.8.3):
 * `name` + AI-facing `description`, без визуальных полей (`icon`, цвета,
 * `is_root`). Полное определение типа — в `etn.types.list`.
 */
export interface CardThoughtTypeRef {
  id: string;
  name: string;
  description: string | null;
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
  properties: McpEffectiveTypeProperty[];
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
  properties: McpEffectiveTypeProperty[];
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
  /**
   * Пояснение о структурных свойствах-связях каталога (0.8.3). Структурные
   * «Родители»/«Потомки» объявлены на корневом типе и наследуются всеми
   * типами мыслей — повторять их в `properties[]` каждого типа бессмысленно,
   * поэтому они вынесены одной строкой-константой на каталог. Присутствует,
   * когда в ответе есть `thought_types`.
   */
  structural_properties_note?: string;
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
   * Apply `active` to the item's thought. With `thought_id` — toggles the
   * existing thought without a nested `thought` block. With `thought` — sets
   * the created thought's flag and wins over `thought.active` (bug
   * 21cbafb8-254b-42e3-a884-3832a3cf6ab5). Absorbs `etn.thoughts.set_active`
   * (bug faf56a02-e884-488b-9b7b-39dfd5d5b275): before that fix the field was
   * silently dropped by Zod (item-level `active` was unknown).
   */
  active?: boolean;
  /** Item-level `title` — renames the existing thought addressed by
   *  `thought_id`, without a nested `thought` block. NOT allowed together
   *  with `thought` (rejected with `VALIDATION_ERROR`): for a new thought set
   *  `thought.title` instead, otherwise the value would be silently ignored
   *  (bug 21cbafb8-254b-42e3-a884-3832a3cf6ab5). Absorbs the rename half of
   *  the removed `etn.thoughts.update` (bug
   *  870c0c0d-dd2d-46b1-a498-780edcf8e18a): the field was absent entirely, so
   *  a batch item addressing an existing thought could not rename it. */
  title?: string;
  /** Item-level `synonyms` — replaces the whole synonym set of the existing
   *  thought addressed by `thought_id` (bug
   *  870c0c0d-dd2d-46b1-a498-780edcf8e18a). Not allowed together with
   *  `thought` (see item-level `title`). */
  synonyms?: string[];
  /** Item-level `type_id` — changes the type of the existing thought
   *  addressed by `thought_id` (bug 870c0c0d-dd2d-46b1-a498-780edcf8e18a,
   *  sibling of the rename gap). Not allowed together with `thought` (see
   *  item-level `title`). */
  type_id?: string | null;
  /** Type resolution by name (XOR with item-level `type_id`). Not allowed
   *  together with `thought` (see item-level `title`). */
  type?: string;
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
  /**
   * Per-key property value ids set in this batch. `id` — id строки
   * `property_values` для скалярного свойства; `null` для свойства-связи
   * (её значение — проекция рёбер, отдельной строки нет). Для свойства-связи
   * `targets` несёт ИТОГОВЫЙ набор целей ребра — по нему агент видит, что
   * запись состоялась, не перечитывая карточку (ошибка 5a50f906: раньше для
   * свойства-связи отдавалась пустая строка; ошибка 17cc0d54: `id: null` без
   * целей бесполезен). `link_ids` — id рёбер, СОЗДАННЫХ этой записью
   * (ошибка 1b719d76: по ним публикуется `link.created`).
   */
  properties?: Record<string, { id: string | null; targets?: string[]; link_ids?: string[] }>;
  /** Link results: id + (if any) attached properties/comments. */
  links?: Array<{
    id: string;
    version: number;
    /** `id` — как у верхнеуровневых `properties` (см. выше). */
    properties?: Record<string, { id: string | null }>;
    comment?: { id: string; version: number };
  }>;
  /** Attachment ids added in this batch. */
  attachments?: Array<{ id: string }>;
  /**
   * Id рёбер, материализованных применением link-дефолтов типа при создании
   * мысли (ошибка 8655842b). Не путать с `links` (явные `links[]` запроса) и
   * с `properties[].link_ids` (рёбра set-записи свойства). По ним публикуется
   * `link.created` — иначе создание мысли с непустым link-дефолтом ставило
   * рёбра «молча». Пусто/не задано — дефолтов-связей не было.
   */
  default_link_ids?: string[];
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
   *  (task N6). Same thin {@link ListThoughtTypeRef} shape as the other read
   *  tools (`etn.thoughts.query`, `subgraph`, `neighbors`). */
  thought_types: Record<string, ListThoughtTypeRef>;
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

/**
 * Ширина «визуальных» полей стиля, которые compact-проекция выносит из
 * списочных ответов MCP: цвет текста и фона, ручные флаги шрифта, вид иконки
 * и вложение-подложка иконки. `icon` (само значение emoji/ссылки) остаётся —
 * оно семантично. Список — единый источник для всех compact-проекций.
 */
export type CompactVisualFieldKeys =
  | 'fg_color'
  | 'bg_color'
  | 'font_bold'
  | 'font_italic'
  | 'font_underline'
  | 'font_strike'
  | 'icon_kind'
  | 'icon_attachment_id';

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
