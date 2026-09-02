/**
 * The single Markdown → HTML pipeline shared by the server (cached `body_html`
 * of comments, HTML export) and the client (live-preview widgets), so both
 * sides always agree on the markup (task M1).
 *
 * Safety model (parity with the previous server renderer):
 *   1. `html: false` — raw HTML in the source is escaped, never passed through.
 *   2. Links/images go through the protocol allow-list in {@link isSafeUrl};
 *      rejected URLs render as plain text, so `javascript:` and friends can
 *      never reach an `href`/`src`.
 *   3. All dynamic values (alt, title, wiki targets) are HTML-escaped.
 */

import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';

import { imagePlugin } from './image.js';
import { linkSafetyPlugin } from './link.js';
import { isSafeUrl } from './url.js';
import { wikiLinkPlugin } from './wiki-link.js';

export { parseAltSize } from './image.js';
export { isSafeUrl } from './url.js';
export {
  WIKI_LINK_CLASS,
  WIKI_LINK_TARGET_ATTR,
  WIKI_LINK_ID_ATTR,
  WIKI_LINK_NETWORK_ATTR,
} from './wiki-link.js';

/**
 * Marker of the rendering pipeline version. The server re-renders the cached
 * `body_html` of every comment once when this value differs from the stored
 * one (see `markdown-sweep.ts`).
 *
 * `markdown-it/3`: `etnimg:` joined the link protocol allow-list — cached
 * `[имя](etnimg://…)` attachment references must re-render as `<a>`.
 */
export const MD_RENDER_VERSION = 'markdown-it/3';

/** Default input cap (256 KiB) to bound rendering work for a single document. */
export const DEFAULT_MAX_LENGTH = 256 * 1024;

/** Options for {@link renderMarkdown}. */
export interface RenderOptions {
  /** Maximum input length in characters before rendering is refused. */
  maxLength?: number;
}

/** The shared renderer instance (statically configured, safe to reuse). */
let instance: MarkdownIt | null = null;

function getRenderer(): MarkdownIt {
  if (instance !== null) return instance;
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    breaks: false,
    highlight: (code, lang) => highlightFence(code, lang),
  });
  // The single hook is shared by links and images, so it is configured with
  // the permissive image set; the exact per-construct rules are enforced in
  // the image renderer and the link-safety plugin.
  md.validateLink = (url: string) => isSafeUrl(url, true);
  wikiLinkPlugin(md);
  imagePlugin(md);
  linkSafetyPlugin(md);
  instance = md;
  return md;
}

/** Fence info string is only trusted as a class/language id when plain. */
const PLAIN_LANG_RE = /^[a-zA-Z0-9_+.-]+$/;

/** HTML-escape the five significant characters of a text node. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render one fenced code block: highlight.js when the language is known. */
function highlightFence(code: string, lang: string): string {
  const safeLang = lang !== '' && PLAIN_LANG_RE.test(lang) ? lang : '';
  if (safeLang === 'mermaid') {
    // Диаграммы рендерит клиент (mermaid.js) — сервер отдаёт только блок
    // с пометкой, чтобы просмотр и live preview вели себя одинаково (M7).
    return `<pre class="mermaid"><code>${escapeHtml(code)}</code></pre>`;
  }
  const language = safeLang !== '' && hljs.getLanguage(safeLang) !== undefined ? safeLang : '';
  if (language === '') {
    return `<pre><code class="hljs">${escapeHtml(code)}</code></pre>`;
  }
  try {
    const value = hljs.highlight(code, { language }).value;
    return `<pre><code class="hljs language-${language}">${value}</code></pre>`;
  } catch {
    return `<pre><code class="hljs">${escapeHtml(code)}</code></pre>`;
  }
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
