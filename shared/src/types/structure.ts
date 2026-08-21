/**
 * «Структуры мыслей» view DTOs (L15): thought filter query, one-level
 * hierarchy expansion and named saved filters.
 *
 * Mirrors docs/03-server-api.md §6.10, §6.11 and §18, and the L3 storage in
 * docs/02-data-model.md §3.10.5.
 */

import type { SavedFilterView, SortOrder, StructurePropertyOp, StructureSort } from '../enums.js';
import type { FocusEdge, ThoughtRef } from './thought.js';

/** A single scalar of a property condition (shape depends on the value type). */
export type StructurePropertyValue = string | number | boolean;

/**
 * One property condition of a filter. `value` is a scalar for scalar
 * operations and an array for `in`/`not_in` (OR inside the list).
 * Allowed ops per property `value_type` (03-server-api.md §6.10):
 * text/url — contains|eq|in|not_in; number/date — eq|gt|lt; bool — eq;
 * thought_ref — eq|in|not_in.
 */
export interface StructurePropertyCondition {
  property_id: string;
  op: StructurePropertyOp;
  value: StructurePropertyValue | StructurePropertyValue[];
}

/** Tri-state has/hasn't criterion: `true`/`false` filters, absent — "not important". */
export type StructureTriState = boolean | undefined;

/** Filter criteria of the structures query (03-server-api.md §6.10). */
export interface StructureFilter {
  /** Keywords mini-syntax: whitespace-separated words, `*` wildcard, `-` exclusion. */
  keywords?: string;
  /**
   * Restrict the candidate set to the union of the subtrees of these thoughts
   * (OR between roots, depth ≤ `STRUCTURES_PARENT_SCOPE_MAX_DEPTH`, deduped;
   * the roots themselves are excluded — only their descendants match).
   */
  parent_ids?: string[];
  /** Thought types (OR inside the list). */
  type_ids?: string[];
  /** The thought has an active link of any of these types in either direction. */
  link_type_ids?: string[];
  /** Property conditions (AND between conditions). */
  properties?: StructurePropertyCondition[];
  /** Has at least one property value (§15.3 «Дополнительно»). */
  has_properties?: StructureTriState;
  /** Has a permanent comment. */
  has_comment?: StructureTriState;
  /** Has at least one attachment. */
  has_attachments?: StructureTriState;
  /** Has at least one chronological comment entry. */
  has_chronology?: StructureTriState;
  /**
   * «Актуальность»: `true` — only active thoughts, `false` — only inactive;
   * absent — "not important" (the `show_inactive` flag governs). The panel
   * offers the field only while the client setting «Показывать неактуальное»
   * is on (§15.3 «Дополнительно»).
   */
  active?: StructureTriState;
  show_inactive?: boolean;
}

/** Filter + paging of `POST /thoughts/query` (the list envelope of §6.10). */
export interface StructureQueryRequest extends StructureFilter {
  sort: StructureSort;
  order: SortOrder;
  limit: number;
  offset: number;
  /**
   * `true` — return bare thought ids instead of `ThoughtRef` pages (used by
   * the bulk filter commands to collect the whole result, L22): the `limit`
   * ceiling is `STRUCTURES_QUERY_IDS_MAX_LIMIT` instead of 100.
   */
  ids_only?: boolean;
}

/**
 * Per-thought link direction flags: `has_incoming` — the thought has active
 * parents, `has_outgoing` — active children. In the structures tree these
 * drive the ellipse fill exactly like on the canvas focus row.
 */
export type StructureDirectionFlags = Record<string, { has_incoming: boolean; has_outgoing: boolean }>;

/** Result of `POST /thoughts/query` as consumed by the client (§6.10). */
export interface StructureQueryResponse {
  items: ThoughtRef[];
  total: number;
  /** Direction flags of every returned item (rides in the list envelope `meta`). */
  directions: StructureDirectionFlags;
}

/** Result of `POST /thoughts/query` with `ids_only: true` (§6.10, L22). */
export interface StructureIdsQueryResponse {
  ids: string[];
  total: number;
}

/** Response of `GET /thoughts/{id}/hierarchy` (03-server-api.md §6.11). */
export interface HierarchyResponse {
  /** Parents (link sources) or children (link targets) after `exclude_ids` dedup. */
  neighbors: ThoughtRef[];
  /** Active links between the expanded thought and the returned neighbors. */
  edges: FocusEdge[];
  /** @deprecated alias of `has_more`, kept for backward compatibility. */
  truncated: boolean;
  /** true — more neighbors exist past `offset + limit` (§15.5 «Показать ещё»). */
  has_more: boolean;
  /** Whether each visible thought (node + neighbors) has active incoming/outgoing
   *  links — in the tree these mean "has parents/children to expand"; drives the
   *  ellipse fill exactly like on the canvas. */
  directions: StructureDirectionFlags;
}

/** Persisted criteria of a saved filter: filter + sort/order (03-server-api.md §18). */
export interface SavedFilterDefinition extends StructureFilter {
  sort: StructureSort;
  order: SortOrder;
}

/** A named saved filter of the structures view (L3, per-user). */
export interface SavedFilter {
  id: string;
  /** Which view the filter belongs to; legacy rows default to 'structures'. */
  view: SavedFilterView;
  name: string;
  definition: SavedFilterDefinition;
  /** ISO-8601 UTC. */
  created_at: string;
  /** ISO-8601 UTC. */
  updated_at: string;
}
