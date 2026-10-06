/**
 * Wiki-link support (tasks M3, R2): `[[имя мысли|синоним]]` renders as a
 * span carrying the raw target name; the alias (or the name itself) is the
 * visible label. From task R2 also ID-based forms are supported:
 *
 * - `[[#<uuid>]]` / `[[#<uuid>|<alias>]]` — link by thought id in the current
 *   network; rendered as `<span data-wiki-id="<uuid>"></span>`. The body is
 *   empty without an alias — the client fills the title via
 *   `etn.thoughts.resolve`; with an explicit alias the alias IS the body, and
 *   the client keeps it instead of overwriting it with the resolved title.
 * - `[[n:<uuid>#<uuid>]]` / `[[n:<uuid>#<uuid>|<alias>]]` — cross-network
 *   link; additionally carries `data-wiki-network="<uuid>"`.
 *
 * Publication rendering (task d8ad884e) adds, gated on the per-render `env`
 * (`env.pub`), the prefixed form `[[#pub:<uuid>]]` and a resolver hook: in
 * publication mode the caller decides what each link becomes (in-document
 * anchor, plain title, or an «удалена» marker) instead of emitting a span.
 *
 * Resolution to a thought happens at click time in the client, never at
 * render time (names may change after the HTML is cached).
 */

import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

import { MD_SOURCE_END_ATTR, MD_SOURCE_START_ATTR, type SourceRange } from './source-map.js';

/** Class of the rendered span (matched by the client's click handler). */
export const WIKI_LINK_CLASS = 'wiki-link';
/** Data attribute holding the raw target name (`[[target|alias]]` → `target`). */
export const WIKI_LINK_TARGET_ATTR = 'data-wiki-target';
/**
 * Data attribute holding the thought id for ID-based links
 * (`[[#<uuid>]]` / `[[n:<uuid>#<uuid>]]`). For legacy name links this
 * attribute is absent.
 */
export const WIKI_LINK_ID_ATTR = 'data-wiki-id';
/**
 * Data attribute holding the network id for cross-network links
 * (`[[n:<uuid>#<uuid>]]`). For same-network id links and legacy name links
 * this attribute is absent.
 */
export const WIKI_LINK_NETWORK_ATTR = 'data-wiki-network';
/**
 * Extra class on the «удалена» marker emitted when a publication-mode resolver
 * reports `{ kind: 'missing' }` (requirement [[#7f583ef9]]).
 */
export const WIKI_LINK_MISSING_CLASS = 'wiki-link-missing';

/**
 * UUID v4 (and any other variant) — case-insensitive, 8-4-4-4-12 hex with
 * dashes. Mirrors the regex in `client/src/renderer/lib/pure.ts:341`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kind of a parsed wiki link. */
export type WikiLinkKind = 'name' | 'id' | 'cross' | 'pub';

/** Meta attached to a `wiki_link` token. */
export interface WikiLinkMeta {
  target: string;
  alias: string | null;
  kind: WikiLinkKind;
  /** Thought / publication id for kind='id' / 'cross' / 'pub'. */
  targetId: string | null;
  /** Network id for kind='cross'. */
  networkId: string | null;
  /**
   * Source range of the visible text (alias, or the target name when there is
   * no alias), relative to the inline content. The source-map rule
   * (задача ba68771d) converts it into an absolute `data-md-*` pair; `null`
   * (or absent) when the span has no visible text of its own.
   */
  mdRelative?: SourceRange | null;
}

/** Relative range of the visible text of a wiki link inside its inline source. */
function visibleRelativeRange(
  content: string,
  linkStart: number,
  pipe: number,
  alias: string | null,
  target: string,
): SourceRange {
  if (alias !== null && pipe !== -1) {
    const rawAlias = content.slice(pipe + 1);
    const lead = rawAlias.length - rawAlias.trimStart().length;
    const start = linkStart + 2 + pipe + 1 + lead;
    return { start, end: start + alias.length };
  }
  const lead = content.length - content.trimStart().length;
  const start = linkStart + 2 + lead;
  return { start, end: start + target.length };
}

/** A parsed wiki link handed to a publication resolver. */
export interface WikiLinkRef {
  kind: WikiLinkKind;
  /** Target id for 'id' / 'cross' / 'pub', otherwise null. */
  id: string | null;
  /** Network id for 'cross', otherwise null. */
  networkId: string | null;
  /** Raw target text (name form, or the `#…` / `n:…` token). */
  target: string;
  /** Author-provided alias, when present. */
  alias: string | null;
}

/** What a publication resolver turns a wiki link into. */
export type WikiLinkResolution =
  | { kind: 'anchor'; anchor: string; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'missing' };

/**
 * Publication-mode resolver. Called for every wiki link when `env.pub` is set.
 * Returning `undefined` falls back to plain text (the alias, or «удалена» for
 * target-id forms) so publication output never carries dangling spans.
 */
export type WikiLinkResolver = (ref: WikiLinkRef) => WikiLinkResolution | undefined;

/** The `env.pub` slice the wiki-link plugin reacts to. */
interface PublicationHook {
  resolveLink?: WikiLinkResolver;
}

/** Returns the publication hook carried by the current render env, if any. */
function pubHook(env: unknown): PublicationHook | undefined {
  const pub = (env as { pub?: PublicationHook } | null | undefined)?.pub;
  return pub ?? undefined;
}

export function wikiLinkPlugin(md: MarkdownIt): void {
  md.inline.ruler.after('image', 'wiki_link', (state, silent) => {
    const src = state.src;
    const start = state.pos;
    // Two opening brackets at the scan position.
    if (src.charCodeAt(start) !== 0x5b /* [ */ || src.charCodeAt(start + 1) !== 0x5b) {
      return false;
    }
    const close = src.indexOf(']]', start + 2);
    if (close === -1) return false;
    const content = src.slice(start + 2, close);
    // No empty or multiline links.
    if (content === '' || content.includes('\n') || content.includes('\r')) return false;
    const pipe = content.indexOf('|');
    const target = (pipe === -1 ? content : content.slice(0, pipe)).trim();
    const aliasRaw = pipe === -1 ? null : content.slice(pipe + 1).trim();
    const alias = aliasRaw !== null && aliasRaw !== '' ? aliasRaw : null;
    if (target === '') return false;

    // Resolve the kind: name / id / cross / pub. Invalid UUIDs fall back to
    // legacy 'name' so existing `[[имя с #]]` patterns keep working.
    let kind: WikiLinkKind = 'name';
    let targetId: string | null = null;
    let networkId: string | null = null;
    if (target.startsWith('#')) {
      const id = target.slice(1).trim();
      if (UUID_RE.test(id)) {
        kind = 'id';
        targetId = id.toLowerCase();
      } else if (id.startsWith('pub:') && pubHook(state.env) !== undefined) {
        // `[[#pub:<uuid>]]` — publication link (task d8ad884e). Only parsed in
        // publication mode: plain renderMarkdown keeps its legacy behaviour.
        const pubId = id.slice('pub:'.length).trim();
        if (UUID_RE.test(pubId)) {
          kind = 'pub';
          targetId = pubId.toLowerCase();
        }
      }
    } else if (target.startsWith('n:')) {
      // n:<networkId>#<thoughtId>
      const hashAt = target.indexOf('#', 2);
      if (hashAt !== -1) {
        const net = target.slice(2, hashAt).trim();
        const id = target.slice(hashAt + 1).trim();
        if (UUID_RE.test(net) && UUID_RE.test(id)) {
          kind = 'cross';
          networkId = net.toLowerCase();
          targetId = id.toLowerCase();
        }
      }
    }

    if (!silent) {
      // Range of the visible text for the source-position mapping (задача
      // ba68771d): the alias, the target name, or nothing for a bare id span.
      const visible = kind === 'name' ? (alias ?? target) : alias;
      const mdRelative =
        visible === null
          ? null
          : visibleRelativeRange(content, start, pipe, alias, target);
      const token = state.push('wiki_link', 'span', 0);
      token.meta = { target, alias, kind, targetId, networkId, mdRelative } satisfies WikiLinkMeta;
    }
    state.pos = close + 2;
    return true;
  });

  md.renderer.rules.wiki_link = (tokens, idx, _options, env) => {
    const meta = tokens[idx]!.meta as WikiLinkMeta;
    const esc = md.utils.escapeHtml;

    // Publication mode: when the caller supplies a resolver it decides the
    // output for EVERY wiki link so the exported/read document has no
    // unresolved spans (req. [[#888453b6]]). Without a resolver the span forms
    // are kept as-is, so a resolver-less publication render matches
    // `renderMarkdown` (only the `[[#pub:…]]` form is publication-specific).
    const resolver = pubHook(env)?.resolveLink;
    if (resolver !== undefined) {
      const resolved = resolver({
        kind: meta.kind,
        id: meta.targetId,
        networkId: meta.networkId,
        target: meta.target,
        alias: meta.alias,
      });
      if (resolved !== undefined) return renderResolution(resolved, esc);
      // No decision — plain text fallback (аlias when present).
      if (meta.kind === 'name') return esc(meta.alias ?? meta.target);
      return esc(meta.alias ?? 'удалена');
    }
    if (meta.kind === 'pub') {
      // Parsed only in publication mode; without a resolver there is no span
      // form — fall back to text so no dangling span is emitted.
      return esc(meta.alias ?? 'удалена');
    }

    const attrs: string[] = [`class="${WIKI_LINK_CLASS}"`];
    // Absolute source range resolved by the source-map core rule (задача
    // ba68771d); present only when the render opted into position mapping.
    const mdRange = (meta as WikiLinkMeta & { mdRange?: SourceRange }).mdRange;
    if (mdRange !== undefined) {
      attrs.push(`${MD_SOURCE_START_ATTR}="${mdRange.start}"`);
      attrs.push(`${MD_SOURCE_END_ATTR}="${mdRange.end}"`);
    }

    if (meta.kind === 'id' || meta.kind === 'cross') {
      // ID-based form: the span carries the id in its data-attributes; the
      // body is the author's alias (`[[#<id>|алиас]]`) or empty. The client
      // fills the resolved title via `etn.thoughts.resolve` into EMPTY spans
      // only, so an explicit alias stays visible (карточка feccffcc). For
      // cross-network links also expose the network id so the client can
      // switch tabs.
      attrs.push(`${WIKI_LINK_ID_ATTR}="${esc(meta.targetId ?? '')}"`);
      attrs.push(`${WIKI_LINK_TARGET_ATTR}="${esc(meta.targetId ?? '')}"`);
      if (meta.kind === 'cross' && meta.networkId !== null) {
        attrs.push(`${WIKI_LINK_NETWORK_ATTR}="${esc(meta.networkId)}"`);
      }
      return `<span ${attrs.join(' ')}>${meta.alias !== null ? esc(meta.alias) : ''}</span>`;
    }

    // Legacy name form: target is the human-readable name, body is alias
    // (or name when alias is missing). Resolution at click time.
    attrs.push(`${WIKI_LINK_TARGET_ATTR}="${esc(meta.target)}"`);
    // Marker so the editor (task R10) and view-mode can offer the
    // «Обновить формат на [[#<id>]]» action.
    attrs.push('data-legacy-link="true"');
    const label = meta.alias ?? meta.target;
    return `<span ${attrs.join(' ')}>${esc(label)}</span>`;
  };
}

/** Renders a resolver decision to safe HTML. */
function renderResolution(
  resolution: WikiLinkResolution,
  esc: (input: string) => string,
): string {
  if (resolution.kind === 'anchor') {
    return `<a href="#${esc(resolution.anchor)}">${esc(resolution.text)}</a>`;
  }
  if (resolution.kind === 'text') return esc(resolution.text);
  return `<span class="${WIKI_LINK_CLASS} ${WIKI_LINK_MISSING_CLASS}">удалена</span>`;
}

/** Recursively collects human-readable text out of an inline token's children. */
export function inlinePlainText(token: Token): string {
  const children = token.children;
  if (children === null) return token.content;
  let out = '';
  for (const child of children) {
    if (child.type === 'text' || child.type === 'code_inline') {
      out += child.content;
    } else if (child.type === 'wiki_link') {
      const meta = child.meta as WikiLinkMeta | null;
      out += meta?.alias ?? meta?.target ?? '';
    } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
      out += ' ';
    }
  }
  return out.trim();
}
