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
 * All three FTS5 tables are `tokenize = 'trigram case_sensitive 0'` (bug
 * 0258fd9d «Не ищет мысль по части слова не с начала», migration
 * `038_search_trigram.sql`): unlike the previous `unicode61` tokenizer, this
 * matches an include word as a literal substring anywhere in the text (not
 * only a token prefix), and case-folds Cyrillic correctly without any custom
 * JS code. {@link buildTrigramQuery} builds the boolean `MATCH` expression
 * (`"счет" NOT "вод"`) from the keywords mini-syntax (§6.10). The tokenizer's
 * one limitation: a fragment shorter than 3 characters produces zero
 * trigrams, so `MATCH` silently returns nothing for it — {@link searchNames}
 * (the only group with a normalized column to fall back to, `title_norm`/
 * `synonym_norm`) covers such words via `LIKE`; `by_texts`/`by_links`/
 * `by_chrono` do not filter on them at all (Tier 1 — see the bug's
 * chronological comments for the Tier 2 scope, adding `comments.body_norm`).
 *
 * Filters: `in_subtree_of` (recursive CTE), `scope`, `type_id[]`,
 * `link_type_id[]`, `show_inactive`. Results are bounded per group by
 * `limit`/`offset` (default 50 / 0).
 *
 * Change layers (task S6, docs/13-layers.md §9): every group joins the FTS
 * row with the resolution view by the winner row's `rowid`
 * (`thoughts_v.rowid = fts_thought_names.rowid`,
 * `comments_v.rowid = fts_thought_texts.rowid`, …) — the FTS tables carry one
 * row per PHYSICAL row of every layer, and the rowid join keeps only the
 * text of the row that wins in the connection's layer chain. FTS5 ranks
 * first; layer visibility filtering and per-logical-id deduplication run in
 * the join/CTE on top of the ranked scan (a `LIMIT` is never pushed into the
 * FTS query), so `meta.total_in_group` counts AFTER the deduplication — exact
 * on MVP volumes, possibly more expensive than a plain COUNT.
 * Tombstones are excluded by construction: a tombstoned row has no view row
 * to join, so the base text does not surface even when it matches.
 *
 * {@link findDuplicates} powers the add-thought dialog and the MCP
 * `find_duplicates` tool; {@link findMentions} powers the editor mentions
 * panel; {@link findMentionsInTexts} powers the comment view-mode
 * auto-annotation of thought mentions (§21, L24) — the reverse direction:
 * many thoughts scanned against one caller-supplied text.
 *
 * `findDuplicates` uses the same `fts_thought_names` index as a CANDIDATE
 * NARROWER for its partial tier (задача e4f26158, ошибка 49e05ea0): include
 * words of ≥3 characters are a boolean `MATCH` conjunct instead of a full
 * `LIKE '%…%'` scan. Words the trigram tokenizer cannot index (<3 characters)
 * and `*`-exclusions (whose order semantics a boolean `NOT` cannot reproduce)
 * stay on the LIKE fallback; with no long include word at all the pass remains
 * LIKE. The exact mini-language semantics — fragments inside CONSECUTIVE words
 * in the typed order, §6.10 — are still enforced by the JS post-filter
 * (`synonymPatternToRegex`), so the narrower only has to be a superset.
 */

import {
  buildLikePattern,
  EtnError,
  FILTER_AST_VERSION,
  foldCase,
  mentionPrefilterMarkers,
  mentionPrefilterPass,
  parseFilterKeywords,
  regexEscape,
  SEARCH_SCOPES,
  splitCompoundTitle,
  splitMentionWords,
  synonymPatternSource,
  synonymPatternToRegex,
  TRAVERSAL_DEFAULTS,
  type DuplicateHit,
  type DuplicateMatchKind,
  type DuplicateSearchMode,
  type FilterAst,
  type FilterAstNode,
  type IconKind,
  type MentionHit,
  type MentionPrefilterMarkers,
  type MentionsScanMatch,
  type SearchChronoHit,
  type SearchLinkHit,
  type SearchNameHit,
  type SearchRequest,
  type SearchResponse,
  type SearchResponseMeta,
  type SearchScope,
  type SearchTextHit,
  type StructureKeywordScope,
} from '@etn/shared';

// Формы дублей переехали в общий модуль (задача 120385ba): одна форма ответа
// `GET /thoughts/duplicates` на сервер и клиент. Реэкспорт — для существующих
// импортов из домена.
export type { DuplicateHit, DuplicateMatchKind, DuplicateSearchMode };

import type { NetworkDb } from '../db/network-db.js';
import {
  FONT_BOLD_BIT,
  FONT_ITALIC_BIT,
  FONT_STRIKE_BIT,
  FONT_UNDERLINE_BIT,
  readFont,
} from './font-style.js';
import { resolveThoughtTypeIdByName } from './thought-type-service.js';
import { expandTypeIdsToSubtree } from './type-hierarchy.js';
import { assertFilterAstInProfile } from './filter-profile-validation.js';
import { diagnoseFilterAst, filterDiagnosticsError } from './filter-diagnostics.js';
import { buildKeywordWordClause, filterAstClause, type AstTokenContext } from './query-service.js';
import {
  resolveThoughtTokensInAst,
  scanStringForTokens,
  type TokenIssue,
} from './thought-type-view-tokens.js';
import { getThought } from './thought-service.js';
import { buildThoughtResolveContext } from './thought-type-views-service.js';

// Re-export so route/MCP callers have a single import surface for read helpers
// (docs/03-server-api.md §6.9 resolve is conceptually part of search/lookup).
export { resolveThoughts } from './thought-service.js';

// ---------------------------------------------------------------------------
// FTS query sanitisation & highlighting
// ---------------------------------------------------------------------------

/**
 * Split raw input into clean search terms: trimmed, quote-free tokens of
 * length ≥ 1. Used to drive client-side-style snippet highlighting (the FTS
 * MATCH expression is built by {@link buildTrigramQuery} instead).
 */
function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length >= 1);
}

/**
 * Minimum literal-fragment length the `trigram` FTS5 tokenizer can index
 * (migration `038_search_trigram.sql`): a phrase shorter than 3 characters
 * produces zero trigrams, so `MATCH` always returns zero rows for it rather
 * than erroring — {@link trigramPhrase} treats such words as "unusable"
 * instead of emitting a query that would silently match nothing.
 */
const TRIGRAM_MIN_LEN = 3;

/**
 * Quote one literal fragment for an FTS5 `MATCH` expression. A double quote is
 * the phrase delimiter, so a quote inside the fragment is doubled — the escape
 * FTS5 expects inside a string literal.
 */
function quoteFtsPhrase(fragment: string): string {
  return `"${fragment.replace(/"/g, '""')}"`;
}

/**
 * One fragment's trigram phrase covering BOTH canonical Unicode forms, or
 * `null` when the fragment cannot be narrowed safely.
 *
 * The `trigram` tokenizer works over code points and does NOT normalise
 * Unicode (`case_sensitive 0` only folds case), while the LIKE columns this
 * phrase narrows — `title_norm`/`synonym_norm` — are NFC. Raw names may be
 * stored in NFD (e.g. written by macOS), so a single NFC phrase produced a
 * false negative and made the FTS narrower than the old LIKE scan
 * (review of e4f26158, pitfall 6898ef75). When the NFC and NFD spellings of a
 * fragment differ, the phrase becomes `("nfc" OR "nfd")`: one `MATCH` now
 * covers both stored forms, and for an exclusion `NOT (…)` the group means
 * "absent in both forms" — exactly the old `NOT (… LIKE …)` over the NFC
 * column for wholly-NFC/wholly-NFD rows. Mixed-per-character raw text remains
 * a documented limitation; the phrase is still a candidate narrower, and the
 * JS post-filter keeps the exact semantics.
 *
 * Returns `null` when the spellings differ and EITHER one is shorter than
 * {@link TRIGRAM_MIN_LEN}: that branch cannot produce trigrams, so the `OR`
 * would lose candidates instead of being a superset. The caller then drops
 * the fragment and keeps the LIKE fallback for the whole word.
 */
function dualFormTrigramPhrase(fragment: string): string | null {
  const nfc = fragment.normalize('NFC');
  const nfd = fragment.normalize('NFD');
  if (nfc === nfd) {
    return nfc.length >= TRIGRAM_MIN_LEN ? quoteFtsPhrase(nfc) : null;
  }
  if (nfc.length < TRIGRAM_MIN_LEN || nfd.length < TRIGRAM_MIN_LEN) return null;
  return `(${quoteFtsPhrase(nfc)} OR ${quoteFtsPhrase(nfd)})`;
}

/**
 * Build one word's trigram phrase for the boolean MATCH expression, or
 * `null` when every literal fragment (split on `*`) is shorter than
 * {@link TRIGRAM_MIN_LEN}. A `*` splits the word into independent literal
 * fragments joined by `AND` (each must occur somewhere in the text, in no
 * particular relative order) — the ordering guarantee of a plain LIKE
 * `%…%…%` pattern is not preserved, but `*` inside a single word is a rare
 * edge case of the keywords mini-syntax (03-server-api.md §6.10), not the
 * bug's primary scenario (whole-word infix search, 0258fd9d). Fragments
 * shorter than {@link TRIGRAM_MIN_LEN} — and fragments with no safely
 * indexable canonical form ({@link dualFormTrigramPhrase}) — are dropped
 * rather than failing the whole word, so `сло*во` still filters on `сло` even
 * if `во`-equivalent fragments were too short.
 */
function trigramPhrase(word: string): string | null {
  const fragments = word
    .split('*')
    .map((f) => f.toLowerCase())
    .filter((f) => f.length >= TRIGRAM_MIN_LEN);
  if (fragments.length === 0) return null;
  const parts: string[] = [];
  for (const fragment of fragments) {
    const phrase = dualFormTrigramPhrase(fragment);
    if (phrase !== null) parts.push(phrase);
  }
  return parts.length === 0 ? null : parts.join(' AND ');
}

/**
 * Boolean `MATCH` expression over `fts_thought_names` for the §6.10 include
 * words, or `null` when no word yields a usable trigram (every word shorter
 * than {@link TRIGRAM_MIN_LEN} after splitting on `*`).
 *
 * Используется `query-service` как индексный сужатель отбора по `keywords`
 * (требование 314cbb8d, ADR 5f6cb775): FTS-условие — обязательный конъюнкт,
 * поэтому оно строится только из слов, которые индекс способен отразить;
 * точную семантику мини-языка по-прежнему гарантирует LIKE-клауза, которая
 * применяется ко всем словам. Слова без индексного представления (короткие)
 * сужатель просто не учитывает.
 */
export function nameTrigramMatch(include: string[]): string | null {
  const positives: string[] = [];
  for (const word of include) {
    const phrase = trigramPhrase(word);
    if (phrase !== null) positives.push(phrase);
  }
  return positives.length === 0 ? null : positives.join(' AND ');
}

/** Parsed `q` ready for the four FTS groups + the `by_names` LIKE fallback. */
interface TrigramQuery {
  /**
   * Boolean MATCH expression for `<table> MATCH ?`, or `''` when no include
   * word produced a usable trigram phrase — callers must skip the `MATCH`
   * clause entirely in that case (an empty string is not a valid FTS5 query
   * and `by_texts`/`by_links`/`by_chrono` have no other way to filter, so
   * they return no hits; `by_names` still has {@link TrigramQuery.nameShortInclude}).
   */
  match: string;
  /**
   * Include words with no usable (≥3-char) trigram fragment. Only `by_names`
   * has a fallback for these (`title_norm`/`synonym_norm` are already
   * NFC+lowercase — see {@link buildShortWordNameClause}); Tier 1 of bug
   * 0258fd9d leaves `by_texts`/`by_links`/`by_chrono` unfiltered by them
   * (`comments.body_md` has no equivalent normalized column).
   */
  nameShortInclude: string[];
  /**
   * Exclude words that must be applied via the `by_names` LIKE fallback
   * instead of `NOT "phrase"`: either the word itself is too short, or (when
   * `match === ''`) there is no trigram anchor at all to attach a `NOT` to
   * (FTS5 has no unary NOT) — in that case EVERY exclude word ends up here,
   * regardless of its own length.
   */
  nameShortExclude: string[];
  /** ALL NFC-normalised include words — the exact per-word `by_names` predicate. */
  nameInclude: string[];
  /** ALL NFC-normalised exclude words — the exact per-word `by_names` predicate. */
  nameExclude: string[];
}

/**
 * Build the `trigram`-tokenizer boolean MATCH expression from user input
 * using the keywords mini-syntax (03-server-api.md §6.10): every include
 * word is a required literal substring (in any position, not just a token
 * prefix — bug 0258fd9d), `-word` exclusions join as `NOT`. A combined
 * expression like `"счет" NOT "вод"` is a SINGLE `MATCH` call — FTS5 forbids
 * `MATCH` twice on the same virtual table in one query, but a boolean
 * expression with `AND`/`NOT` inside one `MATCH` is not "twice". Returns
 * `match: ''` when no include word clears the trigram floor — callers treat
 * that as "no FTS match possible" (a query of pure exclusions, or of only
 * short words with no anchor, also degenerates to this per FTS5's lack of
 * unary NOT).
 */
function buildTrigramQuery(text: string): TrigramQuery {
  // NFC-нормализация ДО выбора «короткое/длинное» и до LIKE-фолбэка: длина
  // фрагмента и колонки `title_norm`/`synonym_norm` считаются по composed-форме.
  // Без этого NFD-ввод короткого слова («йо» = 3 code points) уходил в LIKE-
  // фолбэк, но паттерн строился из NFD и не находил NFC-колонку (блокер
  // проверки e4f26158). Длинные слова не страдают: dual-form-фраза
  // ({@link dualFormTrigramPhrase}) всё равно покрывает обе канонические формы.
  const parsed = parseFilterKeywords(text);
  const include = parsed.include.map((word) => word.normalize('NFC'));
  const exclude = parsed.exclude.map((word) => word.normalize('NFC'));
  if (include.length === 0) {
    // No include words at all (empty query, or pure exclusions like `-dog`)
    // — nothing to anchor a match or even a LIKE fallback to.
    return { match: '', nameShortInclude: [], nameShortExclude: [], nameInclude: [], nameExclude: [] };
  }

  const positives: string[] = [];
  const nameShortInclude: string[] = [];
  for (const word of include) {
    const phrase = trigramPhrase(word);
    if (phrase === null) nameShortInclude.push(word);
    else positives.push(phrase);
  }

  if (positives.length === 0) {
    // Every include word is too short for the trigram index: `by_names`
    // falls back to a pure LIKE pass (no FTS anchor at all), so every
    // exclude word — long or short — must go through the same LIKE-based
    // NOT for names; the other three groups stay unfiltered (Tier 1).
    return {
      match: '',
      nameShortInclude,
      nameShortExclude: exclude,
      nameInclude: include,
      nameExclude: exclude,
    };
  }

  let match = positives.join(' AND ');
  const nameShortExclude: string[] = [];
  for (const word of exclude) {
    const phrase = trigramPhrase(word);
    if (phrase === null) nameShortExclude.push(word);
    else match += ` NOT ${phrase}`;
  }
  return { match, nameShortInclude, nameShortExclude, nameInclude: include, nameExclude: exclude };
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
    const literal = (star === -1 ? word : word.slice(0, star)).toLowerCase();
    // `fts_thought_texts`/`fts_link_texts` are `trigram`-tokenized (migration
    // 038_search_trigram.sql, bug 0258fd9d): a phrase shorter than 3
    // characters produces zero trigrams, so `MATCH` would always return zero
    // rows instead of the broad candidate set this function is meant to
    // provide — that would silently hide real mentions behind a query that
    // structurally cannot match. Falling through to `null` here routes the
    // caller to the existing full-scan branch (same one already used for
    // `*ян`-style patterns with no literal prefix at all), so correctness is
    // preserved at the cost of skipping the FTS prefilter for short terms.
    if (literal.length < TRIGRAM_MIN_LEN) return null;
    const escaped = literal.replace(/"/g, '""');
    parts.push(star === -1 ? `"${escaped}"` : `"${escaped}"*`);
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
  /**
   * Актуальность/корзина КОРПУСНЫХ сущностей (связи и link-половина хроники):
   * `show_inactive`/`trashed` остаются параметрами полнотекстового поиска и
   * фильтруют хиты-связи и хроно-хиты (требование b91336e7, ADR 7581ac14).
   * Мыслевые настройки (актуальность/корзина/тип/подкорень) сюда НЕ входят —
   * они исполняются единым AST-движком ({@link thoughtClause}).
   */
  showInactive: boolean;
  /** S13: when false (default) marked-for-deletion rows are hidden. */
  trashed: boolean;
  /** Фильтр по типу связи (поддерево) — корпусный, фильтрует хиты-связи. */
  linkTypeIds: string[] | null;
  /**
   * Конъюнктивная WHERE-клауза МЫСЛЕВЫХ условий отбора (профиль `thoughts`),
   * скомпилированная единым AST-движком ({@link filterAstClause}). Добавляется
   * к WHERE мыслевых FTS-групп (`by_names`, `by_texts`, thought-половина
   * `by_chrono`); корпусные группы её не получают. `null` — мыслевых
   * настроек нет.
   */
  thoughtClause: Clause | null;
  limit: number;
  offset: number;
  /** Highlight terms derived from the query (for JS snippet highlighting). */
  terms: string[];
  /**
   * Автор — id пользователя, создавшего мысль/комментарий (задача 59119797
   * «Фильтры Автор/Редактор»). `null` — фильтр не применяется. Применяется
   * к by_names, by_texts и by_chrono (для thoughts); для by_links пропускается
   * (автор относится к мысли, не к связи).
   */
  authorId: string | null;
  /** Последний редактор — id пользователя (`updated_by`); `null` — не применять. */
  editorId: string | null;
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

/**
 * LIKE-fallback clause for one `by_names` short/anchor-less word (Tier 1,
 * bug 0258fd9d): `title_norm`/`synonym_norm` are already NFC+lowercase, so the
 * typed word MUST be lower-cased before it becomes a pattern (bug
 * 6bba224b-9899-4f7e-a37c-ff2067ac0a6c — a `%Н%` pattern can never match the
 * normalized column, so a short query typed with a capital letter returned
 * nothing; the same `toLowerCase()` every other `buildLikePattern` caller in
 * the domain uses). After folding, this is correct for Cyrillic without any
 * custom case-folding — the exact pattern already proven in
 * {@link findDuplicates} (same escaping, same `ESCAPE '\'` — copied
 * deliberately rather than re-derived, see the bug's chronological comment on
 * why re-deriving it went wrong last time).
 *
 * Words arrive from {@link buildTrigramQuery}, which normalises them to NFC
 * BEFORE the short/long decision: a decomposed («NFD») two-character word is
 * three code points, so without that step it would land here still
 * decomposed and its `%…%` pattern would never match the NFC column
 * (review of e4f26158). Keep the normalisation at that single entry point —
 * here the word is already composed.
 */
function buildShortWordNameClause(word: string, negate: boolean): Clause {
  const pattern = buildLikePattern(word.toLowerCase());
  const sql =
    "(t.title_norm LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM thought_synonyms_v ts" +
    " WHERE ts.thought_id = t.id AND ts.synonym_norm LIKE ? ESCAPE '\\'))";
  return { sql: negate ? `NOT ${sql}` : sql, params: [pattern, pattern] };
}

/** Области per-word предиката `by_names`: заголовок и синонимы (D5). */
const NAME_KEYWORD_SCOPE = new Set<StructureKeywordScope>(['title', 'synonyms']);

/**
 * Точный предикат ОДНОГО include- или исключающего слова по группе `by_names`
 * (задача f0b06700, требование 35218826, сценарий «поиск», D1/D3/D5):
 * литеральная подстрока в заголовке ИЛИ в синониме, а для слова БЕЗ `*` — ещё
 * и совпадение со СЛОВОМ `*`-синонима по границам слова
 * (`synonym_word_pattern_match`, D4: слово запроса с `*` — только литерально).
 *
 * Заголовок расширению не подлежит (D5) — матчер применяется только к синонимам.
 * Предикат — ОБЩИЙ с `keywords` отбора мыслей (`buildKeywordWordClause`,
 * правило аналогов): своего SQL здесь нет, чтобы маршруты не разъехались.
 */
function buildNameWordClause(word: string, negate: boolean): Clause {
  const clause = buildKeywordWordClause(NAME_KEYWORD_SCOPE, word);
  return { sql: negate ? `NOT ${clause.sql}` : clause.sql, params: clause.params };
}

/**
 * Только pattern-ветка исключения для FTS-тира: литеральную часть уже учёл
 * `fts_thought_names MATCH` (в т.ч. короткие слова — своей LIKE-клаузой), а
 * слово-паттерн синонима туда не попадает. `null` — слово запроса содержит `*`
 * (D4) или совпадение невозможно.
 */
function buildNamePatternExcludeClause(word: string): Clause | null {
  const norm = word.normalize('NFC').toLowerCase();
  if (norm.includes('*')) return null;
  return {
    sql:
      'NOT EXISTS (SELECT 1 FROM thought_synonyms_v ts' +
      ' WHERE ts.thought_id = t.id AND synonym_word_pattern_match(?, ts.synonym_norm))',
    params: [norm],
  };
}

/** Колонки хита `by_names` (визуальный стиль и `active` — из строки-победителя). */
const NAME_HIT_COLUMNS = `t.id AS thought_id, t.title AS title, t.icon AS icon,
              t.icon_kind AS icon_kind, t.icon_attachment_id AS icon_attachment_id,
              t.icon_color AS icon_color,
              t.fg_color AS fg_color, t.bg_color AS bg_color,
              t.font_bold AS font_bold, t.font_italic AS font_italic,
              t.font_underline AS font_underline, t.font_strike AS font_strike,
              t.font_manual AS font_manual,
              t.type_id AS type_id, t.active AS active`;

/**
 * Query the thought-names group. `trigram.match === ''` means no include
 * word cleared the trigram floor — the FTS5 join/MATCH is skipped entirely
 * (querying `MATCH ''` is invalid) and the result rests solely on the
 * per-word LIKE fallbacks; the caller only reaches this state when
 * {@link TrigramQuery.nameShortInclude} is non-empty (otherwise `search()`
 * already returned the empty response for the whole request).
 *
 * **`*`-синонимы (задача f0b06700, требование 35218826, сценарий «поиск»).**
 * FTS-кандидаты остаются первым тиром с прежним поведением и прежним
 * ранжированием (`rank`, затем `title_norm`/`id` как детерминированный добор).
 * Второй тир — мысли, которых FTS не видит, но чьё слово запроса совпало со
 * СЛОВОМ `*`-синонима: он идёт ПОСЛЕ FTS-ранжированных хитов (D11) и
 * проверяется точным предикатом каждого слова (D1/D3). Мысль попадает ровно в
 * один тир (`NOT IN` кандидатов), поэтому `LIMIT`/`OFFSET`/`COUNT` считаются
 * по объединению и пагинация не теряет и не дублирует строки (D7). Сеть без
 * `*`-синонимов второй тир не даёт — прежнее поведение (D2).
 */
function searchNames(
  ndb: NetworkDb,
  trigram: TrigramQuery,
  f: SearchFilters,
): { hits: SearchNameHit[]; total: number } {
  const useFts = trigram.match !== '';
  // Мыслевые настройки (актуальность/корзина/тип/подкорень) — единой
  // конъюнкцией из AST-движка (требование b91336e7, ADR 7581ac14).
  const baseClauses: Array<Clause | null> = [
    f.thoughtClause,
    f.authorId !== null ? { sql: 't.created_by = ?', params: [f.authorId] } : null,
    f.editorId !== null ? { sql: 't.updated_by = ?', params: [f.editorId] } : null,
  ];
  // Короткие include-слова БЕЗ триграммного представления: точный предикат с
  // pattern-веткой (D8) — литеральная подстрока ИЛИ слово `*`-синонима. Только
  // литеральная клауза здесь теряла мысль при комбинации «длинное слово даёт
  // FTS-якорь + короткое совпадает лишь словом-паттерном»: строка была
  // FTS-кандидатом и в tier 2 уже не попадала (NOT IN кандидатов).
  // Короткие ИСКЛЮЧЕНИЯ остаются литеральными: pattern-исключение добавляется
  // отдельно для КАЖДОГО слова запроса (`patternExcludeClauses` ниже).
  const shortClauses: Array<Clause | null> = [
    ...trigram.nameShortInclude.map((w) => buildNameWordClause(w, false)),
    ...trigram.nameShortExclude.map((w) => buildShortWordNameClause(w, true)),
  ];
  // Точный предикат каждого слова: литерал ИЛИ слово-паттерн `*`-синонима.
  const exactIncludeClauses = trigram.nameInclude.map((w) => buildNameWordClause(w, false));
  const exactExcludeClauses = trigram.nameExclude.map((w) => buildNameWordClause(w, true));
  const baseFilters = joinClauses(baseClauses);
  const shortFilters = joinClauses(shortClauses);
  const exactInclude = joinClauses(exactIncludeClauses);
  const exactExclude = joinClauses(exactExcludeClauses);

  // S6 (13-layers.md §9): when the FTS5 join is used, the names index carries
  // one row per PHYSICAL thought row (rowid = thoughts.pk), so an overridden
  // thought has rows for every layer of the chain. The join is by rowid with
  // `thoughts_v` — the view exposes the winner row's rowid — so only the
  // winner's text matches: stale ancestor revisions, other layers' rows and
  // tombstones (no view row) never reach the result. Dedup by logical id
  // comes free: one FTS row joins per visible thought (`UNIQUE (id,
  // layer_id)`) and the second tier excludes every FTS candidate. COUNT and
  // the page are computed over the same union, never inside the FTS scan.
  let body: string;
  let params: unknown[];
  let pageOrder: string;
  if (useFts) {
    const patternExcludeClauses = trigram.nameExclude.map((w) => buildNamePatternExcludeClause(w));
    const patternExcludes = joinClauses(patternExcludeClauses);
    const tier1Where = joinClauses([...baseClauses, ...shortClauses, ...patternExcludeClauses]);
    const tier2Where = joinClauses([
      { sql: 't.rowid NOT IN (SELECT rowid FROM fts_candidates)', params: [] },
      ...baseClauses,
      ...exactIncludeClauses,
      ...exactExcludeClauses,
    ]);
    const tier1 = `SELECT ${NAME_HIT_COLUMNS}, 0 AS kw_tier, f.fts_rank AS kw_rank,
              t.title_norm AS title_norm, t.id AS sort_id
       FROM thoughts_v t
       JOIN fts_candidates f ON f.rowid = t.rowid
       WHERE ${tier1Where.where}`;
    const tier2 = `SELECT ${NAME_HIT_COLUMNS}, 1 AS kw_tier, NULL AS kw_rank,
              t.title_norm AS title_norm, t.id AS sort_id
       FROM thoughts_v t
       WHERE ${tier2Where.where}`;
    body =
      `WITH fts_candidates(rowid, fts_rank) AS (` +
      `SELECT rowid, rank FROM fts_thought_names WHERE fts_thought_names MATCH ?` +
      `) ${tier1} UNION ALL ${tier2}`;
    params = [
      trigram.match,
      ...baseFilters.params,
      ...shortFilters.params,
      ...patternExcludes.params,
      ...baseFilters.params,
      ...exactInclude.params,
      ...exactExclude.params,
    ];
    pageOrder = 'ORDER BY kw_tier ASC, kw_rank ASC, title_norm ASC, sort_id ASC';
  } else {
    const where = joinClauses([...baseClauses, ...exactIncludeClauses, ...exactExcludeClauses]);
    body = `SELECT ${NAME_HIT_COLUMNS}, t.title_norm AS title_norm, t.id AS sort_id
       FROM thoughts_v t
       WHERE ${where.where}`;
    params = [...baseFilters.params, ...exactInclude.params, ...exactExclude.params];
    pageOrder = 'ORDER BY title_norm ASC, sort_id ASC';
  }

  const total = (
    ndb.prepare(`SELECT COUNT(*) AS c FROM (${body})`).get(...params) as { c: number }
  ).c;
  const rows = ndb
    .prepare(`${body} ${pageOrder} LIMIT ? OFFSET ?`)
    .all(...params, f.limit, f.offset) as Array<{
    thought_id: string;
    title: string;
    icon: string | null;
    icon_kind: string;
    icon_attachment_id: string | null;
    icon_color: string | null;
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
        icon_color: r.icon_color,
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
  const { where, params } = joinClauses([
    { sql: 'fts_thought_texts MATCH ?', params: [match] },
    { sql: "c.owner_type = 'thought'", params: [] },
    // Мыслевые настройки — единой AST-конъюнкцией (см. `searchNames`).
    // Автор/редактор остаются корпусными параметрами (авторство МЫСЛИ).
    f.thoughtClause,
    f.authorId !== null ? { sql: 't.created_by = ?', params: [f.authorId] } : null,
    f.editorId !== null ? { sql: 't.updated_by = ?', params: [f.editorId] } : null,
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
              icon_attachment_id, icon_color, fg_color, bg_color,
              font_bold, font_italic, font_underline, font_strike,
              font_manual, type_id, active
       FROM (
         SELECT c.id AS comment_id, f.thought_id AS thought_id, t.title AS title,
                c.body_md AS body, t.icon AS icon, t.icon_kind AS icon_kind,
                t.icon_attachment_id AS icon_attachment_id,
                t.icon_color AS icon_color,
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
    icon_color: string | null;
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
        icon_color: r.icon_color,
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
    // Фильтры авторства (задача 59119797) применяются к самому
    // комментарию — колонки `comments.created_by`/`comments.updated_by`
    // одинаковы для обеих сторон (thought и link).
    f.authorId !== null ? { sql: 'c.created_by = ?', params: [f.authorId] } : null,
    f.editorId !== null ? { sql: 'c.updated_by = ?', params: [f.editorId] } : null,
  ];
  // Each side joins only the table that owns the comment, so the referenced
  // FTS payload column always exists (fts_thought_texts.thought_id for thoughts,
  // fts_link_texts.link_id for links).
  let joins = '';
  if (side === 'thought') {
    // Мыслевые настройки thought-половины хроники — единой AST-конъюнкцией
    // (требование b91336e7). Автор/редактор остаются корпусными: для раздела
    // «хронология» это авторство КОММЕНТАРИЯ (`c.created_by`/`c.updated_by`).
    clauses.push(f.thoughtClause);
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
// Мыслевые настройки отбора → общий AST (требование b91336e7, ADR 7581ac14)
// ---------------------------------------------------------------------------

/** Обернуть результат {@link filterAstClause} в локальную форму WHERE-клаузы. */
function toSearchClause(clause: { sql: string; params: unknown[] }): Clause {
  return { sql: clause.sql, params: clause.params };
}

/**
 * Скомпилировать МЫСЛЕВЫЕ настройки плоского контракта поиска в общий AST
 * (профиль `thoughts`) — обратная совместимость: те же настройки, что раньше
 * исполнялись отдельным плоским путём, теперь идут через единый движок.
 *
 *   * «показывать неактуальные» (`show_inactive`, дефолт — настройка
 *     пользователя): `true` → условия нет; иначе лист «Актуальность» = true.
 *   * «корзина» (`trashed`): `true` → условия нет; иначе лист «Пометка на
 *     удаление» = false (marked_for_deletion скрыты).
 *   * типы мыслей (`type` — имя, резолвится; `type_id`) → лист «Тип в
 *     иерархии» (L21: тип и его подтипы).
 *   * подкорень (`in=subtree` + `from_thought_id`) → «ИЛИ(id в [корень],
 *     parents in_hierarchy [корень] режим `all_links`)» — ровно корень и его
 *     потомки по всем ЖИВЫМ не-корзинным связям (прецедент —
 *     `applyLegacyHierarchyTraversal`, `client/src/renderer/lib/filter-builder.ts`).
 *     Лист `parents` + `in_hierarchy` матчит ПОТОМКОВ корня (родитель входит в
 *     поддерево), сами корни добавляет лист `id` в списке; `children` дал бы
 *     предков и для подкорня не годится.
 *
 * `undefined` — мыслевых настроек в запросе нет (без фильтра).
 */
export function compileSearchThoughtAst(
  ndb: NetworkDb,
  request: SearchRequest,
  showInactiveDefault: boolean,
): FilterAst | undefined {
  const children: FilterAstNode[] = [];

  // «Показывать неактуальные»: true → условия нет; иначе — только активные.
  const showInactive = request.show_inactive ?? showInactiveDefault;
  if (!showInactive) {
    children.push({ entity: { kind: 'active' }, operator: 'eq', value: true });
  }
  if (request.trashed !== true) {
    children.push({ entity: { kind: 'trashed' }, operator: 'eq', value: false });
  }

  // Резолв имени типа в id (задача d5ab1630 «Типы адресуются именами»).
  const resolvedTypeId =
    request.type !== undefined ? resolveThoughtTypeIdByName(ndb, request.type) : undefined;
  const typeIds = resolvedTypeId !== undefined ? [resolvedTypeId] : request.type_id;
  if (typeIds !== undefined && typeIds.length > 0) {
    children.push({ entity: { kind: 'type' }, operator: 'in_hierarchy', value: [...typeIds] });
  }

  if (
    request.in === 'subtree' &&
    typeof request.from_thought_id === 'string' &&
    request.from_thought_id !== ''
  ) {
    const root = request.from_thought_id;
    children.push({
      op: 'or',
      children: [
        { entity: { kind: 'id' }, operator: 'in', value: [root] },
        { entity: { kind: 'parents' }, operator: 'in_hierarchy', mode: 'all_links', value: [root] },
      ],
    });
  }

  if (children.length === 0) return undefined;
  return {
    version: FILTER_AST_VERSION,
    filter: children.length === 1 ? (children[0] as FilterAstNode) : { op: 'and', children },
  };
}

/**
 * Правило сосуществования: `ast` XOR плоские МЫСЛЕВЫЕ параметры
 * (требование b91336e7, ADR 7581ac14). Одновременная передача — ошибка
 * валидации: мыслевые настройки шли бы двумя противоречивыми путями.
 * Корпусные параметры (`q`, `scope`, `link_type_id`, `author_id`,
 * `editor_id`) с `ast` совместимы всегда и здесь не проверяются.
 */
export function assertSearchAstExclusive(request: SearchRequest): void {
  if (request.ast === undefined) return;
  const conflicting: string[] = [];
  if (request.type_id !== undefined && request.type_id.length > 0) conflicting.push('type_id');
  if (request.type !== undefined) conflicting.push('type');
  if (request.show_inactive !== undefined) conflicting.push('show_inactive');
  if (request.trashed !== undefined) conflicting.push('trashed');
  if (request.in !== undefined) conflicting.push('in');
  if (request.from_thought_id !== undefined) conflicting.push('from_thought_id');
  if (conflicting.length === 0) return;
  throw new EtnError(
    'VALIDATION_ERROR',
    `Поле ast несовместимо с плоскими мыслевыми параметрами (${conflicting.join(
      ', ',
    )}): передайте либо ast, либо плоские параметры.`,
    { field: 'ast', conflicting },
  );
}

// ---------------------------------------------------------------------------
// Токены контекста мысли в AST точки поиска (задача 4b1cc3d4)
// ---------------------------------------------------------------------------

/** Пустой ответ поиска (все группы пусты); с диагностикой — при её наличии. */
function emptySearchResponse(unresolved: TokenIssue[]): SearchResponse {
  return {
    by_names: [],
    by_texts: [],
    by_links: [],
    by_chrono: [],
    meta: { total_in_group: { names: 0, texts: 0, links: 0, chronology: 0 } },
    ...(unresolved.length > 0 ? { unresolved } : {}),
  };
}

/**
 * Строки-токены КОНТЕКСТА МЫСЛИ (`$thought`, `$thought.<поле>`,
 * `$thought.[<свойство>]`), найденные в AST. Глобальные токены (`$today`,
 * `$user`, …) не считаются: их раскрывает движок по `tokenContext`
 * (задача 56a143ff). Обход — по объектам-значениям `{ token: '…' }`.
 */
function collectThoughtTokenStrings(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectThoughtTokenStrings(item, out);
    return out;
  }
  if (node === null || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  const token = record['token'];
  if (typeof token === 'string' && Object.keys(record).length === 1) {
    const { known } = scanStringForTokens(token);
    if (known.some((tok) => tok.kind !== 'global')) out.push(token);
    return out;
  }
  for (const value of Object.values(record)) collectThoughtTokenStrings(value, out);
  return out;
}

/**
 * Разрешить в AST токены контекста мысли (`$thought*`) мыслью-фокусом карты
 * (`focus_thought_id`) — образец решения C3 (ошибка 23c7d3e9,
 * `runViewForThought`): пред-резолв токенов контекста мысли сервисом, у
 * которого есть мысль, ДО единого движка отбора.
 *
 * Без фокуса или при ненайденной мысли токен не разрешается: отдаём
 * `unresolved` с пояснением (требование b7fdab20) — условие диагностируется, а
 * не исполняется тихо пустым результатом.
 *
 * `null` — токенов контекста мысли в AST нет: резолв не нужен (лишний запрос к
 * БД не делаем, AST без изменений).
 */
function resolveSearchThoughtTokens(
  ndb: NetworkDb,
  ast: FilterAst,
  focusThoughtId: string | undefined,
  tokenContext: AstTokenContext | undefined,
): { ast: FilterAst; unresolved: TokenIssue[] } | null {
  const tokens = collectThoughtTokenStrings(ast);
  if (tokens.length === 0) return null;
  if (focusThoughtId === undefined || focusThoughtId === '') {
    return {
      ast,
      unresolved: tokens.map((token) => ({
        path: '',
        token,
        reason: 'unknown_token' as const,
        message: `Токен «${token}» требует мысли в фокусе карты: задайте мысль в фокусе и повторите поиск.`,
      })),
    };
  }
  const thought = getThought(ndb, focusThoughtId);
  if (thought === null) {
    return {
      ast,
      unresolved: tokens.map((token) => ({
        path: '',
        token,
        reason: 'unknown_token' as const,
        message: `Мысль в фокусе карты (${focusThoughtId}) не найдена — токен «${token}» не разрешён.`,
      })),
    };
  }
  const ctx = buildThoughtResolveContext(
    ndb,
    {
      id: thought.id,
      title: thought.title,
      synonyms: thought.synonyms,
      type_id: thought.type_id,
      active: thought.active,
      created_by: thought.created_by ?? '',
      updated_by: thought.updated_by ?? '',
      created_at: thought.created_at,
      updated_at: thought.updated_at,
    },
    focusThoughtId,
    tokenContext?.userId ?? '',
    {
      ...(tokenContext?.nowMs !== undefined
        ? { now: (): Date => new Date(tokenContext.nowMs!) }
        : {}),
      ...(tokenContext?.firstDayOfWeek !== undefined
        ? { firstDayOfWeek: tokenContext.firstDayOfWeek }
        : {}),
      ...(tokenContext?.withTime !== undefined ? { withTime: tokenContext.withTime } : {}),
    },
  );
  // Глобальные токены (`$today`/`$user`/…) движок раскрывает сам по
  // `tokenContext`; здесь подставляются ТОЛЬКО токены контекста мысли.
  const resolved = resolveThoughtTokensInAst(ast, ctx);
  return { ast: resolved.definition as FilterAst, unresolved: resolved.unresolved };
}

// ---------------------------------------------------------------------------
// Public: search
// ---------------------------------------------------------------------------

/**
 * Run a full-text search (docs/03-server-api.md §12).
 *
 * Диагностика AST (`unresolved` — задача 56a143ff, требование b7fdab20) объявлена
 * в общем контракте: `SearchResponse.unresolved` (`TokenIssue[]`, задача
 * 1169ae37), поэтому своего расширения ответ точки поиска не заводит.
 *
 * @param ndb - open network database.
 * @param request - query parameters; `scope` selects which groups to populate.
 * @param showInactiveDefault - caller's `preferences.show_inactive` value, used
 *   when `request.show_inactive` is omitted.
 * @param tokenContext - контекст разрешения календарных токенов `request.ast`
 *   (задача 56a143ff): часы сервера, `userId` ключа, первый день недели сети,
 *   профиль времени. Без него лист с токеном неразрешим (`AST_FALSE`,
 *   `unresolved` с пояснением вместо бесшумного пустого).
 */
export function search(
  ndb: NetworkDb,
  request: SearchRequest,
  showInactiveDefault = false,
  tokenContext?: AstTokenContext,
): SearchResponse {
  if (typeof request.q !== 'string' || request.q.trim() === '') {
    throw new EtnError('VALIDATION_ERROR', 'q must be a non-empty string', { field: 'q' });
  }
  const scope: SearchScope =
    typeof request.scope === 'string' &&
    (SEARCH_SCOPES as readonly string[]).includes(request.scope)
      ? (request.scope as SearchScope)
      : 'all';
  const trigram = buildTrigramQuery(request.q);
  const paging = clampPaging(request.limit, request.offset);
  // Highlight terms: the include words only (`*` folded away, exclusions
  // dropped) — they are what the matches above actually found in the text.
  const highlightTerms = parseFilterKeywords(request.q).include.flatMap((w) =>
    tokenize(w.replace(/\*/g, ' ')),
  );

  // Мыслевые настройки отбора — ЕДИНЫМ путём: явное `ast` (профиль `thoughts`)
  // либо компиляция плоских мыслевых параметров в тот же AST (требование
  // b91336e7, ADR 7581ac14, задача d5e8ddc1). Отдельного плоского пути
  // исполнения мыслевых настроек нет — второй движок не вводится.
  const explicitAst = request.ast;
  if (explicitAst !== undefined) {
    assertSearchAstExclusive(request);
    // Видимость операндов профиля `thoughts` (требование 0095daad): условие
    // вне профиля — `VALIDATION_ERROR` до исполнения (сценарий 55f31eee).
    assertFilterAstInProfile(explicitAst, 'thoughts');
    // Красная диагностика: AST со ссылкой на удалённую сущность не исполняем.
    const diag = diagnoseFilterAst(ndb, explicitAst);
    if (diag.errors.length > 0) throw filterDiagnosticsError(diag.errors);
  }
  let effectiveAst: FilterAst | undefined =
    explicitAst ?? compileSearchThoughtAst(ndb, request, showInactiveDefault);
  // Токены КОНТЕКСТА МЫСЛИ (`$thought*`) разрешаются мыслью-фокусом карты до
  // единого движка (задача 4b1cc3d4): без фокуса/при ненайденной мысли —
  // штатная диагностика `unresolved` вместо тихой пустоты (требование b7fdab20).
  if (effectiveAst !== undefined) {
    const thoughtResolved = resolveSearchThoughtTokens(
      ndb,
      effectiveAst,
      request.focus_thought_id,
      tokenContext,
    );
    if (thoughtResolved !== null) {
      if (thoughtResolved.unresolved.length > 0) {
        return emptySearchResponse(thoughtResolved.unresolved);
      }
      effectiveAst = thoughtResolved.ast;
    }
  }
  // Неразрешимые токены AST (задача 56a143ff, требование b7fdab20): лист с
  // токеном собирает диагностику в этот коллектор; пусто — всё разрешилось.
  const unresolved: TokenIssue[] = [];
  const thoughtClause: Clause | null =
    effectiveAst === undefined
      ? null
      : toSearchClause(
          filterAstClause(ndb, effectiveAst, undefined, {
            ...(tokenContext !== undefined ? { ctx: tokenContext } : {}),
            unresolved,
          }),
        );

  const filters: SearchFilters = {
    // show_inactive/trashed остаются параметрами полнотекстового поиска —
    // фильтруют ХИТЫ-связи и хроно-хиты по связям (мыслевые настройки идут в
    // `thoughtClause` через AST).
    showInactive: request.show_inactive ?? showInactiveDefault,
    trashed: request.trashed === true,
    linkTypeIds: request.link_type_id
      ? expandTypeIdsToSubtree(ndb, 'link_types', request.link_type_id)
      : null,
    thoughtClause,
    limit: paging.limit,
    offset: paging.offset,
    terms: highlightTerms,
    // Задача 59119797 «Фильтры Автор/Редактор»: пустая строка и отсутствие
    // значения равнозначны — фильтр не применяется.
    authorId:
      typeof request.author_id === 'string' && request.author_id.trim() !== ''
        ? request.author_id
        : null,
    editorId:
      typeof request.editor_id === 'string' && request.editor_id.trim() !== ''
        ? request.editor_id
        : null,
  };

  const empty: SearchResponse = {
    by_names: [],
    by_texts: [],
    by_links: [],
    by_chrono: [],
    meta: { total_in_group: { names: 0, texts: 0, links: 0, chronology: 0 } },
  };
  // `match === ''` with no `by_names` LIKE fallback either means: no include
  // word at all (empty query already rejected above, or a pure exclusion —
  // FTS5 has no unary NOT, "matches nothing" is the deliberate rule here).
  if (trigram.match === '' && trigram.nameShortInclude.length === 0) {
    // Диагностика токенов сохраняется и на раннем выходе: причина пустого
    // ответа не должна теряться (задача 56a143ff).
    return unresolved.length > 0 ? { ...empty, unresolved } : empty;
  }

  const wants = (group: SearchScope): boolean => scope === 'all' || scope === group;
  // `by_names` alone can run on the LIKE-only fallback (trigram.match === ''
  // but nameShortInclude is non-empty); the other three groups have no such
  // fallback (Tier 1, bug 0258fd9d) and simply stay empty without it.
  const names = wants('names') ? searchNames(ndb, trigram, filters) : { hits: [], total: 0 };
  const texts =
    wants('texts') && trigram.match !== '' ? searchTexts(ndb, trigram.match, filters) : { hits: [], total: 0 };
  const links =
    wants('links') && trigram.match !== '' ? searchLinks(ndb, trigram.match, filters) : { hits: [], total: 0 };
  const chrono =
    wants('chronology') && trigram.match !== ''
      ? searchChrono(ndb, trigram.match, filters)
      : { hits: [], total: 0 };

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
    // Неразрешимые токены AST — только при непустом наборе (паритет с
    // `queryThoughts`: «всё разрешилось» не шумит в ответе).
    ...(unresolved.length > 0 ? { unresolved } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public: findDuplicates (add-thought dialog + MCP find_duplicates)
// ---------------------------------------------------------------------------

/** Normalise a title/synonym the way the thought service does (NFC+trim+lower). */
function norm(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
}

/**
 * Опции {@link findDuplicates}.
 *
 * Режим `dedupe` (по умолчанию) — строгая семантика поиска ДУБЛЕЙ (ошибка
 * 11f14a81): совпадение подстроки слова или одного слова из середины чужого
 * составного названия не делает мысль дублем; `*` в синониме — основа
 * словоформы (короткое окончание), а не произвольная подстрока; частичный
 * кандидат обязан начинать название/литеральный синоним последовательностью
 * слов с начала. Режим `search` — прежнее поведение живого поиска (диалог
 * добавления, пикеры мыслей, 0.4.5). Семантика одна для MCP и REST: REST по
 * умолчанию — `dedupe`, живой поиск клиента передаёт `mode=search` явно.
 * См. {@link DuplicateSearchMode}.
 */
export interface FindDuplicatesOptions {
  /** Режим сопоставления; по умолчанию `dedupe`. */
  mode?: DuplicateSearchMode;
  /**
   * Тип предлагаемой мысли (гейт записи знает его из `thought.type`).
   * В режиме `dedupe` partial-кандидаты другого типа отбрасываются.
   */
  typeId?: string | null;
}

/**
 * Максимум символов слова, которые в режиме `dedupe` поглощает `*`.
 *
 * Это НЕ стеммер: `*` — изменяемая часть слова (окончание), а не произвольная
 * подстрока (карточка ошибки 11f14a81). Русское словоизменение укладывается в
 * три буквы (`-ами`, `-ого`, `-ыми`, `-ешь`); производные слова (`Владимир` →
 * `Владимирович`, `Игорян` → `Игорянский`) длиннее и матчем не считаются.
 */
const DEDUPE_WILDCARD_MAX_ENDING = 3;

/** Один символ слова — та же граница, что у `synonymPatternSource`. */
const WORD_CHAR_CLASS = '[\\p{L}\\p{N}_]';

/** Word-tokenizer границы слова (буквы/цифры/подчёркивание). */
const WORD_TOKEN_RE = /[\p{L}\p{N}_]+/gu;

/**
 * Regex-источник wildcard-синонима для режима `dedupe`: паттерн анкорится на
 * ВЕСЬ термин, `*` поглощает 0…{@link DEDUPE_WILDCARD_MAX_ENDING} символов
 * слова и не переходит границу слова (дефис, пробел, пунктуация).
 */
function dedupeWildcardSource(patternNorm: string): string {
  const words = patternNorm.trim().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return '(?!)';
  const wordBody = (word: string): string =>
    word
      .split('*')
      .map((part) => (part === '' ? '' : regexEscape(part)))
      .join(`${WORD_CHAR_CLASS}{0,${DEDUPE_WILDCARD_MAX_ENDING}}`);
  return `^${words.map(wordBody).join('\\s+')}$`;
}

/** Кэш matcher-ов dedupe по `synonym_norm` (см. {@link anchoredWildcardCache}). */
const dedupeWildcardCache = new Map<string, RegExp>();

/** Anchored matcher режима `dedupe` для `synonymNorm`, компилируется один раз. */
function dedupeWildcardFor(synonymNorm: string): RegExp {
  let re = dedupeWildcardCache.get(synonymNorm);
  if (re === undefined) {
    if (dedupeWildcardCache.size >= ANCHORED_WILDCARD_CACHE_MAX) dedupeWildcardCache.clear();
    re = new RegExp(dedupeWildcardSource(synonymNorm), 'iu');
    dedupeWildcardCache.set(synonymNorm, re);
  }
  return re;
}

/** Слова терма: последовательность runs из букв/цифр/подчёркивания. */
function wordTokens(value: string): string[] {
  return norm(value).match(WORD_TOKEN_RE) ?? [];
}

/**
 * Режим `dedupe`: слова ввода должны начинать терм кандидата как
 * последовательность ЦЕЛЫХ слов (дефис/пунктуация — разделители слов).
 * Слово из середины или конца чужого названия кандидатом не делает —
 * «Владимир» не матчит «Беберашвили Владимир», а «Владимир город» матчит
 * «Владимир (город)».
 */
function startsWithWordSequence(candidate: string[], input: readonly string[]): boolean {
  if (input.length === 0 || input.length > candidate.length) return false;
  for (let i = 0; i < input.length; i += 1) {
    if (candidate[i] !== input[i]) return false;
  }
  return true;
}

/** Whole-term matcher of one stored `*`-synonym plus its cheap prefilter markers. */
interface AnchoredWildcardPattern {
  regex: RegExp;
  markers: MentionPrefilterMarkers;
}

/**
 * Cache of anchored wildcard-synonym matchers, keyed by `synonym_norm`
 * (ошибка 5e35eb7b).
 *
 * {@link findDuplicates} evaluates EVERY `*`-synonym of the network against
 * EVERY input term; on a network with thousands of wildcard synonyms that was
 * thousands of `new RegExp` compilations per call (the CPU-profile hot frame
 * behind the 0.8–1.9 s standalone cost), even though the patterns are stable
 * between edits. A pattern is compiled at most once per process per
 * `synonym_norm`; the cache is capped and cleared wholesale when full — terms
 * are cheap to recompile and a per-entry LRU would cost more than it saves.
 * Shared `RegExp` objects are safe here: the anchored match uses `.test()`
 * without the `g` flag, so there is no `lastIndex` state.
 */
const anchoredWildcardCache = new Map<string, AnchoredWildcardPattern>();
const ANCHORED_WILDCARD_CACHE_MAX = 8192;

/** Returns the anchored wildcard matcher for `synonymNorm`, compiling it at most once. */
function anchoredWildcardFor(synonymNorm: string): AnchoredWildcardPattern {
  let pat = anchoredWildcardCache.get(synonymNorm);
  if (pat === undefined) {
    if (anchoredWildcardCache.size >= ANCHORED_WILDCARD_CACHE_MAX) anchoredWildcardCache.clear();
    pat = {
      regex: new RegExp(`^(?:${synonymPatternSource(synonymNorm)})$`, 'iu'),
      markers: mentionPrefilterMarkers(synonymNorm),
    };
    anchoredWildcardCache.set(synonymNorm, pat);
  }
  return pat;
}

/**
 * LIKE prefilter clause of the partial duplicate tier for one typed word
 * (implicit `*` wrappers are expressed as `%…%`). Used by the FTS-less
 * fallback and by words the trigram index cannot express: shorter than 3
 * characters, or an exclusion containing `*` (see
 * {@link buildPartialCandidateFilter}). `title_norm`/`synonym_norm` are stored
 * NFC+lowercase, so the fragment is folded before it becomes a pattern
 * (bug 6bba224b-…; same reasoning as {@link buildShortWordNameClause}).
 *
 * The synonym half is an UNCORRELATED `IN (SELECT …)`. `thought_synonyms_v` is
 * a layer-chain view: a correlated `EXISTS` makes SQLite re-evaluate the whole
 * view once per outer thought (measured on 5 000 thoughts × 3 500 synonyms:
 * 1 194 ms for one word), while the uncorrelated subquery is materialised once
 * and probed by id (1.3 ms) — same result set, ~900× cheaper (ошибка
 * 5e35eb7b).
 */
function buildPartialLikeClause(word: string, negate: boolean): Clause {
  const pattern = buildLikePattern(word.toLowerCase());
  const sql =
    "(thoughts.title_norm LIKE ? ESCAPE '\\' OR thoughts.id IN (SELECT ts.thought_id" +
    " FROM thought_synonyms_v ts WHERE ts.synonym_norm LIKE ? ESCAPE '\\'))";
  return { sql: negate ? `NOT ${sql}` : sql, params: [pattern, pattern] };
}

/** Candidate prefilter of the partial duplicate tier (see {@link findDuplicates}). */
interface PartialCandidateFilter {
  /**
   * Boolean `MATCH` expression over `fts_thought_names`, or `null` when no
   * include word clears the trigram floor — the caller must then skip the FTS
   * join/MATCH entirely and rely on {@link PartialCandidateFilter.clauses}.
   */
  ftsMatch: string | null;
  /** LIKE clauses for words the trigram index cannot express. */
  clauses: Clause[];
}

/**
 * Split the §6.10 include/exclude words of one duplicate term into an FTS5
 * narrowing condition and the LIKE clauses that remain necessary.
 *
 * FTS5 trigram is a CANDIDATE NARROWER, not the semantics: it indexes only
 * literal fragments of ≥3 characters (migration `038_search_trigram.sql`), so
 * shorter words (and `*` fragments that are short) stay on the LIKE fallback.
 * The JS post-filter ({@link synonymPatternToRegex}) still enforces the
 * consecutive-words/order rules; the FTS expression may be broader (it matches
 * fragments anywhere and cannot see word order), which is safe for a
 * prefilter.
 *
 * Exclusions go through FTS only when that is exactly equivalent to the old
 * LIKE clause: a long word without `*` excludes the same candidates —
 * `NOT "phrase"` means "the fragment is absent from title + all synonyms",
 * the same as `NOT (title LIKE … OR synonym LIKE …)`. An exclusion containing
 * `*` keeps the LIKE path: the old pattern requires the fragments in the typed
 * order, whereas FTS `NOT (a AND b)` would also drop rows that merely contain
 * both in any order.
 *
 * With no anchor at all (every include word shorter than the trigram floor)
 * the whole filter falls back to the original LIKE pass for include and
 * exclude alike.
 */
function buildPartialCandidateFilter(
  include: string[],
  exclude: string[],
): PartialCandidateFilter {
  if (include.length === 0) return { ftsMatch: null, clauses: [] };

  const positives: string[] = [];
  const shortInclude: string[] = [];
  for (const word of include) {
    const phrase = trigramPhrase(word);
    if (phrase === null) shortInclude.push(word);
    else positives.push(phrase);
  }

  if (positives.length === 0) {
    // No trigram anchor: keep the original full LIKE pass.
    return {
      ftsMatch: null,
      clauses: [
        ...include.map((w) => buildPartialLikeClause(w, false)),
        ...exclude.map((w) => buildPartialLikeClause(w, true)),
      ],
    };
  }

  let ftsMatch = positives.join(' AND ');
  const clauses = shortInclude.map((w) => buildPartialLikeClause(w, false));
  for (const word of exclude) {
    const phrase = trigramPhrase(word);
    if (phrase === null || word.includes('*')) {
      clauses.push(buildPartialLikeClause(word, true));
    } else {
      ftsMatch += ` NOT ${phrase}`;
    }
  }
  return { ftsMatch, clauses };
}

/**
 * Размер порции `IN (…)` для батч-чтения синонимов: ниже лимита bind-
 * параметров SQLite (999 в старых сборках) с запасом, а число запросов растёт
 * как O(кандидатов / порция), не O(кандидатов).
 */
const DUPLICATE_SYNONYM_CHUNK = 900;

/** Разбить список id на порции для `IN (…)`. */
function chunkDuplicateIds(ids: readonly string[]): string[][] {
  if (ids.length <= DUPLICATE_SYNONYM_CHUNK) return [ids as string[]];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += DUPLICATE_SYNONYM_CHUNK) {
    out.push(ids.slice(i, i + DUPLICATE_SYNONYM_CHUNK));
  }
  return out;
}

/**
 * Find existing thoughts that look like duplicates of the proposed
 * `title`/`synonyms` (docs/08-ui-spec.md add-thought dialog; MCP
 * `find_duplicates`).
 *
 * Match priority (strongest wins per candidate): exact `title_norm`, exact
 * `synonym_norm`, a stored `*`-synonym matching the WHOLE input term, then
 * partial. `matched_on` keeps the same three values in every mode.
 *
 * Two modes (ошибка 11f14a81 — дедупликация строже живого поиска):
 *
 * - `dedupe` (default; MCP and REST) — the duplicate semantics:
 *   * `*` in a stored synonym is the CHANGEABLE part of a wordform: it absorbs
 *     0…3 word characters inside one word and never crosses a hyphen, space or
 *     punctuation («Владимир*» matches «Владимире», not «Владимирович»;
 *     «Газпромбанк*» does not match «Газпромбанк-Автолизинг»). Not a stemmer:
 *     derived words do not match;
 *   * a partial candidate's title/literal synonym must START with the input's
 *     word sequence (whole words, in order; punctuation/hyphens are word
 *     separators). A single word from the middle of a foreign title or of a
 *     compound synonym is not a duplicate — «Владимир» does not match
 *     «Беберашвили Владимир» or «Отель У Золотых Ворот». Stored `*`-synonyms
 *     are name templates and never serve as partial haystack;
 *   * partial candidates of a FOREIGN type are dropped when the type is already
 *     fixed by a stronger hit (or by the explicit `typeId` of the write gate) —
 *     a city «Владимир» and a person «Беберашвили Владимир» are not duplicates.
 * - `search` — legacy live-search behaviour (add-thought dialog, thought
 *   pickers, 0.4.5): implicit `*` around every typed word, infix candidates,
 *   fragments inside consecutive words in the typed order («дор» →
 *   «Доработать!», «исправ ошиб» → «Исправленные ошибки»). A `-word` exclusion
 *   (03-server-api.md §6.10) keeps its infix semantics.
 *
 * Results are ordered by match strength in both modes.
 *
 * @param title - proposed thought title.
 * @param synonyms - optional proposed synonyms.
 * @param typeIds - optional thought-type filter (link property pickers,
 *   pickers): only thoughts of these types are returned.
 * @param options - `mode` (`dedupe` by default) и `typeId` предлагаемой мысли.
 */
export function findDuplicates(
  ndb: NetworkDb,
  title: string,
  synonyms: string[] = [],
  typeIds: string[] = [],
  options: FindDuplicatesOptions = {},
): DuplicateHit[] {
  const mode: DuplicateSearchMode = options.mode ?? 'dedupe';
  const titleTerms = [title.trim(), ...synonyms.map((s) => s.trim())].filter((t) => t !== '');
  if (titleTerms.length === 0) return [];

  // Type filter (property pickers): parameterised IN-list applied to every
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
  const DUP_COLUMNS = `id, title, type_id, icon, icon_kind, icon_color, fg_color, bg_color,
       font_bold, font_italic, font_underline, font_strike, font_manual`;

  const ensure = (row: {
    id: string;
    title: string;
    type_id: string | null;
    icon: string | null;
    icon_kind: string;
    icon_color: string | null;
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
      hit = {
        id: row.id,
        title: row.title,
        // Синонимы грузятся одним батчем после обхода тиров (задача
        // 8abc413f): поштучный SELECT в ensure() давал N+1 и доминировал в
        // стоимости полного вызова на широком запросе. До финального
        // заполнения hit.synonyms никто не читает — см. блок перед
        // parent_title.
        synonyms: [],
        matched_on: 'partial',
        type_id: row.type_id,
        icon: row.icon,
        // Все три вида иконки сохраняются как есть (задача 610a440e):
        // библиотечный вид `icon` не должен схлопываться в `emoji`.
        icon_kind:
          row.icon_kind === 'image' || row.icon_kind === 'icon' ? row.icon_kind : 'emoji',
        icon_color: row.icon_color,
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
  // Bug a01893c7-ed1e-4c1b-a215-d4398135e049: `thoughts_v` filters only
  // tombstoned rows (`deleted = 0`), not trash-marked ones
  // (`marked_for_deletion = 1`). Adding `AND t.marked_for_deletion = 0`
  // keeps trashed thoughts out of duplicate candidates — they can't be
  // matched against anyway, and surfacing them made `etn.thoughts.write`
  // refuse to create a fresh thought with a DUPLICATE pointing at a
  // trashed row the user had no way to find via get/query.
  const wildSynRows = ndb
    .prepare(
      `SELECT ts.thought_id AS id, t.title AS title, t.type_id AS type_id,
              t.icon AS icon, t.icon_kind AS icon_kind, t.icon_color AS icon_color,
              t.fg_color AS fg_color, t.bg_color AS bg_color,
              t.font_bold AS font_bold, t.font_italic AS font_italic,
              t.font_underline AS font_underline, t.font_strike AS font_strike,
              t.font_manual AS font_manual,
              ts.synonym AS synonym, ts.synonym_norm AS synonym_norm
       FROM thought_synonyms_v ts JOIN thoughts_v t ON t.id = ts.thought_id
       WHERE ts.synonym LIKE '%*%' AND t.marked_for_deletion = 0${typeJoin}`,
    )
    .all(...typeArgs) as Array<{
    id: string;
    title: string;
    type_id: string | null;
    icon: string | null;
    icon_kind: string;
    icon_color: string | null;
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
    // Exact title_norm match (strongest). Bug a01893c7: filter trashed rows.
    const titleRows = ndb
      .prepare(
        `SELECT ${DUP_COLUMNS} FROM thoughts_v WHERE title_norm = ? AND marked_for_deletion = 0${typeDirect}`,
      )
      .all(n, ...typeArgs) as Array<{
      id: string;
      title: string;
      type_id: string | null;
      icon: string | null;
      icon_kind: string;
      icon_color: string | null;
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
    // Exact synonym_norm match. Bug a01893c7: filter trashed rows.
    const synRows = ndb
      .prepare(
        `SELECT ts.thought_id AS id, t.title AS title, t.type_id AS type_id,
                t.icon AS icon, t.icon_kind AS icon_kind, t.icon_color AS icon_color,
                t.fg_color AS fg_color, t.bg_color AS bg_color,
                t.font_bold AS font_bold, t.font_italic AS font_italic,
                t.font_underline AS font_underline, t.font_strike AS font_strike,
                t.font_manual AS font_manual,
                ts.synonym AS synonym
         FROM thought_synonyms_v ts JOIN thoughts_v t ON t.id = ts.thought_id
         WHERE ts.synonym_norm = ? AND t.marked_for_deletion = 0${typeJoin}`,
      )
      .all(n, ...typeArgs) as Array<{
      id: string;
      title: string;
      type_id: string | null;
      icon: string | null;
      icon_kind: string;
      icon_color: string | null;
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
    // Infix matching cannot express the consecutive-words rule, so it stays a
    // cheap candidate prefilter for every word while the exact semantics are
    // enforced in JS over the surviving rows. Candidates for words ≥3
    // characters come from the `trigram` FTS index (`fts_thought_names`), not
    // from a full LIKE scan; words the index cannot represent (shorter than 3
    // characters, `*`-exclusions — see buildPartialCandidateFilter) keep the
    // LIKE clause, and with no long include word at all the whole pass stays
    // LIKE (the trigram floor is a physical limit of the tokenizer).
    //
    // The FTS join is by `rowid` with `thoughts_v`, exactly like `searchNames`:
    // the index holds one row per PHYSICAL row of every layer, while the view
    // exposes the winning row's rowid, so stale ancestor revisions, other
    // layers' rows and tombstones (no view row) never become candidates
    // (13-layers.md §9).
    //
    // `CROSS JOIN` is load-bearing, not stylistic: with a plain `JOIN` the
    // planner keeps `thoughts_v` as the outer loop and evaluates the FTS
    // `MATCH` once per thought (plan `SEARCH t` → `SCAN fnames VIRTUAL TABLE
    // INDEX 0:=M3`; measured on 3 000 thoughts: 26 ms for a non-matching term
    // and 557 ms for a term hitting every row, versus 0.01 ms / 4.6 ms when
    // the FTS table drives). `CROSS JOIN` pins the FTS scan first; the
    // following view lookup uses the rowid primary key, so the join stays an
    // inner join with the same rows.
    // В `dedupe` мини-синтаксис не применяется: ввод — литеральное название,
    // а не поисковый запрос. Кандидатов сужает тот же FTS/LIKE-префильтр
    // (фрагмент слова — надмножество префикса терма), точную семантику
    // «слова ввода начинают терм» проверяет JS-постфильтр ниже.
    const keywords =
      mode === 'search'
        ? parseFilterKeywords(n)
        : { include: wordTokens(n), exclude: [] as string[] };
    if (keywords.include.length > 0) {
      const filter = buildPartialCandidateFilter(keywords.include, keywords.exclude);
      const from =
        filter.ftsMatch !== null
          ? 'fts_thought_names fnames CROSS JOIN thoughts_v thoughts' +
            ' ON fnames.rowid = thoughts.rowid'
          : 'thoughts_v thoughts';
      // The MATCH parameter comes first, then the LIKE fallbacks — the order
      // joinClauses assembles.
      const { where, params } = joinClauses([
        filter.ftsMatch !== null
          ? { sql: 'fts_thought_names MATCH ?', params: [filter.ftsMatch] }
          : null,
        ...filter.clauses,
      ]);
      // Bug a01893c7-ed1e-4c1b-a215-d4398135e049: filter trashed rows out of
      // partial-match candidates.
      let partialRows = ndb
        .prepare(
          `SELECT ${DUP_COLUMNS} FROM ${from} WHERE ${where}
             AND thoughts.marked_for_deletion = 0${typeDirect}`,
        )
        .all(...params, ...typeArgs) as Array<{
        id: string;
        title: string;
        type_id: string | null;
        icon: string | null;
        icon_kind: string;
        icon_color: string | null;
        fg_color: string | null;
        bg_color: string | null;
        font_bold: number;
        font_italic: number;
        font_underline: number;
        font_strike: number;
        font_manual: number;
      }>;
      // Search mode: the include fragments (each implicitly `*`-wrapped) must
      // hit consecutive words of the title or of ONE synonym, in the typed
      // order. synonymPatternToRegex already encodes the word-boundary and
      // adjacency rules; the `*` wrappers turn its exact-word matcher into
      // the infix one.
      //
      // Dedupe mode: the input's WORD SEQUENCE must start the title or a
      // LITERAL synonym (stored `*`-synonyms are templates, not text). This is
      // what keeps «Владимир» away from «Беберашвили Владимир» and from a
      // compound synonym «Золотые Ворота отель Владимир*».
      const includeRe =
        mode === 'search'
          ? synonymPatternToRegex(keywords.include.map((w) => `*${w}*`).join(' '))
          : null;
      const inputTokens = mode === 'search' ? [] : keywords.include;
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
          const syns = synsByThought.get(r.id) ?? [];
          if (includeRe !== null) {
            return [norm(r.title), ...syns].some((h) => includeRe.test(h));
          }
          return [r.title, ...syns.filter((s) => !s.includes('*'))].some((h) =>
            startsWithWordSequence(wordTokens(h), inputTokens),
          );
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
    //
    // Dedupe mode uses the strict wordform matcher (ошибка 11f14a81): `*` is
    // the changeable part of the word, absorbs at most a short ending and never
    // crosses a word boundary; derived words do not match.
    //
    // Performance (ошибка 5e35eb7b): matchers come from a compile cache, and
    // every pattern first passes a cheap conservative prefilter over the term —
    // the same «string sieves before regex» trick as the §21 mentions scan
    // ({@link mentionPrefilterPass}). A pattern whose literal chunks are absent
    // from the term cannot match, so the regex is skipped for the vast majority
    // of the network's wildcard synonyms. The term's folded form and word-token
    // set are computed once per term, not per pattern.
    if (wildSynRows.length > 0) {
      const foldedTerm = foldCase(n);
      const foldedWords = new Set(splitMentionWords(n).map(foldCase));
      for (const r of wildSynRows) {
        const pat = anchoredWildcardFor(r.synonym_norm);
        if (!mentionPrefilterPass(pat.markers, foldedTerm, foldedWords)) continue;
        const re = mode === 'search' ? pat.regex : dedupeWildcardFor(r.synonym_norm);
        if (!re.test(n)) continue;
        const hit = ensure(r);
        if (hit.matched_on === 'partial') {
          hit.matched_on = 'synonym';
          hit.matched_synonym = r.synonym;
        }
      }
    }
  }

  // Dedupe type rule (ошибка 11f14a81): once the type is fixed by a strong
  // (title/synonym) candidate or by the explicit `typeId` of the write gate,
  // a partial candidate of another type is noise, not a duplicate — the city
  // «Владимир» and the person «Беберашвили Владимир» are different entities.
  if (mode === 'dedupe') {
    const strongTypes = new Set<string | null>();
    for (const hit of byId.values()) {
      if (hit.matched_on !== 'partial') strongTypes.add(hit.type_id);
    }
    for (const [id, hit] of byId) {
      if (hit.matched_on !== 'partial') continue;
      if (options.typeId !== undefined && hit.type_id !== options.typeId) {
        byId.delete(id);
        continue;
      }
      if (strongTypes.size > 0 && !strongTypes.has(hit.type_id)) byId.delete(id);
    }
  }

  // Synonym lists of every candidate in O(size / chunk) queries (задача
  // 8abc413f). Порядок внутри мысли — `ORDER BY synonym`, как в прежнем
  // поштучном запросе; порции не пересекаются, поэтому склейка по id даёт
  // прежний результат один-в-один.
  if (byId.size > 0) {
    const synonymsById = new Map<string, string[]>();
    for (const part of chunkDuplicateIds([...byId.keys()])) {
      const rows = ndb
        .prepare(
          `SELECT thought_id, synonym FROM thought_synonyms_v
           WHERE thought_id IN (${part.map(() => '?').join(',')})
           ORDER BY thought_id, synonym`,
        )
        .all(...part) as Array<{ thought_id: string; synonym: string }>;
      for (const r of rows) {
        const list = synonymsById.get(r.thought_id);
        if (list) list.push(r.synonym);
        else synonymsById.set(r.thought_id, [r.synonym]);
      }
    }
    for (const [id, hit] of byId) {
      hit.synonyms = synonymsById.get(id) ?? [];
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

/** Result of the cheap blocking gate ({@link findBlockingDuplicate}). */
export interface BlockingDuplicateMatch {
  id: string;
  matched_on: 'title' | 'synonym';
  /** The existing thought's literal synonym that matched (`matched_on: 'synonym'`). */
  matched_synonym?: string;
}

/**
 * Blocking duplicate of a proposed thought title — the cheap, direct counterpart
 * of {@link findDuplicates} used by the write gate (задача bf9f46bd, ошибка
 * 9f4c0793).
 *
 * A match blocks creation only when BOTH hold:
 *   - it is an exact (normalised) match — the existing thought's `title_norm`
 *     equals the proposed title, or one of its LITERAL (no `*`) synonyms does;
 *   - the matched thought has the SAME type as the proposed one (`null` on both
 *     sides counts as the same type — both untyped).
 *
 * Wildcard-mask matches, partial matches and exact matches at a different type
 * do NOT block: they are reported as candidates instead (see
 * {@link findDuplicates}). The wildcard mask is by construction a
 * wordform/prefix match, never an exact name, so a literal requirement on the
 * synonym side is explicit here (`NOT LIKE '%*%'`).
 *
 * Unlike {@link findDuplicates}, this gate NEVER builds wildcard regexes or runs
 * LIKE scans: both lookups are exact-equality probes served by
 * `idx_thoughts_title_norm` / `idx_synonyms_norm`, i.e. microseconds even on a
 * network with thousands of thoughts. That is what removes the second heavy
 * duplicate call from `upsertThoughtBundle`.
 *
 * Attribution trap (why this cannot be derived from `findDuplicates` hits): a
 * `DuplicateHit`'s `matched_on`/`matched_synonym` describe the side of the
 * EXISTING thought and do not say which proposed term matched. An exact match of
 * a proposed SYNONYM against another thought's title would surface as
 * `matched_on: 'title'` and wrongly block. Only the proposed TITLE is checked
 * here, and synonyms are checked against the proposed title as well — exactly
 * the semantics of the full gate.
 */
export function findBlockingDuplicate(
  ndb: NetworkDb,
  title: string,
  typeId: string | null,
): BlockingDuplicateMatch | undefined {
  const n = norm(title);
  if (n === '') return undefined;
  // Strongest tier first: exact same-type title_norm (indexed point lookup).
  const titleRow = ndb
    .prepare(
      'SELECT id FROM thoughts_v WHERE title_norm = ? AND marked_for_deletion = 0 AND type_id IS ? LIMIT 1',
    )
    .get(n, typeId) as { id: string } | undefined;
  if (titleRow !== undefined) return { id: titleRow.id, matched_on: 'title' };
  // Exact same-type LITERAL synonym (indexed point lookup). A stored `*`-mask
  // synonym never blocks, matching the full gate's `includes('*')` rule.
  const synRow = ndb
    .prepare(
      `SELECT t.id AS id, ts.synonym AS synonym
       FROM thought_synonyms_v ts JOIN thoughts_v t ON t.id = ts.thought_id
       WHERE ts.synonym_norm = ? AND ts.synonym NOT LIKE '%*%'
         AND t.marked_for_deletion = 0 AND t.type_id IS ?
       ORDER BY ts.synonym LIMIT 1`,
    )
    .get(n, typeId) as { id: string; synonym: string } | undefined;
  if (synRow !== undefined) {
    return { id: synRow.id, matched_on: 'synonym', matched_synonym: synRow.synonym };
  }
  return undefined;
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

/** A candidate thought with its matcher patterns. */
interface MentionCandidate {
  id: string;
  title: string;
  active: boolean;
  patterns: MentionScanPattern[];
}

/**
 * One matcher pattern of a scan candidate: the raw term (a compound-title
 * part or a synonym) and its literal prefilter markers. The matcher regex
 * itself is not stored here — see {@link scanRegexFor}: compiling a fresh
 * Unicode regex for every pattern×text pair is what used to freeze the whole
 * event loop for tens of seconds on a 700-thought network (the §21 scan is
 * fully synchronous), so regex work is bounded by the shared compile cache,
 * and most patterns never run a regex at all — the markers reject them first.
 */
interface MentionScanPattern {
  term: string;
  /** 0 — compound-title part (§2.2.3), 1 — literal synonym, 2 — wildcard synonym. */
  priority: number;
  markers: MentionPrefilterMarkers;
}

/**
 * Cross-scan cache of global matcher regexes, keyed by the raw pattern term.
 * A scan is repeated on every comment view redraw, and the terms are stable
 * between edits, so a compile is paid at most once per process per term
 * (instead of once per pattern×text pair, or even once per scan). The cache
 * is capped; when full it is cleared wholesale — terms are cheap to recompile
 * and a per-entry LRU would cost more than it saves. Shared `RegExp` objects
 * are safe here: the scan is synchronous, and `lastIndex` is reset before
 * every use.
 */
const scanRegexCache = new Map<string, RegExp>();
const SCAN_REGEX_CACHE_MAX = 8192;

/** Returns the global matcher for `term`, compiling it at most once per process. */
function scanRegexFor(term: string): RegExp {
  let re = scanRegexCache.get(term);
  if (re === undefined) {
    if (scanRegexCache.size >= SCAN_REGEX_CACHE_MAX) scanRegexCache.clear();
    re = new RegExp(synonymPatternSource(term), 'iug');
    scanRegexCache.set(term, re);
  }
  return re;
}

/** Builds one scan pattern: term + prefilter markers, regex comes from the cache. */
function makeScanPattern(term: string, priority: number): MentionScanPattern {
  return { term, priority, markers: mentionPrefilterMarkers(term) };
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
    const patterns: MentionScanPattern[] = [];
    for (const part of splitCompoundTitle(t.title)) {
      patterns.push(makeScanPattern(part, 0));
    }
    for (const syn of synonymsByThought.get(t.id) ?? []) {
      patterns.push(makeScanPattern(syn, syn.includes('*') ? 2 : 1));
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
 * docs/02-data-model.md §3.2); both go through the same pattern semantics
 * ({@link synonymPatternSource}), since it already implements the exact
 * word-boundary/adjacency rules for literal terms too.
 *
 * Performance: per text, every pattern first passes a cheap conservative
 * prefilter ({@link mentionPrefilterPass} — folded word-token set + folded
 * substring markers), and only surviving patterns run the regex. Matcher
 * regexes come from a shared compile cache ({@link scanRegexFor}) and their
 * `lastIndex` is reset before every pass — see {@link MentionScanPattern}.
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
    // Per-text prefilter inputs, computed once: the folded text for
    // substring markers and the folded word-token set for word markers.
    const foldedText = foldCase(text);
    const foldedWords = new Set(splitMentionWords(text).map(foldCase));
    for (const candidate of candidates) {
      for (const pattern of candidate.patterns) {
        if (!mentionPrefilterPass(pattern.markers, foldedText, foldedWords)) continue;
        const re = scanRegexFor(pattern.term);
        re.lastIndex = 0;
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
