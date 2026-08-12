/// <reference types="vite/client" />

/**
 * Renderer-facing API injected by the preload script (`src/preload/index.ts`)
 * via `contextBridge.exposeInMainWorld('etn', …)`.
 *
 * The surface is intentionally empty for G1; task G7 fills it in with the full
 * typed contract from docs/07-client-electron.md §6.
 */
interface Window {
  etn: EtnApi;
}

/**
 * IPC contract between renderer and main process.
 *
 * For G1 this is an empty placeholder (no methods exposed yet). G7 replaces it
 * with the full `window.etn` surface (server, networks, thoughts, …).
 */
type EtnApi = Record<string, never>;
