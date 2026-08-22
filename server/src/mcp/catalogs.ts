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

import type {
  CompactLink,
  CompactLinkTypeRef,
  CompactThought,
  CompactThoughtRef,
  Link,
  LinkTypeRef,
  Thought,
  ThoughtRef,
  ThoughtTypeRef,
} from '@etn/shared';

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

// ---------------------------------------------------------------------------
// Compact projection (task O12, docs/05-mcp-server.md §4.1)
// ---------------------------------------------------------------------------

/**
 * Compact link-type catalogue (task O12). Same keying as
 * {@link linkTypeCatalog}, but each entry drops the visual line-style fields
 * (`color`, `style`) — agents consume `name_forward`/`name_reverse`/
 * `description` to reason about a link type, not to render it.
 */
export function linkTypeCatalogCompact(
  ndb: NetworkDb,
  ids: ReadonlyArray<string | null>,
): Record<string, CompactLinkTypeRef> {
  const full = linkTypeCatalog(ndb, ids);
  const out: Record<string, CompactLinkTypeRef> = {};
  for (const [id, entry] of Object.entries(full)) {
    out[id] = {
      id: entry.id,
      name_forward: entry.name_forward,
      name_reverse: entry.name_reverse,
      parent_id: entry.parent_id,
      is_root: entry.is_root,
      description: entry.description,
    };
  }
  return out;
}

/**
 * Project a {@link Thought} into the compact shape used by MCP read tools
 * under `view: 'compact'` (task O12). Drops the visual/service fields the
 * agent never consumes (colours, font-style flags, icon attachment id,
 * `is_protected`/`is_root`); keeps `icon` (the emoji / image reference
 * itself) because it carries semantic information the agent uses to
 * recognise a node.
 */
export function toCompactThought(thought: Thought): CompactThought {
  return {
    id: thought.id,
    title: thought.title,
    type_id: thought.type_id,
    icon: thought.icon,
    active: thought.active,
    synonyms: thought.synonyms,
    version: thought.version,
    created_at: thought.created_at,
    updated_at: thought.updated_at,
    ...(thought.created_by !== undefined ? { created_by: thought.created_by } : {}),
    ...(thought.updated_by !== undefined ? { updated_by: thought.updated_by } : {}),
  };
}

/**
 * Project a {@link ThoughtRef} (used by neighbours, usage) into the compact
 * shape under `view: 'compact'` (task O12). Drops the visual fields the
 * reference carried (colours, font flags, icon attachment id).
 */
export function toCompactThoughtRef(ref: ThoughtRef): CompactThoughtRef {
  return {
    id: ref.id,
    title: ref.title,
    type_id: ref.type_id,
    icon: ref.icon,
    active: ref.active,
  };
}

/**
 * Project a {@link Link} into the compact shape used by
 * `etn.thoughts.subgraph` (and any future edge-returning tool) under
 * `view: 'compact'` (task O12). Drops the per-link style overrides
 * (`color`, `style`, `width`) — agents reason over the topology, they do
 * not re-render the canvas.
 */
export function toCompactLink(link: Link): CompactLink {
  return {
    id: link.id,
    source_id: link.source_id,
    target_id: link.target_id,
    type_id: link.type_id,
    active: link.active,
    version: link.version,
    created_at: link.created_at,
    updated_at: link.updated_at,
    ...(link.created_by !== undefined ? { created_by: link.created_by } : {}),
    ...(link.updated_by !== undefined ? { updated_by: link.updated_by } : {}),
  };
}
