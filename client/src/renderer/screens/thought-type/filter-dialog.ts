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
import { clear, div, el, errText, span, setTooltip } from '../../lib/dom.js';
import { showDialog } from '../../lib/dialog.js';
import { etn } from '../../lib/etn.js';
import {
  FILTER_ORDERS,
  FILTER_SORTS,
  OPS_BY_TYPE,
  authorFilterActive,
  buildAuthorConditionRow,
  datesActive as builderDatesActive,
  type AuthorRowEditors,
} from '../../lib/filter-builder.js';
import { notice } from '../../lib/notice.js';
import {
  buildEntityChipField,
  pickEntitiesModal,
  thoughtEntityOption,
  thoughtTypeEntityOptions,
  linkTypeEntityOptions,
  type EntityOption,
} from '../../lib/entity-picker.js';
import { wireSuggest, type SuggestEntry, type SuggestSource } from '../../lib/suggest-dropdown.js';
import { type ThoughtCloudInput } from '../../lib/thought-cloud.js';
import { buildUserSelectWidget, listUsers, resolveUserName } from '../../lib/users.js';
import { buildValueEditor } from '../../editor/value-editor.js';
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
  // for each property binding on the chain).
  const registryById = new Map<string, NetworkProperty>();
  try {
    const list = await etn.propertyRegistry.list(networkId);
    for (const row of list) registryById.set(row.id, row);
  } catch {
    /* empty registry — picker just shows none of the property tokens */
  }

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
  const errorLine = span('', 'error-text');

  // Name — required, ≤200.
  const nameInput = el('input', 'text-input') as HTMLInputElement;
  nameInput.type = 'text';
  nameInput.value = initialName;
  nameInput.maxLength = THOUGHT_TYPE_VIEW_NAME_MAX;
  nameInput.placeholder = 'Название отбора (обязательно)';
  const nameField = div('field');
  nameField.append(el('label', 'field-label', `Имя отбора (тип «${typeName}»)`));
  nameField.append(nameInput);

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

  body.append(nameField, descField, defaultField, criteriaLabel, criteria.root, errorLine);

  // 4. Show the dialog. The Save button keeps itself open on validation
  //    failure; we close only when the IPC call resolves.
  let saveBtn: HTMLButtonElement | null = null;
  showDialog({
    title,
    body,
    width: 760,
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
  errorLine: HTMLElement;
}

async function onSave(ctx: SaveCtx): Promise<void> {
  const trimmedName = ctx.name.trim();
  if (trimmedName === '') {
    showFieldError(ctx, 'Укажите имя отбора.');
    return;
  }
  if (trimmedName.length > THOUGHT_TYPE_VIEW_NAME_MAX) {
    showFieldError(
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
  ctx.errorLine.textContent = '';

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
  ctx.errorLine.textContent = message;
  notice(message, 'error');
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

/** A group title whose conditions may be non-empty: the head is highlighted
 *  and its `*` marker toggled by {@link refreshGroupTitles}. */
interface GroupMarker {
  head: HTMLElement;
  star: HTMLElement;
  isNonEmpty: () => boolean;
}

/** Plain section with a title and a group-marker star. */
function block(title: string): { box: HTMLElement; body: HTMLElement; head: HTMLElement; star: HTMLElement } {
  const box = div('st-f-block');
  const head = el('div', 'st-f-title');
  head.append(el('span', '', title));
  const star = el('span', 'st-f-star', '');
  head.append(star);
  const body = div('st-f-body');
  box.append(head, body);
  return { box, body, head, star };
}

/** Collapsible section; `refresh()` toggles the caret and the body. */
function collapsibleBlock(
  title: string,
  getCollapsed: () => boolean,
  setCollapsed: (v: boolean) => void,
): { box: HTMLElement; body: HTMLElement; head: HTMLElement; star: HTMLElement; refresh: () => void } {
  const box = div('st-f-block');
  const head = el('div', 'st-f-title st-f-collapsible-title');
  const caret = el('span', 'st-f-caret', getCollapsed() ? '▸' : '▾');
  head.append(caret, el('span', '', title));
  const star = el('span', 'st-f-star', '');
  head.append(star);
  const body = div('st-f-body');
  box.append(head, body);
  const refresh = (): void => {
    const collapsed = getCollapsed();
    body.classList.toggle('hidden', collapsed);
    caret.textContent = collapsed ? '▸' : '▾';
  };
  head.addEventListener('click', () => {
    setCollapsed(!getCollapsed());
    refresh();
  });
  refresh();
  return { box, body, head, star, refresh };
}

/** Условие «Дополнительно» активно. */
function extrasActive(state: DialogCriteriaState): boolean {
  return (
    state.hasProperties !== null ||
    state.hasComment !== null ||
    state.hasAttachments !== null ||
    state.hasChronology !== null ||
    state.active !== null ||
    state.trashed
  );
}

/**
 * Builds a self-contained criteria form. Unlike the previous implementation,
 * the form is built once and mutated in place: input handlers update `state`
 * and refresh group markers WITHOUT rebuilding the DOM (which used to drop
 * focus on every keystroke). Only structural changes (add/remove condition,
 * switch operator, reorder the author list) rebuild the affected subtree.
 */
function buildCriteriaBuilder(opts: CriteriaBuilderOpts): CriteriaBuilder {
  const { networkId, registryById } = opts;
  const state = opts.initial;
  const root = div('st-f-layout view-editor-criteria');

  // Transient collapse state (default collapsed, §e0257ca5).
  let propsCollapsed = true;
  let extraCollapsed = true;
  let authorCollapsed = true;
  let datesCollapsed = true;

  // Uniform «group carries values» marking.
  const markers: GroupMarker[] = [];
  const refreshGroupTitles = (): void => {
    for (const m of markers) {
      const active = m.isNonEmpty();
      m.head.classList.toggle('st-f-title-active', active);
      m.star.textContent = active ? ' *' : '';
    }
  };
  /** Persist-less touch: refresh markers only (no DOM rebuild). */
  const touch = (): void => refreshGroupTitles();

  // --- Ключевые слова -------------------------------------------------------
  const kw = block('Ключевые слова');
  markers.push({ head: kw.head, star: kw.star, isNonEmpty: () => state.keywords.trim() !== '' });

  const kwWrap = div('st-f-kw-wrap');
  const kwInput = el('input', 'st-f-input st-f-keywords') as HTMLInputElement;
  kwInput.type = 'text';
  kwInput.value = state.keywords;
  kwInput.placeholder = 'счет* -вод*';
  setTooltip(kwInput, 'Слова через пробел, все обязательны; * — любые символы; -слово — исключение.');
  kwInput.addEventListener('input', () => {
    state.keywords = kwInput.value;
    touch();
  });
  // Составное поле (несколько слов) — живой поиск фильтрует по последнему
  // «слову» у каретки, а выбор токена заменяет только его, не всё значение
  // (общая выпадашка, источник — её параметр).
  wireSuggest(kwInput, {
    sources: [
      {
        when: 'always',
        load: () => comboToEntries(getTokenOptions({ kind: 'keywords' }, trailingWordQuery(kwInput))),
      },
    ],
    pickFirstOnEnter: false,
    onPick: (entry) => {
      replaceTrailingWord(kwInput, entry.value, (v) => {
        state.keywords = v;
        touch();
      });
    },
  });
  const kwClear = el('button', 'st-f-clear-inline', '×') as HTMLButtonElement;
  kwClear.type = 'button';
  setTooltip(kwClear, 'Очистить');
  kwClear.addEventListener('click', () => {
    state.keywords = '';
    kwInput.value = '';
    touch();
  });
  kwWrap.append(kwInput, kwClear);
  kw.body.append(kwWrap);
  kw.body.append(buildKeywordScopeRow(state, touch));

  // --- Родительские мысли -----------------------------------------------
  // Общий чип-лист сущностей (инструкция «Использовать унифицированные поля
  // выбора ссылок в диалогах»): чипы — мини-облачка, живой поиск мыслей общим
  // пикером-выпадашкой, токены (`$thought`) — источник вызывающего, кнопка
  // «выбрать…» ДОБАВЛЯЕТ результат к уже набранным, а не подменяет список.
  const pt = block('Родительские мысли');
  markers.push({ head: pt.head, star: pt.star, isNonEmpty: () => state.parentIds.length > 0 });
  const parentField = buildEntityChipField({
    getValues: () => state.parentIds,
    onChange: (values) => {
      state.parentIds = values;
      touch();
    },
    loadOptions: (query) => parentThoughtOptions(networkId, query),
    optionsHeader: 'Мысли',
    extraSources: [tokenSourceFor({ kind: 'parent' })],
    cloudOf: (value) => (value.startsWith('$') ? null : (parentClouds.get(value) ?? null)),
    placeholder: 'Название мысли или токен…',
    picker: { label: 'выбрать…', open: (managed) => pickParentThoughts(networkId, managed) },
  });
  setTooltip(parentField.root, 'Ограничить отбор мыслями, подчинёнными указанным');
  pt.body.append(parentField.root);
  // Догрузить облачка уже выбранных мыслей (в каталоге живого поиска их нет).
  void resolveParentClouds(networkId, state.parentIds).then(() => parentField.refresh());

  // --- Типы мыслей --------------------------------------------------------
  const tt = block('Типы мыслей');
  markers.push({ head: tt.head, star: tt.star, isNonEmpty: () => state.typeIds.length > 0 });
  const typeField = buildEntityChipField({
    getValues: () => state.typeIds,
    onChange: (values) => {
      state.typeIds = values;
      touch();
    },
    loadOptions: (query) =>
      filterEntityOptions(thoughtTypeEntityOptions(store.state.thoughtTypes), query),
    optionsHeader: 'Типы мыслей',
    extraSources: [tokenSourceFor({ kind: 'thought_type' })],
    placeholder: 'Название типа или токен…',
    picker: { label: 'список типов…', open: (managed) => openThoughtTypesPicker(networkId, managed) },
  });
  tt.body.append(typeField.root);

  // --- Типы связей ----------------------------------------------------------
  const lt = block('Типы связей');
  markers.push({ head: lt.head, star: lt.star, isNonEmpty: () => state.linkTypeIds.length > 0 });
  const linkTypeField = buildEntityChipField({
    getValues: () => state.linkTypeIds,
    onChange: (values) => {
      state.linkTypeIds = values;
      touch();
    },
    loadOptions: (query) =>
      filterEntityOptions(linkTypeEntityOptions(store.state.linkTypes), query),
    optionsHeader: 'Типы связей',
    extraSources: [tokenSourceFor({ kind: 'link_type' })],
    placeholder: 'Название типа или токен…',
    picker: { label: 'список типов…', open: (managed) => openLinkTypesPicker(networkId, managed) },
  });
  lt.body.append(linkTypeField.root);

  // --- Свойства (сворачиваемая группа) -------------------------------------
  const props = collapsibleBlock('Свойства', () => propsCollapsed, (v) => (propsCollapsed = v));
  markers.push({ head: props.head, star: props.star, isNonEmpty: () => state.properties.length > 0 });
  const condsBox = div('st-f-conds');
  const renderConditions = (): void => {
    clear(condsBox);
    if (state.properties.length === 0) {
      condsBox.append(el('div', 'st-f-empty', 'Условий нет'));
      return;
    }
    state.properties.forEach((cond, idx) => {
      condsBox.append(buildConditionRow({ networkId, cond, index: idx, state, registryById, touch, renderConditions }));
    });
  };
  renderConditions();
  const addCond = el('button', 'st-f-add', '+ условие по свойству') as HTMLButtonElement;
  addCond.type = 'button';
  addCond.addEventListener('click', () => {
    const firstReg = registryById.values().next().value as NetworkProperty | undefined;
    if (firstReg === undefined) {
      notice('В реестре свойств сети пока нет ни одного свойства.', 'info');
      return;
    }
    const firstOp = OPS_BY_TYPE[firstReg.value_type][0]!.op;
    state.properties = [...state.properties, { propertyId: firstReg.id, op: firstOp, values: [''] }];
    renderConditions();
    touch();
  });
  props.body.append(condsBox, addCond);

  // --- Дополнительно (сворачиваемая группа) ---------------------------------
  const extra = collapsibleBlock('Дополнительно', () => extraCollapsed, (v) => (extraCollapsed = v));
  markers.push({ head: extra.head, star: extra.star, isNonEmpty: () => extrasActive(state) });
  const triRow = (
    label: string,
    get: () => boolean | null,
    set: (v: boolean | null) => void,
    options?: { yes: string; no: string },
  ): HTMLElement => {
    const row = div('st-f-tri-row');
    row.append(el('span', 'st-f-tri-label', label));
    const select = el('select', 'st-f-input') as HTMLSelectElement;
    for (const opt of [
      { v: '', label: 'не важно' },
      { v: 'true', label: options?.yes ?? 'да' },
      { v: 'false', label: options?.no ?? 'нет' },
    ]) {
      const o = el('option', '', opt.label) as HTMLOptionElement;
      o.value = opt.v;
      select.append(o);
    }
    const cur = get();
    select.value = cur === null ? '' : cur ? 'true' : 'false';
    select.addEventListener('change', () => {
      set(select.value === '' ? null : select.value === 'true');
      touch();
    });
    row.append(select);
    return row;
  };
  extra.body.append(
    triRow('Есть значение свойства', () => state.hasProperties, (v) => (state.hasProperties = v)),
    triRow('Есть постоянный комментарий', () => state.hasComment, (v) => (state.hasComment = v)),
    triRow('Есть вложения', () => state.hasAttachments, (v) => (state.hasAttachments = v)),
    triRow('Есть хронология', () => state.hasChronology, (v) => (state.hasChronology = v)),
    triRow('Только актуальные', () => state.active, (v) => (state.active = v), { yes: 'актуальные', no: 'не актуальные' }),
  );
  const trashedRow = div('st-f-tri-row');
  const trashedLbl = el('label', 'checkbox-row') as HTMLLabelElement;
  const trashedCb = el('input') as HTMLInputElement;
  trashedCb.type = 'checkbox';
  trashedCb.checked = state.trashed;
  trashedCb.addEventListener('change', () => {
    state.trashed = trashedCb.checked;
    touch();
  });
  trashedLbl.append(trashedCb, span('Включая помеченные на удаление'));
  trashedRow.append(el('span', 'st-f-tri-label', 'Корзина'), trashedLbl);
  extra.body.append(trashedRow);

  // --- Автор / Редактор (сворачиваемая группа) ------------------------------
  const authorship = collapsibleBlock('Автор / Редактор', () => authorCollapsed, (v) => (authorCollapsed = v));
  markers.push({
    head: authorship.head,
    star: authorship.star,
    isNonEmpty: () =>
      authorFilterActive(state.authorOp, state.authorId, state.authorIds) ||
      authorFilterActive(state.editorOp, state.editorId, state.editorIds),
  });
  const authorRows = div('st-f-author-rows');
  const renderAuthor = (): void => {
    clear(authorRows);
    authorRows.append(
      buildAuthorRow({
        label: 'Автор',
        field: 'author',
        op: state.authorOp,
        singleId: state.authorId,
        listIds: state.authorIds,
        onOpChange: (op) => {
          state.authorOp = op;
          if (op !== 'eq' && op !== 'ne') state.authorId = '';
          if (op !== 'in' && op !== 'not_in') state.authorIds = [];
          renderAuthor();
          touch();
        },
        onSingleChange: (id) => {
          state.authorId = id;
          touch();
        },
        onListChange: (ids) => {
          state.authorIds = ids;
          touch();
        },
      }),
      buildAuthorRow({
        label: 'Редактор',
        field: 'editor',
        op: state.editorOp,
        singleId: state.editorId,
        listIds: state.editorIds,
        onOpChange: (op) => {
          state.editorOp = op;
          if (op !== 'eq' && op !== 'ne') state.editorId = '';
          if (op !== 'in' && op !== 'not_in') state.editorIds = [];
          renderAuthor();
          touch();
        },
        onSingleChange: (id) => {
          state.editorId = id;
          touch();
        },
        onListChange: (ids) => {
          state.editorIds = ids;
          touch();
        },
      }),
    );
  };
  renderAuthor();
  authorship.body.append(authorRows);

  // --- Даты (сворачиваемая группа) ------------------------------------------
  const dates = collapsibleBlock('Даты', () => datesCollapsed, (v) => (datesCollapsed = v));
  markers.push({ head: dates.head, star: dates.star, isNonEmpty: () => builderDatesActive(state) });
  dates.body.append(
    buildDateRangeRow(networkId, 'Создано', state.createdAfter, state.createdBefore, (from, to) => {
      state.createdAfter = from;
      state.createdBefore = to;
      touch();
    }),
    buildDateRangeRow(networkId, 'Изменено', state.updatedAfter, state.updatedBefore, (from, to) => {
      state.updatedAfter = from;
      state.updatedBefore = to;
      touch();
    }),
  );

  // --- Сортировка -----------------------------------------------------------
  // Наборы сортировок и направлений — единые экземпляры конструктора
  // (`lib/filter-builder.ts`), тот же набор, что принимает исполнитель.
  const sort = block('Сортировка');
  const sortRow = div('st-f-sort');
  const sortSelect = el('select', 'st-f-input') as HTMLSelectElement;
  for (const opt of FILTER_SORTS) {
    const o = el('option', '', opt.label) as HTMLOptionElement;
    o.value = opt.v;
    sortSelect.append(o);
  }
  sortSelect.value = state.sort;
  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value as StructureSort;
  });
  const orderSelect = el('select', 'st-f-input') as HTMLSelectElement;
  for (const opt of FILTER_ORDERS) {
    const o = el('option', '', opt.label) as HTMLOptionElement;
    o.value = opt.v;
    orderSelect.append(o);
  }
  orderSelect.value = state.order;
  orderSelect.addEventListener('change', () => {
    state.order = orderSelect.value as SortOrder;
  });
  sortRow.append(sortSelect, orderSelect);
  sort.body.append(sortRow);

  root.append(
    kw.box,
    pt.box,
    tt.box,
    lt.box,
    props.box,
    extra.box,
    authorship.box,
    dates.box,
    sort.box,
  );

  refreshGroupTitles();

  return {
    root,
    buildWire: () => buildWireDefinition(state, registryById),
    hasAnyCriteria: () => hasAnyCriteria(state),
  };
}

// ---------------------------------------------------------------------------
// Keyword scope row
// ---------------------------------------------------------------------------

function buildKeywordScopeRow(state: DialogCriteriaState, touch: () => void): HTMLElement {
  const row = div('st-f-kw-scope');
  const items: Array<{ label: string; get: () => boolean; set: (v: boolean) => void; input: HTMLInputElement | null }> = [
    { label: 'наименование', get: () => state.keywordInTitle, set: (v) => (state.keywordInTitle = v), input: null },
    { label: 'синонимы', get: () => state.keywordInSynonyms, set: (v) => (state.keywordInSynonyms = v), input: null },
    { label: 'комментарий', get: () => state.keywordInComment, set: (v) => (state.keywordInComment = v), input: null },
  ];
  for (const item of items) {
    const lbl = el('label', 'checkbox-row st-f-kw-scope-item') as HTMLLabelElement;
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = item.get();
    item.input = cb;
    cb.addEventListener('change', () => {
      item.set(cb.checked);
      // Last checked guard: default back to title+synonyms when all cleared.
      if (!state.keywordInTitle && !state.keywordInSynonyms && !state.keywordInComment) {
        state.keywordInTitle = true;
        state.keywordInSynonyms = true;
      }
      for (const other of items) other.input!.checked = other.get();
      touch();
    });
    lbl.append(cb, span(item.label));
    row.append(lbl);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Property condition row + value editor
// ---------------------------------------------------------------------------

interface ConditionRowOpts {
  networkId: string;
  cond: DialogPropertyCondition;
  index: number;
  state: DialogCriteriaState;
  registryById: Map<string, NetworkProperty>;
  touch: () => void;
  renderConditions: () => void;
}

function buildConditionRow(opts: ConditionRowOpts): HTMLElement {
  const { networkId, cond, index, state, registryById, touch, renderConditions } = opts;
  const row = div('st-f-cond');
  const def = registryById.get(cond.propertyId);

  // Property picker.
  const propSelect = el('select', 'st-f-input st-f-prop') as HTMLSelectElement;
  if (!registryById.has(cond.propertyId)) {
    const placeholder = el('option', '', cond.propertyId === '' ? '— свойство —' : '?') as HTMLOptionElement;
    placeholder.value = cond.propertyId;
    propSelect.append(placeholder);
  }
  for (const [id, entry] of registryById) {
    const opt = el('option', '', entry.name) as HTMLOptionElement;
    opt.value = id;
    propSelect.append(opt);
  }
  propSelect.value = cond.propertyId;
  propSelect.addEventListener('change', () => {
    const nextId = propSelect.value;
    const nextDef = registryById.get(nextId);
    const nextType: PropertyValueType = nextDef?.value_type ?? 'text';
    const ops = OPS_BY_TYPE[nextType];
    const nextOp = ops.some((o) => o.op === cond.op) ? cond.op : ops[0]!.op;
    state.properties[index] = { propertyId: nextId, op: nextOp, values: [''] };
    renderConditions();
    touch();
  });

  // Operator picker.
  const opSelect = el('select', 'st-f-input st-f-op') as HTMLSelectElement;
  const ops = OPS_BY_TYPE[def?.value_type ?? 'text'];
  for (const op of ops) {
    const option = el('option', '', op.label) as HTMLOptionElement;
    option.value = op.op;
    opSelect.append(option);
  }
  if (!ops.some((o) => o.op === cond.op)) {
    cond.op = ops[0]!.op;
  }
  opSelect.value = cond.op;
  opSelect.addEventListener('change', () => {
    const live = state.properties[index] ?? cond;
    state.properties[index] = { ...live, op: opSelect.value as StructurePropertyOp, values: [''] };
    renderConditions();
    touch();
  });

  // Value editor.
  const valueBox = buildConditionValueEditor({
    networkId,
    cond,
    index,
    state,
    registryById,
    touch,
  });

  const remove = el('button', 'st-f-remove', '×') as HTMLButtonElement;
  remove.type = 'button';
  remove.addEventListener('click', () => {
    state.properties = state.properties.filter((_, i) => i !== index);
    renderConditions();
    touch();
  });

  row.append(propSelect, opSelect, valueBox, remove);
  return row;
}

interface ConditionValueOpts {
  networkId: string;
  cond: DialogPropertyCondition;
  index: number;
  state: DialogCriteriaState;
  registryById: Map<string, NetworkProperty>;
  touch: () => void;
}

/**
 * Редактор значения условия — ОБЩИЙ редактор значения
 * (`editor/value-editor.ts`, стандарт S2): вид значения выбирает он, а
 * вызывающий даёт список токенов источником подсказок (`extraSuggest`) —
 * так токены (`$today`, `$user`, `$thought`, `$thought.<ключ>`) сохраняются
 * ровно там, где были, и не появляются у number/bool. `thought_ref` — legacy-
 * вид с тем же значением (id мысли), поэтому ведётся редактором связи.
 * Состояние условия хранит строки, редактор связи отдаёт массив id —
 * переходник сводит массив к строкам; списочная операция включает
 * `config.multiple` (чипы), скалярная — одиночное поле.
 */
function buildConditionValueEditor(opts: ConditionValueOpts): HTMLElement {
  const { networkId, cond, index, state, registryById, touch } = opts;
  const def = registryById.get(cond.propertyId);
  const valueType: PropertyValueType = def?.value_type ?? 'text';
  const box = div('st-f-values');
  const isList = cond.op === 'in' || cond.op === 'not_in';
  const isPresence = cond.op === 'is_empty' || cond.op === 'not_empty';
  if (isPresence) {
    box.append(el('span', 'st-f-value-hint', 'значение не требуется'));
    return box;
  }

  const live = (): DialogPropertyCondition => state.properties[index] ?? cond;
  const setValues = (values: string[]): void => {
    state.properties[index] = { ...live(), values: values.length > 0 ? values : [''] };
    touch();
  };

  const current = live();
  const editorType: PropertyValueType = valueType === 'thought_ref' ? 'link' : valueType;
  const stored = current.values.filter((v) => v !== '');
  const raw = current.values[0] ?? '';
  // Скаляр — одно значение в родном типе редактора; связь и списочная
  // операция — набор. Без ветвления по виду значения: диспетчер по виду —
  // только в общем редакторе (стандарт S2).
  const scalar: unknown =
    valueType === 'bool'
      ? (raw === '' ? null : raw === 'true')
      : valueType === 'number'
        ? (raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : '')
        : raw;
  const value: unknown = editorType === 'link' || isList ? stored : scalar;
  // Токены — только у видов, где они были (text/url/date/link/thought_ref).
  const withTokens =
    editorType === 'link' || valueType === 'text' || valueType === 'url' || valueType === 'date';

  box.append(
    buildValueEditor({
      networkId,
      definition: {
        value_type: editorType,
        config: isList ? { ...(def?.config ?? {}), multiple: true } : (def?.config ?? null),
        required: false,
        default_value: null,
      },
      value,
      commitOn: 'change',
      boolTriState: valueType === 'bool',
      extraSuggest: withTokens
        ? [tokenSourceFor({ kind: 'property', valueType, op: cond.op })]
        : [],
      ...(valueType === 'date' ? { placeholder: 'YYYY-MM-DD или токен ($today+7d)…' } : {}),
      save: (next) => {
        if (Array.isArray(next)) {
          setValues(next.map((v) => String(v)));
        } else if (next === null || next === undefined || next === '') {
          setValues(['']);
        } else {
          setValues([String(next)]);
        }
        return true;
      },
    }),
  );
  return box;
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

// ---------------------------------------------------------------------------
// Author condition row
// ---------------------------------------------------------------------------

interface AuthorRowOpts {
  label: string;
  field: 'author' | 'editor';
  op: StructureAuthorOp;
  singleId: string;
  listIds: string[];
  onOpChange: (op: StructureAuthorOp) => void;
  onSingleChange: (id: string) => void;
  onListChange: (ids: string[]) => void;
}

/**
 * Строка условия «автор/редактор» — единый скелет конструктора
 * (`buildAuthorConditionRow`); диалог подставляет свои редакторы значения
 * с токенами и живым поиском (задача 27472616).
 */
function buildAuthorRow(opts: AuthorRowOpts): HTMLElement {
  const editors: AuthorRowEditors = {
    buildSingle: ({ currentId, onChange }) => buildAuthorSingleEditor(opts.field, currentId, onChange),
    buildList: ({ currentIds, onChange }) =>
      buildAuthorListEditor(opts.field, currentIds, onChange),
  };
  return buildAuthorConditionRow({ ...opts, editors });
}

/**
 * Редактор одиночного значения: живой поиск (id, токен или пользователь по
 * имени) + выбор пользователя из каталога.
 */
function buildAuthorSingleEditor(
  field: 'author' | 'editor',
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
      { when: 'always', load: (query) => comboToEntries(authorComboOptions(field, query)) },
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
function authorComboOptions(field: 'author' | 'editor', query: string): ComboOption[] {
  const tokenOpts = tokensToComboOptions(buildTokensForSpecialField(activeChainProps ?? [], field), null);
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
  field: 'author' | 'editor',
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
    loadOptions: () => usersEntityOptions(),
    optionsHeader: 'Пользователи',
    extraSources: [
      { when: 'always', load: (query) => comboToEntries(authorTokenOptions(field, query)) },
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
function authorTokenOptions(field: 'author' | 'editor', query: string): ComboOption[] {
  return filterComboOptions(
    tokensToComboOptions(buildTokensForSpecialField(activeChainProps ?? [], field), null),
    query,
  );
}

// ---------------------------------------------------------------------------
// Date range row
// ---------------------------------------------------------------------------

/**
 * Строка «от / до» одной временной группы. Поля строит общий редактор
 * значения (вид «дата» + источник токенов вызывающего): у поля есть «✕»
 * очистки, живой поиск токенов (`$today`, `$thought.created`) заменяет
 * значение целиком; пустая строка — граница не выставлена.
 */
function buildDateRangeRow(
  networkId: string,
  label: string,
  from: string,
  to: string,
  onChange: (from: string, to: string) => void,
): HTMLElement {
  const row = div('st-f-date-row');
  row.append(el('span', 'st-f-date-label', label));

  const buildField = (value: string, set: (v: string) => void): HTMLElement => {
    const wrap = div('st-f-date-field');
    wrap.append(
      buildValueEditor({
        networkId,
        definition: { value_type: 'date', config: null, required: false, default_value: null },
        value,
        commitOn: 'change',
        placeholder: 'YYYY-MM-DD или токен…',
        extraSuggest: [tokenSourceFor({ kind: 'property', valueType: 'date', op: null })],
        save: (next) => {
          set(next === null || next === undefined ? '' : String(next));
          return true;
        },
      }),
    );
    return wrap;
  };

  row.append(
    span('от', 'st-f-date-tag'),
    buildField(from, (v) => onChange(v, to)),
    span('до', 'st-f-date-tag'),
    buildField(to, (v) => onChange(from, v)),
  );
  return row;
}

// Словарь операторов по виду значения — единый экземпляр конструктора
// (lib/filter-builder.ts); здесь не объявляется повторно.

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

/** Кандидаты-сущности, отфильтрованные по подстроке (пустой запрос — все). */
function filterEntityOptions(options: readonly EntityOption[], query: string): EntityOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...options];
  return options.filter(
    (o) =>
      o.title.toLowerCase().includes(needle) ||
      (o.searchText ?? '').toLowerCase().includes(needle),
  );
}

/** Извлекает слово у каретки — запрос составного поля («Ключевые слова»). */
function trailingWordQuery(input: HTMLInputElement): string {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  return /(\S*)$/.exec(before)?.[1] ?? '';
}

/** Заменяет слово у каретки токеном, оставляя остальной текст, и возвращает
 *  каретку сразу после токена (составное поле «Ключевые слова»). */
function replaceTrailingWord(
  input: HTMLInputElement,
  token: string,
  onChange: (v: string) => void,
): void {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const after = input.value.slice(caret);
  const wordLen = /(\S*)$/.exec(before)?.[1]?.length ?? 0;
  const wordStart = caret - wordLen;
  const next = input.value.slice(0, wordStart) + token + after;
  input.value = next;
  onChange(next);
  input.focus();
  const newCaret = wordStart + token.length;
  try {
    input.setSelectionRange(newCaret, newCaret);
  } catch {
    /* ignore */
  }
}
