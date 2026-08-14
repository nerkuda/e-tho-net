/**
 * Minimal, dependency-free and XSS-safe Markdown → HTML renderer.
 *
 * Used by the comment service (task C7, docs/03-server-api.md §10) to produce
 * the cached `body_html` column. The renderer is intentionally small: it covers
 * the constructs ETN comments rely on (headings, paragraphs, bold/italic/
 * strike, inline + fenced code, blockquotes, ordered/unordered lists, links,
 * images, horizontal rules and GFM tables) and, crucially, sanitises every
 * text node and URL so that stored HTML is safe to render verbatim on the
 * client.
 *
 * Design rules:
 *   1. Input is HTML-escaped *first* (text nodes never contain raw `<`/`>`/`&`),
 *      so injected HTML/tags in the source are neutralised before any markdown
 *      rule emits markup.
 *   2. URLs are validated against an allow-list of protocols (`http`, `https`,
 *      `mailto`, and `data:` only for images); anything else is rendered as
 *      plain text so `javascript:` and friends can never reach an `href`/`src`.
 *   3. Only fixed markdown constructs are emitted — no arbitrary HTML passes
 *      through.
 *
 * This is not a CommonMark-compliant parser; it is a pragmatic, safe subset
 * suitable for short-form network comments.
 */

/** HTML-escape the five significant characters of a text node. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate a URL against the protocol allow-list. Relative URLs (no scheme) are
 * accepted. Returns the cleaned URL string when safe, or `null` when the URL is
 * rejected (caller renders it as plain text).
 *
 * @param allowData - when true, `data:`, `file:` and the app's `etnimg:` scheme
 *   are accepted (used for inline images; `file:`/`etnimg:` cover images pasted
 *   from the clipboard and stored as local attachment files — `etnimg:` is
 *   served by the Electron client and also works on its dev http origin).
 */
function safeUrl(rawUrl: string, allowData: boolean): string | null {
  const url = rawUrl.trim();
  if (url === '') return null;
  // Reject control characters anywhere in the URL. eslint-disable justified:
  // we deliberately scan the C0 range and DEL.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    const allowed = allowData
      ? ['http', 'https', 'mailto', 'data', 'file', 'etnimg']
      : ['http', 'https', 'mailto'];
    if (!allowed.includes(scheme)) return null;
  }
  return url;
}

/**
 * Split the payload inside a `[text](…)` / `![alt](…)` construct into a URL and
 * an optional title. The whole `…` is captured up-front (URLs do not contain
 * `)` for our purposes), so HTML-escaped quotes (`&quot;`) do not break parsing.
 * Returns `null` when the payload has no usable URL.
 */
function splitLinkPayload(
  payload: string,
  allowData: boolean,
): { url: string; title: string | null } | null {
  const trimmed = payload.trim();
  // Title (if any) is the last space-separated token wrapped in quotes; it may
  // be a raw `"` or an HTML-escaped `&quot;` (the latter because input was
  // escaped before inline rules run).
  const quoted = /\s+(?:"([^"]*)"|&quot;([^&]*)&quot;)$/.exec(trimmed);
  const urlPart = quoted ? trimmed.slice(0, quoted.index) : trimmed;
  const title = quoted ? (quoted[1] ?? quoted[2] ?? null) : null;
  if (urlPart === '' || /\s/.test(urlPart)) return null;
  const safe = safeUrl(urlPart, allowData);
  if (safe === null) return null;
  return { url: safe, title };
}

/** Apply inline markdown spans to an already-escaped text fragment. */
function renderInline(escaped: string): string {
  let out = escaped;
  // Inline code — processed first so its content is not re-interpreted.
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  // Images: ![alt](url "title")
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (full, alt: string, payload: string) => {
    const split = splitLinkPayload(payload, true);
    if (!split) return full.replace(/^!/, '');
    const titleAttr = split.title ? ` title="${split.title}"` : '';
    return `<img src="${split.url}" alt="${alt}"${titleAttr} />`;
  });
  // Links: [text](url "title")
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (full, text: string, payload: string) => {
    const split = splitLinkPayload(payload, false);
    if (!split) return text;
    const titleAttr = split.title ? ` title="${split.title}"` : '';
    return `<a href="${split.url}"${titleAttr}>${text}</a>`;
  });
  // Bold (**), then italic (*), then strikethrough (~~). Order matters so that
  // `**` is consumed before a single `*`.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out;
}

/** Options for {@link renderMarkdown}. */
export interface RenderOptions {
  /** Maximum input length in characters before rendering is refused. */
  maxLength?: number;
}

/** Default input cap (256 KiB) to bound rendering work for a single comment. */
const DEFAULT_MAX_LENGTH = 256 * 1024;

/**
 * Render a Markdown source string into safe, cached HTML
 * (docs/03-server-api.md §10).
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

  // Escape the entire input up-front; emitted tags are added afterwards so
  // user-supplied HTML is inert by construction.
  const lines = source.replace(/\r\n?/g, '\n').split('\n').map(escapeHtml);
  const out: string[] = [];
  let i = 0;

  /** Flush a fenced code block starting at `i` (the opening fence line). */
  const flushCodeBlock = (startIdx: number): { html: string; next: number } => {
    // The fence info from the opening line.
    const fenceLine = lines[startIdx] ?? '';
    const fenceMatch = /^(```|~~~)(.*)$/.exec(fenceLine);
    const fence = fenceMatch?.[1] ?? '```';
    const langRaw = (fenceMatch?.[2] ?? '').trim();
    const lang = /^[a-zA-Z0-9_+-]*$/.test(langRaw) ? langRaw : '';
    const body: string[] = [];
    let j = startIdx + 1;
    while (j < lines.length) {
      const line = lines[j]!;
      if (line.startsWith(fence)) {
        return {
          html: `<pre><code class="language-${lang}">${body.join('\n')}</code></pre>`,
          next: j + 1,
        };
      }
      body.push(line);
      j++;
    }
    // Unterminated fence — close it at EOF.
    return {
      html: `<pre><code class="language-${lang}">${body.join('\n')}</code></pre>`,
      next: j,
    };
  };

  /** Attempt to render a GFM table starting at `i`; return null if not a table. */
  const tryTable = (startIdx: number): { html: string; next: number } | null => {
    const header = lines[startIdx] ?? '';
    if (!header.includes('|')) return null;
    const sep = lines[startIdx + 1] ?? '';
    if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(sep) || !sep.includes('-')) return null;
    const splitRow = (row: string): string[] =>
      row
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((c) => c.trim());
    const headers = splitRow(header);
    if (headers.length === 0) return null;
    let j = startIdx + 2;
    const rows: string[][] = [];
    while (j < lines.length) {
      const line = lines[j]!;
      if (line.trim() === '' || !line.includes('|')) break;
      rows.push(splitRow(line));
      j++;
    }
    const thead = `<thead><tr>${headers
      .map((h) => `<th>${renderInline(h)}</th>`)
      .join('')}</tr></thead>`;
    const tbody = rows
      .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
      .join('');
    return { html: `<table>${thead}<tbody>${tbody}</tbody></table>`, next: j };
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // Blank line — skip (paragraph boundaries are handled per-block).
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block.
    if (/^(```|~~~)/.test(line)) {
      const block = flushCodeBlock(i);
      out.push(block.html);
      i = block.next;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // Heading (atx).
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      out.push(`<h${level}>${renderInline(headingMatch[2]!)}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote: gather consecutive `>` lines into one block.
    if (/^&gt;\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(/^&gt;\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`);
      continue;
    }

    // GFM table.
    const table = tryTable(i);
    if (table) {
      out.push(table.html);
      i = table.next;
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(`<li>${renderInline(lines[i]!.replace(/^\s*[-*+]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(`<li>${renderInline(lines[i]!.replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-block-starter lines.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (
        l.trim() === '' ||
        /^(```|~~~)/.test(l) ||
        /^(#{1,6})\s+/.test(l) ||
        /^&gt;\s?/.test(l) ||
        /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) ||
        /^\s*[-*+]\s+/.test(l) ||
        /^\s*\d+\.\s+/.test(l)
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    out.push(`<p>${renderInline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}
