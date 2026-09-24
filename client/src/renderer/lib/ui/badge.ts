/**
 * Бейдж — единый фасад `lib/ui` (задача f351b894, требование e64083b5,
 * ADR 03eb2c61, инвентаризация 3fc7c54d — раздел «Chip/Badge (счётчики,
 * метки)»).
 *
 * Бейдж — короткая метка или счётчик. Два вида:
 *   • `pill` (по умолчанию) — облачко-метка (`role-badge`): фон и текст
 *     тона, скругление 999px;
 *   • `quiet` — приглушённый счётчик рядом с заголовком (`group-count`,
 *     `st-count`): без фона, цвет `--text-faint`.
 *
 * Тона метки: `neutral`, `accent`, `ok`, `warn`, `danger`.
 */

import { span } from '../dom.js';

/** Базовый класс бейджа. */
export const BADGE_CLASS = 'ui-badge';

/** Тон бейджа-метки. */
export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

/** Вид бейджа. */
export type BadgeKind = 'pill' | 'quiet';

/** Опции {@link badge}. */
export interface BadgeOptions {
  kind?: BadgeKind;
  tone?: BadgeTone;
  title?: string;
  /** Дополнительные классы-модификаторы владельца (раскладка). */
  extraClass?: string;
}

/**
 * Строит бейдж. `text` — начальный текст (можно менять позже через
 * `textContent`); у `quiet`-вида пустой текст бейдж скрывает.
 */
export function badge(text: string, o: BadgeOptions = {}): HTMLSpanElement {
  const kind = o.kind ?? 'pill';
  const classes = [BADGE_CLASS, `${BADGE_CLASS}--${kind}`];
  if (kind === 'pill') classes.push(`${BADGE_CLASS}--${o.tone ?? 'neutral'}`);
  if (o.extraClass !== undefined && o.extraClass.trim() !== '') {
    classes.push(...o.extraClass.trim().split(/\s+/));
  }
  const node = span(text, classes.join(' '));
  if (o.title !== undefined) node.title = o.title;
  return node;
}

/** Меняет текст бейджа; у `quiet`-вида пустой текст скрывает бейдж. */
export function setBadgeText(node: HTMLElement, text: string): void {
  node.textContent = text;
  if (node.classList.contains(`${BADGE_CLASS}--quiet`)) {
    node.classList.toggle('hidden', text === '');
  }
}
