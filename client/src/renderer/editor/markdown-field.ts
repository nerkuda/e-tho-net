/**
 * A reusable markdown view/edit field (08-ui-spec.md §6.4, §6.6).
 *
 * Shows server-rendered HTML by default; a double-click switches to a markdown
 * textarea. Leaving the field (blur) commits the change through `onSave` (which
 * returns the freshly rendered HTML) and returns to the view; `Esc` cancels,
 * restoring the previous text. The field auto-sizes to its content with a
 * minimum height of `minRows` lines.
 *
 * `onSave` may be omitted (e.g. a "new" form whose text is committed together
 * with the rest of the dialog): blur then just switches back to the view.
 */

import { div, el, renderHtml } from '../lib/dom.js';

/** Builds a markdown view/edit field. */
export function createMarkdownField(opts: {
  md: string;
  html: string;
  /** Persist the markdown; resolves the updated HTML to display. */
  onSave?: (md: string) => Promise<string>;
  /** Live text changes (e.g. to mirror a draft). */
  onInput?: (md: string) => void;
  minRows?: number;
}): HTMLElement {
  const minRows = opts.minRows ?? 5;
  const root = div('md-field');
  const view = div('md-field-view comment-view');
  const area = el('textarea', 'md-field-area textarea-input') as HTMLTextAreaElement;
  area.rows = minRows;
  area.setAttribute('aria-label', 'Текст комментария');

  let currentMd = opts.md;
  let currentHtml = opts.html;

  const renderView = (): void => {
    view.replaceChildren();
    if (currentHtml.trim() !== '') {
      renderHtml(view, currentHtml);
    }
  };

  const showView = (): void => {
    area.classList.add('hidden');
    view.classList.remove('hidden');
    renderView();
  };

  const showEdit = (): void => {
    view.classList.add('hidden');
    area.classList.remove('hidden');
    area.value = currentMd;
    resize();
    area.focus();
    // Place the caret at the end.
    area.setSelectionRange(area.value.length, area.value.length);
  };

  const resize = (): void => {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  };

  area.addEventListener('input', () => {
    resize();
    opts.onInput?.(area.value);
  });

  area.addEventListener('blur', () => {
    const md = area.value;
    if (md === currentMd) {
      showView();
      return;
    }
    if (opts.onSave === undefined) {
      // No autosave: without a client renderer we cannot preview unsaved md.
      area.value = currentMd;
      showView();
      return;
    }
    void opts
      .onSave(md)
      .then((html) => {
        currentMd = md;
        currentHtml = html;
        showView();
      })
      .catch(() => {
        // Save failed: revert.
        area.value = currentMd;
        showView();
      });
  });

  area.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      // Revert to the saved text so the blur handler treats it as unchanged.
      area.value = currentMd;
      area.blur();
    }
  });

  view.addEventListener('dblclick', showEdit);

  root.append(view, area);
  showView();
  return root;
}

/** Switches an already-built field into edit mode (e.g. to restore a draft). */
export function editMarkdownField(root: HTMLElement, md?: string): void {
  const view = root.querySelector<HTMLElement>('.md-field-view');
  const area = root.querySelector<HTMLTextAreaElement>('.md-field-area');
  if (view === null || area === null) return;
  view.classList.add('hidden');
  area.classList.remove('hidden');
  if (md !== undefined) area.value = md;
  area.focus();
}

/** Updates an already-built field's content (e.g. after an external change). */
export function setMarkdownField(
  root: HTMLElement,
  md: string,
  html: string,
): void {
  const view = root.querySelector<HTMLElement>('.md-field-view');
  const area = root.querySelector<HTMLTextAreaElement>('.md-field-area');
  if (view !== null) {
    view.replaceChildren();
    if (html.trim() !== '') renderHtml(view, html);
  }
  if (area !== null) area.value = md;
}
