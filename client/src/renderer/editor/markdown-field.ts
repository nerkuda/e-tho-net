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

import { requireNetworkId } from '../app.js';
import { invalidateIndicators } from '../canvas/canvas.js';
import { div, el, renderHtml } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';

/** Owner entity for pasted-image attachments ('thought' | 'link'). */
export interface AttachmentsOwner {
  ownerType: 'thought' | 'link';
  ownerId: string;
}

/** Builds a markdown view/edit field. */
export function createMarkdownField(opts: {
  md: string;
  html: string;
  /** Persist the markdown; resolves the updated HTML to display. */
  onSave?: (md: string) => Promise<string>;
  /** Live text changes (e.g. to mirror a draft). */
  onInput?: (md: string) => void;
  /**
   * When set, pasting an image from the clipboard saves it as an attachment of
   * this entity and inserts the markdown image reference at the caret.
   */
  attachmentsOwner?: AttachmentsOwner;
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

  // Pasting an image (screenshot / copied image file) saves it as an
  // attachment of the owner entity and inserts the markdown reference.
  area.addEventListener('paste', (event) => {
    const owner = opts.attachmentsOwner;
    if (owner === undefined) return;
    const files = event.clipboardData?.files;
    if (files === undefined || files.length === 0) return;
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    event.preventDefault();
    void insertClipboardImages(area, owner, images);
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

/** Saves pasted images as attachments and inserts markdown refs at the caret. */
async function insertClipboardImages(
  area: HTMLTextAreaElement,
  owner: AttachmentsOwner,
  images: File[],
): Promise<void> {
  const networkId = requireNetworkId();
  for (const file of images) {
    // A copied FILE may carry its OS path (Electron ≤31) — attach it as-is;
    // a raw bitmap (screenshot) is persisted through the main process.
    const existingPath = (file as File & { path?: string }).path;
    let filePath: string | null = existingPath ?? null;
    if (filePath === null) {
      const dataUrl = await readFileAsDataUrl(file);
      filePath = await etn.system.saveClipboardImage(dataUrl, file.name);
    }
    if (filePath === null || filePath === '') {
      notice('Не удалось сохранить изображение из буфера.', 'error');
      continue;
    }
    const title = file.name.trim() !== '' ? file.name.trim() : pathBaseName(filePath);
    try {
      await etn.attachments.add(networkId, owner.ownerType, owner.ownerId, {
        kind: 'file',
        file_path: filePath,
        file_size: file.size,
        mime_type: file.type || null,
        title,
      });
      invalidateIndicators(owner.ownerId);
    } catch {
      notice('Не удалось добавить вложение.', 'error');
      continue;
    }
    insertAtCaret(area, `![${sanitizeAlt(title)}](${fileUrl(filePath)})`);
  }
}

/** Reads a File into a `data:` URL. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('read failed')));
    reader.readAsDataURL(file);
  });
}

/** Absolute path → `file:///` URL with each segment percent-encoded. */
function fileUrl(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/').filter((s) => s !== '');
  const encoded = segments.map((seg, i) =>
    i === 0 && /^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg),
  );
  return `file:///${encoded.join('/')}`;
}

/** Last path segment. */
function pathBaseName(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? 'image';
}

/** Markdown image alt text must not contain brackets. */
function sanitizeAlt(text: string): string {
  return text.replace(/[[\]]/g, '').trim() || 'изображение';
}

/** Inserts text at the caret and fires `input` (resize + onInput listeners). */
function insertAtCaret(area: HTMLTextAreaElement, text: string): void {
  const start = area.selectionStart ?? area.value.length;
  const end = area.selectionEnd ?? start;
  const prefix = start > 0 && area.value[start - 1] !== '\n' ? '\n' : '';
  area.setRangeText(`${prefix}${text}`, start, end, 'end');
  area.dispatchEvent(new Event('input', { bubbles: true }));
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
