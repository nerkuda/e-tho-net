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
 *    element and every inline construct carries source offsets as `data-`
 *    attributes. Renderer-owned constructs (`==…==`, `<u>`, wiki-link) and the
 *    standard markdown-it inline constructs (`**strong**`, `*em*`, `` `code` ``,
 *    `~~s~~`) are all annotated — the latter by capturing the delimiter
 *    positions the built-in inline rules consume, still without a second parse
 *    (задача `86598085`). The attributes are:
 *    {@link MD_SOURCE_START_ATTR} / {@link MD_SOURCE_END_ATTR} — the range of
 *    the construct's VISIBLE text (a click inside maps into it 1:1);
 *    {@link MD_SOURCE_AFTER_ATTR} — the offset right AFTER the construct
 *    (including its closing markup), used as an anchor for the text that
 *    follows it; {@link MD_SOURCE_LEAF_ATTR} — marks a construct whose text is
 *    a verbatim source slice. `<br>` nodes (soft/hard breaks) carry only the
 *    after-anchor. Offsets are absolute positions in the very string passed to
 *    {@link renderMarkdown} (the caller's `body_md`, CRLF included).
 * 2. **View side.** {@link sourceOffsetFromCaret} turns a DOM caret position
 *    into a `body_md` offset. It anchors on the nearest preceding
 *    `data-md-after` (`after + <characters since that anchor>`), or on the
 *    construct start when there is none, so markdown markup of preceding
 *    constructs does not disturb the count; escapes/entities are corrected by
 *    {@link MD_SOURCE_SHIFT_ATTR} (see below). The package stays DOM-free — the
 *    helper works on a minimal structural interface a real `Element`/`Text`
 *    satisfies.
 *
 * Granularity. Block ranges are exact for their content start (line-leading
 * markup — heading hashes, list bullets, quotes, task boxes — is skipped).
 * Inline constructs owned by the renderer AND the standard emphasis / code /
 * strikethrough spans get exact ranges and after-anchors; the delimiter
 * positions are captured from the built-in inline rules as they tokenize, so
 * no second parser is introduced. Markdown links and images are still NOT
 * annotated (their rendered text is a label that may differ from the source
 * label coordinates); text after such a construct inside one block therefore
 * keeps the block-anchored approximation.
 *
 * A construct is marked `data-md-leaf` (verbatim 1:1 text) only when it has no
 * annotated descendant: nested constructs (`==a [[Мысль]] b==`,
 * `**a *b* c**`) and constructs containing a soft/hard break
 * (`**a\nb**` → `<br>`, zero rendered characters) are handled through their
 * descendants' after-anchors instead (задача `86598085`, замечание верификатора
 * проверки `ba68771d`).
 *
 * Escapes and HTML entities inside a construct (`**a \* b**`, `**a &amp; b**`)
 * render shorter than their source slice, so a plain `range.start + <chars>`
 * mapping would drift (задача `86598085`; ошибки `1b9cf949`, `d2ad1345`).
 * markdown-it keeps those runs as `text_special` tokens — `markup` = the whole
 * source run, `content` = the rendered text — until its `text_join` core rule
 * merges them. Our core rule runs right after `inline` (before `text_join`), so
 * it records the difference as {@link MD_SOURCE_SHIFT_ATTR} on ANY annotated
 * inline construct, leaf or not: a list of `<renderedBoundary>:<delta>` entries.
 * The resolver adds a delta once the caret moves past the shortened run — in
 * the leaf case from the construct start, in the anchor case only for entries
 * strictly after the nearest preceding `data-md-after` anchor (so a shortened
 * run absorbed by an anchor is not counted twice, ошибка `d2ad1345`). To keep
 * the rendered boundaries exact for an anchored construct, the shift map also
 * counts the visible text of nested `code_inline` / `wiki_link` children (their
 * text is not a `text` token of the construct). No extra element wraps the
 * text — only one more `data-` attribute under `sourceMap`, so the default
 * output stays byte-for-byte.
 *
 * An embedded inline HTML comment (`**a <!-- c --> b**`) is dropped by the
 * `html_comment` inline rule, but under `sourceMap` that rule leaves a
 * zero-length `text_special` marker token where the comment stood (ошибка
 * `29aa3108`). Its `markup` holds the comment source and its `content` is empty,
 * so `constructShiftEntries` records a `hidden` entry whose delta is the comment
 * length, while `text_join` merges the empty content away and the output stays
 * unchanged. Because the run renders ZERO characters, its boundary can coincide
 * with the base anchor, so a hidden entry is applied inclusively at `at` (see
 * {@link sourceOffsetFromCaret}). The block element likewise gets its own
 * `data-md-shift` for escaped/entity/comment runs in ordinary text outside any
 * construct, where it is the nearest annotated ancestor.
 *
 * A shift entry is recorded ONLY for a run at the map owner's own text level:
 * the rendered cursor walks nested constructs too (to stay aligned with the
 * resolver), but a run inside a nested construct is left to that construct's
 * own `data-md-shift` / `data-md-after` anchor. Recording it in the outer map as
 * well would double-count it whenever the nested anchor is the base — most
 * visibly for a zero-render `hidden` comment at the end of a nested construct
 * (регресс проверки `0602db42`: `**a <!--c-->** tail` давало 23 вместо 15).
 *
 * Honest limits (out of scope of the source map, задача `ba68771d`):
 *
 * - A markdown link or image inside a construct (`**[a](u)**`) renders as its
 *   label, which is neither annotated nor counted as a text run, so the
 *   mapping stays approximate there. The same holds for a shortened run
 *   (escape/entity, embedded HTML comment) inside a link/image label or an
 *   autolink — those constructs carry no `data-md-*` annotation at all, so the
 *   nearest annotated ancestor is the block and the label markup drifts
 *   (отдельная ошибка `809fb567`).
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
/**
 * `data-`attribute on an annotated inline construct or block carrying its
 * rendered→source shift map: a comma-separated list of `<renderedBoundary>:<delta>`
 * entries compensating escapes / HTML entities (and, with a trailing `!`, hidden
 * zero-render runs such as embedded HTML comments) whose source run is longer
 * than the rendered text (задача `86598085`, ошибки `1b9cf949`, `d2ad1345`,
 * `29aa3108`).
 */
export const MD_SOURCE_SHIFT_ATTR = 'data-md-shift';

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

/**
 * One rendered→source shift entry of {@link MD_SOURCE_SHIFT_ATTR}: `at` is the
 * rendered offset right after the shortened run, `delta` the source characters
 * it hides, `hidden` true for a run that renders zero characters (an embedded
 * HTML comment marker — its delta must apply AT `at`, not strictly after).
 */
interface ShiftEntry {
  at: number;
  delta: number;
  hidden: boolean;
}

/** Serializes shift entries into the `data-md-shift` attribute value. */
function serializeShiftEntries(entries: readonly ShiftEntry[]): string {
  return entries.map((e) => (e.hidden ? `${e.at}:${e.delta}!` : `${e.at}:${e.delta}`)).join(',');
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

/**
 * Inline construct token types that MAY carry {@link MD_SOURCE_LEAF_ATTR} —
 * their visible text is a verbatim source slice when they own no annotated
 * descendants. `wiki_link` is absent on purpose: its renderer emits the leaf
 * attribute itself (the span body is always verbatim).
 */
const LEAF_INLINE_TYPES = new Set<string>([
  'mark_open',
  'u_open',
  'strong_open',
  'em_open',
  's_open',
  'code_inline',
]);

/**
 * True when `token` (at `children[i]`) owns a descendant carrying a source
 * annotation — either a visible-text range (`mdRange`) or an after-anchor
 * (`mdAfter`, e.g. a soft/hard break rendered as `<br>`). Such a construct is
 * NOT a verbatim source slice: its rendered text omits the descendant's markup
 * (or the zero-width `<br>`), so the leaf shortcut would drift — mapping must
 * go through the descendant anchors instead.
 */
function hasAnnotatedDescendant(children: readonly Token[], i: number): boolean {
  const level = children[i]!.level;
  for (let j = i + 1; j < children.length; j++) {
    const other = children[j]!;
    if (other.level <= level) break;
    const meta = other.meta as RangeCarrier | null;
    if (meta?.mdRange !== undefined || meta?.mdAfter !== undefined) return true;
  }
  return false;
}

/**
 * Rendered→source shift map of an annotated inline construct: markdown-it
 * renders escapes (`\*` → `*`) and HTML entities (`&amp;` → `&`) as
 * `text_special` tokens whose `markup` (source run) is longer than their
 * `content` (rendered text), so the construct's rendered length is smaller than
 * its source slice. Returns ascending `{ at, delta, hidden }` entries — `at` is
 * the rendered offset right after the shortened run, `delta` the number of
 * source characters hidden there.
 *
 * The rendered cursor counts every run that contributes visible text anywhere
 * inside the construct — `text` / `text_special` (nested constructs included)
 * plus `code_inline` / `wiki_link`, whose visible text is held by the token
 * itself rather than by a `text` child — but a delta is only RECORDED for runs
 * at the construct's own text level. A run inside a nested construct belongs to
 * that construct's own map / `data-md-after` anchor, so recording it here too
 * would double-count it when the anchor is the base. Constructs that own none
 * of these runs (a link/image label) are honest limits (see the module head).
 *
 * `hidden` marks a run that renders ZERO characters but occupies source — the
 * `text_special` marker the `html_comment` inline rule leaves for an embedded
 * HTML comment (ошибка `29aa3108`). Such a run sits at the same rendered
 * boundary as whatever precedes it, so the resolver must apply its delta at the
 * boundary INCLUSIVELY, unlike an escape whose non-zero rendered length always
 * puts `at` strictly past the base anchor. Inclusive application is safe because
 * only runs of the element's OWN text level are recorded, so a hidden run of a
 * nested construct can never be re-applied through the outer map.
 */
function constructShiftEntries(
  children: readonly Token[],
  i: number,
): ShiftEntry[] {
  const level = children[i]!.level;
  return accumulateShiftEntries(children, i + 1, level, level + 1);
}

/**
 * Shift entries of a BLOCK's inline content (ошибка `29aa3108`): escapes,
 * entities and embedded HTML comments in ordinary text outside any construct
 * are shortened too, but no inline construct carries their shift — the block
 * element is the nearest annotated ancestor then. Rendered coordinates are
 * accumulated over the WHOLE inline content (nested constructs included) so the
 * cursor matches the resolver, while a delta is recorded only for the block's
 * own runs (`level === 0`): a run inside a nested construct is absorbed by that
 * construct's `data-md-shift` / `data-md-after` and must not leak into the
 * block map (регресс проверки: комментарий в конце конструкции задваивался).
 */
function blockShiftEntries(children: readonly Token[]): ShiftEntry[] {
  return accumulateShiftEntries(children, 0, -1, 0);
}

/**
 * Walks `children` from `start` while `child.level > level`, accumulating the
 * rendered length of every text-contributing run (`text` / `text_special` /
 * `code_inline` / `wiki_link`) and recording a shift entry wherever the source
 * run is longer than the rendered text. Entries are recorded only for runs at
 * `emitLevel` (the map owner's own text level); deeper runs only advance the
 * rendered cursor.
 */
function accumulateShiftEntries(
  children: readonly Token[],
  start: number,
  level: number,
  emitLevel: number,
): ShiftEntry[] {
  const entries: ShiftEntry[] = [];
  let rendered = 0;
  for (let j = start; j < children.length; j++) {
    const other = children[j]!;
    if (other.level <= level) break;
    let renderedLength = 0;
    let sourceLength = 0;
    if (other.type === 'text') {
      renderedLength = other.content.length;
      sourceLength = renderedLength;
    } else if (other.type === 'text_special') {
      renderedLength = other.content.length;
      sourceLength = other.markup.length;
    } else if (other.type === 'code_inline') {
      // The code span's rendered text is its token content (verbatim).
      renderedLength = other.content.length;
      sourceLength = renderedLength;
    } else if (other.type === 'wiki_link') {
      // The wiki-link's visible text is its verbatim source slice, so the
      // resolved range length equals the rendered length.
      const range = (other.meta as RangeCarrier | null)?.mdRange;
      renderedLength = range === undefined ? 0 : range.end - range.start;
      sourceLength = renderedLength;
    } else {
      continue;
    }
    rendered += renderedLength;
    if (sourceLength > renderedLength && other.level === emitLevel) {
      entries.push({
        at: rendered,
        delta: sourceLength - renderedLength,
        hidden: renderedLength === 0,
      });
    }
  }
  return entries;
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
  for (let ti = 0; ti < state.tokens.length; ti++) {
    const token = state.tokens[ti]!;
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
    const children = token.children;
    for (const child of children) {
      const meta = (child.meta ?? (child.meta = {})) as RangeCarrier;
      const relative = meta.mdRelative;
      if (relative !== undefined && relative !== null) {
        const range: SourceRange = { start: cm.absOf(relative.start), end: cm.absOf(relative.end) };
        meta.mdRange = range;
        setRangeAttrs(child, range);
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
    // A construct is a leaf only when it owns no annotated descendant: with a
    // nested construct (`==a [[Мысль]] b==`, `**a *b* c**`) the verbatim
    // assumption breaks, and mapping must go through the descendant anchors.
    // The shift map, however, is attached to ANY annotated construct: an
    // escape/entity in a non-leaf construct drifts the anchor-branch fallback
    // too, so the resolver compensates it there as well (ошибка `d2ad1345`).
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (!LEAF_INLINE_TYPES.has(child.type)) continue;
      const meta = child.meta as RangeCarrier | null;
      if (meta?.mdRange === undefined) continue;
      if (!hasAnnotatedDescendant(children, i)) {
        child.attrSet(MD_SOURCE_LEAF_ATTR, '1');
      }
      const shifts = constructShiftEntries(children, i);
      if (shifts.length > 0) {
        child.attrSet(MD_SOURCE_SHIFT_ATTR, serializeShiftEntries(shifts));
      }
    }
    // The block element is the nearest annotated ancestor of ordinary text
    // outside any construct, so it needs its own shift map for escapes/entities
    // and embedded HTML comments there (ошибка `29aa3108`). The open token is
    // the one right before the inline token and already carries the block range.
    const open = state.tokens[ti - 1];
    if (open !== undefined && open.attrGet(MD_SOURCE_START_ATTR) !== null) {
      const blockShifts = blockShiftEntries(children);
      if (blockShifts.length > 0) {
        open.attrSet(MD_SOURCE_SHIFT_ATTR, serializeShiftEntries(blockShifts));
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

// ---------------------------------------------------------------------------
// Inline position capture for markdown-it's own constructs
// (strong / em / code_inline / strikethrough, задача 86598085)
// ---------------------------------------------------------------------------

/** Marker run of a delimiter-based inline construct (emphasis/strikethrough). */
interface RecordedMarker {
  /** Relative offset of the marker run start inside the inline content. */
  start: number;
  /** Number of source characters this marker token covers. */
  length: number;
}

/** Emphasis-like delimiter entry from markdown-it's inline state. */
interface InlineDelimiter {
  marker: number;
  token: number;
  end: number;
}

/**
 * Minimal structural view of markdown-it's `StateInline` the capture hooks need
 * (a real state satisfies it; kept local so the package stays DOM/parser-free).
 */
interface InlineStateLike {
  src: string;
  pos: number;
  posMax: number;
  env: unknown;
  tokens: Token[];
  delimiters: InlineDelimiter[];
  tokens_meta: Array<{ delimiters?: InlineDelimiter[] } | null>;
}

/** A markdown-it inline rule function. */
type InlineRuleFn = (state: InlineStateLike, silent: boolean) => boolean;

/** One entry of markdown-it's `ruler.__rules__` (internal but stable). */
interface InlineRuleEntry {
  name: string;
  fn: InlineRuleFn;
}

/**
 * Replaces a built-in inline rule with a wrapper, keeping its position in the
 * chain. markdown-it exposes no getter for a rule, so the internal rule list is
 * read directly (its shape is documented in `ruler.mjs`).
 */
function wrapInlineRule(
  md: MarkdownIt,
  name: string,
  wrap: (orig: InlineRuleFn) => InlineRuleFn,
): void {
  const ruler = md.inline.ruler as unknown as {
    __rules__: InlineRuleEntry[];
    __cache__: unknown;
  };
  const entry = ruler.__rules__.find((rule) => rule.name === name);
  if (entry === undefined) return;
  entry.fn = wrap(entry.fn);
  ruler.__cache__ = null;
}

/** The marker character a delimiter rule is starting on, or null. */
function delimiterMarker(state: InlineStateLike): string | null {
  const code = state.src.charCodeAt(state.pos);
  if (code === 0x2a /* * */ || code === 0x5f /* _ */ || code === 0x7e /* ~ */) {
    return String.fromCharCode(code);
  }
  return null;
}

/**
 * Records the source position of every delimiter marker token the just-run
 * rule pushed. The rule consumes a contiguous run of identical marker
 * characters starting at `start`; marker tokens are the only `text` tokens in
 * the range that begin with that character (plain text never does — `*`, `_`
 * and `~` are terminator characters), so the running cursor stays exact.
 */
function recordMarkerPositions(
  state: InlineStateLike,
  start: number,
  beforeTokens: number,
  beforeDelims: number,
  marker: string,
  out: WeakMap<Token, RecordedMarker>,
): void {
  const delimiterTokens = new Set<number>();
  let last = -1;
  for (let i = beforeDelims; i < state.delimiters.length; i++) {
    const delimiter = state.delimiters[i]!;
    delimiterTokens.add(delimiter.token);
    if (delimiter.token > last) last = delimiter.token;
  }
  if (last < 0) return;
  let cursor = start;
  for (let i = beforeTokens; i <= last; i++) {
    const token = state.tokens[i];
    if (token === undefined || token.type !== 'text') continue;
    const content = token.content;
    if (content === '' || content[0] !== marker) continue;
    if (delimiterTokens.has(i)) out.set(token, { start: cursor, length: content.length });
    cursor += content.length;
  }
}

/**
 * Converts the recorded marker positions of matched delimiter pairs into
 * relative source ranges on the OPEN token. Runs in `ruler2` right after the
 * emphasis/strikethrough post-processing has turned marker tokens into
 * `strong_open` / `em_open` / `s_open`.
 */
function applyDelimiterPairs(
  state: InlineStateLike,
  positions: WeakMap<Token, RecordedMarker>,
): void {
  const lists: InlineDelimiter[][] = [state.delimiters];
  for (const meta of state.tokens_meta) {
    if (meta?.delimiters !== undefined) lists.push(meta.delimiters);
  }
  for (const list of lists) {
    for (const delimiter of list) {
      if (delimiter.end === -1) continue;
      const closeDelimiter = list[delimiter.end];
      if (closeDelimiter === undefined) continue;
      const open = state.tokens[delimiter.token];
      const close = state.tokens[closeDelimiter.token];
      if (open === undefined || close === undefined) continue;
      const openPos = positions.get(open);
      const closePos = positions.get(close);
      if (openPos === undefined || closePos === undefined) continue;
      const markupLength = open.markup.length;
      if (markupLength === 0) continue;
      // A merged `**` open token is the SECOND of two adjacent single-char
      // marker tokens, so its markup run starts one char earlier.
      const runStart = openPos.start - Math.max(0, markupLength - openPos.length);
      const visibleStart = runStart + markupLength;
      if (visibleStart > closePos.start) continue;
      const meta = (open.meta ?? (open.meta = {})) as RangeCarrier;
      meta.mdRelative = { start: visibleStart, end: closePos.start };
      meta.mdRelativeAfter = closePos.start + markupLength;
    }
  }
}

/** Registers position capture for emphasis-like and code-span inline rules. */
function installInlineCapture(md: MarkdownIt): void {
  const positions = new WeakMap<Token, RecordedMarker>();

  for (const name of ['emphasis', 'strikethrough'] as const) {
    wrapInlineRule(md, name, (orig) => (state, silent) => {
      const start = state.pos;
      const beforeTokens = state.tokens.length;
      const beforeDelims = state.delimiters.length;
      const marker = silent || !sourceMapEnabled(state.env) ? null : delimiterMarker(state);
      const ok = orig(state, silent);
      if (ok && marker !== null) {
        recordMarkerPositions(state, start, beforeTokens, beforeDelims, marker, positions);
      }
      return ok;
    });
  }

  wrapInlineRule(md, 'backticks', (orig) => (state, silent) => {
    const start = state.pos;
    const before = state.tokens.length;
    const ok = orig(state, silent);
    if (silent || !ok || !sourceMapEnabled(state.env)) return ok;
    const token = state.tokens[state.tokens.length - 1];
    if (token === undefined || token.type !== 'code_inline' || state.tokens.length <= before) {
      return ok;
    }
    const markupLength = token.markup.length;
    const end = state.pos;
    let visibleStart = start + markupLength;
    let visibleEnd = end - markupLength;
    // markdown-it strips one leading AND trailing space of a code span when
    // both are present (CommonMark); mirror it so the range is the visible text.
    if (/^ (.+) $/.test(state.src.slice(visibleStart, visibleEnd))) {
      visibleStart += 1;
      visibleEnd -= 1;
    }
    if (visibleStart <= visibleEnd) {
      const meta = (token.meta ?? (token.meta = {})) as RangeCarrier;
      meta.mdRelative = { start: visibleStart, end: visibleEnd };
      meta.mdRelativeAfter = end;
    }
    return ok;
  });

  md.inline.ruler2.after('emphasis', 'source_map_inline', (state) => {
    if (!sourceMapEnabled(state.env)) return true;
    applyDelimiterPairs(state as unknown as InlineStateLike, positions);
    return true;
  });
}

/** Registers the source-map rule on the shared renderer. */
export function sourceMapPlugin(md: MarkdownIt): void {
  installInlineCapture(md);

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

/** Parses a shift map (`<renderedBoundary>:<delta>[!],…`) into entries. */
function parseShiftEntries(raw: string | null): ShiftEntry[] {
  if (raw === null || raw === '') return [];
  const entries: ShiftEntry[] = [];
  for (const rawPart of raw.split(',')) {
    let part = rawPart;
    const hidden = part.endsWith('!');
    if (hidden) part = part.slice(0, -1);
    const sep = part.indexOf(':');
    if (sep === -1) continue;
    const at = Number(part.slice(0, sep));
    const delta = Number(part.slice(sep + 1));
    if (Number.isFinite(at) && Number.isFinite(delta) && delta > 0) {
      entries.push({ at, delta, hidden });
    }
  }
  return entries;
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
 * The mapping anchors on the nearest preceding `data-md-after` descendant — or
 * on the construct start when there is none — and adds the characters rendered
 * since the anchor, so markdown markup of preceding constructs does not disturb
 * the count. Escapes/entities shorten the rendered text, so the
 * {@link MD_SOURCE_SHIFT_ATTR} deltas whose boundary falls strictly after the
 * anchor and no later than the caret are added on top (for a leaf construct,
 * i.e. with no anchor, the anchor is the construct start, boundary `0`). A
 * hidden delta (a zero-render run, marked with a trailing `!` in the map) is
 * added inclusively AT its boundary as well, since nothing was rendered to
 * absorb it (ошибка `29aa3108`).
 *
 * Returns `null` when no annotated ancestor exists (mapping not rendered).
 */
export function sourceOffsetFromCaret(
  node: SourceMapNode | null,
  offset: number,
): number | null {
  const found = nearestSourceRange(node);
  if (found === null || node === null) return found?.range.start ?? null;

  const caret = charsBeforeCaret(node, offset, found.node);

  // Nearest preceding after-anchor (none → anchor on the construct start).
  let baseRendered = 0;
  let baseSource = found.range.start;
  let best: RenderedAnchor | null = null;
  for (const anchor of collectAnchors(found.node)) {
    if (anchor.endRendered <= caret && (best === null || anchor.endRendered >= best.endRendered)) {
      best = anchor;
    }
  }
  if (best !== null) {
    baseRendered = best.endRendered;
    baseSource = best.after;
  }

  // Compensate escapes/entities and hidden HTML comments: the source run is
  // longer than the rendered text, so a delta applies once the caret passes the
  // shortened run — but only for runs after the base anchor, since an anchor
  // already absorbs the shift of everything up to it (and a nested construct's
  // own map covers its inside). A hidden run (zero rendered characters, e.g. an
  // embedded HTML comment) sits AT the anchor boundary, so its delta applies
  // inclusively there — nothing was rendered to absorb it (ошибка `29aa3108`).
  let shift = 0;
  const raw = typeof found.node.getAttribute === 'function'
    ? found.node.getAttribute(MD_SOURCE_SHIFT_ATTR)
    : null;
  for (const entry of parseShiftEntries(raw)) {
    const applies = entry.hidden ? entry.at >= baseRendered : entry.at > baseRendered;
    if (applies && entry.at <= caret) shift += entry.delta;
  }
  return clamp(baseSource + (caret - baseRendered) + shift, found.range);
}
