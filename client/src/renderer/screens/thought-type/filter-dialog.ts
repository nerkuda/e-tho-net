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
 * Значения условий редактируются единым компонентом (задача 27472616,
 * `value-combo.ts`): комбобокс с живым поиском по подстроке среди
 * токенов-кандидатов (собранных по типу, которому принадлежит отбор — поля
 * мысли + свойства типа и его предков + `$today`/`$now`/`$user`) И
 * произвольным текстом; для списочных условий (в списке/не в списке) и для
 * «Родительские мысли»/«Типы мыслей»/«Типы связей» — chip-модель: несколько
 * литералов и токенов свободно смешиваются в одном списке, а чек-лист/поиск
 * мыслей (кнопка «выбрать…») ДОБАВЛЯЕТ к чипам, а не подменяет их. Список
 * токенов ограничен операцией условия: списочные токены предлагаются только
 * в «в списке» и «не в списке».
 *
 * Сохранение: `etn.thoughtTypeViews.create`/`.update` через IPC. Пустой отбор
 * (ни одного условия) сохранить нельзя — ошибка показывается под формой.
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
import { notice } from '../../lib/notice.js';
import { orderedTypeRows } from '../../lib/type-tree.js';
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
import {
  buildChipListField,
  replaceComboValue,
  replaceTrailingWord,
  trailingWordQuery,
  wireTokenCombo,
} from './value-combo.js';

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

/** Условие «Автор» или «Редактор» активно (для маркера группы). */
function authorFieldActive(op: StructureAuthorOp, single: string, list: string[]): boolean {
  if (op === 'empty' || op === 'not_empty') return true;
  if (op === 'in' || op === 'not_in') return list.length > 0;
  return single !== '';
}

/** Условие «Даты» активно (задана хотя бы одна граница). */
function datesActive(state: DialogCriteriaState): boolean {
  return (
    state.createdAfter !== '' ||
    state.createdBefore !== '' ||
    state.updatedAfter !== '' ||
    state.updatedBefore !== ''
  );
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
  // «слову» у каретки, а выбор токена заменяет только его, не всё значение.
  wireTokenCombo({
    input: kwInput,
    getOptions: (query) => getTokenOptions({ kind: 'keywords' }, query),
    onPick: (token) => {
      replaceTrailingWord(kwInput, token, (v) => {
        state.keywords = v;
        touch();
      });
    },
    queryOf: trailingWordQuery,
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
  // Chip-список (задача 27472616): живой поиск мыслей + токен `$thought`
  // добавляют чипы по мере ввода; кнопка «выбрать…» открывает диалог поиска
  // мыслей и ДОБАВЛЯЕТ его результат к уже набранным чипам, а не подменяет
  // список целиком.
  const pt = block('Родительские мысли');
  markers.push({ head: pt.head, star: pt.star, isNonEmpty: () => state.parentIds.length > 0 });
  const parentField = buildChipListField({
    getValues: () => state.parentIds,
    onChange: (values) => {
      state.parentIds = values;
      touch();
    },
    getOptions: (query) => parentComboOptions(networkId, query),
    renderLabel: (value) => resolveParentChipLabel(networkId, value),
    placeholder: 'Название мысли или токен…',
    picker: { label: 'выбрать…', open: (managed) => pickParentThoughts(networkId, managed) },
  });
  setTooltip(parentField.root, 'Ограничить отбор мыслями, подчинёнными указанным');
  pt.body.append(parentField.root);

  // --- Типы мыслей --------------------------------------------------------
  const tt = block('Типы мыслей');
  markers.push({ head: tt.head, star: tt.star, isNonEmpty: () => state.typeIds.length > 0 });
  const typeField = buildChipListField({
    getValues: () => state.typeIds,
    onChange: (values) => {
      state.typeIds = values;
      touch();
    },
    getOptions: (query) => typeComboOptions('thought', query),
    renderLabel: (value) => typeChipLabel('thought', value),
    placeholder: 'Название типа или токен…',
    picker: { label: 'список типов…', open: (managed) => openThoughtTypesPicker(networkId, managed) },
  });
  tt.body.append(typeField.root);

  // --- Типы связей ----------------------------------------------------------
  const lt = block('Типы связей');
  markers.push({ head: lt.head, star: lt.star, isNonEmpty: () => state.linkTypeIds.length > 0 });
  const linkTypeField = buildChipListField({
    getValues: () => state.linkTypeIds,
    onChange: (values) => {
      state.linkTypeIds = values;
      touch();
    },
    getOptions: (query) => typeComboOptions('link', query),
    renderLabel: (value) => typeChipLabel('link', value),
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
      authorFieldActive(state.authorOp, state.authorId, state.authorIds) ||
      authorFieldActive(state.editorOp, state.editorId, state.editorIds),
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
  markers.push({ head: dates.head, star: dates.star, isNonEmpty: () => datesActive(state) });
  dates.body.append(
    buildDateRangeRow('Создано', state.createdAfter, state.createdBefore, (from, to) => {
      state.createdAfter = from;
      state.createdBefore = to;
      touch();
    }),
    buildDateRangeRow('Изменено', state.updatedAfter, state.updatedBefore, (from, to) => {
      state.updatedAfter = from;
      state.updatedBefore = to;
      touch();
    }),
  );

  // --- Сортировка -----------------------------------------------------------
  const sort = block('Сортировка');
  const sortRow = div('st-f-sort');
  const sortSelect = el('select', 'st-f-input') as HTMLSelectElement;
  for (const opt of [
    { v: 'created', label: 'по дате создания' },
    { v: 'updated', label: 'по дате изменения' },
    { v: 'alpha', label: 'по алфавиту' },
  ]) {
    const o = el('option', '', opt.label) as HTMLOptionElement;
    o.value = opt.v;
    sortSelect.append(o);
  }
  sortSelect.value = state.sort;
  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value as StructureSort;
  });
  const orderSelect = el('select', 'st-f-input') as HTMLSelectElement;
  for (const opt of [
    { v: 'asc', label: 'по возрастанию' },
    { v: 'desc', label: 'по убыванию' },
  ]) {
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
  const setValue = (i: number, v: string): void => {
    const current = live();
    const values = [...current.values];
    while (values.length <= i) values.push('');
    values[i] = v;
    state.properties[index] = { ...current, values };
    touch();
  };

  const buildScalar = (i: number): HTMLElement => {
    if (valueType === 'number') {
      return buildScalarInput('number', live().values[i] ?? '', (v) => setValue(i, v));
    }
    if (valueType === 'date') {
      return buildDateValueRow(networkId, live().values[i] ?? '', cond.op, (v) => setValue(i, v));
    }
    if (valueType === 'bool') {
      return buildBoolSelect(live().values[i] ?? '', (v) => setValue(i, v));
    }
    // text/url: free input + token button.
    return buildTextValueRow(networkId, live().values[i] ?? '', valueType, cond.op, (v) => setValue(i, v));
  };

  if (!isList) {
    box.append(buildScalar(0));
    return box;
  }

  // List editor: chip-модель (задача 27472616) — несколько литералов и
  // токенов свободно смешиваются.
  const chipField = buildChipListField({
    getValues: () => live().values.filter((v) => v !== ''),
    onChange: (values) => {
      const current = live();
      state.properties[index] = { ...current, values: values.length > 0 ? values : [''] };
      touch();
    },
    getOptions: (query) => propertyValueComboOptions(networkId, valueType, cond.op, def, query),
    renderLabel: (value) => propertyValueChipLabel(networkId, valueType, value),
    placeholder: 'Добавить значение…',
  });
  box.append(chipField.root);
  return box;
}

function buildScalarInput(
  type: 'text' | 'number' | 'date',
  value: string,
  onChange: (v: string) => void,
): HTMLInputElement {
  const input = el('input', 'st-f-input') as HTMLInputElement;
  input.type = type;
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function buildBoolSelect(value: string, onChange: (v: string) => void): HTMLSelectElement {
  const select = el('select', 'st-f-input') as HTMLSelectElement;
  const yes = el('option', '', 'да') as HTMLOptionElement;
  yes.value = 'true';
  const no = el('option', '', 'нет') as HTMLOptionElement;
  no.value = 'false';
  select.append(yes, no);
  select.value = value === 'false' ? 'false' : 'true';
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function buildTextValueRow(
  networkId: string,
  value: string,
  valueType: PropertyValueType,
  op: StructurePropertyOp,
  onChange: (v: string) => void,
): HTMLElement {
  const row = div('st-f-value-row');
  const input = el('input', 'st-f-input') as HTMLInputElement;
  input.type = 'text';
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  wireTokenCombo({
    input,
    getOptions: (query) => getTokenOptions({ kind: 'property', valueType, op }, query),
    onPick: (token) => replaceComboValue(input, token, onChange),
  });
  row.append(input);
  return row;
}

/** Кэш id → название мысли для отображения ссылочных значений (e8365d29). */
const refTitleCache = new Map<string, string>();

/** Live-search кандидаты мыслей для комбобоксов (задача 27472616):
 *  найденные заголовки резолвятся в `refTitleCache`, а сам поиск честно
 *  ищет по подстроке — тот же движок, что у «выбрать». */
async function findThoughtCandidates(
  networkId: string,
  query: string,
  typeIds: string[],
): Promise<ComboOption[]> {
  try {
    const hits = await etn.thoughts.findDuplicates(networkId, query, [], typeIds);
    return hits.map((h) => {
      refTitleCache.set(h.id, h.title);
      return { value: h.id, label: h.title, section: 'Мысли' };
    });
  } catch {
    return [];
  }
}

/** Value editor for `date` conditions: literal ISO date or token with ±Nd. */
function buildDateValueRow(
  networkId: string,
  value: string,
  op: StructurePropertyOp,
  onChange: (v: string) => void,
): HTMLElement {
  const row = div('st-f-value-row');
  const input = el('input', 'st-f-input') as HTMLInputElement;
  input.type = 'text';
  input.value = value;
  input.placeholder = 'YYYY-MM-DD или токен ($today+7d)…';
  input.addEventListener('input', () => onChange(input.value));
  wireTokenCombo({
    input,
    getOptions: (query) => getTokenOptions({ kind: 'property', valueType: 'date', op }, query),
    onPick: (token) => replaceComboValue(input, token, onChange),
  });
  row.append(input);
  return row;
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

const AUTHOR_OP_LABELS: Record<StructureAuthorOp, string> = {
  eq: 'равен',
  ne: 'не равен',
  in: 'в списке',
  not_in: 'не в списке',
  empty: 'не заполнено',
  not_empty: 'заполнено',
};

function buildAuthorRow(opts: AuthorRowOpts): HTMLElement {
  const row = div('author-cond-row');
  row.append(el('span', 'author-cond-label', opts.label));

  const opSelect = el('select', 'select-input author-cond-op') as HTMLSelectElement;
  for (const op of ['eq', 'ne', 'in', 'not_in', 'empty', 'not_empty'] as StructureAuthorOp[]) {
    const o = el('option', '', AUTHOR_OP_LABELS[op]) as HTMLOptionElement;
    o.value = op;
    opSelect.append(o);
  }
  opSelect.value = opts.op;
  opSelect.addEventListener('change', () => opts.onOpChange(opSelect.value as StructureAuthorOp));
  row.append(opSelect);

  if (opts.op === 'empty' || opts.op === 'not_empty') {
    row.append(el('span', 'author-cond-hint', 'значение не требуется'));
    return row;
  }

  const isList = opts.op === 'in' || opts.op === 'not_in';
  if (isList) {
    row.append(buildAuthorListEditor(opts));
    return row;
  }

  // Одиночное значение: живой поиск (id, токен или пользователь по имени) +
  // выбор пользователя из каталога.
  const single = div('author-single-wrap');
  const input = el('input', 'st-f-input') as HTMLInputElement;
  input.type = 'text';
  input.value = opts.singleId === '' || opts.singleId.startsWith('$') ? opts.singleId : (resolveUserName(opts.singleId) ?? opts.singleId);
  input.placeholder = 'Пользователь, id или токен…';
  input.addEventListener('input', () => opts.onSingleChange(input.value));
  wireTokenCombo({
    input,
    getOptions: (query) => authorComboOptions(opts.field, query),
    onPick: (value) => {
      input.value = value.startsWith('$') ? value : (resolveUserName(value) ?? value);
      opts.onSingleChange(value);
      input.focus();
    },
  });
  single.append(
    input,
    buildUserSelectWidget({
      label: '',
      currentId: opts.singleId,
      onChange: (id) => {
        input.value = resolveUserName(id) ?? id;
        opts.onSingleChange(id);
      },
    }),
  );
  row.append(single);
  return row;
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
 * Chip-редактор списка автора/редактора (задача 27472616): чипы выбранных
 * значений (имена пользователей или тексты токенов) + живой поиск,
 * смешивающий пользователей сети и токены в одном поле ввода.
 */
function buildAuthorListEditor(opts: AuthorRowOpts): HTMLElement {
  const field = buildChipListField({
    getValues: () => opts.listIds,
    onChange: (values) => opts.onListChange(values),
    getOptions: (query) => authorComboOptions(opts.field, query),
    renderLabel: (value) => (value.startsWith('$') ? value : (resolveUserName(value) ?? value)),
    placeholder: 'Пользователь или токен…',
  });
  return field.root;
}

// ---------------------------------------------------------------------------
// Date range row
// ---------------------------------------------------------------------------

function buildDateRangeRow(
  label: string,
  from: string,
  to: string,
  onChange: (from: string, to: string) => void,
): HTMLElement {
  const row = div('st-f-date-row');
  row.append(el('span', 'st-f-date-label', label));

  const buildField = (value: string, set: (v: string) => void): HTMLElement => {
    const wrap = div('st-f-date-field');
    const input = el('input', 'st-f-input st-f-date-input') as HTMLInputElement;
    input.type = 'text';
    input.value = value;
    input.placeholder = 'YYYY-MM-DD или токен…';
    input.addEventListener('input', () => set(input.value));
    wireTokenCombo({
      input,
      getOptions: (query) => getTokenOptions({ kind: 'property', valueType: 'date', op: null }, query),
      onPick: (token) => replaceComboValue(input, token, set),
    });
    wrap.append(input);
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

// ---------------------------------------------------------------------------
// Operator set per property value type (mirrors filter-panel.ts OPS_BY_TYPE)
// ---------------------------------------------------------------------------

const OPS_BY_TYPE: Record<PropertyValueType, Array<{ op: StructurePropertyOp; label: string }>> = {
  text: [
    { op: 'contains', label: 'содержит' },
    { op: 'eq', label: 'равно' },
    { op: 'in', label: 'в списке' },
    { op: 'not_in', label: 'не в списке' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  url: [
    { op: 'contains', label: 'содержит' },
    { op: 'eq', label: 'равно' },
    { op: 'in', label: 'в списке' },
    { op: 'not_in', label: 'не в списке' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  date: [
    { op: 'eq', label: 'равно' },
    { op: 'gt', label: 'больше' },
    { op: 'lt', label: 'меньше' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  number: [
    { op: 'eq', label: 'равно' },
    { op: 'gt', label: 'больше' },
    { op: 'lt', label: 'меньше' },
    { op: 'not_empty', label: 'заполнено' },
    { op: 'is_empty', label: 'не заполнено' },
  ],
  bool: [{ op: 'eq', label: 'равно' }],
  link: [],
  // Legacy (миграция 040): таких свойств в живой БД не остаётся.
  thought_ref: [],
};

// ---------------------------------------------------------------------------
// Pickers (parent / thought types / link types) — задача 27472616: каждый
// возвращает `Promise<string[] | null>` (`null` — отменено) над УПРАВЛЯЕМЫМ
// подмножеством чипов, а не над всем списком, — см. {@link ChipPickerOptions}
// в `value-combo.ts` для того, как это сочетается с токенами.
// ---------------------------------------------------------------------------

async function pickParentThoughts(networkId: string, managedIds: string[]): Promise<string[] | null> {
  const result = await pickThoughtsDialog({
    networkId,
    allowCreate: false,
    allowLinkType: false,
    selectedIds: managedIds,
  });
  if (result === null) return null;
  return pickedThoughtIds(result);
}

async function openThoughtTypesPicker(networkId: string, managedIds: string[]): Promise<string[] | null> {
  let types = store.state.thoughtTypes;
  if (types.length === 0) {
    try {
      types = await etn.types.listThoughtTypes(networkId);
    } catch {
      types = [];
    }
  }
  const rows = orderedTypeRows(types)
    .filter((row) => !row.type.is_root)
    .map((row) => ({ id: row.type.id, label: row.type.name, depth: row.depth - 1 }));
  return openTypePickerDialog('Типы мыслей', rows, managedIds);
}

async function openLinkTypesPicker(networkId: string, managedIds: string[]): Promise<string[] | null> {
  let types = store.state.linkTypes;
  if (types.length === 0) {
    try {
      types = await etn.types.listLinkTypes(networkId);
    } catch {
      types = [];
    }
  }
  const rows = orderedTypeRows(types)
    .filter((row) => !row.type.is_root)
    .map((row) => ({ id: row.type.id, label: row.type.name_forward, depth: row.depth - 1 }));
  return openTypePickerDialog('Типы связей', rows, managedIds);
}

/**
 * Modal type picker: a search box filtering as you type, a multi-column
 * checklist (checked first, then alphabetical) and «Отмена»/«Применить».
 * Resolves the checked set on Apply, `null` on Cancel/Esc/backdrop (any
 * close path fires `onClose` exactly once — {@link showDialog}).
 */
function openTypePickerDialog(
  title: string,
  rows: Array<{ id: string; label: string; depth: number }>,
  initial: string[],
): Promise<string[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string[] | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const body = div('st-f-picker');
    const searchInput = el('input', 'st-f-input st-f-search') as HTMLInputElement;
    searchInput.type = 'text';
    searchInput.placeholder = 'Найти…';
    const list = div('st-f-checks st-f-picker-list');
    const checked = new Set(initial);
    let needle = '';

    const renderList = (): void => {
      clear(list);
      const filtered = rows.filter((row) => row.label.toLowerCase().includes(needle));
      const byAlpha = (a: (typeof rows)[number], b: (typeof rows)[number]): number =>
        a.label.localeCompare(b.label, 'ru');
      const sorted = [
        ...filtered.filter((row) => checked.has(row.id)).sort(byAlpha),
        ...filtered.filter((row) => !checked.has(row.id)).sort(byAlpha),
      ];
      if (sorted.length === 0) list.append(el('div', 'st-f-empty', 'Ничего не найдено'));
      for (const row of sorted) {
        const line = el('label', 'st-f-check');
        line.style.paddingLeft = `${Math.max(0, row.depth) * 14}px`;
        const input = el('input') as HTMLInputElement;
        input.type = 'checkbox';
        input.checked = checked.has(row.id);
        input.addEventListener('change', () => {
          if (input.checked) checked.add(row.id);
          else checked.delete(row.id);
          renderList();
        });
        line.append(input, el('span', '', row.label));
        list.append(line);
      }
    };
    searchInput.addEventListener('input', () => {
      needle = searchInput.value.trim().toLowerCase();
      renderList();
    });
    body.append(searchInput, list);
    renderList();
    showDialog({
      title,
      body,
      width: 480,
      buttons: [
        { label: 'Отмена' },
        { label: 'Применить', primary: true, onClick: () => finish([...checked]) },
      ],
      onMount: () => {
        searchInput.focus();
      },
      onClose: () => finish(null),
    });
  });
}

// ---------------------------------------------------------------------------
// Value-combo wiring — кандидаты и подписи чипов для каждого поля условия
// (задача 27472616). Формат хранимых значений не меняется: строка (литерал
// или `$token`); резолвер токенов на сервере не трогается.
// ---------------------------------------------------------------------------

/** Поле, к которому пристёгнут комбобокс значения условия. */
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

/** Живой поиск для «Родительские мысли»: токен `$thought` + мысли сети. */
async function parentComboOptions(networkId: string, query: string): Promise<ComboOption[]> {
  const tokenOpts = getTokenOptions({ kind: 'parent' }, query);
  if (query.trim() === '') return tokenOpts;
  return [...tokenOpts, ...(await findThoughtCandidates(networkId, query, []))];
}

/** Подпись чипа «Родительские мысли»: название мысли или текст токена. */
async function resolveParentChipLabel(networkId: string, value: string): Promise<string> {
  if (value.startsWith('$')) return value;
  const cached = refTitleCache.get(value);
  if (cached !== undefined) return cached;
  try {
    const [ref] = await etn.thoughts.resolve(networkId, [value]);
    if (ref === undefined) return '(не найдено)';
    refTitleCache.set(ref.id, ref.title);
    return ref.title;
  } catch {
    return '(не найдено)';
  }
}

/** Живой поиск для «Типы мыслей»/«Типы связей»: токены цепочки типов +
 *  сам каталог типов, отфильтрованный по названию. */
function typeComboOptions(kind: 'thought' | 'link', query: string): ComboOption[] {
  const tokenOpts = tokenOptions(kind === 'thought' ? { kind: 'thought_type' } : { kind: 'link_type' });
  const section = kind === 'thought' ? 'Типы мыслей' : 'Типы связей';
  // Separate branches keep `orderedTypeRows`'s generic bound to one concrete
  // type — a union array (`ThoughtType[] | LinkType[]`) fails inference.
  const typeOpts: ComboOption[] =
    kind === 'thought'
      ? orderedTypeRows(store.state.thoughtTypes)
          .filter((row) => !row.type.is_root)
          .map((row) => ({ value: row.type.id, label: row.type.name, section }))
      : orderedTypeRows(store.state.linkTypes)
          .filter((row) => !row.type.is_root)
          .map((row) => ({ value: row.type.id, label: row.type.name_forward, section }));
  return filterComboOptions([...tokenOpts, ...typeOpts], query);
}

/** Подпись чипа «Типы мыслей»/«Типы связей»: название типа или токен. */
function typeChipLabel(kind: 'thought' | 'link', value: string): string {
  if (value.startsWith('$')) return value;
  const catalogue = kind === 'thought' ? store.state.thoughtTypes : store.state.linkTypes;
  const t = catalogue.find((x) => x.id === value);
  if (t === undefined) return value;
  return 'name' in t ? t.name : t.name_forward;
}

/** Живой поиск для списочных условий по свойству (`in`/`not_in`): токены +
 *  свойства со списочными операторами). */
async function propertyValueComboOptions(
  networkId: string,
  valueType: PropertyValueType,
  op: StructurePropertyOp,
  def: NetworkProperty | undefined,
  query: string,
): Promise<ComboOption[]> {
  void def;
  return getTokenOptions({ kind: 'property', valueType, op }, query);
}

/** Подпись чипа списочного условия: значение как есть. */
function propertyValueChipLabel(
  networkId: string,
  valueType: PropertyValueType,
  value: string,
): string | Promise<string> {
  void networkId;
  void valueType;
  return value;
}
