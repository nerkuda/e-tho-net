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
 *   `examples`), the per-network `type_roles.table_of_contents` dropdown and the
 *   per-user `show_inactive` / `show_trash` L3 preferences (group «Видимость»). Markdown
 *   tabs are owner-only.
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

import { scheduleRefresh, requireNetworkId } from '../app.js';
import { createMarkdownField } from '../editor/markdown-field.js';
import { showDialog } from '../lib/dialog.js';
import { uiTabs } from '../lib/ui/tabs.js';
import { div, el, errText } from '../lib/dom.js';
import { footerErrorLine } from '../lib/ui/messages.js';
import { availableLocales, getLang, t } from '../lib/i18n.js';
import { applyLang } from '../lib/lang.js';
import { buildEntityCombo } from '../lib/entity-picker.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { clip } from '../lib/pure.js';
import { store, type Theme } from '../state.js';
import { buildLogsSection } from './settings-logs.js';
import { scheduleStructuresRefresh } from './structures/structures.js';
import { uiButton } from '../lib/ui/button.js';
import { fieldInput, fieldRow } from '../lib/ui/field.js';
import { checkboxRow, radioRow, choiceGroup } from '../lib/ui/choice-row.js';

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

/**
 * Both `type_roles` entries live as separate keys in the same dictionary
 * (ADR `46d17a91`). The form keeps them as two flat draft fields so the
 * dirty check stays a simple per-field comparison; persistence merges them
 * back into the existing `type_roles` so other roles stay intact.
 */
interface Draft {
  displayName: string;
  networkName: string;
  networkDescription: string;
  networkWhenToUse: string;
  networkConventions: string;
  networkExamples: string;
  networkNodeSectionTypeId: string | null;
  networkInstructionsTypeId: string | null;
  showInactive: boolean;
  showTrash: boolean;
  theme: Theme;
  /** Язык интерфейса (L5 `client_meta.lang`, задача 57f09136). */
  lang: string;
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
    networkNodeSectionTypeId:
      typeof net?.type_roles?.table_of_contents === 'string'
        ? net.type_roles.table_of_contents
        : null,
    networkInstructionsTypeId:
      typeof net?.type_roles?.instructions === 'string'
        ? net.type_roles.instructions
        : null,
    showInactive: store.state.showInactive,
    showTrash: store.state.showTrash,
    theme: store.state.theme,
    lang: getLang(),
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
    a.networkInstructionsTypeId !== b.networkInstructionsTypeId ||
    a.showInactive !== b.showInactive ||
    a.showTrash !== b.showTrash ||
    a.theme !== b.theme ||
    a.lang !== b.lang ||
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
  // Строка ошибки живёт в sticky-футере (ниже), а не в теле: она обязана быть
  // видна на любой вкладке/разделе диалога, в т.ч. при прокрученном
  // содержимом (ошибка add8d09d).
  const errorLine = footerErrorLine('settings-error');

  body.append(nav, content);

  // -- footer ------------------------------------------------------------
  const footer = div('settings-footer');
  footer.append(
    el('span', 'settings-footer-hint', 'Shift+Enter — применить, Ctrl+Enter — применить и закрыть'),
    errorLine,
  );
  const btnGroup = div('settings-footer-buttons');
  const btnApply = uiButton({
    label: t('actions.apply'),
    role: 'secondary',
    size: 'm',
    onClick: () => void applyDraft(false),
  });
  btnApply.title = t('actions.applyShortcut', 'Shift+Enter');
  const btnApplyClose = uiButton({
    label: t('actions.applyClose'),
    role: 'primary',
    size: 'm',
    onClick: () => void applyDraft(true),
  });
  btnApplyClose.title = t('actions.applyCloseShortcut', 'Ctrl+Enter');
  const btnCancel = uiButton({
    label: t('actions.cancel'),
    role: 'secondary',
    size: 'm',
    onClick: () => closeDialog(),
  });
  btnCancel.title = t('actions.cancelShortcut', 'Esc');
  // Primary-действие — крайним справа (требование edc5faea): панель
  // кнопок диалога держит главное действие последним.
  btnGroup.append(btnApply, btnCancel, btnApplyClose);
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

    const nameInput = fieldInput();
    nameInput.type = 'text';
    nameInput.value = draft.displayName;
    nameInput.maxLength = DISPLAY_NAME_MAX_LENGTH;
    nameInput.placeholder = 'Не задано';
    nameInput.addEventListener('input', () => {
      draft.displayName = nameInput.value;
      markDirty();
    });

    const username = fieldInput();
    username.type = 'text';
    username.value = me.username;
    username.disabled = true;

    root.append(
      el('h3', 'settings-section-title', 'Профиль пользователя'),
      fieldRow({ label: 'Имя для отображения', control: nameInput }),
      fieldRow({ label: 'Логин', control: username }),
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

    const nameInput = fieldInput();
    nameInput.type = 'text';
    nameInput.value = draft.networkName;
    nameInput.maxLength = 200;
    nameInput.disabled = !isOwner;
    nameInput.addEventListener('input', () => {
      draft.networkName = nameInput.value;
      markDirty();
    });

    // Вкладки четырёх markdown-полей самоописания сети (O5) — общий механизм
    // `lib/ui/tabs.ts` (задача a57e7998): панели сохраняются, поле каждой
    // вкладки строится лениво при первом показе.
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

    const mdTabs = uiTabs({
      tabs: (['description', 'when_to_use', 'conventions', 'examples'] as NetworkTab[]).map(
        (key) => ({
          id: key,
          label: NETWORK_TAB_TITLES[key],
          content: () =>
            renderMarkdownField({
              tab: key,
              getValue: fieldGetters[key],
              setValue: fieldSetters[key],
              disabled: !isOwner,
            }),
        }),
      ),
    });

    // Node-section type field (O5). The catalogue comes from the in-memory
    // store (refreshed on type changes by realtime); `null` means "no
    // structure". Rendered by the common entity picker (ADR «выбор сущности —
    // один пикер»): значок и цвета типа, живой поиск, «— не задано —».
    const typeCombo = buildEntityCombo({
      networkId: requireNetworkId(),
      kind: 'thought-types',
      value: draft.networkNodeSectionTypeId,
      emptyLabel: '— не задано —',
      placeholder: 'Тип мысли…',
      disabled: !isOwner,
      onChange: (typeId) => {
        draft.networkNodeSectionTypeId = typeId;
        markDirty();
      },
    });

    // Instructions-type field (0.7.2, ADR `46d17a91` + ADR `717f04df`).
    // Same shape as `table_of_contents` but writes into `type_roles.instructions`
    // — required for the `etn.instructions` showcase-tool to return anything.
    const instructionsTypeCombo = buildEntityCombo({
      networkId: requireNetworkId(),
      kind: 'thought-types',
      value: draft.networkInstructionsTypeId,
      emptyLabel: '— не задано —',
      placeholder: 'Тип мысли…',
      disabled: !isOwner,
      onChange: (typeId) => {
        draft.networkInstructionsTypeId = typeId;
        markDirty();
      },
    });

    const showInactiveRow = checkboxRow({
      label: 'Показывать неактуальные мысли и связи в этой сети',
      checked: draft.showInactive,
      onChange: (checked) => {
        draft.showInactive = checked;
        markDirty();
      },
    });
    const showInactiveLabel = showInactiveRow.row;

    // «Показывать содержимое корзины» (задача 77923b49) — рядом с неактуальными,
    // тот же механизм (L3 `show_trash`): выключено — помеченные на удаление
    // мысли/связи скрыты на карте, в локальном графе редактора и в структурах.
    const showTrashRow = checkboxRow({
      label: 'Показывать содержимое корзины в этой сети',
      checked: draft.showTrash,
      onChange: (checked) => {
        draft.showTrash = checked;
        markDirty();
      },
    });
    const showTrashLabel = showTrashRow.row;

    const ownerHint = isOwner
      ? 'Эти поля задаёт владелец сети; изменения сохраняются для всех участников.'
      : 'Эти поля задаёт владелец сети. Вы можете посмотреть их, но не изменить.';

    root.append(
      el('h3', 'settings-section-title', 'Настройки сети'),
      fieldRow({ label: 'Название сети', control: nameInput }),
      el(
        'p',
        'muted',
        'Самоописание сети для людей и AI-агентов. Markdown: ссылки, списки, картинки. Во вкладке «Когда использовать» перечислите сценарии, для которых подходит сеть.',
      ),
      mdTabs.root,      el(
        'p',
        'muted',
        'Узловой тип раздела определяет структуру сети (читается через `etn.networks.structure`). Все активные мысли выбранного типа становятся разделами. Тип, выбранный здесь, нельзя удалить, пока ссылка не снята.',
      ),
      fieldRow({ label: 'Узловой тип раздела', control: typeCombo.root }),
      el(
        'p',
        'muted',
        'Тип инструкций агентам задаёт, какие мысли отдаются витриной `etn.instructions` (ADR 717f04df). Без выбора витрина отвечает пустым списком. Тип, выбранный здесь, защищён от удаления так же, как узловой.',
      ),
      fieldRow({ label: 'Тип инструкций агентам', control: instructionsTypeCombo.root }),
      el('p', 'muted', ownerHint),
      el('h3', 'settings-section-title settings-section-title-spaced', 'Видимость'),
      showInactiveLabel,
      showTrashLabel,
      el('p', 'muted', 'Общая настройка для всех ваших клиентов в этой сети.'),
    );
    return root;
  }

  function renderClientSection(): HTMLElement {
    const root = div('settings-section');

    // Язык интерфейса (L5 `client_meta.lang`, задача 57f09136): выбор из
    // зарегистрированных каталогов (`lib/i18n.ts`) рядом с темой — обе
    // настройки клиентские и действуют на всех экранах.
    const langGroup = choiceGroup();
    for (const locale of availableLocales()) {
      langGroup.append(
        radioRow({
          label: locale.name,
          name: 'settings-lang',
          value: locale.code,
          checked: draft.lang === locale.code,
          onChange: (checked) => {
            if (!checked) return;
            draft.lang = locale.code;
            markDirty();
          },
        }).row,
      );
    }

    const themeGroup = choiceGroup();
    const lightOpt = radioRow({
      label: 'Светлая',
      name: 'settings-theme',
      value: 'light',
      checked: draft.theme === 'light',
    });
    const darkOpt = radioRow({
      label: 'Тёмная',
      name: 'settings-theme',
      value: 'dark',
      checked: draft.theme === 'dark',
    });
    for (const radio of [lightOpt.input, darkOpt.input]) {
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        draft.theme = radio.value as Theme;
        markDirty();
      });
    }
    themeGroup.append(lightOpt.row, darkOpt.row);

    const widthInput = fieldInput();
    widthInput.type = 'number';
    widthInput.min = String(CLOUD_WIDTH_MIN);
    widthInput.max = String(CLOUD_WIDTH_MAX);
    widthInput.value = String(draft.cloudWidth);
    widthInput.addEventListener('input', () => {
      draft.cloudWidth = Number(widthInput.value);
      markDirty();
    });

    const gapInput = fieldInput();
    gapInput.type = 'number';
    gapInput.min = String(CLOUD_GAP_MIN);
    gapInput.max = String(CLOUD_GAP_MAX);
    gapInput.value = String(draft.cloudGap);
    gapInput.addEventListener('input', () => {
      draft.cloudGap = Number(gapInput.value);
      markDirty();
    });

    root.append(
      el('h3', 'settings-section-title', t('settings.language')),
      langGroup,
      el('p', 'muted', t('settings.languageHint')),
      el('h3', 'settings-section-title settings-section-title-spaced', 'Тема'),
      themeGroup,
      el('p', 'muted', 'Применяется на всех экранах. Действует только на этом клиенте.'),
      el('h3', 'settings-section-title settings-section-title-spaced', 'Размер облачка'),
      fieldRow({ label: `Ширина облачка, px (${CLOUD_WIDTH_MIN}–${CLOUD_WIDTH_MAX})`, control: widthInput }),
      fieldRow({ label: `Отступ между облачками, px (${CLOUD_GAP_MIN}–${CLOUD_GAP_MAX})`, control: gapInput }),
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
    errorLine.clear();
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

    // Network: display_name + 4 markdown fields + both type_roles entries
    // (L2 / O5 / task ba024a45 / 0.7.2 `instructions` role).
    // One PATCH so the server-side update is a single transaction; partial
    // mismatches between client and server are tolerated because we always
    // send the full current draft for changed fields.
    const networkFieldsDirty =
      draft.networkName !== original.networkName ||
      draft.networkDescription !== original.networkDescription ||
      draft.networkWhenToUse !== original.networkWhenToUse ||
      draft.networkConventions !== original.networkConventions ||
      draft.networkExamples !== original.networkExamples ||
      draft.networkNodeSectionTypeId !== original.networkNodeSectionTypeId ||
      draft.networkInstructionsTypeId !== original.networkInstructionsTypeId;
    if (networkFieldsDirty) {
      // Merge the form's `type_roles` selections into the existing dictionary
      // so we never wipe roles the dialog doesn't expose. The server's PATCH
      // keeps absent keys, so only the entries we set are overwritten.
      const existingRoles = store.state.network?.type_roles ?? {};
      const fields: Parameters<typeof etn.networks.update>[1] = {
        display_name: draft.networkName.trim() || (store.state.network?.display_name ?? ''),
        description: draft.networkDescription.trim() === '' ? null : draft.networkDescription,
        when_to_use: draft.networkWhenToUse.trim() === '' ? null : draft.networkWhenToUse,
        conventions: draft.networkConventions.trim() === '' ? null : draft.networkConventions,
        examples: draft.networkExamples.trim() === '' ? null : draft.networkExamples,
        type_roles: {
          ...existingRoles,
          table_of_contents: draft.networkNodeSectionTypeId,
          instructions: draft.networkInstructionsTypeId,
        },
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

    // Network: show_trash (L3, задача 77923b49) — «Показывать содержимое
    // корзины». Тот же путь, что у show_inactive: preference → store →
    // перечитывание. Плюс перезапрос деревьев «Структур»: сервер прячет
    // помеченных в иерархии/рёбрах этого экрана, переключатель обязан
    // отработать без перезапуска.
    if (draft.showTrash !== original.showTrash) {
      tasks.push(
        (async () => {
          await etn.networks.setPreference(networkId, PREF_KEY.SHOW_TRASH, draft.showTrash);
          store.update({ showTrash: draft.showTrash });
          scheduleRefresh();
          scheduleStructuresRefresh();
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

    // Client: язык интерфейса (L5 `client_meta.lang`, задача 57f09136).
    // Как тема: применить сразу (каркас i18n + атрибут `lang` документа),
    // затем сохранить выбор.
    if (draft.lang !== original.lang) {
      tasks.push(
        (async () => {
          await etn.meta.set(CLIENT_META_KEY.LANG, draft.lang);
          applyLang(draft.lang);
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
    errorLine.clear();
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
      original.networkInstructionsTypeId = draft.networkInstructionsTypeId;
      original.showInactive = draft.showInactive;
      original.showTrash = draft.showTrash;
      original.theme = draft.theme;
      original.lang = draft.lang;
      original.cloudWidth = draft.cloudWidth;
      original.cloudGap = draft.cloudGap;
      refreshApplyButtons();
      renderContent();
      notice('Настройки сохранены.', 'success');
      if (thenClose) closeDialog();
    } catch (err) {
      errorLine.show(errText(err));
    } finally {
      setBusy(false);
    }
  }

  closeDialog = showDialog({
    title: 'Настройки',
    size: 'l',
    // Высота фиксируется ролью: разделы разной высоты (Пользователь / Мыслесеть
    // / Клиент / Логирование) при переключении больше не меняют высоту окна —
    // содержимое прокручивается в теле, футер остаётся на месте (требование
    // 13464c39, ошибка 0ab63eac). Левая навигация по разделам — по спеке
    // элемента «Единый диалог настроек», поэтому не заменяется вкладками.
    fixedHeight: true,
    body,
    customFooter: footer,
    extraShortcuts: {
      shiftEnter: () => void applyDraft(false),
    },
  });

  renderContent();
  refreshApplyButtons();
}

