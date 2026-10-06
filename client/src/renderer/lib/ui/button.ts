/**
 * Словарь кнопок `lib/ui` (задача 56f1dcb2, требование edc5faea,
 * ADR 03eb2c61).
 *
 * Единственный источник разметки, классов и состояний кнопок клиента.
 * Роли:
 *   • `primary`   — главное действие (заливка акцентом); не больше одной
 *                   на панель/диалог и крайним справа;
 *   • `secondary` — обычное действие (рамка, светлый фон) — по умолчанию;
 *   • `danger`    — разрушающее действие (красный контур/текст);
 *   • `ghost`     — малозначимое действие без рамки (панели, тулбар);
 *   • иконочная   — {@link iconButton}: кнопка-иконка с ОБЯЗАТЕЛЬНОЙ
 *                   подсказкой; `aria-label` ставится из `title` автоматически.
 *
 * Два исторических набора классов (`btn*`, `dialog-btn*`) упразднены —
 * самодельные кнопки и старые классы запрещены сторожем
 * `guard-ui-buttons.test.ts`. Классы словаря объявлены только здесь и в
 * `./button.css`.
 *
 * Модуль — собственный (не вендорский), как и перечислено в тех.проекте
 * под-проекта 1: «собственные новые модули — только там, где готового нет
 * (диалог-компонент, сворачиваемые группы, словарь кнопок, локализация)».
 * Разметка — нативный `<button>`: поведение существующих кнопок (блокировка,
 * горячие клавиши, подтверждения, `ref` как `HTMLButtonElement`) сохраняется
 * без изменений, а вид задают токены ETN (плотность и размеры прежние,
 * обе темы — через `[data-theme]`).
 */

import { el } from '../dom.js';

/** Роль кнопки — определяет её вид и смысл (закрытый словарь требования). */
export type ButtonRole = 'primary' | 'secondary' | 'danger' | 'ghost';

/** Плотность кнопки: `s` — компактная, `m` — обычная (по умолчанию). */
export type ButtonSize = 's' | 'm';

/** Базовый класс словаря — единственная точка определения. */
export const BUTTON_CLASS = 'ui-btn';

/** Класс активного состояния (переключатели вида/сегменты). */
export const BUTTON_ACTIVE_CLASS = 'ui-btn--active';

/** Опции обычной (текстовой) кнопки словаря. */
export interface ButtonOptions {
  /** Надпись кнопки. */
  label?: string;
  /** Роль; по умолчанию `secondary`. */
  role?: ButtonRole;
  /** Плотность; по умолчанию `m`. */
  size?: ButtonSize;
  /** Подсказка (нативный `title`); у иконочной кнопки — обязательна. */
  title?: string;
  /** Заблокирована ли кнопка. */
  disabled?: boolean;
  /**
   * Дополнительные классы-МОДИФИКАТОРЫ прикладного слоя (не роли словаря):
   * `type-tree-toggle`, `entity-chip-pick`, `link-btn` — раскладка или вид,
   * которыми владеет соответствующий компонент (`styles.css`). Роли и
   * состояния задавать здесь нельзя.
   */
  class?: string;
  /** Обработчик клика. */
  onClick?: (event: MouseEvent) => void;
}

/** Опции иконочной кнопки: подсказка обязательна (роль `icon` требования). */
export interface IconButtonOptions extends Omit<ButtonOptions, 'label' | 'title'> {
  /** Содержимое-иконка (например, `svgIcon(...)` из `lib/ui/icon.ts`). */
  icon: Node;
  /** Подсказка; она же становится `aria-label`. */
  title: string;
  /** Роль; по умолчанию `secondary` (рамка) — `ghost` для панелей/тулбара. */
  role?: ButtonRole;
}

/** Собирает строку классов по роли и плотности. */
function classNames(role: ButtonRole, size: ButtonSize, icon: boolean, extra?: string): string {
  const parts = [BUTTON_CLASS, `${BUTTON_CLASS}--${role}`, `${BUTTON_CLASS}--${size}`];
  if (icon) parts.push(`${BUTTON_CLASS}--icon`);
  if (extra !== undefined && extra.trim() !== '') parts.push(extra.trim());
  return parts.join(' ');
}

/**
 * Создаёт кнопку словаря. `type` всегда `button` (кнопки ETN не отправляют
 * форму), подсказка — нативный `title`, клик вешается на сам элемент.
 */
export function uiButton(options: ButtonOptions = {}): HTMLButtonElement {
  const { label = '', role = 'secondary', size = 'm', title, disabled, class: extra, onClick } = options;
  const node = el('button', classNames(role, size, false, extra), label);
  node.type = 'button';
  if (title !== undefined) node.title = title;
  if (disabled === true) node.disabled = true;
  if (onClick !== undefined) node.addEventListener('click', onClick);
  return node;
}

/**
 * Создаёт иконочную кнопку словаря. `title` обязателен и дублируется в
 * `aria-label` — иконочная кнопка без доступного имени недопустима.
 */
export function iconButton(options: IconButtonOptions): HTMLButtonElement {
  const { icon, title, role = 'secondary', size = 'm', disabled, class: extra, onClick } = options;
  const node = el('button', classNames(role, size, true, extra));
  node.type = 'button';
  node.title = title;
  node.setAttribute('aria-label', title);
  node.append(icon);
  if (disabled === true) node.disabled = true;
  if (onClick !== undefined) node.addEventListener('click', onClick);
  return node;
}

/**
 * Переключает активное состояние кнопки словаря — состояние объявлено в
 * `./button.css` (`.ui-btn--active`), а не в вызывающем коде.
 */
export function setButtonActive(node: HTMLButtonElement, active: boolean): void {
  node.classList.toggle(BUTTON_ACTIVE_CLASS, active);
}
