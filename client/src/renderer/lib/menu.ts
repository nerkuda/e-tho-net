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
 * вне / Escape / потерей фокуса / изменением размера окна, флаги пункта
 * `disabled` / `danger` / `checked` и — по опции `keyboard` — клавиатурный
 * профиль списка выбора (↑/↓/Enter, ARIA `listbox`/`option`, 0.15.4,
 * ADR 8f0e9412). Потребители: меню тулбара, меню мысли холста и редактора, меню
 * сортировки зон, панель выделения, меню списков.
 *
 * Строк интерфейса у словаря нет: подпись пункта задаёт потребитель (при
 * переводе — `t('…')` из `lib/i18n.ts`).
 */

import { div, el, span } from './dom.js';
import { noteFocusOrigin } from './focus-origin.js';
import { pushKeyOverlay } from './keymap.js';
import { nextNavIndex, resolveNavAction } from './ui/nav-core.js';

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

/**
 * Опции готового меню (профили поведения).
 *
 * `keyboard` — клавиатурная навигация по строкам (0.15.4, ADR 8f0e9412,
 * элемент 50299ca1 «Список выбора привязки дневниковой записи»): ↑/↓ двигают
 * подсвеченный пункт с пропуском недоступных, Enter выбирает его, текущий пункт
 * подсвечен, контейнер — ARIA `listbox`, строки — `option` с `aria-selected`.
 * Клавиши гасятся в СУЩЕСТВУЮЩЕМ capture-слушателе ({@link showMenuAt}) с
 * `stopImmediatePropagation`: иначе стрелки одновременно двигали бы список
 * результатов/холст под меню (сторож `guard-keymap-single-point` — второй
 * слушатель здесь не заводится).
 */
export interface MenuOptions {
  /** Клавиатурный профиль списка выбора (↑/↓/Enter, ARIA listbox/option). */
  keyboard?: boolean;
}

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

/**
 * Находится ли цель события внутри МЕНЮ (`lib/menu.ts`): его строки или
 * раскрытого подменю. Слои меню порталятся в `document.body`, поэтому клик по
 * строке меню — это клик «по всплывающему слою» для панелей, из которых меню
 * открыто. Строка поиска карты обязана не закрываться по такому нажатию: иначе
 * команда подменю применяется «вслепую», а условия и результаты прячутся вместе
 * с панелью (задача 4b1cc3d4). Один уровень подменю лежит ВНУТРИ корня меню
 * (класс `menu-sub` на том же узле `menu`), поэтому `closest('.menu')` покрывает
 * и строку, и подменю.
 */
export function isInsideMenu(target: EventTarget | null): boolean {
  const node = target as (Element & { closest?(selector: string): Element | null }) | null;
  if (node === null || typeof node !== 'object') return false;
  return typeof node.closest === 'function' && node.closest('.menu') !== null;
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
 * Удерживает фокус текущего элемента при клике по строке меню: строки не
 * забирают фокус на `mousedown`, поэтому поле, из которого открыто меню
 * (в частности редактор комментария CodeMirror), не выходит из правки, а
 * команда применяется к текущему выделению.
 *
 * Обработчик делегирован на КОНТЕЙНЕР меню в фазе capture: `mousedown` по
 * любой строке-потомку `.menu-item` гасится — в том числе по строкам подменю,
 * которые строятся лениво на `mouseenter` ({@link buildMenu}) и появляются в
 * DOM уже ПОСЛЕ открытия меню, на любой глубине вложенности. Навешивание
 * обработчиков на строки, существовавшие на момент вызова, не защищало ленивые
 * подменю (ошибка 64b18420).
 */
export function guardMenuFocus(menuRoot: HTMLElement): void {
  menuRoot.addEventListener(
    'mousedown',
    (event) => {
      if (isMenuRowTarget(event.target)) event.preventDefault();
    },
    true,
  );
}

/** Цель `mousedown` — строка меню (сама `.menu-item` или её потомок). */
function isMenuRowTarget(target: EventTarget | null): boolean {
  const node = target as (Element & { closest?(selector: string): Element | null }) | null;
  if (node === null || typeof node !== 'object') return false;
  if (node.classList?.contains('menu-item') === true) return true;
  return typeof node.closest === 'function' && node.closest('.menu-item') !== null;
}

/** Клавиатурное управление открытым меню (профиль `keyboard`). */
interface MenuKeyboard {
  /** Сдвинуть подсвеченный пункт; `false` — двигать некуда (край/нет строк). */
  move(action: 'up' | 'down'): boolean;
  /** Выбрать подсвеченный пункт (как клик по строке); `false` — выбирать нечего. */
  activate(): boolean;
}

/**
 * Включает клавиатурный профиль меню: ARIA `listbox`/`option`, стартовый пункт —
 * первый доступный, подсветка текущего (`aria-selected`). Логика самих клавиш
 * живёт не здесь, а в capture-слушателе {@link showMenuAt}: экранными
 * слушателями клавиатуры клиент не пользуется (ADR b420b08c, сторож
 * `guard-keymap-single-point`).
 */
function setupMenuKeyboard(root: HTMLElement): MenuKeyboard {
  root.setAttribute('role', 'listbox');
  const rows = (): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(':scope > .menu-item'));
  /** Доступные пункты: по недоступным стрелки не ходят. */
  const enabled = (): HTMLElement[] =>
    rows().filter((row) => !row.classList.contains('menu-item-disabled'));
  let active: HTMLElement | null = null;

  const mark = (next: HTMLElement | null): void => {
    for (const row of rows()) row.setAttribute('aria-selected', row === next ? 'true' : 'false');
    active = next;
  };

  for (const row of rows()) row.setAttribute('role', 'option');
  // Список навигационный — курсор виден сразу, без первого нажатия стрелки.
  mark(enabled()[0] ?? null);

  return {
    move(action) {
      const list = enabled();
      if (list.length === 0) return false;
      const current = active === null ? -1 : list.indexOf(active);
      const next = nextNavIndex(action, current, list.length, { emptyTarget: 'direction' });
      const target = list[next];
      if (target === undefined || target === active) return false;
      mark(target);
      return true;
    },
    activate() {
      if (active === null || active.classList.contains('menu-item-disabled')) return false;
      // Строка меню сама закроет меню и выполнит свою команду (см. `buildMenu`).
      active.click();
      return true;
    },
  };
}

/**
 * Shows a menu at viewport coordinates and returns its root element (so the
 * caller can wire extra behaviour onto the rows, e.g. drag sources).
 * Coordinates are clamped to the viewport and the menu is closed on outside
 * click, Escape, blur or window resize.
 *
 * `options.keyboard` включает клавиатурный профиль списка выбора (0.15.4,
 * ADR 8f0e9412): ↑/↓/Enter обслуживает ТОТ ЖЕ capture-слушатель ниже.
 */
export function showMenuAt(
  x: number,
  y: number,
  items: MenuItem[],
  options: MenuOptions = {},
): HTMLElement {
  closeMenu();
  const root = buildMenu(items);
  document.body.append(root);
  roots.push(root);
  const keyboard = options.keyboard === true ? setupMenuKeyboard(root) : null;

  const rect = root.getBoundingClientRect();
  root.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  root.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;

  const onDown = (event: MouseEvent): void => {
    if (!root.contains(event.target as Node)) closeMenu();
  };
  const onResize = (): void => closeMenu();
  // Меню — всплывающий слой: пока оно открыто и выше него нет другого слоя,
  // `Escape` принадлежит ему. Приоритет решает диспетчер (`lib/keymap.ts`,
  // ошибка 9ff6b606): `handleEscape` ответит `false`, если над меню открыт
  // поповер/другая панель, — тогда меню нажатие не трогает и не глушит.
  // Capture-фаза нужна, чтобы опередить редактор под меню (CM6 гасит `Escape`
  // раньше bubble-диспетчера).
  const escapeOverlay = pushKeyOverlay({ id: 'menu', onEscape: () => closeMenu() });
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.repeat) {
      if (!escapeOverlay.handleEscape(event)) return;
      event.stopImmediatePropagation();
      return;
    }
    if (keyboard === null) return;
    // Клавиатура списка выбора — в ЭТОМ ЖЕ слушателе (новый слушатель краснит
    // сторож `guard-keymap-single-point`); ↑/↓/Enter гасятся, иначе они
    // одновременно двигали бы список результатов/холст под меню.
    const action = resolveNavAction(event.key);
    const handled =
      action === 'up' || action === 'down'
        ? keyboard.move(action)
        : action === 'activate'
          ? keyboard.activate()
          : false;
    if (!handled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onDown, true);
  // Клик по строке списка начинается с `pointerdown`; фасад перетаскивания
  // гасит его (`preventDefault`), и совместимый `mousedown` Chromium уже не
  // шлёт — без этого «клик вне» не закрывал меню строки свойства (50d57b19).
  window.addEventListener('pointerdown', onDown as EventListener, true);
  window.addEventListener('resize', onResize);
  dismissers.push(() => {
    escapeOverlay.release();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('pointerdown', onDown as EventListener, true);
    window.removeEventListener('resize', onResize);
  });
  return root;
}
