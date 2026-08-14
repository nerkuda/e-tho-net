/**
 * Full-text search request/response shapes and mention hits.
 *
 * Mirrors docs/03-server-api.md §12–13. Snippets carry `<mark>…</mark>`
 * highlights produced by the server.
 */

import type { IconKind, SearchGroup, SearchScope } from '../enums.js';

/** Query parameters of `GET /search` (03-server-api.md §12). */
export interface SearchRequest {
  /** Search text. */
  q: string;
  /** Set to `'subtree'` to restrict the search to a subtree. */
  in?: 'subtree';
  /** Required when `in = 'subtree'`. */
  from_thought_id?: string;
  /** Defaults to `'all'`. */
  scope?: SearchScope;
  /** Repeatable filter by thought type. */
  type_id?: string[];
  /** Filter by link type (repeatable). */
  link_type_id?: string[];
  /** Override the user's `show_inactive` preference for this request. */
  show_inactive?: boolean;
  limit?: number;
  offset?: number;
}

/** Hit in the "by_names" group — thought name/synonym matches (§12). */
export interface SearchNameHit {
  thought_id: string;
  title: string;
  /** The thought's icon (rendered in the results list). */
  icon: string | null;
  icon_kind: IconKind;
  snippet: string;
  highlights: string[];
}

/** Hit in the "by_texts" group — thought comment matches (§12). */
export interface SearchTextHit {
  thought_id: string;
  title: string;
  /** The thought's icon (rendered in the results list). */
  icon: string | null;
  icon_kind: IconKind;
  snippet: string;
  comment_id: string;
  highlights: string[];
}

/** Hit in the "by_links" group — link title/comment matches (§12). */
export interface SearchLinkHit {
  link_id: string;
  type_name: string;
  snippet: string;
  highlights: string[];
}

/** Hit in the "by_chrono" group — chronological comment matches (§12). */
export interface SearchChronoHit {
  owner: 'thought' | 'link';
  owner_id: string;
  comment_id: string;
  valid_from: string;
  valid_to: string | null;
  snippet: string;
  highlights: string[];
}

/** Response of `GET /search` (03-server-api.md §12). */
export interface SearchResponse {
  by_names: SearchNameHit[];
  by_texts: SearchTextHit[];
  by_links: SearchLinkHit[];
  by_chrono: SearchChronoHit[];
  meta: SearchResponseMeta;
}

/** Per-group totals returned alongside {@link SearchResponse}. */
export interface SearchResponseMeta {
  total_in_group: Record<SearchGroup, number>;
}

/** Item of `GET /thoughts/{id}/mentions` (03-server-api.md §13). */
export interface MentionHit {
  owner_type: 'thought' | 'link';
  owner_id: string;
  title: string;
  comment_id: string;
  snippet: string;
}
