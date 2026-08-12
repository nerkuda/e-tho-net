/**
 * Network (мыслесеть) registry and membership types.
 *
 * Field names mirror docs/02-data-model.md §2.3–2.4 and the REST contract in
 * docs/03-server-api.md §5. Booleans represent semantic 0/1 INTEGER columns.
 */

import type { NetworkRole } from '../enums.js';

/** Registry row of a network (02-data-model.md §2.3). */
export interface Network {
  id: string;
  display_name: string;
  owner_id: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

/** Input for `POST /networks` (03-server-api.md §5.2). */
export interface CreateNetworkInput {
  display_name: string;
  description?: string | null;
}

/** Input for `PATCH /networks/{id}` (03-server-api.md §5.3). */
export interface UpdateNetworkInput {
  display_name?: string;
  description?: string | null;
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

/** Item of `GET /networks` (03-server-api.md §5.1). */
export interface NetworkListItem {
  id: string;
  display_name: string;
  owner: UserRef;
  role: NetworkRole;
  members_count: number;
  /** Last focus thought id recorded by this client (L4), or null. */
  my_focus_thought_id: string | null;
}

/** Input for `POST /networks/{id}/members` (03-server-api.md §5.3). */
export interface AddMemberInput {
  user_id: string;
}

/** Input for `PATCH /networks/{id}/members/{uid}` — ownership transfer (03-server-api.md §5.3). */
export interface UpdateMemberInput {
  role: NetworkRole;
}
