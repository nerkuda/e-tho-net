/**
 * Subgraph response budgeting (task O13, docs/05-mcp-server.md §4.1).
 *
 * `etn.thoughts.subgraph` is the workhorse RAG tool: agents pull the
 * radius-bounded neighbourhood of seed thoughts together with (optional)
 * comment previews and reference tables of types. The hard `max_nodes`
 * bound keeps the traversal itself bounded, but the JSON envelope can still
 * blow the agent's context budget — 200 active thoughts with non-trivial
 * `include_comments` payloads easily exceed a few hundred thousand
 * characters.
 *
 * `shrinkSubgraphToBudget` is a **post-processing** step that fits an
 * already-materialised payload under a soft `max_chars` cap:
 *
 *  1. If the current JSON size is within budget — return as-is.
 *  2. Otherwise, shrink every comment preview body (permanent + every
 *     chronological entry) down to {@link SUBGRAPH_BUDGET_PREVIEW_CHARS}.
 *     Re-measure. If we now fit — `reason: 'max_chars_preview'`.
 *  3. Otherwise, drop nodes farthest from the seeds first (BFS level
 *     descending, ties broken by reverse visit order — the BFS tail is
 *     dropped before its head). On every drop, incident edges and the
 *     node's comment slot are also removed. As soon as the size fits —
 *     `reason: 'max_chars_nodes'`.
 *
 * `seed_ids` are protected: they never appear in the removal order, so an
 * agent always sees at least the entry points it asked for. If even the seed
 * alone overshoots the budget (degenerate caller), the function returns
 * whatever fits the closest — `truncated: true`, `reason: 'max_chars_nodes'`,
 * no error: the agent can retry with a smaller `radius` or a smaller
 * `include_comments` flag.
 *
 * The function mutates the payload in place (mirroring how `tools.ts`
 * already builds fresh arrays per call) and returns it alongside the
 * truncation metadata so the caller can attach the diagnostics to the
 * response envelope.
 */

import { SUBGRAPH_BUDGET_PREVIEW_CHARS } from '@etn/shared';
import type { CommentsPreview, McpSubgraphTruncationReason } from '@etn/shared';

/**
 * Structural shape accepted by {@link shrinkSubgraphToBudget}. The
 * implementation reads only the listed fields and writes back into the
 * same arrays/objects — extra fields are preserved as-is.
 *
 * Kept as a structural duck-type (rather than a hard import of MCP DTOs)
 * because the same algorithm must work for both `compact` and `full`
 * projections of the response. Index signatures on `nodes`/`edges` make
 * the projected thought/link shapes (compact or full) compatible without
 * forcing every caller to widen its types manually.
 */
export interface SubgraphBudgetPayload {
  nodes: Array<{ id: string } & Record<string, unknown>>;
  edges: Array<
    { source_id: string; target_id: string; type_id: string | null } & Record<string, unknown>
  >;
  /**
   * Optional preview block — when `include_comments` was requested by the
   * caller. Each entry pairs the owning thought id with a
   * {@link CommentsPreview} payload; extra top-level fields are preserved.
   */
  comments?: Array<{ thought_id: string } & CommentsPreview>;
  [k: string]: unknown;
}

/** Options accepted by {@link shrinkSubgraphToBudget}. */
export interface SubgraphBudgetOptions {
  /** Seed thought ids — protected from removal; also seed the BFS. */
  seed_ids: string[];
  /** Hard cap on the JSON-encoded response size (characters). */
  max_chars: number;
  /**
   * Override the per-comment body floor used in the first shrink step.
   * Defaults to {@link SUBGRAPH_BUDGET_PREVIEW_CHARS}.
   */
  preview_chars?: number;
}

/** Result of {@link shrinkSubgraphToBudget}. */
export interface SubgraphBudgetResult<T> {
  /** The (possibly trimmed) payload — same reference as the input. */
  payload: T;
  /** True when any shrink step ran. */
  truncated: boolean;
  /** Why the shrink ran; `null` when nothing was trimmed. */
  reason: McpSubgraphTruncationReason | null;
  /** JSON-encoded size before shrinking (for diagnostics / tests). */
  original_chars: number;
  /** JSON-encoded size after shrinking (for diagnostics / tests). */
  final_chars: number;
}

/**
 * BFS distance from the seeds, restricted to nodes reachable through the
 * supplied edge set. Unreached nodes (orphaned) receive `0` so they sort to
 * the front of the drop list.
 */
function computeBfsLevels(
  nodeIds: ReadonlyArray<string>,
  edges: ReadonlyArray<{ source_id: string; target_id: string }>,
  seedIds: ReadonlyArray<string>,
): Map<string, number> {
  const levels = new Map<string, number>();
  const known = new Set(nodeIds);
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const e of edges) {
    if (known.has(e.source_id) && known.has(e.target_id)) {
      adjacency.get(e.source_id)!.push(e.target_id);
      adjacency.get(e.target_id)!.push(e.source_id);
    }
  }
  const queue: Array<{ id: string; depth: number }> = [];
  for (const seed of seedIds) {
    if (!known.has(seed)) continue;
    levels.set(seed, 0);
    queue.push({ id: seed, depth: 0 });
  }
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    for (const next of adjacency.get(id) ?? []) {
      if (levels.has(next)) continue;
      levels.set(next, depth + 1);
      queue.push({ id: next, depth: depth + 1 });
    }
  }
  return levels;
}

/**
 * Fit a subgraph response payload under `max_chars` characters by
 * progressively shrinking comment previews and then dropping far nodes.
 * See the module-level JSDoc for the exact algorithm.
 */
export function shrinkSubgraphToBudget<T extends SubgraphBudgetPayload>(
  payload: T,
  options: SubgraphBudgetOptions,
): SubgraphBudgetResult<T> {
  const previewChars = options.preview_chars ?? SUBGRAPH_BUDGET_PREVIEW_CHARS;
  const maxChars = options.max_chars;
  const originalChars = JSON.stringify(payload).length;

  if (originalChars <= maxChars) {
    return {
      payload,
      truncated: false,
      reason: null,
      original_chars: originalChars,
      final_chars: originalChars,
    };
  }

  // -------------------------------------------------------------------------
  // Step 1: shorten every comment preview body to `previewChars`.
  // -------------------------------------------------------------------------
  if (payload.comments !== undefined && previewChars > 0) {
    for (const c of payload.comments) {
      if (c.permanent !== null && c.permanent.body_md.length > previewChars) {
        c.permanent = {
          ...c.permanent,
          body_md: c.permanent.body_md.slice(0, previewChars),
        };
      }
      for (const entry of c.chronological.entries) {
        if (entry.body_md.length > previewChars) {
          entry.body_md = entry.body_md.slice(0, previewChars);
        }
      }
    }
  }
  const afterPreviewChars = JSON.stringify(payload).length;
  if (afterPreviewChars <= maxChars) {
    return {
      payload,
      truncated: true,
      reason: 'max_chars_preview',
      original_chars: originalChars,
      final_chars: afterPreviewChars,
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: drop the farthest nodes until the payload fits.
  // -------------------------------------------------------------------------
  const seedSet = new Set(options.seed_ids);
  const ids = payload.nodes.map((n) => n.id);
  const levels = computeBfsLevels(ids, payload.edges, options.seed_ids);
  const removalOrder = ids
    .map((id, idx) => ({ id, idx, level: levels.get(id) ?? Number.POSITIVE_INFINITY }))
    // Protect seeds — they are never dropped, even if they are the only node
    // left and the payload still does not fit (the caller can retry with a
    // smaller scope).
    .filter(({ id }) => !seedSet.has(id))
    // Furthest first; on the same level, drop the BFS tail before its head so
    // the agent keeps the part of the neighbourhood closest to its seeds.
    .sort((a, b) => b.level - a.level || b.idx - a.idx);

  const liveNodes = new Set(ids);
  const trimPayload = (id: string): void => {
    liveNodes.delete(id);
    payload.nodes = payload.nodes.filter((n) => n.id !== id);
    payload.edges = payload.edges.filter(
      (e) => liveNodes.has(e.source_id) && liveNodes.has(e.target_id),
    );
    if (payload.comments !== undefined) {
      payload.comments = payload.comments.filter((c) => c.thought_id !== id);
    }
  };

  let lastChars = afterPreviewChars;
  for (const { id } of removalOrder) {
    if (!liveNodes.has(id)) continue;
    trimPayload(id);
    lastChars = JSON.stringify(payload).length;
    if (lastChars <= maxChars) {
      return {
        payload,
        truncated: true,
        reason: 'max_chars_nodes',
        original_chars: originalChars,
        final_chars: lastChars,
      };
    }
  }

  // Even with every non-seed node removed the payload does not fit
  // (degenerate caller — e.g. seed comments alone are larger than the
  // budget). Return the smallest payload we could produce so the caller
  // can still surface a structured error rather than throwing.
  return {
    payload,
    truncated: true,
    reason: 'max_chars_nodes',
    original_chars: originalChars,
    final_chars: lastChars,
  };
}
