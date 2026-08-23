/**
 * Wiki-link support (tasks M3, R2): `[[имя мысли|синоним]]` renders as a
 * span carrying the raw target name; the alias (or the name itself) is the
 * visible label. From task R2 also ID-based forms are supported:
 *
 * - `[[#<uuid>]]` / `[[#<uuid>|<alias>]]` — link by thought id in the current
 *   network; rendered as `<span data-wiki-id="<uuid>"></span>` (empty body —
 *   the client fills the title via `etn.thoughts.resolve`).
 * - `[[n:<uuid>#<uuid>]]` / `[[n:<uuid>#<uuid>|<alias>]]` — cross-network
 *   link; additionally carries `data-wiki-network="<uuid>"`.
 *
 * Resolution to a thought happens at click time in the client, never at
 * render time (names may change after the HTML is cached).
 */

import type MarkdownIt from 'markdown-it';

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
 * UUID v4 (and any other variant) — case-insensitive, 8-4-4-4-12 hex with
 * dashes. Mirrors the regex in `client/src/renderer/lib/pure.ts:341`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kind of a parsed wiki link. */
type WikiLinkKind = 'name' | 'id' | 'cross';

/** Meta attached to a `wiki_link` token. */
interface WikiLinkMeta {
  target: string;
  alias: string | null;
  kind: WikiLinkKind;
  /** Thought id for kind='id' / 'cross'. */
  targetId: string | null;
  /** Network id for kind='cross'. */
  networkId: string | null;
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

    // Resolve the kind: name / id / cross. Invalid UUIDs fall back to
    // legacy 'name' so existing `[[имя с #]]` patterns keep working.
    let kind: WikiLinkKind = 'name';
    let targetId: string | null = null;
    let networkId: string | null = null;
    if (target.startsWith('#')) {
      const id = target.slice(1).trim();
      if (UUID_RE.test(id)) {
        kind = 'id';
        targetId = id.toLowerCase();
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
      const token = state.push('wiki_link', 'span', 0);
      token.meta = { target, alias, kind, targetId, networkId } satisfies WikiLinkMeta;
    }
    state.pos = close + 2;
    return true;
  });

  md.renderer.rules.wiki_link = (tokens, idx) => {
    const meta = tokens[idx]!.meta as WikiLinkMeta;
    const esc = md.utils.escapeHtml;
    const attrs: string[] = [`class="${WIKI_LINK_CLASS}"`];

    if (meta.kind === 'id' || meta.kind === 'cross') {
      // ID-based form: target is the id, body is empty — the client fills
      // the resolved title via `etn.thoughts.resolve`. For cross-network
      // links also expose the network id so the client can switch tabs.
      attrs.push(`${WIKI_LINK_ID_ATTR}="${esc(meta.targetId ?? '')}"`);
      attrs.push(`${WIKI_LINK_TARGET_ATTR}="${esc(meta.targetId ?? '')}"`);
      if (meta.kind === 'cross' && meta.networkId !== null) {
        attrs.push(`${WIKI_LINK_NETWORK_ATTR}="${esc(meta.networkId)}"`);
      }
      return `<span ${attrs.join(' ')}></span>`;
    }

    // Legacy name form: target is the human-readable name, body is alias
    // (or name when alias is missing). Resolution at click time.
    attrs.push(`${WIKI_LINK_TARGET_ATTR}="${esc(meta.target)}"`);
    const label = meta.alias ?? meta.target;
    return `<span ${attrs.join(' ')}>${esc(label)}</span>`;
  };
}
