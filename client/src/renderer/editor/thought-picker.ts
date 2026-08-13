/**
 * Thought-reference picker: a modal search over existing thoughts, reused by
 * property editors (H11) and the add dialog's «использовать» flows (H14).
 *
 * The input is matched via `thoughts.findDuplicates` (live, debounced); the
 * strongest candidates are listed with their match kind; picking one resolves
 * the promise with the thought id (or `null` on cancel).
 */

import { showDialog } from '../lib/dialog.js';
import { button, div, el, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';

/** Match-kind labels shown next to candidates. */
const KIND_LABELS: Record<string, string> = {
  title: 'точное имя',
  synonym: 'синоним',
  partial: 'частично',
};

/**
 * Opens the picker dialog. Resolves the chosen thought id, or `null`.
 */
export function pickThoughtRef(networkId: string, _allowedTypeId?: string): Promise<string | null> {
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

    let timer: number | null = null;

    const search = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void (async () => {
          const query = input.value.trim();
          if (query === '') {
            list.replaceChildren();
            return;
          }
          try {
            const hits = await etn.thoughts.findDuplicates(networkId, query);
            renderHits(hits);
          } catch (err) {
            errorLine.textContent = err instanceof Error ? err.message : String(err);
          }
        })();
      }, 200);
    };
    input.addEventListener('input', search);

    function renderHits(hits: Array<{ id: string; title: string; matched_on: string }>): void {
      list.replaceChildren();
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
    };

    showDialog({
      title: 'Выбор мысли',
      body,
      width: 440,
      buttons: [{ label: 'Отмена', onClick: () => finish(null) }],
      onMount: () => input.focus(),
    });
    search();
  });
}
