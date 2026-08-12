/**
 * Comment entity (permanent / chronological).
 *
 * Field names mirror docs/02-data-model.md §3.8 and the REST contract in
 * docs/03-server-api.md §10.
 */

import type { CommentKind, CommentOwnerType } from '../enums.js';

/** A permanent or chronological comment on a thought/link (02-data-model.md §3.8). */
export interface Comment {
  id: string;
  owner_type: CommentOwnerType;
  owner_id: string;
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
