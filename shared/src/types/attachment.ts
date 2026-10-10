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
  /**
   * Id пользователя, последним изменившего вложение (требование e6d4165e).
   * Колонка `updated_by` физически добавлена миграцией 033 — у таблицы
   * `attachments` исторически не было своей ISO-колонки `updated_at`,
   * миллисекундных достаточно для сортировки и пометки свежести.
   * Сервер всегда возвращает; помечено `?` чтобы клиентские фикстуры и
   * устаревший код могли собирать объект без него до этапа 3.
   */
  updated_by?: string;
  /** Unix-миллисекунды `created_at` (для сортировки). */
  created_at_ms?: number;
  /** Unix-миллисекунды последнего изменения вложения. */
  updated_at_ms?: number;
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
 * Input of the attachment-creation entry point shared by the REST/MCP facades
 * (`createAttachmentFromInput`, задача 75c75a2f): the ordinary metadata-only
 * `AttachmentInput`, or — when `data_base64` carries a payload — an inline file
 * upload equivalent to `POST …/{id}/attachments/file`.
 *
 * With `data_base64` set, `kind` must be `'file'` (the server stores the
 * decoded bytes under the network's `attachments/` directory) and
 * `url`/`file_path`/`file_size`/`position`/`description` must be omitted — the
 * stored-file path replaces them.
 */
export interface AttachmentCreateInput extends AttachmentInput {
  /** Base64 payload of a file to store server-side (≤10 MiB decoded). */
  data_base64?: string | null;
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
 * With multi-ownership (0.12.1, ADR `9f90b010`) the operation degenerates into
 * adding owners of the SAME attachment — no new rows are created.
 */
export interface AttachmentCopyInput {
  /** Target owner kind: `thought` | `link` | `publication`. */
  target_owner_type: AttachmentOwnerType;
  /** Ids of the target owners. All must exist; duplicates are skipped silently. */
  target_owner_ids: string[];
}

/**
 * Result of `POST /attachments/{id}/copy` (0.12.1, ADR `9f90b010`): with
 * multi-ownership the operation degenerates into adding owners of the SAME
 * attachment — no new rows are created. `added` lists the ownerships created
 * (in request order), `skipped` those that already existed.
 */
export interface AttachmentCopyResult {
  /** Ownerships created, in the order of `target_owner_ids`. */
  added: AttachmentOwnerRef[];
  /** Ownerships that already existed (idempotent no-op). */
  skipped: AttachmentOwnerRef[];
}

/** Result of adding owners (`POST /attachments/{id}/owners`). */
export interface AttachmentOwnerChangeResult {
  /** Ownerships created, in the order of the requested owner ids. */
  added: AttachmentOwnerRef[];
  /** Ownerships that already existed (idempotent no-op). */
  skipped: AttachmentOwnerRef[];
}

/**
 * Result of `DELETE /attachments/{id}/owners` — removing one ownership
 * (0.12.1, ADR `9f90b010`). `attachment_deleted` is `true` when the last live
 * ownership across ALL layers went away and the attachment row (and its
 * server-stored file) was removed with it.
 */
export interface AttachmentOwnerRemoveResult {
  removed: boolean;
  attachment_deleted: boolean;
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

/**
 * Ссылка на владельца вложения в ответе «использование вложения»
 * (0.11.1, задача 46cf4bcb). `title` — название мысли или публикации;
 * у связи собственного названия нет, поэтому `null`.
 */
export interface AttachmentOwnerRef {
  owner_type: AttachmentOwnerType;
  owner_id: string;
  title: string | null;
}

/**
 * Ответ «использование вложения» (0.11.1, задача 46cf4bcb): все владельцы
 * (мысли, связи, публикации), которые держат ЭТО вложение.
 *
 * Одна строка вложения имеет ровно одного владельца, но общий физический
 * носитель (файл/URL) может быть привязан несколькими строками — прежде всего
 * при копировании вложения на другого владельца (ADR 73cfcf64). Поэтому в
 * ответ попадают владельцы всех живых строк с тем же `kind` и тем же
 * `url`/`file_path` — это и есть «облачка» мыслей и публикаций в диалоге
 * выбора обложки. Порядок детерминирован: владельцы группы `thought`, затем
 * `publication`, затем `link`; внутри группы — по id владельца.
 */
export interface AttachmentUsage {
  /** Строка вложения, для которой запрошено использование (её id). */
  attachment_id: string;
  /** Владельцы общего носителя, без дублей. */
  owners: AttachmentOwnerRef[];
}
