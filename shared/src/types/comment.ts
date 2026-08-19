/**
 * Comment entity (permanent / chronological).
 *
 * Field names mirror docs/02-data-model.md §3.8 and the REST contract in
 * docs/03-server-api.md §10.
 */

import type { CommentKind, CommentOwnerType } from '../enums.js';
import type { PermanentCommentPreview } from './thought.js';

/**
 * One attachment of a chronological comment to a thought or a link
 * (02-data-model.md §3.8, L20). `comments.owner_type/owner_id` keep the
 * primary (first) attachment; `comment_targets` is the full m2m set —
 * a chronological comment is visible in the list of every attached owner.
 * Permanent comments always have exactly one target.
 */
export interface CommentTarget {
  owner_type: CommentOwnerType;
  owner_id: string;
}

/** A permanent or chronological comment on a thought/link (02-data-model.md §3.8). */
export interface Comment {
  id: string;
  owner_type: CommentOwnerType;
  owner_id: string;
  /** All attachments (m2m, L20); includes the primary `owner_type/owner_id`. */
  targets: CommentTarget[];
  kind: CommentKind;
  /** Title for chronological comments; `null` for permanent. */
  title: string | null;
  /** Markdown source. */
  body_md: string;
  /** Pre-rendered HTML cached by the server. */
  body_html: string;
  /** ISO-8601 date — equals `created_at` for permanent comments. */
  valid_from: string;
  /** ISO-8601 date or `null` (open-ended; always `null` for permanent). */
  valid_to: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

/** Input accepted by `POST …/{id}/comments` (03-server-api.md §10).
 *  `valid_from`/`valid_to` are ignored for `kind = 'permanent'`. */
export interface CommentInput {
  kind: CommentKind;
  title?: string | null;
  body_md: string;
  valid_from?: string;
  valid_to?: string | null;
}

/** Input accepted by `PATCH /comments/{id}` (03-server-api.md §10). */
export interface CommentUpdateInput {
  title?: string | null;
  body_md?: string;
  valid_from?: string;
  valid_to?: string | null;
}

/**
 * Input accepted by `POST /networks/{nid}/comments` (03-server-api.md §10, L20):
 * a chronological comment attached to one or more owners at once.
 * `targets` must contain 1..N entries; duplicates are collapsed.
 */
export interface CommentInputWithTargets extends CommentInput {
  targets: CommentTarget[];
}

/** Превью одной хронологической записи (task N5): тело не длиннее
 * {@link COMMENT_PREVIEW_CHARS} символов с метаданными обрезки. */
export interface ChronoEntryPreview {
  id: string;
  /** Заголовок записи (02-data-model.md §3.8). */
  title: string | null;
  valid_from: string;
  valid_to: string | null;
  created_by: string;
  created_at: string;
  /** Первые {@link COMMENT_PREVIEW_CHARS} символов markdown-текста. */
  body_md: string;
  /** Сколько символов возвращено в `body_md`. */
  chars_returned: number;
  /** Полная длина тела записи. */
  chars_total: number;
  /** True, когда текст обрезан (`chars_total > chars_returned`). */
  truncated: boolean;
}

/** Превью хронологии (task N5): последние {@link CHRONO_PREVIEW_MAX_ENTRIES}
 * записей (по `valid_from` DESC) + метаданные полноты списка. */
export interface ChronologicalPreview {
  entries: ChronoEntryPreview[];
  /** Всего хронологических записей у владельца. */
  total: number;
  /** Сколько записей возвращено в `entries`. */
  returned: number;
  /** True, когда `returned < total` (список обрезан). */
  truncated: boolean;
}

/** Превью комментариев владельца (task N5, MCP `etn.thoughts.subgraph`
 * `include_comments`): постоянный — как в {@link ThoughtMeta.permanent},
 * хронология — последние записи с обрезкой тел. */
export interface CommentsPreview {
  /** Постоянный комментарий с обрезкой; `null`, когда его нет. */
  permanent: PermanentCommentPreview | null;
  chronological: ChronologicalPreview;
}
