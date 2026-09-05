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
 * Builds the regex SOURCE of a synonym matcher (see
 * {@link synonymPatternToRegex} for the semantics). Exposed separately so
 * hot paths can compile whatever flag set they need (e.g. a global copy for
 * the §21 scan) directly from the source, without an extra base-RegExp
 * compilation.
 */
export function synonymPatternSource(synonym: string): string {
  const words = synonym.trim().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return '(?!)';
  const wordBody = (word: string): string =>
    word
      .split('*')
      .map((part) => (part === '' ? '' : regexEscape(part)))
      .join('\\S*');
  const core = words.map(wordBody).join('\\s+');
  return `(?:^|[^\\p{L}\\p{N}_])${core}(?=[^\\p{L}\\p{N}_]|$)`;
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
  return new RegExp(synonymPatternSource(synonym), 'iu');
}

// ---------------------------------------------------------------------------
// Case folding + prefilter helpers for the §21 mentions scan
// (findMentionsInTexts): the scan matches ~thousands of patterns against each
// text, so it first rejects candidates with cheap string operations and only
// then runs the regex.
// ---------------------------------------------------------------------------

/**
 * Single-character case-fold normalisations applied on top of
 * `toLowerCase()`.
 *
 * The regex `i` flag (with `u`) compares characters by Unicode SIMPLE case
 * folding (one code point → one code point, CaseFolding.txt statuses C/S),
 * while `String.prototype.toLowerCase()` applies the FULL case mapping. The
 * two disagree on a closed set of characters — mostly variant small letters
 * (`ς` vs `σ`, `ſ` vs `s`, `ẛ` vs `ṡ`, Greek symbol variants `ϑ`/`ϕ`/`ϖ`/…)
 * and letter-like symbols (`µ` MICRO SIGN vs `μ` GREEK SMALL LETTER MU). The
 * §21 prefilter compares case-folded strings, so BOTH sides (pattern markers
 * and scanned text) must fold with the same rules the `iu` regex applies, or
 * a true regex match could be rejected by the prefilter. Each entry maps such
 * a character to its simple-folding target; `ẞ` → `ß` agrees with
 * `toLowerCase()` already and is listed only to document the pair explicitly.
 * Full-mapping expansions (`İ` U+0130 → `i`+U+0307) cannot lose a match:
 * both sides expand identically inside the folded strings.
 */
const CASE_FOLD_FIXES: Readonly<Record<string, string>> = {
  '\u00B5': '\u03BC', // µ MICRO SIGN → μ GREEK SMALL LETTER MU
  '\u017F': 's', // ſ LATIN SMALL LETTER LONG S → s
  '\u03C2': '\u03C3', // ς GREEK SMALL LETTER FINAL SIGMA → σ
  '\u03D0': '\u03B2', // ϐ GREEK BETA SYMBOL → β
  '\u03D1': '\u03B8', // ϑ GREEK THETA SYMBOL → θ
  '\u03D5': '\u03C6', // ϕ GREEK PHI SYMBOL → φ
  '\u03D6': '\u03C0', // ϖ GREEK PI SYMBOL → π
  '\u03F0': '\u03BA', // ϰ GREEK KAPPA SYMBOL → κ
  '\u03F1': '\u03C1', // ϱ GREEK RHO SYMBOL → ρ
  '\u03F5': '\u03B5', // ϵ GREEK LUNATE EPSILON SYMBOL → ε
  '\u1C80': '\u0432', // ᲀ CYRILLIC SMALL LETTER ROUNDED VE → в
  '\u1C81': '\u0430', // ᲁ → а
  '\u1C82': '\u0434', // ᲂ → д
  '\u1C83': '\u0435', // ᲃ → е
  '\u1C84': '\u043B', // ᲄ → л
  '\u1C85': '\u043F', // ᲅ → п
  '\u1C86': '\u0440', // ᲆ → р
  '\u1C87': '\u0442', // ᲇ → т
  '\u1C88': '\u0449', // ᲈ → щ
  '\u1E9B': '\u1E61', // ẛ LATIN SMALL LETTER LONG S WITH DOT ABOVE → ṡ
  '\u1E9E': '\u00DF', // ẞ LATIN CAPITAL LETTER SHARP S → ß (= toLowerCase)
};
const CASE_FOLD_FIX_RE =
  /[\u00B5\u017F\u03C2\u03D0\u03D1\u03D5\u03D6\u03F0\u03F1\u03F5\u1C80-\u1C88\u1E9B\u1E9E]/g;

/**
 * Folds `value` into a canonical case-comparison key: `toLowerCase()` plus
 * the simple-folding fixes above. Used by the §21 scan prefilter on BOTH
 * sides (pattern markers and scanned text) so that the cheap comparison
 * never rejects a string the `iu` regex would match.
 */
export function foldCase(value: string): string {
  return value.toLowerCase().replace(CASE_FOLD_FIX_RE, (c) => CASE_FOLD_FIXES[c]!);
}

/** A maximal run of mention "word" characters (see {@link splitMentionWords}). */
const MENTION_WORD_RUN_RE = /[\p{L}\p{N}_]+/gu;

/**
 * Splits `text` into word tokens: maximal runs of letters, digits and
 * underscore — the exact character class the synonym regex treats as word
 * characters for its boundaries. Everything else (whitespace, punctuation,
 * combining marks) is a separator.
 */
export function splitMentionWords(text: string): string[] {
  return text.match(MENTION_WORD_RUN_RE) ?? [];
}

/** Literal prefilter markers of one synonym pattern ({@link mentionPrefilterMarkers}). */
export interface MentionPrefilterMarkers {
  /**
   * Folded whole words: each must occur as an exact standalone token of the
   * scanned text (the tokenizer uses the same character class as the regex
   * boundaries, so a whole-word regex match is impossible without it).
   */
  wordMarkers: string[];
  /**
   * Folded literal chunks: each must occur somewhere as a substring of the
   * folded scanned text (a literal chunk of a `*`-word is a non-whitespace
   * run, so any regex match contains it verbatim).
   */
  substringMarkers: string[];
}

/** True when a pattern word consists entirely of word characters (`\p{L}\p{N}_`). */
const IS_PLAIN_WORD_RE = /^[\p{L}\p{N}_]+$/u;

/**
 * Precomputes the cheap literal markers of one synonym pattern for the §21
 * scan prefilter. Per pattern word:
 *   - a `*`-free word made only of word characters contributes a WORD marker
 *     (checked against the text's token set);
 *   - a `*`-word contributes SUBSTRING markers for its non-empty literal
 *     chunks; any other word with separator characters (e.g. `C++`, `d.e`)
 *     also falls back to a SUBSTRING marker for the whole word, because the
 *     tokenizer would split it.
 *
 * A pattern with no markers at all (e.g. the synonym `*`) has nothing to
 * check and always passes to the regex — the prefilter is conservative by
 * construction.
 */
export function mentionPrefilterMarkers(synonym: string): MentionPrefilterMarkers {
  const wordMarkers: string[] = [];
  const substringMarkers: string[] = [];
  for (const word of synonym.trim().split(/\s+/)) {
    if (word === '') continue;
    if (word.includes('*')) {
      for (const chunk of word.split('*')) {
        if (chunk !== '') substringMarkers.push(foldCase(chunk));
      }
    } else if (IS_PLAIN_WORD_RE.test(word)) {
      wordMarkers.push(foldCase(word));
    } else {
      substringMarkers.push(foldCase(word));
    }
  }
  return { wordMarkers, substringMarkers };
}

/**
 * Conservative prefilter for one pattern against one already-folded text
 * (the folded full text plus the set of its folded word tokens): `true` when
 * every marker is satisfied — or when the pattern has no markers, in which
 * case the regex must run. May return `true` for patterns the regex then
 * rejects (that only costs time); never returns `false` for a pattern the
 * regex would match.
 */
export function mentionPrefilterPass(
  markers: MentionPrefilterMarkers,
  foldedText: string,
  foldedWords: ReadonlySet<string>,
): boolean {
  for (const word of markers.wordMarkers) {
    if (!foldedWords.has(word)) return false;
  }
  for (const chunk of markers.substringMarkers) {
    if (!foldedText.includes(chunk)) return false;
  }
  return true;
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
