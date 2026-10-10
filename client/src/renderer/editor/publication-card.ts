/**
 * Карточка публикации в панели редактора (0.11.1, задача b02ef1cf; элементы
 * интерфейса c3e44cab/2ebacd12, ADR eb687eea). Третий вариант цели панели
 * рядом с карточкой мысли и редактором связи; канв-специфичные механики для
 * этой цели не применяются (их отключает `editor.ts`).
 *
 * Устройство панели повторяет панель мысли (задача b02ef1cf): шапка в три
 * строки (иконка/обложка · заголовок · шестерёнка; подзаголовок; «актуально» ·
 * меню «Действия»), полоса вкладок и ленивые панели. Правки полей применяются
 * сразу (PATCH с `If-Match`, дебаунс), изменения видны документу и библиотеке;
 * realtime-события `publication.*` перечитывают карточку.
 *
 * Вкладки: «Резюме» (markdown-редактор), «Рецепт» (отбор разделов + свойства
 * текстов + доп. материалы + нумерация), «Вложения» (общая панель вложений,
 * точка входа «Сделать обложкой публикации»), «Метаданные».
 *
 * Разметка — фасады `lib/ui` (поля, кнопки, вкладки, чипы, сплиттер),
 * `lib/dialog.ts`; списки — только компонент списка `lib/ui/list.ts` над
 * `nav-core` (ADR fadf99e0); строки — из словаря `t()`.
 */

import type {
  Attachment,
  AttachmentOwnerRef,
  NetworkProperty,
  Publication,
  PublicationUpdateInput,
  Shelf,
  ThoughtRef,
} from '@etn/shared';

import { createMdEditor } from './md-editor.js';
import { buildAttachmentsPane, isIconOwnerBlock } from './attachments.js';
import { createMarkdownField, etnimgUrl, setMarkdownField } from './markdown-field.js';
import { commentShell } from '../lib/ui/comment.js';
import { createThoughtCloud, type ThoughtCloudInput } from '../lib/thought-cloud.js';
import { createPublicationCloud } from '../lib/ui/publication-cloud.js';
import { renderMarkdown } from '@etn/markdown';
import { div, span } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { svgIcon } from '../lib/ui/icon.js';
import { etn } from '../lib/etn.js';
import { showDialog, errorDialog, confirmDialog } from '../lib/dialog.js';
import { menuAction, showMenuAt } from '../lib/menu.js';
import { uiButton, iconButton } from '../lib/ui/button.js';
import { uiTabs, type TabsHandle } from '../lib/ui/tabs.js';
import { fieldInput, fieldRow, fieldTextarea } from '../lib/ui/field.js';
import { fieldError } from '../lib/ui/messages.js';
import { checkboxRow } from '../lib/ui/choice-row.js';
import { loadingState } from '../lib/ui/empty-state.js';
import { notice } from '../lib/notice.js';
import {
  createResourcePicker,
  urlSourceTab,
  type ResourceSourceContext,
} from './resource-picker.js';
import {
  attachmentPickerSourceTab,
  type AttachmentPick,
  type AttachmentPickerRow,
} from './attachment-picker.js';
import {
  commitEntity,
  getEntity,
  invalidateAfterMutation,
  invalidateQueries,
  onQueryInvalidated,
  queryKeys,
  registerQuery,
} from '../lib/live/index.js';
import {
  buildEntityChipField,
  filterEntityOptions,
  type EntityChipField,
  type EntityOption,
} from '../lib/entity-picker.js';
import { buildMetadataBlock } from '../lib/metadata.js';
import { store } from '../state.js';
import { buildCover } from '../screens/publications/cover.js';
import {
  assemblyDateLabel,
  shelfSwapUpdates,
} from '../screens/publications/model.js';
import {
  buildRecipeBuilder,
  loadPropertyRegistry,
  loadPropertyRows,
  propertyChipTitles,
  propertyEntityOptions,
  type RecipeBuilder,
} from '../screens/publications/recipe.js';

/**
 * Тестовый шов: фабрика markdown-редактора, фабрика/запись поля резюме и
 * применение данных к карточке. `createMdEditor` и поле резюме поднимают
 * CodeMirror, которому нужен реальный DOM (`Range`, `getSelection`), — в
 * DOM-шиме клиентских тестов он не исполняется (прецедент — `mdEditorInternals`
 * в `md-editor.ts`). `apply` выставлен для тестов realtime-обновления резюме:
 * в DOM-шиме ветка «та же цель — `apply` на месте» в `showPublicationTarget`
 * недостижима (у шима нет `parentElement`).
 */
export const publicationCardInternals = {
  createMdEditor,
  /** Тестовый шов: фабрика поля резюме (общая `createMarkdownField`). */
  createSummaryField: (opts: Parameters<typeof createMarkdownField>[0]): HTMLElement =>
    createMarkdownField(opts),
  /** Тестовый шов: запись markdown в поле резюме (общий `setMarkdownField`). */
  setSummaryField: (field: HTMLElement, md: string, html: string): void =>
    setMarkdownField(field, md, html),
  apply,
  /** Тестовый шов: пересборка — теперь пункт меню «Действия», не кнопка. */
  rebuild: (): void => void rebuildPublication(),
  /** Тестовый шов: активировать вкладку карточки (ленивые панели). */
  activateTab: (id: string): void => tabsHandleRef?.setActive(id),
  /** Тестовый шов: открыть диалог выбора обложки (поведение списка/навигации). */
  openCoverDialog: (): void => void openCoverDialog(),
  /** Тестовый шов: сбросить запомненную вкладку карточки (сеансовое состояние). */
  resetTab: (): void => {
    publicationTabId = null;
  },
};

/** Что редактор передаёт карточке для отрисовки. */
export interface PublicationCardHost {
  /** Контейнер содержимого панели (`editor-scroll`). */
  scrollBox: HTMLElement;
}

/** Живая карточка (одна на панель). */
interface CardInstance {
  root: HTMLElement;
  publicationId: string;
  publication: Publication | null;
  unsub: () => void;
}

let instance: CardInstance | null = null;
/**
 * Подписка карточки на слой данных (G4 тех.проекта 269016e2): снимок
 * `pub-card:@id` и список вложений `attachments:@publication:@id`. Чужие
 * события роутер гасит этими ключами, свои правки кладут результат в кэш
 * (`commitEntity`) и инвалидируют их — один путь для своих и чужих изменений.
 */
let layerUnsub: (() => void) | null = null;
let saveTimer: number | null = null;
let pendingChanges: PublicationUpdateInput = {};
let suppressFieldEvents = false;
/** Хост миниатюры обложки в шапке (клик — диалог обложки). */
let coverThumbRef: HTMLElement | null = null;
/** Полоса вкладок карточки (тестовый шов и интеграция). */
let tabsHandleRef: TabsHandle | null = null;
/**
 * Выбранная пользователем вкладка карточки публикации: переживает переключение
 * публикаций (как у мыслей), но не сеанс — сбрасывается при перезапуске, т.к.
 * живёт только в памяти (замечание Г приёмки b02ef1cf).
 */
let publicationTabId: string | null = null;
/** Кнопка «Действия» и хост прелоадера пересборки (ошибка c2dec45c). */
let rebuildButtonRef: HTMLButtonElement | null = null;
let rebuildFeedbackRef: HTMLElement | null = null;
/** Кэш полок для диалога настроек. */
let allShelvesCache: Shelf[] = [];
const updaters: Array<(publication: Publication) => void> = [];

/** Сброс карточки при смене цели/пересборке рабочего пространства. */
export function disposePublicationCard(): void {
  layerUnsub?.();
  layerUnsub = null;
  instance?.unsub();
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = null;
  // Не теряем отложенные правки при закрытии/смене цели: досылаем их
  // fire-and-forget ДО обнуления `instance` (ошибка 82aada28). `flushSave`
  // синхронно забирает `pendingChanges`, поэтому после сброса терять нечего;
  // поздний `apply` ответа уже no-op (`instance` равен null).
  if (instance !== null && Object.keys(pendingChanges).length > 0) void flushSave();
  instance = null;
  pendingChanges = {};
  updaters.length = 0;
  coverThumbRef = null;
  tabsHandleRef = null;
  rebuildButtonRef = null;
  rebuildFeedbackRef = null;
  allShelvesCache = [];
}

/**
 * Показывает публикацию в панели редактора. Та же публикация — обновление
 * значений на месте; ДРУГАЯ — переадресация БЕЗ пересоздания узла карточки:
 * содержимое перестраивается внутри уже стоящего в панели корня (замечание 7
 * приёмки 5de0332d — убрать «дёргание» при переключении публикаций, как это
 * сделано для переключения мыслей в `editor.ts`).
 */
export function showPublicationTarget(
  host: PublicationCardHost,
  publicationId: string,
  publication: Publication | undefined,
): void {
  if (instance !== null && instance.root.parentElement === host.scrollBox) {
    if (instance.publicationId !== publicationId) {
      retargetPublicationCard(publicationId);
    }
    if (publication !== undefined) apply(publication);
    else if (instance.publication === null) void refreshFromServer();
    return;
  }
  disposePublicationCard();
  const root = buildCard();
  host.scrollBox.append(root);
  instance = {
    root,
    publicationId,
    publication: publication ?? null,
    unsub: () => undefined,
  };
  bindCardSubscriptions(publicationId);
  // Наполнение — ПОСЛЕ регистрации `instance` (ошибка ecad219b). Панели вкладок
  // строятся лениво, активная («Резюме») собирается ещё внутри `buildCard`,
  // когда `instance` равен `null`, поэтому `apply` до этой строки был бы no-op.
  // Данные пришли сразу — применяем синхронно, иначе перечитываем сервер.
  if (publication !== undefined) apply(publication);
  else void refreshFromServer();
  // Счётчик вкладки «Вложения» — сразу при показе карточки (бейдж, как у
  // панели мысли): вкладка ленивая, поэтому число берём отдельным запросом.
  void refreshAttachmentsCount();
}

/**
 * Переадресация на другую публикацию в ТОМ ЖЕ узле карточки: узел не
 * пересоздаётся (нет мигания панели), а его содержимое собирается заново под
 * новый id. Вынесено из {@link showPublicationTarget} ради единой точки
 * смены владельца карточки.
 */
function retargetPublicationCard(publicationId: string): void {
  const root = instance?.root ?? null;
  if (root === null) return;
  // Отпускаем подписки/состояние прежней публикации (недоотправленные правки
  // досылаются), но НЕ трогаем сам узел `root`.
  disposePublicationCard();
  const fresh = buildCard();
  while (root.firstChild !== null) root.removeChild(root.firstChild);
  while (fresh.firstChild !== null) root.append(fresh.firstChild);
  instance = {
    root,
    publicationId,
    publication: null,
    unsub: () => undefined,
  };
  bindCardSubscriptions(publicationId);
  void refreshAttachmentsCount();
}

/**
 * Слой данных (G4 тех.проекта 269016e2): карточка живёт на ключах
 * `pub-card:@id` и `attachments:@publication:@id`. Чужие события роутер гасит
 * этими ключами; свои правки (PATCH/пересборка/вложение) кладут результат в
 * нормализованный кэш и инвалидируют ключи — подписчик один и тот же.
 */
function bindCardSubscriptions(publicationId: string): void {
  registerQuery(queryKeys.publicationCard(publicationId), null);
  registerQuery(queryKeys.attachments('publication', publicationId), null);
  layerUnsub = onQueryInvalidated((prefix) => {
    if (instance === null) return;
    const id = instance.publicationId;
    if (prefix === queryKeys.publicationCard(id)) {
      // Свежий ПОЛНЫЙ снимок из кэша (его кладут карточка/рабочая область через
      // `commitEntity`); нет записи — перечитываем сервер.
      const cached = getEntity<Publication>('publication', id);
      if (cached !== undefined && cached !== null) apply(cached);
      else void refreshFromServer();
      return;
    }
    if (prefix === queryKeys.attachmentsAll() || prefix === queryKeys.attachments('publication', id)) {
      void refreshAttachmentsCount();
    }
  });
}

/**
 * Перечитывает число вложений публикации и обновляет бейдж `(N)` вкладки
 * «Вложения». Записи вложений кладём в нормализованный кэш слоя — по ним
 * роутер разрешает владельца событий `attachment.updated/deleted`, несущих
 * только id (тот же приём, что у счётчика панели мысли, `editor/attachments.ts`).
 */
async function refreshAttachmentsCount(): Promise<void> {
  const networkId = store.state.networkId;
  const publicationId = instance?.publicationId ?? null;
  if (networkId === null || publicationId === null) return;
  try {
    const items = await etn.attachments.list(networkId, 'publication', publicationId);
    // Цель могла смениться, пока ответ был в пути.
    if (instance?.publicationId !== publicationId || tabsHandleRef === null) return;
    for (const item of items) commitEntity('attachment', item.id, item);
    tabsHandleRef.setCount('attachments', items.length);
  } catch {
    tabsHandleRef?.setCount('attachments', undefined);
  }
}

/** Перечитывает публикацию и применяет значения к карточке. */
async function refreshFromServer(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || instance === null) return;
  try {
    const publication = await etn.publications.get(networkId, instance.publicationId);
    commitEntity('publication', publication.id, publication);
    apply(publication);
  } catch {
    // Публикация могла быть удалена — карточка остаётся как есть.
  }
}

/** Применяет данные публикации к построенным панелям. */
function apply(publication: Publication): void {
  if (instance === null) return;
  // Чужая публикация не должна трогать карточку (ошибка 82aada28): ответ
  // отложенного PATCH или устаревший снимок store при смене цели иначе
  // применялся бы к новой карточке и уводил следующие правки в чужой id.
  if (publication.id !== instance.publicationId) return;
  instance.publication = publication;
  suppressFieldEvents = true;
  try {
    for (const update of updaters) update(publication);
  } finally {
    suppressFieldEvents = false;
  }
  syncStorePublication(publication);
}

/**
 * Синхронизирует снимок публикации в store (ошибка 82aada28). Без этого
 * следующий тик store отдаёт устаревшее значение через ветку «та же цель»,
 * поля откатываются, а сохранение уходит со старой `version` → CONFLICT.
 * `version` не участвует в подписи редактора (`editor.ts`), поэтому запись не
 * пересобирает карточку и не теряет фокус.
 */
function syncStorePublication(publication: Publication): void {
  const target = store.state.editorTarget;
  if (target === null || target.kind !== 'publication' || target.id !== publication.id) return;
  if (target.publication?.version === publication.version) return;
  store.update({ editorTarget: { kind: 'publication', id: publication.id, publication } });
}

/** id показываемой публикации (карточка либо цель редактора). */
function currentPublicationId(): string | null {
  if (instance !== null) return instance.publicationId;
  const target = store.state.editorTarget;
  return target !== null && target.kind === 'publication' ? target.id : null;
}

// ---------------------------------------------------------------------------
// Каркас: шапка в три строки + вкладки
// ---------------------------------------------------------------------------

function buildCard(): HTMLElement {
  const root = div('pub-card-editor');
  // Шапка — тот же каркас, что у панели мысли (коммит-фикс по замечанию
  // пользователя): `editor-fields` > `editor-top-row` / `editor-header-row`.
  // Так карточка наследует готовые отступы, высоты и поведение строк без
  // собственного CSS под роли.
  const head = div('editor-fields');

  // --- Строка 1: иконка-обложка · заголовок · ⚙ (Настройки) ----------------
  const topRow = div('editor-top-row');
  const thumbButton = document.createElement('button');
  thumbButton.type = 'button';
  thumbButton.className = 'editor-icon-box';
  thumbButton.title = t('publication.action.changeCover');
  thumbButton.setAttribute('aria-label', t('publication.action.changeCover'));
  const thumbHost = div('pub-card-editor-thumb');
  coverThumbRef = thumbHost;
  thumbButton.append(thumbHost);
  thumbButton.addEventListener('click', () => void openCoverDialog());

  const titleArea = fieldTextarea({
    id: 'pub-card-title',
    extraClass: 'editor-title-input',
    bare: true,
    placeholder: t('publication.field.titlePlaceholder'),
  }) as HTMLTextAreaElement;
  titleArea.rows = 1;
  const resizeTitle = (): void => {
    titleArea.style.height = 'auto';
    titleArea.style.height = `${titleArea.scrollHeight}px`;
  };
  titleArea.addEventListener('input', () => {
    resizeTitle();
    queueSave({ title: titleArea.value });
  });
  titleArea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      titleArea.blur();
    }
  });

  const settingsButton = iconButton({
    icon: svgIcon('settings', 14),
    title: t('publication.settings'),
    onClick: () => openSettingsDialog(),
  });
  topRow.append(thumbButton, titleArea, settingsButton);

  // --- Строка 2: подзаголовок на всю ширину --------------------------------
  const subtitleInput = fieldInput({
    id: 'pub-card-subtitle',
    extraClass: 'pub-card-editor-subtitle',
    placeholder: t('publication.field.subtitlePlaceholder'),
  });
  subtitleInput.addEventListener('input', () =>
    queueSave({ subtitle: emptyToNull(subtitleInput.value) }),
  );

  // --- Строка 3: «актуально» · меню «Действия» (одна строка) ---------------
  const row3 = div('editor-header-row');
  const activeRow = checkboxRow({ label: t('publication.status.active') });
  activeRow.input.addEventListener('change', () => queueSave({ active: activeRow.input.checked }));
  const actionsButton = uiButton({
    label: `${t('publication.actions')} ▾`,
    role: 'secondary',
    size: 's',
    onClick: () => openActionsMenu(),
  });
  actionsButton.type = 'button';
  rebuildButtonRef = actionsButton;
  const rebuildFeedback = div('pub-card-rebuild-state hidden');
  rebuildFeedbackRef = rebuildFeedback;
  row3.append(activeRow.row, actionsButton, rebuildFeedback);

  head.append(topRow, subtitleInput, row3);

  const tabs = uiTabs({
    tabs: [
      { id: 'summary', label: t('publication.tab.summary'), content: () => buildSummaryPane() },
      { id: 'recipe', label: t('publication.tab.recipe'), content: () => buildRecipePane() },
      {
        id: 'attachments',
        label: t('publication.tab.attachments'),
        content: () => buildAttachmentsTabPane(),
      },
      { id: 'meta', label: t('publication.tab.meta'), content: () => buildMetaPane() },
    ],
    // Выбранная вкладка переживает переключение публикаций (как у мыслей), но
    // НЕ сеанс: состояние — module-level, живёт до перезапуска (замечание Г
    // приёмки b02ef1cf).
    ...(publicationTabId !== null ? { activeId: publicationTabId } : {}),
    onChange: (id) => {
      publicationTabId = id;
    },
  });
  tabsHandleRef = tabs;

  root.append(head, tabs.root);

  updaters.push((p) => {
    titleArea.value = p.title;
    resizeTitle();
    subtitleInput.value = p.subtitle ?? '';
    activeRow.input.checked = p.active;
    renderCoverPreview(p);
  });
  queueMicrotask(resizeTitle);
  // Здесь `apply` НЕ вызывается: `instance` ещё не зарегистрирован (это делает
  // `showPublicationTarget` сразу после возврата `buildCard`). Наполнение
  // выполняет вызывающий.
  return root;
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Миниатюра обложки в шапке (клик по ней открывает диалог выбора обложки). */
function renderCoverPreview(publication: Publication): void {
  const host = coverThumbRef;
  if (host === null) return;
  while (host.firstChild !== null) host.removeChild(host.firstChild);
  // Заглушка сразу — картинка подменяет её после резолва вложения. Протокол
  // `etnimg` служит по ПУТИ файла, поэтому id обложки резолвим в `file_path`
  // запросом вложения (у публикации есть только id).
  host.append(buildCover(publication, 'thumb'));
  if (publication.cover_kind !== 'attachment' || publication.cover_attachment_id === null) return;
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const coverId = publication.cover_attachment_id;
  void etn.attachments
    .get(networkId, coverId)
    .then((attachment) => {
      if (attachment.file_path === null || attachment.file_path === '') return;
      if (coverThumbRef !== host) return;
      const img = document.createElement('img');
      img.className = 'pub-cover-img';
      img.alt = '';
      img.addEventListener('load', () => {
        if (coverThumbRef !== host) return;
        while (host.firstChild !== null) host.removeChild(host.firstChild);
        host.append(img);
      });
      img.src = etnimgUrl(attachment.file_path);
    })
    .catch(() => undefined);
}

/** Текущая публикация карточки (для диалогов и меню). */
function currentPublication(): Publication | null {
  return instance?.publication ?? null;
}

// ---------------------------------------------------------------------------
// Меню «Действия»
// ---------------------------------------------------------------------------

function openActionsMenu(): void {
  const button = rebuildButtonRef;
  if (button === null) return;
  const rect = button.getBoundingClientRect();
  showMenuAt(rect.left, rect.bottom, [
    menuAction(t('publication.action.changeCover'), () => void openCoverDialog()),
    menuAction(t('publication.action.findOnShelf'), () => void findOnShelf()),
    menuAction(t('publication.action.rebuild'), () => void rebuildPublication()),
    menuAction(t('publication.action.copy'), () => void copyPublicationLink()),
    menuAction(t('publication.action.copyId'), () => void copyPublicationId()),
  ]);
}

/** «Найти на полке»: активизирует экран «Публикации» и делает публикацию текущей. */
async function findOnShelf(): Promise<void> {
  const id = currentPublicationId();
  if (id === null) return;
  const { revealPublicationInLibrary } = await import('../screens/publications/publications.js');
  await revealPublicationInLibrary(id);
}

/** «Копировать»: ссылка на публикацию в текстовом формате ссылки мысли. */
async function copyPublicationLink(): Promise<void> {
  const id = currentPublicationId();
  if (id === null) return;
  try {
    await navigator.clipboard.writeText(`[[#pub:${id}]]`);
    notice(t('publication.copy.linkDone'));
  } catch {
    notice(t('publication.copy.failed'), 'error');
  }
}

/** «Копировать ID». */
async function copyPublicationId(): Promise<void> {
  const id = currentPublicationId();
  if (id === null) return;
  try {
    await navigator.clipboard.writeText(id);
    notice(t('publication.copy.idDone'));
  } catch {
    notice(t('publication.copy.failed'), 'error');
  }
}

// ---------------------------------------------------------------------------
// Вкладка «Резюме»
// ---------------------------------------------------------------------------

/**
 * Вкладка «Резюме»: общая оболочка комментария (`commentShell`) с полем
 * markdown — просмотр/правка, двойной клик входит в правку, blur и Ctrl+Enter
 * сохраняют и возвращают в просмотр, Esc отменяет (замечание Б приёмки
 * b02ef1cf). Своё «голое» поле нарушало роль дизайн-системы и не давало
 * режима просмотра — правку легко было затереть.
 */
function buildSummaryPane(): HTMLElement {
  const pane = div('pub-card-pane pub-card-summary-pane');
  const shell = commentShell({ variant: 'plain' });
  pane.append(shell.root);
  let field: HTMLElement | null = null;
  let editing = false;
  // Последнее значение резюме, с которым поле синхронизировано (baseline).
  // Позволяет `apply` перечитывать резюме при realtime-обновлении, не затирая
  // незавершённый пользовательский ввод (ошибка 6f013e67).
  let summarySynced = '';

  /** Немедленное сохранение резюме (Ctrl+Enter/blur) и HTML для просмотра. */
  const saveSummary = async (value: string): Promise<string> => {
    pendingChanges = { ...pendingChanges, summary_md: emptyToNull(value) };
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    await flushSave();
    summarySynced = value;
    return renderMarkdown(value);
  };

  const buildField = (): void => {
    const ownerId = instance?.publicationId ?? currentPublicationId() ?? '';
    field = publicationCardInternals.createSummaryField({
      md: summarySynced,
      html: renderMarkdown(summarySynced),
      placeholder: t('publication.summary.placeholder'),
      attachmentsOwner: { ownerType: 'publication', ownerId },
      onSave: saveSummary,
      onEditChange: (next) => {
        editing = next;
        shell.setMode(next ? 'edit' : 'view');
      },
    });
    shell.setField(field);
  };

  updaters.push((p) => {
    const serverSummary = p.summary_md ?? '';
    if (field === null) {
      summarySynced = serverSummary;
      buildField();
      return;
    }
    // Незавершённый ввод не затираем (ошибка 6f013e67).
    if (editing || serverSummary === summarySynced) return;
    summarySynced = serverSummary;
    publicationCardInternals.setSummaryField(field, serverSummary, renderMarkdown(serverSummary));
  });
  if (instance?.publication != null) apply(instance.publication);
  return pane;
}

// ---------------------------------------------------------------------------
// Вкладка «Рецепт»
// ---------------------------------------------------------------------------

/** Крупная группа вкладки «Рецепт»: заголовок + бледная подсказка + тело. */
function recipeGroup(title: string, hint: string): { root: HTMLElement; body: HTMLElement } {
  const root = div('pub-card-recipe-group');
  const body = div('pub-card-recipe-group-body');
  root.append(
    span(title, 'pub-card-recipe-group-title'),
    span(hint, 'pub-card-recipe-group-hint'),
    body,
  );
  return { root, body };
}

function buildRecipePane(): HTMLElement {
  const pane = div('pub-card-pane pub-card-recipe-pane');

  // 1. ОТБОР РАЗДЕЛОВ: конструктор отбора («Родительские мысли» — первым) +
  //    нумерация уровней разделов.
  const selectGroup = recipeGroup(
    t('publication.recipe.group.select'),
    t('publication.recipe.group.selectHint'),
  );
  const recipeHost = div('pub-card-recipe');
  const numberingBlock = div('pub-card-numbering');
  numberingBlock.append(
    span(t('publication.recipe.group.numbering'), 'pub-card-numbering-title'),
  );
  const numberRow = div('pub-card-numbering-row');
  const fromInput = fieldInput({ type: 'number', min: 1, id: 'pub-card-num-from' });
  const toInput = fieldInput({ type: 'number', min: 1, id: 'pub-card-num-to' });
  const onNumber = (): void => {
    if (suppressFieldEvents) return;
    queueSave({
      numbering_from: intOrNull(fromInput.value),
      numbering_to: intOrNull(toInput.value),
    });
  };
  fromInput.addEventListener('change', onNumber);
  toInput.addEventListener('change', onNumber);
  numberRow.append(
    fieldRow({ label: t('publication.field.numberingFrom'), control: fromInput, id: 'pub-card-num-from' }),
    fieldRow({ label: t('publication.field.numberingTo'), control: toInput, id: 'pub-card-num-to' }),
  );
  numberingBlock.append(numberRow);
  selectGroup.body.append(recipeHost, numberingBlock);
  pane.append(selectGroup.root);

  // 2. СВОЙСТВА С СОДЕРЖИМЫМ РАЗДЕЛОВ (text_sources) и
  // 3. ДОПОЛНИТЕЛЬНЫЕ МАТЕРИАЛЫ (extra_properties).
  const textsGroup = recipeGroup(
    t('publication.recipe.group.texts'),
    t('publication.recipe.group.textsHint'),
  );
  const textsHost = div('pub-card-texts');
  const textsError = fieldError('');
  textsError.classList.add('hidden');
  textsGroup.body.append(textsHost, textsError);

  const extrasGroup = recipeGroup(
    t('publication.recipe.group.extras'),
    t('publication.recipe.group.extrasHint'),
  );
  const extrasHost = div('pub-card-extras');
  const extrasError = fieldError('');
  extrasError.classList.add('hidden');
  extrasGroup.body.append(extrasHost, extrasError);
  pane.append(textsGroup.root, extrasGroup.root);

  let builder: RecipeBuilder | null = null;
  /** Любая правка формы рецепта — в отложенное сохранение (ошибка 82aada28). */
  const onRecipeChange = (): void => {
    if (builder !== null) queueSave({ title_recipe: builder.getDefinition() });
  };

  const networkId = store.state.networkId;
  let registry: Map<string, NetworkProperty> | null = null;
  let textSources: string[] = [];
  let extraProperties: string[] = [];
  let textsField: EntityChipField | null = null;
  let extrasField: EntityChipField | null = null;

  /** Пересечение источников текстов и доп. материалов — ошибка настройки. */
  const checkOverlap = (): void => {
    const shared = textSources.filter((id) => extraProperties.includes(id));
    const invalid = shared.length > 0;
    const message = invalid ? t('publication.recipe.overlap') : '';
    textsError.textContent = message;
    extrasError.textContent = message;
    textsError.classList.toggle('hidden', !invalid);
    extrasError.classList.toggle('hidden', !invalid);
  };

  if (networkId !== null) {
    void Promise.all([loadPropertyRows(networkId), loadPropertyRegistry(networkId)]).then(
      ([rows, loadedRegistry]) => {
        registry = loadedRegistry;
        const choices: EntityOption[] = propertyEntityOptions(rows);
        // Облачко чипа показывает КАНОНИЧЕСКОЕ (прямое) имя свойства, хотя в
        // выпадашке каждая сторона — отдельная строка (задача 7cfaba7c, п.3).
        const chipTitles = propertyChipTitles(choices);
        const cloudOf = (value: string): ThoughtCloudInput => ({
          id: value,
          title: chipTitles.get(value) ?? value,
        });
        textsField = buildEntityChipField({
          getValues: () => textSources,
          onChange: (values) => {
            textSources = values;
            checkOverlap();
            queueSave({ text_sources: textSources });
          },
          loadOptions: (query) => filterEntityOptions(choices, query),
          initialOptions: choices,
          cloudOf,
          optionsHeader: t('publication.field.texts'),
          placeholder: t('typeEditor.addProperty'),
          addPlaceholder: t('typeEditor.addProperty'),
          reorderable: true,
        });
        extrasField = buildEntityChipField({
          getValues: () => extraProperties,
          onChange: (values) => {
            extraProperties = values;
            checkOverlap();
            queueSave({ extra_properties: extraProperties });
          },
          loadOptions: (query) => filterEntityOptions(choices, query),
          initialOptions: choices,
          cloudOf,
          optionsHeader: t('publication.field.extras'),
          placeholder: t('typeEditor.addProperty'),
          addPlaceholder: t('typeEditor.addProperty'),
          reorderable: true,
        });
        textsHost.append(textsField.root);
        extrasHost.append(extrasField.root);
        if (instance?.publication != null) apply(instance.publication);
      },
    );
  }

  updaters.push((p) => {
    fromInput.value = p.numbering_from === null ? '' : String(p.numbering_from);
    toInput.value = p.numbering_to === null ? '' : String(p.numbering_to);
    // Защита слоя (ошибка 4efb01bb): апдейтер обязан выдержать неполный объект
    // публикации — живой кэш может отдать частичную запись (патч realtime-события
    // до полного снимка), у которой нет `text_sources`/`extra_properties`.
    // Корень — событие создания несёт полный DTO (сервер), но слой не должен
    // падать на недопустимых данных.
    textSources = [...(p.text_sources ?? [])];
    extraProperties = [...(p.extra_properties ?? [])];
    textsField?.refresh();
    extrasField?.refresh();
    checkOverlap();
    const recipeKey = JSON.stringify(p.title_recipe ?? null);
    // Пересборка билдера — только при ВНЕШНЕМ изменении определения. Если
    // пришедшее значение совпадает с состоянием билдера, это эхо собственного
    // сохранения: пересборка стёрла бы фокус и позицию правки (ошибка 82aada28).
    const builderKey = builder === null ? null : JSON.stringify(builder.getDefinition());
    if (registry !== null && (builder === null || recipeKey !== builderKey)) {
      while (recipeHost.firstChild !== null) recipeHost.removeChild(recipeHost.firstChild);
      builder = buildRecipeBuilder({ registry, initial: p.title_recipe, onChange: onRecipeChange });
      recipeHost.append(builder.root);
    }
  });
  if (instance?.publication != null) apply(instance.publication);
  return pane;
}

function intOrNull(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Вкладка «Вложения» (общая панель владельца-публикации)
// ---------------------------------------------------------------------------

function buildAttachmentsTabPane(): HTMLElement {
  const pane = div('pub-card-pane pub-card-attachments-pane');
  const ownerId = currentPublicationId() ?? '';
  pane.append(
    buildAttachmentsPane({
      ownerType: 'publication',
      ownerId,
      thought: null,
      // Панель после перезагрузки списка уведомляет — обновляем бейдж вкладки
      // тем же путём, что и панель мысли (`onCountChange`).
      onCountChange: () => void refreshAttachmentsCount(),
      // На картинках-вложениях публикации — «Сделать обложкой публикации»
      // (элемент интерфейса c3e44cab). Файл уже принадлежит публикации, поэтому
      // достаточно назначить его обложкой.
      extraMenuItems: (attachment) =>
        isImageAttachment(attachment)
          ? [
              menuAction(t('publication.attachments.makeCover'), () =>
                setCoverFromAttachment(attachment),
              ),
            ]
          : [],
    }),
  );
  return pane;
}

/** Картинка ли вложение (файл image/* либо URL с расширением картинки). */
function isImageAttachment(a: Attachment): boolean {
  if (a.kind === 'file') return (a.mime_type ?? '').startsWith('image/');
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?.*)?$/i.test(a.url ?? '');
}

/** Назначает вложение-картинку обложкой публикации (вкладка «Вложения»). */
function setCoverFromAttachment(attachment: Attachment): void {
  queueSave({ cover_attachment_id: attachment.id, cover_url: null });
  notice(t('publication.cover.setDone'), 'success');
}

// ---------------------------------------------------------------------------
// Вкладка «Метаданные»
// ---------------------------------------------------------------------------

function buildMetaPane(): HTMLElement {
  const pane = div('pub-card-pane pub-card-meta-pane');
  const host = div('pub-card-meta');
  pane.append(host);
  let block: HTMLElement | null = null;
  let assemblyValue: HTMLElement | null = null;

  updaters.push((p) => {
    const fields = {
      id: p.id,
      createdAtMs: p.created_at,
      createdBy: p.created_by,
      updatedAtMs: p.updated_at,
      updatedBy: p.updated_by,
    };
    if (block === null) {
      block = buildMetadataBlock(fields);
      const assemblyRow = div('pub-card-meta-assembly');
      assemblyValue = span('', 'metadata-field-value');
      assemblyValue.id = 'pub-card-assembly';
      assemblyRow.append(
        span(t('publication.field.assembly'), 'metadata-field-label'),
        assemblyValue,
      );
      host.append(block, assemblyRow);
    } else {
      // Пользовательский кэш подписан на старый блок — отпускаем его и
      // пересобираем свежий (дата/редактор могли измениться нашим же PATCH).
      block.dispatchEvent(new CustomEvent('etn:metadata-dispose'));
      const next = buildMetadataBlock(fields);
      host.replaceChild(next, block);
      block = next;
    }
    if (assemblyValue !== null) {
      assemblyValue.textContent =
        p.assembly_date === null ? '—' : assemblyDateLabel(p.assembly_date);
    }
  });
  if (instance?.publication != null) apply(instance.publication);
  return pane;
}

// ---------------------------------------------------------------------------
// Настройки (шестерёнка): полки + автор
// ---------------------------------------------------------------------------

function openSettingsDialog(): void {
  const publication = currentPublication();
  if (publication === null) return;
  const body = div('pub-card-settings');

  const authorInput = fieldInput({
    id: 'pub-card-settings-author',
    value: publication.authorship ?? '',
    placeholder: t('publication.field.authorPlaceholder'),
  });
  authorInput.addEventListener('input', () =>
    queueSave({ authorship: emptyToNull(authorInput.value) }),
  );
  body.append(
    fieldRow({ label: t('publication.settings.author'), control: authorInput, id: 'pub-card-settings-author' }),
  );

  const shelvesHost = div('pub-card-settings-shelves');
  settingsShelvesHost = shelvesHost;
  body.append(fieldRow({ label: t('publication.settings.shelves'), control: shelvesHost }));

  void loadShelves().then((list) => {
    allShelvesCache = list;
    renderShelfCheckboxes(shelvesHost, publication.id);
  });

  showDialog({
    title: t('publication.settings.title'),
    size: 'm',
    body,
    buttons: [
      {
        label: t('actions.close'),
        onClick: () => {
          settingsShelvesHost = null;
        },
      },
    ],
  });
}

async function loadShelves(): Promise<Shelf[]> {
  const networkId = store.state.networkId;
  if (networkId === null) return [];
  return etn.publications.listShelves(networkId).catch(() => []);
}

function renderShelfCheckboxes(host: HTMLElement, publicationId: string): void {
  while (host.firstChild !== null) host.removeChild(host.firstChild);
  if (allShelvesCache.length === 0) {
    host.append(span(t('publications.shelf.none'), 'pub-card-empty'));
    return;
  }
  for (const shelf of allShelvesCache) {
    const ordered = [...shelf.items].sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((item) => item.publication_id === publicationId);
    const on = index !== -1;
    const row = checkboxRow({ label: shelf.title, checked: on });
    row.input.addEventListener('change', () => {
      void toggleShelfMembership(publicationId, shelf.id, row.input.checked);
    });
    const line = div('pub-card-shelf-row');
    line.append(row.row);
    // Порядок публикации внутри полки (c3e44cab, «Полки и статус»): стрелки
    // меняют позицию, когда публикация на полке.
    if (on) {
      const up = iconButton({
        icon: svgIcon('chevrons-up', 14),
        title: t('publication.orderUp'),
        role: 'ghost',
        disabled: index === 0,
        onClick: () => void moveWithinShelf(shelf.id, publicationId, -1),
      });
      const down = iconButton({
        icon: svgIcon('chevrons-down', 14),
        title: t('publication.orderDown'),
        role: 'ghost',
        disabled: index === ordered.length - 1,
        onClick: () => void moveWithinShelf(shelf.id, publicationId, 1),
      });
      const controls = div('pub-card-shelf-order');
      controls.append(up, down);
      line.append(controls);
    }
    host.append(line);
  }
}

/**
 * Меняет порядок публикации внутри полки на одну позицию: ОБМЕН позициями
 * перемещаемой и соседа (две записи `addShelfItem`, ключ состава —
 * `(shelf_id, publication_id)`). Одной записи недостаточно — сервер отдаёт
 * состав `ORDER BY position ASC` без второго ключа, и равные позиции порядок
 * не меняют (замечание проверки).
 */
async function moveWithinShelf(
  shelfId: string,
  publicationId: string,
  direction: -1 | 1,
): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const shelf = allShelvesCache.find((s) => s.id === shelfId);
  if (shelf === undefined) return;
  const updates = shelfSwapUpdates(shelf.items, publicationId, direction);
  if (updates === null) return;
  try {
    for (const update of updates) {
      await etn.publications.addShelfItem(networkId, shelfId, update.publication_id, update.position);
    }
    allShelvesCache = await loadShelves();
    reopenSettingsHost(publicationId);
  } catch (err) {
    errorDialog(t('publication.error'), err);
  }
}

/** Хост чекбоксов полок открытого диалога настроек (перерисовка после перестановки). */
let settingsShelvesHost: HTMLElement | null = null;

function reopenSettingsHost(publicationId: string): void {
  if (settingsShelvesHost !== null && settingsShelvesHost.isConnected !== false) {
    renderShelfCheckboxes(settingsShelvesHost, publicationId);
  }
}

async function toggleShelfMembership(
  publicationId: string,
  shelfId: string,
  on: boolean,
): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    if (on) await etn.publications.addShelfItem(networkId, shelfId, publicationId);
    else await etn.publications.removeShelfItem(networkId, shelfId, publicationId);
    allShelvesCache = await loadShelves();
    reopenSettingsHost(publicationId);
  } catch (err) {
    errorDialog(t('publication.error'), err);
  }
}

// ---------------------------------------------------------------------------
// Сохранение
// ---------------------------------------------------------------------------

function queueSave(changes: PublicationUpdateInput): void {
  if (suppressFieldEvents) return;
  pendingChanges = { ...pendingChanges, ...changes };
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, 400);
}

async function flushSave(): Promise<boolean> {
  const networkId = store.state.networkId;
  // Владелец правок — карточка на момент постановки запроса. Смена цели за
  // время запроса не должна привести к применению ответа к новой карточке
  // (ошибка 82aada28).
  const owner = instance;
  const current = owner?.publication ?? null;
  if (networkId === null || owner === null || current === null) return true;
  if (Object.keys(pendingChanges).length === 0) return true;
  const changes = pendingChanges;
  pendingChanges = {};
  try {
    const updated = await etn.publications.update(networkId, current.id, changes, current.version);
    if (instance === owner) apply(updated);
    // Своё событие `publication.updated` приходит асинхронно (B1) — свежий полный снимок
    // кладём в кэш слоя и инвалидируем ключи: библиотека, полки и рабочая
    // область обновятся единым кэш-путём (замечание А приёмки b02ef1cf).
    commitEntity('publication', updated.id, updated);
    invalidateAfterMutation([
      queryKeys.publicationCard(updated.id),
      queryKeys.publicationsListAll(),
    ]);
    return true;
  } catch (err) {
    errorDialog(t('publication.error'), err);
    if (instance === owner) void refreshFromServer();
    return false;
  }
}

/**
 * Локальное изменение набора вложений публикации (диалог обложки создал/снял
 * вложение): инвалидируем ключ списка вложений владельца и счётчик — счётчик
 * вкладки и панель «Вложения» перечитают список кэш-путём (замечание А приёмки
 * b02ef1cf). Своего realtime-эха у правки из этого же клиента нет.
 */
function invalidatePublicationAttachments(publicationId: string): void {
  invalidateQueries(queryKeys.attachments('publication', publicationId));
  invalidateQueries(queryKeys.indicators(publicationId));
}

/**
 * Видимая обратная связь пересборки (ошибка c2dec45c): пока идёт запрос —
 * кнопка «Действия» заблокирована, рядом показан прелоадер. Без этого повторное
 * нажатие и «ничего не произошло» неразличимы. Элементы передаются ЯВНО: при
 * смене цели во время запроса module-level refs уже указывают на новую карточку.
 */
function setRebuildingOn(
  button: HTMLButtonElement | null,
  feedback: HTMLElement | null,
  busy: boolean,
): void {
  if (button !== null) button.disabled = busy;
  if (feedback === null) return;
  while (feedback.firstChild !== null) feedback.removeChild(feedback.firstChild);
  feedback.classList.toggle('hidden', !busy);
  if (busy) feedback.append(loadingState(t('publication.rebuilding')));
}

async function rebuildPublication(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || instance === null) return;
  // Владелец пересборки — карточка на момент клика (образец `flushSave`,
  // ошибка 82aada28). Элементы обратной связи захватываем синхронно, ДО любого
  // await.
  const owner = instance;
  const publicationId = owner.publicationId;
  const ownerButton = rebuildButtonRef;
  const ownerFeedback = rebuildFeedbackRef;
  // Сначала досылаем отложенный отбор (дебаунс 400 мс): иначе сервер
  // пересоберёт документ по СТАРОЙ строке публикации, а ответ затрёт поля
  // UI прежними значениями — «нажал, ничего не произошло» (ошибка 82aada28).
  // Конфликт сохранения НЕ пропускаем молча (ошибка c2dec45c).
  if (!(await flushSave())) return;
  setRebuildingOn(ownerButton, ownerFeedback, true);
  try {
    const updated = await etn.publications.rebuild(networkId, publicationId);
    if (instance === owner) {
      apply(updated);
      notice(t('publication.rebuilt.ready'), 'success');
    }
    // Своё событие `publication.rebuilt` приходит асинхронно (B1) — кладём
    // снимок в кэш слоя сразу и инвалидируем ключи: рабочая область по сигналу `publication-rebuilt`
    // снимает подсветку и перечитывает документ, библиотека — список.
    commitEntity('publication', publicationId, updated);
    invalidateAfterMutation(
      [
        queryKeys.publicationAssembly(publicationId),
        queryKeys.publicationCard(publicationId),
        queryKeys.publicationsListAll(),
      ],
      { local: 'publication-rebuilt', id: publicationId },
    );
  } catch (err) {
    errorDialog(t('publication.rebuild'), err);
  } finally {
    setRebuildingOn(ownerButton, ownerFeedback, false);
  }
}
// ---------------------------------------------------------------------------
// Диалог выбора обложки
// ---------------------------------------------------------------------------

/**
 * Открывает диалог выбора обложки: вкладки «Вложения» и «URL». Вкладка
 * «Вложения» — общий компонент выбора вложения (задача 0f6c3e39): список
 * картинок сети с поиском, загрузкой из файла, отметкой текущего и
 * ФИКСИРОВАННЫМ предпросмотром; здесь остаётся только специфика обложки —
 * облачка владельцев носителя и назначение выбранного вложения обложкой
 * публикации. Ошибка 3250096a (предпросмотр/поиск) исправлена в компоненте.
 */
async function openCoverDialog(): Promise<void> {
  const rawNetId = store.state.networkId;
  const publicationId = currentPublicationId();
  if (rawNetId === null || publicationId === null) return;
  // Сужение до `string` для замыканий (TS теряет narrowing захваченных const).
  const netId: string = rawNetId;
  const pubId: string = publicationId;

  /** Владельцы носителя, по ключу строки (единый кеш — замечание 3). */
  const usageCache = new Map<string, AttachmentOwnerRef[]>();
  /** Разрешённые ссылки мыслей-владельцев (тип/значок/оформление, как везде). */
  const refCache = new Map<string, ThoughtRef>();

  /** Дочитывает ссылки мыслей-владельцев батчем (визуал типа — из ссылки). */
  async function ensureRefs(owners: readonly AttachmentOwnerRef[]): Promise<void> {
    const missing = owners
      .filter((o) => o.owner_type === 'thought' && !refCache.has(o.owner_id))
      .map((o) => o.owner_id);
    if (missing.length === 0) return;
    try {
      const refs = await etn.thoughts.resolve(netId, missing.slice(0, 100));
      for (const ref of refs) refCache.set(ref.id, ref);
    } catch {
      // Значок/оформление типа недоступны — облачко соберётся по имени.
    }
  }

  /**
   * Представитель носителя для предпросмотра/применения: предпочтительна
   * строка-владение ЭТОЙ публикации (обложка ставится без добавления владельца),
   * иначе — первый владелец носителя. Владение проверяется по агрегату
   * `owners` (одно вложение — много владельцев, 0.12.1).
   */
  function isOwnedByPublication(a: Attachment): boolean {
    if ((a.owners ?? []).some((o) => o.owner_type === 'publication' && o.owner_id === pubId)) {
      return true;
    }
    // Запас: DTO без агрегата владельцев несёт первичное владение в полях
    // `owner_type`/`owner_id` (совместимость и клиентские фикстуры).
    return a.owner_type === 'publication' && a.owner_id === pubId;
  }

  function representative(row: AttachmentPickerRow): Attachment {
    return row.attachments.find(isOwnedByPublication) ?? row.representative;
  }

  /**
   * Облачко одного владельца: мысль — общий компонент облачка мысли с её
   * типом; публикация — компонент `lib/ui/publication-cloud`; связь — облачко
   * со значком связи. У каждого — крестик снятия владельца (замечание Б2
   * приёмки b02ef1cf).
   */
  function buildOwnerCloud(
    owner: AttachmentOwnerRef,
    row: AttachmentPickerRow,
    refresh: () => void,
  ): HTMLElement {
    if (owner.owner_type === 'publication') {
      return createPublicationCloud(
        { id: owner.owner_id, title: owner.title ?? owner.owner_id },
        {
          width: 'container',
          labels: {
            open: t('publications.menu.open'),
            read: t('publications.menu.read'),
            findOnShelf: t('publication.action.findOnShelf'),
            remove: t('publication.cover.ownerRemove'),
          },
          actions: {
            onOpen: (id) => {
              void import('../screens/publications/publications.js').then((m) =>
                m.openPublicationCard(id),
              );
            },
            onRead: (id) => {
              void import('../screens/publications/publications.js').then((m) =>
                m.openPublicationWorkspace(id),
              );
            },
            onFindOnShelf: (id) => {
              void import('../screens/publications/publications.js').then((m) =>
                m.revealPublicationInLibrary(id),
              );
            },
            onRemove: () => void removeOwner(row, owner, refresh),
          },
        },
      );
    }
    const ref = refCache.get(owner.owner_id);
    const input =
      owner.owner_type === 'thought'
        ? (ref ?? { id: owner.owner_id, title: owner.title ?? owner.owner_id })
        : {
            id: owner.owner_id,
            title: owner.title ?? t('publication.cover.ownerLink'),
            icon: '🔗',
            icon_kind: 'emoji' as const,
          };
    return createThoughtCloud(input, {
      profile: 'chip',
      width: 'container',
      actions: { onRemove: () => void removeOwner(row, owner, refresh) },
    });
  }

  /** Заполняет строку облачками владельцев (мысли/публикации/связи). */
  function fillClouds(
    clouds: HTMLElement,
    row: AttachmentPickerRow,
    refresh: () => void,
  ): void {
    const draw = (): void => {
      const owners = usageCache.get(row.key) ?? [];
      while (clouds.firstChild !== null) clouds.removeChild(clouds.firstChild);
      for (const owner of owners) clouds.append(buildOwnerCloud(owner, row, refresh));
    };
    const cached = usageCache.get(row.key);
    if (cached !== undefined) {
      void ensureRefs(cached).then(draw);
      return;
    }
    // Владельцы общие для всего носителя — запрашиваем один раз по представителю.
    const sample = representative(row);
    if (sample === null) {
      draw();
      return;
    }
    void etn.attachments
      .getUsage(netId, sample.id)
      .then(async (usage) => {
        usageCache.set(row.key, usage.owners);
        await ensureRefs(usage.owners);
        draw();
      })
      .catch(() => undefined);
  }

  /**
   * Снимает ОДНО владение (вложение, объект) через `DELETE /attachments/{id}/owners`
   * (0.12.1; ошибка 8f9768c9). Если владелец последний — сначала общий диалог
   * подтверждения (замечание Б2 приёмки b02ef1cf); своя обложка даёт 409 —
   * внятное сообщение (требование 6b524569).
   */
  async function removeOwner(
    row: AttachmentPickerRow,
    owner: AttachmentOwnerRef,
    refresh: () => void,
  ): Promise<void> {
    let owners = usageCache.get(row.key) ?? [];
    if (owners.length === 0) {
      const sample = representative(row);
      if (sample !== null) {
        try {
          owners = (await etn.attachments.getUsage(netId, sample.id)).owners;
          usageCache.set(row.key, owners);
        } catch {
          owners = [];
        }
      }
    }
    if (owners.length <= 1) {
      const confirmed = await confirmDialog(
        t('publication.cover.removeLastOwner.title'),
        t('publication.cover.removeLastOwner.body'),
        true,
        t('actions.delete'),
      );
      if (!confirmed) return;
    }
    // Носитель — одно вложение-строку на файл; владельцы лежат агрегатом
    // `owners` в этой же строке, отдельной строки на владельца нет (0.12.1).
    const target = representative(row);
    // Снятие владения идёт через `DELETE /attachments/{id}/owners` — пара
    // (вложение, объект), а не удаление вложения (0.12.1, требование 6b524569;
    // ошибка 8f9768c9 — DELETE /attachments/{id} убран из публичного API).
    try {
      await etn.attachments.removeOwner(netId, target.id, {
        owner_type: owner.owner_type,
        owner_id: owner.owner_id,
      });
    } catch (err) {
      // 409 ATTACHMENT_OWNER_IS_ICON — вложение держит сама публикация как
      // обложку: внятное сообщение вместо технической ошибки.
      if (isIconOwnerBlock(err)) {
        notice(t('publication.cover.removeOwnerBlocked'), 'error');
        return;
      }
      errorDialog(t('publication.cover.removeOwner'), err);
      return;
    }
    invalidatePublicationAttachments(pubId);
    usageCache.delete(row.key);
    refresh();
  }

  // Текущая обложка-вложение — отметить её строку при открытии (отметка
  // текущего общего компонента).
  const publication = instance?.publication ?? null;
  const current =
    publication !== null &&
    publication.cover_kind === 'attachment' &&
    publication.cover_attachment_id !== null
      ? {
          attachmentId: publication.cover_attachment_id,
          preview: `etnimg://attachment/${encodeURIComponent(publication.cover_attachment_id)}`,
        }
      : null;

  /**
   * Применение выбранного вложения (нижняя «Применить», двойной клик,
   * Ctrl+Enter): «своё» вложение публикации назначается напрямую; «чужое»
   * сначала привязывается к публикации — публикация становится ЕГО владельцем
   * (`POST /attachments/{id}/owners`), вложение не копируется (тех.проект
   * f9b8917c); загруженный файл — загружается во вложения публикации.
   */
  async function applyPick(pick: AttachmentPick, ctx: ResourceSourceContext): Promise<void> {
    if (pick.source !== undefined) {
      try {
        const comma = pick.source.dataUrl.indexOf(',');
        const created = await etn.attachments.uploadFile(netId, 'publication', pubId, {
          title: pick.source.name.trim() !== '' ? pick.source.name.trim() : 'file',
          mime_type: pick.source.mime,
          data_base64: comma === -1 ? '' : pick.source.dataUrl.slice(comma + 1),
        });
        invalidatePublicationAttachments(pubId);
        queueSave({ cover_attachment_id: created.id, cover_url: null });
      } catch (err) {
        errorDialog(t('publication.cover.upload'), err);
        return;
      }
      notice(t('publication.cover.setDone'), 'success');
      ctx.close();
      return;
    }
    const attachment = pick.row !== undefined ? representative(pick.row) : pick.attachment;
    if (attachment === undefined) return;
    if (isOwnedByPublication(attachment)) {
      queueSave({ cover_attachment_id: attachment.id, cover_url: null });
    } else {
      try {
        await etn.attachments.addOwners(netId, attachment.id, {
          owner_type: 'publication',
          owner_ids: [pubId],
        });
        invalidatePublicationAttachments(pubId);
        queueSave({ cover_attachment_id: attachment.id, cover_url: null });
      } catch (err) {
        errorDialog(t('publication.error'), err);
        return;
      }
    }
    notice(t('publication.cover.setDone'), 'success');
    ctx.close();
  }

  // Каркас диалога — универсальный выбор ресурса (задача d1a56d76): вкладка
  // «Вложения» — общий компонент выбора вложения (задача 0f6c3e39), «URL» —
  // общий источник каркаса.
  createResourcePicker({
    title: t('publication.cover.title'),
    size: 'l',
    applyLabel: t('publication.cover.apply'),
    noneLabel: t('publication.cover.none'),
    noneDanger: true,
    onNone: (close) => {
      queueSave({ cover_attachment_id: null, cover_url: null });
      notice(t('publication.cover.cleared'));
      close();
    },
    tabs: [
      attachmentPickerSourceTab({
        label: t('publication.cover.tab.attachments'),
        autoSelectFirst: true,
        ...(current !== null ? { current } : {}),
        renderRowExtra: (row, api) => {
          const clouds = div('att-pick-clouds');
          fillClouds(clouds, row, api.refresh);
          return clouds;
        },
        onPick: (pick, ctx) => applyPick(pick, ctx),
      }),
      urlSourceTab({
        placeholder: t('publication.cover.urlPlaceholder'),
        previewHint: t('publication.cover.previewHint'),
        onApply: (url, ctx) => {
          queueSave({ cover_url: url, cover_attachment_id: null });
          notice(t('publication.cover.setDone'), 'success');
          ctx.close();
        },
      }),
    ],
  });
}
