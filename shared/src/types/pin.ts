/**
 * Pinned-thoughts DTOs (L18): the per-user list of «закреплённые мысли».
 *
 * Mirrors docs/03-server-api.md §19 and the L3 storage in
 * docs/02-data-model.md §3.10.6. The list is an ordered set of thought ids;
 * the client resolves the cloud metadata through `POST /thoughts/resolve`
 * (docs/03-server-api.md §6.9), exactly like the focus history panel.
 */

/** One entry of the user's pinned list (order is `position`). */
export interface PinnedThoughtEntry {
  thought_id: string;
  /** 0-based position in the list (replace semantics on write). */
  position: number;
}
