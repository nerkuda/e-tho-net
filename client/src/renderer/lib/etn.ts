/**
 * Typed access to the preload bridge. `window.etn` is declared in
 * `src/env.d.ts`; this module re-exports it under a short name for the
 * renderer — the renderer never touches the network directly.
 *
 * IMPORTANT: the export is a **live Proxy** that reads `window.etn` on every
 * property access, not a snapshot taken at module-import time. In Vite dev
 * (ESM, lazy module evaluation) a static `export const etn = window.etn` can
 * capture `undefined` if this module is evaluated a tick before the
 * `contextBridge` exposes the API; the Proxy sidesteps that race entirely.
 *
 * The `typeof window` guard keeps the module importable from Node unit tests.
 */

import type { EtnApi } from '../../main/ipc/contract.js';

const liveTarget = typeof window === 'undefined' ? null : window;

export const etn: EtnApi = new Proxy(
  // The target is never actually read — every access forwards to `window.etn`.
  {} as EtnApi,
  {
    get(_target, prop: string) {
      const api = (liveTarget as { etn?: EtnApi } | null)?.etn;
      if (!api) {
        throw new Error(
          `window.etn is not available yet (accessed .${prop} too early). ` +
            'Ensure the preload script has loaded.',
        );
      }
      return (api as unknown as Record<string, unknown>)[prop];
    },
  },
) as EtnApi;
