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
 * - **Клиент** — язык приложения и `cloud_width` / `cloud_gap` (L4 `ui_state`),
 *   ограниченные системными константами.
 * - **Оформление** — тема интерфейса, режим (значения из профиля с
 *   офлайн-кэшем) и фоновая картинка карты. Контролы применяются сразу
 *   (ИСКЛЮЧЕНИЕ из draft-модели), но входят в «есть непринятые изменения»:
 *   «Применить» фиксирует их в снимке, «Отмена» откатывает к снимку (задача
 *   a6ad0143).
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
import { applyLang, unavailableLang } from '../lib/lang.js';
import { themeOptions } from '../lib/theme.js';
import {
  changeUiMode,
  changeUiTheme,
  getUiThemeState,
} from '../lib/ui-theme.js';
import {
  changeAppLanguage,
  getAppLanguageState,
  isLanguageApiSupported,
  refreshEffectiveLanguage,
} from '../lib/app-language.js';
import { buildEntityCombo } from '../lib/entity-picker.js';
import { etn } from '../lib/etn.js';
import { notice } from '../lib/notice.js';
import { clip } from '../lib/pure.js';
import { store } from '../state.js';
import type { LogsSectionState } from './settings-logs.js';
import { buildLogsSection } from './settings-logs.js';
import { scheduleStructuresRefresh } from './structures/structures.js';
import { uiButton } from '../lib/ui/button.js';
import { fieldInput, fieldRow, fieldSelect } from '../lib/ui/field.js';
import { checkboxRow, radioRow, choiceGroup } from '../lib/ui/choice-row.js';
import { chooseImageFile } from '../lib/image-source.js';
import {
  imagePickErrorText,
  wallpaperPrepareError,
  wallpaperUploadError,
} from '../lib/wallpaper-errors.js';
import { WALLPAPER_SOURCE_MAX_BYTES } from '../lib/wallpaper-image.js';
import { prepareWallpaper } from '../lib/wallpaper-prepare.js';
import {
  getWallpaperState,
  refreshWallpaper,
  removeWallpaper,
  subscribeWallpaper,
  uploadWallpaper,
} from '../lib/wallpaper-state.js';
import type { WallpaperState } from '../../main/ipc/contract.js';

/** Sections of the settings dialog (order in the sidebar). */
type Section = 'user' | 'network' | 'client' | 'appearance' | 'logs';

/** Title rendered above a section. Геттеры: текст берётся в момент рендера
 *  (ошибка ebed42d3). */
const SECTION_TITLES: Record<Section, string> = {
  get user() { return t('settings.user.user'); },
  get network() { return t('settings.network.mysleset'); },
  get client() { return t('settingsLogs.client'); },
  get appearance() { return t('settings.appearance'); },
  get logs() { return t('settings.logs.logging'); },
};

/** Tabs inside the «Мыслесеть» section (task O5). */
type NetworkTab = 'description' | 'when_to_use' | 'conventions' | 'examples';

const NETWORK_TAB_TITLES: Record<NetworkTab, string> = {
  get description() { return t('propertyManager.label.description'); },
  get when_to_use() { return t('settings.when_to_use.kogdaUse'); },
  get conventions() { return t('settings.conventions.pravila'); },
  get examples() { return t('settings.examples.examples'); },
};

/** Hint shown under an empty markdown field (mirrors the old textarea placeholder). */
const NETWORK_TAB_PLACEHOLDERS: Record<NetworkTab, string> = {
  get description() {
    return t('settings.naznachenieNetworkOdnomDvuhAbzacahUvidit');
  },
  get when_to_use() {
    return t('settings.kogdaAgentuObraschatsyaNetworkKazhdogoUse');
  },
  get conventions() {
    return t('settings.pravilaRecordsFormatHronologiyPometkaActive');
  },
  get examples() {
    return t('settings.examplesHoroshihPlohihRecordsToAgent');
  },
};

/** Maximum length of one network markdown field (task O5). */
const NETWORK_FIELDS_TEXT_MAX = 20_000;

/**
 * Варианты первого дня недели сети (требование 1b77decd): ISO 1 = понедельник
 * … 7 = воскресенье. Один список на диалог — значение уходит числом в тот же
 * `PATCH /networks/{id}`, что и остальные поля раздела.
 */
const FIRST_DAY_OF_WEEK_OPTIONS = [
  { value: '1', get label() { return t('settings.label.ponedelnik'); } },
  { value: '2', get label() { return t('settings.label.vtornik'); } },
  { value: '3', get label() { return t('settings.label.sreda'); } },
  { value: '4', get label() { return t('settings.label.chetverg'); } },
  { value: '5', get label() { return t('settings.label.pyatnica'); } },
  { value: '6', get label() { return t('settings.label.subbota'); } },
  { value: '7', get label() { return t('settings.label.voskresene'); } },
] as const;

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
  /** Первый день недели сети, ISO 1 = пн … 7 = вс (требование 1b77decd). */
  networkFirstDayOfWeek: number;
  showInactive: boolean;
  showTrash: boolean;
  /**
   * «Язык приложения» из профиля пользователя (ADR daab6ac4 §2–3, задачи
   * faba9ff4/222666db): `null` — «использовать язык сетей», иначе тег.
   */
  appLanguage: string | null;
  /**
   * Язык сети (ADR daab6ac4 §2): `null` — «использовать язык сервера».
   * Редактируется владельцем сети/администратором.
   */
  networkLanguage: string | null;
  /** Локальный выбор языка для старого сервера (L5 `client_meta.lang`). */
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
    networkFirstDayOfWeek:
      typeof net?.first_day_of_week === 'number' &&
      net.first_day_of_week >= 1 &&
      net.first_day_of_week <= 7
        ? net.first_day_of_week
        : 1,
    showInactive: store.state.showInactive,
    showTrash: store.state.showTrash,
    appLanguage: getAppLanguageState().language,
    networkLanguage: net?.language ?? null,
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
    a.networkFirstDayOfWeek !== b.networkFirstDayOfWeek ||
    a.showInactive !== b.showInactive ||
    a.showTrash !== b.showTrash ||
    a.appLanguage !== b.appLanguage ||
    a.networkLanguage !== b.networkLanguage ||
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
    appearance: el('button', 'settings-nav-item'),
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
  // Превью картинки обновляется подпиской уровня ДИАЛОГА: раздел «Оформление»
  // пересобирается при каждом переходе, и слушатель, заведённый в разделе,
  // копился бы на каждый переход. Снимается в `onClose`.
  let refreshWallpaperSection: (() => void) | null = null;
  const unsubscribeWallpaper = subscribeWallpaper(() => {
    refreshWallpaperSection?.();
    refreshApplyButtons();
  });

  body.append(nav, content);

  // -- footer ------------------------------------------------------------
  const footer = div('settings-footer');
  footer.append(
    el('span', 'settings-footer-hint', t('settings.shiftEnterApplyCtrlEnterApply')),
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
    onClick: () => void rollbackAndClose(() => closeDialog()),
  });
  btnCancel.title = t('actions.cancelShortcut', 'Esc');
  // Primary-действие — крайним справа (требование edc5faea): панель
  // кнопок диалога держит главное действие последним.
  btnGroup.append(btnApply, btnCancel, btnApplyClose);
  footer.append(btnGroup);

  // -- helpers -----------------------------------------------------------
  function setBusy(value: boolean): void {
    busy = value;
    btnCancel.disabled = value;
    for (const btn of Object.values(navButtons)) btn.disabled = value;
    // «Применить»/«Применить и закрыть» живут по признаку «есть непринятые
    // изменения», а не по признаку «идёт запись»: после снятия блокировки они
    // обязаны снова стать недоступными, если применять больше нечего (до
    // задачи a6ad0143 кнопки оставались активными после «Применить»).
    refreshApplyButtons();
  }

  function refreshApplyButtons(): void {
    const dirty = hasUnappliedChanges();
    btnApply.disabled = busy || !dirty;
    btnApplyClose.disabled = busy || !dirty;
  }

  function markDirty(): void {
    refreshApplyButtons();
  }

  // -- снимок мгновенных настроек (задача a6ad0143) ----------------------

  /** Текущее состояние тумблеров журналирования (обновляет раздел «Логирование»). */
  const logState: { client: boolean | null; server: boolean | null } = {
    client: null,
    server: null,
  };

  /**
   * Записи тумблеров журналирования в полёте (задача a6ad0143, гонка
   * «Отмены»): раздел сообщает последнее ЗАПРОШЕННОЕ значение сразу, а
   * фактическое на сервере определяется только по завершении записи. Откат
   * к снимку поэтому сначала ждёт этот хвост. Живёт на уровне диалога —
   * пересборка раздела при переходе по навигации не теряет начатые записи.
   */
  let logsWrites: Promise<void> = Promise.resolve();

  /** Учесть начатую запись тумблера: хвост ждёт и успех, и ошибку. */
  function trackLogsWrite(write: Promise<unknown>): void {
    const settled = write.then(
      () => undefined,
      () => undefined,
    );
    logsWrites = Promise.all([logsWrites, settled]).then(() => undefined);
  }

  /** Дождаться записей тумблеров, включая начатые во время ожидания. */
  async function waitLogsWrites(): Promise<void> {
    for (;;) {
      const tail = logsWrites;
      await tail;
      if (tail === logsWrites) return;
    }
  }

  /** Снимок картинки: «нет картинки» либо байты и метаданные прежней. */
  type WallpaperSnapshot =
    | { kind: 'none' }
    | {
        kind: 'ok';
        contentHash: string;
        dataUrl: string;
        mimeType: string;
        meta: import('@etn/shared').WallpaperMeta;
      };

  /**
   * Снимок «принятых» мгновенных настроек: тема, режим, картинка активной сети
   * и тумблеры журналирования. Берётся при открытии диалога и обновляется
   * каждым «Применить»; «Отмена» и «Не сохранять» возвращают состояние к нему.
   */
  interface SettingsSnapshot {
    theme: typeof store.state.uiTheme;
    mode: typeof store.state.theme;
    wallpaper: WallpaperSnapshot;
    clientLogging: boolean | null;
    serverLogging: boolean | null;
  }

  /** Снимок картинки из состояния главного процесса. */
  function wallpaperSnapshotOf(state: WallpaperState): WallpaperSnapshot {
    return state.status === 'ok'
      ? {
          kind: 'ok',
          contentHash: state.content_hash,
          dataUrl: state.data_url,
          mimeType: state.mime_type,
          meta: state.meta,
        }
      : { kind: 'none' };
  }

  /** Подпись картинки: хэш содержимого либо «нет картинки». */
  function wallpaperSignature(wallpaper: WallpaperSnapshot): string {
    return wallpaper.kind === 'ok' ? `ok:${wallpaper.contentHash}` : 'none';
  }

  /** Подпись текущей картинки (что реально показывает карта). */
  function currentWallpaperSignature(): string {
    return wallpaperSignature(wallpaperSnapshotOf(getWallpaperState()));
  }

  /** Снять текущее состояние мгновенных настроек. */
  function takeSnapshot(): SettingsSnapshot {
    return {
      theme: store.state.uiTheme,
      mode: store.state.theme,
      wallpaper: wallpaperSnapshotOf(getWallpaperState()),
      clientLogging: logState.client,
      serverLogging: logState.server,
    };
  }

  let snapshot: SettingsSnapshot = takeSnapshot();
  /**
   * Пользователь уже менял картинку: позднее чтение при открытии не должно
   * записать его свежую картинку в «принятый» снимок.
   */
  let wallpaperTouched = false;

  /**
   * Есть ли непринятые изменения в мгновенных разделах («Оформление»,
   * «Логирование»): выбранная тема/режим/картинка/тумблеры отличаются от
   * снимка.
   */
  function immediateDirty(): boolean {
    if (store.state.uiTheme !== snapshot.theme) return true;
    if (store.state.theme !== snapshot.mode) return true;
    if (currentWallpaperSignature() !== wallpaperSignature(snapshot.wallpaper)) return true;
    if (
      snapshot.clientLogging !== null &&
      logState.client !== null &&
      logState.client !== snapshot.clientLogging
    ) {
      return true;
    }
    if (
      snapshot.serverLogging !== null &&
      logState.server !== null &&
      logState.server !== snapshot.serverLogging
    ) {
      return true;
    }
    return false;
  }

  /** Общий признак «есть непринятые изменения»: черновик + мгновенные разделы. */
  function hasUnappliedChanges(): boolean {
    return isDirtyDraft(draft, original) || immediateDirty();
  }

  /**
   * Состояние тумблеров из раздела «Логирование». Первое известное значение
   * становится базой снимка (до загрузки раздела о журналах ничего не известно,
   * поэтому «изменено» не считается), следующие — сравниваются с ней.
   */
  function onLogsState(state: LogsSectionState): void {
    logState.client = state.client;
    logState.server = state.server;
    if (snapshot.clientLogging === null && state.client !== null) {
      snapshot.clientLogging = state.client;
    }
    if (snapshot.serverLogging === null && state.server !== null) {
      snapshot.serverLogging = state.server;
    }
    refreshApplyButtons();
  }

  /**
   * Дочитать снимок при открытии: свежая картинка активной сети из главного
   * процесса (сервер или локальный кэш). Если пользователь уже менял картинку,
   * его выбор не перетирается.
   */
  async function initSnapshot(): Promise<void> {
    const wallpaper = await refreshWallpaper().catch(() => getWallpaperState());
    if (!wallpaperTouched) snapshot.wallpaper = wallpaperSnapshotOf(wallpaper);
    refreshApplyButtons();
  }

  /** Байты из `data:`-URL картинки (главный процесс отдаёт base64). */
  function dataUrlBase64(dataUrl: string): string {
    const marker = ';base64,';
    const index = dataUrl.indexOf(marker);
    if (index < 0) throw new Error(t('settings.wallpaperRestoreFailed'));
    return dataUrl.slice(index + marker.length);
  }

  /**
   * Вернуть мгновенные настройки к снимку: тема, режим, картинка активной сети
   * (прежние байты загружаются обратно, загруженная при отсутствии прежней —
   * удаляется) и тумблеры журналирования.
   *
   * Откат тумблеров считается по ПОСЛЕДНЕМУ ЗАПРОШЕННОМУ значению и потому
   * сначала ждёт начатые записи (задача a6ad0143, гонка «Отмены»): без этого
   * «Отмена», нажатая во время записи, уходила параллельно ей и сервер
   * оставался с новым значением. Записи нет в полёте и фактическое значение
   * уже совпадает со снимком — лишнего запроса не отправляется.
   */
  async function rollbackImmediate(): Promise<void> {
    await waitLogsWrites();
    const tasks: Array<Promise<unknown>> = [];
    if (snapshot.theme !== store.state.uiTheme) tasks.push(changeUiTheme(snapshot.theme));
    if (snapshot.mode !== store.state.theme) tasks.push(changeUiMode(snapshot.mode));
    if (currentWallpaperSignature() !== wallpaperSignature(snapshot.wallpaper)) {
      if (snapshot.wallpaper.kind === 'none') {
        tasks.push(removeWallpaper());
      } else {
        tasks.push(
          uploadWallpaper({
            data_base64: dataUrlBase64(snapshot.wallpaper.dataUrl),
            mime_type: snapshot.wallpaper.mimeType,
            meta: snapshot.wallpaper.meta,
          }),
        );
      }
    }
    if (
      snapshot.clientLogging !== null &&
      logState.client !== null &&
      logState.client !== snapshot.clientLogging
    ) {
      tasks.push(etn.system.setClientLogging(snapshot.clientLogging));
    }
    if (
      snapshot.serverLogging !== null &&
      logState.server !== null &&
      logState.server !== snapshot.serverLogging
    ) {
      tasks.push(etn.system.setServerLogging(snapshot.serverLogging));
    }
    await Promise.all(tasks);
    // Откаченное состояние становится принятым: если откат прервался ошибкой,
    // повторное «Не сохранять» не переигрывает уже выполненные шаги.
    logState.client = snapshot.clientLogging ?? logState.client;
    logState.server = snapshot.serverLogging ?? logState.server;
    snapshot = takeSnapshot();
    wallpaperTouched = false;
  }

  /** «Отмена» и «Не сохранять»: откат к снимку, затем закрытие. */
  async function rollbackAndClose(close: () => void): Promise<void> {
    if (busy) return;
    setBusy(true);
    errorLine.clear();
    try {
      await rollbackImmediate();
      close();
    } catch (err) {
      // Откат не выполнен — закрывать нельзя: пользователь остался бы с
      // непринятым состоянием. Показываем причину и оставляем диалог открытым.
      errorLine.show(errText(err));
      renderContent();
      setBusy(false);
    }
  }


  function renderUserSection(): HTMLElement {
    const root = div('settings-section');

    const me = store.state.me;
    if (me === null) {
      root.append(el('p', 'muted', t('settings.profileNotLoaded')));
      return root;
    }

    const nameInput = fieldInput();
    nameInput.type = 'text';
    nameInput.value = draft.displayName;
    nameInput.maxLength = DISPLAY_NAME_MAX_LENGTH;
    nameInput.placeholder = t('settings.notZadano');
    nameInput.addEventListener('input', () => {
      draft.displayName = nameInput.value;
      markDirty();
    });

    const username = fieldInput();
    username.type = 'text';
    username.value = me.username;
    username.disabled = true;

    root.append(
      el('h3', 'settings-section-title', t('settings.profileUser')),
      fieldRow({ label: t('settings.label.nameOtobrazheniya'), control: nameInput }),
      fieldRow({ label: t('settings.label.login'), control: username }),
      el(
        'p',
        'muted',
        t('settings.nameOtobrazhaetsyaTulbareOtherMestahInterfeysa'),
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
    const me = store.state.me;
    const isOwner = store.state.network !== null && store.state.network.owner_id === me?.id;
    // Серверный PATCH /networks/{id} разрешён владельцу ИЛИ администратору
    // (06-auth.md §4.1), поэтому и поля раздела доступны тем же ролям.
    const canEditNetwork = isOwner || me?.is_admin === true;

    const nameInput = fieldInput();
    nameInput.type = 'text';
    nameInput.value = draft.networkName;
    nameInput.maxLength = 200;
    nameInput.disabled = !canEditNetwork;
    nameInput.addEventListener('input', () => {
      draft.networkName = nameInput.value;
      markDirty();
    });

    // Первый день недели сети (требование 1b77decd) — общая настройка всех
    // календарных виджетов и токенов `$weekStart`/`$weekEnd`. Значение уходит
    // тем же единым `PATCH`, что и остальные поля раздела.
    const firstDaySelect = fieldSelect({
      value: String(draft.networkFirstDayOfWeek),
      options: FIRST_DAY_OF_WEEK_OPTIONS,
      disabled: !canEditNetwork,
      onChange: (value) => {
        const next = Number(value);
        if (!Number.isInteger(next) || next < 1 || next > 7) return;
        draft.networkFirstDayOfWeek = next;
        markDirty();
      },
    });

    // Язык сети (ADR daab6ac4 §2, задача 222666db п. 2): «использовать язык
    // сервера» (null) или конкретный тег; меняет владелец/админ — тот же
    // `PATCH /networks/{id}`, что и остальные поля раздела. Старый сервер
    // контракта не знает — поле не показывается.
    const languageSupported = isLanguageApiSupported();
    const localeChoices = availableLocales();
    const networkLanguageOptions = [
      { value: '', label: t('settings.networkLanguageInherit') },
      ...localeChoices.map((locale) => ({ value: locale.code, label: locale.name })),
    ];
    if (
      draft.networkLanguage !== null &&
      !localeChoices.some((locale) => locale.code === draft.networkLanguage)
    ) {
      // Язык, заданный другим клиентом, не теряем и не подменяем: показываем
      // сам тег, пока пользователь не выберет другой.
      networkLanguageOptions.push({ value: draft.networkLanguage, label: draft.networkLanguage });
    }
    const networkLanguageSelect = languageSupported
      ? fieldSelect({
          value: draft.networkLanguage ?? '',
          options: networkLanguageOptions,
          disabled: !canEditNetwork,
          onChange: (value) => {
            draft.networkLanguage = value === '' ? null : value;
            markDirty();
          },
        })
      : null;

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
              disabled: !canEditNetwork,
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
      emptyLabel: t('settings.emptyLabel.notZadano'),
      placeholder: t('settings.placeholder.typeThought'),
      disabled: !canEditNetwork,
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
      emptyLabel: t('settings.emptyLabel.notZadano'),
      placeholder: t('settings.placeholder.typeThought'),
      disabled: !canEditNetwork,
      onChange: (typeId) => {
        draft.networkInstructionsTypeId = typeId;
        markDirty();
      },
    });

    const showInactiveRow = checkboxRow({
      label: t('settings.showNeaktualnyeThoughtLinkNetwork'),
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
      label: t('settings.showSoderzhimoeTrashNetwork'),
      checked: draft.showTrash,
      onChange: (checked) => {
        draft.showTrash = checked;
        markDirty();
      },
    });
    const showTrashLabel = showTrashRow.row;

    const ownerHint = canEditNetwork
      ? t('settings.theseFieldsZadaetOwnerNetworkAdmin')
      : t('settings.theseFieldsZadaetOwnerNetworkAdmin2');

    root.append(
      el('h3', 'settings-section-title', t('settings.settingsNetwork')),
      fieldRow({ label: t('networks.label.titleNetwork'), control: nameInput }),
      fieldRow({ label: t('settings.label.firstDenWeek'), control: firstDaySelect }),
      ...(networkLanguageSelect === null
        ? []
        : [
            fieldRow({
              label: t('settings.networkLanguage'),
              control: networkLanguageSelect,
            }),
            el('p', 'muted', t('settings.networkLanguageHint')),
          ]),
      el(
        'p',
        'muted',
        t('settings.commonSettingAllCalendarVidzhetovNetwork'),
      ),
      el(
        'p',
        'muted',
        t('settings.samoopisanieNetworkLyudeyAiAgentsMarkdown'),
      ),
      mdTabs.root,
      el(
        'p',
        'muted',
        t('settings.uzlovoyTypeRazdelaOpredelyaetStrukturuNetwork'),
      ),
      fieldRow({ label: t('settings.label.uzlovoyTypeRazdela'), control: typeCombo.root }),
      el(
        'p',
        'muted',
        t('settings.typeInstructionAgentsZadaetKakieThought'),
      ),
      fieldRow({ label: t('settings.label.typeInstructionAgents'), control: instructionsTypeCombo.root }),
      el('p', 'muted', ownerHint),
      el('h3', 'settings-section-title settings-section-title-spaced', t('settings.vidimost')),
      showInactiveLabel,
      showTrashLabel,
      el('p', 'muted', t('settings.commonSettingAllVashihKlientovNetwork')),
    );
    return root;
  }

  function renderClientSection(): HTMLElement {
    const root = div('settings-section');

    // «Язык приложения» (ADR daab6ac4 §2–3, задача 222666db п. 1): при
    // доступном сервере — «использовать язык сетей» или конкретный язык,
    // значение живёт в профиле пользователя и действует на всех его клиентах.
    // Старый сервер (0.15.1) не знает контракта: остаётся локальный выбор
    // `client_meta.lang` с пояснением (решение задачи faba9ff4 п. 5).
    const languageSupported = isLanguageApiSupported();
    const localeChoices = availableLocales();
    const langGroup = choiceGroup();
    if (languageSupported) {
      langGroup.append(
        radioRow({
          label: t('settings.languageInherit'),
          name: 'settings-app-lang',
          value: '',
          checked: draft.appLanguage === null,
          onChange: (checked) => {
            if (!checked) return;
            draft.appLanguage = null;
            markDirty();
          },
        }).row,
      );
      for (const locale of localeChoices) {
        langGroup.append(
          radioRow({
            label: locale.name,
            name: 'settings-app-lang',
            value: locale.code,
            checked: draft.appLanguage === locale.code,
            onChange: (checked) => {
              if (!checked) return;
              draft.appLanguage = locale.code;
              markDirty();
            },
          }).row,
        );
      }
      if (
        draft.appLanguage !== null &&
        !localeChoices.some((locale) => locale.code === draft.appLanguage)
      ) {
        // Тег без каталога в этой сборке (например, язык задан другим
        // клиентом) — показываем как есть, не подменяя выбор.
        langGroup.append(
          radioRow({
            label: draft.appLanguage,
            name: 'settings-app-lang',
            value: draft.appLanguage,
            checked: true,
          }).row,
        );
      }
    } else {
      for (const locale of localeChoices) {
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
    }

    // Текущий эффективный язык (ADR §2): показываем язык и ступень
    // наследования, чтобы модель «профиль → сеть → сервер» была видна.
    const effective = getAppLanguageState().effective;
    const effectiveNote =
      languageSupported && effective !== null
        ? el(
            'p',
            'muted',
            t('settings.languageEffective', [
              effective.language,
              t(`settings.languageSource.${effective.source}`),
            ]),
          )
        : null;
    // Сервер не поддерживает хранение языка в профиле (старый сервер).
    const localOnlyNote = languageSupported
      ? null
      : el('p', 'muted', t('settings.languageLocalOnly'));

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

    // Язык недоступен в сборке (задача e6374cd1): интерфейс уже на исходном
    // ru, но пользователь обязан увидеть, почему выбранный/унаследованный
    // язык не применился.
    const unavailable = unavailableLang();
    const unavailableNote =
      unavailable === null
        ? null
        : el('p', 'muted', t('settings.langUnavailable', unavailable));

    root.append(
      el('h3', 'settings-section-title', t('settings.language')),
      langGroup,
      el(
        'p',
        'muted',
        languageSupported ? t('settings.languageHintAllDevices') : t('settings.languageHint'),
      ),
      ...(effectiveNote === null ? [] : [effectiveNote]),
      ...(localOnlyNote === null ? [] : [localOnlyNote]),
      ...(unavailableNote === null ? [] : [unavailableNote]),
      el('h3', 'settings-section-title settings-section-title-spaced', t('settings.razmerOblachka')),
      fieldRow({ label: t('settings.shirinaOblachkaPx', [CLOUD_WIDTH_MIN, CLOUD_WIDTH_MAX]), control: widthInput }),
      fieldRow({ label: t('settings.otstupBetweenOblachkamiPx', [CLOUD_GAP_MIN, CLOUD_GAP_MAX]), control: gapInput }),
      el('p', 'muted', t('settings.hranitsyaOnlyClient')),
    );
    return root;
  }

  /**
   * Раздел «Оформление» (задача a6ad0143; элемент edc921ab, требование
   * 219d030c, задача 0e4a52cd): тема интерфейса, режим и фоновая картинка
   * карты. Вынесен из «Клиента» в самостоятельный раздел верхнего уровня,
   * поэтому собственного заголовка внутри не повторяет.
   *
   * Контролы применяются и сохраняются СРАЗУ (исключение из draft-модели), но
   * входят в признак «есть непринятые изменения»: «Применить» фиксирует их в
   * снимке, «Отмена» возвращает к снимку (задача a6ad0143).
   */
  function renderAppearanceSection(): HTMLElement {
    const root = div('settings-section');

    // Тема — fieldSelect из реестра `lib/theme.ts`, режим — переключатель из
    // двух опций. Строки — только из словаря, термины: «тема» — набор
    // значений, «режим» — тёмный/светлый.
    const themeSelect = fieldSelect({
      options: themeOptions(),
      value: store.state.uiTheme,
      onChange: (value) => {
        if (value === store.state.uiTheme) return;
        errorLine.clear();
        void changeUiTheme(value as Parameters<typeof changeUiTheme>[0]).then((synced) => {
          refreshUiThemeHints();
          refreshApplyButtons();
          if (!synced) errorLine.show(t('settings.uiThemeSyncDeferred'));
        });
        // Применение к store — синхронное: признак «изменено» обновляется сразу,
        // не дожидаясь ответа сервера.
        refreshApplyButtons();
      },
    });
    const modeGroup = choiceGroup();
    const modeRow = (mode: 'light' | 'dark'): HTMLElement => {
      const row = radioRow({
        label: mode === 'light' ? t('settings.uiMode.light') : t('settings.uiMode.dark'),
        name: 'settings-ui-mode',
        value: mode,
        checked: store.state.theme === mode,
        onChange: (checked) => {
          if (!checked) return;
          errorLine.clear();
          void changeUiMode(mode).then((synced) => {
            refreshUiThemeHints();
            refreshApplyButtons();
            if (!synced) errorLine.show(t('settings.uiThemeSyncDeferred'));
          });
          refreshApplyButtons();
        },
      });
      return row.row;
    };
    modeGroup.append(modeRow('dark'), modeRow('light'));
    // Подсказки — живой снимок серверного слоя: пересчитываются при открытии
    // раздела и после каждого выбора/ответа синхронизации (замечание проверки
    // 0e4a52cd). Пока сервер не ответил (`support: 'unknown'`), обещать
    // «хранится в профиле» или «сервер не поддерживает» нельзя — это догадка.
    const themeSupportHint = el('p', 'muted');
    const unknownThemeNote = el('p', 'muted');
    const deferredNote = el('p', 'muted');
    function refreshUiThemeHints(): void {
      const current = getUiThemeState();
      themeSupportHint.hidden = current.support === 'unknown';
      themeSupportHint.textContent = themeSupportHint.hidden
        ? ''
        : current.support === 'supported'
          ? t('settings.uiThemeHintAllDevices')
          : t('settings.uiThemeLocalOnly');
      unknownThemeNote.hidden = current.unknownTheme === null;
      unknownThemeNote.textContent =
        current.unknownTheme === null
          ? ''
          : t('settings.uiThemeUnknown', current.unknownTheme);
      deferredNote.hidden = !current.syncDeferred;
      deferredNote.textContent = current.syncDeferred ? t('settings.uiThemeSyncDeferred') : '';
    }
    refreshUiThemeHints();

    // «Фоновая картинка карты» (0.16.1, задача 80324150, элемент edc921ab):
    // «Загрузить…» → мини-превью 16:9 → «Убрать картинку». Как тема и
    // «Логирование» — ИСКЛЮЧЕНИЕ из draft-модели: картинка живёт на сервере и
    // применяется сразу. Ошибки — в закреплённом футере диалога (виден на
    // любом разделе).
    let wallpaperBusy = false;
    const wallpaperPreview = el('img', 'settings-wallpaper-preview');
    wallpaperPreview.alt = t('settings.wallpaperPreviewAlt');
    const wallpaperHintNote = el('p', 'muted');
    const wallpaperUploadBtn = uiButton({
      label: t('settings.wallpaperUpload'),
      role: 'secondary',
      size: 's',
      onClick: () => void pickWallpaper(),
    });
    const wallpaperRemoveBtn = uiButton({
      label: t('settings.wallpaperRemove'),
      role: 'secondary',
      size: 's',
      onClick: () => void dropWallpaper(),
    });
    const wallpaperBlock = div('settings-wallpaper');
    wallpaperBlock.append(wallpaperUploadBtn, wallpaperPreview, wallpaperRemoveBtn);

    function refreshWallpaperBlock(): void {
      const state = getWallpaperState();
      const has = state.status === 'ok';
      // Без открытой сети картинку не для чего выбирать: контролы недоступны.
      const hasNetwork = store.state.networkId !== null;
      wallpaperPreview.hidden = !has;
      wallpaperRemoveBtn.disabled = wallpaperBusy || !has || !hasNetwork;
      wallpaperUploadBtn.disabled = wallpaperBusy || !hasNetwork;
      if (has) wallpaperPreview.src = state.data_url;
      else wallpaperPreview.removeAttribute('src');
      // Подсказка называет только правило (задача a6ad0143): у каждой пары
      // «пользователь × сеть» своя картинка, имя сети в тексте не дублируется.
      wallpaperHintNote.textContent = hasNetwork
        ? t('settings.wallpaperHint')
        : t('settings.wallpaperHintNoNetwork');
      refreshApplyButtons();
    }
    refreshWallpaperSection = refreshWallpaperBlock;
    refreshWallpaperBlock();

    /** Выбор файла → подготовка (даунскейл/meta) → PUT → немедленное превью. */
    async function pickWallpaper(): Promise<void> {
      if (wallpaperBusy) return;
      errorLine.clear();
      const picked = await chooseImageFile({ maxBytes: WALLPAPER_SOURCE_MAX_BYTES });
      if (picked.status === 'cancel') return;
      if (picked.status === 'error') {
        errorLine.show(imagePickErrorText(picked));
        return;
      }
      wallpaperBusy = true;
      refreshWallpaperBlock();
      try {
        const prepared = await prepareWallpaper({
          data_url: picked.dataUrl,
          mime: picked.mime,
          size: picked.size,
        });
        if (prepared.status === 'error') {
          errorLine.show(wallpaperPrepareError(prepared.message));
          return;
        }
        await uploadWallpaper({
          data_base64: prepared.prepared.data_base64,
          mime_type: prepared.prepared.mime_type,
          meta: prepared.prepared.meta,
        });
        // Снимок «принятого» состояния не должен подхватить эту картинку:
        // иначе «Отмена» не вернёт прежнюю.
        wallpaperTouched = true;
      } catch (err) {
        errorLine.show(wallpaperUploadError(err));
      } finally {
        wallpaperBusy = false;
        refreshWallpaperBlock();
      }
    }

    /** «Убрать картинку»: без подтверждения — обратимо новой загрузкой. */
    async function dropWallpaper(): Promise<void> {
      if (wallpaperBusy) return;
      errorLine.clear();
      wallpaperBusy = true;
      refreshWallpaperBlock();
      try {
        await removeWallpaper();
        wallpaperTouched = true;
      } catch (err) {
        errorLine.show(errText(err));
      } finally {
        wallpaperBusy = false;
        refreshWallpaperBlock();
      }
    }

    root.append(
      fieldRow({ label: t('settings.uiTheme'), control: themeSelect }),
      themeSupportHint,
      unknownThemeNote,
      deferredNote,
      fieldRow({ label: t('settings.uiMode'), control: modeGroup }),
      fieldRow({ label: t('settings.wallpaper'), control: wallpaperBlock }),
      wallpaperHintNote,
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
    // Превью картинки обслуживает только живой раздел «Оформление»: ссылка на
    // разобранный раздел снимается при каждой пересборке.
    refreshWallpaperSection = null;
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
      case 'appearance':
        section = renderAppearanceSection();
        break;
      case 'logs':
        section = buildLogsSection({ onChange: onLogsState, onWrite: trackLogsWrite });
        break;
    }
    content.append(section);
  }

  // -- apply -------------------------------------------------------------
  async function applyDiff(): Promise<void> {
    const networkId = store.state.networkId;
    if (networkId === null) throw new Error(t('app.networkNotOpen'));

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

    // Network: display_name + first day of week + 4 markdown fields + both
    // type_roles entries (L2 / O5 / task ba024a45 / 0.7.2 `instructions` role /
    // требование 1b77decd). One PATCH so the server-side update is a single
    // transaction and one `network.updated`; partial mismatches between client
    // and server are tolerated because we always send the full current draft
    // for changed fields.
    const networkFieldsDirty =
      draft.networkName !== original.networkName ||
      draft.networkFirstDayOfWeek !== original.networkFirstDayOfWeek ||
      draft.networkDescription !== original.networkDescription ||
      draft.networkWhenToUse !== original.networkWhenToUse ||
      draft.networkConventions !== original.networkConventions ||
      draft.networkExamples !== original.networkExamples ||
      draft.networkNodeSectionTypeId !== original.networkNodeSectionTypeId ||
      draft.networkInstructionsTypeId !== original.networkInstructionsTypeId ||
      (isLanguageApiSupported() && draft.networkLanguage !== original.networkLanguage);
    if (networkFieldsDirty) {
      // Merge the form's `type_roles` selections into the existing dictionary
      // so we never wipe roles the dialog doesn't expose. The server's PATCH
      // keeps absent keys, so only the entries we set are overwritten.
      const existingRoles = store.state.network?.type_roles ?? {};
      const fields: Parameters<typeof etn.networks.update>[1] = {
        display_name: draft.networkName.trim() || (store.state.network?.display_name ?? ''),
        first_day_of_week: draft.networkFirstDayOfWeek,
        description: draft.networkDescription.trim() === '' ? null : draft.networkDescription,
        when_to_use: draft.networkWhenToUse.trim() === '' ? null : draft.networkWhenToUse,
        conventions: draft.networkConventions.trim() === '' ? null : draft.networkConventions,
        examples: draft.networkExamples.trim() === '' ? null : draft.networkExamples,
        type_roles: {
          ...existingRoles,
          table_of_contents: draft.networkNodeSectionTypeId,
          instructions: draft.networkInstructionsTypeId,
        },
        // Язык сети — только на сервере с контрактом языка (ADR §2); старый
        // сервер неизвестного ключа не получает.
        ...(isLanguageApiSupported() ? { language: draft.networkLanguage } : {}),
      };
      tasks.push(
        (async () => {
          const updated = await etn.networks.update(networkId, fields);
          store.update({ network: updated });
          // Смена языка сети применяется на лету у всех, кто наследует язык
          // сети (задача 222666db п. 2/4): перечитываем эффективный язык своей
          // пары, не дожидаясь WS-кадра.
          if (isLanguageApiSupported() && draft.networkLanguage !== original.networkLanguage) {
            await refreshEffectiveLanguage();
          }
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

    // Client: «язык приложения». При доступном сервере значение живёт в
    // профиле пользователя (ADR daab6ac4 §2–3, задача 222666db п. 1):
    // сохранение `PUT /users/me/settings/app_language` и живое применение
    // эффективного языка (для «наследовать» его резолвит сервер). Не удалось
    // сохранить — выбор применён локально как кэш, синхронизация отложена
    // (сценарий faba9ff4). Старый сервер — локальный выбор, как раньше.
    if (isLanguageApiSupported()) {
      if (draft.appLanguage !== original.appLanguage) {
        tasks.push(
          (async () => {
            const synced = await changeAppLanguage(draft.appLanguage);
            if (!synced) notice(t('settings.languageSyncDeferred'), 'error');
          })(),
        );
      }
    } else if (draft.lang !== original.lang) {
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
    if (!hasUnappliedChanges()) {
      if (thenClose) closeDialog();
      return;
    }
    setBusy(true);
    errorLine.clear();
    try {
      // Записи тумблеров в полёте: снимок фиксирует их фактический итог, а не
      // «последнее запрошенное» значение (задача a6ad0143).
      await waitLogsWrites();
      if (!hasUnappliedChanges()) {
        // Пока ждали запись, она могла не пройти — применять больше нечего.
        if (thenClose) closeDialog();
        return;
      }
      // Черновик разделов уходит на сервер только при реальных правках:
      // мгновенные настройки («Оформление», «Логирование») уже применены, и
      // «Применить» для них — фиксация снимка.
      if (isDirtyDraft(draft, original)) await applyDiff();
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
      original.networkFirstDayOfWeek = draft.networkFirstDayOfWeek;
      original.showInactive = draft.showInactive;
      original.showTrash = draft.showTrash;
      original.appLanguage = draft.appLanguage;
      original.networkLanguage = draft.networkLanguage;
      original.lang = draft.lang;
      original.cloudWidth = draft.cloudWidth;
      original.cloudGap = draft.cloudGap;
      // Мгновенные настройки приняты: снимок переезжает на текущее состояние,
      // кнопки снова недоступны, «Отмена» откатывает уже к нему.
      snapshot = takeSnapshot();
      wallpaperTouched = false;
      renderContent();
      notice(t('settings.settingsSaved'), 'success');
      if (thenClose) closeDialog();
    } catch (err) {
      errorLine.show(errText(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Подписи, которые не пересобираются `renderContent` (навигация и футер):
   * при смене языка они перечитываются из словаря вместе с содержимым раздела
   * (задача e6374cd1). Черновик формы живёт вне DOM, поэтому пересборка не
   * теряет введённые значения.
   */
  function updateTexts(): void {
    for (const key of Object.keys(navButtons) as Section[]) {
      navButtons[key].textContent = SECTION_TITLES[key];
    }
    btnApply.textContent = t('actions.apply');
    btnApply.title = t('actions.applyShortcut', 'Shift+Enter');
    btnApplyClose.textContent = t('actions.applyClose');
    btnApplyClose.title = t('actions.applyCloseShortcut', 'Ctrl+Enter');
    btnCancel.textContent = t('actions.cancel');
    btnCancel.title = t('actions.cancelShortcut', 'Esc');
  }

  closeDialog = showDialog({
    // Заголовок-функция: каркас перечитывает его при смене языка (e6374cd1).
    title: () => t('settings.title'),
    size: 'l',
    // Высота фиксируется ролью: разделы разной высоты (Пользователь / Мыслесеть
    // / Клиент / Оформление / Логирование) при переключении больше не меняют
    // высоту окна —
    // содержимое прокручивается в теле, футер остаётся на месте (требование
    // 13464c39, ошибка 0ab63eac). Левая навигация по разделам — по спеке
    // элемента «Единый диалог настроек», поэтому не заменяется вкладками.
    fixedHeight: true,
    body,
    customFooter: footer,
    // Ctrl/Cmd+Enter нажимает главную кнопку кастомного футера (задача
    // a6ad0143: каркас ждал primary только из `buttons`, поэтому подсказка
    // «Ctrl+Enter — применить и закрыть» была ложной).
    primaryButton: btnApplyClose,
    // Непринятые изменения (требование b58f6aad + задача a6ad0143): Esc/крестик
    // спрашивают подтверждение с семантикой «применить»; «Не сохранять»
    // возвращает мгновенные настройки к снимку и только потом закрывает диалог.
    dirty: {
      isDirty: hasUnappliedChanges,
      save: () => void applyDraft(true),
      discard: (close) => void rollbackAndClose(close),
      labels: {
        title: t('settings.unsaved.title'),
        message: t('settings.unsaved.message'),
        save: t('actions.apply'),
        discard: t('dialog.unsaved.discard'),
        stay: t('dialog.unsaved.stay'),
      },
    },
    extraShortcuts: {
      shiftEnter: () => void applyDraft(false),
    },
    // Живая смена языка (задача e6374cd1): открытый диалог перерисовывается
    // целиком, но значения полей берутся из черновика — ввод не теряется.
    onLangChange: () => {
      updateTexts();
      renderContent();
    },
    // Подписка на картинку живёт вместе с диалогом.
    onClose: () => {
      unsubscribeWallpaper();
      refreshWallpaperSection = null;
    },
  });

  renderContent();
  refreshApplyButtons();
  // Снимок дочитывается асинхронно: свежая картинка активной сети из главного
  // процесса (сервер или локальный кэш) — задача a6ad0143.
  void initSnapshot();
}

