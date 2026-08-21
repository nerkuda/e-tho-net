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

/** Ancestors whose text must never be scanned/wrapped. */
const EXCLUDED_SELECTOR = 'a, code, pre, .thought-mention';

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
  // eslint-disable-next-line no-cond-assign
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
  void etn.thoughts
    .mentionsScan(networkId, {
      texts: units.map((u) => u.text),
      show_inactive: store.state.showInactive,
      exclude_thought_id: opts.excludeThoughtId,
    })
    .then((res) => {
      if (!container.isConnected) return;
      units.forEach((unit, i) => {
        if (!unit.el.isConnected) return;
        const matches = res.results[i] ?? [];
        // Apply back-to-front: extracting/wrapping a later match must not
        // shift the (node, offset) coordinates a not-yet-applied earlier
        // match relies on.
        for (let m = matches.length - 1; m >= 0; m -= 1) {
          const match = matches[m];
          if (match === undefined || match.thoughts.length === 0) continue;
          wrapMatch(unit, match.start, match.end, match.thoughts, opts.onInsertLink);
        }
      });
    })
    .catch(() => {
      // Best-effort annotation — a failed scan just leaves the text plain.
    });
}
