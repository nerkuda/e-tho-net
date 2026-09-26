/**
 * Общий словарь пунктов меню клиента (08-ui-spec.md §2.6, §8; требование
 * f9ad4f53 «Контекстное меню карты — на общем словаре пунктов меню»).
 *
 * Единственное описание пункта меню — тип {@link MenuItem}; единственный
 * способ собрать пункты — конструкторы словаря {@link menuAction},
 * {@link menuChoice}, {@link menuSubmenu} и разделитель {@link MENU_SEPARATOR}.
 * Меню карты мыслей и меню экранов строятся только из них: самодельные
 * объекты-пункты (`{ label: … }`) в месте сборки запрещены — за этим следит
 * сторож `tests/guard-canvas-menu-dictionary.test.ts`.
 *
 * Одно готовое меню поддерживает один уровень hover-подменю, закрытие кликом
 * вне / Escape / потерей фокуса / изменением размера окна и флаги пункта
 * `disabled` / `danger` / `checked`. Потребители: меню тулбара, меню мысли
 * холста и редактора, меню сортировки зон, панель выделения, меню списков.
 *
 * Строк интерфейса у словаря нет: подпись пункта задаёт потребитель (при
 * переводе — `t('…')` из `lib/i18n.ts`).
 */

import { div, el, span } from './dom.js';
import { noteFocusOrigin } from './focus-origin.js';

/** A menu entry: leaf with `onClick` or a parent with `submenu`.
 *  `dragId` marks a row as a drag source for a thought (the history dropdown)
 *  — it lands in `row.dataset['dragId']` for the caller to wire up. */
export interface MenuItem {
  label: string;
  /** A glyph string (rendered as text) or a DOM node (e.g. an inline-SVG
   *  icon). DOM nodes get the same `menu-item-icon` class wrapper so the
   *  layout stays consistent across both shapes. */
  icon?: string | Node;
  /**
   * Ready-made row content instead of the `icon` + `label` pair — for rich
   * rows (e.g. a thought cloud from the shared factory). Rendered in a
   * full-width `.menu-item-content` wrapper; `label` stays the textual
   * caption of the row (accessibility).
   */
  content?: Node;
  submenu?: MenuItem[];
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  dragId?: string;
  onClick?: () => void;
}

/** A visible separator. */
export const MENU_SEPARATOR: MenuItem = { label: '—' };

/** Опции пункта словаря — всё, кроме подписи, обработчика и подменю. */
export interface MenuItemOptions {
  /** Значок: строка-глиф (текстом) или DOM-узел (например, inline-SVG). */
  icon?: string | Node;
  /** Готовое содержимое строки вместо пары «значок + подпись». */
  content?: Node;
  /** Пункт недоступен: клик игнорируется, строка приглушена. */
  disabled?: boolean;
  /** Разрушающее действие — опасный вид строки. */
  danger?: boolean;
  /** Идентификатор перетаскивания (попадает в `row.dataset['dragId']`). */
  dragId?: string;
}

/** Разворачивает опции в поля пункта, не заводя `undefined`-ключей. */
function withOptions(item: MenuItem, options: MenuItemOptions): MenuItem {
  if (options.icon !== undefined) item.icon = options.icon;
  if (options.content !== undefined) item.content = options.content;
  if (options.disabled !== undefined) item.disabled = options.disabled;
  if (options.danger !== undefined) item.danger = options.danger;
  if (options.dragId !== undefined) item.dragId = options.dragId;
  return item;
}

/**
 * Пункт-действие: лист меню с обработчиком. Основа словаря. `onClick` не
 * задан — строка без действия (обычно вместе с `disabled`: так показывают
 * недоступный режим, не убирая пункт из меню).
 */
export function menuAction(
  label: string,
  onClick?: () => void,
  options: MenuItemOptions = {},
): MenuItem {
  const item: MenuItem = { label };
  if (onClick !== undefined) item.onClick = onClick;
  return withOptions(item, options);
}

/**
 * Пункт-переключатель: отмечает текущий выбранный режим (`checked`) — так
 * показывается активная сортировка зоны и другие взаимоисключающие наборы
 * (по смыслу радио, а не флажок: выбор применяется сразу).
 */
export function menuChoice(
  label: string,
  checked: boolean,
  onClick?: () => void,
  options: MenuItemOptions = {},
): MenuItem {
  const item = menuAction(label, onClick, options);
  item.checked = checked;
  return item;
}

/**
 * Пункт-родитель: при наведении раскрывает подменю (один уровень, см.
 * {@link buildMenu}). Обработчика у самого пункта нет — клик по родителю
 * ничего не делает.
 */
export function menuSubmenu(
  label: string,
  submenu: MenuItem[],
  options: MenuItemOptions = {},
): MenuItem {
  const item = menuAction(label, undefined, options);
  item.submenu = submenu;
  return item;
}

let roots: HTMLElement[] = [];
let dismissers: Array<() => void> = [];

/** Closes the open menu (if any) and its submenus. */
export function closeMenu(): void {
  for (const dismiss of dismissers) dismiss();
  dismissers = [];
  for (const root of roots) root.remove();
  roots = [];
}

/** True when any menu is currently open. */
export function isMenuOpen(): boolean {
  return roots.length > 0;
}

/** Builds a menu DOM node with items; submenus attach to the root list. */
function buildMenu(items: MenuItem[]): HTMLDivElement {
  const root = div('menu');
  for (const item of items) {
    if (item.label === '—') {
      root.append(div('menu-sep'));
      continue;
    }
    const row = el('button', 'menu-item', '');
    row.type = 'button';
    row.classList.toggle('menu-item-danger', item.danger === true);
    row.classList.toggle('menu-item-disabled', item.disabled === true);
    row.classList.toggle('menu-item-checked', item.checked === true);
    if (item.dragId !== undefined) row.dataset['dragId'] = item.dragId;
    if (item.content !== undefined) {
      // Rich row: the caller-owned node replaces icon + label entirely.
      const wrap = span('', 'menu-item-content');
      wrap.append(item.content);
      row.append(wrap);
    } else {
      if (item.icon !== undefined) {
        if (typeof item.icon === 'string') {
          row.append(span(item.icon, 'menu-item-icon'));
        } else {
          const wrap = span('', 'menu-item-icon');
          wrap.append(item.icon);
          row.append(wrap);
        }
      }
      row.append(span(item.label, 'menu-item-label'));
    }
    if (item.submenu !== undefined) row.append(span('▸', 'menu-item-arrow'));
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      if (item.disabled === true) return;
      // Строка-мысль (drop-меню закреплённых/истории, `dragId` — её id) —
      // запоминаем её экранный прямоугольник как источник полёта к этой мысли
      // ДО закрытия меню, пока строка ещё в раскладке (дефект 2 задачи
      // e9f0af94).
      if (item.dragId !== undefined) noteFocusOrigin(item.dragId, row);
      closeMenu();
      item.onClick?.();
    });
    row.addEventListener('mouseenter', () => {
      // Moving the highlight to ANY row closes this list's open submenu —
      // including disabled/leaf rows (hovering them must not leave the old
      // submenu hanging, 08-ui-spec.md §2.6).
      for (const existing of Array.from(root.querySelectorAll(':scope > .menu-sub'))) {
        existing.remove();
      }
      if (item.disabled === true || item.submenu === undefined) return;
      const sub = buildMenu(item.submenu);
      sub.classList.add('menu-sub');
      root.append(sub);
      const rect = row.getBoundingClientRect();
      const subRect = sub.getBoundingClientRect();
      const left =
        rect.right + subRect.width > window.innerWidth - 4 ? rect.left - subRect.width : rect.right;
      const top = Math.max(4, Math.min(rect.top, window.innerHeight - subRect.height - 4));
      sub.style.left = `${Math.max(4, left)}px`;
      sub.style.top = `${top}px`;
    });
    root.append(row);
  }
  return root;
}

/**
 * Shows a menu at viewport coordinates and returns its root element (so the
 * caller can wire extra behaviour onto the rows, e.g. drag sources).
 * Coordinates are clamped to the viewport and the menu is closed on outside
 * click, Escape, blur or window resize.
 */
export function showMenuAt(x: number, y: number, items: MenuItem[]): HTMLElement {
  closeMenu();
  const root = buildMenu(items);
  document.body.append(root);
  roots.push(root);

  const rect = root.getBoundingClientRect();
  root.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  root.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeMenu();
  };
  const onDown = (event: MouseEvent): void => {
    if (!root.contains(event.target as Node)) closeMenu();
  };
  const onResize = (): void => closeMenu();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onDown, true);
  window.addEventListener('resize', onResize);
  dismissers.push(() => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('resize', onResize);
  });
  return root;
}
