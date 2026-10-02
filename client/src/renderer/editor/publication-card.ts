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
} from '@etn/shared';

import { createMdEditor, type MdEditor } from './md-editor.js';
import { buildAttachmentsPane } from './attachments.js';
import { etnimgUrl } from './markdown-field.js';
import { div, span } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { svgIcon } from '../lib/icons.js';
import { etn } from '../lib/etn.js';
import { showDialog, errorDialog } from '../lib/dialog.js';
import { menuAction, showMenuAt } from '../lib/menu.js';
import { uiButton, iconButton } from '../lib/ui/button.js';
import { uiTabs, type TabsHandle } from '../lib/ui/tabs.js';
import { uiSplitter } from '../lib/ui/splitter.js';
import { fieldInput, fieldRow } from '../lib/ui/field.js';
import { fieldError } from '../lib/ui/messages.js';
import { checkboxRow } from '../lib/ui/choice-row.js';
import { loadingState } from '../lib/ui/empty-state.js';
import { createListNav } from '../lib/ui/list.js';
import { reconcileKeyed } from '../lib/ui/keyed-list.js';
import { notice } from '../lib/notice.js';
import {
  notifyPublicationRebuilt,
  onPublicationRebuilt,
} from '../lib/publication-events.js';
import {
  buildEntityChipField,
  filterEntityOptions,
  type EntityChipField,
  type EntityOption,
} from '../lib/entity-picker.js';
import { buildMetadataBlock } from '../lib/metadata.js';
import { onRealtimeEvent } from '../realtime.js';
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
  propertyEntityOptions,
  type RecipeBuilder,
} from '../screens/publications/recipe.js';

/**
 * Тестовый шов: фабрика markdown-редактора и применение данных к карточке.
 * `createMdEditor` поднимает CodeMirror, которому нужен реальный DOM (`Range`,
 * `getSelection`), — в DOM-шиме клиентских тестов он не исполняется (прецедент —
 * `mdEditorInternals` в `md-editor.ts`). `apply` выставлен для тестов
 * realtime-обновления резюме: в DOM-шиме ветка «та же цель — `apply` на месте»
 * в `showPublicationTarget` недостижима (у шима нет `parentElement`).
 */
export const publicationCardInternals = {
  createMdEditor,
  apply,
  /** Тестовый шов: пересборка — теперь пункт меню «Действия», не кнопка. */
  rebuild: (): void => void rebuildPublication(),
  /** Тестовый шов: активировать вкладку карточки (ленивые панели). */
  activateTab: (id: string): void => tabsHandleRef?.setActive(id),
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
let realtimeUnsub: (() => void) | null = null;
/** Подписка на локальные пересборки рабочей области (ошибка c2dec45c). */
let localUnsub: (() => void) | null = null;
let saveTimer: number | null = null;
let pendingChanges: PublicationUpdateInput = {};
let suppressFieldEvents = false;
/** Хост миниатюры обложки в шапке (клик — диалог обложки). */
let coverThumbRef: HTMLElement | null = null;
/** Полоса вкладок карточки (тестовый шов и интеграция). */
let tabsHandleRef: TabsHandle | null = null;
/** Кнопка «Действия» и хост прелоадера пересборки (ошибка c2dec45c). */
let rebuildButtonRef: HTMLButtonElement | null = null;
let rebuildFeedbackRef: HTMLElement | null = null;
/** Кэш полок для диалога настроек. */
let allShelvesCache: Shelf[] = [];
const updaters: Array<(publication: Publication) => void> = [];

/** Сброс карточки при смене цели/пересборке рабочего пространства. */
export function disposePublicationCard(): void {
  realtimeUnsub?.();
  realtimeUnsub = null;
  localUnsub?.();
  localUnsub = null;
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
 * Показывает публикацию в панели редактора. Повторный вызов для той же
 * публикации обновляет значения на месте, для другой — пересобирает карточку.
 */
export function showPublicationTarget(
  host: PublicationCardHost,
  publicationId: string,
  publication: Publication | undefined,
): void {
  if (
    instance !== null &&
    instance.publicationId === publicationId &&
    instance.root.parentElement === host.scrollBox
  ) {
    if (publication !== undefined) apply(publication);
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
  realtimeUnsub = onRealtimeEvent((evt) => {
    if (evt.network_id !== store.state.networkId) return;
    if (
      evt.type !== 'publication.updated' &&
      evt.type !== 'publication.rebuilt' &&
      evt.type !== 'publication.restored'
    ) {
      return;
    }
    const data = evt.data as { id?: string; publication_id?: string };
    const id = data.id ?? data.publication_id ?? '';
    if (id !== publicationId) return;
    void refreshFromServer();
  });
  // Пересборка ИЗ ШАПКИ рабочей области не вернёт карточке realtime-событие
  // (эхо подавлено, ошибка c2dec45c) — рабочая область уведомляет локально.
  localUnsub = onPublicationRebuilt((event) => {
    if (event.source === 'card') return;
    if (instance === null || event.id !== instance.publicationId) return;
    void refreshFromServer();
  });
  // Наполнение — ПОСЛЕ регистрации `instance` (ошибка ecad219b). Панели вкладок
  // строятся лениво, активная («Резюме») собирается ещё внутри `buildCard`,
  // когда `instance` равен `null`, поэтому `apply` до этой строки был бы no-op.
  // Данные пришли сразу — применяем синхронно, иначе перечитываем сервер.
  if (publication !== undefined) apply(publication);
  else void refreshFromServer();
}

/** Перечитывает публикацию и применяет значения к карточке. */
async function refreshFromServer(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || instance === null) return;
  try {
    const publication = await etn.publications.get(networkId, instance.publicationId);
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
  const head = div('pub-card-editor-head');

  // --- Строка 1: иконка-обложка · заголовок · ⚙ (Настройки) ----------------
  const topRow = div('pub-card-editor-top');
  const thumbButton = document.createElement('button');
  thumbButton.type = 'button';
  thumbButton.className = 'pub-card-editor-icon';
  thumbButton.title = t('publication.action.changeCover');
  thumbButton.setAttribute('aria-label', t('publication.action.changeCover'));
  const thumbHost = div('pub-card-editor-thumb');
  coverThumbRef = thumbHost;
  thumbButton.append(thumbHost);
  thumbButton.addEventListener('click', () => void openCoverDialog());

  const titleInput = fieldInput({
    id: 'pub-card-title',
    extraClass: 'pub-card-editor-title',
    placeholder: t('publication.field.titlePlaceholder'),
  });
  titleInput.addEventListener('input', () => queueSave({ title: titleInput.value }));

  const settingsButton = iconButton({
    icon: svgIcon('settings', 14),
    title: t('publication.settings'),
    role: 'ghost',
    onClick: () => openSettingsDialog(),
  });
  topRow.append(thumbButton, titleInput, settingsButton);

  // --- Строка 2: подзаголовок ----------------------------------------------
  const subRow = div('pub-card-editor-subrow');
  const subtitleInput = fieldInput({
    id: 'pub-card-subtitle',
    extraClass: 'pub-card-editor-subtitle',
    placeholder: t('publication.field.subtitlePlaceholder'),
  });
  subtitleInput.addEventListener('input', () =>
    queueSave({ subtitle: emptyToNull(subtitleInput.value) }),
  );
  subRow.append(subtitleInput);

  // --- Строка 3: «актуально» · меню «Действия» -----------------------------
  const actionsRow = div('pub-card-editor-actions');
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
  actionsRow.append(activeRow.row, actionsButton, rebuildFeedback);

  head.append(topRow, subRow, actionsRow);

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
  });
  tabsHandleRef = tabs;

  root.append(head, tabs.root);

  updaters.push((p) => {
    titleInput.value = p.title;
    subtitleInput.value = p.subtitle ?? '';
    activeRow.input.checked = p.active;
    renderCoverPreview(p);
  });
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

function buildSummaryPane(): HTMLElement {
  const pane = div('pub-card-pane pub-card-summary-pane');
  const summaryHost = div('pub-card-summary');
  pane.append(summaryHost);
  let md: MdEditor | null = null;
  // Последнее серверное значение резюме, с которым редактор синхронизирован
  // (baseline). Позволяет `apply` перечитывать резюме при realtime-обновлении,
  // не затирая незавершённый пользовательский ввод (ошибка 6f013e67).
  let summarySynced = '';

  updaters.push((p) => {
    const serverSummary = p.summary_md ?? '';
    if (md === null) {
      md = publicationCardInternals.createMdEditor(serverSummary, {
        onInput: (value) => queueSave({ summary_md: emptyToNull(value) }),
      });
      summaryHost.append(md.dom);
      summarySynced = serverSummary;
      return;
    }
    const current = md.getValue();
    if (current === summarySynced) {
      // Незавершённого ввода нет — перечитываем серверное резюме.
      if (current !== serverSummary) md.setValue(serverSummary);
      summarySynced = serverSummary;
    } else if (current === serverSummary) {
      // Ввод совпал с серверным (эхо собственного PATCH) — редактор
      // не трогаем, но считаем состояние синхронизированным.
      summarySynced = serverSummary;
    }
    // Иначе — расходящийся пользовательский ввод: оставляем его как есть.
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
  const numberRow = div('pub-card-numbering');
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
  selectGroup.body.append(recipeHost, numberRow);
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
        textsField = buildEntityChipField({
          getValues: () => textSources,
          onChange: (values) => {
            textSources = values;
            checkOverlap();
            queueSave({ text_sources: textSources });
          },
          loadOptions: (query) => filterEntityOptions(choices, query),
          initialOptions: choices,
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
    textSources = [...p.text_sources];
    extraProperties = [...p.extra_properties];
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
    return true;
  } catch (err) {
    errorDialog(t('publication.error'), err);
    if (instance === owner) void refreshFromServer();
    return false;
  }
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
    // Своё realtime-эхо `publication.rebuilt` до этого клиента не доходит
    // (подавление на сервере, ошибка c2dec45c) — рабочую область и списки
    // уведомляем локально (привязка к publicationId, а не к карточке).
    notifyPublicationRebuilt({ id: publicationId, source: 'card' });
  } catch (err) {
    errorDialog(t('publication.rebuild'), err);
  } finally {
    setRebuildingOn(ownerButton, ownerFeedback, false);
  }
}

// ---------------------------------------------------------------------------
// Диалог выбора обложки
// ---------------------------------------------------------------------------

/** Открывает диалог выбора обложки: вкладки «Вложения» и «URL». */
async function openCoverDialog(): Promise<void> {
  const rawNetId = store.state.networkId;
  const publicationId = currentPublicationId();
  if (rawNetId === null || publicationId === null) return;
  // Сужение до `string` для замыканий (TS теряет narrowing захваченных const).
  const netId: string = rawNetId;
  const pubId: string = publicationId;

  let tab: 'attachments' | 'url' = 'attachments';
  let selected: Attachment | null = null;
  let urlValue = '';
  let urlValid: string | null = null;
  let applyButton: HTMLButtonElement | null = null;

  /** Доступность нижней «Применить и закрыть» по активной вкладке. */
  function refreshApply(): void {
    if (applyButton === null) return;
    const enabled = tab === 'url' ? urlValid !== null : selected !== null;
    applyButton.disabled = !enabled;
  }

  // --- Вкладка «Вложения» --------------------------------------------------
  function buildAttachmentsTab(): HTMLElement {
    const box = div('pub-cover-pane');
    const top = div('pub-cover-top');
    const search = fieldInput({ extraClass: 'pub-cover-search' });
    search.placeholder = t('publications.search');
    const uploadButton = uiButton({
      label: t('publication.cover.upload'),
      role: 'secondary',
      size: 's',
      onClick: () => void uploadFromFile(),
    });
    top.append(search, uploadButton);

    const split = div('pub-cover-split');
    const listBox = div('pub-cover-list-box');
    const listHost = div('pub-cover-list');
    const emptyHint = span(t('publication.cover.empty'), 'muted pub-cover-empty hidden');
    listBox.append(listHost, emptyHint);
    const previewHost = div('pub-cover-preview');
    previewHost.style.width = '260px';
    previewHost.style.flexBasis = '260px';
    // Сплиттер ширины препросмотра — общий фасад `lib/ui/splitter.ts`.
    const splitter = uiSplitter({
      extraClass: 'pub-cover-splitter',
      title: t('splitter.resizeHint'),
      ariaLabel: t('splitter.resizeAriaHorizontal'),
      plan: () => ({
        axis: 'x' as const,
        sign: -1 as const,
        start: previewHost.getBoundingClientRect().width || 260,
        min: 120,
        max: 640,
      }),
      apply: (value) => {
        previewHost.style.width = `${value}px`;
        previewHost.style.flexBasis = `${value}px`;
      },
    });
    split.append(listBox, splitter, previewHost);
    box.append(top, split);

    let rows: Attachment[] = [];
    const rowEls = new Map<string, HTMLElement>();
    const usageCache = new Map<string, AttachmentOwnerRef[]>();

    const nav = createListNav<Attachment>(listHost, {
      entries: () => rows,
      tokenOf: (a) => a.id,
      elementOf: (a) => rowEls.get(a.id) ?? null,
      applyHighlight: (a) => {
        for (const [id, el] of rowEls) {
          el.classList.toggle('pub-cover-row-current', a !== null && id === a.id);
        }
      },
      onActivate: (a) => selectAttachment(a),
      onClick: (target) => {
        const row = closestRow(target);
        const id = row?.getAttribute('data-key') ?? '';
        const found = rows.find((r) => r.id === id);
        if (found !== undefined) selectAttachment(found);
      },
    });

    /** Ближайшая строка-вложение от узла клика. */
    function closestRow(target: HTMLElement): HTMLElement | null {
      let cursor: HTMLElement | null = target;
      while (cursor !== null && cursor !== listHost) {
        if (cursor.parentElement === listHost) return cursor;
        cursor = cursor.parentElement;
      }
      return null;
    }

    /** Заполняет строку облачками владельцев (мысли/публикации/связи). */
    function fillClouds(clouds: HTMLElement, attachment: Attachment): void {
      const render = (owners: AttachmentOwnerRef[]): void => {
        while (clouds.firstChild !== null) clouds.removeChild(clouds.firstChild);
        for (const owner of owners) {
          const label = `${owner.title ?? owner.owner_id} · ${ownerKindLabel(owner.owner_type)}`;
          clouds.append(span(label, 'pub-cover-cloud'));
        }
      };
      const cached = usageCache.get(attachment.id);
      if (cached !== undefined) {
        render(cached);
        return;
      }
      void etn.attachments
        .getUsage(netId, attachment.id)
        .then((usage) => {
          usageCache.set(attachment.id, usage.owners);
          render(usage.owners);
        })
        .catch(() => undefined);
    }

    /** Строит строку вложения (название + облачки). */
    function buildRow(a: Attachment): HTMLElement {
      const row = div('pub-cover-row');
      row.append(span(a.title ?? a.url ?? a.file_path ?? a.id, 'pub-cover-row-title'));
      const clouds = div('pub-cover-clouds');
      row.append(clouds);
      fillClouds(clouds, a);
      return row;
    }

    /** Перерисовывает список вложений-картинок (keyed-сверка). */
    function renderRows(): void {
      reconcileKeyed(listHost, rows, {
        key: (a) => a.id,
        build: (a) => buildRow(a),
        update: (el, a) => {
          const clouds = el.querySelector<HTMLElement>('.pub-cover-clouds');
          if (clouds !== null) fillClouds(clouds, a);
        },
      });
      rowEls.clear();
      for (const child of Array.from(listHost.children)) {
        const key = (child as HTMLElement).getAttribute('data-key');
        if (key !== null && key !== '') rowEls.set(key, child as HTMLElement);
      }
      emptyHint.classList.toggle('hidden', rows.length > 0);
      nav.refresh();
    }

    /** Ищет вложения-картинки сети (пустой запрос — все: `*`). */
    async function runSearch(): Promise<void> {
      const q = search.value.trim() === '' ? '*' : search.value.trim();
      const hits = await etn.attachments.search(netId, { q }).catch(() => []);
      rows = hits.filter(isImageAttachment);
      renderRows();
    }

    /** Выбирает вложение и показывает его препросмотр. */
    function selectAttachment(a: Attachment): void {
      selected = a;
      nav.setCurrent(a);
      renderPreview(a);
      refreshApply();
    }

    /** Препросмотр выбранной картинки. */
    function renderPreview(a: Attachment): void {
      while (previewHost.firstChild !== null) previewHost.removeChild(previewHost.firstChild);
      const img = document.createElement('img');
      img.className = 'pub-cover-preview-img';
      img.alt = '';
      if (a.kind === 'file' && a.file_path !== null) {
        img.src = etnimgUrl(a.file_path);
      } else {
        img.src = a.url ?? '';
      }
      img.addEventListener('error', () => {
        while (previewHost.firstChild !== null) previewHost.removeChild(previewHost.firstChild);
        previewHost.append(span(t('publication.cover.previewHint'), 'muted'));
      });
      while (previewHost.firstChild !== null) previewHost.removeChild(previewHost.firstChild);
      previewHost.append(img);
    }

    /** «Загрузить из файла»: файл становится вложением публикации. */
    async function uploadFromFile(): Promise<void> {
      try {
        const picked = await etn.system.pickFile();
        if (picked.status === 'cancel') return;
        const res = await fetch(etnimgUrl(picked.path));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const dataUrl = await blobToDataUrl(blob);
        const created = await etn.attachments.uploadFile(netId, 'publication', pubId, {
          title: picked.name,
          mime_type: blob.type !== '' ? blob.type : 'application/octet-stream',
          data_base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        });
        await runSearch();
        selectAttachment(created);
      } catch (err) {
        errorDialog(t('publication.cover.upload'), err);
      }
    }

    search.addEventListener('input', () => void runSearch());
    void runSearch();
    return box;
  }

  // --- Вкладка «URL» (как в диалоге иконки мысли) --------------------------
  function buildUrlTab(): HTMLElement {
    const box = div('pub-cover-pane');
    const input = fieldInput({ extraClass: 'pub-cover-url' });
    input.placeholder = t('publication.cover.urlPlaceholder');
    input.value = urlValue;
    const preview = div('pub-cover-preview pub-cover-preview-url');
    const paintHint = (): void => {
      while (preview.firstChild !== null) preview.removeChild(preview.firstChild);
      preview.append(span(t('publication.cover.previewHint'), 'muted'));
    };
    const validate = (value: string): void => {
      urlValid = null;
      refreshApply();
      while (preview.firstChild !== null) preview.removeChild(preview.firstChild);
      const v = value.trim();
      if (v === '') {
        paintHint();
        return;
      }
      const img = document.createElement('img');
      img.className = 'pub-cover-preview-img';
      img.alt = '';
      img.addEventListener('load', () => {
        if (input.value.trim() === v) {
          urlValid = v;
          refreshApply();
        }
      });
      img.addEventListener('error', () => {
        if (input.value.trim() === v) paintHint();
      });
      img.src = v;
      preview.append(img);
    };
    input.addEventListener('input', () => {
      urlValue = input.value;
      validate(urlValue);
    });
    box.append(input, preview);
    if (urlValue.trim() !== '') validate(urlValue);
    else paintHint();
    return box;
  }

  // --- Применение выбора ----------------------------------------------------
  async function applySelection(close: () => void): Promise<void> {
    if (tab === 'url') {
      if (urlValid === null) return;
      queueSave({ cover_url: urlValid, cover_attachment_id: null });
      notice(t('publication.cover.setDone'), 'success');
      close();
      return;
    }
    if (selected === null) return;
    const attachment = selected;
    if (attachment.owner_type === 'publication' && attachment.owner_id === pubId) {
      queueSave({ cover_attachment_id: attachment.id, cover_url: null });
    } else {
      // ⌘ «Чужое» вложение сначала привязываем к публикации, затем назначаем
      // обложкой (сервер отвечает 422 на cover_attachment_id чужого владельца).
      try {
        const created = await etn.attachments.add(netId, 'publication', pubId, {
          kind: attachment.kind,
          url: attachment.kind === 'url' ? attachment.url : null,
          file_path: attachment.kind === 'file' ? attachment.file_path : null,
          file_size: attachment.file_size,
          mime_type: attachment.mime_type,
          title: attachment.title,
          description: attachment.description,
        });
        queueSave({ cover_attachment_id: created.id, cover_url: null });
      } catch (err) {
        errorDialog(t('publication.error'), err);
        return;
      }
    }
    notice(t('publication.cover.setDone'), 'success');
    close();
  }

  showDialog({
    title: t('publication.cover.title'),
    size: 'l',
    activeTab: tab,
    onTabChange: (id) => {
      tab = id === 'url' ? 'url' : 'attachments';
      refreshApply();
    },
    tabs: [
      {
        id: 'attachments',
        label: t('publication.cover.tab.attachments'),
        content: () => buildAttachmentsTab(),
      },
      { id: 'url', label: t('publication.cover.tab.url'), content: () => buildUrlTab() },
    ],
    buttons: [
      { label: t('actions.cancel') },
      {
        label: t('publication.cover.none'),
        danger: true,
        keepOpen: true,
        onClick: (close) => {
          queueSave({ cover_attachment_id: null, cover_url: null });
          notice(t('publication.cover.cleared'));
          close();
        },
      },
      {
        label: t('publication.cover.apply'),
        primary: true,
        keepOpen: true,
        ref: (el) => {
          applyButton = el;
        },
        onClick: (close) => void applySelection(close),
      },
    ],
  });
  refreshApply();
}

/** Подпись вида владельца вложения в «облачке». */
function ownerKindLabel(kind: AttachmentOwnerRef['owner_type']): string {
  if (kind === 'thought') return t('publication.cover.ownerThought');
  if (kind === 'publication') return t('publication.cover.ownerPublication');
  return t('publication.cover.ownerLink');
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
