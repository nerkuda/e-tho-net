/**
 * «Хроника» view DTOs (L20): the two-phase chronological-comment query of
 * `POST /chronicle/query` (docs/03-server-api.md §20) and the per-user saved
 * filters of this view.
 *
 * Phase 1 selects **thoughts** (keywords / roots + subtree / thought types);
 * phase 2 lists chronological comments attached to those thoughts or to their
 * links (filtered by link types and the link scope), intersected with the
 * requested date range.
 */

import type { ChronicleLinkScope, SavedFilterView, SortOrder } from '../enums.js';
import type { CommentTarget } from './comment.js';
import type { ThoughtRef } from './thought.js';

/** Filter criteria of the chronicle query (03-server-api.md §20). */
export interface ChronicleFilter {
  /** Keywords mini-syntax (`*`/`-`, AND) — searched in thought titles,
   *  synonyms, permanent+chronological comment texts of thoughts and links. */
  keywords?: string;
  /** Root thoughts of the «мысли» field; empty = all thoughts of the network. */
  thought_ids?: string[];
  /** Include the roots' subordinates up to depth 20 (undirected, deduped). */
  include_subtree?: boolean;
  /** Thought types (OR inside the list). */
  type_ids?: string[];
  /** Link types (OR inside the list); empty = links of any type. */
  link_type_ids?: string[];
  /** Which endpoint of a link must be a selected thought (03-server-api.md §20). */
  link_scope?: ChronicleLinkScope;
  /** Period start (YYYY-MM-DD or ISO-8601); empty = unbounded. */
  date_from?: string | null;
  /** Period end; empty = unbounded. */
  date_to?: string | null;
}

/** Filter + paging of `POST /chronicle/query`. */
export interface ChronicleQueryRequest extends ChronicleFilter {
  /** Sort direction of (`valid_from`, `valid_to`, `title`). */
  order: SortOrder;
  limit: number;
  offset: number;
}

/** A link attachment of a chronicle row, resolved for display. */
export interface ChronicleTargetLink {
  id: string;
  type_id: string | null;
  active: boolean;
  /** Display name of the link type relative to source → target. */
  type_name_forward: string | null;
  /** Display name of the link type relative to target → source. */
  type_name_reverse: string | null;
  source: ThoughtRef;
  target: ThoughtRef;
}

/** One attachment of a chronicle row, resolved for display («мысли/связи»). */
export type ChronicleTarget =
  | { kind: 'thought'; thought: ThoughtRef }
  | { kind: 'link'; link: ChronicleTargetLink };

/** One row of the chronicle table (03-server-api.md §20). */
export interface ChronicleRow {
  id: string;
  title: string | null;
  valid_from: string;
  valid_to: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  /** Plain-text preview of `body_md` (~160 chars, `<mark>` highlights). */
  snippet: string;
  /** All attachments of the comment (m2m), resolved. */
  targets: ChronicleTarget[];
}

/** Result of `POST /chronicle/query` (list envelope: rows + total). */
export interface ChronicleQueryResponse {
  rows: ChronicleRow[];
  total: number;
}

/** Persisted criteria of a chronicle saved filter (03-server-api.md §18). */
export interface ChronicleFilterDefinition extends ChronicleFilter {
  order: SortOrder;
}

/** A named saved filter of the chronicle view (L3, per-user). */
export interface ChronicleSavedFilter {
  id: string;
  view: SavedFilterView;
  name: string;
  definition: ChronicleFilterDefinition;
  /** ISO-8601 UTC. */
  created_at: string;
  /** ISO-8601 UTC. */
  updated_at: string;
}
