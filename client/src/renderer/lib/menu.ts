/**
 * Floating context/dropdown menu (08-ui-spec.md §2.6, §8).
 *
 * A single shared menu element supports one level of hover submenus, click
 * outside / Escape dismissal and per-item disabled/danger/checked flags. Used
 * by the toolbar menus, the canvas thought menu, zone sort menus and the
 * selection panel.
 */

import { div, el, span } from './dom.js';

/** A menu entry: leaf with `onClick` or a parent with `submenu`. */
export interface MenuItem {
  label: string;
  icon?: string;
  submenu?: MenuItem[];
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  onClick?: () => void;
}

/** A visible separator. */
export const MENU_SEPARATOR: MenuItem = { label: '—' };

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
    if (item.icon !== undefined) row.append(span(item.icon, 'menu-item-icon'));
    row.append(span(item.label, 'menu-item-label'));
    if (item.submenu !== undefined) row.append(span('▸', 'menu-item-arrow'));
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      if (item.disabled === true) return;
      closeMenu();
      item.onClick?.();
    });
    row.addEventListener('mouseenter', () => {
      if (item.disabled === true || item.submenu === undefined) return;
      // Close previously opened submenus of this list.
      for (const existing of Array.from(root.querySelectorAll(':scope > .menu-sub'))) {
        existing.remove();
      }
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
 * Shows a menu at viewport coordinates. Coordinates are clamped to the viewport
 * and the menu is closed on outside click, Escape, blur or window resize.
 */
export function showMenuAt(x: number, y: number, items: MenuItem[]): void {
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
}
