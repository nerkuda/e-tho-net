/**
 * Searchable type picker (L6, 08-ui-spec.md §8.1): a text input with a
 * dropdown over the type catalogue.
 *
 * The input doubles as the search field — typing filters the list; the rows
 * (and the selected value in the input) carry the type's icon, colours and
 * font style so a needed type is easy to spot among many. Keyboard: ↓/↑ move
 * the active row, Enter picks it, Escape closes the list.
 */

import type { IconKind } from '@etn/shared';

import { div, el, span } from './dom.js';

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
  /** Optional colour dot (e.g. a link type's line colour). */
  dot?: string | null;
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
  const caret = span('▾', 'type-combo-caret');
  root.append(iconBox, input, caret);

  const list = div('type-combo-list hidden');
  root.append(list);

  let current = opts.value;
  let open = false;
  let activeIndex = -1;
  let rows: TypeOption[] = [];

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
    target.classList.remove('font-bold', 'font-italic', 'font-underline', 'font-strike');
    if (opt?.style == null) return;
    if (opt.style.fg !== null) target.style.color = opt.style.fg;
    if (opt.style.bg !== null) target.style.background = opt.style.bg;
    target.classList.toggle('font-bold', opt.style.bold);
    target.classList.toggle('font-italic', opt.style.italic);
    target.classList.toggle('font-underline', opt.style.underline);
    target.classList.toggle('font-strike', opt.style.strike);
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
      if (opt.dot !== undefined && opt.dot !== null) {
        const dot = span('', 'type-combo-dot');
        dot.style.background = opt.dot;
        row.append(dot);
      }
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
    list.classList.remove('hidden');
    renderList('');
    input.select();
  }

  function closeList(): void {
    if (!open) return;
    open = false;
    list.classList.add('hidden');
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
      list.classList.remove('hidden');
    }
    renderList(input.value);
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

  // Window-level capture listeners: close on an outside click, and swallow
  // Escape while the list is open so the host dialog stays mounted (dialog
  // Escape handlers are window-capture too; ours registers first because the
  // combobox is built before showDialog). Both self-unsubscribe once the
  // widget is detached (editor re-renders rebuild comboboxes).
  const onWinDown = (event: MouseEvent): void => {
    if (!root.isConnected) {
      window.removeEventListener('mousedown', onWinDown, true);
      window.removeEventListener('keydown', onWinKey, true);
      return;
    }
    if (open && event.target instanceof Node && !root.contains(event.target)) closeList();
  };
  const onWinKey = (event: KeyboardEvent): void => {
    if (!root.isConnected) {
      window.removeEventListener('mousedown', onWinDown, true);
      window.removeEventListener('keydown', onWinKey, true);
      return;
    }
    if (open && event.key === 'Escape') {
      event.stopImmediatePropagation();
      event.preventDefault();
      closeList();
    }
  };
  window.addEventListener('mousedown', onWinDown, true);
  window.addEventListener('keydown', onWinKey, true);

  renderValue();
  return { root, value: () => current };
}
