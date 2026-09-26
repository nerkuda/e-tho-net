/**
 * Тумблер (кнопка с состоянием «нажато») — единый фасад `lib/ui` (задача
 * f351b894, требование e64083b5, ADR 03eb2c61, инвентаризация 3fc7c54d —
 * раздел «Toggle (aria-pressed)»).
 *
 * Три независимых конвенции тумблеров клиента (лейка настроек поиска, кнопка
 * «скрыть/показать» панели отбора, полоса фильтров холста) сведены к одному
 * контракту: кнопка с `aria-pressed`, клавиатура Space/Enter (её даёт нативная
 * `<button>`, в отличие от самодельных `div`-тумблеров), состояние наружу —
 * `pressed()`/`setPressed()`.
 *
 * Вид компонента-владельца задаёт `extraClass` (его раскладка живёт в
 * `styles.css` и адресует состояние селектором `[aria-pressed='true']`); вид
 * глифа-тумблера (переключатели шрифта) даёт вариант `glyph` — `./toggle.css`.
 */

import { el } from '../dom.js';

/** Класс тумблера. */
export const TOGGLE_CLASS = 'ui-toggle';

/** Класс ряда тумблеров (переключатели шрифта и подобные группы). */
export const TOGGLE_GROUP_CLASS = 'ui-toggle-group';

/** Вариант вида: обычный (оформление владельца) или глиф (переключатели шрифта). */
export type ToggleVariant = 'default' | 'glyph';

/** Опции {@link toggleButton}. */
export interface ToggleOptions {
  /** Обычно `icon` или `label` (ровно одно; при обоих приоритет — иконка). */
  label?: string;
  /** Содержимое-иконка (например, `svgIcon(...)`). */
  icon?: Node;
  /** Подсказка; она же `aria-label` (доступное имя обязательно). */
  title: string;
  /** Начальное состояние. */
  pressed?: boolean;
  variant?: ToggleVariant;
  /** Дополнительные классы-модификаторы владельца. */
  extraClass?: string;
  disabled?: boolean;
  onChange?: (pressed: boolean) => void;
}

/** Дескриптор тумблера. */
export interface ToggleHandle {
  /** Кнопка-тумблер: уходит в разметку владельца. */
  root: HTMLButtonElement;
  pressed(): boolean;
  /** Устанавливает состояние без вызова `onChange`. */
  setPressed(value: boolean): void;
}

/**
 * Строит тумблер. Клик по кнопке переключает состояние и уведомляет
 * `onChange`; `Space`/`Enter` обрабатывает сама нативная кнопка (`click`).
 */
export function toggleButton(o: ToggleOptions): ToggleHandle {
  const classes = [TOGGLE_CLASS];
  if (o.variant === 'glyph') classes.push(`${TOGGLE_CLASS}--glyph`);
  if (o.extraClass !== undefined && o.extraClass.trim() !== '') {
    classes.push(...o.extraClass.trim().split(/\s+/));
  }
  const root = el('button', classes.join(' '));
  root.type = 'button';
  root.title = o.title;
  root.setAttribute('aria-label', o.title);
  if (o.icon !== undefined) root.append(o.icon);
  else if (o.label !== undefined) root.textContent = o.label;
  if (o.disabled === true) root.disabled = true;

  let pressed = o.pressed === true;
  const paint = (): void => root.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  paint();

  root.addEventListener('click', () => {
    if (o.disabled === true) return;
    pressed = !pressed;
    paint();
    o.onChange?.(pressed);
  });

  return {
    root,
    pressed: () => pressed,
    setPressed: (value: boolean): void => {
      pressed = value;
      paint();
    },
  };
}
