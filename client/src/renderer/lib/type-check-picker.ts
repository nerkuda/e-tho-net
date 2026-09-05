/**
 * Inline multi-select type picker (0.6.5 приёмка, ошибка «Выбор типов в
 * свойстве-ссылке: без иконок, стилей и иерархии»).
 *
 * A compact in-dialog panel: a search box on top and a TREE of checkbox rows
 * below — every row carries the type's icon, colours and font style (the same
 * visual shape as {@link createTypeCombobox}'s dropdown), the indent follows
 * the hierarchy depth. Unlike the single-pick combobox, several rows can be
 * checked at once (the `thought_ref` property's `allowed_type_ids` filter).
 *
 * The rows are `TypeOption[]` — build them with `thoughtTypeOptions()` so the
 * visual settings and the tree order come from the same source as everywhere
 * else. A blank query keeps the whole tree; a typed query keeps the matching
 * rows plus their ancestor chain (a match never falls out of its branch).
 */

import { applyFontFlags, button, div, el, span } from './dom.js';
import type { TypeOption } from './type-combobox.js';

/**
 * Filter the tree rows by a search query: every row whose label contains the
 * query (case-insensitive) survives, plus each survivor's ancestor chain —
 * same shape as `typeSearchVisibleIds`, over combobox options. The original
 * tree order is preserved. Pure — unit-tested.
 */
export function filterCheckRows(rows: readonly TypeOption[], query: string): TypeOption[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...rows];
  const byId = new Map(rows.filter((r) => r.id !== null).map((r) => [r.id as string, r]));
  const keep = new Set<TypeOption>();
  for (const row of rows) {
    if (!row.label.toLowerCase().includes(q)) continue;
    let walk: TypeOption | undefined = row;
    while (walk !== undefined && !keep.has(walk)) {
      keep.add(walk);
      walk = walk.parent_id != null ? byId.get(walk.parent_id) : undefined;
    }
  }
  return rows.filter((r) => keep.has(r));
}

/** Renders an option's icon into a box (emoji glyph or <img>). */
function renderIcon(box: HTMLElement, opt: TypeOption): void {
  box.replaceChildren();
  if (opt.icon == null) return;
  if (opt.icon.kind === 'image' && opt.icon.icon !== null) {
    const img = el('img');
    img.src = opt.icon.icon;
    img.alt = '';
    box.append(img);
  } else {
    box.textContent = opt.icon.icon ?? '';
  }
}

/** Applies an option's font/colour style to a label element. */
function applyStyle(target: HTMLElement, opt: TypeOption): void {
  target.style.color = '';
  target.style.background = '';
  const s = opt.style;
  applyFontFlags(target, {
    bold: s?.bold ?? false,
    italic: s?.italic ?? false,
    underline: s?.underline ?? false,
    strike: s?.strike ?? false,
  });
  if (s == null) return;
  if (s.fg !== null) target.style.color = s.fg;
  if (s.bg !== null) target.style.background = s.fg !== null ? 'transparent' : s.bg;
}

/** The created picker widget. */
export interface TypeCheckPicker {
  root: HTMLElement;
  /** Selected type ids, live (same reference identity until the next change). */
  selected(): Set<string>;
}

/**
 * Builds the inline tree-checkbox picker. `selected` is the live set — the
 * picker mutates it in place on every checkbox toggle and reports through
 * `onChange`, so the host keeps its own reference in sync without a rebuild.
 */
export function createTypeCheckPicker(opts: {
  options: () => TypeOption[];
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  /** Search box placeholder. */
  placeholder?: string;
  /** Max list height in px (the list scrolls). */
  maxHeightPx?: number;
}): TypeCheckPicker {
  const { options, onChange } = opts;
  const selected = new Set(opts.selected);

  const root = div('type-check-picker');
  const searchRow = div('form-row type-check-search');
  const searchInput = el('input', 'text-input') as HTMLInputElement;
  searchInput.type = 'text';
  searchInput.placeholder = opts.placeholder ?? 'Поиск типа…';
  const clearBtn = button('снять всё', () => {
    selected.clear();
    onChange(selected);
    renderList();
  }, 'btn small', 'Снять отбор: подойдут мысли любого типа');
  searchRow.append(searchInput, clearBtn);
  const list = div('type-check-list');
  if (opts.maxHeightPx !== undefined) list.style.maxHeight = `${opts.maxHeightPx}px`;
  root.append(searchRow, list);

  function renderList(): void {
    const rows = filterCheckRows(options(), searchInput.value);
    clearBtn.disabled = selected.size === 0;
    list.replaceChildren();
    if (rows.length === 0) {
      list.append(el('p', 'muted type-check-empty', 'Ничего не найдено.'));
      return;
    }
    for (const opt of rows) {
      const row = el('label', 'type-check-row');
      row.style.paddingLeft = `${4 + Math.max(0, (opt.depth ?? 1) - 1) * 16}px`;
      const check = el('input') as HTMLInputElement;
      check.type = 'checkbox';
      check.checked = opt.id !== null && selected.has(opt.id);
      check.addEventListener('change', () => {
        if (opt.id === null) return;
        if (check.checked) selected.add(opt.id);
        else selected.delete(opt.id);
        onChange(selected);
        clearBtn.disabled = selected.size === 0;
      });
      const icon = span('', 'type-combo-icon');
      renderIcon(icon, opt);
      const label = span(opt.label, 'type-check-label');
      applyStyle(label, opt);
      row.append(check, icon, label);
      list.append(row);
    }
  }

  searchInput.addEventListener('input', renderList);
  renderList();

  return { root, selected: () => selected };
}
