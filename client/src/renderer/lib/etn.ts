/**
 * Typed access to the preload bridge. `window.etn` is declared in
 * `src/env.d.ts`; this module just re-exports it under a short name for the
 * renderer — the renderer never touches the network directly.
 */
export const etn = window.etn;
