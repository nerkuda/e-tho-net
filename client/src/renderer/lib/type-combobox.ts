/**
 * Searchable type picker (L6, 08-ui-spec.md §8.1): a text input with a
 * dropdown over the type catalogue.
 *
 * The input doubles as the search field — typing filters the list; the rows
 * (and the selected value in the input) carry the type's icon, colours and
 * font style so a needed type is easy to spot among many. Link types show a
 * line swatch (colour/dash/width) instead. Keyboard: ↓/↑ move the active row,
 * Enter picks it, Escape closes the list.
 *
 * The dropdown is mounted in `document.body` with fixed positioning — it must
 * not be clipped by the host dialog's bounds (08-ui-spec.md §4.2).
 */

import type { IconKind, LinkStyle } from '@etn/shared';

import { applyFontFlags, div, el, span } from './dom.js';
import { svgIcon } from './icons.js';

/** One selectable row of the combobox. */
export interface TypeOption {
  /** Type id; `null` is the "no type" entry (added when `emptyLabel` is set). */
  id: string | null;
  label: string;
  /** Optional icon (e.g. a thought type's own/default icon). */
  icon?: { icon: string | null; kind: IconKind } | null;
  /** Optional font/colour style applied to the row and the selected input. */
  style?: {
    fg: string | null;
    bg: string | null;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strike: boolean;
  } | null;
  /** Optional line swatch (a link type's line look) shown before the label. */
  line?: { color: string | null; style: LinkStyle; width: number } | null;
}

/** The created combobox widget. */
export interface TypeCombobox {
  root: HTMLElement;
  /** Currently selected type id (`null` = no type). */
  value(): string | null;
}

/** Builds a searchable type picker. `options` is re-read on every open. */
export function createTypeCombobox(opts: {
  options: () => TypeOption[];
  value: string | null;
  placeholder?: string;
  /** Label of the "no type" row; omit when a type is mandatory. */
  emptyLabel?: string;
  onChange: (typeId: string | null) => void;
}): TypeCombobox {
  const { options, emptyLabel, onChange } = opts;

  const root = div('type-combo');
  const iconBox = span('', 'type-combo-icon');
  const input = el('input', 'text-input type-combo-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = opts.placeholder ?? '';
  const caret = span('', 'type-combo-caret');
  caret.append(svgIcon('chevron-down', 12));
  root.append(iconBox, input, caret);

  // Lives in document.body while open (fixed positioning, above dialogs).
  const list = div('type-combo-list hidden');
  let open = false;
  let activeIndex = -1;
  let rows: TypeOption[] = [];
  let current = opts.value;

  /** Renders an option's icon into a box (emoji glyph or <img>). */
  function renderIcon(box: HTMLElement, opt: TypeOption | null): void {
    box.replaceChildren();
    if (opt?.icon == null) return;
    if (opt.icon.kind === 'image' && opt.icon.icon !== null) {
      const img = el('img');
      img.src = opt.icon.icon;
      img.alt = '';
      box.append(img);
    } else {
      box.textContent = opt.icon.icon ?? '';
    }
  }

  /** Applies an option's font/colour style to an element. */
  function applyStyle(target: HTMLElement, opt: TypeOption | null): void {
    target.style.color = '';
    target.style.background = '';
    const s = opt?.style;
    applyFontFlags(target, {
      bold: s?.bold ?? false,
      italic: s?.italic ?? false,
      underline: s?.underline ?? false,
      strike: s?.strike ?? false,
    });
    if (s == null) return;
    if (s.fg !== null) target.style.color = s.fg;
    if (s.bg !== null) target.style.background = s.bg;
  }

  /** A small line swatch element for link-type options. */
  function lineSwatch(line: TypeOption['line']): HTMLElement | null {
    if (line == null) return null;
    const swatch = span('', 'type-combo-swatch');
    const style = line.style === 'dashed' ? 'dashed' : line.style === 'dotted' ? 'dotted' : 'solid';
    swatch.style.borderTop = `${Math.max(1, Math.min(6, line.width))}px ${style} ${line.color ?? '#9aa3b2'}`;
    return swatch;
  }

  /** The option object for the currently selected id (or the empty entry). */
  function currentOption(): TypeOption | null {
    if (current === null) return emptyLabel !== undefined ? { id: null, label: emptyLabel } : null;
    return options().find((o) => o.id === current) ?? null;
  }

  /** Renders the selected value into the input (label, icon, style). */
  function renderValue(): void {
    const opt = currentOption();
    input.value = opt?.label ?? '';
    renderIcon(iconBox, opt);
    applyStyle(input, opt);
  }

  /** Rebuilds the filtered dropdown rows. */
  function renderList(query: string): void {
    const q = query.trim().toLowerCase();
    rows = options().filter((o) => o.label.toLowerCase().includes(q));
    if (emptyLabel !== undefined && emptyLabel.toLowerCase().includes(q)) {
      rows.unshift({ id: null, label: emptyLabel });
    }
    list.replaceChildren();
    if (rows.length === 0) {
      activeIndex = -1;
      list.append(el('p', 'muted type-combo-empty', 'Ничего не найдено.'));
      return;
    }
    const selectedAt = rows.findIndex((o) => o.id === current);
    activeIndex = selectedAt >= 0 ? selectedAt : 0;
    for (const [index, opt] of rows.entries()) {
      const row = div('type-combo-item');
      if (index === activeIndex) row.classList.add('active');
      const swatch = lineSwatch(opt.line);
      if (swatch !== null) row.append(swatch);
      const icon = span('', 'type-combo-icon');
      renderIcon(icon, opt);
      row.append(icon);
      const label = span(opt.label, 'type-combo-label');
      applyStyle(label, opt);
      row.append(label);
      row.addEventListener('mousedown', (event) => event.preventDefault()); // keep input focus
      row.addEventListener('click', () => select(opt));
      list.append(row);
    }
  }

  /** Places the body-mounted list right under the input, flipping up if needed. */
  function positionList(): void {
    document.body.append(list);
    list.classList.remove('hidden');
    const rect = input.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const width = Math.max(rect.width, Math.min(listRect.width, 360));
    const left = Math.max(6, Math.min(rect.left, window.innerWidth - width - 6));
    let top = rect.bottom + 2;
    if (top + listRect.height > window.innerHeight - 6 && rect.top > listRect.height + 6) {
      top = Math.max(6, rect.top - listRect.height - 2);
    }
    list.style.left = `${Math.round(left)}px`;
    list.style.top = `${Math.round(top)}px`;
    list.style.width = `${Math.round(width)}px`;
  }

  /** Marks the active row after an arrow-key move. */
  function setActive(next: number): void {
    if (rows.length === 0) return;
    activeIndex = Math.max(0, Math.min(rows.length - 1, next));
    const items = list.querySelectorAll<HTMLElement>('.type-combo-item');
    items.forEach((item, i) => item.classList.toggle('active', i === activeIndex));
    items[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function openList(): void {
    if (open) return;
    open = true;
    renderList('');
    positionList();
    input.select();
  }

  function closeList(): void {
    if (!open) return;
    open = false;
    list.classList.add('hidden');
    list.remove();
    renderValue();
  }

  /** Picks an option: notify the host, show it, close the list. */
  function select(opt: TypeOption): void {
    current = opt.id;
    onChange(current);
    closeList();
  }

  input.addEventListener('focus', openList);
  input.addEventListener('click', openList);
  input.addEventListener('input', () => {
    if (!open) {
      open = true;
      renderList(input.value);
      positionList();
    } else {
      renderList(input.value);
    }
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (open) {
        setActive(activeIndex + 1);
      } else {
        openList();
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (open) setActive(activeIndex - 1);
    } else if (event.key === 'Enter') {
      if (!open) return;
      event.preventDefault();
      const opt = rows[activeIndex];
      if (opt !== undefined) select(opt);
    }
  });

  // Window-level capture listeners: close on an outside click or any scroll
  // (the dialog body may scroll under the fixed list), and swallow Escape
  // while the list is open so the host dialog stays mounted. All self-
  // unsubscribe once the widget is detached (editor re-renders rebuild
  // comboboxes).
  const detach = (): void => {
    window.removeEventListener('mousedown', onWinDown, true);
    window.removeEventListener('keydown', onWinKey, true);
    window.removeEventListener('scroll', onWinScroll, true);
  };
  const onWinDown = (event: MouseEvent): void => {
    if (!root.isConnected) {
      detach();
      return;
    }
    if (open && event.target instanceof Node && !root.contains(event.target) && !list.contains(event.target)) {
      closeList();
    }
  };
  const onWinKey = (event: KeyboardEvent): void => {
    if (!root.isConnected) {
      detach();
      return;
    }
    if (open && event.key === 'Escape') {
      event.stopImmediatePropagation();
      event.preventDefault();
      closeList();
    }
  };
  const onWinScroll = (): void => {
    if (!root.isConnected) {
      detach();
      return;
    }
    if (open) closeList();
  };
  window.addEventListener('mousedown', onWinDown, true);
  window.addEventListener('keydown', onWinKey, true);
  window.addEventListener('scroll', onWinScroll, true);

  renderValue();
  return { root, value: () => current };
}
