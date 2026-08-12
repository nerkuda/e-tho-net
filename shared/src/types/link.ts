/**
 * Link entity and grouped-link view types.
 *
 * Field names mirror docs/02-data-model.md §3.6 and the REST contract in
 * docs/03-server-api.md §7. SQLite 0/1 INTEGER columns surface as `boolean`.
 */

import type { ThoughtRef } from './thought.js';

/** A directed link between two thoughts (02-data-model.md §3.6). */
export interface Link {
  id: string;
  /** Thought the link originates from. */
  source_id: string;
  /** Thought the link points at. */
  target_id: string;
  type_id: string | null;
  active: boolean;
  version: number;
  /** ISO-8601 UTC. */
  created_at: string;
  updated_at: string;
  /** Author id of the link. */
  created_by?: string;
  /** User id of the last edit. */
  updated_by?: string;
}

/** Input accepted by `POST /links` (03-server-api.md §7.1). */
export interface LinkCreateInput {
  source_id: string;
  target_id: string;
  type_id?: string | null;
  active?: boolean;
}

/** Input accepted by `PATCH /links/{id}` (03-server-api.md §7.1). Also the
 *  `changes` payload of `link.updated` real-time events. */
export interface LinkUpdateInput {
  type_id?: string | null;
  active?: boolean;
}

/** A typed group of links returned for the editor (03-server-api.md §7.2). */
export interface ThoughtLinksByTypeGroup {
  type_id: string | null;
  type_name: string;
  items: ThoughtLinkItem[];
}

/** A single link + target thought inside a typed group. */
export interface ThoughtLinkItem {
  link: Link;
  target_thought: ThoughtRef;
}

/** Untyped-link group entry: the link plus the thought on the other side. */
export interface UntypedLinkItem {
  link: Link;
  /** The thought on the side opposite to the queried thought. */
  source_thought?: ThoughtRef;
  target_thought?: ThoughtRef;
}

/** Response of `GET /thoughts/{id}/links?group=type` (03-server-api.md §7.2). */
export interface ThoughtLinksGrouped {
  by_type: ThoughtLinksByTypeGroup[];
  untyped_parents: UntypedLinkItem[];
  untyped_children: UntypedLinkItem[];
}
