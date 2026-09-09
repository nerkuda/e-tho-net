/**
 * `etn.types.list` response budgeting (task f9c7dbc5, 0.7.4).
 *
 * On a mature network the `etn.types.list` JSON envelope — every type with
 * its effective property list, the views[] block per thought-type, and the
 * optional `scope` echo — easily blows the agent's context budget. On the
 * ETN network the full `scope: "thoughts"` payload weighs in around 94 KB
 * while the default MCP-client cap sits at 50 KB; without an in-server
 * shrinker the tail (types starting with `с`, `т`, `э`) never arrives.
 *
 * `shrinkTypesListToBudget` is a **post-processing** step that fits an
 * already-materialised `etn.types.list` payload under a soft `max_chars`
 * cap:
 *
 *  1. If the current JSON size is within budget — return as-is.
 *  2. Otherwise, shorten every type entry's `description` string down to
 *     {@link TYPES_LIST_BUDGET_PREVIEW_CHARS}. Re-measure. If we now fit —
 *     `reason: 'max_chars_preview'`.
 *  3. Otherwise, drop whole entries from the tail of each catalogue in
 *     turn: first `thought_types`, then `link_types`. The drop order is
 *     always tail-first so that an agent paging through alphabetically
 *     sorted catalogues keeps the head. As soon as the size fits —
 *     `reason: 'max_chars_items'`. If we still don't fit (every description
 *     already short + empty catalogues), we return whatever fits the
 *     closest — `truncated: true`, no error: the agent can retry with a
 *     smaller `scope` or a smaller `limit`.
 *
 * The function mutates the payload in place (mirroring
 * `shrinkSubgraphToBudget`) and returns it alongside the truncation
 * metadata so the caller can attach the diagnostics to the response
 * envelope's `meta` block.
 */

import {
  TYPES_LIST_BUDGET_PREVIEW_CHARS,
  type McpLinkTypeEntry,
  type McpThoughtTypeEntry,
  type McpTypesListTruncationReason,
} from '@etn/shared';

/**
 * Structural shape accepted by {@link shrinkTypesListToBudget}. Only the
 * listed fields are read/written — extra keys (the `meta` block, `scope`
 * echo, etc.) are preserved as-is. Index signatures on the catalogue
 * arrays keep the structural duck-type compatible with both `compact` and
 * `full` projections of the response (currently the tool emits a single
 * shape, but the pattern matches `shrinkSubgraphToBudget`).
 */
export interface TypesListBudgetPayload {
  thought_types?: Array<McpThoughtTypeEntry> & Record<string, unknown>[];
  link_types?: Array<McpLinkTypeEntry> & Record<string, unknown>[];
  [k: string]: unknown;
}

/** Options accepted by {@link shrinkTypesListToBudget}. */
export interface TypesListBudgetOptions {
  /** Hard cap on the JSON-encoded response size (characters). */
  max_chars: number;
  /**
   * Override the per-description floor used in the first shrink step.
   * Defaults to {@link TYPES_LIST_BUDGET_PREVIEW_CHARS}.
   */
  preview_chars?: number;
}

/** Result of {@link shrinkTypesListToBudget}. */
export interface TypesListBudgetResult<T> {
  /** The (possibly trimmed) payload — same reference as the input. */
  payload: T;
  /** True when any shrink step ran. */
  truncated: boolean;
  /** Why the shrink ran; `null` when nothing was trimmed. */
  reason: McpTypesListTruncationReason | null;
  /** JSON-encoded size before shrinking (for diagnostics / tests). */
  original_chars: number;
  /** JSON-encoded size after shrinking (for diagnostics / tests). */
  final_chars: number;
}

/**
 * Truncate a single type entry's `description` field to `previewChars`,
 * preserving the entry's other fields. Non-string descriptions (e.g.
 * `null`) are left alone.
 */
function shrinkEntryDescription(
  entry: Record<string, unknown>,
  previewChars: number,
): void {
  const desc = entry['description'];
  if (typeof desc === 'string' && desc.length > previewChars) {
    entry['description'] = desc.slice(0, previewChars);
  }
}

/**
 * Fit a `etn.types.list` response payload under `max_chars` characters by
 * progressively shrinking description strings and then dropping tail
 * entries. See the module-level JSDoc for the exact algorithm.
 */
export function shrinkTypesListToBudget<T extends TypesListBudgetPayload>(
  payload: T,
  options: TypesListBudgetOptions,
): TypesListBudgetResult<T> {
  const previewChars = options.preview_chars ?? TYPES_LIST_BUDGET_PREVIEW_CHARS;
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
  // Step 1: shorten every type entry's `description` to `previewChars`.
  // -------------------------------------------------------------------------
  if (previewChars > 0) {
    for (const t of payload.thought_types ?? []) shrinkEntryDescription(t, previewChars);
    for (const t of payload.link_types ?? []) shrinkEntryDescription(t, previewChars);
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
  // Step 2: drop the tail of each catalogue until the payload fits.
  // `thought_types` is dropped first because (a) it is the larger half on
  // most networks and (b) the alphabetical overlap with `link_types` is
  // low enough that an agent paging alphabetically can usually recover by
  // paging `scope: "thoughts"` separately.
  // -------------------------------------------------------------------------
  let lastChars = afterPreviewChars;
  const dropTail = (
    arr: Array<Record<string, unknown>> | undefined,
  ): boolean => {
    if (arr === undefined || arr.length === 0) return false;
    arr.pop();
    lastChars = JSON.stringify(payload).length;
    return lastChars <= maxChars;
  };

  while ((payload.thought_types?.length ?? 0) > 0) {
    if (dropTail(payload.thought_types)) {
      return {
        payload,
        truncated: true,
        reason: 'max_chars_items',
        original_chars: originalChars,
        final_chars: lastChars,
      };
    }
  }
  while ((payload.link_types?.length ?? 0) > 0) {
    if (dropTail(payload.link_types)) {
      return {
        payload,
        truncated: true,
        reason: 'max_chars_items',
        original_chars: originalChars,
        final_chars: lastChars,
      };
    }
  }

  // Even with every entry removed the payload does not fit (degenerate
  // caller — e.g. the `meta` / `scope` echo alone is larger than the
  // budget). Return whatever fits the closest so the caller can surface a
  // structured error rather than throwing.
  return {
    payload,
    truncated: true,
    reason: 'max_chars_items',
    original_chars: originalChars,
    final_chars: lastChars,
  };
}
