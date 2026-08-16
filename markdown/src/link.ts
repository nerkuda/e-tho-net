/**
 * Strict link allow-list (task M1). markdown-it's single `validateLink` hook is
 * shared by images and links, so it is configured with the permissive image
 * protocol set; this plugin re-checks every rendered link against the strict
 * link set and drops unsafe `<a>` elements (their text renders plain).
 */

import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { isSafeUrl } from './url.js';

/** Meta attached to a dropped (unsafe) link_open token. */
interface DropMeta {
  etnDropLink: true;
}

export function linkSafetyPlugin(md: MarkdownIt): void {
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const href = token.attrGet('href') ?? '';
    if (!isSafeUrl(href, false)) {
      token.meta = { etnDropLink: true } satisfies DropMeta;
      return '';
    }
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.link_close = (tokens, idx, options, env, self) => {
    if (isDroppedLink(tokens, idx)) return '';
    return self.renderToken(tokens, idx, options);
  };
}

/** Finds the matching link_open of `closeIdx` and reports its drop flag. */
function isDroppedLink(tokens: Token[], closeIdx: number): boolean {
  let level = 0;
  for (let i = closeIdx; i >= 0; i--) {
    const token = tokens[i]!;
    if (token.type === 'link_close') {
      level++;
    } else if (token.type === 'link_open') {
      if (level === 0) {
        const meta = token.meta as DropMeta | null;
        return meta?.etnDropLink === true;
      }
      level--;
    }
  }
  return false;
}
