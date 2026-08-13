/**
 * Typed access to the preload bridge. `window.etn` is declared in
 * `src/env.d.ts`; this module just re-exports it under a short name for the
 * renderer — the renderer never touches the network directly.
 *
 * The `typeof window` guard keeps the module importable from Node unit tests
 * (window is only present in the renderer process).
 */

import type { EtnApi } from '../../main/ipc/contract.js';

export const etn: EtnApi =
  typeof window === 'undefined' ? (undefined as unknown as EtnApi) : window.etn;
