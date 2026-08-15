/**
 * UI theme control (L10, 08-ui-spec.md §13).
 *
 * The theme is an L5 installation-scoped `client_meta.theme` value
 * (11-settings-and-state.md §2.1): it applies to every screen — onboarding,
 * network list, workspace — and is restored on boot BEFORE the first screen
 * mounts, so there is no light-theme flash. Applying the theme sets the
 * `data-theme` attribute on the document root; colours themselves live in the
 * `[data-theme='dark']` variable block in styles.css.
 *
 * The store keeps the current theme so hover-dependent redraws (link lines
 * read the themed `--link-default` variable) and the View-menu checkbox can
 * react without DOM polling.
 */

import { CLIENT_META_KEY } from '@etn/shared';
import { etn } from './etn.js';
import { parseTheme } from '../lib/pure.js';
import { store } from '../state.js';

/** Applies a theme to the document root and the store. */
function apply(theme: 'light' | 'dark'): void {
  document.documentElement.dataset['theme'] = theme;
  store.update({ theme });
}

/**
 * Loads the stored theme and applies it. Called once on boot; failures fall
 * back to the light theme (a broken client_meta row must not block startup).
 */
export async function initTheme(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await etn.meta.get(CLIENT_META_KEY.THEME);
  } catch {
    raw = null;
  }
  apply(parseTheme(raw));
}

/**
 * Toggles between the light and dark theme (View menu). The choice is
 * persisted to L5 `client_meta.theme` fire-and-forget: the UI switches
 * immediately, a failed write only means the choice is not remembered.
 */
export function toggleTheme(): void {
  const next = store.state.theme === 'dark' ? 'light' : 'dark';
  apply(next);
  void etn.meta.set(CLIENT_META_KEY.THEME, next).catch(() => undefined);
}
