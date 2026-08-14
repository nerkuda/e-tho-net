/**
 * Icon picker dialog (08-ui-spec.md §6.8).
 *
 * Three tabs: Emoji (a click-to-pick grid), File (system file picker → `data:`
 * URL) and URL (typed URL). The File/URL tabs show a live preview square and an
 * OK button that is enabled only when the image loads. «Очистить» clears the
 * thought's own icon (the type default then shows through).
 */

import type { IconKind } from '@etn/shared';

import { showDialog } from '../lib/dialog.js';
import { button, div, el } from '../lib/dom.js';
import { etn } from '../lib/etn.js';

/** Outcome of the dialog: an icon + kind, or `null` to clear the icon. */
export interface IconPickResult {
  icon: string | null;
  kind: IconKind;
}

/** A compact grid of commonly useful emojis (08-ui-spec.md §6.8). */
const EMOJIS = [
  '💬', '💭', '💡', '📌', '⭐', '❤️', '🔥', '✅', '❌', '⚠️',
  '👤', '👥', '🏠', '🏢', '🏫', '🌍', '📍', '🎯', '🧭', '🔑',
  '📚', '📝', '📄', '📁', '📂', '🗓️', '📈', '📊', '🔧', '⚙️',
  '💻', '🖥️', '📱', '🔗', '📨', '✉️', '📞', '🛒', '💰', '💳',
  '🎨', '🎵', '🎬', '📷', '🔬', '🧪', '🏥', '🚗', '✈️', '🚀',
  '🌱', '🌳', '🐾', '🐶', '🐱', '🐦', '🍎', '🍞', '☕', '🍷',
  '🎁', '🏆', '⚽', '🎮', '🧩', '⚛️', '🌀', '⚜️', '♾️', '❓',
];

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
  const mkTab = (id: Tab, label: string): HTMLButtonElement => {
    const btn = button(label, () => switchTab(id), 'icon-tab');
    return btn;
  };
  const emojiTab = mkTab('emoji', 'Эмодзи');
  const fileTab = mkTab('file', 'Файл');
  const urlTab = mkTab('url', 'URL');
  tabsBar.append(emojiTab, fileTab, urlTab);
  body.append(tabsBar);

  const content = div('icon-content');
  body.append(content);

  // Shared File/URL controls state.
  let pendingValue = ''; // text typed in the file/url input
  let validValue: string | null = null; // an image value that loaded successfully
  let inputEl: HTMLInputElement | null = null;
  let okBtn: HTMLButtonElement | null = null;
  let previewEl: HTMLDivElement | null = null;

  /** Validates a string as a loadable image; updates preview + OK state. */
  function validateImage(value: string): void {
    if (previewEl === null || okBtn === null) return;
    validValue = null;
    okBtn.disabled = true;
    previewEl.replaceChildren();
    previewEl.classList.remove('icon-preview-error');
    const v = value.trim();
    if (v === '') return;
    const img = el('img');
    img.alt = '';
    img.addEventListener('load', () => {
      if (inputEl !== null && inputEl.value.trim() === v) {
        validValue = v;
        okBtn?.removeAttribute('disabled');
      }
    });
    img.addEventListener('error', () => {
      if (inputEl !== null && inputEl.value.trim() === v) {
        validValue = null;
        okBtn?.setAttribute('disabled', 'disabled');
        previewEl?.replaceChildren(el('span', 'icon-preview-bad', '✕'));
        previewEl?.classList.add('icon-preview-error');
      }
    });
    img.src = v;
    previewEl.append(img);
  }

  /** Picks a file via the OS dialog and fills the input + preview. */
  async function pickFile(): Promise<void> {
    const dataUrl = await etn.system.pickImage();
    if (dataUrl === null) return; // canceled or too large / unreadable
    if (inputEl !== null) {
      inputEl.value = dataUrl;
      validateImage(dataUrl);
    }
  }

  /** Commits the validated image value. */
  async function commitImage(close: () => void): Promise<void> {
    if (validValue === null) return;
    const ok = await onPick({ icon: validValue, kind: 'image' });
    if (ok) close();
  }

  /** Builds the emoji grid tab content. */
  function buildEmojiGrid(close: () => void): HTMLElement {
    const grid = div('emoji-grid');
    for (const glyph of EMOJIS) {
      const cell = button(glyph, () => {
        void onPick({ icon: glyph, kind: 'emoji' }).then((ok) => {
          if (ok) close();
        });
      }, 'emoji-cell');
      grid.append(cell);
    }
    return grid;
  }

  /** Builds the File/URL tab (shared; `withPicker` adds the «Выбрать» button). */
  function buildSourceTab(close: () => void, withPicker: boolean): HTMLElement {
    const box = div('icon-source');
    const row = div('icon-source-row');
    inputEl = el('input', 'text-input') as HTMLInputElement;
    inputEl.type = 'text';
    inputEl.value = pendingValue;
    inputEl.placeholder = withPicker ? 'путь к файлу или data: URL' : 'URL изображения';
    inputEl.addEventListener('input', () => {
      pendingValue = inputEl?.value ?? '';
      validateImage(pendingValue);
    });
    row.append(inputEl);
    if (withPicker) {
      const pickBtn = button('Выбрать', () => void pickFile(), 'btn small');
      row.append(pickBtn);
    }
    box.append(row);

    previewEl = div('icon-preview');
    box.append(previewEl);

    okBtn = button('ОК', () => void commitImage(close), 'btn primary');
    okBtn.setAttribute('disabled', 'disabled');
    box.append(okBtn);

    // Validate the prefilled value once laid out.
    queueMicrotask(() => validateImage(pendingValue));
    return box;
  }

  /** Re-renders the active tab. */
  function renderContent(close: () => void): void {
    content.replaceChildren();
    inputEl = null;
    okBtn = null;
    previewEl = null;
    validValue = null;
    for (const t of [emojiTab, fileTab, urlTab]) {
      t.classList.toggle('active', t === activeTabBtn());
    }
    if (tab === 'emoji') {
      content.append(buildEmojiGrid(close));
    } else if (tab === 'file') {
      content.append(buildSourceTab(close, true));
    } else {
      content.append(buildSourceTab(close, false));
    }
  }

  function activeTabBtn(): HTMLButtonElement {
    return tab === 'emoji' ? emojiTab : tab === 'file' ? fileTab : urlTab;
  }

  function switchTab(next: Tab): void {
    if (tab === next) return;
    // Preserve typed text between File/URL tabs.
    if (inputEl !== null) pendingValue = inputEl.value;
    tab = next;
    renderContent(close);
  }

  const close = showDialog({
    title: 'Иконка',
    body,
    buttons: [
      {
        label: 'Очистить',
        danger: true,
        onClick: () => {
          void onPick({ icon: null, kind: 'emoji' }).then((ok) => {
            if (ok) close();
          });
        },
      },
      { label: 'Закрыть', primary: true },
    ],
  });

  renderContent(close);
}
