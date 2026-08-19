/**
 * Thought-reference picker: a modal search over existing thoughts, reused by
 * property editors (H11) and the add dialog's «использовать» flows (H14).
 *
 * The input is matched via `thoughts.findDuplicates` (live, debounced); the
 * strongest candidates are listed with their match kind; picking one resolves
 * the promise with the thought id (or `null` on cancel).
 *
 * `typeIds` restricts the search to thoughts of the given types — used by
 * `thought_ref` properties whose definition configures a type filter (the
 * filter is an input aid: it is only applied while searching, stored values
 * are never reprocessed when it changes).
 */

import { showDialog } from '../lib/dialog.js';
import { button, div, el, positionBodyDropdown, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { store } from '../state.js';

/** Match-kind labels shown next to candidates. */
const KIND_LABELS: Record<string, string> = {
  title: 'точное имя',
  synonym: 'синоним',
  partial: 'частично',
};

/** Pure index math for ↑/↓ over a candidate list (same rule as the toolbar search). */
function navIndex(cursor: number | null, count: number, delta: 1 | -1): number | null {
  if (count === 0) return null;
  const base = cursor === null || cursor >= count ? (delta === 1 ? -1 : count) : cursor;
  return Math.min(count - 1, Math.max(0, base + delta));
}

/**
 * Opens the picker dialog. Resolves the chosen thought id, or `null`.
 */
export function pickThoughtRef(networkId: string, typeIds?: string[]): Promise<string | null> {
  const filter = (typeIds ?? []).filter((id) => id !== '');
  return new Promise((resolve) => {
    const input = el('input', 'text-input');
    input.type = 'text';
    input.placeholder = 'Название мысли…';
    const list = div('dup-list');
    const hint = el('p', 'muted', 'Введите название — появятся кандидаты.');
    hint.style.margin = '0';
    const errorLine = span('', 'error-text');
    const body = div('form-stack');
    body.append(input, hint, list, errorLine);

    // Surface an active type filter so the narrowed result set is not confusing.
    if (filter.length > 0) {
      const names = filter
        .map((id) => store.state.thoughtTypes.find((t) => t.id === id)?.name)
        .filter((name): name is string => name !== undefined);
      if (names.length > 0) {
        const filterLine = el('p', 'muted', `Отбор по типам: ${names.join(', ')}`);
        filterLine.style.margin = '0 0 6px';
        body.insertBefore(filterLine, list);
      }
    }

    let timer: number | null = null;
    /** Keyboard cursor over the candidate rows (↑/↓, Ctrl+↑/↓, Ctrl+Enter). */
    let cursor: number | null = null;

    const search = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void (async () => {
          const query = input.value.trim();
          if (query === '') {
            list.replaceChildren();
            cursor = null;
            return;
          }
          try {
            const hits = await etn.thoughts.findDuplicates(networkId, query, [], filter);
            renderHits(hits);
          } catch (err) {
            errorLine.textContent = err instanceof Error ? err.message : String(err);
          }
        })();
      }, 200);
    };
    input.addEventListener('input', search);

    const candidateRows = (): HTMLElement[] =>
      Array.from(list.querySelectorAll<HTMLElement>('.dup-item'));

    const paintSelection = (): void => {
      const rows = candidateRows();
      rows.forEach((row, i) => row.classList.toggle('selected', i === cursor));
      if (cursor !== null) rows[cursor]?.scrollIntoView({ block: 'nearest' });
    };

    const moveCursor = (delta: 1 | -1): void => {
      const next = navIndex(cursor, candidateRows().length, delta);
      if (next === null) return;
      cursor = next;
      paintSelection();
    };

    /** Ctrl+Enter: activates the selected row (the first one when none), like «использовать». */
    const activateCursor = (): void => {
      const rows = candidateRows();
      rows[cursor ?? 0]?.querySelector<HTMLButtonElement>('button')?.click();
    };

    input.addEventListener('keydown', (event) => {
      if (event.ctrlKey && event.key === 'ArrowUp') {
        if (candidateRows().length === 0) return;
        event.preventDefault();
        cursor = 0;
        paintSelection();
      } else if (event.ctrlKey && event.key === 'ArrowDown') {
        if (candidateRows().length === 0) return;
        event.preventDefault();
        cursor = candidateRows().length - 1;
        paintSelection();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (candidateRows().length === 0) return;
        event.preventDefault();
        moveCursor(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        activateCursor();
      }
    });

    function renderHits(hits: Array<{ id: string; title: string; matched_on: string }>): void {
      list.replaceChildren();
      cursor = null;
      for (const hit of hits) {
        const row = div('dup-item');
        const title = el('span', 'dup-title', hit.title);
        title.title = hit.title;
        row.append(title, span(KIND_LABELS[hit.matched_on] ?? hit.matched_on, 'dup-kind'));
        row.append(
          button(
            'использовать',
            () => {
              finish(hit.id);
            },
            'btn small',
          ),
        );
        list.append(row);
      }
      if (hits.length === 0) list.append(el('p', 'muted', 'Совпадений нет.'));
    }

    const finish = (id: string | null): void => {
      resolve(id);
      // Picking (or cancelling) settles the dialog, not just the promise —
      // without this the picker stays open after «использовать».
      closeSelf();
    };

    const closeSelf = showDialog({
      title: 'Выбор мысли',
      body,
      width: 440,
      buttons: [{ label: 'Отмена', onClick: () => finish(null) }],
      onMount: () => input.focus(),
    });
    search();
  });
}

/**
 * Multi-thought picker (the chronicle filter's «мысли» field, L20): a modal
 * search over existing thoughts where several are accumulated in one pass —
 * Enter (or a click) adds the best candidate to the in-dialog list, Ctrl+Enter
 * (or «Применить») applies the whole list. Resolves the chosen ids or `null`
 * on cancel. Follows the add-dialog batch-mode interaction (08-ui-spec.md §4).
 */
export function pickThoughtsRef(
  networkId: string,
  initialIds: string[],
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const selectedIds = [...initialIds];
    /** Resolved titles of the selected ids (raw id as a fallback). */
    const titles = new Map<string, string>();
    let hits: Array<{ id: string; title: string; matched_on: string }> = [];
    let timer: number | null = null;

    const input = el('input', 'text-input');
    input.type = 'text';
    input.placeholder = 'Название мысли…';
    const hint = el('p', 'muted', 'Enter — добавить найденную мысль в список, Ctrl+Enter — применить.');
    hint.style.margin = '0';
    const candidates = div('dup-list');
    const selectedBox = div('add-list');
    const errorLine = span('', 'error-text');
    const body = div('form-stack');
    body.append(input, hint, candidates, selectedBox, errorLine);

    const renderSelected = (): void => {
      selectedBox.replaceChildren();
      for (const id of selectedIds) {
        const row = div('add-list-item');
        const title = el('span', 'al-title', titles.get(id) ?? id);
        title.title = title.textContent ?? '';
        row.append(
          title,
          button(
            '×',
            () => {
              selectedIds.splice(selectedIds.indexOf(id), 1);
              renderSelected();
            },
            'btn small',
            'Убрать мысль из списка',
          ),
        );
        selectedBox.append(row);
      }
    };

    /** Adds a candidate to the in-dialog list (duplicates are ignored). */
    const addHit = (id: string): void => {
      if (selectedIds.includes(id)) return;
      selectedIds.push(id);
      renderSelected();
    };

    const candidateRows = (): HTMLElement[] =>
      Array.from(candidates.querySelectorAll<HTMLElement>('.dup-item'));

    const search = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void (async () => {
          const query = input.value.trim();
          if (query === '') {
            candidates.replaceChildren();
            hits = [];
            return;
          }
          try {
            hits = await etn.thoughts.findDuplicates(networkId, query);
            renderHits();
          } catch (err) {
            errorLine.textContent = err instanceof Error ? err.message : String(err);
          }
        })();
      }, 200);
    };
    input.addEventListener('input', search);

    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        const first = candidateRows()[0];
        if (first !== undefined) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key !== 'Enter') return;
      // Ctrl+Enter bubbles to the dialog's primary button («Применить»).
      if (event.ctrlKey) return;
      event.preventDefault();
      const hit = hits[0];
      if (hit === undefined) return;
      addHit(hit.id);
      titles.set(hit.id, hit.title);
      input.value = '';
      hits = [];
      candidates.replaceChildren();
    });

    function renderHits(): void {
      candidates.replaceChildren();
      for (const hit of hits) {
        const row = div('dup-item');
        row.tabIndex = 0;
        const title = el('span', 'dup-title', hit.title);
        title.title = hit.title;
        row.append(title, span(KIND_LABELS[hit.matched_on] ?? hit.matched_on, 'dup-kind'));
        row.addEventListener('click', () => {
          titles.set(hit.id, hit.title);
          addHit(hit.id);
          input.value = '';
          hits = [];
          candidates.replaceChildren();
          input.focus();
        });
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            row.click();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const next =
              event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
            if (next instanceof HTMLElement && next.classList.contains('dup-item')) {
              next.focus();
              next.scrollIntoView({ block: 'nearest' });
            } else if (event.key === 'ArrowUp') {
              input.focus();
            }
          } else if (event.key === 'Escape') {
            event.preventDefault();
            input.focus();
          }
        });
        candidates.append(row);
      }
      if (hits.length === 0) candidates.append(el('p', 'muted', 'Совпадений нет.'));
    }

    /** Ctrl+Enter / «Применить»: a leftover query applies as its best candidate. */
    const apply = (): void => {
      const query = input.value.trim();
      if (selectedIds.length === 0 && query !== '' && hits.length > 0) {
        addHit(hits[0]!.id);
      }
      resolve([...selectedIds]);
      closeSelf();
    };

    // Resolve the initial selection titles (raw ids while loading / offline).
    void etn.thoughts
      .resolve(networkId, initialIds)
      .then((refs) => {
        for (const ref of refs) titles.set(ref.id, ref.title);
        renderSelected();
      })
      .catch(() => renderSelected());
    renderSelected();

    const closeSelf = showDialog({
      title: 'Выбор мыслей (несколько)',
      body,
      width: 480,
      buttons: [
        { label: 'Отмена', onClick: () => resolve(null) },
        { label: 'Применить', primary: true, onClick: apply },
      ],
      onMount: () => input.focus(),
    });
  });
}

/**
 * Wires an inline candidate search to a `thought_ref` value input: typing runs
 * the same live duplicate search as the dialog picker (honouring the type
 * filter) and shows the candidates in a body-mounted dropdown; clicking one
 * calls `onPick` with the thought id.
 *
 * The typed text itself is never a value — on blur the field falls back to the
 * title it showed when the search started, so only an explicitly picked
 * candidate (here or via the dialog picker) changes the stored value.
 */
export function wireThoughtRefSearch(
  input: HTMLInputElement,
  opts: {
    networkId: string;
    /** Thought-type filter of the property definition (input aid). */
    typeIds?: string[];
    onPick: (id: string) => void | Promise<void>;
  },
): void {
  const filter = (opts.typeIds ?? []).filter((id) => id !== '');
  const original = input.value;
  let list: HTMLDivElement | null = null;
  let timer: number | null = null;
  let seq = 0;
  /** Keyboard cursor over the dropdown rows (↑/↓, Ctrl+↑/↓, Ctrl+Enter). */
  let cursor: number | null = null;

  const close = (): void => {
    if (list === null) return;
    list.remove();
    list = null;
    window.removeEventListener('mousedown', onOutside, true);
  };

  const onOutside = (event: MouseEvent): void => {
    if (
      list !== null &&
      event.target instanceof Node &&
      !list.contains(event.target) &&
      event.target !== input
    ) {
      close();
    }
  };

  /** Optional dropdown header naming the active type filter. */
  const filterHint = (): HTMLElement | null => {
    if (filter.length === 0) return null;
    const names = filter
      .map((id) => store.state.thoughtTypes.find((t) => t.id === id)?.name)
      .filter((name): name is string => name !== undefined);
    if (names.length === 0) return null;
    return el('p', 'muted type-combo-empty', `Отбор по типам: ${names.join(', ')}`);
  };

  function renderHits(hits: Array<{ id: string; title: string; matched_on: string }>): void {
    if (list === null) return;
    list.replaceChildren();
    cursor = null;
    const hint = filterHint();
    if (hint !== null) list.append(hint);
    for (const hit of hits) {
      const row = div('type-combo-item');
      const title = el('span', 'type-combo-label', hit.title);
      title.title = hit.title;
      title.style.flex = '1';
      row.append(title, span(KIND_LABELS[hit.matched_on] ?? hit.matched_on, 'dup-kind'));
      // Keep the focus in the input — no blur-restore while picking.
      row.addEventListener('mousedown', (event) => event.preventDefault());
      row.addEventListener('click', () => {
        input.value = hit.title;
        close();
        void opts.onPick(hit.id);
      });
      list.append(row);
    }
    if (hits.length === 0) list.append(el('p', 'muted', 'Совпадений нет.'));
    positionBodyDropdown(list, input);
  }

  async function search(): Promise<void> {
    const query = input.value.trim();
    if (query === '' || !input.isConnected) {
      close();
      return;
    }
    const run = ++seq;
    try {
      const hits = await etn.thoughts.findDuplicates(opts.networkId, query, [], filter);
      // A newer keystroke (or an editor re-render) may have won the race.
      if (run !== seq || !input.isConnected) return;
      if (list === null) {
        list = div('type-combo-list');
        document.body.append(list);
        window.addEventListener('mousedown', onOutside, true);
      }
      renderHits(hits);
    } catch {
      // Transient search errors (offline blips) leave the field as is.
    }
  }

  input.addEventListener('input', () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => void search(), 200);
  });
  input.addEventListener('keydown', (event) => {
    if (list === null) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.type-combo-item'));
    const paintRows = (): void => {
      rows.forEach((row, i) => row.classList.toggle('active', i === cursor));
      if (cursor !== null) rows[cursor]?.scrollIntoView({ block: 'nearest' });
    };
    if (event.ctrlKey && event.key === 'ArrowUp') {
      if (rows.length === 0) return;
      event.preventDefault();
      cursor = 0;
      paintRows();
    } else if (event.ctrlKey && event.key === 'ArrowDown') {
      if (rows.length === 0) return;
      event.preventDefault();
      cursor = rows.length - 1;
      paintRows();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rows.length === 0) return;
      event.preventDefault();
      const next = navIndex(cursor, rows.length, event.key === 'ArrowDown' ? 1 : -1);
      if (next === null) return;
      cursor = next;
      paintRows();
    } else if (event.ctrlKey && event.key === 'Enter') {
      if (rows.length === 0) return;
      event.preventDefault();
      rows[cursor ?? 0]?.click();
    }
  });
  input.addEventListener('blur', () => {
    close();
    input.value = original;
  });
}
