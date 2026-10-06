/**
 * Server-side resolver and body expander for comment transclusions
 * (ТП2 «Трансклюзии комментариев», задача `bcfc7eb7`, ADR `85a7a01e`,
 * требования `2fb33964`, `166a7555`, `39e30070`).
 *
 * Parsing and expansion live ONLY in `@etn/markdown`
 * (`expandTransclusions`): the package has no database access and receives
 * source texts through the injected resolver-dependency. This module is the
 * server's resolver — it reads the permanent comment of a source thought of the
 * SAME network through the layer-resolving `comments_v` view. Recursion, the
 * depth cap (5) and the cycle guard all stay inside `@etn/markdown`; the server
 * never parses transclusion references itself (guard
 * `own-transclusion-outside-package`).
 *
 * The expander is applied ONLY on the MCP delivery path (agent-facing reads):
 * `body_md` in the database keeps the transclusion references, so REST
 * responses and the client widgets (ТП2 «Трансклюзии комментариев») always read
 * the raw form. See «MCP. Сервер отдаёт body_md с развёрнутыми трансклюзиями»
 * in the ТП2 permanent comment.
 */

import { expandTransclusions, type TransclusionResolver } from '@etn/markdown';

import type { NetworkDb } from '../db/network-db.js';

/**
 * Transform applied to a FULL `body_md` before it is sliced into a preview or
 * returned as-is. Injected as an opaque dependency by the MCP facades; the
 * domain comment readers stay transport-agnostic (REST passes nothing).
 */
export type BodyExpander = (body_md: string) => string;

/**
 * Build a {@link TransclusionResolver} over one network connection. Called by
 * `@etn/markdown` once per reference; the same source may be referenced several
 * times (including from nested levels), so the resolved full permanent body is
 * cached per source id for the lifetime of the resolver.
 *
 * A source with no permanent comment (absent thought, torn-down comment, or a
 * link/chronological owner) resolves to `{ found: false }` — the package emits
 * the `missing` marker of the ADR `85a7a01e` format.
 */
export function createTransclusionResolver(ndb: NetworkDb): TransclusionResolver {
  const cache = new Map<string, { found: boolean; body_md: string }>();
  return (sourceId: string) => {
    const cached = cache.get(sourceId);
    if (cached !== undefined) return cached;
    const row = ndb
      .prepare(
        `SELECT body_md FROM comments_v
          WHERE owner_type = 'thought' AND owner_id = ? AND kind = 'permanent'
          LIMIT 1`,
      )
      .get(sourceId) as { body_md: string } | undefined;
    const resolved =
      row === undefined
        ? { found: false, body_md: '' }
        : { found: true, body_md: row.body_md };
    cache.set(sourceId, resolved);
    return resolved;
  };
}

/**
 * Build a {@link BodyExpander} bound to one network connection. The returned
 * function expands transclusions up to the package's depth cap (5) with the
 * ADR `85a7a01e` boundary markers; a body without references is returned
 * unchanged.
 */
export function createBodyExpander(ndb: NetworkDb): BodyExpander {
  const resolve = createTransclusionResolver(ndb);
  return (body_md: string): string => expandTransclusions(body_md, resolve);
}
