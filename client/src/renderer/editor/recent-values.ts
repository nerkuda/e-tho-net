/**
 * Recent-values suggestions for single `text` and `thought_ref` property
 * editors (task «Помощь с заполнением значений свойств», 2026-09-02).
 *
 * When editing homogeneous thoughts the same property values repeat; this
 * module keeps a client-LOCAL history (localStorage, key = network id +
 * property id — the server and the API are untouched) and offers it as a
 * dropdown under the value field:
 *  - focusing an EMPTY field — or clearing it back to empty — opens the list
 *    of the 10 most recently saved values of that property (for `thought_ref`
 *    the stored thought ids are resolved to titles; unresolvable entries are
 *    skipped, never shown raw);
 *  - ↑/↓ move the highlight, Enter picks the highlighted row (without a
 *    highlight — the first one, the same rule as the candidate search);
 *    Escape and outside clicks close the list without touching the field;
 *  - typing closes the list so the field's regular behaviour takes over (for
 *    `thought_ref` — the live candidate search; for `text` with predefined
 *    options — the options dropdown).
 *
 * The history is recorded by the properties editor on every successful save
 * of a single text/thought_ref value. Multiple-value properties
 * (`config.multiple`) keep no history at all.
 */

import type { ThoughtRef } from '@etn/shared';

import { div, el, positionBodyDropdown } from '../lib/dom.js';
import { etn } from '../lib/etn.js';

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

/** One pickable row of the recent-values dropdown. */
export interface RecentValueEntry {
  /** The value to save when picked (the text itself or a thought id). */
  value: string;
  /** What the row shows (the text itself or the resolved thought title). */
  label: string;
}

/**
 * Loads the history of a single `thought_ref` property as pickable entries:
 * the stored ids resolve through the shared ref cache (filled by the
 * properties table), the missing ones via one `thoughts.resolve` call; ids
 * that do not resolve (deleted thoughts) are skipped, never shown raw.
 */
export async function loadRecentRefEntries(
  networkId: string,
  propertyId: string,
  refs: Map<string, ThoughtRef>,
): Promise<RecentValueEntry[]> {
  const ids = loadRecentValues(networkId, propertyId);
  if (ids.length === 0) return [];
  const missing = ids.filter((id) => !refs.has(id));
  if (missing.length > 0) {
    try {
      for (const ref of await etn.thoughts.resolve(networkId, missing)) refs.set(ref.id, ref);
    } catch {
      // Offline blips — show whatever the cache already knows.
    }
  }
  const entries: RecentValueEntry[] = [];
  for (const id of ids) {
    const ref = refs.get(id);
    if (ref !== undefined) entries.push({ value: id, label: ref.title });
  }
  return entries;
}

/** Pure index math for ↑/↓ over the rows (the same rule as the candidate search). */
function navIndex(cursor: number | null, count: number, delta: 1 | -1): number | null {
  if (count === 0) return null;
  const base = cursor === null || cursor >= count ? (delta === 1 ? -1 : count) : cursor;
  return Math.min(count - 1, Math.max(0, base + delta));
}

/**
 * Wires the recent-values dropdown to a property value input. Focus on the
 * empty field — and clearing it back to empty — opens the list built from
 * {@link opts.load}; typing closes it so the field's regular behaviour takes
 * over. ↑/↓ move the highlight, Enter picks the highlighted row (without a
 * highlight — the first one, the same rule as the candidate search), Escape
 * and outside clicks close the list without changing the field. The dropdown
 * reuses the type-combobox classes and `positionBodyDropdown` — the same
 * mechanics as the predefined-options picker and the candidate search.
 */
export function wireRecentValues(
  input: HTMLInputElement,
  opts: {
    load: () => RecentValueEntry[] | Promise<RecentValueEntry[]>;
    onPick: (entry: RecentValueEntry) => void;
  },
): void {
  let list: HTMLDivElement | null = null;
  let rows: HTMLElement[] = [];
  /** Keyboard cursor over the dropdown rows (↑/↓, Enter). */
  let cursor: number | null = null;
  let focused = false;
  let seq = 0;

  const close = (): void => {
    if (list === null) return;
    list.remove();
    list = null;
    window.removeEventListener('mousedown', onOutside, true);
  };

  const onOutside = (event: MouseEvent): void => {
    if (
      list !== null &&
      event.target instanceof Node &&
      !list.contains(event.target) &&
      event.target !== input
    ) {
      close();
    }
  };

  const paintRows = (): void => {
    rows.forEach((row, i) => row.classList.toggle('active', i === cursor));
    if (cursor !== null) rows[cursor]?.scrollIntoView({ block: 'nearest' });
  };

  const open = (): void => {
    // Only an EMPTY field shows the history — with a value there is nothing
    // to suggest (and the regular search owns the typed text).
    if (input.value !== '') return;
    const run = ++seq;
    void Promise.resolve()
      .then(opts.load)
      .then((entries) => {
        // A keystroke, blur or editor re-render may have won the race.
        if (run !== seq || !focused || input.value !== '' || !input.isConnected) return;
        if (entries.length === 0 || list !== null) return;
        list = div('type-combo-list');
        cursor = null;
        list.append(el('p', 'muted type-combo-empty', 'Последние значения'));
        rows = entries.map((entry) => {
          const row = div('type-combo-item');
          const label = el('span', 'type-combo-label', entry.label);
          label.title = entry.label;
          label.style.flex = '1';
          row.append(label);
          // Keep the focus in the input — no blur-commit while picking.
          row.addEventListener('mousedown', (event) => event.preventDefault());
          row.addEventListener('click', () => {
            close();
            opts.onPick(entry);
          });
          return row;
        });
        list.append(...rows);
        document.body.append(list);
        positionBodyDropdown(list, input);
        window.addEventListener('mousedown', onOutside, true);
      })
      .catch(() => undefined);
  };

  input.addEventListener('focus', () => {
    focused = true;
    open();
  });
  input.addEventListener('input', () => {
    // Typing closes the history so the regular behaviour takes over;
    // clearing the field back to empty opens it again.
    if (input.value === '') open();
    else close();
  });
  input.addEventListener('keydown', (event) => {
    if (list === null) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rows.length === 0) return;
      event.preventDefault();
      const next = navIndex(cursor, rows.length, event.key === 'ArrowDown' ? 1 : -1);
      if (next === null) return;
      cursor = next;
      paintRows();
    } else if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      // Enter (with or without Ctrl) picks the highlighted row — the same
      // effect as clicking it; without a highlight the first row wins.
      if (rows.length === 0) return;
      event.preventDefault();
      rows[cursor ?? 0]?.click();
    }
  });
  input.addEventListener('blur', () => {
    focused = false;
    close();
  });
}
