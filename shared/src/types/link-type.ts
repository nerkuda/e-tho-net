/**
 * Link type entity.
 *
 * Field names mirror docs/02-data-model.md §3.7 and the REST contract in
 * docs/03-server-api.md §8.
 */

import type { LinkStyle } from '../enums.js';

/** User-defined link type (02-data-model.md §3.7). */
export interface LinkType {
  id: string;
  /** Name when read source → target. */
  name_forward: string;
  /** Name when read target → source. */
  name_reverse: string;
  /** Parent type id; `null` only on the root type («основной тип»). */
  parent_id: string | null;
  /** True for the single undeletable root of the type tree. */
  is_root: boolean;
  color: string | null;
  /**
   * Line style. `null` — inherit from the parent type (the root falls back to
   * the application default `solid`).
   */
  style: LinkStyle | null;
  /**
   * Line width in pixels. `null` — inherit from the parent type (the root
   * falls back to the application default `1`).
   */
  width: number | null;
  /** Free-form description used to give AI agents context about the type. */
  description: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string;
}

/** Input accepted by `POST /link-types` (03-server-api.md §8). */
export interface LinkTypeInput {
  name_forward: string;
  name_reverse: string;
  parent_id?: string | null;
  color?: string | null;
  /** `null` — inherit the parent type's style. */
  style?: LinkStyle | null;
  /** `null` — inherit the parent type's width. */
  width?: number | null;
  description?: string | null;
}

/** Input accepted by `PATCH /link-types/{id}` (03-server-api.md §8). */
export interface LinkTypeUpdateInput {
  name_forward?: string;
  name_reverse?: string;
  /** Changing the parent is rejected while the type is in use by links. */
  parent_id?: string | null;
  color?: string | null;
  /** `null` — inherit the parent type's style. */
  style?: LinkStyle | null;
  /** `null` — inherit the parent type's width. */
  width?: number | null;
  description?: string | null;
}
