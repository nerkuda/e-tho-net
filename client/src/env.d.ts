/// <reference types="vite/client" />

/**
 * Renderer-facing API injected by the preload script (`src/preload/index.ts`)
 * via `contextBridge.exposeInMainWorld('etn', …)`.
 *
 * The single source of truth is `EtnApi` in `src/main/ipc/contract.ts`
 * (docs/07-client-electron.md §6). The renderer imports the type only — all
 * values cross the `etn:invoke` IPC channel.
 */
import type { EtnApi } from './main/ipc/contract.js';

declare global {
  interface Window {
    etn: EtnApi;
  }
}

export type { EtnApi };
