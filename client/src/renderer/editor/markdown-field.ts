/**
 * A reusable markdown view/edit field (08-ui-spec.md §6.4, §6.6).
 *
 * Shows server-rendered HTML by default; a double-click switches to a
 * CodeMirror 6 markdown editor (task M2). Leaving the field (blur) commits the
 * change through `onSave` (which returns the freshly rendered HTML) and
 * returns to the view; `Esc` cancels, restoring the previous text.
 *
 * `onSave` may be omitted (e.g. a "new" form whose text is committed together
 * with the rest of the dialog): blur then just switches back to the view.
 */

import type { MentionsScanThought } from '@etn/shared';

import { requireNetworkId } from '../app.js';
import { invalidateIndicators } from '../canvas/canvas.js';
import { div, errText, renderHtml } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { showMenuAt, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { createMdEditor, type MdEditor } from './md-editor.js';
import { annotateMentions } from './mentions-annotate.js';
import { renderMermaidBlocks } from './md-mermaid.js';
import {
  applyMdZoom,
  currentMdZoom,
  loadMdZoom,
  persistMdZoom,
  zoomByWheel,
} from './md-zoom.js';

/** Owner entity for pasted-image attachments ('thought' | 'link'). */
export interface AttachmentsOwner {
  ownerType: 'thought' | 'link';
  ownerId: string;
}

/** Internal control surface of a built field (WeakMap keyed by root). */
interface MarkdownFieldHandle {
  showEdit(md?: string): void;
  set(md: string, html: string): void;
}

const handles = new WeakMap<HTMLElement, MarkdownFieldHandle>();

/** Builds a markdown view/edit field. */
export function createMarkdownField(opts: {
  md: string;
  html: string;
  /** Persist the markdown; resolves the updated HTML to display. */
  onSave?: (md: string) => Promise<string>;
  /** Live text changes (e.g. to mirror a draft). */
  onInput?: (md: string) => void;
  /**
   * Fired when Esc cancels a non-empty edit — the caller may drop its draft
   * mirror of the cancelled text.
   */
  onCancel?: () => void;
  /**
   * When set, pasting an image from the clipboard saves it as an attachment of
   * this entity and inserts the markdown image reference at the caret.
   */
  attachmentsOwner?: AttachmentsOwner;
  /**
   * Резолвер шаблона комментария типа (08-ui-spec.md §8.1, §6.4). Когда
   * задан, контекстное меню редактора (правый клик) предлагает пункт
   * «Вставить текст шаблона из типа мысли», если колбэк возвращает
   * непустую строку. Клик вставляет её в позицию курсора через
   * `MdEditor.insertAtCaret`.
   */
  onInsertTemplate?: () => string | null;
  /**
   * Thought never offered as an auto-mention match (L24): its own name and
   * synonyms must not be underlined in its own comment text. Evaluated on
   * every view render — the chronicle desktop passes a getter because a
   * record's thought targets can change after the field is built. Falls back
   * to the `attachmentsOwner` thought when omitted.
   */
  getMentionsExcludeThoughtId?: () => string | undefined;
  minRows?: number;
}): HTMLElement {
  const root = div('md-field');
  const view = div('md-field-view comment-view');
  const area = div('md-field-area');
  area.tabIndex = -1;
  area.setAttribute('aria-label', 'Текст комментария');

  let currentMd = opts.md;
  let currentHtml = opts.html;
  let cancelled = false;
  /** Guards against a focusout fired while the editor is being rebuilt. */
  let mounting = false;
  let editor: MdEditor | null = null;

  // Масштаб документа (M9): Ctrl+колесо над полем меняет глобальный
  // `--md-font-size` — действует на все md-поля; значение сохраняется на сеть.
  const networkId = requireNetworkId();
  void loadMdZoom(networkId);
  root.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const next = zoomByWheel(currentMdZoom(), event.deltaY);
    applyMdZoom(next);
    persistMdZoom(networkId, next);
  }, { passive: false });

  const excludeThoughtId = (): string | undefined =>
    opts.getMentionsExcludeThoughtId?.() ??
    (opts.attachmentsOwner?.ownerType === 'thought' ? opts.attachmentsOwner.ownerId : undefined);

  /**
   * «Вставить ссылку» (L24): replaces the first occurrence of the matched
   * plain text in the markdown source with a wiki-link and saves — or, when
   * the field has no `onSave` (e.g. a "new" form), stages the change by
   * switching into edit mode so the caller's own save flow picks it up.
   */
  const insertMentionLink = (thought: MentionsScanThought, matchedText: string): void => {
    const idx = currentMd.indexOf(matchedText);
    if (idx === -1) {
      notice(
        `Не удалось вставить ссылку: текст «${matchedText}» не найден в исходнике (изменён форматированием).`,
        'error',
      );
      return;
    }
    const newMd =
      currentMd.slice(0, idx) + `[[${thought.title}|${matchedText}]]` + currentMd.slice(idx + matchedText.length);
    if (opts.onSave === undefined) {
      showEdit(newMd);
      return;
    }
    void opts
      .onSave(newMd)
      .then((html) => {
        currentMd = newMd;
        currentHtml = html;
        showView();
      })
      .catch((err) => {
        notice(`Не удалось сохранить ссылку: ${errText(err)}`, 'error');
      });
  };

  const renderView = (): void => {
    view.replaceChildren();
    if (currentHtml.trim() !== '') {
      renderHtml(view, currentHtml);
      renderMermaidBlocks(view);
      annotateMentions(view, {
        excludeThoughtId: excludeThoughtId(),
        onInsertLink: insertMentionLink,
      });
    }
  };

  const showView = (): void => {
    area.classList.add('hidden');
    view.classList.remove('hidden');
    renderView();
  };

  const commitOrRevert = (): void => {
    if (mounting || editor === null) return;
    const md = editor.getValue();
    if (cancelled) {
      // Esc: the edit is dropped; restore the saved text so the field returns
      // to the view unchanged.
      if (md !== currentMd) opts.onCancel?.();
      editor.setValue(currentMd);
      showView();
      return;
    }
    if (md === currentMd) {
      showView();
      return;
    }
    if (opts.onSave === undefined) {
      // No autosave: without a client renderer we cannot preview unsaved md.
      editor.setValue(currentMd);
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
        editor?.setValue(currentMd);
        showView();
      });
  };

  /** Mounts a fresh editor for the current markdown. */
  const mountEditor = (): void => {
    mounting = true;
    editor?.destroy();
    cancelled = false;
    editor = createMdEditor(currentMd, {
      onInput: (md) => opts.onInput?.(md),
      onEscape: () => {
        cancelled = true;
        editor?.blur();
      },
      // Ctrl+Enter (M10): обычный коммит через blur-обработчик.
      onCommit: () => {
        cancelled = false;
        editor?.blur();
      },
      onBlur: () => commitOrRevert(),
    });
    // Pasting files (screenshots / copied files) saves them as server-stored
    // attachments of the owner entity and inserts a markdown reference at the
    // caret: images embed as `![alt](etnimg:…)`, other files as a link.
    editor.dom.addEventListener('paste', (event) => {
      const owner = opts.attachmentsOwner;
      if (owner === undefined || editor === null) return;
      const files = event.clipboardData?.files;
      if (files === undefined || files.length === 0) return;
      event.preventDefault();
      void insertClipboardFiles(editor, owner, Array.from(files));
    });
    // Контекстное меню: «Вставить текст шаблона из типа мысли»
    // (08-ui-spec.md §6.4). Пункт появляется только когда тип назначен и
    // шаблон непустой — тогда нативное контекстное меню редактора не
    // показывается; иначе пропускаем событие, и пользователь видит
    // стандартное меню CM6.
    editor.dom.addEventListener('contextmenu', (event) => {
      if (opts.onInsertTemplate === undefined || editor === null) return;
      const template = opts.onInsertTemplate();
      if (template === null || template.trim() === '') return;
      event.preventDefault();
      const items: MenuItem[] = [
        {
          label: 'Вставить текст шаблона из типа мысли',
          onClick: () => {
            if (editor === null) return;
            if (area.classList.contains('hidden')) {
              // Поле в view-режиме: переключаем в edit и подставляем текст.
              showEdit(template);
            } else {
              editor.insertAtCaret(template);
            }
          },
        },
      ];
      showMenuAt(event.clientX, event.clientY, items);
    });
    area.replaceChildren(editor.dom);
    mounting = false;
    editor.focusToEnd();
  };

  const showEdit = (md?: string): void => {
    if (md !== undefined) currentMd = md;
    view.classList.add('hidden');
    area.classList.remove('hidden');
    mountEditor();
  };

  // Programmatic focus (e.g. the editor rebuild refocus, editor.ts) lands on
  // the wrapper and is delegated to the editor.
  area.addEventListener('focus', () => editor?.focus());
  view.addEventListener('dblclick', () => showEdit());

  handles.set(root, {
    showEdit,
    set: (md, html) => {
      currentMd = md;
      currentHtml = html;
      renderView();
      if (editor !== null && !area.classList.contains('hidden')) {
        editor.setValue(md);
      }
    },
  });

  root.append(view, area);
  showView();
  return root;
}

/** Switches an already-built field into edit mode (e.g. to restore a draft). */
export function editMarkdownField(root: HTMLElement, md?: string): void {
  handles.get(root)?.showEdit(md);
}

/** Updates an already-built field's content (e.g. after an external change). */
export function setMarkdownField(root: HTMLElement, md: string, html: string): void {
  handles.get(root)?.set(md, html);
}

/**
 * Uploads pasted files to the server (which stores them under the network's
 * `attachments/` directory next to `data.db`) and inserts markdown references
 * at the caret: `![alt](…)` for images, `[name](…)` links for other files.
 */
async function insertClipboardFiles(
  editor: MdEditor,
  owner: AttachmentsOwner,
  files: File[],
): Promise<void> {
  const networkId = requireNetworkId();
  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file);
    const comma = dataUrl.indexOf(',');
    const dataBase64 = comma === -1 ? '' : dataUrl.slice(comma + 1);
    const title = file.name.trim() !== '' ? file.name.trim() : 'file';
    const mime = file.type || guessMimeFromName(file.name) || 'application/octet-stream';
    let attachment;
    try {
      attachment = await etn.attachments.uploadFile(networkId, owner.ownerType, owner.ownerId, {
        title,
        mime_type: mime,
        data_base64: dataBase64,
      });
    } catch {
      notice('Не удалось добавить вложение.', 'error');
      continue;
    }
    invalidateIndicators(owner.ownerId);
    // Tell the editor chrome the owner's attachment set changed: the
    // «Вложения» tab (if built) reloads its list, the tab badge re-counts —
    // without this a paste from the comment field left a stale empty list
    // until the editor target changed.
    document.dispatchEvent(
      new CustomEvent('etn:attachments-changed', {
        detail: { ownerType: owner.ownerType, ownerId: owner.ownerId },
      }),
    );
    const filePath = attachment.file_path;
    if (filePath === null || filePath === '') continue;
    const url = etnimgUrl(filePath);
    const ref = mime.startsWith('image/')
      ? `![${sanitizeAlt(title)}](${url})`
      : `[${sanitizeAlt(title)}](${url})`;
    editor.insertAtCaret(ref);
  }
}

/** Rough MIME guess for files without a type (by extension). */
export function guessMimeFromName(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    md: 'text/markdown',
    pdf: 'application/pdf',
  };
  return map[ext] ?? null;
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

/**
 * Absolute server file path → `etnimg://` URL. The `etnimg` scheme is a
 * privileged protocol served by the Electron main process (works both from the
 * dev http origin and from the packaged file:// page, unlike raw file://).
 */
export function etnimgUrl(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/').filter((s) => s !== '');
  const encoded = segments.map((seg, i) => {
    // A Windows drive segment ("C:") becomes the URL host — a bare letter,
    // because ':' would parse as a port separator.
    if (i === 0 && /^[a-zA-Z]:$/.test(seg)) return seg[0]!.toLowerCase();
    return encodeURIComponent(seg);
  });
  return `etnimg://${encoded.join('/')}`;
}

/** Markdown image alt text must not contain brackets. */
function sanitizeAlt(text: string): string {
  return text.replace(/[[\]]/g, '').trim() || 'изображение';
}
