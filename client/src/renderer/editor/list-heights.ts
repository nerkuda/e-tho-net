/**
 * Persistent fixed heights of the editor lists and the chronicle screen areas
 * (bug ee745368; always-fixed policy since bug 6b757336; bug 4cc6248c extended
 * the policy to every group with a `persistKey` rowSplitter).
 *
 * A manual splitter drag is remembered as the area's **fixed** height
 * (08-ui-spec.md §6.3, §17.1): on every content refresh the visible height
 * stays exactly this value regardless of the row count — fewer rows leave
 * empty space, more rows scroll. This is deliberate: an area whose height
 * tracked the row count used to collapse and jump back on every reload
 * (property edits, chronicle/attachments refresh) or on
 * switching between thoughts with a different amount of content — the
 * visible "jitter" reported in bug 6b757336. The values are global per
 * screen (not per entity/record), live in the store-free module map and are
 * persisted to L4 ui_state split by owning screen — editor keys under
 * `editor_list_heights`, `chronicle.*` keys under `chronicle_list_heights` —
 * with the same mechanism as `editor_collapsed_groups` (debounced
 * `etn.ui.setState`, per client × user × network, loaded by `openNetwork`).
 *
 * Two application channels (both still keyed by CSS var name `--clamp-*` /
 * function name `applyGroupClamp` for historical reasons — the values they
 * carry are exact heights now, not caps):
 *  - table/list wrappers (`.prop-wrap`, `.chrono-table`, `.attachments-list`)
 *    read the fixed height from a `--clamp-*` CSS custom property set on the
 *    editor scroll box — the property survives the editor re-renders (the
 *    scroll box is only cleared, never replaced), and the CSS fallback keeps
 *    the spec default (five rows) until the user drags;
 *  - groups with a `persistKey` rowSplitter (the «Связи» tab groups, the
 *    «Свойства типа» group, the chronicle screen areas) read the fixed
 *    height inline via `applyGroupClamp` — the inline `height` is re-applied
 *    on every tab rebuild and is paired with `flex-grow: 0` so the area
 *    keeps its saved size instead of flex-filling the remaining space (bug
 *    4cc6248c: was a `max-height` cap, so dragging was content-bound and the
 *    user could never grow the group past its current rows).
 */

import { UI_STATE_KEY } from '@etn/shared';

import { etn } from '../lib/etn.js';
import { store } from '../state.js';

/** Debounce for persisting the heights after a drag, ms. */
const PERSIST_DEBOUNCE_MS = 300;

/**
 * Keys whose target element reads the cap from a CSS custom property. The
 * variable is set on the editor scroll box (see {@link setClampRoot}); the
 * stylesheet provides the default (five visible rows) via `var(..., fallback)`.
 * `rowSplitter` consults this table to keep `props`/`chrono`/`attachments`
 * drag-ranges pinned to the natural content height — letting them stretch
 * past it would persist a huge value into the CSS variable and inflate the
 * table to that height on every render.
 */
export const CSS_VAR_KEYS: Record<string, string> = {
  props: '--clamp-props',
  chrono: '--clamp-chrono',
  attachments: '--clamp-attachments',
};

/** In-memory map of saved caps, px (persistKey → max height). */
let clamps: Record<string, number> = {};

/**
 * persistKeys of the chronicle screen (`chronicle.*`): their caps are stored
 * under the L4 `chronicle_list_heights` key; every other key belongs to the
 * editor (`editor_list_heights`). Clamps are only ever added, so a scope that
 * is empty has never stored anything and is skipped on save.
 */
const CHRONICLE_KEY_PREFIX = 'chronicle.';

/** Element that carries the `--clamp-*` variables (the editor scroll box). */
let clampRoot: HTMLElement | null = null;

/** Debounced-persist timer handle. */
let persistTimer: number | null = null;

/** Replaces the in-memory map (network open loads the L4 ui_state). */
export function initListClamps(parsed: Record<string, number>): void {
  clamps = parsed;
  applyClampVars();
}

/** The saved max height for a list, or null when the user never dragged it. */
export function getListClamp(key: string): number | null {
  return clamps[key] ?? null;
}

/**
 * Remembers a manually dragged height as the list's maximum: updates the map,
 * refreshes the CSS variable at once (so the very next re-render — e.g. after
 * switching to another thought — picks the new cap) and persists debounced.
 */
export function saveListClamp(key: string, px: number): void {
  clamps = { ...clamps, [key]: Math.round(px) };
  if (clampRoot !== null && CSS_VAR_KEYS[key] !== undefined) {
    clampRoot.style.setProperty(CSS_VAR_KEYS[key], `${Math.round(px)}px`);
  }
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    const networkId = store.state.networkId;
    if (networkId === null) return;
    persistClamps(networkId);
  }, PERSIST_DEBOUNCE_MS);
}

/** Writes the in-memory caps to L4, split per owning screen (see above). */
function persistClamps(networkId: string): void {
  const editor: Record<string, number> = {};
  const chronicle: Record<string, number> = {};
  for (const [key, px] of Object.entries(clamps)) {
    if (key.startsWith(CHRONICLE_KEY_PREFIX)) chronicle[key] = px;
    else editor[key] = px;
  }
  if (Object.keys(editor).length > 0) {
    void etn.ui
      .setState(networkId, UI_STATE_KEY.EDITOR_LIST_HEIGHTS, JSON.stringify(editor))
      .catch(() => undefined);
  }
  if (Object.keys(chronicle).length > 0) {
    void etn.ui
      .setState(networkId, UI_STATE_KEY.CHRONICLE_LIST_HEIGHTS, JSON.stringify(chronicle))
      .catch(() => undefined);
  }
}

/**
 * Registers the element that carries the `--clamp-*` variables and applies the
 * saved caps to it. Runs at every editor mount (each network open re-mounts
 * the editor); stale variables of the previous network are cleared first.
 */
export function setClampRoot(root: HTMLElement | null): void {
  clampRoot = root;
  applyClampVars();
}

/** (Re)applies the saved caps as `--clamp-*` variables on the root. */
function applyClampVars(): void {
  if (clampRoot === null) return;
  for (const varName of Object.values(CSS_VAR_KEYS)) {
    clampRoot.style.removeProperty(varName);
  }
  for (const [key, varName] of Object.entries(CSS_VAR_KEYS)) {
    const px = clamps[key];
    if (px !== undefined) clampRoot.style.setProperty(varName, `${px}px`);
  }
}

/**
 * Applies a saved height to an area that lives for the whole mount
 * («Связи» tab groups, the «Свойства типа» group, the chronicle screen
 * areas — rebuilt with the tab / on every network open): inline `height`
 * plus `flex-grow: 0` and `flex-basis: auto`, so the area keeps the exact
 * size the user dragged (more rows scroll inside, fewer leave empty space)
 * instead of flex-filling the remaining space. No-op when the user has
 * never dragged this splitter — the area keeps the CSS-default flex layout.
 *
 * Always-fixed policy (bug 6b757336, bug 4cc6248c): the inline `height` is
 * re-applied on every tab rebuild, so the saved size survives entity
 * changes and restarts. Any stale `max-height` (the older «cap» channel) is
 * cleared so a leftover inline cap cannot clip the new fixed `height`.
 */
export function applyGroupClamp(group: HTMLElement, key: string): void {
  const px = clamps[key];
  if (px === undefined) return;
  group.style.height = `${px}px`;
  group.style.flexGrow = '0';
  group.style.flexBasis = 'auto';
  group.style.maxHeight = '';
}
