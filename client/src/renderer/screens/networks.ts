/**
 * Network list screen (H3): pick/create/open a мыслесеть.
 *
 * H1 ships only the static frame; the list and create dialog land in H3.
 */

import { div, el } from '../lib/dom.js';

/** Builds the network list screen DOM. */
export function buildNetworks(): HTMLElement {
  const root = div('screen screen-networks');
  const card = div('card networks-card');

  card.append(el('h1', 'networks-title', 'Мыслесети'));
  card.append(el('p', 'networks-sub', 'Список сетей появится в задаче H3.'));
  root.append(card);
  return root;
}
