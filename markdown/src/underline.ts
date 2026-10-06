/**
 * Underline (`<u>…</u>`) support of the shared renderer (задача 2fc28fa2, ТП1).
 *
 * The pipeline keeps `html: false` (raw HTML is escaped — safety model of the
 * single renderer), so `<u>` is NOT passed through by an HTML rule. Instead a
 * dedicated inline rule recognises the literal `<u>` opener, tokenizes the
 * inner text and emits `<u>` / `</u>` around it. Tag name is matched
 * case-insensitively; an unmatched `</u>` (and a lone `<u>` without a closing
 * tag) stays escaped text, exactly like any other raw HTML.
 *
 * The rule sits before `emphasis`, after `backticks`, so `<u>` inside a code
 * span is left literal.
 */

import type MarkdownIt from 'markdown-it';

const LT = 0x3c; // <
const GT = 0x3e; // >
const SLASH = 0x2f; // /
const U_LOWER = 0x75; // u

/** Case-insensitive comparison of a letter against `u`. */
function isU(code: number): boolean {
  return (code | 0x20) === U_LOWER;
}

export function underlinePlugin(md: MarkdownIt): void {
  md.inline.ruler.before('emphasis', 'underline', (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    // `<u>` — three characters, tag name case-insensitive.
    if (src.charCodeAt(pos) !== LT || !isU(src.charCodeAt(pos + 1)) || src.charCodeAt(pos + 2) !== GT) {
      return false;
    }
    const max = state.posMax;
    const openEnd = pos + 3;
    let close = -1;
    for (let i = openEnd; i + 3 < max; i++) {
      if (
        src.charCodeAt(i) === LT &&
        src.charCodeAt(i + 1) === SLASH &&
        isU(src.charCodeAt(i + 2)) &&
        src.charCodeAt(i + 3) === GT
      ) {
        close = i;
        break;
      }
    }
    // No closing `</u>` or empty content — plain text (escaped later).
    if (close === -1 || close === openEnd) return false;
    // silent (skipToken) contract: advance `state.pos` so a link label such as
    // `[<u>x</u>]` does not make markdown-it throw.
    if (silent) {
      state.pos = close + 4;
      return true;
    }

    const oldMax = state.posMax;
    state.pos = openEnd;
    state.posMax = close;
    // Source range of the visible text (between `<u>` and `</u>`), relative to
    // the inline content; resolved to absolute offsets by the source-map rule
    // (задача ba68771d).
    state.push('u_open', 'u', 1).markup = '<u>';
    state.tokens[state.tokens.length - 1]!.meta = {
      mdRelative: { start: openEnd, end: close },
      // `</u>` is four characters.
      mdRelativeAfter: close + 4,
    };
    md.inline.tokenize(state);
    state.pos = close + 4;
    state.posMax = oldMax;
    state.push('u_close', 'u', -1).markup = '</u>';
    return true;
  });
}
