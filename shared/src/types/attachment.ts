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
  /** Title; for URLs this is the page title (client-provided on MVP). */
  title: string | null;
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

/** Input accepted by `PATCH /attachments/{id}` (03-server-api.md §11). */
export interface AttachmentUpdateInput {
  url?: string | null;
  file_path?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
  title?: string | null;
  description?: string | null;
  position?: number;
}
