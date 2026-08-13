/**
 * Screen manager: owns the `#app` root and swaps onboarding / networks /
 * workspace screens (H1 layout, H2 onboarding, H3 network list).
 */

import { clear } from '../lib/dom.js';
import { store, type Screen } from '../state.js';
import { buildOnboarding } from './onboarding.js';
import { buildNetworks } from './networks.js';
import { buildWorkspace } from './workspace.js';

let root: HTMLElement | null = null;

/** Mounts the screen root. Called once at boot. */
export function initScreens(rootEl: HTMLElement): void {
  root = rootEl;
}

/** Switches the visible screen, tearing down the previous one. */
export function showScreen(screen: Screen): void {
  if (root === null) throw new Error('initScreens was not called');
  clear(root);
  switch (screen) {
    case 'onboarding':
      root.append(buildOnboarding());
      break;
    case 'networks':
      root.append(buildNetworks());
      break;
    case 'workspace':
      root.append(buildWorkspace());
      break;
  }
  store.update({ screen });
}
