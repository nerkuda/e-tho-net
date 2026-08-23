/**
 * Deep-link dispatcher (task R11, docs/12-wiki-id-refs.md §7,
 * docs/07-client-electron.md §4).
 *
 * Sends an `etn:deep-link` IPC event to the renderer whenever the OS hands us
 * an `etn://open?net=<id>&thought=<id>` URL — either via cold-start argv,
 * a `second-instance` event (Win/Linux) or an `open-url` event (macOS).
 *
 * The renderer is the single owner of the user's "current network" and the
 * tab strip; this module is a thin pipe that hands it the parsed payload.
 */

import type { BrowserWindow } from 'electron';

import { extractDeepLinkFromArgv, type DeepLink } from '@etn/shared';

/** Channel name listened to by `client/src/renderer/editor/deep-link-handler.ts`. */
export const DEEP_LINK_CHANNEL = 'etn:deep-link';

/**
 * Pull the first `etn://open?…` URL out of an argv-style array. Returns
 * `null` when no valid deep link is present (cold start without one, or
 * launch flags that happen to share the `etn` prefix but aren't our scheme).
 */
export function extractDeepLink(argv: readonly string[]): DeepLink | null {
  return extractDeepLinkFromArgv(argv);
}

/**
 * Send a parsed deep-link payload to the renderer's main window. If no window
 * is open yet (cold start before `whenReady`), the caller should buffer the
 * payload and replay it after `createWindow` resolves.
 */
export function dispatchDeepLink(window: BrowserWindow, payload: DeepLink): void {
  window.webContents.send(DEEP_LINK_CHANNEL, payload);
}
