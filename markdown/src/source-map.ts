/**
 * Source-position mapping of the single renderer (задача `ba68771d`, ТП1;
 * ADR [[#ee4e721b]], требование [[#41621f41]]).
 *
 * The renderer annotates rendered nodes with the character range of the source
 * they came from, and the client field maps a click position back to an offset
 * in `body_md` WITHOUT parsing markdown a second time (the единый рендерер rule
 * of the ADR). The contract has two halves:
 *
 * 1. **Rendered side.** With the opt-in `sourceMap` render option every block
 *    element and every inline construct the renderer owns (`==…==`, `<u>`,
 *    wiki-link) carries source offsets as `data-`attributes:
 *    {@link MD_SOURCE_START_ATTR} / {@link MD_SOURCE_END_ATTR} — the range of
 *    the construct's VISIBLE text (a click inside maps into it 1:1);
 *    {@link MD_SOURCE_AFTER_ATTR} — the offset right AFTER the construct
 *    (including its closing markup), used as an anchor for the text that
 *    follows it; {@link MD_SOURCE_LEAF_ATTR} — marks a construct whose text is
 *    a verbatim source slice. `<br>` nodes (soft/hard breaks) carry only the
 *    after-anchor. Offsets are absolute positions in the very string passed to
 *    {@link renderMarkdown} (the caller's `body_md`, CRLF included).
 * 2. **View side.** {@link sourceOffsetFromCaret} turns a DOM caret position
 *    into a `body_md` offset. Inside an annotated leaf it is
 *    `range.start + <characters before the caret>`; at block level it anchors
 *    on the nearest preceding `data-md-after` (`after + <characters since that
 *    anchor>`), so markdown markup of preceding constructs does not disturb the
 *    count. The package stays DOM-free — the helper works on a minimal
 *    structural interface a real `Element`/`Text` satisfies.
 *
 * Granularity. Block ranges are exact for their content start (line-leading
 * markup — heading hashes, list bullets, quotes, task boxes — is skipped).
 * Inline constructs owned by the renderer get exact ranges and after-anchors.
 * Inline emphasis/links are NOT annotated (markdown-it does not expose their
 * spans without a second parser, which the ADR forbids): text after such a
 * construct inside one block therefore keeps the block-anchored approximation.
 */

import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

/** `data-`attribute holding the source start offset of an annotated node. */
export const MD_SOURCE_START_ATTR = 'data-md-start';
/** `data-`attribute holding the source end offset (exclusive) of a node's visible text. */
export const MD_SOURCE_END_ATTR = 'data-md-end';
/** `data-`attribute holding the source offset right AFTER a construct. */
export const MD_SOURCE_AFTER_ATTR = 'data-md-after';
/** `data-`attribute marking a node whose text is a verbatim source slice. */
export const MD_SOURCE_LEAF_ATTR = 'data-md-leaf';

/** Half-open character range in the markdown source. */
export interface SourceRange {
  /** First source character offset (inclusive). */
  start: number;
  /** Last source character offset (exclusive). */
  end: number;
}

/**
 * Source range of an inline construct relative to the inline parser's input
 * (`state.src`). Set by inline rules that own the construct and converted to
 * absolute offsets by the post-`inline` core rule below.
 */
export interface RelativeSourceRange {
  start: number;
  end: number;
}

/** Meta keys used to carry ranges through tokenization. */
interface RangeCarrier {
  /** Visible-text range, relative to the inline content (`null` = no visible text). */
  mdRelative?: RelativeSourceRange | null;
  /** Offset right after the construct, relative to the inline content. */
  mdRelativeAfter?: number | null;
  /** Absolute visible-text range, resolved by the core rule. */
  mdRange?: SourceRange;
  /** Absolute after-anchor, resolved by the core rule. */
  mdAfter?: number;
}

/** Per-render flag read from the render `env`. */
interface SourceMapEnv {
  sourceMap?: boolean;
  /**
   * The source string as passed by the caller. markdown-it normalises newlines
   * (`\r\n` → `\n`) in its own `normalize` core rule before ours runs, so we
   * take offsets against the caller's original string to keep `body_md`
   * coordinates, not the internal normalised copy.
   */
  sourceMapSource?: string;
}

/** Reads the opt-in flag from a render env. */
function sourceMapEnabled(env: unknown): boolean {
  return (env as SourceMapEnv | null | undefined)?.sourceMap === true;
}

/** The caller's source string carried by the render env, if any. */
function envSource(env: unknown): string | undefined {
  return (env as SourceMapEnv | null | undefined)?.sourceMapSource;
}

/** Character offsets of every line start (lines split on `\n`). */
export function computeLineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 0x0a) starts.push(i + 1);
  }
  return starts;
}

/** Advances `i` past spaces and tabs. */
function skipSpaces(src: string, i: number, end: number): number {
  while (i < end && (src[i] === ' ' || src[i] === '\t')) i++;
  return i;
}

/** True when `src[i..]` starts a task-list marker (`[ ]` / `[x]` / `[X]`). */
function isTaskMarker(src: string, i: number): number {
  if (src[i] !== '[') return 0;
  const mark = src[i + 1];
  if (mark !== ' ' && mark !== 'x' && mark !== 'X') return 0;
  return src[i + 2] === ']' ? 3 : 0;
}

/**
 * Skips the line-leading block markup so the returned offset points at the
 * first rendered character of a block: blockquote markers, heading hashes,
 * list bullets / ordered markers, task-list boxes and table column bars.
 *
 * This is not a markdown parser: it only strips the well-known line prefixes of
 * the block whose source line is handed to it (a paragraph never legitimately
 * starts with a list marker — markdown-it would have parsed it as a list).
 */
function skipBlockPrefix(src: string, from: number, lineEnd: number): number {
  let i = from;
  for (;;) {
    const before = i;
    i = skipSpaces(src, i, lineEnd);
    // Blockquote `>` (possibly repeated: `> >`).
    if (src[i] === '>') {
      i = skipSpaces(src, i + 1, lineEnd);
      continue;
    }
    // Heading `#`..`######`.
    if (src[i] === '#') {
      let h = i;
      while (h < lineEnd && src[h] === '#') h++;
      if (h - i <= 6 && (h >= lineEnd || src[h] === ' ' || src[h] === '\t')) {
        i = skipSpaces(src, h, lineEnd);
        continue;
      }
    }
    // Task-list box.
    const task = isTaskMarker(src, i);
    if (task > 0) {
      i = skipSpaces(src, i + task, lineEnd);
      continue;
    }
    // Table cell separator / row bar.
    if (src[i] === '|') {
      i = skipSpaces(src, i + 1, lineEnd);
      continue;
    }
    // Bullet list marker.
    if ((src[i] === '-' || src[i] === '*' || src[i] === '+') &&
      (src[i + 1] === ' ' || src[i + 1] === '\t')) {
      i = skipSpaces(src, i + 1, lineEnd);
      continue;
    }
    // Ordered list marker `1.` / `1)`.
    let n = i;
    while (n < lineEnd && src[n]! >= '0' && src[n]! <= '9') n++;
    if (n > i && (src[n] === '.' || src[n] === ')') &&
      (src[n + 1] === ' ' || src[n + 1] === '\t')) {
      i = skipSpaces(src, n + 1, lineEnd);
      continue;
    }
    // No further prefix.
    if (i === before) break;
  }
  return i;
}

/** End offset of the line that starts at `lineStart`, `\r` excluded. */
function lineContentEnd(src: string, lineStart: number): number {
  const nl = src.indexOf('\n', lineStart);
  let end = nl === -1 ? src.length : nl;
  if (end > lineStart && src[end - 1] === '\r') end--;
  return end;
}

/** End offset of the visible heading text (trailing spaces and closing `#` dropped). */
function headingContentEnd(src: string, lineStart: number, lineEnd: number): number {
  let e = lineEnd;
  while (e > lineStart && (src[e - 1] === ' ' || src[e - 1] === '\t')) e--;
  let h = e;
  while (h > lineStart && src[h - 1] === '#') h--;
  if (h < e && (h === lineStart || src[h - 1] === ' ' || src[h - 1] === '\t')) {
    e = h;
    while (e > lineStart && (src[e - 1] === ' ' || src[e - 1] === '\t')) e--;
  }
  return e;
}

/** Block token types that receive a source range. */
const RANGE_BLOCK_TYPES = new Set<string>([
  'paragraph_open',
  'heading_open',
  'blockquote_open',
  'list_item_open',
  'table_open',
  'tr_open',
  'fence',
  'code_block',
]);

/** Inline construct token types whose text is a verbatim source slice. */
const LEAF_INLINE_TYPES = new Set<string>(['mark_open', 'u_open', 'wiki_link']);

/** Absolute content range of a block token (start at first rendered char). */
function blockRange(
  src: string,
  lineStarts: readonly number[],
  token: Token,
): SourceRange | null {
  const map = token.map;
  if (map === null) return null;
  const startLine = map[0]!;
  const endLine = map[1]!;
  const lineStart = lineStarts[startLine];
  if (lineStart === undefined) return null;
  const blockEnd = lineStarts[endLine] ?? src.length;

  if (token.type === 'fence') {
    // Content lives on the lines between the opening and the closing fence.
    const first = lineStarts[startLine + 1];
    if (first === undefined || startLine + 1 >= endLine) {
      return { start: lineStart, end: blockEnd };
    }
    const lastLineStart = lineStarts[endLine - 1] ?? blockEnd;
    const lastLine = src.slice(lastLineStart, lineContentEnd(src, lastLineStart)).trimStart();
    const markup = token.markup;
    const closing = markup !== '' && lastLine.startsWith(markup);
    return { start: first, end: closing ? lastLineStart : blockEnd };
  }
  if (token.type === 'code_block') {
    // Indented code: the mapped lines ARE the content.
    return { start: skipSpaces(src, lineStart, lineContentEnd(src, lineStart)), end: blockEnd };
  }

  const contentStart = skipBlockPrefix(src, lineStart, lineContentEnd(src, lineStart));
  const end =
    token.type === 'heading_open'
      ? headingContentEnd(src, lineStart, lineContentEnd(src, lineStart))
      : blockEnd;
  return { start: contentStart, end: Math.max(contentStart, end) };
}

/**
 * Maps offsets inside an inline token's `content` to absolute offsets in the
 * source. markdown-it builds the content by normalising newlines and stripping
 * the line-leading block markup of continuation lines (`> `, list indent), so a
 * plain `indexOf` of the whole content is wrong; the map is built line by line.
 */
interface InlineContentMap {
  /** Absolute source offset of an offset inside `token.content`. */
  absOf(contentOffset: number): number;
  /** Absolute offset right after the i-th soft/hard break. */
  breakAfter(breakIndex: number): number;
}

function inlineContentMap(
  src: string,
  lineStarts: readonly number[],
  token: Token,
): InlineContentMap {
  const content = token.content;
  const lines = content.split('\n');
  const chunkAbs: number[] = [];
  const chunkStart: number[] = [];
  let acc = 0;
  const map = token.map;
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j]!;
    chunkStart.push(acc);
    let abs: number;
    const lineIdx = map !== null ? map[0]! + j : -1;
    const lineStart = lineIdx >= 0 ? lineStarts[lineIdx] : undefined;
    if (lineStart !== undefined) {
      const lineEnd = lineContentEnd(src, lineStart);
      if (line === '') {
        abs = lineStart;
      } else {
        const idx = src.indexOf(line, lineStart);
        abs = idx !== -1 && idx < lineEnd ? idx : lineStart;
      }
    } else {
      const idx = src.indexOf(line);
      abs = idx === -1 ? 0 : idx;
    }
    chunkAbs.push(abs);
    acc += line.length + (j < lines.length - 1 ? 1 : 0);
  }

  const absOf = (contentOffset: number): number => {
    if (chunkStart.length === 0) return 0;
    let o = contentOffset;
    if (o < 0) o = 0;
    if (o > content.length) o = content.length;
    let k = 0;
    for (let i = 0; i < chunkStart.length; i++) {
      if (chunkStart[i]! <= o) k = i;
      else break;
    }
    const off = o - chunkStart[k]!;
    const len = lines[k]!.length;
    return chunkAbs[k]! + (off <= len ? off : len);
  };

  const breakAfter = (breakIndex: number): number => {
    const next = breakIndex + 1;
    if (next < chunkAbs.length) return chunkAbs[next]!;
    const last = chunkAbs.length - 1;
    if (last < 0) return 0;
    return chunkAbs[last]! + lines[last]!.length;
  };

  return { absOf, breakAfter };
}

/** Attaches `[start, end)` as data-attributes on a token. */
function setRangeAttrs(token: Token, range: SourceRange): void {
  token.attrSet(MD_SOURCE_START_ATTR, String(range.start));
  token.attrSet(MD_SOURCE_END_ATTR, String(range.end));
}

/**
 * markdown-it core rule: stamps block ranges and converts the relative inline
 * ranges (`mdRelative`, `mdRelativeAfter`) into absolute offsets, adding the
 * `data-md-*` attributes. Runs only when `env.sourceMap` is set, so the default
 * pipeline output is byte-for-byte unchanged.
 */
function stampRanges(state: { src: string; tokens: Token[] }, input: string): void {
  const src = input;
  const lineStarts = computeLineStarts(src);
  for (const token of state.tokens) {
    if (RANGE_BLOCK_TYPES.has(token.type)) {
      const range = blockRange(src, lineStarts, token);
      if (range !== null) {
        const meta = (token.meta ?? (token.meta = {})) as RangeCarrier;
        meta.mdRange = range;
        setRangeAttrs(token, range);
      }
      continue;
    }
    if (token.type !== 'inline' || token.children === null) continue;
    const cm = inlineContentMap(src, lineStarts, token);
    let breaks = 0;
    for (const child of token.children) {
      const meta = (child.meta ?? (child.meta = {})) as RangeCarrier;
      const relative = meta.mdRelative;
      if (relative !== undefined && relative !== null) {
        const range: SourceRange = { start: cm.absOf(relative.start), end: cm.absOf(relative.end) };
        meta.mdRange = range;
        setRangeAttrs(child, range);
        if (LEAF_INLINE_TYPES.has(child.type)) child.attrSet(MD_SOURCE_LEAF_ATTR, '1');
      }
      const relativeAfter = meta.mdRelativeAfter;
      if (relativeAfter !== undefined && relativeAfter !== null) {
        const after = cm.absOf(relativeAfter);
        meta.mdAfter = after;
        child.attrSet(MD_SOURCE_AFTER_ATTR, String(after));
      }
      if (child.type === 'softbreak' || child.type === 'hardbreak') {
        const after = cm.breakAfter(breaks);
        breaks++;
        meta.mdAfter = after;
        child.attrSet(MD_SOURCE_AFTER_ATTR, String(after));
      }
    }
  }
}

/** Injects the source attributes into the first tag of a rendered block. */
function injectRangeAttrs(html: string, range: SourceRange): string {
  const attrs = ` ${MD_SOURCE_START_ATTR}="${range.start}" ${MD_SOURCE_END_ATTR}="${range.end}"`;
  const code = html.indexOf('<code');
  if (code !== -1) {
    const gt = html.indexOf('>', code);
    if (gt !== -1) return html.slice(0, gt) + attrs + html.slice(gt);
  }
  const pre = html.indexOf('<pre');
  if (pre !== -1) {
    const gt = html.indexOf('>', pre);
    if (gt !== -1) return html.slice(0, gt) + attrs + html.slice(gt);
  }
  return html;
}

/** Registers the source-map rule on the shared renderer. */
export function sourceMapPlugin(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'source_map', (state) => {
    if (!sourceMapEnabled(state.env)) return;
    const stateArg = state as unknown as { src: string; tokens: Token[] };
    stampRanges(stateArg, envSource(state.env) ?? stateArg.src);
  });

  // The shared renderer highlights fences inside `options.highlight`, which
  // returns the whole `<pre><code>` block — so the default fence rule skips its
  // own `renderAttrs` and the token attributes never reach the output. Inject
  // the range attributes into the returned markup instead (задача ba68771d).
  const baseFence = md.renderer.rules.fence;
  if (baseFence !== undefined) {
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const html = baseFence(tokens, idx, options, env, self);
      if (!sourceMapEnabled(env)) return html;
      const range = (tokens[idx]!.meta as RangeCarrier | null)?.mdRange;
      return range === undefined ? html : injectRangeAttrs(html, range);
    };
  }

  // Soft/hard breaks render as a hard-coded `<br>` ignoring token attributes;
  // inject the after-anchor so text following a line break maps correctly.
  for (const name of ['softbreak', 'hardbreak'] as const) {
    const base = md.renderer.rules[name];
    if (base === undefined) continue;
    md.renderer.rules[name] = (tokens, idx, options, env, self) => {
      const html = base(tokens, idx, options, env, self);
      if (!sourceMapEnabled(env)) return html;
      const after = (tokens[idx]!.meta as RangeCarrier | null)?.mdAfter;
      if (after === undefined) return html;
      // The default rule emits `<br>\n`; the trailing newline is markup-only
      // (no source character), so drop it — otherwise it shifts the rendered
      // offset of the text after the break (задача ba68771d).
      return html.replace('<br', `<br ${MD_SOURCE_AFTER_ATTR}="${after}"`).replace(/\n$/, '');
    };
  }
}

// ---------------------------------------------------------------------------
// View side: DOM caret → source offset (DOM-free, structural interface)
// ---------------------------------------------------------------------------

/** A DOM text node (`nodeType === 3`). */
export const TEXT_NODE = 3;
/** A DOM element node (`nodeType === 1`). */
export const ELEMENT_NODE = 1;

/**
 * Minimal read-only structural view of a DOM node the resolver needs. A real
 * `Node` (`Element` / `Text`) satisfies it as-is; tests can supply a tiny fake.
 */
export interface SourceMapNode {
  readonly nodeType: number;
  readonly textContent: string | null;
  readonly parentNode: SourceMapNode | null;
  readonly childNodes: ArrayLike<SourceMapNode> | null;
  getAttribute?(name: string): string | null;
}

/** Parses a `{start, end}` range from the two attribute values, or null. */
export function parseSourceRange(
  startAttr: string | null,
  endAttr: string | null,
): SourceRange | null {
  if (startAttr === null || endAttr === null) return null;
  const start = Number(startAttr);
  const end = Number(endAttr);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/** The source range of an annotated element, or null. */
function rangeOf(node: SourceMapNode): SourceRange | null {
  if (node.nodeType !== ELEMENT_NODE || typeof node.getAttribute !== 'function') return null;
  return parseSourceRange(
    node.getAttribute(MD_SOURCE_START_ATTR),
    node.getAttribute(MD_SOURCE_END_ATTR),
  );
}

/** The after-anchor of an element, or null. */
function afterOf(node: SourceMapNode): number | null {
  if (node.nodeType !== ELEMENT_NODE || typeof node.getAttribute !== 'function') return null;
  const raw = node.getAttribute(MD_SOURCE_AFTER_ATTR);
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Walks from `node` (inclusive) up the ancestor chain to the nearest annotated
 * element and returns its source range.
 */
export function nearestSourceRange(
  node: SourceMapNode | null,
): { node: SourceMapNode; range: SourceRange } | null {
  for (let current = node; current !== null; current = current.parentNode) {
    const range = rangeOf(current);
    if (range !== null) return { node: current, range };
  }
  return null;
}

/** Clamps `value` into `[range.start, range.end]`. */
function clamp(value: number, range: SourceRange): number {
  if (value < range.start) return range.start;
  if (value > range.end) return range.end;
  return value;
}

/** Rendered characters before the caret (`node` + `offset`) inside `ancestor`. */
function charsBeforeCaret(
  node: SourceMapNode,
  offset: number,
  ancestor: SourceMapNode,
): number {
  let chars = node.nodeType === TEXT_NODE ? Math.max(0, offset) : 0;
  for (let current = node; current !== null && current !== ancestor; ) {
    const parent = current.parentNode;
    if (parent === null) break;
    const children = parent.childNodes;
    if (children !== null) {
      for (let i = 0; i < children.length; i++) {
        const sibling = children[i]!;
        if (sibling === current) break;
        chars += sibling.textContent?.length ?? 0;
      }
    }
    current = parent;
  }
  return chars;
}

/** An after-anchor of a descendant, expressed in rendered characters. */
interface RenderedAnchor {
  /** Rendered characters of `ancestor` before this anchor. */
  endRendered: number;
  /** Absolute source offset right after the anchored node. */
  after: number;
}

/** Collects `data-md-after` anchors of `ancestor`'s descendants in document order. */
function collectAnchors(ancestor: SourceMapNode): RenderedAnchor[] {
  const anchors: RenderedAnchor[] = [];
  const walk = (el: SourceMapNode, pos: number): number => {
    const children = el.childNodes;
    if (children === null) return pos;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child.nodeType === TEXT_NODE) {
        pos += child.textContent?.length ?? 0;
        continue;
      }
      const after = afterOf(child);
      pos = walk(child, pos);
      if (after !== null) anchors.push({ endRendered: pos, after });
    }
    return pos;
  };
  return walk(ancestor, 0), anchors;
}

/**
 * Converts a DOM caret position (`node` + character `offset` inside it) into an
 * offset in the markdown source, using the nearest annotated ancestor.
 *
 * - Inside an annotated leaf construct the source offset is
 *   `range.start + <characters before the caret>`, clamped to the range.
 * - At block level the result anchors on the nearest preceding
 *   `data-md-after` descendant: `anchor.after + <characters since the anchor>`,
 *   so markdown markup of preceding constructs does not disturb the count.
 *
 * Returns `null` when no annotated ancestor exists (mapping not rendered).
 */
export function sourceOffsetFromCaret(
  node: SourceMapNode | null,
  offset: number,
): number | null {
  const found = nearestSourceRange(node);
  if (found === null || node === null) return found?.range.start ?? null;

  const isLeaf =
    found.node.nodeType === ELEMENT_NODE &&
    typeof found.node.getAttribute === 'function' &&
    found.node.getAttribute(MD_SOURCE_LEAF_ATTR) === '1';
  const caret = charsBeforeCaret(node, offset, found.node);
  if (isLeaf) return clamp(found.range.start + caret, found.range);

  let best: RenderedAnchor | null = null;
  for (const anchor of collectAnchors(found.node)) {
    if (anchor.endRendered <= caret && (best === null || anchor.endRendered >= best.endRendered)) {
      best = anchor;
    }
  }
  if (best === null) return clamp(found.range.start + caret, found.range);
  return clamp(best.after + (caret - best.endRendered), found.range);
}
