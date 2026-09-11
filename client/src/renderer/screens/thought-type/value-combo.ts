/**
 * Единый редактор значения условия отбора (задача 27472616, спека e0257ca5
 * «Диалог отбора типа мысли»): комбобокс с живым поиском по подстроке среди
 * кандидатов (токены и/или другие сущности — мысли, типы) поверх обычного
 * текстового поля, и chip-редактор для списочных условий (`in`/`not_in`) и
 * полей «Родительские мысли»/«Типы мыслей»/«Типы связей», где несколько
 * литералов и токенов можно свободно смешивать.
 *
 * Заменяет точечные `makeTokenBtn`/`openTokenPicker` (статичное меню без
 * живого поиска) и chip-поля `ttChips`/`ptChips`/`ltChips`, которые раньше
 * подменяли список одним токеном вместо добавления, — см. `filter-dialog.ts`.
 *
 * Формат хранимых значений НЕ меняется: строка (литерал или `$token`) для
 * скалярных условий, массив строк для списочных — резолвер токенов на
 * сервере не трогается, это чисто клиентский редактор ввода.
 */

import { clear, div, el, positionBodyDropdown, span } from '../../lib/dom.js';

import type { ComboOption } from './filter-dialog-pure.js';

export type { ComboOption } from './filter-dialog-pure.js';

// ---------------------------------------------------------------------------
// Live-search dropdown — attaches to an existing <input>
// ---------------------------------------------------------------------------

/** Pure index math for ↑/↓ over a candidate list (mirrors thought-picker.ts). */
function navIndex(cursor: number | null, count: number, delta: 1 | -1): number | null {
  if (count === 0) return null;
  const base = cursor === null || cursor >= count ? (delta === 1 ? -1 : count) : cursor;
  return Math.min(count - 1, Math.max(0, base + delta));
}

export interface TokenComboOptions {
  /** The input the live-search dropdown is attached to. The caller keeps
   *  its own `input`-event listener for free-text persistence — this only
   *  adds the candidate dropdown on top, it never touches `input.value`
   *  except through `onPick`. */
  input: HTMLInputElement;
  /** Candidate source for the current query; the caller pre-filters (e.g.
   *  via `filterComboOptions`) and may resolve async (live thought search). */
  getOptions: (query: string) => ComboOption[] | Promise<ComboOption[]>;
  /** Fired when the user picks a candidate (click, or Enter/Tab on a
   *  highlighted row). The handler owns how the pick affects `input.value`
   *  — a plain replace for atomic fields, an insert-at-caret for compound
   *  ones (e.g. «Ключевые слова»). */
  onPick: (value: string) => void;
  /** Extracts the search query from the input — defaults to the whole
   *  value. Compound fields (keywords) pass {@link trailingWordQuery}. */
  queryOf?: (input: HTMLInputElement) => string;
}

/**
 * Attaches a live-search dropdown to `opts.input`: typing (and focusing an
 * empty field) filters/lists candidates in a body-mounted dropdown; ↑/↓ move
 * the highlight, Enter picks the highlighted row (or does nothing over free
 * text — the caller's own `input` listener already persisted it), Escape
 * closes without touching the value.
 */
export function wireTokenCombo(opts: TokenComboOptions): void {
  const { input } = opts;
  const queryOf = opts.queryOf ?? ((inp: HTMLInputElement) => inp.value);
  let list: HTMLElement | null = null;
  let cursor: number | null = null;
  let seq = 0;

  const close = (): void => {
    if (list === null) return;
    list.remove();
    list = null;
    cursor = null;
    window.removeEventListener('mousedown', onOutside, true);
  };

  const onOutside = (event: MouseEvent): void => {
    if (list !== null && event.target instanceof Node && !list.contains(event.target) && event.target !== input) {
      close();
    }
  };

  const render = (options: ComboOption[]): void => {
    if (list === null) return;
    clear(list);
    cursor = null;
    let lastSection: string | undefined;
    for (const opt of options) {
      if (opt.section !== undefined && opt.section !== lastSection) {
        list.append(el('div', 'value-combo-section', opt.section));
        lastSection = opt.section;
      }
      const row = div(`type-combo-item${opt.disabled === true ? ' disabled' : ''}`);
      row.append(el('span', 'type-combo-label', opt.label));
      if (opt.disabled !== true) {
        row.addEventListener('mousedown', (event) => event.preventDefault());
        row.addEventListener('click', () => {
          close();
          opts.onPick(opt.value);
        });
      }
      list.append(row);
    }
    if (options.length === 0) list.append(el('p', 'muted', 'Совпадений нет.'));
    positionBodyDropdown(list, input);
  };

  const open = async (): Promise<void> => {
    const run = ++seq;
    const query = queryOf(input);
    const options = await opts.getOptions(query);
    if (run !== seq || !input.isConnected) return;
    if (list === null) {
      list = div('type-combo-list');
      document.body.append(list);
      window.addEventListener('mousedown', onOutside, true);
    }
    render(options);
  };

  input.addEventListener('input', () => void open());
  input.addEventListener('focus', () => void open());
  input.addEventListener('keydown', (event) => {
    if (list === null) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.type-combo-item:not(.disabled)'));
    const paint = (): void => {
      rows.forEach((row, i) => row.classList.toggle('active', i === cursor));
      if (cursor !== null) rows[cursor]?.scrollIntoView({ block: 'nearest' });
    };
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rows.length === 0) return;
      event.preventDefault();
      const next = navIndex(cursor, rows.length, event.key === 'ArrowDown' ? 1 : -1);
      if (next === null) return;
      cursor = next;
      paint();
    } else if (event.key === 'Enter' && cursor !== null && !event.shiftKey) {
      // A highlighted candidate wins Enter outright — `stopImmediatePropagation`
      // also suppresses a sibling keydown listener on the SAME input (e.g. the
      // chip-list's own Enter-commits-free-text handler in `buildChipListField`),
      // not just bubbling, so the pick and a stale free-text commit can never
      // both fire for one keystroke.
      event.preventDefault();
      event.stopImmediatePropagation();
      rows[cursor]?.click();
    }
  });
  input.addEventListener('blur', () => {
    // A short delay lets a row's `mousedown`/click land before the dropdown
    // is torn down (mirrors thought-picker.ts's blur-restore pattern).
    window.setTimeout(close, 0);
  });
}

/** Replaces the whole input value with `token` and refocuses — the default
 *  pick behaviour for atomic scalar fields (date/text/url/thought_ref/
 *  author/editor single value): the typed prefix that produced the match is
 *  fully replaced, matching a standard combobox, not appended to. */
export function replaceComboValue(input: HTMLInputElement, token: string, onChange: (v: string) => void): void {
  input.value = token;
  onChange(token);
  input.focus();
  const caret = token.length;
  try {
    input.setSelectionRange(caret, caret);
  } catch {
    /* ignore */
  }
}

/** Extracts the trailing whitespace-delimited word up to the caret — the
 *  search query for compound fields (e.g. «Ключевые слова»), where a token
 *  can sit next to literal text rather than being the whole value. */
export function trailingWordQuery(input: HTMLInputElement): string {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  return /(\S*)$/.exec(before)?.[1] ?? '';
}

/** Replaces the trailing word (see {@link trailingWordQuery}) with `token`
 *  and refocuses with the caret right after it — the pick behaviour for
 *  compound fields where only a word fragment is the query, not the whole
 *  value (keywords: `урочные $tod` → `урочные $today`, the rest untouched). */
export function replaceTrailingWord(input: HTMLInputElement, token: string, onChange: (v: string) => void): void {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const after = input.value.slice(caret);
  const wordLen = /(\S*)$/.exec(before)?.[1]?.length ?? 0;
  const wordStart = caret - wordLen;
  const next = input.value.slice(0, wordStart) + token + after;
  input.value = next;
  onChange(next);
  input.focus();
  const newCaret = wordStart + token.length;
  try {
    input.setSelectionRange(newCaret, newCaret);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Chip-list editor — for `in`/`not_in` and the parent/type/link-type fields
// ---------------------------------------------------------------------------

export interface ChipPickerOptions {
  /** Button label, e.g. «выбрать…» / «список типов…». */
  label: string;
  /**
   * Opens a modal that manages a SUBSET of the chip values (the ones
   * `isManaged` accepts — by default everything that is not a `$…` token).
   * Receives the currently managed ids, returns the complete replacement set
   * for that subset (`null` — cancelled, leave the chips untouched). Chips
   * outside the managed subset (typed/picked tokens) are preserved as-is —
   * this is how the picker and the token combo compose instead of one
   * clobbering the other (§27472616 «Родительские мысли»/«Типы мыслей»/
   * «Типы связей»).
   */
  open: (managedValues: string[]) => Promise<string[] | null>;
  isManaged?: (value: string) => boolean;
}

export interface ChipListOptions {
  /** Current stored values (read fresh on every render — the caller owns
   *  the state array, this widget never mutates it in place). */
  getValues: () => string[];
  /** Persists the full replacement list. */
  onChange: (values: string[]) => void;
  /** Live-search candidates for the inline add-input. */
  getOptions: (query: string) => ComboOption[] | Promise<ComboOption[]>;
  /** Chip display label for a stored value — resolved async so callers can
   *  look up thought titles/type names without blocking the render. */
  renderLabel: (value: string) => string | Promise<string>;
  placeholder?: string;
  /** Optional modal picker merged into the same chip list (see {@link ChipPickerOptions}). */
  picker?: ChipPickerOptions;
}

export interface ChipListField {
  root: HTMLElement;
  /** Re-renders the chips from `getValues()` — call after an external
   *  programmatic change to the underlying state (e.g. condition reset). */
  refresh: () => void;
}

/**
 * Tag-input style chip list: existing values render as removable chips
 * inline with a trailing text field; typing filters live candidates
 * (tokens and/or async lookups), Enter (with or without a highlighted
 * candidate) commits the current text as a new chip and clears the field
 * for the next one. An optional «выбрать…» button opens a modal picker
 * whose result is merged, not replacing token chips (see {@link ChipPickerOptions}).
 */
export function buildChipListField(opts: ChipListOptions): ChipListField {
  const root = div('st-f-fieldrow value-combo-row');
  const field = div('st-f-chipfield value-combo-field');
  const addInput = el('input', 'value-combo-add') as HTMLInputElement;
  addInput.type = 'text';
  addInput.placeholder = opts.placeholder ?? 'Добавить значение…';

  const commit = (raw: string): void => {
    const value = raw.trim();
    if (value === '') return;
    const current = opts.getValues();
    if (current.includes(value)) {
      addInput.value = '';
      return;
    }
    opts.onChange([...current, value]);
    addInput.value = '';
    renderChips();
  };

  wireTokenCombo({
    input: addInput,
    getOptions: opts.getOptions,
    onPick: commit,
  });
  addInput.addEventListener('keydown', (event) => {
    // wireTokenCombo's own keydown listener (registered above, on the same
    // input) already consumed Enter over a highlighted candidate via
    // `stopImmediatePropagation` — this only ever fires for free-typed text.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      commit(addInput.value);
    }
  });
  field.addEventListener('click', (event) => {
    if (event.target === field) addInput.focus();
  });

  const renderChips = (): void => {
    const chips = Array.from(field.children).filter((c) => c !== addInput);
    for (const c of chips) c.remove();
    const values = opts.getValues();
    for (const value of values) {
      const chip = div('st-f-chip value-combo-chip');
      const label = span(value, 'st-f-chip-label');
      chip.append(label);
      void Promise.resolve(opts.renderLabel(value)).then((text) => {
        label.textContent = text;
      });
      const rm = el('button', 'st-f-remove', '×') as HTMLButtonElement;
      rm.type = 'button';
      rm.title = 'Убрать';
      rm.addEventListener('click', (event) => {
        event.stopPropagation();
        opts.onChange(opts.getValues().filter((v) => v !== value));
        renderChips();
      });
      chip.append(rm);
      field.insertBefore(chip, addInput);
    }
  };
  field.append(addInput);
  renderChips();

  root.append(field);
  if (opts.picker !== undefined) {
    const { picker } = opts;
    const isManaged = picker.isManaged ?? ((v: string) => !v.startsWith('$'));
    const pickBtn = el('button', 'st-f-add value-combo-pick', picker.label) as HTMLButtonElement;
    pickBtn.type = 'button';
    pickBtn.addEventListener('click', () => {
      const managed = opts.getValues().filter(isManaged);
      void picker.open(managed).then((next) => {
        if (next === null) return;
        const kept = opts.getValues().filter((v) => !isManaged(v));
        opts.onChange([...kept, ...next]);
        renderChips();
      });
    });
    root.append(pickBtn);
  }

  return { root, refresh: renderChips };
}
