/**
 * Editor tab «Вложения (N)» (H10 → L7, 08-ui-spec.md §6.5; 09-scenarios.md D3).
 *
 * Two areas separated by a splitter:
 *  - the list (at most five visible rows, vertical scroll beyond that) with the
 *    drag-and-drop zone and the «Добавить вложение» button. Click selects an
 *    attachment for viewing; double-click opens it in the OS default app;
 *    right-click opens the context menu (L1, minus «Показать» — superseded by
 *    the inline viewer).
 *  - the inline viewer below: images render scaled to the area width;
 *    text/markdown files behave like the permanent comment (HTML view,
 *    double-click edits, blur saves through `PUT …/attachments/{id}/content`);
 *    everything else shows an «Открыть в приложении по умолчанию» button.
 *
 * The tab content is built only when the tab is active; the `(N)` badge in the
 * tab title is refreshed after every change.
 */

import type { Attachment } from '@etn/shared';

import { invalidateIndicators, invalidateRef } from '../canvas/canvas.js';
import { confirmDialog, field, showDialog } from '../lib/dialog.js';
import { button, div, el, errText, isHttpUrl, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { showMenuAt, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { requireNetworkId } from '../app.js';
import { store } from '../state.js';
import { pickThoughtRef } from './thought-picker.js';
import { etnimgUrl, createMarkdownField } from './markdown-field.js';
import {
  refreshTabCount,
  registerTabContent,
  registerTabCount,
  type EditorContext,
} from './editor.js';
import { rowSplitter } from './splitter.js';

/** Registers the attachments tab content and its badge counter (L7). */
export function registerAttachmentsTab(): void {
  registerTabContent('attachments', buildAttachmentsTab);
  registerTabCount('attachments', async (ctx) => {
    try {
      const items = await etn.attachments.list(
        requireNetworkId(),
        ctx.ownerType,
        ctx.ownerId,
      );
      return items.length;
    } catch {
      return undefined;
    }
  });
}

/** True for image files (server-stored or client-local). */
function isImageFile(a: Attachment): boolean {
  return a.kind === 'file' && (a.mime_type ?? '').startsWith('image/');
}

/** True for URL attachments pointing at common image formats. */
function isImageUrl(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?.*)?$/i.test(url);
}

/** True for text/markdown files editable through the content API (L7). */
function isViewableText(a: Attachment): boolean {
  if (a.kind !== 'file') return false;
  if ((a.mime_type ?? '').startsWith('text/')) return true;
  return /\.(txt|md|markdown)$/i.test(a.file_path ?? '');
}

/** True for markdown files (server-rendered html in the viewer). */
function isMarkdownFile(a: Attachment): boolean {
  const mime = (a.mime_type ?? '').toLowerCase();
  if (mime === 'text/markdown' || mime === 'text/md') return true;
  return /\.(md|markdown)$/i.test(a.file_path ?? '');
}

/** Thought-icon size limit, mirrors the server (`assertImageIcon`). */
const THOUGHT_ICON_MAX_BYTES = 256 * 1024;

/** Reads a Blob into a `data:` URL (FileReader — no Buffer in the renderer). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('read failed')));
    reader.readAsDataURL(blob);
  });
}

/** Encodes UTF-8 text as base64 without Node's Buffer (renderer-side). */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Minimal HTML escaping for wrapping plain text into a view block. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Builds the whole attachments tab pane content for the entity. */
function buildAttachmentsTab(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const root = div('attachments-tab');

  const top = div('attachments-top');
  const drop = div('attachments-drop');
  drop.textContent = 'Перетащите файлы или ссылки сюда';
  const list = div('attachments-list');
  const actions = div('attachments-actions');
  actions.append(button('Добавить вложение', () => openAddDialog(), 'btn small'));
  top.append(drop, list, actions);

  const bottom = div('attachment-viewer-area');
  // Resizes the list only; the drop zone and the button stay fixed. The top
  // area never grows past its natural content (one attachment row minimum).
  root.append(top, rowSplitter(() => list, { min: 48, max: () => list.scrollHeight }), bottom);

  let selectedId: string | null = null;
  /** Row elements of the current list, by attachment id. */
  const rowById = new Map<string, HTMLElement>();

  showViewerHint('Выберите вложение для просмотра.');
  void reload();

  // Pastes from OTHER markdown fields (e.g. the permanent comment on the
  // «Основное» tab) add attachments behind this list's back — reload when the
  // owner matches. The listener self-unregisters once the pane is gone.
  const onExternalChange = (event: Event): void => {
    if (!root.isConnected) {
      document.removeEventListener('etn:attachments-changed', onExternalChange);
      return;
    }
    const detail = (event as CustomEvent<{ ownerType: string; ownerId: string }>).detail;
    if (detail?.ownerType === ctx.ownerType && detail?.ownerId === ctx.ownerId) {
      void reload();
    }
  };
  document.addEventListener('etn:attachments-changed', onExternalChange);

  // --- drag & drop ----------------------------------------------------------
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('dragover');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('dragover');
    void handleDrop(event);
  });

  /** Handles a drop of files and/or URLs. */
  async function handleDrop(event: DragEvent): Promise<void> {
    const dt = event.dataTransfer;
    // uri-list lines may carry "#" comments; keep only real entries.
    const urls = (dt?.getData('text/uri-list') ?? '')
      .split(/[\r\n]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '' && !s.startsWith('#'));
    // Fallback: some sources drop only text/plain (e.g. a bare URL string).
    if (urls.length === 0) {
      const plain = dt?.getData('text/plain')?.trim() ?? '';
      if (plain !== '' && isHttpUrl(plain)) urls.push(plain);
    }
    const files = dt?.files;
    let added = 0;
    for (const url of urls) {
      if (!isHttpUrl(url)) continue;
      try {
        await etn.attachments.add(networkId, ctx.ownerType, ctx.ownerId, { kind: 'url', url });
        added++;
      } catch {
        notice('Не удалось добавить вложение.', 'error');
      }
    }
    if (files !== undefined && files.length > 0) {
      for (const file of Array.from(files)) {
        // Electron exposes the OS path on dropped File objects (Electron ≤31).
        const path = (file as File & { path?: string }).path ?? file.name;
        try {
          await etn.attachments.add(networkId, ctx.ownerType, ctx.ownerId, {
            kind: 'file',
            file_path: path,
            file_size: file.size,
            mime_type: file.type || null,
            title: file.name,
          });
          added++;
        } catch {
          notice('Не удалось добавить вложение.', 'error');
        }
      }
    }
    if (added > 0) {
      invalidateIndicators(ctx.ownerId);
      await reload();
      return;
    }
    // Nothing was recognised — say so instead of failing silently.
    notice(
      'Перетащены нераспознанные данные. Поддерживаются файлы и http(s)-ссылки.',
      'error',
    );
  }

  /** Renders the attachment list. */
  async function reload(): Promise<void> {
    list.replaceChildren(el('span', 'muted', 'Загрузка…'));
    let attachments: Attachment[];
    try {
      attachments = await etn.attachments.list(networkId, ctx.ownerType, ctx.ownerId);
    } catch (err) {
      list.replaceChildren(span(`Ошибка: ${errText(err)}`, 'error-text'));
      return;
    }
    refreshTabCount('attachments');
    list.replaceChildren();
    rowById.clear();
    if (attachments.length === 0) {
      list.append(el('p', 'muted', 'Вложений нет.'));
      return;
    }
    for (const attachment of attachments) {
      const item = buildAttachmentItem(attachment);
      if (attachment.id === selectedId) item.classList.add('selected');
      rowById.set(attachment.id, item);
      list.append(item);
    }
  }

  /** Builds the preview square of one attachment row. */
  function buildThumb(attachment: Attachment): HTMLElement {
    // Server-stored image file → the picture itself over etnimg:.
    if (isImageFile(attachment) && attachment.file_path !== null) {
      return imgThumb(etnimgUrl(attachment.file_path), '🖼');
    }
    if (attachment.kind === 'url') {
      const url = attachment.url ?? '';
      // Image URL → the picture; otherwise the server-fetched favicon.
      if (isImageUrl(url)) return imgThumb(url, '🔗');
      if (attachment.icon !== null) return imgThumb(attachment.icon, '🔗');
      return span('🔗', 'attachment-thumb');
    }
    return span('📄', 'attachment-thumb');
  }

  /** An <img> preview falling back to a glyph when the source fails. */
  function imgThumb(src: string, fallbackGlyph: string): HTMLElement {
    const img = el('img', 'attachment-thumb');
    img.src = src;
    img.alt = '';
    img.addEventListener('error', () => {
      img.replaceWith(span(fallbackGlyph, 'attachment-thumb'));
    });
    return img;
  }

  /** Builds one attachment row (preview + title + meta; menu on right-click). */
  function buildAttachmentItem(attachment: Attachment): HTMLElement {
    const item = div('attachment-item');
    item.append(buildThumb(attachment));
    const info = div('attachment-info');
    info.style.flex = '1';
    info.style.minWidth = '0';
    const title = el(
      'div',
      'att-title',
      attachment.title ?? attachment.url ?? attachment.file_path ?? '—',
    );
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';
    title.style.whiteSpace = 'nowrap';
    info.append(title);
    const meta = el(
      'div',
      'att-meta',
      attachment.kind === 'url'
        ? (attachment.url ?? '')
        : `${attachment.file_path ?? ''}${attachment.file_size !== null ? ` · ${attachment.file_size} Б` : ''}`,
    );
    info.append(meta);
    item.append(info);
    item.addEventListener('click', () => selectAttachment(attachment));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showAttachmentMenu(attachment, event);
    });
    item.addEventListener('dblclick', () => {
      // Double-click opens the default viewer like the menu does (§6.5.1).
      void openDefault(attachment);
    });
    return item;
  }

  /** Selects an attachment and shows it in the viewer area. */
  function selectAttachment(attachment: Attachment): void {
    selectedId = attachment.id;
    for (const row of rowById.values()) row.classList.remove('selected');
    rowById.get(attachment.id)?.classList.add('selected');
    showViewer(attachment);
  }

  /** Opens the attachment in the OS default app / browser (L1). */
  async function openDefault(attachment: Attachment): Promise<void> {
    try {
      if (attachment.kind === 'file' && attachment.file_path !== null) {
        const err = await etn.system.openPath(attachment.file_path);
        if (err !== '') notice(`Не удалось открыть: ${err}`, 'error');
      } else if (attachment.kind === 'url' && attachment.url !== null) {
        await etn.system.openExternal(attachment.url);
      }
    } catch (err) {
      notice(`Не удалось открыть: ${errText(err)}`, 'error');
    }
  }

  /** Shows a muted hint in the viewer area (nothing selected). */
  function showViewerHint(text: string): void {
    bottom.replaceChildren(el('p', 'muted attachment-viewer-hint', text));
  }

  /** Renders the inline viewer for the selected attachment (L7, §6.5). */
  function showViewer(attachment: Attachment): void {
    bottom.replaceChildren(el('span', 'muted', 'Загрузка…'));

    if (isImageFile(attachment) && attachment.file_path !== null) {
      const img = el('img', 'attachment-viewer-img');
      img.src = etnimgUrl(attachment.file_path);
      img.alt = attachment.title ?? 'Вложение';
      const frame = div('attachment-view-frame');
      frame.append(img);
      bottom.replaceChildren(frame);
      return;
    }
    if (attachment.kind === 'url' && isImageUrl(attachment.url ?? '')) {
      const img = el('img', 'attachment-viewer-img');
      img.src = attachment.url ?? '';
      img.alt = attachment.title ?? 'Вложение';
      const frame = div('attachment-view-frame');
      frame.append(img);
      bottom.replaceChildren(frame);
      return;
    }
    if (isViewableText(attachment)) {
      void showTextEditor(attachment);
      return;
    }
    // Everything else: open externally instead of a preview (§6.5).
    const frame = div('attachment-view-frame');
    frame.append(el('p', 'muted', 'Для этого типа вложения предпросмотр недоступен.'));
    frame.append(
      button(
        'Открыть в приложении по умолчанию',
        () => void openDefault(attachment),
        'btn small',
      ),
    );
    bottom.replaceChildren(frame);
  }

  /**
   * Text/markdown viewer-editor: view shows the server-rendered html (markdown)
   * or a `<pre>` block (plain text); double-click switches to editing, blur
   * saves via `PUT …/attachments/{id}/content` and returns to the view.
   * Truncated files stay read-only — saving would lose the tail.
   */
  async function showTextEditor(attachment: Attachment): Promise<void> {
    let content: Awaited<ReturnType<typeof etn.attachments.getContent>>;
    try {
      content = await etn.attachments.getContent(networkId, attachment.id);
      if (content.text === null) throw new Error('не текстовое вложение');
    } catch (err) {
      bottom.replaceChildren(span(`Не удалось прочитать файл: ${errText(err)}`, 'error-text'));
      return;
    }
    // Another attachment may have been picked while the content loaded.
    if (selectedId !== attachment.id) return;

    if (content.truncated) {
      const frame = div('attachment-view-frame');
      frame.append(
        el(
          'p',
          'muted',
          'Файл превышает лимит просмотра — показаны первые 200 000 символов, правка отключена.',
        ),
      );
      frame.append(el('pre', 'attachment-view-text', content.text));
      bottom.replaceChildren(frame);
      return;
    }

    const markdown = isMarkdownFile(attachment);
    // Plain text renders as an escaped <pre> block; markdown uses the
    // server-rendered html from the content response / update result.
    const plainView = (text: string): string =>
      `<pre class="attachment-view-text">${escapeHtml(text)}</pre>`;
    const viewHtml = (text: string, html: string | null): string =>
      markdown ? (html ?? '') : plainView(text);

    const widget = createMarkdownField({
      md: content.text,
      html: viewHtml(content.text, content.html),
      attachmentsOwner: { ownerType: ctx.ownerType, ownerId: ctx.ownerId },
      onSave: async (md) => {
        const result = await etn.attachments.updateContent(networkId, attachment.id, {
          data_base64: utf8ToBase64(md),
        });
        return viewHtml(md, result.html);
      },
    });
    const frame = div('attachment-view-frame');
    frame.append(widget);
    bottom.replaceChildren(frame);
  }

  /**
   * «Назначить иконкой мысли» — image files on a thought owner (L1). The
   * thought icon must be a self-contained `data:image` URL (the server rejects
   * machine-local `etnimg:` paths — other clients cannot resolve them), so the
   * stored file is read back through the etnimg protocol and inlined, subject
   * to the same 256 KiB limit as the icon dialog.
   */
  async function assignAsThoughtIcon(attachment: Attachment): Promise<void> {
    const thought = ctx.thought;
    if (thought === null || attachment.file_path === null) return;
    let dataUrl: string;
    try {
      const res = await fetch(etnimgUrl(attachment.file_path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (blob.size > THOUGHT_ICON_MAX_BYTES) {
        notice(
          `Картинка слишком большая для иконки (${blob.size} Б; лимит ${THOUGHT_ICON_MAX_BYTES} Б).`,
          'error',
        );
        return;
      }
      dataUrl = await blobToDataUrl(blob);
    } catch {
      notice('Не удалось прочитать файл вложения.', 'error');
      return;
    }
    try {
      const updated = await etn.thoughts.update(networkId, thought.id, {
        icon: dataUrl,
        icon_kind: 'image',
      }, thought.version);
      const focus = store.state.focus;
      if (focus !== null && focus.focused.id === updated.id) {
        store.update({ focus: { ...focus, focused: updated } });
      }
      invalidateRef(thought.id);
      notice('Иконка мысли обновлена.');
    } catch (err) {
      notice(`Не удалось назначить иконку: ${errText(err)}`, 'error');
    }
  }

  /** «Перенести в мысль» — moves the attachment to another owner (L1). */
  async function moveToThought(attachment: Attachment): Promise<void> {
    const targetId = await pickThoughtRef(networkId);
    if (targetId === null || targetId === attachment.owner_id) return;
    try {
      await etn.attachments.update(networkId, attachment.id, {
        owner_type: 'thought',
        owner_id: targetId,
      });
      invalidateIndicators(attachment.owner_id);
      invalidateIndicators(targetId);
      if (selectedId === attachment.id) {
        selectedId = null;
        showViewerHint('Выберите вложение для просмотра.');
      }
      await reload();
    } catch (err) {
      notice(`Не удалось перенести: ${errText(err)}`, 'error');
    }
  }

  /** «Удалить» — removes the row (and the server-stored file). */
  async function removeAttachment(attachment: Attachment): Promise<void> {
    const name = attachment.title ?? attachment.url ?? attachment.file_path ?? '—';
    const ok = await confirmDialog(
      'Удалить вложение',
      `Удалить вложение «${name}»?` +
        (attachment.kind === 'file' ? ' Серверная копия файла будет удалена.' : ''),
      true,
    );
    if (!ok) return;
    try {
      await etn.attachments.remove(networkId, attachment.id);
      invalidateIndicators(attachment.owner_id);
      if (selectedId === attachment.id) {
        selectedId = null;
        showViewerHint('Выберите вложение для просмотра.');
      }
      await reload();
    } catch (err) {
      notice(`Не удалось удалить: ${errText(err)}`, 'error');
    }
  }

  /** Builds the attachment context menu at the cursor position (L1, L7). */
  function showAttachmentMenu(attachment: Attachment, event: MouseEvent): void {
    const items: MenuItem[] = [];
    const hasTarget =
      (attachment.kind === 'file' && attachment.file_path !== null) ||
      (attachment.kind === 'url' && attachment.url !== null);
    if (hasTarget) {
      items.push({
        label: 'Открыть в программе по умолчанию',
        onClick: () => void openDefault(attachment),
      });
    }
    if (ctx.ownerType === 'thought' && isImageFile(attachment)) {
      items.push({
        label: 'Назначить иконкой мысли',
        onClick: () => void assignAsThoughtIcon(attachment),
      });
    }
    items.push({
      label: 'Перенести в мысль…',
      onClick: () => void moveToThought(attachment),
    });
    items.push({
      label: 'Удалить…',
      danger: true,
      onClick: () => void removeAttachment(attachment),
    });
    showMenuAt(event.clientX, event.clientY, items);
  }

  /** Opens the add-attachment dialog. */
  function openAddDialog(): void {
    const kindUrl = el('input');
    kindUrl.type = 'radio';
    kindUrl.name = 'att-kind';
    kindUrl.checked = true;
    const kindFile = el('input');
    kindFile.type = 'radio';
    kindFile.name = 'att-kind';

    const locationInput = el('input', 'text-input');
    locationInput.type = 'text';
    locationInput.placeholder = 'https://…';

    const titleInput = el('input', 'text-input');
    titleInput.type = 'text';
    titleInput.maxLength = 300;
    const descInput = el('input', 'text-input');
    descInput.type = 'text';
    descInput.maxLength = 2000;
    const errorLine = span('', 'error-text');

    const syncKind = (): void => {
      locationInput.placeholder = kindFile.checked ? 'Путь к файлу' : 'https://…';
    };
    kindUrl.addEventListener('change', syncKind);
    kindFile.addEventListener('change', syncKind);

    const kindRow = div('form-row');
    const urlLabel = el('label', 'checkbox-row');
    urlLabel.append(kindUrl, span('Ссылка (URL)'));
    const fileLabel = el('label', 'checkbox-row');
    fileLabel.append(kindFile, span('Файл (путь)'));
    kindRow.append(urlLabel, fileLabel);

    const body = div('form-stack');
    body.append(
      field('Тип', kindRow),
      field('Адрес / путь', locationInput),
      field('Заголовок (необязательно)', titleInput),
      field('Комментарий (необязательно)', descInput),
      errorLine,
    );

    showDialog({
      title: 'Добавить вложение',
      body,
      width: 480,
      buttons: [
        { label: 'Отмена' },
        {
          label: 'Добавить',
          primary: true,
          keepOpen: true,
          onClick: (close) => {
            void (async () => {
              const kind = kindFile.checked ? 'file' : 'url';
              const location = locationInput.value.trim();
              if (location === '') {
                errorLine.textContent = 'Укажите адрес или путь.';
                return;
              }
              try {
                await etn.attachments.add(networkId, ctx.ownerType, ctx.ownerId, {
                  kind,
                  url: kind === 'url' ? location : null,
                  file_path: kind === 'file' ? location : null,
                  title: titleInput.value.trim() || null,
                  description: descInput.value.trim() || null,
                });
                invalidateIndicators(ctx.ownerId);
                close();
                await reload();
              } catch (err) {
                errorLine.textContent = errText(err);
              }
            })();
          },
        },
      ],
    });
  }

  return root;
}
