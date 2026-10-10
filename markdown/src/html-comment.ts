/**
 * HTML-comment hiding in the shared renderer (задача 2fc28fa2, требование
 * 65154ccb, ТП1): `<!-- … -->` is dropped from the rendered output, so it is
 * invisible in the client view and in publication texts (both go through this
 * pipeline), while the raw markdown stays untouched and therefore visible in
 * the editor.
 *
 * Because `html: false` disables markdown-it's own `html_block`/`html_inline`
 * rules, a comment would otherwise be escaped and shown as text. Two small
 * rules remove it instead:
 *
 * - a BLOCK rule for a comment that occupies whole line(s) — the block is
 *   consumed without emitting tokens, so no empty `<p>` is left behind;
 * - an INLINE rule for a comment embedded in running text.
 *
 * Fenced/inline code is tokenized separately, so a `<!-- -->` inside a code
 * block or a code span stays literal.
 *
 * Source map (ошибка `29aa3108`). Under `env.sourceMap` the inline rule ALSO
 * pushes a zero-length `text_special` marker token (`content: ''`,
 * `markup: <comment source>`) where the comment stood. It renders nothing
 * (`text_join` merges the empty content away), so the default output stays
 * byte-for-byte, but the token-based shift map of `source-map.ts` now SEES the
 * comment's source run and can compensate the missing characters — the same
 * mechanism it already uses for escapes/entities. The transclusion markers are
 * HTML comments on their own lines and are consumed by the BLOCK rule (or by
 * `transclusion-block.ts`), so this inline path never touches them.
 */

import type MarkdownIt from 'markdown-it';

/** Marker consumed at the current position when a comment starts here. */
const OPEN = '<!--';
const CLOSE = '-->';

/** True when the current render opts into the source map (`env.sourceMap`). */
function sourceMapEnabled(env: unknown): boolean {
  return (env as { sourceMap?: boolean } | null | undefined)?.sourceMap === true;
}

export function htmlCommentPlugin(md: MarkdownIt): void {
  md.block.ruler.before('paragraph', 'html_comment', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine]! + state.tShift[startLine]!;
    // Four-space indentation means an indented code block, not a comment.
    if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
    if (!state.src.startsWith(OPEN, start)) return false;

    const end = state.src.indexOf(CLOSE, start + OPEN.length);
    if (end === -1) return false;
    const after = end + CLOSE.length;

    // The closing line is the first one whose end-of-mark is past `after`.
    let line = startLine;
    while (line < endLine && state.eMarks[line]! < after) line++;
    if (line >= endLine) return false;
    // Content after `-->` on the closing line is ordinary text: let the inline
    // path hide only the comment and keep the rest.
    if (state.src.slice(after, state.eMarks[line]!).trim() !== '') return false;

    if (silent) return true;
    state.line = line + 1;
    return true;
  });

  md.inline.ruler.before('emphasis', 'html_comment', (state, silent) => {
    if (!state.src.startsWith(OPEN, state.pos)) return false;
    const end = state.src.indexOf(CLOSE, state.pos + OPEN.length);
    // The comment must be fully inside the current inline range.
    if (end === -1 || end + CLOSE.length > state.posMax) return false;
    // silent (skipToken) contract: advance `state.pos` so a comment inside a
    // link label `[[name|a<!-- c -->b]]` does not make markdown-it throw.
    if (silent) {
      state.pos = end + CLOSE.length;
      return true;
    }
    // Source map (ошибка 29aa3108): leave a zero-length marker token so the
    // shift map sees the comment's source run. `content: ''` renders nothing —
    // `text_join` merges it into the neighbouring text without adding output,
    // so the default pipeline is byte-for-byte unchanged.
    if (sourceMapEnabled(state.env)) {
      const marker = state.push('text_special', '', 0);
      marker.content = '';
      marker.markup = state.src.slice(state.pos, end + CLOSE.length);
    }
    state.pos = end + CLOSE.length;
    return true;
  });
}
