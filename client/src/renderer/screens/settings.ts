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
 * - **Мыслесеть** — network `display_name` plus four markdown self-description
 *   fields (L2, task O5: `description`, `when_to_use`, `conventions`,
 *   `examples`), the per-network `node_section_type_id` dropdown and the
 *   per-user `show_inactive` L3 preference. Markdown tabs are owner-only.
 * - **Клиент** — UI theme (L5 `client_meta.theme`) and `cloud_width` /
 *   `cloud_gap` (L4 `ui_state`), all clipped to the system constants.
 * - **Логирование** — client/server diagnostic journals (task 92b89e6f,
 *   08-ui-spec.md §9.7): immediate-effect toggles and file actions, built in
 *   `settings-logs.ts`; deliberately outside the draft/«Применить» model.
 */

import { renderMarkdown } from '@etn/markdown';
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
import { createMarkdownField } from '../editor/markdown-field.js';
import { showDialog } from '../lib/dialog.js';
import { button, div, el, errText, span } from '../lib/dom.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { clip } from '../lib/pure.js';
import { store, type Theme } from '../state.js';
import { buildLogsSection } from './settings-logs.js';

/** Sections of the settings dialog (order in the sidebar). */
type Section = 'user' | 'network' | 'client' | 'logs';

/** Title rendered above a section. */
const SECTION_TITLES: Record<Section, string> = {
  user: 'Пользователь',
  network: 'Мыслесеть',
  client: 'Клиент',
  logs: 'Логирование',
};

/** Tabs inside the «Мыслесеть» section (task O5). */
type NetworkTab = 'description' | 'when_to_use' | 'conventions' | 'examples';

const NETWORK_TAB_TITLES: Record<NetworkTab, string> = {
  description: 'Описание',
  when_to_use: 'Когда использовать',
  conventions: 'Правила',
  examples: 'Примеры',
};

/** Hint shown under an empty markdown field (mirrors the old textarea placeholder). */
const NETWORK_TAB_PLACEHOLDERS: Record<NetworkTab, string> = {
  description:
    'Назначение сети в одном-двух абзацах. Увидит и человек, и AI-агент при выборе сети.',
  when_to_use:
    'Когда агенту обращаться к этой сети. Для каждого use case — какие ещё поля сети читать.\n\n' +
    'Пример:\n- Кодирование → conventions, structure\n- Ретроспектива проекта → examples, conventions',
  conventions:
    'Правила записи: формат хронологий, пометка active, нейминг, ссылки на типы и шаблоны.',
  examples: 'Примеры хороших и плохих записей — чтобы агент не выдумывал форму.',
};

/** Maximum length of one network markdown field (task O5). */
const NETWORK_FIELDS_TEXT_MAX = 20_000;

/** Draft snapshot of every editable value in the dialog. */
interface Draft {
  displayName: string;
  networkName: string;
  networkDescription: string;
  networkWhenToUse: string;
  networkConventions: string;
  networkExamples: string;
  networkNodeSectionTypeId: string | null;
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
    networkWhenToUse: net?.when_to_use ?? '',
    networkConventions: net?.conventions ?? '',
    networkExamples: net?.examples ?? '',
    networkNodeSectionTypeId: net?.node_section_type_id ?? null,
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
    a.networkWhenToUse !== b.networkWhenToUse ||
    a.networkConventions !== b.networkConventions ||
    a.networkExamples !== b.networkExamples ||
    a.networkNodeSectionTypeId !== b.networkNodeSectionTypeId ||
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
 *
 * `initialSection` selects the section shown when the dialog opens
 * (default — `user`). The «Мыслесеть» menu entry uses it to jump straight
 * to the network section, matching the spec §8.1.
 */
export function showSettingsDialog(initialSection: Section = 'user'): void {
  if (store.state.networkId === null) return;

  let draft: Draft = readInitialDraft();
  const original: Draft = { ...draft };
  let active: Section = initialSection;
  let busy = false;
  let closeDialog: () => void = (): void => undefined;

  // -- body --------------------------------------------------------------
  const body = div('settings-body');

  const nav = el('nav', 'settings-nav');
  const navButtons: Record<Section, HTMLButtonElement> = {
    user: el('button', 'settings-nav-item'),
    network: el('button', 'settings-nav-item'),
    client: el('button', 'settings-nav-item'),
    logs: el('button', 'settings-nav-item'),
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

  /**
   * Build a markdown view/edit block for one network markdown field
   * (task O5). Uses the same `createMarkdownField` component as the thought
   * editor and the chronological-comment editor: HTML render by default,
   * double-click switches to a CodeMirror editor (M2), blur (or Ctrl+Enter)
   * commits and returns to view mode (08-ui-spec.md §6.4, §6.6).
   *
   * The server stores raw markdown only; the view HTML is rendered on the
   * client through the shared `@etn/markdown` pipeline (M1). The field stays
   * read-only for non-owners (the editor opens on double-click but cannot be
   * edited — CodeMirror is mounted on `view.dblclick`, which does not fire
   * for disabled/empty widgets).
   *
   * The static hint below the field carries the role the old textarea
   * placeholder used to play — `createMarkdownField` does not expose a
   * placeholder; keeping the hint always visible mirrors how the other
   * markdown fields in the app are labelled.
   */
  function renderMarkdownField(opts: {
    tab: NetworkTab;
    getValue: () => string;
    setValue: (md: string) => void;
    disabled: boolean;
  }): HTMLElement {
    const initialMd = opts.getValue();
    const initialHtml = renderInitialHtml(initialMd);
    const widget = createMarkdownField({
      md: initialMd,
      html: initialHtml,
      onInput: (md) => {
        if (md.length > NETWORK_FIELDS_TEXT_MAX) md = md.slice(0, NETWORK_FIELDS_TEXT_MAX);
        opts.setValue(md);
        markDirty();
      },
      onSave: (md) => {
        if (md.length > NETWORK_FIELDS_TEXT_MAX) md = md.slice(0, NETWORK_FIELDS_TEXT_MAX);
        opts.setValue(md);
        markDirty();
        return Promise.resolve(renderMarkdown(md));
      },
      minRows: 8,
    });
    if (opts.disabled) {
      // Non-owner: surface that the field is read-only and neutralise the
      // text cursor hint of `md-field-view`. CodeMirror edits are not
      // reached anyway: `view.dblclick` still triggers `showEdit`, but the
      // network markdown has no per-owner client endpoint to persist edits
      // — and the editor makes that obvious because the dblclick hint is
      // disabled by the read-only class.
      widget.classList.add('md-field-readonly');
      const view = widget.querySelector('.md-field-view');
      if (view instanceof HTMLElement) {
        view.setAttribute('aria-readonly', 'true');
      }
    }
    const wrap = div('settings-md-field');
    wrap.append(widget, el('p', 'muted settings-md-hint', NETWORK_TAB_PLACEHOLDERS[opts.tab]));
    return wrap;
  }

  /**
   * Renders markdown to HTML for the initial view. Empty input stays empty;
   * the surrounding hint carries the "what to put here" guidance.
   */
  function renderInitialHtml(md: string): string {
    if (md.trim() === '') return '';
    return renderMarkdown(md);
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

    // Tabs for the four markdown self-description fields (O5).
    let activeTab: NetworkTab = 'description';
    const tabsBar = el('div', 'settings-md-tabs');
    const tabButtons: Record<NetworkTab, HTMLButtonElement> = {
      description: el('button', 'settings-md-tab'),
      when_to_use: el('button', 'settings-md-tab'),
      conventions: el('button', 'settings-md-tab'),
      examples: el('button', 'settings-md-tab'),
    };
    const tabPanel = div('settings-md-panel');

    const fieldSetters: Record<NetworkTab, (md: string) => void> = {
      description: (md) => {
        draft.networkDescription = md;
      },
      when_to_use: (md) => {
        draft.networkWhenToUse = md;
      },
      conventions: (md) => {
        draft.networkConventions = md;
      },
      examples: (md) => {
        draft.networkExamples = md;
      },
    };
    const fieldGetters: Record<NetworkTab, () => string> = {
      description: () => draft.networkDescription,
      when_to_use: () => draft.networkWhenToUse,
      conventions: () => draft.networkConventions,
      examples: () => draft.networkExamples,
    };

    function paintTabs(): void {
      for (const key of Object.keys(tabButtons) as NetworkTab[]) {
        const btn = tabButtons[key];
        const isActive = key === activeTab;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-current', isActive ? 'page' : 'false');
      }
      tabPanel.replaceChildren();
      tabPanel.append(
        renderMarkdownField({
          tab: activeTab,
          getValue: fieldGetters[activeTab],
          setValue: fieldSetters[activeTab],
          disabled: !isOwner,
        }),
      );
    }
    for (const key of Object.keys(tabButtons) as NetworkTab[]) {
      const btn = tabButtons[key];
      btn.type = 'button';
      btn.textContent = NETWORK_TAB_TITLES[key];
      btn.addEventListener('click', () => {
        if (activeTab === key) return;
        activeTab = key;
        paintTabs();
      });
      tabsBar.append(btn);
    }
    paintTabs();

    // Node-section type dropdown (O5). The list comes from the in-memory
    // store (refreshed on type changes by realtime); `null` means "no
    // structure".
    const typeSelect = el('select', 'text-input');
    typeSelect.disabled = !isOwner;
    const noneOption = el('option');
    noneOption.value = '';
    noneOption.textContent = '— не задано —';
    typeSelect.append(noneOption);
    const thoughtTypes = store.state.thoughtTypes ?? [];
    for (const t of thoughtTypes) {
      const opt = el('option');
      opt.value = t.id;
      opt.textContent = t.name;
      typeSelect.append(opt);
    }
    typeSelect.value = draft.networkNodeSectionTypeId ?? '';
    typeSelect.addEventListener('change', () => {
      draft.networkNodeSectionTypeId = typeSelect.value === '' ? null : typeSelect.value;
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
      el(
        'p',
        'muted',
        'Самоописание сети для людей и AI-агентов. Markdown: ссылки, списки, картинки. Во вкладке «Когда использовать» перечислите сценарии, для которых подходит сеть.',
      ),
      tabsBar,
      tabPanel,
      el(
        'p',
        'muted',
        'Узловой тип раздела определяет структуру сети (читается через `etn.networks.structure`). Все активные мысли выбранного типа становятся разделами. Тип, выбранный здесь, нельзя удалить, пока ссылка не снята.',
      ),
      field('Узловой тип раздела', typeSelect),
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
      case 'logs':
        section = buildLogsSection();
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

    // Network: display_name + 4 markdown fields + node_section_type_id (L2 / O5).
    // One PATCH so the server-side update is a single transaction; partial
    // mismatches between client and server are tolerated because we always
    // send the full current draft for changed fields.
    const networkFieldsDirty =
      draft.networkName !== original.networkName ||
      draft.networkDescription !== original.networkDescription ||
      draft.networkWhenToUse !== original.networkWhenToUse ||
      draft.networkConventions !== original.networkConventions ||
      draft.networkExamples !== original.networkExamples ||
      draft.networkNodeSectionTypeId !== original.networkNodeSectionTypeId;
    if (networkFieldsDirty) {
      const fields: Parameters<typeof etn.networks.update>[1] = {
        display_name: draft.networkName.trim() || (store.state.network?.display_name ?? ''),
        description: draft.networkDescription.trim() === '' ? null : draft.networkDescription,
        when_to_use: draft.networkWhenToUse.trim() === '' ? null : draft.networkWhenToUse,
        conventions: draft.networkConventions.trim() === '' ? null : draft.networkConventions,
        examples: draft.networkExamples.trim() === '' ? null : draft.networkExamples,
        node_section_type_id: draft.networkNodeSectionTypeId,
      };
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
      original.networkWhenToUse = draft.networkWhenToUse;
      original.networkConventions = draft.networkConventions;
      original.networkExamples = draft.networkExamples;
      original.networkNodeSectionTypeId = draft.networkNodeSectionTypeId;
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
    width: 760,
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
