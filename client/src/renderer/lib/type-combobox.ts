/**
 * Searchable type picker (L6, 08-ui-spec.md §8.1): a text input with a
 * dropdown over the type catalogue.
 *
 * Since L21 the dropdown is a **tree**: rows carry their hierarchy depth
 * (indent), nodes with children get a ▸/▾ toggle (the root type «основной
 * тип» is always expanded, everything else starts collapsed), and the root
 * itself has no selection mark — it is never assignable to a thought/link.
 * Typing filters the list keeping the matched rows plus their ancestor chain.
 *
 * The input doubles as the search field; the rows (and the selected value in
 * the input) carry the type's icon, colours and font style so a needed type
 * is easy to spot among many. Link types show a line swatch (colour/dash/
 * width) instead. Keyboard: ↓/↑ move the active row, Enter picks it, Escape
 * closes the list (the caret stays in the input). The list scrolls on its own
 * (wheel, scrollbar, active-row scrollIntoView) and closes on blur, an
 * outside click, a scroll elsewhere, or Escape.
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
  /** Parent type id — drives the tree layout (L21); `null`/absent = top row. */
  parent_id?: string | null;
  /** Tree depth (root type = 1) — drives the row indent. */
  depth?: number;
  /** The row has child types and can be expanded. */
  has_children?: boolean;
  /**
   * `false` — the row is displayed but cannot be picked (the hierarchy root
   * «основной тип» has no selection mark, docs/08-ui-spec.md §8.1).
   */
  selectable?: boolean;
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
  line?: { color: string | null; style: LinkStyle | null; width: number | null } | null;
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
  /**
   * L21: start with every tree node expanded (the parent picker wants the
   * full list visible at once). Default: the root only, rest collapsed.
   */
  expandAll?: boolean;
  onChange: (typeId: string | null) => void;
}): TypeCombobox {
  const { options, emptyLabel, onChange } = opts;

  const root = div('type-combo');
  const iconBox = span('', 'type-combo-icon');
  const input = el('input', 'text-input type-combo-input');
  input.type = 'text';
  input.autocomplete = 'off';
  // Disable IME/spellcheck/autocorrect so the field doesn't enter composition
  // mode on Windows — the composition start can swallow system-level combos
  // such as Ctrl+Shift (keyboard-layout switch) while the caret sits here.
  input.spellcheck = false;
  input.inputMode = 'text';
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
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
  // The live search query, tracked separately from the input value: while the
  // list is open the input still shows the LABEL of the selected value until
  // the user types, and that label must never leak into the filtering (a row
  // toggle click used to filter the tree down to the "no type" entry).
  let search = '';
  // Tree expansion state (L21): the root type is always expanded, everything
  // else starts collapsed (docs/08-ui-spec.md §8.1).
  const expanded = new Set<string>();

  /** All catalogue options plus the optional "no type" entry on top. */
  function allOptions(): TypeOption[] {
    const optsList = options();
    if (emptyLabel === undefined) return optsList;
    return [{ id: null, label: emptyLabel, depth: 1 }, ...optsList];
  }

  /** Auto-expand the root and the ancestor chain of the selected value;
   *  with `expandAll` — every node with children (L21 parent picker). */
  function seedExpansion(): void {
    expanded.clear();
    const byId = new Map(options().filter((o) => o.id !== null).map((o) => [o.id as string, o]));
    for (const opt of byId.values()) {
      // The root type is always expanded (docs/08-ui-spec.md §8.1).
      if (opt.selectable === false && opt.parent_id == null) expanded.add(opt.id ?? '');
      if (opts.expandAll === true && opt.has_children === true) expanded.add(opt.id ?? '');
      // A parent id absent from the options (e.g. the hierarchy root excluded
      // from a pick list) must always count as expanded — otherwise its
      // children, the intended top rows, would never show.
      if (opt.parent_id != null && !byId.has(opt.parent_id)) expanded.add(opt.parent_id);
    }
    let walk = current !== null ? byId.get(current) : undefined;
    while (walk !== undefined && walk.parent_id != null) {
      expanded.add(walk.parent_id);
      walk = byId.get(walk.parent_id);
    }
  }

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
    const dash = line.style === 'dashed' ? 'dashed' : line.style === 'dotted' ? 'dotted' : 'solid';
    const width = Math.max(1, Math.min(6, line.width ?? 1));
    swatch.style.borderTop = `${width}px ${dash} ${line.color ?? '#9aa3b2'}`;
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

  /** Rebuilds the dropdown rows: the tree of types, filtered by the query.
   *
   * L21: rows carry their tree depth; nodes with children get a ▸/▾ toggle.
   * A non-empty query keeps every matching row plus its ancestor chain (so
   * the tree structure stays readable), regardless of the expansion state.
   */
  function renderList(query: string): void {
    const q = query.trim().toLowerCase();
    const all = allOptions();
    const byId = new Map(all.filter((o) => o.id !== null).map((o) => [o.id as string, o]));
    const matches = (o: TypeOption): boolean => o.label.toLowerCase().includes(q);
    let visible: TypeOption[];
    if (q === '') {
      visible = all.filter((o) => o.parent_id == null || expanded.has(o.parent_id));
      // The "no type" entry (id: null) has no parent — always visible.
    } else {
      const keep = new Set<TypeOption>();
      for (const opt of all) {
        if (opt.id !== null && matches(opt)) {
          let walk: TypeOption | undefined = opt;
          while (walk !== undefined) {
            keep.add(walk);
            walk = walk.parent_id != null ? byId.get(walk.parent_id) : undefined;
          }
        }
      }
      if (emptyLabel !== undefined && matches({ id: null, label: emptyLabel })) {
        keep.add(all[0]!);
      }
      visible = all.filter((o) => keep.has(o));
    }
    rows = visible;
    list.replaceChildren();
    if (rows.length === 0) {
      activeIndex = -1;
      list.append(el('p', 'muted type-combo-empty', 'Ничего не найдено.'));
      return;
    }
    const selectableRows = rows.filter((o) => o.selectable !== false);
    const selectedAt = selectableRows.findIndex((o) => o.id === current);
    const preferred =
      selectedAt >= 0 ? rows.indexOf(selectableRows[selectedAt]!) : rows.findIndex((o) => o.selectable !== false);
    activeIndex = preferred >= 0 ? preferred : 0;
    for (const [index, opt] of rows.entries()) {
      const row = div('type-combo-item');
      if (index === activeIndex && opt.selectable !== false) row.classList.add('active');
      if (opt.selectable === false) row.classList.add('disabled');
      row.style.paddingLeft = `${8 + Math.max(0, (opt.depth ?? 1) - 1) * 16}px`;
      if (opt.has_children === true) {
        const toggle = span('', 'type-combo-toggle');
        toggle.textContent = expanded.has(opt.id ?? '') ? '▾' : '▸';
        toggle.addEventListener('mousedown', (event) => event.preventDefault());
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          const id = opt.id ?? '';
          if (expanded.has(id)) expanded.delete(id);
          else expanded.add(id);
          renderList(search);
          positionList();
        });
        row.append(toggle);
      } else {
        row.append(span('', 'type-combo-toggle type-combo-toggle-leaf'));
      }
      const swatch = lineSwatch(opt.line);
      if (swatch !== null) row.append(swatch);
      const icon = span('', 'type-combo-icon');
      renderIcon(icon, opt);
      row.append(icon);
      const label = span(opt.label, 'type-combo-label');
      applyStyle(label, opt);
      row.append(label);
      row.addEventListener('mousedown', (event) => event.preventDefault()); // keep input focus
      if (opt.selectable !== false) {
        row.addEventListener('click', () => select(opt));
      }
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

  /** Marks the active row after an arrow-key move (skips non-selectable rows). */
  function setActive(next: number): void {
    if (rows.length === 0) return;
    const clamp = Math.max(0, Math.min(rows.length - 1, next));
    let index = clamp;
    if (rows[index]?.selectable === false) {
      // Step to the nearest selectable row in the move direction.
      const dir = next > activeIndex ? 1 : -1;
      while (index >= 0 && index < rows.length && rows[index]?.selectable === false) {
        index += dir;
      }
      if (index < 0 || index >= rows.length || rows[index]?.selectable === false) return;
    }
    activeIndex = index;
    const items = list.querySelectorAll<HTMLElement>('.type-combo-item');
    items.forEach((item, i) => item.classList.toggle('active', i === activeIndex));
    items[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function openList(): void {
    if (open) return;
    open = true;
    search = '';
    seedExpansion();
    renderList('');
    positionList();
    // Intentionally NOT calling `input.select()` here. Auto-selecting on
    // every focus puts the field into a "replace-selected" state that, on
    // Windows + Electron, swallows system-level key combos (Ctrl+Shift for
    // keyboard-layout switch) because the input enters an IME-style
    // composition flow as soon as its content is selected. The user can
    // still erase via Backspace or Ctrl+A → Delete; this only sacrifices
    // the one-keystroke replace convenience.
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
  input.addEventListener('blur', () => {
    // The caret left the field by any means (Tab onwards, click elsewhere,
    // window switch) — the dropdown follows and closes by itself. Clicking a
    // row keeps the focus in the input (mousedown preventDefault), so a pick
    // never fires this.
    if (open) closeList();
  });
  input.addEventListener('input', () => {
    // Typing replaces the selected-value label with a real search query.
    search = input.value;
    if (!open) {
      open = true;
      renderList(search);
      positionList();
    } else {
      renderList(search);
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

  // Window-level capture listeners: close on an outside click or on a scroll
  // outside the list (the dialog body may scroll under the fixed list), and
  // swallow Escape while the list is open so the host dialog stays mounted.
  // The list's own scrolling never closes it. All self-unsubscribe once the
  // widget is detached (editor re-renders rebuild comboboxes).
  const detach = (): void => {
    window.removeEventListener('mousedown', onWinDown, true);
    window.removeEventListener('keydown', onWinKey, true);
    window.removeEventListener('scroll', onWinScroll, true);
    window.removeEventListener('etn:editor-rebuild', onRebuild);
    // The list lives in document.body — drop it together with the widget,
    // otherwise a re-render that destroys the host DOM leaves it behind as
    // a fixed-position ghost that no handler can close.
    if (list.isConnected) list.remove();
  };
  const onRebuild = (): void => {
    if (!root.isConnected) {
      detach();
      return;
    }
    if (open) closeList();
  };
  const onWinDown = (event: MouseEvent): void => {
    if (!root.isConnected) {
      closeList();
      detach();
      return;
    }
    if (open && event.target instanceof Node && !root.contains(event.target) && !list.contains(event.target)) {
      closeList();
    }
  };
  const onWinKey = (event: KeyboardEvent): void => {
    if (!root.isConnected) {
      closeList();
      detach();
      return;
    }
    if (event.key === 'Escape') {
      // Swallow every Escape while the list is open so the host dialog stays
      // mounted — and swallow key auto-repeats as well: a held Escape must
      // not close the list once and the dialog right after (L21 fix).
      if (open || event.repeat) {
        event.stopImmediatePropagation();
        event.preventDefault();
        if (open) closeList();
      }
    }
  };
  const onWinScroll = (event: Event): void => {
    if (!root.isConnected) {
      closeList();
      detach();
      return;
    }
    // The list scrolling itself (wheel over it, its own scrollbar, the active
    // row's scrollIntoView) is normal list behaviour — only scrolling
    // elsewhere (the editor/dialog body under the fixed list) closes it.
    if (event.target instanceof Node && list.contains(event.target)) return;
    if (open) closeList();
  };
  window.addEventListener('mousedown', onWinDown, true);
  window.addEventListener('keydown', onWinKey, true);
  window.addEventListener('scroll', onWinScroll, true);
  // The editor rebuilds its DOM while keeping the window alive (e.g. a header
  // save bumps the thought version) — close before the old DOM is destroyed.
  window.addEventListener('etn:editor-rebuild', onRebuild);

  renderValue();
  return { root, value: () => current };
}
