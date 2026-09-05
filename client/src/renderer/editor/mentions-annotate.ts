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

import type { MentionsScanThought, Thought } from '@etn/shared';

import { requireNetworkId } from '../app.js';
import { type MenuItem, showMenuAt } from '../lib/menu.js';
import { etn } from '../lib/etn.js';
import { errText } from '../lib/dom.js';
import { notice } from '../lib/notice.js';
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

/**
 * Scans every leaf block of `container` for thought mentions and wraps the
 * matches in place. `excludeThoughtId` — typically the comment's own owner
 * thought — is never offered as a match candidate. `onInsertLink` is called
 * when the user picks «Вставить ссылку…» for a match.
 *
 * The `POST /mentions/scan` contract (docs/03-server-api.md §21) caps the
 * payload at ≤50 texts and ≤20 000 chars per request, so we slice the leaf
 * blocks into compliant batches via {@link chunkTextsForScan} and fan out
 * the requests in parallel; the per-batch results are then concatenated back
 * in the original order. Best-effort: a failed scan (validation error,
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
  const texts = units.map((u) => u.text);
  const batches = chunkTextsForScan(texts);
  const baseReq = {
    show_inactive: store.state.showInactive,
    exclude_thought_id: opts.excludeThoughtId,
  };
  void (async (): Promise<void> => {
    try {
      const responses = await Promise.all(
        batches.map((batch) =>
          etn.thoughts.mentionsScan(networkId, { ...baseReq, texts: batch }),
        ),
      );
      const allResults = responses.flatMap((r) => r.results);
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
  })();
}
