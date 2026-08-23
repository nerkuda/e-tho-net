/**
 * Deep-link receiver (task R11, docs/12-wiki-id-refs.md §7.4).
 *
 * The renderer side of the `etn://open?…` protocol. The main process sends an
 * `etn:deep-link` IPC event with `{ networkId, thoughtId }` whenever the user
 * opens such a URL — either at cold start, via `second-instance`, or via
 * `open-url` (macOS). This handler:
 *
 *  1. Switches the active network to `networkId` via {@link openNetwork}.
 *  2. Tries to focus the thought (canvas / structures / chronicle — same
 *     rules as the in-app `openThoughtByRef` path).
 *  3. Surfaces failures as a toast: «Сеть недоступна», «Мысль удалена» or
 *     a generic load error.
 *
 * Wired once from `client/src/renderer/main.ts`.
 */

import type { DeepLink } from '@etn/shared';

import { openNetwork, requireNetworkId, setFocus } from '../app.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';

let wired = false;

/** Installs the `etn:deep-link` listener (call once from `main.ts`). */
export function initDeepLinkHandler(): void {
  if (wired) return;
  wired = true;
  etn.deepLink.onDeepLink((link) => {
    void handleDeepLink(link);
  });
}

async function handleDeepLink(link: DeepLink): Promise<void> {
  // 1. Switch to the target network if needed.
  const currentNetworkId = safeCurrentNetworkId();
  if (currentNetworkId !== link.networkId) {
    try {
      await openNetwork(link.networkId);
    } catch (err) {
      notice(`Сеть недоступна: ${errToText(err)}`, 'error');
      return;
    }
  }

  // 2. Try to fetch + open the thought.
  let thought;
  try {
    thought = await etn.thoughts.get(link.networkId, link.thoughtId);
  } catch (err) {
    notice(`Мысль удалена или недоступна: ${errToText(err)}`, 'error');
    return;
  }

  if (!thought.active && !store.state.showInactive) {
    notice(
      'Не могу открыть неактуальную мысль — неактуальные мысли не отображаются.',
      'error',
    );
    return;
  }

  // 3. Place the focus — `setFocus` is the canvas view's idempotent operation
  //    that updates the store and refreshes the screen. We don't route through
  //    `openThoughtByRef` because the latter is opinionated about the active
  //    view; a deep-link should always go to the canvas (the user's natural
  //    landing surface).
  await setFocus(thought.id);
}

function safeCurrentNetworkId(): string | null {
  try {
    return requireNetworkId();
  } catch {
    return null;
  }
}

function errToText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'unknown error';
}
