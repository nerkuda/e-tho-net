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
 * `find_duplicates` tool; {@link findMentions} powers the editor mentions panel.
 */

import {
  EtnError,
  SEARCH_SCOPES,
  TRAVERSAL_DEFAULTS,
  type IconKind,
  type MentionHit,
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
 * Build a safe FTS5 MATCH expression from user input. Each token is wrapped in a
 * phrase literal (double quotes stripped first, so it cannot break out) with the
 * FTS5 prefix suffix `*`; tokens join via implicit AND (or explicit OR). Returns
 * an empty string when no usable tokens remain — callers treat that as "no match".
 */
function sanitizeFtsQuery(text: string, operator: 'AND' | 'OR' = 'AND'): string {
  const tokens = tokenize(text);
  if (tokens.length === 0) return '';
  const joiner = operator === 'OR' ? ' OR ' : ' ';
  return tokens.map((t) => `"${t}"*`).join(joiner);
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

/** Escape regex meta-characters so a term can be used inside a RegExp literal. */
function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/**
 * Build a short snippet with highlights: a window around the first match of any
 * term, ellipsised when truncated, with every term wrapped in `<mark>`.
 */
function makeSnippet(rawText: string, terms: string[]): string {
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
  let fragment = rawText.slice(start, end);
  if (start > 0) fragment = `…${fragment}`;
  if (end < rawText.length) fragment = `${fragment}…`;
  return highlight(fragment, terms);
}

// ---------------------------------------------------------------------------
// Subtree filter (recursive CTE, cycle-safe — docs/11-settings-and-state.md §5)
// ---------------------------------------------------------------------------

/** Options for {@link collectSubtreeIds}. */
interface SubtreeOptions {
  /** Max edge-hops from the seed (default {@link TRAVERSAL_DEFAULTS.MAX_DEPTH}). */
  maxDepth?: number;
  /** Include inactive links in the traversal. */
  showInactive?: boolean;
}

/**
 * Collect every thought id reachable from `seedId` via active links, using a
 * recursive CTE with a `path` cycle guard (docs/11-settings-and-state.md §5.2).
 * The seed itself is always included. Returns `null` when no seed is given
 * (meaning "no subtree restriction").
 */
function collectSubtreeIds(
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
        descend(id, depth, path) AS (
          SELECT :seed, 0, ',' || :seed || ','
          UNION ALL
          SELECT CASE WHEN l.target_id = d.id THEN l.source_id ELSE l.target_id END,
                 d.depth + 1,
                 d.path ||
                   CASE WHEN l.target_id = d.id THEN l.source_id ELSE l.target_id END || ','
          FROM descend d
          JOIN links l ON (l.source_id = d.id OR l.target_id = d.id)
                       AND (l.active = 1 OR :show_inactive)
          WHERE d.depth < :max_depth
            AND instr(d.path,
                      ',' || CASE WHEN l.target_id = d.id THEN l.source_id ELSE l.target_id END || ',') = 0
        )
       SELECT DISTINCT id FROM descend`,
    )
    .all({ seed: seedId, max_depth: maxDepth, show_inactive: showInactive }) as Array<{
    id: string;
  }>;
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Shared filter helpers
// ---------------------------------------------------------------------------

/** Resolved filters shared by all four search groups. */
interface SearchFilters {
  showInactive: boolean;
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
    inListClause('t.type_id', f.typeIds),
    subtreeClause('f.thought_id', f.subtreeIds),
  ]);
  const total = (
    ndb
      .prepare(
        `SELECT COUNT(*) AS c FROM fts_thought_names f
         JOIN thoughts t ON t.id = f.thought_id WHERE ${where}`,
      )
      .get(...params) as { c: number }
  ).c;
  const rows = ndb
    .prepare(
      `SELECT f.thought_id AS thought_id, t.title AS title, t.icon AS icon, t.icon_kind AS icon_kind
       FROM fts_thought_names f
       JOIN thoughts t ON t.id = f.thought_id
       WHERE ${where}
       ORDER BY rank
       LIMIT ? OFFSET ?`,
    )
    .all(...params, f.limit, f.offset) as Array<{
    thought_id: string;
    title: string;
    icon: string | null;
    icon_kind: string;
  }>;
  return {
    hits: rows.map((r) => {
      const snippet = makeSnippet(r.title, f.terms);
      return {
        thought_id: r.thought_id,
        title: r.title,
        icon: r.icon,
        icon_kind: r.icon_kind as IconKind,
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
    inListClause('t.type_id', f.typeIds),
    subtreeClause('f.thought_id', f.subtreeIds),
  ]);
  const total = (
    ndb
      .prepare(
        `SELECT COUNT(*) AS c FROM fts_thought_texts f
         JOIN comments c ON c.rowid = f.rowid
         JOIN thoughts t ON t.id = f.thought_id WHERE ${where}`,
      )
      .get(...params) as { c: number }
  ).c;
  const rows = ndb
    .prepare(
      `SELECT c.id AS comment_id, f.thought_id AS thought_id, t.title AS title,
              c.body_md AS body, t.icon AS icon, t.icon_kind AS icon_kind
       FROM fts_thought_texts f
       JOIN comments c ON c.rowid = f.rowid
       JOIN thoughts t ON t.id = f.thought_id
       WHERE ${where}
       ORDER BY rank
       LIMIT ? OFFSET ?`,
    )
    .all(...params, f.limit, f.offset) as Array<{
    comment_id: string;
    thought_id: string;
    title: string;
    body: string;
    icon: string | null;
    icon_kind: string;
  }>;
  return {
    hits: rows.map((r) => {
      const snippet = makeSnippet(r.body, f.terms);
      return {
        thought_id: r.thought_id,
        title: r.title,
        icon: r.icon,
        icon_kind: r.icon_kind as IconKind,
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
    inListClause('l.type_id', f.linkTypeIds),
  ]);
  const total = (
    ndb
      .prepare(
        `SELECT COUNT(*) AS c FROM fts_link_texts f
         JOIN comments c ON c.rowid = f.rowid
         LEFT JOIN links l ON l.id = f.link_id WHERE ${where}`,
      )
      .get(...params) as { c: number }
  ).c;
  const rows = ndb
    .prepare(
      `SELECT f.link_id AS link_id, lt.name_forward AS type_name, c.body_md AS body
       FROM fts_link_texts f
       JOIN comments c ON c.rowid = f.rowid
       LEFT JOIN links l ON l.id = f.link_id
       LEFT JOIN link_types lt ON lt.id = l.type_id
       WHERE ${where}
       ORDER BY rank
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
    clauses.push(inListClause('t.type_id', f.typeIds));
    clauses.push(subtreeClause('f.thought_id', f.subtreeIds));
    joins = 'JOIN thoughts t ON t.id = c.owner_id';
  } else {
    clauses.push({ sql: '(l.active = 1 OR ?)', params: [f.showInactive ? 1 : 0] });
    clauses.push(inListClause('l.type_id', f.linkTypeIds));
    joins = 'LEFT JOIN links l ON l.id = c.owner_id';
  }
  const { where, params } = joinClauses(clauses);
  const sql = `SELECT c.id AS comment_id, '${side}' AS owner, c.owner_id AS owner_id,
                 c.valid_from AS valid_from, c.valid_to AS valid_to, c.body_md AS body
               FROM ${ftsTable} f
               JOIN comments c ON c.rowid = f.rowid
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
    .prepare(`${thought.sql}\nUNION ALL\n${link.sql}\nORDER BY valid_from`)
    .all(...thought.params, ...link.params) as ChronoRow[];

  const total = rows.length;
  const paged = rows.slice(f.offset, f.offset + f.limit);
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

  const filters: SearchFilters = {
    showInactive: request.show_inactive ?? showInactiveDefault,
    typeIds: request.type_id ?? null,
    linkTypeIds: request.link_type_id ?? null,
    subtreeIds: request.in === 'subtree' ? collectSubtreeIds(ndb, request.from_thought_id) : null,
    limit: paging.limit,
    offset: paging.offset,
    terms: tokenize(request.q),
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
 * `synonym_norm`, then partial (`title_norm LIKE %term%`) for the title and each
 * synonym. Results are ordered by match strength.
 *
 * @param title - proposed thought title.
 * @param synonyms - optional proposed synonyms.
 */
export function findDuplicates(
  ndb: NetworkDb,
  title: string,
  synonyms: string[] = [],
): DuplicateHit[] {
  const titleTerms = [title.trim(), ...synonyms.map((s) => s.trim())].filter((t) => t !== '');
  if (titleTerms.length === 0) return [];

  const byId = new Map<string, DuplicateHit>();

  const ensure = (row: { id: string; title: string }): DuplicateHit => {
    let hit = byId.get(row.id);
    if (!hit) {
      const synRows = ndb
        .prepare('SELECT synonym FROM thought_synonyms WHERE thought_id = ? ORDER BY synonym')
        .all(row.id) as Array<{ synonym: string }>;
      hit = {
        id: row.id,
        title: row.title,
        synonyms: synRows.map((s) => s.synonym),
        matched_on: 'partial',
      };
      byId.set(row.id, hit);
    }
    return hit;
  };

  for (const term of titleTerms) {
    const n = norm(term);
    // Exact title_norm match (strongest).
    const titleRows = ndb
      .prepare('SELECT id, title FROM thoughts WHERE title_norm = ?')
      .all(n) as Array<{ id: string; title: string }>;
    for (const r of titleRows) {
      ensure(r).matched_on = 'title';
    }
    // Exact synonym_norm match.
    const synRows = ndb
      .prepare(
        `SELECT ts.thought_id AS id, t.title AS title, ts.synonym AS synonym
         FROM thought_synonyms ts JOIN thoughts t ON t.id = ts.thought_id
         WHERE ts.synonym_norm = ?`,
      )
      .all(n) as Array<{ id: string; title: string; synonym: string }>;
    for (const r of synRows) {
      const hit = ensure(r);
      if (hit.matched_on !== 'title') {
        hit.matched_on = 'synonym';
        hit.matched_synonym = r.synonym;
      }
    }
    // Partial (LIKE) — lowest priority; ensure() defaults to 'partial'.
    const partialRows = ndb
      .prepare('SELECT id, title FROM thoughts WHERE title_norm LIKE ?')
      .all(`%${n}%`) as Array<{ id: string; title: string }>;
    for (const r of partialRows) {
      ensure(r);
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
 * thought's title or any of its synonyms (docs/03-server-api.md §13).
 *
 * Implementation: MATCH the comment-text indexes against the title + synonyms
 * joined with OR. Returns hits across both thought- and link-owned comments;
 * the target thought's own comments are excluded.
 */
export function findMentions(ndb: NetworkDb, thoughtId: string): MentionHit[] {
  const thought = ndb
    .prepare('SELECT id, title FROM thoughts WHERE id = ? LIMIT 1')
    .get(thoughtId) as { id: string; title: string } | undefined;
  if (!thought) {
    throw new EtnError('NOT_FOUND', `thought ${thoughtId} not found`, {
      entity: 'thought',
      id: thoughtId,
    });
  }
  const syns = (
    ndb
      .prepare('SELECT synonym FROM thought_synonyms WHERE thought_id = ?')
      .all(thoughtId) as Array<{ synonym: string }>
  ).map((r) => r.synonym);
  const match = sanitizeFtsQuery([thought.title, ...syns].join(' '), 'OR');
  if (match === '') return [];

  const terms = tokenize([thought.title, ...syns].join(' '));
  const out: MentionHit[] = [];

  // Thought-owned comments: return the owning thought's title; exclude the
  // target thought (a thought does not "mention" itself in its own comments).
  const thoughtRows = ndb
    .prepare(
      `SELECT c.id AS comment_id, c.owner_id AS owner_id, t.title AS title, c.body_md AS body
       FROM fts_thought_texts f
       JOIN comments c ON c.rowid = f.rowid
       JOIN thoughts t ON t.id = c.owner_id
       WHERE fts_thought_texts MATCH ? AND c.owner_id <> ?`,
    )
    .all(match, thoughtId) as Array<{
    comment_id: string;
    owner_id: string;
    title: string;
    body: string;
  }>;
  for (const r of thoughtRows) {
    out.push({
      owner_type: 'thought',
      owner_id: r.owner_id,
      title: r.title,
      comment_id: r.comment_id,
      snippet: makeSnippet(r.body, terms),
    });
  }

  // Link-owned comments: title is the link type's forward name (or empty).
  const linkRows = ndb
    .prepare(
      `SELECT c.id AS comment_id, c.owner_id AS owner_id,
              COALESCE(lt.name_forward, '') AS title, c.body_md AS body
       FROM fts_link_texts f
       JOIN comments c ON c.rowid = f.rowid
       LEFT JOIN links l ON l.id = c.owner_id
       LEFT JOIN link_types lt ON lt.id = l.type_id
       WHERE fts_link_texts MATCH ?`,
    )
    .all(match) as Array<{
    comment_id: string;
    owner_id: string;
    title: string;
    body: string;
  }>;
  for (const r of linkRows) {
    out.push({
      owner_type: 'link',
      owner_id: r.owner_id,
      title: r.title,
      comment_id: r.comment_id,
      snippet: makeSnippet(r.body, terms),
    });
  }

  return out;
}
