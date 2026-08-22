/**
 * Network (мыслесеть) registry and membership types.
 *
 * Field names mirror docs/02-data-model.md §2.3–2.4 and the REST contract in
 * docs/03-server-api.md §5. Booleans represent semantic 0/1 INTEGER columns.
 */

import type { NetworkRole } from '../enums.js';

/**
 * Free-form markdown fields curated by the owner to make a network
 * self-describing for AI agents (task O5, docs/02-data-model.md §2.3,
 * docs/05-mcp-server.md §3):
 *
 * - `description` — 1–2 paragraph summary of the network's purpose.
 * - `when_to_use` — when to route a request to this network (per-use-case
 *   hints, often pointing at `conventions` / `examples` / `structure`).
 * - `conventions` — writing rules: chronicle format, active-flag usage,
 *   naming, links to types/templates.
 * - `examples` — worked good/bad records.
 *
 * Rendered on the server through `@etn/markdown`; the UI uses the same live
 * preview widget as for thought comments.
 */
export interface NetworkSelfDescription {
  description: string | null;
  when_to_use: string | null;
  conventions: string | null;
  examples: string | null;
}

/** Registry row of a network (02-data-model.md §2.3). */
export interface Network extends NetworkSelfDescription {
  id: string;
  display_name: string;
  owner_id: string;
  /**
   * Type id (UUID) from `thought_types` in `networks/<id>/data.db` that
   * marks every active thought of that type as a "node section" of the
   * network structure (task O5 §"Структура сети"). `null` means the owner
   * has not declared a structure. The value is opaque at the system level
   * — there is no cross-DB FK — so a stale id is tolerated but the
   * referenced type becomes un-deletable while any network points at it.
   */
  node_section_type_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Input for `POST /networks` (03-server-api.md §5.2). */
export interface CreateNetworkInput {
  display_name: string;
  description?: string | null;
}

/**
 * Input for `PATCH /networks/{id}` (03-server-api.md §5.3, task O5).
 *
 * Markdown fields are null-clearable: pass `null` (or `''`) to wipe. The
 * `node_section_type_id` is null-clearable too; when omitted, the existing
 * value is preserved.
 */
export interface UpdateNetworkInput {
  display_name?: string;
  description?: string | null;
  when_to_use?: string | null;
  conventions?: string | null;
  examples?: string | null;
  node_section_type_id?: string | null;
}

/** Membership row (02-data-model.md §2.4). */
export interface NetworkMember {
  network_id: string;
  user_id: string;
  role: NetworkRole;
  added_at: string;
  /** User id of the member who performed the add. */
  added_by: string;
}

/** Lightweight user reference used inside list responses. */
export interface UserRef {
  id: string;
  display_name: string | null;
}

/**
 * Item of `GET /networks` (03-server-api.md §5.1, task O5).
 *
 * `description` and `when_to_use` are returned in full — they are the two
 * short fields an agent reads when picking which network to use. `conventions`
 * and `examples` are intentionally NOT included here to keep the list
 * compact when many networks are visible; fetch them per-network on demand.
 */
export interface NetworkListItem {
  id: string;
  display_name: string;
  owner: UserRef;
  role: NetworkRole;
  members_count: number;
  /** Last focus thought id recorded by this client (L4), or null. */
  my_focus_thought_id: string | null;
  /** Free-form purpose (1–2 paragraphs). Always returned. */
  description: string | null;
  /** Routing hints: when to reach for this network. Always returned. */
  when_to_use: string | null;
  /**
   * True when the network declares a node-section type — i.e. it has a
   * machine-readable structure (use `etn.networks.structure` to read it).
   */
  has_structure: boolean;
}

/** Input for `POST /networks/{id}/members` (03-server-api.md §5.3). */
export interface AddMemberInput {
  user_id: string;
}

/** Input for `PATCH /networks/{id}/members/{uid}` — ownership transfer (03-server-api.md §5.3). */
export interface UpdateMemberInput {
  role: NetworkRole;
}
