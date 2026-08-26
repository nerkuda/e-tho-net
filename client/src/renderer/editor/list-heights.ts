/**
 * Persistent max-heights of the editor lists (bug ee745368).
 *
 * A manual splitter drag is remembered as the **maximum** height of the list
 * it resized (08-ui-spec.md §6.3): on every content refresh the visible height
 * follows the row count and never exceeds the saved cap. The values are global
 * for the editor (not per entity), live in the store-free module map and are
 * persisted to the L4 `editor_list_heights` ui_state — the same mechanism as
 * `editor_collapsed_groups` (debounced `etn.ui.setState`, per client × user ×
 * network, loaded by `openNetwork`).
 *
 * Two application channels:
 *  - table/list wrappers (`.prop-wrap`, `.chrono-table`, `.attachments-list`)
 *    read the cap from a `--clamp-*` CSS custom property set on the editor
 *    scroll box — the property survives the editor re-renders (the scroll box
 *    is only cleared, never replaced), and the CSS fallback keeps the spec
 *    default (five rows) until the user drags;
 *  - whole-group targets of the «Связи» tab are clamped inline (max-height +
 *    `flex-grow: 0`, so a clamped group shrinks to its content instead of
 *    flex-filling the tab) — the group element exists synchronously at build
 *    time, so the clamp is re-applied on every rebuild.
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
 */
const CSS_VAR_KEYS: Record<string, string> = {
  props: '--clamp-props',
  chrono: '--clamp-chrono',
  attachments: '--clamp-attachments',
};

/** In-memory map of saved caps, px (persistKey → max height). */
let clamps: Record<string, number> = {};

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
    void etn.ui
      .setState(networkId, UI_STATE_KEY.EDITOR_LIST_HEIGHTS, JSON.stringify(clamps))
      .catch(() => undefined);
  }, PERSIST_DEBOUNCE_MS);
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
 * Applies a saved cap to a whole-group resize target («Связи» tab): inline
 * `max-height` plus `flex-grow: 0`, so the group's height equals its content
 * (never more than the cap) instead of flex-filling the tab. No-op when the
 * user has never dragged this group's splitter.
 */
export function applyGroupClamp(group: HTMLElement, key: string): void {
  const px = clamps[key];
  if (px === undefined) return;
  group.style.maxHeight = `${px}px`;
  group.style.flexGrow = '0';
}
