/**
 * Transient notification toast (bottom-right, auto-dismisses).
 *
 * Used for non-blocking feedback: realtime conflicts, drag feedback, batch
 * operation results. Blocking questions go through the dialog module; ошибки
 * диалога — строкой в панели кнопок (`lib/ui/messages.ts`, требование
 * 397c5a56), тост для них не используется.
 */

import { button, div, span } from './dom.js';

/** Dismiss delay, ms. */
const TTL_MS = 4_000;

/** Вид тоста: `info` — нейтрально, `success` — успех, `warning` — внимание,
 *  `error` — сбой. Цветная полоса слева — токен ETN (`--ok`/`--warn`/`--danger`). */
export type NoticeKind = 'info' | 'success' | 'warning' | 'error';

/** Дополнительный класс по виду (стили — `styles.css`, `.notice.<kind>`). */
const KIND_CLASS: Record<Exclude<NoticeKind, 'info'>, string> = {
  success: 'success',
  warning: 'warning',
  error: 'error',
};

/**
 * Shows a toast with the given text. The kind colours the left edge: `error`
 * — red, `warning` — yellow, `success` — green, `info` (default) — accent.
 */
export function notice(text: string, kind: NoticeKind = 'info'): void {
  const extra = kind === 'info' ? '' : ` ${KIND_CLASS[kind]}`;
  const box = div(`notice${extra}`);
  box.append(span(text, 'notice-text'));
  box.append(button('×', () => box.remove(), 'notice-close'));
  document.body.append(box);
  window.setTimeout(() => box.remove(), TTL_MS);
}
