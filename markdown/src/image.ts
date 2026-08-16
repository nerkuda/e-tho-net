/**
 * Image rendering with Obsidian-style size hints (task M5):
 * `![alt|600px](url)` — width 600px, `![alt|600x400](url)` — width+height,
 * `![alt|50%](url)` — half of the field width. A `|` part that is not a size
 * leaves the alt text untouched. Invalid URLs render the construct as plain
 * text (parity with the previous renderer).
 */

import type MarkdownIt from 'markdown-it';
import { isSafeUrl } from './url.js';

const SIZE_RE =
  /^(?:(?<w>\d+(?:\.\d+)?)(?:px)?)(?:x(?<h>\d+(?:\.\d+)?)(?:px)?)?$|^(?<pct>\d+(?:\.\d+)?)%$/;

/** Splits `alt|size` image alt text; `style` is the CSS `width[;height]` part. */
export function parseAltSize(alt: string): { alt: string; style: string | null } {
  const pipe = alt.indexOf('|');
  if (pipe === -1) return { alt, style: null };
  const size = alt.slice(pipe + 1).trim();
  const match = SIZE_RE.exec(size);
  if (match === null) return { alt, style: null };
  const groups = match.groups;
  const widthValue = groups?.w ?? groups?.pct;
  if (widthValue === undefined) return { alt, style: null };
  const unit = groups?.pct !== undefined ? '%' : 'px';
  const width = `${widthValue}${unit}`;
  const height = groups?.h !== undefined ? `;height:${groups.h}px` : '';
  return { alt: alt.slice(0, pipe).trim(), style: `width:${width}${height}` };
}

export function imagePlugin(md: MarkdownIt): void {
  md.renderer.rules.image = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]!;
    // Alt text comes from the inline children (markup stripped), like the
    // stock renderer; the size hint rides after a `|` inside the alt.
    const renderedAlt = self.renderInlineAsText(token.children ?? [], options, {});
    const { alt, style } = parseAltSize(renderedAlt);
    const src = token.attrGet('src') ?? '';
    if (!isSafeUrl(src, true)) return md.utils.escapeHtml(alt);
    const normalized = md.normalizeLink(src) ?? '';
    const esc = md.utils.escapeHtml;
    const title = token.attrGet('title');
    const titleAttr = title !== null && title !== '' ? ` title="${esc(title)}"` : '';
    const styleAttr = style !== null ? ` style="${style}"` : '';
    return `<img src="${esc(normalized)}" alt="${esc(alt)}"${titleAttr}${styleAttr} />`;
  };
}
