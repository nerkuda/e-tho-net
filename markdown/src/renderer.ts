/**
 * Shared markdown-it pipeline (the single renderer instance behind both
 * {@link renderMarkdown} and the publication renderer). Kept in its own module
 * so the publication toolkit can reuse the exact same instance (single
 * pipeline — see task M1 / подсистема «Markdown-рендерер») without an import
 * cycle.
 *
 * Safety model:
 *   1. `html: false` — raw HTML in the source is escaped, never passed through.
 *   2. Links/images go through the protocol allow-list in {@link isSafeUrl};
 *      rejected URLs render as plain text, so `javascript:` and friends can
 *      never reach an `href`/`src`.
 *   3. All dynamic values (alt, title, wiki targets) are HTML-escaped.
 */

import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';

import { htmlCommentPlugin } from './html-comment.js';
import { imagePlugin } from './image.js';
import { linkSafetyPlugin } from './link.js';
import { markPlugin } from './mark.js';
import { sourceMapPlugin } from './source-map.js';
import { taskListPlugin } from './task-list.js';
import { transclusionBlockPlugin } from './transclusion-block.js';
import { underlinePlugin } from './underline.js';
import { isSafeUrl } from './url.js';
import { wikiLinkPlugin } from './wiki-link.js';

/** Default input cap (256 KiB) to bound rendering work for a single document. */
export const DEFAULT_MAX_LENGTH = 256 * 1024;

/** Fence info string is only trusted as a class/language id when plain. */
const PLAIN_LANG_RE = /^[a-zA-Z0-9_+.-]+$/;

/** The shared renderer instance (statically configured, safe to reuse). */
let instance: MarkdownIt | null = null;

/**
 * Returns the singleton renderer. Plugins may be added lazily after the first
 * call (markdown-it allows `use` between renders); the publication plugin does
 * exactly that, and every publication-specific rule is gated on the per-render
 * `env`, so the base pipeline output never changes.
 */
export function getRenderer(): MarkdownIt {
  if (instance !== null) return instance;
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    // Паритет с режимом редактирования (замечание пользователя 2026-10-03,
    // задача 5de0332d, п. 3): в просмотре каждый перевод строки — разрыв, как
    // в редакторе; абзац не требует ПУСТОЙ строки. `breaks: true` рендерит
    // мягкий перенос (`softbreak`) как `<br>`, оставляя абзацы по пустой
    // строке — межстрочные/межабзацные расстояния совпадают с редактором.
    breaks: true,
    highlight: (code, lang) => highlightFence(code, lang),
  });
  // The single hook is shared by links and images, so it is configured with
  // the permissive image set; the exact per-construct rules are enforced in
  // the image renderer and the link-safety plugin.
  md.validateLink = (url: string) => isSafeUrl(url, true);
  wikiLinkPlugin(md);
  imagePlugin(md);
  linkSafetyPlugin(md);
  // ТП1 (задача 2fc28fa2): новые внутристрочные конструкции и скрытие
  // HTML-комментариев — в едином рендерере, без второго парсера.
  markPlugin(md);
  underlinePlugin(md);
  htmlCommentPlugin(md);
  // ТП2 (задача a2b68d72): блочная обёртка развёрнутых трансклюзий — ПОСЛЕ
  // скрытия HTML-комментариев, чтобы правило маркеров стояло перед ним.
  // Включается опцией рендера `transclusionLabels`; без неё вывод не меняется.
  transclusionBlockPlugin(md);
  taskListPlugin(md);
  // ТП1 (задача ba68771d): разметка отрендеренных узлов диапазонами исходных
  // смещений — opt-in через env.sourceMap, вне него вывод не меняется.
  sourceMapPlugin(md);
  instance = md;
  return md;
}

/** HTML-escape the five significant characters of a text node. */
export function escapeHtml(input: string): string {
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
