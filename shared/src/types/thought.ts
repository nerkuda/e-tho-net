/**
 * Thought entity and focus-related types.
 *
 * Field names mirror docs/02-data-model.md §3.1, §3.10 and the REST contract in
 * docs/03-server-api.md §6. SQLite 0/1 INTEGER columns surface as `boolean`.
 * Internal-only columns (`title_norm`, `created_by`/`updated_by` on some
 * responses) are omitted or marked optional.
 */

import type { EtnErrorCode } from '../errors.js';
import type { FocusDir, IconKind, SortKind, SortOrder } from '../enums.js';

/** A thought entity (02-data-model.md §3.1, 03-server-api.md §6.1). */
export interface Thought {
  id: string;
  title: string;
  type_id: string | null;
  icon: string | null;
  icon_kind: IconKind;
  active: boolean;
  /** Protected thoughts (HOME) cannot be deleted. */
  is_protected: boolean;
  /** Root thought of the network (HOME). */
  is_root: boolean;
  fg_color: string | null;
  bg_color: string | null;
  font_bold: boolean;
  font_italic: boolean;
  font_underline: boolean;
  font_strike: boolean;
  /** Synonyms (from `thought_synonyms`), included on single-thought reads. */
  synonyms: string[];
  version: number;
  /** ISO-8601 UTC. */
  created_at: string;
  updated_at: string;
  /** Author id of the thought. Omitted on lightweight responses. */
  created_by?: string;
  /** User id of the last edit. Omitted on lightweight responses. */
  updated_by?: string;
}

/** Direction for an inline link created together with a thought (03-server-api.md §6.3). */
export interface ThoughtCreateLink {
  /**
   * `parent` — new thought is the source of a link to `target_thought_id`;
   * `child` — new thought is the target of a link from `target_thought_id`.
   */
  direction: 'parent' | 'child';
  target_thought_id: string;
  type_id?: string | null;
}

/** Input accepted by `POST /thoughts` (03-server-api.md §6.3). */
export interface ThoughtCreateInput {
  title: string;
  synonyms?: string[];
  type_id?: string | null;
  icon?: string | null;
  icon_kind?: IconKind;
  active?: boolean;
  fg_color?: string | null;
  bg_color?: string | null;
  font_bold?: boolean;
  font_italic?: boolean;
  font_underline?: boolean;
  font_strike?: boolean;
  create_link?: ThoughtCreateLink;
}

/** Input accepted by `PATCH /thoughts/{id}` (03-server-api.md §6.4). Also used
 *  as the `changes` payload of `thought.updated` real-time events. */
export interface ThoughtUpdateInput {
  title?: string;
  synonyms?: string[];
  type_id?: string | null;
  icon?: string | null;
  icon_kind?: IconKind;
  active?: boolean;
  fg_color?: string | null;
  bg_color?: string | null;
  font_bold?: boolean;
  font_italic?: boolean;
  font_underline?: boolean;
  font_strike?: boolean;
}

/** Operators accepted by `POST /thoughts/batch` (03-server-api.md §6.6). */
export type ThoughtBatchOp =
  | 'set_type'
  | 'clear_type'
  | 'set_active'
  | 'set_inactive'
  | 'delete'
  | 'link_to_focus'
  | 'unlink_from_focus';

/** Arguments for {@link ThoughtBatchInput}. */
export interface ThoughtBatchArgs {
  type_id?: string | null;
  active?: boolean;
  focus_thought_id?: string;
  link_type_id?: string | null;
  direction?: 'parent' | 'child';
}

/** Input accepted by `POST /thoughts/batch` (03-server-api.md §6.6). */
export interface ThoughtBatchInput {
  ids: string[];
  op: ThoughtBatchOp;
  args?: ThoughtBatchArgs;
}

/** Result of `POST /thoughts/batch` (03-server-api.md §6.6). */
export interface ThoughtBatchResult {
  affected: number;
  failures: ThoughtBatchFailure[];
}

/** Per-id failure inside a {@link ThoughtBatchResult}. */
export interface ThoughtBatchFailure {
  id: string;
  code: EtnErrorCode;
  message: string;
}

/**
 * Lightweight thought metadata returned by `POST /thoughts/resolve`
 * (03-server-api.md §6.9). Used for focus history, mentions, etc.
 */
export interface ThoughtRef {
  id: string;
  title: string;
  type_id: string | null;
  icon: string | null;
  icon_kind: IconKind;
  active: boolean;
  fg_color: string | null;
  bg_color: string | null;
  font_bold: boolean;
  font_italic: boolean;
  font_underline: boolean;
  font_strike: boolean;
}

/** Per-user view mark, drives the "viewed" sort (02-data-model.md §3.10.2). */
export interface ThoughtView {
  user_id: string;
  thought_id: string;
  /** ISO-8601 UTC. */
  last_viewed_at: string;
}

/** Per-user focus-zone sort selection (02-data-model.md §3.10.3). */
export interface UserFocusPreferences {
  user_id: string;
  focus_thought_id: string;
  dir: FocusDir;
  sort: SortKind;
  sort_order: SortOrder;
  updated_at: string;
}

/** A single row of `user_focus_order` — a manual position (02-data-model.md §3.10.4). */
export interface UserFocusOrderEntry {
  user_id: string;
  focus_thought_id: string;
  /** Manual order is only stored for parents/children, never siblings. */
  dir: Exclude<FocusDir, 'siblings'>;
  thought_id: string;
  position: number;
  updated_at: string;
}

/** Input for `PUT /thoughts/{fid}/focus-preferences` (03-server-api.md §6.8). */
export interface FocusPreferencesInput {
  dir: FocusDir;
  sort: SortKind;
  order: SortOrder;
}

/** Input for `POST /thoughts/{fid}/focus-order` (03-server-api.md §6.8). */
export interface FocusOrderInput {
  dir: Exclude<FocusDir, 'siblings'>;
  ordered_ids: string[];
}

/** A neighbour returned inside a focus response (03-server-api.md §6.2). */
export interface FocusNeighbor {
  id: string;
  title: string;
  type_id: string | null;
  icon: string | null;
  active: boolean;
  /** Id of the link connecting the focused thought to this neighbour. */
  link_id: string;
  link_type_id: string | null;
  link_active: boolean;
}

/** Response of `POST /thoughts/{id}/focus` (03-server-api.md §6.2). */
export interface FocusResponse {
  /** The focused thought (full entity). */
  focused: Thought;
  /** Sources of links pointing at the focused thought. */
  parents: FocusNeighbor[];
  /** Targets of links originating at the focused thought. */
  children: FocusNeighbor[];
  /** Thoughts sharing a parent with the focused thought. */
  siblings: FocusNeighbor[];
}
