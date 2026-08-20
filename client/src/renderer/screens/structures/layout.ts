/**
 * Pure layout logic of the structures tree (L15, 08-ui-spec.md §15.5).
 *
 * The tree is derived from three inputs: the filter-result roots, the
 * expansion map (which node has parents/children expanded) and a neighbour
 * lookup (id lists served from the hierarchy cache). Everything here is a pure
 * function, so the flattening, indent shifts and per-branch dedup ids are
 * unit-testable without a DOM.
 *
 * Layout model — like a folder tree in Explorer, but every node may have
 * several parents (a revealed graph):
 *
 *  - every row sits in one flat column; the indent is `ownIndent + covers`,
 *    where `ownIndent` is the structural depth (children levels below the
 *    branch root) and `covers` counts the ancestor reveals in effect;
 *  - revealing the PARENTS of a node emits its parent rows immediately above
 *    it, each at the node's pre-reveal position, and shifts the node itself —
 *    plus everything already revealed below it — one more indent step right;
 *  - revealing parents of a row that is itself a parent shifts that parent
 *    and the whole subtree hanging below it one more step right, its own
 *    parents appearing at its vacated position. Several generations thus form
 *    a right-climbing ladder, each level's list vertically aligned.
 */

/** Direction of a hierarchy expansion. */
export type HierarchyDir = 'parents' | 'children';

/** Which directions of a node are expanded, keyed by the node's path key. */
export type ExpansionMap = Map<string, Partial<Record<HierarchyDir, boolean>>>;

/** One flattened tree row. */
export interface TreeRow {
  /** Path key of the node, e.g. `root/child` (parents: `root^p`). */
  key: string;
  thoughtId: string;
  /** The filter-result root this branch belongs to. */
  rootId: string;
  /** True for the filter-result rows themselves (marked with a triangle, §15.5). */
  root: boolean;
  /** Structural depth: children levels to the right of the branch root. */
  ownIndent: number;
  /** Final indent = `ownIndent` + ancestor reveals in effect. */
  indent: number;
  /**
   * How this row attaches to its tree partner: `child` — the row hangs below
   * its partner (came from a children expansion); `parent` — the row sits above
   * its partner (came from a parents reveal). `null` for root rows.
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

/** Internal emission-time shape: a row without its final indent yet. */
interface RowSpec {
  key: string;
  thoughtId: string;
  rootId: string;
  root: boolean;
  ownIndent: number;
  via: TreeRow['via'];
}

/** One parents reveal, recorded in creation (DFS emission) order. */
interface RevealSpec {
  revealerKey: string;
}

/**
 * Flattens the tree (two passes):
 *
 * Pass 1 walks the expansion map depth-first, emitting every row in final
 * visual order (parents above, the node, then its children) and recording the
 * reveals in creation order plus the downward edges.
 *
 * Pass 2 computes a `covers` counter per row: each reveal increments its
 * revealer and the whole downward closure (children chains plus the
 * parent-row→revealer links). Every row's final indent is
 * `ownIndent + covers` — a deeper reveal therefore shifts the revealer chain
 * (parent included) and the whole subtree one more step right, while rows the
 * reveal never reaches (sibling parents, branches of other roots) stay put.
 */
export function flattenStructuresTree(
  roots: string[],
  expansion: ExpansionMap,
  neighborsOf: NeighbourLookup,
): TreeFlattenResult {
  const specs: RowSpec[] = [];
  const reveals: RevealSpec[] = [];
  /** Downward child keys of a main row, in emission order. */
  const childEdges = new Map<string, string[]>();
  /** Revealer key of every parent row (its downward link). */
  const parentRevealerOf = new Map<string, string>();
  /** Raw markers (indent filled in pass 2). */
  const markerSpecs: Array<{ afterKey: string; nodeKey: string; dir: HierarchyDir }> = [];
  let lastKey: string | null = null;

  const pushMoreMarker = (nodeKey: string, dir: HierarchyDir): void => {
    if (lastKey !== null) markerSpecs.push({ afterKey: lastKey, nodeKey, dir });
  };

  const emitMain = (
    key: string,
    thoughtId: string,
    ownIndent: number,
    rootId: string,
    via: TreeRow['via'],
    depth: number,
  ): void => {
    if (depth > MAX_TREE_DEPTH) return;
    if (expansion.get(key)?.parents === true) {
      reveals.push({ revealerKey: key });
      const parents = neighborsOf(key, thoughtId, 'parents');
      for (const p of parents) {
        emitParent(parentKey(key, p), p, ownIndent, rootId, key, thoughtId, depth + 1);
      }
      if (parents.length > 0) pushMoreMarker(key, 'parents');
    }
    specs.push({ key, thoughtId, rootId, root: via === null, ownIndent, via });
    lastKey = key;
    if (expansion.get(key)?.children === true) {
      const children = neighborsOf(key, thoughtId, 'children');
      for (const c of children) {
        const childKeyValue = childKey(key, c);
        const list = childEdges.get(key);
        if (list === undefined) childEdges.set(key, [childKeyValue]);
        else list.push(childKeyValue);
        emitMain(childKeyValue, c, ownIndent + 1, rootId, { otherId: thoughtId, role: 'child' }, depth + 1);
      }
      if (children.length > 0) pushMoreMarker(key, 'children');
    }
  };

  const emitParent = (
    key: string,
    thoughtId: string,
    ownIndent: number,
    rootId: string,
    revealerKey: string,
    childId: string,
    depth: number,
  ): void => {
    if (depth > MAX_TREE_DEPTH) return;
    parentRevealerOf.set(key, revealerKey);
    if (expansion.get(key)?.parents === true) {
      reveals.push({ revealerKey: key });
      const parents = neighborsOf(key, thoughtId, 'parents');
      for (const p of parents) {
        emitParent(parentKey(key, p), p, ownIndent, rootId, key, thoughtId, depth + 1);
      }
      if (parents.length > 0) pushMoreMarker(key, 'parents');
    }
    specs.push({ key, thoughtId, rootId, root: false, ownIndent, via: { otherId: childId, role: 'parent' } });
    lastKey = key;
  };

  for (const root of roots) {
    emitMain(root, root, 0, root, null, 0);
  }

  // --- pass 2: covers (ancestor reveals in effect) per row -------------------

  const covers = new Map<string, number>(specs.map((s) => [s.key, 0]));
  /** Revealer's covers snapshot at the moment its reveal was created (only the
   *  parents-direction marker needs it — its batch sits at the revealer's
   *  pre-reveal column). */
  const revealSnapshot = new Map<string, number>();

  const bumpClosure = (startKey: string): void => {
    const visited = new Set<string>();
    const queue: string[] = [startKey];
    while (queue.length > 0) {
      const key = queue.shift();
      if (key === undefined) break;
      if (visited.has(key)) continue;
      visited.add(key);
      covers.set(key, (covers.get(key) ?? 0) + 1);
      for (const child of childEdges.get(key) ?? []) queue.push(child);
      const revealerOfParent = parentRevealerOf.get(key);
      if (revealerOfParent !== undefined) queue.push(revealerOfParent);
    }
  };

  for (const reveal of reveals) {
    revealSnapshot.set(reveal.revealerKey, covers.get(reveal.revealerKey) ?? 0);
    bumpClosure(reveal.revealerKey);
  }

  const rows: TreeRow[] = specs.map((spec) => ({
    ...spec,
    indent: spec.ownIndent + (covers.get(spec.key) ?? 0),
  }));

  const rowByKey = new Map(rows.map((r) => [r.key, r]));
  const moreMarkers: MoreMarker[] = markerSpecs.map((marker) => {
    const node = rowByKey.get(marker.nodeKey);
    const ownIndent = node?.ownIndent ?? 0;
    const indent =
      marker.dir === 'parents'
        ? ownIndent + (revealSnapshot.get(marker.nodeKey) ?? 0)
        : ownIndent + 1 + (covers.get(marker.nodeKey) ?? 0);
    return { ...marker, indent };
  });

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
