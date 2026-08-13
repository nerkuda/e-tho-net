/**
 * Onboarding screen (H2): first-run connection to an ETN server.
 *
 * H1 ships only the static frame; the form (URL + API-key → `server.addProfile`)
 * lands in H2.
 */

import { div, el } from '../lib/dom.js';

/** Builds the onboarding screen DOM. */
export function buildOnboarding(): HTMLElement {
  const root = div('screen screen-onboarding');
  const card = div('card onboarding-card');

  card.append(el('h1', 'onboarding-title', 'ETN'));
  card.append(el('p', 'onboarding-sub', 'Подключение к серверу появится в задаче H2.'));
  root.append(card);
  return root;
}
