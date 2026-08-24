/**
 * Bulk copy of thoughts across networks (workplan L26, `bb8277f6`).
 *
 * The clipboard on the client captures full snapshots of the source thoughts
 * (style, type for resolution, icon, permanent comment, property values,
 * attachments) and every link that lives entirely inside the selection. The
 * server then materialises them under a chosen parent in one transaction:
 *
 *  - each thought gets a new id, the type is resolved by id → by name →
 *    cleared (the root type is never assignable, L21);
 *  - for `thought_ref` property values the referenced thought is looked up
 *    by id → by title in the destination network; unresolvable values are
 *    dropped (the spec calls for a silent clear);
 *  - attachments are re-created with the visible fields the client sent
 *    (kind, url/file_path, mime_type, title, description, file_size) — the
 *    actual file bytes are **not** copied (only the path is kept, the user
 *    takes care of the file's availability later);
 *  - links among the copied thoughts are re-created with new ids and the
 *    same visual fields (type, colour, style, width, active) plus the
 *    permanent comment and attachments that travel with the link.
 *
 * Wiki-link rewriting in permanent comments is the client's job: when
 * `source_network_id !== <target network>` the renderer rewrites every
 * `[[#<id>]]` to `[[n:<source_network_id>#<id>]]` before sending the
 * snapshot. The server stores the rewritten body verbatim.
 *
 * On top of the inter-thought links the server also creates a plain untyped
 * parent-link from `parent_thought_id` to every new thought — the spec
 * requires the pasted thoughts to become children of the destination cloud.
 * These parent-links are NOT in the snapshot's `links[]`; they are a server
 * concern.
 */

import type { Attachment } from './attachment.js';
import type { IconKind, LinkStyle } from '../enums.js';
import type { Link } from './link.js';
import type { PropertyValueValue } from './thought-type.js';
import type { Thought } from './thought.js';

/**
 * Visual snapshot of a thought the client captured into its clipboard.
 * Carries no id (the server assigns one) but enough fields to recreate the
 * card verbatim: title, synonyms, type tag (for resolution), icon, style.
 */
export interface ThoughtCopySnapshot {
  title: string;
  synonyms: string[];
  /** Type tag for resolution on the target network: id wins, then name. */
  type: {
    id: string | null;
    name: string | null;
  };
  icon: string | null;
  icon_kind: IconKind;
  active: boolean;
  fg_color: string | null;
  bg_color: string | null;
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
}

/**
 * One attachment the client captured — only the visible fields. The id is
 * stripped (a new row is created) and the binary file is not transferred.
 */
export interface ThoughtCopyAttachment {
  kind: 'url' | 'file';
  url?: string | null;
  file_path?: string | null;
  file_size?: number | null;
  mime_type?: string | null;
  title?: string | null;
  description?: string | null;
}

/**
 * One thought + everything that travels with it (permanent comment, property
 * values, attachments). The client's clipboard stores an array of these keyed
 * by the source thought's original id.
 */
export interface ThoughtCopyItem {
  thought: ThoughtCopySnapshot;
  /** Permanent comment to recreate verbatim (rewritten client-side for
   *  cross-network wiki-links). `undefined` — the thought has none. */
  permanent_comment?: {
    title?: string | null;
    body_md: string;
  } | null;
  /**
   * Property values keyed by the source property **key** (not id — the id
   * is meaningless on the target network). For `thought_ref` the value is
   * a JSON `{ id, title }` shape the server tries to resolve by id then
   * by title; on miss the value is dropped.
   */
  properties?: Record<string, PropertyValueValue>;
  attachments?: ThoughtCopyAttachment[];
}

/**
 * One link among the copied thoughts, captured by the client. The server
 * re-creates it with a new id and the same visual style; the type is
 * resolved by id → by `name_forward` (then `name_reverse` if direction
 * is inverted — but the snapshot keeps the original direction) → cleared.
 */
export interface ThoughtCopyLink {
  /** Original source thought id (must be among `thoughts[].source_id`). */
  source_id: string;
  /** Original target thought id (must be among `thoughts[].source_id`). */
  target_id: string;
  /** Type tag for resolution on the target network. */
  type: {
    id: string | null;
    name_forward: string | null;
    name_reverse: string | null;
  };
  color: string | null;
  style: LinkStyle | null;
  width: number | null;
  active: boolean;
  /** Optional permanent comment for the link (none in the snapshot → none in
   *  the result). Cross-network wiki-links are rewritten client-side. */
  permanent_comment?: {
    title?: string | null;
    body_md: string;
  } | null;
  attachments?: ThoughtCopyAttachment[];
}

/**
 * Input of `POST /networks/:nid/thoughts/copy-batch` (workplan L26).
 * `source_network_id` records the network the snapshot was captured on —
 * the client uses it to rewrite cross-network wiki-links before sending.
 * `parent_thought_id` is the destination cloud; the server attaches the
 * new thoughts to it with plain untyped links.
 */
export interface ThoughtCopyInput {
  source_network_id: string;
  parent_thought_id: string;
  thoughts: ThoughtCopyItem[];
  links: ThoughtCopyLink[];
}

/**
 * What the server actually did. The id maps let the client remap local
 * references if it needs to (e.g. for `[[#<id>]]` rewriting inside the
 * same paste flow). The full entities are returned so the realtime
 * emission can hand them straight to the canvas.
 */
export interface ThoughtCopyResult {
  /** Source thought id (client-side) → newly created thought id. */
  thought_id_map: Record<string, string>;
  /** Link identity (`<src>:<tgt>:<type-or-empty>`) → newly created link id. */
  link_id_map: Record<string, string>;
  created_thoughts: Thought[];
  created_links: Link[];
  /** Attachments created on the destination — the client may want to
   *  inventory them when reporting the result. */
  created_attachments: Attachment[];
}
