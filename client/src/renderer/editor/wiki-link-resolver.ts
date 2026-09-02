/**
 * View-mode wiki-link resolver (task R7, docs/12-wiki-id-refs.md §4).
 *
 * The shared renderer (@etn/markdown) emits empty `<span class="wiki-link"
 * data-wiki-id="<uuid>"></span>` for ID-based forms (R2). This module walks
 * the rendered DOM, collects the ids and resolves them to titles via batched
 * `etn.thoughts.resolve` calls, then writes the resolved title back into the
 * span. A small per-session cache avoids re-resolving on every view re-render.
 *
 * For cross-network links (`data-wiki-network` present) the resolver looks up
 * the network's display name lazily; if the user has no access to that
 * network, the span is left empty (no error UI — the click handler will
 * report «Сеть недоступна»).
 */

import type { ThoughtRef } from '@etn/shared';

import { WIKI_LINK_CLASS, WIKI_LINK_ID_ATTR } from '@etn/markdown';

import { etn } from '../lib/etn.js';
import { store } from '../state.js';

/** CSS class added to a span whose target thought is missing/deleted. */
export const CSS_WIKI_LINK_RESOLVED = 'wiki-link-resolved';

/** Per-session cache, keyed by `${networkId}:${thoughtId}`. */
const cache = new Map<string, { title: string; exists: boolean }>();

const RESOLVE_BATCH = 100;

/**
 * Matches ID-form wiki-links inside an HTML-escaped server snippet (the
 * backlinks/mentions snippet format): the id may be wrapped in `<mark>…` by
 * the server-side highlight, and an optional `|alias` may follow.
 * Groups: 1 = cross-network id, 2 = `<mark>`, 3 = thought id, 4 = `</mark>`,
 * 5 = `|alias`.
 */
const WIKI_ID_SNIPPET_RE =
  /\[\[(?:n:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})#|#)(<mark>)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(<\/mark>)?(\|[^\]\n]*)?\]\]/gi;

/** Local HTML escape for server-provided titles inserted into snippet text. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cacheKey(networkId: string, thoughtId: string): string {
  return `${networkId}:${thoughtId}`;
}

/** Read cached entry; returns undefined on miss. */
function getCached(networkId: string, thoughtId: string): { title: string; exists: boolean } | undefined {
  return cache.get(cacheKey(networkId, thoughtId));
}

/** Store a freshly resolved entry. */
function setCached(networkId: string, thoughtId: string, title: string, exists: boolean): void {
  cache.set(cacheKey(networkId, thoughtId), { title, exists });
}

/**
 * Split a span into a per-network map of unresolved thought ids. Cross-network
 * spans (with `data-wiki-network`) are routed to that network bucket; the
 * rest go to the caller-provided `defaultNetworkId`.
 */
function collectUnresolved(
  root: HTMLElement,
  defaultNetworkId: string,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const spans = root.querySelectorAll<HTMLElement>(`span.${WIKI_LINK_CLASS}[${WIKI_LINK_ID_ATTR}]`);
  for (const span of spans) {
    const id = span.getAttribute(WIKI_LINK_ID_ATTR);
    if (id === null || id === '') continue;
    const networkId = span.getAttribute('data-wiki-network') ?? defaultNetworkId;
    const key = cacheKey(networkId, id);
    if (cache.has(key)) continue;
    let bucket = out.get(networkId);
    if (bucket === undefined) {
      bucket = new Set();
      out.set(networkId, bucket);
    }
    bucket.add(id);
  }
  return out;
}

/** Render cached entries into the spans they belong to. */
function paintCachedSpans(root: HTMLElement, defaultNetworkId: string): void {
  const spans = root.querySelectorAll<HTMLElement>(`span.${WIKI_LINK_CLASS}[${WIKI_LINK_ID_ATTR}]`);
  for (const span of spans) {
    const id = span.getAttribute(WIKI_LINK_ID_ATTR);
    if (id === null || id === '') continue;
    const networkId = span.getAttribute('data-wiki-network') ?? defaultNetworkId;
    const entry = getCached(networkId, id);
    if (entry === undefined) continue;
    if (entry.exists) {
      span.textContent = entry.title;
      span.classList.remove('wiki-link-deleted');
      span.classList.add(CSS_WIKI_LINK_RESOLVED);
    } else if (store.state.showInactive) {
      // Inactive thought — show title in muted style, not deleted indicator.
      span.textContent = entry.title;
      span.classList.remove('wiki-link-deleted');
    } else {
      // Missing thought — leave empty (the click handler will report).
      span.textContent = '';
      span.classList.add('wiki-link-deleted');
    }
  }
}

/**
 * Resolve a single batch of ids for one network. Errors are silently swallowed
 * — the resolver is best-effort; spans stay empty on failure and the user
 * can still click to learn the reason.
 */
async function resolveBatch(networkId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const refs: ThoughtRef[] = await etn.thoughts.resolve(networkId, ids.slice(0, RESOLVE_BATCH));
    for (const id of ids.slice(0, RESOLVE_BATCH)) {
      const ref = refs.find((r) => r.id === id);
      if (ref === undefined) {
        setCached(networkId, id, '', false);
      } else {
        setCached(networkId, id, ref.title, ref.active);
      }
    }
  } catch {
    // Best-effort: cache stays empty for these ids.
  }
}

/**
 * Pure replacement of ID-form wiki-links in an HTML-escaped snippet with
 * display names. `lookup` provides resolved entries (see {@link getCached});
 * a missing/deleted thought renders as `…` — the raw id never reaches the
 * screen. A server-side `<mark>` highlight around the id is preserved on the
 * substituted name.
 */
export function substituteWikiIdsInSnippet(
  snippet: string,
  defaultNetworkId: string,
  lookup: (networkId: string, thoughtId: string) => { title: string; exists: boolean } | undefined,
): string {
  const re = new RegExp(WIKI_ID_SNIPPET_RE.source, 'gi');
  return snippet.replace(re, (match, ...args: unknown[]) => {
    const net = args[0] as string | undefined;
    const openMark = args[1] as string | undefined;
    const id = (args[2] as string).toLowerCase();
    const alias = args[4] as string | undefined;
    const networkId = net?.toLowerCase() ?? defaultNetworkId;

    let text: string;
    if (alias !== undefined && alias.length > 1) {
      // Алиас уже HTML-эскейпнут (часть серверного сниппета).
      text = alias.slice(1);
    } else {
      const entry = lookup(networkId, id);
      text = entry !== undefined && entry.title !== '' ? escapeHtml(entry.title) : '…';
    }
    return openMark !== undefined ? `<mark>${text}</mark>` : text;
  });
}

/** Синхронная подстановка имён по текущему кешу (без сетевых запросов). */
export function paintWikiIdsInSnippet(snippet: string, defaultNetworkId: string): string {
  return substituteWikiIdsInSnippet(snippet, defaultNetworkId, getCached);
}

/** Collect snippet ids not yet present in the cache, grouped by network. */
function collectSnippetIds(snippet: string, defaultNetworkId: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = new RegExp(WIKI_ID_SNIPPET_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    const id = m[3]!.toLowerCase();
    const networkId = m[1]?.toLowerCase() ?? defaultNetworkId;
    if (cache.has(cacheKey(networkId, id))) continue;
    let bucket = out.get(networkId);
    if (bucket === undefined) {
      bucket = new Set();
      out.set(networkId, bucket);
    }
    bucket.add(id);
  }
  return out;
}

/**
 * Заменяет ID-формы wiki-ссылок в HTML-эскейпнутом сниппете на имена мыслей:
 * сначала подставляет всё, что уже в сессионном кеше, затем дорезолвивает
 * остальное батчем `etn.thoughts.resolve` (тот же кеш, что и у view-резолвера).
 */
export async function resolveWikiIdsInSnippet(snippet: string, defaultNetworkId: string): Promise<string> {
  const unresolved = collectSnippetIds(snippet, defaultNetworkId);
  if (unresolved.size > 0) {
    await Promise.all([...unresolved].map(([netId, ids]) => resolveBatch(netId, [...ids])));
  }
  return paintWikiIdsInSnippet(snippet, defaultNetworkId);
}

/**
 * Resolve wiki-link spans inside `root` to their thought titles. Safe to call
 * repeatedly — cached entries are reused; new spans trigger a single batched
 * `etn.thoughts.resolve` per network.
 *
 * @param root Container DOM element (already populated with `body_html`).
 * @param networkId Network whose tokens default to (when no
 *   `data-wiki-network` attribute is present).
 */
export async function resolveWikiLinksInDom(root: HTMLElement, networkId: string): Promise<void> {
  // First, paint anything we already know about.
  paintCachedSpans(root, networkId);
  // Then collect the rest and fetch.
  const unresolved = collectUnresolved(root, networkId);
  if (unresolved.size === 0) return;
  const tasks: Promise<void>[] = [];
  for (const [netId, ids] of unresolved) {
    tasks.push(resolveBatch(netId, [...ids]));
  }
  await Promise.all(tasks);
  paintCachedSpans(root, networkId);
}

/**
 * Drop cached entries for one thought id (all networks). Called from the
 * realtime handler for `thought.deleted` to invalidate stale titles.
 */
export function invalidateWikiLinkCache(thoughtId: string): void {
  for (const key of [...cache.keys()]) {
    if (key.endsWith(`:${thoughtId}`)) cache.delete(key);
  }
}

/**
 * Update cached entries for one thought id (all networks). Called from the
 * realtime handler for `thought.updated` to refresh titles without a refetch.
 */
export function refreshWikiLinkCache(thoughtId: string, title: string, active: boolean): void {
  for (const [key] of cache) {
    if (key.endsWith(`:${thoughtId}`)) {
      cache.set(key, { title, exists: active });
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy name-target lookup (shared by navigation and hover preview)
// ---------------------------------------------------------------------------

/** A legacy `[[имя|текст]]` link resolved by name to a thought. */
export interface LegacyWikiTargetHit {
  thoughtId: string;
  title: string;
}

/**
 * Resolves a legacy name-only wiki-link target with the ONE lookup both the
 * click navigation (`openWikiTarget` in `editor/wiki-link.ts`) and the
 * Ctrl-hover preview (`resolveWikiLegacyNameContent` in
 * `lib/hover-preview.ts`) use: FTS `scope=names`, exact title match first,
 * else the first hit — so what the preview shows is exactly what a click
 * would open. Lives here (not in either consumer) because hover-preview must
 * not import `editor/wiki-link.ts` (module cycle, see its doc comment), while
 * both already import this module. Returns `null` when nothing matches;
 * API errors propagate to the caller (each consumer has its own error UX).
 */
export async function searchLegacyWikiTarget(
  networkId: string,
  name: string,
): Promise<LegacyWikiTargetHit | null> {
  const res = await etn.thoughts.search(networkId, { q: name, scope: 'names', limit: 10 });
  const hit = res.by_names.find((h) => h.title === name) ?? res.by_names[0];
  if (hit === undefined) return null;
  return { thoughtId: hit.thought_id, title: hit.title };
}

/** Test-only hook. */
export const __testing = { cache, RESOLVE_BATCH, substituteWikiIdsInSnippet, collectSnippetIds };
