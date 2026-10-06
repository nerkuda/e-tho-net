/**
 * Highlight (`==…==`) support of the shared renderer (задача 2fc28fa2, ТП1):
 * `==текст==` renders as `<mark>текст</mark>`. Like the rest of the pipeline
 * the construct is inline-only, the inner text goes through the standard
 * inline tokenizer (so wiki-links, emphasis and escaping behave as usual) and
 * the delimiters are dropped from the output.
 *
 * The rule sits right before `emphasis` (the same slot used by the upstream
 * markdown-it-mark plugin): code spans (`backticks`) are tokenized earlier, so
 * `==…==` inside a code span stays literal.
 */

import type MarkdownIt from 'markdown-it';

/** ASCII `=`. */
const EQ = 0x3d;

export function markPlugin(md: MarkdownIt): void {
  md.inline.ruler.before('emphasis', 'mark', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== EQ || state.src.charCodeAt(state.pos + 1) !== EQ) {
      return false;
    }
    const max = state.posMax;
    const openEnd = state.pos + 2;
    let close = openEnd;
    while (close < max) {
      if (state.src.charCodeAt(close) === EQ && state.src.charCodeAt(close + 1) === EQ) break;
      close++;
    }
    // No closing `==` or empty content — leave it to the plain-text rule.
    if (close >= max || close === openEnd) return false;
    // silent (skipToken) contract: the rule must advance `state.pos`, otherwise
    // markdown-it throws «inline rule didn't increment state.pos» when the
    // construct appears inside a link label `[...]`.
    if (silent) {
      state.pos = close + 2;
      return true;
    }

    const oldMax = state.posMax;
    state.pos = openEnd;
    state.posMax = close;
    // Source range of the visible text (between the `==` delimiters), relative
    // to the inline content; the source-map core rule turns it into an absolute
    // `data-md-start`/`data-md-end` pair (задача ba68771d).
    state.push('mark_open', 'mark', 1).markup = '==';
    state.tokens[state.tokens.length - 1]!.meta = { mdRelative: { start: openEnd, end: close } };
    md.inline.tokenize(state);
    state.pos = close + 2;
    state.posMax = oldMax;
    state.push('mark_close', 'mark', -1).markup = '==';
    return true;
  });
}
