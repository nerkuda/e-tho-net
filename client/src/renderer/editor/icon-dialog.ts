/**
 * Диалог выбора иконки мысли/типа (08-ui-spec.md §6.8) — АДАПТЕР
 * универсального диалога выбора ресурса (задача d1a56d76).
 *
 * Раньше диалог был самостоятельной реализацией; теперь вся общая механика
 * (вкладки-источники, доступность «Применить», «Очистить»/«Отменить»/«Применить»,
 * закрытие) живёт в {@link createResourcePicker}, а здесь остаётся только
 * конфигурация под иконку и мостик к контракту `onPick`.
 *
 * Источники: «Эмодзи» (полный набор Unicode 16.0), «Библиотека» (значки
 * иконочной библиотеки с поиском), «Иконки мыслей» (сетка иконок типов),
 * «Вложения» (общий компонент выбора вложения — задача 0f6c3e39: список
 * картинок сети с поиском, загрузкой из файла и отметкой текущего) и «URL»
 * (адрес с предпросмотром). «Эмодзи»/«Библиотека»/«Иконки мыслей» применяются
 * сразу по клику; «Вложения»/«URL» — нижней «Применить». Порядок вкладок:
 * «Эмодзи» — первая, «Библиотека» — следующая (элемент интерфейса 91367509).
 *
 * При открытии диалог встаёт на вкладку ВИДА текущей иконки и отмечает текущий
 * выбор (ошибки e2407f6d, 846c426a, 844c426a): `emoji`/`icon` → «Эмодзи»/
 * «Библиотека», `image`-файл (вложение мысли `icon_attachment_id` либо
 * самодостаточное `data:`-превью типа) → «Вложения» (текущая картинка показана
 * выбранной, применение без изменений её сохраняет), `image`-URL → «URL».
 * Разворачивается категория эмодзи и выделяется текущий значок; на вкладке
 * «Библиотека» уже выбранный значок делает «Применить» активной — смена только
 * цвета не требует повторного поиска.
 *
 * 0.12.1, цикл приёмки. Над вкладками — строка ПОСЛЕДНИХ иконок (задача
 * 0fc95a2b): ≤10 ячеек 24×24 любых видов, свежие первыми, без дублей; клик
 * применяет иконку и (при успехе) закрывает диалог. История — клиент-локальная
 * (`editor/recent-icons.ts`, ключ по пользователю), записывается только при
 * успешном `onPick`. В футере — «Вставить из буфера» (задача 78eaf07a):
 * доступна, если буфер содержит эмодзи-текст или картинку; эмодзи применяется
 * как обычный выбор, картинка проходит по пути файла (`source`).
 */

import type { Attachment, IconKind } from '@etn/shared';
import { div, errText } from '../lib/dom.js';
import type { DialogButton } from '../lib/dialog.js';
import { etn } from '../lib/etn.js';
import { t } from '../lib/i18n.js';
import { dataUrlBytes, ICON_MAX_BYTES, makeIconPreview } from '../lib/image-preview.js';
import { notice } from '../lib/notice.js';
import { renderLibraryIcon } from '../lib/ui/icon.js';
import { store } from '../state.js';
import { etnimgUrl } from './markdown-field.js';
import {
  createResourcePicker,
  emojiSourceTab,
  libraryIconSourceTab,
  thoughtIconSourceTab,
  urlSourceTab,
  type ResourceFileSource,
  type ResourceSourceContext,
} from './resource-picker.js';
import { attachmentPickerSourceTab, type AttachmentPick } from './attachment-picker.js';
import { emojiFromClipboardText, fileFromImageDataUrl } from './clipboard-icon.js';
import {
  loadRecentIcons,
  recordRecentIcon,
  renderRecentIcons,
  type RecentIconEntry,
} from './recent-icons.js';

/** The original picked file, carried to the caller for the attachment upload. */
export type IconPickSource = ResourceFileSource;

/** Outcome of the dialog: an icon + kind + colour (+ original file), or `null` to clear. */
export interface IconPickResult {
  icon: string | null;
  kind: IconKind;
  /**
   * Цвет символа иконки (HEX `#rrggbb`) или `null` — цвет не задан
   * (0.12.1, задача 4105bd6a). Задаётся только на вкладке «Библиотека»; для
   * остальных видов и «Очистить» сбрасывается в `null`.
   */
  color: string | null;
  /** Present when the icon came from the OS file picker (L16). */
  source?: IconPickSource;
  /**
   * Уже загруженное вложение-иконка, сохраняемое без повторной загрузки
   * (ошибка 846c426a): применение вложения без изменений НЕ сбрасывает
   * `icon_attachment_id` и не требует новой загрузки файла.
   */
  attachmentId?: string | null;
}

/**
 * Обратная совместимая расширенная форма успеха `onPick` (задача 0fc95a2b):
 * для файловых/буферных выборов вложение создаёт ВЫЗЫВАЮЩАЯ сторона, и только
 * она знает его id — возвращает его для записи в историю последних иконок.
 * Прежняя форма `boolean` поддержана (`true`/`false`).
 */
export interface IconPickOutcome {
  ok: boolean;
  /** id созданного вложения (картинка-файл); `null` — вложения нет. */
  attachmentId?: string | null;
}

/** Opens the icon picker. `onPick` should persist the result and return success. */
export function showIconDialog(opts: {
  current: {
    icon: string | null;
    kind: IconKind;
    color: string | null;
    /**
     * id вложения текущей иконки-файла (`icon_attachment_id`); не `null` —
     * иконка загружена из файла (ошибка 846c426a).
     */
    attachmentId?: string | null;
  };
  /**
   * Владелец-объект диалога (0.12.1, тех.проект f9b8917c): выбор в списке
   * «Вложения» картинки, принадлежащей ДРУГОМУ объекту, добавляет ЭТОТ объект
   * владельцем (`POST /attachments/{id}/owners`) и применяет картинку
   * (ошибка c37981b7). Для ТИПОВ мыслей владельца нет — вложение не создаётся,
   * файл ложится самодостаточным `data:`-превью.
   */
  owner?: { type: 'thought'; id: string };
  onPick: (result: IconPickResult) => Promise<boolean | IconPickOutcome>;
}): void {
  const { current, onPick } = opts;

  const attachmentId = current.attachmentId ?? null;
  /**
   * Иконка-ФАЙЛ (не URL): вид `image` из вложения мысли (`icon_attachment_id`)
   * либо самодостаточное `data:`-превью — иконка-картинка ТИПА мысли, у типов
   * вложений нет (ошибки 846c426a, 844c426a).
   */
  const isFileImage =
    current.kind === 'image' &&
    (attachmentId !== null || (current.icon?.startsWith('data:') ?? false));

  /**
   * Вкладка при открытии — по ВИДУ текущей иконки (ошибки e2407f6d, 846c426a,
   * 844c426a): `emoji` → «Эмодзи», `icon` → «Библиотека», `image`-файл (вложение
   * или `data:`-превью) → «Вложения» (текущая картинка показана выбранной),
   * `image`-URL → «URL».
   */
  const activeTab =
    current.kind === 'icon'
      ? 'library'
      : isFileImage
        ? 'attachments'
        : current.kind === 'image'
          ? 'url'
          : 'emoji';
  /** Начальное значение вкладки «URL» — адрес картинки (не `data:`-превью). */
  const initialUrl =
    current.kind === 'image' && !isFileImage && current.icon !== null
      ? current.icon
      : undefined;

  /** Закрытие каркаса — нужно клику по строке последних иконок. */
  let pickerClose: (() => void) | null = null;
  /** Контекст источника для кликов вне вкладок (строка последних иконок). */
  const pickerContext = (): ResourceSourceContext => ({
    close: () => pickerClose?.(),
    setReady: () => undefined,
  });

  /**
   * Гарантирует владение вложением текущим объектом, если он задан (тех.проект
   * f9b8917c): выбор чужой картинки-вложения добавляет объект владельцем
   * (`POST /attachments/{id}/owners`, идемпотентно) — иначе сервер отвергнет
   * `icon_attachment_id`, не принадлежащий объекту (ошибка c37981b7).
   */
  async function ensureAttachmentOwner(attachmentId: string): Promise<boolean> {
    const owner = opts.owner;
    if (owner === undefined) return true;
    const networkId = store.state.networkId;
    if (networkId === null) return false;
    try {
      await etn.attachments.addOwners(networkId, attachmentId, {
        owner_type: owner.type,
        owner_ids: [owner.id],
      });
      return true;
    } catch (err) {
      notice(`${t('attachments.owner.add.failed')}: ${errText(err)}`, 'error');
      return false;
    }
  }

  /**
   * Применяет результат и (при успехе) закрывает диалог. Успех фиксирует иконку
   * в истории последних выбранных (задача 0fc95a2b); id вложения знает
   * вызывающая сторона — оно приходит в расширенной форме {@link IconPickOutcome}.
   * `ensureOwner: false` — путь ПЕРЕИСПОЛЬЗОВАНИЯ собственного вложения
   * (846c426a): владение уже есть, лишний запрос не нужен.
   */
  const submit =
    (result: IconPickResult, options?: { ensureOwner?: boolean }) =>
    async (ctx: ResourceSourceContext): Promise<void> => {
      if (
        options?.ensureOwner !== false &&
        result.attachmentId != null &&
        !(await ensureAttachmentOwner(result.attachmentId))
      ) {
        return;
      }
      const outcome = await onPick(result);
      const ok = typeof outcome === 'boolean' ? outcome : outcome.ok;
      if (!ok) return;
      const resolvedAttachmentId =
        typeof outcome === 'boolean'
          ? (result.attachmentId ?? null)
          : (outcome.attachmentId ?? result.attachmentId ?? null);
      const entry = entryFromResult(result, resolvedAttachmentId);
      if (entry !== null) recordRecentIcon(currentUserId(), entry);
      ctx.close();
    };

  /**
   * Применение выбора общего компонента вложений (задача 0f6c3e39): вложение
   * из списка / загруженный файл / восстановленное текущее — в результат
   * иконки. Файл-вложение читается и ужимается в самодостаточное `data:`-превью
   * ≤256 КиБ (сервер отвергает `etnimg:`-пути), его id становится
   * `icon_attachment_id`; url-вложение даёт иконку-URL.
   */
  async function applyAttachmentPick(
    pick: AttachmentPick,
    ctx: ResourceSourceContext,
  ): Promise<void> {
    if (pick.source !== undefined) {
      await submit({ icon: pick.preview, kind: 'image', color: null, source: pick.source })(ctx);
      return;
    }
    const a = pick.attachment;
    if (a === undefined) {
      await submit({
        icon: pick.preview,
        kind: 'image',
        color: null,
        attachmentId: pick.attachmentId ?? null,
      })(ctx);
      return;
    }
    // Текущее вложение без изменений — сохраняем как есть (ошибка 846c426a):
    // владение уже установлено, повторный POST владельцев не нужен.
    if (a.id === attachmentId && current.icon !== null) {
      await submit({ icon: current.icon, kind: 'image', color: null, attachmentId }, {
        ensureOwner: false,
      })(ctx);
      return;
    }
    if (a.kind === 'url') {
      await submit({ icon: a.url ?? '', kind: 'image', color: null, attachmentId: null })(ctx);
      return;
    }
    const icon = await attachmentIconPreview(a);
    if (icon === null) {
      notice(t('attachments.picker.readError'), 'error');
      return;
    }
    await submit({ icon, kind: 'image', color: null, attachmentId: a.id })(ctx);
  }

  // --- Строка последних иконок (задача 0fc95a2b) ---------------------------
  const recentEntries = loadRecentIcons(currentUserId());
  const aboveTabs =
    recentEntries.length > 0 ? buildRecentRow(recentEntries, submit, pickerContext) : undefined;

  /** Применяет иконку-картинку из буфера по пути файла (`source`). */
  async function applyClipboardImage(dataUrl: string): Promise<void> {
    let preview = dataUrl;
    try {
      if (dataUrlBytes(preview) > ICON_MAX_BYTES) preview = await makeIconPreview(preview);
    } catch {
      return; // нечитаемая картинка — тихо ничего не делаем
    }
    const file = fileFromImageDataUrl(preview, Date.now());
    if (file === null) return;
    await submit({
      icon: preview,
      kind: 'image',
      color: null,
      source: { dataUrl: preview, mime: file.type, name: file.name },
    })(pickerContext());
  }

  // --- «Вставить из буфера» (задача 78eaf07a) ------------------------------
  /** Прочитанное содержимое буфера: эмодзи либо картинка (`null` — непригоден). */
  let clipboardPick: { emoji: string } | { image: string } | null = null;
  let clipboardBtn: HTMLButtonElement | null = null;
  const clipboardButton: DialogButton = {
    label: t('icons.clipboard.paste'),
    keepOpen: true,
    ref: (node) => {
      clipboardBtn = node;
      node.disabled = true;
    },
    onClick: () => {
      const pick = clipboardPick;
      if (pick === null) return;
      if ('emoji' in pick) {
        void submit({ icon: pick.emoji, kind: 'emoji', color: null })(pickerContext());
      } else {
        void applyClipboardImage(pick.image);
      }
    },
  };

  /**
   * Читает буфер один раз при открытии (в буфер не пишем): эмодзи-текст или
   * картинка → кнопка доступна; пусто/сбой → недоступна, без сообщений.
   */
  async function readClipboardPick(): Promise<void> {
    let result: { text: string | null; imagePngDataUrl: string | null };
    try {
      result = await etn.system.readClipboard();
    } catch {
      return;
    }
    if (result.imagePngDataUrl !== null) clipboardPick = { image: result.imagePngDataUrl };
    else {
      const emoji = emojiFromClipboardText(result.text);
      if (emoji === null) return;
      clipboardPick = { emoji };
    }
    if (clipboardBtn !== null) clipboardBtn.disabled = false;
  }

  pickerClose = createResourcePicker({
    title: 'Иконка',
    size: 'm',
    // Открытие на вкладке вида текущей иконки; без выбора — «Эмодзи».
    activeTab,
    ...(aboveTabs !== undefined ? { aboveTabs } : {}),
    footerLeadingButtons: [clipboardButton],
    applyLabel: t('actions.apply'),
    noneLabel: t('actions.reset'),
    noneDanger: true,
    nonePlacement: 'leading',
    onNone: (close) => {
      void onPick({ icon: null, kind: 'emoji', color: null }).then((outcome) => {
        const ok = typeof outcome === 'boolean' ? outcome : outcome.ok;
        if (ok) close();
      });
    },
    tabs: [
      emojiSourceTab(
        (glyph, ctx) => submit({ icon: glyph, kind: 'emoji', color: null })(ctx),
        { initial: current.kind === 'emoji' ? current.icon : null },
      ),
      libraryIconSourceTab({
        initialIcon: current.kind === 'icon' ? current.icon : null,
        initialColor: current.color,
        onPick: (name, color, ctx) => submit({ icon: name, kind: 'icon', color })(ctx),
      }),
      thoughtIconSourceTab({
        types: store.state.thoughtTypes,
        fill: true,
        onPick: (icon, kind, color, ctx) => submit({ icon, kind, color })(ctx),
      }),
      attachmentPickerSourceTab({
        label: t('publication.cover.tab.attachments'),
        // Текущая иконка-картинка (вложение мысли или data:-превью типа)
        // отмечается в списке/предпросмотре при открытии (ошибки 846c426a,
        // 844c426a) — без повторного поиска и загрузки.
        ...(isFileImage
          ? { current: { attachmentId, preview: current.icon ?? '' } }
          : {}),
        onPick: (pick, ctx) => applyAttachmentPick(pick, ctx),
      }),
      urlSourceTab({
        placeholder: 'URL изображения',
        previewHint: 'Предпросмотр',
        ...(initialUrl !== undefined ? { initial: initialUrl } : {}),
        onApply: (url, ctx) => submit({ icon: url, kind: 'image', color: null })(ctx),
      }),
    ],
  });
  void readClipboardPick();
}

// ---------------------------------------------------------------------------
// Последние иконки (задача 0fc95a2b)
// ---------------------------------------------------------------------------

/** id текущего пользователя для ключа истории; до входа — общий `anon`. */
function currentUserId(): string {
  return store.state.me?.id ?? 'anon';
}

/**
 * Запись истории по результату выбора (задача 0fc95a2b). Формы без хранения:
 * `data:`-превью иконки ТИПА (у типов нет вложений) и «Очистить» — `null`.
 * Картинка-вложение хранится по `attachmentId`, картинка-URL — по адресу.
 */
function entryFromResult(
  result: IconPickResult,
  resolvedAttachmentId: string | null,
): RecentIconEntry | null {
  if (result.icon === null) return null;
  if (result.kind === 'emoji') return { kind: 'emoji', icon: result.icon, color: null };
  if (result.kind === 'icon') return { kind: 'icon', icon: result.icon, color: result.color };
  // kind === 'image'
  if (result.source !== undefined) {
    // Файл/буфер: id вложения знает только вызывающая сторона.
    return resolvedAttachmentId !== null
      ? { kind: 'image-attachment', attachmentId: resolvedAttachmentId, color: null }
      : null;
  }
  const attId = resolvedAttachmentId ?? result.attachmentId ?? null;
  if (attId !== null) return { kind: 'image-attachment', attachmentId: attId, color: null };
  if (result.icon.startsWith('data:')) return null; // data:-превью типа — не храним
  return { kind: 'image-url', icon: result.icon, color: null };
}

/** Восстанавливает результат выбора из записи истории (для клика по ячейке). */
function resultFromEntry(entry: RecentIconEntry, preview?: string): IconPickResult | null {
  switch (entry.kind) {
    case 'emoji':
      return { icon: entry.icon, kind: 'emoji', color: null };
    case 'icon':
      return { icon: entry.icon, kind: 'icon', color: entry.color };
    case 'image-url':
      return { icon: entry.icon, kind: 'image', color: null };
    case 'image-attachment':
      if (preview === undefined) return null;
      return { icon: preview, kind: 'image', color: null, attachmentId: entry.attachmentId };
  }
}

/**
 * Строит строку последних иконок «над вкладками» (слот каркаса `aboveTabs`).
 * Виды рисует {@link renderRecentIcons}; превью вложения резолвится лениво.
 */
function buildRecentRow(
  entries: readonly RecentIconEntry[],
  submit: (result: IconPickResult) => (ctx: ResourceSourceContext) => Promise<void>,
  pickerContext: () => ResourceSourceContext,
): HTMLElement {
  const host = div('recent-icons');
  host.title = t('icons.recent.title');
  host.setAttribute('aria-label', t('icons.recent.title'));
  renderRecentIcons(host, entries, {
    renderLibrary: (cell, name, color) => {
      const options: { size: number; color?: string } = { size: 18 };
      if (color !== null) options.color = color;
      void renderLibraryIcon(cell, name, options, '💭');
    },
    resolveAttachment: (id) => resolveRecentAttachmentPreview(id),
    onPick: (entry, preview) => {
      const result = resultFromEntry(entry, preview);
      if (result === null) return;
      void submit(result)(pickerContext());
    },
    labelFor: () => t('icons.recent.apply'),
  });
  return host;
}

/** Лениво резолвит превью вложения истории (по id) в `data:`- или URL-строку. */
async function resolveRecentAttachmentPreview(attachmentId: string): Promise<string | null> {
  const networkId = store.state.networkId;
  if (networkId === null) return null;
  try {
    const a = await etn.attachments.get(networkId, attachmentId);
    if (a.kind === 'url') return a.url ?? null;
    return await attachmentIconPreview(a);
  } catch {
    return null;
  }
}

/**
 * Самодостаточное `data:`-превью иконки из файла-вложения (≤256 КиБ): файл
 * читается через `etnimg`, при превышении лимита ужимается {@link makeIconPreview}
 * (пути `etnimg:` сервер не принимает в `icon`). `null` — файл недоступен.
 */
async function attachmentIconPreview(a: Attachment): Promise<string | null> {
  if (a.file_path === null) return null;
  try {
    const res = await fetch(etnimgUrl(a.file_path));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let dataUrl = await blobToDataUrl(await res.blob());
    if (dataUrlBytes(dataUrl) > ICON_MAX_BYTES) dataUrl = await makeIconPreview(dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

/** Читает Blob в `data:` URL (FileReader — в рендерере нет Buffer). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('read failed')));
    reader.readAsDataURL(blob);
  });
}
