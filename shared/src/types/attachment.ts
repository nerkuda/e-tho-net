/**
 * Attachment entity (URL / local file path).
 *
 * Field names mirror docs/02-data-model.md §3.9 and the REST contract in
 * docs/03-server-api.md §11. On MVP `kind = 'file'` stores a path in the user's
 * OS; the binary is not uploaded to the server.
 */

import type { AttachmentKind, AttachmentOwnerType } from '../enums.js';

/** An attachment on a thought/link (02-data-model.md §3.9). */
export interface Attachment {
  id: string;
  owner_type: AttachmentOwnerType;
  owner_id: string;
  kind: AttachmentKind;
  /** Populated when `kind = 'url'`. */
  url: string | null;
  /** Populated when `kind = 'file'` — path in the user's OS, not uploaded. */
  file_path: string | null;
  file_size: number | null;
  mime_type: string | null;
  /** Title; for URLs auto-filled with the page `<title>` when reachable. */
  title: string | null;
  /**
   * Preview icon as a `data:` URL — the site favicon for URL attachments
   * (auto-fetched on creation, best-effort). `null` when unavailable.
   */
  icon: string | null;
  description: string | null;
  /** Display order. */
  position: number;
  created_at: string;
  created_by: string;
}

/** Input accepted by `POST …/{id}/attachments` (03-server-api.md §11). */
export interface AttachmentInput {
  kind: AttachmentKind;
  url?: string | null;
  file_path?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
  title?: string | null;
  description?: string | null;
  position?: number;
}

/**
 * Input accepted by `POST …/{id}/attachments/file` (03-server-api.md §11): the
 * server decodes `data_base64` and stores the file under the network's
 * `attachments/` directory (next to `data.db`), returning a `kind = 'file'`
 * attachment whose `file_path` points at the stored copy.
 */
export interface AttachmentFileInput {
  title?: string | null;
  mime_type: string;
  data_base64: string;
}

/** Input accepted by `PATCH /attachments/{id}` (03-server-api.md §11). */
export interface AttachmentUpdateInput {
  url?: string | null;
  file_path?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
  title?: string | null;
  description?: string | null;
  position?: number;
  /** Preview icon (`data:` URL); `null` clears it. */
  icon?: string | null;
  /** Move the attachment to another owner (both fields must be supplied). */
  owner_type?: AttachmentOwnerType;
  owner_id?: string;
}

/**
 * Response of `GET /attachments/{id}/content` (03-server-api.md §11): the
 * content of a text-like file attachment for the built-in viewer/editor.
 * `text` is `null` for non-text attachments; `html` carries the server
 * markdown render for `.md` files.
 */
export interface AttachmentContent {
  mime_type: string | null;
  text: string | null;
  html: string | null;
  /** True when `text` was cut at the 200 000-character limit. */
  truncated: boolean;
}

/**
 * Input accepted by `PUT /attachments/{id}/content` (03-server-api.md §11):
 * overwrites the file of a text-like `kind = 'file'` attachment (≤10 MiB
 * decoded). An optional `mime_type` updates the stored row.
 */
export interface AttachmentContentUpdateInput {
  mime_type?: string;
  data_base64: string;
}

/** Response of `PUT /attachments/{id}/content`: the fresh markdown render. */
export interface AttachmentContentUpdateResult {
  html: string | null;
}

/**
 * Input of `POST /attachments/{id}/copy` (03-server-api.md §11, workplan L25).
 * Creates one new attachment row per `target_owner_ids`, all pointing at the
 * same `url`/`file_path` as the source — the underlying file is not duplicated.
 */
export interface AttachmentCopyInput {
  /** Target owner kind. Currently only `'thought'` is supported. */
  target_owner_type: AttachmentOwnerType;
  /** Ids of the target owners. All must exist; duplicates are skipped silently. */
  target_owner_ids: string[];
}

/** Result of `POST /attachments/{id}/copy`. */
export interface AttachmentCopyResult {
  /** Created rows in the order of `target_owner_ids`, skipping duplicates. */
  created: Attachment[];
  /** Ids of `target_owner_ids` that already had the same attachment. */
  skipped: string[];
}

/**
 * Query of `GET /attachments` (03-server-api.md §11, workplan L25).
 * `q` is required; without it the server returns an empty result
 * (no unscoped listing).
 */
export interface AttachmentSearchQuery {
  /** Keywords; same mini-syntax as the thought search (§6.10): AND of
   *  include-words, `-word` exclusion, `*` infix wildcard. */
  q: string;
  /** Filter to one attachment kind. */
  kind?: AttachmentKind;
  /** Exclude attachments of this owner (used by the editor's add dialog to
   *  hide rows already attached to the current thought/link). */
  exclude_owner_type?: AttachmentOwnerType;
  exclude_owner_id?: string;
  /** Result limit, default 50. */
  limit?: number;
  /** Offset for pagination. */
  offset?: number;
}
