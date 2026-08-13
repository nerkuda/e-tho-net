/**
 * Transient notification toast (bottom-right, auto-dismisses).
 *
 * Used for non-blocking feedback: realtime conflicts, drag feedback, batch
 * operation results. Blocking questions go through the dialog module.
 */

import { button, div, span } from './dom.js';

/** Dismiss delay, ms. */
const TTL_MS = 4_000;

/**
 * Shows a toast with the given text. `kind = 'error'` marks it red.
 */
export function notice(text: string, kind: 'info' | 'error' = 'info'): void {
  const box = div(`notice${kind === 'error' ? ' error' : ''}`);
  box.append(span(text, 'notice-text'));
  box.append(button('×', () => box.remove(), 'notice-close'));
  document.body.append(box);
  window.setTimeout(() => box.remove(), TTL_MS);
}
