/**
 * Unified settings dialog (H18+, 08-ui-spec.md §9; 11-settings-and-state.md).
 *
 * The application used to scatter settings across three toolbar menus (network,
 * user, view). They are now gathered into a single modal opened from the View
 * menu (`☰ → Настройки`). The dialog is laid out as a sidebar of sections
 * (Пользователь / Мыслесеть / Клиент) over a sticky footer with three
 * buttons, per the task in the «Тест 1» thought network:
 *
 *   - «Применить» (Shift+Enter) — apply all pending changes, keep the dialog
 *     open so the user can keep tweaking.
 *   - «Применить и закрыть» (Ctrl+Enter, the built-in primary shortcut) —
 *     apply and close.
 *   - «Отменить» (Esc, the built-in close shortcut) — close and discard all
 *     unapplied changes.
 *
 * Per-section content:
 *
 * - **Пользователь** — own `display_name` (L1 user profile, edited via the
 *   new self-service `PATCH /me`). Username is read-only.
 * - **Мыслесеть** — network `display_name`/`description` (L2, owner-only,
 *   shown disabled otherwise) plus the per-user `show_inactive` L3 preference.
 * - **Клиент** — UI theme (L5 `client_meta.theme`) and `cloud_width` /
 *   `cloud_gap` (L4 `ui_state`), all clipped to the system constants.
 */

import {
  CLIENT_META_KEY,
  CLOUD_GAP_MAX,
  CLOUD_GAP_MIN,
  CLOUD_WIDTH_MAX,
  CLOUD_WIDTH_MIN,
  DISPLAY_NAME_MAX_LENGTH,
  PREF_KEY,
  UI_STATE_KEY,
} from '@etn/shared';

import { scheduleRefresh } from '../app.js';
import { showDialog } from '../lib/dialog.js';
import { button, div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { clip } from '../lib/pure.js';
import { store, type Theme } from '../state.js';

/** Sections of the settings dialog (order in the sidebar). */
type Section = 'user' | 'network' | 'client';

/** Title rendered above a section. */
const SECTION_TITLES: Record<Section, string> = {
  user: 'Пользователь',
  network: 'Мыслесеть',
  client: 'Клиент',
};

/** Draft snapshot of every editable value in the dialog. */
interface Draft {
  displayName: string;
  networkName: string;
  networkDescription: string;
  showInactive: boolean;
  theme: Theme;
  cloudWidth: number;
  cloudGap: number;
}

/** Builds the initial draft from the current store + open network. */
function readInitialDraft(): Draft {
  const me = store.state.me;
  const net = store.state.network;
  return {
    displayName: me?.display_name ?? '',
    networkName: net?.display_name ?? '',
    networkDescription: net?.description ?? '',
    showInactive: store.state.showInactive,
    theme: store.state.theme,
    cloudWidth: store.state.cloudWidth,
    cloudGap: store.state.cloudGap,
  };
}

/** Returns true when `a` and `b` differ in at least one field. */
function isDirtyDraft(a: Draft, b: Draft): boolean {
  return (
    a.displayName !== b.displayName ||
    a.networkName !== b.networkName ||
    a.networkDescription !== b.networkDescription ||
    a.showInactive !== b.showInactive ||
    a.theme !== b.theme ||
    a.cloudWidth !== b.cloudWidth ||
    a.cloudGap !== b.cloudGap
  );
}

/**
 * Opens the unified settings dialog. No-op when no network is open (every
 * section depends on the network except the bare user profile; opening the
 * dialog without a network would show an empty state that adds no value).
 */
export function showSettingsDialog(): void {
  if (store.state.networkId === null) return;

  let draft: Draft = readInitialDraft();
  const original: Draft = { ...draft };
  let active: Section = 'user';
  let busy = false;
  let closeDialog: () => void = (): void => undefined;

  // -- body --------------------------------------------------------------
  const body = div('settings-body');

  const nav = el('nav', 'settings-nav');
  const navButtons: Record<Section, HTMLButtonElement> = {
    user: el('button', 'settings-nav-item'),
    network: el('button', 'settings-nav-item'),
    client: el('button', 'settings-nav-item'),
  };
  for (const key of Object.keys(navButtons) as Section[]) {
    const btn = navButtons[key];
    btn.type = 'button';
    btn.textContent = SECTION_TITLES[key];
    btn.addEventListener('click', () => {
      if (active === key) return;
      active = key;
      renderContent();
    });
    nav.append(btn);
  }

  const content = div('settings-content');
  const errorLine = span('', 'error-text settings-error');

  body.append(nav, content, errorLine);

  // -- footer ------------------------------------------------------------
  const footer = div('settings-footer');
  footer.append(
    el('span', 'settings-footer-hint', 'Shift+Enter — применить, Ctrl+Enter — применить и закрыть'),
  );
  const btnGroup = div('settings-footer-buttons');
  const btnApply = button('Применить', () => void applyDraft(false), 'dialog-btn');
  btnApply.title = 'Применить (Shift+Enter)';
  const btnApplyClose = button(
    'Применить и закрыть',
    () => void applyDraft(true),
    'dialog-btn primary',
  );
  btnApplyClose.title = 'Применить и закрыть (Ctrl+Enter)';
  const btnCancel = button('Отменить', () => closeDialog(), 'dialog-btn');
  btnCancel.title = 'Отменить (Esc)';
  btnGroup.append(btnApply, btnApplyClose, btnCancel);
  footer.append(btnGroup);

  // -- helpers -----------------------------------------------------------
  function setBusy(value: boolean): void {
    busy = value;
    btnApply.disabled = value;
    btnApplyClose.disabled = value;
    btnCancel.disabled = value;
    for (const btn of Object.values(navButtons)) btn.disabled = value;
  }

  function refreshApplyButtons(): void {
    const dirty = isDirtyDraft(draft, original);
    btnApply.disabled = busy || !dirty;
    btnApplyClose.disabled = busy || !dirty;
  }

  function markDirty(): void {
    refreshApplyButtons();
  }

  function renderUserSection(): HTMLElement {
    const root = div('settings-section');

    const me = store.state.me;
    if (me === null) {
      root.append(el('p', 'muted', 'Профиль не загружен.'));
      return root;
    }

    const nameInput = el('input', 'text-input');
    nameInput.type = 'text';
    nameInput.value = draft.displayName;
    nameInput.maxLength = DISPLAY_NAME_MAX_LENGTH;
    nameInput.placeholder = 'Не задано';
    nameInput.addEventListener('input', () => {
      draft.displayName = nameInput.value;
      markDirty();
    });

    const username = el('input', 'text-input');
    username.type = 'text';
    username.value = me.username;
    username.disabled = true;

    root.append(
      el('h3', 'settings-section-title', 'Профиль пользователя'),
      field('Имя для отображения', nameInput),
      field('Логин', username),
      el(
        'p',
        'muted',
        'Имя отображается в тулбаре и других местах интерфейса. Логин задаётся при создании учётной записи.',
      ),
    );
    return root;
  }

  function renderNetworkSection(): HTMLElement {
    const root = div('settings-section');
    const isOwner =
      store.state.network !== null && store.state.network.owner_id === store.state.me?.id;

    const nameInput = el('input', 'text-input');
    nameInput.type = 'text';
    nameInput.value = draft.networkName;
    nameInput.maxLength = 200;
    nameInput.disabled = !isOwner;
    nameInput.addEventListener('input', () => {
      draft.networkName = nameInput.value;
      markDirty();
    });

    const descInput = el('textarea', 'text-input');
    descInput.rows = 3;
    descInput.value = draft.networkDescription;
    descInput.maxLength = 2000;
    descInput.disabled = !isOwner;
    descInput.addEventListener('input', () => {
      draft.networkDescription = descInput.value;
      markDirty();
    });

    const showInactiveCheckbox = el('input');
    showInactiveCheckbox.type = 'checkbox';
    showInactiveCheckbox.checked = draft.showInactive;
    showInactiveCheckbox.addEventListener('change', () => {
      draft.showInactive = showInactiveCheckbox.checked;
      markDirty();
    });
    const showInactiveLabel = el('label', 'checkbox-row');
    showInactiveLabel.append(
      showInactiveCheckbox,
      span('Показывать неактуальные мысли и связи в этой сети'),
    );

    const ownerHint = isOwner
      ? 'Эти поля задаёт владелец сети; изменения сохраняются для всех участников.'
      : 'Эти поля задаёт владелец сети. Вы можете посмотреть их, но не изменить.';

    root.append(
      el('h3', 'settings-section-title', 'Настройки сети'),
      field('Название сети', nameInput),
      field('Описание', descInput),
      el('p', 'muted', ownerHint),
      el('h3', 'settings-section-title settings-section-title-spaced', 'Видимость'),
      showInactiveLabel,
      el('p', 'muted', 'Общая настройка для всех ваших клиентов в этой сети.'),
    );
    return root;
  }

  function renderClientSection(): HTMLElement {
    const root = div('settings-section');

    const themeGroup = div('radio-group');
    const lightLabel = el('label', 'radio-row');
    const lightRadio = el('input');
    lightRadio.type = 'radio';
    lightRadio.name = 'settings-theme';
    lightRadio.value = 'light';
    lightRadio.checked = draft.theme === 'light';
    lightLabel.append(lightRadio, span('Светлая'));
    const darkLabel = el('label', 'radio-row');
    const darkRadio = el('input');
    darkRadio.type = 'radio';
    darkRadio.name = 'settings-theme';
    darkRadio.value = 'dark';
    darkRadio.checked = draft.theme === 'dark';
    darkLabel.append(darkRadio, span('Тёмная'));
    for (const radio of [lightRadio, darkRadio]) {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        draft.theme = radio.value as Theme;
        markDirty();
      });
    }
    themeGroup.append(lightLabel, darkLabel);

    const widthInput = el('input', 'text-input');
    widthInput.type = 'number';
    widthInput.min = String(CLOUD_WIDTH_MIN);
    widthInput.max = String(CLOUD_WIDTH_MAX);
    widthInput.value = String(draft.cloudWidth);
    widthInput.addEventListener('input', () => {
      draft.cloudWidth = Number(widthInput.value);
      markDirty();
    });

    const gapInput = el('input', 'text-input');
    gapInput.type = 'number';
    gapInput.min = String(CLOUD_GAP_MIN);
    gapInput.max = String(CLOUD_GAP_MAX);
    gapInput.value = String(draft.cloudGap);
    gapInput.addEventListener('input', () => {
      draft.cloudGap = Number(gapInput.value);
      markDirty();
    });

    root.append(
      el('h3', 'settings-section-title', 'Тема'),
      themeGroup,
      el('p', 'muted', 'Применяется на всех экранах. Действует только на этом клиенте.'),
      el('h3', 'settings-section-title settings-section-title-spaced', 'Размер облачка'),
      field(`Ширина облачка, px (${CLOUD_WIDTH_MIN}–${CLOUD_WIDTH_MAX})`, widthInput),
      field(`Отступ между облачками, px (${CLOUD_GAP_MIN}–${CLOUD_GAP_MAX})`, gapInput),
      el('p', 'muted', 'Хранится только на этом клиенте.'),
    );
    return root;
  }

  function renderContent(): void {
    for (const key of Object.keys(navButtons) as Section[]) {
      navButtons[key].classList.toggle('active', key === active);
      navButtons[key].setAttribute('aria-current', key === active ? 'page' : 'false');
    }
    content.replaceChildren();
    errorLine.textContent = '';
    let section: HTMLElement;
    switch (active) {
      case 'user':
        section = renderUserSection();
        break;
      case 'network':
        section = renderNetworkSection();
        break;
      case 'client':
        section = renderClientSection();
        break;
    }
    content.append(section);
  }

  // -- apply -------------------------------------------------------------
  async function applyDiff(): Promise<void> {
    const networkId = store.state.networkId;
    if (networkId === null) throw new Error('Сеть не открыта.');

    const tasks: Array<Promise<void>> = [];

    // User: display_name (L1).
    if (draft.displayName !== original.displayName) {
      const next = draft.displayName.trim() === '' ? null : draft.displayName.trim();
      tasks.push(
        (async () => {
          const me = await etn.me.update(next);
          store.update({ me });
        })(),
      );
    }

    // Network: display_name / description (L2). Only the owner can change
    // them; for non-owners the inputs are disabled, so this branch is a no-op.
    if (
      draft.networkName !== original.networkName ||
      draft.networkDescription !== original.networkDescription
    ) {
      const fields: { display_name?: string; description?: string } = {
        display_name: draft.networkName.trim(),
      };
      const desc = draft.networkDescription.trim();
      fields['description'] = desc;
      tasks.push(
        (async () => {
          const updated = await etn.networks.update(networkId, fields);
          store.update({ network: updated });
        })(),
      );
    }

    // Network: show_inactive (L3). Refreshed via `scheduleRefresh()` so the
    // canvas and search pick up the new visibility immediately.
    if (draft.showInactive !== original.showInactive) {
      tasks.push(
        (async () => {
          await etn.networks.setPreference(
            networkId,
            PREF_KEY.SHOW_INACTIVE,
            draft.showInactive,
          );
          store.update({ showInactive: draft.showInactive });
          scheduleRefresh();
        })(),
      );
    }

    // Client: theme (L5). Mirrors `lib/theme.ts` — apply to the DOM right
    // away so the user sees the change live, then persist.
    if (draft.theme !== original.theme) {
      tasks.push(
        (async () => {
          await etn.meta.set(CLIENT_META_KEY.THEME, draft.theme);
          document.documentElement.dataset['theme'] = draft.theme;
          store.update({ theme: draft.theme });
        })(),
      );
    }

    // Client: cloud_width / cloud_gap (L4). Clipped to the system constants.
    if (draft.cloudWidth !== original.cloudWidth || draft.cloudGap !== original.cloudGap) {
      const w = clip(Math.round(draft.cloudWidth), CLOUD_WIDTH_MIN, CLOUD_WIDTH_MAX);
      const g = clip(Math.round(draft.cloudGap), CLOUD_GAP_MIN, CLOUD_GAP_MAX);
      tasks.push(
        (async () => {
          await etn.ui.setState(networkId, UI_STATE_KEY.CLOUD_WIDTH, String(w));
          await etn.ui.setState(networkId, UI_STATE_KEY.CLOUD_GAP, String(g));
          store.update({ cloudWidth: w, cloudGap: g });
          scheduleRefresh();
        })(),
      );
    }

    await Promise.all(tasks);
  }

  async function applyDraft(thenClose: boolean): Promise<void> {
    if (busy) return;
    if (!isDirtyDraft(draft, original)) {
      if (thenClose) closeDialog();
      return;
    }
    setBusy(true);
    errorLine.textContent = '';
    try {
      await applyDiff();
      // Resync from the store: empty display_name normalises to null, etc.
      draft = readInitialDraft();
      original.displayName = draft.displayName;
      original.networkName = draft.networkName;
      original.networkDescription = draft.networkDescription;
      original.showInactive = draft.showInactive;
      original.theme = draft.theme;
      original.cloudWidth = draft.cloudWidth;
      original.cloudGap = draft.cloudGap;
      refreshApplyButtons();
      renderContent();
      notice('Настройки сохранены.');
      if (thenClose) closeDialog();
    } catch (err) {
      errorLine.textContent = errText(err);
    } finally {
      setBusy(false);
    }
  }

  closeDialog = showDialog({
    title: 'Настройки',
    body,
    customFooter: footer,
    width: 640,
    extraShortcuts: {
      shiftEnter: () => void applyDraft(false),
    },
  });

  renderContent();
  refreshApplyButtons();
}

/** Standard field builder (label + control wrapper). */
function field(label: string, control: HTMLElement): HTMLDivElement {
  const row = div('field');
  row.append(el('label', 'field-label', label));
  row.append(control);
  return row;
}
