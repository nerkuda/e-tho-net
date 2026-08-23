/**
 * Renderer entry point (phase H).
 *
 * Mounts the screen root, wires global keyboard shortcuts and boots the
 * application controller (`app.ts`). All network access goes through the
 * preload `window.etn` bridge — the renderer never touches the wire itself.
 */

import { boot, initKeyboard } from './app.js';
import { initDrafts } from './drafts.js';
import { initDeepLinkHandler } from './editor/deep-link-handler.js';
import { initWikiLinkNavigation } from './editor/wiki-link.js';
import { div, el } from './lib/dom.js';
import { initImageZoom } from './lib/image-zoom.js';
import { initScreens } from './screens/screens.js';

const appRoot = document.querySelector('#app');
if (!(appRoot instanceof HTMLElement)) {
  throw new Error('Renderer root element #app not found in index.html');
}

initScreens(appRoot);
initKeyboard();
initDrafts();
initImageZoom();
initWikiLinkNavigation();
initDeepLinkHandler();

void boot().catch((err: unknown) => {
  // Catastrophic boot failure (local DB unavailable) — render a static message.
  const fallback = div('screen screen-onboarding');
  const card = div('card onboarding-card');
  card.append(el('h1', 'onboarding-title', 'ETN'));
  card.append(
    el(
      'p',
      'onboarding-error',
      err instanceof Error ? err.message : 'Не удалось запустить приложение.',
    ),
  );
  fallback.append(card);
  appRoot.replaceChildren(fallback);
});
