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
 * anywhere inside. A word boundary is the text start/end or any character
 * that is not a letter, digit or underscore, so a name inside quotes or
 * brackets («Проект А») is still found. Works identically for `*`-free
 * literal terms (a thought title or a title part, §2.2.3), which just become
 * an exact word-boundary phrase.
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
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${core}(?=[^\\p{L}\\p{N}_]|$)`, 'iu');
}

/**
 * Splits a (possibly compound) thought title into its matchable parts
 * (docs/08-ui-spec.md §2.2.3): parts are dot-separated, only the first
 * `maxParts - 1` dots are significant — everything after that stays one
 * trailing part (`maxParts` parts total, default 4).
 *
 * Text inside a matching pair of single or double quotes is an atomic part
 * regardless of dots inside it — the quote characters themselves are
 * dropped from the result (`Аптеки."Столичка.net"` → `Аптеки`,
 * `Столичка.net`). A quote that never closes is unpaired: everything from
 * it to the end of the title becomes the final part verbatim — no further
 * dots or quotes are processed there, and the unpaired quote character
 * itself is dropped (`Выводы."Все.Никаких выводов` → `Выводы`,
 * `Все.Никаких выводов`).
 *
 * Each part is trimmed of surrounding whitespace (so spaces around a dot
 * are insignificant); empty parts are dropped. A title with no significant
 * dots returns a one-element array with the trimmed title.
 */
export function splitCompoundTitle(title: string, maxParts = 4): string[] {
  const parts: string[] = [];
  let buffer = '';
  let delimitersUsed = 0;
  let i = 0;
  const n = title.length;
  while (i < n) {
    const c = title.charAt(i);
    if (c === '"' || c === "'") {
      const close = title.indexOf(c, i + 1);
      if (close === -1) {
        // Unpaired quote: the rest of the title is the final part, verbatim.
        buffer += title.slice(i + 1);
        break;
      }
      buffer += title.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === '.' && delimitersUsed < maxParts - 1) {
      parts.push(buffer.trim());
      buffer = '';
      delimitersUsed += 1;
      i += 1;
      continue;
    }
    buffer += c;
    i += 1;
  }
  parts.push(buffer.trim());
  return parts.filter((p) => p !== '');
}
