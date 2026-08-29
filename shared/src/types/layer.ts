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
