/**
 * Wiki-link support (task M3): `[[имя мысли|синоним]]` renders as a span
 * carrying the raw target name; the alias (or the name itself) is the visible
 * label. Resolution to a thought happens at click time in the client, never at
 * render time (names may change after the HTML is cached).
 */

import type MarkdownIt from 'markdown-it';

/** Class of the rendered span (matched by the client's click handler). */
export const WIKI_LINK_CLASS = 'wiki-link';
/** Data attribute holding the raw target name (`[[target|alias]]` → `target`). */
export const WIKI_LINK_TARGET_ATTR = 'data-wiki-target';

/** Meta attached to a `wiki_link` token. */
interface WikiLinkMeta {
  target: string;
  alias: string | null;
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
    if (!silent) {
      const token = state.push('wiki_link', 'span', 0);
      token.meta = { target, alias } satisfies WikiLinkMeta;
    }
    state.pos = close + 2;
    return true;
  });

  md.renderer.rules.wiki_link = (tokens, idx) => {
    const meta = tokens[idx]!.meta as WikiLinkMeta;
    const label = meta.alias ?? meta.target;
    const esc = md.utils.escapeHtml;
    return (
      `<span class="${WIKI_LINK_CLASS}" ${WIKI_LINK_TARGET_ATTR}="${esc(meta.target)}">` +
      `${esc(label)}</span>`
    );
  };
}
