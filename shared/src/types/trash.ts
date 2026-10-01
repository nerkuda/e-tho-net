/**
 * Mark-for-deletion ("корзина") DTOs (task S13, docs/03-server-api.md §6.5a,
 * §9.1, §14b; docs/02-data-model.md §3.1.2).
 *
 * `marked_for_deletion` is a plain, reversible column on thoughts and links —
 * the entity stays fully readable and editable until it is physically purged.
 * Physical deletion is blocked while other thoughts reference it through
 * link-property edges with `blocks_target_deletion` (0.8.1; до — через
 * `thought_ref`-значения) and, from 0.5.2, while layer shadow rows hold it;
 * `deletion-check` reports that blocking so the UI can refuse or offer to
 * resolve it first.
 */

import type { Link } from './link.js';
import type { Thought } from './thought.js';
import type {
  Publication,
  PublicationDeletionBlocking,
  Shelf,
  ShelfDeletionBlocking,
} from './publication.js';

/** A layer whose shadow row holds a thought/link back from physical deletion. */
export interface HoldingLayerRef {
  id: string;
  title: string;
}

/** What blocks a thought from being physically deleted. */
export interface ThoughtDeletionBlocking {
  /** Number of thoughts referencing this one through blocking link
   *  properties / leftover stored values. */
  properties: number;
  /** Layers holding the row (empty until layers land in 0.5.2, §3.1.2). */
  layers: HoldingLayerRef[];
}

/** Result of the thought `deletion-check` (03-server-api.md §6.5a). */
export interface ThoughtDeletionCheckResult {
  blocked: boolean;
  blocking: ThoughtDeletionBlocking;
  /** Children that would lose this parent (cascade touches links, not thoughts). */
  orphaned_children: number;
}

/** What blocks a link from being physically deleted. */
export interface LinkDeletionBlocking {
  /** Layers holding the row (empty until layers land in 0.5.2, §3.1.2). */
  layers: HoldingLayerRef[];
}

/** Result of the link `deletion-check` (03-server-api.md §6.5a). */
export interface LinkDeletionCheckResult {
  blocked: boolean;
  blocking: LinkDeletionBlocking;
}

/** A marked-for-deletion thought with its precomputed blocking (GET /trash). */
export type TrashThoughtEntry = Thought & {
  blocked: boolean;
  blocking: ThoughtDeletionBlocking;
};

/** A marked-for-deletion link with its precomputed blocking (GET /trash). */
export type TrashLinkEntry = Link & {
  blocked: boolean;
  blocking: LinkDeletionBlocking;
};

/**
 * A marked-for-deletion publication with its precomputed blocking
 * (GET /trash; 0.11.1, задача c59ce742, требование 200b87be).
 */
export type TrashPublicationEntry = Publication & {
  blocked: boolean;
  blocking: PublicationDeletionBlocking;
};

/**
 * A marked-for-deletion shelf with its precomputed blocking (GET /trash;
 * 0.11.1). Полка блокирована, пока в её составе есть публикации, и в рабочем
 * слое (физическое удаление — только в основе).
 */
export type TrashShelfEntry = Shelf & {
  blocked: boolean;
  blocking: ShelfDeletionBlocking;
};

/** Response of `GET /trash` (03-server-api.md §14b). */
export interface TrashListResult {
  thoughts: TrashThoughtEntry[];
  links: TrashLinkEntry[];
  publications: TrashPublicationEntry[];
  shelves: TrashShelfEntry[];
}

/** Response of `POST /trash/purge` (03-server-api.md §14b). */
export interface TrashPurgeResult {
  /** How many marked rows (thoughts/links/publications/shelves) were physically deleted. */
  purged: number;
  /** How many stayed behind because they were blocked. */
  skipped: number;
}

/** Response of `POST /thoughts/{id}/usage/clear` (03-server-api.md §9.2). */
export interface UsageClearResult {
  /** How many references were cleared (values nulled, edges trashed). */
  cleared: number;
}
