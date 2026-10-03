/**
 * The single Markdown → HTML pipeline shared by the server (cached `body_html`
 * of comments, HTML export) and the client (live-preview widgets), so both
 * sides always agree on the markup (task M1).
 *
 * Publication-aware rendering (heading shift, decapitation, anchors, TOC,
 * numbering, `[[#pub:…]]` links, title substitution) lives in
 * {@link renderPublicationFragment}; it goes through the same single pipeline
 * and is opt-in per call, so plain {@link renderMarkdown} output is unchanged.
 */

import { DEFAULT_MAX_LENGTH, getRenderer } from './renderer.js';

export { parseAltSize } from './image.js';
export { isSafeUrl } from './url.js';
export { DEFAULT_MAX_LENGTH } from './renderer.js';
export {
  WIKI_LINK_CLASS,
  WIKI_LINK_TARGET_ATTR,
  WIKI_LINK_ID_ATTR,
  WIKI_LINK_NETWORK_ATTR,
  WIKI_LINK_MISSING_CLASS,
} from './wiki-link.js';
export type {
  WikiLinkRef,
  WikiLinkResolution,
  WikiLinkResolver,
} from './wiki-link.js';
export {
  PUB_ANCHOR_PREFIX,
  shortId,
  publicationAnchor,
  formatSectionNumber,
  buildToc,
  renderPublicationFragment,
  renderPublicationMarkdownFragment,
} from './publication.js';
export type {
  NumberingRange,
  PublicationHeading,
  HeadingAnchorContext,
  HeadingAnchorProvider,
  PublicationRenderOptions,
  PublicationRenderResult,
  PublicationMarkdownOptions,
  PublicationMarkdownResult,
  TocNode,
} from './publication.js';

/**
 * Marker of the rendering pipeline version. The server re-renders the cached
 * `body_html` of every comment once when this value differs from the stored
 * one (see `markdown-sweep.ts`).
 *
 * `markdown-it/4`: ID-form wiki-links with an alias (`[[#<id>|алиас]]`) render
 * the alias as the span body — cached `body_html` (rendered by v3 with empty
 * bodies) must re-render so the alias becomes visible in view mode.
 *
 * `markdown-it/5`: no renderer change. Bumped by migration 040 (0.8.1,
 * thought_ref → свойства-связи): the migration edits `body_md` of comments
 * moved from links to thoughts (a transfer note is prepended) and folds
 * on-link property values into permanent comments, leaving `body_html` stale
 * on purpose — the sweep re-renders every comment after the migration.
 *
 * `markdown-it/6`: publication toolkit (0.11.1). Plain `renderMarkdown` output
 * is byte-for-byte unchanged (every publication rule is gated on the per-render
 * `env`), but the pinning invariant of the export determinism ADR
 * ([[#06874c5d]]) requires the version to move with the pipeline.
 *
 * `markdown-it/7`: `breaks: true` — a single newline renders as `<br>` so the
 * view matches the editor (задача 5de0332d, п. 3). Cached `body_html` must
 * re-render.
 */
export const MD_RENDER_VERSION = 'markdown-it/7';

/** Options for {@link renderMarkdown}. */
export interface RenderOptions {
  /** Maximum input length in characters before rendering is refused. */
  maxLength?: number;
}

/**
 * Render a Markdown source string into safe HTML.
 *
 * @throws when `source` is not a string or exceeds the configured length cap.
 */
export function renderMarkdown(source: unknown, opts: RenderOptions = {}): string {
  if (typeof source !== 'string') {
    throw new Error('renderMarkdown: source must be a string');
  }
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  if (source.length > maxLength) {
    throw new Error(`renderMarkdown: source exceeds ${maxLength} characters`);
  }
  return getRenderer().render(source);
}
