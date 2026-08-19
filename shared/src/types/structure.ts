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

/** Filter criteria of the structures query (03-server-api.md §6.10). */
export interface StructureFilter {
  /** Keywords mini-syntax: whitespace-separated words, `*` wildcard, `-` exclusion. */
  keywords?: string;
  /** Thought types (OR inside the list). */
  type_ids?: string[];
  /** The thought has an active link of any of these types in either direction. */
  link_type_ids?: string[];
  /** Property conditions (AND between conditions). */
  properties?: StructurePropertyCondition[];
  show_inactive?: boolean;
}

/** Filter + paging of `POST /thoughts/query` (the list envelope of §6.10). */
export interface StructureQueryRequest extends StructureFilter {
  sort: StructureSort;
  order: SortOrder;
  limit: number;
  offset: number;
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

/** Response of `GET /thoughts/{id}/hierarchy` (03-server-api.md §6.11). */
export interface HierarchyResponse {
  /** Parents (link sources) or children (link targets) after `exclude_ids` dedup. */
  neighbors: ThoughtRef[];
  /** Active links between the expanded thought and the returned neighbors. */
  edges: FocusEdge[];
  /** true — more neighbors were dropped by the per-node limit. */
  truncated: boolean;
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
