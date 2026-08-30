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
  /** 1 — service (reserve) layer, hidden from the selection list (§8.2). */
  is_service: boolean;
  /** 1 — exactly one row per network; protected like HOME. */
  is_base: boolean;
  /** Denormalised: 0 at the base, +1 per child (limit §2.1). */
  depth: number;
  created_by: string;
  /** ISO-8601, second precision. */
  created_at: string;
  /** Last write to any branchable row of the layer — not metadata edits. */
  last_activity_at: string;
  /** Row version for `If-Match` on rename/comment edits (§2.2). */
  version: number;
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

/** Response of `POST /networks/{nid}/layers/{id}/merge` (§8.3). */
export interface LayerMergeReport {
  /** How many logical rows moved to the parent, per branchable table. */
  applied: Record<string, number>;
  /** Residual §6.4 cases — link not created, merge continued. */
  skipped: LayerMergeSkip[];
  /** Position-only link batches collapsed into single report entries. */
  reorder_collapsed: LayerMergeReorderCollapsed[];
  /** Service layer holding the pre-merge state of the affected rows (§8.2);
   * `null` when there was nothing to overwrite. */
  reserve_layer_id: string | null;
  /** Rows removed by the trash auto-purge right after the merge (§8.4). */
  purged: number;
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

/** Structural diff response of `GET /networks/{nid}/layers/{id}/diff`. */
export interface LayerDiffResult {
  layer: LayerEcho;
  target_layer: LayerEcho;
  links: LayerDiffLinks;
  /** Ids that physically exist in the layer (shadow rows, inserts AND
   * tombstones alike) — exactly what the canvas marks as «перекрыто». */
  overridden: { thought_ids: string[]; link_ids: string[] };
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
