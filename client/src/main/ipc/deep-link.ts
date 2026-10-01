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

import {
  extractDeepLinkFromArgv,
  extractPublicationDeepLinkFromArgv,
  type DeepLink,
  type PublicationDeepLink,
} from '@etn/shared';

/** Channel name listened to by `client/src/renderer/editor/deep-link-handler.ts`. */
export const DEEP_LINK_CHANNEL = 'etn:deep-link';

/**
 * Разобранная цель deep-link: мысль (`thoughtId`) или публикация
 * (`publicationId`, 0.11.1, задача 3275fd8d, требование 7f583ef9). Формы
 * взаимоисключающи — URL несёт ровно один параметр.
 */
export type DeepLinkPayload = DeepLink | PublicationDeepLink;

/**
 * Pull the first `etn://open?…` URL out of an argv-style array. Returns
 * `null` when no valid deep link is present (cold start without one, or
 * launch flags that happen to share the `etn` prefix but aren't our scheme).
 * Сначала пробуется форма публикации, затем мысли.
 */
export function extractDeepLink(argv: readonly string[]): DeepLinkPayload | null {
  return extractPublicationDeepLinkFromArgv(argv) ?? extractDeepLinkFromArgv(argv);
}

/**
 * Send a parsed deep-link payload to the renderer's main window. If no window
 * is open yet (cold start before `whenReady`), the caller should buffer the
 * payload and replay it after `createWindow` resolves.
 */
export function dispatchDeepLink(window: BrowserWindow, payload: DeepLinkPayload): void {
  window.webContents.send(DEEP_LINK_CHANNEL, payload);
}
