/**
 * Publication toolkit of the shared renderer (task d8ad884e, version 0.11.1).
 *
 * All pieces are PURE (no server, no DB, no I/O) and opt-in per call, so the
 * plain {@link renderMarkdown} path stays byte-for-byte identical:
 *
 * - {@link renderPublicationFragment} — render one block (предисловие / текст)
 *   of a publication: heading-level shift under the enclosing section,
 *   decapitation past H6, per-heading anchors, `[[#pub:<uuid>]]` recognition
 *   and title substitution, plus a collected heading list for the TOC;
 * - {@link buildToc} — nest a flat heading list into the TOC tree;
 * - {@link formatSectionNumber} — section numbering by a level range;
 * - {@link publicationAnchor} / {@link shortId} — deterministic `pub-<shortid>`
 *   block anchors.
 *
 * Specs: requirement [[#9969e586]] (shift / decapitation), [[#7f583ef9]] and
 * [[#888453b6]] (publication links and export links), [[#a33f7b0e]]
 * (numbering), DTO [[#8b849dfc]], ADR [[#06874c5d]] (determinism pinning).
 */

import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

import { DEFAULT_MAX_LENGTH, getRenderer } from './renderer.js';
import {
  inlinePlainText,
  type WikiLinkRef,
  type WikiLinkResolver,
} from './wiki-link.js';

/** Prefix of every publication block anchor (`pub-<shortid>`). */
export const PUB_ANCHOR_PREFIX = 'pub-';

/**
 * Deterministic short id of a thought / publication id: the first 8 characters
 * of the id with dashes removed, lower-cased. UUIDs yield 8 hex characters.
 */
export function shortId(id: string): string {
  return id.replace(/-/g, '').toLowerCase().slice(0, 8);
}

/** Block anchor `pub-<shortid>` for a thought / publication id. */
export function publicationAnchor(id: string): string {
  return `${PUB_ANCHOR_PREFIX}${shortId(id)}`;
}

/** A rendered heading of a fragment (also one TOC entry). */
export interface PublicationHeading {
  /** Final level 1..6 (a decapitated heading keeps 6). */
  level: number;
  /** Plain text of the heading, markdown stripped. */
  text: string;
  /** Generated anchor id without '#', or null when none was requested. */
  anchor: string | null;
  /** True when the heading overflowed H6 and was rendered as `<p><strong>`. */
  decapitated: boolean;
}

/** Context handed to {@link HeadingAnchorProvider}. */
export interface HeadingAnchorContext {
  /** Final (shifted) level 1..6. */
  level: number;
  /** Plain text of the heading. */
  text: string;
  /** True when the heading is decapitated (no anchor is then applied). */
  decapitated: boolean;
  /** 0-based index among the headings of this fragment. */
  index: number;
}

/** Supplies an anchor id (without '#') for a heading; undefined → no anchor. */
export type HeadingAnchorProvider = (heading: HeadingAnchorContext) => string | undefined;

/** Options of {@link renderPublicationFragment}. */
export interface PublicationRenderOptions {
  /**
   * Heading level of the enclosing section. The largest heading of the fragment
   * (smallest Hn) becomes `baseLevel + 1`, the rest shift by the same delta.
   * `0` / omitted → no shift (headings render as authored).
   */
  baseLevel?: number;
  /** Anchor ids for the rendered headings. */
  headingAnchor?: HeadingAnchorProvider;
  /** Turns wiki links into anchors / plain titles / «удалена». */
  resolveLink?: WikiLinkResolver;
  /** Maximum input length in characters (default 256 KiB). */
  maxLength?: number;
}

/** Result of {@link renderPublicationFragment}. */
export interface PublicationRenderResult {
  /** Rendered HTML. */
  html: string;
  /** Headings in document order (flat structure for the TOC). */
  headings: PublicationHeading[];
}

/** A nested TOC node produced by {@link buildToc}. */
export interface TocNode {
  level: number;
  text: string;
  anchor: string | null;
  decapitated: boolean;
  children: TocNode[];
}

/** Level range for section numbering; both null → no numbering at all. */
export interface NumberingRange {
  from: number | null;
  to: number | null;
}

/**
 * Section number label for a section identified by its 1-based sibling
 * counters down the tree. Numbering STARTS AT 1 ON LEVEL `from` (задача
 * 7cfaba7c, п.6): counters of the levels ABOVE `from` are dropped, while the
 * counter of level `from` and deeper ones build the label. So level-1 sections
 * are unnumbered, level-`from` sections read «1», «2», … and their nested
 * sections «1.1», regardless of the absolute position of the ancestry
 * (`[2,1]` with `from: 2` → "1", not "2.1"; a single level `from === to`
 * behaves the same). `from === null` starts from level 1. Returns null when
 * the section is not numbered (level outside the range, empty range, or empty
 * counters).
 */
export function formatSectionNumber(
  counters: readonly number[],
  range?: NumberingRange,
): string | null {
  if (range === undefined) return null;
  const { from, to } = range;
  if (from === null && to === null) return null;
  const level = counters.length;
  if (level === 0) return null;
  if (from !== null && level < from) return null;
  if (to !== null && level > to) return null;
  const start = (from ?? 1) - 1;
  return counters.slice(start).join('.');
}

/**
 * Nests a flat, document-ordered heading list into the TOC tree by heading
 * level. A node attaches to the nearest preceding node of a strictly smaller
 * level; otherwise it starts a new root.
 */
export function buildToc(headings: readonly PublicationHeading[]): TocNode[] {
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];
  for (const heading of headings) {
    const node: TocNode = {
      level: heading.level,
      text: heading.text,
      anchor: heading.anchor,
      decapitated: heading.decapitated,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1]!.level >= node.level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    stack.push(node);
  }
  return roots;
}

/** Meta stamped on heading tokens while rendering in publication mode. */
interface HeadingOpenMeta {
  pubHeading: PublicationHeading;
}
/** Meta stamped on the matching `heading_close`. */
interface HeadingCloseMeta {
  pubClose: true;
  level: number;
  decapitated: boolean;
}

/** The `env.pub` slice driving the publication plugin. */
export interface PublicationEnv {
  baseLevel: number;
  headingAnchor?: HeadingAnchorProvider;
  resolveLink?: WikiLinkResolver;
  /** Output sink for the collected headings. */
  headings: PublicationHeading[];
}

/** Content of `env.pub` as read by the plugin. */
function pubEnv(env: unknown): PublicationEnv | undefined {
  return (env as { pub?: PublicationEnv } | null | undefined)?.pub;
}

/** Registers the publication rules on the shared renderer exactly once. */
let pluginRegistered = false;
function ensurePublicationPlugin(md: MarkdownIt): void {
  if (pluginRegistered) return;
  pluginRegistered = true;
  publicationPlugin(md);
}

/**
 * markdown-it plugin: heading shift / decapitation / anchors / TOC collection.
 * Inactive unless `env.pub` is set, so the base pipeline is untouched.
 */
function publicationPlugin(md: MarkdownIt): void {
  md.core.ruler.push('publication_headings', (state) => {
    const pub = pubEnv(state.env);
    if (pub === undefined) return;

    // Largest heading (smallest Hn) of the fragment defines the shift.
    let min = 7;
    for (const token of state.tokens) {
      if (token.type === 'heading_open') {
        const n = headingNumber(token);
        if (n > 0 && n < min) min = n;
      }
    }
    if (min === 7) return; // no headings → nothing to shift, anchor or collect

    pub.headings = [];
    const base = pub.baseLevel;
    let index = 0;
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i]!;
      if (token.type !== 'heading_open') continue;
      const from = headingNumber(token);
      if (from === 0) continue;
      const shifted = base > 0 ? base + 1 + (from - min) : from;
      const decapitated = shifted > 6;
      const level = decapitated ? 6 : shifted;
      const inline = state.tokens[i + 1];
      const text = inline !== undefined ? inlinePlainText(inline) : '';
      let anchor: string | null = null;
      if (!decapitated && pub.headingAnchor !== undefined) {
        anchor = pub.headingAnchor({ level, text, decapitated, index }) ?? null;
      }
      const heading: PublicationHeading = { level, text, anchor, decapitated };
      pub.headings.push(heading);
      index++;
      token.meta = { pubHeading: heading } satisfies HeadingOpenMeta;
      // Shift the tag and attach the anchor on the token itself so the default
      // `renderToken` keeps its block-newline handling intact.
      token.tag = `h${level}`;
      if (anchor !== null) token.attrSet('id', anchor);
      const close = state.tokens[i + 2];
      if (close !== undefined && close.type === 'heading_close') {
        close.meta = { pubClose: true, level, decapitated } satisfies HeadingCloseMeta;
        close.tag = decapitated ? 'p' : `h${level}`;
      }
    }
  });

  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    const meta = tokens[idx]!.meta as HeadingOpenMeta | null;
    if (meta?.pubHeading.decapitated === true) return '<p><strong>';
    return self.renderToken(tokens, idx, options);
  };

  md.renderer.rules.heading_close = (tokens, idx, options, _env, self) => {
    const meta = tokens[idx]!.meta as HeadingCloseMeta | null;
    if (meta?.pubClose === true && meta.decapitated) return '</strong></p>\n';
    return self.renderToken(tokens, idx, options);
  };
}

/**
 * Numeric heading level from a `heading_open` token tag (`h3` → 3).
 */
function headingNumber(token: Token): number {
  const tag = token.tag;
  if (tag.length !== 2 || tag[0] !== 'h') return 0;
  const n = tag.charCodeAt(1) - 48;
  return n >= 1 && n <= 6 ? n : 0;
}

/**
 * Render one publication block (a section preamble or a text) from its source
 * `body_md`. Pure and server-free; the caller slices the source because of the
 * 256 KiB cap (предисловие и каждый текст — отдельный вызов).
 *
 * @throws when `source` is not a string or exceeds the configured length cap.
 */
export function renderPublicationFragment(
  source: unknown,
  opts: PublicationRenderOptions = {},
): PublicationRenderResult {
  if (typeof source !== 'string') {
    throw new Error('renderPublicationFragment: source must be a string');
  }
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  if (source.length > maxLength) {
    throw new Error(`renderPublicationFragment: source exceeds ${maxLength} characters`);
  }
  const md = getRenderer();
  ensurePublicationPlugin(md);
  const env = {
    pub: {
      baseLevel: opts.baseLevel ?? 0,
      headingAnchor: opts.headingAnchor,
      resolveLink: opts.resolveLink,
      headings: [],
    } satisfies PublicationEnv,
  };
  const html = md.render(source, env);
  return { html, headings: env.pub.headings };
}

// ---------------------------------------------------------------------------
// Markdown-экспорт фрагмента (задача 6d87f1f2, операция 1f161c74)
// ---------------------------------------------------------------------------

/** Options of {@link renderPublicationMarkdownFragment}. */
export interface PublicationMarkdownOptions {
  /** Heading level of the enclosing section (same semantics as the HTML render). */
  baseLevel?: number;
  /** Anchor ids for the collected headings (TOC parity with the HTML render). */
  headingAnchor?: HeadingAnchorProvider;
  /** Turns wiki links into `[text](#anchor)` / plain text / «удалена». */
  resolveLink?: WikiLinkResolver;
  /** Maximum input length in characters (default 256 KiB). */
  maxLength?: number;
}

/** Result of {@link renderPublicationMarkdownFragment}. */
export interface PublicationMarkdownResult {
  /** Fragment with shifted headings, resolved links and block anchors kept inline. */
  markdown: string;
  /** Headings in document order (same shape as the HTML render). */
  headings: PublicationHeading[];
}

/** UUID v4-ish pattern (mirrors wiki-link.ts). */
const UUID_RE_SRC = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Render one publication block to Markdown. Same heading shift / decapitation
 * and the same link resolver as {@link renderPublicationFragment}, so the
 * exported Markdown and the previewed HTML never diverge (requirement
 * [[#9969e586]]). Pure and server-free.
 *
 * Images and other inline markdown are preserved verbatim; `src` rewriting for
 * the `assets/` directory is the caller's business (it knows the file layout).
 *
 * @throws when `source` is not a string or exceeds the configured length cap.
 */
export function renderPublicationMarkdownFragment(
  source: unknown,
  opts: PublicationMarkdownOptions = {},
): PublicationMarkdownResult {
  if (typeof source !== 'string') {
    throw new Error('renderPublicationMarkdownFragment: source must be a string');
  }
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  if (source.length > maxLength) {
    throw new Error(`renderPublicationMarkdownFragment: source exceeds ${maxLength} characters`);
  }
  const md = getRenderer();
  const tokens = md.parse(source, {});
  const lines = source.split('\n');

  // Protected line ranges: fenced and indented code blocks are never rewritten.
  const protectedRanges: Array<[number, number]> = [];
  for (const token of tokens) {
    if ((token.type === 'fence' || token.type === 'code_block') && token.map !== null) {
      protectedRanges.push([token.map[0]!, token.map[1]!]);
    }
  }
  const isProtected = (line: number): boolean =>
    protectedRanges.some(([from, to]) => line >= from && line < to);

  const headings: PublicationHeading[] = [];
  // Heading blocks to replace: start line → { endExclusive, text }.
  const headingReplacements = new Map<number, { end: number; text: string }>();
  let minLevel = 7;
  for (const token of tokens) {
    if (token.type === 'heading_open') {
      const n = headingNumber(token);
      if (n > 0 && n < minLevel) minLevel = n;
    }
  }
  if (minLevel !== 7) {
    const base = opts.baseLevel ?? 0;
    let index = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token.type !== 'heading_open' || token.map === null) continue;
      const from = headingNumber(token);
      if (from === 0) continue;
      const shifted = base > 0 ? base + 1 + (from - minLevel) : from;
      const decapitated = shifted > 6;
      const level = decapitated ? 6 : shifted;
      const inline = tokens[i + 1];
      const rawContent = inline !== undefined ? inline.content : '';
      const text = inline !== undefined ? inlinePlainText(inline) : '';
      let anchor: string | null = null;
      if (!decapitated && opts.headingAnchor !== undefined) {
        anchor = opts.headingAnchor({ level, text, decapitated, index }) ?? null;
      }
      headings.push({ level, text, anchor, decapitated });
      index += 1;
      const end = token.map[1]!;
      const rendered = decapitated
        ? `**${rawContent.trim()}**`
        : `${'#'.repeat(level)} ${rawContent.trim()}`;
      headingReplacements.set(token.map[0]!, { end, text: rendered });
    }
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const replacement = headingReplacements.get(i);
    if (replacement !== undefined) {
      out.push(replacement.text);
      i = replacement.end - 1; // skip the original heading lines
      continue;
    }
    if (isProtected(i)) {
      out.push(lines[i]!);
      continue;
    }
    out.push(opts.resolveLink === undefined ? lines[i]! : resolveWikiLinksInLine(lines[i]!, opts.resolveLink));
  }
  return { markdown: out.join('\n'), headings };
}

/** Parsed wiki link (source-level, mirrors the inline rule of wiki-link.ts). */
interface ParsedWikiLink {
  ref: WikiLinkRef;
}

/** Parse a `[[…]]` body into a resolver ref, or `null` when malformed. */
function parseWikiLinkBody(content: string): ParsedWikiLink | null {
  if (content === '' || content.includes('\n') || content.includes('\r')) return null;
  const pipe = content.indexOf('|');
  const target = (pipe === -1 ? content : content.slice(0, pipe)).trim();
  const aliasRaw = pipe === -1 ? null : content.slice(pipe + 1).trim();
  const alias = aliasRaw !== null && aliasRaw !== '' ? aliasRaw : null;
  if (target === '') return null;

  let kind: WikiLinkRef['kind'] = 'name';
  let targetId: string | null = null;
  let networkId: string | null = null;
  if (target.startsWith('#')) {
    const id = target.slice(1).trim();
    if (UUID_RE_SRC.test(id)) {
      kind = 'id';
      targetId = id.toLowerCase();
    } else if (id.startsWith('pub:')) {
      const pubId = id.slice('pub:'.length).trim();
      if (UUID_RE_SRC.test(pubId)) {
        kind = 'pub';
        targetId = pubId.toLowerCase();
      }
    }
  } else if (target.startsWith('n:')) {
    const hashAt = target.indexOf('#', 2);
    if (hashAt !== -1) {
      const net = target.slice(2, hashAt).trim();
      const id = target.slice(hashAt + 1).trim();
      if (UUID_RE_SRC.test(net) && UUID_RE_SRC.test(id)) {
        kind = 'cross';
        networkId = net.toLowerCase();
        targetId = id.toLowerCase();
      }
    }
  }
  return { ref: { kind, id: targetId, networkId, target, alias } };
}

/**
 * Replace `[[…]]` links on one source line, skipping backtick code spans.
 * The resolver decision is the same one the HTML render uses, so an in-document
 * thought link becomes `[text](#pub-<shortid>)`.
 */
function resolveWikiLinksInLine(line: string, resolveLink: WikiLinkResolver): string {
  const segments = line.split(/(`+[^`]*`+)/g);
  for (let s = 0; s < segments.length; s += 1) {
    if (s % 2 === 1) continue; // a backtick code span — leave as-is
    segments[s] = segments[s]!.replace(/\[\[([^\n]*?)\]\]/g, (whole, body: string) => {
      const parsed = parseWikiLinkBody(body);
      if (parsed === null) return whole;
      const resolved = resolveLink(parsed.ref);
      if (resolved === undefined) {
        if (parsed.ref.kind === 'name') return parsed.ref.alias ?? parsed.ref.target;
        return parsed.ref.alias ?? 'удалена';
      }
      if (resolved.kind === 'anchor') return `[${resolved.text}](#${resolved.anchor})`;
      if (resolved.kind === 'text') return resolved.text;
      return 'удалена';
    });
  }
  return segments.join('');
}
