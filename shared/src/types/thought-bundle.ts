/**
 * Composite "unit of knowledge" bundle (task O1, docs/05-mcp-server.md §4.2a).
 *
 * A thought plus its permanent comment, a map of property values, links and
 * attachments, written by the domain layer (`thought-bundle-service.ts`) in a
 * single transaction. These are the domain-facing input/output DTOs (full
 * entities); the MCP-facing parameter/result shapes live in `mcp.ts`.
 */

import type { AttachmentInput, Attachment } from './attachment.js';
import type { Comment } from './comment.js';
import type { Link } from './link.js';
import type { Thought } from './thought.js';
import type { PropertyValue, PropertyValueValue } from './thought-type.js';
import type { ThoughtCardWarning } from './thought-card-warning.js';

/** How an existing duplicate candidate was matched (mirrors `find_duplicates`). */
export type ThoughtBundleMatchKind = 'title' | 'synonym' | 'partial';

/** Policy for handling a `find_duplicates` match against `thought.title`/`synonyms`. */
export type ThoughtBundleOnDuplicate = 'fail' | 'reuse' | 'update';

/** New/patched fields of the bundle's own thought. */
export interface ThoughtBundleThoughtInput {
  title: string;
  synonyms?: string[];
  type_id?: string | null;
  active?: boolean;
}

/** A link attached to the bundle's thought, direction relative to it. */
export interface ThoughtBundleLinkInput {
  /** `parent` — the bundle thought sources a link to `target_thought_id`;
   *  `child` — `target_thought_id` sources a link to the bundle thought.
   *  NOTE: the MCP tool `etn.thoughts.upsert_bundle` uses the opposite,
   *  agent-facing semantics (bug fix 045) and inverts the value at its
   *  boundary before calling the domain service. */
  direction: 'parent' | 'child';
  target_thought_id: string;
  type_id?: string | null;
}

/** The bundle's permanent comment (create-or-update, like `etn.comments.upsert`). */
export interface ThoughtBundleCommentInput {
  title?: string | null;
  body_md: string;
  valid_from?: string;
  valid_to?: string | null;
}

/**
 * Input of {@link upsertThoughtBundle}. Exactly one of `thought_id`/`thought`
 * must be provided: `thought_id` addresses an existing thought to augment
 * in-place; `thought` describes a new-or-matched thought resolved through
 * `find_duplicates` + `on_duplicate` (default `'fail'`).
 */
export interface ThoughtBundleInput {
  thought_id?: string;
  thought?: ThoughtBundleThoughtInput;
  on_duplicate?: ThoughtBundleOnDuplicate;
  comment?: ThoughtBundleCommentInput;
  properties?: Record<string, PropertyValueValue>;
  links?: ThoughtBundleLinkInput[];
  attachments?: AttachmentInput[];
}

/** What {@link upsertThoughtBundle} actually did to the bundle's thought. */
export type ThoughtBundleThoughtAction = 'created' | 'updated' | 'reused';

/** Result of {@link upsertThoughtBundle} — full entities (server-internal). */
export interface ThoughtBundleResult {
  thought: Thought;
  thought_action: ThoughtBundleThoughtAction;
  /** Strongest `find_duplicates` match that led to `reused`/`updated`; `null`
   *  when the thought was freshly created or addressed by `thought_id`. */
  matched_on: ThoughtBundleMatchKind | null;
  comment?: Comment;
  comment_action?: 'created' | 'updated';
  properties?: Record<string, PropertyValue>;
  links?: Link[];
  attachments?: Attachment[];
  /**
   * "Card completeness" warnings about the resulting card (task O6). Always
   * populated: empty array when the type has no `required` properties or all
   * of them are filled. The MCP layer surfaces this to the agent verbatim;
   * REST ignores it (the contract change is additive, docs/05-mcp-server.md
   * §4.2).
   */
  warnings?: ThoughtCardWarning[];
}
