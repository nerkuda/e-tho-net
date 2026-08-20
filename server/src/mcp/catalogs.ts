/**
 * Type catalogues for MCP read responses (task N6, docs/05-mcp-server.md §4.1).
 *
 * Read tools return `type_id`/`link_type_id` as bare UUIDs; these helpers build
 * the accompanying reference tables (`thought_types` / `link_types`) containing
 * **only** the types actually present in the response, each with its name,
 * icon/color and — most importantly — the AI-facing `description` («комментарий
 * для AI»), so the agent understands the role of and requirements for every
 * type without extra calls or a full catalogue dump.
 */

import type { LinkTypeRef, ThoughtTypeRef } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import { getLinkType } from '../domain/link-type-service.js';
import { getThoughtType } from '../domain/thought-type-service.js';

/**
 * Catalogue of thought types keyed by type id: `{ [type_id]: {id, name,
 * description, icon} }`. Unknown/removed ids are skipped (`thoughts.type_id`
 * has no SQL FK).
 */
export function thoughtTypeCatalog(
  ndb: NetworkDb,
  ids: ReadonlyArray<string | null>,
): Record<string, ThoughtTypeRef> {
  const out: Record<string, ThoughtTypeRef> = {};
  for (const id of new Set(ids.filter((x): x is string => x !== null))) {
    const type = getThoughtType(ndb, id);
    if (type !== null) {
      out[id] = {
        id: type.id,
        name: type.name,
        parent_id: type.parent_id,
        is_root: type.is_root,
        description: type.description,
        icon: type.icon,
      };
    }
  }
  return out;
}

/**
 * Catalogue of link types keyed by type id: `{ [link_type_id]: {id,
 * name_forward, name_reverse, description, color, style} }`. Unknown/removed
 * ids are skipped (`links.type_id` has no SQL FK).
 */
export function linkTypeCatalog(
  ndb: NetworkDb,
  ids: ReadonlyArray<string | null>,
): Record<string, LinkTypeRef> {
  const out: Record<string, LinkTypeRef> = {};
  for (const id of new Set(ids.filter((x): x is string => x !== null))) {
    const type = getLinkType(ndb, id);
    if (type !== null) {
      out[id] = {
        id: type.id,
        name_forward: type.name_forward,
        name_reverse: type.name_reverse,
        parent_id: type.parent_id,
        is_root: type.is_root,
        description: type.description,
        color: type.color,
        style: type.style,
      };
    }
  }
  return out;
}
