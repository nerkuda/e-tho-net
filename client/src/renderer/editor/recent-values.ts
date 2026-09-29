/**
 * Recent-values store for single `text` property editors (task
 * «Помощь с заполнением значений свойств», 2026-09-02; ссылочные значения
 * удалены вместе с видом `thought_ref` — миграция 040).
 *
 * When editing homogeneous thoughts the same property values repeat; this
 * module keeps a client-LOCAL history (localStorage, key = network id +
 * property id — the server and the API are untouched) and exposes it as a
 * source of the shared suggestions dropdown (`lib/suggest-dropdown.ts`,
 * `historySuggestSource`): focusing an EMPTY field — or clearing it back to
 * empty — opens the list of the 10 most recently saved values of that
 * property. The dropdown mechanics (↑/↓, Enter, Escape, outside click, blur)
 * live in that one module — this file owns storage only.
 *
 * The history is recorded by the properties editor on every successful save
 * of a single text value. Multiple-value properties (`config.multiple`) keep
 * no history at all. A text property declared with a closed list of options
 * (`config.options`) keeps no history either — its dropdown shows that list
 * itself, opened right on field focus (карточка ошибки 4a96d07a).
 */

/** History length per property (the agreed product decision: 10 entries). */
export const RECENT_VALUES_MAX = 10;

/** localStorage key of one property's history: network id + property id. */
export function recentValuesStorageKey(networkId: string, propertyId: string): string {
  return `props.recent.${networkId}.${propertyId}`;
}

/** Parses a stored history blob: strings only, non-empty, capped at 10. */
export function parseRecentValues(raw: string | null): string[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .slice(0, RECENT_VALUES_MAX);
}

/**
 * Adds a value to a history: trimmed, placed first; a repeat lifts to the top
 * without duplicates; the list is capped at {@link RECENT_VALUES_MAX} entries.
 * An empty (whitespace-only) value leaves the history unchanged. Pure — the
 * caller owns persistence.
 */
export function mergeRecentValue(prev: readonly string[], value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === '') return [...prev];
  return [trimmed, ...prev.filter((v) => v !== trimmed)].slice(0, RECENT_VALUES_MAX);
}

/** localStorage behind a guard: unavailable (Node tests, hardened contexts) → null. */
function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Reads one property's history (empty when storage is unavailable/corrupt). */
export function loadRecentValues(networkId: string, propertyId: string): string[] {
  const ls = storage();
  if (ls === null) return [];
  try {
    return parseRecentValues(ls.getItem(recentValuesStorageKey(networkId, propertyId)));
  } catch {
    return [];
  }
}

/** Records a saved value into the property's history (best effort). */
export function recordRecentValue(networkId: string, propertyId: string, value: string): void {
  const ls = storage();
  if (ls === null) return;
  const key = recentValuesStorageKey(networkId, propertyId);
  let prev: string[];
  try {
    prev = parseRecentValues(ls.getItem(key));
  } catch {
    prev = [];
  }
  try {
    ls.setItem(key, JSON.stringify(mergeRecentValue(prev, value)));
  } catch {
    // Full or unavailable — the history is a convenience, not critical data.
  }
}
