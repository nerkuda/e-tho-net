/**
 * Карточка публикации в панели редактора (0.11.1, задача a3cfc018; элемент
 * интерфейса c3e44cab, ADR eb687eea). Третий вариант цели панели рядом с
 * карточкой мысли и редактором связи: собственный набор вкладок
 * «Метаданные»/«Рецепты»/«Полки и статус», канв-специфичные механики для этой
 * цели не применяются (их отключает `editor.ts`).
 *
 * Модуль изолирован от монолита `editor.ts` (решение ADR): редактор лишь
 * делегирует сюда отрисовку цели `publication` и владеет хостом. Правки полей
 * применяются сразу (PATCH с `If-Match`), изменения видны документу и
 * библиотеке; realtime-события `publication.*` перечитывают карточку.
 *
 * Разметка — фасады `lib/ui` (поля, кнопки, вкладки, чипы, таблица),
 * `lib/dialog.ts`; строки — из словаря `t()`.
 */

import type { Attachment, Publication, PublicationUpdateInput, Shelf } from '@etn/shared';

import { createMdEditor, type MdEditor } from './md-editor.js';
import { div, span } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { svgIcon } from '../lib/icons.js';
import { etn } from '../lib/etn.js';
import { showDialog, errorDialog } from '../lib/dialog.js';
import { uiButton, iconButton } from '../lib/ui/button.js';
import { uiTabs } from '../lib/ui/tabs.js';
import { fieldInput, fieldRow } from '../lib/ui/field.js';
import { fieldError } from '../lib/ui/messages.js';
import { checkboxRow } from '../lib/ui/choice-row.js';
import { createTable } from '../lib/ui/table.js';
import {
  buildEntityChipField,
  filterEntityOptions,
  type EntityChipField,
  type EntityOption,
} from '../lib/entity-picker.js';
import { onRealtimeEvent } from '../realtime.js';
import { store } from '../state.js';
import { buildCover } from '../screens/publications/cover.js';
import {
  assemblyDateLabel,
  displayAuthorship,
  shelfSwapUpdates,
} from '../screens/publications/model.js';
import {
  buildRecipeBuilder,
  loadPropertyRegistry,
  loadPropertyRows,
  propertyEntityOptions,
  type RecipeBuilder,
} from '../screens/publications/recipe.js';
import * as users from '../lib/users.js';

/**
 * Тестовый шов: фабрика markdown-редактора и применение данных к карточке.
 * `createMdEditor` поднимает CodeMirror, которому нужен реальный DOM (`Range`,
 * `getSelection`), — в DOM-шиме клиентских тестов он не исполняется (прецедент —
 * `mdEditorInternals` в `md-editor.ts`). Тест первого открытия карточки
 * подменяет фабрику заглушкой; в продукте значение не меняется. `apply`
 * выставлен для тестов realtime-обновления резюме: в DOM-шиме ветка «та же
 * цель — `apply` на месте» в `showPublicationTarget` недостижима (у шима нет
 * `parentElement`).
 */
export const publicationCardInternals = { createMdEditor, apply };

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
let saveTimer: number | null = null;
let pendingChanges: PublicationUpdateInput = {};
let suppressFieldEvents = false;
let coverPreview: HTMLElement | null = null;
/** Хост чекбоксов полок текущей карточки (для перерисовки после перестановки). */
let shelvesHostRef: HTMLElement | null = null;
const updaters: Array<(publication: Publication) => void> = [];

/** Сброс карточки при пересборке рабочего пространства. */
export function disposePublicationCard(): void {
  realtimeUnsub?.();
  realtimeUnsub = null;
  instance?.unsub();
  instance = null;
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = null;
  pendingChanges = {};
  updaters.length = 0;
  shelvesHostRef = null;
}

/**
 * Показывает публикацию в панели редактора. Повторный вызов для той же
 * публикации обновляет значения на месте, для другой — пересобирает карточку.
 */
export function showPublicationTarget(host: PublicationCardHost, publicationId: string, publication: Publication | undefined): void {
  if (instance !== null && instance.publicationId === publicationId && instance.root.parentElement === host.scrollBox) {
    if (publication !== undefined) apply(publication);
    return;
  }
  disposePublicationCard();
  const root = buildCard(publicationId, publication ?? null);
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
  // Наполнение — ПОСЛЕ регистрации `instance` (ошибка ecad219b). Панели
  // вкладок `lib/ui/tabs` строятся лениво: активная («Метаданные») собирается
  // ещё внутри `buildCard`, когда `instance` равен `null`, поэтому `apply`,
  // вызванный до этой строки, был бы no-op, и поля оставались пустыми до
  // переключения вкладок. Данные пришли сразу — применяем синхронно, иначе
  // перечитываем сервер.
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
  instance.publication = publication;
  suppressFieldEvents = true;
  try {
    for (const update of updaters) update(publication);
  } finally {
    suppressFieldEvents = false;
  }
  renderCoverPreview(publication);
}

// ---------------------------------------------------------------------------
// Каркас
// ---------------------------------------------------------------------------

function buildCard(publicationId: string, publication: Publication | null): HTMLElement {
  const root = div('pub-card-editor');
  const head = div('pub-card-editor-head');
  const thumbHost = div('pub-card-editor-thumb');
  coverPreview = thumbHost;
  const titleBox = div('pub-card-editor-titlebox');
  const title = span(publication?.title ?? '', 'pub-card-editor-title');
  const meta = span('', 'pub-card-editor-meta');
  titleBox.append(title, meta);
  const rebuild = uiButton({
    label: t('publication.rebuild'),
    role: 'ghost',
    onClick: () => void rebuildPublication(),
  });
  head.append(thumbHost, titleBox, rebuild);

  const tabs = uiTabs({
    tabs: [
      { id: 'meta', label: t('publication.tab.meta'), content: () => buildMetaPane() },
      { id: 'recipe', label: t('publication.tab.recipe'), content: () => buildRecipePane() },
      { id: 'shelves', label: t('publication.tab.shelves'), content: () => buildShelvesPane() },
    ],
  });

  root.append(head, tabs.root);
  updaters.push((p) => {
    title.textContent = p.title;
    meta.textContent = [p.subtitle ?? '', authorLine(p), assemblyDateLabel(p.assembly_date)]
      .filter((part) => part !== '')
      .join(' · ');
  });
  // Здесь `apply` НЕ вызывается: `instance` ещё не зарегистрирован (это делает
  // `showPublicationTarget` сразу после возврата `buildCard`), поэтому вызов был
  // бы no-op (ошибка ecad219b). Наполнение выполняет вызывающий.
  return root;
}

function authorLine(publication: Publication): string {
  return displayAuthorship(publication, users.resolveUserName(publication.created_by));
}

function renderCoverPreview(publication: Publication): void {
  if (coverPreview === null) return;
  while (coverPreview.firstChild !== null) coverPreview.removeChild(coverPreview.firstChild);
  coverPreview.append(buildCover(publication, 'thumb'));
}

// ---------------------------------------------------------------------------
// Вкладка «Метаданные»
// ---------------------------------------------------------------------------

function buildMetaPane(): HTMLElement {
  const pane = div('pub-card-pane form-stack');

  const titleInput = fieldInput({ id: 'pub-card-title' });
  titleInput.addEventListener('input', () => queueSave({ title: titleInput.value }));
  pane.append(
    fieldRow({ label: t('publication.field.title'), control: titleInput, id: 'pub-card-title' }),
  );

  const subtitleInput = fieldInput({ id: 'pub-card-subtitle' });
  subtitleInput.addEventListener('input', () => queueSave({ subtitle: emptyToNull(subtitleInput.value) }));
  pane.append(
    fieldRow({ label: t('publication.field.subtitle'), control: subtitleInput, id: 'pub-card-subtitle' }),
  );

  const authorInput = fieldInput({ id: 'pub-card-author' });
  authorInput.placeholder = t('publication.field.authorPlaceholder');
  authorInput.addEventListener('input', () => queueSave({ authorship: emptyToNull(authorInput.value) }));
  pane.append(
    fieldRow({ label: t('publication.field.author'), control: authorInput, id: 'pub-card-author' }),
  );

  // Обложка: URL + «без обложки» + выбор вложения.
  const coverInput = fieldInput({ id: 'pub-card-cover-url' });
  coverInput.addEventListener('input', () =>
    queueSave({ cover_url: emptyToNull(coverInput.value), cover_attachment_id: null }),
  );
  const coverButtons = div('pub-card-cover-buttons');
  const pickCover = uiButton({
    label: t('publication.cover.pick'),
    role: 'ghost',
    onClick: () => void pickCoverAttachment(),
  });
  const clearCover = uiButton({
    label: t('publication.cover.none'),
    role: 'ghost',
    onClick: () => queueSave({ cover_url: null, cover_attachment_id: null }),
  });
  coverButtons.append(pickCover, clearCover);
  const coverBlock = div('pub-card-cover');
  coverBlock.append(
    fieldRow({ label: t('publication.field.cover'), control: coverInput, id: 'pub-card-cover-url' }),
    coverButtons,
  );
  pane.append(coverBlock);

  // Резюме — markdown-редактор (заголовки запрещены серверной валидацией).
  const summaryHost = div('pub-card-summary');
  const summaryRow = fieldRow({ label: t('publication.field.summary'), control: summaryHost, id: 'pub-card-summary' });
  pane.append(summaryRow);
  let md: MdEditor | null = null;
  // Последнее серверное значение резюме, с которым редактор синхронизирован
  // (baseline). Позволяет `apply` перечитывать резюме при realtime-обновлении,
  // не затирая незавершённый пользовательский ввод (ошибка 6f013e67).
  let summarySynced = '';

  // Дата сборки — readonly; меняется только «Пересобрать».
  const assemblyInput = fieldInput({ id: 'pub-card-assembly' });
  assemblyInput.readOnly = true;
  pane.append(
    fieldRow({ label: t('publication.field.assembly'), control: assemblyInput, id: 'pub-card-assembly' }),
  );

  updaters.push((p) => {
    titleInput.value = p.title;
    subtitleInput.value = p.subtitle ?? '';
    authorInput.value = p.authorship ?? '';
    coverInput.value = p.cover_url ?? '';
    assemblyInput.value = p.assembly_date === null ? '' : assemblyDateLabel(p.assembly_date);
    const serverSummary = p.summary_md ?? '';
    if (md === null) {
      md = publicationCardInternals.createMdEditor(serverSummary, {
        onInput: (value) => queueSave({ summary_md: emptyToNull(value) }),
      });
      summaryHost.append(md.dom);
      summarySynced = serverSummary;
    } else {
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
    }
  });
  // Первичное наполнение, если данные уже пришли.
  if (instance?.publication != null) apply(instance.publication);
  return pane;
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Вкладка «Рецепты»
// ---------------------------------------------------------------------------

function buildRecipePane(): HTMLElement {
  const pane = div('pub-card-pane form-stack');
  const recipeHost = div('pub-card-recipe');
  pane.append(recipeHost);
  let builder: RecipeBuilder | null = null;
  let lastRecipeKey = '';

  const textsHost = div('pub-card-texts');
  const textsError = fieldError('');
  textsError.classList.add('hidden');
  const textsFieldRow = fieldRow({
    label: t('publication.field.texts'),
    control: textsHost,
    id: 'pub-card-texts',
    error: textsError,
  });
  pane.append(textsFieldRow);

  const extrasHost = div('pub-card-extras');
  const extrasError = fieldError('');
  extrasError.classList.add('hidden');
  pane.append(
    fieldRow({
      label: t('publication.field.extras'),
      control: extrasHost,
      id: 'pub-card-extras',
      error: extrasError,
    }),
  );

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
  pane.append(numberRow);

  const networkId = store.state.networkId;
  let registry: Map<string, import('@etn/shared').NetworkProperty> | null = null;
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
    if (registry !== null && (builder === null || recipeKey !== lastRecipeKey)) {
      lastRecipeKey = recipeKey;
      while (recipeHost.firstChild !== null) recipeHost.removeChild(recipeHost.firstChild);
      builder = buildRecipeBuilder({ registry, initial: p.title_recipe });
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
// Вкладка «Полки и статус»
// ---------------------------------------------------------------------------

function buildShelvesPane(): HTMLElement {
  const pane = div('pub-card-pane form-stack');
  const shelvesHost = div('pub-card-shelves');
  shelvesHostRef = shelvesHost;
  pane.append(fieldRow({ label: t('publication.shelves'), control: shelvesHost, id: 'pub-card-shelves' }));
  const activeRow = checkboxRow({ label: t('publication.inactive') });
  activeRow.input.addEventListener('change', () =>
    queueSave({ active: !activeRow.input.checked }),
  );
  pane.append(activeRow.row);
  const trashButton = uiButton({
    label: t('publication.toTrash'),
    role: 'danger',
    onClick: () => void trashPublication(),
  });
  pane.append(trashButton);

  void loadShelves().then((list) => {
    allShelvesCache = list;
    renderShelfCheckboxes(shelvesHost);
    if (instance?.publication != null) apply(instance.publication);
  });

  updaters.push((p) => {
    activeRow.input.checked = !p.active;
    renderShelfCheckboxes(shelvesHost, p.id);
  });
  if (instance?.publication != null) apply(instance.publication);
  return pane;
}

async function loadShelves(): Promise<Shelf[]> {
  const networkId = store.state.networkId;
  if (networkId === null) return [];
  return etn.publications.listShelves(networkId).catch(() => []);
}

function renderShelfCheckboxes(host: HTMLElement, publicationId?: string): void {
  while (host.firstChild !== null) host.removeChild(host.firstChild);
  const publication = instance?.publication ?? null;
  const id = publicationId ?? publication?.id ?? '';
  if (allShelvesCache.length === 0) {
    host.append(span(t('publications.shelf.none'), 'pub-card-empty'));
    return;
  }
  for (const shelf of allShelvesCache) {
    const ordered = [...shelf.items].sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((item) => item.publication_id === id);
    const on = index !== -1;
    const row = checkboxRow({ label: shelf.title, checked: on });
    row.input.addEventListener('change', () => {
      if (id === '') return;
      void toggleShelfMembership(id, shelf.id, row.input.checked);
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
        onClick: () => void moveWithinShelf(shelf.id, id, -1),
      });
      const down = iconButton({
        icon: svgIcon('chevrons-down', 14),
        title: t('publication.orderDown'),
        role: 'ghost',
        disabled: index === ordered.length - 1,
        onClick: () => void moveWithinShelf(shelf.id, id, 1),
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
async function moveWithinShelf(shelfId: string, publicationId: string, direction: -1 | 1): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  const shelf = allShelvesCache.find((s) => s.id === shelfId);
  if (shelf === undefined) return;
  const updates = shelfSwapUpdates(shelf.items, publicationId, direction);
  if (updates === null) return;
  try {
    // Сначала перемещаемая, затем сосед: набор позиций после двух записей —
    // обменянный.
    for (const update of updates) {
      await etn.publications.addShelfItem(networkId, shelfId, update.publication_id, update.position);
    }
    allShelvesCache = await loadShelves();
    if (shelvesHostRef !== null) renderShelfCheckboxes(shelvesHostRef, publicationId);
  } catch (err) {
    errorDialog(t('publication.error'), err);
  }
}

let allShelvesCache: Shelf[] = [];

async function toggleShelfMembership(publicationId: string, shelfId: string, on: boolean): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  try {
    if (on) await etn.publications.addShelfItem(networkId, shelfId, publicationId);
    else await etn.publications.removeShelfItem(networkId, shelfId, publicationId);
    allShelvesCache = await loadShelves();
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

async function flushSave(): Promise<void> {
  const networkId = store.state.networkId;
  const current = instance?.publication ?? null;
  if (networkId === null || current === null || Object.keys(pendingChanges).length === 0) return;
  const changes = pendingChanges;
  pendingChanges = {};
  try {
    const updated = await etn.publications.update(networkId, current.id, changes, current.version);
    apply(updated);
  } catch (err) {
    errorDialog(t('publication.error'), err);
    void refreshFromServer();
  }
}

async function rebuildPublication(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || instance === null) return;
  try {
    const updated = await etn.publications.rebuild(networkId, instance.publicationId);
    apply(updated);
  } catch (err) {
    errorDialog(t('publication.rebuild'), err);
  }
}

async function trashPublication(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null || instance === null) return;
  try {
    await etn.publications.trash(networkId, instance.publicationId);
    store.update({ editorTarget: null });
    disposePublicationCard();
  } catch (err) {
    errorDialog(t('publication.toTrash'), err);
  }
}

// ---------------------------------------------------------------------------
// Выбор обложки-вложения
// ---------------------------------------------------------------------------

async function pickCoverAttachment(): Promise<void> {
  const networkId = store.state.networkId;
  if (networkId === null) return;
  let closeBox: () => void = () => undefined;
  const search = fieldInput({ extraClass: 'pub-cover-search' });
  search.placeholder = t('publications.search');
  const host = div('pub-cover-list');
  let rows: Attachment[] = [];
  const table = createTable<Attachment>({
    columns: [
      {
        key: 'title',
        header: t('publication.field.cover'),
        render: (row) => row.title ?? row.file_path ?? row.url ?? row.id,
      },
      { key: 'mime', header: 'MIME', width: '10rem', render: (row) => row.mime_type ?? '' },
    ],
    rows: () => rows,
    rowKey: (row) => row.id,
    emptyText: t('publications.emptySearch'),
    ariaLabel: t('publication.cover.pick'),
    onDblActivate: (row) => {
      queueSave({ cover_attachment_id: row.id, cover_url: null });
      closeBox();
    },
  });
  host.append(search, table.element);
  closeBox = showDialog({
    title: t('publication.cover.pick'),
    size: 'm',
    body: host,
    buttons: [{ label: t('actions.cancel') }],
  });
  const runSearch = async (): Promise<void> => {
    rows = await etn.attachments.search(networkId, { q: search.value }).catch(() => []);
    table.setRows(rows);
  };
  search.addEventListener('input', () => void runSearch());
  void runSearch();
}
