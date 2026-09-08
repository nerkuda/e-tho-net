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

/**
 * Resolves the current `window.etn` lazily. `lib/etn.ts` is imported by the
 * renderer modules as well as Node unit tests; the renderer always has
 * `window` defined (preload runs first), but the test harness may not.
 * Looking up `window` on every property access keeps the Proxy correct in
 * both worlds without imposing a load-order constraint on the test
 * bootstrap.
 */
function readWindow(): { etn?: EtnApi } | null {
  if (typeof window === 'undefined') {
    return (globalThis as { etn?: EtnApi }).etn !== undefined
      ? (globalThis as unknown as { etn?: EtnApi })
      : null;
  }
  return window as unknown as { etn?: EtnApi };
}

export const etn: EtnApi = new Proxy(
  // The target is never actually read — every access forwards to `window.etn`.
  {} as EtnApi,
  {
    get(_target, prop: string) {
      const w = readWindow();
      const api = w?.etn;
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
