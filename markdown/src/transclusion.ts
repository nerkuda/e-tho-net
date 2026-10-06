/**
 * Transclusion of comments (ТП2 «Трансклюзии комментариев», задача `8365f262`,
 * ADR `8c41387c`, ADR `85a7a01e`, требования `2fb33964`, `166a7555`,
 * `39e30070`).
 *
 * A transclusion reference is a markdown construct `![[#<id>]]` (the whole
 * permanent comment of a thought) or `![[#<id>#Раздел]]` (a heading section
 * together with its sub-sections). Parsing and expansion live ONLY here, in the
 * single `@etn/markdown` package (`own-transclusion-outside-package` guard);
 * server and client call {@link expandTransclusions} with their own resolver and
 * never parse `![[…]]` themselves.
 *
 * The package is pure markdown code — no DB, no DOM, no network. Source texts
 * are supplied through the injected resolver-dependency
 * {@link TransclusionResolver}:
 *
 * ```ts
 * resolveTransclusion(sourceId, sectionTitle?) => { found, body_md }
 * ```
 *
 * The resolver returns the FULL permanent comment of the source; the requested
 * section (if any) is sliced out here, inside the package. Recursion, the depth
 * limit (5) and the cycle guard are all implemented inside
 * {@link expandTransclusions}, so both callers merely provide texts.
 *
 * Expansion emits boundary markers of the ADR `85a7a01e` format (HTML comments
 * with the `etn:transclusion` prefix, one per line, fixed attribute order):
 *
 * - `<!-- etn:transclusion begin source=<uuid>[ section="…"] depth=<N> -->`
 * - `<!-- etn:transclusion end source=<uuid> depth=<N> -->`
 * - `<!-- etn:transclusion skip source=<uuid> depth=<N> reason=<cycle|depth_limit> -->`
 * - `<!-- etn:transclusion missing source=<uuid>[ section="…"] reason=<source|section> -->`
 */

/** Depth cap of the recursive expansion (requirement `166a7555`, const). */
export const TRANSCLUSION_MAX_DEPTH = 5;

/** Prefix of every boundary marker (ADR `85a7a01e`). */
export const TRANSCLUSION_MARKER_PREFIX = 'etn:transclusion';

/** UUID (8-4-4-4-12 hex with dashes) — mirrors `wiki-link.ts`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A parsed transclusion reference and its position in the source. */
export interface TransclusionRef {
  /** Verbatim source text of the reference (`![[#<id>#Раздел]]`). */
  raw: string;
  /** Source thought id, lower-cased. */
  sourceId: string;
  /** Requested section title, or `null` for the whole permanent comment. */
  section: string | null;
  /** Start offset of the reference in the source string. */
  start: number;
  /** End offset (exclusive) of the reference in the source string. */
  end: number;
}

/** Result returned by {@link TransclusionResolver}. */
export interface TransclusionResolution {
  /** `false` when the source thought (or its permanent comment) is absent. */
  found: boolean;
  /** Full permanent comment of the source; `''` when not found. */
  body_md: string;
}

/**
 * Injected text provider of the expansion. Called once per referenced source;
 * must not parse markdown itself. Receives the section title only when the
 * reference addressed a section.
 */
export type TransclusionResolver = (
  sourceId: string,
  sectionTitle?: string,
) => TransclusionResolution;

/** Options of {@link expandTransclusions}. */
export interface ExpandTransclusionsOptions {
  /** Depth cap; defaults to {@link TRANSCLUSION_MAX_DEPTH} (5). */
  maxDepth?: number;
  /**
   * Emit the ADR `85a7a01e` boundary markers around every expanded fragment.
   * `true` (default) — the marker-wrapped form MCP and the client view consume.
   * `false` — plain expanded text only: no boundary comments, no extra blank
   * lines, and absent/skipped sources contribute nothing (their links are
   * swallowed). Used by the client's «as text» clipboard commands (ТП2, задача
   * `e9f553e5`), which reuse the single parser but must not leak markers.
   */
  markers?: boolean;
}

/** Half-open character range in the source markdown. */
interface Range {
  start: number;
  end: number;
}

/** A source line with its absolute offsets (`end` excludes the line break). */
interface Line {
  start: number;
  end: number;
  text: string;
}

/** Splits a source into lines, preserving offsets and stripping CR. */
function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let i = 0;
  const len = source.length;
  for (;;) {
    const nl = source.indexOf('\n', i);
    const at = nl === -1 ? len : nl;
    let text = source.slice(i, at);
    if (text.endsWith('\r')) text = text.slice(0, -1);
    lines.push({ start: i, end: at, text });
    if (nl === -1) break;
    i = nl + 1;
  }
  return lines;
}

/** Ranges of fenced code blocks (``` / ~~~), whose content is not markdown. */
function fencedRanges(source: string): Range[] {
  const lines = splitLines(source);
  const ranges: Range[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^( {0,3})(`{3,}|~{3,})/.exec(lines[i]!.text);
    if (open === null) {
      i++;
      continue;
    }
    const fence = open[2]!;
    const ch = fence[0]!;
    const closeRe = new RegExp(`^ {0,3}${ch}{${fence.length},}[ \\t]*$`);
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j]!.text)) j++;
    const end = j < lines.length ? lines[j]!.end : source.length;
    ranges.push({ start: lines[i]!.start, end });
    i = j < lines.length ? j + 1 : lines.length;
  }
  return ranges;
}

/** Ranges of inline code spans (backtick runs) outside fenced blocks. */
function inlineCodeRanges(source: string, fenced: Range[]): Range[] {
  const ranges: Range[] = [];
  const inFence = (idx: number): boolean =>
    fenced.some((r) => idx >= r.start && idx < r.end);
  let pos = 0;
  while (pos < source.length) {
    const fencedAt = fenced.find((r) => pos >= r.start && pos < r.end);
    if (fencedAt !== undefined) {
      pos = fencedAt.end;
      continue;
    }
    if (source[pos] === '`') {
      let run = 0;
      while (source[pos + run] === '`') run++;
      const close = source.indexOf('`'.repeat(run), pos + run);
      if (close !== -1 && !inFence(close)) {
        ranges.push({ start: pos, end: close + run });
        pos = close + run;
        continue;
      }
    }
    pos++;
  }
  return ranges;
}

/** Source ranges where `![[…]]` must stay literal: code, not markdown. */
function protectedRanges(source: string): Range[] {
  const fenced = fencedRanges(source);
  return [...fenced, ...inlineCodeRanges(source, fenced)];
}

/**
 * Parses every transclusion reference of a markdown source in order.
 *
 * Recognised forms: `![[#<uuid>]]` and `![[#<uuid>#Раздел]]` (the section may
 * contain any characters except a line break; the first `#` after the id
 * separates the section title, so `C#` inside a title is preserved). Anything
 * else — a bare `[[…]]` wiki-link, a non-UUID target, an escaped `\![[…]]`, a
 * reference inside a code block or code span — is not a transclusion and is
 * returned as-is by the expansion.
 */
export function parseTransclusions(source: string): TransclusionRef[] {
  if (typeof source !== 'string') {
    throw new Error('parseTransclusions: source must be a string');
  }
  const refs: TransclusionRef[] = [];
  const protectedList = protectedRanges(source);
  const isProtected = (idx: number): boolean =>
    protectedList.some((r) => idx >= r.start && idx < r.end);

  let i = 0;
  for (;;) {
    const start = source.indexOf('![[', i);
    if (start === -1) break;
    i = start + 1;
    // Escaped `\![[…]]` stays literal markdown.
    if (start > 0 && source[start - 1] === '\\') continue;
    if (isProtected(start)) continue;
    const close = source.indexOf(']]', start + 3);
    if (close === -1) continue;
    const inner = source.slice(start + 3, close);
    if (inner.includes('\n') || inner.includes('\r')) continue;
    if (!inner.startsWith('#')) continue;
    const rest = inner.slice(1);
    const hash = rest.indexOf('#');
    const idPart = (hash === -1 ? rest : rest.slice(0, hash)).trim();
    if (!UUID_RE.test(idPart)) continue;
    const sectionRaw = hash === -1 ? '' : rest.slice(hash + 1).trim();
    refs.push({
      raw: source.slice(start, close + 2),
      sourceId: idPart.toLowerCase(),
      section: sectionRaw === '' ? null : sectionRaw,
      start,
      end: close + 2,
    });
    i = close + 2;
  }
  return refs;
}

/** ATX heading: level (1–6) and its text, `#` closers stripped. */
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/**
 * Extracts a section — the heading with the given title and all its
 * sub-sections — from a markdown source. The first matching heading wins; the
 * section ends at the next heading of the same or a higher level. Headings
 * inside fenced code blocks are ignored. Returns `null` when no such heading
 * exists (requirement `2fb33964`, задача `fc60d763`).
 */
export function extractSection(source: string, title: string): string | null {
  const wanted = title.trim().toLowerCase();
  if (wanted === '') return null;
  const lines = splitLines(source);
  const fenced = fencedRanges(source);
  const inFence = (idx: number): boolean =>
    fenced.some((r) => idx >= r.start && idx < r.end);

  let level = 0;
  let start = -1;
  let end = source.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inFence(line.start)) continue;
    const heading = HEADING_RE.exec(line.text);
    if (heading === null) continue;
    const lineLevel = heading[1]!.length;
    if (start === -1) {
      if (heading[2]!.trim().toLowerCase() === wanted) {
        level = lineLevel;
        start = line.start;
      }
      continue;
    }
    if (lineLevel <= level) {
      end = line.start;
      break;
    }
  }
  if (start === -1) return null;
  return source.slice(start, end).trimEnd();
}

/** Escapes a value for a double-quoted marker attribute (ADR `85a7a01e`). */
function escapeMarkerAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** ` section="…"` attribute, or `''` when the reference targeted no section. */
function sectionAttr(section: string | null): string {
  return section === null ? '' : ` section="${escapeMarkerAttr(section)}"`;
}

/** Wraps a block-level insertion so its markers sit on their own lines. */
function wrapBlock(source: string, start: number, end: number, block: string): string {
  const prefix = start > 0 && source[start - 1] !== '\n' ? '\n' : '';
  const suffix = end < source.length && source[end] !== '\n' ? '\n' : '';
  return `${prefix}${block}${suffix}`;
}

/**
 * Recursively expands transclusion references of every level into inline text
 * bounded by the ADR `85a7a01e` markers.
 *
 * The resolver supplies the source texts; the depth limit
 * ({@link TRANSCLUSION_MAX_DEPTH}, 5) and the cycle guard are enforced here.
 * A reference repeated in its own expansion chain is emitted as a `skip
 * reason=cycle` marker; one beyond the depth cap as `skip reason=depth_limit`;
 * an absent source (or an absent requested section) as `missing`.
 *
 * With `markers: false` the same expansion emits plain text instead: boundary
 * comments are dropped and the absent/skipped cases contribute nothing.
 *
 * @throws when `source` is not a string.
 */
export function expandTransclusions(
  source: string,
  resolveTransclusion: TransclusionResolver,
  opts: ExpandTransclusionsOptions = {},
): string {
  if (typeof source !== 'string') {
    throw new Error('expandTransclusions: source must be a string');
  }
  const maxDepth = opts.maxDepth ?? TRANSCLUSION_MAX_DEPTH;
  const markers = opts.markers ?? true;
  return expandLevel(source, resolveTransclusion, maxDepth, 1, [], markers);
}

/** Expands one nesting level (`depth` is the level of the refs found in `text`). */
function expandLevel(
  text: string,
  resolveTransclusion: TransclusionResolver,
  maxDepth: number,
  depth: number,
  stack: readonly string[],
  markers: boolean,
): string {
  const refs = parseTransclusions(text);
  if (refs.length === 0) return text;
  let out = '';
  let last = 0;
  for (const ref of refs) {
    out += text.slice(last, ref.start);
    out += expandRef(ref, text, resolveTransclusion, maxDepth, depth, stack, markers);
    last = ref.end;
  }
  out += text.slice(last);
  return out;
}

/** Expands a single reference with its boundary markers. */
function expandRef(
  ref: TransclusionRef,
  source: string,
  resolveTransclusion: TransclusionResolver,
  maxDepth: number,
  depth: number,
  stack: readonly string[],
  markers: boolean,
): string {
  const key = `${ref.sourceId}#${ref.section ?? ''}`;
  const marker = (body: string): string => wrapBlock(source, ref.start, ref.end, body);
  // Plain form (`markers: false`): a marker-wrapped block collapses to its inner
  // text; absent/skipped sources collapse to nothing — the link is swallowed.
  const wrap = (markerBody: string, inner: string): string =>
    markers ? marker(markerBody) : inner;

  if (depth > maxDepth) {
    return wrap(
      `<!-- ${TRANSCLUSION_MARKER_PREFIX} skip source=${ref.sourceId}` +
        ` depth=${depth} reason=depth_limit -->`,
      '',
    );
  }
  if (stack.includes(key)) {
    return wrap(
      `<!-- ${TRANSCLUSION_MARKER_PREFIX} skip source=${ref.sourceId}` +
        ` depth=${depth} reason=cycle -->`,
      '',
    );
  }

  const resolved = resolveTransclusion(ref.sourceId, ref.section ?? undefined);
  if (!resolved.found) {
    return wrap(
      `<!-- ${TRANSCLUSION_MARKER_PREFIX} missing source=${ref.sourceId}` +
        `${sectionAttr(ref.section)} reason=source -->`,
      '',
    );
  }

  let body = resolved.body_md;
  if (ref.section !== null) {
    const section = extractSection(body, ref.section);
    if (section === null) {
      return wrap(
        `<!-- ${TRANSCLUSION_MARKER_PREFIX} missing source=${ref.sourceId}` +
          `${sectionAttr(ref.section)} reason=section -->`,
        '',
      );
    }
    body = section;
  }

  const inner = expandLevel(body, resolveTransclusion, maxDepth, depth + 1, [
    ...stack,
    key,
  ], markers);
  const begin =
    `<!-- ${TRANSCLUSION_MARKER_PREFIX} begin source=${ref.sourceId}` +
    `${sectionAttr(ref.section)} depth=${depth} -->`;
  const end =
    `<!-- ${TRANSCLUSION_MARKER_PREFIX} end source=${ref.sourceId} depth=${depth} -->`;
  return wrap(`${begin}\n${inner}\n${end}`, inner);
}
