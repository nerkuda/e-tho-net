/**
 * Keywords mini-syntax of the structures filter (03-server-api.md §6.10).
 *
 * Words are separated by whitespace, all of them are required (AND), the order
 * is arbitrary. `*` inside a word matches any run of characters; a leading `-`
 * marks an exclusion — the word must not appear in the title or the synonyms.
 * Example: `счет* -вод*` matches «Счетчик электричества» but not «счета за воду».
 *
 * Pure functions on strings, shared by the server (SQL parameter building) and
 * the client (tests), no platform dependencies.
 */

/** Parsed keywords: required words and exclusions, `*` kept as typed. */
export interface FilterKeywords {
  include: string[];
  exclude: string[];
}

/** Splits a raw keywords input into include/exclude words (`-word` = exclude). */
export function parseFilterKeywords(input: string): FilterKeywords {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of input.split(/\s+/)) {
    if (raw === '') continue;
    if (raw.startsWith('-')) {
      const word = raw.slice(1);
      if (word !== '') exclude.push(word);
      continue;
    }
    include.push(raw);
  }
  return { include, exclude };
}

/**
 * Converts one keyword into a parameterized LIKE pattern with `\` as the escape
 * character: `%`/`_`/`\` are escaped, `*` becomes `%`. The pattern is wrapped in
 * `%…%` so the keyword matches anywhere in the title/synonym (both user
 * examples of §6.10 rely on infix matching).
 */
export function buildLikePattern(word: string): string {
  const escaped = word.replace(/[\\%_]/g, (ch) => `\\${ch}`).replace(/\*/g, '%');
  return `%${escaped}%`;
}

/**
 * Normalized comparison key of a type name: trimmed and lower-cased. Thought
 * and link type names must be unique ignoring case (`Тип` = `тип` = `ТИП`,
 * docs/02-data-model.md §3.3/§3.7). The server stores the key alongside the
 * name (`name_key`, `name_forward_key`, `name_reverse_key`) and checks
 * duplicates against it; the client uses this helper for live duplicate
 * warnings in the type editors (08-ui-spec.md §8.1). Mirrors the
 * `type_name_key` SQL function registered by the server for migration
 * backfills.
 */
export function typeNameKey(name: string): string {
  return name.trim().toLowerCase();
}
