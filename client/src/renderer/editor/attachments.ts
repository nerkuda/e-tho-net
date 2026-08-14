/**
 * Editor group: attachments (H10, 08-ui-spec.md §6.5; 09-scenarios.md D3).
 *
 * - list with image thumbnails (URL attachments) / icons for files, title,
 *   kind and location metadata, per-item delete;
 * - «Добавить вложение» dialog: kind (url/file), url/path, title,
 *   description → `attachments.add`;
 * - drag-and-drop of files and URLs onto the drop zone (multiple files and
 *   URLs are accepted and added one by one).
 *
 * Applies to both thoughts and links; the canvas 📎 indicator cache is
 * invalidated after every change.
 */

import type { Attachment } from '@etn/shared';

import { invalidateIndicators } from '../canvas/canvas.js';
import { field, showDialog } from '../lib/dialog.js';
import { button, div, el, errText, isHttpUrl, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { requireNetworkId } from '../app.js';
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
    const urls = (event.dataTransfer?.getData('text/uri-list') ?? '')
      .split(/[\r\n]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const files = event.dataTransfer?.files;
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
    if (files !== undefined) {
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
    }
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

  /** Builds one attachment row (thumbnail/icon + title + meta + delete). */
  function buildAttachmentItem(attachment: Attachment): HTMLElement {
    const item = div('attachment-item');
    if (attachment.kind === 'url' && isImageUrl(attachment.url ?? '')) {
      const img = el('img', 'attachment-thumb');
      img.src = attachment.url ?? '';
      img.alt = '';
      img.addEventListener('error', () => {
        img.replaceWith(span('🔗', 'attachment-thumb'));
      });
      item.append(img);
    } else {
      item.append(span(attachment.kind === 'url' ? '🔗' : '📄', 'attachment-thumb'));
    }
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
    item.append(
      button(
        '✕',
        () => {
          void (async () => {
            try {
              await etn.attachments.remove(networkId, attachment.id);
              invalidateIndicators(ctx.ownerId);
              await reload();
            } catch (err) {
              notice(`Не удалось удалить: ${errText(err)}`, 'error');
            }
          })();
        },
        'btn small',
        'Удалить вложение',
      ),
    );
    return item;
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

/** True for URLs pointing at common image formats (thumbnail preview). */
function isImageUrl(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?.*)?$/i.test(url);
}
