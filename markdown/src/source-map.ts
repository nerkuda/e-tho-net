/**
 * Source-position mapping of the single renderer (задача `ba68771d`, ТП1;
 * ADR [[#ee4e721b]], требование [[#41621f41]]).
 *
 * The renderer annotates rendered nodes with the character range of the source
 * they came from, and the client field maps a click position back to an offset
 * in `body_md` WITHOUT parsing markdown a second time (the единый рендерер
 * rule of the ADR). The contract has two halves:
 *
 * 1. **Rendered side.** With the opt-in `sourceMap` render option every block
 *    element and every inline construct the renderer owns (`==…==`, `<u>`,
 *    wiki-link) carries two attributes:
 *    {@link MD_SOURCE_START_ATTR} / {@link MD_SOURCE_END_ATTR} — `[start, end)`
 *    character offsets into the source string. The offsets are absolute
 *    positions in the very string passed to {@link renderMarkdown}
 *    (LF-normalised lines counted as-is), so the field can slice `body_md`.
 * 2. **View side.** {@link sourceOffsetFromCaret} walks a DOM caret position up
 *    to the nearest annotated element and turns it into a `body_md` offset:
 *    `range.start + <characters before the caret inside that element>`, clamped
 *    to the element's range. The package itself stays DOM-free — the helper
 *    works on a minimal structural interface a real `Element`/`Text` satisfies.
 *
 * Granularity. Block-level ranges are exact for their content start (the
 * line-leading block markup — heading hashes, list bullets, quotes, task
 * boxes — is skipped), so plain text maps 1:1. Inline constructs owned by the
 * renderer (`==`, `<u>`, wiki-links) get their own exact ranges. Inline
 * emphasis/links are NOT annotated (markdown-it does not expose their source
 * spans without re-parsing) and therefore map through their enclosing block;
 * the mapping stays correct for the block content and never invents a parser.
 *
 * New ТП1 constructs are all covered: `==…==` and `<u>` get their own ranges,
 * a task-list item maps through its block prefix (`- [ ] `), and hidden
 * HTML-comments stay invisible while their source characters still count into
 * the offsets of the blocks around them.
 */

import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

/** `data-`attribute holding the source start offset of an annotated node. */
export const MD_SOURCE_START_ATTR = 'data-md-start';
/** `data-`attribute holding the source end offset (exclusive) of an annotated node. */
export const MD_SOURCE_END_ATTR = 'data-md-end';

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
  /** Inline-rule range, relative to the inline content (`null` = no visible text). */
  mdRelative?: RelativeSourceRange | null;
  /** Absolute source range, resolved by the core rule. */
  mdRange?: SourceRange;
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

/** End offset of the line that starts at `lineStart` (before its `\n`). */
function lineEndOf(src: string, lineStart: number): number {
  const nl = src.indexOf('\n', lineStart);
  return nl === -1 ? src.length : nl;
}

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
    const lastLine = src.slice(lastLineStart, lineEndOf(src, lastLineStart)).trimStart();
    const markup = token.markup;
    const closing = markup !== '' && lastLine.startsWith(markup);
    return { start: first, end: closing ? lastLineStart : blockEnd };
  }
  if (token.type === 'code_block') {
    // Indented code: the mapped lines ARE the content.
    return { start: skipSpaces(src, lineStart, lineEndOf(src, lineStart)), end: blockEnd };
  }

  const contentStart = skipBlockPrefix(src, lineStart, lineEndOf(src, lineStart));
  return { start: contentStart, end: blockEnd };
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

/**
 * Absolute offset of an inline token's content inside the document source.
 * The inline parser's positions are relative to `token.content`; the content is
 * normally a verbatim slice of the document, so a bounded `indexOf` from the
 * block's first line locates it exactly.
 */
function inlineBaseOffset(src: string, lineStarts: readonly number[], token: Token): number {
  const map = token.map;
  const from = map !== null ? (lineStarts[map[0]!] ?? 0) : 0;
  if (token.content === '') return from;
  const idx = src.indexOf(token.content, from);
  return idx === -1 ? from : idx;
}

/** Attaches `[start, end)` as data-attributes on a token. */
function setRangeAttrs(token: Token, range: SourceRange): void {
  token.attrSet(MD_SOURCE_START_ATTR, String(range.start));
  token.attrSet(MD_SOURCE_END_ATTR, String(range.end));
}

/**
 * markdown-it core rule: stamps `mdRange` on block tokens and converts relative
 * inline ranges (`mdRelative`, set by the renderer-owned inline rules) into
 * absolute ranges. Runs only when `env.sourceMap` is set, so the default
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
    const base = inlineBaseOffset(src, lineStarts, token);
    for (const child of token.children) {
      const meta = child.meta as RangeCarrier | null;
      const relative = meta?.mdRelative;
      if (relative === undefined || relative === null) continue;
      const range: SourceRange = { start: base + relative.start, end: base + relative.end };
      meta!.mdRange = range;
      setRangeAttrs(child, range);
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
  if (baseFence === undefined) return;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const html = baseFence(tokens, idx, options, env, self);
    if (!sourceMapEnabled(env)) return html;
    const range = (tokens[idx]!.meta as RangeCarrier | null)?.mdRange;
    return range === undefined ? html : injectRangeAttrs(html, range);
  };
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

/**
 * Converts a DOM caret position (`node` + character `offset` inside it) into an
 * offset in the markdown source, using the nearest annotated ancestor.
 *
 * The caret's text offset inside the ancestor is measured by counting the
 * characters of preceding siblings plus, for a text node, the caret offset
 * itself. The result is `range.start + charactersBefore`, clamped to the
 * ancestor's range, so a click anywhere inside a node always yields a usable
 * source offset.
 *
 * Returns `null` when no annotated ancestor exists (mapping not rendered).
 */
export function sourceOffsetFromCaret(
  node: SourceMapNode | null,
  offset: number,
): number | null {
  const found = nearestSourceRange(node);
  if (found === null) return null;
  if (node === null) return found.range.start;

  let chars = node.nodeType === TEXT_NODE ? Math.max(0, offset) : 0;
  for (let current = node; current !== null && current !== found.node; ) {
    const parent = current.parentNode;
    if (parent === null) break;
    const children = parent.childNodes;
    if (children !== null && children !== undefined) {
      for (let i = 0; i < children.length; i++) {
        const sibling = children[i]!;
        if (sibling === current) break;
        chars += sibling.textContent?.length ?? 0;
      }
    }
    current = parent;
  }
  return clamp(found.range.start + chars, found.range);
}
