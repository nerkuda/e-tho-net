/// <reference types="vite/client" />

/**
 * Renderer-facing API injected by the preload script (`src/preload/index.ts`)
 * via `contextBridge.exposeInMainWorld('etn', …)`.
 *
 * The single source of truth is `EtnBridgeApi` in `src/main/ipc/contract.ts`
 * (docs/07-client-electron.md §6). The renderer imports the type only — all
 * values cross the `etn:invoke` IPC channel. The renderer public surface
 * (`EtnApi`, e.g. `structures.query(…, { signal })`) is provided by the facade
 * `renderer/lib/etn.ts`, which adapts it to this bridge shape (ошибка
 * b7cbd0e0: `AbortSignal` cannot cross the contextBridge).
 */
import type { EtnBridgeApi } from './main/ipc/contract.js';

declare global {
  interface Window {
    etn: EtnBridgeApi;
  }
}

export type { EtnBridgeApi };
