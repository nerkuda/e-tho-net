/**
 * Диалог создания и правки отбора типа мысли (задача e37f3f04, спека
 * e0257ca5 «Диалог отбора типа мысли», версия 0.7.3).
 *
 * Конструктор условий повторяет панель «Структур» (`filter-panel.ts`) БЕЗ
 * блока сохранённых отборов, кнопок применения и сплиттера: ключевые слова,
 * родительские мысли, типы мыслей и связей, свойства, автор/редактор, даты,
 * «Дополнительно» и сортировка. Тяжёлые группы («Свойства», «Дополнительно»,
 * «Автор / Редактор», «Даты») — сворачиваемые, по умолчанию свёрнуты; заголовок
 * любой группы, чьи условия не пусты, подсвечивается и помечается `*`.
 *
 * Значения условий редактирует ОБЩИЙ редактор значения
 * (`editor/value-editor.ts`, стандарт S2): вид значения выбирает он, а
 * токены-кандидаты (поля мысли + свойства типа и его предков + `$today`/
 * `$now`/`$user`, собранные по типу отбора) вызывающий передаёт источником
 * подсказок (`extraSuggest`). Список токенов ограничен операцией условия:
 * списочные токены предлагаются только в «в списке» и «не в списке».
 * «Родительские мысли»/«Типы мыслей»/«Типы связей» и списки автора/редактора
 * строит общий чип-лист сущностей (`lib/entity-picker.ts`) с тем же
 * источником токенов: несколько литералов и токенов свободно смешиваются, а
 * чек-лист/поиск (кнопка «выбрать…») ДОБАВЛЯЕТ к чипам, а не подменяет их.
 *
 * Сохранение: `etn.thoughtTypeViews.create`/`.update` через IPC. Пустой отбор
 * (ни одного условия) сохранить нельзя — ошибка показывается под формой.
 *
 * Условия отбора строит единый конструктор `lib/filter-builder.ts`
 * (задача 48b59d00, веха 5 версии 0.8.2): модель состояния, словарь
 * операторов, наборы сортировок/направлений, конвертер в wire и строка
 * условия «автор/редактор» импортируются оттуда; диалог держит только
 * кандидатов-токены и раскладку групп.
 */

import {
  THOUGHT_TYPE_VIEW_DESCRIPTION_MAX,
  THOUGHT_TYPE_VIEW_NAME_MAX,
  type EffectiveTypeProperty,
  type NetworkProperty,
  type PropertyValueType,
  type SortOrder,
  type StructureAuthorOp,
  type StructurePropertyOp,
  type StructureSort,
  type ThoughtType,
  type ThoughtTypeView,
  type ThoughtTypeViewDefinition,
  type ThoughtTypeViewInput,
  type ThoughtTypeViewUpdateInput,
} from '@etn/shared';

import { firstPickedThoughtId, pickedThoughtIds, pickThoughtsDialog } from '../../canvas/add-dialog.js';
import { div, el, errText, span } from '../../lib/dom.js';
import { showDialog } from '../../lib/dialog.js';
import { fieldError, footerErrorLine, type ErrorAddress, type FooterErrorLine } from '../../lib/ui/messages.js';
import { etn } from '../../lib/etn.js';
import {
  buildAuthorshipSection,
  buildConditionsSection,
  buildDatesSection,
  buildEntityChipSection,
  buildExtrasSection,
  buildKeywordsSection,
  buildSortSection,
  type EntityChipSection,
  type FilterFormContext,
  type FilterSection,
} from '../../lib/filter-form.js';
import { notice } from '../../lib/notice.js';
import {
  buildEntityChipField,
  filterEntityOptions,
  pickEntitiesModal,
  thoughtEntityOption,
  thoughtTypeEntityOptions,
  linkTypeEntityOptions,
  type EntityOption,
} from '../../lib/entity-picker.js';
import { wireSuggest, type SuggestEntry, type SuggestSource } from '../../lib/suggest-dropdown.js';
import { type ThoughtCloudInput } from '../../lib/thought-cloud.js';
import { buildUserSelectWidget, listUsers, resolveUserName } from '../../lib/users.js';
import { store } from '../../state.js';

import {
  buildTokensForField,
  buildTokensForSpecialField,
  buildWireDefinition,
  filterComboOptions,
  hasAnyCriteria,
  parseViewDefinition,
  tokensToComboOptions,
  type ChainProperties,
  type ComboOption,
  type DialogCriteriaState,
  type DialogPropertyCondition,
  type ViewToken,
} from './filter-dialog-pure.js';

import { withReverseLinkPropertySides } from '../../lib/filter-builder.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** What the dialog was opened for: a new view or an existing one. */
export interface OpenViewEditorOptions {
  networkId: string;
  /** Type the new view belongs to. */
  thoughtTypeId: string;
  /** Type display name (used in the dialog title). */
  typeName: string;
  /** `null` — create; otherwise the existing view to edit. */
  view: ThoughtTypeView | null;
  /**
   * Called after a successful save. Receives the saved view (newly created or
   * freshly updated). Errors are surfaced in-place; no callback on cancel.
   */
  onSaved?: (view: ThoughtTypeView) => void;
}

/**
 * Opens the «Создать отбор» / «Изменить отбор» dialog.
 *
 * The dialog is modal and self-contained — closing it requires no further
 * plumbing from the caller. The host should react to `onSaved` to refresh
 * its strip / list (the IPC event `thought-type-view.{created,updated}`
 * already drives the realtime repaint).
 */
export function openViewEditorDialog(opts: OpenViewEditorOptions): void {
  // The body is built lazily after the type chain is loaded (we need the
  // ancestor types' effective properties to feed the token-picker).
  void buildAndShow(opts).catch((err: unknown) => {
    notice(`Не удалось открыть диалог отбора: ${errText(err)}`, 'error');
  });
}

/** Module-scoped chain of properties for the currently open dialog.
 *  The token-picker reads it lazily — there is at most one dialog open at
 *  a time. Set when the chain loads, cleared in the dialog's `onClose`
 *  (see `buildAndShowImpl`) — NOT in a `finally`, because `buildAndShowImpl`
 *  resolves once the DOM is mounted and the dialog has not closed yet, so a
 *  `finally` would wipe the chain before the user clicks any token button.
 */
let activeChainProps: ChainProperties[] | null = null;

function buildAndShow(opts: OpenViewEditorOptions): Promise<void> {
  return buildAndShowImpl(opts);
}

async function buildAndShowImpl(opts: OpenViewEditorOptions): Promise<void> {
  const { networkId, thoughtTypeId, typeName } = opts;
  // 1. Resolve the type chain (own + ancestors). The token-picker needs every
  //    property available on this type so users can pin a condition value to,
  //    say, `$thought.[версия]`.
  const chain = await loadTypeChain(networkId, thoughtTypeId);
  const chainProps = await loadTypeChainProperties(networkId, chain);
  activeChainProps = chainProps;
  // Property registry (registry-level metadata, e.g. name and multiple flag
  // for each property binding on the chain). Задача df992826: к реестру
  // добавляются обратные стороны ВСЕХ свойств-связей реестра — в конструкторе
  // условий обе стороны адресуемы (обе стороны каждой связи, не только
  // цепочки редактируемого типа).
  let baseRegistry = new Map<string, NetworkProperty>();
  try {
    const list = await etn.propertyRegistry.list(networkId);
    for (const row of list) baseRegistry.set(row.id, row);
  } catch {
    /* empty registry — picker just shows none of the property tokens */
  }
  const registryById = withReverseLinkPropertySides(baseRegistry, store.state.linkTypes);

  // 2. Initialise the form state from the existing view (or defaults).
  const isEdit = opts.view !== null;
  const title = isEdit ? 'Изменить отбор' : 'Создать отбор';
  const initial = parseViewDefinition(opts.view);
  const initialName = opts.view?.name ?? '';
  const initialDescription = opts.view?.description ?? '';
  const initialIsDefault = opts.view?.is_default ?? false;
  const initialVersion = opts.view?.version ?? 0;

  // 3. Build the form DOM.
  const body = div('form-stack view-editor-body');
  // Ошибка отбора живёт в панели кнопок (единственное обязательное место
  // ошибки диалога, требование 397c5a56); у поля имени — дублирование.
  const errorLine = footerErrorLine();

  // Name — required, ≤200.
  const nameInput = el('input', 'text-input') as HTMLInputElement;
  nameInput.type = 'text';
  nameInput.value = initialName;
  nameInput.maxLength = THOUGHT_TYPE_VIEW_NAME_MAX;
  nameInput.placeholder = 'Название отбора (обязательно)';
  const nameField = div('field');
  nameField.append(el('label', 'field-label', `Имя отбора (тип «${typeName}»)`));
  const nameError = fieldError();
  nameField.append(nameInput, nameError);

  // Description — optional, ≤1000.
  const descInput = el('textarea', 'textarea-input') as HTMLTextAreaElement;
  descInput.rows = 3;
  descInput.maxLength = THOUGHT_TYPE_VIEW_DESCRIPTION_MAX;
  descInput.value = initialDescription;
  descInput.placeholder = 'Описание (его читают и человек, и агент)';
  const descField = div('field');
  descField.append(el('label', 'field-label', 'Описание'));
  descField.append(descInput);

  // «Open by default» checkbox.
  const defaultLabel = el('label', 'checkbox-row') as HTMLLabelElement;
  const defaultCheckbox = el('input') as HTMLInputElement;
  defaultCheckbox.type = 'checkbox';
  defaultCheckbox.checked = initialIsDefault;
  defaultLabel.append(defaultCheckbox, span('Открывать по умолчанию'));
  const defaultField = div('field');
  defaultField.append(defaultLabel);

  // Criteria builder. Self-contained: it owns the criteria state for the
  // dialog lifetime.
  const criteria = buildCriteriaBuilder({ networkId, initial, registryById });

  // Section title — жирный, чтобы «Критерии отбора» читались как заголовок.
  const criteriaLabel = el('div', 'view-editor-section-title', 'Критерии отбора');

  body.append(nameField, descField, defaultField, criteriaLabel, criteria.root);

  // 4. Show the dialog. The Save button keeps itself open on validation
  //    failure; we close only when the IPC call resolves.
  let saveBtn: HTMLButtonElement | null = null;
  showDialog({
    title,
    body,
    size: 'l',
    // Ошибка сохранения — строкой в панели кнопок (требование 397c5a56):
    // ошибки полей видны только на своей вкладке/месте, футер — всегда.
    footerError: errorLine,
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Сохранить',
        primary: true,
        keepOpen: true,
        ref: (b) => {
          saveBtn = b;
        },
        onClick: (close) => {
          void onSave({
            close,
            saveBtn,
            opts,
            name: nameInput.value,
            description: descInput.value,
            isDefault: defaultCheckbox.checked,
            version: initialVersion,
            criteria,
            errorLine,
            nameError,
            nameAddress: { field: () => nameInput },
          });
        },
      },
    ],
    onClose: () => {
      activeChainProps = null;
    },
  });
}

// ---------------------------------------------------------------------------
// Save flow
// ---------------------------------------------------------------------------

interface SaveCtx {
  close: () => void;
  saveBtn: HTMLButtonElement | null;
  opts: OpenViewEditorOptions;
  name: string;
  description: string;
  isDefault: boolean;
  version: number;
  criteria: CriteriaBuilder;
  /** Строка ошибки в панели кнопок диалога. */
  errorLine: FooterErrorLine;
  /** Дублирование ошибки у поля имени. */
  nameError: HTMLElement;
  /** Адрес ошибок имени — поле имени для перехода по клику на строку. */
  nameAddress: ErrorAddress;
}

async function onSave(ctx: SaveCtx): Promise<void> {
  const trimmedName = ctx.name.trim();
  if (trimmedName === '') {
    showNameError(ctx, 'Укажите имя отбора.');
    return;
  }
  if (trimmedName.length > THOUGHT_TYPE_VIEW_NAME_MAX) {
    showNameError(
      ctx,
      `Имя не должно превышать ${THOUGHT_TYPE_VIEW_NAME_MAX} символов (сейчас ${trimmedName.length}).`,
    );
    return;
  }
  const trimmedDesc = ctx.description.trim();
  if (trimmedDesc.length > THOUGHT_TYPE_VIEW_DESCRIPTION_MAX) {
    showFieldError(
      ctx,
      `Описание не должно превышать ${THOUGHT_TYPE_VIEW_DESCRIPTION_MAX} символов (сейчас ${trimmedDesc.length}).`,
    );
    return;
  }
  // Запрет пустого отбора (ошибка e8365d29): без условий отбор бессмыслен.
  if (!ctx.criteria.hasAnyCriteria()) {
    showFieldError(ctx, 'Укажите хотя бы одно условие отбора.');
    return;
  }

  const definition: ThoughtTypeViewDefinition = ctx.criteria.buildWire();
  const definitionJson = JSON.stringify(definition);

  if (ctx.saveBtn !== null) ctx.saveBtn.disabled = true;
  ctx.errorLine.clear();
  ctx.nameError.textContent = '';

  const { networkId, thoughtTypeId, view } = ctx.opts;
  try {
    let saved: ThoughtTypeView;
    if (view === null) {
      const input: ThoughtTypeViewInput = {
        name: trimmedName,
        description: trimmedDesc === '' ? null : trimmedDesc,
        definition: definitionJson,
        is_default: ctx.isDefault,
      };
      saved = await etn.thoughtTypeViews.create(networkId, thoughtTypeId, input);
    } else {
      const patch: ThoughtTypeViewUpdateInput = {
        name: trimmedName,
        description: trimmedDesc === '' ? null : trimmedDesc,
        definition: definitionJson,
        is_default: ctx.isDefault,
      };
      saved = await etn.thoughtTypeViews.update(
        networkId,
        view.thought_type_id,
        view.id,
        patch,
        ctx.version,
      );
    }
    ctx.opts.onSaved?.(saved);
    ctx.close();
  } catch (err) {
    showFieldError(ctx, errText(err));
    if (ctx.saveBtn !== null) ctx.saveBtn.disabled = false;
  }
}

function showFieldError(ctx: SaveCtx, message: string): void {
  // Ошибка не про имя — убираем дублирование у поля, чтобы оно не «залипало».
  ctx.nameError.textContent = '';
  ctx.errorLine.show(message);
}

/**
 * Ошибка поля имени: строка в панели кнопок (обязательное место) + то же
 * сообщение дублируется у самого поля. Тоста нет — ошибка диалога не
 * неблокирующее уведомление (требование 397c5a56).
 */
function showNameError(ctx: SaveCtx, message: string): void {
  ctx.errorLine.show(message, ctx.nameAddress);
  ctx.nameError.textContent = message;
}

// ---------------------------------------------------------------------------
// Type chain + effective properties
// ---------------------------------------------------------------------------

/** Walks the type chain from a type up to the root, inclusive. */
async function loadTypeChain(networkId: string, typeId: string): Promise<ThoughtType[]> {
  // Prefer the store's catalogue (kept in sync by realtime-ui); fall back to
  // a single fetch when the type is not in the catalogue.
  let catalogue = store.state.thoughtTypes.slice();
  if (catalogue.length === 0) {
    try {
      catalogue = await etn.types.listThoughtTypes(networkId);
    } catch {
      catalogue = [];
    }
  }
  const byId = new Map<string, ThoughtType>();
  for (const t of catalogue) byId.set(t.id, t);

  const chain: ThoughtType[] = [];
  let current: string | null = typeId;
  const guard = new Set<string>();
  while (current !== null && !guard.has(current)) {
    guard.add(current);
    const t = byId.get(current);
    if (t === undefined) break;
    chain.push(t);
    current = t.parent_id;
  }
  return chain;
}

/** Loads the effective properties for each level of the chain. */
async function loadTypeChainProperties(
  networkId: string,
  chain: ThoughtType[],
): Promise<ChainProperties[]> {
  const out: ChainProperties[] = [];
  for (const type of chain) {
    let props: EffectiveTypeProperty[] = [];
    try {
      props = await etn.types.listTypeProperties(networkId, 'thought_type', type.id);
    } catch {
      props = [];
    }
    out.push({ type, props });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Re-exports from the pure helper module (so existing callers and tests
// can keep importing from `filter-dialog.js`).
// ---------------------------------------------------------------------------

export type { ChainProperties, DialogCriteriaState, DialogPropertyCondition, SpecialTokenField, ViewToken } from './filter-dialog-pure.js';
export {
  buildTokensForField,
  buildTokensForSpecialField,
  buildWireDefinition,
  defaultDialogCriteriaState,
  hasAnyCriteria,
  parseViewDefinition,
} from './filter-dialog-pure.js';

/** Length constants re-exported for tests. */
export const VIEW_NAME_MAX = THOUGHT_TYPE_VIEW_NAME_MAX;
export const VIEW_DESCRIPTION_MAX = THOUGHT_TYPE_VIEW_DESCRIPTION_MAX;

// ---------------------------------------------------------------------------
// Criteria builder
// ---------------------------------------------------------------------------

interface CriteriaBuilderOpts {
  networkId: string;
  initial: DialogCriteriaState;
  registryById: Map<string, NetworkProperty>;
}

interface CriteriaBuilder {
  root: HTMLElement;
  buildWire: () => ThoughtTypeViewDefinition;
  hasAnyCriteria: () => boolean;
}

/**
 * Строит форму критериев отбора. Состав и порядок секций — параметр сборки
 * этого места; вид и поведение каждого элемента — общий каркас
 * `lib/filter-form.ts` (задача 3742dd59). Форма строится один раз и меняется
 * на месте: ввод обновляет состояние и маркеры секций БЕЗ перерисовки DOM
 * (иначе терялся бы фокус). Токены-кандидаты (`$today`, `$thought.*`,
 * свойства цепочки типов) — источники подсказок вызывающего.
 */
function buildCriteriaBuilder(opts: CriteriaBuilderOpts): CriteriaBuilder {
  const { networkId, registryById } = opts;
  const state = opts.initial;

  // Transient collapse state (default collapsed, §e0257ca5).
  let propsCollapsed = true;
  let extraCollapsed = true;
  let authorCollapsed = true;
  let datesCollapsed = true;

  const sections: FilterSection[] = [];
  const touch = (): void => {
    for (const section of sections) section.refresh();
  };
  const ctx: FilterFormContext = {
    networkId,
    getState: () => state,
    registry: registryById,
    touch,
  };

  // --- Ключевые слова (составное поле: токен заменяет слово у каретки) ------
  sections.push(
    buildKeywordsSection(ctx, {
      placeholder: 'счет* -вод*',
      tooltip: 'Слова через пробел, все обязательны; * — любые символы; -слово — исключение.',
      showScope: true,
      composite: true,
      suggestSource: tokenSourceFor({ kind: 'keywords' }),
    }),
  );

  // --- Родительские мысли ---------------------------------------------------
  const parentSection = buildEntityChipSection(ctx, {
    title: 'Родительские мысли',
    getValues: () => state.parentIds,
    setValues: (values) => {
      state.parentIds = values;
    },
    loadOptions: (query) => parentThoughtOptions(networkId, query),
    optionsHeader: 'Мысли',
    extraSources: [tokenSourceFor({ kind: 'parent' })],
    cloudOf: (value) => (value.startsWith('$') ? null : (parentClouds.get(value) ?? null)),
    placeholder: 'Название мысли или токен…',
    tooltip: 'Ограничить отбор мыслями, подчинёнными указанным',
    picker: { label: 'выбрать…', open: (managed) => pickParentThoughts(networkId, managed) },
  });
  sections.push(parentSection);
  // Догрузить облачка уже выбранных мыслей (в каталоге живого поиска их нет).
  void resolveParentClouds(networkId, state.parentIds).then(() => parentSection.fieldRefresh());

  // --- Типы мыслей и связи --------------------------------------------------
  sections.push(
    buildEntityChipSection(ctx, {
      title: 'Типы мыслей',
      getValues: () => state.typeIds,
      setValues: (values) => {
        state.typeIds = values;
      },
      loadOptions: (query) =>
        filterEntityOptions(thoughtTypeEntityOptions(store.state.thoughtTypes), query),
      optionsHeader: 'Типы мыслей',
      extraSources: [tokenSourceFor({ kind: 'thought_type' })],
      placeholder: 'Название типа или токен…',
      picker: { label: 'список типов…', open: (managed) => openThoughtTypesPicker(networkId, managed) },
    }),
    buildEntityChipSection(ctx, {
      title: 'Типы связей',
      getValues: () => state.linkTypeIds,
      setValues: (values) => {
        state.linkTypeIds = values;
      },
      loadOptions: (query) =>
        filterEntityOptions(linkTypeEntityOptions(store.state.linkTypes), query),
      optionsHeader: 'Типы связей',
      extraSources: [tokenSourceFor({ kind: 'link_type' })],
      placeholder: 'Название типа или токен…',
      picker: { label: 'список типов…', open: (managed) => openLinkTypesPicker(networkId, managed) },
    }),
  );

  // --- Свойства / Дополнительно / Автор-Редактор / Даты / Сортировка --------
  sections.push(
    buildConditionsSection(
      ctx,
      { get: () => propsCollapsed, set: (v) => (propsCollapsed = v) },
      {
        // Токены значений — у тех же видов, где они были (text/url/date/link).
        extraSuggestFor: (cond) => {
          const def = registryById.get(cond.propertyId);
          const valueType = def?.value_type ?? 'text';
          const editorType = valueType === 'thought_ref' ? 'link' : valueType;
          const withTokens =
            editorType === 'link' || valueType === 'text' || valueType === 'url' || valueType === 'date';
          return withTokens ? [tokenSourceFor({ kind: 'property', valueType, op: cond.op })] : [];
        },
      },
    ),
    buildExtrasSection(ctx, { get: () => extraCollapsed, set: (v) => (extraCollapsed = v) }),
    buildAuthorshipSection(
      ctx,
      { get: () => authorCollapsed, set: (v) => (authorCollapsed = v) },
      {
        // Редакторы значения — с токенами и живым поиском пользователей.
        editors: {
          buildSingle: ({ currentId, onChange }) => buildAuthorSingleEditor(currentId, onChange),
          buildList: ({ currentIds, onChange }) => buildAuthorListEditor(currentIds, onChange),
        },
      },
    ),
    buildDatesSection(ctx, { get: () => datesCollapsed, set: (v) => (datesCollapsed = v) }),
    buildSortSection(ctx),
  );

  const root = div('st-f-layout view-editor-criteria');
  for (const section of sections) root.append(section.box);
  touch();

  return {
    root,
    buildWire: () => buildWireDefinition(state, registryById),
    hasAnyCriteria: () => hasAnyCriteria(state),
  };
}

// ---------------------------------------------------------------------------
// Кандидаты «Родительские мысли» (живой поиск мыслей) — общий пикер
// ---------------------------------------------------------------------------

/** Облачка выбранных мыслей «Родительских мыслей» (id → данные облачка). */
const parentClouds = new Map<string, ThoughtCloudInput>();

/** Live-search кандидаты мыслей для чип-листа «Родительские мысли». */
async function parentThoughtOptions(networkId: string, query: string): Promise<EntityOption[]> {
  const needle = query.trim();
  if (needle === '') return [];
  try {
    const hits = await etn.thoughts.findDuplicates(networkId, needle, [], []);
    return hits.map((hit) => {
      parentClouds.set(hit.id, { ...hit });
      return thoughtEntityOption(hit);
    });
  } catch {
    return [];
  }
}

/** Дозаполняет облачка уже выбранных родительских мыслей (резолв по id). */
async function resolveParentClouds(networkId: string, ids: readonly string[]): Promise<void> {
  const missing = ids.filter((id) => !id.startsWith('$') && !parentClouds.has(id));
  if (missing.length === 0) return;
  try {
    const refs = await etn.thoughts.resolve(networkId, [...missing]);
    for (const ref of refs) parentClouds.set(ref.id, { ...ref });
  } catch {
    // Оффлайн — чипы останутся с сырым id.
  }
}

/**
 * Редактор одиночного значения: живой поиск (id, токен или пользователь по
 * имени) + выбор пользователя из каталога.
 */
function buildAuthorSingleEditor(
  currentId: string,
  onChange: (id: string) => void,
): HTMLElement {
  const single = div('author-single-wrap');
  const input = el('input', 'st-f-input') as HTMLInputElement;
  input.type = 'text';
  input.value = currentId === '' || currentId.startsWith('$') ? currentId : (resolveUserName(currentId) ?? currentId);
  input.placeholder = 'Пользователь, id или токен…';
  input.addEventListener('input', () => onChange(input.value));
  // Живой поиск — общая выпадашка (источник вариантов — её параметр):
  // выбранная строка подставляется в поле, свободный текст фиксирует
  // `input`-обработчик выше.
  wireSuggest(input, {
    sources: [
      { when: 'always', load: (query) => comboToEntries(authorComboOptions(query)) },
    ],
    pickFirstOnEnter: false,
    onPick: (entry) => {
      input.value = entry.value.startsWith('$') ? entry.value : (resolveUserName(entry.value) ?? entry.value);
      onChange(entry.value);
      input.focus();
    },
  });
  single.append(
    input,
    buildUserSelectWidget({
      label: '',
      currentId,
      onChange: (id) => {
        input.value = resolveUserName(id) ?? id;
        onChange(id);
      },
    }),
  );
  return single;
}

/** Live-search кандидаты для полей «Автор»/«Редактор»: токены (`$…`) +
 *  пользователи сети, отфильтрованные по имени/логину (задача 27472616). */
function authorComboOptions(query: string): ComboOption[] {
  // Для обоих полей набор токенов один и тот же (`$thought.author`,
  // `$thought.editor`, `$user`) — см. `buildTokensForSpecialField`.
  const tokenOpts = tokensToComboOptions(buildTokensForSpecialField(activeChainProps ?? [], 'author'), null);
  const userOpts: ComboOption[] = listUsers().map((u) => ({
    value: u.id,
    label: `${u.display_name ?? u.username} (${u.username})`,
    section: 'Пользователи',
  }));
  return filterComboOptions([...tokenOpts, ...userOpts], query);
}

/**
 * Чип-редактор списка автора/редактора (задача 27472616): чипы выбранных
 * значений (имена пользователей или тексты токенов) + живой поиск,
 * смешивающий пользователей сети и токены в одном поле ввода. Чипы строит
 * общий чип-лист сущностей (`lib/entity-picker.ts`).
 */
function buildAuthorListEditor(
  currentIds: string[],
  onChange: (ids: string[]) => void,
): HTMLElement {
  // Локальная копия — владелец состояния обновится через `onChange`, а чипы
  // обязаны перерисоваться сразу (замкнутый массив к этому моменту устарел).
  let ids = [...currentIds];
  const fieldEl = buildEntityChipField({
    getValues: () => ids,
    onChange: (values) => {
      ids = values;
      onChange(values);
    },
    loadOptions: (query) => filterEntityOptions(usersEntityOptions(), query),
    optionsHeader: 'Пользователи',
    extraSources: [
      { when: 'always', load: (query) => comboToEntries(authorTokenOptions(query)) },
    ],
    cloudOf: (value) =>
      value.startsWith('$')
        ? null
        : { id: value, title: resolveUserName(value) ?? value, icon: '👤', icon_kind: 'emoji' },
    placeholder: 'Пользователь или токен…',
  });
  return fieldEl.root;
}

/** Варианты пользователей сети для чип-листа автора/редактора. */
function usersEntityOptions(): EntityOption[] {
  return listUsers().map((u) => ({
    id: u.id,
    title: `${u.display_name ?? u.username} (${u.username})`,
    selectable: true,
    cloud: { id: u.id, title: u.display_name ?? u.username, icon: '👤', icon_kind: 'emoji' },
  }));
}

/** Токен-кандидаты полей «Автор»/«Редактор» (без пользователей). */
function authorTokenOptions(query: string): ComboOption[] {
  return filterComboOptions(
    tokensToComboOptions(buildTokensForSpecialField(activeChainProps ?? [], 'author'), null),
    query,
  );
}



// ---------------------------------------------------------------------------
// Pickers (parent / thought types / link types) — каждый возвращает
// `Promise<string[] | null>` (`null` — отменено) над УПРАВЛЯЕМЫМ подмножеством
// значений чип-листа; чипы-токены сохраняются (см. `buildEntityChipField`).
// ---------------------------------------------------------------------------

async function pickParentThoughts(networkId: string, managedIds: readonly string[]): Promise<string[] | null> {
  const result = await pickThoughtsDialog({
    networkId,
    allowCreate: false,
    allowLinkType: false,
    selectedIds: [...managedIds],
  });
  if (result === null) return null;
  return pickedThoughtIds(result);
}

async function openThoughtTypesPicker(networkId: string, managedIds: readonly string[]): Promise<string[] | null> {
  return pickEntitiesModal({
    networkId,
    kind: 'thought-types',
    title: 'Типы мыслей',
    currentIds: managedIds,
  });
}

async function openLinkTypesPicker(networkId: string, managedIds: readonly string[]): Promise<string[] | null> {
  return pickEntitiesModal({
    networkId,
    kind: 'link-types',
    title: 'Типы связей',
    currentIds: managedIds,
  });
}

// ---------------------------------------------------------------------------
// Токены и кандидаты полей (задача 27472616). Формат хранимых значений НЕ
// меняется: строка (литерал или `$token`) для скалярных условий, массив строк
// для списочных; резолвер токенов на сервере не трогается. Токены — источник
// подсказок вызывающего: их получает либо общий редактор значения
// (`extraSuggest`), либо общий чип-лист сущностей (`extraSources`).
// ---------------------------------------------------------------------------

/** Поле, к которому пристёгнут источник токенов. */
type TokenPickerField =
  | { kind: 'property'; valueType: PropertyValueType; op: StructurePropertyOp | null }
  | { kind: 'keywords' }
  | { kind: 'thought_type' }
  | { kind: 'link_type' }
  | { kind: 'parent' }
  | { kind: 'author' }
  | { kind: 'editor' };

/** Токен-кандидаты для поля (без учёта текстового запроса). */
function tokenOptions(field: TokenPickerField): ComboOption[] {
  const chainProps = activeChainProps ?? [];
  if (field.kind === 'property') {
    return tokensToComboOptions(buildTokensForField(chainProps, field.valueType, field.op), field.op);
  }
  if (field.kind === 'parent') {
    const tokens: ViewToken[] = [{ text: '$thought', label: '$thought — id мысли в фокусе', section: 'Поля мысли' }];
    return tokensToComboOptions(tokens, null);
  }
  return tokensToComboOptions(buildTokensForSpecialField(chainProps, field.kind), null);
}

/** Токен-кандидаты, отфильтрованные по подстроке `query` (живой поиск). */
function getTokenOptions(field: TokenPickerField, query: string): ComboOption[] {
  return filterComboOptions(tokenOptions(field), query);
}

/** Строка общей выпадашки по кандидату-токену. */
function comboToEntries(options: readonly ComboOption[]): SuggestEntry[] {
  return options.map((o) => ({
    value: o.value,
    label: o.label,
    ...(o.section !== undefined ? { section: o.section } : {}),
    ...(o.disabled === true ? { disabled: true } : {}),
  }));
}

/** Источник подсказок «токены поля» — параметр общего редактора/пикера. */
function tokenSourceFor(field: TokenPickerField): SuggestSource {
  return {
    when: 'always',
    load: (query) => comboToEntries(getTokenOptions(field, query)),
  };
}

