/**
 * Cycle-safe graph traversal helpers (task C11,
 * docs/11-settings-and-state.md §5).
 *
 * The ETN graph is an arbitrary directed graph — cycles (A→B→C→A) are legal
 * data, so every traversal must be bounded. Two mechanisms coexist:
 *
 *   * SQL path: recursive CTE with `UNION` row deduplication — at most one
 *     row per `(id, depth)`, so the working set is bounded by
 *     `|thoughts| × max_depth`. Used by the search service for
 *     `in_subtree_of` and the chronicle service for the subtree filter (a
 *     `path`-string guard was rejected: it enumerates simple paths, which
 *     is exponential on cyclic graphs and froze the synchronous SQLite
 *     loop — see `search-service.ts`);
 *   * application level: BFS with a `Set<string>` visited-set — this module,
 *     used for subgraph extraction and path finding where per-node post-
 *     processing (filters, truncation) is needed in TypeScript.
 *
 * All traversals honour `maxDepth` (default `TRAVERSAL_DEFAULTS.MAX_DEPTH`) and
 * `maxNodes` (default `MCP_DEFAULTS.MAX_NODES_PER_SUBGRAPH`) and return a
 * `truncated` flag instead of walking forever (docs/11-settings-and-state.md
 * §5.3).
 */

import { MCP_DEFAULTS, TRAVERSAL_DEFAULTS } from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';

/** Which edge direction BFS steps through. */
export type TraverseDirection = 'parents' | 'children' | 'both';

/** Common bounds for all traversal helpers. */
export interface TraversalBounds {
  /** Maximum edge distance from the seeds. Default `TRAVERSAL_DEFAULTS.MAX_DEPTH`. */
  maxDepth?: number;
  /** Maximum number of nodes to collect. Default `MCP_DEFAULTS.MAX_NODES_PER_SUBGRAPH`. */
  maxNodes?: number;
  /** Whether inactive (`active=0`) thoughts are walked. Default `false`. */
  showInactive?: boolean;
}

/** Result of a bounded traversal. */
export interface TraversalResult {
  /** Collected thought ids in breadth-first order (seeds first). */
  ids: string[];
  /** True when the walk stopped early on a bound. */
  truncated: boolean;
  /** Why truncation happened, for API `meta` payloads. */
  reason?: 'max_depth' | 'max_nodes';
}

/**
 * Collect a thought's neighbours along `direction` in breadth-first order,
 * bounded by `maxDepth`/`maxNodes`. Each node is visited once — diamonds
 * (two paths into one node) are fine, cycles terminate naturally.
 */
export function traverse(
  ndb: NetworkDb,
  seedIds: string[],
  direction: TraverseDirection,
  bounds: TraversalBounds = {},
): TraversalResult {
  const maxDepth = bounds.maxDepth ?? TRAVERSAL_DEFAULTS.MAX_DEPTH;
  const maxNodes = bounds.maxNodes ?? MCP_DEFAULTS.MAX_NODES_PER_SUBGRAPH;
  const showInactive = bounds.showInactive === true ? 1 : 0;

  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = seedIds.map((id) => ({ id, depth: 0 }));
  const order: string[] = [];
  let truncated = false;
  let reason: TraversalResult['reason'];

  const neighborOf = ndb.prepare(
    direction === 'parents'
      ? `SELECT source_id AS nid FROM links_v WHERE target_id = ? AND (active = 1 OR ?)`
      : direction === 'children'
        ? `SELECT target_id AS nid FROM links_v WHERE source_id = ? AND (active = 1 OR ?)`
        : `SELECT CASE WHEN source_id = ? THEN target_id ELSE source_id END AS nid
             FROM links_v WHERE (source_id = ? OR target_id = ?) AND (active = 1 OR ?)`,
  );

  while (queue.length > 0) {
    const { id, depth } = queue.shift() as { id: string; depth: number };
    if (visited.has(id)) continue;

    if (order.length >= maxNodes) {
      truncated = true;
      reason = 'max_nodes';
      break;
    }
    visited.add(id);
    order.push(id);

    if (depth >= maxDepth) continue;

    const rows = (
      direction === 'both'
        ? neighborOf.all(id, id, id, showInactive)
        : neighborOf.all(id, showInactive)
    ) as Array<{ nid: string }>;
    for (const { nid } of rows) {
      if (!visited.has(nid)) {
        queue.push({ id: nid, depth: depth + 1 });
      }
    }
  }

  return { ids: order, truncated, reason };
}

/**
 * Extract a radius-bounded subgraph around `seedIds` as `{nodes, edges}`.
 * Nodes are thoughts reachable within `radius` edges (both directions by
 * default — the MCP subgraph semantics, 05-mcp-server.md §4.1); edges are the
 * active links between collected nodes.
 */
export function subgraph(
  ndb: NetworkDb,
  seedIds: string[],
  radius: number,
  bounds: TraversalBounds = {},
): {
  nodes: string[];
  edges: Array<{ id: string; source_id: string; target_id: string; type_id: string | null }>;
  truncated: boolean;
} {
  const { ids, truncated } = traverse(ndb, seedIds, 'both', {
    maxDepth: radius,
    maxNodes: bounds.maxNodes,
    showInactive: bounds.showInactive,
  });

  if (ids.length === 0) {
    return { nodes: [], edges: [], truncated };
  }

  const placeholders = ids.map(() => '?').join(',');
  const edges = ndb
    .prepare(
      `SELECT id, source_id, target_id, type_id
         FROM links_v
        WHERE active = 1
          AND source_id IN (${placeholders})
          AND target_id IN (${placeholders})`,
    )
    .all(...ids, ...ids) as Array<{
    id: string;
    source_id: string;
    target_id: string;
    type_id: string | null;
  }>;

  return { nodes: ids, edges, truncated };
}

/**
 * Shortest path from `fromId` to `toId` through directed parent/child edges
 * (direction-agnostic step: each hop may go source→target or target→source),
 * bounded by `maxDepth`. Returns the id sequence (inclusive) or `null` when no
 * path exists within the bound.
 */
export function findPath(
  ndb: NetworkDb,
  fromId: string,
  toId: string,
  maxDepth: number = TRAVERSAL_DEFAULTS.MAX_DEPTH,
): string[] | null {
  if (fromId === toId) return [fromId];

  const visited = new Set<string>([fromId]);
  const queue: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [fromId] }];

  while (queue.length > 0) {
    const { id, path } = queue.shift() as { id: string; path: string[] };
    if (path.length - 1 >= maxDepth) continue;

    const neighbors = ndb
      .prepare(
        `SELECT CASE WHEN source_id = ? THEN target_id ELSE source_id END AS nid
           FROM links_v WHERE (source_id = ? OR target_id = ?) AND active = 1`,
      )
      .all(id, id, id) as Array<{ nid: string }>;

    for (const { nid } of neighbors) {
      if (visited.has(nid)) continue;
      if (nid === toId) return [...path, nid];
      visited.add(nid);
      queue.push({ id: nid, path: [...path, nid] });
    }
  }
  return null;
}
