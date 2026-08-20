/**
 * Pure layout logic of the structures tree (L15, 08-ui-spec.md §15.5).
 *
 * The tree is derived from three inputs: the filter-result roots, the
 * expansion map (which node has parents/children expanded) and a neighbour
 * lookup (id lists served from the hierarchy cache). Everything here is a pure
 * function, so the flattening, indent shifts and per-branch dedup ids are
 * unit-testable without a DOM.
 */

/** Direction of a hierarchy expansion. */
export type HierarchyDir = 'parents' | 'children';

/** Which directions of a node are expanded, keyed by the node's path key. */
export type ExpansionMap = Map<string, Partial<Record<HierarchyDir, boolean>>>;

/** One flattened tree row. */
export interface TreeRow {
  /** Path key of the node, e.g. `root/child/grandchild` (parents: `root^p`). */
  key: string;
  thoughtId: string;
  /** The filter-result root this branch belongs to. */
  rootId: string;
  /** True for the filter-result rows themselves (marked with a triangle, §15.5). */
  root: boolean;
  /** Horizontal level; the row's left padding = indent × level width. */
  indent: number;
  /**
   * How this row attaches to its tree partner: `child` — the row hangs below
   * its partner (came from a children expansion); `parent` — the row sits above
   * its partner (came from a parents expansion). `null` for root rows.
   */
  via: { otherId: string; role: 'child' | 'parent' } | null;
}

/** Serves the neighbour ids of an expanded node (from the hierarchy cache). */
export type NeighbourLookup = (
  nodeKey: string,
  thoughtId: string,
  dir: HierarchyDir,
) => string[];

/**
 * Insertion point for a per-node «Показать ещё» button (§15.5 pagination):
 * `afterKey` is the row after which the button renders (the last row of that
 * direction's expansion batch, however deep its own nested expansions go).
 */
export interface MoreMarker {
  afterKey: string;
  nodeKey: string;
  dir: HierarchyDir;
  indent: number;
}

/** Result of {@link flattenStructuresTree}. */
export interface TreeFlattenResult {
  rows: TreeRow[];
  moreMarkers: MoreMarker[];
}

/** Safety cap: a branch may not nest deeper than this (cycle guard, L15). */
export const MAX_TREE_DEPTH = 40;

/** Path separator for children (below) and parents (above) respectively. */
const CHILD_SEP = '/';
const PARENT_SEP = '^';

/** Computes the child node key under `parentKey`. */
export function childKey(parentKey: string, childId: string): string {
  return `${parentKey}${CHILD_SEP}${childId}`;
}

/** Computes the parent node key above `nodeKey`. */
export function parentKey(nodeKey: string, parentId: string): string {
  return `${nodeKey}${PARENT_SEP}${parentId}`;
}

/**
 * Flattens the tree: for every root, rows are emitted depth-first. Expanding
 * the children of a node emits its child rows right below it (indent + 1).
 *
 * Expanding the parents of a **descendant-side** row (a filter-result root or
 * a `child`-via row) starts a new ancestor column: its immediate parents are
 * emitted above it at the row's own (pre-shift) indent, and the row itself —
 * plus everything already expanded below it — shifts one level right.
 * Expanding the parents of a row that is **itself already an ancestor**
 * (`via.role === 'parent'`) does NOT shift that row again: the further
 * ancestors join the SAME column (same indent), stacking above it — so a
 * multi-generation ancestor chain stays in one column instead of walking
 * further left with every extra generation (08-ui-spec.md §15.5).
 */
export function flattenStructuresTree(
  roots: string[],
  expansion: ExpansionMap,
  neighborsOf: NeighbourLookup,
): TreeFlattenResult {
  const rows: TreeRow[] = [];
  const moreMarkers: MoreMarker[] = [];
  let lastKey: string | null = null;
  const pushRow = (row: TreeRow): void => {
    rows.push(row);
    lastKey = row.key;
  };
  const emit = (
    key: string,
    thoughtId: string,
    indent: number,
    rootId: string,
    via: TreeRow['via'],
    depth: number,
  ): void => {
    if (depth > MAX_TREE_DEPTH) return;
    const isAncestorRow = via !== null && via.role === 'parent';
    const flags = expansion.get(key);
    let selfIndent = indent;
    if (flags?.parents === true) {
      const parents = neighborsOf(key, thoughtId, 'parents');
      for (const p of parents) {
        emit(
          parentKey(key, p),
          p,
          indent,
          rootId,
          { otherId: thoughtId, role: 'parent' },
          depth + 1,
        );
      }
      if (parents.length > 0 && lastKey !== null) {
        moreMarkers.push({ afterKey: lastKey, nodeKey: key, dir: 'parents', indent });
      }
      // An ancestor row stays put — its own further ancestors join its column
      // instead of pushing it right; only descendant-side rows shift.
      if (!isAncestorRow) selfIndent = indent + 1;
    }
    pushRow({ key, thoughtId, rootId, root: via === null, indent: selfIndent, via });
    if (flags?.children === true) {
      const children = neighborsOf(key, thoughtId, 'children');
      for (const c of children) {
        emit(childKey(key, c), c, selfIndent + 1, rootId, { otherId: thoughtId, role: 'child' }, depth + 1);
      }
      if (children.length > 0 && lastKey !== null) {
        moreMarkers.push({ afterKey: lastKey, nodeKey: key, dir: 'children', indent: selfIndent + 1 });
      }
    }
  };
  for (const root of roots) {
    emit(root, root, 0, root, null, 0);
  }
  return { rows, moreMarkers };
}

/** All thought ids currently shown in one root's branch (dedup input, §15.5). */
export function branchThoughtIds(rows: TreeRow[], rootId: string): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.rootId === rootId) ids.add(row.thoughtId);
  }
  return [...ids];
}

/**
 * Node keys whose expansion state is nested under `key` (the subtree that
 * collapses when the node folds). Includes the node's own two directions.
 */
export function subtreeExpansionKeys(key: string, expansion: ExpansionMap): string[] {
  const prefixes = [`${key}${CHILD_SEP}`, `${key}${PARENT_SEP}`];
  const out: string[] = [];
  for (const candidate of expansion.keys()) {
    if (candidate === key || prefixes.some((p) => candidate.startsWith(p))) {
      out.push(candidate);
    }
  }
  return out;
}
