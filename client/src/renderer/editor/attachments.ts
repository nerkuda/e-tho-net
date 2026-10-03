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

import type { Attachment, AttachmentOwnerType, Thought, ThoughtUpdateInput } from '@etn/shared';
import { t } from '../lib/i18n.js';

import {
  commitEntity,
  invalidateQueries,
  onQueryInvalidated,
  queryKeys,
  registerQuery,
} from '../lib/live/index.js';
import { closeDialog, confirmDialog, showDialog } from '../lib/dialog.js';
import { div, el, errText, isHttpUrl, span } from '../lib/dom.js';
import { radioRow } from '../lib/ui/choice-row.js';
import { fieldInput, fieldRow } from '../lib/ui/field.js';
import { filePathField } from '../lib/ui/file-path-field.js';
import { errorLine as panelErrorLine, footerErrorLine, operationError } from '../lib/ui/messages.js';
import { etn } from '../lib/etn.js';
import { ICON_MAX_BYTES, dataUrlBytes, makeIconPreview } from '../lib/image-preview.js';
import { menuAction, showMenuAt, type MenuItem } from '../lib/menu.js';
import { notice } from '../lib/notice.js';
import { requireNetworkId } from '../app.js';
import { firstPickedThoughtId, pickThoughtsDialog, pickedThoughtIds } from '../canvas/add-dialog.js';
import { etnimgUrl, createMarkdownField, guessMimeFromName } from './markdown-field.js';
import {
  refreshTabCount,
  reflectThoughtUpdate,
  registerTabContent,
  registerTabCount,
  type EditorContext,
} from './editor.js';
import { rowSplitter } from './splitter.js';
import { uiButton } from '../lib/ui/button.js';

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
      // Записи вложений — в нормализованный кэш слоя: по ним роутер разрешает
      // владельца для событий `attachment.updated/deleted`, несущих только id.
      for (const item of items) commitEntity('attachment', item.id, item);
      registerQuery(queryKeys.attachments(ctx.ownerType, ctx.ownerId), null);
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

/**
 * Иконка, готовую к назначению иконкой мысли, извлекаемую из url-вложения:
 * favicon, который сервер положил в `attachment.icon` как `data:`-URL
 * (best-effort при создании ссылки, см. 03-server-api.md §11). Тот же источник
 * использует drag-and-drop интернет-ссылки в зону карты (canvas/add-dialog.ts).
 * `null` — вложение не url или favicon не извлечён; не-image `data:` отсекаем,
 * чтобы битую строку не отправили в `icon`.
 */
export function urlAttachmentIcon(a: Attachment): string | null {
  if (a.kind !== 'url') return null;
  const icon = a.icon;
  return icon !== null && icon.startsWith('data:') ? icon : null;
}

/**
 * Виден ли пункт «Назначить иконкой мысли» для вложения: либо файл-картинка
 * (иконку читает `assignAsThoughtIcon` из самого файла), либо url-ссылка с
 * извлечённой иконкой. У file-вложений и ссылок без иконки пункта нет.
 */
export function canAssignAsThoughtIcon(a: Attachment): boolean {
  return isImageFile(a) || urlAttachmentIcon(a) !== null;
}

/**
 * Ставит мысли иконку-картинку из готового `data:`-URL и разносит результат по
 * всем видам (карта, карточка, закреплённые/история) через
 * `reflectThoughtUpdate`. Общий путь для favicon url-вложения (источник как у
 * drag-and-drop) и вложения-картинки после подготовки data URL.
 */
export async function assignDataIconToThought(
  networkId: string,
  thought: Thought,
  icon: string,
  iconAttachmentId: string | null,
): Promise<Thought> {
  const patch: ThoughtUpdateInput = { icon, icon_kind: 'image' };
  if (iconAttachmentId !== null) patch.icon_attachment_id = iconAttachmentId;
  const updated = await etn.thoughts.update(networkId, thought.id, patch, thought.version);
  reflectThoughtUpdate(updated);
  return updated;
}

/**
 * Picks one of three Russian noun forms by `n` (mod 10 / mod 100):
 * `['мысль', 'мысли', 'мыслей']` → 1 мысль, 3 мысли, 5 мыслей. Local helper
 * for the «Скопировано в N мыслей…» notice; not exposed.
 */
function pluralRu(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
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

/** Attachment upload limit — mirrors the server's `ATTACHMENT_FILE_MAX_BYTES`. */
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Uploads a local file's content as a server-stored attachment
 * (`POST …/attachments/file`, §11). `kind='file'` through the plain
 * `POST …/attachments` only registers the path — no server copy, no
 * `mime_type`, hence no preview; uploads land in `networks/<nid>/attachments/`
 * next to `data.db` like clipboard pastes do.
 */
async function uploadLocalFile(
  networkId: string,
  ownerType: AttachmentOwnerType,
  ownerId: string,
  filePath: string,
  title: string | null,
  description: string | null,
): Promise<void> {
  let blob: Blob;
  try {
    const res = await fetch(etnimgUrl(filePath));
    if (!res.ok) throw new Error(res.status === 404 ? 'not found' : `HTTP ${res.status}`);
    blob = await res.blob();
  } catch {
    throw new Error(`Файл не найден или недоступен по пути: ${filePath}`);
  }
  if (blob.size > ATTACHMENT_MAX_BYTES) {
    throw new Error(`Файл больше ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} МБ — лимит вложения.`);
  }
  // The etnimg protocol maps only common extensions; fall back to a guess so
  // the server keeps the right file extension when storing the copy.
  const mime =
    blob.type !== '' && blob.type !== 'application/octet-stream'
      ? blob.type
      : (guessMimeFromName(filePath) ?? 'application/octet-stream');
  const dataUrl = await blobToDataUrl(blob);
  const attachment = await etn.attachments.uploadFile(networkId, ownerType, ownerId, {
    title,
    mime_type: mime,
    data_base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
  });
  // The upload endpoint has no description field — patch it separately.
  if (description !== null) {
    await etn.attachments.update(networkId, attachment.id, { description });
  }
}

/** Minimal HTML escaping for wrapping plain text into a view block. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Параметры построения панели вложений для любого вида владельца. */
export interface AttachmentsPaneOptions {
  ownerType: AttachmentOwnerType;
  ownerId: string;
  /** Мысль-владелец (пункт «Назначить иконкой мысли»); у публикации — null. */
  thought?: Thought | null;
  /** Дополнительные пункты контекстного меню (напр. «Сделать обложкой публикации»). */
  extraMenuItems?: (attachment: Attachment) => MenuItem[];
  /** Уведомление о смене числа вложений (бейдж вкладки панели мысли). */
  onCountChange?: () => void;
}

/** Вкладка «Вложения» панели мысли: общая панель над владельцем-мыслью/связью. */
function buildAttachmentsTab(ctx: EditorContext): HTMLElement {
  return buildAttachmentsPane({
    ownerType: ctx.ownerType,
    ownerId: ctx.ownerId,
    thought: ctx.thought,
    onCountChange: () => refreshTabCount('attachments'),
  });
}

/**
 * Строит панель «Вложения» для ЛЮБОГО вида владельца (мысль / связь /
 * публикация, 0.11.1, задача b02ef1cf): общий список, drag&drop, диалог
 * добавления и встроенный просмотрщик. Мысле-специфичные пункты меню
 * («Назначить иконкой мысли») показываются только для владельца-мысли;
 * дополнительные пункты даёт вызывающий (`extraMenuItems`).
 */
export function buildAttachmentsPane(opts: AttachmentsPaneOptions): HTMLElement {
  const ownerType = opts.ownerType;
  const ownerId = opts.ownerId;
  const thought = opts.thought ?? null;
  const extraMenuItems = opts.extraMenuItems;
  const onCountChange = opts.onCountChange;
  const networkId = requireNetworkId();
  const root = div('attachments-tab');
  /**
   * Гаснет ключ списка вложений владельца (кэш-путь слоя, G4): подписчики —
   * эта панель и бейдж вкладки — перечитывают набор. Своего realtime-эха у
   * локальной правки нет, поэтому инвалидация — единственный сигнал.
   */
  const refreshAttachments = (): void => {
    invalidateQueries(queryKeys.attachments(ownerType, ownerId));
  };

  const top = div('attachments-top');
  const drop = div('attachments-drop');
  drop.textContent = 'Перетащите файлы или ссылки сюда';
  const list = div('attachments-list');
  const actions = div('attachments-actions');
  actions.append(uiButton({
    label: 'Добавить вложение',
    role: 'secondary',
    size: 's',
    onClick: () => openAddDialog(),
  }));
  top.append(drop, list, actions);

  const bottom = div('attachment-viewer-area');
  // Resizes the list only; the drop zone and the button stay fixed. The drag
  // is remembered as the list's exact fixed height (ee745368, 4cc6248c) — it
  // never depends on the current row count.
  root.append(
    top,
    rowSplitter(() => list, { min: 48, persistKey: 'attachments' }),
    bottom,
  );

  let selectedId: string | null = null;
  /** Row elements of the current list, by attachment id. */
  const rowById = new Map<string, HTMLElement>();

  showViewerHint('Выберите вложение для просмотра.');
  void reload();

  // Набор вложений владельца живёт под ключом слоя `attachments:@owner`:
  // роутер гасит его на чужие события `attachment.*`, производители (вставка в
  // markdown, правки на вкладке) — через `invalidateQueries`. Оба источника
  // сходятся сюда: пока вкладка подключена — перечитываем список на месте,
  // отключённую (скрытую) отпускает редактор (`editor.ts`).
  registerQuery(queryKeys.attachments(ownerType, ownerId), null);
  const layerUnsub = onQueryInvalidated((prefix) => {
    if (!root.isConnected) {
      layerUnsub();
      return;
    }
    if (prefix === queryKeys.attachmentsAll() || prefix === queryKeys.attachments(ownerType, ownerId)) {
      void reload();
    }
  });

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
        await etn.attachments.add(networkId, ownerType, ownerId, { kind: 'url', url });
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
          await etn.attachments.add(networkId, ownerType, ownerId, {
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
      invalidateQueries(queryKeys.indicators(ownerId));
      refreshAttachments();
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
      attachments = await etn.attachments.list(networkId, ownerType, ownerId);
    } catch (err) {
      list.replaceChildren(operationError(err));
      return;
    }
    // Записи вложений — в нормализованный кэш слоя: по ним роутер разрешает
    // владельца событий `attachment.updated/deleted`, несущих только id.
    for (const attachment of attachments) commitEntity('attachment', attachment.id, attachment);
    onCountChange?.();
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

  /**
   * Opens the attachment in the OS default app / browser (L1). File
   * attachments go through `system.openAttachmentFile`: when the path is
   * missing locally (a remote server stored its own copy), the main process
   * downloads it to a temp file and opens that copy.
   */
  async function openDefault(attachment: Attachment): Promise<void> {
    try {
      if (attachment.kind === 'file' && attachment.file_path !== null) {
        const err = await etn.system.openAttachmentFile(attachment.file_path);
        if (err !== '') notice(`Не удалось открыть: ${err}`, 'error');
      } else if (attachment.kind === 'url' && attachment.url !== null) {
        const err = await etn.system.openExternal(attachment.url);
        if (err !== '') notice(`Не удалось открыть: ${err}`, 'error');
      }
    } catch (err) {
      notice(`Не удалось открыть: ${errText(err)}`, 'error');
    }
  }

  /**
   * The «open externally» button shown in the viewer — every URL attachment
   * gets one (image URLs included, on top of the inline preview), so opening
   * does not depend on the double-click/context menu being discovered.
   */
  function buildOpenDefaultButton(attachment: Attachment): HTMLElement {
    return uiButton({
      label: 'Открыть в приложении по умолчанию',
      role: 'secondary',
      size: 's',
      onClick: () => void openDefault(attachment),
    });
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
      frame.append(img, buildOpenDefaultButton(attachment));
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
    frame.append(buildOpenDefaultButton(attachment));
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
      bottom.replaceChildren(operationError(err, 'Не удалось прочитать файл'));
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
      attachmentsOwner: { ownerType: ownerType, ownerId: ownerId },
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
   * «Назначить иконкой мысли» — доступно для файла-картинки и для url-ссылки с
   * извлечённой иконкой (L1, L16). У url-вложения favicon уже лежит
   * `data:`-URL в `attachment.icon` — кладём его как есть, тем же способом, что
   * drag-and-drop интернет-ссылки в зону карты. Для файла-картинки иконка должна
   * быть самодостаточным `data:image`-URL ≤256 KiB (сервер отклоняет
   * machine-local `etnimg:`-пути — другие клиенты их не разрешат), поэтому файл
   * читается обратно через etnimg-протокол и инлайнится; файлы сверх лимита
   * становятся уменьшенным превью вместо отказа. `icon_attachment_id` связывает
   * иконку с вложением — Ctrl-hover показывает полную картинку.
   */
  async function assignAsThoughtIcon(attachment: Attachment): Promise<void> {
    if (thought === null) return;

    // url-вложение с favicon: источник готов, ссылку на вложение не ставим —
    // у неё нет файла для Ctrl-hover (как и у drag-and-drop).
    const urlIcon = urlAttachmentIcon(attachment);
    if (urlIcon !== null) {
      try {
        await assignDataIconToThought(networkId, thought, urlIcon, null);
        notice('Иконка мысли обновлена.');
      } catch (err) {
        notice(`Не удалось назначить иконку: ${errText(err)}`, 'error');
      }
      return;
    }

    if (attachment.file_path === null) return;
    let dataUrl: string;
    try {
      const res = await fetch(etnimgUrl(attachment.file_path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      dataUrl = await blobToDataUrl(blob);
    } catch {
      notice('Не удалось прочитать файл вложения.', 'error');
      return;
    }
    if (dataUrlBytes(dataUrl) > ICON_MAX_BYTES) {
      try {
        dataUrl = await makeIconPreview(dataUrl);
      } catch {
        notice('Не удалось подготовить превью иконки.', 'error');
        return;
      }
    }
    try {
      await assignDataIconToThought(networkId, thought, dataUrl, attachment.id);
      notice('Иконка мысли обновлена.');
    } catch (err) {
      notice(`Не удалось назначить иконку: ${errText(err)}`, 'error');
    }
  }

  /** «Перенести в мысль» — moves the attachment to another owner (L1). */
  async function moveToThought(attachment: Attachment): Promise<void> {
    const result = await pickThoughtsDialog({ networkId, allowCreate: false, allowLinkType: false });
    const targetId = firstPickedThoughtId(result);
    if (targetId === null || targetId === attachment.owner_id) return;
    try {
      await etn.attachments.update(networkId, attachment.id, {
        owner_type: 'thought',
        owner_id: targetId,
      });
      invalidateQueries(queryKeys.indicators(attachment.owner_id));
      invalidateQueries(queryKeys.indicators(targetId));
      if (selectedId === attachment.id) {
        selectedId = null;
        showViewerHint('Выберите вложение для просмотра.');
      }
      // Вложение ушло из показанного владельца и прибыло к целевому: гасим оба
      // списка — подписчики перечитают набор.
      refreshAttachments();
      invalidateQueries(queryKeys.attachments('thought', targetId));
    } catch (err) {
      notice(`Не удалось перенести: ${errText(err)}`, 'error');
    }
  }

  /**
   * «Скопировать в мысли…» — multi-pick destination thoughts (workplan L25).
   * The server creates one new attachment row per target, all sharing the
   * source's `url`/`file_path` (no file duplication). Duplicates in targets
   * that already own the same `kind+url/file_path` are skipped silently.
   */
  async function copyToThoughts(attachment: Attachment): Promise<void> {
    const result = await pickThoughtsDialog({
      networkId,
      allowCreate: false,
      allowLinkType: false,
    });
    const targetIds = pickedThoughtIds(result).filter((id) => id !== attachment.owner_id);
    if (targetIds.length === 0) return;
    try {
      const copyResult = await etn.attachments.copy(networkId, attachment.id, {
        target_owner_type: 'thought',
        target_owner_ids: targetIds,
      });
      for (const created of copyResult.created) {
        invalidateQueries(queryKeys.indicators(created.owner_id));
      }
      const created = copyResult.created.length;
      const skipped = copyResult.skipped.length;
      const parts: string[] = [];
      if (created > 0) parts.push(`Скопировано в ${created} ${pluralRu(created, ['мысль', 'мысли', 'мыслей'])}`);
      if (skipped > 0) parts.push(`уже было в ${skipped}`);
      notice(parts.join(', ') + '.');
    } catch (err) {
      notice(`Не удалось скопировать: ${errText(err)}`, 'error');
    }
  }

  /** «Удалить» — removes the row (and the server-stored file). */
  async function removeAttachment(attachment: Attachment): Promise<void> {
    const name = attachment.title ?? attachment.url ?? attachment.file_path ?? '—';
    const ok = await confirmDialog(
      'Удалить вложение',
      `Удалить вложение «${name}»?` +
        (attachment.kind === 'file'
          ? ' Серверская копия файла будет удалена, если файл не используется другими вложениями или иконками мыслей.'
          : ''),
      true,
    );
    if (!ok) return;
    try {
      await etn.attachments.remove(networkId, attachment.id);
      invalidateQueries(queryKeys.indicators(attachment.owner_id));
      if (selectedId === attachment.id) {
        selectedId = null;
        showViewerHint('Выберите вложение для просмотра.');
      }
      refreshAttachments();
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
      items.push(
        menuAction(t('attachments.menu.openDefault'), () => void openDefault(attachment)),
      );
    }
    // Дополнительные пункты владельца (напр. «Сделать обложкой публикации»):
    // их состав задаёт вызывающий, общий список команд здесь не расширяется.
    if (extraMenuItems !== undefined) {
      items.push(...extraMenuItems(attachment));
    }
    if (ownerType === 'thought' && canAssignAsThoughtIcon(attachment)) {
      items.push(
        menuAction(t('attachments.menu.assignIcon'), () => void assignAsThoughtIcon(attachment)),
      );
    }
    items.push(
      menuAction(t('attachments.menu.move'), () => void moveToThought(attachment)),
      menuAction(t('attachments.menu.copy'), () => void copyToThoughts(attachment)),
      menuAction(t('attachments.menu.delete'), () => void removeAttachment(attachment), {
        danger: true,
      }),
    );
    showMenuAt(event.clientX, event.clientY, items);
  }

  /** Opens the add-attachment dialog. */
  function openAddDialog(): void {
    // --- tab switcher --------------------------------------------------------
    // «Создать новое» — the classic form (URL/path + title + description).
    // «Найти существующее» — network-wide search by title/description/url/file_path,
    // reuses an existing attachment instead of uploading a fresh copy (L25).
    const tabCreateOpt = radioRow({ label: 'Создать новое', name: 'att-tab', checked: true });
    const tabSearchOpt = radioRow({ label: 'Найти существующее', name: 'att-tab' });
    const tabCreate = tabCreateOpt.input;
    const tabSearch = tabSearchOpt.input;

    // --- create panel (the classic form) ------------------------------------
    const kindUrlOpt = radioRow({ label: 'Ссылка (URL)', name: 'att-kind', checked: true });
    const kindFileOpt = radioRow({ label: 'Файл (путь)', name: 'att-kind' });
    const kindUrl = kindUrlOpt.input;
    const kindFile = kindFileOpt.input;

    const titleInput = fieldInput({ maxLength: 300 });
    const descInput = fieldInput({ maxLength: 2000 });
    const errorLine = footerErrorLine();

    // «Открыть с диска…» fills the path via the OS picker; the file reaches
    // the server only when «Добавить» is pressed (§6.5).
    const location = filePathField({
      placeholder: 'https://…',
      onPick: async () => {
        try {
          const picked = await etn.system.pickFile();
          if (picked.status !== 'ok') return null;
          if (titleInput.value.trim() === '') titleInput.value = picked.name;
          return picked.path;
        } catch (err) {
          errorLine.show(errText(err));
          return null;
        }
      },
    });
    const locationInput = location.input;
    const pickBtn = location.button;
    const locationRow = location.root;

    const syncKind = (): void => {
      locationInput.placeholder = kindFile.checked ? 'Путь к файлу' : 'https://…';
      pickBtn.style.display = kindFile.checked ? '' : 'none';
    };
    kindUrl.addEventListener('change', syncKind);
    kindFile.addEventListener('change', syncKind);
    syncKind();

    const kindRow = div('form-row');
    kindRow.append(kindUrlOpt.row, kindFileOpt.row);

    const createPanel = div('att-tab-panel');
    createPanel.append(
      fieldRow({ label: 'Тип', control: kindRow }),
      fieldRow({ label: 'Адрес / путь', control: locationRow }),
      fieldRow({ label: 'Заголовок (необязательно)', control: titleInput }),
      fieldRow({ label: 'Комментарий (необязательно)', control: descInput }),
    );
    // errorLine уходит в панель кнопок диалога (`footerError`, ошибка
    // add8d09d): сообщение о неудачном добавлении должно быть видно и на
    // вкладке «Найти существующее», а не только в теле «Создать новое».

    // --- search panel --------------------------------------------------------
    const searchInput = fieldInput({ placeholder: 'Название, файл, URL, комментарий…' });
    const searchResults = div('att-search-results');
    const searchHint = el('p', 'muted att-search-hint', 'Введите запрос для поиска по сети.');
    searchResults.append(searchHint);
    const searchError = panelErrorLine();

    const searchPanel = div('att-tab-panel hidden');
    searchPanel.append(
      fieldRow({ label: 'Поиск', control: searchInput }),
      searchResults,
      searchError,
    );

    // Debounced search: 250 ms after the last keystroke. We remember the latest
    // request id so out-of-order replies don't overwrite newer results.
    let searchSeq = 0;
    let searchDebounce: ReturnType<typeof setTimeout> | null = null;
    function scheduleSearch(): void {
      if (searchDebounce !== null) clearTimeout(searchDebounce);
      const seq = ++searchSeq;
      const q = searchInput.value.trim();
      searchResults.replaceChildren(el('p', 'muted', 'Поиск…'));
      if (q === '') {
        searchResults.replaceChildren(el('p', 'muted', 'Введите запрос.'));
        return;
      }
      searchDebounce = setTimeout(() => {
        void runSearch(seq, q);
      }, 250);
    }
    async function runSearch(seq: number, q: string): Promise<void> {
      try {
        const hits = await etn.attachments.search(networkId, {
          q,
          exclude_owner_type: ownerType,
          exclude_owner_id: ownerId,
        });
        if (seq !== searchSeq) return;
        renderSearchResults(hits);
      } catch (err) {
        if (seq !== searchSeq) return;
        searchError.textContent = errText(err);
        searchResults.replaceChildren();
      }
    }
    function renderSearchResults(hits: Attachment[]): void {
      searchError.textContent = '';
      searchResults.replaceChildren();
      if (hits.length === 0) {
        searchResults.append(el('p', 'muted', 'Ничего не найдено.'));
        return;
      }
      for (const attachment of hits) {
        const item = buildAttachmentItem(attachment);
        item.classList.add('att-search-result');
        item.addEventListener('click', () => void reuseAttachment(attachment));
        searchResults.append(item);
      }
    }
    /**
     * Reuses the chosen attachment: creates a new row for the current owner
     * with the same visible fields. The server does not duplicate the file —
     * a second row simply references the same `url`/`file_path`.
     */
    async function reuseAttachment(attachment: Attachment): Promise<void> {
      try {
        await etn.attachments.add(networkId, ownerType, ownerId, {
          kind: attachment.kind,
          url: attachment.kind === 'url' ? attachment.url : null,
          file_path: attachment.kind === 'file' ? attachment.file_path : null,
          file_size: attachment.file_size,
          mime_type: attachment.mime_type,
          title: attachment.title,
          description: attachment.description,
        });
        invalidateQueries(queryKeys.indicators(ownerId));
        closeDialog();
        refreshAttachments();
      } catch (err) {
        searchError.textContent = errText(err);
      }
    }
    searchInput.addEventListener('input', scheduleSearch);

    // --- tabs ---------------------------------------------------------------
    const tabRow = div('form-row');
    tabRow.append(tabCreateOpt.row, tabSearchOpt.row);

    const applyTabs = (): void => {
      if (tabCreate.checked) {
        createPanel.classList.remove('hidden');
        searchPanel.classList.add('hidden');
      } else {
        createPanel.classList.add('hidden');
        searchPanel.classList.remove('hidden');
        searchInput.focus();
      }
    };
    tabCreate.addEventListener('change', applyTabs);
    tabSearch.addEventListener('change', applyTabs);

    const body = div('form-stack');
    body.append(fieldRow({ label: 'Режим', control: tabRow }), createPanel, searchPanel);

    /** Создание вложения и закрытие — общий путь кнопки и подтверждения (b58f6aad). */
    async function addNew(close: () => void): Promise<void> {
      // The «Добавить» button only applies to the «Создать новое» tab —
      // the search tab commits immediately on row click.
      if (!tabCreate.checked) return;
      const kind = kindFile.checked ? 'file' : 'url';
      const location = locationInput.value.trim();
      if (location === '') {
        errorLine.show('Укажите адрес или путь.');
        return;
      }
      try {
        if (kind === 'file') {
          // Upload the content so the server keeps a copy (preview,
          // other clients) — a bare file_path would only register it.
          const name = location.split(/[\\/]/).pop() ?? location;
          await uploadLocalFile(
            networkId,
            ownerType,
            ownerId,
            location,
            titleInput.value.trim() || name,
            descInput.value.trim() || null,
          );
        } else {
          await etn.attachments.add(networkId, ownerType, ownerId, {
            kind,
            url: location,
            title: titleInput.value.trim() || null,
            description: descInput.value.trim() || null,
          });
        }
        invalidateQueries(queryKeys.indicators(ownerId));
        close();
        refreshAttachments();
      } catch (err) {
        errorLine.show(errText(err));
      }
    }

    showDialog({
      title: 'Добавить вложение',
      body,
      size: 'm',
      // Ошибка добавления — в панели кнопок, видимой на обеих вкладках
      // (ошибка add8d09d); на вкладке «Найти существующее» своя строка
      // `searchError` для ошибок поиска (локальная операция вкладки).
      footerError: errorLine,
      // Грязная форма (требование b58f6aad): Esc/крестик при заполненной форме
      // создания вложения требуют подтверждения; «Сохранить» идёт тем же путём,
      // что «Добавить». Вкладка поиска — выбор строки, не форма.
      dirty: {
        isDirty: () =>
          tabCreate.checked &&
          (locationInput.value.trim() !== '' ||
            titleInput.value.trim() !== '' ||
            descInput.value.trim() !== ''),
        save: (close) => void addNew(close),
      },
      buttons: [
        { label: t('actions.cancel') },
        {
          label: 'Добавить',
          primary: true,
          keepOpen: true,
          onClick: (close) => void addNew(close),
        },
      ],
    });
  }

  return root;
}
