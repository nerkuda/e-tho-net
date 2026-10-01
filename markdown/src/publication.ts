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
 * counters down the tree (`[1]` → "1", `[1,2,3]` → "1.2.3"). Only the section's
 * own level must fall inside `[from .. to]`; ancestors always contribute to the
 * label (сквозная нумерация, [[#a33f7b0e]]). Returns null when the section is
 * not numbered (level outside the range, empty range, or empty counters).
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
  return counters.join('.');
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

/** Numeric heading level from a `heading_open` token tag (`h3` → 3). */
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
