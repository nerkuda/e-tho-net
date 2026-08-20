/**
 * Shared helpers for the type hierarchy (L21, docs/02-data-model.md §3.3/§3.7).
 *
 * `thought_types` and `link_types` are trees with a single undeletable root
 * («основной тип», `is_root = 1`). Both tables expose the same `parent_id`
 * column, so every helper below is table-parameterised. The trees are tiny,
 * so plain per-row parent walks are fine — no recursive CTEs needed.
 */

import { EtnError } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/** Which of the two type tables a hierarchy helper operates on. */
export type TypeTable = 'thought_types' | 'link_types';

/** Maximum tree depth including the root (docs/08-ui-spec.md §8.1). */
export const MAX_TYPE_DEPTH = 4;

/** Minimal `id, parent_id, is_root, name` projection shared by both tables. */
export interface TypeNodeRow {
  id: string;
  parent_id: string | null;
  is_root: number;
}

/** Read the id/parent_id/is_root projection of every row of a type table. */
export function listTypeNodes(ndb: NetworkDb, table: TypeTable): TypeNodeRow[] {
  return ndb.prepare(`SELECT id, parent_id, is_root FROM ${table}`).all() as TypeNodeRow[];
}

/** The single root type of a table, or `null` (only possible mid-migration). */
export function getRootTypeId(ndb: NetworkDb, table: TypeTable): string | null {
  const row = ndb
    .prepare(`SELECT id FROM ${table} WHERE is_root = 1`)
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * The chain of a type's ancestor ids, from the type itself up to (and
 * including) the root. Unknown ids yield an empty chain.
 */
export function typeAncestors(ndb: NetworkDb, table: TypeTable, typeId: string): string[] {
  const byId = new Map(listTypeNodes(ndb, table).map((n) => [n.id, n]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(typeId);
  while (current) {
    if (seen.has(current.id)) break; // corrupt cycle — stop defensively
    seen.add(current.id);
    chain.push(current.id);
    if (current.parent_id === null) break;
    current = byId.get(current.parent_id);
  }
  return chain;
}

/** Depth of a type in the tree: the root is 1, its children 2, and so on. */
export function typeDepth(ndb: NetworkDb, table: TypeTable, typeId: string): number {
  return typeAncestors(ndb, table, typeId).length;
}

/** Height of the subtree rooted at a type: a leaf is 1. Unknown id → 0. */
export function subtreeHeight(ndb: NetworkDb, table: TypeTable, typeId: string): number {
  const childrenOf = new Map<string, string[]>();
  for (const node of listTypeNodes(ndb, table)) {
    if (node.parent_id === null) continue;
    const list = childrenOf.get(node.parent_id);
    if (list) list.push(node.id);
    else childrenOf.set(node.parent_id, [node.id]);
  }
  const height = (id: string): number => {
    const kids = childrenOf.get(id) ?? [];
    let best = 0;
    for (const kid of kids) best = Math.max(best, height(kid));
    return 1 + best;
  };
  return height(typeId);
}

/**
 * Every type id in the subtree rooted at `typeId`, including itself. Used to
 * expand `type_ids` filters: matching a parent type matches its descendants
 * with OR semantics (docs/03-server-api.md §6.10/§20).
 */
export function subtreeIds(ndb: NetworkDb, table: TypeTable, typeId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const node of listTypeNodes(ndb, table)) {
    if (node.parent_id === null) continue;
    const list = childrenOf.get(node.parent_id);
    if (list) list.push(node.id);
    else childrenOf.set(node.parent_id, [node.id]);
  }
  const out: string[] = [];
  const walk = (id: string): void => {
    out.push(id);
    for (const kid of childrenOf.get(id) ?? []) walk(kid);
  };
  walk(typeId);
  return out;
}

/**
 * Expand a list of type ids to itself plus all descendants (deduplicated).
 * An empty list stays empty (= no filter). Unknown ids are kept verbatim —
 * they match nothing (type columns only store existing ids), which preserves
 * the «deleted type in a saved filter filters everything out» behaviour.
 */
export function expandTypeIdsToSubtree(
  ndb: NetworkDb,
  table: TypeTable,
  ids: readonly string[],
): string[] {
  if (ids.length === 0) return [];
  const known = new Set(listTypeNodes(ndb, table).map((n) => n.id));
  const expanded = new Set<string>();
  for (const id of ids) {
    if (!known.has(id)) {
      expanded.add(id);
      continue;
    }
    for (const sub of subtreeIds(ndb, table, id)) expanded.add(sub);
  }
  return [...expanded];
}

/**
 * Validate a parent assignment for a type (create or reparent).
 *
 * Throws `NOT_FOUND` when the parent does not exist and `VALIDATION_ERROR`
 * when the parent is the type itself, one of its descendants (would create a
 * cycle), or when the resulting tree would exceed {@link MAX_TYPE_DEPTH}
 * levels.
 */
export function assertParentValid(
  ndb: NetworkDb,
  table: TypeTable,
  typeId: string | null,
  parentId: string | null,
): void {
  // null parent means «directly under the root» — nothing to validate.
  if (parentId === null) return;
  const parent = ndb.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(parentId) as
    | { id: string }
    | undefined;
  if (!parent) {
    throw new EtnError('NOT_FOUND', `parent type ${parentId} not found`, {
      entity: 'type',
      id: parentId,
    });
  }
  if (typeId !== null) {
    if (parentId === typeId) {
      throw new EtnError('VALIDATION_ERROR', 'тип не может быть родителем самого себя', {
        entity: 'type',
        id: typeId,
      });
    }
    if (subtreeIds(ndb, table, typeId).includes(parentId)) {
      throw new EtnError('VALIDATION_ERROR', 'родительский тип не может быть подчинённым этого типа', {
        entity: 'type',
        id: typeId,
        parent_id: parentId,
      });
    }
  }
  // Depth check: the parent's own depth + the height of the type's subtree
  // must fit into MAX_TYPE_DEPTH levels.
  const parentDepth = typeDepth(ndb, table, parentId);
  const subtree = typeId === null ? 1 : subtreeHeight(ndb, table, typeId);
  if (parentDepth + subtree > MAX_TYPE_DEPTH) {
    throw new EtnError(
      'VALIDATION_ERROR',
      `вложенность типов ограничена ${MAX_TYPE_DEPTH} уровнями, включая корневой тип`,
      { entity: 'type', id: typeId, parent_id: parentId },
    );
  }
}
