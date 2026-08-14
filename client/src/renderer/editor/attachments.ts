/**
 * Editor group: attachments (H10, 08-ui-spec.md §6.5; 09-scenarios.md D3, L1).
 *
 * - list with previews: server-stored image files render via `etnimg:`,
 *   URL attachments show the server-fetched favicon (`icon`), image URLs show
 *   the picture itself; other files show a glyph;
 * - per-item context menu (08-ui-spec.md §6.5): открыть в программе по
 *   умолчанию / показать (картинки, тексты, markdown) / назначить иконкой
 *   мысли (картинки, только для владельца-мысли) / перенести в мысль /
 *   удалить (сервер удаляет и файл серверного хранения);
 * - «Добавить вложение» dialog: kind (url/file), url/path, title,
 *   description → `attachments.add`;
 * - drag-and-drop of files and URLs onto the drop zone.
 *
 * Applies to both thoughts and links; the canvas 📎 indicator cache is
 * invalidated after every change.
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
import { etnimgUrl } from './markdown-field.js';
import { registerGroupBuilder, type EditorContext } from './editor.js';

/** Registers the attachments group for the editor. */
export function registerAttachmentGroup(): void {
  registerGroupBuilder((ctx) => ({
    id: 'attachments',
    title: 'Вложения',
    defaultCollapsed: true,
    loadCount: () => countAttachments(ctx),
    buildBody: () => buildAttachmentsBody(ctx),
  }));
}

/** Counts attachments for the group badge. */
async function countAttachments(ctx: EditorContext): Promise<string | undefined> {
  const networkId = requireNetworkId();
  try {
    const items = await etn.attachments.list(networkId, ctx.ownerType, ctx.ownerId);
    return `(${items.length})`;
  } catch {
    return undefined;
  }
}

/** True for image files (server-stored or client-local). */
function isImageFile(a: Attachment): boolean {
  return a.kind === 'file' && (a.mime_type ?? '').startsWith('image/');
}

/** True for URL attachments pointing at common image formats. */
function isImageUrl(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?.*)?$/i.test(url);
}

/** True for text/markdown files viewable in the built-in viewer (L1). */
function isViewableText(a: Attachment): boolean {
  if (a.kind !== 'file') return false;
  if ((a.mime_type ?? '').startsWith('text/')) return true;
  return /\.(txt|md|markdown)$/i.test(a.file_path ?? '');
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

/** Builds the attachments group body (drop zone + list). */
function buildAttachmentsBody(ctx: EditorContext): HTMLElement {
  const networkId = requireNetworkId();
  const box = div('attachments-body');

  const drop = div('attachments-drop');
  drop.textContent = 'Перетащите сюда файлы или ссылки, или нажмите «Добавить вложение»';
  box.append(drop);

  const list = div('attachments-list');
  box.append(list);

  const actions = div('form-row');
  actions.style.marginTop = '8px';
  actions.append(button('Добавить вложение', () => openAddDialog(), 'btn small'));
  box.append(actions);

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
    // Nothing was recognised — say so instead of failing silently (otherwise a
    // drop of, say, plain text looks like the zone does not react at all).
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
    list.replaceChildren();
    if (attachments.length === 0) {
      list.append(el('p', 'muted', 'Вложений нет.'));
      return;
    }
    for (const attachment of attachments) {
      list.append(buildAttachmentItem(attachment));
    }
    // Tell the group header to refresh its count badge.
    box.closest('.group')?.dispatchEvent(new CustomEvent('etn:refresh-count'));
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
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showAttachmentMenu(attachment, event);
    });
    item.addEventListener('dblclick', () => {
      // Double-click opens the default viewer (image/text) like the menu does.
      void openDefault(attachment);
    });
    return item;
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

  /** Shows the built-in viewer (images / text / markdown, L1). */
  function showViewer(attachment: Attachment): void {
    const title = attachment.title ?? 'Просмотр вложения';
    if (isImageFile(attachment) && attachment.file_path !== null) {
      showImageViewer(etnimgUrl(attachment.file_path), title);
      return;
    }
    if (attachment.kind === 'url' && isImageUrl(attachment.url ?? '')) {
      showImageViewer(attachment.url ?? '', title);
      return;
    }
    if (isViewableText(attachment)) {
      void showTextViewer(attachment, title);
    }
  }

  /** Image viewer dialog. */
  function showImageViewer(src: string, title: string): void {
    const img = el('img', 'attachment-viewer-img');
    img.src = src;
    img.alt = title;
    const body = div('attachment-viewer');
    body.append(img);
    showDialog({ title, body, width: 720, buttons: [{ label: 'Закрыть', primary: true }] });
  }

  /** Text/markdown viewer dialog (content fetched over etnimg:). */
  async function showTextViewer(attachment: Attachment, title: string): Promise<void> {
    try {
      const res = await fetch(etnimgUrl(attachment.file_path ?? ''));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = (await res.text()).slice(0, 200_000);
      const pre = el('pre', 'attachment-viewer-text', text);
      const body = div('attachment-viewer');
      body.append(pre);
      showDialog({ title, body, width: 720, buttons: [{ label: 'Закрыть', primary: true }] });
    } catch {
      notice('Не удалось прочитать файл.', 'error');
    }
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
      await reload();
    } catch (err) {
      notice(`Не удалось удалить: ${errText(err)}`, 'error');
    }
  }

  /** Builds the attachment context menu at the cursor position (L1). */
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
    const viewable =
      isImageFile(attachment) ||
      isViewableText(attachment) ||
      (attachment.kind === 'url' && isImageUrl(attachment.url ?? ''));
    if (viewable) {
      items.push({ label: 'Показать', onClick: () => showViewer(attachment) });
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

  void reload();
  return box;
}
