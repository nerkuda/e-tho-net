/**
 * Change-layer DTOs (task S7, docs/13-layers.md §2, §7, §10.1;
 * docs/03-server-api.md §5a).
 *
 * A layer is a copy-on-write branch of the thought network: reads resolve
 * along the layer's ancestor chain down to the base (13-layers.md §4.1),
 * writes materialise shadow rows/tombstones in the session's current layer
 * (§5). The `layers` table itself is not branchable (§3) — its rows are plain
 * metadata with ordinary optimistic locking (`version`).
 */

/** One colour of the layer indication, per UI theme (0.6.4, 13-layers.md
 * §2.2a): `#rrggbb` hex strings. The client computes the opposite theme's
 * variant by flipping HSL lightness, so both are stored once and switching
 * the theme is a pure lookup. */
export interface LayerThemeColor {
  dark: string;
  light: string;
}

/**
 * Colour indication of a layer (0.6.4, docs/13-layers.md §2.2a): makes a
 * non-base layer visibly distinct from the base so the user understands why
 * others do not see the layer's edits.
 *
 *   * `focus_stripe` — the focus band across the middle zone of the thought
 *     map AND the halo border of the thought opened in the editor;
 *   * `background` — the canvas background of every view (map, structures,
 *     chronicle).
 *
 * `null` (absent) — the theme defaults; the base layer always has `colors =
 * null` and rejects colour assignment.
 */
export interface LayerColors {
  focus_stripe: LayerThemeColor;
  background: LayerThemeColor;
}

/** Full layer metadata as returned by `GET /networks/{nid}/layers` (§2.2). */
export interface Layer {
  id: string;
  /** `null` only for the base layer. */
  parent_id: string | null;
  title: string;
  /** Optional free-form purpose note; strongly recommended (§2.2). */
  comment: string | null;
  /** Reserved for future git-reconciliation tooling; never validated on MVP. */
  git_branch: string | null;
  /** Colour indication (0.6.4, §2.2a); always `null` on the base layer. */
  colors: LayerColors | null;
  /** 1 — service (reserve) layer, hidden from the selection list (§8.2). */
  is_service: boolean;
  /** 1 — exactly one row per network; protected like HOME. */
  is_base: boolean;
  /** Denormalised: 0 at the base, +1 per child (limit §2.1). */
  depth: number;
  created_by: string;
  /** ISO-8601, second precision. */
  created_at: string;
  /**
   * Id пользователя, последним изменившего слой (переименование/комментарий,
   * §2.2). Раньше поля не было — спека §3.0 хранила только `created_by`.
   * Колонка `updated_by` физически добавлена миграцией 033. Сервер всегда
   * возвращает; помечено `?` чтобы клиентские фикстуры могли собирать
   * объект без него до этапа 3.
   */
  updated_by?: string;
  /** Last write to any branchable row of the layer — not metadata edits. */
  last_activity_at: string;
  /** Row version for `If-Match` on rename/comment edits (§2.2). */
  version: number;
  /** Unix-миллисекунды `created_at` (для сортировки). */
  created_at_ms?: number;
  /** Unix-миллисекунды последнего изменения метаданных слоя. */
  updated_at_ms?: number;
  /** Size of the whole descendant subtree (all layers, incl. service ones) —
   * the `cascade` confirmation of DELETE (§2.4) echoes this number back. */
  children_count: number;
  /** True on the session's current layer — only meaningful in the list
   * response (§10.1); mutating endpoints echo the same fact via `meta.layer`. */
  current: boolean;
}

/**
 * Echo of the session's current layer: `meta.layer` of every mutating REST
 * response (13-layers.md §7.1) and the `X-Etn-Layer`/`X-Etn-Layer-Title`
 * headers on bodiless 204 replies.
 */
export interface LayerEcho {
  id: string;
  title: string;
}

/** Response of `DELETE /networks/{nid}/layers/{id}` (03-server-api.md §5a). */
export interface LayerDeleteResult {
  /** How many layers were physically removed: the layer + its whole subtree. */
  deleted: number;
  /** Trash auto-purge right after the deletion (§2.4): rows removed. */
  purged: number;
  /** Trash rows that stayed behind because they are still blocked. */
  skipped: number;
}

// ---------------------------------------------------------------------------
// Merge (task S8, docs/13-layers.md §8; docs/03-server-api.md §5a.6)
// ---------------------------------------------------------------------------

/** One `base_version` divergence that rejected a merge (13-layers.md §8.3). */
export interface LayerMergeConflict {
  table: string;
  id: string;
  expected_base_version: number;
  current_version: number;
}

/** One reference that kept a merge set from being closed (§8.1). */
export interface LayerMergeMissingClosure {
  table: string;
  id: string;
  /** The merged row that references the missing entity. */
  referenced_by: { table: string; id: string };
}

/** One residual §6.4 case: a link whose endpoint is physically gone. */
export interface LayerMergeSkip {
  table: string;
  id: string;
  reason: 'endpoint_missing';
  /** Which endpoint is gone: `source` or `target`. */
  missing: 'source' | 'target';
}

/** A collapsed batch of position-only link updates (13-layers.md §6.5). */
export interface LayerMergeReorderCollapsed {
  /** The thought whose children were reordered (`links.source_id`). */
  thought_id: string;
  count: number;
}

/** A collapsed batch of position-only `publication_order` updates (0.11.1,
 * требование e7487d77 п.2: свёртка пачек перестановок порядка публикации). */
export interface LayerMergePublicationReorderCollapsed {
  /** Публикация, у которой переставили узлы (`publication_order.publication_id`). */
  publication_id: string;
  count: number;
}

/** Response of `POST /networks/{nid}/layers/{id}/merge` (§8.3). */
export interface LayerMergeReport {
  /** How many logical rows moved to the parent, per branchable table. */
  applied: Record<string, number>;
  /** Residual §6.4 cases — link not created, merge continued. */
  skipped: LayerMergeSkip[];
  /** Position-only link batches collapsed into single report entries. */
  reorder_collapsed: LayerMergeReorderCollapsed[];
  /** Свёрнутые пачки перестановок порядка публикаций (0.11.1). Необязательно —
   * старые сохранённые отчёты и клиенты, не знающие публикаций, поля не имеют. */
  publication_reorder_collapsed?: LayerMergePublicationReorderCollapsed[];
  /** Service layer holding the pre-merge state of the affected rows (§8.2);
   * `null` when there was nothing to overwrite. */
  reserve_layer_id: string | null;
  /** Rows removed by the trash auto-purge right after the merge (§8.4). */
  purged: number;
  /** Сводка авто-свёртки журнала активности для слоя (задача 6bcccd2b,
   * требование 1f7f789b «авто-свёртка при слиянии слоя»): сколько
   * ключевых сущностей `(entity_type, entity_id)` получили итоговую запись
   * и сколько детальных строк удалено из журнала. */
  activity_rollup: { groups: number; removed: number };
  /** Присутствует только у слияния ОДНОЙ мысли (`thought_id` в запросе,
   * задача f5c363a3): чем закончилось разрешение её изменений. */
  thought_merge?: LayerThoughtMergeResult;
}

// ---------------------------------------------------------------------------
// Разрешение изменений одной мысли (задача f5c363a3, «Слияние отдельных
// мыслей в основу из GUI с разрешением конфликтов»)
// ---------------------------------------------------------------------------

/**
 * Режим разрешения изменений одной мысли слоя:
 *   * `overwrite` — «Полностью переписать мысль в основе»: версия слоя
 *     побеждает целиком (существующая семантика точечного слияния, но с
 *     предварительным снятием расхождения `base_version` по строкам мысли);
 *   * `combine` — «Объединить изменения»: постоянный комментарий
 *     объединяется с маркерами конфликтов git-стиля, остальные строки
 *     (связи, свойства, синонимы, хроно-записи) переносятся версией слоя.
 */
export const LAYER_THOUGHT_MERGE_MODES = ['overwrite', 'combine'] as const;
export type LayerThoughtMergeMode = (typeof LAYER_THOUGHT_MERGE_MODES)[number];

/** Итог режима `combine`: что стало с постоянным комментарием. */
export interface LayerThoughtMergeResult {
  thought_id: string;
  mode: LayerThoughtMergeMode;
  /** Комментарий был переписан объединением (режим `combine`, тексты слоя и
   *  основы различались; для `overwrite` — `false`). */
  comment_merged: boolean;
  /** Сколько конфликтных блоков (`<<<<<<<`/`=======`/`>>>>>>>`) вставлено. */
  comment_conflicts: number;
}

/**
 * Ответ `POST /networks/{nid}/layers/{id}/discard` — «Отказаться от
 * изменений» (задача f5c363a3): все строки слоя, принадлежащие мысли,
 * физически удалены из слоя, мысль вернулась к состоянию основы (а если была
 * создана в слое — исчезла). Основа не затронута.
 */
export interface LayerDiscardReport {
  layer: LayerEcho;
  target_layer: LayerEcho;
  thought_id: string;
  /** Сколько строк слоя удалено, по ветвимым таблицам. */
  discarded: Record<string, number>;
  /** Итог по всем таблицам. */
  total: number;
}

// ---------------------------------------------------------------------------
// Override reset / pending-conflict preview (задача 7cc34cf4, docs/13-layers.md
// §8.5)
// ---------------------------------------------------------------------------

/** One copy column where the target's row («было в основе») and the layer's
 * shadow row («стало в слое») differ — the side-by-side the reset must show
 * (§8.5). Text values are clipped to keep the report bounded. */
export interface LayerOverrideDiffField {
  column: string;
  base: string | number | boolean | null;
  layer: string | number | boolean | null;
}

/** One shadow row of a layer described against the row it overrides. */
export interface LayerOverrideRow {
  table: string;
  id: string;
  /** `base_version` of the shadow row before the operation. */
  previous_base_version: number;
  /** Current version of the same logical row along the merge target chain —
   * what `base_version` is re-pinned to. `0` when the target has no such row
   * (the row is an insert, §5.1). */
  current_version: number;
  /** Shadow row version before the operation — moved to the target verbatim
   * by the merge (§8.1). */
  layer_version: number;
  /** Version actually written to the shadow when it lagged behind the target
   * (the merge must not walk the target's version backwards); `null` when the
   * shadow was already ahead or level. */
  version_raised_to: number | null;
  /** Whether the target's row / the shadow is a tombstone. */
  base_deleted: boolean;
  layer_deleted: boolean;
  /** Changed copy columns — «было в основе / стало в слое» (§8.5). */
  diff: LayerOverrideDiffField[];
}

/** Read-only preview of the rows that would reject a merge (§8.5, работа
 * `etn.ops { action: "layers.conflicts" }`). */
export interface LayerPendingConflictsReport {
  layer: LayerEcho;
  target_layer: LayerEcho;
  /** Shadow rows the layer physically holds (live and tombstones alike) —
   * the scope a reset can address. */
  overridden: number;
  /** Versioned shadow rows whose `base_version` lags behind the target. */
  conflicts: LayerOverrideRow[];
}

/** Response of the override reset (§8.5, working
 * `etn.ops { action: "layers.reset_override" }`). */
export interface LayerResetOverrideReport {
  layer: LayerEcho;
  target_layer: LayerEcho;
  /** Rows whose `base_version` was re-pinned to the current target version. */
  reset: LayerOverrideRow[];
  /** Rows left untouched, with the reason: already in sync, or a table whose
   * rows carry no version and therefore never conflict. */
  unchanged: Array<{ table: string; id: string; reason: 'up_to_date' | 'not_versioned' }>;
}

// ---------------------------------------------------------------------------
// Structural + textual layer diffs (task S11, docs/13-layers.md §10.3;
// docs/03-server-api.md §5a.7)
// ---------------------------------------------------------------------------

/** One visible link row of a diff context — enough to compare structure. */
export interface LayerDiffLinkRow {
  id: string;
  source_id: string;
  target_id: string;
  type_id: string | null;
  /** Manual child order (T1); surfaced only in the diff, not in the Link API. */
  position: number;
}

/** A link visible in both contexts whose `type_id` changed (§6.1 UPDATE path). */
export interface LayerDiffTypeChange {
  id: string;
  from_type_id: string | null;
  to_type_id: string | null;
}

/** A thought that swapped its single parent link: one incoming link removed,
 * one added — the S14 «перецепка» read as a reparenting (§10.3). */
export interface LayerDiffReparented {
  thought_id: string;
  from_parent_id: string;
  to_parent_id: string;
}

/** Link changes of the layer relative to its merge target. */
export interface LayerDiffLinks {
  added: LayerDiffLinkRow[];
  removed: LayerDiffLinkRow[];
  type_changed: LayerDiffTypeChange[];
  /** Position-only batches collapsed per parent thought (§6.5): `{ thought_id,
   * count }` — the same shape the merge report uses. */
  reorder_collapsed: LayerMergeReorderCollapsed[];
  /** 1:1 parent-link swaps; anything more complex stays as added/removed. */
  reparented: LayerDiffReparented[];
}

/** Ids that physically exist in the layer (shadow rows, inserts AND tombstones
 * alike) — exactly what the canvas marks as «перекрыто». */
export interface LayerDiffOverridden {
  thought_ids: string[];
  link_ids: string[];
}

/** Structural diff response of `GET /networks/{nid}/layers/{id}/diff` without
 * pagination parameters — the full report (REST default, задача ddb67ddc). */
export interface LayerDiffResult {
  layer: LayerEcho;
  target_layer: LayerEcho;
  links: LayerDiffLinks;
  overridden: LayerDiffOverridden;
}

/**
 * Addressable sections of the structural diff report (задача ddb67ddc).
 *
 * They are exactly the leaf collections of {@link LayerDiffResult}: each link
 * batch and each `overridden` id set. A section name is `<object>.<field>` and
 * is the unit of both the `sections` filter and the keyset cursor.
 */
export const LAYER_DIFF_SECTIONS = [
  'links.added',
  'links.removed',
  'links.type_changed',
  'links.reorder_collapsed',
  'links.reparented',
  'overridden.thought_ids',
  'overridden.link_ids',
] as const;
export type LayerDiffSection = (typeof LAYER_DIFF_SECTIONS)[number];

/** Totals per section across the WHOLE report (not just the current page).
 * Present in every paged answer so the caller can plan the audit. */
export type LayerDiffCounts = Record<LayerDiffSection, number>;

/** Default page size of `layers.diff` in the MCP contour — a first page is
 * returned even when the caller passes no pagination parameters. */
export const LAYER_DIFF_DEFAULT_LIMIT = 200;
/** Hard ceiling on `limit`; the byte budget can trim a page further. */
export const LAYER_DIFF_MAX_LIMIT = 1000;
/**
 * Soft byte budget of one paged answer, measured on the exact JSON text the
 * MCP transport hands to the model (`JSON.stringify(page, null, 2)`, UTF-8).
 * Sits below the default MCP-client `maxModelBytes = 50000` (05-mcp-server.md
 * §4.1) so the transport never truncates a page silently — задача ddb67ddc.
 */
export const LAYER_DIFF_PAGE_BUDGET_BYTES = 48_000;

/**
 * One page of the structural diff report (задача ddb67ddc).
 *
 * `links` / `overridden` carry only the requested sections, each holding at
 * most the page's items; `counts` always describes the whole report. The page
 * is guaranteed to fit {@link LAYER_DIFF_PAGE_BUDGET_BYTES}; `truncated` +
 * `next_cursor` signal that more items remain (keyset continuation, ADR
 * 5f6cb775).
 */
export interface LayerDiffPage {
  layer: LayerEcho;
  target_layer: LayerEcho;
  /** Sections included in this page, in the canonical order of
   * {@link LAYER_DIFF_SECTIONS} (all of them when no filter was passed). */
  sections: LayerDiffSection[];
  /** Totals per section across the whole report. */
  counts: LayerDiffCounts;
  /** Page items, grouped by section; only requested sections are present. */
  links: Partial<LayerDiffLinks>;
  overridden: Partial<LayerDiffOverridden>;
  /** Echo of the effective page size. */
  limit: number;
  /** True when more items remain (this is not the whole report). */
  truncated: boolean;
  /** Why the page is incomplete: `has_more` — items remain; `null` — complete. */
  reason: 'has_more' | null;
  /** Opaque keyset cursor for the next page (section + last item id); `null`
   * when the page is the last one. */
  next_cursor: string | null;
}

/** Textual diff response of `GET /networks/{nid}/layers/{id}/diff/doc`: two
 * deterministically assembled markdown documents (§10.3, «дешёвый дифф
 * закрывает содержание, но не структуру»). */
export interface LayerDiffDoc {
  layer: LayerEcho;
  target_layer: LayerEcho;
  layer_doc: string;
  target_doc: string;
}

// ---------------------------------------------------------------------------
// Per-thought textual diff (задача 52c776f1)
// ---------------------------------------------------------------------------

/**
 * Comparable attributes of a single thought, resolved in BOTH contexts (the
 * diffed layer and its merge target) — the display-ready pairs the client
 * feeds to the line diff.
 *
 * The server is the only side that can read the same thought out of the layer
 * and out of the base at once: from inside a layer the client cannot see the
 * base version of a shadowed thought.
 */
export const LAYER_THOUGHT_DIFF_FIELD_KEYS = [
  'title',
  'type',
  'synonyms',
  'active',
  'comment',
] as const;
export type LayerThoughtDiffFieldKey = (typeof LAYER_THOUGHT_DIFF_FIELD_KEYS)[number];

/** One attribute in two contexts; `target` — base/parent layer, `layer` —
 *  the diffed layer. An attribute absent on one side is the empty string. */
export interface LayerThoughtDiffField {
  key: LayerThoughtDiffFieldKey;
  target: string;
  layer: string;
  changed: boolean;
}

/** How the thought itself relates to the diffed layer:
 * `added` — new in the layer, `removed` — deleted (tombstoned) in the layer,
 * `changed` — present in both with at least one different attribute,
 * `unchanged` — present in both and identical. */
export type LayerThoughtDiffKind = 'changed' | 'added' | 'removed' | 'unchanged';

/** Response of `GET /networks/{nid}/layers/{id}/diff/thought/{thoughtId}`. */
export interface LayerThoughtDiff {
  layer: LayerEcho;
  target_layer: LayerEcho;
  thought_id: string;
  /** Best-known title (the layer's version wins when present). */
  title: string;
  kind: LayerThoughtDiffKind;
  /** One entry per {@link LAYER_THOUGHT_DIFF_FIELD_KEYS}, in that order. */
  fields: LayerThoughtDiffField[];
}
