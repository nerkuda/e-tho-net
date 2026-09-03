/**
 * Type-tree helpers (L21, docs/08-ui-spec.md §8.1).
 *
 * Pure functions over the flat type catalogues (`store.thoughtTypes` /
 * `store.linkTypes`): tree building/flattening for the UI lists, chain-based
 * resolution of visual settings (a type inherits icon/colours/font — or line
 * style for link types — from its ancestors; `null` on a field means
 * «inherit»), and subtree expansion for type filters. The catalogues are tiny,
 * so per-call linear scans are fine.
 */

import type { LinkStyle, LinkType, ThoughtType } from '@etn/shared';

import type { TypeOption } from './type-combobox.js';

/** Minimal catalogue entry shape shared by both type kinds. */
export interface TypeNode {
  id: string;
  parent_id: string | null;
  is_root: boolean;
}

/** A tree node built from a flat catalogue entry. */
export interface TypeTreeNode<T extends TypeNode> {
  type: T;
  depth: number; // root = 1
  children: TypeTreeNode<T>[];
}

/** Sort key of a catalogue entry (thought types: name; link types: forward name). */
function typeSortKey(t: { name?: string; name_forward?: string }): string {
  return t.name ?? t.name_forward ?? '';
}

/** Build the type tree from a flat catalogue; the root is the only top node. */
export function buildTypeTree<T extends TypeNode>(types: readonly T[]): TypeTreeNode<T>[] {
  const byId = new Map(types.map((t) => [t.id, { type: t, depth: 1, children: [] } as TypeTreeNode<T>]));
  const roots: TypeTreeNode<T>[] = [];
  for (const node of byId.values()) {
    const parent = node.type.parent_id !== null ? byId.get(node.type.parent_id) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
      node.depth = parent.depth + 1;
    } else {
      roots.push(node);
    }
  }
  // A detached node whose parent id points nowhere still has depth 1 here;
  // fix depths once the tree is assembled (children attached above).
  const fixDepth = (node: TypeTreeNode<T>, depth: number): void => {
    node.depth = depth;
    node.children.sort((a, b) =>
      typeSortKey(a.type as { name?: string; name_forward?: string }).localeCompare(
        typeSortKey(b.type as { name?: string; name_forward?: string }),
        'ru',
      ),
    );
    for (const child of node.children) fixDepth(child, depth + 1);
  };
  for (const root of roots) fixDepth(root, 1);
  roots.sort((a, b) =>
    typeSortKey(a.type as { name?: string; name_forward?: string }).localeCompare(
      typeSortKey(b.type as { name?: string; name_forward?: string }),
      'ru',
    ),
  );
  return roots;
}

/** A flattened row of the tree for rendering (`depth` drives the indent). */
export interface FlatTypeRow<T extends TypeNode> {
  type: T;
  depth: number;
  hasChildren: boolean;
}

/**
 * Flatten the tree depth-first, keeping only nodes whose parent chain is
 * expanded. Used by every tree list (type manager, comboboxes, filter panels).
 */
export function flattenTypeTree<T extends TypeNode>(
  roots: readonly TypeTreeNode<T>[],
  expanded: ReadonlySet<string>,
): FlatTypeRow<T>[] {
  const out: FlatTypeRow<T>[] = [];
  const walk = (nodes: readonly TypeTreeNode<T>[]): void => {
    for (const node of nodes) {
      out.push({ type: node.type, depth: node.depth, hasChildren: node.children.length > 0 });
      if (node.children.length > 0 && expanded.has(node.type.id)) walk(node.children);
    }
  };
  walk(roots);
  return out;
}

/** The root type of a catalogue, or `null` (only possible mid-migration). */
export function findRootType<T extends TypeNode>(types: readonly T[]): T | null {
  return types.find((t) => t.is_root) ?? null;
}

/**
 * Catalogue rows in tree order (depth-first, alphabetical per level) with
 * depth and has-children flags — the shape every tree list/combobox builds
 * its rows from.
 */
export function orderedTypeRows<T extends TypeNode>(
  types: readonly T[],
): FlatTypeRow<T>[] {
  return flattenTypeTree(buildTypeTree(types), new Set(types.map((t) => t.id)));
}

/** The ancestor chain of a type, from itself up to the root; unknown → []. */
export function typeChainOf<T extends TypeNode>(types: readonly T[], typeId: string | null): T[] {
  const byId = new Map(types.map((t) => [t.id, t]));
  const chain: T[] = [];
  const seen = new Set<string>();
  let current = typeId === null ? findRootType(types) : byId.get(typeId);
  if (typeId === null && current === null) return [];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parent_id !== null ? byId.get(current.parent_id) : undefined;
  }
  return chain;
}

/** Depth of a type (root = 1); unknown id → 1 (treated as top-level). */
export function typeDepth(types: readonly TypeNode[], typeId: string): number {
  return typeChainOf(types, typeId).length || 1;
}

/** Height of the subtree rooted at a type (leaf = 1); unknown id → 0. */
export function subtreeHeight(types: readonly TypeNode[], typeId: string): number {
  const childrenOf = new Map<string, string[]>();
  for (const t of types) {
    if (t.parent_id === null || t.parent_id === t.id) continue;
    const list = childrenOf.get(t.parent_id);
    if (list) list.push(t.id);
    else childrenOf.set(t.parent_id, [t.id]);
  }
  const byId = new Map(types.map((t) => [t.id, t]));
  const height = (id: string): number => {
    let best = 0;
    for (const kid of childrenOf.get(id) ?? []) best = Math.max(best, height(kid));
    return 1 + best;
  };
  return byId.has(typeId) ? height(typeId) : 0;
}

/** Maximum hierarchy depth including the root (docs/08-ui-spec.md §8.1). */
export const MAX_TYPE_DEPTH = 4;

/** Every type id in the subtree rooted at `typeId`, including itself. */
export function subtreeTypeIds(types: readonly TypeNode[], typeId: string): Set<string> {
  const out = new Set<string>();
  const childrenOf = new Map<string, string[]>();
  for (const t of types) {
    if (t.parent_id === null || t.parent_id === t.id) continue;
    const list = childrenOf.get(t.parent_id);
    if (list) list.push(t.id);
    else childrenOf.set(t.parent_id, [t.id]);
  }
  const walk = (id: string): void => {
    out.add(id);
    for (const kid of childrenOf.get(id) ?? []) walk(kid);
  };
  walk(typeId);
  return out;
}

/**
 * Expand selected type ids to whole subtrees (client-side mirror of the
 * server-side filter expansion): used to feed `thought_ref` pickers whose
 * `allowed_type_ids` must match descendants too (L21).
 */
export function expandTypeIdsToSubtree(
  types: readonly TypeNode[],
  ids: readonly string[],
): string[] {
  const out = new Set<string>();
  const known = new Set(types.map((t) => t.id));
  for (const id of ids) {
    if (!known.has(id)) {
      out.add(id);
      continue;
    }
    for (const sub of subtreeTypeIds(types, id)) out.add(sub);
  }
  return [...out];
}

/** Effective visual settings of a thought type chain (L21 inheritance). */
export interface ResolvedThoughtVisual {
  icon: string | null;
  icon_kind: ThoughtType['icon_kind'];
  fg_color: string | null;
  bg_color: string | null;
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
}

/**
 * Resolve a thought type's visual settings along its ancestor chain: the
 * nearest non-null value of each field wins (a child overrides the parent by
 * setting its own value). `typeId = null` resolves the root type — untyped
 * thoughts show the root's settings (docs/08-ui-spec.md §8.1).
 */
export function resolveThoughtTypeVisual(
  types: readonly ThoughtType[],
  typeId: string | null,
): ResolvedThoughtVisual {
  const chain = typeChainOf(types, typeId);
  const withIcon = chain.find((t) => t.icon !== null);
  return {
    icon: withIcon?.icon ?? null,
    icon_kind: withIcon?.icon_kind ?? 'emoji',
    fg_color: chain.find((t) => t.fg_color !== null)?.fg_color ?? null,
    bg_color: chain.find((t) => t.bg_color !== null)?.bg_color ?? null,
    font_bold: chain.find((t) => t.font_bold !== null)?.font_bold ?? null,
    font_italic: chain.find((t) => t.font_italic !== null)?.font_italic ?? null,
    font_underline: chain.find((t) => t.font_underline !== null)?.font_underline ?? null,
    font_strike: chain.find((t) => t.font_strike !== null)?.font_strike ?? null,
  };
}

/** Application defaults for link lines when nothing is set on the chain. */
export const LINK_STYLE_DEFAULTS: { color: string | null; style: LinkStyle; width: number } = {
  color: null,
  style: 'solid',
  width: 1,
};

/** Effective line style of a link type chain (L21 inheritance). */
export interface ResolvedLinkVisual {
  color: string | null;
  style: LinkStyle;
  width: number;
}

/**
 * Resolve a link type's line style along its ancestor chain (`null` fields
 * inherit from the parent; past the root the application defaults apply).
 * `typeId = null` resolves the root type — untyped links show the root's
 * settings.
 */
export function resolveLinkTypeVisual(
  types: readonly LinkType[],
  typeId: string | null,
): ResolvedLinkVisual {
  const chain = typeChainOf(types, typeId);
  const style = chain.find((t) => t.style !== null)?.style ?? LINK_STYLE_DEFAULTS.style;
  const width = chain.find((t) => t.width !== null)?.width ?? LINK_STYLE_DEFAULTS.width;
  const color = chain.find((t) => t.color !== null)?.color ?? LINK_STYLE_DEFAULTS.color;
  return { color, style, width };
}

// ---------------------------------------------------------------------------
// Combobox options (pick lists without the hierarchy root, L22 review)
// ---------------------------------------------------------------------------

/**
 * Rows for a thought-type pick list: the whole tree WITHOUT the hierarchy
 * root («основной тип» lives only in the type manager, 08-ui-spec.md §8.1)
 * and with depths shifted up so the former root children sit at the left
 * edge. Every row is selectable and carries the type's own icon/font style.
 */
export function thoughtTypeOptions(types: readonly ThoughtType[]): TypeOption[] {
  return orderedTypeRows(types)
    .filter((row) => !row.type.is_root)
    .map((row) => ({
      id: row.type.id,
      label: row.type.name,
      parent_id: row.type.parent_id,
      depth: row.depth - 1,
      has_children: row.hasChildren,
      icon: { icon: row.type.icon, kind: row.type.icon_kind },
      style: {
        fg: row.type.fg_color,
        bg: row.type.bg_color,
        bold: row.type.font_bold ?? false,
        italic: row.type.font_italic ?? false,
        underline: row.type.font_underline ?? false,
        strike: row.type.font_strike ?? false,
      },
    }));
}

/**
 * Rows for a link-type pick list: like {@link thoughtTypeOptions}, without the
 * root, labels carry both direction names, rows show the resolved line swatch.
 */
export function linkTypeOptions(types: readonly LinkType[]): TypeOption[] {
  return orderedTypeRows(types)
    .filter((row) => !row.type.is_root)
    .map((row) => {
      const line = resolveLinkTypeVisual(types, row.type.id);
      return {
        id: row.type.id,
        label: `${row.type.name_forward} / ${row.type.name_reverse}`,
        parent_id: row.type.parent_id,
        depth: row.depth - 1,
        has_children: row.hasChildren,
        line: { color: line.color, style: line.style, width: line.width },
      };
    });
}

// ---------------------------------------------------------------------------
// Type-manager list helpers (search filter + record-count aggregation).
// ---------------------------------------------------------------------------

/** The searchable label(s) of a catalogue entry: a thought type's own name,
 *  or a link type's forward AND reverse names (either may match). */
function searchLabels(t: { name?: string; name_forward?: string; name_reverse?: string }): string[] {
  if (t.name !== undefined) return [t.name];
  return [t.name_forward ?? '', t.name_reverse ?? ''];
}

/**
 * Ids to keep visible when filtering a type tree list by name (docs task
 * «Улучшить диалог редактирования типов…»): every type whose name matches
 * the query, plus its whole ancestor chain — so a match never falls out of
 * its branch and loses context. A blank query keeps everything (no filter).
 */
export function typeSearchVisibleIds<T extends TypeNode & { name?: string; name_forward?: string; name_reverse?: string }>(
  types: readonly T[],
  query: string,
): Set<string> {
  const q = query.trim().toLowerCase();
  if (q === '') return new Set(types.map((t) => t.id));
  const byId = new Map(types.map((t) => [t.id, t]));
  const keep = new Set<string>();
  for (const t of types) {
    if (!searchLabels(t).some((label) => label.toLowerCase().includes(q))) continue;
    let cur: T | undefined = t;
    while (cur !== undefined) {
      keep.add(cur.id);
      cur = cur.parent_id !== null ? byId.get(cur.parent_id) : undefined;
    }
  }
  return keep;
}

/**
 * Sums per-type record counts (own + every descendant) over a type tree —
 * the type-manager list's «Количество» column (docs task «Улучшить диалог…»:
 * a group/parent type shows itself plus its whole subtree). `counts` holds
 * OWN counts per type id (server-computed, task's aggregated endpoint); a
 * type absent from it counts as 0.
 */
export function aggregateTypeCounts(
  types: readonly TypeNode[],
  counts: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of types) {
    let sum = 0;
    for (const id of subtreeTypeIds(types, t.id)) sum += counts[id] ?? 0;
    out[t.id] = sum;
  }
  return out;
}
