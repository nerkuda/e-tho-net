/**
 * Auto-annotation of thought mentions in comment view-mode text (L24,
 * docs/08-ui-spec.md §6.4, docs/03-server-api.md §21).
 *
 * Runs as a DOM post-process step after the server-rendered HTML is inserted
 * into a view (same pattern as `renderMermaidBlocks`, `md-mermaid.ts`) — the
 * shared `@etn/markdown` renderer has no knowledge of the network's thoughts,
 * and baking auto-links into cached `body_html` would invalidate every
 * comment's cache whenever any thought in the network is renamed.
 *
 * Words matching a thought's title (or a part of a compound title,
 * §2.2.3), or one of its synonyms (wildcard `*` per 02-data-model.md §3.2),
 * get wrapped in a dotted-underline `.thought-mention` span. A click opens a
 * menu: "Перейти к «…»" and "Вставить ссылку на «…»" per candidate thought
 * (≤5, grouped as a submenu when there is more than one).
 */

import type {
  MentionsScanMatch,
  MentionsScanRequest,
  MentionsScanResponse,
  MentionsScanThought,
  Thought,
} from '@etn/shared';

import { requireNetworkId } from '../app.js';
import { type MenuItem, showMenuAt } from '../lib/menu.js';
import { etn } from '../lib/etn.js';
import { errText } from '../lib/dom.js';
import { notice } from '../lib/notice.js';
import { onRealtimeEvent } from '../realtime.js';
import { store } from '../state.js';
import { openThoughtByRef } from './wiki-link.js';

/** Block-level elements treated as independent scanning units. */
const BLOCK_SELECTOR = 'p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, dd, dt';

/** `POST /mentions/scan` limits (docs/03-server-api.md §21). */
export const MENTIONS_SCAN_MAX_ITEMS = 50;
export const MENTIONS_SCAN_MAX_CHARS = 20000;

/**
 * Splits `texts` into batches that satisfy the `POST /mentions/scan` contract:
 * each batch holds at most {@link MENTIONS_SCAN_MAX_ITEMS} entries and the sum
 * of their `length` does not exceed {@link MENTIONS_SCAN_MAX_CHARS}. A single
 * text longer than the char cap is placed in its own batch — the server will
 * reject it, but that one rejection is preferable to splitting a single text
 * across multiple requests (results are indexed per request, and per-text
 * matches cannot be reconstructed across batches). Order of texts is preserved
 * across batches. Pure — exported for unit tests.
 */
export function chunkTextsForScan(texts: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const t of texts) {
    const len = t.length;
    // Close the current batch only if it's non-empty AND adding `t` would
    // violate either limit. A single oversized text lands in its own batch.
    if (
      current.length > 0 &&
      (current.length >= MENTIONS_SCAN_MAX_ITEMS || currentChars + len > MENTIONS_SCAN_MAX_CHARS)
    ) {
      out.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(t);
    currentChars += len;
  }
  if (current.length > 0) out.push(current);
  return out;
}

// ---------------------------------------------------------------------------
// Scan cache + sequential batch orchestration (server-freeze amplifier fix)
// ---------------------------------------------------------------------------

/** Cache size bound; a full cache is cleared wholesale (see {@link MentionsScanCache}). */
const SCAN_CACHE_MAX_ENTRIES = 500;
/** Entry lifetime, ms — bounds staleness from edits this client made itself. */
const SCAN_CACHE_TTL_MS = 60_000;

/** Everything a `POST /mentions/scan` result depends on besides the text. */
export interface MentionsScanScope {
  networkId: string;
  showInactive: boolean;
  excludeThoughtId: string | undefined;
}

/** One cache entry: the per-text matches plus the moment they were produced. */
interface CacheEntry {
  at: number;
  matches: MentionsScanMatch[];
}

/**
 * Results cache of `POST /mentions/scan`: text → per-text matches, keyed by
 * everything the result depends on ({@link MentionsScanScope} plus the text).
 * Every comment view render fires {@link annotateMentions}, so without a cache
 * each re-render (view/edit toggle, reopening a thought) re-scanned the same
 * texts on the server — under a slow scan this piled the whole client request
 * queue behind repeat scans.
 *
 * Invalidation:
 *  - realtime `thought.created/updated/deleted` clears the cache — the
 *    candidate set (titles, synonyms, active flags) changed;
 *  - a network switch clears it ({@link noteNetwork});
 *  - entries expire after {@link SCAN_CACHE_TTL_MS}: the applier drops
 *    own-client realtime echoes (04-realtime.md §5), so a title/synonym edit
 *    made in THIS client produces no event the renderer could hear — the TTL
 *    bounds how long annotations may lag behind such own edits.
 *
 * Bounded: at {@link SCAN_CACHE_MAX_ENTRIES} entries the map is cleared
 * wholesale — scan results are cheap to rebuild, LRU bookkeeping is not worth
 * the complexity. Pure (no DOM), exported for unit tests.
 */
export class MentionsScanCache {
  private readonly entries = new Map<string, CacheEntry>();
  private networkId: string | null = null;

  constructor(
    private readonly maxEntries: number = SCAN_CACHE_MAX_ENTRIES,
    private readonly ttlMs: number = SCAN_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Composite entry key: scope + text. */
  private key(scope: MentionsScanScope, text: string): string {
    return `${scope.networkId}\u0000${scope.showInactive ? '1' : '0'}\u0000${scope.excludeThoughtId ?? ''}\u0000${text}`;
  }

  /**
   * Clears the cache when the network changed. Entries of other networks are
   * unreachable through the key anyway; this only stops them from sitting in
   * memory.
   */
  public noteNetwork(networkId: string): void {
    if (this.networkId === networkId) return;
    this.networkId = networkId;
    this.entries.clear();
  }

  /** Cached matches for the text, or `undefined` on a miss/expired entry. */
  public get(scope: MentionsScanScope, text: string): MentionsScanMatch[] | undefined {
    const key = this.key(scope, text);
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.matches;
  }

  /** Stores the matches; a full cache is cleared wholesale (bounded memory). */
  public set(scope: MentionsScanScope, text: string, matches: MentionsScanMatch[]): void {
    if (this.entries.size >= this.maxEntries) this.entries.clear();
    this.entries.set(this.key(scope, text), { at: this.now(), matches });
  }

  /** Drops everything (realtime candidate-set change). */
  public clear(): void {
    this.entries.clear();
  }
}

/** The `etn.thoughts.mentionsScan` call shape, injectable for unit tests. */
export type MentionsScanFn = (request: MentionsScanRequest) => Promise<MentionsScanResponse>;

/**
 * Resolves the matches of `texts` through {@link cache} and the server: cache
 * misses are batched by {@link chunkTextsForScan} and sent SEQUENTIALLY (one
 * `await` per batch) — the previous `Promise.all` fan-out turned every server
 * hiccup into a full client-queue stall. Results are returned aligned with
 * `texts` by index. A failed scan rejects; the caller keeps the best-effort
 * contract (plain text). Pure (no DOM), exported for unit tests.
 */
export async function scanMentionsTexts(
  scan: MentionsScanFn,
  cache: MentionsScanCache,
  scope: MentionsScanScope,
  texts: readonly string[],
): Promise<MentionsScanMatch[][]> {
  cache.noteNetwork(scope.networkId);
  const results: (MentionsScanMatch[] | undefined)[] = texts.map((t) => cache.get(scope, t));
  const missingIdx: number[] = [];
  const missingTexts: string[] = [];
  texts.forEach((text, i) => {
    if (results[i] === undefined) {
      missingIdx.push(i);
      missingTexts.push(text);
    }
  });

  let offset = 0;
  for (const batch of chunkTextsForScan(missingTexts)) {
    const response = await scan({
      show_inactive: scope.showInactive,
      exclude_thought_id: scope.excludeThoughtId,
      texts: batch,
    });
    batch.forEach((text, j) => {
      const matches = response.results[j] ?? [];
      cache.set(scope, text, matches);
      results[missingIdx[offset + j]!] = matches;
    });
    offset += batch.length;
  }
  return results.map((r) => r ?? []);
}

/** Ancestors whose text must never be scanned/wrapped. */
const EXCLUDED_SELECTOR = 'a, code, pre, .wiki-link, .thought-mention';

/** A scanning unit: one leaf block element plus its eligible flat text. */
interface TextUnit {
  el: HTMLElement;
  text: string;
  /** Eligible text nodes, in document order, with their offset range in `text`. */
  nodes: Array<{ node: Text; start: number; end: number }>;
}

/** Picks leaf block elements (no nested block element of the same kind). */
function collectLeafBlocks(root: HTMLElement): HTMLElement[] {
  const all = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
  return all.filter((el) => el.querySelector(BLOCK_SELECTOR) === null);
}

/** Walks `root`, collecting text nodes outside of any `EXCLUDED_SELECTOR` ancestor. */
function collectEligibleTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return (node as Element).matches(EXCLUDED_SELECTOR)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      }
      return node.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const out: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

function buildTextUnit(el: HTMLElement): TextUnit {
  let text = '';
  const nodes: TextUnit['nodes'] = [];
  for (const node of collectEligibleTextNodes(el)) {
    const start = text.length;
    text += node.data;
    nodes.push({ node, start, end: start + node.data.length });
  }
  return { el, text, nodes };
}

/**
 * Finds the index of the range covering `offset` in a list of consecutive,
 * non-overlapping `[start, end]` ranges (as produced by concatenating text
 * node lengths in document order). Pure — no DOM — so it's unit-testable
 * without a document; {@link pointAt} is the thin DOM-specific wrapper.
 */
export function findRangeAtOffset(
  ranges: ReadonlyArray<{ start: number; end: number }>,
  offset: number,
): number | null {
  for (let i = 0; i < ranges.length; i += 1) {
    const r = ranges[i]!;
    if (offset >= r.start && offset <= r.end) return i;
  }
  return null;
}

/** Maps a char offset within `unit.text` to a (node, local offset) DOM point. */
function pointAt(unit: TextUnit, offset: number): { node: Text; offset: number } | null {
  const i = findRangeAtOffset(unit.nodes, offset);
  if (i === null) return null;
  const n = unit.nodes[i]!;
  return { node: n.node, offset: offset - n.start };
}

function buildActions(
  thought: MentionsScanThought,
  matchedText: string,
  onInsertLink: (thought: MentionsScanThought, matchedText: string) => void,
): MenuItem[] {
  return [
    {
      label: `Перейти к «${thought.title}»`,
      onClick: () => {
        void navigateToMention(thought);
      },
    },
    {
      label: `Вставить ссылку на «${thought.title}»`,
      onClick: () => onInsertLink(thought, matchedText),
    },
  ];
}

async function navigateToMention(thought: MentionsScanThought): Promise<void> {
  const networkId = requireNetworkId();
  let full: Thought;
  try {
    full = await etn.thoughts.get(networkId, thought.id);
  } catch (err) {
    notice(`Не удалось открыть «${thought.title}»: ${errText(err)}`, 'error');
    return;
  }
  await openThoughtByRef(full);
}

function showMentionMenu(
  event: MouseEvent,
  thoughts: MentionsScanThought[],
  matchedText: string,
  onInsertLink: (thought: MentionsScanThought, matchedText: string) => void,
): void {
  const items: MenuItem[] =
    thoughts.length === 1 && thoughts[0] !== undefined
      ? buildActions(thoughts[0], matchedText, onInsertLink)
      : thoughts.map((t) => ({ label: t.title, submenu: buildActions(t, matchedText, onInsertLink) }));
  showMenuAt(event.clientX, event.clientY, items);
}

/** Wraps one resolved span of `unit` in a `.thought-mention` element. */
function wrapMatch(
  unit: TextUnit,
  start: number,
  end: number,
  thoughts: MentionsScanThought[],
  onInsertLink: (thought: MentionsScanThought, matchedText: string) => void,
): void {
  const s = pointAt(unit, start);
  const e = pointAt(unit, end);
  if (s === null || e === null) return;
  const range = document.createRange();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  const matchedText = range.toString();
  if (matchedText === '') return;

  const wrapper = document.createElement('span');
  wrapper.className = 'thought-mention';
  if (thoughts.some((t) => !t.active)) wrapper.classList.add('thought-mention-inactive');
  wrapper.title = thoughts.map((t) => t.title).join(', ');
  wrapper.dataset['mentionIds'] = thoughts.map((t) => t.id).join(',');
  wrapper.appendChild(range.extractContents());
  range.insertNode(wrapper);

  wrapper.addEventListener('click', (event) => {
    event.stopPropagation();
    showMentionMenu(event, thoughts, matchedText, onInsertLink);
  });
}

/** Scan results cache shared by every annotated view. */
const scanCache = new MentionsScanCache();

/**
 * Serializes scan sequences: concurrent comment renders (e.g. the permanent
 * comment plus several chronological ones mounting together) queue behind each
 * other instead of fanning out parallel `/mentions/scan` request waves. The
 * chained job never rejects (best-effort), so the chain stays healthy.
 */
let scanChain: Promise<void> = Promise.resolve();

let invalidationWired = false;

/** Wires the realtime invalidation of {@link scanCache} once (first use). */
function wireCacheInvalidation(): void {
  if (invalidationWired) return;
  invalidationWired = true;
  onRealtimeEvent((evt) => {
    if (
      evt.type === 'thought.created' ||
      evt.type === 'thought.updated' ||
      evt.type === 'thought.deleted'
    ) {
      // The mention candidate set (titles/synonyms/active flags) changed.
      // Own-client echoes never arrive here (dropped by the applier,
      // 04-realtime.md §5) — that half is covered by the cache TTL.
      scanCache.clear();
    }
  });
}

/**
 * Scans every leaf block of `container` for thought mentions and wraps the
 * matches in place. `excludeThoughtId` — typically the comment's own owner
 * thought — is never offered as a match candidate. `onInsertLink` is called
 * when the user picks «Вставить ссылку…» for a match.
 *
 * The `POST /mentions/scan` contract (docs/03-server-api.md §21) caps the
 * payload at ≤50 texts and ≤20 000 chars per request, so the leaf blocks are
 * sliced into compliant batches via {@link chunkTextsForScan}. Repeat scans
 * of already-seen texts are served from the {@link scanCache}; misses are
 * fetched in sequential batches (see {@link scanMentionsTexts}), and the scan
 * sequences of concurrent renders queue on {@link scanChain} instead of
 * piling up parallel requests. Best-effort: a failed scan (validation error,
 * network glitch) leaves the text plain.
 */
export function annotateMentions(
  container: HTMLElement,
  opts: {
    excludeThoughtId?: string;
    onInsertLink: (thought: MentionsScanThought, matchedText: string) => void;
  },
): void {
  const blocks = collectLeafBlocks(container);
  if (blocks.length === 0) return;
  const units = blocks.map(buildTextUnit).filter((u) => u.text.trim() !== '');
  if (units.length === 0) return;

  const networkId = requireNetworkId();
  wireCacheInvalidation();
  const scope: MentionsScanScope = {
    networkId,
    showInactive: store.state.showInactive,
    excludeThoughtId: opts.excludeThoughtId,
  };
  const texts = units.map((u) => u.text);
  const run = async (): Promise<void> => {
    try {
      const allResults = await scanMentionsTexts(
        (request) => etn.thoughts.mentionsScan(networkId, request),
        scanCache,
        scope,
        texts,
      );
      if (!container.isConnected) return;
      units.forEach((unit, i) => {
        if (!unit.el.isConnected) return;
        const matches = allResults[i] ?? [];
        // Apply back-to-front: extracting/wrapping a later match must not
        // shift the (node, offset) coordinates a not-yet-applied earlier
        // match relies on.
        for (let m = matches.length - 1; m >= 0; m -= 1) {
          const match = matches[m];
          if (match === undefined || match.thoughts.length === 0) continue;
          wrapMatch(unit, match.start, match.end, match.thoughts, opts.onInsertLink);
        }
      });
    } catch {
      // Best-effort annotation — a failed scan just leaves the text plain.
    }
  };
  scanChain = scanChain.then(run);
}
