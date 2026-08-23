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

/** Test-only hook. */
export const __testing = { cache, RESOLVE_BATCH };
