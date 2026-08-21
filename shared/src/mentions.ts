/**
 * Pure text-matching helpers for the "mentions" family of features
 * (docs/03-server-api.md §13, §21; docs/02-data-model.md §3.2 — wildcard
 * synonym semantics).
 *
 * Shared by the server (§13 `findMentions`, §21 `findMentionsInTexts`) and, in
 * principle, testable from the client without platform dependencies — pure
 * functions on strings only.
 */

/** Escape regex meta-characters so a term can be used inside a RegExp literal. */
export function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a synonym (a single word or a whitespace-separated phrase) into a
 * case-insensitive matcher RegExp. `*` inside a pattern word matches any run
 * of non-whitespace characters (zero or more), so it never crosses a word
 * boundary. Pattern words must appear in the text as whole adjacent words in
 * the given order; the text may differ from the pattern only at `*`
 * positions. The match is not anchored to the text — a pattern matches
 * anywhere inside. Works identically for `*`-free literal terms (a thought
 * title or a title part, §2.2.3), which just become an exact word-boundary
 * phrase.
 */
export function synonymPatternToRegex(synonym: string): RegExp {
  const words = synonym.trim().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return /(?!)/u;
  const wordBody = (word: string): string =>
    word
      .split('*')
      .map((part) => (part === '' ? '' : regexEscape(part)))
      .join('\\S*');
  const core = words.map(wordBody).join('\\s+');
  return new RegExp(`(?:^|\\s)${core}(?=\\s|$)`, 'iu');
}

/**
 * Splits a (possibly compound) thought title into its matchable parts
 * (docs/08-ui-spec.md §2.2.3): parts are comma-separated, only the first 3
 * commas are significant — everything after the 3rd comma is one trailing
 * part (max 4 parts total). Each part is trimmed; empty parts are dropped.
 * A single-part (non-compound) title returns a one-element array with the
 * trimmed title.
 */
export function splitCompoundTitle(title: string): string[] {
  const parts: string[] = [];
  let rest = title;
  for (let i = 0; i < 3; i += 1) {
    const comma = rest.indexOf(',');
    if (comma === -1) break;
    parts.push(rest.slice(0, comma));
    rest = rest.slice(comma + 1);
  }
  parts.push(rest);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}
