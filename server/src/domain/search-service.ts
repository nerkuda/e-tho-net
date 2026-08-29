/**
 * Full-text search service (task C9, docs/03-server-api.md §12–13,
 * docs/02-data-model.md §3.11).
 *
 * Four result groups mirror the search scenario (docs/03-server-api.md §12):
 *   * `by_names`  — thought titles + synonyms (fts_thought_names);
 *   * `by_texts`  — bodies of comments owned by thoughts (fts_thought_texts);
 *   * `by_links`  — bodies of comments owned by links (fts_link_texts);
 *   * `by_chrono` — chronological comments (kind='chronological') over the two
 *                   comment-text indexes.
 *
 * FTS5 is used for `MATCH` (matching rows) and `rank` ordering only. Snippet
 * highlighting is produced in TypeScript over the source text (`title` /
 * `body_md`, joined from the base tables): the FTS5 `snippet()` helper returns
 * the UNINDEXED payload column instead of the indexed `text` when the schema
 * declares the payload column first (a known quirk in this SQLite build), so a
 * deterministic JS highlighter is safer and version-independent.
 *
 * Filters: `in_subtree_of` (recursive CTE), `scope`, `type_id[]`,
 * `link_type_id[]`, `show_inactive`. Results are bounded per group by
 * `limit`/`offset` (default 50 / 0).
 *
 * {@link findDuplicates} powers the add-thought dialog and the MCP
 * `find_duplicates` tool; {@link findMentions} powers the editor mentions
 * panel; {@link findMentionsInTexts} powers the comment view-mode
 * auto-annotation of thought mentions (§21, L24) — the reverse direction:
 * many thoughts scanned against one caller-supplied text.
 */

import {
  buildLikePattern,
  EtnError,
  parseFilterKeywords,
  regexEscape,
  SEARCH_SCOPES,
  splitCompoundTitle,
  synonymPatternToRegex,
  TRAVERSAL_DEFAULTS,
  type IconKind,
  type MentionHit,
  type MentionsScanMatch,
  type SearchChronoHit,
  type SearchLinkHit,
  type SearchNameHit,
  type SearchRequest,
  type SearchResponse,
  type SearchResponseMeta,
  type SearchScope,
  type SearchTextHit,
} from '@etn/shared';

import type { NetworkDb } from '../db/network-db.js';
import {
  FONT_BOLD_BIT,
  FONT_ITALIC_BIT,
  FONT_STRIKE_BIT,
  FONT_UNDERLINE_BIT,
  readFont,
} from './font-style.js';
import { expandTypeIdsToSubtree } from './type-hierarchy.js';

// Re-export so route/MCP callers have a single import surface for read helpers
// (docs/03-server-api.md §6.9 resolve is conceptually part of search/lookup).
export { resolveThoughts } from './thought-service.js';

// ---------------------------------------------------------------------------
// FTS query sanitisation & highlighting
// ---------------------------------------------------------------------------

/**
 * Split raw input into clean search terms: trimmed, quote-free tokens of
 * length ≥ 1. Used both to build the FTS MATCH expression and to drive
 * client-side-style snippet highlighting.
 */
function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length >= 1);
}

/**
 * Build a safe FTS5 MATCH expression from user input using the keywords
 * mini-syntax (03-server-api.md §6.10): every include word is a required
 * phrase of word-prefixes, `-word` exclusions join as NOT. FTS5 cannot express
 * an infix `*`, so a star degenerates into a phrase break (`сло*во` → the
 * adjacent prefixes «сло» «во»); a trailing star folds into the FTS5 prefix
 * marker the tokenizer already produced. Double quotes are stripped from
 * tokens first, so the input cannot break out of the phrase literals. Returns
 * an empty string when no usable include tokens remain — callers treat that
 * as "no match" (a query of pure exclusions matches nothing).
 */
function sanitizeFtsQuery(text: string, operator: 'AND' | 'OR' = 'AND'): string {
  const phrase = (word: string): string => {
    const tokens = tokenize(word.replace(/\*/g, ' '));
    if (tokens.length === 0) return '';
    return tokens.map((t) => `"${t}"*`).join(' ');
  };
  const { include, exclude } = parseFilterKeywords(text);
  const positives = include.map(phrase).filter((p) => p !== '');
  if (positives.length === 0) return '';
  const joiner = operator === 'OR' ? ' OR ' : ' ';
  let match = positives.join(joiner);
  for (const word of exclude) {
    const negative = phrase(word);
    if (negative !== '') match += ` NOT ${negative}`;
  }
  return match;
}

/** HTML-escape the five significant characters of a text node. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build an FTS5 candidate MATCH expression for one mention term (a compound
 * title part or a synonym): a phrase where words without `*` are exact token
 * literals and a pattern word contributes its literal prefix up to the first
 * `*`. Candidates are intentionally broad — exact word-boundary and adjacency
 * semantics are enforced by {@link synonymPatternToRegex} afterwards. Returns
 * `null` when a pattern word has no literal prefix (e.g. `*ян`) — such terms
 * need a full scan instead.
 */
function candidateMatchForTerm(term: string): string | null {
  const words = term.trim().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return null;
  const parts: string[] = [];
  for (const word of words) {
    const star = word.indexOf('*');
    if (star === -1) {
      // A pattern word without `*` must match exactly.
      parts.push(`"${word.toLowerCase().replace(/"/g, '""')}"`);
      continue;
    }
    const literal = word.slice(0, star).toLowerCase();
    if (literal === '') return null;
    parts.push(`"${literal.replace(/"/g, '""')}"*`);
  }
  return parts.join(' ');
}

/**
 * Wrap every case-insensitive occurrence of any of `terms` in `<mark>…</mark>`.
 * Input is HTML-escaped first, so stored markdown/source angle brackets are
 * inert; terms are escaped on both layers (HTML + regex) to stay literal.
 */
function highlight(rawText: string, terms: string[]): string {
  const escaped = escapeHtml(rawText);
  const escapedTerms = terms.map(escapeHtml).filter((t) => t.length > 0);
  if (escapedTerms.length === 0) return escaped;
  const alternation = escapedTerms.map(regexEscape).join('|');
  const re = new RegExp(`(${alternation})`, 'giu');
  return escaped.replace(re, '<mark>$1</mark>');
}

/** Default snippet window length (characters) around the first match. */
const SNIPPET_WINDOW = 160;

/** Closed `[[…]]` span — content without brackets/newlines, as in the parsers. */
const WIKI_SPAN_RE = /\[\[[^[\]\n]*\]\]/g;

/**
 * Build a short snippet with highlights: a window around the first match of any
 * term, ellipsised when truncated, with every term wrapped in `<mark>`.
 * Shared with the chronicle view (L20) for its table previews.
 */
export function makeSnippet(rawText: string, terms: string[]): string {
  const lower = rawText.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0 && (first < 0 || idx < first)) first = idx;
  }
  let start = 0;
  let end = rawText.length;
  if (first >= 0) {
    start = Math.max(0, first - 40);
    end = Math.min(rawText.length, start + SNIPPET_WINDOW);
  } else if (rawText.length > SNIPPET_WINDOW) {
    end = SNIPPET_WINDOW;
  }
  // Не разрезать wiki-ссылки на границах окна: обрывок `…<uuid>]]` или
  // `[[#<uuid>…` клиент не может резолвить в имя. Раздвигаем границы до
  // краёв `[[…]]`, когда они попадают внутрь ссылки.
  WIKI_SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_SPAN_RE.exec(rawText)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    if (from <= start && start < to) start = from;
    if (from < end && end < to) end = to;
  }
  let fragment = rawText.slice(start, end);
  if (start > 0) fragment = `…${fragment}`;
  if (end < rawText.length) fragment = `${fragment}…`;
  return highlight(fragment, terms);
}

// ---------------------------------------------------------------------------
// Subtree filter (recursive CTE, cycle-safe — docs/11-settings-and-state.md §5)
// ---------------------------------------------------------------------------

/** Options for {@link collectSubtreeIds} / {@link collectSubtreeTypes}. */
export interface SubtreeOptions {
  /** Max edge-hops from the seed (default {@link TRAVERSAL_DEFAULTS.MAX_DEPTH}). */
  maxDepth?: number;
  /** Include inactive links in the traversal. */
  showInactive?: boolean;
  /** Include inactive thoughts in the result. Default: false (matches search). */
  includeInactiveThoughts?: boolean;
}

/**
 * Collect the thought id and all its **subordinates** (children,
 * `source → target` direction, per docs/11-settings-and-state.md §5.2) via a
 * recursive CTE. The seed itself is always included. Returns `null` when no
 * seed is given (meaning "no subtree restriction").
 *
 * Cycle safety comes from `UNION` row deduplication (at most one row per
 * `(id, depth)`, so the working set is bounded by `|thoughts| × max_depth`)
 * instead of a `path` string guard: the path-guarded variant enumerates
 * simple paths, which explodes exponentially on cyclic graphs and freezes
 * the synchronous SQLite event loop (the «Хроника» subtree filter hang).
 */
export function collectSubtreeIds(
  ndb: NetworkDb,
  seedId: string | undefined,
  opts: SubtreeOptions = {},
): Set<string> | null {
  if (seedId === undefined) return null;
  const maxDepth = opts.maxDepth ?? TRAVERSAL_DEFAULTS.MAX_DEPTH;
  const showInactive = opts.showInactive === true ? 1 : 0;
  const rows = ndb
    .prepare(
      `WITH RECURSIVE
        descend(id, depth) AS (
          SELECT :seed, 0
          UNION
          SELECT l.target_id, d.depth + 1
          FROM descend d
          JOIN links_v l ON l.source_id = d.id AND (l.active = 1 OR :show_inactive)
          WHERE d.depth < :max_depth
        )
       SELECT DISTINCT id FROM descend`,
    )
    .all({ seed: seedId, max_depth: maxDepth, show_inactive: showInactive }) as Array<{
    id: string;
  }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * Aggregate `type_id` usage inside a thought's subtree (task O16,
 * docs/05-mcp-server.md §5.1b — `etn.types.list` with `in_subtree_of`).
 *
 * Returns:
 *   * `thought_type_counts` — `Map<type_id, count>` of distinct thought types
 *     used in the subtree (`thoughts.type_id` is nullable, so thoughts without
 *     a type are counted under `null` and dropped from the returned map).
 *   * `link_type_counts` — `Map<type_id, count>` of distinct link types
 *     used by links whose both endpoints lie inside the subtree. Inactive
 *     links are excluded.
 *
 * Returns `null` for both maps when no `seedId` is supplied (meaning "no
 * subtree restriction" — the caller should fall back to the full catalogue).
 */
export interface SubtreeTypes {
  thought_type_counts: Map<string, number>;
  link_type_counts: Map<string, number>;
}

export function collectSubtreeTypes(
  ndb: NetworkDb,
  seedId: string | undefined,
  opts: SubtreeOptions = {},
): SubtreeTypes {
  const empty: SubtreeTypes = {
    thought_type_counts: new Map(),
    link_type_counts: new Map(),
  };
  const ids = collectSubtreeIds(ndb, seedId, opts);
  if (ids === null || ids.size === 0) {
    return empty;
  }
  const includeInactiveThoughts = opts.includeInactiveThoughts === true;
  const idList = Array.from(ids);

  // Single pass: thought type usage grouped by type_id.
  const thoughtRows = ndb
    .prepare(
      `SELECT type_id, COUNT(*) AS c
         FROM thoughts_v
        WHERE id IN (${idList.map(() => '?').join(',')})
          ${includeInactiveThoughts ? '' : 'AND active = 1'}
          AND type_id IS NOT NULL
        GROUP BY type_id`,
    )
    .all(...idList) as Array<{ type_id: string; c: number }>;
  for (const row of thoughtRows) {
    empty.thought_type_counts.set(row.type_id, row.c);
  }

  // Link types restricted to the subtree (both endpoints inside the set) so a
  // single cross-boundary link is never counted under the section's type. The
  // set of ids is small after the recursive CTE; the IN-list is bounded by the
  // subtree size.
  const linkRows = ndb
    .prepare(
      `SELECT type_id, COUNT(*) AS c
         FROM links_v
        WHERE source_id IN (${idList.map(() => '?').join(',')})
          AND target_id IN (${idList.map(() => '?').join(',')})
          AND active = 1
          AND type_id IS NOT NULL
        GROUP BY type_id`,
    )
    .all(...idList, ...idList) as Array<{ type_id: string; c: number }>;
  for (const row of linkRows) {
    empty.link_type_counts.set(row.type_id, row.c);
  }
  return empty;
}

// ---------------------------------------------------------------------------
// Shared filter helpers
// ---------------------------------------------------------------------------

/** Resolved filters shared by all four search groups. */
interface SearchFilters {
  showInactive: boolean;
  /** S13: when false (default) marked-for-deletion rows are hidden. */
  trashed: boolean;
  typeIds: string[] | null;
  linkTypeIds: string[] | null;
  subtreeIds: Set<string> | null;
  limit: number;
  offset: number;
  /** Highlight terms derived from the query (for JS snippet highlighting). */
  terms: string[];
}

/** A WHERE condition fragment plus its bind parameters, in order. */
interface Clause {
  sql: string;
  params: unknown[];
}

/** Clamp limit/offset to a sane window. */
function clampPaging(
  limit: number | undefined,
  offset: number | undefined,
): {
  limit: number;
  offset: number;
} {
  return {
    limit: Math.min(Math.max(limit ?? 50, 1), 200),
    offset: Math.max(offset ?? 0, 0),
  };
}

/** Build a `(col IN (?, ?…))` clause, or `null` when `ids` is empty. */
function inListClause(column: string, ids: string[] | null): Clause | null {
  if (!ids || ids.length === 0) return null;
  const placeholders = ids.map(() => '?').join(',');
  return { sql: `${column} IN (${placeholders})`, params: [...ids] };
}

/** Build a subtree-restriction clause, or `null` when the set is not limiting. */
function subtreeClause(column: string, ids: Set<string> | null): Clause | null {
  if (ids === null) return null;
  if (ids.size === 0) return { sql: '0', params: [] }; // guaranteed-false
  const placeholders = [...ids].map(() => '?').join(',');
  return { sql: `${column} IN (${placeholders})`, params: [...ids] };
}

/** Join clause fragments into a single `c1 AND c2 AND …` block. */
function joinClauses(clauses: Array<Clause | null>): { where: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const c of clauses) {
    if (!c) continue;
    parts.push(c.sql);
    params.push(...c.params);
  }
  return { where: parts.join(' AND '), params };
}

// ---------------------------------------------------------------------------
// Group: by_names
// ---------------------------------------------------------------------------

/** Query the thought-names group. */
function searchNames(
  ndb: NetworkDb,
  match: string,
  f: SearchFilters,
): { hits: SearchNameHit[]; total: number } {
  if (f.subtreeIds !== null && f.subtreeIds.size === 0) return { hits: [], total: 0 };
  const { where, params } = joinClauses([
    { sql: 'fts_thought_names MATCH ?', params: [match] },
    { sql: '(t.active = 1 OR ?)', params: [f.showInactive ? 1 : 0] },
    { sql: '(t.marked_for_deletion = 0 OR ?)', params: [f.trashed ? 1 : 0] },
    inListClause('t.type_id', f.typeIds),
    subtreeClause('f.thought_id', f.subtreeIds),
  ]);
  const total = (
    ndb
      .prepare(
        `SELECT COUNT(*) AS c FROM fts_thought_names f
         JOIN thoughts_v t ON t.id = f.thought_id WHERE ${where}`,
      )
      .get(...params) as { c: number }
  ).c;
  // The names FTS index is keyed by `thought_id`/`synonym_norm`, so one row
  // already maps to one thought — no per-comment collapse is needed here.
  // Visual style and `active` are joined from `thoughts` so the client can
  // render the hit row like a cloud on the canvas (08-ui-spec.md §2.2).
  const rows = ndb
    .prepare(
      `SELECT f.thought_id AS thought_id, t.title AS title, t.icon AS icon,
              t.icon_kind AS icon_kind, t.icon_attachment_id AS icon_attachment_id,
              t.fg_color AS fg_color, t.bg_color AS bg_color,
              t.font_bold AS font_bold, t.font_italic AS font_italic,
              t.font_underline AS font_underline, t.font_strike AS font_strike,
              t.font_manual AS font_manual,
              t.type_id AS type_id, t.active AS active
       FROM fts_thought_names f
       JOIN thoughts_v t ON t.id = f.thought_id
       WHERE ${where}
       ORDER BY rank
       LIMIT ? OFFSET ?`,
    )
    .all(...params, f.limit, f.offset) as Array<{
    thought_id: string;
    title: string;
    icon: string | null;
    icon_kind: string;
    icon_attachment_id: string | null;
    fg_color: string | null;
    bg_color: string | null;
    font_bold: number;
    font_italic: number;
    font_underline: number;
    font_strike: number;
    font_manual: number;
    type_id: string | null;
    active: number;
  }>;
  return {
    hits: rows.map((r) => {
      const snippet = makeSnippet(r.title, f.terms);
      return {
        thought_id: r.thought_id,
        title: r.title,
        icon: r.icon,
        icon_kind: r.icon_kind as IconKind,
        icon_attachment_id: r.icon_attachment_id,
        fg_color: r.fg_color,
        bg_color: r.bg_color,
        font_bold: readFont(r.font_manual, FONT_BOLD_BIT, r.font_bold),
        font_italic: readFont(r.font_manual, FONT_ITALIC_BIT, r.font_italic),
        font_underline: readFont(r.font_manual, FONT_UNDERLINE_BIT, r.font_underline),
        font_strike: readFont(r.font_manual, FONT_STRIKE_BIT, r.font_strike),
        type_id: r.type_id,
        active: r.active === 1,
        snippet,
        highlights: [snippet],
      };
    }),
    total,
  };
}

// ---------------------------------------------------------------------------
// Group: by_texts
// ---------------------------------------------------------------------------

/** Query the thought-comment-texts group. */
function searchTexts(
  ndb: NetworkDb,
  match: string,
  f: SearchFilters,
): { hits: SearchTextHit[]; total: number } {
  if (f.subtreeIds !== null && f.subtreeIds.size === 0) return { hits: [], total: 0 };
  const { where, params } = joinClauses([
    { sql: 'fts_thought_texts MATCH ?', params: [match] },
    { sql: "c.owner_type = 'thought'", params: [] },
    { sql: '(t.active = 1 OR ?)', params: [f.showInactive ? 1 : 0] },
    { sql: '(t.marked_for_deletion = 0 OR ?)', params: [f.trashed ? 1 : 0] },
    inListClause('t.type_id', f.typeIds),
    subtreeClause('f.thought_id', f.subtreeIds),
  ]);
  // One row per (thought, comment). The text FTS is keyed by comment rowid —
  // a thought with N matching comments shows up N times. The result list must
  // collapse to one hit per thought (UX expectation; `comment_id` keeps the
  // first match so the user can navigate to it). `total` counts distinct
  // thoughts, the inner `rank` ordering drives which comment wins.
  const total = (
    ndb
      .prepare(
        `SELECT COUNT(DISTINCT f.thought_id) AS c FROM fts_thought_texts f
         JOIN comments_v c ON c.rowid = f.rowid
         JOIN thoughts_v t ON t.id = f.thought_id WHERE ${where}`,
      )
      .get(...params) as { c: number }
  ).c;
  const rows = ndb
    .prepare(
      `SELECT comment_id, thought_id, title, body, icon, icon_kind,
              icon_attachment_id, fg_color, bg_color,
              font_bold, font_italic, font_underline, font_strike,
              font_manual, type_id, active
       FROM (
         SELECT c.id AS comment_id, f.thought_id AS thought_id, t.title AS title,
                c.body_md AS body, t.icon AS icon, t.icon_kind AS icon_kind,
                t.icon_attachment_id AS icon_attachment_id,
                t.fg_color AS fg_color, t.bg_color AS bg_color,
                t.font_bold AS font_bold, t.font_italic AS font_italic,
                t.font_underline AS font_underline, t.font_strike AS font_strike,
                t.font_manual AS font_manual,
                t.type_id AS type_id, t.active AS active,
                rank AS _rank,
                ROW_NUMBER() OVER (PARTITION BY f.thought_id ORDER BY rank) AS _rn
         FROM fts_thought_texts f
         JOIN comments_v c ON c.rowid = f.rowid
         JOIN thoughts_v t ON t.id = f.thought_id
         WHERE ${where}
       )
       WHERE _rn = 1
       ORDER BY _rank
       LIMIT ? OFFSET ?`,
    )
    .all(...params, f.limit, f.offset) as Array<{
    comment_id: string;
    thought_id: string;
    title: string;
    body: string;
    icon: string | null;
    icon_kind: string;
    icon_attachment_id: string | null;
    fg_color: string | null;
    bg_color: string | null;
    font_bold: number;
    font_italic: number;
    font_underline: number;
    font_strike: number;
    font_manual: number;
    type_id: string | null;
    active: number;
  }>;
  return {
    hits: rows.map((r) => {
      const snippet = makeSnippet(r.body, f.terms);
      return {
        thought_id: r.thought_id,
        title: r.title,
        icon: r.icon,
        icon_kind: r.icon_kind as IconKind,
        icon_attachment_id: r.icon_attachment_id,
        fg_color: r.fg_color,
        bg_color: r.bg_color,
        font_bold: readFont(r.font_manual, FONT_BOLD_BIT, r.font_bold),
        font_italic: readFont(r.font_manual, FONT_ITALIC_BIT, r.font_italic),
        font_underline: readFont(r.font_manual, FONT_UNDERLINE_BIT, r.font_underline),
        font_strike: readFont(r.font_manual, FONT_STRIKE_BIT, r.font_strike),
        type_id: r.type_id,
        active: r.active === 1,
        snippet,
        comment_id: r.comment_id,
        highlights: [snippet],
      };
    }),
    total,
  };
}

// ---------------------------------------------------------------------------
// Group: by_links
// ---------------------------------------------------------------------------

/** Query the link-comment-texts group. */
function searchLinks(
  ndb: NetworkDb,
  match: string,
  f: SearchFilters,
): { hits: SearchLinkHit[]; total: number } {
  const { where, params } = joinClauses([
    { sql: 'fts_link_texts MATCH ?', params: [match] },
    { sql: "c.owner_type = 'link'", params: [] },
    { sql: '(l.active = 1 OR ?)', params: [f.showInactive ? 1 : 0] },
    { sql: '(l.marked_for_deletion = 0 OR ?)', params: [f.trashed ? 1 : 0] },
    inListClause('l.type_id', f.linkTypeIds),
  ]);
  // Same collapse as `searchTexts`: one hit per `link_id`. `total` counts
  // distinct links, the inner `rank` picks the first comment per link.
  const total = (
    ndb
      .prepare(
        `SELECT COUNT(DISTINCT f.link_id) AS c FROM fts_link_texts f
         JOIN comments_v c ON c.rowid = f.rowid
         LEFT JOIN links_v l ON l.id = f.link_id WHERE ${where}`,
      )
      .get(...params) as { c: number }
  ).c;
  const rows = ndb
    .prepare(
      `SELECT link_id, type_name, body FROM (
         SELECT f.link_id AS link_id, lt.name_forward AS type_name, c.body_md AS body,
                rank AS _rank,
                ROW_NUMBER() OVER (PARTITION BY f.link_id ORDER BY rank) AS _rn
         FROM fts_link_texts f
         JOIN comments_v c ON c.rowid = f.rowid
         LEFT JOIN links_v l ON l.id = f.link_id
         LEFT JOIN link_types_v lt ON lt.id = l.type_id
         WHERE ${where}
       )
       WHERE _rn = 1
       ORDER BY _rank
       LIMIT ? OFFSET ?`,
    )
    .all(...params, f.limit, f.offset) as Array<{
    link_id: string;
    type_name: string | null;
    body: string;
  }>;
  return {
    hits: rows.map((r) => {
      const snippet = makeSnippet(r.body, f.terms);
      return {
        link_id: r.link_id,
        type_name: r.type_name ?? '',
        snippet,
        highlights: [snippet],
      };
    }),
    total,
  };
}

// ---------------------------------------------------------------------------
// Group: by_chrono (chronological comments over both indexes, UNION)
// ---------------------------------------------------------------------------

/** Raw chrono row from either FTS index. */
interface ChronoRow {
  comment_id: string;
  owner: 'thought' | 'link';
  owner_id: string;
  valid_from: string;
  valid_to: string | null;
  body: string;
}

/** Build one half of the chrono UNION (SQL text + bind array in order). */
function buildChronoHalf(
  side: 'thought' | 'link',
  match: string,
  f: SearchFilters,
): { sql: string; params: unknown[] } {
  const ftsTable = side === 'thought' ? 'fts_thought_texts' : 'fts_link_texts';
  const clauses: Array<Clause | null> = [
    { sql: `${ftsTable} MATCH ?`, params: [match] },
    { sql: 'c.owner_type = ?', params: [side] },
    { sql: "c.kind = 'chronological'", params: [] },
  ];
  // Each side joins only the table that owns the comment, so the referenced
  // FTS payload column always exists (fts_thought_texts.thought_id for thoughts,
  // fts_link_texts.link_id for links).
  let joins = '';
  if (side === 'thought') {
    clauses.push({ sql: '(t.active = 1 OR ?)', params: [f.showInactive ? 1 : 0] });
    clauses.push({ sql: '(t.marked_for_deletion = 0 OR ?)', params: [f.trashed ? 1 : 0] });
    clauses.push(inListClause('t.type_id', f.typeIds));
    clauses.push(subtreeClause('f.thought_id', f.subtreeIds));
    joins = 'JOIN thoughts_v t ON t.id = c.owner_id';
  } else {
    clauses.push({ sql: '(l.active = 1 OR ?)', params: [f.showInactive ? 1 : 0] });
    clauses.push({ sql: '(l.marked_for_deletion = 0 OR ?)', params: [f.trashed ? 1 : 0] });
    clauses.push(inListClause('l.type_id', f.linkTypeIds));
    joins = 'LEFT JOIN links_v l ON l.id = c.owner_id';
  }
  const { where, params } = joinClauses(clauses);
  const sql = `SELECT c.id AS comment_id, '${side}' AS owner, c.owner_id AS owner_id,
                 c.valid_from AS valid_from, c.valid_to AS valid_to, c.body_md AS body
               FROM ${ftsTable} f
               JOIN comments_v c ON c.rowid = f.rowid
               ${joins}
               WHERE ${where}`;
  return { sql, params };
}

/** Query chronological comments from both comment-text indexes. */
function searchChrono(
  ndb: NetworkDb,
  match: string,
  f: SearchFilters,
): { hits: SearchChronoHit[]; total: number } {
  const thought = buildChronoHalf('thought', match, f);
  const link = buildChronoHalf('link', match, f);
  const rows = ndb
    .prepare(`${thought.sql}\nUNION ALL\n${link.sql}`)
    .all(...thought.params, ...link.params) as ChronoRow[];

  // Each chronological comment is its own FTS row, so an owner with N matching
  // entries shows up N times. Collapse to one hit per `(owner, owner_id)`,
  // keeping the earliest `valid_from` (chronology's natural sort) and the id
  // of the first match so the caller can still navigate to it.
  const firstByOwner = new Map<string, ChronoRow>();
  for (const r of rows) {
    const key = `${r.owner}:${r.owner_id}`;
    const current = firstByOwner.get(key);
    if (
      current === undefined ||
      r.valid_from < current.valid_from ||
      (r.valid_from === current.valid_from && r.comment_id < current.comment_id)
    ) {
      firstByOwner.set(key, r);
    }
  }
  const ordered = [...firstByOwner.values()].sort((a, b) =>
    a.valid_from < b.valid_from ? -1 : a.valid_from > b.valid_from ? 1 : 0,
  );
  const total = ordered.length;
  const paged = ordered.slice(f.offset, f.offset + f.limit);
  return {
    hits: paged.map((r) => {
      const snippet = makeSnippet(r.body, f.terms);
      return {
        owner: r.owner,
        owner_id: r.owner_id,
        comment_id: r.comment_id,
        valid_from: r.valid_from,
        valid_to: r.valid_to,
        snippet,
        highlights: [snippet],
      };
    }),
    total,
  };
}

// ---------------------------------------------------------------------------
// Public: search
// ---------------------------------------------------------------------------

/**
 * Run a full-text search (docs/03-server-api.md §12).
 *
 * @param ndb - open network database.
 * @param request - query parameters; `scope` selects which groups to populate.
 * @param showInactiveDefault - caller's `preferences.show_inactive` value, used
 *   when `request.show_inactive` is omitted.
 */
export function search(
  ndb: NetworkDb,
  request: SearchRequest,
  showInactiveDefault = false,
): SearchResponse {
  if (typeof request.q !== 'string' || request.q.trim() === '') {
    throw new EtnError('VALIDATION_ERROR', 'q must be a non-empty string', { field: 'q' });
  }
  const scope: SearchScope =
    typeof request.scope === 'string' &&
    (SEARCH_SCOPES as readonly string[]).includes(request.scope)
      ? (request.scope as SearchScope)
      : 'all';
  const match = sanitizeFtsQuery(request.q);
  const paging = clampPaging(request.limit, request.offset);
  // Highlight terms: the include words only (`*` folded away, exclusions
  // dropped) — they are what the matches above actually found in the text.
  const highlightTerms = parseFilterKeywords(request.q).include.flatMap((w) =>
    tokenize(w.replace(/\*/g, ' ')),
  );

  const filters: SearchFilters = {
    showInactive: request.show_inactive ?? showInactiveDefault,
    trashed: request.trashed === true,
    // L21: a selected parent type matches its whole subtree (OR semantics).
    typeIds: request.type_id ? expandTypeIdsToSubtree(ndb, 'thought_types', request.type_id) : null,
    linkTypeIds: request.link_type_id
      ? expandTypeIdsToSubtree(ndb, 'link_types', request.link_type_id)
      : null,
    subtreeIds: request.in === 'subtree' ? collectSubtreeIds(ndb, request.from_thought_id) : null,
    limit: paging.limit,
    offset: paging.offset,
    terms: highlightTerms,
  };

  const empty: SearchResponse = {
    by_names: [],
    by_texts: [],
    by_links: [],
    by_chrono: [],
    meta: { total_in_group: { names: 0, texts: 0, links: 0, chronology: 0 } },
  };
  if (match === '') {
    return empty;
  }

  const wants = (group: SearchScope): boolean => scope === 'all' || scope === group;
  const names = wants('names') ? searchNames(ndb, match, filters) : { hits: [], total: 0 };
  const texts = wants('texts') ? searchTexts(ndb, match, filters) : { hits: [], total: 0 };
  const links = wants('links') ? searchLinks(ndb, match, filters) : { hits: [], total: 0 };
  const chrono = wants('chronology') ? searchChrono(ndb, match, filters) : { hits: [], total: 0 };

  const meta: SearchResponseMeta = {
    total_in_group: {
      names: names.total,
      texts: texts.total,
      links: links.total,
      chronology: chrono.total,
    },
  };
  return {
    by_names: names.hits,
    by_texts: texts.hits,
    by_links: links.hits,
    by_chrono: chrono.hits,
    meta,
  };
}

// ---------------------------------------------------------------------------
// Public: findDuplicates (add-thought dialog + MCP find_duplicates)
// ---------------------------------------------------------------------------

/** How a candidate matched the query (in descending priority order). */
export type DuplicateMatchKind = 'title' | 'synonym' | 'partial';

/** A candidate returned by {@link findDuplicates}. */
export interface DuplicateHit {
  id: string;
  title: string;
  /** Display forms of the candidate's synonyms. */
  synonyms: string[];
  /** Strongest match found. */
  matched_on: DuplicateMatchKind;
  /** Synonym text that matched, when `matched_on === 'synonym'`. */
  matched_synonym?: string;
  /** The candidate's own thought type (for icon/style resolution). */
  type_id: string | null;
  /** Own icon, when set; the caller falls back to the type's icon. */
  icon: string | null;
  icon_kind: IconKind;
  /** Own style overrides (nullable: inherit the type defaults, 02-data-model.md §3.1.1). */
  fg_color: string | null;
  bg_color: string | null;
  font_bold: boolean | null;
  font_italic: boolean | null;
  font_underline: boolean | null;
  font_strike: boolean | null;
  /**
   * Title of one parent (lexicographically first), so the add dialog can
   * disambiguate equal titles under different parents.
   */
  parent_title: string | null;
}

/** Normalise a title/synonym the way the thought service does (NFC+trim+lower). */
function norm(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
}

/**
 * Find existing thoughts that look like duplicates of the proposed
 * `title`/`synonyms` (docs/08-ui-spec.md add-thought dialog; MCP
 * `find_duplicates`).
 *
 * Match priority (strongest wins per candidate): exact `title_norm`, exact
 * `synonym_norm`, then partial. Partial follows the synonym-pattern principle
 * (02-data-model.md §3.2) with an implicit `*` around every typed word, so
 * the user never types `*`: a single fragment matches inside a word of the
 * title or of one synonym («дор» → «Доработать!», «Подорожание 2026 года»,
 * «Дорога в лето»); several fragments must occur inside CONSECUTIVE words in
 * the typed order («исправ ошиб» → «Исправленные ошибки», but not «исправить
 * старую ошибку»). A `-word` exclusion (03-server-api.md §6.10) uses the same
 * infix semantics and drops a candidate whose title/synonyms contain the
 * fragment anywhere. An explicit `*` in a word is allowed and is absorbed by
 * the implicit wrappers. Results are ordered by match strength.
 *
 * @param title - proposed thought title.
 * @param synonyms - optional proposed synonyms.
 * @param typeIds - optional thought-type filter (property `thought_ref`
 *   pickers): only thoughts of these types are returned.
 */
export function findDuplicates(
  ndb: NetworkDb,
  title: string,
  synonyms: string[] = [],
  typeIds: string[] = [],
): DuplicateHit[] {
  const titleTerms = [title.trim(), ...synonyms.map((s) => s.trim())].filter((t) => t !== '');
  if (titleTerms.length === 0) return [];

  // Type filter (thought_ref pickers): parameterised IN-list applied to every
  // query below. L21: the list is expanded to whole subtrees, so picking a
  // parent type also offers its descendants. The direct thoughts queries use
  // `type_id`, the synonym join aliases the table as `t`.
  const types = expandTypeIdsToSubtree(
    ndb,
    'thought_types',
    [...new Set(typeIds.filter((t) => t !== ''))],
  );
  const typeDirect =
    types.length > 0 ? ` AND type_id IN (${types.map(() => '?').join(',')})` : '';
  const typeJoin = types.length > 0 ? ` AND t.type_id IN (${types.map(() => '?').join(',')})` : '';
  const typeArgs = types;

  const byId = new Map<string, DuplicateHit>();

  /** The row columns shared by every candidate query below. */
  const DUP_COLUMNS = `id, title, type_id, icon, icon_kind, fg_color, bg_color,
       font_bold, font_italic, font_underline, font_strike, font_manual`;

  const ensure = (row: {
    id: string;
    title: string;
    type_id: string | null;
    icon: string | null;
    icon_kind: string;
    fg_color: string | null;
    bg_color: string | null;
    font_bold: number;
    font_italic: number;
    font_underline: number;
    font_strike: number;
    font_manual: number;
  }): DuplicateHit => {
    let hit = byId.get(row.id);
    if (!hit) {
      const synRows = ndb
        .prepare('SELECT synonym FROM thought_synonyms_v WHERE thought_id = ? ORDER BY synonym')
        .all(row.id) as Array<{ synonym: string }>;
      hit = {
        id: row.id,
        title: row.title,
        synonyms: synRows.map((s) => s.synonym),
        matched_on: 'partial',
        type_id: row.type_id,
        icon: row.icon,
        icon_kind: row.icon_kind === 'image' ? 'image' : 'emoji',
        fg_color: row.fg_color,
        bg_color: row.bg_color,
        font_bold: readFont(row.font_manual, FONT_BOLD_BIT, row.font_bold),
        font_italic: readFont(row.font_manual, FONT_ITALIC_BIT, row.font_italic),
        font_underline: readFont(row.font_manual, FONT_UNDERLINE_BIT, row.font_underline),
        font_strike: readFont(row.font_manual, FONT_STRIKE_BIT, row.font_strike),
        parent_title: null,
      };
      byId.set(row.id, hit);
    }
    return hit;
  };

  // Stored synonym patterns containing `*` — matched against each input term
  // with the word-boundary semantics of synonymPatternToRegex (a thought with
  // synonym `Игорян*` matches the input `Игорянский`).
  const wildSynRows = ndb
    .prepare(
      `SELECT ts.thought_id AS id, t.title AS title, t.type_id AS type_id,
              t.icon AS icon, t.icon_kind AS icon_kind,
              t.fg_color AS fg_color, t.bg_color AS bg_color,
              t.font_bold AS font_bold, t.font_italic AS font_italic,
              t.font_underline AS font_underline, t.font_strike AS font_strike,
              t.font_manual AS font_manual,
              ts.synonym AS synonym, ts.synonym_norm AS synonym_norm
       FROM thought_synonyms_v ts JOIN thoughts_v t ON t.id = ts.thought_id
       WHERE ts.synonym LIKE '%*%'${typeJoin}`,
    )
    .all(...typeArgs) as Array<{
    id: string;
    title: string;
    type_id: string | null;
    icon: string | null;
    icon_kind: string;
    fg_color: string | null;
    bg_color: string | null;
    font_bold: number;
    font_italic: number;
    font_underline: number;
    font_strike: number;
    font_manual: number;
    synonym: string;
    synonym_norm: string;
  }>;

  for (const term of titleTerms) {
    const n = norm(term);
    // Exact title_norm match (strongest).
    const titleRows = ndb
      .prepare(`SELECT ${DUP_COLUMNS} FROM thoughts_v WHERE title_norm = ?${typeDirect}`)
      .all(n, ...typeArgs) as Array<{
      id: string;
      title: string;
      type_id: string | null;
      icon: string | null;
      icon_kind: string;
      fg_color: string | null;
      bg_color: string | null;
      font_bold: number;
      font_italic: number;
      font_underline: number;
      font_strike: number;
      font_manual: number;
    }>;
    for (const r of titleRows) {
      ensure(r).matched_on = 'title';
    }
    // Exact synonym_norm match.
    const synRows = ndb
      .prepare(
        `SELECT ts.thought_id AS id, t.title AS title, t.type_id AS type_id,
                t.icon AS icon, t.icon_kind AS icon_kind,
                t.fg_color AS fg_color, t.bg_color AS bg_color,
                t.font_bold AS font_bold, t.font_italic AS font_italic,
                t.font_underline AS font_underline, t.font_strike AS font_strike,
                t.font_manual AS font_manual,
                ts.synonym AS synonym
         FROM thought_synonyms_v ts JOIN thoughts_v t ON t.id = ts.thought_id
         WHERE ts.synonym_norm = ?${typeJoin}`,
      )
      .all(n, ...typeArgs) as Array<{
      id: string;
      title: string;
      type_id: string | null;
      icon: string | null;
      icon_kind: string;
      fg_color: string | null;
      bg_color: string | null;
      font_bold: number;
      font_italic: number;
      font_underline: number;
      font_strike: number;
      font_manual: number;
      synonym: string;
    }>;
    for (const r of synRows) {
      const hit = ensure(r);
      if (hit.matched_on !== 'title') {
        hit.matched_on = 'synonym';
        hit.matched_synonym = r.synonym;
      }
    }
    // Partial — lowest priority; ensure() defaults to 'partial'.
    // The synonym-pattern principle (02-data-model.md §3.2) with an implicit
    // `*` around every typed fragment, so the user never types `*`
    // (08-ui-spec.md §4.3): a single fragment must occur inside a word of
    // the title or of one synonym, several fragments must occur inside
    // CONSECUTIVE words in the typed order. A `-word` exclusion (§6.10)
    // drops a candidate whose title/synonyms contain the fragment anywhere.
    // Without include words there is nothing to anchor the candidates to —
    // a pure negative query returns no partial hits (unlike the structures
    // filter, the dialog must not list the whole network).
    //
    // 0.4.5: the 0.4.3 whole-word rule («Диана» ≠ «обсидиана») broke the
    // infix search of the add-thought dialog («дор» stopped finding
    // «Доработать!») and is reverted here. Partial is the weak "candidate"
    // tier — the exact title/synonym tiers above (plus the anchored
    // `*`-synonym match below) keep the duplicate semantics, so a
    // partial-only hit never auto-substitutes in the dialog.
    //
    // Infix LIKE cannot express the consecutive-words rule, so it stays a
    // cheap SQL pre-filter for every word while the exact semantics are
    // enforced in JS over the surviving rows.
    const keywords = parseFilterKeywords(n);
    if (keywords.include.length > 0) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      const push = (word: string, negate: boolean): void => {
        const pattern = buildLikePattern(word);
        const clause =
          "(title_norm LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM thought_synonyms_v ts" +
          " WHERE ts.thought_id = thoughts.id AND ts.synonym_norm LIKE ? ESCAPE '\\'))";
        conditions.push(negate ? `NOT ${clause}` : clause);
        params.push(pattern, pattern);
      };
      for (const word of keywords.include) push(word, false);
      for (const word of keywords.exclude) push(word, true);
      // `thoughts_v thoughts` — alias keeps the correlated EXISTS reference
      // (`thoughts.id`) valid against the view.
      let partialRows = ndb
        .prepare(
          `SELECT ${DUP_COLUMNS} FROM thoughts_v thoughts WHERE ${conditions.join(' AND ')}${typeDirect}`,
        )
        .all(...params, ...typeArgs) as Array<{
        id: string;
        title: string;
        type_id: string | null;
        icon: string | null;
        icon_kind: string;
        fg_color: string | null;
        bg_color: string | null;
        font_bold: number;
        font_italic: number;
        font_underline: number;
        font_strike: number;
        font_manual: number;
      }>;
      // The include fragments (each implicitly `*`-wrapped) must hit
      // consecutive words of the title or of ONE synonym, in the typed
      // order. synonymPatternToRegex already encodes the word-boundary and
      // adjacency rules; the `*` wrappers turn its exact-word matcher into
      // the infix one.
      const includeRe = synonymPatternToRegex(
        keywords.include.map((w) => `*${w}*`).join(' '),
      );
      if (partialRows.length > 0) {
        // Synonym norms of the candidates in one query, then the
        // consecutive-words check per candidate against its title and
        // every synonym.
        const ids = partialRows.map((r) => r.id);
        const synRows = ndb
          .prepare(
            `SELECT thought_id, synonym_norm FROM thought_synonyms_v
             WHERE thought_id IN (${ids.map(() => '?').join(',')})`,
          )
          .all(...ids) as Array<{ thought_id: string; synonym_norm: string }>;
        const synsByThought = new Map<string, string[]>();
        for (const s of synRows) {
          const list = synsByThought.get(s.thought_id);
          if (list) list.push(s.synonym_norm);
          else synsByThought.set(s.thought_id, [s.synonym_norm]);
        }
        partialRows = partialRows.filter((r) => {
          const hay = [norm(r.title), ...(synsByThought.get(r.id) ?? [])];
          return hay.some((h) => includeRe.test(h));
        });
      }
      for (const r of partialRows) {
        ensure(r);
      }
    }
    // Wildcard synonyms: stored `*`-patterns the input matches. The pattern
    // is a NAME template («Игорян*» matches the proposed title «Игорянский»),
    // so it must match the whole input term, not a word inside it — otherwise
    // a synonym «грабл*» would match the phrase «не наступать на грабли» and
    // the add-thought dialog would treat «Грабли» as an exact duplicate of
    // the whole phrase (08-ui-spec.md §4.4: «`*`-паттерн синонима совпал со
    // вводом»).
    for (const r of wildSynRows) {
      const anchored = new RegExp(`^(?:${synonymPatternToRegex(r.synonym_norm).source})$`, 'iu');
      if (!anchored.test(n)) continue;
      const hit = ensure(r);
      if (hit.matched_on === 'partial') {
        hit.matched_on = 'synonym';
        hit.matched_synonym = r.synonym;
      }
    }
  }

  // One parent title per candidate (lexicographically first) — the add dialog
  // shows it next to equal titles to disambiguate them (08-ui-spec.md §4.2).
  if (byId.size > 0) {
    const ids = [...byId.keys()];
    const parentRows = ndb
      .prepare(
        `SELECT l.target_id AS child_id, t.title AS parent_title
         FROM links_v l JOIN thoughts_v t ON t.id = l.source_id
         WHERE l.target_id IN (${ids.map(() => '?').join(',')}) AND l.active = 1
         ORDER BY l.target_id, t.title_norm`,
      )
      .all(...ids) as Array<{ child_id: string; parent_title: string }>;
    const firstByChild = new Map<string, string>();
    for (const r of parentRows) {
      if (!firstByChild.has(r.child_id)) firstByChild.set(r.child_id, r.parent_title);
    }
    for (const [id, hit] of byId) {
      hit.parent_title = firstByChild.get(id) ?? null;
    }
  }

  const priority: Record<DuplicateMatchKind, number> = { title: 0, synonym: 1, partial: 2 };
  return [...byId.values()].sort(
    (a, b) => priority[a.matched_on] - priority[b.matched_on] || a.title.localeCompare(b.title),
  );
}

// ---------------------------------------------------------------------------
// Public: findMentions (editor mentions panel)
// ---------------------------------------------------------------------------

/**
 * Find comments whose text mentions the given thought — i.e. contains the
 * thought's name or any of its synonyms (docs/03-server-api.md §13).
 *
 * Matchable terms are the compound-title parts (docs/08-ui-spec.md §2.2.3 —
 * for «Проект А,Закрытые ошибки» the parts «Проект А» and «Закрытые ошибки»
 * are searched separately) plus the synonyms, deduplicated case-insensitively.
 * Every term is compiled with {@link synonymPatternToRegex} and matched as a
 * whole: multi-word terms must appear as adjacent words in the given order
 * (any whitespace between), words without `*` match exactly, `*` inside a word
 * matches any run of non-whitespace characters and never crosses a word
 * boundary (docs/02-data-model.md §3.2). So the name «Проект А» finds
 * «Проект А» and «Проект      А», but not «А Проект» or «проект аналогичный»;
 * inflected forms are covered by `*`-synonyms («Прект* А» finds «проекту А»).
 *
 * Implementation: FTS5 phrase queries over literal word prefixes fetch
 * candidates, then {@link synonymPatternToRegex} enforces the exact semantics.
 * FTS5 alone cannot match whole terms: a phrase containing more than one
 * prefix token silently degrades to AND (single words of a name), so the
 * regex is the deciding matcher. Returns one hit per owning thought/link
 * (a thought with several matching comments collapses into a single hit);
 * the target thought's own comments are excluded.
 */
export function findMentions(ndb: NetworkDb, thoughtId: string): MentionHit[] {
  const thought = ndb
    .prepare('SELECT id, title FROM thoughts_v WHERE id = ? LIMIT 1')
    .get(thoughtId) as { id: string; title: string } | undefined;
  if (!thought) {
    throw new EtnError('NOT_FOUND', `thought ${thoughtId} not found`, {
      entity: 'thought',
      id: thoughtId,
    });
  }
  const synRows = ndb
    .prepare('SELECT synonym FROM thought_synonyms_v WHERE thought_id = ?')
    .all(thoughtId) as Array<{ synonym: string }>;

  // Matchable terms: compound-title parts (§2.2.3), then synonyms, without
  // case-insensitive duplicates.
  const terms: string[] = [];
  const addTerm = (raw: string): void => {
    const term = raw.trim();
    if (term === '') return;
    const key = term.toLowerCase();
    if (terms.some((t) => t.toLowerCase() === key)) return;
    terms.push(term);
  };
  for (const part of splitCompoundTitle(thought.title)) addTerm(part);
  for (const s of synRows) addTerm(s.synonym);

  const out: MentionHit[] = [];
  const seen = new Set<string>();

  interface MentionRow {
    comment_id: string;
    owner_id: string;
    title: string;
    active: number;
    body: string;
  }
  // One hit per owning thought/link (03-server-api.md §13 returns «мысли/связи»):
  // several matching comments of the same owner collapse into its first hit.
  // Highlight terms are the substrings actually matched, so the snippet
  // highlights whole phrases, not their single words.
  const push = (r: MentionRow & { owner_type: 'thought' | 'link' }, highlightTerms: string[]): void => {
    const key = `${r.owner_type}:${r.owner_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      owner_type: r.owner_type,
      owner_id: r.owner_id,
      title: r.title,
      comment_id: r.comment_id,
      snippet: makeSnippet(r.body, highlightTerms),
      active: r.active === 1,
    });
  };

  /** Substrings of `body` matched by one term regex (the leading boundary character dropped). */
  const matchSpans = (re: RegExp, body: string): string[] => {
    const reAll = new RegExp(re.source, `${re.flags}g`);
    const spans: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = reAll.exec(body)) !== null) {
      const start = m.index + (m.index > 0 ? 1 : 0);
      const end = m.index + m[0].length;
      if (end > start) spans.push(body.slice(start, end));
      if (m[0].length === 0) reAll.lastIndex += 1; // guard against empty matches
    }
    return spans;
  };

  const apply = (rows: MentionRow[], ownerType: 'thought' | 'link', re: RegExp): void => {
    for (const r of rows) {
      const spans = matchSpans(re, r.body);
      if (spans.length > 0) push({ ...r, owner_type: ownerType }, spans);
    }
  };

  for (const term of terms) {
    const re = synonymPatternToRegex(term);
    const candidate = candidateMatchForTerm(term);
    if (candidate !== null) {
      apply(
        ndb
          .prepare(
            `SELECT c.id AS comment_id, c.owner_id AS owner_id, t.title AS title,
                    t.active AS active, c.body_md AS body
             FROM fts_thought_texts f
             JOIN comments_v c ON c.rowid = f.rowid
             JOIN thoughts_v t ON t.id = c.owner_id
             WHERE fts_thought_texts MATCH ? AND c.owner_id <> ?`,
          )
          .all(candidate, thoughtId) as MentionRow[],
        'thought',
        re,
      );
      apply(
        ndb
          .prepare(
            `SELECT c.id AS comment_id, c.owner_id AS owner_id,
                    COALESCE(lt.name_forward, '') AS title, COALESCE(l.active, 1) AS active,
                    c.body_md AS body
             FROM fts_link_texts f
             JOIN comments_v c ON c.rowid = f.rowid
             LEFT JOIN links_v l ON l.id = c.owner_id
             LEFT JOIN link_types_v lt ON lt.id = l.type_id
             WHERE fts_link_texts MATCH ?`,
          )
          .all(candidate) as MentionRow[],
        'link',
        re,
      );
    } else {
      // No literal prefix to query (e.g. `*ян`) — full scan of both comment
      // owners, the regex does all the work.
      apply(
        ndb
          .prepare(
            `SELECT c.id AS comment_id, c.owner_id AS owner_id, t.title AS title,
                    t.active AS active, c.body_md AS body
             FROM comments_v c
             JOIN thoughts_v t ON t.id = c.owner_id
             WHERE c.owner_type = 'thought' AND c.owner_id <> ?`,
          )
          .all(thoughtId) as MentionRow[],
        'thought',
        re,
      );
      apply(
        ndb
          .prepare(
            `SELECT c.id AS comment_id, c.owner_id AS owner_id,
                    COALESCE(lt.name_forward, '') AS title, COALESCE(l.active, 1) AS active,
                    c.body_md AS body
             FROM comments_v c
             LEFT JOIN links_v l ON l.id = c.owner_id
             LEFT JOIN link_types_v lt ON lt.id = l.type_id
             WHERE c.owner_type = 'link'`,
          )
          .all() as MentionRow[],
        'link',
        re,
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public: findMentionsInTexts (auto-annotation of comment view text, §21)
// ---------------------------------------------------------------------------

/** A candidate thought with its compiled matcher patterns. */
interface MentionCandidate {
  id: string;
  title: string;
  active: boolean;
  /** `priority`: 0 — a compound-title part (§2.2.3), 1 — literal synonym, 2 — wildcard synonym. */
  patterns: Array<{ re: RegExp; priority: number }>;
}

/** Builds matcher candidates for every eligible thought of the network. */
function buildMentionCandidates(
  ndb: NetworkDb,
  opts: { showInactive: boolean; excludeThoughtId?: string },
): MentionCandidate[] {
  const thoughtRows = ndb
    .prepare('SELECT id, title, active FROM thoughts_v WHERE :show_inactive OR active = 1')
    .all({ show_inactive: opts.showInactive ? 1 : 0 }) as Array<{
    id: string;
    title: string;
    active: number;
  }>;
  const thoughts = thoughtRows.filter((t) => t.id !== opts.excludeThoughtId);
  if (thoughts.length === 0) return [];

  const synRows = ndb.prepare('SELECT thought_id, synonym FROM thought_synonyms_v').all() as Array<{
    thought_id: string;
    synonym: string;
  }>;
  const synonymsByThought = new Map<string, string[]>();
  for (const r of synRows) {
    const list = synonymsByThought.get(r.thought_id);
    if (list) list.push(r.synonym);
    else synonymsByThought.set(r.thought_id, [r.synonym]);
  }

  const candidates: MentionCandidate[] = [];
  for (const t of thoughts) {
    const patterns: Array<{ re: RegExp; priority: number }> = [];
    for (const part of splitCompoundTitle(t.title)) {
      patterns.push({ re: synonymPatternToRegex(part), priority: 0 });
    }
    for (const syn of synonymsByThought.get(t.id) ?? []) {
      patterns.push({ re: synonymPatternToRegex(syn), priority: syn.includes('*') ? 2 : 1 });
    }
    if (patterns.length === 0) continue;
    candidates.push({ id: t.id, title: t.title, active: t.active === 1, patterns });
  }
  return candidates;
}

/** A single raw (possibly overlapping) match before span-resolution. */
interface RawSpan {
  start: number;
  end: number;
  candidate: MentionCandidate;
  priority: number;
}

/**
 * Resolves overlapping raw matches into disjoint groups: the longest span
 * wins over any shorter span it overlaps; matches sharing the exact same
 * `(start, end)` (from different thoughts, or different patterns of the same
 * thought) collapse into one group, capped at 5 thoughts, sorted by match
 * priority then title.
 */
function resolveMentionSpans(raw: RawSpan[]): MentionsScanMatch[] {
  const sorted = [...raw].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  interface Group {
    start: number;
    end: number;
    thoughts: Map<string, { id: string; title: string; active: boolean; priority: number }>;
  }
  const groups: Group[] = [];
  for (const span of sorted) {
    const exact = groups.find((g) => g.start === span.start && g.end === span.end);
    if (exact) {
      const existing = exact.thoughts.get(span.candidate.id);
      if (existing === undefined || span.priority < existing.priority) {
        exact.thoughts.set(span.candidate.id, {
          id: span.candidate.id,
          title: span.candidate.title,
          active: span.candidate.active,
          priority: span.priority,
        });
      }
      continue;
    }
    const overlapsExisting = groups.some((g) => span.start < g.end && g.start < span.end);
    if (overlapsExisting) continue;
    groups.push({
      start: span.start,
      end: span.end,
      thoughts: new Map([
        [
          span.candidate.id,
          {
            id: span.candidate.id,
            title: span.candidate.title,
            active: span.candidate.active,
            priority: span.priority,
          },
        ],
      ]),
    });
  }
  groups.sort((a, b) => a.start - b.start);
  return groups.map((g) => ({
    start: g.start,
    end: g.end,
    thoughts: [...g.thoughts.values()]
      .sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title))
      .slice(0, 5)
      .map((t) => ({ id: t.id, title: t.title, active: t.active })),
  }));
}

/**
 * Finds thought mentions inside each of `texts` (docs/03-server-api.md §21) —
 * the reverse direction of {@link findMentions}: instead of one thought
 * scanned against the whole comment corpus, every eligible thought of the
 * network is scanned against one caller-supplied text (typically a single
 * block-level element of a comment being viewed). Matchable terms per thought
 * are its compound-title parts (docs/08-ui-spec.md §2.2.3 — a title without
 * commas is a single part) and its synonyms (wildcard `*` per
 * docs/02-data-model.md §3.2); both go through the same
 * {@link synonymPatternToRegex}, since it already implements the exact
 * word-boundary/adjacency semantics for literal terms too.
 */
export function findMentionsInTexts(
  ndb: NetworkDb,
  texts: string[],
  opts: { showInactive: boolean; excludeThoughtId?: string },
): MentionsScanMatch[][] {
  const candidates = buildMentionCandidates(ndb, opts);
  if (candidates.length === 0) return texts.map(() => []);
  return texts.map((text) => {
    const raw: RawSpan[] = [];
    for (const candidate of candidates) {
      for (const pattern of candidate.patterns) {
        const re = new RegExp(pattern.re.source, `${pattern.re.flags}g`);
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) {
            re.lastIndex += 1;
            continue;
          }
          // The leading boundary group may have consumed one character (any
          // non-letter/digit/underscore) — only possible when the match
          // doesn't start at position 0, since `^` without the `m` flag only
          // matches the absolute string start; the trailing lookahead is
          // zero-width and never consumed, so `m[0].length` already excludes
          // it.
          const start = m.index + (m.index > 0 ? 1 : 0);
          const end = m.index + m[0].length;
          if (end > start) raw.push({ start, end, candidate, priority: pattern.priority });
        }
      }
    }
    return resolveMentionSpans(raw);
  });
}
