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
  color: string | null;
  style: LinkStyle;
  /** Line width in pixels. */
  width: number;
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
  color?: string | null;
  style?: LinkStyle;
  width?: number;
  description?: string | null;
}

/** Input accepted by `PATCH /link-types/{id}` (03-server-api.md §8). */
export interface LinkTypeUpdateInput {
  name_forward?: string;
  name_reverse?: string;
  color?: string | null;
  style?: LinkStyle;
  width?: number;
  description?: string | null;
}
