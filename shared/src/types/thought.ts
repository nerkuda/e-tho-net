/**
 * Thought entity and focus-related types.
 *
 * Field names mirror docs/02-data-model.md §3.1, §3.10 and the REST contract in
 * docs/03-server-api.md §6. SQLite 0/1 INTEGER columns surface as `boolean`.
 * Internal-only columns (`title_norm`, `created_by`/`updated_by` on some
 * responses) are omitted or marked optional.
 */

import type { EtnErrorCode } from '../errors.js';
import type { FocusDir, IconKind, LinkStyle, SortKind, SortOrder } from '../enums.js';

/** A thought entity (02-data-model.md §3.1, 03-server-api.md §6.1). */
export interface Thought {
  id: string;
  title: string;
  type_id: string | null;
  icon: string | null;
  icon_kind: IconKind;
  /**
   * Id of the attachment (image file of this thought) whose full picture
   * Ctrl-hover shows over the icon; the icon itself stays a self-contained
   * preview (workplan L16). `null` — the icon has no backing attachment.
   */
  icon_attachment_id: string | null;
  active: boolean;
  /** Protected thoughts (HOME) cannot be deleted. */
  is_protected: boolean;
  /** Root thought of the network (HOME). */
  is_root: boolean;
  fg_color: string | null;
  bg_color: string | null;
  /**
   * Font-style flags. `null` means "inherit from the thought's type" (see
   * 02-data-model.md §3.1.1); `true`/`false` is an explicit manual value.
   */
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
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
  /** Attachment shown by Ctrl-hover over the icon; `null` clears the link (L16). */
  icon_attachment_id?: string | null;
  active?: boolean;
  fg_color?: string | null;
  bg_color?: string | null;
  /**
   * `null` clears the manual setting (the field is inherited from the type);
   * `true`/`false` sets an explicit manual value (02-data-model.md §3.1.1).
   */
  font_bold?: boolean | null;
  font_italic?: boolean | null;
  font_underline?: boolean | null;
  font_strike?: boolean | null;
}

/** Operators accepted by `POST /thoughts/batch` (03-server-api.md §6.6). */
export type ThoughtBatchOp =
  | 'set_type'
  | 'clear_type'
  | 'set_active'
  | 'set_inactive'
  | 'delete'
  | 'link_to_focus'
  | 'unlink_from_focus'
  // Bulk link operations of the structures filter commands (L22, §6.6):
  // anchors come in `parent_ids`/`child_ids`, new links are untyped and
  // existing pairs are left untouched.
  | 'link_parents'
  | 'link_children'
  | 'set_only_parents'
  | 'unlink_parents'
  | 'unlink_children';

/** Arguments for {@link ThoughtBatchInput}. */
export interface ThoughtBatchArgs {
  type_id?: string | null;
  active?: boolean;
  focus_thought_id?: string;
  link_type_id?: string | null;
  direction?: 'parent' | 'child';
  /** Anchor thought ids for `link_parents`/`set_only_parents`/`unlink_parents`. */
  parent_ids?: string[];
  /** Anchor thought ids for `link_children`/`unlink_children`. */
  child_ids?: string[];
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
  /** Backing attachment of the icon for Ctrl-hover zoom (L16); `null` — none. */
  icon_attachment_id: string | null;
  active: boolean;
  fg_color: string | null;
  bg_color: string | null;
  /** Manual (`true`/`false`) or `null` = inherit from the type (§3.1.1). */
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
}

/**
 * One group of the usage response: thoughts referencing the target thought
 * through one `thought_ref` property (03-server-api.md §9.1).
 */
export interface ThoughtUsageGroup {
  property_id: string;
  /** Property name (`type_properties.key`). */
  key: string;
  thoughts: ThoughtRef[];
}

/** Response of `GET /thoughts/{id}/usage` (03-server-api.md §9.1). */
export interface ThoughtUsage {
  /** Total number of referencing values across all groups. */
  total: number;
  groups: ThoughtUsageGroup[];
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
  /** Whether the neighbour has ANY incoming link (drives the top ellipse fill). */
  has_incoming: boolean;
  /** Whether the neighbour has ANY outgoing link (drives the bottom ellipse fill). */
  has_outgoing: boolean;
}

/**
 * A link among the visible thoughts of a focus response (03-server-api.md §6.2).
 * Unlike {@link FocusNeighbor} (which only carries the link to the focus), this
 * lists every active link between any two visible thoughts — including
 * neighbour↔neighbour — so the canvas can draw all visible links.
 */
export interface FocusEdge {
  id: string;
  source_id: string;
  target_id: string;
  type_id: string | null;
  /** Per-link override of the type's colour; `null` = inherit from the type. */
  color: string | null;
  /** Per-link override of the type's dash style; `null` = inherit. */
  style: LinkStyle | null;
  /** Per-link override of the type's width; `null` = inherit. */
  width: number | null;
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
  /** Every active link among the visible thoughts (focus + parents + children + siblings). */
  edges: FocusEdge[];
  /** Per-zone sort currently applied for this user (siblings is not orderable). */
  sorts: { parents: SortKind; children: SortKind };
}

/** «Сигналы полноты» мысли для MCP-чтения (task N2, docs/05-mcp-server.md
 * §3): счётчики соседних сущностей и превью постоянного комментария. */
export interface ThoughtMeta {
  /** Активные связи, входящие в мысль. */
  parents_count: number;
  /** Активные связи, исходящие из мысли. */
  children_count: number;
  /** Вложения мысли (url + file). */
  attachments_count: number;
  /** Хронологические комментарии мысли. */
  chrono_count: number;
  /**
   * Сколько раз мысль используется как `thought_ref`-значение свойств
   * других мыслей (формальные связи, «Использование» в редакторе —
   * 03-server-api.md §9.1).
   */
  usage_count: number;
  /**
   * Постоянный комментарий (ровно один на мысль) с обрезкой больших
   * текстов: `body_md` — первые {@link COMMENT_PREVIEW_CHARS}
   * символов; `chars_total` — полная длина, `truncated` — обрезан ли текст.
   * `null`, когда постоянного комментария нет.
   */
  permanent: PermanentCommentPreview | null;
}

/** Превью постоянного комментария (task N2). */
export interface PermanentCommentPreview {
  /** Id комментария — адрес для `etn.comments.get` (полный текст). */
  id: string;
  /** Первые 2000 символов markdown-текста. */
  body_md: string;
  /** Сколько символов возвращено в `body_md`. */
  chars_returned: number;
  /** Полная длина тела комментария. */
  chars_total: number;
  /** True, когда текст обрезан (`chars_total > chars_returned`). */
  truncated: boolean;
  /** Для permanent совпадает с `created_at` (02-data-model.md §3.8). */
  valid_from: string;
  created_at: string;
  updated_at: string;
}
