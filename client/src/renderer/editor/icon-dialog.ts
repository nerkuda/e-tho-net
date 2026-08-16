/**
 * Icon picker dialog (08-ui-spec.md §6.8).
 *
 * Tabs:
 *  - «Эмодзи» — the FULL emoji set (Unicode 16.0, generated `emoji-data.ts`)
 *    grouped by CLDR categories; groups are collapsible; a click on a glyph
 *    applies it immediately.
 *  - «Файл» — a grid of the icons used by thought types (quick picks) and the
 *    system file picker with a live preview; no text input. The bottom
 *    «Применить» runs the L16 flow: the original file is carried to the caller
 *    (uploaded as an attachment for thought owners) and the icon itself is a
 *    ≤256 KiB preview.
 *  - «URL» — a typed URL with a live preview; «Применить» stores the URL.
 *
 * Bottom buttons: «Очистить» (clears the entity's own icon so the type default
 * shows through), «Отменить» (close without changes) and «Применить» (enabled
 * only when the active tab has a valid selection — a picked file or a loaded
 * URL).
 */

import type { IconKind, ThoughtType } from '@etn/shared';

import { showDialog } from '../lib/dialog.js';
import { button, div, el } from '../lib/dom.js';
import { EMOJI_GROUPS } from '../lib/emoji-data.js';
import { etn } from '../lib/etn.js';
import { dataUrlBytes, ICON_MAX_BYTES, makeIconPreview } from '../lib/image-preview.js';
import { notice } from '../lib/notice.js';
import { store } from '../state.js';

/** The original picked file, carried to the caller for the attachment upload. */
export interface IconPickSource {
  dataUrl: string;
  mime: string;
  name: string;
}

/** Outcome of the dialog: an icon + kind (+ original file), or `null` to clear. */
export interface IconPickResult {
  icon: string | null;
  kind: IconKind;
  /** Present when the icon came from the OS file picker (L16). */
  source?: IconPickSource;
}

type Tab = 'emoji' | 'file' | 'url';

/** Opens the icon picker. `onPick` should persist the result and return success. */
export function showIconDialog(opts: {
  current: { icon: string | null; kind: IconKind };
  onPick: (result: IconPickResult) => Promise<boolean>;
}): void {
  const { current, onPick } = opts;
  let tab: Tab = current.kind === 'image' ? 'url' : 'emoji';

  const body = div('icon-dialog');

  // Tab switcher.
  const tabsBar = div('icon-tabs');
  const mkTab = (id: Tab, label: string): HTMLButtonElement =>
    button(label, () => switchTab(id), 'icon-tab');
  const emojiTab = mkTab('emoji', 'Эмодзи');
  const fileTab = mkTab('file', 'Файл');
  const urlTab = mkTab('url', 'URL');
  tabsBar.append(emojiTab, fileTab, urlTab);
  body.append(tabsBar);

  const content = div('icon-content');
  body.append(content);

  // Per-tab selection state (survives tab switches, reset per dialog open).
  let urlValue = ''; // text typed on the URL tab
  let urlValid: string | null = null; // a URL that loaded successfully
  let urlInputEl: HTMLInputElement | null = null;
  let urlPreviewEl: HTMLDivElement | null = null;
  let fileDataUrl: string | null = null; // a picked file that loaded
  let fileSource: IconPickSource | null = null;
  let filePreviewEl: HTMLDivElement | null = null;
  let applyBtn: HTMLButtonElement | null = null;

  /** Enables the bottom «Применить» only when the active tab has a selection. */
  function refreshApply(): void {
    if (applyBtn === null) return;
    const enabled =
      tab === 'file' ? fileDataUrl !== null : tab === 'url' ? urlValid !== null : false;
    if (enabled) applyBtn.removeAttribute('disabled');
    else applyBtn.setAttribute('disabled', 'disabled');
  }

  // --- emoji tab ------------------------------------------------------------

  /** Builds the collapsible emoji groups (full set, lazy cell rendering). */
  function buildEmojiGrid(close: () => void): HTMLElement {
    const root = div('emoji-groups');
    EMOJI_GROUPS.forEach((group, index) => {
      const details = el('details', 'emoji-group');
      if (index === 0) details.open = true;
      const summary = el('summary', 'emoji-group-title', `${group.name} · ${group.items.length}`);
      const grid = div('emoji-grid');
      details.append(summary, grid);
      const populate = (): void => {
        if (grid.childElementCount > 0) return;
        for (const glyph of group.items) {
          grid.append(
            button(glyph, () => {
              void onPick({ icon: glyph, kind: 'emoji' }).then((ok) => {
                if (ok) close();
              });
            }, 'emoji-cell'),
          );
        }
      };
      if (details.open) populate();
      // Build cells on first expand — 1900+ glyphs would be wasteful upfront.
      details.addEventListener('toggle', () => {
        if (details.open) populate();
      });
      root.append(details);
    });
    return root;
  }

  // --- file tab -------------------------------------------------------------

  /** Applies a thought type's icon immediately (same UX as the emoji grid). */
  function applyTypeIcon(type: ThoughtType): void {
    void onPick({ icon: type.icon, kind: type.icon_kind }).then((ok) => {
      if (ok) close();
    });
  }

  /** Grid of the icons used by thought types (quick picks on the File tab). */
  function buildTypeIconsGrid(): HTMLElement {
    const grid = div('icon-type-grid');
    const types = store.state.thoughtTypes.filter((t) => t.icon !== null && t.icon !== '');
    if (types.length === 0) {
      grid.append(el('p', 'muted', 'Типы мыслей с иконками не заданы.'));
      return grid;
    }
    for (const type of types) {
      const cell = button('', () => applyTypeIcon(type), 'icon-type-cell');
      cell.title = `Иконка типа «${type.name}»`;
      if (type.icon_kind === 'image' && type.icon !== null) {
        const img = el('img');
        img.src = type.icon;
        img.alt = '';
        cell.append(img);
      } else {
        cell.textContent = type.icon ?? '💭';
      }
      grid.append(cell);
    }
    return grid;
  }

  /** Renders the picked file in the preview square (or an error marker). */
  function showFilePreview(dataUrl: string): void {
    if (filePreviewEl === null) return;
    filePreviewEl.replaceChildren();
    filePreviewEl.classList.remove('icon-preview-error');
    const img = el('img');
    img.alt = '';
    img.addEventListener('load', () => {
      fileDataUrl = dataUrl;
      refreshApply();
    });
    img.addEventListener('error', () => {
      fileDataUrl = null;
      refreshApply();
      filePreviewEl?.replaceChildren(el('span', 'icon-preview-bad', '✕'));
      filePreviewEl?.classList.add('icon-preview-error');
    });
    img.src = dataUrl;
    filePreviewEl.append(img);
  }

  /** Picks a file via the OS dialog and shows its preview (L16). */
  async function pickFile(): Promise<void> {
    const picked = await etn.system.pickImage();
    if (picked.status === 'cancel') return;
    fileDataUrl = null;
    fileSource = null;
    refreshApply();
    if (picked.status === 'error') {
      if (filePreviewEl !== null) {
        filePreviewEl.replaceChildren(el('span', 'icon-preview-bad', '✕'));
        filePreviewEl.classList.add('icon-preview-error');
      }
      notice(picked.message, 'error');
      return;
    }
    fileSource = { dataUrl: picked.dataUrl, mime: picked.mime, name: picked.name };
    showFilePreview(picked.dataUrl);
  }

  /** Builds the File tab: type-icon grid + «Выбрать файл…» + preview. */
  function buildFileTab(): HTMLElement {
    const box = div('icon-source');
    box.append(el('div', 'icon-section-title', 'Иконки типов мыслей'), buildTypeIconsGrid());
    const pickRow = div('icon-pick-row');
    pickRow.append(button('Выбрать файл…', () => void pickFile(), 'btn small'));
    box.append(pickRow);
    filePreviewEl = div('icon-preview');
    box.append(filePreviewEl);
    if (fileDataUrl !== null) showFilePreview(fileDataUrl);
    else filePreviewEl.append(el('span', 'muted', 'Файл не выбран'));
    return box;
  }

  // --- url tab --------------------------------------------------------------

  /** Shows a loaded URL in the preview square. */
  function showUrlPreview(url: string): void {
    if (urlPreviewEl === null) return;
    urlPreviewEl.replaceChildren();
    urlPreviewEl.classList.remove('icon-preview-error');
    const img = el('img');
    img.alt = '';
    img.addEventListener('error', () => {
      urlPreviewEl?.replaceChildren(el('span', 'icon-preview-bad', '✕'));
      urlPreviewEl?.classList.add('icon-preview-error');
    });
    img.src = url;
    urlPreviewEl.append(img);
  }

  /** Validates typed URL text as a loadable image; updates preview + Apply. */
  function validateUrl(value: string): void {
    urlValid = null;
    refreshApply();
    if (urlPreviewEl === null) return;
    urlPreviewEl.replaceChildren();
    urlPreviewEl.classList.remove('icon-preview-error');
    const v = value.trim();
    if (v === '') {
      urlPreviewEl.append(el('span', 'muted', 'Предпросмотр'));
      return;
    }
    const img = el('img');
    img.alt = '';
    img.addEventListener('load', () => {
      if (urlInputEl !== null && urlInputEl.value.trim() === v) {
        urlValid = v;
        refreshApply();
      }
    });
    img.addEventListener('error', () => {
      if (urlInputEl !== null && urlInputEl.value.trim() === v) {
        urlPreviewEl?.replaceChildren(el('span', 'icon-preview-bad', '✕'));
        urlPreviewEl?.classList.add('icon-preview-error');
      }
    });
    img.src = v;
    urlPreviewEl.append(img);
  }

  /** Builds the URL tab: typed URL + live preview (no per-tab OK). */
  function buildUrlTab(): HTMLElement {
    const box = div('icon-source');
    const row = div('icon-source-row');
    urlInputEl = el('input', 'text-input') as HTMLInputElement;
    urlInputEl.type = 'text';
    urlInputEl.value = urlValue;
    urlInputEl.placeholder = 'URL изображения';
    urlInputEl.addEventListener('input', () => {
      urlValue = urlInputEl?.value ?? '';
      validateUrl(urlValue);
    });
    row.append(urlInputEl);
    box.append(row);

    urlPreviewEl = div('icon-preview');
    box.append(urlPreviewEl);
    if (urlValid !== null) showUrlPreview(urlValid);
    else urlPreviewEl.append(el('span', 'muted', 'Предпросмотр'));
    return box;
  }

  // --- apply ----------------------------------------------------------------

  /** Applies the active tab's selection (file or URL) — the bottom button. */
  async function applySelection(close: () => void): Promise<void> {
    if (tab === 'file') {
      if (fileDataUrl === null || fileSource === null) return;
      let icon = fileDataUrl;
      if (dataUrlBytes(icon) > ICON_MAX_BYTES) {
        try {
          icon = await makeIconPreview(icon);
        } catch {
          notice('Не удалось подготовить превью иконки.', 'error');
          return;
        }
      }
      const ok = await onPick({ icon, kind: 'image', source: fileSource });
      if (ok) close();
      return;
    }
    if (tab === 'url' && urlValid !== null) {
      const ok = await onPick({ icon: urlValid, kind: 'image' });
      if (ok) close();
    }
  }

  // --- tabs -----------------------------------------------------------------

  /** Re-renders the active tab (selections survive across switches). */
  function renderContent(close: () => void): void {
    content.replaceChildren();
    urlInputEl = null;
    urlPreviewEl = null;
    filePreviewEl = null;
    for (const t of [emojiTab, fileTab, urlTab]) {
      t.classList.toggle('active', t === activeTabBtn());
    }
    if (tab === 'emoji') {
      content.append(buildEmojiGrid(close));
    } else if (tab === 'file') {
      content.append(buildFileTab());
    } else {
      content.append(buildUrlTab());
    }
    refreshApply();
  }

  function activeTabBtn(): HTMLButtonElement {
    return tab === 'emoji' ? emojiTab : tab === 'file' ? fileTab : urlTab;
  }

  function switchTab(next: Tab): void {
    if (tab === next) return;
    // Preserve the typed URL text between switches.
    if (urlInputEl !== null) urlValue = urlInputEl.value;
    tab = next;
    renderContent(close);
  }

  const close = showDialog({
    title: 'Иконка',
    body,
    width: 520,
    buttons: [
      {
        label: 'Очистить',
        danger: true,
        keepOpen: true,
        onClick: (c) => {
          void onPick({ icon: null, kind: 'emoji' }).then((ok) => {
            if (ok) c();
          });
        },
      },
      { label: 'Отменить' },
      {
        label: 'Применить',
        primary: true,
        keepOpen: true,
        onClick: (c) => void applySelection(c),
        ref: (el) => {
          applyBtn = el;
        },
      },
    ],
  });

  renderContent(close);
}
